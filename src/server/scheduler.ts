/**
 * Write priority: the order in which the operations of the HTTP API start (`rest.ts`).
 *
 * The engine runs on one thread. Under a stream of reads, every `await` of a write (the note, the
 * journal, the transaction log, the change feed) waits behind the reads queued meanwhile, and a
 * write of 30 ms takes 120 ms. The scheduler lets a write run with only the reads already under way:
 *
 * - writes start one at a time, in the order they arrived;
 * - while a write runs or waits, a new read waits until no write is left; reads under way finish;
 * - a read never waits longer than `maxReadWaitMs`, nor while more than `MAX_WRITES_AHEAD` writes
 *   start after it: a burst of writes lets the reads waiting through;
 * - a write that keeps its turn past `WRITE_SLOT.maxMs` lets the next write start (a warning
 *   names it);
 * - free operations never wait and never hold anything up: the long poll of the change feed
 *   (`list_changes` with `wait_ms`), the semantic index sync (calls to the embedding provider).
 *
 * Writes already serialize at the transaction log's lock; running them one at a time only spares
 * the checks of a write another overtook (write-check.ts). What each operation does is unchanged.
 */

import { telemetry } from "../core/telemetry";
import { READ_OPERATIONS } from "./token-routes";

export type OperationClass = "read" | "write" | "free";

/** Writes that wait on something outside the engine for minutes: they run as reads do, unordered. */
const FREE_WRITES: ReadonlySet<string> = new Set(["sync_semantic_index"]);

/** Reads that wait on something outside the engine (the embedding provider). */
const FREE_READS: ReadonlySet<string> = new Set(["semantic_search", "search"]);

/** At most this many writes start while a read waits: then the read starts too. */
export const MAX_WRITES_AHEAD = 8;

/**
 * The longest a write keeps the write slot, in ms: past it a warning names the write and the
 * next write starts. Writes still serialize at the transaction log's lock, and a write another
 * overtook while it was checked runs again (write-check.ts): one write that hangs must not hold
 * every later one. Tests lower it.
 */
export const WRITE_SLOT = { maxMs: 60_000 };

/**
 * How an operation is scheduled: reads are the operations marked `readOnlyHint` in the catalogue
 * (`token-routes.ts`), every other one is a write; a long poll and the calls to the embedding
 * provider are free.
 */
export function operationClass(op: string, body: Record<string, unknown> = {}): OperationClass {
  if (op === "list_changes" && typeof body.wait_ms === "number" && body.wait_ms > 0) return "free";
  if (FREE_WRITES.has(op) || FREE_READS.has(op)) return "free";
  return READ_OPERATIONS.has(op) ? "read" : "write";
}

export interface SchedulerOptions {
  /** Off: every operation starts at once, as without the scheduler. */
  enabled: boolean;
  /** The longest a read waits for writes, in ms. */
  maxReadWaitMs: number;
}

/** How long an operation waited to start, and why it could start. */
export interface ScheduleWait {
  class: OperationClass;
  /** ms waited (0: it started at once). */
  waitedMs: number;
  /** Writes running or waiting when it arrived. */
  writesAhead: number;
  /** Why a read that waited could start: the writes ended, or it waited its longest. */
  released?: "writes_done" | "max_wait" | "max_writes";
}

interface WaitingRead {
  start: (why: NonNullable<ScheduleWait["released"]>) => void;
  /** `writesStarted` when the read arrived. */
  writesBefore: number;
}

export class OperationScheduler {
  private writing = false;
  private readonly writes: (() => void)[] = [];
  private readonly reads = new Set<WaitingRead>();
  private writesStarted = 0;

  constructor(
    private readonly options: () => SchedulerOptions,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Writes running or waiting. */
  get pendingWrites(): number {
    return this.writes.length + (this.writing ? 1 : 0);
  }

  /** Reads waiting for writes. */
  get waitingReads(): number {
    return this.reads.size;
  }

  /** Would an operation of this class wait if it arrived now? */
  wouldWait(cls: OperationClass): boolean {
    return this.options().enabled && cls !== "free" && this.pendingWrites > 0;
  }

  /**
   * Wait until an operation of this class may start; `release` when it ends (a write: the next
   * one starts). How long it waited, and why it could start: `wait`. `op`: the operation's name,
   * for the warning of a write that keeps its turn too long.
   */
  async acquire(cls: OperationClass, op = ""): Promise<{ wait: ScheduleWait; release: () => void }> {
    const o = this.options();
    const ahead = this.pendingWrites;
    if (!o.enabled || cls === "free") return { wait: { class: cls, waitedMs: 0, writesAhead: ahead }, release: () => {} };
    const t0 = this.now();
    if (cls === "write") {
      if (this.writing || this.writes.length > 0) await new Promise<void>((resolve) => this.writes.push(resolve));
      else this.writing = true;
      this.writesStarted++;
      this.releaseOverrun();
      let released = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pass = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        this.nextWrite();
      };
      const started = this.now();
      timer = setTimeout(() => {
        telemetry().log("WARN", "datanotes write still running: the next write starts", { operation: op, held_ms: Math.round(this.now() - started) });
        pass();
      }, WRITE_SLOT.maxMs);
      // a timer must not keep a stopping process alive
      (timer as { unref?: () => void }).unref?.();
      return {
        wait: { class: cls, waitedMs: ahead > 0 ? this.now() - t0 : 0, writesAhead: ahead },
        release: pass,
      };
    }
    const why = ahead > 0 ? await this.waitForWrites(Math.max(0, o.maxReadWaitMs)) : undefined;
    return { wait: { class: cls, waitedMs: why ? this.now() - t0 : 0, writesAhead: ahead, ...(why ? { released: why } : {}) }, release: () => {} };
  }

  /** Run `fn` when its class may start (see {@link acquire}). */
  async run<T>(cls: OperationClass, fn: () => Promise<T>): Promise<T> {
    const slot = await this.acquire(cls);
    try {
      return await fn();
    } finally {
      slot.release();
    }
  }

  private waitForWrites(maxWaitMs: number): Promise<NonNullable<ScheduleWait["released"]>> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read: WaitingRead = {
        writesBefore: this.writesStarted,
        start: (why) => {
          if (!this.reads.delete(read)) return;
          if (timer) clearTimeout(timer);
          resolve(why);
        },
      };
      this.reads.add(read);
      timer = setTimeout(() => read.start("max_wait"), maxWaitMs);
      // a timer must not keep a stopping process alive
      (timer as { unref?: () => void }).unref?.();
    });
  }

  /** The next write in line, or the reads when none is left. */
  private nextWrite(): void {
    const next = this.writes.shift();
    if (next) {
      // still writing: the next write takes over
      next();
      return;
    }
    this.writing = false;
    for (const r of [...this.reads]) r.start("writes_done");
  }

  /** Reads that saw more than MAX_WRITES_AHEAD writes start after them start now. */
  private releaseOverrun(): void {
    for (const r of [...this.reads]) if (this.writesStarted - r.writesBefore > MAX_WRITES_AHEAD) r.start("max_writes");
  }
}
