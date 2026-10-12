/**
 * Secrets out of recorded tool calls. A tool call becomes a `tool_call` event of the change feed,
 * which the engine keeps in its store and the store backup commits and pushes: a webhook's secret
 * or a token returned by a call must never get there. Removed are the arguments and result keys
 * the catalogue marks `sensitive`, and, for any tool, the keys that name a secret
 * ({@link SECRET_KEYS}), at any depth. A text (an error, a result sent as text) loses the values
 * of those keys written as JSON.
 */

import { OPERATIONS } from "./catalog.js";

/** What a removed value becomes. */
export const REDACTED = "[redacted]";

/** Keys whose values are secrets, whatever the tool (compared without case, `_` or `-`). */
export const SECRET_KEYS = ["secret", "token", "password", "apikey", "authorization", "httpservertoken", "accesstoken", "refreshtoken", "clientsecret"] as const;

const SENSITIVE = new Map(OPERATIONS.filter((o) => o.sensitive).map((o) => [o.name, o.sensitive!]));

const norm = (k: string) => k.toLowerCase().replace(/[_-]/g, "");
const GENERIC = new Set<string>(SECRET_KEYS);

/** A JSON key (one of the patterns `names`) and its string value, in a text: `"secret": "…"`. */
function keyValue(names: string): RegExp {
  return new RegExp(`("(?:${names})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
}

/** The same for these key names, taken as they are. */
function textPattern(keys: readonly string[]): RegExp {
  return keyValue(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
}

const GENERIC_TEXT = keyValue("secret|token|password|api[_-]?key|authorization|http[_-]?server[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret");

function redact(v: unknown, extra: ReadonlySet<string>, text: RegExp | null): unknown {
  if (typeof v === "string") {
    let out = v.replace(GENERIC_TEXT, `$1"${REDACTED}"`);
    if (text) out = out.replace(text, `$1"${REDACTED}"`);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, extra, text));
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, GENERIC.has(norm(k)) || extra.has(norm(k)) ? REDACTED : redact(x, extra, text)]));
}

/** A tool call's arguments and result without their secrets (new objects; the call's own are kept). */
export function redactToolCall(tool: string, args: Record<string, unknown>, value: unknown): { args: Record<string, unknown>; value: unknown } {
  const s = SENSITIVE.get(tool);
  const argKeys = new Set((s?.args ?? []).map(norm));
  const resultKeys = new Set((s?.result ?? []).map(norm));
  return {
    args: redact(args, argKeys, s?.args?.length ? textPattern(s.args) : null) as Record<string, unknown>,
    value: redact(value, resultKeys, s?.result?.length ? textPattern(s.result) : null),
  };
}
