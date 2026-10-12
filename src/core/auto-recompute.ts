/**
 * Keeps generated / identity columns current after hand edits: when a row changes in Obsidian,
 * a `recompute_columns` of that row runs a few seconds after the last change (so typing is not
 * interrupted). The recompute is a normal journaled operation; it is a no-op when nothing is
 * stale, so the plugin's own writes do not loop.
 *
 * Built for bulk edits made outside the engine (a git pull, a find and replace over 1,000 notes):
 *
 * - the rows waiting are grouped per table: one `recompute_columns` reads the table once for all
 *   of them, instead of once per row;
 * - a row whose table has no generated column and whose identity columns already hold their value
 *   (a valid uuid not used by another note, the file name, a creation time) is not recomputed at
 *   all: that recompute would change nothing.
 */

import type { App, TFile } from "./host";
import { cachedMetastore, resolveCatalogRef } from "./metastore";
import type { OpResult } from "./engine";
import type { RecomputeInput } from "./rows";
import type { DatanotesSettings } from "./settings";
import { isUuid } from "./uuid";
import { isEmptyValue } from "./validate";

export const AUTO_RECOMPUTE_DELAY_MS = 3000;
/** While a table's rows keep changing, the rows already quiet wait at most this many delays. */
export const AUTO_RECOMPUTE_MAX_WAIT_FACTOR = 10;

type Runner = (app: App, settings: DatanotesSettings, input: RecomputeInput) => Promise<OpResult>;

/** A uuid seen on more than one note when the index was built: those notes are always recomputed. */
const SHARED = "\u0000shared";

interface Followed {
  full: string;
  /** The table's columns, as the metastore holds them. */
  columns: readonly Record<string, unknown>[];
  fm: Record<string, unknown>;
}

export class AutoRecompute {
  /** Rows waiting for a recompute, per table: path -> time of its last change. */
  private readonly pending = new Map<string, Map<string, number>>();
  /** When the rows waiting of a table began to wait. */
  private readonly since = new Map<string, number>();
  /** One timer per table with rows waiting. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per table, `<column>\0<uuid>` -> the path of the note holding it (built on first use). */
  private readonly ids = new Map<string, Map<string, string>>();

  constructor(
    private readonly app: App,
    private readonly settings: () => DatanotesSettings,
    private readonly run: Runner,
    private readonly onError: (path: string, error: unknown) => void = () => {},
    private readonly delayMs = AUTO_RECOMPUTE_DELAY_MS,
  ) {}

  /** The table `file` is a row of, when that table has computed columns, with the row's frontmatter. */
  private followed(file: TFile): Followed | null {
    const s = this.settings();
    const model = cachedMetastore(this.app, s);
    if (!model) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const value = fm?.[s.tableKey];
    if (typeof value !== "string" || value.trim() === "") return null;
    let ref;
    try {
      ref = resolveCatalogRef(model, value);
    } catch {
      return null;
    }
    if (!ref) return null;
    const entry = model.catalogs[ref.catalog]!.schemas[ref.schema]!.tables[ref.table]!;
    const computed = entry.columns.some((c) => c.generated !== undefined || c.identity !== undefined);
    return computed ? { full: ref.full, columns: entry.columns, fm: fm! } : null;
  }

  /** Full name of the table `file` is a row of, when that table has computed columns. */
  tableWithComputedColumns(file: TFile): string | null {
    return this.followed(file)?.full ?? null;
  }

  /**
   * Whether a recompute of the row would change nothing: no generated column, and every identity
   * column holds its value (a uuid no other note holds, the file name, a creation time).
   */
  private upToDate(file: TFile, row: Followed): boolean {
    for (const c of row.columns) {
      if (c.generated !== undefined) return false;
      const name = String(c.name);
      const v = row.fm[name];
      if (c.identity === "filename" && v !== file.basename) return false;
      if (c.identity === "created" && isEmptyValue(v)) return false;
      if (c.identity === "uuid" && (!isUuid(v) || !this.ownsId(row.full, name, v, file.path))) return false;
    }
    return true;
  }

  /** Whether `path` is the only note of the table holding `id` in `column` (a copied note shares it). */
  private ownsId(full: string, column: string, id: string, path: string): boolean {
    const index = this.idIndex(full);
    const key = `${column}\u0000${id.toLowerCase()}`;
    const holder = index.get(key);
    if (holder === path) return true;
    if (holder === SHARED) return false;
    if (holder !== undefined && this.holds(holder, full, column, key)) return false; // a copy
    index.set(key, path);
    // a note the index has not seen (new, or written by the engine since): the recompute decides
    return holder !== undefined;
  }

  /** Whether the note at `path` is still a row of `full` holding the uuid of `key`. */
  private holds(path: string, full: string, column: string, key: string): boolean {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !("extension" in f)) return false;
    const row = this.followed(f as TFile);
    const v = row?.fm[column];
    return row?.full === full && typeof v === "string" && `${column}\u0000${v.toLowerCase()}` === key;
  }

  /** The uuids of the table's rows, read once from the metadata cache. */
  private idIndex(full: string): Map<string, string> {
    let index = this.ids.get(full);
    if (index) return index;
    index = new Map();
    this.ids.set(full, index);
    for (const f of this.app.vault.getMarkdownFiles()) {
      const row = this.followed(f);
      if (row?.full !== full) continue;
      for (const c of row.columns) {
        const v = row.fm[String(c.name)];
        if (c.identity !== "uuid" || !isUuid(v)) continue;
        const key = `${String(c.name)}\u0000${v.toLowerCase()}`;
        index.set(key, index.has(key) ? SHARED : f.path);
      }
    }
    return index;
  }

  /** A row changed (metadata or rename): schedule its recompute, restarting its delay. */
  onChanged(file: TFile): void {
    if (!this.settings().autoRecompute || file.extension !== "md") return;
    const row = this.followed(file);
    if (!row || this.upToDate(file, row)) return;
    const waiting = this.pending.get(row.full) ?? new Map<string, number>();
    this.pending.set(row.full, waiting);
    const now = Date.now();
    if (waiting.size === 0) this.since.set(row.full, now);
    waiting.delete(file.path); // kept in the order of the last change
    waiting.set(file.path, now);
    if (!this.timers.has(row.full)) this.arm(row.full, this.delayMs);
  }

  private arm(table: string, ms: number): void {
    this.timers.set(
      table,
      setTimeout(() => this.due(table), ms),
    );
  }

  /**
   * The table's timer. Once no row of the table changed for the delay, its rows are recomputed as
   * one operation. While changes go on (a long pull), the rows quiet for the delay go at the latest
   * {@link AUTO_RECOMPUTE_MAX_WAIT_FACTOR} delays after the first change; a row still changing waits.
   */
  private due(table: string): void {
    this.timers.delete(table);
    const waiting = this.pending.get(table)!; // a table's timer is cleared with its rows
    const now = Date.now();
    let last = 0;
    for (const at of waiting.values()) last = Math.max(last, at);
    const capped = this.since.get(table)! + this.delayMs * AUTO_RECOMPUTE_MAX_WAIT_FACTOR;
    if (now - last < this.delayMs && now < capped) {
      this.arm(table, Math.min(last + this.delayMs, capped) - now);
      return;
    }
    const ready: string[] = [];
    let next = Infinity;
    for (const [path, at] of waiting) {
      if (now - at >= this.delayMs) ready.push(path);
      else next = Math.min(next, at + this.delayMs - now);
    }
    for (const path of ready) waiting.delete(path);
    if (waiting.size === 0) this.pending.delete(table);
    else {
      this.since.set(table, now);
      this.arm(table, next);
    }
    if (ready.length === 0) return;
    const where = ready.length === 1 ? ready[0]! : `${ready[0]} and ${ready.length - 1} more`;
    this.run(this.app, this.settings(), { table, paths: ready }).catch((e: unknown) => this.onError(where, e));
  }

  /** Forget a renamed row's pending recompute (the new path schedules its own). */
  onRenamed(file: TFile, oldPath: string): void {
    for (const [table, waiting] of this.pending) {
      if (!waiting.delete(oldPath) || waiting.size > 0) continue;
      this.pending.delete(table);
      clearTimeout(this.timers.get(table));
      this.timers.delete(table);
    }
    this.onChanged(file);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
    this.since.clear();
    this.ids.clear();
  }
}
