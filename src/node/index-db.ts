/**
 * The vault index on disk, `<store>/index/vault.sqlite`: what the headless host learns from each
 * file of the vault (its stat and file id; for a note its hash, front matter, tags, links and
 * where they lead, and its text), so that a start reads only the notes changed since the last
 * run, as Obsidian does with its own metadata cache.
 *
 * It is a cache, never a source of truth: a note counts as unchanged only while its stat is the
 * one recorded and it was not written within {@link RACY_MS} of being recorded (git's "racy
 * clean" rule: a write in the same tick as the record keeps its mtime); any other note is read
 * again. Deleting the file is always safe: the next start rebuilds it. It is not part of the
 * store backup (the backup's `.gitignore` tracks a fixed list of folders).
 *
 * The host keeps it up to date in the background ({@link IndexKeeper}: a transaction at most every
 * {@link FLUSH_MS}, and at stop); a crash loses at most the last ones, which the next start finds
 * again by the stat. A file written by another engine version, by another parser, or for another
 * vault is deleted and rebuilt; so is one SQLite cannot read. An error of SQLite while the engine
 * runs turns the index off for the run (the engine keeps everything in memory); one that says the
 * file is damaged leaves a mark ({@link DAMAGED_FILE}), and the next start rebuilds it.
 *
 * It also holds the search table: each note's folded path and text as trigrams (FTS5), so that
 * search_notes reads only the notes that can match; texts are stored compressed.
 *
 * After a start the keeper reads the search's row ids in slices, then has SQLite check the file a
 * table at a time ({@link IndexKeeper.afterStart}); damage found leaves the mark too.
 *
 * It needs `node:sqlite` (Node 22.13 or later; loaded through `process.getBuiltinModule`, so the
 * bundle runs on any Node): without it, or with the setting `vaultIndexEnabled` off, every start
 * reads every note.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { OrderedFrontmatter } from "../core/types";
import { telemetry } from "../core/telemetry";
import { messageOf } from "../core/message";
import { searchFold } from "../core/vault-read";
import { intern } from "../core/intern";
import { makePrivateDir, tightenPrivate } from "./private-files";

/** The parts of `node:sqlite` the index uses (the API Node 22.13 and later share). */
interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  setReadBigInts(enabled: boolean): void;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
export interface SqliteModule {
  DatabaseSync: new (file: string) => Database;
}

/**
 * How `node:sqlite` is loaded: without a warning (Node 22.13 to 23 call it experimental when it
 * loads; that warning only is dropped), and null where it is missing (Node 22.0 to 22.12, another
 * runtime). Tests replace `load` to run without it.
 */
export const SQLITE: { load: () => SqliteModule | null } = { load: loadSqlite };

export function loadSqlite(): SqliteModule | null {
  const emit = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const text = typeof warning === "string" ? warning : warning.message;
    const kind = typeof rest[0] === "string" ? rest[0] : ((rest[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : ""));
    if (kind === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const m = get?.call(process, "node:sqlite") as SqliteModule | undefined;
    return m && typeof m.DatabaseSync === "function" ? m : null;
  } catch {
    return null; // a Node with getBuiltinModule but without node:sqlite (22.3 to 22.12)
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * The layout of the file: another value deletes and rebuilds it. 2: `changed`, each file's change
 * time. 3: texts compressed (deflate-raw), the search table.
 */
export const INDEX_FORMAT = "3";

/**
 * The version of what the host reads from a note (front matter, tags, links, how links resolve):
 * bump it when that changes, so that the indexes kept by the previous code are rebuilt. The
 * engine's version is part of the key too: every release rebuilds the index once.
 */
export const PARSE_VERSION = 1;

/**
 * A note recorded within this long of its last write is read again at the next start (ms): a file
 * system that keeps the mtime to the second or two (FAT, SMB) shows no change for a write in that
 * time. The keeper waits until a note written by the engine is that old before it records it.
 */
export const RACY_MS = 2000;

/** The index is written at most this often while the engine runs (ms). */
export const FLUSH_MS = 200;

/**
 * At most this many files are written in one transaction, {@link SLICE_PAUSE_MS} apart: a start
 * that records every note writes them a slice at a time, and the engine answers in between.
 */
export const FLUSH_FILES = 1000;

/** The pause between two slices of a long write (ms). */
export const SLICE_PAUSE_MS = 10;

/**
 * At most this many note texts in one transaction: each also goes to the search table, whose
 * deletes cost more in a large transaction. A start that records every note writes them a slice
 * at a time.
 */
export const FLUSH_TEXTS = 200;

/** At most this many trigrams in one search: a longer query is narrowed by its first ones (FTS5 limits an expression's depth). */
export const SEARCH_GRAMS = 64;

/** How many rows of `search_rows` one slice of the warm-up reads ({@link IndexDb.warmSearchPaths}). Tests change it. */
export const SEARCH_PATHS_SLICE = { rows: 5000 };

/**
 * SQLite's check of the index after a start ({@link IndexKeeper.afterStart}): how long after the
 * row ids are read it begins, and the pause between two tables (ms). Tests change them.
 */
export const INDEX_CHECK = { delayMs: 30_000, pauseMs: 100 };

/** The file's name in `<store>/index/`. */
export const INDEX_FILE = "vault.sqlite";

/** The mark a run leaves next to an index SQLite found damaged (its error inside): the next start rebuilds the index. */
export const DAMAGED_FILE = `${INDEX_FILE}.damaged`;

/** SQLite's result codes for a damaged file: SQLITE_CORRUPT (11), SQLITE_NOTADB (26). */
const DAMAGED_CODES = new Set([11, 26]);

/**
 * Whether an error of SQLite says the file is damaged. `node:sqlite` gives the code as `errcode`
 * (an extended code: its low byte is the primary one); an error without it is read by its message.
 */
export function damaged(e: unknown): boolean {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof code === "number") return DAMAGED_CODES.has(code & 0xff);
  return /malformed|not a database|corrupt/i.test(messageOf(e));
}

/** How a note's front matter is recorded (`fm_state`). */
const FM = { parsed: 1, unreadable: 2, unknown: 3 } as const;

/** A note as the index records it. */
export interface NoteRecord {
  hash: string;
  /** The front matter's entries (`readOrderedFromMarkdown`) and where the body starts; null when the YAML cannot be read. */
  parse: { ordered: OrderedFrontmatter; bodyStart: number } | null;
  tags: string[];
  links: [linkpath: string, subpath: string][];
}

/** Where a note's links lead: target path → links, link path → links that lead nowhere. */
export interface NoteLinks {
  resolved: Record<string, number>;
  unresolved: Record<string, number>;
}

/** A file as the index records it (`note` for a Markdown note). */
export interface FileRecord {
  path: string;
  mtime: number;
  size: number;
  ctime: number;
  /** The status change time (POSIX ctime, NTFS ChangeTime), ms: it moves with every write, also one that restores the old mtime. Null: not recorded. */
  changed: number | null;
  fileId: string | null;
  indexedAt: number;
  /** A note's record: null for another file; undefined when it is to be read again. */
  note: NoteRecord | null | undefined;
  /** Where the note's links led when it was recorded (null: not recorded). */
  links: NoteLinks | null;
}

/** Whether a value survives a JSON round trip unchanged (strings, finite numbers but -0, booleans, null, arrays, plain objects). */
export function jsonSafe(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0);
  if (Array.isArray(v)) return v.every(jsonSafe);
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v) as unknown;
    return (proto === Object.prototype || proto === null) && Object.values(v as Record<string, unknown>).every(jsonSafe);
  }
  return false;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  ctime REAL NOT NULL,
  changed REAL,
  file_id TEXT,
  indexed_at INTEGER NOT NULL,
  note INTEGER NOT NULL,
  hash TEXT,
  fm_state INTEGER,
  fm TEXT,
  body_start INTEGER,
  tags TEXT,
  links TEXT,
  resolved TEXT,
  unresolved TEXT
);
CREATE TABLE IF NOT EXISTS texts (path TEXT PRIMARY KEY, hash TEXT NOT NULL, text BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS search_rows (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
`;

/**
 * The search table: each note's path and text folded as search_notes folds them, as trigrams
 * (three code points; case_sensitive: the fold is ours), nothing else stored (contentless: the
 * texts are in `texts`), a row deleted by its id (contentless_delete, SQLite 3.43), no positions
 * (detail=none: a word is looked up as the trigrams it has, a superset the engine checks on the
 * text). Its rowid is `search_rows.id`. Needs FTS5 in node:sqlite.
 */
const SEARCH_SCHEMA = "CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(name, text, tokenize = 'trigram case_sensitive 1', content = '', contentless_delete = 1, detail = none)";

/**
 * A statement the index runs (`run()`): its answer as BigInts. `run()` answers the connection's
 * last inserted rowid, whatever table set it: after a delete from the search table that is the
 * rowid of an FTS5 tombstone page (2^53 and up), and Node 26 refuses to give it as a number
 * ("Value is too large to be represented"), where Node 22 and 24 gave it rounded. As a BigInt it
 * is exact on every Node; the index reads only `search_rows`' own ids from it.
 */
function writeStatement(db: Database, sql: string): Statement {
  const s = db.prepare(sql);
  s.setReadBigInts(true);
  return s;
}

/** Create the search table where this SQLite can: whether it is there. */
function searchTable(db: Database): boolean {
  try {
    db.exec(SEARCH_SCHEMA);
    db.prepare("SELECT rowid FROM search LIMIT 0").all();
    return true;
  } catch {
    return false; // no FTS5 (or an SQLite before 3.43): search_notes reads every note
  }
}

/** A note's text as the index stores it: UTF-8, deflate-raw at level 1 (fast, about half the size). */
function pack(text: string): Buffer {
  return zlib.deflateRawSync(Buffer.from(text, "utf8"), { level: 1 });
}

/** A stored text back. One that does not inflate is a damaged file (SQLITE_CORRUPT: the next start rebuilds it). */
function unpack(blob: unknown, p: string): string {
  try {
    return zlib.inflateRawSync(blob as Uint8Array).toString("utf8");
  } catch (e) {
    throw Object.assign(new Error(`the vault index holds a damaged text for ${p}: ${messageOf(e)}`), { errcode: 11 });
  }
}

/** A note's text as the search table holds it: folded as search_notes folds, NUL as a space (no word looked up has one). */
function searchText(text: string): string {
  return searchFold(text).replace(/\0/g, " ");
}

/** A warm-up of the row-id map under way: the rows read so far, the last id read, the next slice, its promise's resolve. */
interface Warming {
  map: Map<number, string>;
  after: number;
  next: ReturnType<typeof setImmediate> | null;
  done: () => void;
}

/** The index file of a store, open. */
export class IndexDb {
  private readonly put: Statement;
  private readonly putText: Statement;
  private readonly drop: Statement;
  private readonly dropText: Statement;
  private readonly move: Statement;
  private readonly moveText: Statement;
  private readonly update: Statement;
  private readonly getText: Statement;
  private readonly clean: Statement;
  private readonly textAt: Statement;
  // the search table's statements: null without one
  private readonly searchId: Statement | null;
  private readonly searchRowAdd: Statement | null;
  private readonly searchRowDrop: Statement | null;
  private readonly searchPut: Statement | null;
  private readonly searchDrop: Statement | null;
  private readonly searchQuery: Statement | null;
  private readonly pathsAfter: Statement | null;
  /**
   * `search_rows` in memory: a search row's id to its note's path, so a search asks SQLite for
   * the matching ids only (no join). Read after a start in slices ({@link warmSearchPaths}), or at
   * the first search, whichever comes first; then kept in step: a write's changes to it apply once
   * the write commits. Null until then.
   */
  private paths: Map<number, string> | null = null;
  /** The warm-up of {@link paths} under way ({@link warmSearchPaths}). */
  private warming: Warming | null = null;
  private warmed: Promise<void> | null = null;
  /** Slices the warm-up read (tests). */
  warmSlices = 0;
  /** The changes a write under way makes to {@link paths} (id, path; null: gone). */
  private pathChanges: [number, string | null][] = [];
  private closed = false;

  private constructor(
    private readonly db: Database,
    /** The file (`<store>/index/vault.sqlite`). */
    readonly file: string,
    /** Why it was built anew at this open (none before, or one that could not be used); null when it was used. */
    readonly rebuilt: string | null,
    /** Whether it holds the search table (FTS5 in this SQLite): only then can it answer a search. */
    readonly searchable: boolean,
  ) {
    const writer = (sql: string) => writeStatement(db, sql);
    this.clean = writer("INSERT OR REPLACE INTO meta (key, value) VALUES ('clean', ?)");
    this.put = writer(
      "INSERT OR REPLACE INTO files (path, mtime, size, ctime, changed, file_id, indexed_at, note, hash, fm_state, fm, body_start, tags, links, resolved, unresolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.putText = writer("INSERT OR REPLACE INTO texts (path, hash, text) VALUES (?, ?, ?)");
    this.drop = writer("DELETE FROM files WHERE path = ?");
    this.dropText = writer("DELETE FROM texts WHERE path = ?");
    // a note moved: its links resolve from its new folder, written by a later update (none: resolved again)
    this.move = writer("UPDATE files SET path = ?, resolved = NULL, unresolved = NULL WHERE path = ?");
    this.moveText = writer("UPDATE texts SET path = ? WHERE path = ?");
    this.update = writer("UPDATE files SET mtime = ?, size = ?, ctime = ?, changed = ?, file_id = ?, indexed_at = ?, resolved = ?, unresolved = ? WHERE path = ?");
    this.getText = db.prepare("SELECT text FROM texts WHERE path = ? AND hash = ?");
    this.textAt = db.prepare("SELECT text FROM texts WHERE path = ?");
    const prep = (sql: string) => (searchable ? db.prepare(sql) : null);
    const prepWriter = (sql: string) => (searchable ? writer(sql) : null);
    this.searchId = prep("SELECT id FROM search_rows WHERE path = ?");
    this.searchRowAdd = prepWriter("INSERT INTO search_rows (path) VALUES (?)");
    this.searchRowDrop = prepWriter("DELETE FROM search_rows WHERE id = ?");
    this.searchPut = prepWriter("INSERT INTO search (rowid, name, text) VALUES (?, ?, ?)");
    this.searchDrop = prepWriter("DELETE FROM search WHERE rowid = ?");
    this.searchQuery = prep("SELECT rowid AS id FROM search WHERE search MATCH ?");
    this.pathsAfter = prep("SELECT id, path FROM search_rows WHERE id > ? ORDER BY id LIMIT ?");
  }

  /**
   * Open (or create) the index of a store for a vault, and read every file it records. A file of
   * another format, parser or vault, or one SQLite cannot read, is deleted and created again
   * (`rebuilt` says why). Null when `node:sqlite` is missing, or the file can be neither opened nor
   * deleted (another process holds it): the engine then reads every note, as without an index.
   * `links`: whether the links recorded agree with the files recorded (the last write left the
   * index caught up with the engine); otherwise every link is resolved again.
   */
  static open(store: string, o: { vault: string; version: string }): { db: IndexDb; files: Map<string, FileRecord>; links: boolean } | null {
    const sqlite = SQLITE.load();
    if (!sqlite) return null;
    const dir = path.join(store, "index");
    const file = path.join(dir, INDEX_FILE);
    const vault = realPath(o.vault);
    let why: string | null = fs.existsSync(file) ? null : "none yet";
    // a run found it damaged: built anew (the mark goes with it)
    const mark = readText(path.join(dir, DAMAGED_FILE));
    if (mark !== null) {
      why = `the last run found it damaged (${mark})`;
      if (!removeIndex(dir)) {
        telemetry().log("WARN", "datanotes could not open the vault index: every note is read at start", { file, error: `${DAMAGED_FILE}: the damaged index cannot be deleted` });
        return null;
      }
    }
    for (let attempt = 0; ; attempt++) {
      let db: Database | null = null;
      try {
        makePrivateDir(dir);
        db = new sqlite.DatabaseSync(file);
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;");
        db.exec(SCHEMA);
        const searchable = searchTable(db);
        // `search` last: a file kept with the search table where FTS5 is now missing (or the reverse) is rebuilt
        const want: Record<string, string> = { format: INDEX_FORMAT, parser: `${o.version}/${PARSE_VERSION}`, vault, search: searchable ? "fts5" : "none" };
        const meta = new Map(db.prepare("SELECT key, value FROM meta").all().map((r) => [String(r.key), String(r.value)]));
        meta.delete("clean");
        const differs = meta.size === 0 ? undefined : Object.keys(want).find((k) => meta.get(k) !== want[k]);
        if (differs) throw new Rebuild(`another ${differs} (${meta.get(differs) ?? "none"}, now ${want[differs]})`);
        if (meta.size === 0) {
          db.exec("DELETE FROM files; DELETE FROM texts; DELETE FROM search_rows;");
          if (searchable) db.exec("DELETE FROM search;");
          const set = writeStatement(db, "INSERT INTO meta (key, value) VALUES (?, ?)");
          for (const [k, v] of Object.entries(want)) set.run(k, v);
        }
        const files = readFiles(db);
        const links = db.prepare("SELECT value FROM meta WHERE key = 'clean'").get()?.value === "1";
        tightenPrivate([dir, file]);
        return { db: new IndexDb(db, file, why, searchable), files, links };
      } catch (e) {
        /* v8 ignore start -- defensive: a handle SQLite already failed on refuses to close */
        try {
          db?.close();
        } catch {
          // closed with the error
        }
        /* v8 ignore stop */
        why = e instanceof Rebuild ? e.message : `it could not be read: ${messageOf(e)}`;
        if (attempt > 0 || !removeIndex(dir)) {
          telemetry().log("WARN", "datanotes could not open the vault index: every note is read at start", { file, error: messageOf(e) });
          return null;
        }
      }
    }
  }

  /** The text recorded for a note when it has this hash (undefined otherwise). */
  text(p: string, hash: string): string | undefined {
    const r = this.getText.get(p, hash);
    return r ? unpack(r.text, p) : undefined;
  }

  /** Index a note's text for search (inside a write): its row replaced, or added. */
  private indexText(p: string, text: string): void {
    const row = this.searchId!.get(p);
    let id: number;
    if (row) {
      id = Number(row.id);
      this.searchDrop!.run(id);
    } else {
      id = Number((this.searchRowAdd!.run(p) as { lastInsertRowid: number | bigint }).lastInsertRowid);
      this.pathChanges.push([id, p]);
    }
    this.searchPut!.run(id, searchFold(p), searchText(text));
  }

  /** A path's search row gone (inside a write). */
  private unindex(p: string): void {
    const row = this.searchId!.get(p);
    if (!row) return;
    this.searchDrop!.run(Number(row.id));
    this.searchRowDrop!.run(Number(row.id));
    this.pathChanges.push([Number(row.id), null]);
  }

  /**
   * The paths of the notes whose search row has every trigram of `words` (at most SEARCH_GRAMS
   * trigrams, in the words' order); null when the words have no trigram (the table cannot tell).
   */
  searchHits(words: readonly string[]): string[] | null {
    const grams = new Set<string>();
    for (const w of words) {
      const cps = Array.from(w);
      for (let i = 0; i + 3 <= cps.length && grams.size < SEARCH_GRAMS; i++) grams.add(cps[i]! + cps[i + 1]! + cps[i + 2]!);
    }
    if (grams.size === 0 || !this.searchQuery) return null;
    const expr = [...grams].map((g) => `"${g.replace(/"/g, '""')}"`).join(" AND ");
    const rows = this.searchQuery.all(expr);
    const paths = this.searchPaths();
    const out: string[] = [];
    for (const r of rows) {
      const p = paths.get(Number(r.id));
      if (p !== undefined) out.push(p);
    }
    return out;
  }

  /**
   * Read {@link paths} now, {@link SEARCH_PATHS_SLICE}.rows rows at a time, one slice per turn of
   * the event loop (after a start: the first search then finds it ready). Writes meanwhile change
   * the rows read so far as they change the map ({@link applyPathChanges}). Resolves once read, or
   * once a search read the rest, or the file closed; rejects on an error of SQLite. A second call
   * answers the same promise; none without the search table, or with the map read.
   */
  warmSearchPaths(): Promise<void> {
    if (!this.searchable || this.paths || this.closed) return Promise.resolve();
    if (this.warmed) return this.warmed;
    this.warmed = new Promise<void>((resolve, reject) => {
      // row ids start at 1 (INTEGER PRIMARY KEY, given by SQLite)
      const w: Warming = { map: new Map(), after: 0, next: null, done: resolve };
      this.warming = w;
      // never awaits: a slice and a write never interleave, which keeps the map exact
      const slice = (): void => {
        w.next = null;
        if (this.warming !== w) return; // a search read the rest, or the file closed
        try {
          const rows = this.pathsAfter!.all(w.after, SEARCH_PATHS_SLICE.rows);
          for (const r of rows) {
            const id = Number(r.id);
            w.map.set(id, intern(String(r.path)));
            w.after = id;
          }
          this.warmSlices++;
          if (rows.length < SEARCH_PATHS_SLICE.rows) {
            this.paths = w.map;
            this.endWarm();
          } else w.next = setImmediate(slice);
        } catch (e) {
          reject(e); // first: endWarm resolves, and a settled promise stays as it is
          this.endWarm();
        }
      };
      w.next = setImmediate(slice);
    });
    return this.warmed;
  }

  /** Stop a warm-up under way (the index turned off): the rows read so far are dropped, its promise resolves. */
  endWarmup(): void {
    this.endWarm();
  }

  /** The warm-up over (read, read by a search, closed, failed): its promise resolved (a failure rejects it first). */
  private endWarm(): void {
    const w = this.warming;
    this.warming = null;
    this.warmed = null;
    if (!w) return;
    if (w.next) clearImmediate(w.next);
    w.next = null;
    w.done();
  }

  /** {@link paths}, read now if not yet (what a warm-up under way has not read yet): the paths interned (the vault's own copies). */
  private searchPaths(): Map<number, string> {
    if (this.paths) return this.paths;
    const w = this.warming;
    const paths = w?.map ?? new Map<number, string>();
    // LIMIT -1: no limit
    for (const r of this.pathsAfter!.all(w?.after ?? 0, -1)) paths.set(Number(r.id), intern(String(r.path)));
    this.paths = paths;
    this.endWarm();
    return paths;
  }

  /** A write's changes to {@link paths}, once it committed (dropped when it rolled back). */
  private applyPathChanges(committed: boolean): void {
    const changes = this.pathChanges;
    this.pathChanges = [];
    // the map, or the one a warm-up is reading: a row it read already follows the write too
    const target = this.paths ?? this.warming?.map ?? null;
    if (!committed || !target) return;
    for (const [id, p] of changes) {
      if (p === null) target.delete(id);
      else target.set(id, intern(p));
    }
  }

  /** The tables SQLite's check reads: every table but the search table (FTS5's own check of it reads its whole index; its storage tables are tables and are checked). */
  checkTables(): string[] {
    return this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name")
      .all()
      .map((r) => String(r.name));
  }

  /** SQLite's quick check of one table and its indexes: the problems it reports (none: sound). */
  quickCheck(table: string): string[] {
    return this.db
      .prepare(`PRAGMA quick_check("${table.replace(/"/g, '""')}")`)
      .all()
      .map((r) => String(Object.values(r)[0]))
      .filter((m) => m !== "ok");
  }

  /**
   * Write a batch of changes as one transaction (see {@link IndexKeeper}). `caughtUp`: nothing is
   * left to write after it, so the links recorded agree with the files recorded. Every change of
   * `texts` changes the search table the same way, in the same transaction. Returns the notes the
   * search table holds as written (none without the table).
   */
  write(b: IndexBatch, caughtUp: boolean): string[] {
    const indexed: string[] = [];
    this.db.exec("BEGIN");
    try {
      this.clean.run(caughtUp ? "1" : "0");
      for (const op of b.ops) {
        const at = op.to ?? op.from;
        this.drop.run(at);
        this.dropText.run(at);
        if (this.searchable) this.unindex(at);
        if (op.to === null) continue;
        this.move.run(op.to, op.from);
        this.moveText.run(op.to, op.from);
        if (this.searchable) {
          // the moved note's row: its name is its new path's, indexed again from the text that moved with it
          this.unindex(op.from);
          const t = this.textAt.get(op.to);
          if (t) {
            this.indexText(op.to, unpack(t.text, op.to));
            indexed.push(op.to);
          }
        }
      }
      for (const f of b.files) {
        const n = f.note;
        const state = n === null ? null : n.parse === null ? FM.unreadable : jsonSafe(n.parse.ordered) ? FM.parsed : FM.unknown;
        this.put.run(
          f.path,
          f.mtime,
          f.size,
          f.ctime,
          f.changed ?? null,
          f.fileId,
          f.indexedAt,
          f.note === null ? 0 : 1,
          n?.hash ?? null,
          state,
          state === FM.parsed ? JSON.stringify(n!.parse!.ordered) : null,
          n?.parse?.bodyStart ?? null,
          n ? JSON.stringify(n.tags) : null,
          n ? JSON.stringify(n.links) : null,
          f.links ? JSON.stringify(f.links.resolved) : null,
          f.links ? JSON.stringify(f.links.unresolved) : null,
        );
      }
      for (const [p, t] of b.texts) {
        this.putText.run(p, t.hash, pack(t.text));
        if (this.searchable) {
          this.indexText(p, t.text);
          indexed.push(p);
        }
      }
      for (const s of b.updates) {
        this.update.run(s.mtime, s.size, s.ctime, s.changed ?? null, s.fileId, s.indexedAt, s.links ? JSON.stringify(s.links.resolved) : null, s.links ? JSON.stringify(s.links.unresolved) : null, s.path);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.applyPathChanges(false);
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // rolled back with the error
      }
      throw e;
    }
    this.applyPathChanges(true);
    return indexed;
  }

  /** Leave the damage mark next to the file (best effort): the next {@link open} rebuilds the index. */
  markDamaged(reason: string): void {
    try {
      fs.writeFileSync(path.join(path.dirname(this.file), DAMAGED_FILE), reason);
    } catch {
      // a folder gone or read-only: the next start finds the damage again
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // a queued slice never runs on a closed connection
    this.endWarm();
    try {
      this.db.close(); // the last connection: SQLite folds the write-ahead log into the file
    } catch (e) {
      telemetry().log("WARN", "datanotes could not close the vault index", { file: this.file, error: messageOf(e) });
    }
  }
}

/** A reason to delete the file and create it again. */
class Rebuild extends Error {}

/** A folder's real path (as the file system spells it), or the path when it cannot be resolved. */
function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** A file's text, or null when it cannot be read (none there). */
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Delete the index files (the database, its write-ahead log, the damage mark); false when one cannot be deleted. */
function removeIndex(dir: string): boolean {
  try {
    for (const f of [INDEX_FILE, `${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`, DAMAGED_FILE]) fs.rmSync(path.join(dir, f), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Delete a store's index (the setting `vaultIndexEnabled` turned off): best effort. */
export function removeVaultIndex(store: string): void {
  removeIndex(path.join(store, "index"));
}

function readFiles(db: Database): Map<string, FileRecord> {
  const out = new Map<string, FileRecord>();
  for (const r of db.prepare("SELECT * FROM files").all()) {
    const p = String(r.path);
    out.set(p, {
      path: p,
      mtime: Number(r.mtime),
      size: Number(r.size),
      ctime: Number(r.ctime),
      changed: r.changed == null ? null : Number(r.changed),
      fileId: r.file_id == null ? null : String(r.file_id),
      indexedAt: Number(r.indexed_at),
      note: Number(r.note) === 0 ? null : noteOf(r),
      links: r.resolved == null ? null : { resolved: JSON.parse(String(r.resolved)) as Record<string, number>, unresolved: JSON.parse(String(r.unresolved)) as Record<string, number> },
    });
  }
  return out;
}

function noteOf(r: Record<string, unknown>): NoteRecord | undefined {
  const state = Number(r.fm_state);
  if (state === FM.unknown) return undefined;
  const base = { hash: String(r.hash), tags: JSON.parse(String(r.tags)) as string[], links: JSON.parse(String(r.links)) as [string, string][] };
  if (state === FM.unreadable) return { ...base, parse: null };
  return { ...base, parse: { ordered: JSON.parse(String(r.fm)) as OrderedFrontmatter, bodyStart: Number(r.body_start) } };
}

/** What one write of the index changes, in order: moves and deletes, then whole records, texts, and the stats and links of recorded notes. */
export interface IndexBatch {
  /** A file moved (`to`) or gone (`to` null). */
  ops: { from: string; to: string | null }[];
  /** Whole records: a note's (`note`) or another file's (`note` null). */
  files: (Omit<FileRecord, "note" | "changed"> & { note: NoteRecord | null; changed?: number | null })[];
  texts: Map<string, { hash: string; text: string }>;
  updates: { path: string; mtime: number; size: number; ctime: number; changed?: number | null; fileId: string | null; indexedAt: number; links: NoteLinks | null }[];
}

/** What the keeper asks the host for when it writes. */
export interface IndexSource {
  /** The stat of a file of the vault now (null: no such file). */
  stat(p: string): { mtime: number; size: number; ctime: number; changed?: number } | null;
  /** Whether the path is a Markdown note's. */
  isNote(p: string): boolean;
  /** Where a note's links lead now (null: not resolved). */
  links(p: string): NoteLinks | null;
  /** The id of a file on disk now (null: unknown). */
  fileId(p: string): string | null;
  /** Nothing is left to write (after a write, or a release with nothing to write): the host may let go of what it kept for the writes. */
  written?(): void;
}

/**
 * Keeps the index in step with the host, in the background: the host tells it what changed (a
 * note read, a file's stat, a note's links, a file moved or gone), and it writes all of it in a
 * transaction at most every {@link FLUSH_MS}, and at stop. A note written less than
 * {@link RACY_MS} ago waits until it is older (recorded now, the next start would read it again).
 * Until written, the texts of the notes read are served from memory ({@link textOf}). It also
 * answers which notes a search must read ({@link searchCandidates}).
 */
export class IndexKeeper {
  private ops: { from: string; to: string | null }[] = [];
  private notes = new Map<string, { note: NoteRecord; text: string }>();
  /**
   * The notes the search table may not hold as they are now: read and not written yet (every key
   * of `notes` is here), or moved and not written yet. A search reads them whatever the table says.
   * Kept only with a search table.
   */
  private uncovered = new Set<string>();
  private touched = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Off for the rest of the run after an error of SQLite. */
  private failed = false;
  private closed = false;
  /** Writes wait for {@link release} (the service's start: the engine listens first). */
  private held = false;
  /** Transactions written (tests, the log). */
  writes = 0;
  private afterStarted = false;
  private checkDelay: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private checking: Promise<void> | null = null;
  private checkDone: (() => void) | null = null;
  /** Tables SQLite's check read (tests). */
  checked = 0;

  constructor(
    readonly db: IndexDb,
    private readonly host: IndexSource,
    private readonly now: () => number = Date.now,
  ) {}

  /** A note read (its record and its text): written whole. */
  noteRead(p: string, note: NoteRecord, text: string): void {
    this.notes.set(p, { note, text });
    if (this.db.searchable) this.uncovered.add(p);
    this.touch(p);
  }

  /** A file whose stat or links may have changed. */
  touch(p: string): void {
    this.touched.add(p);
    this.soon(FLUSH_MS);
  }

  /** A file gone. */
  deleted(p: string): void {
    this.notes.delete(p);
    this.touched.delete(p);
    this.uncovered.delete(p);
    this.ops.push({ from: p, to: null });
    this.soon(FLUSH_MS);
  }

  /** A file moved: its record moves with it. */
  renamed(from: string, to: string): void {
    const n = this.notes.get(from);
    this.notes.delete(from);
    if (n) this.notes.set(to, n);
    this.touched.delete(from);
    this.uncovered.delete(from);
    if (this.db.searchable) this.uncovered.add(to);
    this.ops.push({ from, to });
    this.touch(to);
  }

  /** The text of a note read but not written yet, when it has this hash; else the index's. */
  textOf(p: string, hash: string): string | undefined {
    if (this.failed) return undefined;
    const n = this.notes.get(p);
    if (n && n.note.hash === hash) return n.text;
    try {
      return this.db.text(p, hash);
    } catch (e) {
      this.fail(e);
      return undefined;
    }
  }

  /**
   * The notes that can have every one of `words` (folded, each of three code points or more):
   * `hits`, whose search row has their trigrams, and `unsure`, the notes the table may not hold as
   * they are now. Null when the index cannot answer: no search table, off after an error, closed,
   * or words without a trigram. An error of SQLite turns the index off (as textOf).
   */
  searchCandidates(words: readonly string[]): { hits: string[]; unsure: string[] } | null {
    if (this.failed || this.closed || !this.db.searchable) return null;
    try {
      const hits = this.db.searchHits(words);
      return hits === null ? null : { hits, unsure: [...this.uncovered] };
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** Write nothing in the background until {@link release} (an explicit {@link flush} still writes). */
  hold(): void {
    this.held = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Write in the background again, starting with what waited. */
  release(): void {
    this.held = false;
    if (this.ops.length > 0 || this.touched.size > 0) this.soon(FLUSH_MS);
    // nothing to write: the host may let go of what it kept for the writes (the walk's file ids)
    else this.host.written?.();
  }

  private soon(ms: number): void {
    if (this.failed || this.closed || this.held || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
    this.timer.unref?.();
  }

  /**
   * Write what changed (a slice of {@link FLUSH_FILES} files or {@link FLUSH_TEXTS} texts per
   * transaction; the rest soon after). `all`: also the notes written less than {@link RACY_MS} ago, and everything left (the
   * engine stops).
   */
  flush(all = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.failed) return;
    const at = this.now();
    const batch: IndexBatch = { ops: this.ops, files: [], texts: new Map(), updates: [] };
    this.ops = [];
    const later = new Set<string>();
    let n = 0;
    const full = () => n >= FLUSH_FILES || batch.texts.size >= FLUSH_TEXTS;
    for (const p of this.touched) {
      if (!all && full()) {
        later.add(p);
        continue;
      }
      const st = this.host.stat(p);
      if (!st) continue; // gone since: its delete is in the ops
      if (!all && st.mtime > at - RACY_MS) {
        later.add(p); // recorded now, the next start would read it again
        continue;
      }
      n++;
      const pending = this.notes.get(p);
      this.notes.delete(p);
      const fileId = this.host.fileId(p);
      if (!this.host.isNote(p)) batch.files.push({ path: p, ...st, fileId, indexedAt: at, note: null, links: null });
      else if (pending) {
        batch.files.push({ path: p, ...st, fileId, indexedAt: at, note: pending.note, links: this.host.links(p) });
        batch.texts.set(p, { hash: pending.note.hash, text: pending.text });
      } else batch.updates.push({ path: p, ...st, fileId, indexedAt: at, links: this.host.links(p) });
    }
    this.touched = later;
    if (batch.ops.length > 0 || n > 0) {
      try {
        const indexed = this.db.write(batch, later.size === 0);
        // a note whose newer text still waits (written within RACY_MS) stays uncovered
        for (const p of indexed) if (!this.notes.has(p)) this.uncovered.delete(p);
        this.writes++;
        if (later.size === 0) this.host.written?.();
      } catch (e) {
        this.fail(e);
        return;
      }
    }
    if (later.size > 0) this.soon(full() ? SLICE_PAUSE_MS : RACY_MS);
  }

  /**
   * An error of SQLite: the index is off for the rest of the run. It keeps what the last write
   * left, a consistent state of the vault then (each write is one transaction): the next start
   * reads the notes changed since, as after a crash; one SQLite says is damaged is rebuilt then.
   */
  private fail(e: unknown): void {
    if (this.failed) return;
    this.failed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    telemetry().log("WARN", "datanotes vault index failed: off until the next start", { file: this.db.file, error: messageOf(e) });
    // no search reads the index any more: a warm-up under way would read for nothing
    this.db.endWarmup();
    if (damaged(e)) this.db.markDamaged(messageOf(e));
  }

  /** The search's row ids read in slices ({@link IndexDb.warmSearchPaths}); an error of SQLite turns the index off. */
  warmSearch(): Promise<void> {
    if (this.failed || this.closed || !this.db.searchable) return Promise.resolve();
    return this.db.warmSearchPaths().catch((e: unknown) => this.fail(e));
  }

  /**
   * SQLite's quick check of the file, one table per slice, {@link INDEX_CHECK}.pauseMs apart (the
   * engine answers in between). A problem found turns the index off for the run and leaves the
   * damage mark (as any error of SQLite that says the file is damaged): the next start rebuilds it.
   * Resolves once every table is read, or the index is off or closed; a second call answers the same promise.
   */
  checkIndex(): Promise<void> {
    if (this.checking) return this.checking;
    if (this.failed || this.closed) return Promise.resolve();
    let tables: string[];
    try {
      tables = this.db.checkTables();
    } catch (e) {
      this.fail(e);
      return Promise.resolve();
    }
    let i = 0;
    const step = (): void => {
      this.checkTimer = null;
      if (this.failed || this.closed || i >= tables.length) return this.endCheck();
      const table = tables[i++]!;
      try {
        const problems = this.db.quickCheck(table);
        this.checked++;
        if (problems.length > 0) this.fail(Object.assign(new Error(`SQLite's check of the table ${table} found damage: ${problems.slice(0, 3).join("; ")}`), { errcode: 11 }));
      } catch (e) {
        this.fail(e);
      }
      this.checkTimer = setTimeout(step, INDEX_CHECK.pauseMs);
      this.checkTimer.unref?.();
    };
    this.checking = new Promise<void>((resolve) => (this.checkDone = resolve));
    this.checkTimer = setTimeout(step, 0);
    this.checkTimer.unref?.();
    return this.checking;
  }

  /** The check over: its timer cleared, its promise resolved. */
  private endCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    this.checking = null;
    const done = this.checkDone;
    this.checkDone = null;
    done?.();
  }

  /**
   * Once the engine answers (the service, after {@link release}): the search's row ids read in
   * slices ({@link warmSearch}), then, {@link INDEX_CHECK}.delayMs later, SQLite's check of the
   * file ({@link checkIndex}). Nothing waits for it; a stop ends it. A second call does nothing.
   */
  afterStart(): void {
    if (this.afterStarted) return;
    this.afterStarted = true;
    void this.warmSearch().then(() => {
      if (this.failed || this.closed) return;
      this.checkDelay = setTimeout(() => {
        this.checkDelay = null;
        void this.checkIndex();
      }, INDEX_CHECK.delayMs);
      this.checkDelay.unref?.();
    });
  }

  /** Whether an error turned the index off for this run. */
  get off(): boolean {
    return this.failed;
  }

  /** Write everything left and close the file (the engine stops). */
  close(): void {
    if (this.closed) return;
    while (!this.failed && (this.ops.length > 0 || this.touched.size > 0)) this.flush(true);
    this.closed = true;
    if (this.checkDelay) clearTimeout(this.checkDelay);
    this.checkDelay = null;
    this.endCheck();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.db.close();
  }
}
