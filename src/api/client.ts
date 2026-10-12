/**
 * A client of the Datanotes HTTP API, with no dependency: it runs in Node, in browsers and in
 * Obsidian (pass Obsidian's `requestUrl` as the transport). `call` runs an operation of the
 * catalogue by name, the way agents name them; `request` reaches any route.
 */

import { operationRequest, OperationInputError } from "./requests.js";
import { resultOf, type OperationResult } from "./results.js";
import { checkArguments, DOCS_BASE, guidanceIn, guidedText, type Guidance } from "./guidance.js";

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** Who is calling, recorded with every write (header `X-Datanotes-Actor`). Self-reported. */
export interface ActorInfo {
  /** The program: "claude-code", "cursor", a program's own name. */
  harness?: string;
  harness_version?: string;
  model?: string;
  /** The agent's session (the engine remembers the model an MCP server reports for it). */
  session?: string;
  /** The tool the agent called, when the call comes from an MCP server. */
  tool?: string;
}

export const ACTOR_HEADER = "X-Datanotes-Actor";

/** What to do when the engine does not answer, or refuses the token. */
const UNREACHABLE: Guidance = {
  hint: "Start the engine (datanotes serve --database <folder>) or check its address; datanotes status --database <folder> shows whether it runs and where.",
  docs: `${DOCS_BASE}/start/connect-agents.md#how-the-mcp-server-reaches-the-engine`,
};
const AUTH: Guidance = {
  hint: "Send the engine's owner token (httpServerToken in settings.json in the engine's store: datanotes store path shows where) or a named token the owner made with POST /datanotes/tokens/create/, as Authorization: Bearer <token>.",
  docs: `${DOCS_BASE}/develop/http-api.md#authenticate-your-requests`,
};

export class DatanotesError extends Error {
  override readonly name = "DatanotesError";
  /** How to fix it, and where to read more (also at the end of the message). */
  readonly hint?: string;
  readonly docs?: string;
  /** `unreachable`: the engine did not answer; `auth`: the token was refused. */
  constructor(message: string, readonly kind: "unreachable" | "auth" | "http" = "http", readonly status = 0, guidance: Guidance | null = kind === "unreachable" ? UNREACHABLE : kind === "auth" ? AUTH : null) {
    super(guidedText(message, guidance));
    if (guidance) {
      this.hint = guidance.hint;
      this.docs = guidance.docs;
    }
  }
}

export interface ClientOptions {
  /** The engine's address, e.g. `http://127.0.0.1:27150`. */
  url: string;
  token: string;
  /** Recorded with every write unless a call names another actor. */
  actor?: ActorInfo;
  transport?: Transport;
}

/** One tool call by an agent (an engine operation, or a tool of the MCP server's own), for the engine's change feed. */
export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  duration_ms: number;
  value: unknown;
  /** Who served it: "engine", or the name of the MCP server whose own tool it is. */
  served_by: string;
  session?: string;
  result_chars?: number;
  result_tokens?: number;
}

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) });
  return { status: res.status, text: await res.text() };
};

/** A body the engine sends: a JSON object with `ok` (an operation's result) or `error` (an error). */
function isEngineAnswer(json: unknown): boolean {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
  const o = json as Record<string, unknown>;
  return typeof o.ok === "boolean" || typeof o.error === "string";
}

function parse(text: string): unknown {
  try {
    return text.trim() ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

export class DatanotesClient {
  readonly url: string;
  private readonly send: Transport;

  constructor(private readonly o: ClientOptions) {
    this.url = o.url.replace(/\/+$/, "");
    this.send = o.transport ?? fetchTransport;
  }

  /** Send a request; the answer's status, its JSON (when it is JSON) and its text. */
  async request(method: "GET" | "POST", path: string, body?: unknown, opts: { actor?: ActorInfo; accept?: string } = {}): Promise<{ status: number; json: unknown; text: string }> {
    if (!this.url) throw new DatanotesError("engine address not set", "unreachable");
    if (!this.o.token) throw new DatanotesError("token not set", "auth");
    const actor = opts.actor ?? this.o.actor;
    let res: HttpResponse;
    try {
      res = await this.send({
        url: `${this.url}${path}`,
        method,
        headers: {
          Authorization: `Bearer ${this.o.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.accept ? { Accept: opts.accept } : {}),
          ...(actor && Object.keys(actor).length ? { [ACTOR_HEADER]: JSON.stringify(actor) } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new DatanotesError(`engine unreachable at ${this.url}: ${e instanceof Error ? e.message : String(e)}`, "unreachable");
    }
    if (res.status === 401) throw new DatanotesError("token refused by the engine", "auth", 401);
    const json = parse(res.text);
    // 503 is also the engine's own answer (a write rolled back, the engine stopping, a service off):
    // only a body that is no engine answer means a proxy answered for an engine it cannot reach
    const unreachable = res.status === 0 || res.status === 502 || res.status === 504 || (res.status === 503 && !isEngineAnswer(json));
    if (unreachable) throw new DatanotesError(`engine unreachable at ${this.url} (HTTP ${res.status})`, "unreachable", res.status);
    return { status: res.status, json, text: res.text };
  }

  /** `POST /datanotes/<route>` and its JSON answer; throws on an error status. */
  async post<T = unknown>(route: string, body: unknown = {}, actor?: ActorInfo): Promise<T> {
    const r = await this.request("POST", `/datanotes${route}`, body, actor ? { actor } : {});
    // the message ends with the engine's hint and docs: `guidance` only sets the fields
    if (r.status >= 400) throw Object.assign(new DatanotesError(resultOf(r.status, r.json, r.text).value as string, "http", r.status), guidanceIn(r.json));
    return r.json as T;
  }

  /**
   * Run an operation of the catalogue (`select_rows`, `insert_row`, …) with an agent's arguments.
   * Arguments the operation does not take, or of the wrong type, are refused before anything is sent,
   * with the same message the engine gives.
   */
  async call(name: string, args: Record<string, unknown> = {}, actor?: ActorInfo): Promise<OperationResult> {
    let req;
    try {
      req = operationRequest(name, args);
    } catch (e) {
      if (e instanceof OperationInputError) return { ok: false, value: e.message };
      throw e;
    }
    const problem = checkArguments(name, args);
    if (problem) return { ok: false, value: guidedText(problem.message, problem) };
    const r = await this.request(req.method, req.path, req.body, actor ? { actor } : {});
    return resultOf(r.status, r.json, r.text);
  }

  /** True when the engine answers `GET /` (no token needed). */
  async ping(): Promise<boolean> {
    try {
      const r = await this.send({ url: `${this.url}/`, method: "GET", headers: {} });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  /** Record an agent's tool call in the change feed (what MCP servers report). */
  async recordToolCall(call: ToolCallRecord, actor?: ActorInfo): Promise<void> {
    await this.post("/tool-calls/record/", call, actor);
  }
}
