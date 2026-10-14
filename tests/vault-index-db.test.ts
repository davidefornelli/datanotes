/**
 * The vault index on disk (`<store>/index/vault.sqlite`): a start records what it read; the next
 * start reads only the notes whose stat changed, takes the others from the index, and ends with
 * the host in the state a start that reads every note gives. Hand edits, moves and deletes made
 * while the engine was stopped are found; an index deleted, unreadable, of another format or
 * another vault is rebuilt; without node:sqlite there is none.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "../src/core/host";
import { readHashed } from "../src/core/file-cache";
import { setTelemetry } from "../src/core/telemetry";
import { closeNodeHost, createNodeHost, indexNodeHost, INTERN_SLICE, openNodeVault, openNodeVaultAsync, type NodeHost } from "../src/node/node-app";
import { DAMAGED_FILE, FLUSH_FILES, FLUSH_MS, INDEX_FILE, IndexDb, jsonSafe, RACY_MS, SQLITE } from "../src/node/index-db";
import { BACKUP_TRACKED, STORE_GITIGNORE } from "../src/node/store-backup";

const VERSION = "test";
const opened: NodeHost[] = [];
const load = SQLITE.load;
afterEach(() => {
  for (const h of opened.splice(0)) closeNodeHost(h);
  SQLITE.load = load;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function vaultWith(files: Record<string, string>): { root: string; store: string; write(rel: string, text: string): void; abs(rel: string): string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-index-db-"));
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

const VAULT = {
  "Welcome.md": "Start at [[Projects/Apollo]] and [[Ada]].\n",
  "People/Ada.md": "---\nid: 01a0f000-0000-7000-8000-00000000000a\nname: Ada\ntags: [person]\n---\nWorks on [[Apollo]] #team\n",
  "People/Bob.md": "---\nname: Bob\nfriend: \"[[Ada]]\"\n---\nSee ![[diagram.png]] and [[Missing note]].\n",
  "Projects/Apollo.md": "---\nstatus: active\n2: numbered key\n---\n# Apollo\nLead: [[People/Ada|Ada]] [[#Goals]]\n",
  "Projects/Broken.md": "---\ntable: [broken\n---\nA plan with front matter YAML cannot read. #broken-tag\n",
  "Projects/Odd.md": "---\nratio: .nan\nlimit: .inf\n---\nValues JSON cannot hold.\n",
  "Projects/Empty.md": "---\n---\nAn empty block.\n",
  "Projects/diagram.png": "png",
  "Archive/Old.md": "No front matter, a link to [Apollo](../Projects/Apollo.md).\n",
};

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

/** What the host knows of the vault, to compare with a start that reads every note. */
function state(h: NodeHost) {
  const notes = h.vault.getMarkdownFiles();
  return {
    files: h.vault.getFiles().map((f) => [f.path, f.stat?.size]),
    meta: notes.map((f) => [f.path, h.metadataCache.getFileCache(f), h.metadataCache.hashOf(f.path), h.metadataCache.linksOf(f.path)]),
    resolved: JSON.stringify(h.metadataCache.resolvedLinks),
    unresolved: JSON.stringify(h.metadataCache.unresolvedLinks),
    backlinks: notes.map((f) => [f.path, h.metadataCache.backlinksOf(f.path)]),
  };
}

function cold(root: string) {
  const h = openNodeVault(root);
  const s = state(h);
  h.metadataCache.dispose();
  return s;
}

/** The notes the start read (fs.promises.readFile), as vault paths. */
function readsOf(root: string, spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([p]) => path.relative(root, String(p)).split(path.sep).join("/")).sort();
}

/** Age every recorded note past the racy window (as if recorded long ago). */
function aged(v: { root: string }, files: string[]): void {
  const past = Date.now() / 1000 - 3600;
  for (const f of files) fs.utimesSync(path.join(v.root, ...f.split("/")), past, past);
}

describe("the vault index on disk", () => {
  it("a first start reads every note and records it; the next reads none and ends in the same state", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    const reads = vi.spyOn(fs.promises, "readFile");
    const first = await start(v);
    expect(first.index).not.toBeNull();
    expect(readsOf(v.root, reads)).toEqual(Object.keys(VAULT).filter((p) => p.endsWith(".md")).sort());
    expect(fs.existsSync(path.join(v.store, "index", INDEX_FILE))).toBe(true);
    expect(state(first)).toEqual(cold(v.root));
    await stop(first);
    reads.mockClear();
    const second = await start(v);
    // only the note whose front matter JSON cannot hold (NaN, Infinity) is read again
    expect(readsOf(v.root, reads)).toEqual(["Projects/Odd.md"]);
    expect(state(second)).toEqual(cold(v.root));
    expect(second.metadataCache.verifyLinks()).toEqual([]);
    expect(second.metadataCache.getFileCache(second.vault.getAbstractFileByPath("Projects/Odd.md") as TFile)?.frontmatter).toEqual({ ratio: NaN, limit: Infinity });
    // the engine's file cache has each note's parse and hash: its text comes from the index, not the disk
    reads.mockClear();
    const ada = second.vault.getAbstractFileByPath("People/Ada.md") as TFile;
    expect((await readHashed(second.app as unknown as App, ada)).content).toBe(VAULT["People/Ada.md"]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("finds what changed while the engine was stopped: an edit, a new note, a deleted one, a moved one", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    await stop(await start(v));
    v.write("People/Bob.md", "---\nname: Robert\n---\nNow links to [[Old]] only.\n");
    v.write("People/Cy.md", "---\nname: Cy\n---\nA new note named [[Bob]].\n");
    fs.rmSync(v.abs("Welcome.md"));
    fs.mkdirSync(v.abs("Team"));
    fs.renameSync(v.abs("People/Ada.md"), v.abs("Team/Ada.md")); // the same file: its id kept
    fs.writeFileSync(v.abs("Projects/diagram.png"), "a bigger png");
    aged(v, ["People/Bob.md", "People/Cy.md", "Projects/diagram.png"]); // written long ago: recorded at once
    const reads = vi.spyOn(fs.promises, "readFile");
    const h = await start(v);
    // the edit and the new note are read; the moved note is known by its id, not read again
    expect(readsOf(v.root, reads)).toEqual(["People/Bob.md", "People/Cy.md", "Projects/Odd.md"]);
    expect(state(h)).toEqual(cold(v.root));
    expect(h.metadataCache.verifyLinks()).toEqual([]);
    await stop(h);
    // the index followed: one more start reads nothing new and still agrees
    reads.mockClear();
    const again = await start(v);
    expect(readsOf(v.root, reads)).toEqual(["Projects/Odd.md"]);
    expect(state(again)).toEqual(cold(v.root));
  });

  it("pairs a note moved as a new file (a copy, then a delete) by its hash, once read", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    await stop(await start(v));
    fs.mkdirSync(v.abs("Team"));
    fs.copyFileSync(v.abs("People/Ada.md"), v.abs("Team/Ada.md")); // another file id
    fs.rmSync(v.abs("People/Ada.md"));
    aged(v, ["Team/Ada.md"]);
    const h = createNodeHost(v.root);
    opened.push(h);
    await h.vault.scan();
    const counts = await indexNodeHost(h, { index: { store: v.store, version: VERSION } });
    expect(counts).toMatchObject({ read: 2, moved: 1, indexed: true, rebuilt: null }); // Team/Ada.md and Projects/Odd.md
    expect(state(h)).toEqual(cold(v.root));
    await stop(h);
    // the record moved with it: the next start reads it no more
    const reads = vi.spyOn(fs.promises, "readFile");
    const again = await start(v);
    expect(readsOf(v.root, reads)).toEqual(["Projects/Odd.md"]);
    expect(state(again)).toEqual(cold(v.root));
  });

  it("keeps up with the engine's writes and the hand edits it sees while it runs", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    const h = await start(v);
    const ada = h.vault.getAbstractFileByPath("People/Ada.md") as TFile;
    await h.vault.process(ada, (t) => t.replace("Works on", "Leads"));
    await h.vault.create("People/Dee.md", "---\nname: Dee\n---\n[[Ada]] and [[Welcome]]\n");
    await h.fileManager.renameFile(h.vault.getAbstractFileByPath("Projects/Apollo.md")!, "Projects/Apollo 11.md");
    await h.vault.delete(h.vault.getAbstractFileByPath("Archive/Old.md")!);
    v.write("Welcome.md", "Edited by hand: [[Dee]].\n");
    h.vault.syncPath("Welcome.md");
    // written in the background: a note written less than RACY_MS ago waits until it is older
    await new Promise((r) => setTimeout(r, RACY_MS + FLUSH_MS + 300));
    expect(h.index!.writes).toBeGreaterThan(1);
    await stop(h);
    const reads = vi.spyOn(fs.promises, "readFile");
    const again = await start(v);
    expect(readsOf(v.root, reads)).toEqual(["Projects/Odd.md"]);
    expect(state(again)).toEqual(cold(v.root));
  });

  it("reads again a note written within the racy window of its record, though its stat is the same", async () => {
    const v = vaultWith({ "a.md": "---\nk: one\n---\nA\n", "b.md": "---\nk: [broken\n---\nB #tag\n", "c.md": "C, no front matter\n" });
    const h = await start(v); // recorded right after the write: within the window
    await stop(h);
    const st = fs.statSync(v.abs("a.md"));
    v.write("a.md", "---\nk: two\n---\nA\n"); // the same size
    fs.utimesSync(v.abs("a.md"), st.atime, st.mtime); // and the same mtime
    const reads = vi.spyOn(fs.promises, "readFile");
    const again = await start(v);
    // every note is read again; b and c are the same text: their records are kept as they are
    expect(readsOf(v.root, reads)).toEqual(["a.md", "b.md", "c.md"]);
    expect(again.metadataCache.getFileCache(again.vault.getAbstractFileByPath("a.md") as TFile)?.frontmatter).toEqual({ k: "two" });
    expect(state(again)).toEqual(cold(v.root));
    expect(RACY_MS).toBe(2000);
  });

  it("an index the engine stopped writing halfway (a crash): its parses are used, every link is resolved again", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    await stop(await start(v));
    const sqlite = SQLITE.load()!;
    const db = new sqlite.DatabaseSync(path.join(v.store, "index", INDEX_FILE));
    db.exec("UPDATE meta SET value = '0' WHERE key = 'clean'; UPDATE files SET resolved = '{\"nowhere.md\":1}', unresolved = '{}' WHERE path = 'People/Bob.md'");
    db.close();
    const reads = vi.spyOn(fs.promises, "readFile");
    const h = await start(v);
    expect(readsOf(v.root, reads)).toEqual(["Projects/Odd.md"]);
    expect(state(h)).toEqual(cold(v.root));
    expect(h.metadataCache.verifyLinks()).toEqual([]);
  });

  it("is rebuilt when deleted, unreadable, of another format or for another vault", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    const file = path.join(v.store, "index", INDEX_FILE);
    await stop(await start(v));
    const notes = Object.keys(VAULT).filter((p) => p.endsWith(".md")).sort();
    const reads = vi.spyOn(fs.promises, "readFile");
    const readAll = async (why: string | null) => {
      reads.mockClear();
      const h = await start(v);
      expect(readsOf(v.root, reads)).toEqual(notes);
      expect(h.index!.db.rebuilt).toEqual(why);
      expect(state(h)).toEqual(cold(v.root));
      await stop(h);
    };
    fs.rmSync(file);
    await readAll("none yet");
    fs.writeFileSync(file, "not a database at all, just text that SQLite cannot read".repeat(100));
    for (const f of [`${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    await readAll(expect.stringMatching(/^it could not be read: /) as never);
    const sqlite = SQLITE.load()!;
    const db = new sqlite.DatabaseSync(file);
    db.exec("UPDATE meta SET value = '0' WHERE key = 'format'");
    db.close();
    await readAll("another format (0, now 3)");
    const other = new sqlite.DatabaseSync(file);
    other.exec("UPDATE meta SET value = 'elsewhere' WHERE key = 'vault'");
    other.close();
    await readAll(expect.stringMatching(/^another vault \(elsewhere, now /) as never);
  });

  it("is none where node:sqlite is missing, or the file can be neither read nor replaced: every note is read", async () => {
    const v = vaultWith(VAULT);
    SQLITE.load = () => null;
    const h = await start(v);
    expect(h.index).toBeNull();
    expect(state(h)).toEqual(cold(v.root));
    expect(fs.existsSync(path.join(v.store, "index"))).toBe(false);
    await stop(h);
    SQLITE.load = load;
    // a folder where the file should be: neither opened nor deleted
    fs.mkdirSync(path.join(v.store, "index", INDEX_FILE, "inside"), { recursive: true });
    const logs: string[] = [];
    setTelemetry({ log: (_s, body) => void logs.push(body), flush: async () => {} });
    expect(IndexDb.open(v.store, { vault: v.root, version: VERSION })).toBeNull();
    expect(logs).toContain("datanotes could not open the vault index: every note is read at start");
  });

  it("an error of SQLite while the engine runs turns the index off for the run; the next start reads what changed", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    const h = await start(v);
    const logs: string[] = [];
    setTelemetry({ log: (_s, body) => void logs.push(body), flush: async () => {} });
    vi.spyOn(h.index!.db, "write").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    v.write("People/Bob.md", "---\nname: Bob\n---\nEdited.\n");
    h.vault.syncPath("People/Bob.md");
    h.index!.flush(true);
    expect(h.index!.off).toBe(true);
    expect(logs).toContain("datanotes vault index failed: off until the next start");
    expect(h.index!.textOf("People/Ada.md", "x")).toBeUndefined();
    vi.restoreAllMocks();
    await stop(h);
    const reads = vi.spyOn(fs.promises, "readFile");
    const again = await start(v);
    expect(readsOf(v.root, reads)).toEqual(["People/Bob.md", "Projects/Odd.md"]);
    expect(state(again)).toEqual(cold(v.root));
  });

  it("a damaged index found while the engine runs: off for the run, rebuilt at the next start", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    setTelemetry({ log: () => {}, flush: async () => {} });
    const h = await start(v);
    vi.spyOn(h.index!.db, "text").mockImplementation(() => {
      throw Object.assign(new Error("database disk image is malformed"), { errcode: 11 });
    });
    expect(h.index!.textOf("People/Ada.md", "x")).toBeUndefined();
    expect(h.index!.off).toBe(true);
    vi.restoreAllMocks();
    await stop(h);
    const mark = path.join(v.store, "index", DAMAGED_FILE);
    expect(fs.existsSync(mark)).toBe(true);
    const reads = vi.spyOn(fs.promises, "readFile");
    const again = await start(v);
    expect(readsOf(v.root, reads)).toEqual(Object.keys(VAULT).filter((p) => p.endsWith(".md")).sort());
    expect(again.index!.db.rebuilt).toBe("the last run found it damaged (database disk image is malformed)");
    expect(fs.existsSync(mark)).toBe(false);
    expect(state(again)).toEqual(cold(v.root));
  });

  it("reads again a note edited in place with its old modification time restored (cp -p, rsync -t): its change time moved", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    await stop(await start(v));
    const file = v.abs("People/Bob.md");
    const st = fs.statSync(file);
    await new Promise((r) => setTimeout(r, 50)); // past the file system's clock tick
    fs.writeFileSync(file, VAULT["People/Bob.md"].replace("name: Bob", "name: Rob")); // the same size
    fs.utimesSync(file, st.atime, st.mtime); // the old modification time
    expect([fs.statSync(file).size, fs.statSync(file).mtimeMs]).toEqual([st.size, st.mtimeMs]);
    expect(fs.statSync(file).ctimeMs).not.toBe(st.ctimeMs);
    const reads = vi.spyOn(fs.promises, "readFile");
    const h = await start(v);
    expect(readsOf(v.root, reads)).toEqual(["People/Bob.md", "Projects/Odd.md"]);
    expect(h.metadataCache.getFileCache(h.vault.getAbstractFileByPath("People/Bob.md") as TFile)?.frontmatter).toMatchObject({ name: "Rob" });
    expect(state(h)).toEqual(cold(v.root));
  });

  it("held, writes nothing in the background until released; a start that records every note writes it a slice at a time", async () => {
    const files = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`n${i}.md`, `---
n: ${i}
---
[[n${(i + 1) % 25}]]
`]));
    const v = vaultWith(files);
    aged(v, Object.keys(files));
    const limits = { files: FLUSH_FILES };
    const h = await openNodeVaultAsync(v.root, undefined, { index: { store: v.store, version: VERSION } });
    opened.push(h);
    expect(h.index!.writes).toBe(0);
    h.index!.hold();
    await new Promise((r) => setTimeout(r, FLUSH_MS + 100));
    expect(h.index!.writes).toBe(0);
    h.index!.release();
    await new Promise((r) => setTimeout(r, FLUSH_MS + 100));
    expect(h.index!.writes).toBe(Math.ceil(25 / limits.files));
    h.index!.release(); // nothing left: nothing more
    await stop(h);
    const reads = vi.spyOn(fs.promises, "readFile");
    const again = await start(v);
    expect(reads).not.toHaveBeenCalled();
    expect(state(again)).toEqual(cold(v.root));
  });

  it("a restart with nothing to write lets go of the walk's file ids; a held one at its release", async () => {
    // without Projects/Odd.md, which every start reads again (JSON cannot hold its front matter)
    const files = Object.fromEntries(Object.entries(VAULT).filter(([p]) => p !== "Projects/Odd.md"));
    const v = vaultWith(files);
    aged(v, Object.keys(files));
    await stop(await start(v));
    const h = await openNodeVaultAsync(v.root, undefined, { index: { store: v.store, version: VERSION } });
    opened.push(h);
    expect(h.index!.writes).toBe(0);
    expect(h.vault.walkIds).toBeNull();
    await stop(h);
    const host = createNodeHost(v.root);
    await host.vault.scan();
    await indexNodeHost(host, { index: { store: v.store, version: VERSION }, hold: true });
    opened.push(host);
    expect(host.vault.walkIds).not.toBeNull();
    host.index!.release();
    expect(host.vault.walkIds).toBeNull();
  });

  it("interns the records a start took from the index after the start, a slice per turn; the host's state stays the same", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    const first = await start(v);
    expect(first.metadataCache.internPending).toBe(0); // every note read: nothing to intern
    await first.metadataCache.internRecords();
    await stop(first);
    const slice = INTERN_SLICE.records;
    INTERN_SLICE.records = 2;
    try {
      const host = createNodeHost(v.root);
      await host.vault.scan();
      await indexNodeHost(host, { index: { store: v.store, version: VERSION }, hold: true });
      opened.push(host);
      const mc = host.metadataCache;
      // held: nothing interned until the caller starts it; 7 notes taken from the index (Odd.md read)
      expect(mc.internPending).toBe(7);
      const done = mc.internRecords();
      expect(mc.internRecords()).toBe(done);
      expect(mc.internPending).toBe(7); // the first slice waits for the next turn
      await new Promise((r) => setImmediate(r));
      expect(mc.internPending).toBe(5);
      await done;
      expect(mc.internPending).toBe(0);
      expect(state(host)).toEqual(cold(v.root));
      await mc.internRecords(); // nothing left: answered at once
      // not held: the start interns by itself
      const h = await openNodeVaultAsync(v.root, undefined, { index: { store: v.store, version: VERSION } });
      opened.push(h);
      expect(h.metadataCache.internPending).toBe(7);
      await h.metadataCache.internRecords();
      expect(h.metadataCache.internPending).toBe(0);
      expect(state(h)).toEqual(cold(v.root));
    } finally {
      INTERN_SLICE.records = slice;
    }
  });

  it("a stop while the records are interned ends it: the promise resolves, no slice runs after", async () => {
    const v = vaultWith(VAULT);
    aged(v, Object.keys(VAULT));
    await stop(await start(v));
    const slice = INTERN_SLICE.records;
    INTERN_SLICE.records = 1;
    try {
      const host = createNodeHost(v.root);
      await host.vault.scan();
      await indexNodeHost(host, { index: { store: v.store, version: VERSION }, hold: true });
      opened.push(host);
      const mc = host.metadataCache;
      const done = mc.internRecords();
      await new Promise((r) => setImmediate(r));
      expect(mc.internPending).toBe(6);
      await stop(host);
      expect(mc.internPending).toBe(0);
      await done;
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      expect(mc.internPending).toBe(0);
      mc.dispose(); // twice: nothing to end
    } finally {
      INTERN_SLICE.records = slice;
    }
  });

  it("stays out of the store backup", () => {
    expect(BACKUP_TRACKED.some((t) => t.startsWith("index"))).toBe(false);
    expect(STORE_GITIGNORE.split("\n")).toContain("/*");
  });

  it("records only values JSON holds as they are", () => {
    expect([jsonSafe({ a: [1, "x", true, null, { b: 2.5 }] }), jsonSafe(NaN), jsonSafe(Infinity), jsonSafe(-0), jsonSafe(new Date(0)), jsonSafe(undefined), jsonSafe(Object.create(null))]).toEqual([true, false, false, false, false, false, true]);
  });
});
