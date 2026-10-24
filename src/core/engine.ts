/**
 * Headless table engine — DDL operations (phase 33).
 *
 * Every operation: load → compute a {@link ChangeSet} for all affected notes → refuse with
 * conflicts/violations (no write) → or, unless `dryRun`, write it via {@link applyChangeSet}
 * (journaled, undoable).
 */

import { currentActor, type Actor } from "./actor";
import { markUndone, readJournal, writeJournal } from "./journal";
import { inverseEditsFor } from "./inverse";
import { assertChangeSetWritable } from "./write-scope";
import type { App, TFile } from "./host";
import { invalidateFiles, readBody, readFrontmatter, readFrontmatterEntries } from "./file-cache";
import {
  transactionLogRoot,
  EXTERNAL_EDIT,
  forgetLoggedStates,
  syncTransactionLogs,
  withLogLock,
  type ExternalLogChange,
  type SyncedCommit,
  type SyncOptions,
} from "./transaction-log";
import {
  undoChangeSet,
  undoMigration,
  type JournalEntry,
  type UndoConflict,
  type UndoResult,
  applyChangeSet,
  diffOrdered,
  editIsNoop,
  emptyChangeSet,
  fileOrNull,
  type ChangeSet
} from "./changeset";
import {
  buildMarkdownWithFrontmatter,
  fmAdd,
  fmDelete,
  fmGet,
  fmRename,
  fmSet,
  readOrderedFromMarkdown,
} from "./frontmatter";
import { TABLE_META_KEYS } from "./reserved-keys";
import { catalogRowFiles, sortedRowFiles } from "./row-files";
import { vaultIndex } from "./vault-index";
import {
  catalogTablePath,
  entryToOrdered,
  loadMetastore,
  MetastoreError,
  metastorePath,
  parseMetastore,
  refOf,
  orderedToEntry,
  primeWrittenMetastore,
  resolveCatalogRef,
  effectiveColumns,
  setTableEntries,
  setTableEntry,
  withTableTags,
  type CatalogRef,
  type CatalogTableEntry,
  type Metastore,
} from "./metastore";
import { linkTargetOf, modelColumns, readersBlocking, readsColumn, rewrittenEntries } from "./link-paths";
import type { DatanotesSettings } from "./settings";
import { tableNotFound, validationContextFor } from "./table-registry";
import { parseColumn, parseLinkLevels, parseTableOptions, tableDefinitionFromOrdered } from "./table-loader";
import { assertIdentifier, readDatabaseConfig } from "./database";
import { normalizeDatetime, resolveDefault } from "./datetime";
import {
  COLUMNS_KEY,
  SYSTEM_ID_COLUMN,
  SYSTEM_ID_SPEC,
  TABLE_KEY,
  type ColumnSpec,
  type TableDefinition,
  type TableOptions,
  type Violation,
} from "./types-table";
import type { OrderedFrontmatter } from "./types";
import type { ExternalEdit } from "./external-edits";
import type { LinkAdded, LinkAmbiguous } from "./autolink";
import { isEmptyValue, requiredMessage, validateValue } from "./validate";
import { telemetry, traced, type AttrValue, type Severity } from "./telemetry";
import { messageOf } from "./message";
import { closestNames, guide, GuidedError, unknownColumn, type Guidance } from "./hints";
import { addColumnRefusal, createTableRefusal, hasText, missingDescriptions, removedDescriptionRefusal, withEngineDescription, type Refusal } from "./descriptions";
import { STALE_WRITE, staleWrite, wrote } from "./write-check";
import { count, phase } from "./tracing";

export interface OpConflict {
  path: string;
  message: string;
}

export interface RowViolations {
  path: string;
  violations: Violation[];
}

export interface PlannedNoteChange {
  path: string;
  set: Record<string, unknown>;
  remove: string[];
  /** True when the note body changes too. */
  body?: boolean;
}

/**
 * A reference to a table in another definition: a column's `ref` or `vocabulary` (of a table or a
 * base), or a table a view's query reads (`key`: `table`, `union[1].table`, `join.table`).
 */
export interface SchemaReference {
  /** The table whose column names it (full name). */
  table?: string;
  /** The base whose column names it. */
  base?: string;
  /** The view whose query names it (full name). */
  view?: string;
  /** The column of the table or base. */
  column?: string;
  /** Where the name is: `ref` or `vocabulary` of the column, or a key of the view's query. */
  key: string;
  /** The name as written before. */
  from: string;
  /** The name written in its place. */
  to: string;
}

export interface OpResult {
  ok: boolean;
  op: string;
  dry_run: boolean;
  migration_id?: string;
  notes_changed: number;
  files_created: number;
  files_moved: number;
  files_deleted: number;
  references_updated: number;
  conflicts: OpConflict[];
  violations: RowViolations[];
  failed: { path: string; error: string }[];
  /**
   * Set when a write failed partway (`failed`): true when the engine put back what it had written
   * (nothing is left written), false when that rollback failed too (`failed` names the files left;
   * undo_migration on `migration_id` retries it).
   */
  rolled_back?: boolean;
  planned_edits: PlannedNoteChange[];
  planned_creates: string[];
  planned_moves: { from: string; to: string }[];
  planned_deletes: string[];
  /** Whole-file text writes, e.g. `metastore.yaml` for metastore DDL. */
  planned_texts: string[];
  /** Transaction-log commits written (metastore tables only). */
  commits?: SyncedCommit[];
  /** Links the write added to the text it wrote (automatic links, `autolink.ts`). */
  links_added?: LinkAdded[];
  /** Mentions in that text left unlinked: the agent reads the candidates and links the right one. */
  ambiguous_mentions?: LinkAmbiguous[];
  /**
   * alter_table that moves or renames a table: the references to it in other definitions that the
   * move rewrites (or, on a dry run, would). Present when there is one.
   */
  schema_references?: SchemaReference[];
  /** Query lines rewritten (or to be rewritten on a dry run) by `rename_value`. */
  /** Occurrences `rename_value` did not change because it cannot be sure they refer to the table. */
}

export interface RunOptions {
  dryRun?: boolean;
  now?: Date;
}

/** A call's arguments the operation cannot run with: what is wrong, and (`hint`, `docs`) how to fix it. */
export class OperationInputError extends GuidedError {
  override readonly name = "OperationInputError";
}

/** A refusal (src/core/descriptions.ts) as the error an operation throws. */
export function refused(r: Refusal): OperationInputError {
  return new OperationInputError(r.message, r.guidance);
}

/**
 * Table tags given to create_table / alter_table: an object of strings (`{"domain": "health"}`).
 * With `allowNull` (alter_table) a `null` value removes that tag.
 */
export function tagsInput(value: unknown, allowNull: boolean): Record<string, string | null> {
  const example = `e.g. {"domain": "health"}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationInputError(`"tags" must be an object of strings, ${example}`);
  }
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.trim() === "") throw new OperationInputError(`"tags": a tag name must be a non-empty string`);
    // " domain " next to "domain" would be two different tags that look the same.
    if (k !== k.trim()) throw new OperationInputError(`"tags": the tag name ${JSON.stringify(k)} has spaces around it: write "${k.trim()}"`);
    // Assigned to a plain object, `__proto__` would be dropped silently.
    if (k === "__proto__") throw new OperationInputError(`"tags": "__proto__" cannot be a tag name`);
    if (v === null && allowNull) out[k] = null;
    else if (typeof v === "string") out[k] = v;
    else {
      throw new OperationInputError(
        `"tags.${k}" must be a string${allowNull ? " (or null to remove the tag)" : ""}, not ${v === null ? "null" : Array.isArray(v) ? "a list" : typeof v}: ${example}`,
      );
    }
  }
  return out;
}

// --- Shared helpers ---

export interface LoadedTable {
  /** The metastore file (`metastore.yaml`). */
  file: TFile;
  ordered: OrderedFrontmatter;
  def: TableDefinition;
  /** The table's entry in the metastore (`metastore.yaml`). */
  catalog: { ref: CatalogRef; entry: CatalogTableEntry; text: string; model: Metastore };
}

/** A metastore table as a {@link LoadedTable}. */
export function catalogLoadedTable(
  settings: DatanotesSettings,
  ms: { file: TFile; text: string; model: Metastore },
  ref: CatalogRef,
): LoadedTable {
  const entry = ms.model.catalogs[ref.catalog]!.schemas[ref.schema]!.tables[ref.table]!;
  const ordered = entryToOrdered(ref, entry, settings, ms.model);
  const def = tableDefinitionFromOrdered(ref, catalogTablePath(settings, ref.full), ordered, settings);
  return { file: ms.file, ordered, def, catalog: { ref, entry, text: ms.text, model: ms.model } };
}

/**
 * Retries for table resolution: right after a write of metastore.yaml the metastore cache may
 * still hold the previous text, so back-to-back operations would 404.
 */
export const INDEX_RETRY = { attempts: 8, delayMs: 150 };


export async function loadTable(
  app: App,
  settings: DatanotesSettings,
  ref: string,
): Promise<LoadedTable> {
  // Tables live in metastore.yaml; a note that has just been written may need a moment to be indexed.
  for (let i = 0; ; i++) {
    const ms = await loadMetastore(app, settings);
    const cref = ms ? resolveCatalogRef(ms.model, ref) : null;
    if (ms && cref) return catalogLoadedTable(settings, ms, cref);
    if (i >= INDEX_RETRY.attempts) throw tableNotFound(ref, ms?.model);
    await new Promise((r) => setTimeout(r, INDEX_RETRY.delayMs));
  }
}

/** Row membership as the first frontmatter entry for table `t`. */
export function memberEntry(settings: DatanotesSettings, t: LoadedTable): [string, unknown] {
  return [settings.tableKey, t.catalog.ref.full];
}

export interface LoadedRow {
  file: TFile;
  ordered: OrderedFrontmatter;
}

/**
 * A row with its body, the Markdown after the frontmatter block: {@link loadRows} reads the bodies
 * only when asked (`bodies`), since a body needs the note's text; {@link rowBody} reads one later.
 */
export interface LoadedRowWithBody extends LoadedRow {
  body: string;
}

/** A row's body: the one it carries, else its note's (as the file cache reads it now). */
export async function rowBody(app: App, r: LoadedRow): Promise<string> {
  const own = (r as Partial<LoadedRowWithBody>).body;
  return typeof own === "string" ? own : readBody(app, r.file);
}

/**
 * The rows of a table, by path. `skipUnreadable`: a row whose frontmatter cannot be read is left
 * out instead of failing the call. `bodies`: each row with its body, read from the same version
 * of its note as its front matter (writes that keep the body); without, no note's text is needed
 * while the file cache holds its parse.
 */
export function loadRows(app: App, settings: DatanotesSettings, t: LoadedTable, skipUnreadable?: boolean): Promise<LoadedRow[]>;
export function loadRows(app: App, settings: DatanotesSettings, t: LoadedTable, skipUnreadable: boolean, o: { bodies: true }): Promise<LoadedRowWithBody[]>;
export function loadRows(app: App, settings: DatanotesSettings, t: LoadedTable, skipUnreadable = false, o: { bodies?: boolean } = {}): Promise<LoadedRow[]> {
  // a full scan of the table's notes (no index: the file cache spares the reads of unchanged ones)
  return phase("engine.query.scan", async (span) => {
    const out: LoadedRow[] = [];
    // in the order of the answer (by path): the vault index keeps it while the rows stay
    const files = sortedRowFiles(app, settings, t.catalog.ref.full, t.def);
    const keep = new Set([settings.tableKey]);
    for (const f of files) {
      let row: LoadedRow;
      try {
        row = o.bodies ? { file: f, ...(await readFrontmatter(app, f, keep)) } : { file: f, ordered: await readFrontmatterEntries(app, f, keep) };
      } catch (e) {
        if (skipUnreadable) continue;
        // the error is the one of the first row that cannot be read in the vault's order of its notes
        return rowsInVaultOrder(app, settings, t, keep, o.bodies === true);
      }
      out.push(row);
    }
    span.setAttribute("db.collection.name", t.catalog.ref.full);
    count("datanotes.rows_scanned", out.length);
    return out;
  }, { "datanotes.query.plan": "full_scan" });
}

/**
 * The paths a filter pins its rows to (`{path: "a.md"}`, `{path: {eq: …}}`, `{path: {in: […]}}` at
 * its top level), or null when it does not: only those notes can match.
 */
export function pinnedPaths(where: unknown, t: LoadedTable): string[] | null {
  if (where == null || typeof where !== "object" || Array.isArray(where)) return null;
  const cond = (where as Record<string, unknown>).path;
  // a column of its own named path: its values, not the notes' paths
  if (cond === undefined || t.def.columns.some((c) => c.name === "path")) return null;
  let list: unknown[] | null = null;
  if (typeof cond === "string") list = [cond];
  else if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
    const ops = Object.entries(cond as Record<string, unknown>);
    if (ops.length !== 1) return null;
    const [op, v] = ops[0]!;
    if (op === "eq" && typeof v === "string") list = [v];
    else if (op === "in" && Array.isArray(v)) list = v;
  }
  // a token (`{this.path}`, a date) is resolved later: every row is read
  if (!list || list.some((v) => typeof v !== "string" || v.includes("{"))) return null;
  return list as string[];
}

/**
 * The rows of `t` that a filter can match: only the notes it pins (see {@link pinnedPaths}),
 * looked up in the vault index, else every row ({@link loadRows}). The caller still applies the
 * filter. Same rows, same order, as {@link loadRows} filtered.
 */
export function loadRowsWhere(app: App, settings: DatanotesSettings, t: LoadedTable, where: unknown): Promise<LoadedRow[]> {
  const paths = pinnedPaths(where, t);
  const idx = paths ? vaultIndex(app, settings) : null;
  if (!paths || !idx || idx.hasFailures) return loadRows(app, settings, t);
  return phase("engine.query.scan", async (span) => {
    const full = t.catalog.ref.full;
    const excluded = [...(t.def.options.exclude ?? []), t.def.layout.archive];
    const files: TFile[] = [];
    for (const p of new Set(paths)) {
      const n = idx.note(p);
      if (n?.table === full && !excluded.some((dir) => p.startsWith(`${dir}/`))) files.push(n.file);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const keep = new Set([settings.tableKey]);
    const out: LoadedRow[] = [];
    for (const f of files) {
      let ordered: OrderedFrontmatter;
      try {
        // the front matter only: no text needed while the cache holds the note's parse
        ordered = await readFrontmatterEntries(app, f, keep);
      } catch {
        // a row that cannot be read: the full read says which, as without the lookup
        return loadRows(app, settings, t);
      }
      // the body is read when asked for (rowBody), as loadRows does
      out.push({ file: f, ordered });
    }
    span.setAttribute("db.collection.name", full);
    count("datanotes.rows_scanned", out.length);
    return out;
  }, { "datanotes.query.plan": "path_lookup" });
}

/** {@link loadRows} reading the rows in the vault's order of its notes (it throws the first row's error), then sorted. */
async function rowsInVaultOrder(
  app: App,
  settings: DatanotesSettings,
  t: LoadedTable,
  keep: ReadonlySet<string>,
  bodies: boolean,
): Promise<LoadedRow[]> {
  const out: LoadedRow[] = [];
  for (const f of catalogRowFiles(app, settings, t.catalog.ref.full, t.def)) {
    // with their bodies when the first pass read them (clone_table writes them)
    out.push(bodies ? { file: f, ...(await readFrontmatter(app, f, keep)) } : { file: f, ordered: await readFrontmatterEntries(app, f, keep) });
  }
  return out.sort((a, b) => a.file.path.localeCompare(b.file.path));
}

/**
 * Rows sharing a non-empty value in a `unique` column. `rows` is the table as it would be
 * after the operation (one entry per path).
 */
export function uniqueViolations(
  columns: readonly ColumnSpec[],
  rows: readonly { path: string; ordered: OrderedFrontmatter }[],
): RowViolations[] {
  const byPath = new Map<string, Violation[]>();
  // the first row of each path (a row inserted at a path that is taken comes after the one there)
  const rowOf = new Map<string, { path: string; ordered: OrderedFrontmatter }>();
  for (const r of rows) if (!rowOf.has(r.path)) rowOf.set(r.path, r);
  for (const col of columns.filter((c) => c.unique)) {
    const seen = new Map<string, string[]>();
    for (const r of rows) {
      const key = uniqueKey(fmGet(r.ordered, col.name));
      if (key === null) continue;
      const paths = seen.get(key);
      if (paths) paths.push(r.path);
      else seen.set(key, [r.path]);
    }
    for (const paths of seen.values()) {
      if (paths.length < 2) continue;
      for (const p of paths) {
        const others = paths.filter((x) => x !== p).join(", ");
        let list = byPath.get(p);
        if (!list) byPath.set(p, (list = []));
        list.push({ column: col.name, code: "unique", message: `must be unique (also used by ${others})`, value: fmGet(rowOf.get(p)!.ordered, col.name) });
      }
    }
  }
  return [...byPath.entries()].map(([path, violations]) => ({ path, violations }));
}

/** The key a `unique` column compares a value by (strings trimmed, in lower case; null for an empty value). */
export function uniqueKey(v: unknown): string | null {
  if (isEmptyValue(v)) return null;
  return typeof v === "string" ? v.trim().toLowerCase() : JSON.stringify(v);
}

/** Table metadata keys of the ordered description; never column names, kept after the fields. */
const META_KEYS: ReadonlySet<string> = new Set(TABLE_META_KEYS);

/** Serialize a column spec for `_columns` (stable attribute order, no empty attributes). */
export function serializeColumn(c: ColumnSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { name: c.name, type: c.type };
  if (c.items !== undefined) out.items = c.items;
  if (c.required) out.required = true;
  if (c.default !== undefined) out.default = c.default;
  if (c.min !== undefined) out.min = c.min;
  if (c.max !== undefined) out.max = c.max;
  if (c.step !== undefined) out.step = c.step;
  if (c.values !== undefined) out.values = [...c.values];
  if (c.value_descriptions !== undefined) out.value_descriptions = { ...c.value_descriptions };
  if (c.external_default !== undefined) out.external_default = c.external_default;
  if (c.ref !== undefined) out.ref = c.ref;
  if (c.label !== undefined) out.label = c.label;
  if (c.description !== undefined) out.description = c.description;
  if (c.aliases.length > 0) out.aliases = [...c.aliases];
  if (c.note !== undefined) out.note = c.note;
  if (c.unique) out.unique = true;
  if (c.ordered) out.ordered = true;
  if (c.generated !== undefined) out.generated = c.generated;
  if (c.identity !== undefined) out.identity = c.identity;
  if (c.hierarchy) out.hierarchy = true;
  if (c.acyclic) out.acyclic = true;
  if (c.vocabulary !== undefined) out.vocabulary = c.vocabulary;
  if (c.inverse !== undefined) out.inverse = c.inverse;
  if (c.ref_where !== undefined) out.ref_where = c.ref_where;
  if (c.ref_by !== undefined) {
    // written as given: the `levels` shortcut, or the map
    const { column, target_column, levels, map } = c.ref_by;
    out.ref_by = { column, ...(target_column !== undefined ? { target_column } : {}), ...(levels ? { levels: [...levels] } : { map }) };
  }
  return out;
}

export function serializeOptions(o: TableOptions): Record<string, unknown>[] {
  const entry: Record<string, unknown> = {};
  for (const k of ["name", "description", "partition", "filename", "archive"] as const) {
    if (o[k] !== undefined) entry[k] = o[k];
  }
  // create_table's options as given: one alias or folder may be a string, not a list.
  const list = (v: string | readonly string[] | undefined) => (typeof v === "string" ? [v] : v);
  const aliases = list(o.aliases);
  const exclude = list(o.exclude);
  if (aliases && aliases.length > 0) entry.aliases = [...aliases];
  if (exclude && exclude.length > 0) entry.exclude = exclude.length === 1 ? exclude[0] : [...exclude];
  return Object.keys(entry).length > 0 ? [entry] : [];
}

/**
 * Insert a top-level field before the first reserved key (keeps meta keys at the bottom). `ordered`
 * comes from withColumns, so it always has one (`columns`).
 */
function addFieldBeforeMeta(
  ordered: OrderedFrontmatter,
  key: string,
  value: unknown,
  reserved: ReadonlySet<string>,
): OrderedFrontmatter {
  return fmAdd(ordered, key, value, ordered.findIndex(([k]) => reserved.has(k)));
}

function withColumns(
  ordered: OrderedFrontmatter,
  columns: readonly ColumnSpec[],
): OrderedFrontmatter {
  return fmSet(ordered, COLUMNS_KEY, columns.map(serializeColumn));
}

export function emptyResult(op: string, dryRun: boolean): OpResult {
  return {
    ok: false,
    op,
    dry_run: dryRun,
    notes_changed: 0,
    files_created: 0,
    files_moved: 0,
    files_deleted: 0,
    references_updated: 0,
    conflicts: [],
    violations: [],
    failed: [],
    planned_edits: [],
    planned_creates: [],
    planned_moves: [],
    planned_deletes: [],
    planned_texts: [],
  };
}

function plannedFrom(cs: ChangeSet): PlannedNoteChange[] {
  return cs.edits
    .filter((e) => !editIsNoop(e))
    .map((e) => {
      const d = diffOrdered(e.before, e.after);
      const bodyChanged = e.bodyAfter !== undefined && e.bodyAfter !== e.bodyBefore;
      return { path: e.path, set: Object.fromEntries(d.set), remove: d.remove, ...(bodyChanged ? { body: true } : {}) };
    });
}

/** Refuse, preview, or apply a computed change set. */
export async function finish(
  app: App,
  settings: DatanotesSettings,
  cs: ChangeSet,
  conflicts: OpConflict[],
  violations: RowViolations[],
  opts: RunOptions,
): Promise<OpResult> {
  const dryRun = opts.dryRun === true;
  if (conflicts.length === 0 && violations.every((v) => v.violations.length === 0)) {
    const mirrored = await addInverseEdits(app, settings, cs, conflicts);
    if (mirrored) {
      // CHECKs that follow links (and filtered link columns) see the inverse-link edits too
      const { linkedCheckViolations } = await import("./changeset-checks");
      violations = [...violations, ...(await linkedCheckViolations(app, settings, cs, mirrored))];
    }
    // after the inverse-link edits: a cycle through an acyclic column is refused whichever side the write set
    const { changeSetCycles } = await import("./acyclic");
    violations = [...violations, ...(await changeSetCycles(app, settings, cs))];
  }
  const base = emptyResult(cs.op, dryRun);
  base.planned_edits = plannedFrom(cs);
  base.planned_creates = cs.creates.map((c) => c.path);
  base.planned_moves = cs.moves.map((m) => ({ ...m }));
  base.planned_deletes = [...cs.deletes];
  base.planned_texts = [...new Set(cs.texts.map((t) => t.path))];
  base.conflicts = conflicts;
  base.violations = violations.filter((v) => v.violations.length > 0);
  if (base.conflicts.length > 0 || base.violations.length > 0) return base;
  // a named token's row write changes only rows of tables it may write, side effects included
  // (set_null, inverse links, align_relations): otherwise nothing is written, dry run or not
  await assertChangeSetWritable(app, settings, cs);
  if (dryRun) return { ...base, ok: true };
  const done = await whileWriting(app, () => withLogLock(app, async () => {
    // another write applied since this one was checked: it is checked again (runWrite, write-check.ts)
    if (staleWrite(app)) return null;
    // Hand edits since the last commit are logged first, so the operation's commit holds only its own changes
    // (not checked here: the write does not wait for it; the change feed reports them).
    await logChanges(app, settings, { operation: EXTERNAL_EDIT, ...(opts.now ? { now: opts.now } : {}) }, false);
    const applied = await applyChangeSet(app, settings, cs, opts.now);
    // A write that failed partway is put back as it was, before anything logs it.
    const rollback = applied.ok ? undefined : await rollBackFailedWrite(app, settings, applied.migrationId, opts.now);
    wrote(app);
    invalidateFiles(app, [...touchedPaths(cs), ...cs.moves.map((m) => m.from), ...cs.deletes]);
    if (rollback?.ok) return { applied, commits: await loggedRollback(app, settings, applied.migrationId, rollback, opts.now), rollback };
    if (rollback) await loadMetastore(app, settings);
    // the text written, with the file's stat: the next load of the metastore reads nothing
    else for (const t of cs.texts) if (t.path === metastorePath(settings)) await primeWrittenMetastore(app, settings, t.after);
    if (movesLogFiles(settings, cs.moves.map((m) => m.from))) forgetLoggedStates(app);
    const commits = await logChanges(app, settings, {
      operation: logOperation(cs.op),
      parameters: { summary: cs.summary },
      migrationId: applied.migrationId,
      touched: touchedPaths(cs),
      ...(opts.now ? { now: opts.now } : {}),
    });
    // Listeners hear of the operation before the engine counts as idle again.
    notifyApplied(app, {
      op: cs.op,
      summary: cs.summary,
      migrationId: applied.migrationId,
      paths: touchedPaths(cs),
      moves: cs.moves.map((m) => ({ ...m })),
      deletes: [...cs.deletes],
      ...(currentActor() ? { actor: currentActor() } : {}),
    });
    return { applied, commits, rollback };
  }));
  if (!done) return { ...base, conflicts: [{ path: "", message: `${STALE_WRITE}: send it again` }] };
  const { applied, commits, rollback } = done;
  const result: OpResult = {
    ...base,
    ...(commits.length > 0 ? { commits } : {}),
    ok: applied.ok,
    migration_id: applied.migrationId,
    notes_changed: applied.notesChanged,
    files_created: applied.filesCreated,
    files_moved: applied.filesMoved,
    files_deleted: applied.filesDeleted,
    references_updated: applied.referencesUpdated,
    failed: applied.failed,
  };
  return rollback ? withRollback(result, rollback) : result;
}

/**
 * Put back what a write that failed partway wrote: its journal entry is undone as undo_migration
 * undoes one (journaled as its `rollback`), without the undo's checks, since the database goes
 * back to the state it was in. An entry that wrote nothing is marked undone by itself.
 */
async function rollBackFailedWrite(app: App, settings: DatanotesSettings, migrationId: string, now?: Date): Promise<UndoResult> {
  const at = now ?? new Date();
  try {
    const { entry } = await readJournal(app, settings, migrationId);
    // the entry was just written by applyChangeSet: it lists its deleted files
    if ([entry.rows, entry.creates, entry.moves, entry.references, entry.deleted!].every((x) => x.length === 0)) {
      await markUndone(app, settings, migrationId, migrationId, at);
      return { ok: true, undoes: migrationId, conflicts: [], failed: [], touched: [] };
    }
    const r = await undoMigration(app, settings, migrationId, at, undefined, "rollback");
    // refused (a file changed meanwhile): every file the write wrote is left as it is
    if (!r.ok && !r.left) {
      r.left = [...new Set([...entry.references.map((x) => x.path), ...entry.rows.map((x) => x.path), ...entry.moves.map((m) => m.to), ...entry.creates, ...entry.deleted!.map((d) => d.path)])];
    }
    return r;
  } catch (e) {
    return { ok: false, undoes: migrationId, conflicts: [], failed: [{ path: "undo", error: messageOf(e) }] };
  }
}

/**
 * The transaction log after a rollback: the files are back as they were, so usually nothing is
 * committed; what differs (a file written back in another layout) is logged as the undo it is,
 * never as a version of the failed write. Listeners hear of nothing: no row changed.
 */
async function loggedRollback(app: App, settings: DatanotesSettings, migrationId: string, rollback: UndoResult, now?: Date): Promise<SyncedCommit[]> {
  forgetLoggedStates(app);
  await loadMetastore(app, settings);
  // a rollback that succeeded names the files it wrote (none when the write wrote nothing)
  invalidateFiles(app, rollback.touched!);
  return logChanges(app, settings, {
    operation: "UNDO",
    parameters: { migration: migrationId },
    ...(rollback.migration_id ? { migrationId: rollback.migration_id } : {}),
    touched: rollback.touched!,
    ...(now ? { now } : {}),
  });
}

/** A failed write's result with its rollback: nothing left written, or the files the rollback left. */
function withRollback(r: OpResult, rollback: UndoResult): OpResult {
  if (rollback.ok) return { ...r, rolled_back: true, notes_changed: 0, files_created: 0, files_moved: 0, files_deleted: 0, references_updated: 0 };
  const why = [...rollback.conflicts.map((c) => c.message), ...rollback.failed.map((f) => f.error)].join("; ");
  const left = rollback.left?.length ? rollback.left : ["undo"];
  return { ...r, rolled_back: false, failed: [...r.failed, ...left.map((path) => ({ path, error: `not rolled back: ${why}` }))] };
}

/** Row operations whose link edits are mirrored on inverse columns (see `inverse.ts`). */
const INVERSE_OPS = new Set(["insert_row", "update_rows", "update_row", "merge_rows", "adopt_rows", "move_rows", "recompute_columns"]);

/**
 * Add to `cs` the edits that keep inverse link columns in step with its own row edits. Returns the
 * paths of the rows it adds edits for (rows the operation does not write itself), or null when it
 * changes nothing.
 */
async function addInverseEdits(app: App, settings: DatanotesSettings, cs: ChangeSet, conflicts: OpConflict[]): Promise<Set<string> | null> {
  if (cs.skipInverse || !INVERSE_OPS.has(cs.op)) return null;
  const keep = new Set([settings.tableKey]);
  const rows = [
    ...cs.edits.map((e) => ({ path: e.path, before: e.before, after: e.after })),
    ...cs.creates.map((c) => ({ path: c.path, before: [] as OrderedFrontmatter, after: readOrderedFromMarkdown(c.content, keep).ordered })),
  ];
  const moved = new Map(cs.moves.map((m) => [m.from, m.to]));
  const plan = await inverseEditsFor(app, settings, rows, (p) => moved.get(p) ?? p);
  if (!plan) return null;
  conflicts.push(...plan.conflicts);
  if (plan.edits.size === 0) return null;
  const mirrored = new Set<string>();
  // a link resolves to a file of the vault, so a row the change set creates is never a target
  for (const [path, w] of plan.edits) {
    const own = cs.edits.find((e) => e.path === path);
    if (own) own.after = w.after;
    else {
      cs.edits.push({ path, before: w.before, after: w.after });
      mirrored.add(path);
    }
  }
  return mirrored;
}

/** Operation names for the transaction log. */
const LOG_OPERATIONS: Record<string, string> = {
  create_table: "CREATE TABLE",
  drop_table: "DROP TABLE",
  alter_table: "ALTER TABLE",
  move_table: "ALTER TABLE",
  add_column: "ADD COLUMNS",
  drop_column: "DROP COLUMNS",
  rename_column: "RENAME COLUMN",
  alter_column: "CHANGE COLUMN",
  rename_value: "UPDATE",
  insert_row: "WRITE",
  update_rows: "UPDATE",
  update_row: "UPDATE",
  delete_rows: "DELETE",
  move_rows: "MOVE ROWS",
  restore_table: "RESTORE",
  restore_database: "RESTORE",
  merge_rows: "MERGE",
  clone_table: "CLONE",
  recompute_columns: "RECOMPUTE",
};

export function logOperation(op: string): string {
  return LOG_OPERATIONS[op] ?? op.toUpperCase().replace(/_/g, " ");
}

function touchedPaths(cs: ChangeSet): string[] {
  return [
    ...cs.edits.map((e) => e.path),
    ...cs.creates.map((c) => c.path),
    ...cs.texts.map((t) => t.path),
    ...cs.moves.map((m) => m.to),
  ];
}

/** What an applied operation touched, for listeners such as the change feed. */
export interface AppliedOperation {
  op: string;
  summary: string;
  migrationId?: string;
  /** Files written or created (after moves). */
  paths: string[];
  moves: { from: string; to: string }[];
  deletes: string[];
  actor?: Actor;
  /** A move of the database folder (`move_database`): its rows moved with it. */
  databaseMove?: { from: string; to: string; by: "configure_database" | "hand"; entries?: string[] };
  /** The links repaired after notes moved by hand (`repair_links`): those moves (old path → new path). */
  handMoves?: { from: string; to: string }[];
}

type ApplyListener = (e: AppliedOperation) => void;
const APPLY_LISTENERS = new WeakMap<object, Set<ApplyListener>>();

/** Be told about every operation the engine applies on `app` (after it is written). Returns the unsubscribe. */
export function onApplied(app: App, fn: ApplyListener): () => void {
  let set = APPLY_LISTENERS.get(app);
  if (!set) APPLY_LISTENERS.set(app, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

const WRITING = new WeakMap<object, number>();

/** Is the engine writing notes on `app` right now? Vault events meanwhile are its own writes, reported by `onApplied`. */
export function engineWriting(app: App): boolean {
  return (WRITING.get(app) ?? 0) > 0;
}

/** Run `fn` as an engine write: vault events meanwhile are the engine's own (see {@link engineWriting}). */
export async function whileWriting<T>(app: App, fn: () => Promise<T>): Promise<T> {
  WRITING.set(app, (WRITING.get(app) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    WRITING.set(app, WRITING.get(app)! - 1); // set above
  }
}

/** Tell the listeners of {@link onApplied} about an operation the engine applied. */
export function notifyApplied(app: App, e: AppliedOperation): void {
  for (const fn of APPLY_LISTENERS.get(app) ?? []) {
    try {
      fn(e);
    } catch (err) {
      telemetry().log("WARN", "datanotes apply listener failed", { error: messageOf(err) });
    }
  }
}

/**
 * Log sync that never fails the operation: a log problem is reported, not thrown. Hand edits are
 * checked against the tables' rules (`operationMetrics.violations`) unless `checkHandEdits` is
 * false (right before an engine write, which does not wait for it: those commits have no count).
 */
async function logChanges(app: App, settings: DatanotesSettings, options: SyncOptions, checkHandEdits = true): Promise<SyncedCommit[]> {
  // An operation's commit carries the agent of the request (hand edits never do).
  const actor = options.operation !== EXTERNAL_EDIT ? currentActor() : undefined;
  if (actor && !options.actor) options = { ...options, actor };
  if (options.operation === EXTERNAL_EDIT && checkHandEdits && !options.check) options = { ...options, check: (changes) => externalViolationCounts(app, settings, changes) };
  try {
    const kind = options.operation === EXTERNAL_EDIT ? "hand_edits" : "operation";
    return await phase("engine.transaction_log", (span) =>
      syncTransactionLogs(app, settings, options).then((commits) => {
        span.setAttribute("datanotes.commits", commits.length);
        return commits;
      }), { "datanotes.log.kind": kind });
  } catch (e) {
    telemetry().log("WARN", "datanotes transaction log not updated", {
      operation: options.operation,
      error: messageOf(e),
    });
    return [];
  }
}

/**
 * The counts of EXTERNAL_EDIT commits, by table: the hand edits of every table checked once,
 * together (checkExternalEdits, against the log's previous state: only what they break counts).
 * A table counts the rules its own rows break (each once) because of the edits of its rows whose
 * frontmatter changed (a body-only change is not checked) or that left it: the edited rows and
 * the rows of the table linking to them; rows of other tables count in their table (the change
 * feed reports them under the edit). A table whose entry in metastore.yaml changed counts every
 * rule its rows break (check_table). A table with nothing checked is missing (no count);
 * undefined when the check failed.
 */
async function externalViolationCounts(app: App, settings: DatanotesSettings, changes: readonly ExternalLogChange[]): Promise<Map<string, number> | undefined> {
  try {
    const { checkExternalEdits, checkChangedTables } = await import("./external-edits");
    const tp = settings.tableKey;
    const keep = new Set([tp]);
    // the log holds only rows whose front matter it could read (transaction-log.ts reads them alike)
    const parse = (content: string): OrderedFrontmatter => readOrderedFromMarkdown(content, keep).ordered;
    const added = new Set(changes.flatMap((c) => c.add.map((a) => a.path)));
    const edits: (ExternalEdit & { after?: OrderedFrontmatter | null })[] = [];
    /** The tables an edit counts in: its table now and the one it left. */
    const countsIn = new Map<string, Set<string>>();
    for (const c of changes) {
      for (const a of c.add) {
        const owner = changes.find((x) => x.before.has(a.path));
        const prev = owner?.before.get(a.path);
        const after = parse(a.content);
        const before = prev ? parse(prev.content) : null;
        // a body-only change breaks nothing new
        if (prev && JSON.stringify(before) === JSON.stringify(after)) continue;
        edits.push({ path: a.path, before, after });
        countsIn.set(a.path, new Set([c.table, ...(owner ? [owner.table] : [])]));
      }
      for (const r of c.remove) {
        if (added.has(r.path)) continue;
        edits.push({ path: r.path, before: parse(c.before.get(r.path)!.content), gone: true }); // a removed file was in the log's state
        countsIn.set(r.path, new Set([c.table]));
      }
    }
    // a row deleted and created elsewhere with the same id: renamed (by git or a sync tool)
    for (const e of edits) {
      if (e.gone || e.before !== null || !e.after) continue;
      const id = fmGet(e.after, "id");
      const g = id == null ? -1 : edits.findIndex((x) => x.gone && x.before && fmGet(x.before, "id") === id && fmGet(x.before, tp) === fmGet(e.after!, tp));
      if (g < 0) continue;
      const [from] = edits.splice(g, 1);
      e.oldPath = from!.path;
      e.before = from!.before;
      countsIn.set(e.path, new Set([...countsIn.get(e.path)!, ...countsIn.get(from!.path)!])); // every edit has its tables
    }
    const out = new Map<string, number>();
    if (edits.length > 0) {
      const { byPath, tableOf } = await checkExternalEdits(app, settings, edits.map(({ after: _after, ...e }) => e));
      const seen = new Map<string, Set<string>>();
      for (const e of edits) {
        for (const full of countsIn.get(e.path)!) {
          if (!seen.has(full)) seen.set(full, new Set());
          /* v8 ignore next -- a race: a row that became unreadable between the log and its check has no entry */
          for (const v of byPath.get(e.path) ?? []) if (tableOf.get(v.path) === full) seen.get(full)!.add(JSON.stringify(v));
        }
      }
      for (const [full, list] of seen) out.set(full, list.size);
    }
    // a definition changed by hand: every row of the table is checked against it
    const redefined = changes.filter((c) => c.metadataChanged && c.entry !== null).map((c) => c.table);
    if (redefined.length > 0) {
      const { byTable, errors } = await checkChangedTables(app, settings, redefined);
      for (const [full, list] of byTable) out.set(full, list.length);
      for (const [table, error] of errors) {
        out.delete(table);
        telemetry().log("WARN", "datanotes could not check a table changed by hand", { table, error });
      }
    }
    return out;
  } catch (e) {
    telemetry().log("WARN", "datanotes could not check hand edits", { tables: changes.length, error: messageOf(e) });
    return undefined;
  }
}

/** Record hand edits (vault events, plugin load) in the transaction log. */
export function logExternalEdits(app: App, settings: DatanotesSettings): Promise<SyncedCommit[]> {
  return withLogLock(app, () => logChanges(app, settings, { operation: EXTERNAL_EDIT }));
}

/**
 * Right before an engine write that is not a change set (the links repaired after a hand move),
 * under the log lock: the hand edits seen so far get their EXTERNAL_EDIT commits, unchecked as in
 * {@link finish}, so the write's own commit ({@link logEngineWrite}) holds only its changes.
 */
export function logHandEditsFirst(app: App, settings: DatanotesSettings, now?: Date): Promise<SyncedCommit[]> {
  return logChanges(app, settings, { operation: EXTERNAL_EDIT, ...(now ? { now } : {}) }, false);
}

/** The commit of an engine write that is not a change set, under the log lock; a log problem is reported, not thrown. */
export function logEngineWrite(app: App, settings: DatanotesSettings, options: SyncOptions): Promise<SyncedCommit[]> {
  return logChanges(app, settings, options);
}

/**
 * Record a change of a table's definition: a rewrite of its entry in `metastore.yaml`.
 */
export function addSchemaChange(
  cs: ChangeSet,
  t: LoadedTable,
  after: OrderedFrontmatter,
  settings: DatanotesSettings,
): void {
  const ref = t.catalog.ref;
  let entry: CatalogTableEntry;
  let def: TableDefinition;
  try {
    entry = orderedToEntry(after, t.catalog.entry, settings, { model: t.catalog.model, ref });
    // Only new or changed link targets are checked: tables written before full names were required keep working.
    const before = new Map(t.catalog.entry.columns.map((c) => [String(c.name), c]));
    const touched = entry.columns.filter((c) => {
      const prev = before.get(String(c.name));
      return !prev || prev.ref !== c.ref || prev.hierarchy !== c.hierarchy || prev.acyclic !== c.acyclic || prev.type !== c.type || prev.items !== c.items || prev.vocabulary !== c.vocabulary || JSON.stringify(prev.ref_by) !== JSON.stringify(c.ref_by);
    });
    checkColumnRefs(t.catalog.model, ref.full, touched, ref.full, entry.columns);
    def = tableDefinitionFromOrdered(ref, catalogTablePath(settings, ref.full), entryToOrdered(ref, entry, settings, t.catalog.model), settings);
  } catch (e) {
    if (e instanceof MetastoreError) throw new OperationInputError(e.message);
    throw e;
  }
  const id = def.columns.find((c) => c.name === SYSTEM_ID_COLUMN);
  if (!id || id.type !== "string" || id.identity !== "uuid" || !id.unique || !id.required) {
    throw new OperationInputError(
      `"${SYSTEM_ID_COLUMN}" is the system row id (string, identity: uuid, unique, required): it cannot be dropped, renamed or changed — only its description, label or aliases`,
    );
  }
  // one schema change per change set: its operation rewrites the table's entry once
  cs.texts.push({ path: t.file.path, before: t.catalog.text, after: setTableEntry(t.catalog.text, ref, entry) });
}

const FULL_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Link targets of metastore tables must be named in full (`catalog.schema.table`) or `self`, and
 * name an existing table; a `hierarchy` column must point at its own table. `own`: the owner's
 * columns as they will be, when `columns` are only some of them (a `ref_by` to the table itself
 * reads its target column there).
 */
export function checkColumnRefs(model: Metastore, owner: string | null, columns: readonly Record<string, unknown>[], where: string, own: readonly Record<string, unknown>[] = columns): void {
  const tables = new Set(catalogTablesOf(model));
  for (const c of columns) {
    if (c.vocabulary !== undefined && c.vocabulary !== null) {
      const v = String(c.vocabulary);
      if (!FULL_NAME.test(v)) throw new OperationInputError(`${where}.${String(c.name)}: vocabulary "${v}" must be the full table name (catalog.schema.table)`, tableRefHint(v, tables, "vocabulary"));
      if (!tables.has(v)) throw new OperationInputError(`${where}.${String(c.name)}: vocabulary "${v}" is not a table`, tableRefHint(v, tables, "vocabulary"));
    }
    const isLink = c.type === "link" || (c.type === "list" && c.items === "link");
    if (c.ref === undefined || c.ref === null) {
      if (c.hierarchy === true) throw new OperationInputError(`${where}.${String(c.name)}: "hierarchy" needs ref: self`);
      continue;
    }
    if (!isLink) continue;
    const ref = String(c.ref);
    if (c.ref_by !== undefined && c.ref_by !== null) checkLinkLevelsTarget(model, owner, own, c, ref, where);
    if (ref === "self") continue;
    if (!FULL_NAME.test(ref)) {
      throw new OperationInputError(`${where}.${String(c.name)}: ref "${ref}" must be the full table name (catalog.schema.table) or self`, tableRefHint(ref, tables, "links"));
    }
    if (!tables.has(ref) && ref !== owner) throw new OperationInputError(`${where}.${String(c.name)}: ref "${ref}" is not a table`, tableRefHint(ref, tables, "links"));
    if (c.hierarchy === true && ref !== owner) {
      throw new OperationInputError(`${where}.${String(c.name)}: a hierarchy column must point at its own table (ref: self)`);
    }
    if (c.acyclic === true && ref !== owner) {
      throw new OperationInputError(
        `${where}.${String(c.name)}: an acyclic column must point at its own table (ref: self)`,
        guide(`Set ref: "self": acyclic keeps the links between rows of one table free of cycles, such as tasks blocked by tasks.`, "acyclic"),
      );
    }
    if (typeof c.inverse === "string") checkInverse(model, owner, columns, c, ref, where);
  }
}

/** Guidance for a table a column names (`ref`, `vocabulary`) that is not a full table name: the closest ones. */
function tableRefHint(given: string, tables: ReadonlySet<string>, topic: "links" | "vocabulary"): Guidance {
  const bare = new Map<string, string>([...tables].map((full) => [full.split(".").pop()!, full]));
  const near = closestNames(given.split(".").pop()!, bare.keys()).map((n) => `"${bare.get(n)}"`);
  return guide(
    `${near.length > 0 ? `Did you mean ${near.join(" or ")}? ` : ""}Name the table in full (catalog.schema.table), or "self" for the table itself; list_tables gives the full names.`,
    topic,
  );
}

/** Guidance for a column a schema change names that the table does not have. */
function noColumn(name: string, t: LoadedTable): Guidance {
  return unknownColumn(name, [...t.def.columns.map((c) => c.name), ...t.def.untypedFields], t.catalog.ref.full, "describeTable");
}

const EXISTS_HINT = guide("Choose another name, or change the existing column with alter_column (rename it with rename_column).", "alterColumn");

/** The columns of table `target` (`owner`'s own: what it has, with the columns being written on top). */
function targetColumnsOf(model: Metastore, owner: string | null, columns: readonly Record<string, unknown>[], target: string): Record<string, unknown>[] | null {
  const r = resolveCatalogRef(model, target);
  const entry = r ? model.catalogs[r.catalog]?.schemas[r.schema]?.tables[r.table] : undefined;
  if ((!r || !entry) && target !== owner) return null;
  const existing = r && entry ? effectiveColumns(model, r, entry) : [];
  return target === owner ? [...existing.filter((x) => !columns.some((c2) => String(c2.name) === String(x.name))), ...columns] : existing;
}

/** `ref_by`: the linked table has the target column (enum or string), and an enum has the values the map allows. */
function checkLinkLevelsTarget(model: Metastore, owner: string | null, columns: readonly Record<string, unknown>[], c: Record<string, unknown>, ref: string, where: string): void {
  const name = String(c.name);
  const by = c.ref_by as { column?: unknown; target_column?: unknown; levels?: unknown; map?: unknown };
  const target = ref === "self" ? owner : ref;
  if (target === null) return;
  const cols = targetColumnsOf(model, owner, columns, target);
  if (!cols) return; // the ref check reports it
  const tcol = String(by.target_column ?? by.column);
  const col = cols.find((x) => String(x.name) === tcol);
  if (!col) throw new OperationInputError(`${where}.${name}: ref_by needs column "${tcol}" in ${target} (set ref_by.target_column to name another one)`);
  if (col.type !== "enum" && col.type !== "string") throw new OperationInputError(`${where}.${name}: ref_by target column ${target}.${tcol} must be an enum or string column`);
  if (col.type !== "enum" || !Array.isArray(col.values)) return;
  const allowed = Array.isArray(by.levels) ? (by.levels as unknown[]).slice(0, -1) : Object.values((by.map ?? {}) as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : []));
  const unknown = [...new Set(allowed.map(String))].filter((v) => !(col.values as unknown[]).map(String).includes(v));
  if (unknown.length > 0) {
    throw new OperationInputError(`${where}.${name}: ref_by allows ${unknown.map((v) => `"${v}"`).join(", ")}, not a value of ${target}.${tcol} (${(col.values as unknown[]).join(", ")})`);
  }
}

/**
 * alter_column of column `column` of table `full`: the `ref_by` of every table (this one included)
 * whose targets it picks, checked on `model` (the metastore with the change): an allowed level the
 * column no longer has (a value dropped from the enum, or a type that is no longer enum / string)
 * refuses it. A string target column takes any value: its levels are not checked.
 */
function levelTargetConflicts(model: Metastore, full: string, column: string): string[] {
  const out: string[] = [];
  for (const owner of catalogTablesOf(model)) {
    const cols = modelColumns(model, owner)!; // a table of the model
    for (const c of cols) {
      const by = c.ref_by as { column?: unknown; target_column?: unknown } | null | undefined;
      if (by == null || linkTargetOf(c, owner) !== full || String(by.target_column ?? by.column) !== column) continue;
      try {
        checkLinkLevelsTarget(model, owner, cols, c, String(c.ref), owner);
      } catch (e) {
        /* v8 ignore next -- defensive: only OperationInputError is expected, anything else goes up */
        if (!(e instanceof OperationInputError)) throw e;
        out.push(`${e.message}: change that ref_by first`);
      }
    }
  }
  return out;
}

/** `inverse`: a link column of the `ref` table that links back to this one (and agrees, if it declares one). */
function checkInverse(model: Metastore, owner: string | null, columns: readonly Record<string, unknown>[], c: Record<string, unknown>, ref: string, where: string): void {
  const name = String(c.name);
  const inv = String(c.inverse);
  if (owner === null) throw new OperationInputError(`${where}.${name}: "inverse" is only valid on table columns`);
  // checkColumnRefs passes a full name that is a table or the owner (it skips "self")
  const target = ref;
  const r = resolveCatalogRef(model, target);
  const entry = r ? model.catalogs[r.catalog]?.schemas[r.schema]?.tables[r.table] : undefined;
  // The owner's own columns: what the table has, with the columns being written on top.
  const existing = r && entry ? effectiveColumns(model, r, entry) : [];
  const targetColumns =
    target === owner
      ? [...existing.filter((x) => !columns.some((c2) => String(c2.name) === String(x.name))), ...columns]
      : existing;
  const back = targetColumns.find((x) => String(x.name) === inv);
  if (!back) throw new OperationInputError(`${where}.${name}: inverse column "${inv}" does not exist in ${target}`);
  const backIsLink = back.type === "link" || (back.type === "list" && back.items === "link");
  const backRef = back.ref === "self" ? target : back.ref;
  if (!backIsLink || backRef !== owner) {
    throw new OperationInputError(`${where}.${name}: inverse column ${target}.${inv} must be a link column with ref ${owner}`);
  }
  if (typeof back.inverse === "string" && back.inverse !== name) {
    throw new OperationInputError(`${where}.${name}: ${target}.${inv} declares inverse "${back.inverse}", not "${name}"`);
  }
}

function catalogTablesOf(model: Metastore): string[] {
  const out: string[] = [];
  for (const [c, cat] of Object.entries(model.catalogs)) for (const [s, sch] of Object.entries(cat.schemas)) for (const t of Object.keys(sch.tables)) out.push(`${c}.${s}.${t}`);
  return out;
}

/** Entry form of the system id column (required, dense, with its description). */
function systemIdEntryColumn(): Record<string, unknown> {
  const { description, required: _r, ...rest } = SYSTEM_ID_SPEC;
  return { ...rest, required: true, dense: true, description };
}

/** A metastore entry with the system id column first (an existing string `id` column is replaced). */
export function withSystemIdColumn<T extends { columns: Record<string, unknown>[] }>(entry: T): T {
  const existing = entry.columns.find((c) => c.name === SYSTEM_ID_COLUMN);
  if (existing && existing.type !== "string") {
    throw new OperationInputError(`"${SYSTEM_ID_COLUMN}" is reserved for the system row id (a UUID string); rename your "${SYSTEM_ID_COLUMN}" column first`);
  }
  return { ...entry, columns: [systemIdEntryColumn(), ...entry.columns.filter((c) => c.name !== SYSTEM_ID_COLUMN)] };
}

function assertColumnName(name: unknown, what: string): string {
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new OperationInputError(`${what} must start with a letter and contain only letters, digits, "_" or "-"`);
  }
  return name;
}

// --- DDL: tables ---

export interface CreateTableInput {
  name?: string;
  /** What a row of the table records (required). Null or "" is refused with the other missing descriptions. */
  description?: string | null;
  /** Catalog of the metastore; default from the database configuration. */
  catalog?: string;
  /** Database schema (namespace); default from the database configuration. */
  schema?: string;
  /** Date/datetime column that partitions rows and names their files (database tables). */
  timeColumn?: string;
  /**
   * The table's options; `autolink_target` (true / false) says whether automatic links may link
   * its rows (absent: yes, unless its rows are named by a date or a time). Kept in the entry's
   * `options`, not in `_table`.
   */
  options?: Omit<TableOptions, "name" | "description"> & { autolink_target?: boolean };
  /** Transaction log for the table: true / false (absent: the database's setting). Kept in the entry's `properties`. */
  history?: boolean;
  /** Untyped top-level fields with default values (e.g. `{ type: "log" }`). */
  fields?: Record<string, unknown>;
  /** Column specs; `dense: true` also adds the column as a top-level field. */
  columns: (Record<string, unknown> & { dense?: boolean })[];
  /** Markdown body of new rows (`row_template`). */
  rowTemplate?: string;
  /** How to fill a row, for agents (Markdown); kept in metastore.yaml as `instructions`. */
  instructions?: string;
  /** Key/value labels of the table (`{ domain: "health" }`), kept in `metastore.yaml`. */
  tags?: Record<string, string>;
}

async function createTableImpl(
  app: App,
  settings: DatanotesSettings,
  input: CreateTableInput,
  opts: RunOptions = {},
): Promise<OpResult> {
  if (input.instructions !== undefined && input.instructions !== null && typeof input.instructions !== "string") {
    throw new OperationInputError(`"instructions" must be text: how to fill a row of the table`, guide(`Pass instructions as Markdown text, e.g. "1. Ask which film and when.", or leave them out.`, "instructions"));
  }
  // A description passed as null is one to write: infer_table leaves them so.
  const proposal = input.description === null || input.columns.some((c) => c?.description === null);
  {
    // Metastore tables always start with the system row id.
    const given = input.columns.find((c) => c.name === SYSTEM_ID_COLUMN);
    if (given && given.type !== "string") {
      throw new OperationInputError(`"${SYSTEM_ID_COLUMN}" is reserved for the system row id (a UUID string)`);
    }
    // the columns the engine sets itself get its description when they have none
    const columns = input.columns.filter((c) => c.name !== SYSTEM_ID_COLUMN).map(withEngineDescription);
    input = { ...input, columns: [{ ...SYSTEM_ID_SPEC, dense: true }, ...columns] };
  }
  const reserved = META_KEYS;
  const conflicts: OpConflict[] = [];
  const tags = input.tags === undefined ? {} : (tagsInput(input.tags, false) as Record<string, string>);
  const columns = input.columns.map((raw, i) => {
    const { dense: _dense, ...spec } = raw;
    return parseColumn(spec, i, reserved);
  });
  const names = new Set<string>();
  for (const c of columns) {
    if (names.has(c.name)) throw new OperationInputError(`duplicate column "${c.name}"`);
    names.add(c.name);
  }
  {
    // Defined in metastore.yaml, addressed as catalog.schema.table.
    if (!input.name) throw new OperationInputError(`pass "name" (and optionally "catalog", "schema") to create a table`);
    const cfg = await readDatabaseConfig(app, settings);
    const ref = refOf(
      assertIdentifier("catalog", input.catalog ?? cfg.default_catalog),
      assertIdentifier("schema", input.schema ?? cfg.default_schema),
      assertIdentifier("table", input.name),
    );
    const extra: TableOptions = { archive: cfg.archive_folder };
    if (input.timeColumn !== undefined) {
      const tc = columns.find((c) => c.name === input.timeColumn);
      if (!tc || (tc.type !== "datetime" && tc.type !== "date")) {
        throw new OperationInputError(`"time_column" must be a date or datetime column of the table`);
      }
      if (cfg.default_partition !== "") extra.partition = `{${tc.name}:${cfg.default_partition}}`;
      // A date has no time of day: its rows are named by the date part of the format only.
      const format = tc.type === "date" ? cfg.default_filename.replace(/\s*(\[[^\]]*\])?\s*[Hh]{1,2}.*$/, "") || "YYYY-MM-DD" : cfg.default_filename;
      extra.filename = `{${tc.name}:${format}}`;
    }
    const { autolink_target: linkTarget, ...givenOptions } = input.options ?? {};
    if (linkTarget !== undefined && linkTarget !== null && typeof linkTarget !== "boolean") {
      throw new OperationInputError(
        `"autolink_target" must be true or false, not ${JSON.stringify(linkTarget)}`,
        guide(`Pass autolink_target: true (automatic links may link the table's rows) or false (never), or leave it out: then every table is a target but those whose rows are named by a date or a time.`, "autolinkTargets"),
      );
    }
    const given = { ...givenOptions } as TableOptions;
    if ("path" in given) throw new OperationInputError(`database tables take "partition", not "path"`);
    if (input.description !== undefined && input.description !== null) {
      if (typeof input.description !== "string") {
        throw new OperationInputError(`"description" must be a string: what a row of the table records`, guide(`Pass the table's description as text, e.g. "description": "Films I watched or want to watch".`, "descriptions"));
      }
      // "" is no description: refused below with the other missing ones
      if (hasText(input.description)) given.description = input.description;
    }
    const catOptions = parseTableOptions(serializeOptions({ ...extra, ...given, name: ref.table }));
    if (!catOptions.filename) {
      throw new OperationInputError(`pass "time_column" or "filename" (e.g. "{name}") so rows get file names`);
    }
    const ms = await loadMetastore(app, settings);
    const text = ms?.text ?? "";
    const model = ms?.model ?? parseMetastore("");
    const pseudo = catalogTablePath(settings, ref.full);
    const sch = model.catalogs[ref.catalog]?.schemas[ref.schema];
    if (sch?.tables[ref.table] || sch?.views[ref.table]) conflicts.push({ path: pseudo, message: `${ref.full} already exists` });
    let cat: OrderedFrontmatter = [];
    for (const [k, v] of Object.entries(input.fields ?? {})) {
      if (reserved.has(k) || k === settings.tableKey) throw new OperationInputError(`"${k}" is a reserved front matter key`);
      if (names.has(k)) throw new OperationInputError(`"${k}" is in both "fields" and "columns"`);
      cat = fmSet(cat, k, v);
    }
    input.columns.forEach((raw, i) => {
      if (raw.dense === true) cat = fmSet(cat, columns[i]!.name, columns[i]!.default ?? null);
    });
    cat = fmSet(cat, TABLE_KEY, serializeOptions(catOptions));
    cat = withColumns(cat, columns);
    tableDefinitionFromOrdered(ref, pseudo, cat, settings); // generated expressions and other cross-column rules
    const entry = withTableTags(orderedToEntry(cat, undefined, settings), tags);
    if (typeof input.rowTemplate === "string" && input.rowTemplate.trim() !== "") entry.row_template = input.rowTemplate; // body of new rows
    if (typeof input.instructions === "string" && input.instructions.trim() !== "") entry.instructions = input.instructions;
    // the entry has options: a table needs a filename
    if (typeof linkTarget === "boolean") entry.options = { ...entry.options, autolink_target: linkTarget };
    if (typeof input.history === "boolean") entry.options = { ...entry.options, history: input.history };
    checkColumnRefs(model, ref.full, entry.columns, ref.full);
    const missing = missingDescriptions(catOptions.description, columns);
    if (missing) throw refused(createTableRefusal(ref.full, missing, input.columns, proposal));
    const cs = emptyChangeSet("create_table", `create table ${ref.full}`, pseudo);
    cs.texts.push({ path: metastorePath(settings), before: text, after: setTableEntry(text, ref, entry) });
    return finish(app, settings, cs, conflicts, [], opts);
  }
}

/** Archive folder of a table: `properties.archive`, else `<table folder>/_archive`. */
export function archiveFolder(def: TableDefinition): string {
  return def.layout.archive;
}

async function dropTableImpl(
  app: App,
  settings: DatanotesSettings,
  input: { table: string; mode?: "archive" },
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const rows = catalogRowFiles(app, settings, t.catalog.ref.full, t.def);
  const conflicts: OpConflict[] = [];
  if (rows.length > 0 && input.mode !== "archive") {
    conflicts.push({
      path: t.file.path,
      message: `table has ${rows.length} rows; pass mode: "archive" to archive them with the table`,
    });
  }
  for (const r of readersBlocking(t.catalog.model, t.catalog.ref.full, "drop")) conflicts.push({ path: t.file.path, ...r });
  const folder = archiveFolder(t.def);
  const cs = emptyChangeSet("drop_table", `drop table ${t.def.name}`, t.def.schemaPath);
  cs.texts.push({ path: t.file.path, before: t.catalog.text, after: setTableEntry(t.catalog.text, t.catalog.ref, null) });
  const targets = new Set<string>();
  for (const f of rows) {
    const to = `${folder}/${f.name}`;
    if (targets.has(to) || app.vault.getAbstractFileByPath(to) != null) {
      conflicts.push({ path: f.path, message: `archive target exists: ${to}` });
    }
    targets.add(to);
    cs.moves.push({ from: f.path, to });
  }
  return finish(app, settings, cs, conflicts, [], opts);
}

// --- DDL: columns ---

function columnExists(t: LoadedTable, name: string): boolean {
  return t.def.columns.some((c) => c.name === name) || t.def.untypedFields.includes(name);
}

async function addColumnImpl(
  app: App,
  settings: DatanotesSettings,
  input: { table: string; column: Record<string, unknown> },
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const reserved = META_KEYS;
  // `dense` is the column's: written on every row, not an attribute of its spec
  const { dense: denseGiven, ...given } = input.column;
  if (denseGiven !== undefined && denseGiven !== null && typeof denseGiven !== "boolean") {
    throw new OperationInputError(`"dense" must be true or false`, guide(`Pass "dense": true in the column to write it on every row with its default.`, "createTable"));
  }
  // a column the engine sets itself gets its description when it has none
  const column = withEngineDescription(given);
  const spec = parseColumn(column, t.def.columns.length, reserved);
  if (columnExists(t, spec.name)) {
    throw new OperationInputError(`column "${spec.name}" already exists in table "${t.def.name}"`, EXISTS_HINT);
  }
  if (!hasText(spec.description)) throw refused(addColumnRefusal(t.catalog.ref.full, column));
  const dense = denseGiven === true;
  let after = withColumns(t.ordered, [...t.def.columns, spec]);
  if (dense) after = addFieldBeforeMeta(after, spec.name, spec.default ?? null, META_KEYS);

  const cs = emptyChangeSet("add_column", `add column ${spec.name} to ${t.def.name}`, t.def.schemaPath);
  addSchemaChange(cs, t, after, settings);
  const violations: RowViolations[] = [];
  // The value existing rows get: `{today}` / `{now}` are evaluated now, as on insert.
  const fill = resolveDefault(spec.default, new Date(), (await readDatabaseConfig(app, settings)).timezone);
  for (const r of await loadRows(app, settings, t)) {
    const cur = fmGet(r.ordered, spec.name);
    const has = r.ordered.some(([k]) => k === spec.name);
    const value = has ? cur : fill;
    if (isEmptyValue(value)) {
      if (spec.required) {
        violations.push({
          path: r.file.path,
          violations: [{ column: spec.name, code: "required", message: `${requiredMessage(spec)} (give the column a default)` }],
        });
      }
    } else {
      violations.push({ path: r.file.path, violations: validateValue(spec, value) });
    }
    if (dense && !has) {
      cs.edits.push({
        path: r.file.path,
        before: r.ordered,
        after: fmAdd(r.ordered, spec.name, fill ?? null),
      });
    }
  }
  if (spec.unique) {
    violations.push(...uniqueViolations([spec], (await loadRows(app, settings, t)).map((r) => ({ path: r.file.path, ordered: r.ordered }))));
  }
  violations.push(...(await filteredLinkViolations(app, settings, t, [...t.def.columns, spec], spec)));
  const { acyclicPairs, acyclicViolations } = await import("./acyclic");
  const withNew = [...t.def.columns, spec];
  if (acyclicPairs(withNew, t.catalog.ref.full).some((p) => p.column === spec.name || p.inverse === spec.name)) {
    const rowsNow = (await loadRows(app, settings, t)).map((r) => {
      const has = r.ordered.some(([k]) => k === spec.name);
      const value = has ? fmGet(r.ordered, spec.name) : dense ? fill : undefined;
      return { path: r.file.path, ordered: value === undefined ? r.ordered : fmSet(r.ordered, spec.name, value) };
    });
    violations.push(...acyclicViolations(withNew, t.catalog.ref.full, rowsNow, { involving: spec.name, wording: "check" }));
  }
  return finish(app, settings, cs, [], violations, opts);
}

/** A `ref_by` that reads the renamed column follows it (its target too, on a link to the table itself). */
function withRenamedLevels<C extends ColumnSpec>(c: C, table: string, from: string, to: string): C {
  const by = c.ref_by;
  if (!by) return c;
  const self = c.ref === table || c.ref === "self";
  const target = by.target_column ?? by.column;
  const column = by.column === from ? to : by.column;
  const renamedTarget = self && target === from ? to : target;
  if (column === by.column && renamedTarget === target) return c;
  const { target_column: _t, ...rest } = by;
  return { ...c, ref_by: { ...rest, column, ...(renamedTarget !== column ? { target_column: renamedTarget } : {}) } };
}

/**
 * add_column / alter_column of a link column with `ref_where` / `ref_by`: the existing rows it
 * refuses (row operations live in rows.ts, which imports this module: loaded when needed).
 */
async function filteredLinkViolations(app: App, settings: DatanotesSettings, t: LoadedTable, columns: readonly ColumnSpec[], spec: ColumnSpec): Promise<RowViolations[]> {
  if (spec.ref_where === undefined && spec.ref_by === undefined) return [];
  const { columnTargetViolations } = await import("./link-targets");
  return columnTargetViolations(app, settings, t, columns, spec.name);
}

/** Rewrite, in the metastore text `cs` writes for `t`, the CHECKs and link filters `f` changes (see rewrittenEntries). */
function rewriteLinkFilters(cs: ChangeSet, t: LoadedTable, f: Parameters<typeof rewrittenEntries>[2]): void {
  const pending = cs.texts.find((x) => x.path === t.file.path)!; // addSchemaChange wrote it
  let text = pending.after;
  text = setTableEntries(text, rewrittenEntries(t.catalog.model, parseMetastore(text), f).map(({ ref, entry }) => [ref, entry] as const));
  pending.after = text;
}

/** A condition with the old word swapped for the new one: a value, a list, or the values of its operators. */
function swapCondition(c: unknown, swap: (v: unknown) => unknown): unknown {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return swap(c);
  return Object.fromEntries(Object.entries(c).map(([op, v]) => [op, op === "exists" ? v : swap(v)]));
}

/**
 * A stored `ref_by` (`{column, levels}` or `{column, map}`) with values renamed by `word`: on the
 * row's side (`keys`: the map's keys) and / or the target's (`values`: the allowed targets). Levels
 * stay levels when both sides change, and are written out as the map when only one does.
 */
function renamedLevels(by: Record<string, unknown>, keys: boolean, values: boolean, word: (s: string) => string): Record<string, unknown> {
  if (!keys && !values) return by;
  const { levels, map, ...rest } = by;
  if (Array.isArray(levels)) {
    const lv = levels.map(String);
    if (keys && values) return { ...rest, levels: lv.map(word) };
    return { ...rest, map: Object.fromEntries(lv.map((v, i) => [keys ? word(v) : v, i === 0 ? null : [values ? word(lv[i - 1]!) : lv[i - 1]!]])) };
  }
  // a hand-edited ref_by without levels or a map (its table is reported malformed): left as it is
  if (map === null || typeof map !== "object") return by;
  return {
    ...rest,
    map: Object.fromEntries(Object.entries(map as Record<string, unknown>).map(([k, v]) => [keys ? word(k) : k, values && Array.isArray(v) ? v.map((x) => word(String(x))) : v])),
  };
}

/**
 * The CHECKs and link filters (`ref_where`, `ref_by`) of every table that read column `column` of
 * table `full` (directly, or through a link): drop_column is refused while one does.
 */
export function filtersReading(model: Metastore, full: string, column: string): string[] {
  const out: string[] = [];
  for (const owner of catalogTablesOf(model)) {
    const r = resolveCatalogRef(model, owner)!; // a table of the model
    const entry = model.catalogs[r.catalog]?.schemas[r.schema]?.tables[r.table];
    for (const [name, where] of Object.entries(entry?.constraints ?? {})) {
      if (readsColumn(model, owner, where, full, column)) out.push(`CHECK ${name} of ${owner}`);
    }
    for (const c of modelColumns(model, owner)!) { // a table of the model
      const target = linkTargetOf(c, owner);
      if (target === null || (owner === full && String(c.name) === column)) continue;
      if (c.ref_where != null && readsColumn(model, target, c.ref_where, full, column)) out.push(`ref_where of ${owner}.${String(c.name)}`);
      const by = c.ref_by as { column?: string; target_column?: string } | undefined;
      if (by && ((owner === full && by.column === column) || (target === full && (by.target_column ?? by.column) === column))) out.push(`ref_by of ${owner}.${String(c.name)}`);
    }
  }
  return out;
}

async function renameColumnImpl(
  app: App,
  settings: DatanotesSettings,
  input: { table: string; from: string; to: string },
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const from = input.from;
  const to = assertColumnName(input.to, `"to"`);
  if (!columnExists(t, from)) throw new OperationInputError(`column "${from}" not found in table "${t.def.name}"`, noColumn(from, t));
  if (columnExists(t, to)) throw new OperationInputError(`column "${to}" already exists in table "${t.def.name}"`, EXISTS_HINT);
  const conflicts: OpConflict[] = [];

  const columns = t.def.columns.map((c) => withRenamedLevels(c.name === from ? { ...c, name: to } : c, t.catalog.ref.full, from, to));
  let after = t.def.columns.some((c) => c.name === from) ? withColumns(t.ordered, columns) : t.ordered;
  after = fmRename(after, from, to);
  const cs = emptyChangeSet("rename_column", `rename column ${from} to ${to} in ${t.def.name}`, t.def.schemaPath);
  addSchemaChange(cs, t, after, settings);
  // CHECKs and ref_where that read the column (here, or through a link from other tables) follow it
  const full = t.catalog.ref.full;
  rewriteLinkFilters(cs, t, {
    key: (table, column) => (table === full && column === from ? to : column),
    refBy: (owner, target, by) =>
      owner !== full && target === full && String(by.target_column ?? by.column) === from ? { ...by, target_column: to } : by,
  });

  for (const r of await loadRows(app, settings, t)) {
    const hasFrom = r.ordered.some(([k]) => k === from);
    if (!hasFrom) continue;
    const hasTo = r.ordered.some(([k]) => k === to);
    let next = r.ordered;
    if (hasTo) {
      const toVal = fmGet(r.ordered, to);
      if (!isEmptyValue(toVal) && JSON.stringify(toVal) !== JSON.stringify(fmGet(r.ordered, from))) {
        conflicts.push({ path: r.file.path, message: `row has both "${from}" and "${to}" with different values` });
        continue;
      }
      next = fmDelete(next, to);
    }
    cs.edits.push({ path: r.file.path, before: r.ordered, after: fmRename(next, from, to) });
  }
  return finish(app, settings, cs, conflicts, [], opts);
}

async function renameValueImpl(
  app: App,
  settings: DatanotesSettings,
  input: { table: string; column: string; from: string; to: string },
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const col = t.def.columns.find((c) => c.name === input.column);
  if (!col) throw new OperationInputError(`column "${input.column}" not found in table "${t.def.name}"`, noColumn(input.column, t));
  if ((col.type === "list" ? col.items : col.type) !== "enum") {
    const enums = t.def.columns.filter((c) => (c.type === "list" ? c.items : c.type) === "enum").map((c) => c.name);
    throw new OperationInputError(
      `column "${col.name}" is not an enum column`,
      guide(`rename_value renames a value of an enum column (${enums.length > 0 ? `in ${t.catalog.ref.full}: ${enums.join(", ")}` : `${t.catalog.ref.full} has none`}); for another column, update_rows changes the values.`, "renameValue"),
    );
  }
  const from = String(input.from ?? "").trim();
  const to = String(input.to ?? "").trim();
  const values = col.values!; // the loader requires the values of an enum column
  const valuesHint = guide(`Pass from_value (one of: ${values.join(", ")}) and the new to_value.`, "renameValue");
  if (from === "" || to === "") throw new OperationInputError(`"from" and "to" must be non-empty`, valuesHint);
  if (from === to) throw new OperationInputError(`"from" and "to" are the same value`, valuesHint);
  if (!values.includes(from)) {
    const near = closestNames(from, values);
    throw new OperationInputError(
      `"${from}" is not a value of ${t.def.name}.${col.name} (values: ${values.join(", ")})`,
      near.length > 0 ? guide(`Did you mean ${near.map((v) => `"${v}"`).join(" or ")}? ${valuesHint.hint}`, "renameValue") : valuesHint,
    );
  }
  const conflicts: OpConflict[] = [];
  if (values.includes(to)) conflicts.push({ path: t.file.path, message: `"${to}" is already a value of ${col.name}` });

  // Same position, new word: the order of an ordered enum is unchanged.
  const spec: ColumnSpec = {
    ...col,
    values: values.map((v) => (v === from ? to : v)),
    ...(col.default === from ? { default: to } : {}),
    // the value's description follows it (same position among the keys)
    ...(col.value_descriptions && from in col.value_descriptions
      ? { value_descriptions: Object.fromEntries(Object.entries(col.value_descriptions).map(([k, d]) => [k === from ? to : k, d])) }
      : {}),
  };
  const swap = (v: unknown): unknown =>
    Array.isArray(v) ? v.map((x) => (String(x) === from ? to : x)) : String(v) === from ? to : v;
  const full = t.catalog.ref.full;
  const word = (s: string) => (s === from ? to : s);
  // `ref_by` levels of this table that name the value (as the row's level, or the target's) follow it
  const columns = t.def.columns.map((c, i) => {
    const c2 = c.name === col.name ? spec : c;
    if (!c2.ref_by) return c2;
    const target = c2.ref; // the loaded definition names "self" in full
    const stored = serializeColumn(c2).ref_by as Record<string, unknown>;
    const next = renamedLevels(stored, c2.ref_by.column === col.name, target === full && (c2.ref_by.target_column ?? c2.ref_by.column) === col.name, word);
    return next === stored ? c2 : { ...c2, ref_by: parseLinkLevels(next, i) };
  });
  let after = withColumns(t.ordered, columns);
  const dense = fmGet(after, col.name);
  if (dense !== undefined && JSON.stringify(swap(dense)) !== JSON.stringify(dense)) after = fmSet(after, col.name, swap(dense));
  const cs = emptyChangeSet("rename_value", `rename ${t.def.name}.${col.name} value ${from} to ${to}`, t.def.schemaPath);
  addSchemaChange(cs, t, after, settings);
  // CHECKs and ref_where on the column (here, or through a link from other tables) use the new word;
  // so do the `ref_by` targets of other tables' links to this one
  rewriteLinkFilters(cs, t, {
    cond: (table, column, c) => (table === full && column === col.name ? swapCondition(c, swap) : c),
    refBy: (owner, target, by) =>
      owner !== full && target === full && String(by.target_column ?? by.column) === col.name ? renamedLevels(by, false, true, word) : by,
  });
  for (const r of await loadRows(app, settings, t)) {
    const v = fmGet(r.ordered, col.name);
    if (isEmptyValue(v)) continue;
    const next = swap(v);
    if (JSON.stringify(next) === JSON.stringify(v)) continue;
    cs.edits.push({ path: r.file.path, before: r.ordered, after: fmSet(r.ordered, col.name, next) });
  }
  return finish(app, settings, cs, conflicts, [], opts);
}

async function dropColumnImpl(
  app: App,
  settings: DatanotesSettings,
  input: { table: string; name: string },
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const name = input.name;
  if (!columnExists(t, name)) throw new OperationInputError(`column "${name}" not found in table "${t.def.name}"`, noColumn(name, t));
  const conflicts: OpConflict[] = filtersReading(t.catalog.model, t.catalog.ref.full, name).map((what) => ({
    path: t.file.path,
    message: `${what} reads ${t.def.name}.${name}: drop or change it first`,
  }));
  if (conflicts.length > 0) return finish(app, settings, emptyChangeSet("drop_column", `drop column ${name} from ${t.def.name}`, t.def.schemaPath), conflicts, [], opts);
  let after = t.def.columns.some((c) => c.name === name)
    ? withColumns(t.ordered, t.def.columns.filter((c) => c.name !== name))
    : t.ordered;
  after = fmDelete(after, name);
  const cs = emptyChangeSet("drop_column", `drop column ${name} from ${t.def.name}`, t.def.schemaPath);
  addSchemaChange(cs, t, after, settings);
  for (const r of await loadRows(app, settings, t)) {
    if (!r.ordered.some(([k]) => k === name)) continue;
    cs.edits.push({ path: r.file.path, before: r.ordered, after: fmDelete(r.ordered, name) });
  }
  return finish(app, settings, cs, conflicts, [], opts);
}

async function alterColumnImpl(
  app: App,
  settings: DatanotesSettings,
  input: { table: string; name: string; changes: Record<string, unknown> },
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const idx = t.def.columns.findIndex((c) => c.name === input.name);
  if (idx < 0) throw new OperationInputError(`column "${input.name}" not found in table "${t.def.name}"`, noColumn(input.name, t));
  const old = t.def.columns[idx]!;
  const { dense, name, ...changes } = input.changes;
  if (name !== undefined && name !== old.name) {
    throw new OperationInputError(`use rename_column to change a column name`, guide(`Call rename_column(table, from_column, to_column); alter_column changes the other attributes.`, "renameColumn"));
  }
  // a description may change, never go (another type is the column parser's to refuse)
  const d = changes.description;
  if (d === null || (typeof d === "string" && !hasText(d))) throw refused(removedDescriptionRefusal(t.catalog.ref.full, old.name));
  const merged: Record<string, unknown> = { ...serializeColumn(old) };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const spec = parseColumn(merged, idx, META_KEYS);
  const checked: ColumnSpec = spec.ref === "self" ? { ...spec, ref: t.catalog.ref.full } : spec;
  const columns = t.def.columns.map((c, i) => (i === idx ? spec : c));
  const reserved = META_KEYS;
  let after = withColumns(t.ordered, columns);
  const makeDense = dense === true && !old.dense;
  if (makeDense) after = addFieldBeforeMeta(after, spec.name, spec.default ?? null, META_KEYS);
  if (dense === false && old.dense) after = fmDelete(after, spec.name);

  const cs = emptyChangeSet("alter_column", `alter column ${spec.name} in ${t.def.name}`, t.def.schemaPath);
  addSchemaChange(cs, t, after, settings);
  const existing = await loadRows(app, settings, t);
  // date -> datetime widens every value to midnight in the database time zone
  const widen = old.type === "date" && spec.type === "datetime";
  const tz = widen ? (await readDatabaseConfig(app, settings)).timezone : "";
  const violations: RowViolations[] = spec.unique
    ? uniqueViolations([spec], existing.map((r) => ({ path: r.file.path, ordered: r.ordered })))
    : [];
  const fill = makeDense ? resolveDefault(spec.default, new Date(), (await readDatabaseConfig(app, settings)).timezone) : undefined;
  for (const r of existing) {
    const has = r.ordered.some(([k]) => k === spec.name);
    let v = fmGet(r.ordered, spec.name);
    if (widen && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const cast = normalizeDatetime(`${v}T00:00`, tz);
      cs.edits.push({ path: r.file.path, before: r.ordered, after: fmSet(r.ordered, spec.name, cast) });
      v = cast;
    }
    if (isEmptyValue(v)) {
      if (spec.required && !(makeDense && !isEmptyValue(spec.default))) {
        violations.push({ path: r.file.path, violations: [{ column: spec.name, code: "required", message: requiredMessage(spec) }] });
      }
    } else {
      violations.push({ path: r.file.path, violations: validateValue(checked, v, validationContextFor(app, settings, r.file.path)) });
    }
    if (makeDense && !has) {
      cs.edits.push({ path: r.file.path, before: r.ordered, after: fmAdd(r.ordered, spec.name, fill ?? null) });
    }
  }
  violations.push(...(await filteredLinkViolations(app, settings, t, columns, spec)));
  const { acyclicPairs, acyclicViolations } = await import("./acyclic");
  if (acyclicPairs(columns, t.catalog.ref.full).some((p) => p.column === spec.name || p.inverse === spec.name)) {
    const afterOf = new Map(cs.edits.map((e) => [e.path, e.after]));
    const rowsNow = existing.map((r) => ({ path: r.file.path, ordered: afterOf.get(r.file.path) ?? r.ordered }));
    violations.push(...acyclicViolations(columns, t.catalog.ref.full, rowsNow, { involving: spec.name, wording: "check" }));
  }
  // the levels other tables' ref_by pick on this column must stay values of it
  const text = cs.texts.find((x) => x.path === t.file.path)!.after; // addSchemaChange wrote it
  const conflicts: OpConflict[] = levelTargetConflicts(parseMetastore(text), t.catalog.ref.full, spec.name).map((message) => ({ path: t.file.path, message }));
  return finish(app, settings, cs, conflicts, violations, opts);
}

export { fileOrNull };

// --- Telemetry wrappers (every table operation logs one record) ---

export function opSummary(r: OpResult): { severity: Severity; attributes: Record<string, AttrValue> } {
  return {
    severity: r.ok ? "INFO" : r.failed.length > 0 ? "ERROR" : "WARN",
    attributes: {
      ok: r.ok,
      notes_changed: r.notes_changed,
      files_created: r.files_created,
      files_moved: r.files_moved,
      files_deleted: r.files_deleted,
      references_updated: r.references_updated,
      conflicts: r.conflicts.length,
      violating_rows: r.violations.length,
      failed: r.failed.length,
      planned_notes: r.planned_edits.length,
      migration_id: r.migration_id,
    },
  };
}

export function instrumented<I, R extends OpResult = OpResult>(
  op: string,
  impl: (app: App, settings: DatanotesSettings, input: I, opts?: RunOptions) => Promise<R>,
  attrsOf: (input: I) => Record<string, AttrValue>,
): (app: App, settings: DatanotesSettings, input: I, opts?: RunOptions) => Promise<R> {
  // the attributes read the input before the operation checks it: a malformed one gets its refusal, not a TypeError
  const attrs = (input: I): Record<string, AttrValue> => {
    try {
      return attrsOf(input);
    } catch {
      return {};
    }
  };
  return (app, settings, input, opts = {}) =>
    traced(
      `datanotes ${op}`,
      { "datanotes.op": op, dry_run: opts.dryRun === true, ...attrs(input) },
      () => impl(app, settings, input, opts),
      opSummary,
    );
}

export const createTable = instrumented("create_table", createTableImpl, (i) => ({ table: i.name }));
export const dropTable = instrumented("drop_table", dropTableImpl, (i) => ({ table: i.table, mode: i.mode }));
export const addColumn = instrumented("add_column", addColumnImpl, (i) => ({
  table: i.table,
  column: typeof i.column.name === "string" ? i.column.name : undefined,
  dense: i.column.dense === true,
}));
export const renameColumn = instrumented("rename_column", renameColumnImpl, (i) => ({ table: i.table, from: i.from, to: i.to }));
export const renameValue = instrumented("rename_value", renameValueImpl, (i) => ({
  table: i.table,
  column: i.column,
  from: i.from,
  to: i.to,
}));
export const dropColumn = instrumented("drop_column", dropColumnImpl, (i) => ({ table: i.table, column: i.name }));
export const alterColumn = instrumented("alter_column", alterColumnImpl, (i) => ({ table: i.table, column: i.name }));

/**
 * Undo a journaled operation (see {@link undoMigration}), logged like other operations. A batch is
 * undone by undoing its operations newest first. The rows the whole undo leaves are checked first
 * (CHECKs that follow links, `ref_where` / `ref_by`, on the metastore it puts back), so a refusal
 * writes nothing. It stops at the first operation that cannot be undone (a note changed since:
 * reported, the ones after it stay undone); a retry skips the operations already undone. The undos
 * of a batch's operations are journaled as a batch (its `migration_id`), so undoing an undo is
 * a redo for a batch as for one operation. The result names the operation (`op`), as those of the
 * other writes do, whether it was undone or refused.
 */
export async function undoOperation(app: App, settings: DatanotesSettings, migrationId: string): Promise<UndoOperationResult> {
  const { ok, left: _left, ...rest } = await undoAny(app, settings, migrationId);
  return { ok, op: "undo_migration", ...rest };
}

/** What undo_migration answers: the undo's result, with the operation's name. */
export type UndoOperationResult = UndoResult & { op: "undo_migration" };

async function undoAny(app: App, settings: DatanotesSettings, migrationId: string): Promise<UndoResult> {
  const { entry, undone, path } = await readJournal(app, settings, migrationId);
  if (entry.op === "batch") {
    if (undone) return { ok: false, undoes: migrationId, conflicts: [{ path, message: "migration already undone" }], failed: [] };
    const members: string[] = [];
    const entries: JournalEntry[] = [];
    for (const m of [...entry.members!].reverse()) { // a batch entry lists its operations
      const j = await readJournal(app, settings, m);
      if (j.undone) continue; // undone by an earlier attempt
      members.push(m);
      entries.push(j.entry);
    }
    const refused = await undoCheck(app, settings, await undoChangeSet(app, entries, `undo ${migrationId}`));
    if (refused.length > 0) return { ok: false, undoes: migrationId, conflicts: refused, failed: [] };
    const touched: string[] = [];
    const undos: string[] = [];
    for (const m of members) {
      const r = await undoOne(app, settings, m, false);
      if (!r.ok) {
        return {
          ok: false,
          undoes: migrationId,
          conflicts: r.conflicts.map((c) => ({ ...c, message: `${m}: ${c.message}` })),
          failed: r.failed,
          touched,
        };
      }
      touched.push(...r.touched!); // an undo that succeeded names the files it wrote
      if (r.migration_id) undos.push(r.migration_id);
    }
    // the undos of its operations are a batch too: undoing it redoes them all, oldest first
    const now = new Date();
    const undoId =
      undos.length === 0
        ? undefined
        : (
            await writeJournal(
              app,
              settings,
              {
                op: "batch",
                summary: `undo ${migrationId}`,
                executed_at: now.toISOString(),
                rows: [],
                creates: [],
                moves: [],
                references: [],
                failed: [],
                members: undos,
                undoes: migrationId,
                ...(currentActor() ? { actor: currentActor() } : {}),
              },
              now,
            )
          ).id;
    await markUndone(app, settings, migrationId, undoId ?? migrationId, now);
    return { ok: true, undoes: migrationId, ...(undoId ? { migration_id: undoId } : {}), conflicts: [], failed: [], touched };
  }
  return undoOne(app, settings, migrationId);
}

/** How a refusal of undo_migration / restore_table names the way out. */
export const RESTORE_WAY_OUT = "fix the row first, or drop the rule that refuses it (alter_column ref_where / ref_by: null, drop_constraint)";

/**
 * undo_migration is checked like other writes: rows it would leave breaking a CHECK that follows
 * links, or a `ref_where` / `ref_by`, refuse it (listed, with their messages and the way out). The
 * rules are those of the metastore the undo leaves (an undone rename_value / rename_column puts
 * the old names back, an undone drop of a rule puts the rule back, and every row must hold it).
 */
async function undoCheck(app: App, settings: DatanotesSettings, cs: ChangeSet): Promise<UndoConflict[]> {
  const { linkedCheckViolations, metastoreLeftBy } = await import("./changeset-checks");
  return (await linkedCheckViolations(app, settings, cs, new Set(), await metastoreLeftBy(app, settings, cs))).flatMap((x) =>
    x.violations.map((v) => ({ path: x.path, message: `${v.code === "check" ? v.message : `${v.column} ${v.message}`}; to undo, ${RESTORE_WAY_OUT}` })),
  );
}

/** Whether some of these paths are files of a transaction log (moved with their table). */
export function movesLogFiles(settings: DatanotesSettings, paths: readonly string[]): boolean {
  const root = `${transactionLogRoot(settings)}/`;
  return paths.some((p) => p.startsWith(root));
}

function undoOne(
  app: App,
  settings: DatanotesSettings,
  migrationId: string,
  check = true,
): Promise<UndoResult> {
  return traced(
    "datanotes undo_migration",
    { "datanotes.op": "undo_migration", migration_id: migrationId },
    () =>
      whileWriting(app, () => withLogLock(app, async () => {
        await logChanges(app, settings, { operation: EXTERNAL_EDIT }, false);
        const r = await undoMigration(app, settings, migrationId, undefined, check ? (cs) => undoCheck(app, settings, cs) : undefined);
        invalidateFiles(app, r.touched ?? []);
        // The logged states stay valid unless the undo moved transaction log files (the undo of a
        // table's rename takes its log back): forgetting them all makes the next log sync replay
        // every table's log, seconds on a large vault.
        if (movesLogFiles(settings, r.touched ?? [])) forgetLoggedStates(app);
        await loadMetastore(app, settings);
        if (r.ok) {
          // an undo that succeeded has its journal entry and names the files it wrote
          notifyApplied(app, {
            op: "undo_migration",
            summary: `undo ${migrationId}`,
            migrationId: r.migration_id!,
            paths: r.touched!,
            moves: [],
            deletes: [],
            ...(currentActor() ? { actor: currentActor() } : {}),
          });
          await logChanges(app, settings, {
            operation: "UNDO",
            parameters: { migration: migrationId },
            migrationId: r.migration_id!,
            touched: r.touched!,
          });
        }
        return r;
      })),
    (r) => ({
      severity: r.ok ? "INFO" : r.failed.length > 0 ? "ERROR" : "WARN",
      attributes: {
        ok: r.ok,
        conflicts: r.conflicts.length,
        failed: r.failed.length,
        undo_migration_id: r.migration_id,
      },
    }),
  );
}
