/**
 * One MCP session: a low-level MCP `Server` whose tools come from the Toolbox. The token used
 * for the engine is the agent's (HTTP: the request's bearer token; stdio: the one configured).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ActorInfo } from "../api/client";
import type { Toolbox } from "./tools";

export interface SessionOptions {
  toolbox: Toolbox;
  instructions: string;
  /** The token for this request: from the HTTP request (`authInfo`), or the configured one. */
  token: (authToken: string | undefined) => string;
  version: string;
  /** The session when the transport has none (stdio): one per process. */
  session?: string;
}

export function createSession(o: SessionOptions): Server {
  const server = new Server({ name: "datanotes", version: o.version }, { capabilities: { tools: { listChanged: false } }, instructions: o.instructions });
  const actor = (sessionId: string | undefined): ActorInfo => {
    // after initialize, which names the client (sparse ones are completed: http.ts lenientInitialize)
    const client = server.getClientVersion()!;
    // HTTP: the transport's session; stdio: the process's
    const session = (sessionId ?? o.session)!;
    return { harness: client.name, harness_version: client.version, session: session.slice(0, 16) };
  };
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: o.toolbox.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    // a client that traces sends its trace context in `_meta` (W3C traceparent / tracestate)
    return o.toolbox.call(o.token(extra.authInfo?.token), req.params.name, args, actor(extra.sessionId), req.params._meta);
  });
  return server;
}
