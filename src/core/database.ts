/**
 * The database as a whole: its root folder (the folder of `metastore.yaml`), its configuration
 * (`config:` in `<root>/metastore.yaml`) and a description of its catalogs and schemas.
 * Tools never take database paths: tables are addressed by `catalog.schema.table`.
 */

import type { App, TFile } from "./host";
import { catalogRowFiles } from "./row-files";
import { catalogLoadedTable, loadRows, notifyApplied, whileWriting } from "./engine";
import type { DatanotesSettings } from "./settings";
import { storePath } from "./store";
import { DEFAULT_ARCHIVE_FOLDER } from "./table-loader";
import { DEFAULT_SCHEMA } from "./types-table";
import { isValidTimeZone } from "./datetime";
import { catalogTables, loadMetastore, METASTORE_FILE, metastorePath, NEW_DATABASE_CONFIG, primeMetastore, rebaseTablePaths, setConfig, tableTags } from "./metastore";
import { GuidedError, guide, identifierHint } from "./hints";
import { applyDiff, diffOrdered, type JournalRow } from "./changeset";
import { writeFrontmatter } from "./frontmatter";
import { withGenerated } from "./computed-columns";
import { withMetastoreId } from "./database-id";
import { appendDatabaseMove, eachLimit, moveLinks, MOVE_WRITES, type DatabaseMove } from "./database-move";
import { forgetLoggedStates, syncTransactionLogs, withLogLock } from "./transaction-log";
import { writeJournal } from "./journal";
import { invalidateFiles } from "./file-cache";
import { currentActor } from "./actor";
import { telemetry } from "./telemetry";
import { bulkWrite } from "./vault-settle";
import { missingDescriptions, type MissingDescriptions } from "./descriptions";
import { databaseEntries, inDatabase, normalizeDatabaseFolder } from "./db-paths";
import { unreadableRows } from "./unreadable";

export class DatabaseConfigError extends GuidedError {
  override readonly name = "DatabaseConfigError";
}

export interface DatabaseConfig {
  /** Catalog used when a table name has fewer than three parts and when creating tables. */
  default_catalog: string;
  /** Schema used when a table is created without one. */
  default_schema: string;
  /** Date format of row sub-folders of time-based tables (`YYYY/MM` → `2026/09`); empty = flat. */
  default_partition: string;
  /** Date format of row file names of time-based tables (`YYYY-MM-DD[T]HHmm`). */
  default_filename: string;
  /** Archive folder name inside each table folder. */
  archive_folder: string;
  /**
   * IANA time zone (e.g. `Europe/Rome`). When set, date-times written without seconds or offset
   * are completed with it (RFC 3339). Empty = values are stored as given.
   */
  timezone: string;
  /**
   * Transaction log for time travel (`transaction_log`). A database the engine creates gets
   * `history: true` in its metastore (`NEW_DATABASE_CONFIG`); in a metastore without the key it is
   * off, as it was before 3.0.0. A table's own `properties.history` (alter_table) overrides it.
   */
  history: boolean;
  /**
   * Automatic links: the text a write puts in a note's body links the notes it mentions by name
   * (src/core/autolink.ts). On by default; a write's own `autolink` overrides it.
   */
  autolink: boolean;
}

export const DEFAULT_DATABASE_CONFIG: DatabaseConfig = {
  default_catalog: "main",
  default_schema: DEFAULT_SCHEMA,
  default_partition: "",
  default_filename: "YYYY-MM-DD[T]HHmm",
  archive_folder: DEFAULT_ARCHIVE_FOLDER,
  timezone: "",
  history: false,
  autolink: true,
};

/** The settings that are true or false; the others are text. */
const BOOLEAN_KEYS = ["history", "autolink"] as const;
type BooleanConfigKey = (typeof BOOLEAN_KEYS)[number];
type TextConfigKey = Exclude<keyof DatabaseConfig, BooleanConfigKey>;
const CONFIG_KEYS = (Object.keys(DEFAULT_DATABASE_CONFIG) as (keyof DatabaseConfig)[]).filter(
  (k): k is TextConfigKey => !(BOOLEAN_KEYS as readonly string[]).includes(k),
);
const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function databaseRoot(settings: Pick<DatanotesSettings, "databaseFolder">): string {
  return normalizeDatabaseFolder(settings.databaseFolder);
}

/** Schema and table names: lowercase letters, digits, `_`, starting with a letter. */
export function assertIdentifier(kind: "catalog" | "schema" | "table" | "view", value: string): string {
  const v = value.trim();
  if (!NAME_RE.test(v)) {
    throw new DatabaseConfigError(`${kind} name "${value}" must be lowercase letters, digits and _ (start with a letter)`, identifierHint(kind, value));
  }
  return v;
}

function validateConfig(cfg: DatabaseConfig): DatabaseConfig {
  assertIdentifier("catalog", cfg.default_catalog);
  assertIdentifier("schema", cfg.default_schema);
  for (const k of ["default_partition", "default_filename"] as const) {
    if ((k === "default_filename" && cfg[k].trim() === "") || cfg[k].includes("{") || cfg[k].includes("}")) {
      throw new DatabaseConfigError(`"${k}" must be a date format such as YYYY/MM (no braces)`);
    }
  }
  if (cfg.timezone !== "" && !isValidTimeZone(cfg.timezone)) {
    throw new DatabaseConfigError(`"timezone" must be an IANA time zone such as Europe/Rome`);
  }
  if (cfg.archive_folder.trim() === "" || cfg.archive_folder.includes("/")) {
    throw new DatabaseConfigError(`"archive_folder" must be a single folder name such as _archive`);
  }
  return cfg;
}

/**
 * Read the configuration in `metastore.yaml`; missing keys fall back to the defaults. Without a
 * metastore the database does not exist yet: it reads as the engine will create it, with the
 * settings of a new database (`NEW_DATABASE_CONFIG`: history on).
 */
export async function readDatabaseConfig(app: App, settings: DatanotesSettings): Promise<DatabaseConfig> {
  const cfg: DatabaseConfig = { ...DEFAULT_DATABASE_CONFIG };
  const ms = await loadMetastore(app, settings);
  if (!ms) return { ...cfg, ...(NEW_DATABASE_CONFIG as Partial<DatabaseConfig>) };
  if (ms && Object.keys(ms.model.config).length > 0) {
    for (const k of CONFIG_KEYS) {
      const v = ms.model.config[k];
      const emptyAllowed = k === "default_partition" || k === "timezone";
      if (typeof v === "string" && (v.trim() !== "" || emptyAllowed)) cfg[k] = v.trim();
      else if (v === null && emptyAllowed) cfg[k] = "";
    }
    for (const k of BOOLEAN_KEYS) if (typeof ms.model.config[k] === "boolean") cfg[k] = ms.model.config[k] as boolean;
    return cfg;
  }
  return cfg;
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  let cur = "";
  for (const part of folder.split("/")) {
    cur = cur === "" ? part : `${cur}/${part}`;
    if (app.vault.getAbstractFileByPath(cur) == null) await app.vault.createFolder(cur);
  }
}

/**
 * Configuration lives under `config:` in `metastore.yaml` (created when missing, with the
 * database's id). A new `config:` gets every key; an existing one gets the keys it has and the
 * keys `given`, so a setting added in a later version (whose default is what the file means
 * without it) appears in the file only when someone sets it.
 */
async function writeDatabaseConfig(app: App, settings: DatanotesSettings, cfg: DatabaseConfig, given: ReadonlySet<string>): Promise<void> {
  const path = metastorePath(settings);
  const ms = await loadMetastore(app, settings);
  const text = ms?.text ?? "";
  const has = ms && Object.keys(ms.model.config).length > 0 ? new Set(Object.keys(ms.model.config)) : null;
  let after = setConfig(text, Object.fromEntries(Object.entries(cfg).filter(([k]) => !has || has.has(k) || given.has(k))));
  if (after === text) return;
  if (ms) await app.vault.process(ms.file, () => after);
  else {
    // the engine creates the database: its metastore gets the database's id
    if (settings.databaseId) after = withMetastoreId(after, settings.databaseId);
    await ensureFolder(app, path.slice(0, path.lastIndexOf("/")));
    await app.vault.create(path, after);
  }
  primeMetastore(app, settings, after);
}

export interface DescribedTable {
  name: string;
  qualified: string;
  row_count: number;
  description?: string;
  /** Key/value labels of the table (`{ domain: "health" }`). */
  tags?: Record<string, string>;
  /** What has no description (a table written before they were required): fill it with alter_table / alter_column. */
  missing_descriptions?: MissingDescriptions;
  /**
   * Rows whose front matter cannot be read (not in `row_count`: every read leaves them out), when
   * there are any; check_table lists them with code `unreadable`.
   */
  unreadable_count?: number;
}

export interface DatabaseDescription {
  root: string;
  /** `metastore.yaml`: configuration, catalogs, schemas, tables and views. */
  metastore: string;
  journal: string;
  config: DatabaseConfig;
  /** Metastore tables and views, by catalog and schema. */
  catalogs: {
    catalog: string;
    description?: string;
    default?: true;
    schemas: { schema: string; description?: string; tables: DescribedTable[]; views: { name: string; qualified: string; description?: string }[] }[];
  }[];
  /**
   * Bases (shared columns) and the tables that extend each one; `missing_descriptions` when the
   * base or some of its own columns have none: define_base fills them.
   */
  bases: { name: string; description?: string; bases?: string[]; columns: string[]; tables: string[]; missing_descriptions?: { base: boolean; columns: string[] } }[];
}

export async function describeDatabase(app: App, settings: DatanotesSettings): Promise<DatabaseDescription> {
  const root = databaseRoot(settings);
  const config = await readDatabaseConfig(app, settings);
  const ms = await loadMetastore(app, settings);
  const catalogs: DatabaseDescription["catalogs"] = [];
  if (ms) {
    const byTable = new Map(catalogTables(ms.model).map((x) => [x.ref.full, x]));
    const unreadable = new Map<string, number>();
    for (const u of await unreadableRows(app, settings, ms.model)) unreadable.set(u.table, (unreadable.get(u.table) ?? 0) + 1);
    for (const [catalog, cat] of Object.entries(ms.model.catalogs)) {
      catalogs.push({
        catalog,
        ...(cat.description ? { description: cat.description } : {}),
        ...(catalog === config.default_catalog ? { default: true as const } : {}),
        schemas: Object.entries(cat.schemas).map(([schema, sch]) => ({
          schema,
          ...(sch.description ? { description: sch.description } : {}),
          tables: Object.entries(sch.tables).map(([name, entry]) => {
            const full = `${catalog}.${schema}.${name}`;
            const t = catalogLoadedTable(settings, ms, byTable.get(full)!.ref);
            const tags = tableTags(entry);
            const missing = missingDescriptions(t.def.options.description, t.def.columns);
            return {
              name,
              qualified: full,
              row_count: catalogRowFiles(app, settings, full, t.def).length,
              ...(entry.description ? { description: entry.description } : {}),
              ...(tags ? { tags } : {}),
              ...(missing ? { missing_descriptions: missing } : {}),
              ...(unreadable.has(full) ? { unreadable_count: unreadable.get(full)! } : {}),
            };
          }),
          views: Object.entries(sch.views).map(([name, v]) => ({
            name,
            qualified: `${catalog}.${schema}.${name}`,
            ...(v.description ? { description: v.description } : {}),
          })),
        })),
      });
    }
  }
  return {
    root,
    metastore: metastorePath(settings),
    journal: storePath("journal"),
    config,
    catalogs,
    bases: ms
      ? Object.entries(ms.model.bases).map(([name, b]) => {
          const missing = missingDescriptions(b.description, b.columns);
          return {
            name,
            ...(b.description ? { description: b.description } : {}),
            ...(b.bases ? { bases: b.bases } : {}),
            columns: b.columns.map((c) => String(c.name)),
            tables: catalogTables(ms.model).filter(({ entry }) => ((entry.bases as string[] | undefined) ?? []).includes(name)).map(({ ref }) => ref.full),
            ...(missing ? { missing_descriptions: { base: missing.table, columns: missing.columns } } : {}),
          };
        })
      : [],
  };
}

/** Move every file under `from` to the same relative path under `to`, then drop the empty folders. */
async function moveFilesOneByOne(app: App, from: string, to: string): Promise<void> {
  const files = app.vault.getFiles().filter((f) => f.path.startsWith(`${from}/`));
  for (const f of files) {
    const target = `${to}${f.path.slice(from.length)}`;
    await ensureFolder(app, target.slice(0, target.lastIndexOf("/")));
    const existing = app.vault.getAbstractFileByPath(target);
    if (existing != null) {
      // Another plugin may create empty notes in new folders (folder notes): replace those only.
      if (!("extension" in existing) || (await app.vault.read(existing as TFile)) !== "") {
        throw new DatabaseConfigError(`cannot move ${f.path}: ${target} already exists`);
      }
      await app.vault.delete(existing as TFile);
    }
    await app.fileManager.renameFile(f, target);
  }
  const old = app.vault.getAbstractFileByPath(from);
  if (old != null) {
    try {
      await app.vault.delete(old as TFile, true);
    } catch {
      // an empty folder left behind is harmless
    }
  }
}

export interface ConfigureDatabaseInput extends Partial<DatabaseConfig> {
  /** New database folder; the current one is renamed (links follow). */
  root?: string;
}

const ROOT_EXAMPLE = `root: "datanotes"`;

/**
 * The database folder `root` names, checked against the current one (`oldRoot`): any folder of the
 * vault but the vault root, with no dot segment (editors hide dot folders: the rows would vanish
 * from view), not inside the current database folder, and not an existing path (ignoring case: a
 * vault on Windows or macOS does). A case-only rename of the current folder is allowed.
 */
export function checkDatabaseRoot(app: App, oldRoot: string, root: string): string {
  const newRoot = root.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const fix = (hint: string) => guide(hint, "moveDatabase");
  // "": the database moves to the root of the vault (configureDatabase checks its names there)
  if (newRoot === "") return newRoot;
  const bad = newRoot.split("/").find((p) => p === "" || p.startsWith("."));
  if (bad !== undefined) {
    throw new DatabaseConfigError(
      `"root" cannot have a ${bad === "" ? "empty" : "dot"} segment: "${root}"`,
      fix(`Editors hide folders whose name starts with a dot, so the rows would vanish from view: name folders without a leading dot, e.g. ${ROOT_EXAMPLE}.`),
    );
  }
  if (newRoot === oldRoot) return newRoot;
  const lower = newRoot.toLowerCase();
  if (lower === oldRoot.toLowerCase()) {
    // a case-only rename: of the database folder's own name (its parents are other folders of the vault)
    const parent = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
    if (parent(newRoot) !== parent(oldRoot)) {
      throw new DatabaseConfigError(
        `"${newRoot}" changes the case of a folder above the database folder ${oldRoot}`,
        fix(`Change the case of the database folder's own name only, e.g. root: "${parent(oldRoot) ? `${parent(oldRoot)}/` : ""}${newRoot.slice(newRoot.lastIndexOf("/") + 1)}".`),
      );
    }
    return newRoot;
  }
  if (lower.startsWith(`${oldRoot.toLowerCase()}/`)) {
    throw new DatabaseConfigError(`"${newRoot}" is inside the current database folder ${oldRoot}`, fix(`Name a folder outside ${oldRoot}/, e.g. ${ROOT_EXAMPLE}.`));
  }
  const taken =
    app.vault.getAbstractFileByPath(newRoot) != null ||
    app.vault.getFiles().some((f) => {
      const p = f.path.toLowerCase();
      return p === lower || p.startsWith(`${lower}/`);
    });
  if (taken) {
    throw new DatabaseConfigError(`"${newRoot}" already exists in the vault`, fix(`Name a folder that does not exist yet: the engine creates it and moves the database into it.`));
  }
  return newRoot;
}

/**
 * The database's names at the root of the vault (metastore.yaml and the catalog folders), for a
 * move to or from the root; refused, before anything moves, when one of them is taken at the target.
 */
async function rootEntries(app: App, settings: DatanotesSettings, oldRoot: string, newRoot: string): Promise<string[]> {
  const ms = await loadMetastore(app, settings);
  const entries = databaseEntries(METASTORE_FILE, ms ? Object.keys(ms.model.catalogs) : []);
  const taken = entries.filter((e) => {
    const target = inDatabase(newRoot, e).toLowerCase();
    return app.vault.getFiles().some((f) => f.path.toLowerCase() === target || f.path.toLowerCase().startsWith(`${target}/`)) || app.vault.getAbstractFileByPath(inDatabase(newRoot, e)) != null;
  });
  if (taken.length > 0) {
    throw new DatabaseConfigError(
      `"root": ${taken.map((e) => inDatabase(newRoot, e)).join(", ")} already ${taken.length === 1 ? "exists" : "exist"} in the vault`,
      guide(`The database's ${newRoot === "" ? "names at the root of the vault" : "folder"} must be free: move or rename ${taken.join(", ")} first, or choose another root, e.g. ${ROOT_EXAMPLE}.`, "moveDatabase"),
    );
  }
  return entries;
}

/** Rename the folder `from` to `to` through the vault (links follow); on Windows, file by file when a file is open. */
async function renameFolder(app: App, from: string, to: string): Promise<void> {
  const folder = app.vault.getAbstractFileByPath(from);
  if (folder == null) return;
  const parent = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
  if (parent !== "") await ensureFolder(app, parent);
  try {
    await app.fileManager.renameFile(folder as TFile, to);
  } catch {
    // Windows refuses to rename a folder while a file in it is open (EPERM): move file by file.
    await moveFilesOneByOne(app, from, to);
  }
}

/**
 * Change the database folder and/or its configuration. Renaming the folder goes through the vault
 * (links follow; a case-only rename goes through a temporary name, which file systems that ignore
 * case need), then the settings are saved (the host records the new place) and the move is
 * recorded ({@link recordDatabaseMove}): links still pointing into the old folder and generated
 * columns are brought up to date in the same operation. The move itself is not undone: call it
 * again with the old value to revert.
 */
export async function configureDatabase(
  app: App,
  settings: DatanotesSettings,
  input: ConfigureDatabaseInput,
  saveSettings: () => Promise<void>,
): Promise<DatabaseDescription> {
  const current = await readDatabaseConfig(app, settings);
  const cfg = validateConfig({
    ...current,
    ...Object.fromEntries(CONFIG_KEYS.filter((k) => input[k] !== undefined).map((k) => [k, String(input[k]).trim()])),
    ...Object.fromEntries(BOOLEAN_KEYS.filter((k) => input[k] !== undefined).map((k) => [k, input[k] === true])),
  } as DatabaseConfig);
  if (input.root !== undefined) {
    const oldRoot = databaseRoot(settings);
    const newRoot = checkDatabaseRoot(app, oldRoot, input.root);
    if (newRoot !== oldRoot) {
      // One operation: the vault events of the rename are the engine's own (the change feed hears
      // of the move from recordDatabaseMove, and the runtime does not look for a lost database).
      // to or from the root of the vault: the database's names there move, one by one
      const entries = oldRoot === "" || newRoot === "" ? await rootEntries(app, settings, oldRoot, newRoot) : null;
      await whileWriting(app, () => bulkWrite(app, async () => {
        if (entries) {
          for (const e of entries) await renameFolder(app, inDatabase(oldRoot, e), inDatabase(newRoot, e));
          // the folder the database left, now empty
          const left = oldRoot === "" ? null : app.vault.getAbstractFileByPath(oldRoot);
          if (left != null && app.vault.getFiles().every((f) => !f.path.startsWith(`${oldRoot}/`))) await app.vault.delete(left as TFile, true).catch(() => undefined);
        } else if (newRoot.toLowerCase() === oldRoot.toLowerCase()) {
          const tmp = `${newRoot}-renaming-${Date.now().toString(36)}`;
          await renameFolder(app, oldRoot, tmp);
          await renameFolder(app, tmp, newRoot);
        } else await renameFolder(app, oldRoot, newRoot);
        settings.databaseFolder = newRoot;
        await saveSettings();
        await recordDatabaseMove(app, settings, { from: oldRoot, to: newRoot, by: "configure_database" });
      }));
    }
  }
  await writeDatabaseConfig(app, settings, cfg, new Set(Object.keys(input).filter((k) => input[k as keyof ConfigureDatabaseInput] !== undefined)));
  return describeDatabase(app, settings);
}

/** What {@link recordDatabaseMove} did. */
export interface RecordedMove extends DatabaseMove {
  /** The journal entry of the move (op `move_database`). */
  migrationId: string;
  /** Notes whose links into the old folder were repaired. */
  linksRepaired: string[];
  /** Rows whose generated columns were brought up to date (a link column whose target moved). */
  recomputed: string[];
  /** Tables whose transaction log got the move's commit. */
  tables: string[];
}

/**
 * The generated columns of every table brought up to date, written at once: after a move of the
 * database folder, a generated link (`link({day:YYYY-MM-DD})`) names the new folder. Returns the
 * journal rows of what it wrote.
 */
async function recomputeGenerated(app: App, settings: DatanotesSettings): Promise<JournalRow[]> {
  const ms = await loadMetastore(app, settings);
  if (!ms) return [];
  const out: JournalRow[] = [];
  for (const { ref } of catalogTables(ms.model)) {
    const t = catalogLoadedTable(settings, ms, ref);
    if (!t.def.columns.some((c) => c.generated !== undefined)) continue;
    await eachLimit(await loadRows(app, settings, t, true), MOVE_WRITES, async (r) => {
      const after = withGenerated(t, settings, r.ordered, r.file.path);
      if (JSON.stringify(after) === JSON.stringify(r.ordered)) return;
      const d = diffOrdered(r.ordered, after);
      const order = after.map(([k]) => k);
      await writeFrontmatter(app, r.file, (fm) => applyDiff(fm, d.set, d.remove, order));
      out.push({ path: r.file.path, before: d.beforeValues, before_absent: d.beforeAbsent, before_order: r.ordered.map(([k]) => k), after: d.afterValues, after_absent: d.afterAbsent });
    });
  }
  return out;
}

/**
 * Record a move of the database folder, once its files are at `to` and `settings.databaseFolder`
 * is `to`, as ONE operation, applied before the engine serves anything else: the tables' archive
 * and exclude folders inside it follow (metastore.yaml), links still pointing into the old folder
 * are repaired across the vault (a move by hand: the vault did not rewrite them), generated
 * columns are recomputed in bulk, and the move goes to the store (database_moves.jsonl, read by the
 * journal and the transaction log), the journal (one `move_database` entry, listed but not
 * undone, with the rows it recomputed) and every table's transaction log (a `MOVE DATABASE`
 * commit). Listeners (the change feed, git sync) hear of it once.
 */
export async function recordDatabaseMove(
  app: App,
  settings: DatanotesSettings,
  move: { from: string; to: string; by: DatabaseMove["by"] },
  now: Date = new Date(),
): Promise<RecordedMove> {
  const { from, to, by } = move;
  return whileWriting(app, () =>
    withLogLock(app, async () => {
      const ms = await loadMetastore(app, settings);
      // to or from the root of the vault: what moved are the database's names there, not the root
      const entries = from === "" || to === "" ? databaseEntries(METASTORE_FILE, ms ? Object.keys(ms.model.catalogs) : []) : undefined;
      const record: DatabaseMove = { from, to, at: now.toISOString(), by, ...(entries ? { entries } : {}) };
      await appendDatabaseMove(app, record);
      forgetLoggedStates(app);
      if (ms) {
        const after = rebaseTablePaths(ms.text, from, to, entries);
        if (after !== ms.text) {
          await app.vault.process(ms.file, () => after);
          primeMetastore(app, settings, after);
        }
      }
      const linksRepaired: string[] = [];
      // a case-only rename: the old name still finds the folder where the file system ignores case;
      // from the root, the database's names left it
      const oldGone = from === "" || from.toLowerCase() === to.toLowerCase() || app.vault.getAbstractFileByPath(from) == null;
      // thousands of writes at once: the host stops following the disk meanwhile (bulkWrite)
      const rows = await bulkWrite(app, async () => {
        if (oldGone) {
          await eachLimit(app.vault.getMarkdownFiles(), MOVE_WRITES, async (f) => {
            const text = await app.vault.read(f);
            const next = moveLinks(text, from, to, entries);
            if (next === text) return;
            await app.vault.process(f, () => next);
            linksRepaired.push(f.path);
          });
          linksRepaired.sort();
          invalidateFiles(app, linksRepaired);
        }
        return recomputeGenerated(app, settings);
      });
      rows.sort((a, b) => a.path.localeCompare(b.path));
      const recomputed = rows.map((r) => r.path);
      invalidateFiles(app, recomputed);
      const name = (folder: string) => (folder === "" ? "the root of the vault" : folder);
      const summary = `move the database folder from ${name(from)} to ${name(to)}${by === "hand" ? " (moved by hand)" : ""}`;
      const journal = await writeJournal(
        app,
        settings,
        {
          op: "move_database",
          summary,
          executed_at: record.at,
          rows,
          creates: [],
          moves: [],
          references: [],
          deleted: [],
          failed: [],
          ...(currentActor() ? { actor: currentActor() } : {}),
        },
        now,
      );
      const commits = await syncTransactionLogs(app, settings, {
        operation: "MOVE DATABASE",
        parameters: { from, to, by },
        migrationId: journal.id,
        touched: [...new Set([...linksRepaired, ...recomputed])],
        always: true,
        now,
      });
      notifyApplied(app, {
        op: "move_database",
        summary,
        migrationId: journal.id,
        paths: [],
        moves: [],
        deletes: [],
        databaseMove: { from, to, by, ...(entries ? { entries } : {}) },
        ...(currentActor() ? { actor: currentActor() } : {}),
      });
      telemetry().log(by === "hand" ? "WARN" : "INFO", "datanotes database folder moved", { from, to, by, links_repaired: linksRepaired.length, recomputed: recomputed.length });
      return { ...record, migrationId: journal.id, linksRepaired, recomputed, tables: commits.map((c) => c.table) };
    }),
  );
}
