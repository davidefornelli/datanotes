/**
 * The engine's HTTP server, so programs (MCP servers, apps, scripts) reach the database. Their
 * client: `src/api/` (`datanotes/client`).
 *
 * - `POST /datanotes/operations/<name>/`: every operation of the catalogue, its body the
 *   operation's arguments (`rest.ts` handlers).
 * - `/datanotes/*`: the engine's other routes (status, stop, tokens, sessions, tool calls, the
 *   change feed's stream), from the runtime.
 * - `GET /`: status, without authentication.
 * - `GET /datanotes/manual/` (an index) and `GET /datanotes/manual/<page>.md` (`?section=<anchor>` for one
 *   section): the Markdown docs of this version, shipped with the package (src/api/docs.ts).
 * - `GET /datanotes/openapi.json` (the OpenAPI document) and `GET /datanotes/docs` (Swagger UI
 *   over it, `docs-ui.ts`): without authentication too; they describe the API and hold no data.
 *
 * Every other request needs `Authorization: Bearer <token>`: the owner's token, or a named token
 * (its requests carry its name as `actor.auth` and are checked against its permissions, see
 * `tokens.ts`). It listens on 127.0.0.1
 * unless told otherwise, and answers no CORS preflight, so web pages cannot call it.
 */

import { gzip } from "node:zlib";
import type { App } from "../core/host";
import { ACTOR_HEADER, parseActor, runWithActor } from "../core/actor";
import { ROUTE_PREFIX, dispatch as plainDispatch, operationOf, type Handler, type HandlerResponse } from "./rest";
import { CALLABLE_OPERATIONS } from "../api/requests";
import type { Actor } from "../core/actor";
import { telemetry } from "../core/telemetry";
import { activeSpan, tracingOn, withSpan } from "../core/tracing";
import { parseTraceparent, TRACEPARENT_HEADER, TRACESTATE_HEADER } from "../api/tracing";
import type { SessionIdentities } from "./identities";
import { opOfKind, wireEvent, type ChangeFeed } from "../core/change-feed";
import { docsResponse } from "./docs-ui";
import { openApiDocument } from "./openapi";
import { messageOf } from "../core/message";
import { closestNames, guide, GuidedError, type Guidance } from "../core/hints";
import { DocsError, openDocs, type DocsLibrary } from "../api/docs";
import { READ_SCOPE_SUPPORTED, type ReadScope } from "../core/read-scope";
// the stream refuses a restricted token where no read scope can be carried as the permission guard does
// (tokens.ts imports this module too: the two constants are read only when a request arrives)
import { READ_SCOPE_UNSUPPORTED, READ_SCOPE_UNSUPPORTED_HINT } from "./token-routes";


/** Why the server cannot listen on its address, and how to fix it; `code` is the system's (`EADDRINUSE`...). */
export class ListenError extends GuidedError {
  constructor(
    message: string,
    readonly code: string | undefined,
    g: Guidance,
  ) {
    super(message, g);
  }
}

/** How to listen elsewhere. */
const OTHER_PORT = "start the engine on another port: --port <port> from 1024 to 65535, or --port 0 for any free port.";

/** The error of a server that could not listen on `host:port`, with what to do about it. */
export function listenError(e: Error & { code?: string }, host: string, port: number): ListenError {
  const where = `${host}:${port}`;
  switch (e.code) {
    case "EADDRINUSE":
      return new ListenError(`port ${port} is already in use (${where})`, e.code, guide(`Another program holds the port, often another engine. Stop that program, or ${OTHER_PORT}`, "port"));
    case "EACCES":
      return new ListenError(
        `the system does not let the engine listen on ${where} (EACCES)`,
        e.code,
        guide(`The system reserves the port: ${OTHER_PORT} On Windows, netsh interface ipv4 show excludedportrange protocol=tcp lists the reserved ports.`, "port"),
      );
    case "EADDRNOTAVAIL":
    case "ENOTFOUND":
      return new ListenError(`${host} is not an address of this machine (${e.code})`, e.code, guide("Give --host an address of this machine: 127.0.0.1 for this computer only, or 0.0.0.0 for every network interface.", "port"));
    default:
      return new ListenError(`the HTTP server cannot listen on ${where}: ${e.message}`, e.code, guide(`Check --host and --port, or ${OTHER_PORT}`, "port"));
  }
}

/** Routes that only POST reaches: they change the engine's state. */
const POST_ONLY = new Set(["/stop/"]);
const STOP_POST_HINT = guide("Send POST /datanotes/stop/ with the owner token, or run datanotes stop --vault <folder>.", "stop");
const STOPPING_HINT = guide("Wait until the engine has stopped, then start it again (datanotes serve) and repeat the request.", "stop");

const AUTH_HINT = guide(
  "Send the owner token (httpServerToken in settings.json in the engine's store: datanotes store path shows where) or a named token as Authorization: Bearer <token>; the owner creates named tokens with POST /datanotes/tokens/create/.",
  "auth",
);
const ROUTES_HINT = guide("Call an operation with POST /datanotes/operations/<name>/ and its arguments as a JSON object; GET /datanotes/openapi.json lists the routes, GET /datanotes/docs explains them.", "routes");

const MAX_BODY = 20 * 1024 * 1024;
const MARKDOWN = "text/markdown; charset=utf-8";
/** The docs of this version, as Markdown (`/datanotes/docs` is the API console). */
export const MANUAL_PATH = `${ROUTE_PREFIX}/manual`;

interface NodeReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Where the request comes from (Node's `IncomingMessage.socket`). */
  socket?: { remoteAddress?: string };
  on(ev: "data", cb: (chunk: Uint8Array) => void): void;
  on(ev: "end" | "error", cb: (e?: unknown) => void): void;
  destroy(): void;
}
interface NodeRes {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(body?: string | Uint8Array): void;
  write?(chunk: string): boolean;
  flushHeaders?(): void;
  on?(ev: "close" | "finish", cb: () => void): void;
}
interface NodeSocket {
  destroy(): void;
  on(ev: "close", cb: () => void): void;
}
interface NodeServer {
  listen(port: number, host: string, cb: () => void): void;
  on(ev: "error", cb: (e: Error & { code?: string }) => void): void;
  on(ev: "connection", cb: (socket: NodeSocket) => void): void;
  close(cb?: () => void): void;
  closeAllConnections?(): void;
  /** A TCP server that is listening: never a pipe name (string) nor null. */
  address(): { port: number };
}
type CreateServer = (handler: (req: NodeReq, res: NodeRes) => void) => NodeServer;

export interface HttpServerOptions {
  app: App;
  handlers: Record<string, Handler>;
  token: string;
  port: number;
  host?: string;
  version?: string;
  /** Injected in tests; the service uses Node's `http` module. */
  createServer?: CreateServer;
  /** What agents reported about their sessions: added to the actor of their requests. */
  identities?: SessionIdentities;
  /** The change feed, for `GET /datanotes/changes/stream` (Server-Sent Events). */
  changeFeed?: () => ChangeFeed | null;
  /**
   * The read scope of a named token, by name (the runtime: `tokens.ts` `scopeOf`): the change
   * stream, answered outside the permission guard, sends it only the events it may read.
   */
  readScopeOf?: (tokenName: string) => ReadScope | null;
  /** Whether a read scope can be enforced (default: READ_SCOPE_SUPPORTED); a test seam. */
  readScopeSupported?: boolean;
  /** Named tokens: they are accepted too (see `tokens.ts`). */
  tokens?: { authenticate(token: string): Promise<{ name: string } | null> };
  /** Runs a route handler (default: `rest.ts` dispatch; the runtime passes one that checks the tokens' permissions). */
  dispatch?: (route: string, handler: Handler, body: unknown) => Promise<HandlerResponse>;
  /** The docs `GET /datanotes/manual/` serves (default: the package's own). */
  docs?: DocsLibrary;
  /** Which clients get large answers compressed (the `httpCompression` setting); default: none. */
  compression?: () => HttpCompression;
}

/** `remote`: clients on other machines that accept gzip; `always`: this machine's too; `off`: none. */
export type HttpCompression = "remote" | "always" | "off";

/** Answers this long or longer (characters) are compressed for a client that may get them so. */
export const GZIP_MIN_CHARS = 16_384;

/** The responses to compress: decided per request, from its `Accept-Encoding` and its origin. */
const GZIP = new WeakSet<object>();

/** Whether an `Accept-Encoding` header accepts gzip (`gzip`, `x-gzip` or `*`, with a quality above 0). */
export function acceptsGzip(header: string | undefined): boolean {
  let named: number | undefined;
  let any: number | undefined;
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    if (name === "gzip" || name === "x-gzip") named = quality;
    else if (name === "*") any = quality;
  }
  return (named ?? any ?? 0) > 0;
}

/** An address of this machine (IPv4 127.0.0.0/8, IPv6 ::1, or IPv4 written as IPv6). */
export function isLoopback(address: string | undefined): boolean {
  const a = (address ?? "").replace(/^::ffff:/i, "");
  return a.startsWith("127.") || a === "::1";
}

function send(res: NodeRes, status: number, body: unknown, type = "application/json", headers: Record<string, string> = {}, text?: string): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.statusCode = status;
  res.setHeader("Content-Type", type === "application/json" ? "application/json; charset=utf-8" : type);
  // `text`: the body already serialized (a cached read), sent as it is
  const out = text ?? (type === "application/json" ? JSON.stringify(body) : String(body));
  if (!GZIP.has(res) || out.length < GZIP_MIN_CHARS) {
    res.end(out);
    return;
  }
  // compressed off the event loop (the thread pool), quickly: JSON shrinks well at a low level
  gzip(out, { level: 3 }, (e, zipped) => {
    /* v8 ignore next 4 -- defensive: zlib fails only without memory; the answer then goes as it is */
    if (e) {
      res.end(out);
      return;
    }
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.end(zipped);
  });
}

function header(req: NodeReq, name: string): string | undefined {
  // Node gives a list only for set-cookie, which no route reads; other repeated headers are joined or the first kept
  return req.headers[name.toLowerCase()] as string | undefined;
}

/** Constant-time comparison of two strings: the same work whatever their lengths (up to 512). */
function sameToken(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(512, a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function readBody(req: NodeReq): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const all = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.length;
      }
      resolve(new TextDecoder().decode(all));
    });
    req.on("error", reject);
  });
}

export class HttpApiServer {
  private server: NodeServer | null = null;
  /** Open connections (keep-alive clients would otherwise hold the port after stop). */
  private sockets = new Set<NodeSocket>();
  /** The OpenAPI document, built on first request. */
  private spec: Record<string, unknown> | null = null;
  /** Requests being answered (the change stream left out: it lasts as long as its client). */
  private inFlight = 0;
  private idleWaiters: (() => void)[] = [];
  /** Set by `drain`: new requests are answered 503, the engine is stopping. */
  private draining = false;

  constructor(private readonly opts: HttpServerOptions) {}

  /**
   * Resolves with the bound port once listening. A busy port is retried a few times: when the
   * engine restarts, the previous instance may still be closing. Rejects with a {@link ListenError}.
   */
  async start(retries = 6, delayMs = 500): Promise<number> {
    for (let i = 0; ; i++) {
      try {
        return await this.listenOnce();
      } catch (e) {
        if (i >= retries || !(e instanceof ListenError) || e.code !== "EADDRINUSE") throw e;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  private listenOnce(): Promise<number> {
    const create =
      this.opts.createServer ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ((h: (req: NodeReq, res: NodeRes) => void) => (require("http") as { createServer: CreateServer }).createServer(h));
    const server = create((req, res) => this.track(req, res));
    this.server = server;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    const host = this.opts.host ?? "127.0.0.1";
    return new Promise((resolve, reject) => {
      server.on("error", (e) => reject(listenError(e, host, this.opts.port)));
      server.listen(this.opts.port, host, () => resolve(server.address().port));
    });
  }

  /**
   * Answer a request, counted until its answer is sent (`finish`, or `close` when the client goes
   * first), so `drain` knows when the requests under way are done. The change stream is not
   * counted: it stays open as long as its client.
   */
  private track(req: NodeReq, res: NodeRes): void {
    const mode = this.opts.compression?.() ?? "off";
    if (mode !== "off" && acceptsGzip(header(req, "accept-encoding")) && (mode === "always" || !isLoopback(req.socket?.remoteAddress))) GZIP.add(res);
    const answer = () => this.handle(req, res).catch((e: unknown) => send(res, 500, { error: messageOf(e) }));
    if ((req.method ?? "GET").toUpperCase() === "GET" && /^\/datanotes\/changes\/stream\/?(\?|$)/.test(req.url ?? "")) {
      void answer();
      return;
    }
    this.inFlight++;
    // done once the handler has answered and the answer has gone (a response without events, as
    // the tests' fakes, once the handler has answered)
    let handled = false;
    let sent = !res.on;
    let counted = true;
    const settle = () => {
      if (!handled || !sent || !counted) return;
      counted = false;
      this.inFlight--;
      if (this.inFlight === 0) for (const w of this.idleWaiters.splice(0)) w();
    };
    const gone = () => {
      sent = true;
      settle();
    };
    res.on?.("finish", gone);
    res.on?.("close", gone);
    void answer().finally(() => {
      handled = true;
      settle();
    });
  }

  /**
   * Stop taking requests (new ones are answered 503: the engine is stopping) and wait until the
   * ones under way are answered, at most `timeoutMs`. True when none is left.
   */
  drain(timeoutMs: number): Promise<boolean> {
    this.draining = true;
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== idle);
        resolve(false);
      }, timeoutMs);
      const idle = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.idleWaiters.push(idle);
    });
  }

  /** Requests being answered now. */
  get requestsInFlight(): number {
    return this.inFlight;
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      // Stop listening, then drop open connections at once: clients reconnect to whoever owns the port next.
      s.close(() => resolve());
      s.closeAllConnections?.();
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      setTimeout(resolve, 1000); // never wait longer than this
    });
  }

  /**
   * Answer a request in a SERVER span `<METHOD> <route>` (OpenTelemetry HTTP conventions), which
   * continues the caller's trace when it sends `traceparent`. Not traced: `GET /`, the API's
   * description and console, the change stream (open for hours).
   */
  private handle(req: NodeReq, res: NodeRes): Promise<void> {
    if (!tracingOn()) return this.answer(req, res);
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    const route = this.routeOf(url.pathname);
    if (route === null) return this.answer(req, res);
    const remote = parseTraceparent(header(req, TRACEPARENT_HEADER), header(req, TRACESTATE_HEADER));
    const agent = header(req, "user-agent");
    const socket = (req as { socket?: { remoteAddress?: string; remotePort?: number } }).socket;
    return withSpan(
      route ? `${method} ${route}` : method,
      {
        kind: "server",
        newTrace: true,
        ...(remote ? { remote } : {}),
        attributes: {
          "http.request.method": method,
          "http.route": route || undefined,
          "url.path": url.pathname,
          "url.scheme": "http",
          "network.protocol.name": "http",
          "client.address": socket?.remoteAddress,
          "client.port": socket?.remotePort,
          "user_agent.original": agent,
        },
      },
      async (span) => {
        await this.answer(req, res);
        span.setAttribute("http.response.status_code", res.statusCode);
        if (res.statusCode >= 500) span.setStatus("error", `HTTP ${res.statusCode}`).setAttribute("error.type", String(res.statusCode));
        else if (res.statusCode >= 400) span.setAttribute("error.type", String(res.statusCode));
      },
    );
  }

  /** `http.route` of a path: the route's template, "" for an unknown one, null for those not traced. */
  private routeOf(path: string): string | null {
    if (path === "/" || path === `${ROUTE_PREFIX}/openapi.json` || path === `${ROUTE_PREFIX}/docs` || path.startsWith(`${ROUTE_PREFIX}/docs/`)) return null;
    if (path === `${ROUTE_PREFIX}/changes/stream` || path === `${ROUTE_PREFIX}/changes/stream/`) return null;
    if (path === MANUAL_PATH || path.startsWith(`${MANUAL_PATH}/`)) return `${MANUAL_PATH}/{page}`;
    if (!path.startsWith(`${ROUTE_PREFIX}/`)) return "";
    const route = path.slice(ROUTE_PREFIX.length);
    const key = route.endsWith("/") ? route : `${route}/`;
    return this.opts.handlers[key] ? `${ROUTE_PREFIX}${key}` : "";
  }

  private async answer(req: NodeReq, res: NodeRes): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    if (this.draining) {
      send(res, 503, { error: "the engine is stopping", ...STOPPING_HINT });
      return;
    }
    if (method === "GET" && path === "/") {
      // `auth`: whose token was sent, when one was ("owner", or the named token's name)
      const auth = this.authorized(req) ? "owner" : ((await this.namedTokenOf(req))?.name ?? null);
      send(res, 200, { status: "OK", service: "datanotes", version: this.opts.version ?? "", authenticated: auth !== null, auth });
      return;
    }
    // public: the API's description and its console (no data; the console's calls need a token)
    if (method === "GET" && path === `${ROUTE_PREFIX}/openapi.json`) {
      this.spec ??= openApiDocument(this.opts.version ?? "");
      send(res, 200, this.spec, "application/json", { "Cache-Control": "no-cache" });
      return;
    }
    const docs = method === "GET" ? docsResponse(path, this.opts.version ?? "") : null;
    if (docs) {
      send(res, 200, docs.body, docs.type, docs.headers);
      return;
    }
    // No WWW-Authenticate on 401: clients would start an OAuth flow this server does not offer.
    const owner = this.authorized(req);
    const named = owner ? null : await this.namedTokenOf(req);
    if (!owner && !named) {
      send(res, 401, { error: "missing or wrong bearer token", ...AUTH_HINT });
      return;
    }
    const said = parseActor(header(req, ACTOR_HEADER));
    // what the agent declared for this session (an MCP server reporting it) wins over what the
    // client says by itself (an MCP server sends the client's name from the handshake)
    const known = said?.session ? this.opts.identities?.get(said.session) : undefined;
    const headerActor = said && known ? { ...said, ...known } : said;
    // `auth` is the credential, which the client cannot claim: "owner", or the named token's name;
    // a named token's requests without an agent behind them name the token as the harness too
    const actor: Actor = named ? { ...(headerActor ?? { harness: named.name }), auth: named.name } : { ...(headerActor ?? {}), auth: "owner" };
    // who called: the token's name (never the token), and what the agent says of itself
    activeSpan().setAttributes({
      "datanotes.token.name": actor.auth,
      "datanotes.client.harness": actor.harness,
      "datanotes.client.model": actor.model,
      "datanotes.session": actor.session,
      "gen_ai.tool.name": actor.tool,
    });

    if (method === "GET" && (path === `${ROUTE_PREFIX}/changes/stream` || path === `${ROUTE_PREFIX}/changes/stream/`)) {
      await this.stream(req, res, url, named ? (this.opts.readScopeOf?.(named.name) ?? null) : null);
      return;
    }

    if (method === "GET" && (path === MANUAL_PATH || path.startsWith(`${MANUAL_PATH}/`))) {
      this.manual(res, path.slice(MANUAL_PATH.length).replace(/%2F/gi, "/").replace(/^\/+/, ""), url.searchParams.get("section"));
      return;
    }

    if (path.startsWith(`${ROUTE_PREFIX}/`)) {
      const route = path.slice(ROUTE_PREFIX.length);
      const key = route.endsWith("/") ? route : `${route}/`;
      const handler = this.opts.handlers[key];
      const op = operationOf(key);
      if (!handler) {
        if (op !== undefined || key.startsWith("/operations/")) {
          const near = closestNames(op ?? "", [...CALLABLE_OPERATIONS]);
          send(res, 404, { error: `unknown operation ${op ?? key.slice("/operations/".length).replace(/\/$/, "")}`, ...ROUTES_HINT, ...(near.length > 0 ? { hint: `Did you mean ${near.join(" or ")}? ${ROUTES_HINT.hint}` } : {}) });
          return;
        }
        const near = closestNames(route, Object.keys(this.opts.handlers)).map((r) => `${ROUTE_PREFIX}${r}`);
        send(res, 404, { error: `unknown route ${path}`, ...ROUTES_HINT, ...(near.length > 0 ? { hint: `Did you mean ${near.join(" or ")}? ${ROUTES_HINT.hint}` } : {}) });
        return;
      }
      if (method !== "POST" && method !== "GET") {
        send(res, 405, { error: "use POST", ...ROUTES_HINT });
        return;
      }
      // an operation, or a route that changes the engine's state, never answers GET (a link, a prefetch, a crawler)
      if (method !== "POST" && op !== undefined) {
        send(res, 405, { error: `${method} ${path} does nothing: operations take POST`, ...ROUTES_HINT });
        return;
      }
      if (method !== "POST" && POST_ONLY.has(key)) {
        send(res, 405, { error: `${method} ${path} does nothing: the stop takes POST`, ...STOP_POST_HINT });
        return;
      }
      let body: unknown = undefined;
      if (method === "POST") {
        const text = await readBody(req);
        if (text.trim() !== "") {
          try {
            body = JSON.parse(text);
          } catch {
            send(res, 400, { error: "request body must be JSON", ...ROUTES_HINT });
            return;
          }
        }
      }
      const out = await runWithActor(actor, () => (this.opts.dispatch ?? plainDispatch)(route, handler, body));
      // a cached read carries its JSON text: the answer is not serialized again
      if (out.body !== undefined) send(res, out.status, undefined, "application/json", {}, out.body);
      else send(res, out.status, out.json);
      return;
    }

    telemetry().log("WARN", "datanotes http unknown route", { "http.route": path });
    send(res, 404, { error: `unknown route ${path}`, ...ROUTES_HINT });
  }

  /**
   * The change feed as Server-Sent Events: `id:` = sequence number, `data:` = the event (JSON).
   * Starts after `since` (query) or the `Last-Event-ID` header, so a reconnecting client resumes;
   * same filters as list_changes (`tables`, `kinds`, `columns`: comma-separated; `exclude_actor`;
   * `where`: JSON).
   * A comment line every 25 s keeps proxies from closing the connection.
   */
  private async stream(req: NodeReq, res: NodeRes, url: URL, scope: ReadScope | null): Promise<void> {
    // fail closed, as the permission guard does: a restricted token never gets an unfiltered feed
    if (scope && !(this.opts.readScopeSupported ?? READ_SCOPE_SUPPORTED)) {
      send(res, 503, { error: READ_SCOPE_UNSUPPORTED, ...READ_SCOPE_UNSUPPORTED_HINT });
      return;
    }
    const feed = this.opts.changeFeed?.();
    if (!feed || !res.write) {
      send(res, 503, { error: "the change feed is not available", ...guide("The change feed runs while the engine follows the vault (datanotes serve); list_changes reads it.", "changeFeed") });
      return;
    }
    const list = (k: string) => url.searchParams.get(k)?.split(",").map((x) => x.trim()).filter(Boolean);
    let where: Record<string, unknown> | undefined;
    try {
      where = url.searchParams.get("where") ? (JSON.parse(url.searchParams.get("where")!) as Record<string, unknown>) : undefined;
    } catch {
      send(res, 400, { error: "where must be a JSON object", ...guide(`Pass where as URL-encoded JSON: ?where={"kind":"update"}.`, "changeFeed") });
      return;
    }
    const since = Number(header(req, "last-event-id") ?? url.searchParams.get("since") ?? feed.lastSeq);
    const q = {
      ...(list("tables") ? { tables: list("tables")! } : {}),
      ...(list("kinds") ? { ops: list("kinds")!.map(opOfKind) } : {}),
      ...(list("columns") ? { columns: list("columns")! } : {}),
      ...(url.searchParams.get("exclude_actor") ? { excludeActor: url.searchParams.get("exclude_actor")! } : {}),
      ...(where ? { where } : {}),
    };
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    let open = true;
    res.on?.("close", () => {
      open = false;
    });
    const ping = setInterval(() => open && res.write!(": ping\n\n"), 25_000);
    let cursor = Number.isFinite(since) && since >= 0 ? since : feed.lastSeq;
    res.write(`: datanotes change feed from ${cursor}\n\n`);
    try {
      while (open && this.server && !this.draining) {
        // the token's scope, passed in: the stream runs outside the guard that sets one
        const page = await feed.wait({ ...q, since: cursor, limit: 500 }, 20_000, scope);
        if (!open) break;
        if (page.gap) res.write(`event: gap\ndata: {"since":${cursor}}\n\n`);
        for (const ev of page.events) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(wireEvent(ev))}\n\n`);
        cursor = page.last;
      }
    } finally {
      clearInterval(ping);
      if (open) res.end();
    }
  }

  /** The docs index (`page` empty), a page or one of its sections, as Markdown. */
  private manual(res: NodeRes, page: string, section: string | null): void {
    const docs = this.opts.docs ?? openDocs();
    try {
      if (page === "") send(res, 200, manualIndex(docs), MARKDOWN);
      else send(res, 200, docs.text(page, section).text, MARKDOWN);
    } catch (e) {
      if (!(e instanceof DocsError)) throw e;
      send(res, e.code === "missing" ? 503 : 404, { error: e.message, hint: e.hint, docs: e.docs });
    }
  }

  private bearer(req: NodeReq): string | null {
    const m = /^Bearer\s+(.+)$/i.exec((header(req, "authorization") ?? "").trim());
    return m ? m[1]! : null;
  }

  private authorized(req: NodeReq): boolean {
    const t = this.bearer(req);
    return t !== null && this.opts.token.length > 0 && sameToken(t, this.opts.token);
  }

  private async namedTokenOf(req: NodeReq): Promise<{ name: string } | null> {
    const t = this.bearer(req);
    if (t === null || !this.opts.tokens) return null;
    try {
      return await this.opts.tokens.authenticate(t);
    } catch {
      return null;
    }
  }

}

/** A new random token (hex). */
export function newToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The index of the docs: every page with its description, linked to its route. */
export function manualIndex(docs: DocsLibrary): string {
  const lines = docs.list().map((p) => `- [${p.title}](${MANUAL_PATH}/${p.path}.md)${p.description ? `: ${p.description}` : ""}`);
  return `# Datanotes documentation\n\nThe docs of this engine's version, as Markdown: GET ${MANUAL_PATH}/<page>.md, or one section with ?section=<anchor>.\n\n${lines.join("\n")}\n`;
}
