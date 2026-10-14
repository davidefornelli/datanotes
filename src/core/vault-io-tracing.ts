/**
 * The time the engine spends in the vault and its store, on the spans of tracing.ts: each call of
 * the host (`vault.read`, `adapter.write`, `store.list`, …) is counted on the active span and on
 * its operation span (`datanotes.io.<kind>_count`; `_chars`: characters as JavaScript counts a
 * string, UTF-16 code units, not bytes, and for a listing its entries; `_ms`), and a slow call gets a span
 * of its own (`vault.<kind>`). Thousands of reads of a table scan stay a few attributes, not
 * thousands of spans.
 *
 * It wraps the host's methods in place, once per host; with tracing off a wrapped call costs one
 * check.
 */

import type { App, TAbstractFile, VaultAdapter } from "./host";
import { ioDone, traceNow, tracingOn, type IoKind } from "./tracing";

const WRAPPED = new WeakSet<object>();

type Method = (...args: never[]) => Promise<unknown>;

/** Replace `obj[name]` by a wrapper that counts the call (`pathOf` and `charsOf` read its arguments and result). */
function wrap<O extends object>(obj: O, name: string, kind: IoKind, pathOf: (args: unknown[]) => string, charsOf: (args: unknown[], result: unknown) => number): void {
  const orig = (obj as Record<string, unknown>)[name];
  if (typeof orig !== "function") return;
  const fn = orig as Method;
  (obj as Record<string, unknown>)[name] = function (this: unknown, ...args: never[]) {
    if (!tracingOn()) return fn.apply(this, args);
    const start = traceNow();
    return Promise.resolve(fn.apply(this, args)).then((r) => {
      ioDone(kind, pathOf(args), start, charsOf(args, r));
      return r;
    });
  };
}

const text = (v: unknown): number => (typeof v === "string" ? v.length : 0);
const first = (args: unknown[]): string => (typeof args[0] === "string" ? args[0] : ((args[0] as TAbstractFile | undefined)?.path ?? ""));

function wrapAdapter(a: VaultAdapter): void {
  if (WRAPPED.has(a)) return;
  WRAPPED.add(a);
  wrap(a, "read", "read", first, (_a, r) => text(r));
  wrap(a, "write", "write", first, (args) => text(args[1]));
  wrap(a, "append", "append", first, (args) => text(args[1]));
  wrap(a, "list", "list", first, (_a, r) => {
    const l = r as { files?: unknown[]; folders?: unknown[] } | undefined;
    return (l?.files?.length ?? 0) + (l?.folders?.length ?? 0);
  });
  wrap(a, "exists", "exists", first, () => 0);
  wrap(a, "mkdir", "mkdir", first, () => 0);
  wrap(a, "remove", "remove", first, () => 0);
  wrap(a, "rename", "rename", first, () => 0);
}

/** Count the vault and store calls of `app` on the spans (once per app). */
export function traceVaultIo(app: App): void {
  const v = app.vault;
  if (!WRAPPED.has(v)) {
    WRAPPED.add(v);
    wrap(v, "read", "read", first, (_a, r) => text(r));
    wrap(v, "process", "process", first, (_a, r) => text(r));
    wrap(v, "create", "create", first, (args) => text(args[1]));
    wrap(v, "delete", "delete", first, () => 0);
    wrap(v, "trash", "trash", first, () => 0);
  }
  wrapAdapter(v.adapter);
  if (app.store) wrapAdapter(app.store);
}
