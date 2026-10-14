/**
 * select: the rows of a table, a view, a base (`base:<name>`), a UNION ALL or
 * `system.information_schema`, filtered, sorted and paged, joined, grouped and aggregated, also as
 * of an earlier version (time travel).
 */

import { unsafeVaultPath } from "./vault-path";
import type { App, TFile } from "./host";
import { loadTableAsOf, TableAbsentError, type HistoricalTable } from "./history";
import { informationSchemaTable, informationSchemaTableData, resolveViewSelect } from "./catalog-ops";
import { resolveThisTokens, type Host } from "./this-tokens";
import { baseChain, catalogTables, loadMetastore } from "./metastore";
import { loadRows, loadRowsWhere, loadTable, OperationInputError, type LoadedRow, type LoadedRowWithBody, type LoadedTable } from "./engine";
import { readFrontmatter } from "./file-cache";
import { fmGet, readOrderedFromMarkdown } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { traced } from "./telemetry";
import { phase } from "./tracing";
import { resolveDateTokens } from "./datetime";
import {
  compileExpr,
  computeAggregate,
  computeOrderedAggregate,
  groupDisplay,
  joinRows,
  parseAggregates,
  type QueryRow,
} from "./query";
import { SYSTEM_ID_COLUMN, type ColumnSpec } from "./types-table";
import { readDatabaseConfig } from "./database";
import { isArchivedPath, tableNotFound, TableNotFoundError } from "./table-registry";
import { guide, unknownColumn, unknownName } from "./hints";

const JOIN_HINT = guide(`Write join as {"table": "<other table>", "on": {"<left column or expression>": "<right column or expression>"}}, e.g. {"table": "watch", "on": {"title": "film"}}.`, "join");
const UNION_HINT = guide(`Write a union as {"union": [{"table": "a", "where": {...}}, {"table": "b"}]}, with at least two branches; order_by, limit and columns apply to the stacked rows.`, "union");
import { isEmptyValue, parseWikilink } from "./validate";
import { comparable, compileWhere, readableKeys, resolveWithin, rowGetter, type RowGetter, type Where } from "./where";

export interface SelectJoin {
  /** Right-hand table (name or schema path). */
  table: string;
  /** Exactly one pair `{ "<left expr>": "<right expr>" }`, e.g. `{ "date(occurred_at)+1": "date(timestamp)" }`. */
  on: Record<string, string>;
  /** Key under which matched rows are attached (default: the right table's name). */
  as?: string;
  /** `inner` (default) drops left rows without matches; `left` keeps them. */
  type?: "inner" | "left";
  /** Columns of matched rows to return (default: all). */
  columns?: string[];
  /** Filter applied to the right table before matching. */
  where?: Where;
}

/** One branch of a UNION ALL view: its own table (or view) and filter; columns default to the outer ones. */
export interface SelectUnionBranch {
  table: string;
  columns?: string[];
  where?: Where;
}

export interface SelectInput {
  /**
   * A table, a view, `system.information_schema.<x>`, or `base:<name>`: every table that extends
   * that base (directly or through other bases), on the base's columns, rows tagged `_source`.
   */
  table: string;
  /**
   * UNION ALL (views only): the rows of every branch, each tagged with `_source` (the branch's table),
   * then sorted, paged and narrowed by the outer `order_by` / `limit` / `where` (the outer `where` is
   * applied inside every branch, so its columns must exist in each). No join / group_by / time travel.
   */
  union?: SelectUnionBranch[];
  columns?: string[];
  where?: Where;
  orderBy?: string | string[];
  limit?: number;
  offset?: number;
  expand?: string[];
  join?: SelectJoin;
  /** Group rows by columns or expressions (e.g. `date(occurred_at)`); output one row per group. */
  groupBy?: string | string[];
  /** `{ "n": "count", "units": "sum:metric_alcohol_units", "kcal": "avg:meal.total_kcal" }`. */
  aggregates?: Record<string, string>;
  /** Also return each row's note body (markdown after the frontmatter) as `body`. */
  includeBody?: boolean;
  /**
   * Time travel: read the table as of this log version (metastore tables). A version numbers the
   * versions of one table: refused where several tables are read (a join, a union, a base).
   */
  version?: number;
  /**
   * Time travel: read the table as of this time (the last version committed at or before it); a
   * join, a union, a base or a view built on them reads every table they read as of that time.
   */
  timestamp?: string;
  /** The note showing the result: values for `{this.*}` tokens in the view and in `where` (see this-tokens.ts). */
  host?: Host;
  /** Vault path of that note (`this_note`): `select` reads it into `host`. */
  thisNote?: string;
}

export interface SelectResult {
  table: string;
  total: number;
  rows: Record<string, unknown>[];
  /** Log version read (time travel only; of the left table for a join, absent for a union or a base). */
  version?: number;
  /** Commit time of that version (time travel only); for a union or a base, the time asked for. */
  timestamp?: string;
  /** Time travel over several tables (a join, a union, a base): the version read of each, by full name. */
  versions?: Record<string, number>;
  /** The view that was selected (its stored query ran). */
  view?: string;
}

function parseOrder(orderBy: string | string[] | undefined): { col: string; desc: boolean }[] {
  if (orderBy == null) return [{ col: "path", desc: false }];
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  return list.map((o) => (o.startsWith("-") ? { col: o.slice(1), desc: true } : { col: o, desc: false }));
}

/**
 * A value as the sort compares it, worked out once per row instead of once per comparison: empty
 * (empties go last), a number, or else its text.
 */
interface SortKey {
  empty: boolean;
  num: number | null;
  text: string;
}

function sortKey(v: unknown): SortKey {
  if (isEmptyValue(v)) return { empty: true, num: null, text: "" };
  return { empty: false, num: typeof v === "number" ? v : null, text: String(v) };
}

/** Empty values last, numbers by value, anything else by its text in the locale's order. */
function compareKeys(a: SortKey, b: SortKey): number {
  if (a.empty || b.empty) return a.empty === b.empty ? 0 : a.empty ? 1 : -1;
  if (a.num !== null && b.num !== null) return a.num - b.num;
  return a.text.localeCompare(b.text);
}

/**
 * The order of `n` items by their keys (one list per `order` entry): the first `need` positions of
 * a stable sort, so equal items keep their order. Items already in order are not sorted; when only
 * a page is needed, a heap keeps the best `need` (the index breaks ties, as the stable sort does).
 */
function orderedIndexes(n: number, keys: readonly (readonly SortKey[])[], order: readonly { desc: boolean }[], need: number): number[] {
  const cmp = (i: number, j: number): number => {
    for (let o = 0; o < order.length; o++) {
      const c = compareKeys(keys[o]![i]!, keys[o]![j]!);
      if (c !== 0) return order[o]!.desc ? -c : c;
    }
    return 0;
  };
  const all = Array.from({ length: n }, (_, i) => i);
  let sorted = true;
  for (let i = 1; i < n && sorted; i++) sorted = !(cmp(i - 1, i) > 0);
  if (sorted) return all;
  // ties broken by position: a total order, the same as the stable sort's
  const before = (i: number, j: number): boolean => {
    const c = cmp(i, j);
    return c < 0 || (!(c > 0) && i < j);
  };
  if (need <= 0) return [];
  if (need * 4 > n) return all.sort(cmp);
  // a max-heap of the best `need` so far, the worst at its root
  const heap: number[] = [];
  const down = (k: number) => {
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let worst = k;
      if (l < heap.length && before(heap[worst]!, heap[l]!)) worst = l;
      if (r < heap.length && before(heap[worst]!, heap[r]!)) worst = r;
      if (worst === k) return;
      [heap[k], heap[worst]] = [heap[worst]!, heap[k]!];
      k = worst;
    }
  };
  for (let i = 0; i < n; i++) {
    if (heap.length < need) {
      heap.push(i);
      for (let k = heap.length - 1; k > 0; ) {
        const p = (k - 1) >> 1;
        if (!before(heap[p]!, heap[k]!)) break;
        [heap[k], heap[p]] = [heap[p]!, heap[k]!];
        k = p;
      }
    } else if (before(i, heap[0]!)) {
      heap[0] = i;
      down(0);
    }
  }
  return heap.sort((i, j) => cmp(i, j) || i - j);
}

/** `rows` in the order `order` gives their values (`valueOf`): the first `need` of them. */
function orderBy<T>(rows: readonly T[], order: readonly { col: string; desc: boolean }[], valueOf: (row: T, col: string) => unknown, need: number): T[] {
  const keys = order.map((o) => rows.map((r) => sortKey(valueOf(r, o.col))));
  return orderedIndexes(rows.length, keys, order, need).map((i) => rows[i]!);
}

function asQueryRow(r: LoadedRow, get: RowGetter): QueryRow & { src: LoadedRow } {
  return { path: r.file.path, get: (c) => get(r, c), src: r };
}

function projectRow(r: LoadedRow, columns: readonly string[] | undefined, hidden: ReadonlySet<string>): Record<string, unknown> {
  const cols = columns ?? r.ordered.map(([k]) => k).filter((k) => !hidden.has(k));
  const out: Record<string, unknown> = { path: r.file.path };
  for (const c of cols) {
    if (c === "path") continue;
    const v = fmGet(r.ordered, c);
    out[c] = v === undefined ? null : v;
  }
  return out;
}

interface LoadedJoin {
  alias: string;
  matchesOf: Map<LoadedRow, LoadedRow[]>;
  kept: LoadedRow[];
  columns?: string[];
  known: Set<string>;
  specs: Map<string, ColumnSpec>;
}

async function loadJoin(
  app: App,
  settings: DatanotesSettings,
  t: LoadedTable,
  left: LoadedRow[],
  join: SelectJoin,
  env: { tz: string; now: Date },
  asOf: { timestamp?: string; read: Map<string, number> },
): Promise<LoadedJoin> {
  const pairs = Object.entries(join.on ?? {});
  if (pairs.length !== 1) throw new OperationInputError(`join.on must contain exactly one "left": "right" pair`, JOIN_HINT);
  const [leftText, rightText] = pairs[0]!;
  if (typeof rightText !== "string") throw new OperationInputError(`join.on values must be strings`, JOIN_HINT);
  // time travel: the right table as of the same time as the left one
  const hist = asOf.timestamp !== undefined ? await loadTableAsOf(app, settings, join.table, { timestamp: asOf.timestamp }) : null;
  if (hist) asOf.read.set(hist.table.catalog.ref.full, hist.version);
  const rt = hist?.table ?? (await loadTable(app, settings, join.table));
  const rKnown = readableKeys(rt, settings);
  const lGet = rowGetter(app, t, settings, env.tz);
  const rGet = rowGetter(app, rt, settings, env.tz);
  for (const c of join.columns ?? []) {
    if (!rKnown.has(c)) throw new OperationInputError(`unknown column in join.columns: "${c}"`, unknownColumn(c, [...rKnown], rt.catalog.ref.full, "join"));
  }
  const leftOn = compileExpr(leftText, readableKeys(t, settings), new Map(t.def.columns.map((c) => [c.name, c])));
  const rightOn = compileExpr(rightText, rKnown, new Map(rt.def.columns.map((c) => [c.name, c])));
  const rWhere = await resolveWithin(app, settings, rt, resolveDateTokens(join.where, env.tz, env.now));
  const rightRows = (hist?.rows ?? (await loadRows(app, settings, rt))).filter(compileWhere(rWhere, rt, settings, rGet));
  const joined = joinRows(left.map((r) => asQueryRow(r, lGet)), leftOn, {
    rows: rightRows.map((r) => asQueryRow(r, rGet)),
    on: rightOn,
    type: join.type ?? "inner",
  });
  const matchesOf = new Map<LoadedRow, LoadedRow[]>();
  for (const j of joined) matchesOf.set(j.row.src, j.matches.map((m) => m.src));
  return {
    alias: join.as ?? rt.def.name,
    matchesOf,
    kept: joined.map((j) => j.row.src),
    ...(join.columns ? { columns: join.columns } : {}),
    known: rKnown,
    specs: new Map(rt.def.columns.map((c) => [c.name, c])),
  };
}

const MAX_VIEW_DEPTH = 8;

/** Most rows a single union branch may contribute: a union is sorted in memory, so it must be bounded. */
export const UNION_BRANCH_MAX = 1000;

/** Time travel by `version` where several tables are read: refused, with the way out. */
function perTableVersion(what: string): OperationInputError {
  return new OperationInputError(
    `"version" numbers the versions of one table, and ${what}: pass "timestamp" instead (every table is read as of that time)`,
    guide(`Pass "timestamp" (an ISO date-time) instead of "version"; describe_history shows each version's time.`, "readAsOf"),
  );
}

/** Polymorphic select: `base:<name>` → a union over the tables that extend the base. */
async function selectBase(app: App, settings: DatanotesSettings, input: SelectInput, depth: number, read: Map<string, number>): Promise<SelectResult> {
  const name = input.table.slice("base:".length).trim();
  const ms = await loadMetastore(app, settings);
  if (!ms || !ms.model.bases[name]) {
    throw new OperationInputError(`unknown base "${name}"`, unknownName(name, Object.keys(ms?.model.bases ?? {}), "bases", "describe_database lists them; define_base makes one.", "bases"));
  }
  const model = ms.model;
  const tables = catalogTables(model)
    .filter(({ entry }) => {
      const ext = (entry.bases as string[] | undefined) ?? [];
      return ext.length > 0 && baseChain(model.bases, ext).includes(name);
    })
    .map(({ ref }) => ref.full);
  const own = new Set([SYSTEM_ID_COLUMN, ...baseChain(model.bases, [name]).flatMap((b) => model.bases[b]!.columns.map((c) => String(c.name)))]);
  const columns = input.columns ?? [...own];
  for (const c of [...columns, ...Object.keys(input.where ?? {}).filter((k) => !["and", "or", "not"].includes(k))]) {
    if (c !== "path" && !own.has(c)) {
      throw new OperationInputError(
        `"${c}" is not a column of base ${name} (columns: ${[...own].join(", ")})`,
        unknownName(c, [...own], `columns of base ${name}`, `base:${name} reads only the base's columns; select one table to read its own.`, "bases"),
      );
    }
  }
  if (input.version !== undefined) throw perTableVersion(`base:${name} reads every table that extends it`);
  if (tables.length === 0) return { table: input.table, total: 0, rows: [] };
  const r = await selectUnion(app, settings, { ...input, columns, union: tables.map((table) => ({ table })) }, depth, read, 1);
  return { ...r, table: input.table };
}

async function selectUnion(app: App, settings: DatanotesSettings, input: SelectInput, depth: number, read: Map<string, number>, minBranches = 2): Promise<SelectResult> {
  const branches = input.union!; // both callers pass a union
  if (branches.length < minBranches) throw new OperationInputError(`union needs at least two branches`, UNION_HINT);
  if (input.join || input.groupBy !== undefined || input.aggregates !== undefined) throw new OperationInputError(`union does not support join, group_by or aggregates`, UNION_HINT);
  if (input.version !== undefined) throw perTableVersion("a union reads several tables");
  const rows: Record<string, unknown>[] = [];
  for (const b of branches) {
    if (!b || typeof b.table !== "string" || b.table === "") throw new OperationInputError(`every union branch needs "table"`, UNION_HINT);
    const outer = input.where && Object.keys(input.where).length > 0 ? input.where : undefined;
    const where = b.where && outer ? { and: [b.where, outer] } : (b.where ?? outer);
    // `_source` is added here, not read from the branch's table
    const columns = (b.columns ?? input.columns)?.filter((c) => c !== "_source");
    let r: SelectResult;
    try {
      r = await selectImpl(app, settings, {
        table: b.table,
        ...(columns ? { columns } : {}),
        ...(where ? { where } : {}),
        ...(input.expand ? { expand: input.expand } : {}),
        ...(input.includeBody ? { includeBody: true } : {}),
        // a branch that selects a view reads the same note
        ...(input.host ? { host: input.host } : {}),
        // every branch as of the same time
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
        limit: UNION_BRANCH_MAX,
      }, depth + 1, read);
    } catch (e) {
      // a table that did not exist at that time had no rows then
      if (e instanceof TableAbsentError) continue;
      throw e;
    }
    if (r.total > UNION_BRANCH_MAX) {
      throw new OperationInputError(
        `union branch ${b.table} has ${r.total} rows (max ${UNION_BRANCH_MAX}): narrow it with where`,
        guide(`Give that branch a "where" that keeps at most ${UNION_BRANCH_MAX} rows, or select the table on its own and page with offset.`, "union"),
      );
    }
    for (const row of r.rows) rows.push({ ...row, _source: r.view ?? b.table });
  }
  const order = parseOrder(input.orderBy);
  const limit = Math.min(Math.max(input.limit ?? 100, 0), 1000);
  const offset = Math.max(input.offset ?? 0, 0);
  return {
    table: "union",
    total: rows.length,
    rows: orderBy(rows, order, (r, col) => r[col], offset + limit).slice(offset, offset + limit),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp, versions: sortedVersions(read) } : {}),
  };
}

const sortedVersions = (read: Map<string, number>) => Object.fromEntries([...read].sort(([a], [b]) => a.localeCompare(b)));

/**
 * `read`: the tables read as of a version or time and the version read of each (time travel over a
 * join, a union or a base reports them as `versions`).
 */
async function selectImpl(app: App, settings: DatanotesSettings, input: SelectInput, depth = 0, read = new Map<string, number>()): Promise<SelectResult> {
  if (input.host && input.where) input = { ...input, where: resolveThisTokens(input.where, input.host) };
  if (input.union) return phase("engine.query.union", () => selectUnion(app, settings, input, depth, read), { "datanotes.branches": input.union.length });
  if (input.table.startsWith("base:")) return phase("engine.query.base", () => selectBase(app, settings, input, depth, read), { "db.collection.name": input.table });
  const info = informationSchemaTable(input.table);
  if (info) {
    if (input.version !== undefined || input.timestamp !== undefined) {
      throw new OperationInputError(`information_schema has no history`, guide(`Leave out "version" and "timestamp": information_schema describes the schema as it is now; describe_history shows how a table changed.`, "describe"));
    }
    const data = await informationSchemaTableData(app, settings, info);
    return { ...(await selectOn(app, settings, input, data, read)), table: `system.information_schema.${info}` };
  }
  const view = await resolveViewSelect(app, settings, input);
  if (view) {
    if (depth >= MAX_VIEW_DEPTH) {
      throw new OperationInputError(`views nested deeper than ${MAX_VIEW_DEPTH} (a cycle?) at ${view.view}`, guide(`A view reads another view that reads it back: make one of them read its table (create_view with replace: true).`, "views"));
    }
    // a view runs its stored query, narrowed by the caller's
    return { ...(await phase("engine.query.view", () => selectImpl(app, settings, view.input, depth + 1, read), { "datanotes.view": view.view, "db.collection.name": view.input.table })), view: view.view };
  }
  if (input.version === undefined && input.timestamp === undefined) return selectOn(app, settings, input, null, read);
  if (input.join && input.version !== undefined) throw perTableVersion("a join reads two tables");
  const hist = await loadTableAsOf(app, settings, input.table, {
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  });
  read.set(hist.table.catalog.ref.full, hist.version);
  const r = await selectOn(app, settings, input, hist, read);
  return { ...r, version: hist.version, timestamp: hist.timestamp, ...(input.join ? { versions: sortedVersions(read) } : {}) };
}

/**
 * A row of the page with its body (include_body): its properties and body from one version of
 * its note, read now (a note changed since the scan gives both from its new text). A row of the
 * past (time travel, information_schema) keeps the body it carries. Null when the note was
 * deleted since the scan: the page leaves it out.
 */
async function pageRowWithBody(app: App, settings: DatanotesSettings, r: LoadedRow): Promise<LoadedRowWithBody | null> {
  const own = (r as Partial<LoadedRowWithBody>).body;
  if (typeof own === "string") return { file: r.file, ordered: r.ordered, body: own };
  try {
    // the keys as the scan reads them (loadRows): `table` holds a wikilink
    return { file: r.file, ...(await readFrontmatter(app, r.file, new Set([settings.tableKey]))) };
  } catch (e) {
    if (await app.vault.adapter.exists(r.file.path)) throw e;
    return null;
  }
}

async function selectOn(app: App, settings: DatanotesSettings, input: SelectInput, hist: HistoricalTable | null, read: Map<string, number>): Promise<SelectResult> {
  const t =
    hist?.table ??
    (await loadTable(app, settings, input.table).catch(async (e: unknown) => {
      // a read takes a view too: suggest both
      throw e instanceof TableNotFoundError ? tableNotFound(input.table, (await loadMetastore(app, settings))?.model, "any") : e;
    }));
  const known = readableKeys(t, settings);
  const tz = (await readDatabaseConfig(app, settings)).timezone;
  const now = new Date();
  const get = rowGetter(app, t, settings, tz);
  const hidden = new Set([settings.tableKey]);
  const specs = new Map(t.def.columns.map((c) => [c.name, c]));
  for (const c of [...(input.columns ?? []), ...(input.expand ?? [])]) {
    if (!known.has(c)) throw new OperationInputError(`unknown column: "${c}"`, unknownColumn(c, [...known], t.catalog.ref.full, "select"));
  }
  const limit = Math.min(Math.max(input.limit ?? 100, 0), 1000);
  const offset = Math.max(input.offset ?? 0, 0);
  // planning: dates and `within` resolved (`within` follows links), the filter compiled
  const pred = await phase("engine.query.plan", async () => compileWhere(await resolveWithin(app, settings, t, resolveDateTokens(input.where, tz, now)), t, settings, get));
  // a filter on `path` reads only the notes it names
  const scanned = hist?.rows ?? (await loadRowsWhere(app, settings, t, input.where));
  let rows = phase("engine.query.filter", (span) => {
    const kept = scanned.filter(pred);
    span.setAttributes({ "datanotes.rows_in": scanned.length, "datanotes.rows_out": kept.length });
    return kept;
  });
  const join = input.join
    ? await phase("engine.query.join", () => loadJoin(app, settings, t, rows, input.join!, { tz, now }, { ...(hist ? { timestamp: input.timestamp! } : {}), read }), { "datanotes.join.table": input.join.table })
    : undefined;
  if (join) rows = join.kept;

  if (input.groupBy !== undefined || input.aggregates !== undefined) {
    return phase("engine.query.group", () => groupSelect(t, rows, join, input, known, specs, limit, offset, get), { "datanotes.rows_in": rows.length });
  }

  const order = parseOrder(input.orderBy);
  for (const o of order) if (!known.has(o.col)) throw new OperationInputError(`unknown column in order_by: "${o.col}"`, unknownColumn(o.col, [...known], t.catalog.ref.full, "select"));
  // each row's sort values read once (a date parsed, a link named, `file_modified` formatted), and
  // only the rows up to the page's end put in order
  const page = phase("engine.query.sort", () => orderBy(rows, order, (r, col) => comparable(specs.get(col), get(r, col)), offset + limit).slice(offset, offset + limit), { "datanotes.rows_in": rows.length });
  const expand = new Set(input.expand ?? []);
  const expandLink = (sourcePath: string, v: unknown): unknown => {
    const linkpath = parseWikilink(v);
    if (linkpath == null) return v;
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    // an archived row is gone, as a deleted one: its link stays a link
    if (!dest || isArchivedPath(app, settings, dest.path)) return v;
    const fm = (app.metadataCache.getFileCache(dest)?.frontmatter ?? {}) as Record<string, unknown>;
    return { path: dest.path, ...fm };
  };
  // the page's rows with their bodies (see pageRowWithBody); `total` counts the rows as scanned
  const withBodies = input.includeBody ? await Promise.all(page.map((r) => pageRowWithBody(app, settings, r))) : null;
  // the page's columns, links expanded (each expand reads the linked note's properties)
  return phase("engine.query.project", () => ({
    table: `${t.def.catalog}.${t.def.schema}.${t.def.name}`,
    total: rows.length,
    rows: page.flatMap((r, i) => {
      const b = withBodies?.[i];
      if (b === null) return []; // deleted since the scan
      const row = b ?? r;
      const cols = input.columns ?? row.ordered.map(([k]) => k).filter((k) => !hidden.has(k));
      const out: Record<string, unknown> = { path: row.file.path };
      for (const c of cols) {
        if (c === "path") continue;
        let v = get(row, c);
        if (expand.has(c)) v = Array.isArray(v) ? v.map((x) => expandLink(row.file.path, x)) : expandLink(row.file.path, v);
        out[c] = v === undefined ? null : v;
      }
      if (join) {
        // every row kept by the join has its matches (keyed by the scanned row)
        out[join.alias] = join.matchesOf.get(r)!.map((m) => projectRow(m, join.columns, hidden));
      }
      if (b) out.body = b.body;
      return [out];
    }),
  }), { "datanotes.rows_out": page.length, "datanotes.expand": expand.size > 0 ? [...expand].join(",") : undefined });
}

function groupSelect(
  t: LoadedTable,
  rows: LoadedRow[],
  join: LoadedJoin | undefined,
  input: SelectInput,
  known: Set<string>,
  specs: Map<string, ColumnSpec>,
  limit: number,
  offset: number,
  get: RowGetter,
): SelectResult {
  const groupTexts = input.groupBy === undefined ? [] : Array.isArray(input.groupBy) ? input.groupBy : [input.groupBy];
  const groupExprs = groupTexts.map((g) => compileExpr(g, known, specs));
  const aggs = parseAggregates(input.aggregates);
  for (const a of aggs) {
    if (a.column === undefined) continue;
    const dot = a.column.indexOf(".");
    if (dot > 0 && join && a.column.slice(0, dot) === join.alias) {
      if (!join.known.has(a.column.slice(dot + 1))) {
        throw new OperationInputError(`aggregate "${a.name}": unknown column "${a.column}"`, unknownName(a.column.slice(dot + 1), [...join.known], `columns of ${join.alias}`, "describe_table lists them.", "groupBy"));
      }
    } else if (!known.has(a.column)) {
      throw new OperationInputError(`aggregate "${a.name}": unknown column "${a.column}"`, unknownColumn(a.column, [...known], t.catalog.ref.full, "groupBy"));
    }
  }
  const groups = new Map<string, { key: unknown[]; rows: LoadedRow[] }>();
  for (const r of rows) {
    const q = asQueryRow(r, get);
    // A list value puts the row in one group per item (like SQL UNNEST): group_by "tags" counts each tag.
    let keys: unknown[][] = [[]];
    for (const e of groupExprs) {
      const v = e.eval(q);
      const items = Array.isArray(v) ? [...new Set(v.map((x) => groupDisplay(x)))] : [groupDisplay(v)];
      const options = items.length > 0 ? items : [null];
      keys = keys.flatMap((k) => options.map((o) => [...k, o]));
    }
    for (const key of keys) {
      const id = JSON.stringify(key);
      const g = groups.get(id) ?? { key, rows: [] };
      g.rows.push(r);
      groups.set(id, g);
    }
  }
  const valuesFor = (g: { rows: LoadedRow[] }, column: string): unknown[] => {
    const dot = column.indexOf(".");
    if (dot > 0 && join && column.slice(0, dot) === join.alias) {
      const col = column.slice(dot + 1);
      // Each joined row counts once per group, even when several left rows matched it (no fan-out).
      const unique = new Set(g.rows.flatMap((r) => join.matchesOf.get(r)!)); // every row kept by the join has its matches
      return [...unique].map((m) => fmGet(m.ordered, col));
    }
    return g.rows.map((r) => get(r, column));
  };
  const specOf = (column: string): ColumnSpec | undefined => {
    const dot = column.indexOf(".");
    if (dot > 0 && join && column.slice(0, dot) === join.alias) return join.specs.get(column.slice(dot + 1));
    return specs.get(column);
  };
  const out = [...groups.values()].map((g) => {
    const row: Record<string, unknown> = {};
    groupExprs.forEach((e, i) => {
      row[e.text] = g.key[i];
    });
    for (const a of aggs) {
      const values = a.column === undefined ? [] : valuesFor(g, a.column);
      const spec = a.column === undefined ? undefined : specOf(a.column);
      row[a.name] =
        a.fn === "count" && a.column !== undefined
          ? values.filter((v) => !isEmptyValue(v)).length
          : spec?.ordered && spec.type === "enum"
            ? computeOrderedAggregate(a.fn, spec, values, g.rows.length)
            : computeAggregate(a.fn, values, g.rows.length);
    }
    return row;
  });
  const outputs = new Set([...groupExprs.map((e) => e.text), ...aggs.map((a) => a.name)]);
  const order =
    input.orderBy === undefined ? groupExprs.map((e) => ({ col: e.text, desc: false })) : parseOrder(input.orderBy);
  for (const o of order) {
    if (!outputs.has(o.col)) {
      throw new OperationInputError(
        `order_by "${o.col}" must be a group_by expression or an aggregate name`,
        unknownName(o.col, [...outputs], "the grouped rows' columns", "Grouped rows have only the group_by expressions and the aggregates.", "groupBy"),
      );
    }
  }
  return { table: `${t.def.catalog}.${t.def.schema}.${t.def.name}`, total: out.length, rows: orderBy(out, order, (r, col) => r[col], offset + limit).slice(offset, offset + limit) };
}

export function select(app: App, settings: DatanotesSettings, input: SelectInput): Promise<SelectResult> {
  return traced(
    "datanotes select",
    { "datanotes.op": "select", table: input.table },
    async () => selectImpl(app, settings, input.thisNote === undefined ? input : { ...input, host: await noteHost(app, input.thisNote) }),
    (r) => ({ attributes: { total: r.total, returned: r.rows.length } }),
  );
}

const THIS_NOTE_HINT = guide(`Give "this_note" the vault path of an existing note, with ".md" (list_folder or search_notes find it).`, "thisNote");

/** The note `this_note` names, as its `{this.*}` tokens read it: its path and its properties. */
async function noteHost(app: App, path: string): Promise<Host> {
  const why = unsafeVaultPath(path);
  if (why) throw new OperationInputError(`this_note: ${why}`, THIS_NOTE_HINT);
  const file = app.vault.getAbstractFileByPath(path);
  if (file == null || !("extension" in file)) throw new OperationInputError(`this_note: no note at "${path}" (give its vault path, e.g. "Journal/2026-10-06.md")`, THIS_NOTE_HINT);
  const { ordered } = readOrderedFromMarkdown(await app.vault.read(file as TFile));
  return { path: file.path, frontmatter: Object.fromEntries(ordered) };
}
