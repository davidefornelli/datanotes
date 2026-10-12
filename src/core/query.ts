/**
 * Query helpers for `select`: expressions, value joins between tables, group-by aggregates.
 * Pure functions over already-loaded rows (no Obsidian I/O).
 *
 * Expressions: a column name, `path`, or `date(column)` optionally shifted in days —
 * `date(occurred_at)`, `date(occurred_at)+1`, `date(timestamp)-7`.
 */

import type { ColumnSpec } from "./types-table";
import { isEmptyValue, parseWikilink } from "./validate";
import { guide, GuidedError, unknownName } from "./hints";

const columnsHint = (col: string, known: ReadonlySet<string>) =>
  unknownName(col, [...known], "columns", `An expression is a column, "path", or date(<column>) shifted in days: date(watched_on)+1.`, "groupBy");

export class QueryInputError extends GuidedError {
  override readonly name = "QueryInputError";
}

export interface QueryRow {
  path: string;
  get(column: string): unknown;
}

export interface Expr {
  text: string;
  /** Raw value (a list for list columns). */
  eval(row: QueryRow): unknown;
  /** Spec of the underlying column, when typed. */
  spec?: ColumnSpec;
}

const DATE_EXPR = /^date\(\s*([A-Za-z][A-Za-z0-9_-]*)\s*\)\s*(?:([+-])\s*(\d+))?$/;

function shiftDate(value: unknown, days: number): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** Compile an expression against the columns a table knows. */
export function compileExpr(text: string, known: ReadonlySet<string>, specs: ReadonlyMap<string, ColumnSpec>): Expr {
  const t = text.trim();
  const m = t.match(DATE_EXPR);
  if (m) {
    const col = m[1]!;
    if (!known.has(col)) throw new QueryInputError(`unknown column in expression "${text}": "${col}"`, columnsHint(col, known));
    const days = m[3] ? Number(m[3]) * (m[2] === "-" ? -1 : 1) : 0;
    return {
      text: t,
      eval: (row) => {
        const v = row.get(col);
        return Array.isArray(v) ? v.map((x) => shiftDate(x, days)) : shiftDate(v, days);
      },
    };
  }
  if (!known.has(t)) throw new QueryInputError(`unknown column or expression: "${text}"`, columnsHint(t, known));
  const spec = specs.get(t);
  return { text: t, eval: (row) => (t === "path" ? row.path : row.get(t)), ...(spec ? { spec } : {}) };
}

/** Normalized join/group keys of a value: links by note name, lists expanded, empties dropped. */
export function keysOf(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const v of values) {
    if (isEmptyValue(v)) continue;
    const link = parseWikilink(v);
    out.push(link != null ? `link:${link.split("/").pop()!.replace(/\.md$/i, "").toLowerCase()}` : JSON.stringify(v));
  }
  return out;
}

export interface JoinSpec<R extends QueryRow> {
  rows: readonly R[];
  on: Expr;
  type: "inner" | "left";
}

/** Match each left row to the right rows whose `on` key equals the left key. */
export function joinRows<L extends QueryRow, R extends QueryRow>(
  left: readonly L[],
  leftOn: Expr,
  join: JoinSpec<R>,
): { row: L; matches: R[] }[] {
  const index = new Map<string, R[]>();
  for (const r of join.rows) {
    for (const k of new Set(keysOf(join.on.eval(r)))) {
      const list = index.get(k) ?? [];
      list.push(r);
      index.set(k, list);
    }
  }
  const out: { row: L; matches: R[] }[] = [];
  for (const l of left) {
    const seen = new Set<R>();
    for (const k of keysOf(leftOn.eval(l))) for (const r of index.get(k) ?? []) seen.add(r);
    const matches = [...seen];
    if (matches.length === 0 && join.type === "inner") continue;
    out.push({ row: l, matches });
  }
  return out;
}

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

export interface AggregateSpec {
  name: string;
  fn: AggregateFn;
  /** Column (or `alias.column` for joined rows); absent for plain `count`. */
  column?: string;
}

const AGG_HINT = guide(
  `Write aggregates as {"<name>": "<function>"}: "count", or "sum:<column>", "avg:<column>", "min:<column>", "max:<column>", "count:<column>", e.g. {"films": "count", "hours": "sum:minutes"}.`,
  "groupBy",
);

const AGG_RE = /^(count|sum|avg|min|max)(?::\s*([A-Za-z][A-Za-z0-9_.-]*))?$/;

/** Parse `{"n": "count", "units": "sum:metric_alcohol_units", "kcal": "avg:meal.total_kcal"}`. */
export function parseAggregates(raw: Record<string, unknown> | undefined): AggregateSpec[] {
  if (raw === undefined) return [];
  return Object.entries(raw).map(([name, v]) => {
    const m = typeof v === "string" ? v.trim().match(AGG_RE) : null;
    if (!m) throw new QueryInputError(`aggregate "${name}" must be count, count:col, sum:col, avg:col, min:col or max:col`, AGG_HINT);
    const fn = m[1] as AggregateFn;
    if (fn !== "count" && !m[2]) throw new QueryInputError(`aggregate "${name}": ${fn} needs a column`, AGG_HINT);
    return { name, fn, ...(m[2] ? { column: m[2] } : {}) };
  });
}

function numeric(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Compute one aggregate over a list of values (already collected for the group). */
export function computeAggregate(fn: AggregateFn, values: readonly unknown[], countRows: number): number | string | null {
  if (fn === "count") return countRows;
  const nums = values.map(numeric).filter((x): x is number => x !== null);
  if (nums.length === 0) {
    // min / max also work on dates and date-times (ISO strings sort in time order) and on text
    if (fn !== "min" && fn !== "max") return null;
    const texts = values.filter((v): v is string => typeof v === "string" && v.trim() !== "").sort();
    if (texts.length === 0) return null;
    return fn === "min" ? texts[0]! : texts[texts.length - 1]!;
  }
  switch (fn) {
    case "sum":
      return round(nums.reduce((a, b) => a + b, 0));
    case "avg":
      return round(nums.reduce((a, b) => a + b, 0) / nums.length);
    case "min":
      return Math.min(...nums);
    default:
      return Math.max(...nums);
  }
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 1-based position of `value` in an ordered enum column, or null when it is not one of its values. */
export function enumPosition(spec: ColumnSpec | undefined, value: unknown): number | null {
  if (!spec?.ordered || !spec.values) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const i = spec.values.indexOf(String(value));
  return i < 0 ? null : i + 1;
}

/** Aggregate over an ordered enum: positions for sum/avg, the value itself for min/max. */
export function computeOrderedAggregate(
  fn: AggregateFn,
  spec: ColumnSpec,
  values: readonly unknown[],
  countRows: number,
): unknown {
  const positions = values.map((v) => enumPosition(spec, v));
  const r = computeAggregate(fn, positions, countRows);
  // a position computed from the values: always one of them
  if ((fn === "min" || fn === "max") && typeof r === "number") return spec.values![r - 1]!;
  return r;
}

/** Group key display value: the expression result with lists joined. */
export function groupDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? null : value.join(", ");
  return value === undefined ? null : value;
}
