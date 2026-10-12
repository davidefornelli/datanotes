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
 */

import { parseWikilink } from "./validate";
import { formatDateTokensOrNull } from "./datetime";

export class GeneratedExpressionError extends Error {
  override readonly name = "GeneratedExpressionError";
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
