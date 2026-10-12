/**
 * `{this.*}` tokens: a view's filters may read the note that shows it, so one view serves many
 * notes (every daily note, every project note):
 *
 *   {this.date}, {this.date+1d}, {this.date-1w}   a frontmatter value of that note (date arithmetic)
 *   {this.link}                                   a link to that note: [[Name]] (for `within`)
 *   {this.name}, {this.path}                      its name, its vault path
 *
 * A whole-value token keeps the value's type; inside text (`"[[{this.name}]]"`) it becomes text. A
 * token without a value (no note, or the note lacks the property) stays as written and matches
 * nothing, whatever the operator: a condition on it (`eq`, `ne`, `gt`, `contains`, `within`, …)
 * matches no row, an item of `in` holding it matches nothing (where.ts). Under `not` such a
 * condition is negated like any other.
 */

export interface Host {
  path: string;
  frontmatter: Record<string, unknown>;
}

/** A whole-value token: `{this.field}`, optionally shifted by days or weeks (`{this.date+1d}`). */
export const THIS_WHOLE = /^\{this\.(\w+(?:\.\w+)*)(?:([+-])(\d+)([dw]))?\}$/;
/** A token inside text: `"[[{this.name}]]"`. */
export const THIS_INNER = /\{this\.(\w+(?:\.\w+)*)\}/g;

const noteName = (host: Host) => host.path.split("/").pop()!.replace(/\.md$/i, "");

/** Fields every note has; any other `{this.field}` is a frontmatter value of the note. */
export const THIS_NOTE_FIELDS: ReadonlyMap<string, (host: Host) => string> = new Map([
  ["path", (host: Host) => host.path],
  ["name", (host: Host) => noteName(host)],
  ["link", (host: Host) => `[[${noteName(host)}]]`],
]);

function hostValue(host: Host, field: string): unknown {
  const own = THIS_NOTE_FIELDS.get(field);
  if (own) return own(host);
  return field.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), host.frontmatter);
}

function shiftDate(value: unknown, sign: string, n: number, unit: string): unknown {
  const s = typeof value === "string" ? value : value instanceof Date ? value.toISOString() : null;
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})/.exec(s) : null;
  if (!m) return value;
  const days = n * (unit === "w" ? 7 : 1) * (sign === "-" ? -1 : 1);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000).toISOString().slice(0, 10);
}

export const hasThisTokens = (query: unknown): boolean => JSON.stringify(query ?? null).includes("{this.");

/** Replace `{this.*}` tokens everywhere in a query or filter. */
export function resolveThisTokens<T>(query: T, host: Host): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    if (typeof v !== "string" || !v.includes("{this.")) return v;
    const whole = THIS_WHOLE.exec(v);
    if (whole) {
      const value = hostValue(host, whole[1]!);
      if (value === undefined || value === null) return v;
      return whole[2] ? shiftDate(value, whole[2], Number(whole[3]), whole[4]!) : value;
    }
    return v.replace(THIS_INNER, (m, f: string) => {
      const value = hostValue(host, f);
      return value === undefined || value === null ? m : String(value);
    });
  };
  return walk(query) as T;
}
