/**
 * What an agent reads when a call goes wrong, on the client's side: the engine sends `hint` (how
 * to fix it) and `docs` (where to read more) next to `error` (src/core/hints.ts is the engine's
 * half), and the text of a failed call ends with them. Here also the mistakes caught before a call
 * reaches the engine: a tool that does not exist, arguments the tool does not take, a required one
 * missing, a value of the wrong type. Each names the closest real name and the tool's arguments.
 *
 * No dependency: src/api imports nothing else (the engine's copy of the docs address and of the
 * name matching is in src/core/hints.ts; tests/hints.test.ts checks that both agree).
 */

import { OPERATION_KIND, OPERATIONS } from "./catalog.js";

/** The docs site; the pages are read in Markdown: `<route>.md`. */
export const DOCS_BASE = "https://datanotes.dev";

/** The page for agents on reading the engine's errors. */
export const ERRORS_DOCS = `${DOCS_BASE}/guides/agents/reading-errors.md`;

/** The overview of the operations, by kind. */
export const OPERATIONS_DOCS = `${DOCS_BASE}/reference/operations.md`;

/** The reference of an operation (its arguments, with types and defaults): the page of its kind; the overview for an unknown one. */
export function toolDocs(op: string): string {
  const kind = Object.prototype.hasOwnProperty.call(OPERATION_KIND, op) ? OPERATION_KIND[op] : undefined;
  return kind ? `${DOCS_BASE}/reference/operations/${kind}.md#${op}` : OPERATIONS_DOCS;
}

/** How to fix a mistake, and where to read more. */
export interface Guidance {
  hint: string;
  docs: string;
}

/** `hint` and `docs` of an engine's answer, or null when it has none. */
export function guidanceIn(data: unknown): Guidance | null {
  if (data === null || typeof data !== "object") return null;
  const { hint, docs } = data as { hint?: unknown; docs?: unknown };
  return typeof hint === "string" && typeof docs === "string" ? { hint, docs } : null;
}

/**
 * A docs address of the site as the call that reads the same page in the docs shipped with the
 * package (the read_docs tool of `datanotes mcp`, src/api/docs.ts):
 * `read_docs("guides/read-and-write/read-and-filter#compare-values-with-operators")` for
 * `https://datanotes.dev/guides/read-and-write/read-and-filter.md#compare-values-with-operators`. Null for any other address.
 */
export function localDocs(url: string): string | null {
  const m = /^https:\/\/datanotes\.dev\/([a-z0-9/_-]+)\.md(#[a-z0-9_-]+)?$/.exec(url);
  return m ? `read_docs(${JSON.stringify(`${m[1]}${m[2] ?? ""}`)})` : null;
}

/**
 * The text an agent reads: the message, then the hint and the docs page, one per line. The docs
 * line also names the call that reads the page offline, when it is a page of the site.
 */
export function guidedText(message: string, g: Guidance | null): string {
  if (!g) return message;
  const local = localDocs(g.docs);
  return `${message}\nHint: ${g.hint}\nDocs: ${g.docs}${local ? ` (offline: ${local})` : ""}`;
}

/**
 * The text of an error for an agent of the MCP server, which always has the docs tools: each docs
 * line keeps only the call that reads the page offline (`Docs: read_docs("…")`), with no address
 * to fetch. A docs line that is not a page of the site keeps its address.
 */
export function offlineDocsText(text: string): string {
  return text.replace(/^Docs: \S+ \(offline: (read_docs\("[^"\n]*"\))\)$/gm, "Docs: $1");
}

// --- "did you mean" (the same matching as src/core/hints.ts) ---------------------------------------

function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

const fold = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** The real names closest to a wrong one, best first (at most `max`). */
export function closestNames(input: string, candidates: Iterable<string>, max = 3): string[] {
  const wanted = fold(input);
  if (wanted === "") return [];
  const limit = Math.max(1, Math.floor(wanted.length / 3));
  const scored: [string, number][] = [];
  for (const name of new Set(candidates)) {
    const f = fold(name);
    if (f === wanted) scored.push([name, 0]);
    else if (wanted.length >= 3 && (f.includes(wanted) || wanted.includes(f)) && f.length >= 3) scored.push([name, 1 + editDistance(wanted, f) / 100]); // the nearer of two that contain it
    else {
      const dist = editDistance(wanted, f);
      if (dist <= limit) scored.push([name, 1 + dist]);
    }
  }
  // only the closest: a name one edit away hides those two edits away
  const sorted = scored.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return sorted
    .filter(([, s]) => s === sorted[0]![1])
    .slice(0, max)
    .map(([n]) => n);
}

/** `Did you mean "x"?` / `Did you mean "x" or "y"?`, or "" when nothing is close. */
export function didYouMean(input: string, candidates: Iterable<string>): string {
  const near = closestNames(input, candidates).map((n) => `"${n}"`);
  if (near.length === 0) return "";
  return `Did you mean ${near.length === 1 ? near[0] : `${near.slice(0, -1).join(", ")} or ${near[near.length - 1]}`}?`;
}

// --- tools and their arguments ----------------------------------------------------------------------

type Schema = { type?: string | string[]; anyOf?: Schema[]; items?: Schema; enum?: unknown[] };

const OPS = new Map(OPERATIONS.map((o) => [o.name, o]));

/** A tool's input schema: its arguments and the required ones. */
export type InputSchema = { properties?: Record<string, Schema>; required?: string[] };

const schemaOf = (op: string) => (OPS.get(op)?.inputSchema ?? {}) as InputSchema;

/** Values in words: `"a"`, `"a" or "b"`, `"a", "b" or "c"`. */
function oneOfWords(values: unknown[]): string {
  const v = values.map((x) => JSON.stringify(x));
  return v.length === 1 ? v[0]! : `${v.slice(0, -1).join(", ")} or ${v[v.length - 1]}`;
}

/** A schema's type in words: `string`, `object`, `list of strings`, `integer or null`, `"a" or "b"`. */
export function typeName(s: Schema): string {
  if (s.enum) return oneOfWords(s.enum);
  if (s.anyOf) return [...new Set(s.anyOf.map(typeName))].filter((t) => t !== "null").join(" or ");
  const all = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (all.length === 0) return "any";
  const types = all.filter((t) => t !== "null");
  if (types.length === 0) return "null";
  return types.map((t) => (t === "array" ? (s.items ? (s.items.enum ? `list of ${oneOfWords(s.items.enum)}` : `list of ${typeName(s.items)}s`) : "list") : t)).join(" or ");
}

/** An operation's arguments in one line: `table (string, required), values (object, required), dry_run (boolean)`. */
export function argumentsOf(op: string): string {
  return argumentList(schemaOf(op));
}

/** A tool's arguments in one line, from its input schema. */
export function argumentList(schema: InputSchema): string {
  const req = new Set(schema.required ?? []);
  const args = Object.entries(schema.properties ?? {}).map(([name, s]) => `${name} (${typeName(s)}${req.has(name) ? ", required" : ""})`);
  return args.length > 0 ? args.join(", ") : "no arguments";
}

/** Whether a value (never null: null is "not given") is of a JSON Schema type. */
const IS_TYPE: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && !Array.isArray(v),
};

/** Whether a given value (not null) is of a schema's type and among its `enum`; a list's items too. A schema without a type takes anything. */
export function typeOk(v: unknown, s: Schema): boolean {
  if (s.anyOf) return s.anyOf.some((x) => typeOk(v, x));
  if (s.enum && !s.enum.some((x) => x === v)) return false;
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  // "null" (and a type this check does not know) accepts nothing that is given
  const ok = types.length === 0 || types.some((t) => IS_TYPE[t]?.(v) === true);
  return ok && (!Array.isArray(v) || !s.items || v.every((x) => x !== null && typeOk(x, s.items!)));
}

/** A type in words, with its article: `an integer`, `a list of strings`, `"a" or "b"`. */
const article = (t: string) => (t.startsWith('"') ? t : `${/^[aeiou]/.test(t) ? "an" : "a"} ${t}`);

const describeValue = (v: unknown) => (Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v === "string" ? `string ${JSON.stringify(v)}` : `${typeof v} ${String(v)}`);

/** An error found before the call reaches the engine: its text names what to fix. */
export interface ArgumentProblem extends Guidance {
  message: string;
}

/** A tool that does not exist: the closest real ones. `names`: the tools the agent may call. */
export function unknownTool(name: string, names: readonly string[]): ArgumentProblem {
  const near = didYouMean(name, names);
  return {
    message: `unknown tool: ${name}`,
    hint: [near, "tools/list (MCP) and the reference list every operation with its arguments."].filter(Boolean).join(" "),
    docs: OPERATIONS_DOCS,
  };
}

/**
 * The arguments an agent gave a tool, against the tool's input schema: names it does not take (with
 * the closest real one), required ones missing, values of the wrong type (null is "not given", as
 * the engine reads it). Null when they are right; unknown tools are not checked here.
 */
export function checkArguments(op: string, args: Record<string, unknown>): ArgumentProblem | null {
  return OPS.has(op) ? checkToolArguments(op, schemaOf(op), args, toolDocs(op)) : null;
}

/** The same check for any tool, from its input schema (the docs tools of src/api/docs.ts), with its docs page. */
export function checkToolArguments(op: string, schema: InputSchema, args: Record<string, unknown>, docs: string): ArgumentProblem | null {
  const props = schema.properties ?? {};
  const problems: string[] = [];
  const fixes: string[] = [];
  for (const k of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(props, k)) continue;
    problems.push(`unknown argument "${k}"`);
    const near = closestNames(k, Object.keys(props));
    if (near.length > 0) fixes.push(`For "${k}" use ${near.map((n) => `"${n}"`).join(" or ")}.`);
  }
  for (const k of schema.required ?? []) {
    if (args[k] === undefined || args[k] === null) problems.push(`missing required argument "${k}" (${typeName(props[k]!)})`);
  }
  for (const [k, v] of Object.entries(args)) {
    const s = Object.prototype.hasOwnProperty.call(props, k) ? props[k]! : undefined;
    if (!s || v === null || v === undefined || typeOk(v, s)) continue;
    // a list whose item is wrong: name the item
    const list = Array.isArray(v) ? (s.anyOf ?? [s]).find((x) => (Array.isArray(x.type) ? x.type : [x.type]).includes("array") && x.items) : undefined;
    const item = list && (v as unknown[]).find((x) => x === null || !typeOk(x, list.items!));
    if (list && item !== undefined) problems.push(`"${k}": item ${JSON.stringify(item)} must be ${article(typeName(list.items!))}`);
    else problems.push(`"${k}" must be ${article(typeName(s))}, not ${describeValue(v)}`);
  }
  if (problems.length === 0) return null;
  return {
    message: `${op}: ${problems.join("; ")}`,
    hint: [...fixes, `${op} takes: ${argumentList(schema)}.`].join(" "),
    docs,
  };
}
