/**
 * Writes at the same time (tests/concurrency.test.ts). An operation plans and validates its change
 * set before it takes the transaction log's lock (`finish`, engine.ts), so two writes sent at once
 * would both validate on the same database: two rows with one unique value, a task added while its
 * project closes. Each change set applied raises the database's generation. A write run through
 * `runWrite` remembers the generation it started on, and `finish` applies it only if no other
 * write came in between; otherwise it answers STALE_WRITE and `runWrite` runs the operation again,
 * on the database as it is now.
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
}

interface Storage {
  run<R>(store: WriteContext, fn: () => R): R;
  getStore(): WriteContext | undefined;
}

let storage: Storage | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require("node:async_hooks") as { AsyncLocalStorage: new () => Storage };
  storage = new AsyncLocalStorage();
} catch /* v8 ignore next -- Node always has async_hooks */ {
  storage = null;
}

const generation = (app: App): number => GENERATION.get(app) ?? 0;

/** Did another write apply since this write started? Only inside `runWrite`. */
export function staleWrite(app: App): boolean {
  const ctx = storage?.getStore();
  return ctx !== undefined && ctx.gen !== generation(app);
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
 * and run it again when it was refused that way (`isStale`), at most WRITE_ATTEMPTS times.
 */
export async function runWrite<T>(app: App, fn: () => Promise<T>, isStale: (result: T) => boolean): Promise<T> {
  if (!storage) return fn();
  for (let attempt = 1; ; attempt++) {
    const result = await storage.run({ gen: generation(app) }, fn);
    if (attempt >= WRITE_ATTEMPTS || !isStale(result)) return result;
  }
}

/** Does an answer (an operation's result, a batch's steps) hold the STALE_WRITE conflict? */
export function holdsStaleWrite(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(STALE_WRITE);
}
