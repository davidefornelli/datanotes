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
import { buildMarkdownWithFrontmatter, readOrderedFromMarkdown } from "../core/frontmatter";
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
import { basename, dirname, LinkResolver, linkText, parseLinks, rewriteLinks, type LinkRef } from "./links";
import { eachLimit, MOVE_WRITES } from "../core/database-move";
import { contentHash } from "../core/file-cache";
import { readVaultConfig, type VaultConfig } from "./vault-config";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./private-files";

export class NodeFile implements TFile {
  stat: FileStats;
  constructor(
    public path: string,
    stat: FileStats,
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

function hidden(rel: string): boolean {
  return rel.split("/").some((p) => p.startsWith("."));
}

function statsOf(s: fs.Stats): FileStats {
  /* v8 ignore next -- platform: only a filesystem without birth time (some Linux ones) reports 0 */
  return { ctime: s.birthtimeMs || s.ctimeMs, mtime: s.mtimeMs, size: s.size };
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
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
      /* v8 ignore start -- runs only on Windows, while a reader holds the file; it gives up only if one holds it for seconds */
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 30 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw e;
      await new Promise((r) => setTimeout(r, 25 + attempt * 10));
    }
    /* v8 ignore stop */
  }
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

export class NodeVault implements Vault {
  readonly adapter: VaultAdapter;
  readonly events = new EventEmitter();
  listener: IndexListener | null = null;
  private files = new Map<string, NodeFile>();
  private folders = new Map<string, NodeFolder>();
  private root = new NodeFolder("");

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

  // --- index ---

  /** Read the whole folder tree into the index (silently: no events). */
  scanSync(): void {
    this.files.clear();
    this.folders.clear();
    this.root = new NodeFolder("");
    this.folders.set("", this.root);
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
   * Finish the renames in case only a crash left half done (between their two renames: the file
   * under its temporary name, `.datanotes-rename-…--<target>`): each is renamed to its target,
   * unless a file has that name (in any case) by now. Run before {@link scanSync} (at start).
   * Returns the files put back (their vault paths) and the temporary files left (none to put back,
   * or no target in the name).
   */
  recoverRenames(): { recovered: string[]; left: string[] } {
    const out = { recovered: [] as string[], left: [] as string[] };
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(this.abs(dir), { withFileTypes: true })) {
        const rel = dir === "" ? e.name : `${dir}/${e.name}`;
        if (e.isDirectory() && !e.name.startsWith(".")) walk(rel);
        if (!e.isFile() || !e.name.startsWith(RENAME_TEMP_PREFIX)) continue;
        const target = RENAME_TEMP.exec(e.name)?.[1];
        const to = target === undefined ? null : dir === "" ? target : `${dir}/${target}`;
        // a file system that ignores case finds a file of that name in another case too
        if (to === null || fs.existsSync(this.abs(to))) {
          out.left.push(rel);
          continue;
        }
        fs.renameSync(this.abs(rel), this.abs(to));
        out.recovered.push(to);
      }
    };
    walk("");
    return out;
  }

  private parentOf(rel: string): NodeFolder {
    const d = dirname(rel);
    return this.folders.get(d) ?? this.addFolder(d);
  }

  private addFolder(rel: string): NodeFolder {
    const hit = this.folders.get(rel);
    if (hit) return hit;
    const f = new NodeFolder(rel);
    this.folders.set(rel, f);
    if (rel !== "") this.parentOf(rel).children.push(f);
    return f;
  }

  private addFile(rel: string, stat: FileStats): NodeFile {
    const hit = this.files.get(rel);
    if (hit) {
      hit.stat = stat;
      return hit;
    }
    const f = new NodeFile(rel, stat);
    this.files.set(rel, f);
    this.parentOf(rel).children.push(f);
    return f;
  }

  private detach(item: TAbstractFile): void {
    const parent = this.folders.get(dirname(item.path));
    if (parent) parent.children = parent.children.filter((c) => c !== item);
  }

  private dropFile(rel: string): NodeFile | null {
    const f = this.files.get(rel);
    if (!f) return null;
    this.files.delete(rel);
    this.detach(f);
    return f;
  }

  private dropFolder(rel: string): NodeFolder | null {
    const f = this.folders.get(rel);
    if (!f || rel === "") return null;
    for (const c of [...f.children]) {
      if (c instanceof NodeFolder) this.dropFolder(c.path);
      else this.dropFile(c.path);
    }
    this.folders.delete(rel);
    this.detach(f);
    return f;
  }

  private emit(name: string, ...args: unknown[]): void {
    const [item, old] = args as [TAbstractFile, string | undefined];
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
    f.path = to;
    f.stat = statsOf(st);
    this.files.set(to, f);
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

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((f) => f.extension === "md");
  }

  getFiles(): TFile[] {
    return [...this.files.values()];
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
    if (isFolder) {
      const folder = this.folders.get(from)!;
      const files = [...this.files.values()].filter((f) => f.path.startsWith(`${from}/`));
      const subfolders = [...this.folders.values()].filter((f) => f.path.startsWith(`${from}/`));
      this.detach(folder);
      this.folders.delete(from);
      for (const f of subfolders) this.folders.delete(f.path);
      for (const f of files) this.files.delete(f.path);
      folder.path = to;
      this.folders.set(to, folder);
      this.parentOf(to).children.push(folder);
      renamed.push([folder, from]);
      for (const f of subfolders) {
        const old = f.path;
        f.path = to + old.slice(from.length);
        this.folders.set(f.path, f);
        renamed.push([f, old]);
      }
      for (const f of files) {
        const old = f.path;
        f.path = to + old.slice(from.length);
        this.files.set(f.path, f);
        moved.set(old, f.path);
        renamed.push([f, old]);
      }
    } else {
      const f = this.files.get(from)!;
      this.detach(f);
      this.files.delete(from);
      f.path = to;
      this.files.set(to, f);
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

interface NoteMeta {
  frontmatter?: Record<string, unknown>;
  tags: { tag: string }[];
  links: LinkRef[];
  /** Hash of the text read (a note moved outside is recognized by it). */
  hash: string;
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
  for (const m of noCode.matchAll(TAG_RE)) out.push({ tag: `#${m[1]}` });
  return out;
}

export class NodeMetadataCache implements MetadataCache {
  readonly events = new EventEmitter();
  private meta = new Map<string, NoteMeta>();
  private linkResolver: LinkResolver;
  private resolved: Record<string, Record<string, number>> = {};
  private unresolved: Record<string, Record<string, number>> = {};
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Files were created, deleted or renamed since the links were last resolved: they are resolved
   * again on the next read of them, once for a whole burst (a folder of 2000 notes moved by hand
   * is one resolution, not one per note).
   */
  private stale = false;

  constructor(private readonly vault: NodeVault) {
    this.events.setMaxListeners(0);
    this.linkResolver = new LinkResolver(this.fileIndex());
  }

  private fresh(): void {
    if (!this.stale) return;
    this.stale = false;
    this.linkResolver.rebuild(this.fileIndex());
    this.resolveAll();
  }

  get resolver(): LinkResolver {
    this.fresh();
    return this.linkResolver;
  }

  /** source path → (target path → number of links). */
  get resolvedLinks(): Record<string, Record<string, number>> {
    this.fresh();
    return this.resolved;
  }

  get unresolvedLinks(): Record<string, Record<string, number>> {
    this.fresh();
    return this.unresolved;
  }

  /** Parse every note and resolve every link (startup). */
  indexAll(): void {
    this.meta.clear();
    for (const f of this.vault.getMarkdownFiles()) this.meta.set(f.path, this.parse(fs.readFileSync(this.vault.abs(f.path), "utf8")));
    this.stale = false;
    this.linkResolver.rebuild(this.fileIndex());
    this.resolveAll();
  }

  private parse(text: string): NoteMeta {
    let frontmatter: Record<string, unknown> | undefined;
    let body = text;
    try {
      const r = readOrderedFromMarkdown(text);
      body = r.body;
      if (r.ordered.length > 0) frontmatter = Object.fromEntries(r.ordered);
    } catch {
      frontmatter = undefined; // invalid YAML: Obsidian shows no properties
    }
    return { ...(frontmatter ? { frontmatter } : {}), tags: tagsOf(body), links: parseLinks(text), hash: contentHash(text) };
  }

  hashOf(p: string): string | undefined {
    return this.meta.get(p)?.hash;
  }

  /** Re-read one file (after a write or an external change); a new file may resolve other links. */
  changed(file: NodeFile, created: boolean): void {
    if (created) this.stale = true;
    if (/\.md$/i.test(file.path)) {
      let text: string;
      try {
        const w = this.vault.written;
        text = w && w.path === file.path ? w.data : fs.readFileSync(this.vault.abs(file.path), "utf8");
      } catch {
        return;
      }
      this.meta.set(file.path, this.parse(text));
      if (!this.stale) this.resolveOne(file.path);
    }
    if (/\.md$/i.test(file.path)) this.events.emit("changed", file, "", this.getFileCache(file));
    this.announceResolved();
  }

  deleted(p: string): void {
    this.meta.delete(p);
    this.stale = true;
    this.announceResolved();
  }

  renamed(oldPath: string, newPath: string): void {
    const m = this.meta.get(oldPath);
    if (m) {
      this.meta.delete(oldPath);
      this.meta.set(newPath, m);
    }
    this.stale = true;
    this.announceResolved();
  }

  private fileIndex() {
    return { paths: () => this.vault.getFiles().map((f) => f.path) };
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
    this.resolved[p] = resolved;
    this.unresolved[p] = unresolved;
  }

  /** Resolve every note's links again (files were added, removed or renamed); the caller announces it. */
  private resolveAll(): void {
    this.resolved = {};
    this.unresolved = {};
    for (const p of this.meta.keys()) this.resolveOne(p);
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
  linksOf(p: string): LinkRef[] {
    return this.meta.get(p)?.links ?? [];
  }

  getFileCache(file: TFile): CachedMetadata | null {
    const m = this.meta.get(file.path);
    if (!m) return null;
    return { ...(m.frontmatter ? { frontmatter: m.frontmatter } : {}), tags: m.tags };
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

  dispose(): void {
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = null;
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
    // Who links to what moves, resolved as the vault is now.
    const oldResolver = new LinkResolver({ paths: () => this.vault.getFiles().map((f) => f.path) });
    const from = item.path;
    const isFolder = "children" in item;
    const movingFiles = isFolder ? this.vault.getFiles().filter((f) => f.path.startsWith(`${from}/`)).map((f) => f.path) : [from];
    const moving = new Set(movingFiles);
    const sources = new Set<string>(movingFiles.filter((p) => /\.md$/i.test(p)));
    for (const [src, targets] of Object.entries(this.cache.resolvedLinks)) {
      if (Object.keys(targets).some((t) => moving.has(t))) sources.add(src);
    }
    const texts = new Map<string, string>();
    for (const src of sources) {
      const f = this.vault.getAbstractFileByPath(src);
      if (f && "extension" in f) texts.set(src, await this.vault.read(f as TFile));
    }

    const moved = await this.vault.move(item, newPath); // the cache follows (rename events)

    await eachLimit([...texts], MOVE_WRITES, async ([oldSrc, text]) => {
      const src = moved.get(oldSrc) ?? oldSrc;
      const next = this.relinked(text, src, oldSrc, oldResolver, moved);
      const f = this.vault.getAbstractFileByPath(src) as NodeFile | null;
      if (f && next !== text) await this.vault.writeText(f, next);
    });
  }

  /**
   * A note's text (at `src` now, at `oldSrc` before the move) with its links to moved files
   * (`moved`: old path → new path) rewritten in the vault's link format, as `oldResolver` (the
   * vault before the move) resolved them; its relative links that would break from a new place too.
   */
  private relinked(text: string, src: string, oldSrc: string, oldResolver: LinkResolver, moved: ReadonlyMap<string, string>): string {
    const newResolver = this.cache.resolver;
    const format = this.vault.config.newLinkFormat;
    return rewriteLinks(
      text,
      src,
      (lp, s) => oldResolver.resolve(lp, s),
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
      const after = this.relinked(text, f.path, oldSrc, oldResolver, followed);
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
    const entries = Object.entries(fm);
    await this.vault.writeText(f, entries.length === 0 && ordered.length === 0 ? text : buildMarkdownWithFrontmatter(entries, body));
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
}

/**
 * Open a vault folder: index files and notes, resolve links, and keep the metadata cache in step
 * with every write made through the host (external changes: `NodeWatcher`).
 */
export function openNodeVault(root: string, config?: Partial<VaultConfig>, opts: { store?: string } = {}): NodeHost {
  const vault = new NodeVault(path.resolve(root), { ...readVaultConfig(root), ...(config ?? {}) });
  vault.scanSync();
  const metadataCache = new NodeMetadataCache(vault);
  metadataCache.indexAll();
  vault.listener = metadataCache;
  const fileManager = new NodeFileManager(vault, metadataCache);
  const app: App = { vault, metadataCache, fileManager, ...(opts.store ? { store: nodeStoreAdapter(opts.store) } : {}) };
  return { app, vault, metadataCache, fileManager };
}
