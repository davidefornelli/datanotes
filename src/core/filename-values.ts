/**
 * The inverse of a table's `filename` pattern: read column values back from a file name, so a
 * note created by hand (or by Daily Notes) inside a table folder can become a row.
 * `{date:YYYY-MM-DD}` + `2026-09-30` → `{ date: "2026-09-30" }`;
 * `{occurred_at:YYYY-MM-DD[T]HHmm}` + `2026-09-30T0830` → `{ occurred_at: "2026-09-30T08:30" }`;
 * `skill-{name}` + `skill-metrics` → `{ name: "metrics" }`.
 */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_-]*)(?::([^}]+))?\}/g;
const FORMAT_TOKEN = /\[([^\]]*)\]|YYYY|MM|DD|HH|mm|ss/g;
const TOKEN_RE: Record<string, string> = { YYYY: "(\\d{4})", MM: "(\\d{2})", DD: "(\\d{2})", HH: "(\\d{2})", mm: "(\\d{2})", ss: "(\\d{2})" };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Slot {
  column: string;
  /** Date tokens in capture order (empty for a plain `{column}`). */
  tokens: string[];
}

/** Column values encoded in `basename` by `pattern`, or null when the name does not fit. */
export function valuesFromFilename(pattern: string, basename: string): Record<string, string> | null {
  const slots: Slot[] = [];
  let re = "";
  let last = 0;
  for (const m of pattern.matchAll(PLACEHOLDER)) {
    re += escape(pattern.slice(last, m.index));
    last = m.index! + m[0].length;
    const [, column, format] = m;
    if (format === undefined) {
      re += "(.+?)";
      slots.push({ column: column!, tokens: [""] });
      continue;
    }
    const tokens: string[] = [];
    let fl = 0;
    for (const t of format.matchAll(FORMAT_TOKEN)) {
      re += escape(format.slice(fl, t.index));
      fl = t.index! + t[0].length;
      if (t[1] !== undefined) re += escape(t[1]);
      else {
        re += TOKEN_RE[t[0]]!;
        tokens.push(t[0]);
      }
    }
    re += escape(format.slice(fl));
    slots.push({ column: column!, tokens });
  }
  re += escape(pattern.slice(last));
  const hit = basename.match(new RegExp(`^${re}$`));
  if (!hit) return null;
  const out: Record<string, string> = {};
  let g = 1;
  for (const s of slots) {
    if (s.tokens.length === 1 && s.tokens[0] === "") {
      const v = hit[g++]!;
      if (out[s.column] !== undefined && out[s.column] !== v) return null;
      out[s.column] = v;
      continue;
    }
    const parts: Record<string, string> = {};
    for (const t of s.tokens) parts[t] = hit[g++]!;
    if (!parts.YYYY || !parts.MM || !parts.DD) return null; // not enough to rebuild a date
    const date = `${parts.YYYY}-${parts.MM}-${parts.DD}`;
    out[s.column] = parts.HH !== undefined ? `${date}T${parts.HH}:${parts.mm ?? "00"}${parts.ss !== undefined ? `:${parts.ss}` : ""}` : date;
  }
  return out;
}
