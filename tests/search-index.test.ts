/**
 * search_notes over the vault index on disk (an FTS5 trigram table): the same answers as a search
 * of every note, at start, after hand edits not yet written, after the writes, after moves and
 * deletes, after a restart; without FTS5 every note is read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchNotes, setSearchSource } from "../src/core/vault-read";
import { closeNodeHost, openNodeVaultAsync, type NodeHost } from "../src/node/node-app";
import { loadSqlite, SQLITE, type SqliteModule } from "../src/node/index-db";

const VERSION = "test";
const opened: NodeHost[] = [];
const load = SQLITE.load;
afterEach(() => {
  for (const h of opened.splice(0)) closeNodeHost(h);
  SQLITE.load = load;
  vi.restoreAllMocks();
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

function vaultWith(files: Record<string, string>): { root: string; store: string; write(rel: string, text: string): void; abs(rel: string): string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "search-index-"));
  const root = path.join(base, "vault");
  const store = path.join(base, "store");
  const abs = (rel: string) => path.join(root, ...rel.split("/"));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  return { root, store, write, abs };
}

/** Start a host on the vault with the index in the store; the index written at once. */
async function start(v: { root: string; store: string }): Promise<NodeHost> {
  const h = await openNodeVaultAsync(v.root, undefined, { index: { store: v.store, version: VERSION } });
  opened.push(h);
  h.index?.flush();
  return h;
}

async function stop(h: NodeHost): Promise<void> {
  opened.splice(opened.indexOf(h), 1);
  closeNodeHost(h);
}

/** Age every file past the racy window (as if written long ago). */
function aged(v: { root: string }, files: string[]): void {
  const past = Date.now() / 1000 - 3600;
  for (const f of files) fs.utimesSync(path.join(v.root, ...f.split("/")), past, past);
}

const PHRASES = ["Paris in spring", "a café downtown", "café latte to go", "한국어 lesson", "😀 report due", "budget review"];

/** 40 notes in three folders (accents whole and decomposed, Hangul, emoji, a NUL, a long note, a word only in a path) and an image. */
function notes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < 40; i++) {
    const folder = i < 20 ? "Notes" : i < 30 ? "Trips/Café de Flore" : "Archive";
    const name = i === 31 ? "Quokka n31" : `n${i}`;
    const words = [PHRASES[i % PHRASES.length]!, PHRASES[(i * 7) % PHRASES.length]!];
    if (i % 3 !== 2) words.push("common");
    if (i === 2) words.push("zephyrine wanders far from home, a long enough text to be paired when it moves");
    if (i === 5) words.push("a\u0000b paris");
    if (i === 7) words.push("long ".repeat(1200));
    out[`${folder}/${name}.md`] = `${i % 2 === 0 ? `---\ntitle: Note ${i}\n---\n` : ""}${words.join(". ")}\n`;
  }
  out["img.png"] = "paris";
  return out;
}

const QUERIES = ["paris", "cafe", "café latte", "한국어", "😀 report", "trips", "common", "nowhere", "ab", "pa", "a\u0000b", "common paris", "quokka", "zephyrine"];

/** search_notes as the engine answers it (through the index), and a search of every note. */
async function both(h: NodeHost, q: string) {
  const narrowed = await searchNotes(h.app, q, 20);
  setSearchSource(h.app, null);
  try {
    return { narrowed, full: await searchNotes(h.app, q, 20) };
  } finally {
    setSearchSource(h.app, { candidates: (w) => h.index!.searchCandidates(w) });
  }
}

async function allEqual(h: NodeHost, queries: readonly string[] = QUERIES): Promise<void> {
  for (const q of queries) {
    const r = await both(h, q);
    expect(r.narrowed, q).toEqual(r.full);
  }
}

describe("search_notes over the vault index", () => {
  it.skipIf(!FTS)("answers as a search of every note: at start, after hand edits, moves and deletes before and after they are written, and after a restart", async () => {
    const files = notes();
    const v = vaultWith(files);
    aged(v, Object.keys(files));
    let h = await start(v);
    const k = () => h.index!;
    expect(k().searchCandidates(["paris"])!.unsure).toEqual([]);
    await allEqual(h);
    expect(k().searchCandidates(["common"])!.hits.length).toBeLessThan(40);
    expect(k().searchCandidates(["quokka"])!.hits).toEqual(["Archive/Quokka n31.md"]);
    expect((await both(h, "paris")).narrowed.total).toBeGreaterThan(0);

    // a hand edit, within the racy window: not written yet
    v.write("Notes/n1.md", "Now about Lisbon and paris\n");
    h.vault.syncPaths(["Notes/n1.md"]);
    expect(k().searchCandidates(["lisbon"])!.unsure).toContain("Notes/n1.md");
    await allEqual(h, ["lisbon", ...QUERIES]);
    expect((await both(h, "lisbon")).narrowed.total).toBe(1);
    k().flush(true);
    expect(k().searchCandidates(["lisbon"])).toEqual({ hits: ["Notes/n1.md"], unsure: [] });
    await allEqual(h, ["lisbon", ...QUERIES]);

    // a hand move
    fs.mkdirSync(v.abs("Moved"));
    fs.renameSync(v.abs("Notes/n2.md"), v.abs("Moved/n2.md"));
    h.vault.syncPaths(["Notes/n2.md", "Moved/n2.md"]);
    await allEqual(h);
    k().flush(true);
    expect(k().searchCandidates(["zephyrine"])).toEqual({ hits: ["Moved/n2.md"], unsure: [] });
    expect(k().searchCandidates(["moved/"])!.hits).toEqual(["Moved/n2.md"]);
    await allEqual(h);

    // a hand delete
    fs.rmSync(v.abs("Notes/n3.md"));
    h.vault.syncPaths(["Notes/n3.md"]);
    await allEqual(h);
    k().flush(true);
    expect(k().searchCandidates(["common"])!.hits).not.toContain("Notes/n3.md");
    expect(k().searchCandidates(["n3.md"])!.hits).toEqual([]);
    await allEqual(h);

    // a restart
    await stop(h);
    h = await start(v);
    await allEqual(h, ["lisbon", ...QUERIES]);
    expect(k().searchCandidates(["lisbon"])!.hits).toEqual(["Notes/n1.md"]);
  });

  it("without FTS5, a search reads every note, with the same answers", async () => {
    withoutFts5();
    const files = notes();
    const v = vaultWith(files);
    aged(v, Object.keys(files));
    const h = await start(v);
    expect(h.index).not.toBeNull();
    expect(h.index!.searchCandidates(["paris"])).toBeNull();
    await allEqual(h);
  });

  it.skipIf(!FTS)("a query of short words only, or a word with a lone surrogate, is not looked up", async () => {
    const files = notes();
    const v = vaultWith(files);
    aged(v, Object.keys(files));
    const h = await start(v);
    const spy = vi.spyOn(h.index!, "searchCandidates");
    const answers = [await searchNotes(h.app, "ab pa", 20), await searchNotes(h.app, "pa\uD800ris", 20)];
    expect(spy).not.toHaveBeenCalled();
    setSearchSource(h.app, null);
    expect(answers).toEqual([await searchNotes(h.app, "ab pa", 20), await searchNotes(h.app, "pa\uD800ris", 20)]);
    await searchNotes(h.app, "paris");
    expect(spy).not.toHaveBeenCalled(); // no source: never asked
  });
});
