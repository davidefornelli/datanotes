/**
 * Keeps the headless vault in step with changes made by other programs (a person in an editor,
 * git, a sync tool):
 *
 * - `events`: the operating system reports changed paths (recursive `fs.watch`: Windows, macOS,
 *   Linux with Node ≥ 20); the paths reported together are checked against the index as one batch
 *   after a short quiet time (a note renamed outside is two paths: its old one and its new one);
 * - `poll`: the whole tree is compared with the index every few seconds (mtime + size). Use it
 *   where events do not arrive, e.g. a Docker bind mount of a Windows folder. The interval adapts:
 *   a comparison that takes long (thousands of notes over a slow mount) is followed by a longer
 *   pause, so comparing never takes more than a fifth of the time. Before an operation (`flush`)
 *   the tree is compared only while a comparison is cheap (a small vault on a local disk): on a
 *   large vault over a slow mount, a change made outside is seen at the next comparison.
 *
 * Both start with a full comparison (changes made while the engine was off). After the service's
 * own walk of the vault at start, the comparison does not block: the tree is listed and stat-ed
 * again many files at a time, and only what changed since the walk is checked (requests wait for
 * it meanwhile). It is the only walk when it ends after the OS's stream started (the check
 * `startupRescanMs` after start, for what a starting stream missed, is then not needed). The OS's
 * reports are not followed during the start's reads: on Windows each read of a note may update its
 * access time, and a recursive watcher then slows every read many times. The engine's own writes
 * are recognised by their stat and not reported again. A comparison of the whole tree (the OS's
 * buffer of reports overflowed) never blocks either, and none runs while the engine writes (a
 * burst of its own writes overflows the buffer): one runs once it is done; polls wait likewise.
 * A note renamed or moved outside is announced as a rename (`NodeVault.syncPaths`).
 */

import fs from "node:fs";
import path from "node:path";
import type { NodeVault } from "./node-app";

const RESCAN = "\u0000rescan";

/** Poll mode: the pause after a comparison is at least this many times the comparison's duration. */
export const POLL_BUSY_FACTOR = 4;
/** Poll mode: the longest pause between two comparisons, ms. */
export const POLL_MAX_INTERVAL_MS = 60_000;

/**
 * Poll mode: `flush` compares the whole tree only while a recent comparison took at most this long,
 * ms. Above it, comparing before every operation made the engine unusable (10,000 notes over a
 * Docker bind mount of a Windows folder).
 */
export const POLL_FLUSH_BUDGET_MS = 50;
/**
 * Poll mode: `flush` skips its comparison only when each of this many last comparisons went over
 * {@link POLL_FLUSH_BUDGET_MS}. One slow comparison (a GC pause, a busy CPU) is not a slow vault:
 * skipping on it let an operation read a database folder just moved by hand.
 */
export const POLL_FLUSH_RECENT = 3;

/** Poll mode: the pause before the next comparison, after one that took `tookMs`. */
export function nextPollMs(intervalMs: number, tookMs: number): number {
  return Math.max(intervalMs, Math.min(POLL_MAX_INTERVAL_MS, Math.round(tookMs * POLL_BUSY_FACTOR)));
}

export interface WatcherOptions {
  mode: "events" | "poll";
  /** Poll interval (poll mode), ms. */
  intervalMs?: number;
  /** Quiet time before the changed paths are checked (events mode), ms. */
  debounceMs?: number;
  /** Events mode: the changed paths are checked at most this long after the first of them, also while changes go on, ms. */
  maxWaitMs?: number;
  /** Called after each batch of external changes, with the paths that changed. */
  onChanges?: (paths: string[]) => void;
  /**
   * Events mode: a full comparison this long after start, ms (0: none). The operating system's
   * stream takes a moment to start (macOS FSEvents in particular): a change made in that moment is
   * reported by nothing else. Windows reports from the moment the watcher starts.
   */
  startupRescanMs?: number;
  /**
   * Whether the engine is writing now: a full comparison asked for meanwhile (the OS reported more
   * changes than its buffer holds, as a burst of the engine's own writes does) waits until it is
   * done, then runs once.
   */
  writing?: () => boolean;
}

export class NodeWatcher {
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Poll mode: how long the last comparison of the whole tree took, ms. */
  private lastScanMs = 0;
  /** How long the last {@link POLL_FLUSH_RECENT} comparisons took, ms, oldest first. */
  private recentScanMs: number[] = [];
  /** When the last comparison of the whole tree started (`performance.now()`; -Infinity: none yet). */
  private lastScanAt = -Infinity;
  /** Paths reported and not checked yet (events mode), in the order reported: checked together. */
  private pending = new Set<string>();
  private quiet: ReturnType<typeof setTimeout> | null = null;
  /** When the first of the pending paths was reported (0: none pending). */
  private pendingSince = 0;
  private startup: ReturnType<typeof setTimeout> | null = null;
  /** A comparison of the whole tree without blocking, while it runs ({@link compare}). */
  private comparing: Promise<void> | null = null;
  /** Another comparison was asked for while one ran. */
  private again = false;
  /** Moves at every start and stop: a comparison that ends after one applies nothing. */
  private runs = 0;
  /** How many full comparisons ran (start, polls, OS buffer overflows, flushes). */
  rescans = 0;

  constructor(
    private readonly vault: NodeVault,
    private readonly opts: WatcherOptions,
  ) {}

  /**
   * Start: compare the whole tree with the index, then follow the changes. `scanned`: the vault
   * was walked just now, from `at` (`performance.now()`) for `ms`: the comparison runs without
   * blocking ({@link NodeVault.changedSinceWalk}), after the OS's reports are followed, and
   * {@link flush} waits for it. Returns what the blocking comparison found (none with `scanned`).
   */
  start(o: { scanned?: { at: number; ms: number } } = {}): string[] {
    this.runs++;
    let changed: string[] = [];
    if (o.scanned) {
      this.lastScanAt = o.scanned.at;
      this.took(o.scanned.ms);
    } else {
      changed = this.scan();
      if (changed.length > 0) this.opts.onChanges?.(changed);
    }
    if (this.opts.mode === "poll") {
      this.poll(this.opts.intervalMs ?? 3000);
    } else {
      this.watchOs();
      const startupMs = this.opts.startupRescanMs ?? 1000;
      if (startupMs > 0) {
        this.startup = setTimeout(() => {
          this.startup = null;
          // the comparison that follows the walk still runs: it ends after the stream started
          if (!this.comparing) this.compare().catch(() => undefined);
        }, startupMs);
      }
    }
    if (o.scanned) {
      const startup = this.startup;
      const deadline = performance.now() + (this.opts.startupRescanMs ?? 1000);
      this.compare()
        .then(() => {
          // ended after the OS's stream started: no second comparison of the tree
          if (startup && this.startup === startup && performance.now() >= deadline) {
            clearTimeout(startup);
            this.startup = null;
          }
        })
        .catch(() => undefined);
    }
    return changed;
  }

  /**
   * Compare the whole tree with the index without blocking: listed and stat-ed many files at a
   * time ({@link NodeVault.changedSinceWalk}), then only what changed is checked. {@link flush}
   * waits for it. Asked for while one runs, another runs once it ends (the running one may have
   * listed a folder before the change).
   */
  private compare(): Promise<void> {
    if (this.comparing) {
      this.again = true;
      return this.comparing;
    }
    const run = this.runs;
    const t0 = performance.now();
    this.rescans++;
    const done = this.vault
      .changedSinceWalk()
      .then((paths) => {
        if (run !== this.runs) return; // stopped meanwhile
        const c = paths.length > 0 ? this.vault.syncPaths(paths) : [];
        if (c.length > 0) this.opts.onChanges?.(c);
      })
      .finally(() => {
        if (run !== this.runs) return;
        this.comparing = null;
        this.lastScanAt = t0;
        this.took(performance.now() - t0);
      });
    const all: Promise<void> = done.then(() => {
      if (run !== this.runs || !this.again) return;
      this.again = false;
      return this.compare();
    });
    this.comparing = all;
    all.catch(() => undefined); // waited for by flush, which reports a failure
    return all;
  }

  private watchOs(): void {
    this.watcher = fs.watch(this.vault.basePath, { recursive: true }, (_event, filename) => {
      if (!filename) {
        this.schedule(RESCAN);
        return;
      }
      const rel = String(filename).split(path.sep).join("/");
      if (rel.split("/").some((p) => p.startsWith("."))) return; // dot-folders (hidden store, .obsidian, temp files)
      this.schedule(rel);
    });
    // events without a path (above), or a watcher error: compare the whole tree
    this.watcher.on("error", () => this.schedule(RESCAN));
  }

  /** Poll mode: compare the whole tree in `ms`, then again after a pause that fits its duration. */
  private poll(ms: number): void {
    const timer = setTimeout(() => {
      if (this.opts.writing?.()) {
        // the engine writes: its own changes are known, compare once it is done
        this.poll(this.opts.debounceMs ?? 150);
        return;
      }
      try {
        const c = this.scan();
        if (c.length > 0) this.opts.onChanges?.(c);
      } finally {
        // not when the watcher was stopped (or stopped and started again) meanwhile
        if (this.timer === timer) this.poll(nextPollMs(this.opts.intervalMs ?? 3000, this.lastScanMs));
      }
    }, ms);
    this.timer = timer;
  }

  /** Compare the whole tree with the index, timed. */
  private scan(): string[] {
    const t0 = performance.now();
    this.lastScanAt = t0;
    this.rescans++;
    try {
      return this.vault.rescan();
    } finally {
      this.took(performance.now() - t0);
    }
  }

  /** A comparison of the whole tree took `ms`. */
  private took(ms: number): void {
    this.lastScanMs = ms;
    this.recentScanMs.push(ms);
    if (this.recentScanMs.length > POLL_FLUSH_RECENT) this.recentScanMs.shift();
  }

  /** A path reported: checked with the others once the vault is quiet, or at the latest `maxWaitMs` after the first. */
  private schedule(rel: string): void {
    this.pending.add(rel);
    if (this.quiet) clearTimeout(this.quiet);
    const now = Date.now();
    this.pendingSince ||= now;
    const wait = Math.max(0, Math.min(this.opts.debounceMs ?? 150, this.pendingSince + (this.opts.maxWaitMs ?? 2000) - now));
    this.quiet = setTimeout(() => void this.checkPending()?.catch(() => undefined), wait);
  }

  /**
   * Check every pending path as one batch; the whole tree when a comparison is due (without
   * blocking: the promise of the comparison, which {@link flush} waits for).
   */
  private checkPending(): Promise<void> | undefined {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    this.pendingSince = 0;
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length === 0) return undefined;
    const named = paths.filter((p) => p !== RESCAN);
    const due = named.length < paths.length;
    if (due && this.opts.writing?.()) {
      // the engine is writing (the buffer overflowed with its own writes): compare once it is done
      this.pending.add(RESCAN);
      this.quiet = setTimeout(() => void this.checkPending()?.catch(() => undefined), this.opts.debounceMs ?? 150);
    }
    const c = named.length > 0 ? this.vault.syncPaths(named) : [];
    if (c.length > 0) this.opts.onChanges?.(c);
    if (due && !this.opts.writing?.()) return this.compare();
    return undefined;
  }

  /**
   * Apply now what would be applied later: in events mode the paths still in their quiet time (and,
   * while the OS stream may still be starting, the whole tree). Called before every operation, so
   * it sees the changes made on disk before it. Poll mode compares the whole tree only while that is
   * cheap (the fastest of the last {@link POLL_FLUSH_RECENT} took at most {@link POLL_FLUSH_BUDGET_MS}); else the next poll sees the changes. `since`: when the
   * operation arrived; a comparison started after it (for another operation while this one waited,
   * or a poll) has seen every change made before it, and is not made again. While the comparison
   * that follows the start runs, it waits for it first.
   */
  flush(since?: number): void | Promise<void> {
    if (this.comparing) return this.comparing.then(() => this.flush(since));
    if (this.opts.mode === "poll") {
      if (!this.timer || Math.min(...this.recentScanMs) > POLL_FLUSH_BUDGET_MS) return;
      if (since !== undefined && this.lastScanAt >= since) return;
      const c = this.scan();
      if (c.length > 0) this.opts.onChanges?.(c);
      return;
    }
    if (!this.watcher) return;
    if (this.startup) this.pending.add(RESCAN);
    return this.checkPending();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.startup) clearTimeout(this.startup);
    this.startup = null;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    this.pending.clear();
    this.pendingSince = 0;
    this.runs++;
    this.comparing = null;
    this.again = false;
  }
}
