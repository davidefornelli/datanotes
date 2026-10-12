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
 * Both start with a full comparison (changes made while the engine was off). The engine's own
 * writes are recognised by their stat and not reported again. A note renamed or moved outside is
 * announced as a rename (`NodeVault.syncPaths`).
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
 * Poll mode: `flush` compares the whole tree only while the last comparison took at most this long,
 * ms. Above it, comparing before every operation made the engine unusable (10,000 notes over a
 * Docker bind mount of a Windows folder).
 */
export const POLL_FLUSH_BUDGET_MS = 50;

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
   * Events mode: a full comparison this long after start, ms. The operating system's stream takes a
   * moment to start (macOS FSEvents in particular): a change made in that moment is reported by
   * nothing else.
   */
  startupRescanMs?: number;
}

export class NodeWatcher {
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Poll mode: how long the last comparison of the whole tree took, ms. */
  private lastScanMs = 0;
  /** Paths reported and not checked yet (events mode), in the order reported: checked together. */
  private pending = new Set<string>();
  private quiet: ReturnType<typeof setTimeout> | null = null;
  /** When the first of the pending paths was reported (0: none pending). */
  private pendingSince = 0;
  private startup: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly vault: NodeVault,
    private readonly opts: WatcherOptions,
  ) {}

  start(): string[] {
    const changed = this.scan();
    if (changed.length > 0) this.opts.onChanges?.(changed);
    if (this.opts.mode === "poll") {
      this.poll(this.opts.intervalMs ?? 3000);
    } else {
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
      this.startup = setTimeout(() => {
        this.startup = null;
        this.schedule(RESCAN);
      }, this.opts.startupRescanMs ?? 1000);
    }
    return changed;
  }

  /** Poll mode: compare the whole tree in `ms`, then again after a pause that fits its duration. */
  private poll(ms: number): void {
    const timer = setTimeout(() => {
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
    try {
      return this.vault.rescan();
    } finally {
      this.lastScanMs = performance.now() - t0;
    }
  }

  /** A path reported: checked with the others once the vault is quiet, or at the latest `maxWaitMs` after the first. */
  private schedule(rel: string): void {
    this.pending.add(rel);
    if (this.quiet) clearTimeout(this.quiet);
    const now = Date.now();
    this.pendingSince ||= now;
    const wait = Math.max(0, Math.min(this.opts.debounceMs ?? 150, this.pendingSince + (this.opts.maxWaitMs ?? 2000) - now));
    this.quiet = setTimeout(() => this.checkPending(), wait);
  }

  /** Check every pending path as one batch (the whole tree when a comparison is due). */
  private checkPending(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    this.pendingSince = 0;
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length === 0) return;
    const c = paths.includes(RESCAN) ? this.vault.rescan() : this.vault.syncPaths(paths);
    if (c.length > 0) this.opts.onChanges?.(c);
  }

  /**
   * Apply now what would be applied later: in events mode the paths still in their quiet time (and,
   * while the OS stream may still be starting, the whole tree). Called before every operation, so
   * it sees the changes made on disk before it. Poll mode compares the whole tree only while that is
   * cheap ({@link POLL_FLUSH_BUDGET_MS}); else the next poll sees the changes.
   */
  flush(): void {
    if (this.opts.mode === "poll") {
      if (!this.timer || this.lastScanMs > POLL_FLUSH_BUDGET_MS) return;
      const c = this.scan();
      if (c.length > 0) this.opts.onChanges?.(c);
      return;
    }
    if (!this.watcher) return;
    if (this.startup) this.pending.add(RESCAN);
    this.checkPending();
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
  }
}
