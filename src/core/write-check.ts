/**
 * Writes at the same time (tests/concurrency.test.ts). An operation plans and validates its change
 * set before it takes the transaction log's lock (`finish`, engine.ts), so two writes sent at once
 * would both validate on the same database: two rows with one unique value, a task added while its
 * project closes. Each change set applied raises the database's generation. A write run through
 * `runWrite` remembers the generation it started on, and `finish` applies it only if no other
 * write came in between; otherwise it answers STALE_WRITE and `runWrite` runs the operation again,
 * on the database as it is now. Only an attempt `finish` found overtaken is searched for the
 * conflict: an answer that merely quotes its text (a value written) is never run again.
 *
 * AsyncLocalStorage needs Node; elsewhere writes run unchecked, as before (actor.ts does the same).
 */

import type { App } from "./host";

/** The conflict of a write whose database changed while it was being checked. */
export const STALE_WRITE = "the database changed while this write was being checked";
/** How many times `runWrite` runs a write again before it answers the conflict. */
export const WRITE_ATTEMPTS = 5;

const GENERATION = new WeakMap<App, number>();

interface WriteContext {
  /** The generation the write started on, moved on by its own applies (a batch's steps). */
  gen: number;
  /** finish found this attempt overtaken (staleWrite): runWrite then looks for the conflict in its answer. */
  stale: boolean;
}

interface Storage {
  run<R>(store: WriteContext, fn: () => R): R;
  getStore(): WriteContext | undefined;
}

let storage: Storage | null = null;
/* v8 ignore start -- platform: a runtime without node:async_hooks (Node always has it) */
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require("node:async_hooks") as { AsyncLocalStorage: new () => Storage };
  storage = new AsyncLocalStorage();
} catch {
  storage = null;
}
/* v8 ignore stop */

const generation = (app: App): number => GENERATION.get(app) ?? 0;

/** Did another write apply since this write started? Only inside `runWrite`. */
export function staleWrite(app: App): boolean {
  const ctx = storage?.getStore();
  if (ctx === undefined || ctx.gen === generation(app)) return false;
  ctx.stale = true; // runWrite looks for the conflict in this attempt's answer
  return true;
}

/** A change set was applied: the database moves to a new generation, which this write has seen. */
export function wrote(app: App): void {
  const next = generation(app) + 1;
  GENERATION.set(app, next);
  const ctx = storage?.getStore();
  if (ctx) ctx.gen = next;
}

/**
 * Run a write so that `finish` refuses to apply it on a database another write changed meanwhile,
 * and run it again when `finish` found it overtaken and its answer holds the conflict (`isStale`),
 * at most WRITE_ATTEMPTS times.
 */
export async function runWrite<T>(app: App, fn: () => Promise<T>, isStale: (result: T) => boolean): Promise<T> {
  /* v8 ignore next -- platform: a runtime without node:async_hooks (Node always has it) */
  if (!storage) return fn();
  const s = storage;
  let ctx: WriteContext = { gen: 0, stale: false };
  // a fresh context per attempt: one overtaken attempt never makes the next look overtaken
  const attempt = () => s.run((ctx = { gen: generation(app), stale: false }), fn);
  let result = await attempt();
  // only an attempt finish found overtaken can hold the conflict: other answers are never searched
  for (let n = 1; n < WRITE_ATTEMPTS && ctx.stale && isStale(result); n++) result = await attempt();
  return result;
}

/** Does an answer (an operation's result, a batch's steps) hold the STALE_WRITE conflict? */
export function holdsStaleWrite(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(STALE_WRITE);
}
