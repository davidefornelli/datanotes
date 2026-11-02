// Named tokens in the browser: the table patterns of their permissions, and the token form's draft.
// The rules repeat the engine's (src/server/tokens.ts, src/core/read-scope.ts) only to warn while the
// owner types; the engine judges on save, and tests/ui-lib-patterns.test.ts checks the two agree.

/** A permission pattern: a table name, catalog.schema.*, catalog.* or *. */
export const PATTERN_RE = /^(\*|[\w-]+(\.[\w-]+){0,2}(\.\*)?)$/;
/** A token's name: kebab-case, at most 63 characters. */
export const TOKEN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Does a qualified table name match one of the patterns? */
export function matchesPattern(full: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith(".*")) return full.startsWith(p.slice(0, -1));
    return p === full;
  });
}

/** Does read pattern `r` cover write pattern `w` (every table `w` matches, `r` matches)? */
export function readCovers(r: string, w: string): boolean {
  return r === "*" || r === w || (r.endsWith(".*") && w.startsWith(r.slice(0, -1)));
}

export interface TokenDraft {
  name: string;
  description: string;
  /** Reads every table (no `read` patterns). */
  readAll: boolean;
  read: string[];
  write: string[];
  ddl: boolean;
  maintain: boolean;
  /** "default": the database's autolink setting. */
  autolink: "default" | "on" | "off";
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function readsAll(read: unknown): boolean {
  return !Array.isArray(read) || read.includes("*");
}

function autolinkOf(v: unknown): TokenDraft["autolink"] {
  return v === true ? "on" : v === false ? "off" : "default";
}

/** The draft of a token entry as `/tokens/` lists it; null: a new token's defaults. */
export function draftFrom(entry: Record<string, unknown> | null): TokenDraft {
  if (!entry) return { name: "", description: "", readAll: true, read: [], write: [], ddl: false, maintain: false, autolink: "default" };
  const all = readsAll(entry.read);
  return {
    name: typeof entry.name === "string" ? entry.name : "",
    description: typeof entry.description === "string" ? entry.description : "",
    readAll: all,
    read: all ? [] : strings(entry.read),
    write: strings(entry.write),
    ddl: entry.ddl === true,
    maintain: entry.maintain === true,
    autolink: autolinkOf(entry.autolink),
  };
}

/** What the engine would refuse in this draft, as messages ([] when it would accept it). */
export function draftProblems(d: TokenDraft, creating: boolean): string[] {
  const out: string[] = [];
  if (creating) {
    if (!TOKEN_NAME_RE.test(d.name)) out.push("the name must be kebab-case: a-z, 0-9 and -");
    else if (d.name === "owner") out.push(`"owner" is reserved`);
  }
  const read = d.readAll ? [] : d.read;
  for (const [field, list] of [
    ["read", read],
    ["write", d.write],
  ] as const) {
    for (const p of list) if (!PATTERN_RE.test(p)) out.push(`${field} pattern "${p}" must be a table name, catalog.schema.*, catalog.* or *`);
  }
  if (d.readAll || read.includes("*")) return out;
  if (d.ddl || d.maintain) out.push("ddl and maintain need read on every table");
  for (const w of d.write) if (!read.some((r) => readCovers(r, w))) out.push(`writes ${w} but may not read it`);
  return out;
}

function autolinkValue(a: TokenDraft["autolink"]): boolean | null {
  return a === "on" ? true : a === "off" ? false : null;
}

/** The body of `/tokens/create/`. */
export function draftToCreate(d: TokenDraft): Record<string, unknown> {
  const autolink = autolinkValue(d.autolink);
  return {
    name: d.name,
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(d.readAll ? {} : { read: d.read }),
    write: d.write,
    ddl: d.ddl,
    maintain: d.maintain,
    ...(autolink !== null ? { autolink } : {}),
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The fields of `/tokens/update/` that change `before` (an entry of `/tokens/`) into the draft:
 * reading every table again sends `read: null`, the database's autolink again `autolink: null`.
 */
export function draftToUpdate(before: Record<string, unknown>, d: TokenDraft): Record<string, unknown> {
  const was = draftFrom(before);
  const out: Record<string, unknown> = {};
  if (d.description.trim() !== was.description) out.description = d.description.trim();
  if (d.readAll !== was.readAll || (!d.readAll && !sameList(d.read, was.read))) out.read = d.readAll ? null : d.read;
  if (!sameList(d.write, was.write)) out.write = d.write;
  if (d.ddl !== was.ddl) out.ddl = d.ddl;
  if (d.maintain !== was.maintain) out.maintain = d.maintain;
  if (d.autolink !== was.autolink) out.autolink = autolinkValue(d.autolink);
  return out;
}

/** Patterns to offer for these tables (qualified names): *, each catalog.*, each catalog.schema.*, each table. */
export function patternSuggestions(tables: string[]): string[] {
  const out = new Set<string>(["*"]);
  for (const t of tables) {
    const parts = t.split(".");
    if (parts.length > 1) out.add(`${parts[0]}.*`);
    if (parts.length > 2) out.add(`${parts[0]}.${parts[1]}.*`);
    out.add(t);
  }
  return [...out].sort();
}
