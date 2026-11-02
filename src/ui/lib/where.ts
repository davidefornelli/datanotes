// The grid's filter: rows of [column][operator][value] (all must hold) turned into the `where` of
// select_rows, and back. A `where` the rows cannot show (and/or/not, nested values) stays in the JSON
// editor. Values are only parsed into JSON types by the column's type; the engine judges the rest.
// Pure.

/** The engine's operators (src/core/where.ts OPERATORS; tests/ui-lib-where.test.ts checks the parity). */
export const OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "icontains", "exists", "within"] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Condition {
  column: string;
  op: Operator;
  value: string;
}

const LOGICAL = ["and", "or", "not"];

function isOperator(k: string): k is Operator {
  return (OPERATORS as readonly string[]).includes(k);
}

/** One value parsed by the column's type: a number, a boolean or the text. */
function coerce(column: string, type: string | undefined, text: string): { value?: unknown; error?: string } {
  if (type === "integer" || type === "number") {
    const t = text.trim();
    const n = Number(t);
    if (t === "" || !Number.isFinite(n)) return { error: `"${column}": "${text}" is not a number` };
    return { value: n };
  }
  if (type === "boolean") {
    const t = text.trim();
    if (t === "true") return { value: true };
    if (t === "false") return { value: false };
    return { error: `"${column}": "${text}" is not true or false` };
  }
  return { value: text };
}

/** The `where` of the conditions (all must hold), and what keeps one of them from being sent. */
export function conditionsToWhere(conds: Condition[], types: Record<string, string>): { where: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const byColumn = new Map<string, [Operator, unknown][]>();
  for (const c of conds) {
    if (!c.column) {
      errors.push("Pick a column for every condition");
      continue;
    }
    const type = types[c.column];
    let value: unknown;
    if (c.op === "exists") {
      const t = c.value.trim();
      if (t !== "true" && t !== "false") {
        errors.push(`"${c.column}": exists takes true or false`);
        continue;
      }
      value = t === "true";
    } else if (c.op === "in") {
      const items: unknown[] = [];
      let bad = false;
      for (const part of c.value.split(",")) {
        const r = coerce(c.column, type, part.trim());
        if (r.error) {
          errors.push(r.error);
          bad = true;
        } else items.push(r.value);
      }
      if (bad) continue;
      value = items;
    } else {
      const r = coerce(c.column, type, c.value);
      if (r.error) {
        errors.push(r.error);
        continue;
      }
      value = r.value;
    }
    const list = byColumn.get(c.column) ?? [];
    if (list.some(([op]) => op === c.op)) {
      errors.push(`"${c.column}": the operator ${c.op} is used twice`);
      continue;
    }
    list.push([c.op, value]);
    byColumn.set(c.column, list);
  }
  const where: Record<string, unknown> = {};
  for (const [column, list] of byColumn) {
    const only = list.length === 1 ? list[0]! : null;
    if (only && only[0] === "eq") where[column] = only[1];
    else where[column] = Object.fromEntries(list);
  }
  return { where, errors };
}

/** A value as the filter's text box shows it; null when the box cannot hold it. */
function textOf(op: Operator, v: unknown): string | null {
  if (op === "in") {
    if (!Array.isArray(v)) return null;
    const parts = v.map((x) => textOf("eq", x));
    if (parts.some((p) => p === null || p.includes(","))) return null;
    return parts.join(", ");
  }
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** The conditions of a `where`; null when it needs the JSON mode (and, or, not, nested values). */
export function whereToConditions(where: Record<string, unknown>): Condition[] | null {
  const out: Condition[] = [];
  for (const [column, cond] of Object.entries(where)) {
    if (LOGICAL.includes(column)) return null;
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const entries = Object.entries(cond as Record<string, unknown>);
      if (entries.length === 0) return null;
      for (const [op, v] of entries) {
        if (!isOperator(op)) return null;
        const text = textOf(op, v);
        if (text === null) return null;
        out.push({ column, op, value: text });
      }
      continue;
    }
    const text = textOf("eq", cond);
    if (text === null) return null;
    out.push({ column, op: "eq", value: text });
  }
  return out;
}
