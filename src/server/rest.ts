/**
 * The routes of the engine's operations (`http-server.ts`): `POST /datanotes/operations/<name>/`,
 * one per operation of the catalogue (`src/api/catalog.ts`), its body the operation's arguments
 * exactly as an agent passes them to the MCP tool of the same name. A thin layer over the engine
 * (`src/core/`).
 *
 * Every request's arguments are first checked against the operation's input schema: an unknown
 * name (a misspelled argument) is refused with the closest real one, never ignored. Handlers are
 * pure `(body) => {status, json}` functions over the engine.
 */

import type { App } from "../core/host";
import { MigrationNotFoundError } from "../core/changeset";
import {
  addColumn,
  alterColumn,
  createTable,
  dropColumn,
  dropTable,
  OperationInputError,
  renameColumn,
  renameValue,
  undoOperation,
  type OpResult,
  type RunOptions,
} from "../core/engine";
import { settleVault } from "../core/vault-settle";
import { searchVault } from "../core/note-search";
import { holdsStaleWrite, runWrite } from "../core/write-check";
import { QueryInputError } from "../core/query";
import { adoptRows, alignRelations, alterTable, checkTable, deleteRows, insertRow, linkOptions, mergeRows, moveRows, recomputeColumns, select, updateRow, updateRows } from "../core/rows";
import { listMigrations } from "../core/journal";
import { addConstraint, cloneTable, commentOn, createView, defineBase, dropConstraint, dropView, setTableBases } from "../core/catalog-ops";
import { configureDatabase, DatabaseConfigError, describeDatabase } from "../core/database";
import type { DatanotesSettings } from "../core/settings";
import { MalformedColumnError, MalformedTableOptionsError } from "../core/table-loader";
import { TableNotFoundError } from "../core/table-registry";
import { AmbiguousCatalogRefError, MetastoreError } from "../core/metastore";
import { describeHistory, restoreTable, tableChanges, vacuumTable, wireCommit } from "../core/history";
import { describeDatabaseHistory, restoreDatabase } from "../core/database-history";
import { graphNeighbors, graphPath, graphTraverse, type Direction, type GraphNodeSet } from "../core/graph";
import { telemetry, type AttrValue } from "../core/telemetry";
import { activeSpan, discardTrace, phase, withSpan, type Span } from "../core/tracing";
import { createPublicApi, describeTable, listTablesAndViews, type DatanotesPublicApi } from "../core/public-api";
import { inferTable } from "../core/infer";
import { runBatch, type BatchResult } from "../core/batch";
import { EmbeddingError } from "../core/embeddings";
import type { SemanticIndex } from "../core/semantic";
import { opOfKind, wirePage } from "../core/change-feed";
import { listFolder, readNote, searchNotes, VaultPathError, VaultPathNotFoundError } from "../core/vault-read";
import { messageOf } from "../core/message";
import { didYouMean, guide, GuidedError, guidanceOf, refusalGuidance, undoGuidance, type Guidance } from "../core/hints";
import { argumentsOf, checkArguments, toolDocs } from "../api/guidance";
import { operationRoute } from "../api/requests";
import { currentActor } from "../core/actor";
import { currentReadScope, READ_DENIED_GUIDANCE, ReadDeniedError, tableReadable } from "../core/read-scope";
import { WriteDeniedError } from "../core/write-scope";
import { pathHidden } from "../core/changeset-checks";
import { READ_OPERATIONS } from "./token-routes";
import { operationClass, type OperationScheduler } from "./scheduler";
import type { CachedAnswer, CacheTicket, ReadCache } from "./read-cache";

export interface HandlerResponse {
  status: number;
  json: unknown;
  /** `json` as JSON text, when it is at hand (a cached read): sent as it is. */
  body?: string;
}

/** What the operations share besides the engine: write priority and the read cache (runtime.ts). */
export interface HandlerOptions {
  scheduler?: OperationScheduler;
  /** The read cache now (null: none, e.g. while the engine does not follow the vault). */
  cache?: () => ReadCache | null;
  /** The token behind the current call and its permissions: part of the read cache's keys. */
  scope?: () => string;
}

export type Body = Record<string, unknown>;
export type Handler = (body: Body) => Promise<HandlerResponse>;

export const ROUTE_PREFIX = "/datanotes";

/** Bad input to a route; `hint` and `docs` say how to fix it (default: the operation's arguments). */
export class BadRequest extends GuidedError {}

/** The caller may not do this (a named token beyond its permissions). */
export class Forbidden extends GuidedError {
  override readonly name = "Forbidden";
}

/** What a named token may not do: how to get the permission. */
export const FORBIDDEN_HINT = guide(
  "Named tokens read the tables their \"read\" patterns name (every table without \"read\"); writes need a matching \"write\" pattern, schema changes \"ddl\": true, maintenance \"maintain\": true. Ask the owner to update the token (tokens/update/), or use a token that has the permission.",
  "tokens",
);

/** The operation a route runs (`/operations/<name>/`), when it is one. */
export function operationOf(route: string): string | undefined {
  const m = /^\/operations\/([a-z][a-z0-9_]*)\/?$/.exec(route);
  return m ? m[1] : undefined;
}

/** Guidance when an error has none of its own: the operation's arguments and reference (or the route's). */
function argumentsGuidance(op: string | undefined, route: string | undefined): Guidance {
  if (op) return { hint: `Check the arguments of ${op}: ${argumentsOf(op)}.`, docs: toolDocs(op) };
  if (route?.startsWith("/tokens/")) {
    return guide(`The token routes take {"name"} and, to create or update one, "description" (text), "read" (table patterns it may read; on update, null for every table), "write" (table patterns it may write, each one readable), "ddl" and "maintain" (true or false), "autolink" (true or false: the default of its writes for automatic links).`, "manageTokens");
  }
  return guide("Check the request's fields against the route in GET /datanotes/openapi.json.", "routes");
}

/** Semantic search is off in the engine's settings. */
const SEMANTIC_OFF = guide(`Semantic search is off: the owner turns it on with semanticEnabled, semanticProvider and semanticModel in the engine's settings; search_notes finds text meanwhile.`, "semantic");

function optInt(body: Body, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new BadRequest(`"${key}" must be a non-negative integer`);
  return v;
}

/** Time travel parameters: `version` or `timestamp`. */
function asOf(body: Body): { version?: number; timestamp?: string } {
  const version = optInt(body, "version");
  const timestamp = str(body, "timestamp");
  return { ...(version !== undefined ? { version } : {}), ...(timestamp !== undefined ? { timestamp } : {}) };
}

// The readers below take a body already checked against the operation's input schema (checkArgs):
// a required argument is given, and a given one has its type (an object, a list of strings, a value
// of its enum). They read it, and refuse only what the schema lets through.

function str(body: Body, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim() === "") throw new BadRequest(`"${key}" must be a non-empty string`);
  return v;
}

/** An optional string where "" means something (a flat `partition`, the vault root). */
function text(body: Body, key: string): string | undefined {
  const v = body[key];
  return v === undefined || v === null ? undefined : (v as string);
}

function obj(body: Body, key: string): Record<string, unknown> | undefined {
  const v = body[key];
  return v === undefined || v === null ? undefined : (v as Record<string, unknown>);
}

function list(body: Body, key: string): unknown[] | undefined {
  const v = body[key];
  return v === undefined || v === null ? undefined : (v as unknown[]);
}

function strings(body: Body, key: string): string[] | undefined {
  return list(body, key) as string[] | undefined;
}

/** An optional true or false; null is not given. */
function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  return v === undefined || v === null ? undefined : (v as boolean);
}

/** An optional value among `allowed` (the schema's enum). */
function oneOf<T extends string>(body: Body, key: string, _allowed: readonly T[]): T | undefined {
  return str(body, key) as T | undefined;
}

/** A write's `autolink` (automatic links in the text it writes), when given. */
function autolinkArg(body: Body): { autolink?: boolean } {
  const v = optBool(body, "autolink");
  return v === undefined ? {} : { autolink: v };
}

function runOpts(body: Body): RunOptions {
  return { dryRun: body.dry_run === true };
}

function kindsArg(body: Body): string[] | undefined {
  return strings(body, "kinds")?.map(opOfKind);
}

/**
 * A write's answer: refused or failed ones say how to fix them (`hint`, `docs`). The status tells
 * a client what to do: 422, refused (change the data); 503, failed partway and rolled back, nothing
 * written (send it again later); 500, failed and not rolled back (undo_migration first).
 */
function writeResponse(r: OpResult, app: App, settings: DatanotesSettings): HandlerResponse {
  // the status is the write's; the answer (and so its guidance) is what the caller may read
  const answer = redactWriteAnswer(r, app, settings);
  if (r.ok) return { status: 200, json: answer };
  return { status: writeStatus(r.failed.length > 0, r.rolled_back), json: { ...answer, ...refusalGuidance(answer) } };
}

/**
 * The answer of a write as a restricted token may read it (its read scope: src/core/read-scope.ts,
 * guides/security/tokens#limit-what-a-token-can-read). The write itself is not changed (it checked
 * links, CHECKs and unique values against every table); its answer leaves out what it would tell
 * about the notes the token may not read: their entries in `planned_edits`, `planned_creates`,
 * `planned_moves` (either side), `planned_deletes`, `violations`, `conflicts` and `failed`, the
 * `commits` of their tables, the `links_added` to them, and the candidates of `ambiguous_mentions`
 * (a mention left with none goes). When it leaves out a conflict, violation or failure, one
 * conflict on the empty path says how many such rows block the write. A path of no note (the
 * empty one, a row the write creates or deleted) stays. Without a scope the result is returned
 * as it is. Built field by field: a field of the engine's result not listed here is not sent.
 */
export function redactWriteAnswer(r: OpResult, app: App, settings: DatanotesSettings): OpResult {
  const scope = currentReadScope();
  if (!scope) return r;
  const hidden = (path: string) => pathHidden(app, settings, path, scope);
  const blocked = new Set<string>();
  const keep = <T>(list: readonly T[], pathOf: (x: T) => string): T[] =>
    list.filter((x) => {
      const p = pathOf(x);
      if (!hidden(p)) return true;
      blocked.add(p);
      return false;
    });
  const conflicts = keep(r.conflicts, (c) => c.path).map((c) => ({ path: c.path, message: c.message }));
  const violations = keep(r.violations, (v) => v.path).map((v) => ({ path: v.path, violations: v.violations }));
  const failed = keep(r.failed, (f) => f.path).map((f) => ({ path: f.path, error: f.error }));
  if (blocked.size > 0) {
    const n = blocked.size;
    conflicts.push({ path: "", message: `${n} ${n === 1 ? "row" : "rows"} this token may not read ${n === 1 ? "blocks" : "block"} this write` });
  }
  const links = r.links_added?.filter((l) => !hidden(l.path) && !hidden(l.target)).map((l) => ({ path: l.path, text: l.text, target: l.target, link: l.link }));
  const mentions = r.ambiguous_mentions
    ?.filter((m) => !hidden(m.path))
    .map((m) => ({ path: m.path, text: m.text, reason: m.reason, candidates: m.candidates.filter((c) => !hidden(c)), context: m.context, hint: m.hint }))
    .filter((m) => m.candidates.length > 0);
  return {
    ok: r.ok,
    op: r.op,
    dry_run: r.dry_run,
    ...(r.migration_id !== undefined ? { migration_id: r.migration_id } : {}),
    notes_changed: r.notes_changed,
    files_created: r.files_created,
    files_moved: r.files_moved,
    files_deleted: r.files_deleted,
    references_updated: r.references_updated,
    conflicts,
    violations,
    failed,
    ...(r.rolled_back !== undefined ? { rolled_back: r.rolled_back } : {}),
    planned_edits: r.planned_edits.filter((e) => !hidden(e.path)).map((e) => ({ path: e.path, set: e.set, remove: e.remove, ...(e.body !== undefined ? { body: e.body } : {}) })),
    planned_creates: r.planned_creates.filter((p) => !hidden(p)),
    planned_moves: r.planned_moves.filter((m) => !hidden(m.from) && !hidden(m.to)).map((m) => ({ from: m.from, to: m.to })),
    planned_deletes: r.planned_deletes.filter((p) => !hidden(p)),
    planned_texts: [...r.planned_texts],
    ...(r.commits ? { commits: r.commits.filter((c) => tableReadable(c.table, scope)).map((c) => ({ table: c.table, version: c.version, operation: c.operation })) } : {}),
    ...(links && links.length > 0 ? { links_added: links } : {}),
    ...(mentions && mentions.length > 0 ? { ambiguous_mentions: mentions } : {}),
  };
}

/** The status of a write that did not apply: refused (422), failed and rolled back (503), failed and left (500). */
function writeStatus(failed: boolean, rolledBack: boolean | undefined): number {
  return !failed ? 422 : rolledBack === true ? 503 : 500;
}

/**
 * Map thrown errors to HTTP status codes with an agent-readable message: `error` says what is
 * wrong, `hint` how to fix it and `docs` where to read more (the error's own, or the defaults of
 * its kind: the operation's arguments for bad input). An unexpected error (500) has neither.
 */
export function errorResponse(e: unknown, op?: string, route?: string): HandlerResponse {
  const message = messageOf(e);
  const own = guidanceOf(e);
  const body = (fallback: Guidance) => ({ error: message, ...(own ?? fallback) });
  if (e instanceof TableNotFoundError) return { status: 404, json: body(guide("list_tables lists the tables and views, with their descriptions and aliases.", "findTable")) };
  if (e instanceof MigrationNotFoundError) return { status: 404, json: body(guide("list_migrations lists the journal ids (migration_id) of the writes, newest first.", "undo")) };
  if (e instanceof VaultPathNotFoundError) return { status: 404, json: body(guide("list_folder lists a folder, search_notes finds notes by their words.", "readNote")) };
  if (e instanceof ReadDeniedError) return { status: 403, json: body(READ_DENIED_GUIDANCE) };
  if (e instanceof Forbidden || e instanceof WriteDeniedError) return { status: 403, json: body(FORBIDDEN_HINT) };
  if (e instanceof AmbiguousCatalogRefError) {
    return { status: 409, json: { ...body(guide(`Name the table in full (catalog.schema.table): ${e.candidates.join(" or ")}.`, "catalogs")), tables: e.candidates } };
  }
  if (
    e instanceof BadRequest ||
    e instanceof OperationInputError ||
    e instanceof MalformedColumnError ||
    e instanceof MalformedTableOptionsError ||
    e instanceof QueryInputError ||
    e instanceof DatabaseConfigError ||
    e instanceof EmbeddingError ||
    e instanceof MetastoreError ||
    e instanceof VaultPathError
  ) {
    return { status: 400, json: body(e instanceof EmbeddingError ? guide("Check the embedding provider's settings and key; describe_semantic_index shows the index.", "semantic") : argumentsGuidance(op, route)) };
  }
  return { status: 500, json: { error: message } };
}

/** A batch step's error answer as an error, keeping its `hint` and `docs`. */
function stepFailure(json: unknown): Error {
  return Object.assign(new Error((json as { error: string }).error), guidanceOf(json));
}

/**
 * A batch's answer with its `rollback` as a restricted token may read it: the undo conflicts and
 * failures of notes it may not read left out (as in {@link redactWriteAnswer}). The steps are
 * redacted by their own answers. Without a scope, or without a rollback, the result as it is.
 */
export function redactBatchRollback(r: BatchResult, app: App, settings: DatanotesSettings): BatchResult {
  const scope = currentReadScope();
  if (!scope || !r.rollback) return r;
  const shown = (path: string) => !pathHidden(app, settings, path, scope);
  return {
    ok: r.ok,
    op: r.op,
    dry_run: r.dry_run,
    ...(r.migration_id !== undefined ? { migration_id: r.migration_id } : {}),
    steps: r.steps,
    ...(r.failed_at !== undefined ? { failed_at: r.failed_at } : {}),
    ...(r.rolled_back !== undefined ? { rolled_back: r.rolled_back } : {}),
    rollback: r.rollback.map((u) => ({
      migration_id: u.migration_id,
      ok: u.ok,
      conflicts: u.conflicts.filter((c) => shown(c.path)).map((c) => ({ path: c.path, message: c.message })),
      failed: u.failed.filter((f) => shown(f.path)).map((f) => ({ path: f.path, error: f.error })),
    })),
  };
}

/** How to go on after a refused batch. */
export function batchGuidance(r: { dry_run: boolean; failed_at?: number; rolled_back?: boolean }): Guidance {
  if (r.dry_run) return guide("Fix the operations marked refused, then send the batch again (dry_run checks each one against the vault as it is now).", "batch");
  if (r.rolled_back === false) return guide("Some operations could not be undone: \"rollback\" lists them; undo them with undo_migration, or repair the rows, before you retry.", "batch");
  return guide(`Nothing is left written: fix operation ${r.failed_at} as its error says, then send the whole batch again.`, "batch");
}

/** The writes a batch may hold: the row operations, restore_table and the schema operations. */
export const BATCH_OPERATIONS: readonly string[] = [
  "insert_row",
  "update_row",
  "update_rows",
  "delete_rows",
  "merge_rows",
  "move_rows",
  "adopt_rows",
  "recompute_columns",
  "align_relations",
  "restore_table",
  "create_table",
  "drop_table",
  "alter_table",
  "clone_table",
  "add_column",
  "rename_column",
  "drop_column",
  "alter_column",
  "rename_value",
  "comment_on",
  "define_base",
  "set_table_bases",
  "add_constraint",
  "drop_constraint",
  "create_view",
  "drop_view",
];
const BATCH_SET: ReadonlySet<string> = new Set(BATCH_OPERATIONS);

/** May a batch hold this operation? (Own names only: not `toString` and the like.) */
export function isBatchOperation(op: string): boolean {
  return BATCH_SET.has(op);
}

/** The arguments of a call, checked against the operation's input schema (catalog.ts). */
function checkArgs(op: string, args: Body): void {
  const p = checkArguments(op, args);
  if (p) throw new BadRequest(p.message, { hint: p.hint, docs: p.docs });
}

/** Route path (without prefix) → handler: `/operations/<name>/` for every operation. */
export function createHandlers(
  app: App,
  getSettings: () => DatanotesSettings,
  saveSettings: () => Promise<void> = async () => {},
  semantic?: SemanticIndex,
  api?: DatanotesPublicApi,
  options: HandlerOptions = {},
): Record<string, Handler> {
  const s = getSettings;
  const opResponse = (r: OpResult): HandlerResponse => writeResponse(r, app, s());
  const pub = api ?? createPublicApi(app, getSettings, saveSettings, semantic);
  const needSemantic = (): SemanticIndex => {
    if (!semantic) throw new BadRequest("semantic search is not available", SEMANTIC_OFF);
    return semantic;
  };
  const feedCall = async <T>(f: () => Promise<T> | T): Promise<HandlerResponse> => {
    try {
      return { status: 200, json: await f() };
    } catch (e) {
      throw new BadRequest(messageOf(e), guidanceOf(e));
    }
  };

  const ops: Record<string, Handler> = {
    // --- auxiliary ---
    list_tables: async () => ({ status: 200, json: await listTablesAndViews(app, s()) }),
    describe_table: async (b) => ({ status: 200, json: await describeTable(app, s(), str(b, "table")!) }),
    describe_database: async () => ({ status: 200, json: await describeDatabase(app, s()) }),
    configure_database: async (b) => {
      // argument → the key of `config` in metastore.yaml
      const keys: Record<string, string> = {
        root: "root",
        default_catalog: "default_catalog",
        default_schema: "default_schema",
        default_partition: "default_partition",
        default_filename: "default_filename",
        archive_folder: "archive_folder",
        timezone: "timezone",
      };
      const input: Record<string, string | boolean> = {};
      for (const k of ["history", "autolink"]) {
        const v = optBool(b, k);
        if (v !== undefined) input[k] = v;
      }
      for (const [arg, key] of Object.entries(keys)) {
        const v = text(b, arg); // "" is meaningful for default_partition (flat tables)
        if (v !== undefined) input[key] = v;
      }
      return { status: 200, json: await configureDatabase(app, s(), input, saveSettings) };
    },
    check_table: async (b) => {
      const table = str(b, "table");
      const limit = optInt(b, "limit");
      const offset = optInt(b, "offset");
      return {
        status: 200,
        json: await checkTable(app, s(), { ...(table ? { table } : {}), ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) }),
      };
    },
    infer_table: async (b) => {
      const maxEnum = optInt(b, "max_enum_values");
      const folder = text(b, "folder");
      const r = await inferTable(app, s(), {
        ...(folder !== undefined ? { folder } : {}),
        ...(strings(b, "paths") ? { paths: strings(b, "paths")! } : {}),
        ...(str(b, "table") !== undefined ? { table: str(b, "table")! } : {}),
        ...(str(b, "name") !== undefined ? { name: str(b, "name")! } : {}),
        ...(maxEnum !== undefined ? { maxEnumValues: maxEnum } : {}),
      });
      if (!r.proposal) return { status: 200, json: r };
      // the proposal in create_table's argument names, so the caller passes it as it is
      const { name, description, timeColumn, options, ...proposal } = r.proposal;
      return {
        status: 200,
        json: { ...r, proposal: { name, description, ...(timeColumn !== undefined ? { time_column: timeColumn } : {}), ...(options.filename !== undefined ? { filename: options.filename } : {}), ...proposal } },
      };
    },
    describe_semantic_index: async () => ({ status: 200, json: needSemantic().status() }),
    sync_semantic_index: async (b) => {
      const rebuild = optBool(b, "rebuild");
      return { status: 200, json: await needSemantic().sync({ rebuild: rebuild === true }) };
    },

    // --- schema (DDL) ---
    create_table: async (b) => {
      const options: Record<string, unknown> = {};
      for (const k of ["filename", "archive"]) {
        const v = str(b, k);
        if (v !== undefined) options[k] = v;
      }
      const partition = text(b, "partition");
      if (partition !== undefined) options.partition = partition;
      for (const k of ["exclude", "aliases"]) {
        const v = strings(b, k);
        if (v) options[k] = v;
      }
      const target = optBool(b, "autolink_target");
      if (target !== undefined) options.autolink_target = target;
      const history = optBool(b, "history");
      const template = text(b, "row_template");
      const instructions = text(b, "instructions");
      return opResponse(
        await createTable(
          app,
          s(),
          {
            name: str(b, "name")!,
            // null (as infer_table's proposal has it) or "" is refused by the engine with the other missing descriptions
            ...(b.description === null ? { description: null } : text(b, "description") !== undefined ? { description: text(b, "description")! } : {}),
            ...(str(b, "schema") !== undefined ? { schema: str(b, "schema")! } : {}),
            ...(str(b, "catalog") !== undefined ? { catalog: str(b, "catalog")! } : {}),
            ...(str(b, "time_column") !== undefined ? { timeColumn: str(b, "time_column")! } : {}),
            ...(Object.keys(options).length > 0 ? { options: options as never } : {}),
            ...(history !== undefined ? { history } : {}),
            ...(obj(b, "fields") ? { fields: obj(b, "fields")! } : {}),
            columns: list(b, "columns") as never,
            ...(template !== undefined ? { rowTemplate: template } : {}),
            ...(instructions !== undefined ? { instructions } : {}),
            ...(obj(b, "tags") ? { tags: obj(b, "tags") as Record<string, string> } : {}),
          },
          runOpts(b),
        ),
      );
    },
    drop_table: async (b) => {
      const mode = oneOf(b, "mode", ["archive"] as const);
      return opResponse(await dropTable(app, s(), { table: str(b, "table")!, ...(mode ? { mode } : {}) }, runOpts(b)));
    },
    alter_table: async (b) => {
      const optStr = (k: string) => (str(b, k) !== undefined ? { [k]: str(b, k)! } : {});
      // true, false or "default" (the input schema)
      const history = b.history;
      const target = b.autolink_target;
      const description = text(b, "description");
      const template = text(b, "row_template");
      const instructions = text(b, "instructions");
      const archive = text(b, "archive");
      const partition = text(b, "partition");
      return opResponse(
        await alterTable(
          app,
          s(),
          {
            table: str(b, "table")!,
            ...optStr("catalog"),
            ...optStr("schema"),
            ...optStr("name"),
            ...(partition !== undefined ? { partition } : {}),
            ...optStr("filename"),
            ...(description !== undefined ? { description } : {}),
            ...(strings(b, "aliases") ? { aliases: strings(b, "aliases")! } : {}),
            ...(strings(b, "exclude") ? { exclude: strings(b, "exclude")! } : {}),
            ...(history === "default" ? { history: null } : typeof history === "boolean" ? { history } : {}),
            ...(target === "default" ? { autolinkTarget: null } : typeof target === "boolean" ? { autolinkTarget: target } : {}),
            // "" removes the template
            ...(template !== undefined ? { rowTemplate: template === "" ? null : template } : {}),
            // "" removes the instructions
            ...(instructions !== undefined ? { instructions: instructions === "" ? null : instructions } : {}),
            ...(obj(b, "tags") ? { tags: obj(b, "tags") as Record<string, string | null> } : {}),
            ...(optBool(b, "clear_tags") === true ? { clearTags: true } : {}),
            ...(archive !== undefined ? { archive } : {}),
            ...(obj(b, "fields") ? { fields: obj(b, "fields")! } : {}),
          },
          runOpts(b),
        ),
      );
    },
    clone_table: async (b) => {
      const copyRows = optBool(b, "copy_rows");
      return opResponse(
        await cloneTable(app, s(), { source: str(b, "source")!, target: str(b, "target")!, ...asOf(b), ...(copyRows === false ? { shallow: true } : {}) }, runOpts(b)),
      );
    },
    add_column: async (b) => opResponse(await addColumn(app, s(), { table: str(b, "table")!, column: obj(b, "column")! }, runOpts(b))),
    rename_column: async (b) =>
      opResponse(await renameColumn(app, s(), { table: str(b, "table")!, from: str(b, "from_column")!, to: str(b, "to_column")! }, runOpts(b))),
    drop_column: async (b) => opResponse(await dropColumn(app, s(), { table: str(b, "table")!, name: str(b, "column")! }, runOpts(b))),
    alter_column: async (b) =>
      opResponse(await alterColumn(app, s(), { table: str(b, "table")!, name: str(b, "column")!, changes: obj(b, "changes")! }, runOpts(b))),
    rename_value: async (b) =>
      opResponse(
        await renameValue(app, s(), { table: str(b, "table")!, column: str(b, "column")!, from: str(b, "from_value")!, to: str(b, "to_value")! }, runOpts(b)),
      ),
    comment_on: async (b) => {
      const description = text(b, "description")!;
      return opResponse(
        await commentOn(app, s(), { catalog: str(b, "catalog")!, ...(str(b, "schema") !== undefined ? { schema: str(b, "schema")! } : {}), description }, runOpts(b)),
      );
    },
    define_base: async (b) => {
      const rename = obj(b, "rename_columns");
      return opResponse(
        await defineBase(
          app,
          s(),
          {
            name: str(b, "name")!,
            columns: list(b, "columns") as Record<string, unknown>[],
            ...(strings(b, "bases") ? { bases: strings(b, "bases")! } : {}),
            ...(str(b, "description") !== undefined ? { description: str(b, "description")! } : {}),
            ...(rename ? { renameColumns: rename as Record<string, string> } : {}),
            ...(strings(b, "drop_columns") ? { dropColumns: strings(b, "drop_columns")! } : {}),
          },
          runOpts(b),
        ),
      );
    },
    set_table_bases: async (b) => opResponse(await setTableBases(app, s(), { table: str(b, "table")!, bases: strings(b, "bases")! }, runOpts(b))),
    add_constraint: async (b) => opResponse(await addConstraint(app, s(), { table: str(b, "table")!, name: str(b, "name")!, check: obj(b, "check")!, ...(text(b, "hint") !== undefined ? { hint: text(b, "hint")! } : {}) }, runOpts(b))),
    drop_constraint: async (b) => opResponse(await dropConstraint(app, s(), { table: str(b, "table")!, name: str(b, "name")! }, runOpts(b))),
    create_view: async (b) =>
      opResponse(
        await createView(
          app,
          s(),
          {
            name: str(b, "name")!,
            ...(str(b, "catalog") !== undefined ? { catalog: str(b, "catalog")! } : {}),
            ...(str(b, "schema") !== undefined ? { schema: str(b, "schema")! } : {}),
            ...(str(b, "description") !== undefined ? { description: str(b, "description")! } : {}),
            ...(strings(b, "aliases") ? { aliases: strings(b, "aliases")! } : {}),
            ...(obj(b, "labels") ? { labels: obj(b, "labels") as Record<string, string> } : {}),
            query: obj(b, "query")!,
            ...(optBool(b, "replace") === true ? { replace: true } : {}),
          },
          runOpts(b),
        ),
      ),
    drop_view: async (b) => opResponse(await dropView(app, s(), { view: str(b, "view")! }, runOpts(b))),

    // --- rows (DML) ---
    insert_row: async (b) =>
      opResponse(
        await insertRow(
          app,
          s(),
          {
            table: str(b, "table")!,
            values: obj(b, "values")!,
            ...(text(b, "body") !== undefined ? { body: text(b, "body")! } : {}),
            ...(str(b, "path") !== undefined ? { path: str(b, "path")! } : {}),
            ...autolinkArg(b),
          },
          runOpts(b),
        ),
      ),
    update_row: async (b) =>
      opResponse(
        await updateRow(
          app,
          s(),
          {
            table: str(b, "table")!,
            ...(str(b, "id") !== undefined ? { id: str(b, "id")! } : {}),
            ...(str(b, "path") !== undefined ? { path: str(b, "path")! } : {}),
            ...(obj(b, "set") ? { set: obj(b, "set")! } : {}),
            ...(strings(b, "unset") ? { unset: strings(b, "unset")! } : {}),
            ...(text(b, "body") !== undefined ? { body: text(b, "body")! } : {}),
            ...(obj(b, "body_sections") ? { bodySections: obj(b, "body_sections") as Record<string, string> } : {}),
            ...(text(b, "body_prepend") !== undefined ? { bodyPrepend: text(b, "body_prepend")! } : {}),
            ...(text(b, "body_append") !== undefined ? { bodyAppend: text(b, "body_append")! } : {}),
            ...(obj(b, "expect") ? { expect: obj(b, "expect")! } : {}),
            ...autolinkArg(b),
          },
          runOpts(b),
        ),
      ),
    update_rows: async (b) => {
      const expectCount = optInt(b, "expect_count");
      return opResponse(
        await updateRows(
          app,
          s(),
          {
            table: str(b, "table")!,
            where: obj(b, "where")!,
            ...(obj(b, "set") ? { set: obj(b, "set")! } : {}),
            ...(strings(b, "unset") ? { unset: strings(b, "unset")! } : {}),
            ...(expectCount !== undefined ? { expectCount } : {}),
          },
          runOpts(b),
        ),
      );
    },
    delete_rows: async (b) => {
      const mode = oneOf(b, "mode", ["archive", "delete"] as const);
      const policy = oneOf(b, "on_referenced", ["restrict", "set_null", "ignore"] as const);
      return opResponse(
        await deleteRows(app, s(), { table: str(b, "table")!, where: obj(b, "where")!, ...(mode ? { mode } : {}), ...(policy ? { onReferenced: policy } : {}) }, runOpts(b)),
      );
    },
    merge_rows: async (b) => {
      const whenMatched = oneOf(b, "when_matched", ["update", "ignore"] as const);
      const whenNotMatched = oneOf(b, "when_not_matched", ["insert", "ignore"] as const);
      return opResponse(
        await mergeRows(
          app,
          s(),
          {
            table: str(b, "table")!,
            on: strings(b, "on")!,
            rows: list(b, "rows") as Record<string, unknown>[],
            ...(whenMatched ? { whenMatched } : {}),
            ...(whenNotMatched ? { whenNotMatched } : {}),
          },
          runOpts(b),
        ),
      );
    },
    move_rows: async (b) =>
      opResponse(
        await moveRows(
          app,
          s(),
          {
            table: str(b, "table")!,
            toTable: str(b, "to_table")!,
            where: obj(b, "where")!,
            ...(obj(b, "rename") ? { rename: obj(b, "rename") as Record<string, string> } : {}),
            ...(obj(b, "set") ? { set: obj(b, "set")! } : {}),
            ...(strings(b, "drop") ? { drop: strings(b, "drop")! } : {}),
            ...(optBool(b, "relocate") === true ? { relocate: true } : {}),
          },
          runOpts(b),
        ),
      ),
    adopt_rows: async (b) =>
      opResponse(
        await adoptRows(
          app,
          s(),
          {
            table: str(b, "table")!,
            paths: strings(b, "paths")!,
            ...(obj(b, "rename") ? { rename: obj(b, "rename") as Record<string, string> } : {}),
            ...(obj(b, "set") ? { set: obj(b, "set")! } : {}),
            ...(obj(b, "per_row") ? { perRow: obj(b, "per_row") as Record<string, Record<string, unknown>> } : {}),
            ...(strings(b, "drop") ? { drop: strings(b, "drop")! } : {}),
            ...(optBool(b, "relocate") === false ? { relocate: false } : {}),
          },
          runOpts(b),
        ),
      ),
    recompute_columns: async (b) =>
      opResponse(
        await recomputeColumns(
          app,
          s(),
          { table: str(b, "table")!, ...(strings(b, "paths") ? { paths: strings(b, "paths")! } : {}), ...(optBool(b, "new_ids") === true ? { newIds: true } : {}) },
          runOpts(b),
        ),
      ),
    align_relations: async (b) =>
      opResponse(await alignRelations(app, s(), { table: str(b, "table")!, ...(strings(b, "paths") ? { paths: strings(b, "paths")! } : {}) }, runOpts(b))),
    batch: async (b) => {
      const operations = list(b, "operations")!;
      if (operations.length === 0) throw new BadRequest(`"operations" must be a non-empty list`);
      // the steps refused because they change rows of a table the token may not write (403)
      const denied = new Set<number>();
      const steps = operations.map((raw, i) => {
        const { op, ...args } = raw as Body;
        if (typeof op !== "string") throw new BadRequest(`operation ${i} needs "op"`);
        if (!isBatchOperation(op)) {
          throw new BadRequest(
            `operation ${i}: "op" must be one of ${BATCH_OPERATIONS.join(", ")}`,
            guide(`${didYouMean(op, BATCH_OPERATIONS)} A batch holds writes: each operation is {"op": "<name>", ...its arguments}.`.trim(), "batch"),
          );
        }
        const problem = checkArguments(op, args);
        if (problem) throw new BadRequest(`operation ${i}: ${problem.message}`, { hint: problem.hint, docs: problem.docs });
        return {
          op,
          run: async (dryRun: boolean): Promise<OpResult> => {
            // an error is answered as the operation answers it: its message, with its guidance
            const res = await ops[op]!({ ...args, dry_run: dryRun }).catch((e: unknown) => {
              if (e instanceof WriteDeniedError) denied.add(i);
              return errorResponse(e, op);
            });
            // a write's result (done, refused, failed) has its "op"; an error is the step's error
            if ("op" in (res.json as object)) return res.json as OpResult;
            throw stepFailure(res.json);
          },
        };
      });
      const r = await runBatch(app, s(), steps, (id) => undoOperation(app, s(), id), {
        ...runOpts(b),
        ...(str(b, "summary") !== undefined ? { summary: str(b, "summary")! } : {}),
      });
      // a step that failed partway (not refused) makes the batch a failure: 503 once all is rolled back
      const failedStep = r.failed_at !== undefined && (r.steps[r.failed_at]?.result?.failed.length ?? 0) > 0;
      // a step refused for a table the token may not write: the batch is refused as that write is (403)
      const forbidden = r.failed_at !== undefined ? (denied.has(r.failed_at) ? r.failed_at : undefined) : [...denied].sort((a, b) => a - b)[0];
      const status = r.ok ? 200 : r.rolled_back === false ? 500 : forbidden !== undefined ? 403 : writeStatus(failedStep, true);
      // each step's result is redacted already (opResponse); what the rollback reports is too
      const answer = redactBatchRollback(r, app, s());
      if (status === 403) {
        // as the guard refuses a step: "operation <i>: <why>", with the step's hint and docs
        const step = answer.steps[forbidden!]!;
        return { status, json: { ...answer, error: `operation ${forbidden}: ${step.error}`, hint: step.hint, docs: step.docs } };
      }
      return { status, json: answer.ok ? answer : { ...answer, ...batchGuidance(answer) } };
    },

    // --- queries ---
    select_rows: async (b) => {
      // a string or a list of strings (the input schema)
      const groupBy = b.group_by;
      const orderBy = b.order_by;
      const limit = optInt(b, "limit");
      const offset = optInt(b, "offset");
      const join = obj(b, "join");
      const aggregates = obj(b, "aggregates");
      return {
        status: 200,
        json: await select(app, s(), {
          table: str(b, "table")!,
          ...(strings(b, "columns") ? { columns: strings(b, "columns")! } : {}),
          ...(obj(b, "where") ? { where: obj(b, "where")! } : {}),
          ...(orderBy !== undefined && orderBy !== null ? { orderBy: orderBy as string | string[] } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(strings(b, "expand") ? { expand: strings(b, "expand")! } : {}),
          ...(join ? { join: join as never } : {}),
          ...(groupBy !== undefined && groupBy !== null ? { groupBy: groupBy as string | string[] } : {}),
          ...(aggregates ? { aggregates: aggregates as Record<string, string> } : {}),
          ...(optBool(b, "include_body") === true ? { includeBody: true } : {}),
          ...(str(b, "this_note") !== undefined ? { thisNote: str(b, "this_note")! } : {}),
          ...asOf(b),
        }),
      };
    },
    list_link_targets: async (b) => {
      const limit = optInt(b, "limit");
      const row = str(b, "row");
      const values = obj(b, "values");
      return {
        status: 200,
        json: await linkOptions(app, s(), {
          table: str(b, "table")!,
          column: str(b, "column")!,
          ...(row !== undefined ? { row } : {}),
          ...(values ? { values } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      };
    },
    read_note: async (b) => ({ status: 200, json: await readNote(app, s(), text(b, "path")!) }),
    list_folder: async (b) => ({ status: 200, json: listFolder(app, text(b, "folder") ?? "", s()) }),
    search_notes: async (b) => {
      const ctx = optInt(b, "context_length");
      return { status: 200, json: await searchNotes(app, str(b, "query")!, ctx ?? 100, s()) };
    },
    semantic_search: async (b) => {
      const sem = needSemantic();
      const limit = optInt(b, "limit");
      const minScore = b.min_score; // a number (the input schema)
      return {
        status: 200,
        json: await sem.search({
          query: str(b, "query")!,
          ...(limit !== undefined ? { limit } : {}),
          ...(strings(b, "tables") ? { tables: strings(b, "tables")! } : {}),
          ...(str(b, "folder") !== undefined ? { folder: str(b, "folder")! } : {}),
          ...(typeof minScore === "number" ? { minScore } : {}),
        }),
      };
    },
    search: async (b) => {
      const limit = optInt(b, "limit");
      const minScore = b.min_score; // a number (the input schema)
      return {
        status: 200,
        json: await searchVault(app, s(), {
          query: str(b, "query")!,
          ...(limit !== undefined ? { limit } : {}),
          ...(strings(b, "tables") ? { tables: strings(b, "tables")! } : {}),
          ...(str(b, "folder") !== undefined ? { folder: str(b, "folder")! } : {}),
          ...(typeof minScore === "number" ? { minScore } : {}),
        }, semantic),
      };
    },
    graph_neighbors: async (b) => ({
      status: 200,
      json: await graphNeighbors(app, s(), {
        from: obj(b, "from_nodes") as GraphNodeSet,
        ...(str(b, "direction") !== undefined ? { direction: str(b, "direction") as Direction } : {}),
        ...(strings(b, "edges") ? { edges: strings(b, "edges")! } : {}),
      }),
    }),
    graph_traverse: async (b) => {
      const min = optInt(b, "min_depth");
      const max = optInt(b, "max_depth");
      const limit = optInt(b, "limit");
      return {
        status: 200,
        json: await graphTraverse(app, s(), {
          from: obj(b, "from_nodes") as GraphNodeSet,
          ...(str(b, "direction") !== undefined ? { direction: str(b, "direction") as Direction } : {}),
          ...(strings(b, "edges") ? { edges: strings(b, "edges")! } : {}),
          ...(strings(b, "tables") ? { tables: strings(b, "tables")! } : {}),
          ...(strings(b, "through") ? { through: strings(b, "through")! } : {}),
          ...(min !== undefined ? { minDepth: min } : {}),
          ...(max !== undefined ? { maxDepth: max } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      };
    },
    graph_path: async (b) => {
      const max = optInt(b, "max_depth");
      return {
        status: 200,
        json: await graphPath(app, s(), {
          from: obj(b, "from_nodes") as GraphNodeSet,
          to: obj(b, "to_nodes") as GraphNodeSet,
          ...(str(b, "direction") !== undefined ? { direction: str(b, "direction") as Direction } : {}),
          ...(strings(b, "edges") ? { edges: strings(b, "edges")! } : {}),
          ...(max !== undefined ? { maxDepth: max } : {}),
        }),
      };
    },

    // --- history, journal, change feed ---
    list_migrations: async (b) => {
      const limit = optInt(b, "limit");
      const op = str(b, "op");
      const table = str(b, "table");
      const since = str(b, "since");
      return {
        status: 200,
        json: await listMigrations(app, s(), { ...(limit !== undefined ? { limit } : {}), ...(op ? { op } : {}), ...(table ? { table } : {}), ...(since ? { since } : {}) }),
      };
    },
    undo_migration: async (b) => {
      const { touched: _touched, ...r } = await undoOperation(app, s(), str(b, "migration_id")!);
      return { status: r.ok ? 200 : r.failed.length > 0 ? 500 : 409, json: r.ok ? r : { ...r, ...undoGuidance(r) } };
    },
    describe_history: async (b) => {
      const limit = optInt(b, "limit");
      const table = str(b, "table");
      const since = str(b, "since");
      const rest = { ...(limit !== undefined ? { limit } : {}), ...(since !== undefined ? { since } : {}) };
      // without a table: the history of the whole database
      const h = table === undefined ? await describeDatabaseHistory(app, s(), rest) : await describeHistory(app, s(), { table, ...rest });
      return { status: 200, json: { ...h, history: h.history.map(wireCommit) } };
    },
    table_changes: async (b) => {
      const start = optInt(b, "start_version")!;
      const end = optInt(b, "end_version");
      return { status: 200, json: await tableChanges(app, s(), { table: str(b, "table")!, startVersion: start, ...(end !== undefined ? { endVersion: end } : {}) }) };
    },
    restore_table: async (b) => {
      const at = asOf(b);
      if (at.version === undefined && at.timestamp === undefined) throw new BadRequest(`pass "version" or "timestamp"`);
      return opResponse(await restoreTable(app, s(), { table: str(b, "table")!, ...at }, runOpts(b)));
    },
    restore_database: async (b) => {
      const timestamp = str(b, "timestamp");
      const before = str(b, "before_migration");
      if ((timestamp === undefined) === (before === undefined)) throw new BadRequest(`pass "timestamp" or "before_migration" (one of them)`);
      return opResponse(await restoreDatabase(app, s(), { ...(timestamp !== undefined ? { timestamp } : { beforeMigration: before! }) }, runOpts(b)));
    },
    vacuum_table: async (b) => {
      const retain = optInt(b, "retain_from_version");
      runOpts(b);
      // vacuum deletes history for good: a dry run unless the caller says dry_run: false
      return { status: 200, json: await vacuumTable(app, s(), { table: str(b, "table")!, ...(retain !== undefined ? { retainFrom: retain } : {}) }, { dryRun: b.dry_run !== false }) };
    },
    list_changes: async (b) => {
      const since = optInt(b, "since");
      const limit = optInt(b, "limit");
      const waitMs = optInt(b, "wait_ms");
      const kinds = kindsArg(b);
      return feedCall(async () =>
        wirePage(await pub.changes({
          ...(since !== undefined ? { since } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(waitMs !== undefined ? { waitMs } : {}),
          ...(strings(b, "tables") ? { tables: strings(b, "tables")! } : {}),
          ...(kinds ? { ops: kinds as never } : {}),
          ...(strings(b, "columns") ? { columns: strings(b, "columns")! } : {}),
          ...(str(b, "exclude_actor") !== undefined ? { excludeActor: str(b, "exclude_actor")! } : {}),
          ...(obj(b, "where") ? { where: obj(b, "where")! } : {}),
        })),
      );
    },
    list_webhooks: async () => feedCall(() => ({ webhooks: pub.listWebhooks() })),
    create_webhook: async (b) => {
      const kinds = kindsArg(b);
      const since = optInt(b, "since");
      return feedCall(() =>
        pub.createWebhook({
          url: str(b, "url")!,
          ...(strings(b, "tables") ? { tables: strings(b, "tables")! } : {}),
          ...(kinds ? { ops: kinds as never } : {}),
          ...(strings(b, "columns") ? { columns: strings(b, "columns")! } : {}),
          ...(str(b, "exclude_actor") !== undefined ? { excludeActor: str(b, "exclude_actor")! } : {}),
          ...(obj(b, "where") ? { where: obj(b, "where")! } : {}),
          ...(since !== undefined ? { since } : {}),
        }),
      );
    },
    delete_webhook: async (b) => {
      const id = str(b, "id")!;
      const r = await pub.deleteWebhook(id);
      if (!r.deleted) throw new BadRequest(`no webhook ${id}`, guide("list_webhooks lists the webhooks and their ids.", "webhooks"));
      return { status: 200, json: r };
    },
  };

  const handlers: Record<string, Handler> = {};
  const { scheduler } = options;
  const scope = options.scope ?? (() => currentActor()?.auth ?? "");
  for (const [name, h] of Object.entries(ops)) {
    const writes = !READ_OPERATIONS.has(name);
    // Every request first waits for the host to index the changes made on disk before it (vault-settle.ts):
    // it reads them, and the transaction log records them before its own commit.
    handlers[operationRoute(name)] = (body) =>
      // the operation's span: what it is and what it did, in the conventions of database spans
      withSpan(`engine.op ${name}`, { operation: true, attributes: operationAttributes(name, body) }, async (span) => {
        // when it arrived: a comparison of the disk started later (while it waited) covers it too
        const arrived = performance.now();
        checkArgs(name, body);
        const cls = operationClass(name, body);
        const cache = cls === "read" ? (options.cache?.() ?? null) : null;
        // write priority (scheduler.ts): a read waits while writes run or wait, a cached answer too
        const waits = scheduler?.wouldWait(cls) ?? false;
        const slot = scheduler ? await (waits ? phase("engine.schedule.wait", () => scheduler.acquire(cls, name), { "datanotes.schedule.class": cls }) : scheduler.acquire(cls, name)) : null;
        try {
          if (slot) {
            span.setAttribute("datanotes.schedule.class", cls);
            if (slot.wait.waitedMs > 0) span.setAttributes({ "datanotes.schedule.wait_ms": Math.round(slot.wait.waitedMs * 100) / 100, "datanotes.schedule.writes_ahead": slot.wait.writesAhead, "datanotes.schedule.released": slot.wait.released });
          }
          await phase("engine.settle", () => settleVault(app, arrived));
          // the read cache (read-cache.ts), once the vault is settled
          const ticket = cache ? await cache.ticket(name, body, scope()) : null;
          if (ticket && cache) {
            const hit = cache.get(ticket);
            if (hit) return cachedAnswer(span, hit);
          }
          if (ticket) span.setAttribute("datanotes.read_cache", "miss");
          const boundary = writes ? options.cache?.() : null;
          boundary?.writeBoundary();
          // a write that another write overtook while it was being checked runs again (write-check.ts);
          // a read applies nothing, so it is never stale: its answer is not searched for the conflict
          let attempts = 0;
          let res: HandlerResponse;
          try {
            res = !writes
              ? await h(body)
              : await runWrite(app, () => {
                  if (attempts++ > 0) span.addEvent("stale write: checked and run again", { attempt: attempts });
                  return h(body);
                }, (r) => holdsStaleWrite(r.json));
          } finally {
            boundary?.writeBoundary();
          }
          resultAttributes(span, res);
          if (ticket && cache && res.status === 200) {
            const j = (res.json ?? {}) as Record<string, unknown>;
            const answer: CachedAnswer = {
              status: res.status,
              body: JSON.stringify(res.json),
              ...(Array.isArray(j.rows) ? { returnedRows: j.rows.length } : {}),
              ...(typeof j.total === "number" ? { total: j.total } : {}),
            };
            if (!cache.set(ticket, answer)) span.setAttribute("datanotes.read_cache", "not_kept");
            res = { ...res, body: answer.body };
          }
          return res;
        } finally {
          slot?.release();
        }
      });
  }
  return handlers;
}

/** The answer of a read from the read cache: its JSON text as kept, parsed only for a caller in process. */
function cachedAnswer(span: Span, hit: CachedAnswer): HandlerResponse {
  span.setAttributes({ "datanotes.read_cache": "hit", "db.response.returned_rows": hit.returnedRows, "datanotes.rows_total": hit.total });
  let parsed: unknown;
  let done = false;
  return {
    status: hit.status,
    body: hit.body,
    get json(): unknown {
      if (!done) {
        parsed = JSON.parse(hit.body);
        done = true;
      }
      return parsed;
    },
  };
}

/** What an operation span says before it runs: the operation, its table or view, its options. */
export function operationAttributes(name: string, body: Body): Record<string, AttrValue> {
  const collection = typeof body.table === "string" ? body.table : typeof body.view === "string" ? body.view : undefined;
  const parts = collection && !collection.includes(":") ? collection.split(".") : [];
  return {
    "db.system": "datanotes",
    "db.system.name": "datanotes",
    "db.operation.name": name,
    "db.collection.name": collection,
    "db.namespace": parts.length === 3 ? `${parts[0]}.${parts[1]}` : undefined,
    "db.query.summary": collection ? `${name} ${collection}` : name,
    "datanotes.dry_run": typeof body.dry_run === "boolean" ? body.dry_run : undefined,
    "datanotes.long_poll": name === "list_changes" && typeof body.wait_ms === "number" && body.wait_ms > 0 ? true : undefined,
  };
}

/** What an operation span says after it ran: rows, notes, the journal entry, the refusal. */
export function resultAttributes(span: Span, res: HandlerResponse): void {
  const j = (res.json !== null && typeof res.json === "object" && !Array.isArray(res.json) ? res.json : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  span.setAttributes({
    "db.response.returned_rows": Array.isArray(j.rows) ? j.rows.length : Array.isArray(j.events) ? j.events.length : undefined,
    "datanotes.rows_total": num(j.total),
    "datanotes.notes_changed": num(j.notes_changed),
    "datanotes.files_created": num(j.files_created),
    "datanotes.migration_id": typeof j.migration_id === "string" ? j.migration_id : undefined,
    "datanotes.violating_rows": Array.isArray(j.violations) && j.violations.length > 0 ? j.violations.length : undefined,
    "datanotes.conflicts": Array.isArray(j.conflicts) && j.conflicts.length > 0 ? j.conflicts.length : undefined,
  });
  if (res.status >= 400) span.setAttribute("db.response.status_code", String(res.status));
  // a refusal is the caller's to fix (status unset); a write that failed is an error
  if (res.status >= 500) span.setStatus("error", `HTTP ${res.status}`).setAttribute("error.type", typeof j.error === "string" ? "failed" : String(res.status));
  else if (j.ok === false || res.status >= 400) span.setAttribute("error.type", Array.isArray(j.violations) && j.violations.length > 0 ? "violation" : "refused");
}

/** Run one handler with error mapping and one telemetry record per request. */
export async function dispatch(route: string, handler: Handler, body: unknown, now: () => number = Date.now): Promise<HandlerResponse> {
  const start = now();
  let res: HandlerResponse;
  try {
    if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) {
      throw new BadRequest("request body must be a JSON object");
    }
    // a long poll waits for changes by design: its request is marked, so latency figures can leave it out
    const waitMs = (body as Body | undefined)?.wait_ms;
    if (operationOf(route) === "list_changes" && typeof waitMs === "number" && waitMs > 0) activeSpan().setAttribute("datanotes.long_poll", true);
    res = await handler((body ?? {}) as Body);
  } catch (e) {
    res = errorResponse(e, operationOf(route), route);
  }
  // Services poll the change feed every few seconds: empty answers are not worth a log line, nor a trace.
  if (operationOf(route) === "list_changes" && res.status === 200 && (res.json as { events?: unknown[] }).events?.length === 0) {
    discardTrace();
    return res;
  }
  // while the request's span is exported, it says what this record says: the record goes to DEBUG
  telemetry().log(res.status >= 500 ? "ERROR" : res.status >= 400 ? "WARN" : activeSpan().recording ? "DEBUG" : "INFO", "datanotes http", {
    "http.route": `${ROUTE_PREFIX}${route}`,
    "http.response.status_code": res.status,
    duration_ms: now() - start,
  });
  return res;
}
