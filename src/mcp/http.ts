/**
 * MCP over Streamable HTTP at `/mcp`, for agents that connect by address (hosted assistants, a
 * phone, several clients at once). Every request needs `Authorization: Bearer <token>`: the
 * agent's own Datanotes token (a named token), passed to the engine on each call, so the engine
 * checks its permissions and records it. `GET /` answers the status without a token.
 * Refused requests and sessions opened/closed go to the toolbox's log (never the token).
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { DatanotesError } from "../api/client";
import { DOCS_BASE } from "../api/guidance";
import { createSession } from "./server";
import type { Toolbox } from "./tools";

const MAX_BODY = 20 * 1024 * 1024;

/** How to fix a refused connection, and where to read more (`hint`, `docs` next to `error`). */
const HTTP_HINT = { hint: "The MCP endpoint is POST /mcp (Streamable HTTP); GET / reports the server's status.", docs: `${DOCS_BASE}/start/connect-agents.md#serve-agents-over-http` };
const TOKEN_HINT = { hint: "Send a Datanotes token the engine knows (the owner's, or a named one) as Authorization: Bearer <token>.", docs: `${DOCS_BASE}/start/connect-agents.md#give-each-agent-its-own-token` };
const ENGINE_HINT = { hint: "The MCP server cannot reach the engine: start it (datanotes serve --database <folder>) or check --url.", docs: `${DOCS_BASE}/start/connect-agents.md#how-the-mcp-server-reaches-the-engine` };
const TOKEN_TTL_MS = 60_000;
const SESSION_IDLE_MS = 24 * 3600_000;

export interface HttpOptions {
  toolbox: Toolbox;
  host: string;
  port: number;
  version: string;
  /** A session unused this long is closed (default a day). */
  idleMs?: number;
  /** How often idle sessions are looked for (default an hour). */
  sweepMs?: number;
  /** Largest request body, bytes (default 20 MB). */
  maxBody?: number;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Some clients open the session with a sparse `initialize` (no capabilities, no client version);
 * fill what the protocol requires instead of refusing them.
 */
export function lenientInitialize(body: unknown): unknown {
  const m = body as { method?: unknown; params?: Record<string, unknown> } | null;
  if (!m || typeof m !== "object" || Array.isArray(m) || m.method !== "initialize") return body;
  const params = m.params ?? {};
  const info = (params.clientInfo ?? {}) as Record<string, unknown>;
  return {
    ...m,
    params: {
      ...params,
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: params.capabilities ?? {},
      clientInfo: { ...info, name: typeof info.name === "string" ? info.name : "unknown", version: typeof info.version === "string" ? info.version : "0" },
    },
  };
}

function bearer(req: http.IncomingMessage): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return m ? m[1]! : null;
}

export async function startHttp(o: HttpOptions): Promise<{ port: number; close(): Promise<void> }> {
  const idleMs = o.idleMs ?? SESSION_IDLE_MS;
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; seen: number }>();
  const accepted = new Map<string, number>();
  const log = o.toolbox.log;

  /** Answer an error and log why the request was refused. */
  const refuse = (req: http.IncomingMessage, res: http.ServerResponse, status: number, reason: string, body: unknown, session?: string) => {
    log("WARN", `refused ${req.method} /mcp: ${status} ${reason}`, { status, reason, method: req.method, session: session?.slice(0, 16) });
    send(res, status, body);
  };

  /** Forget a session, logging it once (closed by the client, expired, or the server stopping). */
  const drop = (id: string, reason: string) => {
    if (sessions.delete(id)) log("INFO", `session closed: ${reason}`, { session: id.slice(0, 16), reason, open_sessions: sessions.size });
  };

  /** Is this a Datanotes token? Asked to the engine, remembered for a minute. */
  const check = async (token: string): Promise<"ok" | "refused" | "unreachable"> => {
    const at = accepted.get(token);
    if (at && Date.now() - at < TOKEN_TTL_MS) return "ok";
    try {
      await o.toolbox.client(token).post("/database/");
      accepted.set(token, Date.now());
      return "ok";
    } catch (e) {
      if (e instanceof DatanotesError && e.kind === "auth") return "refused";
      if (e instanceof DatanotesError && e.kind === "unreachable") return "unreachable";
      accepted.set(token, Date.now()); // the engine answered and knew the token
      return "ok";
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url as string, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        send(res, 200, { status: "OK", service: "datanotes-mcp", version: o.version, engine: await o.toolbox.client("-").ping() });
        return;
      }
      if (url.pathname !== "/mcp") return send(res, 404, { error: "not found", ...HTTP_HINT });
      const token = bearer(req);
      // no WWW-Authenticate: clients would start an OAuth flow this server does not offer
      if (!token) return refuse(req, res, 401, "missing bearer token", { error: "missing bearer token", ...TOKEN_HINT });
      const verdict = await check(token);
      if (verdict === "refused") return refuse(req, res, 401, "token refused by Datanotes", { error: "token refused by Datanotes", ...TOKEN_HINT });
      if (verdict === "unreachable") return refuse(req, res, 502, "Datanotes engine unreachable", { error: "Datanotes engine unreachable", ...ENGINE_HINT });
      (req as http.IncomingMessage & { auth?: unknown }).auth = { token, clientId: "datanotes", scopes: [] };

      // a repeated header arrives joined into one string (not one of Node's array headers)
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let body: unknown;
      if (req.method === "POST") {
        try {
          body = JSON.parse(await readBody(req, o.maxBody ?? MAX_BODY));
        } catch {
          return refuse(req, res, 400, "parse error", { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, sessionId);
        }
      }
      body = lenientInitialize(body);
      const known = sessionId ? sessions.get(sessionId) : undefined;
      if (known) {
        known.seen = Date.now();
        await known.transport.handleRequest(req, res, body);
        return;
      }
      if (sessionId) return refuse(req, res, 404, "session not found", { jsonrpc: "2.0", id: null, error: { code: -32001, message: "session not found" } }, sessionId);
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return refuse(req, res, 400, "no session: start with initialize", { jsonrpc: "2.0", id: null, error: { code: -32000, message: "start with initialize (no session)" } });
      }
      const client = body.params.clientInfo;
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, seen: Date.now() });
          log("INFO", `session opened: ${client.name} ${client.version}`, { session: id.slice(0, 16), harness: client.name, harness_version: client.version, open_sessions: sessions.size });
        },
        onsessionclosed: (id) => drop(id, "closed by the client"),
      });
      transport.onclose = () => {
        if (transport.sessionId) drop(transport.sessionId, "transport closed");
      };
      const session = createSession({ toolbox: o.toolbox, instructions: o.toolbox.instructions(), token: (t) => t as string, version: o.version }); // every request carries its token (req.auth)
      await session.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((e: unknown) => {
      const message = (e as Error).message;
      log("ERROR", `request failed: ${message}`, { method: req.method, path: req.url?.split("?")[0], error: message.slice(0, 300) });
      if (!res.headersSent) send(res, 500, { error: message });
    });
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) {
      if (s.seen >= cutoff) continue;
      drop(id, "expired");
      void s.transport.close();
    }
  }, o.sweepMs ?? 3600_000);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      clearInterval(sweep);
      for (const [id, s] of sessions) {
        drop(id, "server stopped");
        await s.transport.close();
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
