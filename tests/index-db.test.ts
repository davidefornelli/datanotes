/**
 * The vault index on disk at its edges (src/node/index-db.ts): loading node:sqlite without its
 * warning, a file recorded for another parser, the keeper's slices, its writes that fail, its
 * texts, and a close.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTelemetry } from "../src/core/telemetry";
import { DAMAGED_FILE, damaged, FLUSH_FILES, FLUSH_TEXTS, INDEX_CHECK, IndexDb, IndexKeeper, INDEX_FILE, loadSqlite, removeVaultIndex, SEARCH_GRAMS, SEARCH_PATHS_SLICE, SLICE_PAUSE_MS, SQLITE, type IndexSource, type NoteRecord, type SqliteModule } from "../src/node/index-db";

const load = SQLITE.load;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  SQLITE.load = load;
});

/** Whether this Node's SQLite has FTS5 with contentless_delete: the search table. */
function ftsHere(): boolean {
  const s = loadSqlite();
  if (!s) return false;
  const db = new s.DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'trigram case_sensitive 1', content = '', contentless_delete = 1, detail = none)");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
const FTS = ftsHere();

/** node:sqlite without FTS5 (as a Node built without it): SQLITE.load answers a wrapper. */
function withoutFts5(): void {
  const real = loadSqlite()!;
  SQLITE.load = () =>
    ({
      DatabaseSync: class {
        private readonly db: InstanceType<SqliteModule["DatabaseSync"]>;
        constructor(file: string) {
          this.db = new real.DatabaseSync(file);
        }
        exec(sql: string): void {
          if (/fts5/i.test(sql)) throw new Error("no such module: fts5");
          this.db.exec(sql);
        }
        prepare(sql: string) {
          return this.db.prepare(sql);
        }
        close(): void {
          this.db.close();
        }
      },
    }) as unknown as SqliteModule;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "index-db-"));
const NOTE: NoteRecord = { hash: "h1", parse: { ordered: [["k", "v"]], bodyStart: 10 }, tags: ["#t"], links: [["Other", ""]] };

/** A host of files `stats` (path → stat), all notes with links unless said, ids by path. */
function source(stats: Map<string, { mtime: number; size: number; ctime: number; changed?: number }>, o: { links?: boolean; ids?: boolean } = {}): IndexSource {
  return {
    stat: (p) => stats.get(p) ?? null,
    isNote: (p) => p.endsWith(".md"),
    links: () => (o.links === false ? null : { resolved: { "Other.md": 1 }, unresolved: {} }),
    fileId: (p) => (o.ids === false ? null : `1:${p.length}`),
  };
}

function open(store = tmp(), vault = tmp()) {
  const opened = IndexDb.open(store, { vault, version: "test" })!;
  return { ...opened, store, vault };
}

const OLD = { mtime: 1_000, size: 10, ctime: 1_000 };

/** What the search table names for a word, joined to search_rows on another connection: the truth the map must match. */
function joined(file: string, w: string): string[] {
  const db = new (loadSqlite()!).DatabaseSync(file);
  try {
    return db
      .prepare("SELECT r.path AS path FROM search JOIN search_rows r ON r.id = search.rowid WHERE search MATCH ?")
      .all(Array.from({ length: w.length - 2 }, (_, i) => `"${w.slice(i, i + 3)}"`).join(" AND "))
      .map((r) => String(r.path))
      .sort();
  } finally {
    db.close();
  }
}
const turn = () => new Promise((r) => setImmediate(r));
/** The warm-up's statement (private): tests count or break its reads. */
type PathsAfter = { all: (...a: unknown[]) => Record<string, unknown>[] };
const pathsAfterOf = (db: IndexDb) => db as unknown as { pathsAfter: PathsAfter };

describe("loading node:sqlite", () => {
  it("drops its experimental warning only, and is none where the module is missing or refused", () => {
    const real = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const warned: string[] = [];
    const emit = vi.spyOn(process, "emitWarning").mockImplementation(((w: string | Error) => void warned.push(typeof w === "string" ? w : w.message)) as never);
    const mod = { DatabaseSync: class {} };
    const builtin = vi.spyOn(process as never as { getBuiltinModule(id: string): unknown }, "getBuiltinModule").mockImplementation(() => {
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
      process.emitWarning(new Error("SQLite is old") as never);
      process.emitWarning("Something else", { type: "DeprecationWarning" } as never);
      return mod;
    });
    expect(loadSqlite()).toBe(mod);
    expect(warned).toEqual(["SQLite is old", "Something else"]);
    expect(process.emitWarning).toBe(emit); // restored
    builtin.mockImplementation(() => ({}));
    expect(loadSqlite()).toBeNull();
    builtin.mockImplementation(() => {
      throw new Error("No such built-in module: node:sqlite");
    });
    expect(loadSqlite()).toBeNull();
    builtin.mockRestore();
    expect(typeof real).toBe("function");
    expect(loadSqlite()).not.toBeNull();
  });
});

describe("the index file", () => {
  it("of another parser, or with a key of its record missing, is built anew; a vault path that cannot be resolved is taken as it is", () => {
    const o = open();
    o.db.close();
    const sqlite = SQLITE.load()!;
    const file = path.join(o.store, "index", INDEX_FILE);
    const raw = new sqlite.DatabaseSync(file);
    raw.exec("DELETE FROM meta WHERE key = 'parser'");
    raw.close();
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.db.rebuilt).toBe("another parser (none, now test/1)");
    again.db.close();
    const next = IndexDb.open(o.store, { vault: o.vault, version: "next" })!;
    expect(next.db.rebuilt).toBe("another parser (test/1, now next/1)");
    next.db.close();
    const missing = path.join(o.vault, "gone");
    const other = IndexDb.open(o.store, { vault: missing, version: "next" })!;
    expect(other.db.rebuilt).toBe(`another vault (${fs.realpathSync.native(o.vault)}, now ${path.resolve(missing)})`);
    other.db.close();
    other.db.close(); // closed once
  });

  it("a write that fails is taken back whole; a close that fails is a warning", () => {
    const o = open();
    const stats = new Map([["a.md", OLD]]);
    const k = new IndexKeeper(o.db, source(stats));
    k.noteRead("a.md", NOTE, "text of a");
    k.flush();
    const db = o.db as unknown as { put: { run(...a: unknown[]): unknown }; db: { close(): void } };
    const put = db.put;
    db.put = { run: () => { throw new Error("disk I/O error"); } };
    expect(() => o.db.write({ ops: [{ from: "a.md", to: null }], files: [{ path: "b.md", ...OLD, fileId: null, indexedAt: 5_000, note: NOTE, links: null }], texts: new Map(), updates: [] }, true)).toThrow("disk I/O error");
    db.put = put;
    expect(o.db.text("a.md", "h1")).toBe("text of a"); // the delete was taken back
    const logs: string[] = [];
    setTelemetry({ log: (_s, body) => void logs.push(body), flush: async () => {} });
    const close = db.db.close.bind(db.db);
    db.db.close = () => {
      close();
      throw new Error("busy");
    };
    o.db.close();
    expect(logs).toEqual(["datanotes could not close the vault index"]);
  });
});

describe("the keeper", () => {
  it("writes a long list a slice at a time, the engine answering in between; a file gone meanwhile is left out", async () => {
    vi.useFakeTimers();
    const o = open();
    const stats = new Map<string, { mtime: number; size: number; ctime: number }>();
    for (let i = 0; i <= FLUSH_FILES; i++) stats.set(`n${i}.png`, OLD);
    const k = new IndexKeeper(o.db, source(stats, { ids: false }), () => 10_000);
    for (const p of stats.keys()) k.touch(p);
    k.touch("gone.md"); // no stat: its delete is the host's to tell
    await vi.advanceTimersByTimeAsync(200);
    expect(k.writes).toBe(1);
    await vi.advanceTimersByTimeAsync(SLICE_PAUSE_MS);
    expect(k.writes).toBe(2);
    k.close();
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.files.size).toBe(FLUSH_FILES + 1);
    expect(again.files.get("n0.png")).toMatchObject({ fileId: null, note: null, links: null });
    expect(again.links).toBe(true);
    again.db.close();
  });

  it("serves the texts of notes not written yet, then the index's; a note without links is recorded without them", () => {
    const o = open();
    const stats = new Map([["a.md", OLD], ["b.md", OLD]]);
    const k = new IndexKeeper(o.db, source(stats, { links: false }), () => 10_000);
    k.noteRead("a.md", NOTE, "text of a");
    expect([k.textOf("a.md", "h1"), k.textOf("a.md", "other"), k.textOf("c.md", "h1")]).toEqual(["text of a", undefined, undefined]);
    k.flush();
    expect(k.textOf("a.md", "h1")).toBe("text of a");
    k.touch("a.md"); // its stat and links again: none
    k.flush();
    k.close();
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.files.get("a.md")).toMatchObject({ note: NOTE, links: null });
    again.db.close();
  });

  it("an error of SQLite turns it off: nothing more is written or served, the next error says nothing", () => {
    vi.useFakeTimers();
    const o = open();
    const logs: string[] = [];
    setTelemetry({ log: (_s, body) => void logs.push(body), flush: async () => {} });
    const k = new IndexKeeper(o.db, source(new Map([["a.md", OLD]])), () => 10_000);
    k.touch("a.md"); // a write is scheduled
    vi.spyOn(o.db, "text").mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    expect(k.textOf("a.md", "h1")).toBeUndefined();
    expect(k.off).toBe(true);
    vi.spyOn(o.db, "write");
    k.flush();
    expect(o.db.write).not.toHaveBeenCalled();
    expect(k.textOf("a.md", "h1")).toBeUndefined();
    k.touch("a.md");
    (k as unknown as { fail(e: unknown): void }).fail(new Error("again"));
    expect(logs).toEqual(["datanotes vault index failed: off until the next start"]);
    k.close();
    k.close();
  });

  it("closes with a write under way scheduled: everything left is written first", () => {
    vi.useFakeTimers();
    const o = open();
    const stats = new Map([["a.md", { mtime: 9_500, size: 1, ctime: 9_500 }]]);
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    k.noteRead("a.md", NOTE, "text");
    k.flush(); // written 0.5 s ago: waits until it is older
    expect(k.writes).toBe(0);
    k.close();
    expect(k.writes).toBe(1);
    k.touch("a.md"); // after the close: nothing scheduled
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.files.get("a.md")?.indexedAt).toBe(10_000);
    again.db.close();
  });
});

describe("a damaged index", () => {
  const malformed = () => Object.assign(new Error("database disk image is malformed"), { errcode: 11 });

  it("tells a damaged file by SQLite's code or message", () => {
    const errors = [{ errcode: 11 }, { errcode: 267 }, { errcode: 26 }, { errcode: 10 }, new Error("database disk image is malformed"), new Error("disk I/O error"), null];
    expect(errors.map(damaged)).toEqual([true, true, true, false, true, false, false]);
  });

  it("an error of SQLite that says the file is damaged leaves a mark: the next open rebuilds the index; another error leaves none", () => {
    setTelemetry({ log: () => {}, flush: async () => {} });
    const o = open();
    const k = new IndexKeeper(o.db, source(new Map([["a.md", OLD]])), () => 10_000);
    vi.spyOn(o.db, "text").mockImplementation(() => {
      throw malformed();
    });
    expect(k.textOf("a.md", "h1")).toBeUndefined();
    k.close();
    const mark = path.join(o.store, "index", DAMAGED_FILE);
    expect(fs.readFileSync(mark, "utf8")).toBe("database disk image is malformed");
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.db.rebuilt).toBe("the last run found it damaged (database disk image is malformed)");
    expect(fs.existsSync(mark)).toBe(false);
    again.db.close();
    // another error: off for the run, no mark, the next open uses the file
    const p = open();
    const k2 = new IndexKeeper(p.db, source(new Map([["a.md", OLD]])), () => 10_000);
    vi.spyOn(p.db, "write").mockImplementation(() => {
      throw Object.assign(new Error("disk I/O error"), { errcode: 10 });
    });
    k2.touch("a.md");
    k2.flush(true);
    expect(k2.off).toBe(true);
    k2.close();
    expect(fs.existsSync(path.join(p.store, "index", DAMAGED_FILE))).toBe(false);
    const reopened = IndexDb.open(p.store, { vault: p.vault, version: "test" })!;
    expect(reopened.db.rebuilt).toBeNull();
    reopened.db.close();
  });

  it("a mark left where the folder is gone is no error: the next start finds the damage again", () => {
    const o = open();
    o.db.close();
    fs.rmSync(path.join(o.store, "index"), { recursive: true });
    o.db.markDamaged("database disk image is malformed");
    expect(fs.existsSync(path.join(o.store, "index", DAMAGED_FILE))).toBe(false);
  });

  it("a mark that cannot be deleted with the index: none, every note read", () => {
    const store = tmp();
    const dir = path.join(store, "index");
    fs.mkdirSync(path.join(dir, INDEX_FILE), { recursive: true });
    fs.writeFileSync(path.join(dir, INDEX_FILE, "held"), "x");
    fs.writeFileSync(path.join(dir, DAMAGED_FILE), "database disk image is malformed");
    const logs: { body: string; attributes?: Record<string, unknown> }[] = [];
    setTelemetry({ log: (_s, body, attributes) => void logs.push({ body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
    expect(IndexDb.open(store, { vault: tmp(), version: "test" })).toBeNull();
    expect(logs).toEqual([{ body: "datanotes could not open the vault index: every note is read at start", attributes: { file: path.join(dir, INDEX_FILE), error: `${DAMAGED_FILE}: the damaged index cannot be deleted` } }]);
  });

  it("the mark goes when the index is turned off", () => {
    const o = open();
    o.db.close();
    const mark = path.join(o.store, "index", DAMAGED_FILE);
    fs.writeFileSync(mark, "database disk image is malformed");
    removeVaultIndex(o.store);
    expect(fs.existsSync(mark)).toBe(false);
  });
});

describe("the change time", () => {
  it("records each file's change time: none when the host has none; an update writes the new one", () => {
    const o = open();
    const stats = new Map<string, { mtime: number; size: number; ctime: number; changed?: number }>([
      ["a.md", { ...OLD, changed: 1234.5 }],
      ["b.md", OLD],
    ]);
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    k.noteRead("a.md", NOTE, "text of a");
    k.noteRead("b.md", NOTE, "text of b");
    k.close();
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect([again.files.get("a.md")?.changed, again.files.get("b.md")?.changed]).toEqual([1234.5, null]);
    stats.set("a.md", { ...OLD, changed: 2000 });
    const k2 = new IndexKeeper(again.db, source(stats), () => 10_000);
    k2.touch("a.md"); // a recorded note: its stat updated
    k2.close();
    const third = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(third.files.get("a.md")).toMatchObject({ changed: 2000, note: NOTE });
    third.db.close();
  });
});

describe.skipIf(!FTS)("the search table", () => {
  it("names the notes that have every trigram of the words, by their path too; a note read and not written yet is unsure", () => {
    const o = open();
    const stats = new Map([["Trips/Paris.md", OLD], ["b.md", OLD]]);
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    expect(o.db.searchable).toBe(true);
    k.noteRead("Trips/Paris.md", NOTE, "Dinner at a café in spring");
    k.noteRead("b.md", { ...NOTE, hash: "h2" }, "Rome in spring 😀😀😀");
    expect(k.searchCandidates(["spring"])).toEqual({ hits: [], unsure: ["Trips/Paris.md", "b.md"] });
    k.flush();
    const hits = (w: string[]) => k.searchCandidates(w)!.hits.sort();
    expect(k.searchCandidates(["spring"])!.unsure).toEqual([]);
    expect(hits(["spring"])).toEqual(["Trips/Paris.md", "b.md"]);
    expect(hits(["cafe"])).toEqual(["Trips/Paris.md"]); // folded
    expect(hits(["trips/"])).toEqual(["Trips/Paris.md"]); // the path
    expect(hits(["😀😀😀"])).toEqual(["b.md"]);
    expect(hits(["spring", "rome"])).toEqual(["b.md"]);
    expect(hits(["lisbon"])).toEqual([]);
    expect(k.searchCandidates(["ab"])).toBeNull(); // no trigram
    k.close();
    expect(k.searchCandidates(["spring"])).toBeNull(); // closed
  });

  it("follows moves and deletes", () => {
    const o = open();
    const stats = new Map([["a.md", OLD]]);
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    const hits = (w: string[]) => k.searchCandidates(w)!.hits.sort();
    k.noteRead("a.md", NOTE, "about lisbon");
    k.flush();
    stats.set("x/y.md", OLD);
    stats.delete("a.md");
    k.renamed("a.md", "x/y.md");
    expect(k.searchCandidates(["lisbon"])).toEqual({ hits: ["a.md"], unsure: ["x/y.md"] });
    k.flush();
    expect(k.searchCandidates(["lisbon"])).toEqual({ hits: ["x/y.md"], unsure: [] });
    expect(hits(["x/y"])).toEqual(["x/y.md"]);
    expect(hits(["a.md"])).toEqual([]); // the old name went with its row
    k.deleted("x/y.md");
    stats.delete("x/y.md");
    k.flush();
    expect(k.searchCandidates(["lisbon"])).toEqual({ hits: [], unsure: [] });
    k.close();
  });

  it("a note moved over another one takes its place in the table; a note read again replaces its row", () => {
    const o = open();
    const stats = new Map([["a.md", OLD], ["b.md", OLD]]);
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    const hits = (w: string[]) => k.searchCandidates(w)!.hits.sort();
    k.noteRead("a.md", NOTE, "words of alpha");
    k.noteRead("b.md", { ...NOTE, hash: "h2" }, "words of bravo");
    k.flush();
    stats.delete("a.md");
    k.renamed("a.md", "b.md"); // b.md replaced by a's file
    k.flush();
    expect(hits(["words"])).toEqual(["b.md"]);
    expect(hits(["alpha"])).toEqual(["b.md"]);
    expect(hits(["bravo"])).toEqual([]);
    k.noteRead("b.md", { ...NOTE, hash: "h3" }, "words of charlie");
    k.flush();
    expect(hits(["alpha"])).toEqual([]);
    expect(hits(["charlie"])).toEqual(["b.md"]);
    k.close();
  });

  it("a note moved and edited within the racy window stays unsure until its new text is written", () => {
    const o = open();
    const now = { t: 10_000 };
    const stats = new Map([["a.md", OLD]]);
    const k = new IndexKeeper(o.db, source(stats), () => now.t);
    k.noteRead("a.md", NOTE, "old words lisbon");
    k.flush();
    stats.set("b.md", { mtime: 9_500, size: 10, ctime: 1_000 });
    stats.delete("a.md");
    k.renamed("a.md", "b.md");
    k.noteRead("b.md", { ...NOTE, hash: "h2" }, "new words porto");
    k.flush(); // the move is written, the text waits
    expect(k.writes).toBe(2);
    expect(k.searchCandidates(["porto"])!.unsure).toEqual(["b.md"]);
    expect(k.searchCandidates(["lisbon"])).toEqual({ hits: ["b.md"], unsure: ["b.md"] }); // the old text under the new path
    now.t = 20_000;
    k.flush();
    expect(k.searchCandidates(["porto"])).toEqual({ hits: ["b.md"], unsure: [] });
    expect(k.searchCandidates(["lisbon"])!.hits).toEqual([]);
    k.close();
  });

  it("writes at most FLUSH_TEXTS texts a transaction", async () => {
    vi.useFakeTimers();
    const o = open();
    const stats = new Map<string, { mtime: number; size: number; ctime: number }>();
    for (let i = 0; i <= FLUSH_TEXTS; i++) stats.set(`n${i}.md`, OLD);
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    let i = 0;
    for (const p of stats.keys()) k.noteRead(p, { ...NOTE, hash: `h${i}` }, `text ${i++}`);
    await vi.advanceTimersByTimeAsync(200);
    expect(k.writes).toBe(1);
    expect(k.searchCandidates(["text"])!.unsure).toEqual([`n${FLUSH_TEXTS}.md`]);
    await vi.advanceTimersByTimeAsync(SLICE_PAUSE_MS);
    expect(k.writes).toBe(2);
    expect(k.searchCandidates(["text"])).toMatchObject({ unsure: [] });
    expect(k.searchCandidates(["text"])!.hits.length).toBe(FLUSH_TEXTS + 1);
    k.close();
  });

  it("a word longer than SEARCH_GRAMS trigrams is looked up by its first ones; a quote is a character like any other", () => {
    expect(SEARCH_GRAMS).toBe(64);
    const o = open();
    const stats = new Map([["a.md", OLD], ["b.md", OLD], ["c.md", OLD]]);
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    const w = Array.from({ length: 80 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
    k.noteRead("a.md", NOTE, w);
    k.noteRead("b.md", { ...NOTE, hash: "h2" }, w.slice(0, 70));
    k.noteRead("c.md", { ...NOTE, hash: "h3" }, w.slice(10));
    k.flush();
    expect(k.searchCandidates([w])!.hits.sort()).toEqual(["a.md", "b.md"]);
    k.noteRead("a.md", { ...NOTE, hash: "h4" }, 'say "hi" now');
    k.flush();
    expect(k.searchCandidates(['"hi"'])!.hits).toEqual(["a.md"]);
    k.close();
  });

  it("answers the paths the join of search_rows names, its id-to-path map kept in step with writes, moves, deletes, a failed write and a reopen", () => {
    const o = open();
    const stats = new Map<string, { mtime: number; size: number; ctime: number }>();
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    const sqlite = loadSqlite()!;
    /** What the search table names, joined to search_rows on another connection. */
    const joined = (file: string, w: string) => {
      const db = new sqlite.DatabaseSync(file);
      try {
        return db.prepare("SELECT r.path AS path FROM search JOIN search_rows r ON r.id = search.rowid WHERE search MATCH ?").all(Array.from({ length: w.length - 2 }, (_, i) => `"${w.slice(i, i + 3)}"`).join(" AND ")).map((r) => String(r.path)).sort();
      } finally {
        db.close();
      }
    };
    const same = (db: IndexDb, w: string) => expect(db.searchHits([w])!.slice().sort()).toEqual(joined(db.file, w));
    // before the first search: the writes need no map
    for (let i = 0; i < 6; i++) {
      stats.set(`n${i}.md`, OLD);
      k.noteRead(`n${i}.md`, { ...NOTE, hash: `h${i}` }, `common words ${i % 2 ? "odd" : "even"}`);
    }
    k.flush();
    same(o.db, "common");
    // the map read: every change from here on follows it
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    for (let step = 0; step < 60; step++) {
      const paths = [...stats.keys()];
      const pick = paths[rnd(paths.length)]!;
      const r = rnd(4);
      if (r === 0 || paths.length < 3) {
        const p = `n${10 + step}.md`;
        stats.set(p, OLD);
        k.noteRead(p, { ...NOTE, hash: `x${step}` }, `common words ${step % 2 ? "odd" : "even"}`);
      } else if (r === 1) {
        stats.delete(pick);
        k.deleted(pick);
      } else if (r === 2) {
        const to = `m/${step}.md`;
        stats.set(to, stats.get(pick)!);
        stats.delete(pick);
        k.renamed(pick, to);
      } else k.noteRead(pick, { ...NOTE, hash: `y${step}` }, `common words ${step % 3 ? "odd" : "even"}`);
      if (step % 5 === 4) {
        k.flush();
        for (const w of ["common", "odd", "even", "m/1"]) same(o.db, w);
      }
    }
    k.flush();
    // a write that fails: its changes to the map are dropped with the rollback
    const before = o.db.searchHits(["common"])!.slice().sort();
    const db = o.db as unknown as { put: { run(...a: unknown[]): unknown } };
    const put = db.put;
    db.put = { run: () => { throw new Error("disk I/O error"); } };
    const gone = [...stats.keys()][0]!;
    expect(() => o.db.write({ ops: [{ from: gone, to: null }], files: [{ path: "z.md", ...OLD, fileId: null, indexedAt: 5_000, note: NOTE, links: null }], texts: new Map([["w.md", { hash: "w", text: "common" }]]), updates: [] }, true)).toThrow("disk I/O error");
    db.put = put;
    expect(o.db.searchHits(["common"])!.slice().sort()).toEqual(before);
    same(o.db, "common");
    k.close();
    // reopened: the map read again from the file
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.db.searchHits(["common"])!.slice().sort()).toEqual(before);
    same(again.db, "odd");
    again.db.close();
  });

  it("an error of SQLite in a search turns the index off and leaves the damage mark", () => {
    setTelemetry({ log: () => {}, flush: async () => {} });
    const o = open();
    const k = new IndexKeeper(o.db, source(new Map([["a.md", OLD]])), () => 10_000);
    vi.spyOn(o.db, "searchHits").mockImplementation(() => {
      throw Object.assign(new Error("database disk image is malformed"), { errcode: 11 });
    });
    expect(k.searchCandidates(["paris"])).toBeNull();
    expect(k.off).toBe(true);
    expect(k.searchCandidates(["paris"])).toBeNull();
    k.close();
    expect(fs.existsSync(path.join(o.store, "index", DAMAGED_FILE))).toBe(true);
  });
});

describe.skipIf(!FTS)("the search's row ids, read after a start", () => {
  afterEach(() => {
    SEARCH_PATHS_SLICE.rows = 5000;
  });

  /** A keeper over notes n0.md ... n<count-1>.md, all written. */
  function notes(count: number) {
    const o = open();
    const stats = new Map<string, { mtime: number; size: number; ctime: number }>();
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    for (let i = 0; i < count; i++) {
      stats.set(`n${i}.md`, OLD);
      k.noteRead(`n${i}.md`, { ...NOTE, hash: `h${i}` }, `common words ${i}`);
    }
    k.flush();
    return { o, k, stats };
  }

  it("are read a slice per turn of the event loop; a search then reads no table", async () => {
    SEARCH_PATHS_SLICE.rows = 2;
    const { o, k } = notes(7);
    const warm = k.warmSearch();
    expect(o.db.warmSlices).toBe(0);
    await turn();
    expect(o.db.warmSlices).toBe(1);
    await warm;
    expect(o.db.warmSlices).toBe(4); // 2 + 2 + 2 + 1
    const db = pathsAfterOf(o.db);
    const real = db.pathsAfter;
    let reads = 0;
    db.pathsAfter = { all: (...a) => (reads++, real.all(...a)) };
    expect(o.db.searchHits(["common"])!.slice().sort()).toEqual(joined(o.db.file, "common"));
    expect(reads).toBe(0);
    await o.db.warmSearchPaths(); // read already: at once
    expect(o.db.warmSlices).toBe(4);
    expect(reads).toBe(0);
    db.pathsAfter = real;
    k.close();
  });

  it("keep up with writes between two slices; a search during the warm-up reads the rest at once", async () => {
    SEARCH_PATHS_SLICE.rows = 2;
    const { o, k, stats } = notes(6); // ids 1-6
    const warm = k.warmSearch();
    await turn(); // ids 1, 2 read
    expect(o.db.warmSlices).toBe(1);
    stats.delete("n0.md");
    k.deleted("n0.md"); // an id read already goes
    stats.set("m/5.md", stats.get("n5.md")!);
    stats.delete("n5.md");
    k.renamed("n5.md", "m/5.md"); // an id not read yet moves: a new id
    stats.set("n9.md", OLD);
    k.noteRead("n9.md", { ...NOTE, hash: "h9" }, "common words 9");
    k.flush();
    for (const w of ["common", "m/5"]) expect(o.db.searchHits([w])!.slice().sort()).toEqual(joined(o.db.file, w));
    await warm; // ended by the search
    const s = o.db.warmSlices;
    await turn();
    expect(o.db.warmSlices).toBe(s);
    stats.delete("n1.md");
    k.deleted("n1.md");
    stats.set("n10.md", OLD);
    k.noteRead("n10.md", { ...NOTE, hash: "h10" }, "common words 10");
    k.flush();
    expect(o.db.searchHits(["common"])!.slice().sort()).toEqual(joined(o.db.file, "common"));
    expect(o.db.searchHits(["common"])).toHaveLength(6);
    k.close();
  });

  it("end with the file's close", async () => {
    SEARCH_PATHS_SLICE.rows = 1;
    const { o } = notes(3);
    const warm = o.db.warmSearchPaths();
    expect(o.db.warmSearchPaths()).toBe(warm);
    o.db.close();
    await warm;
    expect(o.db.warmSlices).toBe(0);
    await turn();
    expect(o.db.warmSlices).toBe(0);
    await o.db.warmSearchPaths(); // closed: nothing to read
    expect(o.db.warmSlices).toBe(0);
  });

  it("end when another error turns the index off", async () => {
    setTelemetry({ log: () => {}, flush: async () => {} });
    SEARCH_PATHS_SLICE.rows = 1;
    const { o, k } = notes(4);
    const warm = k.warmSearch();
    await turn();
    expect(o.db.warmSlices).toBe(1);
    (k as unknown as { fail(e: unknown): void }).fail(new Error("disk I/O error"));
    expect(k.off).toBe(true);
    await warm;
    await turn();
    await turn();
    expect(o.db.warmSlices).toBe(1);
    k.close();
  });

  it("an error of SQLite while they are read rejects the warm-up; the keeper turns the index off and leaves the mark", async () => {
    setTelemetry({ log: () => {}, flush: async () => {} });
    const { o, k } = notes(2);
    const db = pathsAfterOf(o.db);
    const real = db.pathsAfter;
    db.pathsAfter = {
      all: () => {
        throw new Error("disk I/O error");
      },
    };
    await expect(o.db.warmSearchPaths()).rejects.toThrow("disk I/O error");
    db.pathsAfter = real;
    await o.db.warmSearchPaths(); // a later warm-up starts again and finishes
    expect(o.db.warmSlices).toBe(1);
    expect(o.db.searchHits(["common"])).toHaveLength(2);
    vi.spyOn(o.db, "warmSearchPaths").mockRejectedValue(Object.assign(new Error("database disk image is malformed"), { errcode: 11 }));
    await k.warmSearch();
    expect(k.off).toBe(true);
    await k.warmSearch(); // off: nothing
    k.close();
    expect(fs.existsSync(path.join(o.store, "index", DAMAGED_FILE))).toBe(true);
  });
});

describe("format 3", () => {
  it("without FTS5: no row ids to read after a start", async () => {
    withoutFts5();
    const o = open();
    const k = new IndexKeeper(o.db, source(new Map([["a.md", OLD]])), () => 10_000);
    await k.warmSearch();
    expect(o.db.warmSlices).toBe(0);
    await o.db.warmSearchPaths();
    expect(o.db.checkTables()).toEqual(["files", "meta", "search_rows", "texts"]);
    k.close();
  });

  it("without FTS5: no search table, no candidates; records and texts as before; a switch either way rebuilds the index", () => {
    withoutFts5();
    const o = open();
    expect(o.db.searchable).toBe(false);
    const k = new IndexKeeper(o.db, source(new Map([["a.md", OLD], ["b.md", OLD]])), () => 10_000);
    k.noteRead("a.md", NOTE, "text of a");
    k.noteRead("b.md", NOTE, "text of b");
    k.flush();
    k.renamed("b.md", "c.md");
    k.deleted("a.md");
    expect(k.searchCandidates(["text"])).toBeNull();
    expect(k.textOf("b.md", "h1")).toBe("text of b");
    k.close();
    SQLITE.load = load;
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    if (FTS) expect(again.db.rebuilt).toBe("another search (none, now fts5)");
    again.db.close();
    if (!FTS) return;
    withoutFts5();
    const third = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(third.db.rebuilt).toBe("another search (fts5, now none)");
    third.db.close();
  });

  it("stores the texts compressed and reads them back whole", () => {
    const o = open();
    const text = "Paris é😀\r\n".repeat(300);
    const k = new IndexKeeper(o.db, source(new Map([["a.md", OLD]])), () => 10_000);
    k.noteRead("a.md", NOTE, text);
    k.close();
    const raw = new (SQLITE.load()!).DatabaseSync(path.join(o.store, "index", INDEX_FILE));
    const row = raw.prepare("SELECT typeof(text) AS t, length(text) AS n FROM texts WHERE path = 'a.md'").get()!;
    raw.close();
    expect(row.t).toBe("blob");
    expect(Number(row.n)).toBeLessThan(Buffer.byteLength(text) / 2);
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.db.rebuilt).toBeNull();
    const k2 = new IndexKeeper(again.db, source(new Map([["a.md", OLD]])), () => 10_000);
    expect(k2.textOf("a.md", "h1")).toBe(text);
    k2.close();
  });

  it("a text that does not inflate turns the index off and leaves the damage mark", () => {
    setTelemetry({ log: () => {}, flush: async () => {} });
    const o = open();
    const k = new IndexKeeper(o.db, source(new Map([["a.md", OLD]])), () => 10_000);
    k.noteRead("a.md", NOTE, "text of a");
    k.close();
    const raw = new (SQLITE.load()!).DatabaseSync(path.join(o.store, "index", INDEX_FILE));
    raw.exec("UPDATE texts SET text = x'00ff00ff'");
    raw.close();
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    const k2 = new IndexKeeper(again.db, source(new Map([["a.md", OLD]])), () => 10_000);
    expect(k2.textOf("a.md", "h1")).toBeUndefined();
    expect(k2.off).toBe(true);
    k2.close();
    expect(fs.readFileSync(path.join(o.store, "index", DAMAGED_FILE), "utf8")).toMatch(/damaged text for a\.md/);
  });

  it("release with nothing to write tells the host the writes are done", () => {
    const o = open();
    const written = vi.fn();
    const k = new IndexKeeper(o.db, { ...source(new Map([["a.md", OLD]])), written }, () => 10_000);
    k.hold();
    k.release();
    expect(written).toHaveBeenCalledTimes(1);
    k.hold();
    k.touch("a.md");
    k.release();
    expect(written).toHaveBeenCalledTimes(1);
    k.flush();
    expect(written).toHaveBeenCalledTimes(2);
    k.close();
  });
});

describe("the check of the index after a start", () => {
  const TABLES = FTS ? ["files", "meta", "search_config", "search_data", "search_docsize", "search_idx", "search_rows", "texts"] : ["files", "meta", "search_rows", "texts"];
  afterEach(() => {
    INDEX_CHECK.delayMs = 30_000;
    INDEX_CHECK.pauseMs = 100;
  });

  /** A keeper over `count` notes with texts, all written. */
  function written(count = 1) {
    const o = open();
    const stats = new Map<string, { mtime: number; size: number; ctime: number }>();
    const k = new IndexKeeper(o.db, source(stats), () => 10_000);
    for (let i = 0; i < count; i++) {
      stats.set(`n${i}.md`, OLD);
      k.noteRead(`n${i}.md`, { ...NOTE, hash: `h${i}` }, `some text of note ${i} `.repeat(50));
    }
    k.flush();
    return { o, k, stats };
  }
  const marked = (store: string) => fs.existsSync(path.join(store, "index", DAMAGED_FILE));

  it("reads every table but the search table, one per pause, and finds a sound file sound", async () => {
    INDEX_CHECK.pauseMs = 1;
    const { o, k } = written();
    expect(o.db.checkTables()).toEqual(TABLES);
    const check = k.checkIndex();
    expect(k.checkIndex()).toBe(check);
    expect(k.checked).toBe(0);
    await check;
    expect(k.checked).toBe(TABLES.length);
    expect(k.off).toBe(false);
    k.close();
    expect(marked(o.store)).toBe(false);
    await k.checkIndex(); // closed
    expect(k.checked).toBe(TABLES.length);
  });

  it("a table SQLite reports damaged turns the index off and leaves the mark: the next open rebuilds it", async () => {
    INDEX_CHECK.pauseMs = 1;
    setTelemetry({ log: () => {}, flush: async () => {} });
    const { o, k } = written();
    vi.spyOn(o.db, "quickCheck").mockImplementation((t: string) => (t === "meta" ? ["*** in database main ***\nPage 3: btreeInitPage() returns error code 11"] : []));
    await k.checkIndex();
    expect(k.off).toBe(true);
    expect(k.checked).toBe(2); // files, then meta; no table after
    expect(fs.readFileSync(path.join(o.store, "index", DAMAGED_FILE), "utf8")).toContain("SQLite's check of the table meta found damage");
    await k.checkIndex(); // off: nothing
    expect(k.checked).toBe(2);
    k.close();
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.db.rebuilt).toMatch(/^the last run found it damaged/);
    again.db.close();
  });

  it("a page damaged on disk is found", async () => {
    INDEX_CHECK.pauseMs = 1;
    setTelemetry({ log: () => {}, flush: async () => {} });
    const { o, k, stats } = written(3);
    k.close(); // the last connection folds the write-ahead log into the file
    const file = path.join(o.store, "index", INDEX_FILE);
    const raw = new (loadSqlite()!).DatabaseSync(file);
    const root = Number(raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'texts'").get()!.rootpage);
    const size = Number(raw.prepare("PRAGMA page_size").get()!.page_size);
    raw.close();
    const fd = fs.openSync(file, "r+");
    fs.writeSync(fd, Buffer.alloc(size, 0xff), 0, size, (root - 1) * size); // a bad sector in the texts
    fs.closeSync(fd);
    const again = IndexDb.open(o.store, { vault: o.vault, version: "test" })!;
    expect(again.db.rebuilt).toBeNull(); // the open reads no text: unseen until the check
    const k2 = new IndexKeeper(again.db, source(stats), () => 10_000);
    await k2.checkIndex();
    expect(k2.off).toBe(true);
    k2.close();
    expect(marked(o.store)).toBe(true);
  });

  it("an error of SQLite in the check that is no damage turns the index off without a mark; so does one listing the tables", async () => {
    INDEX_CHECK.pauseMs = 1;
    setTelemetry({ log: () => {}, flush: async () => {} });
    const { o, k } = written();
    vi.spyOn(o.db, "quickCheck").mockImplementation(() => {
      throw new Error("database is locked");
    });
    await k.checkIndex();
    expect(k.off).toBe(true);
    expect(k.checked).toBe(0);
    k.close();
    expect(marked(o.store)).toBe(false);
    const b = written();
    vi.spyOn(b.o.db, "checkTables").mockImplementation(() => {
      throw new Error("database is locked");
    });
    await b.k.checkIndex();
    expect(b.k.off).toBe(true);
    expect(b.k.checked).toBe(0);
    b.k.close();
    expect(marked(b.o.store)).toBe(false);
  });

  it("after a start: the row ids, then the check once INDEX_CHECK.delayMs passed; a second call does nothing; a close stops what waits", async () => {
    INDEX_CHECK.delayMs = 5;
    INDEX_CHECK.pauseMs = 1;
    const a = written();
    a.k.afterStart();
    a.k.afterStart();
    await vi.waitFor(() => expect(a.k.checked).toBe(TABLES.length), { timeout: 2000, interval: 5 });
    if (FTS) expect(a.o.db.warmSlices).toBe(1);
    a.k.close();
    INDEX_CHECK.delayMs = 50;
    const b = written();
    b.k.afterStart();
    await b.k.warmSearch(); // the delay is armed after the warm-up
    await turn();
    b.k.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(b.k.checked).toBe(0);
    INDEX_CHECK.pauseMs = 30;
    const c = written();
    const check = c.k.checkIndex();
    await vi.waitFor(() => expect(c.k.checked).toBe(1), { timeout: 2000, interval: 5 });
    c.k.close();
    await check;
    expect(c.k.checked).toBe(1);
    // a keeper closed before the warm-up ends arms nothing
    const d = written();
    d.k.afterStart();
    d.k.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(d.k.checked).toBe(0);
  });

  it.skipIf(!FTS)("a warm-up that fails starts no check", async () => {
    INDEX_CHECK.delayMs = 1;
    setTelemetry({ log: () => {}, flush: async () => {} });
    const { o, k } = written();
    vi.spyOn(o.db, "warmSearchPaths").mockRejectedValue(new Error("disk I/O error"));
    k.afterStart();
    await new Promise((r) => setTimeout(r, 30));
    expect(k.off).toBe(true);
    expect(k.checked).toBe(0);
    k.close();
  });
});
