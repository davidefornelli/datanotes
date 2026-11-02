// The row editor's values: a column's value as an input shows it (rawOf), an input parsed back into
// the JSON type the engine takes (parseValue), and what a save sends: the changed columns (diffRow),
// the values they had when the form was read (buildExpect, so a concurrent edit is refused) and the
// values of a new row (insertValues). Only formats are checked here; the engine judges the rest.
// Pure.

export interface ColumnInfo {
  name: string;
  type: string;
  items?: string;
  required: boolean;
  values?: string[];
  value_descriptions?: Record<string, string>;
  ref?: string;
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  generated?: string;
  identity?: string;
  description?: string;
  unique?: boolean;
  hierarchy?: boolean;
  inverse?: string;
}

/** What an input holds: text, the items of a list, a tri-state boolean (null: not set). */
export type Raw = string | string[] | boolean | null;

/** A column the engine computes (generated) or sets once (identity): never sent. */
export function readOnlyColumn(c: ColumnInfo): boolean {
  return Boolean(c.generated) || Boolean(c.identity);
}

function textOfValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** The engine's value as its input shows it. */
export function rawOf(c: ColumnInfo, value: unknown): Raw {
  if (c.type === "boolean") return typeof value === "boolean" ? value : null;
  if (c.type === "list") {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value.map(textOfValue) : [textOfValue(value)];
  }
  if (c.type === "json") return value === null || value === undefined ? "" : JSON.stringify(value, null, 2);
  return textOfValue(value);
}

function rawText(raw: Raw): string {
  if (raw === null) return "";
  if (Array.isArray(raw)) return raw.join(", ");
  return String(raw);
}

/** An input parsed into the column's JSON type; `empty`: nothing given (the key is left out or removed). */
export function parseValue(c: ColumnInfo, raw: Raw): { value?: unknown; empty: boolean; error?: string } {
  if (c.type === "boolean") {
    if (typeof raw === "boolean") return { value: raw, empty: false };
    const t = rawText(raw).trim();
    if (t === "") return { empty: true };
    if (t === "true" || t === "false") return { value: t === "true", empty: false };
    return { empty: false, error: "must be true or false" };
  }
  if (c.type === "list") {
    const items = (Array.isArray(raw) ? raw : rawText(raw) === "" ? [] : [rawText(raw)]).filter((x) => x.trim() !== "");
    if (items.length === 0) return { empty: true };
    const itemColumn: ColumnInfo = { name: c.name, type: c.items ?? "string", required: false };
    const out: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      const r = parseValue(itemColumn, items[i]!);
      if (r.error) return { empty: false, error: `item ${i + 1}: ${r.error}` };
      out.push(r.value);
    }
    return { value: out, empty: false };
  }
  const text = rawText(raw);
  if (c.type === "string" || c.type === "enum") return text === "" ? { empty: true } : { value: text, empty: false };
  const t = text.trim();
  if (t === "") return { empty: true };
  switch (c.type) {
    case "integer":
      return /^-?\d+$/.test(t) ? { value: Number(t), empty: false } : { empty: false, error: "must be a whole number" };
    case "number": {
      const n = Number(t);
      return Number.isFinite(n) ? { value: n, empty: false } : { empty: false, error: "must be a number" };
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { value: t, empty: false } : { empty: false, error: "use YYYY-MM-DD" };
    case "datetime":
      return Number.isNaN(Date.parse(t)) ? { empty: false, error: "use an ISO date-time such as 2026-11-01T09:30" } : { value: t, empty: false };
    case "link":
      return { value: t.startsWith("[[") && t.endsWith("]]") ? t : `[[${t}]]`, empty: false };
    case "json":
      try {
        return { value: JSON.parse(t) as unknown, empty: false };
      } catch {
        return { empty: false, error: "not valid JSON" };
      }
    default:
      return { value: text, empty: false };
  }
}

const present = (v: unknown) => v !== undefined && v !== null;

/**
 * What a save of the form changes: `set` the changed values, `unset` the columns emptied, `changed`
 * both, `errors` the inputs that do not parse. Read-only columns and inputs left as they were read
 * are skipped (an untouched invalid value is not sent, so it is not validated again).
 */
export function diffRow(
  cols: ColumnInfo[],
  original: Record<string, unknown>,
  raws: Record<string, Raw>,
): { set: Record<string, unknown>; unset: string[]; changed: string[]; errors: Record<string, string> } {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const changed: string[] = [];
  const errors: Record<string, string> = {};
  for (const c of cols) {
    if (readOnlyColumn(c) || !(c.name in raws)) continue;
    const raw = raws[c.name]!;
    const before = original[c.name];
    if (JSON.stringify(raw) === JSON.stringify(rawOf(c, before))) continue;
    const r = parseValue(c, raw);
    if (r.error) {
      errors[c.name] = r.error;
      continue;
    }
    if (r.empty) {
      if (present(before)) {
        unset.push(c.name);
        changed.push(c.name);
      }
      continue;
    }
    if (JSON.stringify(r.value) !== JSON.stringify(before)) {
      set[c.name] = r.value;
      changed.push(c.name);
    }
  }
  return { set, unset, changed, errors };
}

/** The values the changed columns had when read: the engine refuses the save if one differs now. */
export function buildExpect(cols: ColumnInfo[], original: Record<string, unknown>, changed: string[]): Record<string, unknown> {
  const expect: Record<string, unknown> = {};
  for (const name of changed) {
    const c = cols.find((x) => x.name === name);
    if (c?.type === "json") continue;
    const before = original[name];
    expect[name] = present(before) ? before : { exists: false };
  }
  return expect;
}

/** The values of a new row: the inputs given, parsed; defaults are the engine's to apply. */
export function insertValues(cols: ColumnInfo[], raws: Record<string, Raw>): { values: Record<string, unknown>; errors: Record<string, string> } {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const c of cols) {
    if (readOnlyColumn(c) || !(c.name in raws)) continue;
    const r = parseValue(c, raws[c.name]!);
    if (r.error) errors[c.name] = r.error;
    else if (!r.empty) values[c.name] = r.value;
  }
  return { values, errors };
}

/** A note's text split at its front matter (between the first two `---` lines); none: all body. */
export function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  const open = /^---\r?\n/.exec(content);
  if (!open) return { frontMatter: "", body: content };
  const rest = content.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) return { frontMatter: "", body: content };
  return { frontMatter: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}
