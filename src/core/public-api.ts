/**
 * The plugin's API: `app.plugins.plugins["datanotes"].api`. It is the primary way to use the
 * database from code (other plugins, scripts, the console) and needs no other plugin. The REST
 * routes (`rest.ts`, on the Local REST API plugin) and the MCP server are optional layers over the
 * same operations.
 *
 * `version` changes only on a breaking change; new methods are added without bumping it, so feature
 * detection is `typeof api.insertRow === "function"`. Inputs are the engine's (camelCase).
 * Writes return an `OpResult` (`ok`, `violations`, `conflicts`, `migrationId` for undo) and accept
 * `{ dryRun: true }`. Bad input, unknown tables and malformed definitions throw.
 */

import type { App } from "./host";
import { runWithActor, type Actor } from "./actor";
import {
  addColumn,
  alterColumn,
  createTable,
  dropColumn,
  dropTable,
  loadTable,
  renameColumn,
  renameValue,
  undoOperation,
  type OpResult,
  type RunOptions,
} from "./engine";
import {
  adoptRows,
  alignRelations,
  alterTable,
  checkTable,
  deleteRows,
  insertRow,
  linkOptions,
  mergeRows,
  moveRows,
  recomputeColumns,
  select,
  updateRow,
  updateRows,
  type CheckResult,
} from "./rows";
import { addConstraint, cloneTable, commentOn, createView, defineBase, dropConstraint, dropView, setTableBases } from "./catalog-ops";
import { configureDatabase, describeDatabase } from "./database";
import { describeHistory, restoreTable, tableChanges, vacuumTable } from "./history";
import { packRows, unpackRows } from "./pack-rows";
import { describeDatabaseHistory, restoreDatabase } from "./database-history";
import { listMigrations } from "./journal";
import { catalogViews, constraintHints, loadMetastore, tableInstructions, tableTags } from "./metastore";
import { missingDescriptions } from "./descriptions";
import type { TableColumn } from "./types-table";
import { catalogRowFiles } from "./row-files";
import type { DatanotesSettings } from "./settings";
import { listTables, viewReadable, type TableRef } from "./table-registry";
import { assertTableReadable, currentReadScope, tableReadable, tableReadDenied } from "./read-scope";
import { refOf } from "./query-tables";
import { graphNeighbors, graphPath, graphTraverse, type NeighborsInput, type PathInput, type TraverseInput } from "./graph";
import { inferTable, type InferInput, type InferResult } from "./infer";
import type { SemanticIndex, SemanticSearchInput, SemanticHit, SemanticStatus, SyncResult } from "./semantic";
import type { ChangeFeed, ChangeOp, ChangePage, ChangeQuery } from "./change-feed";

/** Webhooks of the change feed (implemented by the server layer, see `server/webhooks.ts`). */
export interface WebhookAdmin {
  list(): unknown[];
  create(input: { url: string; tables?: string[]; ops?: ChangeOp[]; columns?: string[]; excludeActor?: string; where?: Record<string, unknown>; since?: number }): Promise<unknown>;
  remove(id: string): Promise<boolean>;
}
import { runBatch, type BatchResult } from "./batch";
import { guide, GuidedError } from "./hints";

/** The change feed and the webhooks run only while the engine follows the vault. */
const FOLLOW_HINT = (topic: "changeFeed" | "webhooks") => guide("They run while the engine follows the vault: start it with datanotes serve --vault <folder>.", topic);

/** Input of an engine operation `(app, settings, input, ...)`. */
type In<F> = F extends (app: App, settings: DatanotesSettings, input: infer I, ...rest: never[]) => unknown ? I : never;
type Out<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;
/** A journaled write: input plus optional `{ dryRun }`. */
type Write<F> = (input: In<F>, opts?: RunOptions) => Promise<OpResult>;

export interface ViewRef {
  name: string;
  catalog: string;
  schema: string;
  qualified: string;
  description?: string;
  aliases?: string[];
}

export interface DatanotesPublicApi {
  version: 1;

  // --- database and tables ---
  /** Tables of the cached `metastore.yaml` (sync; call `listTablesAndViews` to refresh first). */
  listTables(): TableRef[];
  /** Re-reads `metastore.yaml`: every table and view. */
  listTablesAndViews(): Promise<{ tables: TableRef[]; views: ViewRef[] }>;
  /** A table's definition (columns, options) with its qualified name and row count. */
  describeTable(table: string): Promise<DescribedTableAnswer>;
  describeDatabase(): Promise<Out<typeof describeDatabase>>;
  configureDatabase(input: In<typeof configureDatabase>): Promise<Out<typeof configureDatabase>>;

  // --- DDL ---
  createTable: Write<typeof createTable>;
  dropTable: Write<typeof dropTable>;
  alterTable: Write<typeof alterTable>;
  addColumn: Write<typeof addColumn>;
  alterColumn: Write<typeof alterColumn>;
  renameColumn: Write<typeof renameColumn>;
  dropColumn: Write<typeof dropColumn>;
  renameValue: Write<typeof renameValue>;
  addConstraint: Write<typeof addConstraint>;
  dropConstraint: Write<typeof dropConstraint>;
  createView: Write<typeof createView>;
  dropView: Write<typeof dropView>;
  cloneTable: Write<typeof cloneTable>;
  defineBase: Write<typeof defineBase>;
  setTableBases: Write<typeof setTableBases>;
  /** COMMENT ON CATALOG / SCHEMA: `comment` null or "" removes it. */
  commentOn: Write<typeof commentOn>;

  // --- rows ---
  insertRow: Write<typeof insertRow>;
  updateRows: Write<typeof updateRows>;
  /** One row by `id` or `path`; can also edit body sections. */
  updateRow: Write<typeof updateRow>;
  deleteRows: Write<typeof deleteRows>;
  mergeRows: Write<typeof mergeRows>;
  moveRows: Write<typeof moveRows>;
  adoptRows: Write<typeof adoptRows>;
  recomputeColumns: Write<typeof recomputeColumns>;
  /** Add the reciprocal links missing on a table's inverse columns (`inverse` on a link column). */
  alignRelations: Write<typeof alignRelations>;
  /** Query a table, a view or `base:<name>` (every table extending it): where, order, joins, group by, aggregates, time travel. */
  select(input: In<typeof select>): Promise<Out<typeof select>>;
  /**
   * `table` is a table name or the `path` from `listTables()`; without it, every table. The rows
   * with violations are paged: `page.limit` (default 500, at most 5000) from `page.offset`.
   */
  checkTable(table?: string, page?: { limit?: number; offset?: number }): Promise<CheckResult>;
  /** The valid targets of a link column for a row (`ref_where` / `ref_by` applied), for agents and pickers. */
  linkOptions(input: In<typeof linkOptions>): Promise<Out<typeof linkOptions>>;

  // --- journal and history ---
  listMigrations(input?: In<typeof listMigrations>): Promise<Out<typeof listMigrations>>;
  /** Undo one journaled operation by its `migrationId`. */
  undo(migrationId: string): Promise<Out<typeof undoOperation>>;
  describeHistory(input: In<typeof describeHistory>): Promise<Out<typeof describeHistory>>;
  tableChanges(input: In<typeof tableChanges>): Promise<Out<typeof tableChanges>>;
  restoreTable: Write<typeof restoreTable>;
  /** The commits of every logged table, newest first; the commits of one operation across tables are grouped (`tables`). */
  describeDatabaseHistory(input?: In<typeof describeDatabaseHistory>): Promise<Out<typeof describeDatabaseHistory>>;
  /** Every logged table back to a time, or to just before an operation, as one undoable operation. */
  restoreDatabase(input: In<typeof restoreDatabase>, opts?: RunOptions): Promise<Out<typeof restoreDatabase>>;
  vacuumTable(input: In<typeof vacuumTable>, opts?: RunOptions): Promise<Out<typeof vacuumTable>>;
  packRows(input: In<typeof packRows>, opts?: RunOptions): Promise<Out<typeof packRows>>;
  unpackRows(input: In<typeof unpackRows>, opts?: RunOptions): Promise<Out<typeof unpackRows>>;

  // --- link graph ---
  graphNeighbors(input: NeighborsInput): ReturnType<typeof graphNeighbors>;
  graphTraverse(input: TraverseInput): ReturnType<typeof graphTraverse>;
  graphPath(input: PathInput): ReturnType<typeof graphPath>;

  // --- schema inference ---
  /** Propose a table for existing notes (`folder` / `paths`), or the undeclared columns of a `table`. Read-only. */
  inferTable(input: InferInput): Promise<InferResult>;

  // --- semantic search (when enabled in the settings) ---
  /** Notes ranked by meaning; one result per note with its best passage. */
  semanticSearch(input: SemanticSearchInput): Promise<{ query: string; results: SemanticHit[] }>;
  semanticStatus(): SemanticStatus;
  /** Update the index (changed notes only), or `rebuild` it from scratch. */
  semanticSync(opts?: { rebuild?: boolean }): Promise<SyncResult>;

  // --- change feed (when the engine follows the vault) ---
  /**
   * Row changes after `since` (engine writes and hand edits), oldest first. `waitMs` waits up to
   * that long for a matching change when there is none yet (long poll). Pass `last` back as `since`.
   */
  changes(input?: ChangeQuery & { waitMs?: number }): Promise<ChangePage>;
  /** Webhooks: the change feed pushed to URLs (HMAC-signed batches, retried until delivered). */
  listWebhooks(): unknown[];
  /** Returns the webhook with its `secret` (shown once). Starts from now unless `since` is given. */
  createWebhook(input: { url: string; tables?: string[]; ops?: ChangeOp[]; columns?: string[]; excludeActor?: string; where?: Record<string, unknown>; since?: number }): Promise<unknown>;
  deleteWebhook(id: string): Promise<{ deleted: boolean }>;

  // --- batches ---
  /**
   * Several writes that succeed or fail together: `operations` are `{ op, ...input }` with `op` a
   * write method name (`insertRow`, `updateRow`, `addColumn`, … or snake_case `insert_row`). They run
   * in order; if one is refused, the ones already applied are undone. One journal entry: `undo` of
   * the batch's `migrationId` undoes them all.
   */
  batch(input: { operations: ({ op: string } & Record<string, unknown>)[]; summary?: string }, opts?: RunOptions): Promise<BatchResult>;

  /** Run `fn` on behalf of `actor` (e.g. an agent): its writes record who made them. */
  withActor<R>(actor: Actor, fn: () => R): R;
}

/**
 * Every table and view of `metastore.yaml` (re-read). Under a read scope, only those the token may
 * read: a view when its own name is readable and so is every table it reads.
 */
export async function listTablesAndViews(app: App, settings: DatanotesSettings): Promise<{ tables: TableRef[]; views: ViewRef[] }> {
  const ms = await loadMetastore(app, settings);
  const scope = currentReadScope();
  const views: ViewRef[] = ms
    ? catalogViews(ms.model).filter(({ ref }) => viewReadable(ms.model, ref.full, scope)).map(({ ref, view }) => ({
        name: ref.table,
        catalog: ref.catalog,
        schema: ref.schema,
        qualified: ref.full,
        ...(view.description ? { description: view.description } : {}),
        ...(view.aliases && view.aliases.length > 0 ? { aliases: view.aliases } : {}),
      }))
    : [];
  return { tables: listTables(app, settings.databaseFolder).filter((t) => tableReadable(t.qualified, scope)), views };
}

/** What describe_table answers: built field by field, so the engine's internals stay its own. */
export interface DescribedTableAnswer {
  qualified: string;
  name: string;
  catalog: string;
  schema: string;
  description?: string;
  aliases?: readonly string[];
  /** Where the rows go: the table folder, the folder pattern of new rows, the archive folder. */
  layout: { folder: string; row_folder: string; archive: string };
  /** The table options set on it: partition, filename, archive, exclude, pack, pack_after_days. */
  options: { partition?: string; filename?: string; archive?: string; exclude?: readonly string[]; pack?: string; pack_after_days?: number };
  columns: TableColumn[];
  /** Front matter keys every new row gets without a column (`fields`), and `table`. */
  untyped_fields: readonly string[];
  row_count: number;
  tags?: Record<string, string>;
  /** What has no description (a table written before descriptions were required). */
  missing_descriptions?: { table: boolean; columns: string[] };
  /** The bases it inherits columns from, in order. */
  bases?: string[];
  /** Its CHECK constraints: name → the `where` every row must match. */
  constraints?: Record<string, Record<string, unknown>>;
  /** The hint of each CHECK that has one: name → text. */
  constraint_hints?: Record<string, string>;
  /** How to fill a row of the table: follow them before writing. */
  instructions?: string;
  /** The text of every new row's note. */
  row_template?: string;
  /** Its own history setting (absent: the database's). */
  history?: boolean;
  /** Its own autolink_target setting (absent: the default). */
  autolink_target?: boolean;
  /** Front matter keys every new row gets, with their values. */
  fields?: Record<string, unknown>;
}

/** A table's definition with its qualified name, row count and what lacks a description. */
export async function describeTable(app: App, settings: DatanotesSettings, table: string): Promise<DescribedTableAnswer> {
  const scope = currentReadScope();
  if (scope) {
    // a view's name: refused when list_tables would hide it (the view, or a table it reads)
    const model = (await loadMetastore(app, settings))?.model;
    const view = model && typeof table === "string" && refOf(model, table, "table") === null ? refOf(model, table, "view") : null;
    if (model && view && !viewReadable(model, view, scope)) throw tableReadDenied(scope.token, view);
  }
  const t = await loadTable(app, settings, table);
  assertTableReadable(t.catalog.ref.full);
  const { def } = t;
  const o = def.options;
  const e = t.catalog.entry;
  const tags = tableTags(e);
  const hints = constraintHints(e);
  const instructions = tableInstructions(e);
  const missing = missingDescriptions(o.description, def.columns);
  return {
    qualified: t.catalog.ref.full,
    name: def.name,
    catalog: def.catalog,
    schema: def.schema,
    ...(o.description !== undefined ? { description: o.description } : {}),
    ...(o.aliases !== undefined ? { aliases: o.aliases } : {}),
    layout: { folder: def.layout.folder, row_folder: def.layout.rowPath, archive: def.layout.archive },
    options: {
      ...(o.partition !== undefined ? { partition: o.partition } : {}),
      ...(o.filename !== undefined ? { filename: o.filename } : {}),
      ...(o.archive !== undefined ? { archive: o.archive } : {}),
      ...(o.exclude !== undefined ? { exclude: o.exclude } : {}),
      ...(typeof e.options?.pack === "string" ? { pack: e.options.pack } : {}),
      ...(typeof e.options?.pack_after_days === "number" ? { pack_after_days: e.options.pack_after_days } : {}),
    },
    columns: [...def.columns],
    untyped_fields: def.untypedFields,
    row_count: catalogRowFiles(app, settings, t.catalog.ref.full, def).length,
    ...(tags ? { tags } : {}),
    ...(missing ? { missing_descriptions: missing } : {}),
    ...(e.bases && e.bases.length > 0 ? { bases: [...e.bases] } : {}),
    ...(e.constraints && Object.keys(e.constraints).length > 0 ? { constraints: e.constraints } : {}),
    ...(Object.keys(hints).length > 0 ? { constraint_hints: hints } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(typeof e.row_template === "string" ? { row_template: e.row_template } : {}),
    ...(typeof e.options?.history === "boolean" ? { history: e.options.history } : {}),
    ...(typeof e.options?.autolink_target === "boolean" ? { autolink_target: e.options.autolink_target } : {}),
    ...(e.fields && Object.keys(e.fields).length > 0 ? { fields: e.fields } : {}),
  };
}

/** Write operations a batch may contain, by API method name. */
export const BATCH_OPS = {
  insertRow, updateRows, updateRow, deleteRows, mergeRows, moveRows, adoptRows, recomputeColumns, alignRelations,
  createTable, dropTable, alterTable, addColumn, alterColumn, renameColumn, dropColumn, renameValue,
  addConstraint, dropConstraint, createView, dropView, cloneTable, defineBase, setTableBases, commentOn, restoreTable,
} as const;

/** `insert_row` → `insertRow`. */
export function camelOp(op: string): string {
  return op.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

export function createPublicApi(
  app: App,
  getSettings: () => DatanotesSettings,
  saveSettings: () => Promise<void> = async () => {},
  semantic?: SemanticIndex,
  feed?: () => ChangeFeed | null,
  webhooks?: () => WebhookAdmin | null,
): DatanotesPublicApi {
  const hooks = (): WebhookAdmin => {
    const w = webhooks?.();
    if (!w) throw new GuidedError("webhooks are not available (the engine is not following the vault)", FOLLOW_HINT("webhooks"));
    return w;
  };
  const s = getSettings;
  const index = (): SemanticIndex => {
    if (!semantic) throw new GuidedError("semantic search is not available", guide("Semantic search is off: turn it on with semanticEnabled, semanticProvider and semanticModel in the engine's settings.", "semantic"));
    return semantic;
  };
  return {
    version: 1,
    listTables: () => listTables(app, s().databaseFolder),
    listTablesAndViews: () => listTablesAndViews(app, s()),
    describeTable: (table) => describeTable(app, s(), table),
    describeDatabase: () => describeDatabase(app, s()),
    configureDatabase: (input) => configureDatabase(app, s(), input, saveSettings),

    createTable: (input, opts) => createTable(app, s(), input, opts),
    dropTable: (input, opts) => dropTable(app, s(), input, opts),
    alterTable: (input, opts) => alterTable(app, s(), input, opts),
    addColumn: (input, opts) => addColumn(app, s(), input, opts),
    alterColumn: (input, opts) => alterColumn(app, s(), input, opts),
    renameColumn: (input, opts) => renameColumn(app, s(), input, opts),
    dropColumn: (input, opts) => dropColumn(app, s(), input, opts),
    renameValue: (input, opts) => renameValue(app, s(), input, opts),
    addConstraint: (input, opts) => addConstraint(app, s(), input, opts),
    dropConstraint: (input, opts) => dropConstraint(app, s(), input, opts),
    createView: (input, opts) => createView(app, s(), input, opts),
    dropView: (input, opts) => dropView(app, s(), input, opts),
    cloneTable: (input, opts) => cloneTable(app, s(), input, opts),
    defineBase: (input, opts) => defineBase(app, s(), input, opts),
    setTableBases: (input, opts) => setTableBases(app, s(), input, opts),
    commentOn: (input, opts) => commentOn(app, s(), input, opts),

    insertRow: (input, opts) => insertRow(app, s(), input, opts),
    updateRows: (input, opts) => updateRows(app, s(), input, opts),
    updateRow: (input, opts) => updateRow(app, s(), input, opts),
    deleteRows: (input, opts) => deleteRows(app, s(), input, opts),
    mergeRows: (input, opts) => mergeRows(app, s(), input, opts),
    moveRows: (input, opts) => moveRows(app, s(), input, opts),
    adoptRows: (input, opts) => adoptRows(app, s(), input, opts),
    recomputeColumns: (input, opts) => recomputeColumns(app, s(), input, opts),
    alignRelations: (input, opts) => alignRelations(app, s(), input, opts),
    select: (input) => select(app, s(), input),
    checkTable: (table, page) => checkTable(app, s(), { ...(table === undefined ? {} : { table }), ...page }),
    linkOptions: (input) => linkOptions(app, s(), input),

    listMigrations: (input = {}) => listMigrations(app, s(), input),
    undo: (migrationId) => undoOperation(app, s(), migrationId),
    describeHistory: (input) => describeHistory(app, s(), input),
    tableChanges: (input) => tableChanges(app, s(), input),
    restoreTable: (input, opts) => restoreTable(app, s(), input, opts),
    describeDatabaseHistory: (input = {}) => describeDatabaseHistory(app, s(), input),
    restoreDatabase: (input, opts) => restoreDatabase(app, s(), input, opts),
    vacuumTable: (input, opts) => vacuumTable(app, s(), input, opts),
    packRows: (input, opts) => packRows(app, s(), input, opts),
    unpackRows: (input, opts) => unpackRows(app, s(), input, opts),

    graphNeighbors: (input) => graphNeighbors(app, s(), input),
    graphTraverse: (input) => graphTraverse(app, s(), input),
    graphPath: (input) => graphPath(app, s(), input),

    inferTable: (input) => inferTable(app, s(), input),

    semanticSearch: (input) => index().search(input),
    semanticStatus: () => index().status(),
    semanticSync: (opts = {}) => index().sync(opts),

    changes: async (input = {}) => {
      const f = feed?.();
      if (!f) throw new GuidedError("the change feed is not available (the engine is not following the vault)", FOLLOW_HINT("changeFeed"));
      const { waitMs, ...q } = input;
      return waitMs ? f.wait(q, waitMs) : f.read(q);
    },
    listWebhooks: () => hooks().list(),
    createWebhook: (input) => hooks().create(input),
    deleteWebhook: async (id) => ({ deleted: await hooks().remove(id) }),

    batch: async (input, opts = {}) => {
      if (!input || !Array.isArray(input.operations)) throw new Error(`"operations" must be a list`);
      const steps = input.operations.map((o, i) => {
        const { op, ...rest } = (o ?? {}) as { op?: unknown } & Record<string, unknown>;
        const name = typeof op === "string" ? camelOp(op) : "";
        const fn = (BATCH_OPS as Record<string, (app: App, settings: DatanotesSettings, input: never, opts: RunOptions) => Promise<OpResult>>)[name];
        if (!fn) throw new Error(`operation ${i}: "op" must be one of ${Object.keys(BATCH_OPS).join(", ")}`);
        return { op: name, run: (dryRun: boolean) => fn(app, s(), rest as never, { dryRun }) };
      });
      return runBatch(app, s(), steps, (id) => undoOperation(app, s(), id), { ...opts, ...(input.summary ? { summary: input.summary } : {}) });
    },

    withActor: (actor, fn) => runWithActor(actor, fn),
  };
}
