/**
 * Expressions of generated columns.
 *
 * - A column name or `path`: its value (`generated: name`).
 * - `date(col)` with an optional day shift: `date(occurred_at)`, `date(occurred_at)+1`.
 * - A string template with `{col}` / `{col:FORMAT}` placeholders and literal text:
 *   `"{name} {surname}"`, `"{value} ({occurred_at:DD/MM})"`. Empty values render as nothing
 *   (spaces collapse); links render as their alias or note name; lists join with ", ".
 *   Formats use YYYY MM DD HH mm ss and `[literal]`.
 * - In a template, `{min(a, b):FORMAT}` / `{max(a, b):FORMAT}` / `{coalesce(a, b):FORMAT}`: the smallest,
 *   largest or first non-empty of several columns, each formatted first (so dates compare as text:
 *   `{min(occurred_at, created_at):YYYY-MM-DD}` = the event's day, but never later than the day
 *   the row was written).
 * - `link(<template>)` (link columns with a `ref`): a link to the row of the `ref` table whose file
 *   is named by the template — `link({occurred_at:YYYY-MM-DD})` with `ref` the days table links each
 *   event to its day note. The target's folder is read from the schema at write time; the target
 *   row may not exist yet (the link resolves once it is created). Empty when a placeholder is empty.
 * - An aggregate of a json column holding a list of objects (see {@link parseAggregate}):
 *   `count(feeds)`, `count(feeds.min)` (the items with a `min`), `sum(feeds.min)`, `avg(…)`,
 *   `min(…)`, `max(…)`, each with an optional filter on one field of the item:
 *   `count(feeds, side = "left")`, `sum(feeds.min, min > 0)`.
 */

import { parseWikilink } from "./validate";
import { formatDateTokensOrNull } from "./datetime";
import { GuidedError, guide, type Guidance } from "./hints";

export class GeneratedExpressionError extends GuidedError {
  override readonly name = "GeneratedExpressionError";
}

/** How to write an aggregate, for every malformed one. */
export const AGGREGATE_GUIDANCE: Guidance = guide(
  `An aggregate reads a json column holding a list of objects: count(feeds), count(feeds, side = "left"), count(feeds.min) (the items with a min), sum(feeds.min), avg|min|max(feeds.min, side != "right"). A filter compares one field of the item with "text", a number, true or false, using =, !=, <, <=, > or >=.`,
  "jsonAggregates",
);

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";
type FilterOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

/** A parsed aggregate: the json column, the field of the items it reads, and the filter. */
export interface Aggregate {
  fn: AggregateFn;
  column: string;
  field?: string;
  filter?: { field: string; op: FilterOp; value: string | number | boolean };
}

const AGGREGATE_START = /^(count|sum|avg|min|max)\s*\(/;
const AGGREGATE_EXPR = /^(count|sum|avg|min|max)\s*\(\s*([A-Za-z][A-Za-z0-9_-]*)(?:\.([A-Za-z_][A-Za-z0-9_-]*))?\s*(?:,\s*([\s\S]*?))?\s*\)$/;
const FILTER_EXPR = /^([A-Za-z_][A-Za-z0-9_-]*)\s*(!=|<=|>=|=|<|>)\s*([\s\S]*)$/;
const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?$/;

/** A filter's value: "text" (JSON escapes), 'text', a number, true or false; undefined otherwise. */
function filterValue(text: string): string | number | boolean | undefined {
  if (text === "true" || text === "false") return text === "true";
  if (NUMBER_LITERAL.test(text)) return Number(text);
  if (/^'[^']*'$/.test(text)) return text.slice(1, -1);
  if (/^"[\s\S]*"$/.test(text)) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The aggregate an expression is, or null when it is not one (it does not start with
 * `count(`, `sum(`, `avg(`, `min(` or `max(`). Throws on a malformed aggregate.
 */
export function parseAggregate(expr: string): Aggregate | null {
  const e = expr.trim();
  if (!AGGREGATE_START.test(e)) return null;
  const fail = (message: string) => new GeneratedExpressionError(message, AGGREGATE_GUIDANCE);
  const m = e.match(AGGREGATE_EXPR);
  if (!m) throw fail(`"${expr}" is not an aggregate: write count(column), count(column, field = value) or sum|avg|min|max(column.field), with an optional filter`);
  const fn = m[1] as AggregateFn;
  const column = m[2]!;
  if (fn !== "count" && m[3] === undefined) throw fail(`"${expr}": ${fn}() needs a field of the items, like ${fn}(${column}.minutes)`);
  const out: Aggregate = { fn, column, ...(m[3] !== undefined ? { field: m[3] } : {}) };
  if (m[4] === undefined) return out;
  const f = m[4].match(FILTER_EXPR);
  if (!f) throw fail(`"${expr}": the filter "${m[4]}" must compare a field with a value, like side = "left"`);
  const op = f[2] as FilterOp;
  const raw = f[3]!.trim();
  const value = filterValue(raw);
  if (value === undefined) throw fail(`"${expr}": the filter value ${raw} is not "text", a number, true or false`);
  if (op !== "=" && op !== "!=" && typeof value !== "number") throw fail(`"${expr}": ${op} compares numbers: the filter value must be a number, like min ${op} 5`);
  return { ...out, filter: { field: f[1]!, op, value } };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** An item's field: undefined when the item is not an object. */
const fieldOf = (item: unknown, field: string): unknown => (isObject(item) ? item[field] : undefined);

/** Whether an item passes the filter: `=` is strict equality, `!=` its negation, the orderings compare numbers. */
function passes(item: unknown, filter: NonNullable<Aggregate["filter"]>): boolean {
  const v = fieldOf(item, filter.field);
  if (filter.op === "=") return v === filter.value;
  if (filter.op === "!=") return v !== filter.value;
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const n = filter.value as number;
  if (filter.op === "<") return v < n;
  if (filter.op === "<=") return v <= n;
  if (filter.op === ">") return v > n;
  return v >= n;
}

/** A total without the noise of binary fractions (0.1 + 0.2 is 0.3). */
const tidy = (n: number) => Number(n.toPrecision(15));

/**
 * An aggregate's value. No list (missing, null) reads as no items; a value that is not a list
 * gives null. Items without the field are left out; a field that holds anything but a finite
 * number gives null. With no number left: `sum` is 0, `avg`, `min` and `max` are null.
 */
function evalAggregate(a: Aggregate, value: unknown): number | null {
  const list = value === undefined || value === null ? [] : value;
  if (!Array.isArray(list)) return null;
  const items = a.filter ? list.filter((x) => passes(x, a.filter!)) : list;
  if (a.field === undefined) return items.length;
  const values = items.map((x) => fieldOf(x, a.field!)).filter((v) => v !== undefined && v !== null);
  if (a.fn === "count") return values.length;
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const nums = values as number[];
  if (a.fn === "sum") return tidy(nums.reduce((s, n) => s + n, 0));
  if (nums.length === 0) return null;
  if (a.fn === "avg") return tidy(nums.reduce((s, n) => s + n, 0) / nums.length);
  return a.fn === "min" ? Math.min(...nums) : Math.max(...nums);
}

const PLACEHOLDER_RE = /\{(?:(min|max|coalesce)\(\s*([A-Za-z][A-Za-z0-9_-]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_-]*)*)\s*\)|([A-Za-z][A-Za-z0-9_-]*))(?::([^}]+))?\}/g;

/** Columns a placeholder reads. */
function placeholderCols(m: RegExpMatchArray): string[] {
  return m[2] ? m[2].split(",").map((c) => c.trim()) : [m[3]!];
}
const LINK_EXPR = /^link\(\s*([\s\S]+?)\s*\)$/;
const DATE_EXPR = /^date\(\s*([A-Za-z][A-Za-z0-9_-]*)\s*\)\s*(?:([+-])\s*(\d+))?$/;
const COLUMN_EXPR = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function isLinkExpression(expr: string): boolean {
  return LINK_EXPR.test(expr.trim());
}

export function isTemplateExpression(expr: string): boolean {
  return !isLinkExpression(expr) && expr.includes("{");
}

/** Columns an expression reads (throws on a malformed expression). */
export function generatedRefs(expr: string): string[] {
  const e = expr.trim();
  const agg = parseAggregate(expr);
  if (agg) return [agg.column];
  const lm = e.match(LINK_EXPR);
  if (lm) {
    if (!lm[1]!.includes("{")) throw new GeneratedExpressionError(`"${expr}": link() needs a name template with at least one {column}`);
    return generatedRefs(lm[1]!);
  }
  if (isTemplateExpression(e)) {
    const leftover = e.replace(PLACEHOLDER_RE, "");
    if (leftover.includes("{") || leftover.includes("}")) throw new GeneratedExpressionError(`"${expr}": unbalanced { }`);
    // never empty: the expression has a `{` and none is left over, so a placeholder naming a column matched
    return [...new Set([...e.matchAll(PLACEHOLDER_RE)].flatMap(placeholderCols))];
  }
  const m = e.match(DATE_EXPR);
  if (m) return [m[1]!];
  if (COLUMN_EXPR.test(e)) return [e];
  throw new GeneratedExpressionError(
    `"${expr}" is not a generated expression: use a column, date(column)±N or a template like "{name} {surname}"`,
  );
}

function shiftDate(value: unknown, days: number): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

/** A value formatted as a date; a value that is not a date is kept as it is. */
function formatDate(value: string, format: string): string {
  return formatDateTokensOrNull(value, format) ?? value;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(display).filter((s) => s !== "").join(", ");
  if (typeof value === "string") {
    const alias = value.match(/^\[\[[^\]|]*\|([^\]]+)\]\]$/);
    if (alias) return alias[1]!.trim();
    const link = parseWikilink(value);
    if (link != null) return link.split("/").pop()!.replace(/\.md$/i, "");
    return value;
  }
  return String(value);
}

/**
 * Evaluate an expression against a row (`get` reads a column; `path` is the row's path).
 * `linkFolder` gives the folder of the `ref` table, for `link(…)` (null: no link).
 */
export function evalGenerated(expr: string, get: (column: string) => unknown, path: string, linkFolder?: () => string | null): unknown {
  const e = expr.trim();
  const read = (col: string) => (col === "path" ? path : get(col));
  const agg = parseAggregate(e);
  if (agg) return evalAggregate(agg, read(agg.column));
  const lm = e.match(LINK_EXPR);
  if (lm) {
    const tpl = lm[1]!;
    // every placeholder must have a value: a link to "2026-" would be wrong
    for (const m of tpl.matchAll(PLACEHOLDER_RE)) if (placeholderText(m, read) === "") return null;
    const name = evalGenerated(tpl, get, path);
    const folder = linkFolder?.();
    if (typeof name !== "string" || name === "" || folder === undefined || folder === null) return null;
    return `[[${folder ? `${folder}/` : ""}${name}|${name}]]`;
  }
  if (isTemplateExpression(e)) {
    const out = e.replace(PLACEHOLDER_RE, (...args: unknown[]) => placeholderText(args as unknown as RegExpMatchArray, read));
    const tidy = out.replace(/\s+/g, " ").replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s+/g, " ").trim();
    return tidy === "" ? null : tidy;
  }
  const m = e.match(DATE_EXPR);
  if (m) {
    const days = m[3] ? Number(m[3]) * (m[2] === "-" ? -1 : 1) : 0;
    const v = read(m[1]!);
    return Array.isArray(v) ? v.map((x) => shiftDate(x, days)) : shiftDate(v, days);
  }
  return read(e);
}

/** A placeholder's text: one column, or min / max / coalesce of several (each formatted first). */
function placeholderText(m: RegExpMatchArray, read: (col: string) => unknown): string {
  const fmt = m[4];
  const texts = placeholderCols(m)
    .map((c) => display(read(c)))
    .filter((t) => t !== "")
    .map((t) => (fmt !== undefined ? formatDate(t, fmt) : t));
  if (texts.length === 0) return "";
  if (m[1] === "min") return [...texts].sort()[0]!;
  if (m[1] === "max") return [...texts].sort().pop()!;
  return texts[0]!;
}
