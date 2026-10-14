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

/** How many characters of a recorded call's result, and of each of its arguments, are kept. */
export const RECORDED_CHARS = { value: 1000, arg: 300 } as const;

/** A value as a recorded call keeps it: a text, or an object's JSON, longer than `n` characters is cut (with "…"). */
export function cutRecorded(v: unknown, n: number): unknown {
  if (typeof v === "string") return v.length > n ? `${v.slice(0, n)}…` : v;
  if (v === null || typeof v !== "object") return v;
  const text = JSON.stringify(v);
  return text.length > n ? `${text.slice(0, n)}…` : v;
}

/** A result object in short: its first 30 fields, lists as their length, texts cut at 200 characters, nothing nested. */
export function summarizeRecorded(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v).slice(0, 30)) {
    if (Array.isArray(x)) out[k] = x.length;
    else if (typeof x === "string") out[k] = x.length > 200 ? `${x.slice(0, 200)}…` : x;
    else if (typeof x === "number" || typeof x === "boolean" || x === null) out[k] = x;
  }
  return out;
}

/** An object that is no list. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A call (secrets already removed) as a reporter sends it to an engine that takes it cut: the
 * arguments and the value cut as the engine cuts them, and the summary of a result object, which
 * the cut value may no longer give. The engine records the same event as from the whole call.
 */
export function cutToolCall(call: { args: Record<string, unknown>; ok: boolean; value: unknown }): { args: Record<string, unknown>; value: unknown; summary?: Record<string, unknown> } {
  return {
    args: Object.fromEntries(Object.entries(call.args).map(([k, v]) => [k, cutRecorded(v, RECORDED_CHARS.arg)])),
    value: cutRecorded(call.value, RECORDED_CHARS.value),
    ...(call.ok && isPlainObject(call.value) ? { summary: summarizeRecorded(call.value) } : {}),
  };
}
