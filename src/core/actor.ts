/**
 * Who is making the current request: the agent behind a REST call (sent by the MCP server in the
 * `X-Datanotes-Actor` header: session, harness, model). It is kept for the duration of the
 * request with AsyncLocalStorage, so the journal entry and the transaction-log commit of every
 * write record it without passing it through each operation. Hand edits and commands run outside a
 * request: no actor.
 *
 * AsyncLocalStorage needs Node (desktop Obsidian, where the Local REST API runs); elsewhere
 * requests simply carry no actor.
 */

export interface Actor {
  /** MCP session id. */
  session?: string;
  /** The app running the agent (MCP clientInfo, e.g. "claude-code", "Anthropic/ClaudeAI"). */
  harness?: string;
  harness_version?: string;
  /** Model id as reported by the agent (identify_session). */
  model?: string;
  /** Tool the agent called. */
  tool?: string;
  /**
   * The credential the request came with, set by the server (never taken from the header):
   * "owner" for the owner's token, else the name of the token. The other fields are self-reported.
   */
  auth?: string;
}

export const ACTOR_HEADER = "x-datanotes-actor";

interface Storage {
  run<R>(store: Actor, fn: () => R): R;
  getStore(): Actor | undefined;
}

let storage: Storage | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require("node:async_hooks") as { AsyncLocalStorage: new () => Storage };
  storage = new AsyncLocalStorage();
} catch {
  storage = null;
}

const KEYS: (keyof Actor)[] = ["session", "harness", "harness_version", "model", "tool"];

/** Parse the header value (JSON object); unknown keys and non-strings are dropped. */
export function parseActor(raw: unknown): Actor | undefined {
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== "string" || text.trim() === "") return undefined;
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const out: Actor = {};
    for (const k of KEYS) {
      const v = obj[k];
      if (typeof v === "string" && v.trim() !== "") out[k] = v.trim().slice(0, 200);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function runWithActor<R>(actor: Actor | undefined, fn: () => R): R {
  return actor && storage ? storage.run(actor, fn) : fn();
}

export function currentActor(): Actor | undefined {
  return storage?.getStore();
}

/** "harness / model" (and "via <token>" for a named token), for the transaction log's userName. */
export function actorName(a: Actor | undefined): string | undefined {
  if (!a) return undefined;
  const parts = [a.harness, a.model].filter((x): x is string => !!x);
  const name = parts.length > 0 ? parts.join(" / ") : a.session;
  const token = a.auth && a.auth !== "owner" ? a.auth : undefined;
  if (token && token !== a.harness) return name ? `${name} via ${token}` : token;
  return name;
}
