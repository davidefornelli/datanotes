/**
 * Packs of rows on the headless host (`App.packs`, see `PackStore` in core/host.ts): each section
 * of a pack is listed in the vault's index as a note of its own, at the path the row's values give
 * it (its logical path), a `NodeFile` like any other. The pack's file itself is not listed: the
 * engine never sees it, and `getFiles()` lists the rows instead.
 *
 * - **Reading**: a row's text is rebuilt from its section (front matter and text), never read from
 *   the disk; its stat is the one it had as a note (kept in the store's `packs.json`, by its
 *   section's hash), else the pack's.
 * - **Hand edits** (an editor, git): a pack changed on disk is read again and compared with what
 *   the host had, row by row by `id`: only the rows that changed get a vault event.
 * - **Writes of the engine** on a packed row change its section in place when the new text can
 *   stay in the pack (packable, the same key, the same path); otherwise the row comes out as a note
 *   of its own. A delete or a move takes it out; a trash puts its note in `.trash/`.
 * - **pack / unpack** are silent: no vault event; the rows keep their paths, texts and stats.
 *
 * A note of its own at a packed row's path wins: the section stays in the pack, left aside, until
 * the note goes. A pack that cannot be read keeps the rows it had, and refuses writes until fixed.
 */

import fs from "node:fs";
import path from "node:path";
import type { LinkRewrite, PackInfo, PackStore } from "../core/host";
import { isPackFrontmatter, packable, parsePack, rowNoteText, sectionText, writePack, type PackMeta, type PackRow } from "../core/pack-format";
import { databaseRootOfPack, namedAsPack, packedTablesIn, packKeyOf, rowPathOf, type PackedTable } from "../core/pack-layout";
import { readOrderedFromMarkdown, splitFrontmatter } from "../core/frontmatter";
import { contentHash } from "../core/file-cache";
import { METASTORE_FILE } from "../core/metastore";
import { telemetry } from "../core/telemetry";
import { messageOf } from "../core/message";
import { countPackName } from "../core/validate";
import { jsonSafe } from "./index-db";
import { basename, dirname } from "./links";
import type { NodeFile, NodeFileStats } from "./node-app";

/** What the pack store needs of the vault: its index, its events and its disk. */
export interface PackVault {
  abs(rel: string): string;
  /** The file at `rel` in the index (rows of packs included). */
  indexed(rel: string): NodeFile | undefined;
  /** Add a file to the index without an event. */
  addFile(rel: string, stat: NodeFileStats): NodeFile;
  /** Take a file out of the index without an event. */
  dropFile(rel: string): NodeFile | null;
  /** Give an indexed file another path (folders made as needed), without an event. */
  repath(file: NodeFile, to: string): void;
  emit(name: "create" | "modify" | "delete" | "rename", file: NodeFile, old?: string): void;
  /** Run `fn` while `paths` count as written by the vault (the watcher leaves them alone). */
  guarded<T>(paths: string[], fn: () => Promise<T>): Promise<T>;
  /** Write a file atomically. */
  writeAtomic(rel: string, data: string): Promise<void>;
  /** The packs whose files came or went: links to them resolve again. */
  packsChanged(paths: readonly string[]): void;
}

/** A row of a pack, as the host keeps it. */
interface PackedRow {
  file: NodeFile;
  pack: string;
  heading: string;
  id: string;
  /** Hash of its section's text. */
  hash: string;
  row: PackRow;
}

/** A section left aside: a note of its own has its path (the note wins). */
interface AsideRow {
  path: string;
  row: PackRow;
}

/** A pack as the host keeps it. */
interface PackState {
  path: string;
  meta: PackMeta;
  tableKey: string;
  /** Its rows by id: the rows listed in the vault. */
  rows: Map<string, PackedRow>;
  /** Sections left aside, kept as they are in the pack. */
  aside: AsideRow[];
  /** The pack's stat as last read or written ({@link sameStat}). */
  stat: { mtime: number; size: number } | null;
  /** Why the pack cannot be read now (a hand edit broke it): writes are refused until it is fixed. */
  broken: string | null;
}

/**
 * A row as `packs.json` keeps it: its pack, its section's hash, its times, and its values (the
 * next start reads the section without parsing its YAML again; absent when they are not plain JSON).
 */
type SavedRow = [pack: string, hash: string, ctime: number, mtime: number, size: number, values?: [string, unknown][]];

/** The format of `packs.json`: another one is not read (the rows take their packs' stats once). */
const STATE_VERSION = 2;

/** How long the stats wait before they are written (ms): a burst of writes writes them once. */
const SAVE_DELAY_MS = 500;

/** The file of the store that keeps the rows' stats. */
export const PACK_STATE_FILE = "packs.json";

/** The front matter key of a pack whose rows name their table with another property than `table`. */
const TABLE_KEY_FIELD = "table_key";

/** The front matter of a text, when it is a pack's; null otherwise. */
function packFrontmatter(text: string): Record<string, unknown> | null {
  if (!text.startsWith("---")) return null;
  try {
    const split = splitFrontmatter(text);
    if (!split) return null;
    const fm = Object.fromEntries(readOrderedFromMarkdown(`---\n${split.yamlText}\n---\n`).ordered);
    return isPackFrontmatter(fm) ? fm : null;
  } catch {
    return null;
  }
}

/** The property that names a row's table in a pack (`table`, unless its front matter says another). */
function tableKeyOf(fm: Record<string, unknown>): string {
  return typeof fm[TABLE_KEY_FIELD] === "string" ? (fm[TABLE_KEY_FIELD] as string) : "table";
}

/** A pack's text with its rows; `table_key` written when it is not `table`. */
function packText(meta: PackMeta, tableKey: string, rows: readonly PackRow[]): string {
  const text = writePack(meta, rows, tableKey);
  if (tableKey === "table") return text;
  return text.replace(/\n---\n/, `\n${TABLE_KEY_FIELD}: ${JSON.stringify(tableKey)}\n---\n`);
}

/** Whether a pack's stat is the one recorded (the host's own write, or no change). */
function sameStat(a: { mtime: number; size: number } | null, b: { mtime: number; size: number }): boolean {
  return a !== null && a.mtime === b.mtime && a.size === b.size;
}

/** The id of a row's values, as a string. */
const idOf = (row: PackRow) => String(new Map(row.ordered).get("id"));

export class NodePackStore implements PackStore {
  private packs = new Map<string, PackState>();
  private rows = new Map<string, PackedRow>();
  /** The stats `packs.json` kept, by row path. */
  private saved = new Map<string, SavedRow>();
  private stateFile: string | null = null;
  /** The values of the sections `packs.json` kept, by their hash (built on first use). */
  private byHash: Map<string, [string, unknown][]> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Something `packs.json` does not hold yet. */
  private dirty = false;
  /** The hashes of the sections a read of a pack computed (by their text), while it registers them. */
  private hashes = new Map<string, string>();
  /** Every folder that holds a row of a pack, above it included (built on first use, dropped when rows change). */
  private rowFolders: Set<string> | null = null;
  /** The tables of each database (by its folder), as its metastore was when last read (by stat). */
  private schemas = new Map<string, { mtime: number; size: number; tables: Map<string, PackedTable> }>();

  /** How the links to rows follow them in and out of packs (the metadata cache's; see `relinks`). */
  relinker: NonNullable<PackStore["relinks"]> | null = null;

  constructor(private readonly vault: PackVault) {}

  relinks(rows: readonly string[], to: "pack" | "note", targets: ReadonlyMap<string, { pack: string; heading: string }>): Promise<LinkRewrite[]> {
    // set with the host (createNodeHost): the metadata cache knows the links
    return this.relinker!(rows, to, targets);
  }

  /** Keep the rows' stats in `<store>/packs.json` (read now). */
  useStore(storeDir: string): void {
    this.stateFile = path.join(storeDir, PACK_STATE_FILE);
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as { version?: number; rows?: Record<string, SavedRow> };
      this.saved = raw.version === STATE_VERSION ? new Map(Object.entries(raw.rows ?? {})) : new Map();
    } catch {
      this.saved = new Map();
    }
  }

  // --- PackStore ---

  isPack(p: string): boolean {
    return this.packs.has(p);
  }

  locate(p: string): { pack: string; heading: string } | null {
    const r = this.rows.get(p);
    return r ? { pack: r.pack, heading: r.heading } : null;
  }

  packsOf(table: string): PackInfo[] {
    const out: PackInfo[] = [];
    for (const s of this.packs.values()) {
      if (s.meta.table === table) out.push({ path: s.path, table, key: s.meta.key, rows: [...s.rows.values()].map((r) => r.file.path).sort() });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async pack(input: { table: string; key: string; path: string; rows: readonly string[]; tableKey: string }): Promise<string> {
    const target = input.path;
    let state = this.packs.get(target);
    if (state) {
      this.freshen(state);
      state = this.packs.get(target);
    }
    if (!state) {
      if (fs.existsSync(this.vault.abs(target))) throw new Error(`${target} exists and is not a pack of ${input.table}`);
      state = { path: target, meta: { table: input.table, key: input.key }, tableKey: input.tableKey, rows: new Map(), aside: [], stat: null, broken: null };
    } else if (state.meta.table !== input.table || state.meta.key !== input.key) {
      throw new Error(`${target} is the pack of ${state.meta.table} for ${state.meta.key}, not of ${input.table} for ${input.key}`);
    }
    this.assertReadable(state);
    const adding: { file: NodeFile; row: PackRow }[] = [];
    const headings = new Set([...state.rows.values()].map((r) => r.heading));
    for (const p of input.rows) {
      const file = this.vault.indexed(p);
      if (!file || this.rows.has(p)) throw new Error(`${p} is not a note of its own`);
      const text = fs.readFileSync(this.vault.abs(p), "utf8");
      const heading = basename(p).replace(/\.md$/i, "");
      const ok = packable(text, heading, input.table, input.tableKey);
      if (!ok.ok) throw new Error(`${p} cannot go into a pack: ${ok.reason}`);
      if (headings.has(heading)) throw new Error(`${target} has a row named ${heading} already`);
      headings.add(heading);
      adding.push({ file, row: ok.row });
    }
    const s = state;
    const isNew = !this.packs.has(target);
    await this.vault.guarded([target, ...input.rows], async () => {
      await this.vault.writeAtomic(target, packText(s.meta, s.tableKey, [...this.rowsOf(s), ...adding.map((a) => a.row)]));
      s.stat = this.diskStat(target);
      this.addPack(s);
      for (const { file, row } of adding) {
        // the row keeps its file object, path and stat: the note goes, its section answers for it
        fs.rmSync(this.vault.abs(file.path));
        this.removeEmptyFolders(dirname(file.path));
        this.adopt(s, file, row);
      }
    });
    if (isNew) this.vault.packsChanged([target]);
    // the rows' stats now: a pack is silent only while its rows keep them across a restart
    this.flush();
    return target;
  }

  async unpack(packPath: string, rows?: readonly string[]): Promise<string[]> {
    let state = this.packs.get(packPath);
    if (state) {
      this.freshen(state);
      state = this.packs.get(packPath);
    }
    if (!state) throw new Error(`${packPath} is not a pack`);
    this.assertReadable(state);
    const wanted = rows ? new Set(rows) : null;
    const out = [...state.rows.values()].filter((r) => !wanted || wanted.has(r.file.path));
    if (wanted) for (const p of wanted) if (!out.some((r) => r.file.path === p)) throw new Error(`${p} is not a row of ${packPath}`);
    const s = state;
    await this.vault.guarded([packPath, ...out.map((r) => r.file.path)], async () => {
      for (const r of out) {
        // the note as it was, with the modification time the row had
        await this.vault.writeAtomic(r.file.path, rowNoteText(r.row));
        this.keepTime(r.file);
        this.forgetRow(s, r);
      }
      await this.rewrite(s);
    });
    this.flush();
    return out.map((r) => r.file.path);
  }

  // --- the vault's view ---

  /** Whether `rel` is a row of a pack (listed in the vault, not on disk). */
  isRow(rel: string): boolean {
    return this.rows.has(rel);
  }

  /** Whether a folder holds rows of packs (it stays in the vault without the disk). */
  holdsRows(folder: string): boolean {
    if (!this.rowFolders) {
      this.rowFolders = new Set();
      for (const p of this.rows.keys()) for (let d = dirname(p); !this.rowFolders.has(d); d = dirname(d)) {
        this.rowFolders.add(d);
        if (d === "") break;
      }
    }
    return this.rowFolders.has(folder);
  }

  /** The text of a packed row (its note as the engine would write it); undefined for another path. */
  textOf(rel: string): string | undefined {
    const r = this.rows.get(rel);
    return r ? rowNoteText(r.row) : undefined;
  }

  /** The row of the pack at `packPath` named `heading`, as a vault path; null when there is none. */
  rowAt(packPath: string, heading: string): string | null {
    // asked of a pack the resolver found: one the host keeps
    for (const r of this.packs.get(packPath)!.rows.values()) if (r.heading === heading) return r.file.path;
    return null;
  }

  /** The paths of the packs (for link resolution). */
  packPaths(): string[] {
    return [...this.packs.keys()];
  }

  /** Whether a path of the disk is a pack: one already, or a new file named as one with `pack` in its front matter. */
  handles(rel: string): boolean {
    return this.packs.has(rel) || (namedAsPack(rel) && packFrontmatter(this.readHead(rel)) !== null);
  }

  // --- start ---

  /**
   * Find the packs among `paths` (the vault's files: named `<table> <key>.md` in a table's
   * folder, with `pack` in their front matter) and list their rows instead of them, silently.
   */
  loadAll(paths: readonly string[]): void {
    for (const p of paths) {
      if (!namedAsPack(p)) continue;
      const text = this.read(p);
      // a file gone since the walk is no pack
      if (text !== null && packFrontmatter(text)) this.register(p, text, false);
    }
    if (this.dirty || this.rows.size !== this.saved.size) this.flush();
  }

  // --- hand edits ---

  /**
   * A pack path changed on disk (the watcher): read again and compared with what the host has,
   * row by row; returns what happened. A pack gone takes its rows away; a file that stopped being a
   * pack takes them away too (the caller indexes it as a note).
   */
  sync(rel: string): "created" | "modified" | "deleted" | null {
    const state = this.packs.get(rel);
    const st = this.diskStat(rel);
    const text = st ? this.read(rel) : null;
    if (st && text !== null && packFrontmatter(text)) {
      if (state && sameStat(state.stat, st)) return null; // its own write, or no change
      const changed = this.register(rel, text, true);
      this.save();
      return changed ? (state ? "modified" : "created") : null;
    }
    if (!state) return null;
    for (const r of [...state.rows.values()]) {
      this.forgetRow(state, r);
      this.vault.dropFile(r.file.path);
      this.vault.emit("delete", r.file);
    }
    this.dropPack(rel);
    this.vault.packsChanged([rel]);
    this.save();
    return "deleted";
  }

  /** A note of its own appeared at a packed row's path: it wins, the section is left aside. */
  noteAt(rel: string): void {
    // asked for a row's path (isRow)
    const r = this.rows.get(rel)!;
    const state = this.packs.get(r.pack)!;
    state.rows.delete(r.id);
    state.aside.push({ path: rel, row: r.row });
    this.rows.delete(rel);
    this.rowFolders = null;
    telemetry().log("WARN", "datanotes found a note where a row of a pack is: the note wins, the row stays aside in the pack", { path: rel, pack: r.pack });
    this.save();
  }

  /** A note of its own went from `rel`: a section left aside for it takes its place again (`create`). */
  noteGone(rel: string): void {
    for (const s of this.packs.values()) {
      const i = s.aside.findIndex((a) => a.path === rel);
      if (i < 0) continue;
      const [a] = s.aside.splice(i, 1);
      // a pack read or written has its stat
      const st = s.stat!;
      const file = this.vault.addFile(rel, { ctime: st.mtime, mtime: st.mtime, size: Buffer.byteLength(rowNoteText(a!.row)) });
      const packed: PackedRow = { file, pack: s.path, heading: a!.row.heading, id: idOf(a!.row), hash: this.hashOf(s, a!.row), row: a!.row };
      s.rows.set(packed.id, packed);
      this.rows.set(rel, packed);
      this.rowFolders = null;
      this.vault.emit("create", file);
      this.save();
      return;
    }
  }

  // --- the engine's writes ---

  /**
   * The engine writes `next` as the text of the packed row `file`: in its section when it can
   * stay (packable, the same pack, the same path), else as a note of its own at its path. The
   * caller announces the write.
   */
  async write(file: NodeFile, next: string): Promise<void> {
    const state = this.stateOf(file);
    const cur = this.rows.get(file.path);
    if (!cur || cur.file !== file) throw new Error(`${file.path} changed on disk since it was read`);
    const stays = this.staysIn(state, cur, next);
    await this.vault.guarded([state.path, file.path], async () => {
      if (stays) {
        cur.row = stays;
        cur.hash = this.hashOf(state, stays);
        await this.rewrite(state);
        file.stat = { ctime: file.stat.ctime, mtime: Date.now(), size: Buffer.byteLength(next) };
      } else {
        await this.vault.writeAtomic(file.path, next);
        const st = fs.statSync(this.vault.abs(file.path));
        this.forgetRow(state, cur);
        await this.rewrite(state);
        file.stat = { ctime: file.stat.ctime, mtime: st.mtimeMs, size: st.size, changed: st.ctimeMs };
      }
    });
    this.save();
  }

  /** Take a packed row out of its pack for good (a delete): the pack is written without it. */
  async remove(file: NodeFile): Promise<void> {
    const state = this.stateOf(file);
    const cur = this.rows.get(file.path);
    if (!cur) return;
    await this.vault.guarded([state.path, file.path], async () => {
      this.forgetRow(state, cur);
      await this.rewrite(state);
    });
    this.save();
  }

  /**
   * A packed row moved (a rename or a move) to `to`: it comes out as a note of its own at `to`,
   * with its modification time, and its pack is written without it. The index and the event are
   * the caller's.
   */
  async extractTo(file: NodeFile, to: string): Promise<void> {
    const state = this.stateOf(file);
    const cur = this.rows.get(file.path)!;
    await this.vault.writeAtomic(to, rowNoteText(cur.row));
    this.forgetRow(state, cur);
    await this.rewrite(state);
    const at = file.stat.mtime / 1000;
    fs.utimesSync(this.vault.abs(to), at, at);
    const st = fs.statSync(this.vault.abs(to));
    file.stat = { ctime: file.stat.ctime, mtime: st.mtimeMs, size: st.size, changed: st.ctimeMs };
    this.save();
  }

  /**
   * Before a folder goes (deleted or trashed): the packed rows under it come out of their packs as
   * notes of their own in place, so the folder holds them on disk. Silent (the caller announces
   * what it drops).
   */
  async extractUnder(folder: string): Promise<void> {
    for (const r of [...this.rows.values()]) {
      if (!r.file.path.startsWith(`${folder}/`)) continue;
      await this.extractTo(r.file, r.file.path);
    }
  }

  /** Whether a path is a pack the host knows with this stat on disk (nothing to read again). */
  unchanged(rel: string, st: { mtime: number; size: number }): boolean {
    const s = this.packs.get(rel);
    return s !== undefined && sameStat(s.stat, st);
  }

  /**
   * A folder went from the vault with what it held (deleted or trashed): its packs and their rows
   * are forgotten, silently (the caller announces the files it drops).
   */
  forgetUnder(folder: string): void {
    const gone = [...this.packs.values()].filter((s) => s.path.startsWith(`${folder}/`));
    if (gone.length === 0) return;
    for (const s of gone) {
      for (const r of [...s.rows.values()]) this.forgetRow(s, r);
      this.dropPack(s.path);
    }
    this.vault.packsChanged(gone.map((s) => s.path));
    this.save();
  }

  /** A folder of the vault moved (its rows already have their new paths): its packs follow. */
  moved(from: string, to: string): void {
    const packs = [...this.packs.values()].filter((s) => s.path.startsWith(`${from}/`));
    if (packs.length === 0) return;
    const old = packs.map((s) => s.path);
    for (const s of packs) {
      this.dropPack(s.path);
      s.path = to + s.path.slice(from.length);
      this.addPack(s);
      for (const r of s.rows.values()) r.pack = s.path;
      for (const a of s.aside) if (a.path.startsWith(`${from}/`)) a.path = to + a.path.slice(from.length);
    }
    this.rows = new Map([...this.rows.values()].map((r) => [r.file.path, r]));
    this.rowFolders = null;
    this.vault.packsChanged([...old, ...packs.map((s) => s.path)]);
    this.save();
  }

  // --- inside ---

  /** A pack the host keeps from now on (links into it name its rows: validate.ts's pack names). */
  private addPack(state: PackState): void {
    if (!this.packs.has(state.path)) countPackName(basename(state.path).replace(/\.md$/i, ""), 1);
    this.packs.set(state.path, state);
  }

  /** A pack the host no longer keeps. */
  private dropPack(p: string): void {
    if (this.packs.delete(p)) countPackName(basename(p).replace(/\.md$/i, ""), -1);
  }

  /** The pack of a packed row, read again first when it changed on disk; refused when it cannot be read. */
  private stateOf(file: NodeFile): PackState {
    const r = this.rows.get(file.path);
    if (!r) throw new Error(`${file.path} is not a row of a pack`);
    const state = this.packs.get(r.pack)!;
    this.freshen(state);
    this.assertReadable(state);
    return state;
  }

  private assertReadable(state: PackState): void {
    if (state.broken !== null) throw new Error(`the pack ${state.path} cannot be read (${state.broken}): fix it by hand first`);
  }

  /** The rows a pack's text holds: its listed rows and those left aside. */
  private rowsOf(state: PackState): PackRow[] {
    return [...[...state.rows.values()].map((r) => r.row), ...state.aside.map((a) => a.row)];
  }

  /** The hash of a row's section as the host writes it. */
  private hashOf(state: PackState, row: PackRow): string {
    return contentHash(sectionText(row, state.meta.table, state.tableKey));
  }

  /** A file's text; null when it cannot be read. */
  private read(rel: string): string | null {
    try {
      return fs.readFileSync(this.vault.abs(rel), "utf8");
    } catch {
      return null;
    }
  }

  /** The first 4 KB of a file (enough for a pack's front matter); "" when it cannot be read. */
  private readHead(rel: string): string {
    try {
      const fd = fs.openSync(this.vault.abs(rel), "r");
      try {
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, n).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  private diskStat(rel: string): { mtime: number; size: number; ctime: number } | null {
    try {
      const s = fs.statSync(this.vault.abs(rel));
      /* v8 ignore next -- a folder named like a pack, or a file system without birth times */
      return s.isFile() ? { mtime: s.mtimeMs, size: s.size, ctime: s.birthtimeMs || s.ctimeMs } : null;
    } catch {
      return null;
    }
  }

  /** Before a write: a pack changed on disk since the host read it is read again (its events sent). */
  private freshen(state: PackState): void {
    const st = this.diskStat(state.path);
    if (st && sameStat(state.stat, st)) return;
    this.sync(state.path);
  }

  /** The table of a pack as its database's metastore says (by its stat); null when unknown. */
  private tableOf(packPath: string, table: string): PackedTable | null {
    const root = databaseRootOfPack(packPath, table);
    if (root === null) return null;
    const metastore = root === "" ? METASTORE_FILE : `${root}/${METASTORE_FILE}`;
    try {
      const st = fs.statSync(this.vault.abs(metastore));
      let hit = this.schemas.get(root);
      if (!hit || hit.mtime !== st.mtimeMs || hit.size !== st.size) {
        hit = { mtime: st.mtimeMs, size: st.size, tables: packedTablesIn(fs.readFileSync(this.vault.abs(metastore), "utf8"), root) };
        this.schemas.set(root, hit);
      }
      return hit.tables.get(table) ?? null;
    } catch {
      return null;
    }
  }

  /** The path of a section's row: from its values and the table's layout, else its heading next to the pack. */
  private rowPath(state: PackState, row: PackRow): string {
    const layout = this.tableOf(state.path, state.meta.table)?.layout ?? null;
    let p: string | null = null;
    if (layout) {
      try {
        p = rowPathOf(layout, new Map(row.ordered));
      } catch {
        p = null;
      }
    }
    if (p === null) return `${dirname(state.path)}/${row.heading}.md`;
    // the heading names the row (links use it): a section whose values give another name keeps its heading
    return basename(p).replace(/\.md$/i, "") === row.heading ? p : `${dirname(p)}/${row.heading}.md`;
  }

  /**
   * Read a pack's text into the index: its rows listed at their paths, the pack's file out of the
   * index. `live` (the engine runs): each row that came, went, moved or changed gets its event.
   * Returns whether a row changed. A pack that cannot be read keeps the rows it had (a WARN).
   */
  private register(rel: string, text: string, live: boolean): boolean {
    const fm = packFrontmatter(text)!;
    const tableKey = tableKeyOf(fm);
    const st = this.diskStat(rel)!;
    let parsed: ReturnType<typeof parsePack>;
    try {
      parsed = parsePack(text, tableKey, (t) => this.knownValues(t));
    } catch (e) {
      this.hashes.clear();
      telemetry().log("WARN", "datanotes cannot read a pack: its rows stay as they were until it is fixed", { pack: rel, error: messageOf(e) });
      const known = this.packs.get(rel);
      if (known) {
        known.broken = messageOf(e);
        known.stat = { mtime: st.mtime, size: st.size };
      }
      return false;
    }
    let state = this.packs.get(rel);
    const fresh = !state;
    if (!state) {
      state = { path: rel, meta: parsed.meta, tableKey, rows: new Map(), aside: [], stat: null, broken: null };
      this.addPack(state);
    }
    state.meta = parsed.meta;
    state.tableKey = tableKey;
    state.stat = { mtime: st.mtime, size: st.size };
    state.broken = null;
    state.aside = [];
    // the pack's file is no note of the vault
    const asNote = this.vault.indexed(rel);
    if (asNote && !this.rows.has(rel)) {
      this.vault.dropFile(rel);
      if (live) this.vault.emit("delete", asNote);
    }
    let changed = false;
    const seen = new Set<string>();
    const size = (row: PackRow) => Buffer.byteLength(rowNoteText(row));
    for (const sec of parsed.sections) {
      const row: PackRow = { heading: sec.heading, ordered: sec.ordered, body: sec.body };
      const id = idOf(row);
      seen.add(id);
      const hash = this.hashes.get(sec.text) ?? contentHash(sec.text);
      const at = this.rowPath(state, row);
      const old: PackedRow | undefined = state.rows.get(id);
      if (old && old.hash === hash && old.file.path === at) continue;
      const other: PackedRow | undefined = this.rows.get(at);
      const otherPack: PackState | undefined = other && other !== old ? this.packs.get(other.pack) : undefined;
      if (other && other !== old && otherPack !== state && this.diskStat(other.pack) !== null) {
        telemetry().log("WARN", "datanotes found a row in two packs: the one read first keeps it", { path: at, pack: rel, other: other.pack });
        state.aside.push({ path: at, row });
        continue;
      }
      const real = this.vault.indexed(at);
      if (real && !this.rows.has(at)) {
        telemetry().log("WARN", "datanotes found a note where a row of a pack is: the note wins, the row stays aside in the pack", { path: at, pack: rel });
        state.aside.push({ path: at, row });
        continue;
      }
      changed = true;
      if (old) {
        // the same row: changed, renamed or both
        const from = old.file.path;
        const textChanged = old.hash !== hash;
        old.row = row;
        old.heading = sec.heading;
        old.hash = hash;
        if (textChanged) old.file.stat = { ...old.file.stat, mtime: st.mtime, size: size(row) };
        if (from !== at) {
          this.rows.delete(from);
          this.vault.repath(old.file, at);
          this.rows.set(at, old);
          this.rowFolders = null;
          if (live) this.vault.emit("rename", old.file, from);
        }
        if (live && textChanged) this.vault.emit("modify", old.file);
        continue;
      }
      if (other && otherPack) {
        // a row whose pack is gone from the disk (a pack renamed by hand): this pack takes it
        otherPack.rows.delete(other.id);
        const same = other.hash === hash;
        Object.assign(other, { pack: rel, id, row, heading: sec.heading, hash });
        state.rows.set(id, other);
        if (!same) {
          other.file.stat = { ...other.file.stat, mtime: st.mtime, size: size(row) };
          if (live) this.vault.emit("modify", other.file);
        }
        continue;
      }
      // the stat the row had (packs.json), while its section is the same; else the pack's
      const saved = this.saved.get(at);
      const known = saved !== undefined && saved[0] === rel && saved[1] === hash;
      if (!known) this.dirty = true;
      const stat: NodeFileStats = known ? { ctime: saved[2], mtime: saved[3], size: saved[4] } : { ctime: st.ctime, mtime: st.mtime, size: size(row) };
      const file = this.vault.addFile(at, stat);
      const packed: PackedRow = { file, pack: rel, heading: sec.heading, id, hash, row };
      state.rows.set(id, packed);
      this.rows.set(at, packed);
      this.rowFolders = null;
      if (live) this.vault.emit("create", file);
    }
    this.hashes.clear();
    for (const [id, r] of [...state.rows]) {
      if (seen.has(id)) continue;
      changed = true;
      this.forgetRow(state, r);
      this.vault.dropFile(r.file.path);
      if (live) this.vault.emit("delete", r.file);
    }
    if (fresh) this.vault.packsChanged([rel]);
    return changed || fresh;
  }

  /** The row a write keeps in its pack as `next` (its new text), or null when it comes out. */
  private staysIn(state: PackState, cur: PackedRow, next: string): PackRow | null {
    const ok = packable(next, cur.heading, state.meta.table, state.tableKey);
    if (!ok.ok) return null;
    if (idOf(ok.row) !== cur.id) return null;
    const template = this.tableOf(state.path, state.meta.table)?.template ?? null;
    if (template && packKeyOf(template, new Map(ok.row.ordered)) !== state.meta.key) return null;
    if (this.rowPath(state, ok.row) !== cur.file.path) return null;
    return ok.row;
  }

  /** Write a pack with its rows now (those left aside kept), or remove it when none is left. */
  private async rewrite(state: PackState): Promise<void> {
    const all = this.rowsOf(state);
    if (all.length === 0) {
      fs.rmSync(this.vault.abs(state.path), { force: true });
      this.dropPack(state.path);
      this.vault.packsChanged([state.path]);
      return;
    }
    await this.vault.writeAtomic(state.path, packText(state.meta, state.tableKey, all));
    state.stat = this.diskStat(state.path);
  }

  /** List a note's file as a row of `state` (its file object and stat kept). */
  private adopt(state: PackState, file: NodeFile, row: PackRow): void {
    const packed: PackedRow = { file, pack: state.path, heading: row.heading, id: idOf(row), hash: this.hashOf(state, row), row };
    state.rows.set(packed.id, packed);
    this.rows.set(file.path, packed);
    this.rowFolders = null;
    delete file.stat.changed;
  }

  private forgetRow(state: PackState, r: PackedRow): void {
    state.rows.delete(r.id);
    if (this.rows.get(r.file.path) === r) this.rows.delete(r.file.path);
    this.rowFolders = null;
  }

  /** A note written back from a row: the modification time the row had, and the stat of the disk. */
  private keepTime(file: NodeFile): void {
    const abs = this.vault.abs(file.path);
    const at = file.stat.mtime / 1000;
    fs.utimesSync(abs, at, at);
    const st = fs.statSync(abs);
    file.stat = { ...file.stat, mtime: st.mtimeMs, size: st.size, changed: st.ctimeMs };
  }

  /** Remove the folders a note left empty, up to the first that is not (they stay in the index while rows are listed there). */
  private removeEmptyFolders(dir: string): void {
    for (let d = dir; d !== ""; d = dirname(d)) {
      try {
        fs.rmdirSync(this.vault.abs(d));
      } catch {
        return; // not empty, or gone
      }
    }
  }

  /** The values of a section `packs.json` kept (by the hash of its text), when it has them. */
  private knownValues(sectionText: string): [string, unknown][] | undefined {
    if (this.saved.size === 0) return undefined;
    if (!this.byHash) {
      this.byHash = new Map();
      for (const s of this.saved.values()) if (s[5]) this.byHash.set(s[1], s[5]);
    }
    const hash = contentHash(sectionText);
    this.hashes.set(sectionText, hash);
    return this.byHash.get(hash);
  }

  /** Keep the rows' stats in `packs.json` soon (a burst of changes is written once). */
  private save(): void {
    this.dirty = true;
    if (!this.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  /** Write the rows' stats to `packs.json` now (when the host has a store): at stop, and after a pack or unpack. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.stateFile) return;
    const rows: Record<string, SavedRow> = {};
    for (const [p, r] of this.rows) rows[p] = [r.pack, r.hash, r.file.stat.ctime, r.file.stat.mtime, r.file.stat.size, ...(jsonSafe(r.row.ordered) ? [r.row.ordered as [string, unknown][]] : [])] as SavedRow;
    this.saved = new Map(Object.entries(rows));
    this.byHash = null;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, rows }), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      telemetry().log("WARN", "datanotes could not keep the stats of the rows of packs", { file: this.stateFile, error: messageOf(e) });
    }
  }
}
