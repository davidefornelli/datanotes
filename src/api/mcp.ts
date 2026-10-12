/**
 * `datanotes/mcp`: the engine's operations as Model Context Protocol (MCP) tools, for people who
 * build their own MCP server on Datanotes: list some of them next to tools of their own, call them
 * through a `DatanotesClient`, and start the server's instructions with the engine's.
 *
 *   const tools = [...engineTools({ only: ["select_rows", "insert_row"] }), myTool];
 *   if (isEngineTool(name)) return callEngineTool(client, name, args);
 *
 * The definitions come from the catalogue (`catalog.ts`), so they always match the engine's
 * routes; `datanotes mcp` (src/mcp) serves the same ones. Next to them, the docs tools (list_docs,
 * read_docs, search_docs: docsTools, callDocsTool) read the docs of this version that the package
 * ships (src/api/docs.ts, Node only), with no engine; given a client, search_docs also asks the
 * engine for its ranking of the docs by meaning, and fuses it with its own (hybrid search). Plain
 * data and functions: no dependency, not even the MCP SDK, which only the server that uses them
 * needs.
 */

import { OPERATIONS, type OperationDef } from "./catalog.js";
import { DatanotesError, type ActorInfo, type DatanotesClient } from "./client.js";
import { DocsError, FUSION_DEPTH, OFFLINE_DOCS, openDocs, parseQuery, READ_DOCS_MAX, type DocsLibrary } from "./docs.js";
import { checkArguments, checkToolArguments, guidedText, offlineDocsText, unknownTool } from "./guidance.js";

/** What an agent needs to know before it uses the engine's tools: `datanotes mcp` sends it as its instructions. */
export const ENGINE_INSTRUCTIONS =
  "Database of Markdown notes: tables defined in metastore.yaml, a row is a note whose front matter key `table` names its table, and each front matter key is a column. Use list_tables / describe_table first, select_rows to read, insert_row / update_row / update_rows / batch to write (validated, journaled, undo with undo_migration). Change the schema only with its operations (create_table, add_column, alter_column, create_view, ...); never edit metastore.yaml. Every table and column needs a `description` of what it holds, or it is refused: descriptions are how agents and people understand the schema. Fill those describe_table lists in `missing_descriptions` with alter_table / alter_column. A body you write links the notes it mentions by name (a one-word name only with a capital, inside a sentence): when a write returns ambiguous_mentions, read the candidate notes and link the right one with update_row and autolink: false, or leave the text. Read the docs of this version with search_docs and read_docs.";

/** An engine operation as an MCP tool definition (`tools/list`). */
export interface EngineTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: OperationDef["annotations"];
}

/** Which engine tools to keep: only these names, and none of those. Unknown names throw, so a typo shows at once. */
export interface EngineToolFilter {
  only?: readonly string[];
  except?: readonly string[];
}

/** MCP content of a tool's result (`tools/call`): what a server returns to the agent. */
export interface ToolContent {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const NAMES = new Set(OPERATIONS.map((o) => o.name));

function checkNames(names: readonly string[] | undefined, option: string): void {
  for (const n of names ?? []) if (!NAMES.has(n)) throw new Error(`${option}: "${n}" is not an engine tool`);
}

function kept(name: string, filter: EngineToolFilter): boolean {
  return NAMES.has(name) && (!filter.only || filter.only.includes(name)) && !filter.except?.includes(name);
}

/**
 * The engine's operations as MCP tool definitions, in the catalogue's order. Each one is a fresh
 * copy (name, description, input schema, annotations), safe to change.
 */
export function engineTools(filter: EngineToolFilter = {}): EngineTool[] {
  checkNames(filter.only, "only");
  checkNames(filter.except, "except");
  return OPERATIONS.filter((o) => kept(o.name, filter)).map(({ name, description, inputSchema, annotations }) => JSON.parse(JSON.stringify({ name, description, inputSchema, annotations })) as EngineTool);
}

/** Is this the name of an engine tool (kept by the filter, when one is given)? */
export function isEngineTool(name: string, filter: EngineToolFilter = {}): boolean {
  return kept(name, filter);
}

/** MCP content of a result: the text, and the object itself when it is one. */
export function toolContent(ok: boolean, value: unknown): ToolContent {
  if (!ok) return { content: [{ type: "text", text: String(value) }], isError: true };
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const structured = value !== null && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {};
  return { content: [{ type: "text", text }], ...structured };
}

/**
 * An error result as the agents of a server that serves the docs tools read it: each `Docs:` line
 * names only the read_docs call that reads its section offline, with no web address to fetch, as
 * `datanotes mcp` answers. A docs line that is not a page of the docs, and any other result, stay
 * as they are.
 */
export function offlineDocs(content: ToolContent): ToolContent {
  return content.isError ? { ...content, content: content.content.map((c) => ({ ...c, text: offlineDocsText(c.text) })) } : content;
}

/**
 * What is wrong with a call before it reaches the engine, as the text the agent reads: a tool that
 * does not exist (or that the filter leaves out), arguments the tool does not take, a required
 * one missing, a value of the wrong type. Each with the closest real name, the tool's arguments
 * and its docs. Null when the call can be sent.
 */
export function callProblem(name: string, args: Record<string, unknown>, filter: EngineToolFilter = {}): string | null {
  if (!kept(name, filter)) {
    const p = unknownTool(name, OPERATIONS.map((o) => o.name).filter((n) => kept(n, filter)));
    return guidedText(p.message, p);
  }
  const p = checkArguments(name, args);
  return p ? guidedText(p.message, p) : null;
}

/**
 * Call an engine tool for an agent and answer its MCP content. A refusal, bad arguments, a name
 * the filter leaves out and an engine that does not answer come back as an error result
 * (`isError`), never as a throw: the agent reads why, how to fix it and where to read more.
 * `actor` names the agent in the journal (default: the client's own actor).
 */
export async function callEngineTool(client: DatanotesClient, name: string, args: Record<string, unknown> = {}, opts: EngineToolFilter & { actor?: ActorInfo } = {}): Promise<ToolContent> {
  try {
    const problem = callProblem(name, args, opts);
    if (problem) return toolContent(false, problem);
    const r = await client.call(name, args, opts.actor);
    return toolContent(r.ok, r.value);
  } catch (e) {
    if (e instanceof DatanotesError) return toolContent(false, e.message);
    throw e;
  }
}

// --- the docs of this version (src/api/docs.ts) ------------------------------------------------------

/** The names of the docs tools. */
export const DOCS_TOOL_NAMES = ["list_docs", "read_docs", "search_docs"] as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const DOCS_TOOLS: EngineTool[] = [
  {
    name: "list_docs",
    description:
      "List the pages of the Datanotes documentation of this version (read offline, from the package): path, title and description, one per line. `prefix` keeps the pages under a folder (`guides/`, `reference/`, `start/`). Read one with read_docs(path).",
    inputSchema: { type: "object", properties: { prefix: { type: "string", description: "Only the pages under this folder or path, such as `guides/`." } }, additionalProperties: false },
    annotations: { title: "List Docs", ...READ_ONLY },
  },
  {
    name: "read_docs",
    description: `Read a page of the Datanotes documentation of this version as Markdown, or one section of it: \`guides/read-and-write/read-and-filter\`, or \`guides/read-and-write/read-and-filter#compare-values-with-operators\` (the anchor of its heading, as in the docs links of the errors; the datanotes.dev addresses work too). Read a section rather than a whole page: list_docs lists the pages, search_docs finds the sections on a topic. At most ${READ_DOCS_MAX} characters at a time: a longer text ends with a note on how to read the rest (\`offset\`, or its sections one by one).`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The page (`guides/read-and-write/read-and-filter`), optionally with a section's anchor (`guides/read-and-write/read-and-filter#compare-values-with-operators`)." },
        section: { type: "string", description: "The anchor of a section of the page, instead of `#anchor` in `path`." },
        offset: { type: "integer", minimum: 0, description: "The character to start from, to read on after a cut (the note at the cut gives it)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { title: "Read Docs", ...READ_ONLY },
  },
  {
    name: "search_docs",
    description:
      'Search the Datanotes documentation of this version for the sections on a topic, best first: each with the path to pass to read_docs (`guides/read-and-write/read-and-filter#compare-values-with-operators`), its page and heading, and a short excerpt. Words in a heading count most; a word matches in any form (`rows`, `row`) and its synonyms too (`revert` for `undo`). Syntax: a quoted phrase ("time travel") or a +term (`+view`) must appear in a section, a -term (`-sql`) must not; the other words only rank. When the engine has semantic search on, the sections are also ranked by meaning and the two rankings are fused (hybrid search): each hit then says which matched, keyword or semantic.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'A few words of the topic: `filter rows by date`, `undo a write`, `"time travel" +view -sql`.' },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "The most sections to return." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { title: "Search Docs", ...READ_ONLY },
  },
];

const DOCS_NAMES = new Set<string>(DOCS_TOOL_NAMES);

function checkDocsNames(names: readonly string[] | undefined, option: string): void {
  for (const n of names ?? []) if (!DOCS_NAMES.has(n)) throw new Error(`${option}: "${n}" is not a docs tool`);
}

function keptDocs(name: string, filter: EngineToolFilter): boolean {
  return DOCS_NAMES.has(name) && (!filter.only || filter.only.includes(name)) && !filter.except?.includes(name);
}

/**
 * The tools that read the Datanotes documentation of this version, shipped in the package
 * (`list_docs`, `read_docs`, `search_docs`), as MCP tool definitions: fresh copies, kept by the
 * same filter as engineTools (unknown names throw). They need no engine: callDocsTool answers them.
 */
export function docsTools(filter: EngineToolFilter = {}): EngineTool[] {
  checkDocsNames(filter.only, "only");
  checkDocsNames(filter.except, "except");
  return DOCS_TOOLS.filter((t) => keptDocs(t.name, filter)).map((t) => JSON.parse(JSON.stringify(t)) as EngineTool);
}

/** Is this the name of a docs tool (kept by the filter, when one is given)? */
export function isDocsTool(name: string, filter: EngineToolFilter = {}): boolean {
  return keptDocs(name, filter);
}

const text = (s: string): ToolContent => ({ content: [{ type: "text", text: s }] });

/** How long search_docs waits for the engine's ranking of the docs by meaning, before it ranks by words alone. */
export const SEMANTIC_DOCS_TIMEOUT_MS = 10_000;

/** After an engine did not answer (or not in time), how long search_docs ranks by words alone before it asks it again. */
export const SEMANTIC_DOCS_RETRY_MS = 60_000;

/** The engines that did not answer, by address: until when search_docs does not ask them. */
const silentEngines = new Map<string, number>();

/** What the engine answers on `POST /datanotes/manual/search/`. */
interface SemanticDocsAnswer {
  version: string;
  ready: boolean;
  results: { path: string; score: number }[];
}

/** How search_docs reaches the engine for its ranking by meaning (hybrid search). */
export interface DocsSearchOptions {
  /** The engine: with semantic search on, search_docs fuses its ranking by meaning with the ranking by words. */
  client?: DatanotesClient;
  /** Who asks, as for engine tools (default: the client's own actor). */
  actor?: ActorInfo;
  /** How long to wait for the engine (default SEMANTIC_DOCS_TIMEOUT_MS). */
  semanticTimeoutMs?: number;
}

/**
 * The engine's ranking of the docs by meaning, best first; null when there is none to fuse: the
 * engine has semantic search off, is older than this route, still builds the index, ships docs of
 * another version, or does not answer in time (then it is left alone for SEMANTIC_DOCS_RETRY_MS).
 */
async function semanticRanking(docs: DocsLibrary, query: string, opts: DocsSearchOptions & { client: DatanotesClient }): Promise<readonly { path: string }[] | null> {
  const url = opts.client.url;
  if ((silentEngines.get(url) ?? 0) > Date.now()) return null;
  const request = opts.client.post<SemanticDocsAnswer>("/manual/search/", { query: parseQuery(query).text, limit: FUSION_DEPTH }, opts.actor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), opts.semanticTimeoutMs ?? SEMANTIC_DOCS_TIMEOUT_MS)));
  let answer: SemanticDocsAnswer | "late" | "unreachable" | null;
  try {
    answer = await Promise.race([request, late]);
  } catch (e) {
    // the client throws DatanotesError only: "unreachable" when the engine does not answer
    answer = (e as DatanotesError).kind === "unreachable" ? "unreachable" : null;
  }
  clearTimeout(timer);
  if (answer === "late" || answer === "unreachable") {
    silentEngines.set(url, Date.now() + SEMANTIC_DOCS_RETRY_MS);
    return null;
  }
  // an answer that is no JSON object (another program at that address) has no ranking either
  return answer?.ready && answer.version === docs.version() ? answer.results : null;
}

/** search_docs: the sections by words, fused with the engine's ranking by meaning when it has one. */
async function searchDocs(docs: DocsLibrary, args: Record<string, unknown>, opts: DocsSearchOptions): Promise<string> {
  const query = args.query as string;
  const limit = (args.limit as number | undefined) ?? 8;
  // by words first: a query without words is refused before the engine is asked
  const byWords = docs.search(query, limit);
  const byMeaning = opts.client ? await semanticRanking(docs, query, { ...opts, client: opts.client }) : null;
  const hits = byMeaning ? docs.hybrid(query, byMeaning, limit) : byWords;
  if (hits.length === 0) {
    const q = parseQuery(query);
    const filters = q.required.length + q.excluded.length > 0 ? " A section must hold every quoted phrase and +term, and none of the -terms: try fewer of them," : " Try";
    return `No section matches "${query}".${filters} other words, or list_docs to see the pages.`;
  }
  const lines = hits.map((h) => `${h.path} — ${h.page}${h.section ? ` › ${h.section}` : ""}${byMeaning ? ` (${h.signals.join(", ")})` : ""}\n  ${h.excerpt}`);
  return [...lines, `${byMeaning ? "Ranked by words and by meaning (hybrid search). " : ""}Read one with read_docs("<path>").`].join("\n");
}

function answerDocs(docs: DocsLibrary, name: string, args: Record<string, unknown>): string {
  if (name === "list_docs") {
    const pages = docs.list((args.prefix as string | undefined) ?? "");
    return [`${pages.length} pages. Read one with read_docs("<path>").`, ...pages.map((p) => `${p.path}: ${p.title}${p.description ? ` — ${p.description}` : ""}`)].join("\n");
  }
  return docs.read(args.path as string, { section: (args.section as string | undefined) ?? null, offset: (args.offset as number | undefined) ?? 0 });
}

/**
 * Answer a docs tool for an agent (MCP content): text, or an error result (`isError`) that says
 * what is wrong (an unknown page or section, with the closest real ones), how to fix it and where
 * to read more; never a throw. `docs`: the docs to read (default: the package's own, `openDocs()`).
 * `client`: the engine, for search_docs' hybrid search (without it, or when the engine has no
 * ranking by meaning to give, search_docs ranks by words alone).
 */
export async function callDocsTool(name: string, args: Record<string, unknown> = {}, opts: EngineToolFilter & DocsSearchOptions & { docs?: DocsLibrary } = {}): Promise<ToolContent> {
  if (!keptDocs(name, opts)) {
    const p = unknownTool(name, DOCS_TOOL_NAMES.filter((n) => keptDocs(n, opts)));
    return toolContent(false, guidedText(p.message, p));
  }
  const def = DOCS_TOOLS.find((t) => t.name === name)!;
  const problem = checkToolArguments(name, def.inputSchema, args, OFFLINE_DOCS);
  if (problem) return toolContent(false, guidedText(problem.message, problem));
  try {
    const docs = opts.docs ?? openDocs();
    return text(name === "search_docs" ? await searchDocs(docs, args, opts) : answerDocs(docs, name, args));
  } catch (e) {
    if (e instanceof DocsError) return toolContent(false, guidedText(e.message, e));
    throw e;
  }
}
