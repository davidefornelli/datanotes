/**
 * The headless host: the engine's `App` (VaultHost) on a folder of the filesystem, without
 * Obsidian. It keeps the same file index, metadata cache and link index Obsidian would, and the
 * same behaviour on writes:
 *
 * - files are written atomically (temporary file, then rename);
 * - renaming or moving a file or a folder rewrites every link to it, in note bodies and in
 *   frontmatter, in the vault's link format (`.obsidian/app.json`);
 * - deleted files go to `.trash/` (or are removed, per `trashOption`);
 * - dot-files and dot-folders are not part of the vault (like Obsidian), but stay reachable
 *   through `vault.adapter`. The engine's store is a folder of its own (`nodeStoreAdapter`).
 *
 * Changes made by other programs (a person in an editor, git, a sync tool) arrive through
 * `NodeWatcher` (`watcher.ts`), which calls `vault.syncPaths` / `vault.rescan`. A note renamed or
 * moved outside, which the disk shows as one file gone and one new, is announced as a `rename`
 * (like Obsidian's own renames) when the two are seen together and the new file has the gone one's
 * content, or is the same file in another case.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildMarkdownWithFrontmatter, detached, readOrderedFromMarkdown } from "../core/frontmatter";
import type {
  App,
  CachedMetadata,
  EventRef,
  FileManager,
  FileStats,
  LinkRewrite,
  LinksAfterMoveOptions,
  MetadataCache,
  RenameInfo,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
  StoreAdapter,
  VaultAdapter,
} from "../core/host";
import { addLinkLookupNames, basename, dirname, fileLookupNames, LinkResolver, linkLookupNames, linkText, parseLinks, rewriteLinks } from "./links";
import { eachLimit, MOVE_WRITES } from "../core/database-move";
import { contentHash, primeFiles, setTextSource } from "../core/file-cache";
import { intern, internAll } from "../core/intern";
import { setSearchSource } from "../core/vault-read";
import { IndexDb, IndexKeeper, RACY_MS, type FileRecord, type IndexSource, type NoteLinks, type NoteRecord } from "./index-db";
import type { OrderedFrontmatter } from "../core/types";
import { readVaultConfig, type VaultConfig } from "./vault-config";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./private-files";

/** A file's stat on the Node host: FileStats and its change time. */
export interface NodeFileStats extends FileStats {
  /** The status change time (fs.Stats.ctimeMs: POSIX ctime, NTFS ChangeTime): it moves with every write, also one that restores the old mtime. */
  changed?: number;
}

export class NodeFile implements TFile {
  stat: NodeFileStats;
  constructor(
    public path: string,
    stat: NodeFileStats,
  ) {
    this.stat = stat;
  }
  get name(): string {
    return basename(this.path);
  }
  get basename(): string {
    const n = this.name;
    const i = n.lastIndexOf(".");
    return i > 0 ? n.slice(0, i) : n;
  }
  get extension(): string {
    const n = this.name;
    const i = n.lastIndexOf(".");
    return i > 0 ? n.slice(i + 1) : "";
  }
}

export class NodeFolder implements TFolder {
  children: TAbstractFile[] = [];
  constructor(public path: string) {}
  get name(): string {
    return this.path === "" ? "" : basename(this.path);
  }
}

/** A name listed in folder `dir`, as a vault path. */
function joined(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function hidden(rel: string): boolean {
  return rel.split("/").some((p) => p.startsWith("."));
}

function statsOf(s: fs.Stats): NodeFileStats {
  /* v8 ignore next -- platform: only a filesystem without birth time (some Linux ones) reports 0 */
  return { ctime: s.birthtimeMs || s.ctimeMs, mtime: s.mtimeMs, size: s.size, changed: s.ctimeMs };
}

/** Makes every temporary file name unique, also for two writes of a file in the same millisecond. */
let tmpSeq = 0;

/** The start of the temporary name of a rename in case only (see `NodeVault.renameThroughTemporary`). */
export const RENAME_TEMP_PREFIX = ".datanotes-rename-";
const RENAME_TEMP = /^\.datanotes-rename-\d+-\d+--(.+)$/;

/**
 * A unique temporary name for a file on its way to the name `target` (in the same folder):
 * `.datanotes-rename-<pid>-<n>--<target>`, or without the target when the name would be too long
 * for the file system (255 bytes); such a file cannot be recovered after a crash.
 */
export function temporaryName(target: string): string {
  tmpSeq = (tmpSeq + 1) % Number.MAX_SAFE_INTEGER;
  const base = `${RENAME_TEMP_PREFIX}${process.pid}-${tmpSeq}`;
  const full = `${base}--${target}`;
  return Buffer.byteLength(full) <= 255 ? full : base;
}

/**
 * Write a file atomically: a sibling temporary file renamed over the target. Each write has its
 * own temporary file, so concurrent writes of the same file never share one: the last rename wins.
 * The temporary name does not include the target's: a note name near the file system's limit of
 * 255 characters would otherwise give a temporary name over it, and no write would succeed.
 * With `modes` (the store's private files), the folders and the new temporary file get them, so
 * the file after the rename has the file mode.
 */
async function atomicWrite(abs: string, data: string, modes?: FileModes): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true, ...(modes ? { mode: modes.dir } : {}) });
  tmpSeq = (tmpSeq + 1) % Number.MAX_SAFE_INTEGER;
  const tmp = path.join(path.dirname(abs), `.datanotes-${process.pid}-${Date.now()}-${tmpSeq}.tmp`);
  await fsp.writeFile(tmp, data, { encoding: "utf8", ...(modes ? { mode: modes.file } : {}) });
  try {
    await renameRetrying(tmp, abs);
    /* v8 ignore start -- the rename gives up only if another program holds the file for seconds */
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  /* v8 ignore stop */
}

/**
 * Rename on disk. Windows: renaming a file another process has open (or over one) fails with
 * EPERM / EBUSY / EACCES until it closes it; readers (an editor, an antivirus, a sync tool) hold
 * files for milliseconds, so retry for up to ~3 s before the write fails (and is rolled back).
 */
async function renameRetrying(from: string, to: string, attempt = 0): Promise<void> {
  try {
    await fsp.rename(from, to);
    /* v8 ignore start -- runs only on Windows, while a reader holds the file; it gives up only if one holds it for seconds */
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (attempt >= 30 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw e;
    await new Promise((r) => setTimeout(r, 25 + attempt * 10));
    await renameRetrying(from, to, attempt + 1);
  }
  /* v8 ignore stop */
}

/**
 * A vault-relative path as an absolute one under `root`. Anything that would land outside the
 * vault (`..`, a backslash or drive letter read as a separator on Windows) is refused: every read,
 * write, move and delete of the host goes through here.
 */
export function resolveInVault(root: string, rel: string): string {
  const parts = String(rel).split("/").filter((s) => s !== "" && s !== ".");
  for (const s of parts) {
    if (s === ".." || s.includes("\\") || s.includes("\0") || /^[A-Za-z]:/.test(s)) throw new Error(`path outside the vault refused: ${rel}`);
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  /* v8 ignore next -- defensive: the checks above already refuse every part that leaves the vault */
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`path outside the vault refused: ${rel}`);
  return abs;
}

/** The modes of new folders and files (POSIX; Windows ignores them). */
interface FileModes {
  dir: number;
  file: number;
}

class NodeAdapter implements VaultAdapter {
  constructor(
    private readonly root: string,
    private readonly modes?: FileModes,
  ) {}
  private dirOpts(): { recursive: true; mode?: number } {
    return { recursive: true, ...(this.modes ? { mode: this.modes.dir } : {}) };
  }
  private abs(p: string): string {
    return resolveInVault(this.root, p);
  }
  async exists(p: string): Promise<boolean> {
    return fs.existsSync(this.abs(p));
  }
  read(p: string): Promise<string> {
    return fsp.readFile(this.abs(p), "utf8");
  }
  write(p: string, data: string): Promise<void> {
    return atomicWrite(this.abs(p), data, this.modes);
  }
  async append(p: string, data: string): Promise<void> {
    await fsp.mkdir(path.dirname(this.abs(p)), this.dirOpts());
    await fsp.appendFile(this.abs(p), data, { encoding: "utf8", ...(this.modes ? { mode: this.modes.file } : {}) });
  }
  async list(p: string): Promise<{ files: string[]; folders: string[] }> {
    const ents = await fsp.readdir(this.abs(p), { withFileTypes: true });
    const rel = (n: string) => (p === "" ? n : `${p}/${n}`);
    return { files: ents.filter((e) => e.isFile()).map((e) => rel(e.name)), folders: ents.filter((e) => e.isDirectory()).map((e) => rel(e.name)) };
  }
  async mkdir(p: string): Promise<void> {
    await fsp.mkdir(this.abs(p), this.dirOpts());
  }
  remove(p: string): Promise<void> {
    return fsp.rm(this.abs(p));
  }
  async rename(a: string, b: string): Promise<void> {
    await fsp.mkdir(path.dirname(this.abs(b)), this.dirOpts());
    await renameRetrying(this.abs(a), this.abs(b));
  }
  rmdir(p: string, recursive: boolean): Promise<void> {
    return fsp.rm(this.abs(p), { recursive });
  }
  async stat(p: string): Promise<{ size: number; mtime: number } | null> {
    try {
      const s = await fsp.stat(this.abs(p));
      return { size: s.size, mtime: s.mtimeMs };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw e;
    }
  }
}

/**
 * The engine's store on a folder of the filesystem (paths relative to it, written atomically). It
 * is private: new folders 0700, new files 0600 (private-files.ts).
 */
export function nodeStoreAdapter(dir: string): StoreAdapter {
  return new NodeAdapter(path.resolve(dir), { dir: PRIVATE_DIR_MODE, file: PRIVATE_FILE_MODE });
}

/** Kept in step synchronously with every change of the index, before events are emitted. */
export interface IndexListener {
  changed(file: NodeFile, created: boolean): void;
  deleted(path: string): void;
  renamed(oldPath: string, newPath: string): void;
  /** The hash of a note's text as last read (to recognize it under another name); undefined when unknown. */
  hashOf(path: string): string | undefined;
}

/** Whether a vault path is a Markdown note. */
const isNote = (rel: string) => /\.md$/i.test(rel);

/**
 * A note gone and a new one are paired by their text only from this many characters on: an empty
 * note or a short one (a template, "TODO") is the same text as many others, not the same note.
 */
const MIN_PAIRED_TEXT = 32;

/** How many folder listings or file stats the start's walk keeps in flight. */
export const SCAN_CONCURRENCY = 64;

/** How many notes the start reads at a time (the thread pool runs them; see threadpool.ts). */
export const READ_CONCURRENCY = 64;

/**
 * The records the start took from the index on disk are interned this many at a time, one slice
 * per turn of the event loop once the engine answers ({@link NodeMetadataCache.internRecords}).
 * Tests change it.
 */
export const INTERN_SLICE = { records: 1000 };

/** What a file's stat says of its identity: the same file under another name has the same id. */
export interface FileIdentity {
  /** `<device>:<inode>` (the NTFS file id on Windows). */
  id: string;
}

export class NodeVault implements Vault {
  readonly adapter: VaultAdapter;
  readonly events = new EventEmitter();
  listener: IndexListener | null = null;
  private files = new Map<string, NodeFile>();
  private folders = new Map<string, NodeFolder>();
  private root = new NodeFolder("");
  /** The lists `getFiles` and `getMarkdownFiles` give, kept until a file comes, goes or moves. */
  private lists: { all: TFile[]; md: TFile[] } | null = null;
  /** The file ids the last walk ({@link scan}) saw, by path (for the persistent index). */
  walkIds: Map<string, string> | null = null;

  constructor(
    readonly basePath: string,
    readonly config: VaultConfig,
  ) {
    this.adapter = new NodeAdapter(basePath);
    this.events.setMaxListeners(0);
    this.folders.set("", this.root);
  }

  abs(rel: string): string {
    return resolveInVault(this.basePath, rel);
  }

  /**
   * The absolute path of a path the walk listed (names a folder listing gave, joined with `/`): no
   * check for a way out of the vault, which such a path cannot have: over a whole vault, the
   * `path.resolve` of {@link abs} took more time than the walk's own calls.
   */
  listedAbs(rel: string): string {
    if (rel === "") return this.basePath;
    const base = this.basePath.endsWith(path.sep) ? this.basePath : this.basePath + path.sep;
    return base + (path.sep === "/" ? rel : rel.split("/").join(path.sep));
  }

  // --- index ---

  /** Read the whole folder tree into the index (silently: no events). */
  scanSync(): void {
    this.files.clear();
    this.folders.clear();
    this.root = new NodeFolder("");
    this.folders.set("", this.root);
    this.filesChanged();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(this.abs(dir), { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const rel = dir === "" ? e.name : `${dir}/${e.name}`;
        if (e.isDirectory()) {
          this.addFolder(rel);
          walk(rel);
        } else if (e.isFile()) {
          this.addFile(rel, statsOf(fs.statSync(this.abs(rel))));
        }
      }
    };
    walk("");
  }

  /**
   * {@link scanSync} without blocking, and in one walk for the whole start: the folders are listed
   * and the files' stats taken with up to `concurrency` calls in flight, then the index is built in
   * the order a walk lists them (the order {@link scanSync} gives). The same walk finds the
   * temporary files of renames in case only a crash left half done (`renameTemps`, for
   * {@link recoverRenames} once the engine holds its lock) and each file's id ({@link walkIds}).
   */
  async scan(concurrency = SCAN_CONCURRENCY): Promise<{ renameTemps: string[] }> {
    const { listing, stats, renameTemps } = await this.walkTree(concurrency);
    this.files.clear();
    this.folders.clear();
    this.root = new NodeFolder("");
    this.folders.set("", this.root);
    this.filesChanged();
    const ids = new Map<string, string>();
    const build = (dir: string) => {
      for (const e of listing.get(dir) ?? []) {
        if (e.name.startsWith(".")) continue;
        const p = joined(dir, e.name);
        if (e.isDirectory()) {
          this.addFolder(p);
          build(p);
          continue;
        }
        const st = e.isFile() ? stats.get(p) : undefined;
        if (!st) continue;
        this.addFile(p, statsOf(st));
        ids.set(p, `${st.dev}:${st.ino}`);
      }
    };
    build("");
    this.walkIds = ids;
    return { renameTemps };
  }

  /**
   * The paths whose state on disk differs from the index now (a file new, changed or gone, a
   * folder new or gone), found without blocking: a walk as {@link scan}'s, many calls in flight.
   * The watcher's comparison after the start's walk hands them to {@link syncPaths}, which checks
   * each again.
   */
  async changedSinceWalk(concurrency = SCAN_CONCURRENCY): Promise<string[]> {
    const { listing, stats } = await this.walkTree(concurrency);
    const out: string[] = [];
    const listed = new Set<string>();
    for (const [dir, ents] of listing) {
      for (const e of ents) {
        if (e.name.startsWith(".")) continue;
        const p = joined(dir, e.name);
        listed.add(p);
        if (e.isDirectory()) {
          if (!this.folders.has(p)) out.push(p);
          continue;
        }
        const st = stats.get(p);
        const f = this.files.get(p);
        // a file gone between its listing and its stat is reported by the OS, or the next check
        if (st && (!f || f.stat.mtime !== st.mtimeMs || f.stat.size !== st.size)) out.push(p);
      }
    }
    for (const p of [...this.files.keys(), ...this.folders.keys()]) if (p !== "" && !listed.has(p)) out.push(p);
    return out;
  }

  /** Every folder listed and every file stat-ed, `concurrency` calls at a time (dot-folders left out). */
  private async walkTree(concurrency: number): Promise<{ listing: Map<string, fs.Dirent[]>; stats: Map<string, fs.Stats>; renameTemps: string[] }> {
    const listing = new Map<string, fs.Dirent[]>();
    for (let level = [""]; level.length > 0; ) {
      const next: string[] = [];
      await eachLimit(level, concurrency, async (dir) => {
        let ents: fs.Dirent[];
        try {
          ents = await fsp.readdir(this.listedAbs(dir), { withFileTypes: true });
        } catch (e) {
          if (dir === "") throw e;
          ents = []; // removed since its parent was listed: the watcher reports it
        }
        listing.set(dir, ents);
        for (const e of ents) if (e.isDirectory() && !e.name.startsWith(".")) next.push(joined(dir, e.name));
      });
      level = next;
    }
    const files: string[] = [];
    const renameTemps: string[] = [];
    for (const [dir, ents] of listing) {
      for (const e of ents) {
        if (!e.isFile()) continue;
        if (!e.name.startsWith(".")) files.push(joined(dir, e.name));
        else if (e.name.startsWith(RENAME_TEMP_PREFIX)) renameTemps.push(joined(dir, e.name));
      }
    }
    const stats = new Map<string, fs.Stats>();
    await eachLimit(files, concurrency, async (p) => {
      try {
        stats.set(p, await fsp.stat(this.listedAbs(p)));
      } catch {
        // removed since its folder was listed: the watcher reports it
      }
    });
    return { listing, stats, renameTemps };
  }

  /**
   * Finish the renames in case only a crash left half done (between their two renames: the file
   * under its temporary name, `.datanotes-rename-…--<target>`): each is renamed to its target,
   * unless a file has that name (in any case) by now. `temps`: the temporary files a walk found
   * ({@link scan}); without, the vault is walked for them. Returns the files put back (their vault
   * paths) and the temporary files left (none to put back, or no target in the name).
   */
  recoverRenames(temps?: readonly string[]): { recovered: string[]; left: string[] } {
    const out = { recovered: [] as string[], left: [] as string[] };
    for (const rel of temps ?? this.renameTemps()) {
      const dir = dirname(rel);
      const target = RENAME_TEMP.exec(basename(rel))?.[1];
      const to = target === undefined ? null : dir === "" ? target : `${dir}/${target}`;
      // a file system that ignores case finds a file of that name in another case too
      if (to === null || fs.existsSync(this.abs(to))) {
        out.left.push(rel);
        continue;
      }
      try {
        fs.renameSync(this.abs(rel), this.abs(to));
      } catch (e) {
        /* v8 ignore next -- a rename the file system refuses (a reader holding the file on Windows) */
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        continue; // gone since the walk
      }
      out.recovered.push(to);
    }
    return out;
  }

  /** The temporary files of renames in case only, in every folder of the vault (dot-folders aside). */
  private renameTemps(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(this.abs(dir), { withFileTypes: true })) {
        const rel = dir === "" ? e.name : `${dir}/${e.name}`;
        if (e.isDirectory() && !e.name.startsWith(".")) walk(rel);
        else if (e.isFile() && e.name.startsWith(RENAME_TEMP_PREFIX)) out.push(rel);
      }
    };
    walk("");
    return out;
  }

  /** A file came, went or moved: the lists of files are made again when asked for. */
  private filesChanged(): void {
    this.lists = null;
  }

  private parentOf(rel: string): NodeFolder {
    const d = dirname(rel);
    return this.folders.get(d) ?? this.addFolder(d);
  }

  private addFolder(rel: string): NodeFolder {
    const hit = this.folders.get(rel);
    if (hit) return hit;
    const p = intern(rel);
    const f = new NodeFolder(p);
    this.folders.set(p, f);
    if (p !== "") this.parentOf(p).children.push(f);
    return f;
  }

  private addFile(rel: string, stat: NodeFileStats): NodeFile {
    const hit = this.files.get(rel);
    if (hit) {
      hit.stat = stat;
      return hit;
    }
    const p = intern(rel);
    const f = new NodeFile(p, stat);
    this.files.set(p, f);
    this.filesChanged();
    this.parentOf(p).children.push(f);
    return f;
  }

  private detach(item: TAbstractFile): void {
    const parent = this.folders.get(dirname(item.path));
    if (!parent) return;
    // in place, without a copy of the list: a folder emptied file by file stays linear per file
    const i = parent.children.indexOf(item);
    if (i >= 0) parent.children.splice(i, 1);
  }

  private dropFile(rel: string): NodeFile | null {
    const f = this.files.get(rel);
    if (!f) return null;
    this.files.delete(rel);
    this.filesChanged();
    this.detach(f);
    return f;
  }

  private dropFolder(rel: string): NodeFolder | null {
    const f = this.folders.get(rel);
    if (!f || rel === "") return null;
    this.forgetTree(f);
    this.detach(f);
    return f;
  }

  /** Drop a folder and everything under it from the index (its own place in its parent is the caller's). */
  private forgetTree(folder: NodeFolder): void {
    for (const c of folder.children) {
      if (c instanceof NodeFolder) this.forgetTree(c);
      else this.files.delete(c.path);
    }
    this.filesChanged();
    folder.children = [];
    this.folders.delete(folder.path);
  }

  /**
   * The id of a file on disk (`<device>:<inode>`, the NTFS file id on Windows): the walk's while the
   * file did not change since, else from a stat now; null when there is none.
   */
  fileId(rel: string): string | null {
    const id = this.walkIds?.get(rel);
    if (id !== undefined) return id;
    const st = this.statOf(rel);
    return st ? `${st.dev}:${st.ino}` : null;
  }

  private emit(name: string, ...args: unknown[]): void {
    const [item, old] = args as [TAbstractFile, string | undefined];
    // a file changed: its id may have changed too (an atomic write is a new file)
    if (this.walkIds && item instanceof NodeFile) {
      this.walkIds.delete(item.path);
      if (old !== undefined) this.walkIds.delete(old);
    }
    if (this.listener && item instanceof NodeFile) {
      if (name === "create" || name === "modify") this.listener.changed(item, name === "create");
      else if (name === "delete") this.listener.deleted(item.path);
      else if (name === "rename" && old !== undefined) this.listener.renamed(old, item.path);
    }
    this.events.emit(name, ...args);
  }

  async refreshStat(f: NodeFile): Promise<void> {
    f.stat = statsOf(await fsp.stat(this.abs(f.path)));
  }

  /**
   * Bring one path of the index in line with the disk (for the watcher). Emits create / modify /
   * delete when something changed; returns what happened.
   */
  /**
   * Paths the vault is writing right now (and the folders above them). Between the change on disk
   * and the index update there is an `await`: a rescan landing there must not take the vault's own
   * write for a change made outside (a moved file would be dropped as deleted and added again).
   */
  private readonly busy = new Map<string, number>();

  private async guarded<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    for (const p of paths) this.busy.set(p, (this.busy.get(p) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      for (const p of paths) {
        const n = this.busy.get(p)! - 1; // counted above
        if (n <= 0) this.busy.delete(p);
        else this.busy.set(p, n);
      }
    }
  }

  private isBusy(rel: string): boolean {
    for (const p of this.busy.keys()) if (rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`)) return true;
    return false;
  }

  syncPath(rel: string, seen: "listed" | "unlisted" | "unknown" = "unknown"): "created" | "modified" | "deleted" | "renamed" | null {
    if (rel === "" || hidden(rel)) return null;
    if (this.isBusy(rel)) return null; // the vault's own write in progress: the next scan sees it settled
    // Where the file system ignores case (Windows, macOS), a path renamed in case only still stats
    // under its old spelling: the path counts only as the folder listing spells it.
    const st = seen === "unlisted" ? null : seen === "listed" ? this.statOf(rel) : this.present(rel);
    const file = this.files.get(rel);
    const folder = this.folders.get(rel);
    if (!st) {
      if (file) {
        this.dropFile(rel);
        this.emit("delete", file);
        return "deleted";
      }
      if (folder) {
        const gone = [...this.files.values()].filter((f) => f.path.startsWith(`${rel}/`));
        this.dropFolder(rel);
        for (const f of gone) this.emit("delete", f);
        this.emit("delete", folder);
        return "deleted";
      }
      return null;
    }
    if (st.isDirectory()) {
      if (folder) return null;
      const f = this.addFolder(rel);
      this.emit("create", f);
      for (const e of fs.readdirSync(this.abs(rel))) this.syncPath(`${rel}/${e}`, "listed");
      return "created";
    }
    /* v8 ignore next -- platform: a FIFO, socket or device in the vault (none on Windows; the tests make none) */
    if (!st.isFile()) return null;
    const stat = statsOf(st);
    if (!file) {
      // The same file under its old spelling, still in the index (a rename in case only whose old
      // path no event reported): it is renamed, so the index keeps one path for it.
      const variant = this.staleVariant(rel);
      if (variant !== undefined && this.renameIndexed(variant, rel, false)) return "renamed";
      const f = this.addFile(rel, stat);
      this.emit("create", f);
      return "created";
    }
    if (file.stat.mtime === stat.mtime && file.stat.size === stat.size) return null; // our own write, or no change
    file.stat = stat;
    this.emit("modify", file);
    return "modified";
  }

  /**
   * Bring these paths of the index in line with the disk, as one batch (the paths the watcher saw
   * change together). A note gone from the disk and a new one with its content, or the same file in
   * another case, both in the batch, is that note renamed or moved by hand: announced as a
   * `rename`, not a delete and a create. Returns the paths that changed.
   */
  syncPaths(rels: readonly string[]): string[] {
    const list = new Set<string>();
    for (const rel of rels) {
      list.add(rel);
      // a new folder: its notes may be moved ones
      if (rel !== "" && !hidden(rel) && !this.folders.has(rel) && this.present(rel)?.isDirectory()) for (const p of this.listTree(rel)) list.add(p);
    }
    const paths = [...list].filter((p) => p !== "" && !hidden(p) && !this.isBusy(p));
    const gone = paths.filter((p) => isNote(p) && this.files.has(p) && !this.present(p) && this.present(dirname(p)) !== null);
    const born = paths.filter((p) => isNote(p) && !this.files.has(p) && this.present(p)?.isFile() === true);
    const changed = this.pairMoves(gone, born);
    for (const p of list) if (this.syncPath(p)) changed.push(p);
    return [...new Set(changed)];
  }

  /** Every path under the folder `rel` (dot entries left out), parents before their children. */
  private listTree(rel: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(this.abs(rel), { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = `${rel}/${e.name}`;
      out.push(p);
      if (e.isDirectory()) out.push(...this.listTree(p));
    }
    return out;
  }

  /**
   * Notes gone from the disk (`gone`, still in the index) and new ones (`born`), seen together. A
   * new note that is a gone one in another case (file systems that ignore case), or the only new
   * one with the text of the only gone one with that text, is that note renamed or moved: each
   * pair is announced as a `rename`. By text, only a note of {@link MIN_PAIRED_TEXT} characters or
   * more that kept its name or its folder is paired (a short text, or one in another folder under
   * another name, is likely another note: a delete and a create; a row is still recognized by its
   * id in the change feed). Notes of a folder gone as a whole are not paired (a folder
   * moved by hand stays deletes and creates; a moved database folder is recognized by its id).
   * Returns the paths of both sides of each pair.
   */
  private pairMoves(gone: readonly string[], born: readonly string[]): string[] {
    if (gone.length === 0 || born.length === 0) return [];
    const pairs: [string, string, boolean][] = [];
    const byLower = new Map(gone.map((g) => [g.toLowerCase(), g]));
    const left = new Set(gone);
    const rest: string[] = [];
    for (const b of born) {
      const g = byLower.get(b.toLowerCase());
      if (g !== undefined && left.has(g)) {
        left.delete(g);
        pairs.push([g, b, false]);
      } else rest.push(b);
    }
    const goneByHash = new Map<string, string[]>();
    for (const g of left) {
      const h = this.listener?.hashOf(g);
      if (h !== undefined) goneByHash.set(h, [...(goneByHash.get(h) ?? []), g]);
    }
    if (goneByHash.size > 0) {
      const bornByHash = new Map<string, string[]>();
      for (const b of rest) {
        const h = this.hashOnDisk(b, MIN_PAIRED_TEXT);
        if (h !== undefined) bornByHash.set(h, [...(bornByHash.get(h) ?? []), b]);
      }
      for (const [h, bs] of bornByHash) {
        const gs = goneByHash.get(h);
        // two notes with the same text gone, or two new: which went where is not known; a note
        // that kept neither its name nor its folder is another note with the same text (a template)
        if (gs?.length === 1 && bs.length === 1 && (basename(gs[0]!) === basename(bs[0]!) || dirname(gs[0]!) === dirname(bs[0]!))) pairs.push([gs[0]!, bs[0]!, true]);
      }
    }
    const out: string[] = [];
    for (const [from, to, same] of pairs) if (this.renameIndexed(from, to, same)) out.push(from, to);
    return out;
  }

  /**
   * A note of the index moved on disk by another program from `from` to `to`: the same file object
   * takes the new path (new folders are announced first), then `rename` is announced (as made by
   * another program: `{ external: true }`, a hand edit also while the engine writes), and `modify`
   * when its text changed too (`sameText`: known to be the same).
   */
  private renameIndexed(from: string, to: string, sameText: boolean): boolean {
    const st = this.statOf(to);
    /* v8 ignore next -- a race: the new file went away between the listing and this stat */
    if (!st) return false;
    const f = this.files.get(from)!; // gone ones and stale variants are in the index
    const was = sameText ? undefined : this.listener?.hashOf(from);
    this.indexFolder(dirname(to));
    this.detach(f);
    this.files.delete(from);
    f.path = intern(to);
    f.stat = statsOf(st);
    this.files.set(f.path, f);
    this.filesChanged();
    this.parentOf(to).children.push(f);
    this.emit("rename", f, from, { external: true } satisfies RenameInfo);
    if (!sameText && (was === undefined || was !== this.hashOnDisk(to))) this.emit("modify", f);
    return true;
  }

  /** The hash of a file's text on disk; undefined when it cannot be read or has fewer than `min` characters (blanks aside). */
  private hashOnDisk(rel: string, min = 0): string | undefined {
    try {
      const text = fs.readFileSync(this.abs(rel), "utf8");
      return text.trim().length < min ? undefined : contentHash(text);
      /* v8 ignore next 3 -- a race: the file went away right after its stat */
    } catch {
      return undefined;
    }
  }

  /** Add a folder (and the folders above it) to the index, announcing each new one. */
  private indexFolder(rel: string): void {
    if (rel === "" || this.folders.has(rel)) return;
    this.indexFolder(dirname(rel));
    this.emit("create", this.addFolder(rel));
  }

  /**
   * A file of the index spelled like `rel` but for case, in the same folder, that the disk no
   * longer has as spelled (the same file renamed in case only on a file system that ignores case,
   * or a file gone on one that does not).
   */
  private staleVariant(rel: string): string | undefined {
    const lower = rel.toLowerCase();
    for (const c of this.folders.get(dirname(rel))?.children ?? []) {
      if (c instanceof NodeFile && c.path !== rel && c.path.length === rel.length && c.path.toLowerCase() === lower && !this.isBusy(c.path) && !this.present(c.path)) return c.path;
    }
    return undefined;
  }

  /** Whether two paths name the same file on disk (one path in two cases, where the file system ignores case). */
  private sameFile(a: string, b: string): boolean {
    const x = this.statOf(a);
    const y = this.statOf(b);
    return x !== null && y !== null && x.ino === y.ino && x.dev === y.dev;
  }

  private statOf(rel: string): fs.Stats | null {
    try {
      return fs.statSync(this.abs(rel));
    } catch {
      return null;
    }
  }

  /** The file or folder at `rel` as the disk has it, spelled as its folder lists it; null when there is none. */
  private present(rel: string): fs.Stats | null {
    const st = this.statOf(rel);
    return st && (rel === "" || this.spelledAsListed(rel)) ? st : null;
  }

  /** Whether every segment of `rel` is spelled as its folder lists it (false on a case mismatch). */
  private realBase: string | undefined;

  private spelledAsListed(rel: string): boolean {
    if (process.platform === "linux") return true; // a case-sensitive file system: the stat said it
    if (process.platform === "win32") {
      try {
        // the path as the file system spells it (Windows gives every segment its true case)
        this.realBase ??= fs.realpathSync.native(this.basePath);
        const real = fs.realpathSync.native(this.abs(rel));
        const spelled = path.join(this.realBase, ...rel.split("/"));
        if (real === spelled) return true;
        if (real.toLowerCase() === spelled.toLowerCase()) return false;
      } catch {
        return false;
      }
    }
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      try {
        const name = parts[i]!.normalize("NFC");
        if (!fs.readdirSync(this.abs(parts.slice(0, i).join("/"))).some((e) => e === parts[i] || e.normalize("NFC") === name)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Compare the whole tree with the index (startup reconciliation, polling); returns the paths that
   * changed. A note renamed or moved meanwhile is announced as a rename (see {@link syncPaths}).
   */
  rescan(): string[] {
    const listed: string[] = [];
    const folders = new Set<string>();
    const walk = (dir: string) => {
      let ents: fs.Dirent[] = [];
      try {
        ents = fs.readdirSync(this.abs(dir), { withFileTypes: true });
        /* v8 ignore start -- a race: the folder was removed between its listing and this read */
      } catch {
        return;
      }
      /* v8 ignore stop */
      for (const e of ents) {
        if (e.name.startsWith(".")) continue;
        const rel = dir === "" ? e.name : `${dir}/${e.name}`;
        listed.push(rel);
        if (e.isDirectory()) {
          folders.add(rel);
          walk(rel);
        }
      }
    };
    walk("");
    const seen = new Set(listed);
    const kept = (p: string) => dirname(p) === "" || folders.has(dirname(p));
    const gone = [...this.files.keys()].filter((p) => isNote(p) && !seen.has(p) && kept(p) && !this.isBusy(p));
    const born = listed.filter((p) => isNote(p) && !folders.has(p) && !this.files.has(p) && !this.isBusy(p));
    const changed = this.pairMoves(gone, born);
    for (const rel of listed) if (this.syncPath(rel, "listed")) changed.push(rel);
    for (const p of [...this.files.keys(), ...this.folders.keys()]) {
      if (p !== "" && !seen.has(p) && this.syncPath(p, "unlisted")) changed.push(p);
    }
    return changed;
  }

  // --- Vault API ---

  getAbstractFileByPath(p: string): TAbstractFile | null {
    const rel = p.replace(/^\/+|\/+$/g, "");
    if (rel === "") return this.root;
    if (hidden(rel)) return null;
    return this.files.get(rel) ?? this.folders.get(rel) ?? null;
  }

  /** The notes, in the index's order. The same list until a file comes, goes or moves: do not change it. */
  getMarkdownFiles(): TFile[] {
    return this.listed().md;
  }

  /** Every file, in the index's order. The same list until a file comes, goes or moves: do not change it. */
  getFiles(): TFile[] {
    return this.listed().all;
  }

  private listed(): { all: TFile[]; md: TFile[] } {
    if (!this.lists) {
      const all = [...this.files.values()];
      this.lists = { all, md: all.filter((f) => f.extension === "md") };
    }
    return this.lists;
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.folders.values(), ...this.files.values()];
  }

  getRoot(): TFolder {
    return this.root;
  }

  read(file: TFile): Promise<string> {
    return fsp.readFile(this.abs(file.path), "utf8");
  }

  /** Write a file's text (internal: also used by the file manager). */
  async writeText(file: NodeFile, data: string): Promise<void> {
    await this.guarded([file.path], async () => {
      await atomicWrite(this.abs(file.path), data);
      await this.refreshStat(file);
    });
    // the metadata cache parses the text just written instead of reading it back from the disk
    this.written = { path: file.path, data };
    try {
      this.emit("modify", file);
    } finally {
      this.written = null;
    }
  }

  /** The text of the write being announced (see writeText), for the metadata cache. */
  written: { path: string; data: string } | null = null;

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const f = this.files.get(file.path);
    if (!f) throw new Error(`file not found: ${file.path}`);
    const next = fn(await this.read(f));
    await this.writeText(f, next);
    return next;
  }

  async create(p: string, data: string): Promise<TFile> {
    const rel = p.replace(/^\/+/, "");
    if (fs.existsSync(this.abs(rel))) throw new Error(`File already exists: ${rel}`);
    const f = await this.guarded([rel], async () => {
      await this.ensureFolder(dirname(rel));
      await atomicWrite(this.abs(rel), data);
      return this.addFile(rel, statsOf(await fsp.stat(this.abs(rel))));
    });
    this.emit("create", f);
    return f;
  }

  private async ensureFolder(rel: string): Promise<void> {
    if (rel === "" || this.folders.has(rel)) return;
    await this.ensureFolder(dirname(rel));
    await fsp.mkdir(this.abs(rel), { recursive: true });
    this.emit("create", this.addFolder(rel));
  }

  async createFolder(p: string): Promise<unknown> {
    const rel = p.replace(/^\/+|\/+$/g, "");
    if (this.folders.has(rel)) throw new Error(`Folder already exists: ${rel}`);
    await this.ensureFolder(rel);
    return this.folders.get(rel);
  }

  async delete(file: TAbstractFile, force?: boolean): Promise<void> {
    return this.guarded([file.path], () => this.deleteNow(file, force));
  }

  private async deleteNow(file: TAbstractFile, force?: boolean): Promise<void> {
    const rel = file.path;
    if (this.folders.has(rel)) {
      const gone = [...this.files.values()].filter((f) => f.path.startsWith(`${rel}/`));
      await fsp.rm(this.abs(rel), { recursive: force === true });
      const folder = this.dropFolder(rel)!;
      for (const f of gone) this.emit("delete", f);
      this.emit("delete", folder);
      return;
    }
    await fsp.rm(this.abs(rel));
    const f = this.dropFile(rel);
    if (f) this.emit("delete", f);
  }

  /** Move to `.trash/` (Obsidian's local trash; also for "system", which Node cannot reach) or delete. */
  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    if (this.config.trashOption === "none") return this.delete(file, true);
    return this.guarded([file.path], () => this.trashNow(file, system));
  }

  private async trashNow(file: TAbstractFile, _system: boolean): Promise<void> {
    const target = await this.freeName(`.trash/${basename(file.path)}`);
    const isFolder = this.folders.has(file.path);
    const gone = isFolder ? [...this.files.values()].filter((f) => f.path.startsWith(`${file.path}/`)) : [];
    await fsp.mkdir(this.abs(".trash"), { recursive: true });
    await renameRetrying(this.abs(file.path), this.abs(target));
    if (isFolder) {
      const folder = this.dropFolder(file.path)!;
      for (const f of gone) this.emit("delete", f);
      this.emit("delete", folder);
    } else {
      const f = this.dropFile(file.path);
      if (f) this.emit("delete", f);
    }
  }

  private async freeName(rel: string): Promise<string> {
    if (!fs.existsSync(this.abs(rel))) return rel;
    const ext = path.posix.extname(rel);
    const stem = rel.slice(0, rel.length - ext.length);
    let n = 1;
    while (fs.existsSync(this.abs(`${stem} ${n}${ext}`))) n++;
    return `${stem} ${n}${ext}`;
  }

  /**
   * Move a file or folder on disk and in the index (paths of the same objects change, like in
   * Obsidian). Emits `rename` for every moved file and folder. Returns old → new file paths.
   */
  async move(item: TAbstractFile, newPath: string): Promise<Map<string, string>> {
    const from = item.path;
    const to = newPath.replace(/^\/+|\/+$/g, "");
    if (from === to) return new Map();
    return this.guarded([from, to], () => this.moveNow(item, from, to));
  }

  private async moveNow(item: TAbstractFile, from: string, to: string): Promise<Map<string, string>> {
    // in case only, the destination may be the file itself (a file system that ignores case)
    const caseOnly = from.toLowerCase() === to.toLowerCase();
    if (fs.existsSync(this.abs(to)) && !(caseOnly && this.sameFile(from, to))) throw new Error(`Destination exists: ${to}`);
    // Checked before the disk changes: an error must leave the file where it was.
    const isFolder = this.folders.has(from);
    if (!isFolder && !this.files.has(from)) throw new Error(`file not found: ${from}`);
    await this.ensureFolder(dirname(to));
    if (caseOnly) await this.renameThroughTemporary(from, to);
    else await renameRetrying(this.abs(from), this.abs(to));
    const moved = new Map<string, string>();
    const renamed: [TAbstractFile, string][] = [];
    this.filesChanged();
    if (isFolder) {
      const folder = this.folders.get(from)!;
      const files = [...this.files.values()].filter((f) => f.path.startsWith(`${from}/`));
      const subfolders = [...this.folders.values()].filter((f) => f.path.startsWith(`${from}/`));
      this.detach(folder);
      this.folders.delete(from);
      for (const f of subfolders) this.folders.delete(f.path);
      for (const f of files) this.files.delete(f.path);
      folder.path = intern(to);
      this.folders.set(folder.path, folder);
      this.parentOf(to).children.push(folder);
      renamed.push([folder, from]);
      for (const f of subfolders) {
        const old = f.path;
        f.path = intern(to + old.slice(from.length));
        this.folders.set(f.path, f);
        renamed.push([f, old]);
      }
      for (const f of files) {
        const old = f.path;
        f.path = intern(to + old.slice(from.length));
        this.files.set(f.path, f);
        moved.set(old, f.path);
        renamed.push([f, old]);
      }
    } else {
      const f = this.files.get(from)!;
      this.detach(f);
      this.files.delete(from);
      f.path = intern(to);
      this.files.set(f.path, f);
      this.parentOf(to).children.push(f);
      await this.refreshStat(f);
      moved.set(from, to);
      renamed.push([f, from]);
    }
    for (const [obj, old] of renamed) this.emit("rename", obj, old);
    return moved;
  }

  /**
   * A rename in case only (`Note.md` to `note.md`) goes through a temporary name, as the database
   * folder's does: a file system that ignores case may take a direct one for no change at all, and
   * the file would keep its old name while the index has the new one. The temporary name is a
   * dot-file next to the target, which the index, the watcher and git sync leave out. It ends with
   * the target's name: a crash between the two renames leaves a file {@link recoverRenames} puts
   * where it was going at the next start.
   */
  private async renameThroughTemporary(from: string, to: string): Promise<void> {
    const tmp = `${dirname(to) === "" ? "" : `${dirname(to)}/`}${temporaryName(basename(to))}`;
    await renameRetrying(this.abs(from), this.abs(tmp));
    try {
      await renameRetrying(this.abs(tmp), this.abs(to));
      /* v8 ignore start -- the second rename fails only if something took the name in between */
    } catch (e) {
      await renameRetrying(this.abs(tmp), this.abs(from));
      throw e;
    }
    /* v8 ignore stop */
  }

  on(name: string, cb: (...args: never[]) => unknown): EventRef {
    this.events.on(name, cb as (...args: unknown[]) => void);
    return { name, cb };
  }

  offref(ref: EventRef): void {
    const r = ref as { name?: string; cb?: (...args: unknown[]) => void };
    if (r.name && r.cb) this.events.off(r.name, r.cb);
  }
}

/** A link of a note as the index keeps it: its target, without its place in the text (read again to rewrite it). */
export interface NoteLink {
  linkpath: string;
  subpath: string;
}

interface NoteMeta {
  /** What `getFileCache` gives: the same object every time, as Obsidian does (callers do not change it). */
  cache: CachedMetadata;
  links: NoteLink[];
  /** Hash of the text read (a note moved outside is recognized by it). */
  hash: string;
}

/** A note's text as the start read it, with its parse, for the engine's file cache. */
interface StartText {
  content: string;
  hash: string;
  frontmatter?: { ordered: OrderedFrontmatter; body: string };
}

/** A note the start found in the index on disk: its hash and parse for the engine's file cache, no text. */
interface KnownNote {
  hash: string;
  parse?: { ordered: OrderedFrontmatter; bodyStart: number };
}

/** The index on disk at start: the files it records, whether their links can be trusted, and its keeper. */
export interface StartIndex {
  files: ReadonlyMap<string, FileRecord>;
  /** The links recorded agree with the files recorded (the last write left the index caught up). */
  links: boolean;
  keeper: IndexKeeper;
}

/** How a start indexed the vault: its notes, how many it read, how many it found moved by their file id. */
export interface IndexedVault {
  notes: number;
  read: number;
  moved: number;
}

/** A note at start: its metadata and record, and where it came from (read, read again, recorded, moved). */
interface Known {
  meta: NoteMeta;
  record: NoteRecord;
  /** Where its links led, as recorded (null: resolve them). */
  links: NoteLinks | null;
  text?: StartText;
  /** Read and parsed. */
  read?: boolean;
  /** Read again within the racy window, the same text as recorded. */
  again?: boolean;
  /** The path it was recorded under (moved while the engine was stopped). */
  from?: string;
}

/**
 * Whether a recorded file still has its stat and was recorded well after its last write (git's
 * racy rule). `samePath`: the change time too (a write that restored the old mtime moves it); a
 * file found under another path by its id does not compare it (a rename moves it on Linux).
 */
function unchanged(r: FileRecord, stat: NodeFileStats, samePath = true): boolean {
  if (r.note == null || r.mtime !== stat.mtime || r.size !== stat.size || stat.mtime >= r.indexedAt - RACY_MS) return false;
  return !samePath || r.changed === null || stat.changed === undefined || r.changed === stat.changed;
}

/**
 * A note's metadata from its record: what parsing its text gives. The record's strings (JSON of
 * the index on disk: new copies) are interned later, in place ({@link internRecord}): the metadata
 * holds the same strings, and V8 turns each into a forward to its one copy.
 */
function metaOf(r: NoteRecord): NoteMeta {
  const frontmatter = r.parse && r.parse.ordered.length > 0 ? (Object.fromEntries(r.parse.ordered) as Record<string, unknown>) : undefined;
  return {
    cache: { ...(frontmatter ? { frontmatter } : {}), tags: r.tags.map((tag) => ({ tag })) },
    links: r.links.map(([linkpath, subpath]) => ({ linkpath, subpath })),
    hash: r.hash,
  };
}

/** Intern a record's front matter, tags and links in place (its hash is unique to its note: left as it is). */
function internRecord(r: NoteRecord): void {
  if (r.parse) internAll(r.parse.ordered);
  internAll(r.tags);
  internAll(r.links);
}

// A tag starts after whitespace or at the start of a line (not after "(") and is not all digits.
const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

function tagsOf(body: string): { tag: string }[] {
  const out: { tag: string }[] = [];
  // No tags inside code, wikilinks (aliases included) or Markdown links.
  const noCode = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/!?\[\[[^\]\n]*\]\]/g, " ")
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, " ");
  for (const m of noCode.matchAll(TAG_RE)) out.push({ tag: detached(`#${m[1]}`) });
  return out;
}

export class NodeMetadataCache implements MetadataCache {
  readonly events = new EventEmitter();
  private meta = new Map<string, NoteMeta>();
  private linkResolver: LinkResolver;
  /**
   * Links are resolved as files come and go: a file created, deleted or renamed re-resolves only
   * the notes whose links look up its name ({@link lookers}), never every link of the vault.
   */
  private resolved: Record<string, Record<string, number>> = {};
  private unresolved: Record<string, Record<string, number>> = {};
  /** `resolved` transposed: target path → (source path → number of links), the backlinks. */
  private inbound = new Map<string, Map<string, number>>();
  /** The names each note's links look up (see `linkLookupNames`), and the notes looking up each name. */
  private names = new Map<string, readonly string[]>();
  private lookers = new Map<string, Set<string>>();
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The records the start took from the index on disk, interned from `internAt` on ({@link internRecords}). */
  private uninterned: NoteRecord[] = [];
  private internAt = 0;
  private interning: Promise<void> | null = null;
  private internNext: ReturnType<typeof setImmediate> | null = null;
  private internDone: (() => void) | null = null;

  constructor(private readonly vault: NodeVault) {
    this.events.setMaxListeners(0);
    this.linkResolver = new LinkResolver(this.fileIndex());
  }

  get resolver(): LinkResolver {
    return this.linkResolver;
  }

  /** source path → (target path → number of links). */
  get resolvedLinks(): Record<string, Record<string, number>> {
    return this.resolved;
  }

  get unresolvedLinks(): Record<string, Record<string, number>> {
    return this.unresolved;
  }

  /** The notes linking to `path`, each with its number of links to it (Obsidian's backlinks). */
  backlinksOf(path: string): Record<string, number> {
    return Object.fromEntries(this.inbound.get(path) ?? []);
  }

  /** The vault index on disk, while the host keeps it up to date ({@link indexAllAsync}). */
  keeper: IndexKeeper | null = null;

  /**
   * The notes as the start read them (a text with its parse) or found them in the index on disk (a
   * parse and hash, no text), until the host hands them to the engine's file cache ({@link
   * openNodeVault}): the engine's first reads of every row then read nothing again.
   */
  startTexts: Map<NodeFile, StartText | KnownNote> | null = null;

  /** Parse every note and resolve every link (startup). */
  indexAll(): void {
    this.meta.clear();
    const texts = new Map<NodeFile, StartText>();
    for (const f of this.vault.getMarkdownFiles()) {
      const r = this.read(fs.readFileSync(this.vault.abs(f.path), "utf8"));
      texts.set(f as NodeFile, r.text);
      this.meta.set(f.path, r.meta);
    }
    this.startTexts = texts;
    this.linkResolver.rebuild(this.fileIndex());
    this.resolveAll();
  }

  /**
   * {@link indexAll} without blocking: the notes are read `concurrency` at a time (the thread
   * pool reads while the main thread parses), and kept in the order of the vault's list of notes.
   * A note gone since the walk is left out: the watcher reports it.
   *
   * With the vault index on disk (`index`: its records and keeper), a note whose stat is the one
   * recorded, and that was not written within RACY_MS of being recorded, is not read: its record
   * gives its metadata, its parse and hash for the engine's file cache, and where its links lead
   * (resolved again only where a file came or went since). A note recorded under a path that has
   * no file now, found under another with its file id and stat, was moved while the engine was
   * stopped: it is not read either. The others are read, and recorded.
   */
  async indexAllAsync(concurrency = READ_CONCURRENCY, index: StartIndex | null = null): Promise<IndexedVault> {
    const files = this.vault.getMarkdownFiles() as NodeFile[];
    const all = this.vault.getFiles() as NodeFile[];
    const present = new Set(all.map((f) => f.path));
    const known = index?.files ?? null;
    const ids = this.vault.walkIds;
    // notes recorded under a path that has no file now, by their file id
    const gone = new Map<string, FileRecord>();
    if (known) for (const r of known.values()) if (r.note && r.fileId !== null && !present.has(r.path)) gone.set(r.fileId, r);
    const got: (Known | undefined)[] = new Array(files.length);
    const toRead: number[] = [];
    files.forEach((f, i) => {
      const at = known?.get(f.path);
      if (at?.note && unchanged(at, f.stat)) {
        got[i] = { meta: metaOf(at.note), record: at.note, links: index!.links ? at.links : null };
        return;
      }
      const was = at === undefined ? gone.get(ids?.get(f.path) ?? "") : undefined;
      if (was && unchanged(was, f.stat, false)) {
        gone.delete(was.fileId!);
        got[i] = { meta: metaOf(was.note!), record: was.note!, links: null, from: was.path };
        return;
      }
      toRead.push(i);
    });
    // the gone notes not found by their id (a copy, a tool that writes a new file), by their hash once read
    const goneByHash = new Map<string, FileRecord>();
    for (const r of gone.values()) goneByHash.set(r.note!.hash, r);
    if (known) for (const r of known.values()) if (r.note && r.fileId === null && !present.has(r.path)) goneByHash.set(r.note.hash, r);
    await eachLimit(toRead, concurrency, async (i) => {
      const f = files[i]!;
      let text: string;
      try {
        text = await fsp.readFile(this.vault.listedAbs(f.path), "utf8");
      } catch {
        return; // removed since the walk: the watcher reports it
      }
      const at = known?.get(f.path);
      // recorded with this stat, within the racy window: the same text keeps its record
      if (at?.note && at.mtime === f.stat.mtime && at.size === f.stat.size && contentHash(text) === at.note.hash) {
        const parse = at.note.parse;
        const frontmatter = parse ? { frontmatter: { ordered: parse.ordered, body: text.slice(parse.bodyStart) } } : {};
        got[i] = { meta: metaOf(at.note), record: at.note, links: index!.links ? at.links : null, text: { content: text, hash: at.note.hash, ...frontmatter }, again: true };
        return;
      }
      const r = this.read(text);
      const was = at === undefined ? goneByHash.get(r.record.hash) : undefined;
      if (was) goneByHash.delete(was.note!.hash);
      got[i] = { meta: r.meta, record: r.record, links: null, text: r.text, read: true, ...(was ? { from: was.path } : {}) };
    });
    this.meta.clear();
    const texts = new Map<NodeFile, StartText | KnownNote>();
    files.forEach((f, i) => {
      const g = got[i];
      if (!g) return;
      this.meta.set(f.path, g.meta);
      if (!g.read) this.uninterned.push(g.record);
      texts.set(f as NodeFile, g.text ?? { hash: g.record.hash, ...(g.record.parse ? { parse: g.record.parse } : {}) });
    });
    this.startTexts = texts;
    this.keeper = index?.keeper ?? null;
    // where the links lead: as recorded, but where a file came or went since (or a recorded target is gone)
    this.linkResolver.rebuild(this.fileIndex());
    this.resolved = {};
    this.unresolved = {};
    this.inbound.clear();
    this.names.clear();
    this.lookers.clear();
    files.forEach((f, i) => {
      const g = got[i];
      if (!g) return;
      const l = g.links;
      if (l && Object.keys(l.resolved).every((d) => present.has(d))) this.keep(f.path, l.resolved, l.unresolved);
      else this.resolveOne(f.path);
    });
    if (known && index!.links) {
      for (const p of present) if (!known.has(p)) this.reresolve(fileLookupNames(p));
      for (const p of known.keys()) if (!present.has(p)) this.reresolve(fileLookupNames(p));
    }
    // the index learns what the start found
    const k = this.keeper;
    if (k) {
      const moved = new Set<string>();
      files.forEach((f, i) => {
        const g = got[i];
        if (g?.from !== undefined) {
          moved.add(g.from);
          k.renamed(g.from, f.path);
        } else if (g?.again) k.touch(f.path); // recorded again, out of the racy window
        else if (g?.read) k.noteRead(f.path, g.record, g.text!.content);
      });
      for (const p of index!.files.keys()) if (!present.has(p) && !moved.has(p)) k.deleted(p);
      for (const f of all) {
        const r = known?.get(f.path);
        if (!/\.md$/i.test(f.path) && (!r || r.note !== null || r.mtime !== f.stat.mtime || r.size !== f.stat.size)) k.touch(f.path);
      }
    }
    return { notes: files.length, read: toRead.length, moved: got.filter((g) => g?.from !== undefined).length };
  }

  /** A note's metadata from its text; the text with its parse for the engine's file cache (one parse at start); its record for the index on disk. */
  private read(content: string): { meta: NoteMeta; text: StartText; record: NoteRecord } {
    let frontmatter: { ordered: OrderedFrontmatter; body: string } | undefined;
    const meta = this.parse(content, (r) => (frontmatter = r));
    const record: NoteRecord = {
      hash: meta.hash,
      parse: frontmatter ? { ordered: frontmatter.ordered, bodyStart: content.length - frontmatter.body.length } : null,
      tags: meta.cache.tags!.map((t) => t.tag),
      links: meta.links.map((l) => [l.linkpath, l.subpath]),
    };
    return { meta, text: { content, hash: meta.hash, ...(frontmatter ? { frontmatter } : {}) }, record };
  }

  private parse(text: string, parsed?: (r: { ordered: OrderedFrontmatter; body: string }) => void): NoteMeta {
    let frontmatter: Record<string, unknown> | undefined;
    let body = text;
    try {
      const r = readOrderedFromMarkdown(text);
      parsed?.(r);
      body = r.body;
      if (r.ordered.length > 0) frontmatter = Object.fromEntries(r.ordered);
    } catch {
      frontmatter = undefined; // invalid YAML: Obsidian shows no properties
    }
    return { cache: { ...(frontmatter ? { frontmatter } : {}), tags: tagsOf(body) }, links: parseLinks(text).map((l) => ({ linkpath: detached(l.linkpath), subpath: detached(l.subpath) })), hash: contentHash(text) };
  }

  /** What the index on disk asks the host when it writes (see IndexKeeper). */
  indexSource(): IndexSource {
    return {
      stat: (p) => {
        const f = this.vault.getAbstractFileByPath(p);
        return f instanceof NodeFile ? { mtime: f.stat.mtime, size: f.stat.size, ctime: f.stat.ctime, ...(f.stat.changed !== undefined ? { changed: f.stat.changed } : {}) } : null;
      },
      isNote: (p) => /\.md$/i.test(p),
      links: (p) => (this.resolved[p] ? { resolved: this.resolved[p]!, unresolved: this.unresolved[p]! } : null),
      fileId: (p) => this.vault.fileId(p),
      written: () => void (this.vault.walkIds = null),
    };
  }

  hashOf(p: string): string | undefined {
    return this.meta.get(p)?.hash;
  }

  /** Re-read one file (after a write or an external change); a new file may resolve other links. */
  changed(file: NodeFile, created: boolean): void {
    if (created) this.fileAdded(file.path);
    if (/\.md$/i.test(file.path)) {
      let text: string;
      try {
        const w = this.vault.written;
        text = w && w.path === file.path ? w.data : fs.readFileSync(this.vault.abs(file.path), "utf8");
      } catch {
        return;
      }
      const r = this.read(text);
      this.meta.set(file.path, r.meta);
      this.keeper?.noteRead(file.path, r.record, text);
      this.resolveOne(file.path);
    } else this.keeper?.touch(file.path);
    if (/\.md$/i.test(file.path)) this.events.emit("changed", file, "", this.getFileCache(file));
    this.announceResolved();
  }

  deleted(p: string): void {
    this.keeper?.deleted(p);
    this.meta.delete(p);
    this.forget(p);
    this.fileRemoved(p);
    this.announceResolved();
  }

  renamed(oldPath: string, newPath: string): void {
    this.keeper?.renamed(oldPath, newPath);
    const m = this.meta.get(oldPath);
    if (m) {
      this.meta.delete(oldPath);
      this.meta.set(newPath, m);
    }
    this.forget(oldPath);
    this.fileRemoved(oldPath);
    this.fileAdded(newPath);
    // its relative links read from the new folder
    if (m) this.resolveOne(newPath);
    this.announceResolved();
  }

  private fileIndex() {
    return { paths: () => this.vault.getFiles().map((f) => f.path) };
  }

  /** A file the vault has now: the links that look up its name may resolve to it. */
  private fileAdded(p: string): void {
    this.linkResolver.add(p);
    this.reresolve(fileLookupNames(p));
  }

  /** A file gone: the links that resolved to it (they look up its name) resolve again. */
  private fileRemoved(p: string): void {
    this.linkResolver.remove(p);
    this.reresolve(fileLookupNames(p));
  }

  /** Resolve again the links of every note that looks up one of these names. */
  private reresolve(names: readonly string[]): void {
    const sources = new Set<string>();
    for (const n of names) for (const s of this.lookers.get(n) ?? []) sources.add(s);
    for (const s of sources) this.resolveOne(s);
  }

  private resolveOne(p: string): void {
    const resolved: Record<string, number> = {};
    const unresolved: Record<string, number> = {};
    for (const l of this.meta.get(p)!.links) { // only notes read are resolved
      if (l.linkpath === "") continue;
      const dest = this.linkResolver.resolve(l.linkpath, p);
      if (dest) resolved[dest] = (resolved[dest] ?? 0) + 1;
      else unresolved[l.linkpath] = (unresolved[l.linkpath] ?? 0) + 1;
    }
    this.keep(p, resolved, unresolved);
    this.keeper?.touch(p);
  }

  /** Keep where a note's links lead, with their backlinks and the names they look up. */
  private keep(p: string, resolved: Record<string, number>, unresolved: Record<string, number>): void {
    this.unregister(p);
    const names = new Set<string>();
    for (const l of this.meta.get(p)!.links) if (l.linkpath !== "") addLinkLookupNames(names, l.linkpath, p);
    this.resolved[p] = resolved;
    this.unresolved[p] = unresolved;
    for (const [dest, n] of Object.entries(resolved)) {
      let from = this.inbound.get(dest);
      if (!from) this.inbound.set(dest, (from = new Map()));
      from.set(p, n);
    }
    // interned: every note that links to a file shares its names
    const list = [...names].map(intern);
    this.names.set(p, list);
    for (const n of list) {
      let who = this.lookers.get(n);
      if (!who) this.lookers.set(n, (who = new Set()));
      who.add(p);
    }
  }

  /** Take a note's resolved links and looked-up names out of the indexes (its entries stay in `resolved`). */
  private unregister(p: string): void {
    for (const dest of Object.keys(this.resolved[p] ?? {})) {
      const from = this.inbound.get(dest)!; // registered with the link
      from.delete(p);
      if (from.size === 0) this.inbound.delete(dest);
    }
    for (const n of this.names.get(p) ?? []) {
      const who = this.lookers.get(n)!; // registered with the name
      who.delete(p);
      if (who.size === 0) this.lookers.delete(n);
    }
    this.names.delete(p);
  }

  /** A note gone from `p` (deleted, or renamed away): its links are no longer resolved. */
  private forget(p: string): void {
    this.unregister(p);
    delete this.resolved[p];
    delete this.unresolved[p];
  }

  /** Resolve every note's links again, from scratch (startup). */
  private resolveAll(): void {
    this.resolved = {};
    this.unresolved = {};
    this.inbound.clear();
    this.names.clear();
    this.lookers.clear();
    for (const p of this.meta.keys()) this.resolveOne(p);
  }

  /**
   * How the links kept up to date file by file differ from resolving every link of the vault again
   * now (a debug check: `DATANOTES_INDEX_CHECK`, and the tests); empty when they agree.
   */
  verifyLinks(): string[] {
    const fresh = new LinkResolver(this.fileIndex());
    const out: string[] = [];
    const keys = Object.keys(this.resolved);
    const notes = [...this.meta.keys()];
    if (JSON.stringify(keys) !== JSON.stringify(notes)) out.push(`resolved notes: ${JSON.stringify(keys)} instead of ${JSON.stringify(notes)}`);
    const inbound = new Map<string, Map<string, number>>();
    for (const p of notes) {
      const resolved: Record<string, number> = {};
      const unresolved: Record<string, number> = {};
      for (const l of this.meta.get(p)!.links) {
        if (l.linkpath === "") continue;
        const dest = fresh.resolve(l.linkpath, p);
        if (dest) resolved[dest] = (resolved[dest] ?? 0) + 1;
        else unresolved[l.linkpath] = (unresolved[l.linkpath] ?? 0) + 1;
      }
      for (const [dest, n] of Object.entries(resolved)) {
        if (!inbound.has(dest)) inbound.set(dest, new Map());
        inbound.get(dest)!.set(p, n);
      }
      if (JSON.stringify(this.resolved[p]) !== JSON.stringify(resolved)) out.push(`${p}: resolves ${JSON.stringify(this.resolved[p])} instead of ${JSON.stringify(resolved)}`);
      if (JSON.stringify(this.unresolved[p]) !== JSON.stringify(unresolved)) out.push(`${p}: leaves ${JSON.stringify(this.unresolved[p])} unresolved instead of ${JSON.stringify(unresolved)}`);
    }
    const sorted = (m: Map<string, Map<string, number>>) => JSON.stringify([...m].map(([d, from]) => [d, [...from].sort()]).sort());
    if (sorted(this.inbound) !== sorted(inbound)) out.push("backlinks differ from the resolved links");
    // the names each note looks up, and the notes looking up each name
    const lookers = new Map<string, Set<string>>();
    for (const p of notes) {
      const names = new Set(this.meta.get(p)!.links.flatMap((l) => (l.linkpath === "" ? [] : linkLookupNames(l.linkpath, p))));
      for (const n of names) {
        if (!lookers.has(n)) lookers.set(n, new Set());
        lookers.get(n)!.add(p);
      }
    }
    const names = (m: Map<string, Set<string>>) => JSON.stringify([...m].map(([n, who]) => [n, [...who].sort()]).sort());
    if (names(this.lookers) !== names(lookers)) out.push("looked-up names differ from the notes' links");
    return out;
  }

  /**
   * Resolve every note's links again from scratch, after {@link verifyLinks} found them out of step
   * (DATANOTES_INDEX_CHECK): the next check agrees. The resolver is rebuilt first (it may be the
   * stale part); each note resolved is recorded in the index on disk (resolveOne), and `resolved`
   * is announced, as after any resolution.
   */
  relinkAll(): void {
    this.linkResolver.rebuild(this.fileIndex());
    this.resolveAll();
    this.announceResolved();
  }

  /** Obsidian announces `resolved` after a change, asynchronously; bursts are coalesced. */
  private announceResolved(): void {
    if (this.resolveTimer) return;
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = null;
      this.events.emit("resolved");
    }, 20);
  }

  /** Links of a note (for the file manager's rewrites). */
  linksOf(p: string): NoteLink[] {
    return this.meta.get(p)?.links ?? [];
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.meta.get(file.path)?.cache ?? null;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const dest = this.resolver.resolve(linkpath, sourcePath);
    const f = dest ? this.vault.getAbstractFileByPath(dest) : null;
    return f && "extension" in f ? (f as TFile) : null;
  }

  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    return linkText(this.resolver, file.path, sourcePath, this.vault.config.newLinkFormat, omitMdExtension);
  }

  on(name: string, cb: (...args: never[]) => unknown): EventRef {
    this.events.on(name, cb as (...args: unknown[]) => void);
    return { name, cb };
  }

  offref(ref: EventRef): void {
    const r = ref as { name?: string; cb?: (...args: unknown[]) => void };
    if (r.name && r.cb) this.events.off(r.name, r.cb);
  }

  /** How many records the start took from the index on disk are still to intern. */
  get internPending(): number {
    return this.uninterned.length - this.internAt;
  }

  /**
   * Intern the strings of the records the start took from the index on disk (front matter, tags,
   * links; see `intern.ts`), INTERN_SLICE.records at a time, one slice per turn of the event loop:
   * the start does not wait for it (the service begins once it listens). The metadata built from
   * them holds the same strings, which V8 turns into forwards in place, so the holders made
   * earlier share the one copy too. Resolves once every record is interned, or the cache is
   * disposed; a second call answers the same promise.
   */
  internRecords(): Promise<void> {
    if (this.interning) return this.interning;
    if (this.internPending === 0) return Promise.resolve();
    const slice = () => {
      const end = Math.min(this.internAt + INTERN_SLICE.records, this.uninterned.length);
      for (; this.internAt < end; this.internAt++) internRecord(this.uninterned[this.internAt]!);
      if (this.internAt < this.uninterned.length) this.internNext = setImmediate(slice);
      else this.endInterning();
    };
    this.interning = new Promise<void>((resolve) => (this.internDone = resolve));
    this.internNext = setImmediate(slice);
    return this.interning;
  }

  /** The records interned or let go: nothing more to do, the promise resolved. */
  private endInterning(): void {
    if (this.internNext) clearImmediate(this.internNext);
    this.internNext = null;
    this.uninterned = [];
    this.internAt = 0;
    this.interning = null;
    this.internDone?.();
    this.internDone = null;
  }

  dispose(): void {
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = null;
    this.endInterning();
  }
}

export class NodeFileManager implements FileManager {
  constructor(
    private readonly vault: NodeVault,
    private readonly cache: NodeMetadataCache,
  ) {}

  /**
   * Rename or move a file or folder and rewrite every link to what moved (in note bodies and
   * frontmatter), plus relative links of moved notes that would otherwise break.
   */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    const item = this.vault.getAbstractFileByPath(file.path);
    if (!item) throw new Error(`file not found: ${file.path}`);
    // Who links to what moves: the notes that move and their backlinks (no pass over every link).
    const from = item.path;
    const isFolder = "children" in item;
    const movingFiles = isFolder ? this.vault.getFiles().filter((f) => f.path.startsWith(`${from}/`)).map((f) => f.path) : [from];
    const sources = new Set<string>(movingFiles.filter((p) => /\.md$/i.test(p)));
    for (const p of movingFiles) for (const src of Object.keys(this.cache.backlinksOf(p))) sources.add(src);
    const texts = new Map<string, string>();
    for (const src of sources) {
      const f = this.vault.getAbstractFileByPath(src);
      if (f && "extension" in f) texts.set(src, await this.vault.read(f as TFile));
    }
    // Their links resolved as the vault is now, before the move (no copy of the resolver).
    const before = new Map<string, Map<string, string | null>>();
    for (const [src, text] of texts) {
      const dests = new Map<string, string | null>();
      for (const l of parseLinks(text)) if (!dests.has(l.linkpath)) dests.set(l.linkpath, this.cache.resolver.resolve(l.linkpath, src));
      before.set(src, dests);
    }

    const moved = await this.vault.move(item, newPath); // the cache follows (rename events)

    await eachLimit([...texts], MOVE_WRITES, async ([oldSrc, text]) => {
      const src = moved.get(oldSrc) ?? oldSrc;
      const dests = before.get(oldSrc)!; // every source read has its links resolved
      const next = this.relinked(text, src, oldSrc, (lp) => dests.get(lp) ?? null, moved);
      const f = this.vault.getAbstractFileByPath(src) as NodeFile | null;
      if (f && next !== text) await this.vault.writeText(f, next);
    });
  }

  /**
   * A note's text (at `src` now, at `oldSrc` before the move) with its links to moved files
   * (`moved`: old path → new path) rewritten in the vault's link format, as `resolveOld` (the
   * vault before the move, from the note's old place) resolved them; its relative links that
   * would break from a new place too.
   */
  private relinked(text: string, src: string, oldSrc: string, resolveOld: (linkpath: string, source: string) => string | null, moved: ReadonlyMap<string, string>): string {
    const newResolver = this.cache.resolver;
    const format = this.vault.config.newLinkFormat;
    return rewriteLinks(
      text,
      src,
      resolveOld,
      moved,
      (dest, s) => linkText(newResolver, dest, s, format, true),
      oldSrc,
      (lp, s) => newResolver.resolve(lp, s),
    ).text;
  }

  /**
   * Files moved by another program (old path → new path, already in the index at the new one):
   * the notes whose links still point to an old path, with their text as `renameFile` would have
   * left it. A note an editor already relinked (Obsidian does on its own renames) has no link to
   * an old path: it is not listed. A move whose new path has no file is left out; one whose old
   * path has a file again (a → b, then c → a) too, unless `options.reoccupied` says, note by note,
   * that the links to that path meant the file that moved away. Nothing is written.
   */
  async linksAfterMove(moves: ReadonlyMap<string, string>, options: LinksAfterMoveOptions = {}): Promise<LinkRewrite[]> {
    const now = this.vault.getFiles().map((f) => f.path);
    const present = new Set(now);
    const reoccupied = options.reoccupied;
    const moved = new Map([...moves].filter(([from, to]) => from !== to && present.has(to) && (!present.has(from) || reoccupied !== undefined)));
    if (moved.size === 0) return [];
    const back = new Map([...moved].map(([from, to]) => [to, from]));
    // the vault before the moves: a file now at an old path that did not move there was not there
    const before = now.filter((p) => back.has(p) || !moved.has(p)).map((p) => back.get(p) ?? p);
    const oldResolver = new LinkResolver({ paths: () => before });
    const out: LinkRewrite[] = [];
    for (const f of this.vault.getMarkdownFiles()) {
      const oldSrc = back.get(f.path) ?? f.path;
      // the links the cache knows: only notes with a link that reached a moved file are read
      if (!back.has(f.path) && !this.cache.linksOf(f.path).some((l) => moved.has(oldResolver.resolve(l.linkpath, oldSrc) ?? ""))) continue;
      const text = await this.vault.read(f);
      // a link to an old path that holds a file again follows the move only where it meant the moved file
      const followed = new Map([...moved].filter(([from, to]) => !present.has(from) || to === f.path || reoccupied!(from, f.path, text)));
      const after = this.relinked(text, f.path, oldSrc, (lp, s) => oldResolver.resolve(lp, s), followed);
      if (after !== text) out.push({ path: f.path, before: text, after });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const f = this.vault.getAbstractFileByPath(file.path) as NodeFile | null;
    if (!f) throw new Error(`file not found: ${file.path}`);
    const text = await this.vault.read(f);
    const { ordered, body } = readOrderedFromMarkdown(text);
    const fm = Object.fromEntries(ordered) as Record<string, unknown>;
    const before = JSON.stringify(fm);
    fn(fm);
    if (JSON.stringify(fm) === before) return;
    // fm changed, so it had keys before or has some now: never a note left without frontmatter
    await this.vault.writeText(f, buildMarkdownWithFrontmatter(Object.entries(fm), body));
  }

  trashFile(file: TAbstractFile): Promise<void> {
    return this.vault.trash(file, true);
  }
}

export interface NodeHost {
  app: App;
  vault: NodeVault;
  metadataCache: NodeMetadataCache;
  fileManager: NodeFileManager;
  /** The vault index on disk while the host keeps it ({@link indexNodeHost}); null without one. */
  index?: IndexKeeper | null;
}

/**
 * Open a vault folder: index files and notes, resolve links, and keep the metadata cache in step
 * with every write made through the host (external changes: `NodeWatcher`).
 */
export function openNodeVault(root: string, config?: Partial<VaultConfig>, opts: { store?: string } = {}): NodeHost {
  const host = createNodeHost(root, config, opts);
  host.vault.scanSync();
  host.metadataCache.indexAll();
  following(host);
  return host;
}

/**
 * {@link openNodeVault} without blocking, the way the service starts: one walk of the vault
 * (folders listed and files stat-ed many at a time), then the notes read many at a time.
 */
export async function openNodeVaultAsync(root: string, config?: Partial<VaultConfig>, opts: { store?: string; index?: { store: string; version: string } | null } = {}): Promise<NodeHost> {
  const host = createNodeHost(root, config, opts);
  await host.vault.scan();
  await indexNodeHost(host, { index: opts.index ?? null });
  return host;
}

/**
 * A host on a vault folder with nothing read yet. The service walks it ({@link NodeVault.scan}),
 * finds its store from the files the walk found, then reads the notes ({@link indexNodeHost}).
 */
export function createNodeHost(root: string, config?: Partial<VaultConfig>, opts: { store?: string } = {}): NodeHost {
  const vault = new NodeVault(path.resolve(root), { ...readVaultConfig(root), ...(config ?? {}) });
  const metadataCache = new NodeMetadataCache(vault);
  const fileManager = new NodeFileManager(vault, metadataCache);
  const app: App = { vault, metadataCache, fileManager, ...(opts.store ? { store: nodeStoreAdapter(opts.store) } : {}) };
  return { app, vault, metadataCache, fileManager };
}

/**
 * Read and parse the notes of a walked vault and resolve their links; the host then follows every
 * change. `index`: the vault index on disk of this store (`<store>/index/vault.sqlite`, see
 * index-db.ts) for an engine of this version: the notes it records unchanged are not read, and
 * the host keeps it up to date; a text the engine's file cache no longer keeps comes from it, and
 * a search reads only the notes the index's search table names.
 * `hold`: nothing is written until `host.index.release()`.
 */
export async function indexNodeHost(host: NodeHost, o: { index?: { store: string; version: string } | null; hold?: boolean } = {}): Promise<IndexedVault & { rebuilt: string | null; indexed: boolean }> {
  const opened = o.index ? IndexDb.open(o.index.store, { vault: host.vault.basePath, version: o.index.version }) : null;
  const keeper = opened ? new IndexKeeper(opened.db, host.metadataCache.indexSource()) : null;
  // `hold`: what the start found is written once the caller releases the keeper (the service: once it listens)
  if (o.hold) keeper?.hold();
  const counts = await host.metadataCache.indexAllAsync(READ_CONCURRENCY, opened && keeper ? { files: opened.files, links: opened.links, keeper } : null);
  host.index = keeper;
  if (keeper) {
    setTextSource(host.app, { textOf: (p, hash) => keeper.textOf(p, hash) });
    setSearchSource(host.app, { candidates: (words) => keeper.searchCandidates(words) });
  } else host.vault.walkIds = null;
  following(host);
  // not held: a start with nothing to write lets the walk's file ids go now (held: at release)
  if (keeper && !o.hold) keeper.release();
  // the records taken from the index interned between other work (held: the caller starts it, the service once it listens)
  if (!o.hold) void host.metadataCache.internRecords();
  return { ...counts, rebuilt: opened?.db.rebuilt ?? null, indexed: keeper !== null };
}

/** Stop a host: the index on disk written and closed, the metadata cache's timers cleared. */
export function closeNodeHost(host: NodeHost): void {
  host.index?.close();
  host.index = null;
  setTextSource(host.app, null);
  setSearchSource(host.app, null);
  host.metadataCache.dispose();
}

/** The metadata cache follows the vault's changes; the notes read at start go to the engine's file cache. */
function following(host: NodeHost): void {
  host.vault.listener = host.metadataCache;
  primeFiles(host.app, [...host.metadataCache.startTexts!].map(([file, t]) => ({ file, ...t })));
  host.metadataCache.startTexts = null;
}
