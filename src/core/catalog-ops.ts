/**
 * Metastore features beyond plain tables:
 * CHECK constraints (`add_constraint` / `drop_constraint`), views stored in `metastore.yaml`,
 * catalog and schema comments (`comment_on`), the read-only `system.information_schema` and
 * `clone_table`.
 */

import type { App, TFile } from "./host";
import { emptyChangeSet, type ChangeSet } from "./changeset";
import { readDatabaseConfig } from "./database";
import { resolveDefault } from "./datetime";
import { latestVersion } from "./transaction-log";
import {
  catalogLoadedTable,
  checkColumnRefs,
  filtersReading,
  emptyResult,
  finish,
  withSystemIdColumn,
  instrumented,
  loadRows,
  loadTable,
  OperationInputError,
  refused,
  type LoadedRow,
  type LoadedRowWithBody,
  type LoadedTable,
  type OpConflict,
  type OpResult,
  type RowViolations,
  type RunOptions,
} from "./engine";
import { buildMarkdownWithFrontmatter, fmGet, fmSet } from "./frontmatter";
import { loadTableAsOf, type HistoricalTable } from "./history";
import {
  baseChain,
  columnToEntry,
  catalogTables,
  effectiveColumns,
  entryToOrdered,
  inheritedColumns,
  setBaseEntry,
  type BaseEntry,
  catalogViews,
  loadMetastore,
  metastorePath,
  parseMetastore,
  refOf,
  resolveCatalogRef,
  setCatalogComment,
  setTableEntries,
  setTableEntry,
  setViewEntry,
  SYSTEM_CATALOG,
  tableTags,
  type CatalogRef,
  type CatalogTableEntry,
  type Metastore,
  type ViewEntry,
} from "./metastore";
import { hasThisTokens, resolveThisTokens } from "./this-tokens";
import { catalogRowFilesOf } from "./row-files";
import type { DatanotesSettings } from "./settings";
import { CheckLinks } from "./check-links";
import { linkedCheckViolations, metastoreLeftBy } from "./changeset-checks";
import { fillIdentities } from "./computed-columns";
import { claimFreeName, renderPathTemplate } from "./path-templates";
import { select, type SelectInput } from "./select";
import { compileCheck, hasLogical, type Where } from "./where";
import { linkTargetOf, mapWhere, modelColumns, rewrittenEntries } from "./link-paths";
import { validateRow } from "./validate";
import { validationContextFor } from "./table-registry";
import { parseColumn } from "./table-loader";
import { catalogLayout, parseTableOptions } from "./table-loader";
import { SYSTEM_ID_COLUMN, TABLE_KEY } from "./types-table";
import { uuidv7 } from "./uuid";
import { tableNotFound } from "./table-registry";
import type { OrderedFrontmatter } from "./types";
import { messageOf } from "./message";
import { guide, identifierHint, unknownName } from "./hints";
import { cloneTableRefusal, defineBaseRefusal, descriptionOf, engineDescription, hasText, missingDescriptions, withEngineDescription, type MissingDescriptions } from "./descriptions";
import { normalizeDatabaseFolder } from "./db-paths";

const VIEW_HINT = guide(`A view's query is a select_rows call: {"table": "film", "where": {"status": "to watch"}, "order_by": "title"}, or {"union": [{"table": "a"}, {"table": "b"}]}.`, "views");

const IDENT = /^[a-z][a-z0-9_]*$/;

function ident(kind: string, value: string): string {
  if (!IDENT.test(value)) throw new OperationInputError(`${kind} "${value}" must be lowercase letters, digits and _ (starting with a letter)`, identifierHint(kind, value));
  if (kind === "catalog" && value === SYSTEM_CATALOG) throw new OperationInputError(`"${SYSTEM_CATALOG}" is a reserved catalog`, guide(`Choose another catalog name: "${SYSTEM_CATALOG}" holds information_schema.`, "catalogs"));
  return value;
}

async function metastoreOrEmpty(app: App, settings: DatanotesSettings) {
  const ms = await loadMetastore(app, settings);
  return { text: ms?.text ?? "", model: ms?.model ?? parseMetastore(""), ms };
}

function requireCatalog(t: LoadedTable, _what: string): LoadedTable["catalog"] {
  return t.catalog;
}

/** A new object name: 3 parts exact, 2 parts in the default catalog, 1 part in the default schema too. */
async function newRef(
  app: App,
  settings: DatanotesSettings,
  input: { catalog?: string; schema?: string; name: string },
  fallback?: { catalog: string; schema: string },
): Promise<CatalogRef> {
  const cfg = await readDatabaseConfig(app, settings);
  const parts = input.name.split(".");
  if (parts.length === 3) return refOf(ident("catalog", parts[0]!), ident("schema", parts[1]!), ident("table", parts[2]!));
  if (parts.length === 2) {
    return refOf(ident("catalog", input.catalog ?? fallback?.catalog ?? cfg.default_catalog), ident("schema", parts[0]!), ident("table", parts[1]!));
  }
  return refOf(
    ident("catalog", input.catalog ?? fallback?.catalog ?? cfg.default_catalog),
    ident("schema", input.schema ?? fallback?.schema ?? cfg.default_schema),
    ident("table", input.name),
  );
}

function nameTaken(model: Metastore, ref: CatalogRef): boolean {
  const sch = model.catalogs[ref.catalog]?.schemas[ref.schema];
  return Boolean(sch?.tables[ref.table] || sch?.views[ref.table]);
}

// --- CHECK constraints ---

export interface AddConstraintInput {
  table: string;
  name: string;
  /** `where` filter every row must match, e.g. `{ "value": { "gte": 1, "lte": 5 } }`. */
  check: Where;
}

/** ALTER TABLE … ADD CONSTRAINT … CHECK: refused while existing rows violate it. */
async function addConstraintImpl(app: App, settings: DatanotesSettings, input: AddConstraintInput, opts: RunOptions = {}): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const cat = requireCatalog(t, "a CHECK constraint");
  ident("constraint", input.name);
  if (!input.check || typeof input.check !== "object" || Array.isArray(input.check) || Object.keys(input.check).length === 0) {
    throw new OperationInputError(`"check" must be a non-empty where filter`, guide(`A CHECK is a where filter every row must match, e.g. {"or": [{"status": "to watch"}, {"rating": {"exists": true}}]}.`, "check"));
  }
  if (cat.entry.constraints?.[input.name]) throw new OperationInputError(`constraint "${input.name}" already exists; drop it first`, guide(`Choose another name, or drop_constraint "${input.name}" first to replace it; describe_table lists the constraints.`, "check"));
  // the same predicate as write-time validation; unknown columns / operators fail here. Dotted keys
  // (`parent.kind`) follow links: their target rows are loaded once, before compiling.
  const links = new CheckLinks(app, settings);
  await links.prepare(t, input.check);
  const passes = compileCheck(input.check, t, settings, links);
  const conflicts: OpConflict[] = [];
  for (const r of await loadRows(app, settings, t)) {
    if (!passes(r)) conflicts.push({ path: r.file.path, message: `violates CHECK ${input.name}` });
  }
  const entry: CatalogTableEntry = { ...cat.entry, constraints: { ...(cat.entry.constraints ?? {}), [input.name]: input.check } };
  const cs = emptyChangeSet("add_constraint", `add constraint ${input.name} to ${cat.ref.full}`, t.def.schemaPath);
  cs.texts.push({ path: t.file.path, before: cat.text, after: setTableEntry(cat.text, cat.ref, entry) });
  return finish(app, settings, cs, conflicts, [], opts);
}

async function dropConstraintImpl(app: App, settings: DatanotesSettings, input: { table: string; name: string }, opts: RunOptions = {}): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const cat = requireCatalog(t, "a CHECK constraint");
  if (!cat.entry.constraints?.[input.name]) {
    throw new OperationInputError(`${cat.ref.full} has no constraint "${input.name}"`, unknownName(input.name, Object.keys(cat.entry.constraints ?? {}), `constraints of ${cat.ref.full}`, "describe_table lists them.", "check"));
  }
  const { [input.name]: _gone, ...rest } = cat.entry.constraints;
  const { constraints: _c, ...base } = cat.entry;
  const entry: CatalogTableEntry = Object.keys(rest).length > 0 ? { ...base, constraints: rest } : (base as CatalogTableEntry);
  const cs = emptyChangeSet("drop_constraint", `drop constraint ${input.name} from ${cat.ref.full}`, t.def.schemaPath);
  cs.texts.push({ path: t.file.path, before: cat.text, after: setTableEntry(cat.text, cat.ref, entry) });
  return finish(app, settings, cs, [], [], opts);
}

export const addConstraint = instrumented("add_constraint", addConstraintImpl, (i) => ({ table: i.table, name: i.name }));
export const dropConstraint = instrumented("drop_constraint", dropConstraintImpl, (i) => ({ table: i.table, name: i.name }));

// --- Views ---

/** Select parameters a view may store (`table` included); callers can narrow or page the result. */
export const VIEW_QUERY_KEYS: ReadonlySet<string> = new Set(["table", "union", "columns", "where", "order_by", "limit", "join", "group_by", "aggregates", "expand"]);
/** The keys of one branch of a view's `union`. */
export const UNION_BRANCH_KEYS: readonly string[] = ["table", "columns", "where"];
/**
 * The keys a view's query may have next to `union`, applied to every branch (`columns` when a
 * branch has none, `where`, `expand`) or to the stacked rows (`order_by`, `limit`).
 */
export const UNION_QUERY_KEYS: readonly string[] = ["union", "columns", "where", "order_by", "limit", "expand"];

export interface CreateViewInput {
  name: string;
  catalog?: string;
  schema?: string;
  /** What the view shows. */
  description?: string;
  aliases?: string[];
  /** Column headings in notes (`datanotes` blocks): `{ "name": "Project" }`. */
  labels?: Record<string, string>;
  /**
   * Stored select: `{ table, columns?, where?, order_by?, limit?, join?, group_by?, aggregates?, expand? }`,
   * or a UNION ALL: `{ union: [{ table, columns?, where? }, …], columns?, order_by?, limit? }` (rows get `_source`).
   */
  query: Record<string, unknown>;
  /** CREATE OR REPLACE. */
  replace?: boolean;
}

export function viewQueryToSelect(query: Record<string, unknown>): SelectInput {
  for (const k of Object.keys(query)) {
    if (!VIEW_QUERY_KEYS.has(k)) throw new OperationInputError(`view query: unknown key "${k}" (allowed: ${[...VIEW_QUERY_KEYS].join(", ")})`, unknownName(k, [...VIEW_QUERY_KEYS], "keys of a view's query", VIEW_HINT.hint, "views"));
  }
  if (query.union !== undefined) {
    if (!Array.isArray(query.union)) throw new OperationInputError(`view query: "union" must be a list of { table, columns?, where? }`, VIEW_HINT);
    if (query.table !== undefined) throw new OperationInputError(`view query: use "table" or "union", not both`, VIEW_HINT);
    const other = Object.keys(query).filter((k) => !UNION_QUERY_KEYS.includes(k));
    if (other.length > 0) throw new OperationInputError(`view query: union does not support ${other.join(", ")} (next to union: ${UNION_QUERY_KEYS.slice(1).join(", ")})`, VIEW_HINT);
    for (const b of query.union as unknown[]) {
      const keys = b && typeof b === "object" ? Object.keys(b as object) : [];
      const bad = keys.filter((k) => !UNION_BRANCH_KEYS.includes(k));
      if (!b || typeof (b as { table?: unknown }).table !== "string" || bad.length > 0) {
        throw new OperationInputError(`view query: each union branch is { table, columns?, where? }${bad.length ? ` (unknown: ${bad.join(", ")})` : ""}`, VIEW_HINT);
      }
    }
  } else if (typeof query.table !== "string" || query.table === "") throw new OperationInputError(`view query needs "table" (or "union")`, VIEW_HINT);
  return {
    table: typeof query.table === "string" ? query.table : "",
    ...(Array.isArray(query.union) ? { union: query.union as SelectInput["union"] } : {}),
    ...(Array.isArray(query.columns) ? { columns: query.columns as string[] } : {}),
    ...(query.where ? { where: query.where as Where } : {}),
    ...(query.order_by !== undefined ? { orderBy: query.order_by as string | string[] } : {}),
    ...(typeof query.limit === "number" ? { limit: query.limit } : {}),
    ...(query.join ? { join: query.join as SelectInput["join"] } : {}),
    ...(query.group_by !== undefined ? { groupBy: query.group_by as string | string[] } : {}),
    ...(query.aggregates ? { aggregates: query.aggregates as Record<string, string> } : {}),
    ...(Array.isArray(query.expand) ? { expand: query.expand as string[] } : {}),
  };
}

async function createViewImpl(app: App, settings: DatanotesSettings, input: CreateViewInput, opts: RunOptions = {}): Promise<OpResult> {
  const ref = await newRef(app, settings, input);
  const { text, model } = await metastoreOrEmpty(app, settings);
  const sch = model.catalogs[ref.catalog]?.schemas[ref.schema];
  const conflicts: OpConflict[] = [];
  if (sch?.tables[ref.table]) conflicts.push({ path: ref.full, message: `${ref.full} is a table` });
  if (sch?.views[ref.table] && input.replace !== true) conflicts.push({ path: ref.full, message: `${ref.full} already exists (pass replace)` });
  // The query must run now (unknown tables / columns fail here). A view that reads the note showing
  // it (`{this.*}`) runs with a placeholder note: only checks that need no real values are kept.
  if (hasThisTokens(input.query)) viewQueryToSelect(input.query);
  else await select(app, settings, { ...viewQueryToSelect(input.query), limit: 1 });
  for (const [k, v] of Object.entries(input.labels ?? {})) {
    if (typeof v !== "string") throw new OperationInputError(`labels.${k} must be a string`, guide(`labels maps a column to its heading: {"title": "Film"}.`, "views"));
  }
  const view: ViewEntry = {
    ...(input.description ? { description: input.description } : {}),
    ...(input.aliases && input.aliases.length > 0 ? { aliases: input.aliases } : {}),
    ...(input.labels && Object.keys(input.labels).length > 0 ? { labels: input.labels } : {}),
    query: input.query,
  };
  const cs = emptyChangeSet("create_view", `create view ${ref.full}`, `${metastorePath(settings)}#${ref.full}`);
  cs.texts.push({ path: metastorePath(settings), before: text, after: setViewEntry(text, ref, view) });
  return finish(app, settings, cs, conflicts, [], opts);
}

async function dropViewImpl(app: App, settings: DatanotesSettings, input: { view: string }, opts: RunOptions = {}): Promise<OpResult> {
  const { text, model } = await metastoreOrEmpty(app, settings);
  const ref = resolveCatalogRef(model, input.view, "view");
  if (!ref) throw tableNotFound(input.view, model, "view");
  const cs = emptyChangeSet("drop_view", `drop view ${ref.full}`, `${metastorePath(settings)}#${ref.full}`);
  cs.texts.push({ path: metastorePath(settings), before: text, after: setViewEntry(text, ref, null) });
  return finish(app, settings, cs, [], [], opts);
}

export const createView = instrumented("create_view", createViewImpl, (i) => ({ name: i.name, catalog: i.catalog, schema: i.schema }));
export const dropView = instrumented("drop_view", dropViewImpl, (i) => ({ view: i.view }));

/**
 * A select on a view: the stored query, narrowed by the caller's `where` (same-column conditions
 * are combined), with the caller's columns / order / paging when given.
 */
export async function resolveViewSelect(app: App, settings: DatanotesSettings, input: SelectInput): Promise<{ view: string; input: SelectInput } | null> {
  const ms = await loadMetastore(app, settings);
  if (!ms) return null;
  let tableRef: CatalogRef | null = null;
  try {
    tableRef = resolveCatalogRef(ms.model, input.table);
  } catch {
    tableRef = null;
  }
  if (tableRef) return null;
  const ref = resolveCatalogRef(ms.model, input.table, "view");
  if (!ref) return null;
  const view = ms.model.catalogs[ref.catalog]!.schemas[ref.schema]!.views[ref.table]!;
  const base = viewQueryToSelect(input.host ? resolveThisTokens(view.query, input.host) : view.query);
  let where: Where = { ...(base.where ?? {}) };
  // With or / and / not on either side, the caller's filter is AND-ed as a whole.
  if (input.where && Object.keys(input.where).length > 0 && (hasLogical(base.where) || hasLogical(input.where))) {
    where = base.where && Object.keys(base.where).length > 0 ? { and: [base.where, input.where] } : { ...input.where };
  } else for (const [col, cond] of Object.entries(input.where ?? {})) {
    if (!(col in where)) {
      where[col] = cond;
      continue;
    }
    const asOps = (c: unknown) => (c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : { eq: c });
    where[col] = { ...asOps(where[col]), ...asOps(cond) };
  }
  const { table: _t, where: _w, ...rest } = input;
  const merged: SelectInput = { ...base, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
  if (Object.keys(where).length > 0) merged.where = where;
  return { view: ref.full, input: merged };
}

// --- COMMENT ON CATALOG / SCHEMA ---

export interface CommentOnInput {
  catalog: string;
  /** A schema of the catalog; omitted, the description is the catalog's. */
  schema?: string;
  /** The new description; "" (or `null`) removes it. */
  description: string | null;
}

/** COMMENT ON CATALOG / SCHEMA: the description of a catalog or of one of its schemas in `metastore.yaml`. */
async function commentOnImpl(app: App, settings: DatanotesSettings, input: CommentOnInput, opts: RunOptions = {}): Promise<OpResult> {
  if (input.description !== null && typeof input.description !== "string") throw new OperationInputError(`"description" must be a string ("" removes it)`, guide(`Pass "description" as text, or "" to remove it.`, "describe"));
  const { text, model } = await metastoreOrEmpty(app, settings);
  // Own keys only: `constructor`, `toString` or `__proto__` are not catalogs or schemas.
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  if (!own(model.catalogs, input.catalog)) {
    const names = Object.keys(model.catalogs);
    throw new OperationInputError(`unknown catalog "${input.catalog}" (catalogs: ${names.length > 0 ? names.join(", ") : "none yet"})`, unknownName(input.catalog, names, "catalogs", "describe_database lists them with their schemas.", "describe"));
  }
  const cat = model.catalogs[input.catalog]!;
  if (input.schema !== undefined && !own(cat.schemas, input.schema)) {
    const names = Object.keys(cat.schemas);
    throw new OperationInputError(
      `unknown schema "${input.schema}" in catalog ${input.catalog} (schemas: ${names.length > 0 ? names.join(", ") : "none yet"})`,
      unknownName(input.schema, names, `schemas of ${input.catalog}`, "describe_database lists them.", "describe"),
    );
  }
  const comment = typeof input.description === "string" && input.description.trim() !== "" ? input.description : null;
  // The comment it already has (or none to remove): nothing is written or journaled.
  const current = input.schema === undefined ? cat.description : cat.schemas[input.schema]!.description;
  if ((current ?? null) === comment) return { ...emptyResult("comment_on", opts.dryRun === true), ok: true };
  const target = input.schema === undefined ? input.catalog : `${input.catalog}.${input.schema}`;
  const what = `${input.schema === undefined ? "catalog" : "schema"} ${target}`;
  const after = setCatalogComment(text, input.catalog, input.schema, comment);
  const cs = emptyChangeSet("comment_on", comment === null ? `remove the comment on ${what}` : `comment on ${what}`, `${metastorePath(settings)}#${target}`);
  if (after !== text) cs.texts.push({ path: metastorePath(settings), before: text, after });
  return finish(app, settings, cs, [], [], opts);
}

export const commentOn = instrumented("comment_on", commentOnImpl, (i) => ({ catalog: i.catalog, schema: i.schema, remove: typeof i.description !== "string" || i.description.trim() === "" }));

// --- system.information_schema ---

const INFO_TABLES = ["catalogs", "schemata", "tables", "columns", "views", "check_constraints"] as const;
type InfoTable = (typeof INFO_TABLES)[number];

const INFO_COLUMNS: Record<InfoTable, [string, string][]> = {
  catalogs: [["catalog_name", "string"], ["comment", "string"], ["is_default", "boolean"]],
  schemata: [["catalog_name", "string"], ["schema_name", "string"], ["comment", "string"]],
  tables: [
    ["table_catalog", "string"], ["table_schema", "string"], ["table_name", "string"], ["full_name", "string"],
    ["table_type", "string"], ["comment", "string"], ["row_count", "integer"], ["latest_version", "integer"], ["tags", "json"],
  ],
  columns: [
    ["table_catalog", "string"], ["table_schema", "string"], ["table_name", "string"], ["column_name", "string"],
    ["ordinal_position", "integer"], ["data_type", "string"], ["is_nullable", "string"], ["column_default", "string"],
    ["comment", "string"], ["generation_expression", "string"], ["is_identity", "string"], ["is_unique", "string"],
    ["inherited_from", "string"], ["is_hierarchy", "string"],
  ],
  views: [["table_catalog", "string"], ["table_schema", "string"], ["table_name", "string"], ["view_definition", "string"], ["comment", "string"], ["aliases", "list"], ["labels", "string"]],
  check_constraints: [["table_catalog", "string"], ["table_schema", "string"], ["table_name", "string"], ["constraint_name", "string"], ["check_clause", "string"]],
};

/** `information_schema.<name>` or `system.information_schema.<name>`, else null. */
export function informationSchemaTable(ref: string): InfoTable | null {
  const parts = ref.trim().split(".");
  const rest = parts.length === 3 && parts[0] === SYSTEM_CATALOG ? parts.slice(1) : parts;
  if (rest.length !== 2 || rest[0] !== "information_schema") return null;
  if (!(INFO_TABLES as readonly string[]).includes(rest[1]!)) {
    throw new OperationInputError(`system.information_schema has: ${INFO_TABLES.join(", ")}`, unknownName(rest[1]!, INFO_TABLES, "tables of information_schema", `Read one with select_rows("information_schema.columns").`, "describe"));
  }
  return rest[1] as InfoTable;
}

function pseudoFile(path: string): TFile {
  const name = path.split("/").pop()!; // split() returns at least one element
  return { path, name, basename: name, extension: "md" } as unknown as TFile;
}

const text = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v));

async function informationRows(app: App, settings: DatanotesSettings, name: InfoTable): Promise<Record<string, unknown>[]> {
  const ms = await loadMetastore(app, settings);
  const model = ms?.model ?? parseMetastore("");
  const cfg = await readDatabaseConfig(app, settings);
  const tables = catalogTables(model);
  switch (name) {
    case "catalogs":
      return Object.entries(model.catalogs).map(([c, cat]) => ({ catalog_name: c, comment: cat.description ?? null, is_default: c === cfg.default_catalog }));
    case "schemata":
      return Object.entries(model.catalogs).flatMap(([c, cat]) =>
        Object.entries(cat.schemas).map(([s, sch]) => ({ catalog_name: c, schema_name: s, comment: sch.description ?? null })),
      );
    case "tables": {
      const out: Record<string, unknown>[] = [];
      const defs = tables.map(({ ref }) => ({ full: ref.full, def: catalogLoadedTable(settings, { file: ms!.file, text: ms!.text, model }, ref).def }));
      const rows = catalogRowFilesOf(app, settings, defs); // every table's rows in one pass over the vault
      for (const { ref, entry } of tables) {
        const latest = await latestVersion(app, settings, ref.full);
        out.push({
          table_catalog: ref.catalog, table_schema: ref.schema, table_name: ref.table, full_name: ref.full, table_type: "TABLE",
          comment: entry.description ?? null, row_count: rows.get(ref.full)!.length,
          latest_version: latest, tags: tableTags(entry) ?? null,
        });
      }
      for (const { ref, view } of catalogViews(model)) {
        out.push({
          table_catalog: ref.catalog, table_schema: ref.schema, table_name: ref.table, full_name: ref.full, table_type: "VIEW",
          comment: view.description ?? null, row_count: null, latest_version: null, tags: null,
        });
      }
      return out;
    }
    case "columns":
      return tables.flatMap(({ ref, entry }) => {
        const from = new Map(inheritedColumns(model, entry.bases as string[] | undefined, ref.full).map((x) => [String(x.column.name), x.base]));
        return effectiveColumns(model, ref, entry).map((c, i) => ({
          table_catalog: ref.catalog, table_schema: ref.schema, table_name: ref.table, column_name: c.name,
          ordinal_position: i + 1,
          data_type: c.type === "list" ? `list<${String(c.items ?? "string")}>` : c.type === "enum" ? `enum(${((c.values as string[]) ?? []).join(",")})` : c.type,
          is_nullable: c.required === true ? "NO" : "YES", column_default: text(c.default), comment: text(c.description),
          generation_expression: text(c.generated), is_identity: c.identity ? String(c.identity) : "NO", is_unique: c.unique ? "YES" : "NO",
          inherited_from: from.get(String(c.name)) ?? null, is_hierarchy: c.hierarchy ? "YES" : "NO",
        }));
      });
    case "views":
      return catalogViews(model).map(({ ref, view }) => ({
        table_catalog: ref.catalog, table_schema: ref.schema, table_name: ref.table, view_definition: JSON.stringify(view.query), comment: view.description ?? null,
        aliases: view.aliases ?? [], labels: view.labels ? JSON.stringify(view.labels) : null,
      }));
    case "check_constraints":
      return tables.flatMap(({ ref, entry }) =>
        Object.entries(entry.constraints ?? {}).map(([n, where]) => ({
          table_catalog: ref.catalog, table_schema: ref.schema, table_name: ref.table, constraint_name: n, check_clause: JSON.stringify(where),
        })),
      );
  }
}

/** An information_schema view as a read-only table the select pipeline can query. */
export async function informationSchemaTableData(app: App, settings: DatanotesSettings, name: InfoTable): Promise<HistoricalTable> {
  const ref = refOf(SYSTEM_CATALOG, "information_schema", name);
  const entry: CatalogTableEntry = { columns: INFO_COLUMNS[name].map(([n, type]) => ({ name: n, type })) };
  const model: Metastore = { config: {}, bases: {}, catalogs: { [ref.catalog]: { schemas: { [ref.schema]: { tables: { [ref.table]: entry }, views: {} } } } } };
  const t = catalogLoadedTable(settings, { file: pseudoFile(metastorePath(settings)), text: "", model }, ref);
  const rows: LoadedRowWithBody[] = (await informationRows(app, settings, name)).map((values, i) => ({
    file: pseudoFile(`${SYSTEM_CATALOG}/information_schema/${name}/${String(i + 1).padStart(5, "0")}`),
    ordered: Object.entries(values).filter(([, v]) => v !== null) as OrderedFrontmatter,
    body: "",
  }));
  return { table: t, rows, version: 0, timestamp: "" };
}

// --- clone_table ---

export interface CloneTableInput {
  source: string;
  /** New table: `catalog.schema.table`, `schema.table` (default catalog) or a name (source's schema). */
  target: string;
  /** Clone the source as of this log version / time (time travel). */
  version?: number;
  timestamp?: string;
  /** Definition only (CREATE TABLE LIKE); default copies the rows too (deep clone). */
  shallow?: boolean;
}

/**
 * A table entry with the descriptions it lacks: those of `now` (the table as it is now, when it
 * still exists), else the engine's for a column it sets itself.
 */
function describedFrom(entry: CatalogTableEntry, now: CatalogTableEntry | undefined): CatalogTableEntry {
  const known = new Map((now?.columns ?? []).map((c) => [String(c.name), descriptionOf(c)]));
  const { description: own, ...rest } = entry;
  const comment = hasText(own) ? own : now?.description;
  return {
    ...(comment !== undefined ? { description: comment } : {}),
    ...rest,
    columns: entry.columns.map((c) => {
      const d = descriptionOf(c) === undefined ? (known.get(String(c.name)) ?? engineDescription(c)) : undefined;
      return d === undefined ? c : { ...c, description: d };
    }),
  };
}

/**
 * CREATE TABLE … CLONE: a new metastore table with the source's definition and (unless shallow)
 * copies of its rows, as of now or a past version. The copies are independent notes.
 */
async function cloneTableImpl(app: App, settings: DatanotesSettings, input: CloneTableInput, opts: RunOptions = {}): Promise<OpResult> {
  const asOf = input.version !== undefined || input.timestamp !== undefined;
  let src: LoadedTable;
  let rows: LoadedRowWithBody[];
  if (asOf) {
    const hist = await loadTableAsOf(app, settings, input.source, {
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    });
    src = hist.table;
    rows = hist.rows;
  } else {
    src = await loadTable(app, settings, input.source);
    rows = input.shallow ? [] : await loadRows(app, settings, src, false, { bodies: true });
  }
  const ref = await newRef(app, settings, { name: input.target }, { catalog: src.def.catalog, schema: src.def.schema });
  const { text, model } = await metastoreOrEmpty(app, settings);
  const conflicts: OpConflict[] = [];
  if (nameTaken(model, ref)) conflicts.push({ path: ref.full, message: `${ref.full} already exists` });
  // the clone is a new table, described as create_table's must be: a past version lacking a
  // description gets the one the table has now
  const s = src.catalog.ref;
  const entry: CatalogTableEntry = withSystemIdColumn(describedFrom({ ...src.catalog.entry }, model.catalogs[s.catalog]?.schemas[s.schema]?.tables[s.table]));
  // inherited columns as the clone has them: described by their base, or restyled by the table
  const missing = missingDescriptions(entry.description, effectiveColumns(model, ref, entry));
  if (missing) throw refused(cloneTableRefusal(s.full, missing));
  const props = { ...(entry.options ?? {}) };
  delete props.path;
  entry.options = props;
  const cs = emptyChangeSet("clone_table", `clone ${src.catalog.ref.full} to ${ref.full}`, `${metastorePath(settings)}#${ref.full}`);
  cs.texts.push({ path: metastorePath(settings), before: text, after: setTableEntry(text, ref, entry) });
  if (!input.shallow) {
    // The `_table` options only: `options` may also hold metastore-only keys such as `history`.
    const options = parseTableOptions(fmGet(entryToOrdered(ref, entry, settings), TABLE_KEY));
    const layout = catalogLayout(normalizeDatabaseFolder(settings.databaseFolder), ref, options);
    const taken = new Set<string>();
    const identity = src.def.columns.filter((c) => c.identity === "filename").map((c) => c.name);
    const ids = src.def.columns.filter((c) => c.identity === "uuid").map((c) => c.name);
    for (const r of rows) {
      const values = new Map(r.ordered);
      const own = r.file.path.split("/").pop()!.replace(/\.md$/i, "");
      let stem: string;
      try {
        stem = options.filename ? `${renderPathTemplate(layout.rowPath, values)}/${renderPathTemplate(options.filename, values)}` : `${layout.rowPath}/${own}`;
      } catch {
        stem = `${layout.rowPath}/${own}`;
      }
      const path = claimFreeName(stem, (p) => taken.has(p) || app.vault.getAbstractFileByPath(p) != null);
      taken.add(path);
      const name = path.split("/").pop()!.replace(/\.md$/i, "");
      let ordered: OrderedFrontmatter = [[settings.tableKey, ref.full], ...r.ordered.filter(([k]) => k !== settings.tableKey)];
      for (const c of identity) ordered = fmSet(ordered, c, name);
      // A clone's rows are new rows: new ids (the system id is always present in a metastore table).
      for (const c of new Set([...ids, SYSTEM_ID_COLUMN])) ordered = fmSet(ordered, c, uuidv7());
      cs.creates.push({ path, content: buildMarkdownWithFrontmatter(ordered, r.body || "\n") });
    }
  }
  return finish(app, settings, cs, conflicts, [], opts);
}

export const cloneTable = instrumented("clone_table", cloneTableImpl, (i) => ({ source: i.source, target: i.target, shallow: i.shallow === true }));

// --- Bases (shared columns, like PostgreSQL INHERITS) ---

export interface DefineBaseInput {
  name: string;
  /**
   * The base's full column list (after renames), each with its `description`: a column given
   * without one keeps the one the base had for it.
   */
  columns: Record<string, unknown>[];
  /** Other bases this one extends. */
  bases?: string[];
  /** What the tables of the base share: required for a new base, kept when omitted. */
  description?: string;
  /** Column renames, applied to the base and to the rows of every inheriting table. */
  renameColumns?: Record<string, string>;
  /** Columns removed from the base; their values are removed from every inheriting table's rows. */
  dropColumns?: string[];
}

/** Tables that inherit `base` (directly or through other bases). */
function tablesInheriting(model: Metastore, base: string): CatalogRef[] {
  return catalogTables(model)
    // a parsed metastore names known bases, without cycles: the chain is always there
    .filter(({ entry }) => baseChain(model.bases, (entry.bases as string[] | undefined) ?? []).includes(base))
    .map(({ ref }) => ref);
}

/**
 * Tables of `model` (the new metastore) listed in `refs`, with every row checked against the new
 * definition after `rewrite` (rename / drop keys, fill inherited dense and identity columns).
 */
async function planInheritedRows(
  app: App,
  settings: DatanotesSettings,
  model: Metastore,
  text: string,
  refs: readonly CatalogRef[],
  rewrite: (ordered: OrderedFrontmatter) => OrderedFrontmatter,
  cs: ReturnType<typeof emptyChangeSet>,
): Promise<RowViolations[]> {
  const violations: RowViolations[] = [];
  for (const ref of refs) {
    const ms = { file: pseudoFile(metastorePath(settings)), text, model };
    let t: LoadedTable;
    try {
      t = catalogLoadedTable(settings, ms, ref);
    } catch (e) {
      // the metastore's own messages name the table already
      const message = messageOf(e);
      throw new OperationInputError(message.startsWith(`${ref.full}: `) ? message : `${ref.full}: ${message}`);
    }
    const own = new Set(t.catalog!.entry.columns.map((c) => String(c.name)));
    checkColumnRefs(model, ref.full, effectiveColumns(model, ref, t.catalog!.entry).filter((c) => !own.has(String(c.name))), ref.full);
    const old = await loadTable(app, settings, ref.full); // rows are found through the current definition
    const dense = t.def.columns.filter((c) => c.dense);
    const now = new Date();
    const tz = (await readDatabaseConfig(app, settings)).timezone;
    for (const r of await loadRows(app, settings, old)) {
      let after = rewrite(r.ordered);
      for (const c of dense) if (!after.some(([k]) => k === c.name)) after = fmSet(after, c.name, resolveDefault(c.default, now, tz) ?? null);
      after = await fillIdentities(app, settings, t, after, r.file.path);
      const v = validateRow(t.def, after, { tableKey: settings.tableKey }, validationContextFor(app, settings, r.file.path));
      if (v.length > 0) violations.push({ path: r.file.path, violations: v });
      if (JSON.stringify(after) !== JSON.stringify(r.ordered)) cs.edits.push({ path: r.file.path, before: r.ordered, after });
    }
  }
  return violations;
}

/**
 * The columns of "the inheriting table" of base `base` in the model as it is (old names): the
 * base's (its own bases included, `ref: self` as `""`), then the own columns of the tables that
 * inherit it where they agree (same link target, a link to the table itself as `""`); a column
 * the heirs link differently is not a link there, so a filter's walk ends on it.
 */
function inheritingTableColumns(model: Metastore, base: string, heirs: ReadonlySet<string>): Record<string, unknown>[] {
  const out = new Map(inheritedColumns(model, [base], "").map(({ column }) => [String(column.name), column]));
  const fromBase = new Set(out.keys());
  for (const heir of heirs) {
    for (const c of modelColumns(model, heir)!) { // a table of the model
      const name = String(c.name);
      if (fromBase.has(name)) continue;
      const col = c.ref === heir ? { ...c, ref: "" } : c;
      const seen = out.get(name);
      if (seen === undefined) out.set(name, col);
      else if (linkTargetOf(seen, "") !== linkTargetOf(col, "")) out.set(name, { name });
    }
  }
  return [...out.values()];
}

/**
 * A base column (ref_where / ref_by) with the renamed columns of the base followed: `renamed` and
 * `refBy` as for rewrittenEntries, the inheriting table being `""` when the column links to it (`ref: self`).
 */
function renamedBaseFilters(
  model: Metastore,
  c: Record<string, unknown>,
  renamed: (table: string, column: string) => string,
  refBy: (owner: string, target: string, by: Record<string, unknown>) => Record<string, unknown>,
  selfColumns: Record<string, unknown>[],
): Record<string, unknown> {
  const target = c.ref === "self" ? "" : linkTargetOf(c, "");
  if (target === null) return c;
  let out = c;
  // the walk reads "" (the inheriting table) through the columns every inheriting table has
  const columns = (t: string) => (t === "" ? selfColumns : modelColumns(model, t));
  if (c.ref_where != null) out = { ...out, ref_where: mapWhere(model, target, c.ref_where, { key: renamed, columns }) };
  if (c.ref_by != null && typeof c.ref_by === "object") out = { ...out, ref_by: refBy("", target, c.ref_by as Record<string, unknown>) };
  return out;
}

/**
 * define_base / set_table_bases: the CHECKs that follow links and filtered link columns on the rows
 * of the inheriting tables as the change leaves them, with the metastore it writes (an inherited
 * `ref_where` / `ref_by` holds every row, as alter_column's does).
 */
async function inheritedLinkViolations(app: App, settings: DatanotesSettings, cs: ChangeSet): Promise<RowViolations[]> {
  return linkedCheckViolations(app, settings, cs, new Set(), await metastoreLeftBy(app, settings, cs));
}

/** Metastore column → engine column spec: the same words, without `dense`. */
function entryColumnToSpec(c: Record<string, unknown>): Record<string, unknown> {
  const { dense: _d, ...rest } = c;
  return rest;
}

async function defineBaseImpl(app: App, settings: DatanotesSettings, input: DefineBaseInput, opts: RunOptions = {}): Promise<OpResult> {
  ident("base", input.name);
  const { text, model } = await metastoreOrEmpty(app, settings);
  const previous = model.bases[input.name];
  const rename = input.renameColumns ?? {};
  const drop = new Set(input.dropColumns ?? []);
  const names = input.columns.map((c) => String(c.name));
  if (new Set(names).size !== names.length) throw new OperationInputError(`duplicate column in base "${input.name}"`);
  if (names.includes("id")) throw new OperationInputError(`"id" is the system column of every table: it cannot be in a base`);
  for (const [from, to] of Object.entries(rename)) {
    if (!previous?.columns.some((c) => c.name === from)) throw new OperationInputError(`rename: "${from}" is not a column of base "${input.name}"`);
    if (!names.includes(to)) throw new OperationInputError(`rename: "${to}" must be in the new columns`);
  }
  for (const c of previous?.columns ?? []) {
    const n = String(c.name);
    if (!names.includes(n) && !(n in rename) && !drop.has(n)) {
      throw new OperationInputError(`base "${input.name}" would lose column "${n}": list it in drop_columns (its values are removed from the rows) or rename_columns`);
    }
  }
  // Descriptions: given, or kept from the base as it was (a renamed column keeps its own); a column
  // the engine sets gets the engine's. A new base and a new column must end up with one (below).
  const before = new Map((previous?.columns ?? []).map((c) => [String(c.name), descriptionOf(c)]));
  const was = (n: string) => Object.keys(rename).find((from) => rename[from] === n) ?? n;
  input = {
    ...input,
    columns: input.columns.map((c) => {
      const kept = descriptionOf(c) === undefined ? before.get(was(String(c.name))) : undefined;
      return withEngineDescription(kept === undefined ? c : { ...c, description: kept });
    }),
  };
  for (const [i, c] of input.columns.entries()) {
    const spec = { ...c };
    if (spec.ref === "self") spec.ref = "main.x.x"; // parse structure only; refs are checked per table
    parseColumn(entryColumnToSpec(spec), i, new Set());
  }
  checkColumnRefs(model, null, input.columns, `bases.${input.name}`);
  // a base or a column written before descriptions were required stays as it is
  const missing: MissingDescriptions = {
    table: !previous && !hasText(input.description),
    columns: input.columns.filter((c) => !before.has(was(String(c.name))) && descriptionOf(c) === undefined).map((c) => String(c.name)),
  };
  if (missing.table || missing.columns.length > 0) throw refused(defineBaseRefusal(input.name, missing, input.columns));
  // CHECKs and link filters (`ref_where` / `ref_by`) that read a renamed column of the base follow
  // it: the base's own link columns, and those of every table (inheriting ones included)
  const heirs = new Set(tablesInheriting(model, input.name).map((r) => r.full));
  const word = (column: string) => (Object.prototype.hasOwnProperty.call(rename, column) ? rename[column]! : column);
  // "" stands for the inheriting table in a base column's own filters (ref: self)
  const renamed = (table: string, column: string) => (table === "" || heirs.has(table) ? word(column) : column);
  const refBy = (owner: string, target: string, by: Record<string, unknown>): Record<string, unknown> => {
    const { target_column: _t, ...rest } = by;
    const column = owner === "" || heirs.has(owner) ? word(String(by.column)) : String(by.column);
    const tcol = target === "" || heirs.has(target) ? word(String(by.target_column ?? by.column)) : String(by.target_column ?? by.column);
    if (column === String(by.column) && tcol === String(by.target_column ?? by.column)) return by;
    return { ...rest, column, ...(tcol !== column ? { target_column: tcol } : {}) };
  };
  const selfColumns = Object.keys(rename).length === 0 ? [] : inheritingTableColumns(model, input.name, heirs);
  const columns = Object.keys(rename).length === 0 ? input.columns : input.columns.map((c) => renamedBaseFilters(model, c, renamed, refBy, selfColumns));
  const base: BaseEntry = {
    ...(hasText(input.description) ? { description: input.description } : previous?.description ? { description: previous.description } : {}),
    ...(input.bases && input.bases.length > 0 ? { bases: input.bases } : {}),
    columns: columns.map((c) => columnToEntry(entryColumnToSpec(c), c.dense === true)),
  };
  let after = setBaseEntry(text, input.name, base);
  let next: Metastore;
  try {
    next = parseMetastore(after);
    if (Object.keys(rename).length > 0) {
      after = setTableEntries(after, rewrittenEntries(model, next, { key: renamed, refBy }).map(({ ref, entry }) => [ref, entry] as const));
      next = parseMetastore(after);
    }
  } catch (e) {
    throw new OperationInputError(messageOf(e));
  }
  // a CHECK or link filter that reads a dropped column refuses it, as drop_column does
  const conflicts: OpConflict[] = [...drop].flatMap((col) =>
    [...heirs].flatMap((full) => filtersReading(next, full, col).map((what) => ({ path: metastorePath(settings), message: `${what} reads ${full}.${col}: drop or change it first` }))),
  );
  const cs = emptyChangeSet("define_base", `${previous ? "alter" : "create"} base ${input.name}`, `${metastorePath(settings)}#bases.${input.name}`);
  cs.texts.push({ path: metastorePath(settings), before: text, after });
  if (conflicts.length > 0) return finish(app, settings, cs, conflicts, [], opts);
  const rewrite = (o: OrderedFrontmatter) => {
    let out = o.filter(([k]) => !drop.has(k));
    for (const [from, to] of Object.entries(rename)) out = out.map(([k, v]) => (k === from ? [to, v] : [k, v]) as [string, unknown]);
    return out;
  };
  const violations = await planInheritedRows(app, settings, next, after, tablesInheriting(next, input.name), rewrite, cs);
  return finish(app, settings, cs, [], [...violations, ...(await inheritedLinkViolations(app, settings, cs))], opts);
}

export interface SetTableBasesInput {
  table: string;
  /** Bases the table extends (replaces the list); [] removes inheritance. */
  bases: string[];
}

/**
 * Make a table extend bases. Own columns with an inherited name give way to the inherited
 * definition (their presentation — label, comment, aliases — is kept when compatible); every row
 * must stay valid; inherited dense columns and identity columns (created, id) are filled in.
 */
/** Column attributes that constrain values (entry form: `nullable`, not `required`). */
const CONSTRAINT_KEYS = ["required", "unique", "min", "max", "step", "values", "ordered", "ref", "generated", "identity", "default", "hierarchy", "ref_where", "ref_by"];

async function setTableBasesImpl(app: App, settings: DatanotesSettings, input: SetTableBasesInput, opts: RunOptions = {}): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const cat = requireCatalog(t, "Inheritance");
  const { text, model } = await metastoreOrEmpty(app, settings);
  for (const b of input.bases) if (!model.bases[b]) throw new OperationInputError(`unknown base "${b}"`, unknownName(b, Object.keys(model.bases), "bases", "describe_database lists them; define_base makes one.", "bases"));
  const inherited = new Map(inheritedColumns(model, input.bases, cat.ref.full).map((x) => [String(x.column.name), x.column]));
  const own: Record<string, unknown>[] = [];
  for (const c of cat.entry.columns) {
    const inh = inherited.get(String(c.name));
    if (!inh) {
      own.push(c);
      continue;
    }
    // The base's type wins (rows are validated against it), but a constraint of the own column
    // that the base does not have would be lost: refuse instead.
    const lost = CONSTRAINT_KEYS.filter((k) => c[k] !== undefined && JSON.stringify(c[k]) !== JSON.stringify(inh[k]));
    if (lost.length > 0) {
      throw new OperationInputError(
        `${cat.ref.full}: column "${String(c.name)}" has ${lost.join(", ")} that the base column does not; ` +
          `remove it with alter_column (or keep the rule as a CHECK constraint) before inheriting`,
      );
    }
    // keep only the presentation of an own column the base now defines
    const keep: Record<string, unknown> = { name: c.name };
    for (const k of ["label", "description", "aliases", "note", "dense"]) if (c[k] !== undefined && JSON.stringify(c[k]) !== JSON.stringify(inh[k])) keep[k] = c[k];
    if (Object.keys(keep).length > 1) own.push(keep);
  }
  const { bases: _e, ...rest } = cat.entry;
  const entry: CatalogTableEntry = { ...rest, ...(input.bases.length > 0 ? { bases: input.bases } : {}), columns: own };
  const after = setTableEntry(text, cat.ref, entry);
  // the bases exist and their columns agree (inheritedColumns above); the own columns keep only
  // what the bases do not define: the entry parses and its columns resolve
  const next = parseMetastore(after);
  const cs = emptyChangeSet("set_table_bases", `${cat.ref.full} extends ${input.bases.join(", ") || "nothing"}`, t.def.schemaPath);
  cs.texts.push({ path: metastorePath(settings), before: text, after });
  const violations = await planInheritedRows(app, settings, next, after, [cat.ref], (o) => o, cs);
  return finish(app, settings, cs, [], [...violations, ...(await inheritedLinkViolations(app, settings, cs))], opts);
}

export const defineBase = instrumented("define_base", defineBaseImpl, (i) => ({ name: i.name, columns: i.columns.length }));
export const setTableBases = instrumented("set_table_bases", setTableBasesImpl, (i) => ({ table: i.table, bases: i.bases.join(",") }));
