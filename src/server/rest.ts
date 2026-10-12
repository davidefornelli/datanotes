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
import { telemetry } from "../core/telemetry";
import { createPublicApi, describeTable, listTablesAndViews, type DatanotesPublicApi } from "../core/public-api";
import { inferTable } from "../core/infer";
import { runBatch } from "../core/batch";
import { EmbeddingError } from "../core/embeddings";
import type { SemanticIndex } from "../core/semantic";
import { opOfKind, wirePage } from "../core/change-feed";
import { listFolder, readNote, searchNotes, VaultPathError, VaultPathNotFoundError } from "../core/vault-read";
import { messageOf } from "../core/message";
import { didYouMean, guide, GuidedError, guidanceOf, refusalGuidance, undoGuidance, type Guidance } from "../core/hints";
import { argumentsOf, checkArguments, toolDocs } from "../api/guidance";
import { operationRoute } from "../api/requests";

export interface HandlerResponse {
  status: number;
  json: unknown;
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
  "Named tokens read everything; writes need a matching \"write\" pattern, schema changes \"ddl\": true, maintenance \"maintain\": true. Ask the owner to update the token (tokens/update/), or use a token that has the permission.",
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
    return guide(`The token routes take {"name"} and, to create or update one, "description" (text), "write" (table patterns), "ddl" and "maintain" (true or false), "autolink" (true or false: the default of its writes for automatic links).`, "manageTokens");
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
  const timestamp = str(body, "timestamp", false);
  return { ...(version !== undefined ? { version } : {}), ...(timestamp !== undefined ? { timestamp } : {}) };
}

function str(body: Body, key: string, required = true): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw new BadRequest(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.trim() === "") throw new BadRequest(`"${key}" must be a non-empty string`);
  return v;
}

/** An optional string where "" means something (a flat `partition`, the vault root). */
function text(body: Body, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new BadRequest(`"${key}" must be a string`);
  return v;
}

function obj(body: Body, key: string, required = true): Record<string, unknown> | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw new BadRequest(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== "object" || Array.isArray(v)) throw new BadRequest(`"${key}" must be an object`);
  return v as Record<string, unknown>;
}

function list(body: Body, key: string): unknown[] | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new BadRequest(`"${key}" must be a list`);
  return v;
}

function strings(body: Body, key: string): string[] | undefined {
  const v = list(body, key);
  if (v === undefined) return undefined;
  if (!v.every((x) => typeof x === "string")) throw new BadRequest(`"${key}" must be a list of strings`);
  return v as string[];
}

/** An optional true or false; null is not given. */
function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new BadRequest(`"${key}" must be true or false`);
  return v;
}

/** An optional value among `allowed`. */
function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T | undefined {
  const v = str(body, key, false);
  if (v !== undefined && !(allowed as readonly string[]).includes(v)) throw new BadRequest(`"${key}" must be ${allowed.map((a) => `"${a}"`).join(", ")}`);
  return v as T | undefined;
}

/** The rows a bulk write changes: required, so that every row is never meant by mistake ({} is every row). */
function whereArg(body: Body): Record<string, unknown> {
  const w = obj(body, "where", false);
  if (!w) throw new BadRequest(`"where" is required: the condition of the rows to change, or {} for every row`, guide(`Pass "where", e.g. {"status": "done"}; {} changes every row of the table.`, "filters"));
  return w;
}

/** A write's `autolink` (automatic links in the text it writes), when given. */
function autolinkArg(body: Body): { autolink?: boolean } {
  const v = optBool(body, "autolink");
  return v === undefined ? {} : { autolink: v };
}

function runOpts(body: Body): RunOptions {
  if (body.dry_run !== undefined && body.dry_run !== null && typeof body.dry_run !== "boolean") {
    throw new BadRequest(`"dry_run" must be true or false`);
  }
  return { dryRun: body.dry_run === true };
}

/** The kinds of change of the change feed (its filters `kinds`). */
const CHANGE_KINDS = ["insert", "update", "delete", "move", "metastore", "tool_call", "unreadable"] as const;

function kindsArg(body: Body): string[] | undefined {
  const kinds = strings(body, "kinds");
  if (kinds && kinds.some((k) => !(CHANGE_KINDS as readonly string[]).includes(k))) throw new BadRequest(`"kinds" must be among ${CHANGE_KINDS.join(", ")}`);
  return kinds?.map(opOfKind);
}

/**
 * A write's answer: refused or failed ones say how to fix them (`hint`, `docs`). The status tells
 * a client what to do: 422, refused (change the data); 503, failed partway and rolled back, nothing
 * written (send it again later); 500, failed and not rolled back (undo_migration first).
 */
function opResponse(r: OpResult): HandlerResponse {
  if (r.ok) return { status: 200, json: r };
  return { status: writeStatus(r.failed.length > 0, r.rolled_back), json: { ...r, ...refusalGuidance(r) } };
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
  if (e instanceof Forbidden) return { status: 403, json: body(FORBIDDEN_HINT) };
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
): Record<string, Handler> {
  const s = getSettings;
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
      const table = str(b, "table", false);
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
        ...(str(b, "table", false) !== undefined ? { table: str(b, "table")! } : {}),
        ...(str(b, "name", false) !== undefined ? { name: str(b, "name")! } : {}),
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
        const v = str(b, k, false);
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
      return opResponse(
        await createTable(
          app,
          s(),
          {
            ...(str(b, "name", false) !== undefined ? { name: str(b, "name")! } : {}),
            // null (as infer_table's proposal has it) or "" is refused by the engine with the other missing descriptions
            ...(b.description === null ? { description: null } : text(b, "description") !== undefined ? { description: text(b, "description")! } : {}),
            ...(str(b, "schema", false) !== undefined ? { schema: str(b, "schema")! } : {}),
            ...(str(b, "catalog", false) !== undefined ? { catalog: str(b, "catalog")! } : {}),
            ...(str(b, "time_column", false) !== undefined ? { timeColumn: str(b, "time_column")! } : {}),
            ...(Object.keys(options).length > 0 ? { options: options as never } : {}),
            ...(history !== undefined ? { history } : {}),
            ...(obj(b, "fields", false) ? { fields: obj(b, "fields")! } : {}),
            columns: (list(b, "columns") ?? []) as never,
            ...(template !== undefined ? { rowTemplate: template } : {}),
            ...(obj(b, "tags", false) ? { tags: obj(b, "tags") as Record<string, string> } : {}),
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
      const optStr = (k: string) => (str(b, k, false) !== undefined ? { [k]: str(b, k)! } : {});
      const history = b.history;
      if (history !== undefined && history !== null && history !== "default" && typeof history !== "boolean") {
        throw new BadRequest(`"history" must be true, false or "default", not ${JSON.stringify(history)}`, guide(`Pass history: true (keep the table's versions), false, or "default" (the database's setting).`, "history"));
      }
      const target = b.autolink_target;
      if (target !== undefined && target !== null && target !== "default" && typeof target !== "boolean") {
        throw new BadRequest(
          `"autolink_target" must be true, false or "default", not ${JSON.stringify(target)}`,
          guide(`Pass autolink_target: true (automatic links may link the table's rows), false (never) or "default" (yes, unless its rows are named by a date or a time).`, "autolinkTargets"),
        );
      }
      const description = text(b, "description");
      const template = text(b, "row_template");
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
            ...(obj(b, "tags", false) ? { tags: obj(b, "tags") as Record<string, string | null> } : {}),
            ...(optBool(b, "clear_tags") === true ? { clearTags: true } : {}),
            ...(archive !== undefined ? { archive } : {}),
            ...(obj(b, "fields", false) ? { fields: obj(b, "fields")! } : {}),
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
      const description = text(b, "description");
      if (description === undefined) throw new BadRequest(`"description" is required ("" removes it)`);
      return opResponse(
        await commentOn(app, s(), { catalog: str(b, "catalog")!, ...(str(b, "schema", false) !== undefined ? { schema: str(b, "schema")! } : {}), description }, runOpts(b)),
      );
    },
    define_base: async (b) => {
      const rename = obj(b, "rename_columns", false);
      return opResponse(
        await defineBase(
          app,
          s(),
          {
            name: str(b, "name")!,
            columns: (list(b, "columns") ?? []) as Record<string, unknown>[],
            ...(strings(b, "bases") ? { bases: strings(b, "bases")! } : {}),
            ...(str(b, "description", false) !== undefined ? { description: str(b, "description")! } : {}),
            ...(rename ? { renameColumns: rename as Record<string, string> } : {}),
            ...(strings(b, "drop_columns") ? { dropColumns: strings(b, "drop_columns")! } : {}),
          },
          runOpts(b),
        ),
      );
    },
    set_table_bases: async (b) => opResponse(await setTableBases(app, s(), { table: str(b, "table")!, bases: strings(b, "bases") ?? [] }, runOpts(b))),
    add_constraint: async (b) => opResponse(await addConstraint(app, s(), { table: str(b, "table")!, name: str(b, "name")!, check: obj(b, "check")! }, runOpts(b))),
    drop_constraint: async (b) => opResponse(await dropConstraint(app, s(), { table: str(b, "table")!, name: str(b, "name")! }, runOpts(b))),
    create_view: async (b) =>
      opResponse(
        await createView(
          app,
          s(),
          {
            name: str(b, "name")!,
            ...(str(b, "catalog", false) !== undefined ? { catalog: str(b, "catalog")! } : {}),
            ...(str(b, "schema", false) !== undefined ? { schema: str(b, "schema")! } : {}),
            ...(str(b, "description", false) !== undefined ? { description: str(b, "description")! } : {}),
            ...(strings(b, "aliases") ? { aliases: strings(b, "aliases")! } : {}),
            ...(obj(b, "labels", false) ? { labels: obj(b, "labels", false) as Record<string, string> } : {}),
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
            ...(str(b, "path", false) !== undefined ? { path: str(b, "path")! } : {}),
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
            ...(str(b, "id", false) !== undefined ? { id: str(b, "id")! } : {}),
            ...(str(b, "path", false) !== undefined ? { path: str(b, "path")! } : {}),
            ...(obj(b, "set", false) ? { set: obj(b, "set")! } : {}),
            ...(strings(b, "unset") ? { unset: strings(b, "unset")! } : {}),
            ...(text(b, "body") !== undefined ? { body: text(b, "body")! } : {}),
            ...(obj(b, "body_sections", false) ? { bodySections: obj(b, "body_sections") as Record<string, string> } : {}),
            ...(text(b, "body_prepend") !== undefined ? { bodyPrepend: text(b, "body_prepend")! } : {}),
            ...(text(b, "body_append") !== undefined ? { bodyAppend: text(b, "body_append")! } : {}),
            ...(obj(b, "expect", false) ? { expect: obj(b, "expect")! } : {}),
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
            where: whereArg(b),
            ...(obj(b, "set", false) ? { set: obj(b, "set")! } : {}),
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
        await deleteRows(app, s(), { table: str(b, "table")!, where: whereArg(b), ...(mode ? { mode } : {}), ...(policy ? { onReferenced: policy } : {}) }, runOpts(b)),
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
            on: strings(b, "on") ?? [],
            rows: (list(b, "rows") ?? []) as Record<string, unknown>[],
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
            where: whereArg(b),
            ...(obj(b, "rename", false) ? { rename: obj(b, "rename") as Record<string, string> } : {}),
            ...(obj(b, "set", false) ? { set: obj(b, "set")! } : {}),
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
            paths: strings(b, "paths") ?? [],
            ...(obj(b, "rename", false) ? { rename: obj(b, "rename") as Record<string, string> } : {}),
            ...(obj(b, "set", false) ? { set: obj(b, "set")! } : {}),
            ...(obj(b, "per_row", false) ? { perRow: obj(b, "per_row") as Record<string, Record<string, unknown>> } : {}),
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
      const operations = list(b, "operations");
      if (!operations || operations.length === 0) throw new BadRequest(`"operations" must be a non-empty list`);
      const steps = operations.map((raw, i) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequest(`operation ${i} must be an object`);
        const { op, ...args } = raw as Body;
        if (typeof op !== "string") throw new BadRequest(`operation ${i} needs "op"`);
        if (!isBatchOperation(op)) {
          throw new BadRequest(
            `operation ${i}: "op" must be one of ${BATCH_OPERATIONS.join(", ")}`,
            guide(`${didYouMean(op, BATCH_OPERATIONS)} A batch holds writes: each operation is {"op": "<name>", ...its arguments}.`.trim(), "batch"),
          );
        }
        try {
          checkArgs(op, args);
        } catch (e) {
          throw new BadRequest(`operation ${i}: ${messageOf(e)}`, guidanceOf(e) ?? undefined);
        }
        return {
          op,
          run: async (dryRun: boolean): Promise<OpResult> => {
            // an error is answered as the operation answers it: its message, with its guidance
            const res = await ops[op]!({ ...args, dry_run: dryRun }).catch((e: unknown) => errorResponse(e, op));
            // a write's result (done, refused, failed) has its "op"; an error is the step's error
            if ("op" in (res.json as object)) return res.json as OpResult;
            throw stepFailure(res.json);
          },
        };
      });
      const r = await runBatch(app, s(), steps, (id) => undoOperation(app, s(), id), {
        ...runOpts(b),
        ...(str(b, "summary", false) !== undefined ? { summary: str(b, "summary")! } : {}),
      });
      // a step that failed partway (not refused) makes the batch a failure: 503 once all is rolled back
      const failedStep = r.failed_at !== undefined && (r.steps[r.failed_at]?.result?.failed.length ?? 0) > 0;
      const status = r.ok ? 200 : r.rolled_back === false ? 500 : writeStatus(failedStep, true);
      return { status, json: r.ok ? r : { ...r, ...batchGuidance(r) } };
    },

    // --- queries ---
    select_rows: async (b) => {
      const groupBy = b.group_by;
      if (groupBy !== undefined && groupBy !== null && typeof groupBy !== "string" && !Array.isArray(groupBy)) {
        throw new BadRequest(`"group_by" must be a string or a list of strings`);
      }
      const orderBy = b.order_by;
      if (orderBy !== undefined && orderBy !== null && typeof orderBy !== "string" && !Array.isArray(orderBy)) {
        throw new BadRequest(`"order_by" must be a string or a list of strings`);
      }
      const limit = optInt(b, "limit");
      const offset = optInt(b, "offset");
      const join = obj(b, "join", false);
      const aggregates = obj(b, "aggregates", false);
      return {
        status: 200,
        json: await select(app, s(), {
          table: str(b, "table")!,
          ...(strings(b, "columns") ? { columns: strings(b, "columns")! } : {}),
          ...(obj(b, "where", false) ? { where: obj(b, "where")! } : {}),
          ...(orderBy !== undefined && orderBy !== null ? { orderBy: orderBy as string | string[] } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(strings(b, "expand") ? { expand: strings(b, "expand")! } : {}),
          ...(join ? { join: join as never } : {}),
          ...(groupBy !== undefined && groupBy !== null ? { groupBy: groupBy as string | string[] } : {}),
          ...(aggregates ? { aggregates: aggregates as Record<string, string> } : {}),
          ...(optBool(b, "include_body") === true ? { includeBody: true } : {}),
          ...(str(b, "this_note", false) !== undefined ? { thisNote: str(b, "this_note")! } : {}),
          ...asOf(b),
        }),
      };
    },
    list_link_targets: async (b) => {
      const limit = optInt(b, "limit");
      const row = str(b, "row", false);
      const values = obj(b, "values", false);
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
    read_note: async (b) => ({ status: 200, json: await readNote(app, s(), text(b, "path") ?? "") }),
    list_folder: async (b) => ({ status: 200, json: listFolder(app, text(b, "folder") ?? "") }),
    search_notes: async (b) => {
      const ctx = optInt(b, "context_length");
      return { status: 200, json: await searchNotes(app, str(b, "query")!, ctx ?? 100) };
    },
    semantic_search: async (b) => {
      const sem = needSemantic();
      const limit = optInt(b, "limit");
      const minScore = b.min_score;
      if (minScore !== undefined && minScore !== null && typeof minScore !== "number") throw new BadRequest(`"min_score" must be a number`);
      return {
        status: 200,
        json: await sem.search({
          query: str(b, "query")!,
          ...(limit !== undefined ? { limit } : {}),
          ...(strings(b, "tables") ? { tables: strings(b, "tables")! } : {}),
          ...(str(b, "folder", false) !== undefined ? { folder: str(b, "folder")! } : {}),
          ...(typeof minScore === "number" ? { minScore } : {}),
        }),
      };
    },
    graph_neighbors: async (b) => ({
      status: 200,
      json: await graphNeighbors(app, s(), {
        from: obj(b, "from_nodes") as GraphNodeSet,
        ...(str(b, "direction", false) !== undefined ? { direction: str(b, "direction") as Direction } : {}),
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
          ...(str(b, "direction", false) !== undefined ? { direction: str(b, "direction") as Direction } : {}),
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
          ...(str(b, "direction", false) !== undefined ? { direction: str(b, "direction") as Direction } : {}),
          ...(strings(b, "edges") ? { edges: strings(b, "edges")! } : {}),
          ...(max !== undefined ? { maxDepth: max } : {}),
        }),
      };
    },

    // --- history, journal, change feed ---
    list_migrations: async (b) => {
      const limit = optInt(b, "limit");
      const op = str(b, "op", false);
      const table = str(b, "table", false);
      const since = str(b, "since", false);
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
      const table = str(b, "table", false);
      const since = str(b, "since", false);
      const rest = { ...(limit !== undefined ? { limit } : {}), ...(since !== undefined ? { since } : {}) };
      // without a table: the history of the whole database
      const h = table === undefined ? await describeDatabaseHistory(app, s(), rest) : await describeHistory(app, s(), { table, ...rest });
      return { status: 200, json: { ...h, history: h.history.map(wireCommit) } };
    },
    table_changes: async (b) => {
      const start = optInt(b, "start_version");
      if (start === undefined) throw new BadRequest(`"start_version" is required`);
      const end = optInt(b, "end_version");
      return { status: 200, json: await tableChanges(app, s(), { table: str(b, "table")!, startVersion: start, ...(end !== undefined ? { endVersion: end } : {}) }) };
    },
    restore_table: async (b) => {
      const at = asOf(b);
      if (at.version === undefined && at.timestamp === undefined) throw new BadRequest(`pass "version" or "timestamp"`);
      return opResponse(await restoreTable(app, s(), { table: str(b, "table")!, ...at }, runOpts(b)));
    },
    restore_database: async (b) => {
      const timestamp = str(b, "timestamp", false);
      const before = str(b, "before_migration", false);
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
          ...(str(b, "exclude_actor", false) !== undefined ? { excludeActor: str(b, "exclude_actor")! } : {}),
          ...(obj(b, "where", false) ? { where: obj(b, "where")! } : {}),
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
          ...(str(b, "exclude_actor", false) !== undefined ? { excludeActor: str(b, "exclude_actor")! } : {}),
          ...(obj(b, "where", false) ? { where: obj(b, "where")! } : {}),
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
  for (const [name, h] of Object.entries(ops)) {
    // Every request first waits for the host to index the changes made on disk before it (vault-settle.ts):
    // it reads them, and the transaction log records them before its own commit.
    handlers[operationRoute(name)] = async (body) => {
      checkArgs(name, body);
      await settleVault(app);
      // a write that another write overtook while it was being checked runs again (write-check.ts)
      return runWrite(app, () => h(body), (res) => holdsStaleWrite(res.json));
    };
  }
  return handlers;
}

/** Run one handler with error mapping and one telemetry record per request. */
export async function dispatch(route: string, handler: Handler, body: unknown, now: () => number = Date.now): Promise<HandlerResponse> {
  const start = now();
  let res: HandlerResponse;
  try {
    if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) {
      throw new BadRequest("request body must be a JSON object");
    }
    res = await handler((body ?? {}) as Body);
  } catch (e) {
    res = errorResponse(e, operationOf(route), route);
  }
  // Services poll the change feed every few seconds: empty answers are not worth a log line.
  if (operationOf(route) === "list_changes" && res.status === 200 && (res.json as { events?: unknown[] }).events?.length === 0) return res;
  telemetry().log(res.status >= 500 ? "ERROR" : res.status >= 400 ? "WARN" : "INFO", "datanotes http", {
    "http.route": `${ROUTE_PREFIX}${route}`,
    "http.response.status_code": res.status,
    duration_ms: now() - start,
  });
  return res;
}
