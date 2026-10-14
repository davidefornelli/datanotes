/**
 * The vault index: which notes are the rows of which table, kept up to date by the host's events
 * instead of a walk over every note on each read.
 *
 * Every read of a table used to look at every note of the vault (its front matter's `table`
 * value, resolved against the metastore): O(vault) per table read, O(vault x tables) for the
 * operations that read many tables. The index keeps, for every note, what that walk reads, and
 * the rows of each table; the host's events (`create`, `modify`, `delete`, `rename` of the vault,
 * `changed` of the metadata cache) mark the notes to read again before the next query. The
 * answers are the walk's own, in its order: the index is an accelerator, never a source of truth.
 *
 * A host without events (a test double) has no index: the engine walks the vault as before.
 *
 * The index layer, and its shape (plain data and paths, so a later version can keep it on disk
 * as a rebuildable snapshot: a start then reads only the notes whose stat changed):
 *
 * - here, per note: path → { order, frontmatter, tableValue, table, bare, failed }: `order` is
 *   the note's place in the host's list of notes (`getMarkdownFiles`: a note created or renamed
 *   goes last), `frontmatter` the host's own object (JSON on disk), `tableValue` the raw value of
 *   the table key in it, `table` the table it names under the current metastore (archive and
 *   `exclude` folders are applied per read, from the table's definition); per table: the paths of
 *   its rows, a generation moved when its rows or one of them changed, one when rows come or go;
 *   two logs by cursor, the notes changed and the files (any file) that came or went, read by
 *   the indexes built on this one, which rebuild when the log no longer reaches back (`epoch`);
 * - built on it (core): each table's rows sorted by path (row-files.ts), the vocabularies'
 *   names per table (table-registry.ts), the autolink names (autolink.ts), the unique values of
 *   each table, path → keys and key → paths per unique column (unique-index.ts), the typed edges
 *   of every row with the names their links look up (graph.ts), the transaction log's current
 *   state of the tables with history, path → { hash, text } per table (transaction-log.ts);
 * - in the headless host (src/node): the link resolver by lower-case path and file name, each
 *   note's link targets and the names they look up, the resolved and unresolved links, their
 *   transpose (backlinks), all kept file by file (node-app.ts, links.ts);
 * - the file cache keeps one parse per version of each note (`readFrontmatter`), shared with the
 *   host's front matter at start.
 *
 * Every part is rebuilt from the notes when its inputs change in a way it does not follow (another
 * metastore, table key or database folder). `verifyIndex` (index-check.ts) compares all of it with
 * a full read; DATANOTES_INDEX_CHECK=1 runs it after every operation of the service.
 */

import type { App, TAbstractFile, TFile } from "./host";
import { cachedMetastore, rowTableFull, type Metastore } from "./metastore";
import type { DatanotesSettings } from "./settings";

export type IndexSettings = Pick<DatanotesSettings, "databaseFolder" | "tableKey">;

/** What the index knows of one note (see the module's comment). */
export interface IndexedNote {
  readonly path: string;
  file: TFile;
  order: number;
  /** The host's front matter (its own object, not a copy); undefined when it has none. */
  frontmatter: Record<string, unknown> | undefined;
  /** The host has no front matter for it (none, or none it could read). */
  bare: boolean;
  /** The value of the table key there (undefined: none). */
  tableValue: unknown;
  /** The host's `getFileCache` threw for it (a host whose index throws on broken YAML). */
  failed: boolean;
  /** The table it is a row of under the current metastore (null: none). */
  table: string | null;
}

/** How many paths each change log keeps: a consumer further behind rebuilds from the notes. */
export const INDEX_LOG = { limit: 100_000 };

const INDEXES = new WeakMap<object, VaultIndex | null>();

/** Whether a vault entry is a note, as `getMarkdownFiles` lists them. */
function isNote(f: TAbstractFile | null): f is TFile {
  return f != null && "extension" in f && (f as TFile).extension === "md";
}

function isFolder(f: TAbstractFile): boolean {
  return "children" in f;
}

/** The key of a table value, to resolve each distinct value once per metastore. */
function valueKey(v: unknown): string {
  return typeof v === "string" ? v : `\0${JSON.stringify(v ?? null)}`;
}

export class VaultIndex {
  private readonly notes = new Map<string, IndexedNote>();
  private readonly rows = new Map<string, Set<string>>();
  /** Each table's rows in the host's order, while they do not change. */
  private readonly ordered = new Map<string, TFile[]>();
  private readonly dirty = new Set<string>();
  /** A full read of the vault is due (the start, another table key). */
  private stale = true;
  private nextOrder = 0;
  /** The place a create or a rename gave a path, for its next refresh. */
  private readonly placed = new Map<string, number>();
  private model: Metastore | null = null;
  private tableKey = "";
  private readonly tableGens = new Map<string, number>();
  /** Per table: moves only when its rows come or go (not when one of them changes). */
  private readonly memberGens = new Map<string, number>();
  private failures = 0;
  private log: string[] = [];
  private logStart = 0;
  /** The paths where a file (any file: attachments are link targets too) came or went, in order. */
  private fileLog: string[] = [];
  private fileLogStart = 0;
  /** Moves on every full read: the consumers of the change log start again from the notes. */
  epoch = 0;

  constructor(private readonly app: App) {}

  /** Follow the host's events (once). */
  attach(): void {
    const v = this.app.vault as unknown as { on(n: string, cb: (...a: never[]) => unknown): unknown };
    const mc = this.app.metadataCache as unknown as { on(n: string, cb: (...a: never[]) => unknown): unknown };
    v.on("create", ((f: TAbstractFile) => {
      if (isFolder(f)) return;
      this.place(f.path);
      this.touch(f.path);
      this.fileChanged(f.path);
    }) as never);
    v.on("modify", ((f: TAbstractFile) => this.touch(f.path)) as never);
    v.on("delete", ((f: TAbstractFile) => {
      this.touch(f.path);
      if (isFolder(f)) this.touchTree(f.path, null);
      else this.fileChanged(f.path);
    }) as never);
    v.on("rename", ((f: TAbstractFile, old: string) => {
      this.touch(old);
      if (isFolder(f)) {
        this.touchTree(old, f.path);
        return;
      }
      this.place(f.path);
      this.touch(f.path);
      this.fileChanged(old);
      this.fileChanged(f.path);
    }) as never);
    mc.on("changed", ((f: TAbstractFile) => this.touch(f.path)) as never);
  }

  /** A path to read again before the next query. */
  touch(path: string): void {
    this.dirty.add(path);
  }

  /** A created or renamed file: it goes last in the host's list. */
  private place(path: string): void {
    this.placed.set(path, this.nextOrder++);
  }

  /**
   * The notes under a folder deleted or renamed: read again; under the new name (`to`), in their
   * order, for a host that tells only of the folder.
   */
  private touchTree(from: string, to: string | null): void {
    const prefix = `${from}/`;
    const inside = [...this.notes.values()].filter((n) => n.path.startsWith(prefix)).sort((a, b) => a.order - b.order);
    for (const n of inside) {
      this.touch(n.path);
      this.fileChanged(n.path);
      if (to === null) continue;
      const moved = `${to}/${n.path.slice(prefix.length)}`;
      this.place(moved);
      this.touch(moved);
      this.fileChanged(moved);
    }
  }

  /** A file came or went at `path` (the set of files changed: links may resolve elsewhere). */
  private fileChanged(path: string): void {
    this.fileLog.push(path);
    if (this.fileLog.length > INDEX_LOG.limit) {
      const drop = this.fileLog.length - INDEX_LOG.limit / 2;
      this.fileLog = this.fileLog.slice(drop);
      this.fileLogStart += drop;
    }
  }

  /** Bring the index up to date: the notes marked, the metastore loaded now, the table key. */
  sync(settings: IndexSettings): void {
    const model = cachedMetastore(this.app, settings);
    if (this.stale || settings.tableKey !== this.tableKey) {
      this.rebuild(settings.tableKey, model);
      return;
    }
    if (model !== this.model) this.remodel(model);
    if (this.dirty.size === 0) return;
    const paths = [...this.dirty];
    this.dirty.clear();
    for (const p of paths) this.refresh(p);
  }

  /** Read every note again (the start, or another table key). */
  private rebuild(tableKey: string, model: Metastore | null): void {
    this.stale = false;
    this.tableKey = tableKey;
    this.model = model;
    this.notes.clear();
    this.rows.clear();
    this.ordered.clear();
    this.dirty.clear();
    this.placed.clear();
    this.failures = 0;
    for (const f of this.app.vault.getMarkdownFiles()) this.add(f.path, f, this.nextOrder++);
    for (const t of [...this.tableGens.keys()]) this.bump(t, true);
    this.epoch++;
    this.logStart += this.log.length;
    this.log = [];
    this.fileLogStart += this.fileLog.length;
    this.fileLog = [];
  }

  /** Another metastore: every note's table again, from its value (no front matter read). */
  private remodel(model: Metastore | null): void {
    this.model = model;
    const tables = new Map<string, string | null>();
    for (const n of this.notes.values()) {
      const k = valueKey(n.tableValue);
      let t = tables.get(k);
      if (t === undefined) tables.set(k, (t = this.tableOf(n.tableValue)));
      if (t !== n.table) {
        this.setTable(n, t);
        this.changed(n.path);
      }
    }
  }

  private tableOf(value: unknown): string | null {
    return value === undefined || value === null || this.model === null ? null : rowTableFull(this.model, value);
  }

  /** Read one path again from the host. */
  private refresh(path: string): void {
    const f = this.app.vault.getAbstractFileByPath(path);
    const n = this.notes.get(path);
    if (!isNote(f)) {
      this.placed.delete(path);
      if (n) this.remove(n);
      return;
    }
    if (!n) {
      this.add(path, f, this.placed.get(path) ?? this.nextOrder++);
      this.placed.delete(path);
      return;
    }
    const order = this.placed.get(path);
    if (order !== undefined) {
      this.placed.delete(path);
      n.order = order;
      if (n.table !== null) this.ordered.delete(n.table);
    }
    n.file = f;
    this.read(n);
    this.changed(path);
  }

  private add(path: string, file: TFile, order: number): void {
    const n: IndexedNote = { path, file, order, frontmatter: undefined, bare: true, tableValue: undefined, failed: false, table: null };
    this.notes.set(path, n);
    this.read(n);
    this.changed(path);
  }

  private remove(n: IndexedNote): void {
    this.setTable(n, null);
    if (n.failed) this.failures--;
    this.notes.delete(n.path);
    this.changed(n.path);
  }

  /** The note's front matter and table, as the host has them now. */
  private read(n: IndexedNote): void {
    let fm: unknown;
    let failed = false;
    try {
      fm = this.app.metadataCache.getFileCache(n.file)?.frontmatter;
    } catch {
      fm = undefined;
      failed = true;
    }
    if (failed !== n.failed) this.failures += failed ? 1 : -1;
    n.failed = failed;
    n.bare = !fm;
    n.frontmatter = fm && typeof fm === "object" ? (fm as Record<string, unknown>) : undefined;
    n.tableValue = n.frontmatter?.[this.tableKey];
    const table = this.tableOf(n.tableValue);
    if (table !== n.table) this.setTable(n, table);
    else if (table !== null) this.bump(table); // a row changed
  }

  private setTable(n: IndexedNote, table: string | null): void {
    if (n.table !== null) {
      this.rows.get(n.table)!.delete(n.path); // a row is in its table's set
      this.ordered.delete(n.table);
      this.bump(n.table, true);
    }
    n.table = table;
    if (table !== null) {
      let set = this.rows.get(table);
      if (!set) this.rows.set(table, (set = new Set()));
      set.add(n.path);
      this.ordered.delete(table);
      this.bump(table, true);
    }
  }

  private bump(table: string, members = false): void {
    this.tableGens.set(table, (this.tableGens.get(table) ?? 0) + 1);
    if (members) this.memberGens.set(table, (this.memberGens.get(table) ?? 0) + 1);
  }

  private changed(path: string): void {
    this.log.push(path);
    if (this.log.length > INDEX_LOG.limit) {
      const drop = this.log.length - INDEX_LOG.limit / 2;
      this.log = this.log.slice(drop);
      this.logStart += drop;
    }
  }

  // --- queries (call sync first) ---

  /** Whether the host's index threw for a note: the engine then walks the vault, which reports it. */
  get hasFailures(): boolean {
    return this.failures > 0;
  }

  /** The rows of `table`, in the host's order (archive and exclude folders not applied). */
  rowsOf(table: string): readonly TFile[] {
    let out = this.ordered.get(table);
    if (!out) {
      const notes = [...(this.rows.get(table) ?? [])].map((p) => this.notes.get(p)!);
      out = notes.sort((a, b) => a.order - b.order).map((n) => n.file);
      this.ordered.set(table, out);
    }
    return out;
  }

  /** The tables with rows. */
  tables(): string[] {
    return [...this.rows].filter(([, set]) => set.size > 0).map(([t]) => t);
  }

  /** The number of rows of `table` (archive and exclude folders not applied). */
  rowCount(table: string): number {
    return this.rows.get(table)?.size ?? 0;
  }

  note(path: string): IndexedNote | undefined {
    return this.notes.get(path);
  }

  /** Every note the index knows, in no particular order. */
  allNotes(): IterableIterator<IndexedNote> {
    return this.notes.values();
  }

  /** The notes `keep` takes, in the host's order (`getMarkdownFiles`). */
  notesInOrder(keep: (n: IndexedNote) => boolean): IndexedNote[] {
    const out: IndexedNote[] = [];
    for (const n of this.notes.values()) if (keep(n)) out.push(n);
    return out.sort((a, b) => a.order - b.order);
  }

  /** Moves whenever `table`'s rows, or one of them, changed. */
  tableGeneration(table: string): number {
    return this.tableGens.get(table) ?? 0;
  }

  /** Moves whenever a row of `table` comes or goes (a rename too), not when one changes. */
  membershipGeneration(table: string): number {
    return this.memberGens.get(table) ?? 0;
  }

  /** Where the change log is now: pass it to {@link changedSince} later. */
  get cursor(): number {
    return this.logStart + this.log.length;
  }

  /**
   * The paths changed since `cursor` (from {@link cursor} in the same {@link epoch}), or null
   * when the log no longer reaches back there: rebuild from the notes.
   */
  changedSince(cursor: number, epoch: number): Set<string> | null {
    if (epoch !== this.epoch || cursor < this.logStart || cursor > this.cursor) return null;
    return new Set(this.log.slice(cursor - this.logStart));
  }

  /** Where the log of files that came or went is now: pass it to {@link filesChangedSince} later. */
  get fileCursor(): number {
    return this.fileLogStart + this.fileLog.length;
  }

  /**
   * The paths where a file came or went since `cursor` (from {@link fileCursor} in the same
   * {@link epoch}), or null when the log no longer reaches back there.
   */
  filesChangedSince(cursor: number, epoch: number): Set<string> | null {
    if (epoch !== this.epoch || cursor < this.fileLogStart || cursor > this.fileCursor) return null;
    return new Set(this.fileLog.slice(cursor - this.fileLogStart));
  }

  /** Read every note again at the next query (after a difference found by {@link verifyIndex}). */
  invalidate(): void {
    this.stale = true;
  }
}

/** Whether the host tells of its changes: only then can an index follow it. */
function followsEvents(app: App): boolean {
  const v = app.vault as unknown as { on?: unknown };
  const mc = app.metadataCache as unknown as { on?: unknown };
  return typeof v.on === "function" && typeof mc.on === "function";
}

/** The vault index of `app`, up to date for `settings`; null on a host without events. */
export function vaultIndex(app: App, settings: IndexSettings): VaultIndex | null {
  let idx = INDEXES.get(app);
  if (idx === undefined) {
    idx = followsEvents(app) ? new VaultIndex(app) : null;
    idx?.attach();
    INDEXES.set(app, idx);
  }
  idx?.sync(settings);
  return idx;
}

/** Paths changed outside the host's events (a write the engine knows of): read again at the next query. */
export function touchIndex(app: App, paths: Iterable<string>): void {
  const idx = INDEXES.get(app);
  if (idx) for (const p of paths) idx.touch(p);
}
