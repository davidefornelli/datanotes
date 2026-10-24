/**
 * What a select reads, told from its arguments and the metastore alone (no rows): the tables of a
 * `select_rows` body or of a view's stored query, through its views (views over views included),
 * joins, unions and the dotted keys of its filters. The read cache keys its answers by these
 * tables (src/server/read-cache.ts); the read permissions of named tokens use them where a static
 * answer is needed, such as hiding a view whose tables a token may not read (src/core/read-scope.ts).
 *
 * Pure: no vault, no store. A part that cannot be resolved from the metastore alone (`within`,
 * `{this.*}`, `base:`, `expand`, a key of no plain read, an unknown name) makes the answer
 * incomplete: it may then read any note.
 */

import { catalogTables, effectiveColumns, resolveCatalogRef, SYSTEM_CATALOG, type Metastore } from "./metastore";

/** Arguments of a plain read of known tables (`select_rows`; a view's query). */
export const PLAIN_SELECT_KEYS: ReadonlySet<string> = new Set(["table", "columns", "where", "order_by", "limit", "offset", "group_by", "aggregates", "include_body", "join", "union"]);

/** The full name of a table or a view (by `kind`), or null: unknown, or ambiguous. */
export function refOf(model: Metastore, name: string, kind: "table" | "view"): string | null {
  try {
    return resolveCatalogRef(model, name, kind)?.full ?? null;
  } catch {
    return null;
  }
}

/** A table of the system catalog, as select reads it: `system.<…>`, or `information_schema.<name>` (catalog-ops.ts informationSchemaTable). */
export function isSystemTable(name: string): boolean {
  const t = name.trim();
  if (t.startsWith(`${SYSTEM_CATALOG}.`)) return true;
  const parts = t.split(".");
  return parts.length === 2 && parts[0] === "information_schema";
}

/** What a select (or a view's query) reads: tables into `out`, or the whole vault; the date or the time. */
export interface QueryReads {
  vault: boolean;
  /** It counts backlinks (`file_backlink_count`): the links between notes. */
  links?: boolean;
  /** It reads system.information_schema: `latest_version` comes from the transaction log, which no version follows. */
  store?: boolean;
  today: boolean;
  now: boolean;
}

/** A key of a query's JSON with a dot in it: a path through a link column. */
const DOTTED_KEY = /"[^"]*\.[^"]*"\s*:/;

/** The tables a select reads, through its views, joins and unions (every one walked, for their dates). */
export function queryTables(q: Record<string, unknown>, model: Metastore, out: Set<string>, depth: number): QueryReads {
  const text = JSON.stringify(q);
  const r: QueryReads = { vault: false, today: text.includes("{today"), now: text.includes("{now") };
  if (depth > 8) return { ...r, vault: true };
  if (text.includes("within") || text.includes("{this")) r.vault = true;
  // a dotted key (`{"project.status": …}`) follows link columns into the tables they link to:
  // those tables count; a key that cannot be followed from the metastore reads the whole vault
  if (DOTTED_KEY.test(text) && !linkedTables(q, model, out)) r.vault = true;
  if (text.includes("file_backlink_count")) r.links = true;
  if (Object.keys(q).some((k) => !PLAIN_SELECT_KEYS.has(k))) r.vault = true;
  const sources: unknown[] = [q.table];
  if (q.join && typeof q.join === "object") sources.push((q.join as Record<string, unknown>).table);
  if (Array.isArray(q.union)) for (const b of q.union) sources.push(b && typeof b === "object" ? (b as Record<string, unknown>).table : undefined);
  for (const name of sources) {
    if (typeof name === "string" && isSystemTable(name)) {
      r.store = true;
      continue;
    }
    if (typeof name !== "string" || name.startsWith("base:")) {
      r.vault = true;
      continue;
    }
    const table = refOf(model, name, "table");
    const view = refOf(model, name, "view");
    if (!table && !view) r.vault = true;
    if (table) out.add(table);
    const v = view ? viewQuery(model, view) : null;
    if (view && !v) r.vault = true;
    if (v) {
      const sub = queryTables(v, model, out, depth + 1);
      r.vault ||= sub.vault;
      r.links ||= sub.links;
      r.store ||= sub.store;
      r.today ||= sub.today;
      r.now ||= sub.now;
    }
  }
  return r;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A plain table of the metastore by name (a view, a base or an unknown name: null). */
function plainTable(model: Metastore, name: unknown): string | null {
  return typeof name === "string" && !refOf(model, name, "view") ? refOf(model, name, "table") : null;
}

/**
 * The tables the dotted keys of a query's filters reach, into `out` (where.ts resolveWithin):
 * `where` from its table, or from each branch's table in a union (select applies it to every
 * branch); `join.where` from the joined table; a branch's own `where` from its table. False when
 * one cannot be followed from the metastore alone (a view's or base's columns, a column that is
 * no link with `ref`), or a dotted key sits elsewhere (`join.on`, `aggregates`).
 */
function linkedTables(q: Record<string, unknown>, model: Metastore, out: Set<string>): boolean {
  const join = isRecord(q.join) ? q.join : null;
  const branches = Array.isArray(q.union) ? q.union : null;
  const rest = {
    ...q,
    where: undefined,
    join: join ? { ...join, where: undefined } : q.join,
    union: branches ? branches.map((b) => (isRecord(b) ? { ...b, where: undefined } : b)) : q.union,
  };
  if (DOTTED_KEY.test(JSON.stringify(rest))) return false;
  const roots = branches ? branches.map((b) => (isRecord(b) ? plainTable(model, b.table) : null)) : [plainTable(model, q.table)];
  if (roots.length === 0) return false;
  for (const table of roots) if (!followKeys(q.where, table, model, out)) return false;
  if (join && !followKeys(join.where, plainTable(model, join.table), model, out)) return false;
  for (const b of branches ?? []) if (isRecord(b) && !followKeys(b.where, plainTable(model, b.table), model, out)) return false;
  return true;
}

/** The dotted keys of a filter followed from `table` (null: no plain table), into `out`; false when one cannot be. */
function followKeys(where: unknown, table: string | null, model: Metastore, out: Set<string>): boolean {
  if (where === null || typeof where !== "object") return true;
  if (Array.isArray(where)) return where.every((w) => followKeys(w, table, model, out));
  for (const [key, cond] of Object.entries(where)) {
    if (key === "and" || key === "or" || key === "not") {
      if (!followKeys(cond, table, model, out)) return false;
    } else if (key.indexOf(".") > 0 && (table === null || !followPath(key, table, model, out))) return false;
  }
  return true;
}

/** Follow `a.b.c` from `table`: every part but the last a link column with `ref`; the tables reached into `out`. */
function followPath(key: string, table: string, model: Metastore, out: Set<string>): boolean {
  let current = table;
  for (const column of key.split(".").slice(0, -1)) {
    const next = linkTarget(model, current, column);
    if (!next) return false;
    out.add(next);
    current = next;
  }
  return true;
}

/** The table a link column leads to (`ref`, `self` resolved), or null when the column is no link with `ref`. */
function linkTarget(model: Metastore, full: string, column: string): string | null {
  const t = catalogTables(model).find((x) => x.ref.full === full);
  if (!t) return null;
  let columns: Record<string, unknown>[];
  try {
    columns = effectiveColumns(model, t.ref, t.entry);
  } catch {
    return null; // bases that disagree: the table cannot load either
  }
  const c = columns.find((x) => x.name === column);
  const link = c !== undefined && (c.type === "link" || (c.type === "list" && c.items === "link"));
  return link && typeof c.ref === "string" ? refOf(model, c.ref, "table") : null;
}

/** A view's stored query by full name, or null. */
export function viewQuery(model: Metastore, full: string): Record<string, unknown> | null {
  const [catalog, schema, name] = full.split(".");
  const q = model.catalogs[catalog!]?.schemas[schema!]?.views[name!]?.query;
  return q && typeof q === "object" ? q : null;
}

/**
 * The tables a select body (or a view's stored query) reads, sorted; `complete` false when some part
 * cannot be resolved from the metastore alone (`within`, `{this.*}`, `base:`, `expand`, unknown keys
 * or names). The system catalog (`system.information_schema.*`) is no table of the metastore: it is
 * not listed and leaves the answer complete.
 */
export function tablesReadByQuery(q: Record<string, unknown>, model: Metastore): { tables: string[]; complete: boolean } {
  const found = new Set<string>();
  const r = queryTables(q, model, found, 0);
  return { tables: [...found].sort(), complete: !r.vault };
}

/** The tables a view (full name) reads, as tablesReadByQuery; an unknown view or one without a query reads nothing known: incomplete. */
export function tablesReadByView(model: Metastore, viewFull: string): { tables: string[]; complete: boolean } {
  const q = viewQuery(model, viewFull);
  return q ? tablesReadByQuery(q, model) : { tables: [], complete: false };
}
