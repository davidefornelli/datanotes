/**
 * `where` filters: compiled into row predicates (compileWhere; compileCheck for CHECK
 * constraints), after `within` and dotted link keys are resolved (resolveWithin), and how a read
 * gets a row's values (`path` and the file columns included).
 */

import type { App } from "./host";
import { loadRows, loadTable, OperationInputError, type LoadedRow, type LoadedTable } from "./engine";
import { fmGet } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { isoAt } from "./datetime";
import { enumPosition } from "./query";
import type { ColumnSpec } from "./types-table";
import { isEmptyValue, isValidDate, isValidDatetime, parseWikilink } from "./validate";
import { basenameOf } from "./path-templates";
import { hasThisTokens } from "./this-tokens";
import { guide, unknownColumn, unknownOperator, type Guidance } from "./hints";
import { assertTableReadable, currentReadScope, pathReadable } from "./read-scope";

const LOGICAL_HINT = guide(`"and" and "or" take a list of where objects, "not" one: {"or": [{"status": "watched"}, {"rating": {"gte": 4}}]}.`, "logical");

/**
 * What compileWhere and compileCheck need of {@link CheckLinks} (check-links.ts): the test of a
 * dotted key that follows a link column to the rows it names.
 */
export interface WhereLinks {
  test(t: LoadedTable, col: string, cond: unknown): (row: LoadedRow) => boolean;
}

export type WhereValue = unknown;
export type Where = Record<string, WhereValue>;

/**
 * Logical keys of a `where`: `or: [where, …]` (any matches), `and: [where, …]` (all match),
 * `not: where` (does not match). They nest; the other keys are columns, AND-ed as before.
 */
export const LOGICAL_KEYS: ReadonlySet<string> = new Set(["or", "and", "not"]);

function logicalParts(key: string, cond: unknown): Where[] {
  const parts = key === "not" ? [cond] : cond;
  // `not` takes one where object (checked below); `or` / `and` a list
  if (!Array.isArray(parts) || parts.length === 0) throw new OperationInputError(`"${key}" needs a non-empty list of where objects`, LOGICAL_HINT);
  for (const p of parts) {
    if (p == null || typeof p !== "object" || Array.isArray(p)) throw new OperationInputError(`"${key}" needs where objects, got ${JSON.stringify(p)}`, LOGICAL_HINT);
  }
  return parts as Where[];
}

/** True when a `where` uses `or` / `and` / `not` at its top level. */
export function hasLogical(where: Where | undefined): boolean {
  return where != null && Object.keys(where).some((k) => LOGICAL_KEYS.has(k));
}

/** The operators a caller may write. */
const OPERATORS: ReadonlySet<string> = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "icontains", "exists", "within"]);
const OPERATOR_LIST = [...OPERATORS].join(", ");

/**
 * `within` and dotted link keys are resolved before compiling (see resolveWithin) into `in_any`, an
 * internal operator: only the condition objects resolveWithin builds (kept here) may use it; a
 * caller-supplied `in_any` is an unknown operator.
 */
const INTERNAL_OP = "in_any";
const internalConds = new WeakSet<object>();
function internalCond(cond: Record<string, unknown>): WhereValue {
  internalConds.add(cond);
  return cond;
}

/** Lowercase without accents, so "Café" matches "cafe" (for `icontains`). */
function fold(v: unknown): string {
  return String(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function comparable(spec: ColumnSpec | undefined, v: unknown): unknown {
  const t = spec?.type === "list" ? spec.items : spec?.type;
  if ((t === "datetime" || t === "date") && typeof v === "string" && (isValidDatetime(v) || isValidDate(v))) {
    // a date-time against a date column counts by its calendar date as written: `{now-7d}` is
    // written in the database's time zone, so it matches as `{today-7d}` does
    return Date.parse(t === "date" ? `${v.slice(0, 10)}T00:00:00Z` : v);
  }
  if (t === "enum" && spec?.ordered) {
    // Ordered enums compare by position, so `{gte: "medium"}` matches medium and high.
    return enumPosition(spec, v) ?? v;
  }
  if (t === "link") {
    // Compare links by note name so `[[Alice]]` matches `[[People/Alice|A]]`.
    const lp = parseWikilink(v);
    return lp == null ? v : lp.split("/").pop()!.replace(/\.md$/i, "");
  }
  return v;
}

/**
 * Equality as the filters define it, two values with the same JSON, against an expected value
 * whose JSON is computed once: strings (most values) compare as they are, which says the same.
 */
function equalTo(e: unknown): (a: unknown) => boolean {
  const json = JSON.stringify(e);
  if (typeof e === "string") return (a) => (typeof a === "string" ? a === e : JSON.stringify(a) === json);
  return (a) => JSON.stringify(a) === json;
}

/** Membership as the filters define it (some item with the same JSON), with the items' JSON computed once. */
function memberOf(items: readonly unknown[]): (a: unknown) => boolean {
  const strings = new Set<string>();
  const json = new Set<string | undefined>();
  for (const i of items) {
    if (typeof i === "string") strings.add(i);
    json.add(JSON.stringify(i));
  }
  return (a) => (typeof a === "string" ? strings.has(a) : json.has(JSON.stringify(a)));
}

/**
 * One operator of a condition, compiled once for every row: the expected value made comparable,
 * folded or turned into a set before the rows are read. A misuse (`within` where it is not
 * available, `in` without a list) is refused when a row is tested, as before compiling.
 */
function compileOp(op: string, expected: unknown, spec: ColumnSpec | undefined): (actual: unknown) => boolean {
  if (op === "exists") return (actual) => (expected === false) === isEmptyValue(actual);
  if (op === "within") {
    return () => {
      throw new OperationInputError(`"within" is not available here`, guide(`"within" works in select_rows and views on a link column whose table has a hierarchy column; elsewhere, list the rows with "in".`, "linkFilters"));
    };
  }
  if (op === "in_any") {
    const allowed = new Set((expected as unknown[]).map((e) => comparable(spec, e)));
    return (actual) => (Array.isArray(actual) ? actual : [actual]).some((x) => allowed.has(comparable(spec, x)));
  }
  if (op === "icontains") {
    // Case- and accent-insensitive substring, of the text or of any item of a list (names, aliases).
    if (expected == null || typeof expected === "object") return () => false;
    const needle = fold(expected);
    return (actual) => (Array.isArray(actual) ? actual : [actual]).some((x) => x != null && typeof x !== "object" && fold(comparable(spec, x)).includes(needle));
  }
  if (op === "contains") {
    const same = equalTo(comparable(spec, expected));
    return (actual) => {
      if (Array.isArray(actual)) return actual.some((x) => same(comparable(spec, x)));
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    };
  }
  if (op === "in") {
    if (!Array.isArray(expected)) {
      return () => {
        throw new OperationInputError(`"in" expects a list`, guide(`Write {"<column>": {"in": ["a", "b"]}}; for one value use {"<column>": "a"}.`, "filters"));
      };
    }
    const member = memberOf(expected.map((e) => comparable(spec, e)));
    return (actual) => member(comparable(spec, actual));
  }
  const e = comparable(spec, expected);
  if (op === "eq" || op === "ne") {
    const same = equalTo(e);
    return op === "eq" ? (actual) => same(comparable(spec, actual)) : (actual) => !same(comparable(spec, actual));
  }
  const y = e as number | string;
  const cmp: (x: number | string) => boolean = op === "gt" ? (x) => x > y : op === "gte" ? (x) => x >= y : op === "lt" ? (x) => x < y : (x) => x <= y;
  return (actual) => {
    const a = comparable(spec, actual);
    return !isEmptyValue(a) && cmp(a as number | string);
  };
}

/**
 * A condition's operators, less the `{this.*}` tokens no note filled (this-tokens.ts): such a token
 * matches nothing whatever the operator (`eq`, `ne`, `gt`, `contains`, `exists`, …), so the
 * condition matches no row (null); in the list of `in`, only that item matches nothing. `within`
 * is resolved before (resolveWithin), and where it is not available it still says so.
 */
function withoutUnfilledTokens(ops: [string, unknown][]): [string, unknown][] | null {
  const out: [string, unknown][] = [];
  for (const [op, expected] of ops) {
    if (op === "within" || op === "in_any" || !hasThisTokens(expected)) out.push([op, expected]);
    else if (op === "in" && Array.isArray(expected)) out.push([op, expected.filter((e) => !hasThisTokens(e))]);
    else return null;
  }
  return out;
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const internal = internalConds.has(v);
  return keys.length > 0 && keys.every((k) => OPERATORS.has(k) || (internal && k === INTERNAL_OP));
}

/** A caller's condition naming `in_any` (alone or with other operators) is refused, whatever the column. */
function refuseInternalOp(col: string, cond: unknown): void {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond) || internalConds.has(cond)) return;
  const keys = Object.keys(cond);
  if (keys.includes(INTERNAL_OP) && keys.every((k) => OPERATORS.has(k) || k === INTERNAL_OP)) {
    throw new OperationInputError(`where "${col}": unknown operator "${INTERNAL_OP}" (use ${OPERATOR_LIST})`, unknownOperator([INTERNAL_OP], [...OPERATORS]));
  }
}

/** Keys a `where`/`columns` may reference: typed columns, untyped fields, template, and `path`. */
export function knownKeys(t: LoadedTable, settings: DatanotesSettings): Set<string> {
  return new Set([
    ...t.def.columns.map((c) => c.name),
    ...t.def.untypedFields,
    settings.tableKey,
    "path",
  ]);
}

/**
 * Read-only columns every row has, taken from its file rather than its frontmatter (a real column
 * with the same name wins): `file_name`, `file_link` (`[[path|name]]`), `file_modified` (last
 * change, in the database time zone) and `file_backlink_count` (how many notes link to it).
 */
export const FILE_COLUMNS = ["file_name", "file_link", "file_modified", "file_backlink_count"] as const;
const FILE_COLUMN_SET: ReadonlySet<string> = new Set(FILE_COLUMNS);

/** Keys a read (where, columns, order, group, join) may use: {@link knownKeys} plus the file columns. */
export function readableKeys(t: LoadedTable, settings: DatanotesSettings): Set<string> {
  const keys = knownKeys(t, settings);
  for (const c of FILE_COLUMNS) keys.add(c);
  return keys;
}

export type RowGetter = (r: LoadedRow, col: string) => unknown;

/**
 * Reads a row's value, `path` and the file columns included. Backlinks need `app`; under a read
 * scope (read-scope.ts) they count only the notes the token may read.
 */
export function rowGetter(app: App | null, t: LoadedTable, settings: DatanotesSettings, tz = ""): RowGetter {
  const real = knownKeys(t, settings);
  let inlinks: Map<string, number> | null = null;
  const scope = currentReadScope();
  /** Whether a note linking to a row counts: always without a scope; else once per note, remembered. */
  const seen = new Map<string, boolean>();
  const counts = (src: string): boolean => {
    if (!scope) return true;
    let ok = seen.get(src);
    if (ok === undefined) seen.set(src, (ok = pathReadable(app!, settings, src, scope)));
    return ok;
  };
  const backlinks = (path: string): number | null => {
    if (!app) return null;
    // a host that keeps backlinks counts them for one note (no pass over every link)
    const kept = app.metadataCache.backlinksOf;
    if (kept) return Object.keys(kept.call(app.metadataCache, path)).filter((src) => src !== path && counts(src)).length;
    if (!inlinks) {
      inlinks = new Map();
      const resolved = app.metadataCache.resolvedLinks;
      for (const [src, dests] of Object.entries(resolved)) {
        if (!counts(src)) continue;
        for (const d of Object.keys(dests)) if (d !== src) inlinks.set(d, (inlinks.get(d) ?? 0) + 1);
      }
    }
    return inlinks.get(path) ?? 0;
  };
  return (r, col) => {
    if (col === "path") return r.file.path;
    if (!FILE_COLUMN_SET.has(col) || real.has(col)) return fmGet(r.ordered, col);
    switch (col) {
      case "file_name":
        return basenameOf(r.file.path);
      case "file_link":
        return `[[${r.file.path.replace(/\.md$/i, "")}|${basenameOf(r.file.path)}]]`;
      case "file_modified": {
        const m = (r.file as { stat?: { mtime?: number } }).stat?.mtime;
        return typeof m === "number" && m > 0 ? isoAt(m, tz) : null;
      }
      default:
        return backlinks(r.file.path);
    }
  };
}

/**
 * Resolve `{ col: { within: X } }` on a link column into "the link names X or a row below it" in
 * the target table's hierarchy (X included). X is a link, a path or a row's file name.
 */
export async function resolveWithin(app: App, settings: DatanotesSettings, t: LoadedTable, where: Where | undefined): Promise<Where | undefined> {
  if (where == null || typeof where !== "object" || Array.isArray(where)) return where;
  let out: Where | undefined;
  /** Dotted keys on a link column the where also tests: added to its `and` once every key is read (whatever their order). */
  const extra: Where[] = [];
  for (const [col, cond] of Object.entries(where)) {
    if (LOGICAL_KEYS.has(col)) {
      const parts = await Promise.all(logicalParts(col, cond).map((w) => resolveWithin(app, settings, t, w)));
      out ??= { ...where };
      out[col] = (col === "not" ? parts[0] : parts) as WhereValue;
      continue;
    }
    const dot = col.indexOf(".");
    if (dot > 0) {
      // `{ "projects.area": { within: House } }`: follow the link column to the rows it names and test
      // their column there; the row matches when any linked row does (nests: "a.b.c").
      const head = col.slice(0, dot);
      const tail = col.slice(dot + 1);
      const via = t.def.columns.find((c) => c.name === head);
      const viaLink = via && (via.type === "link" || (via.type === "list" && via.items === "link"));
      if (!via || !viaLink || !via.ref) throw new OperationInputError(`where "${col}": "${head}" is not a link column with ref`, notALink(head, t));
      const target = via.ref === t.catalog.ref.full ? t : await loadTable(app, settings, via.ref);
      // a filter is a read of the table it follows into (in a write's where too)
      assertTableReadable(target.catalog.ref.full);
      const sub = await resolveWithin(app, settings, target, { [tail]: cond } as Where);
      const pred = compileWhere(sub, target, settings, rowGetter(app, target, settings));
      const hits = (await loadRows(app, settings, target)).filter(pred).map((r) => `[[${basenameOf(r.file.path)}]]`);
      out ??= { ...where };
      delete out[col];
      const clause = internalCond({ [INTERNAL_OP]: hits });
      if (out[head] === undefined) out[head] = clause;
      else extra.push({ [head]: clause } as Where);
      continue;
    }
    if (!isOperatorObject(cond) || !("within" in cond)) continue;
    const spec = t.def.columns.find((c) => c.name === col);
    const isLink = spec && (spec.type === "link" || (spec.type === "list" && spec.items === "link"));
    if (!spec || !isLink || !spec.ref) throw new OperationInputError(`"within" needs a link column with ref: "${col}" is not one`, notALink(col, t));
    const target = spec.ref === t.catalog.ref.full ? t : await loadTable(app, settings, spec.ref);
    assertTableReadable(target.catalog.ref.full);
    const h = target.def.columns.find((c) => c.hierarchy);
    if (!h) throw new OperationInputError(`"within": ${spec.ref} has no hierarchy column (e.g. parent with hierarchy: true)`, guide(`"within" follows a tree: give ${spec.ref} a parent link with hierarchy: true (add_column), or filter with "eq" / "in" instead.`, "tree"));
    const raw = (cond as Record<string, unknown>).within;
    const { within: _w, ...rest } = cond as Record<string, unknown>;
    out ??= { ...where };
    if (hasThisTokens(raw)) {
      // a `{this.*}` token no note filled matches nothing (this-tokens.ts)
      out[col] = internalCond({ ...rest, [INTERNAL_OP]: [] });
      continue;
    }
    const rows = await loadRows(app, settings, target);
    const names = new Set(rows.map((r) => basenameOf(r.file.path)));
    let root = linkName(raw) ?? (typeof raw === "string" ? basenameOf(raw.trim()) : null);
    if (root != null && !names.has(root)) {
      // a name / title value instead of a file name
      const hit = rows.find((r) => r.ordered.some(([k, v]) => (k === "name" || k === "title") && v === raw));
      root = hit ? basenameOf(hit.file.path) : null;
    }
    if (root == null) throw new OperationInputError(`"within": no row of ${spec.ref} named ${JSON.stringify(raw)}`, guide(`Name a row of ${spec.ref} by its note name or link ("[[Name]]"): list_link_targets("${t.catalog.ref.full}", "${col}") lists them.`, "linkFilters"));
    const children = new Map<string, string[]>();
    for (const r of rows) {
      const p = linkName(fmGet(r.ordered, h.name));
      if (!p) continue;
      const list = children.get(p);
      if (list) list.push(basenameOf(r.file.path));
      else children.set(p, [basenameOf(r.file.path)]);
    }
    const subtree = new Set<string>([root]);
    for (const n of subtree) for (const c of children.get(n) ?? []) subtree.add(c);
    out[col] = internalCond({ ...rest, [INTERNAL_OP]: [...subtree].map((n) => `[[${n}]]`) });
  }
  if (out && extra.length > 0) out.and = [...((out.and as Where[] | undefined) ?? []), ...extra];
  return out ?? where;
}

export function compileWhere(
  where: Where | undefined,
  t: LoadedTable,
  settings: DatanotesSettings,
  get: RowGetter = rowGetter(null, t, settings),
  /** CHECKs only: dotted keys follow links to the rows loaded there (see CheckLinks). */
  links?: WhereLinks,
): (row: LoadedRow) => boolean {
  return compileWhereOn(where, t, readableKeys(t, settings), new Map(t.def.columns.map((c) => [c.name, c])), get, links);
}

/** {@link compileWhere} with the table's keys and column specs computed once for every logical branch. */
function compileWhereOn(
  where: Where | undefined,
  t: LoadedTable,
  known: ReadonlySet<string>,
  specs: ReadonlyMap<string, ColumnSpec>,
  get: RowGetter,
  links: WhereLinks | undefined,
): (row: LoadedRow) => boolean {
  if (where == null) return () => true;
  if (typeof where !== "object" || Array.isArray(where)) throw new OperationInputError(`"where" must be an object`, guide(`Write "where" as an object of conditions: {"status": "watched", "rating": {"gte": 4}}.`, "filters"));
  const tests: ((row: LoadedRow) => boolean)[] = Object.entries(where).map(([col, cond]) => {
    if (LOGICAL_KEYS.has(col)) {
      const parts = logicalParts(col, cond).map((w) => compileWhereOn(w, t, known, specs, get, links));
      if (col === "or") return (row) => parts.some((p) => p(row));
      if (col === "and") return (row) => parts.every((p) => p(row));
      return (row) => !parts[0]!(row);
    }
    if (links && !known.has(col) && col.indexOf(".") > 0) return links.test(t, col, cond);
    if (!known.has(col)) throw new OperationInputError(`unknown column in where: "${col}"`, unknownColumn(col, [...known], t.catalog.ref.full, "select"));
    refuseInternalOp(col, cond);
    if (!isOperatorObject(cond) && cond !== null && typeof cond === "object" && !Array.isArray(cond) && specs.has(col) && specs.get(col)!.type !== "json") {
      // On a typed column an object is operators (json columns may hold literal objects): a typo must not silently match nothing.
      const bad = Object.keys(cond).filter((k) => !OPERATORS.has(k));
      throw new OperationInputError(
        `where "${col}": unknown operator ${bad.map((k) => `"${k}"`).join(", ") || "(empty object)"} (use ${OPERATOR_LIST})`,
        unknownOperator(bad, [...OPERATORS]),
      );
    }
    const ops = withoutUnfilledTokens(isOperatorObject(cond) ? Object.entries(cond) : [["eq", cond]]);
    if (ops === null) return () => false;
    const spec = specs.get(col);
    const matchers = ops.map(([op, expected]) => compileOp(op, expected, spec));
    if (matchers.length === 1) {
      const only = matchers[0]!;
      return (row) => only(get(row, col));
    }
    return (row) => {
      const actual = get(row, col);
      return matchers.every((m) => m(actual));
    };
  });
  return (row) => tests.every((test) => test(row));
}

/**
 * The predicate of one CHECK constraint, shared by write-time validation and add_constraint (which
 * verifies the existing rows), so both decide the same way. Like SQL, a condition on an empty value
 * passes: a top-level column key whose value in the row is empty (missing, null, "", []) is skipped.
 * `path` and the logical keys (`or` / `and` / `not`) always apply, and their nested parts are
 * evaluated as ordinary `where` filters, with no skipping: inside them an empty value fails a
 * comparison and `exists: false` matches it, so `{ or: [{ kind: "a" }, { parent: { exists: true } }] }`
 * refuses a row of kind "b" with no parent. Throws on an invalid filter (unknown column / operator).
 *
 * With `links` (see {@link CheckLinks}) a key may follow a link column to the row it names:
 * `{ "parent.kind": "project" }` (further dots follow further links). At the top level such a key
 * is skipped when the link is empty, like any empty value; inside or / and / not an empty link makes
 * it false. Only the FIRST link of a longer path is skipped when empty: `parent.parent.kind` is
 * skipped for a row with no parent, but false for a row whose parent has no parent. A link to a row
 * that does not exist makes it false, and on a list of links every linked row must match. `not`
 * turns that false into true: `{ not: { "parent.kind": "area" } }` passes a link to a missing row
 * (and an empty link), so pair it with `"parent.kind": { exists: true }` to require a real target.
 */
export function compileCheck(where: Where, t: LoadedTable, settings: DatanotesSettings, links?: WhereLinks): (row: LoadedRow) => boolean {
  const parts = Object.entries(where).map(([col, cond]) => ({
    // a dotted key is empty when its link column is
    col: col.indexOf(".") > 0 ? col.slice(0, col.indexOf(".")) : col,
    always: col === "path" || LOGICAL_KEYS.has(col),
    test: compileWhere({ [col]: cond } as Where, t, settings, rowGetter(null, t, settings), links),
  }));
  return (row) => parts.every((p) => (!p.always && isEmptyValue(fmGet(row.ordered, p.col))) || p.test(row));
}

/** Guidance for a dotted key or `within` on a column that is not a link with ref. */
function notALink(col: string, t: LoadedTable): Guidance {
  const links = t.def.columns.filter((c) => (c.type === "link" || (c.type === "list" && c.items === "link")) && c.ref).map((c) => c.name);
  return guide(
    `Dotted keys ("<link column>.<column>") and "within" follow a link column with a ref; ${links.length > 0 ? `those of ${t.catalog.ref.full} are: ${links.join(", ")}` : `${t.catalog.ref.full} has none`}. describe_table shows each column's ref.`,
    "linkFilters",
  );
}

/** The note name a link value names (`[[People/Alice|A]]` → `Alice`); null when it is not a link. */
export function linkName(v: unknown): string | null {
  const lp = parseWikilink(v);
  return lp == null ? null : lp.split("/").pop()!.replace(/\.md$/i, "");
}
