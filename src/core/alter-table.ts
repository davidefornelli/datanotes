/**
 * alter_table: move a table (catalog, schema, name) or change its options; its rows, archived
 * rows and transaction log follow it to their new paths.
 */

import type { App, TFile } from "./host";
import { emptyChangeSet, type ChangeSet } from "./changeset";
import { transactionLogDir, listVersions } from "./transaction-log";
import { storeList } from "./store";
import {
  cachedMetastore,
  catalogTablePath,
  catalogTables,
  catalogViews,
  loadMetastore,
  metastorePath,
  orderedToEntry,
  parseMetastore,
  refOf,
  resolveCatalogRef,
  rowTableFull,
  setBaseEntry,
  setTableEntries,
  setViewEntry,
  tableTags,
  withTableTags,
  type CatalogRef,
  type CatalogTableEntry,
  type Metastore,
} from "./metastore";
import {
  finish,
  packOptions,
  serializeOptions,
  instrumented,
  emptyResult,
  withSystemIdColumn,
  loadRows,
  loadTable,
  OperationInputError,
  refused,
  tagsInput,
  type LoadedTable,
  type OpConflict,
  type OpResult,
  type RunOptions,
  type SchemaReference,
} from "./engine";
import { fmDelete, fmGet, fmSet, readOrderedFromMarkdown } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { TABLE_KEY, type TableLayout, type TableOptions } from "./types-table";
import { assertIdentifier, databaseRoot, readDatabaseConfig } from "./database";
import { catalogLayout, parseTableOptions } from "./table-loader";
import { TABLE_META_KEYS } from "./reserved-keys";
import { packPartitionWarning } from "./pack-layout";
import type { OrderedFrontmatter } from "./types";
import { isEmptyValue } from "./validate";
import { basenameOf, claimFreeName, renderPathTemplate } from "./path-templates";
import { withIdentity, withRowId } from "./computed-columns";
import { knownKeys } from "./where";
import { messageOf } from "./message";
import { guide } from "./hints";
import { hasText, removedDescriptionRefusal } from "./descriptions";

// --- move_table ---

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rows moved to the table's archive folder (still members of the table, but not rows). */
function archivedRowFiles(app: App, settings: DatanotesSettings, t: LoadedTable): TFile[] {
  const archive = `${t.def.layout.archive}/`;
  const model = cachedMetastore(app, settings);
  const full = t.catalog.ref.full;
  return app.vault.getMarkdownFiles().filter((f) => {
    if (!f.path.startsWith(archive) || !model) return false;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    return rowTableFull(model, fm?.[settings.tableKey]) === full;
  });
}


/** The table a view's query names (`table`, a union branch's, a join's), on `model`; null when it names none. */
function viewTable(model: Metastore, name: string): string | null {
  try {
    return resolveCatalogRef(model, name)?.full ?? null;
  } catch {
    return null; // ambiguous: it names no one table
  }
}

/**
 * The references to table `from` in the other definitions of the metastore, rewritten to `to`
 * (the table moved or renamed): the `ref` and `vocabulary` of the columns of other tables and of
 * the bases, and the tables of the views' queries (`table`, `union[].table`, `join.table`).
 * `text` is the metastore as the move writes it (the table under its new name); `model` is the
 * metastore as it is. A view that names the table so that the name still finds it (`food`, after a
 * move to another schema) is left as written. CHECKs and link filters (`ref_where` / `ref_by`)
 * name columns, never tables: they follow the rewritten `ref`.
 */
function movedReferences(text: string, model: Metastore, from: string, to: string): { text: string; references: SchemaReference[] } {
  const references: SchemaReference[] = [];
  const moved = (c: Record<string, unknown>, owner: { table: string } | { base: string }) => {
    let out = c;
    for (const key of ["ref", "vocabulary"] as const) {
      if (c[key] !== from) continue;
      out = { ...out, [key]: to };
      references.push({ ...owner, column: String(c.name), key, from, to });
    }
    return out;
  };
  let after = text;
  for (const [name, base] of Object.entries(model.bases)) {
    const columns = base.columns.map((c) => moved(c, { base: name }));
    if (columns.some((c, i) => c !== base.columns[i])) after = setBaseEntry(after, name, { ...base, columns });
  }
  const tables: [CatalogRef, CatalogTableEntry][] = [];
  for (const { ref, entry } of catalogTables(model)) {
    if (ref.full === from) continue; // the moved table: the move writes its entry
    const columns = entry.columns.map((c) => moved(c, { table: ref.full }));
    if (columns.some((c, i) => c !== entry.columns[i])) tables.push([ref, { ...entry, columns }]);
  }
  after = setTableEntries(after, tables);
  let next: Metastore;
  try {
    next = parseMetastore(after);
  } catch {
    return { text: after, references }; // the new name is a view's: a conflict refuses the move
  }
  for (const { ref, view } of catalogViews(model)) {
    const q = view.query;
    const renamed = (name: unknown, key: string): unknown => {
      if (typeof name !== "string" || viewTable(model, name) !== from || viewTable(next, name) === to) return name;
      references.push({ view: ref.full, key, from: name, to });
      return to;
    };
    const query: Record<string, unknown> = { ...q };
    if (q.table !== undefined) query.table = renamed(q.table, "table");
    if (Array.isArray(q.union)) {
      query.union = q.union.map((b: unknown, i) => (b && typeof b === "object" ? { ...(b as object), table: renamed((b as { table?: unknown }).table, `union[${i}].table`) } : b));
    }
    if (q.join && typeof q.join === "object" && !Array.isArray(q.join)) query.join = { ...(q.join as object), table: renamed((q.join as { table?: unknown }).table, "join.table") };
    if (JSON.stringify(query) !== JSON.stringify(q)) after = setViewEntry(after, ref, { ...view, query });
  }
  return { text: after, references };
}

/** Move a table and its rows (ALTER TABLE): its entry in `metastore.yaml` goes to `dest`, every row to its new computed path. */
async function relocateTable(
  app: App,
  settings: DatanotesSettings,
  t: LoadedTable,
  dest: { catalogRef: CatalogRef },
  changes: Record<string, unknown>,
  opts: RunOptions,
  /** Metastore-only table properties to set (`null` removes one), e.g. `history`. */
  properties: Record<string, unknown> = {},
  /** New `row_template` (null removes it; undefined keeps it). */
  rowTemplate?: string | null,
  /** The table's tags after the change (undefined keeps them; `{}` removes them). */
  tags?: Record<string, string>,
  /** Untyped fields to set (`null` removes one): the entry's `defaults`. */
  fields: Record<string, unknown> = {},
  /** New `instructions` (null or "" removes them; undefined keeps them). */
  instructions?: string | null,
): Promise<OpResult> {
  const conflicts: OpConflict[] = [];
  const merged: Record<string, unknown> = { ...serializeOptions(t.def.options)[0] }; // it has a name at least
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const membership = new Set([settings.tableKey]);
  let options: TableOptions;
  let layout: TableLayout;
  let member: (ordered: OrderedFrontmatter) => OrderedFrontmatter;
  const taken = new Set<string>();
  let cs: ChangeSet;
  let references: SchemaReference[] = [];
  {
    const ref = dest.catalogRef;
    options = parseTableOptions([{ ...merged, name: ref.table }]);
    layout = catalogLayout(databaseRoot(settings), ref, options);
    // Rows carry the system UUID id (a row without one gets it when it moves).
    member = (o) => withRowId([[settings.tableKey, ref.full], ...o.filter(([k]) => !membership.has(k))] as OrderedFrontmatter);
    // the table was just loaded from it
    const { text, model } = (await loadMetastore(app, settings))!;
    const sch = model.catalogs[ref.catalog]?.schemas[ref.schema];
    if (ref.full !== t.catalog.ref.full && (sch?.tables[ref.table] || sch?.views[ref.table])) {
      conflicts.push({ path: catalogTablePath(settings, ref.full), message: `${ref.full} already exists` });
    }
    let schemaOrdered = fmSet(t.ordered.filter(([k]) => !membership.has(k)), TABLE_KEY, serializeOptions(options));
    for (const [k, v] of Object.entries(fields)) schemaOrdered = v === null ? fmDelete(schemaOrdered, k) : fmSet(schemaOrdered, k, v);
    const entry = withSystemIdColumn(orderedToEntry(schemaOrdered, t.catalog.entry, settings, { model, ref, previousRef: t.catalog.ref }));
    if (Object.keys(properties).length > 0) {
      const props = { ...(entry.options ?? {}) };
      for (const [k, v] of Object.entries(properties)) {
        if (v === null) delete props[k];
        else props[k] = v;
      }
      if (Object.keys(props).length > 0) entry.options = props;
      else delete entry.options;
    }
    if (rowTemplate === null || (typeof rowTemplate === "string" && rowTemplate.trim() === "")) delete entry.row_template;
    else if (typeof rowTemplate === "string") entry.row_template = rowTemplate;
    if (instructions === null || (typeof instructions === "string" && instructions.trim() === "")) delete entry.instructions;
    else if (typeof instructions === "string") entry.instructions = instructions;
    // a move: the old entry removed and the new one set, in one edit of the text
    const from = t.catalog.ref.full;
    // a vocabulary of the table itself follows its new name, as its links to itself do (ownColumns)
    if (from !== ref.full) entry.columns = entry.columns.map((c) => (c.vocabulary === from ? { ...c, vocabulary: ref.full } : c));
    let after = setTableEntries(text, [...(from !== ref.full ? [[t.catalog.ref, null] as const] : []), [ref, tags === undefined ? entry : withTableTags(entry, tags)] as const]);
    // what names the table in other definitions follows it too, as the links in the notes do
    if (from !== ref.full) ({ text: after, references } = movedReferences(after, model, from, ref.full));
    cs = emptyChangeSet("alter_table", from === ref.full ? `alter table ${from}` : `move table ${from} to ${ref.full}`, catalogTablePath(settings, ref.full));
    if (after !== text) cs.texts.push({ path: metastorePath(settings), before: text, after });
    // The transaction log follows the table to its new name.
    if (t.catalog.ref.full !== ref.full) {
      const oldDir = transactionLogDir(settings, t.catalog.ref.full);
      const newDir = transactionLogDir(settings, ref.full);
      if ((await listVersions(app, settings, ref.full)).length > 0) {
        conflicts.push({ path: newDir, message: `${ref.full} already has a transaction log (a dropped table?): vacuum it or pick another name` });
      }
      for (const f of (await storeList(app, oldDir)).files) {
        cs.moves.push({ from: f, to: `${newDir}/${f.slice(oldDir.length + 1)}` });
      }
    }
  }

  const known = knownKeys(t, settings);
  const claim = (base: string, self: string): string => {
    const to = claimFreeName(base, (p) => p !== self && (taken.has(p) || app.vault.getAbstractFileByPath(p) != null));
    taken.add(to);
    return to;
  };
  const relink = (r: { path: string; ordered: OrderedFrontmatter }, to: string) => {
    let after = member(r.ordered);
    const oldName = basenameOf(r.path);
    const newName = basenameOf(to);
    if (to !== r.path) after = withIdentity(t, after, to);
    if (to !== r.path && known.has("aliases") && oldName !== newName && !oldName.startsWith(newName)) {
      const cur = fmGet(after, "aliases");
      const list = Array.isArray(cur) ? cur : isEmptyValue(cur) ? [] : [cur];
      if (!list.includes(oldName)) after = fmSet(after, "aliases", [...list, oldName]);
    }
    if (JSON.stringify(after) !== JSON.stringify(r.ordered)) {
      cs.edits.push({ path: r.path, before: r.ordered, after });
    }
    if (to !== r.path) cs.moves.push({ from: r.path, to });
  };

  // A change of metadata only (tags, description, history, fields, …) rewrites the table entry
  // alone: rows are moved or rewritten only when where they go changes, archived rows only when
  // the archive folder does.
  const renamed = dest.catalogRef.full !== t.catalog.ref.full;
  const rowsMove =
    renamed ||
    layout.rowPath !== t.def.layout.rowPath ||
    (options.filename ?? "") !== (t.def.options.filename ?? "") ||
    JSON.stringify(options.exclude ?? []) !== JSON.stringify(t.def.options.exclude ?? []);
  const archiveMoves = renamed || layout.archive !== t.def.layout.archive;

  // Notes in folders the (new) options exclude stop being rows: they are not moved or relinked.
  const excluded = (p: string) => (options.exclude ?? []).some((dir) => p.startsWith(`${dir.replace(/\/+$/, "")}/`));
  const rows = rowsMove ? (await loadRows(app, settings, t)).filter((r) => !excluded(r.file.path)) : [];
  const bases = new Map<string, string>();
  if (options.filename) {
    for (const r of rows) {
      try {
        const values = new Map(r.ordered);
        bases.set(r.file.path, `${renderPathTemplate(layout.rowPath, values)}/${renderPathTemplate(options.filename, values)}`);
      } catch (e) {
        conflicts.push({ path: r.file.path, message: `cannot compute the new path: ${messageOf(e)}` });
      }
    }
    // A row already named `<base>` or `<base>-N` keeps its suffix, so clashing rows do not swap names.
    for (const r of rows) {
      const base = bases.get(r.file.path);
      if (base === undefined) continue;
      const own = basenameOf(r.file.path);
      const baseName = basenameOf(base);
      const dir = base.slice(0, base.length - baseName.length);
      if (own !== baseName && !new RegExp(`^${escapeRegExp(baseName)}-\\d+$`).test(own)) continue;
      const keep = `${dir}${own}.md`;
      if (!taken.has(keep) && (keep === r.file.path || app.vault.getAbstractFileByPath(keep) == null)) {
        taken.add(keep);
        bases.set(r.file.path, `\0${keep}`);
      }
    }
  }
  for (const r of rows) {
    const base = bases.get(r.file.path);
    if (options.filename && base === undefined) continue; // conflict above
    const to = base === undefined ? r.file.path : base.startsWith("\0") ? base.slice(1) : claim(base, r.file.path);
    relink({ path: r.file.path, ordered: r.ordered }, to);
  }
  // Archived rows (not rows any more, but still linked to the schema) follow to the new archive.
  const newArchive = layout.archive;
  for (const f of archiveMoves ? archivedRowFiles(app, settings, t) : []) {
    const { ordered } = readOrderedFromMarkdown(await app.vault.read(f), membership);
    // archiveMoves means the archive folder changes: a rename gives the table a new folder, and
    // alterTableImpl turns a vault-path archive into a folder name inside it, so never the same path
    const to = claim(`${newArchive}/${basenameOf(f.path)}`, f.path);
    relink({ path: f.path, ordered }, to);
  }
  const result = await finish(app, settings, cs, conflicts, [], opts);
  return references.length > 0 ? { ...result, schema_references: references } : result;
}

// --- alter_table ---

export interface AlterTableInput {
  table: string;
  /** Move the table to this catalog (rows then declare `table: catalog.schema.name`). */
  catalog?: string;
  /** Move the table to this schema (namespace). */
  schema?: string;
  /** Rename the table (its folder). */
  name?: string;
  /** Row sub-folder pattern inside the table folder, e.g. `{occurred_at:YYYY/MM}`; "" = flat. */
  partition?: string;
  filename?: string;
  /** The new description: what a row records. Null or "" is refused: a description changes, never goes. */
  description?: string | null;
  aliases?: string[] | null;
  exclude?: string[] | null;
  /** Transaction log for this table: true / false, or null to follow the database setting. */
  history?: boolean | null;
  /**
   * Whether automatic links may link the table's rows: true / false, or null for the default (yes,
   * unless the rows are named by a date or a time).
   */
  autolinkTarget?: boolean | null;
  /** Body of new rows (insert_row, notes created in the table folder); null removes it. */
  rowTemplate?: string | null;
  /** How to fill a row, for agents (Markdown); null or "" removes them. */
  instructions?: string | null;
  /** Tags to add or change (`{ domain: "health" }`); a `null` value removes that tag. */
  tags?: Record<string, string | null>;
  /** Remove every tag first (with `tags`: the table ends up with exactly those). */
  clearTags?: boolean;
  /** Archive folder: a folder name inside the table folder; "" = the database default. Archived rows follow. */
  archive?: string;
  /** Untyped fields to set (name → default, as in create_table `fields`); a `null` value removes that field. */
  fields?: Record<string, unknown>;
  /** Packs of rows: a template of a date column (`{started_at:YYYY-MM}`); null or "" removes it. */
  pack?: string | null;
  /** Days after the end of a period before its rows go into a pack; null for the default (7). */
  packAfterDays?: number | null;
}

/**
 * Refuse a change of where the rows go (or of their packs) while some of them are in packs: a
 * packed row keeps the path its values give, so the layout changes only once they are notes again.
 */
function assertNotPacked(app: App, t: LoadedTable, what: string): void {
  const packs = app.packs?.packsOf(t.catalog.ref.full).filter((p) => p.rows.length > 0) ?? [];
  if (packs.length === 0) return;
  const rows = packs.reduce((n, p) => n + p.rows.length, 0);
  throw new OperationInputError(
    `${t.catalog.ref.full} has ${rows} row${rows === 1 ? "" : "s"} in ${packs.length} pack${packs.length === 1 ? "" : "s"}: ${what} only while every row is a note of its own`,
    guide(`Run unpack_rows on ${t.catalog.ref.full} first, then alter the table, then pack_rows again.`, "unpackFirst"),
  );
}

/** alter_table `fields`: an object; names that are columns or reserved keys are refused. */
function fieldsInput(t: LoadedTable, settings: DatanotesSettings, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationInputError(`"fields" must be an object of front matter keys and their default values (null removes a key), e.g. {"type": "log"}`);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.trim() === "" || k !== k.trim()) throw new OperationInputError(`"fields": ${JSON.stringify(k)} is not a front matter key`);
    // Assigned to a plain object, `__proto__` would be dropped silently.
    if (k === "__proto__" || TABLE_META_KEYS.includes(k) || k === settings.tableKey) throw new OperationInputError(`"${k}" is a reserved front matter key`);
    if (t.def.columns.some((c) => c.name === k)) throw new OperationInputError(`"${k}" is a column of ${t.catalog.ref.full}: change it with alter_column, not "fields"`);
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * ALTER TABLE without paths: the table entry moves to `catalog.schema.name` in `metastore.yaml`
 * and keeps only relative layout (`partition`, archive name). Rows and archived rows move to
 * `<root>/<catalog>/<schema>/<name>/` with it (see `move_table`).
 */
async function alterTableImpl(
  app: App,
  settings: DatanotesSettings,
  input: AlterTableInput,
  opts: RunOptions = {},
): Promise<OpResult> {
  if (input.instructions !== undefined && input.instructions !== null && typeof input.instructions !== "string") {
    throw new OperationInputError(`"instructions" must be text: how to fill a row of the table`, guide(`Pass instructions as Markdown text, e.g. "1. Ask which film and when.", or leave them out; "" removes them.`, "instructions"));
  }
  const t = await loadTable(app, settings, input.table);
  const cfg = await readDatabaseConfig(app, settings);
  const schema = assertIdentifier("schema", input.schema ?? t.def.schema);
  const name = assertIdentifier("table", input.name ?? t.def.name);
  const catalog = assertIdentifier("catalog", input.catalog ?? t.def.catalog);
  const changes: Record<string, unknown> = { name: null };
  if (input.partition !== undefined) changes.partition = input.partition ? input.partition : null;
  const cur = t.def.options;
  if (input.archive !== undefined) {
    if (typeof input.archive !== "string") throw new OperationInputError(`"archive" must be a folder name inside the table folder, such as _archive ("" = the database default)`);
    const archive = input.archive.trim();
    if (archive.includes("/") || archive.includes("\\") || archive === "." || archive === "..") {
      throw new OperationInputError(`"archive" must be a single folder name inside the table folder, such as _archive, not "${input.archive}"`);
    }
    changes.archive = archive === "" ? cfg.archive_folder : archive;
  } else if (
    // An archive given as a vault path becomes a folder name inside the table folder, when the
    // table moves or its layout changes (a change of metadata only leaves the archive alone).
    [input.catalog, input.schema, input.name, input.partition, input.filename, input.exclude].some((v) => v !== undefined) &&
    (!cur.archive || cur.archive.includes("/"))
  ) {
    const own = t.def.layout.archive;
    changes.archive = own.startsWith(`${t.def.layout.folder}/`) && !own.slice(t.def.layout.folder.length + 1).includes("/")
      ? own.slice(t.def.layout.folder.length + 1)
      : cfg.archive_folder;
  }
  if (input.filename !== undefined) changes.filename = input.filename;
  // a description may change, never go (another type is the options' parser's to refuse)
  const d = input.description;
  if (d === null || (typeof d === "string" && !hasText(d))) throw refused(removedDescriptionRefusal(t.catalog.ref.full));
  if (d !== undefined) changes.description = d;
  if (input.aliases !== undefined) changes.aliases = input.aliases;
  if (input.exclude !== undefined) changes.exclude = input.exclude;
  let tags: Record<string, string> | undefined;
  if (input.tags !== undefined || input.clearTags === true) {
    const given = input.tags === undefined ? {} : tagsInput(input.tags, true);
    const current = tableTags(t.catalog.entry) ?? {};
    tags = input.clearTags === true ? {} : { ...current };
    for (const [k, v] of Object.entries(given)) {
      if (v === null) delete tags[k];
      else tags[k] = v;
    }
    // Tags as they are (`tags: {}`, a removal of an absent tag): the entry's `tags` stay untouched.
    const same = Object.keys(tags).length === Object.keys(current).length && Object.entries(tags).every(([k, v]) => current[k] === v);
    if (same) {
      tags = undefined;
      const { table: _t, tags: _g, clearTags: _c, ...other } = input;
      if (Object.values(other).every((v) => v === undefined)) return { ...emptyResult("alter_table", opts.dryRun === true), ok: true };
    }
  }
  const fields = input.fields === undefined ? {} : fieldsInput(t, settings, input.fields);
  const own = t.catalog.entry.options ?? {};
  const packProps: Record<string, unknown> = {};
  if (input.pack !== undefined) {
    const removed = input.pack === null || (typeof input.pack === "string" && input.pack.trim() === "");
    const next = removed ? null : packOptions(app, t.catalog.ref.full, t.def.columns, input.pack, undefined).pack!;
    if (next !== (own.pack ?? null)) {
      assertNotPacked(app, t, removed ? "the pack option goes" : "the pack option changes");
      packProps.pack = next;
    }
  }
  if (input.packAfterDays !== undefined) packProps.pack_after_days = input.packAfterDays === null ? null : packOptions(app, t.catalog.ref.full, t.def.columns, undefined, input.packAfterDays).pack_after_days!;
  const layoutChanges =
    (input.catalog !== undefined && input.catalog !== t.def.catalog) ||
    (input.schema !== undefined && input.schema !== t.def.schema) ||
    (input.name !== undefined && input.name !== t.def.name) ||
    (input.partition !== undefined && (input.partition || undefined) !== cur.partition) ||
    (input.filename !== undefined && input.filename !== cur.filename);
  if (layoutChanges) assertNotPacked(app, t, "the table moves or its rows change folder or name");
  // the layout after the change: a partition wider than the packs' periods is worth a warning
  const partition = input.partition !== undefined ? input.partition.trim().replace(/^\/+|\/+$/g, "") || undefined : cur.partition;
  const pack = packProps.pack !== undefined ? ((packProps.pack as string | null) ?? undefined) : own.pack;
  const warning = packPartitionWarning(refOf(catalog, schema, name).full, partition, pack);
  const result = await relocateTable(app, settings, t, { catalogRef: refOf(catalog, schema, name) }, changes, opts, {
    ...(input.history !== undefined ? { history: input.history } : {}),
    ...(input.autolinkTarget !== undefined ? { autolink_target: input.autolinkTarget } : {}),
    ...packProps,
  }, input.rowTemplate, tags, fields, input.instructions);
  return warning ? { ...result, warnings: [warning] } : result;
}

export const alterTable = instrumented("alter_table", alterTableImpl, (i) => ({ table: i.table, schema: i.schema, name: i.name }));
