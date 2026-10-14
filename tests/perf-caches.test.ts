/**
 * What the engine keeps in memory so that reads and writes stay fast on a large vault, and how it
 * notices that what it keeps is stale: the metastore's tables and references (per parsed model),
 * the journal's monthly files (by the host's size and time), the transaction log's last states
 * (checked against the log before a commit), the notes read at start, the change feed's newest
 * events. Each one answers as reading everything again would.
 */

import fs from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { adoptCreatedNote } from "../src/core/auto-adopt";
import { ChangeFeed } from "../src/core/change-feed";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { primeFiles, readHashed, readParsedValue } from "../src/core/file-cache";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import type { App, TFile, VaultAdapter } from "../src/core/host";
import { inverseSpecs } from "../src/core/inverse";
import { compactJournal, journalFileFor, MigrationNotFoundError, readJournal } from "../src/core/journal";
import { AmbiguousCatalogRefError, catalogTables, catalogViews, loadMetastore, parseMetastore, resolveCatalogRef, rowTableFull } from "../src/core/metastore";
import { catalogRowFiles, catalogRowFilesOf } from "../src/core/row-files";
import { insertRow } from "../src/core/rows";
import { storeReadFile, storeStat } from "../src/core/store";
import { contentHash, EXTERNAL_EDIT, forgetLoggedStates, latestVersion, listVersions, syncTransactionLogs, warmLoggedStates } from "../src/core/transaction-log";
import { openNodeVault } from "../src/node/node-app";
import { createDbVault, logVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const TWO_EVENTS = `catalogs:
  main:
    schemas:
      public:
        tables:
          person:
            columns:
              - { name: name, type: string }
              - { name: partner, type: link, ref: main.public.person, inverse: partner }
          event:
            columns:
              - { name: title, type: string }
        views:
          vw_people:
            query: { table: person }
      metrics:
        tables:
          event:
            columns:
              - { name: value, type: integer }
`;

/** Give an adapter the host's `stat` (as Obsidian's DataAdapter and the headless host have it), on the files under `abs`. */
function withStat(adapter: VaultAdapter, abs: (p: string) => string): void {
  adapter.stat = async (p: string) => {
    const f = abs(p);
    if (!fs.existsSync(f)) return null;
    const s = fs.statSync(f);
    return { size: s.size, mtime: s.mtimeMs };
  };
  onTestFinished(() => {
    delete adapter.stat;
  });
}

/** Count the reads of an adapter whose path matches. */
function countReads(adapter: VaultAdapter, match: (p: string) => boolean): { n: number } {
  const count = { n: 0 };
  const read = adapter.read.bind(adapter);
  const spy = vi.spyOn(adapter, "read").mockImplementation(async (p: string) => {
    if (match(p)) count.n++;
    return read(p);
  });
  onTestFinished(() => spy.mockRestore());
  return count;
}

describe("the metastore's tables and references, per parsed model", () => {
  it("each caller gets its own lists and references", () => {
    const model = parseMetastore(TWO_EVENTS);
    const first = catalogTables(model);
    first[0]!.ref.full = "changed";
    first.pop();
    expect(catalogTables(model).map((t) => t.ref.full)).toEqual(["main.metrics.event", "main.public.event", "main.public.person"]);
    const views = catalogViews(model);
    views[0]!.ref.table = "changed";
    expect(catalogViews(model).map((v) => v.ref.full)).toEqual(["main.public.vw_people"]);
    const ref = resolveCatalogRef(model, "person")!;
    ref.table = "changed";
    expect(resolveCatalogRef(model, "person")).toEqual({ catalog: "main", schema: "public", table: "person", full: "main.public.person" });
    expect(resolveCatalogRef(model, "vw_people", "view")!.full).toBe("main.public.vw_people");
    expect(resolveCatalogRef(model, "vw_people")).toBeNull(); // a view is no table
  });

  it("an ambiguous name is refused each time, and is no row's table", () => {
    const model = parseMetastore(TWO_EVENTS);
    for (let i = 0; i < 2; i++) {
      expect(() => resolveCatalogRef(model, "event")).toThrow(new AmbiguousCatalogRefError("event", ["main.metrics.event", "main.public.event"]));
      expect(rowTableFull(model, "event")).toBeNull();
    }
    expect(rowTableFull(model, "metrics.event")).toBe("main.metrics.event");
    expect(rowTableFull(model, "nothing")).toBeNull();
    expect(rowTableFull(model, "  ")).toBeNull();
    expect(rowTableFull(model, 3)).toBeNull();
  });

  it("the inverse pairs are worked out once per model", () => {
    const model = parseMetastore(TWO_EVENTS);
    expect(inverseSpecs(model)).toBe(inverseSpecs(model));
    expect(inverseSpecs(model).get("main.public.person")!.map((s) => s.column)).toEqual(["partner"]);
    expect(inverseSpecs(parseMetastore(TWO_EVENTS))).not.toBe(inverseSpecs(model));
  });

  it("an unchanged metastore.yaml is not read again on a host with stat; a changed one is", async () => {
    const v = createDbVault({ "Datanotes/metastore.yaml": TWO_EVENTS }, {}, { host: "fake" });
    const path = "Datanotes/metastore.yaml";
    const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
    let reads = 0;
    const read = vault.read.bind(vault);
    vault.read = async (f) => {
      if (f.path === path) reads++;
      return read(f);
    };
    // without stat: read every time
    const first = await loadMetastore(v.app, v.settings);
    await loadMetastore(v.app, v.settings);
    expect(reads).toBe(2);
    withStat(v.app.vault.adapter, (p) => v.abs(p));
    const second = await loadMetastore(v.app, v.settings); // read once more, to learn its size and time
    const third = await loadMetastore(v.app, v.settings);
    expect(reads).toBe(3);
    expect(third!.model).toBe(first!.model); // the same text: parsed once
    expect(second!.text).toBe(TWO_EVENTS);
    fs.writeFileSync(v.abs(path), TWO_EVENTS.replace("person:", "people:"));
    const changed = await loadMetastore(v.app, v.settings);
    expect(reads).toBe(4);
    expect(catalogTables(changed!.model).map((t) => t.ref.table)).toContain("people");
  });
});

describe("the journal's monthly files, kept while the host reports them unchanged", () => {
  /** A log vault whose store has stat (the fake host's store has none). */
  function journalVault(): DbVault {
    const v = logVault({}, "fake");
    withStat(v.app.store!, (p) => v.abs(`store:${p}`));
    return v;
  }
  const insert = async (v: DbVault, kind: string, now: string) => {
    const r = await insertRow(v.app, v.settings, { table: "log", values: { kind, occurred_at: "2026-09-27T09:00" } }, { now: new Date(now) });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.migration_id!;
  };

  it("writes, finds and undoes entries without reading the file again", async () => {
    const v = journalVault();
    const reads = countReads(v.app.store!, (p) => p.startsWith("journal/"));
    const a = await insert(v, "walk", "2026-09-27T09:00:00Z");
    const b = await insert(v, "walk", "2026-09-27T09:00:00Z"); // the same second: another id
    expect(b).toBe(`${a}-2`);
    expect((await readJournal(v.app, v.settings, a)).entry.op).toBe("insert_row");
    expect((await undoOperation(v.app, v.settings, b)).ok).toBe(true);
    expect((await readJournal(v.app, v.settings, b)).undone).toBe(true);
    expect(reads.n).toBe(0); // the file was created by these writes: never read
    await expect(readJournal(v.app, v.settings, "20260927T090000-nothing")).rejects.toThrow(MigrationNotFoundError);
  });

  it("a file another program changed is read again; an entry glued to a torn line is found", async () => {
    const v = journalVault();
    const a = await insert(v, "walk", "2026-09-27T09:00:00Z");
    const file = journalFileFor(v.settings, a);
    const line = v.read(file).trim();
    // another process appends an entry and leaves a torn line, then the engine appends after it
    const other = line.split(a).join("20260927T090100-insert_row-other");
    fs.appendFileSync(v.abs(file), `${other}\n{"type":"migration","migration_id":"20260927T0902`);
    expect((await readJournal(v.app, v.settings, "20260927T090100-insert_row-other")).entry.migration_id).toBe("20260927T090100-insert_row-other");
    const b = await insert(v, "mood", "2026-09-27T09:03:00Z");
    expect(v.read(file).split("\n").at(-2)).toContain(`"migration_id":"${b}"`); // on a line of its own
    expect((await readJournal(v.app, v.settings, b)).entry.migration_id).toBe(b);
    // a line glued to a torn one (an older engine): the entry after the tear is found
    fs.appendFileSync(v.abs(file), `{"type":"undone","migr${other.split("20260927T090100-insert_row-other").join("20260927T090400-insert_row-glued")}\n`);
    expect((await readJournal(v.app, v.settings, "20260927T090400-insert_row-glued")).entry.op).toBe("insert_row");
    // the torn entry itself, cut after its id, is no entry
    fs.appendFileSync(v.abs(file), `{"type":"migration","migration_id":"20260927T090500-torn","op":${other.split("20260927T090100-insert_row-other").join("20260927T090600-insert_row-after")}\n`);
    await expect(readJournal(v.app, v.settings, "20260927T090500-torn")).rejects.toThrow(MigrationNotFoundError);
    expect((await readJournal(v.app, v.settings, "20260927T090600-insert_row-after")).entry.op).toBe("insert_row");
  });

  it("a removed file is no entry; compaction rewrites the files and they are read again", async () => {
    const v = journalVault();
    const a = await insert(v, "walk", "2026-09-27T09:00:00Z");
    const file = journalFileFor(v.settings, a);
    fs.rmSync(v.abs(file));
    await expect(readJournal(v.app, v.settings, a)).rejects.toThrow(MigrationNotFoundError);
    const b = await insert(v, "walk", "2026-09-27T09:05:00Z");
    expect(v.read(file).trim().split("\n")).toHaveLength(1);
    await compactJournal(v.app, { journalRetentionDays: 1 }, new Date("2026-10-30T00:00:00Z"));
    expect(fs.existsSync(v.abs(file))).toBe(false);
    await expect(readJournal(v.app, v.settings, b)).rejects.toThrow(MigrationNotFoundError);
  });

  it("a host whose store loses stat after a read keeps nothing", async () => {
    const v = journalVault();
    const a = await insert(v, "walk", "2026-09-27T09:00:00Z");
    delete v.app.store!.stat;
    const b = await insert(v, "walk", "2026-09-27T09:06:00Z");
    expect((await readJournal(v.app, v.settings, a)).entry.migration_id).toBe(a);
    expect((await readJournal(v.app, v.settings, b)).entry.migration_id).toBe(b);
  });
});

describe("the store's stat", () => {
  it("is undefined on a host without it, null for a file that is not there", async () => {
    const v = logVault({}, "fake");
    expect(await storeStat(v.app, "store:journal/2026-09.jsonl")).toBeUndefined();
    withStat(v.app.store!, (p) => v.abs(`store:${p}`));
    expect(await storeStat(v.app, "store:journal/2026-09.jsonl")).toBeNull();
    await expect(storeReadFile(v.app, "store:journal/2026-09.jsonl")).rejects.toThrow();
  });
});

describe("the transaction log's last states", () => {
  const MOOD = "main.metrics.mood";
  const LOG = `store:transaction_log/${MOOD}`;
  const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });
  const rowPath = (hour: string) => `Datanotes/main/metrics/mood/2026-09-26T${hour}00.md`;

  async function moodVault(): Promise<DbVault> {
    // one file per version: the tests write a version as another writer would
    const v = createDbVault({}, { transactionLogFormat: "files" });
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    const columns = [
      { name: "occurred_at", type: "datetime", required: true, dense: true },
      { name: "value", type: "integer", dense: true },
    ];
    expect((await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns }), at(0))).ok).toBe(true);
    return v;
  }
  const insertMood = async (v: DbVault, hour: string, minute: number) => {
    const r = await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: `2026-09-26T${hour}:00`, value: 3 } }, at(minute));
    expect(r.ok).toBe(true);
    return r.migration_id!;
  };

  it("a version another writer committed is replayed before the next commit, never overwritten", async () => {
    const v = await moodVault();
    await insertMood(v, "09", 1);
    // another engine commits version 2 (the same files: an empty change) behind this one's back
    const theirs = v.read(`${LOG}/00000000000000000001.json`).replace('"version":1', '"version":2');
    fs.writeFileSync(v.abs(`${LOG}/00000000000000000002.json`), theirs);
    v.write(rowPath("09"), v.read(rowPath("09")).replace("value: 3", "value: 4"));
    const commits = await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT });
    expect(commits).toEqual([{ table: MOOD, version: 3, operation: EXTERNAL_EDIT }]);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([0, 1, 2, 3]);
  });

  it("a version another writer committed with the same change leaves nothing to commit", async () => {
    const v = await moodVault();
    await insertMood(v, "09", 1);
    const row = rowPath("09");
    v.write(row, v.read(row).replace("value: 3", "value: 4"));
    const one = v.read(`${LOG}/00000000000000000001.json`).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, { path: string; hash: string }>);
    const before = one.find((l) => l.add)!.add!;
    const content = v.read(row);
    const info = { version: 2, timestamp: "2026-09-01T10:05:00.000Z", operation: EXTERNAL_EDIT, operationMetrics: { numAddedFiles: 1, numRemovedFiles: 1, metadataChanged: false }, engineInfo: "datanotes" };
    const lines = [{ commitInfo: info }, { remove: { path: row, hash: before.hash } }, { add: { path: row, hash: contentHash(content), size: content.length, content } }];
    fs.writeFileSync(v.abs(`${LOG}/00000000000000000002.json`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    expect(await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT })).toEqual([]);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([0, 1, 2]);
  });

  it("a log removed by hand is written again from version 0, as a table never logged", async () => {
    const v = await moodVault();
    await insertMood(v, "09", 1);
    fs.rmSync(v.abs(LOG), { recursive: true });
    v.write(rowPath("09"), v.read(rowPath("09")).replace("value: 3", "value: 4"));
    const commits = await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT });
    expect(commits).toEqual([{ table: MOOD, version: 0, operation: "CREATE TABLE" }]);
  });

  it("the latest version comes from the known state while it is the log's latest", async () => {
    const v = await moodVault();
    await insertMood(v, "09", 1);
    const lists = vi.spyOn(v.app.store!, "list");
    onTestFinished(() => lists.mockRestore());
    expect(await latestVersion(v.app, v.settings, MOOD)).toBe(1);
    expect(lists).not.toHaveBeenCalled();
    forgetLoggedStates(v.app);
    expect(await latestVersion(v.app, v.settings, MOOD)).toBe(1); // listed
    expect(await latestVersion(v.app, v.settings, "main.metrics.nothing")).toBeNull();
  });

  it("an undo keeps the known states: the logs are not replayed", async () => {
    const v = await moodVault();
    const id = await insertMood(v, "09", 1);
    const commitReads = countReads(v.app.store!, (p) => p.startsWith("transaction_log/"));
    expect((await undoOperation(v.app, v.settings, id)).ok).toBe(true);
    expect(commitReads.n).toBe(0);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([0, 1, 2]);
  });

  it("the start replays each table's log once, one table at a time, and stops when asked", async () => {
    const v = await moodVault();
    await insertMood(v, "09", 1);
    forgetLoggedStates(v.app);
    expect(await warmLoggedStates(v.app, v.settings, () => true)).toBe(0);
    expect(await warmLoggedStates(v.app, v.settings)).toBe(1);
    expect(await warmLoggedStates(v.app, v.settings)).toBe(0); // known now
    v.write(rowPath("09"), v.read(rowPath("09")).replace("value: 3", "value: 5"));
    expect(await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT })).toEqual([{ table: MOOD, version: 2, operation: EXTERNAL_EDIT }]);
  });
});

describe("the file cache", () => {
  it("keeps the notes a host read at start under their stat, and reads one that has none", async () => {
    const v = logVault({}, "fake");
    const files = v.app.vault.getMarkdownFiles();
    const a = files.find((f) => f.path === "Daily/a.md")!;
    const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
    let reads = 0;
    const read = vault.read.bind(vault);
    vault.read = async (f) => {
      reads++;
      return read(f);
    };
    const bare = { path: "Daily/b.md", name: "b.md", basename: "b", extension: "md" } as unknown as TFile;
    primeFiles(v.app, [
      { file: a, content: "primed" },
      { file: bare, content: "never kept" },
    ]);
    expect((await readHashed(v.app, a)).content).toBe("primed");
    expect(reads).toBe(0);
    expect((await readHashed(v.app, bare)).content).toContain("kind: mood");
    expect(reads).toBe(1);
  });

  it("reads one value of the front matter, parsed once", async () => {
    const v = logVault({}, "fake");
    const a = v.app.vault.getMarkdownFiles().find((f) => f.path === "Daily/a.md")!;
    let parses = 0;
    const parse = (t: string) => {
      parses++;
      return readOrderedFromMarkdown(t);
    };
    const kind = (o: readonly (readonly [string, unknown])[]) => o.find(([k]) => k === "kind")?.[1];
    expect(await readParsedValue(v.app, a, "test", parse, kind)).toBe("alcohol");
    expect(await readParsedValue(v.app, a, "test", parse, kind)).toBe("alcohol");
    expect(parses).toBe(1);
  });

  it("the headless host hands the notes it read at start to the cache", async () => {
    const v = logVault({}, "node");
    const host = openNodeVault(v.abs(""), undefined, { store: v.abs("store:") });
    const a = host.app.vault.getAbstractFileByPath("Daily/a.md") as TFile;
    const read = vi.spyOn(host.vault, "read");
    expect((await readHashed(host.app as unknown as App, a)).content).toBe(v.read("Daily/a.md"));
    expect(read).not.toHaveBeenCalled();
    expect(await host.vault.adapter.stat!("Daily/none.md")).toBeNull();
    expect(await host.vault.adapter.stat!("Daily/a.md/inside")).toBeNull(); // a file is no folder
    await expect(host.vault.adapter.stat!("../outside")).rejects.toThrow("path outside the vault refused");
  });
});

describe("the rows of several tables in one pass", () => {
  it("are those of each table, and none before the metastore is loaded", async () => {
    const v = createDbVault({
      "Datanotes/metastore.yaml": TWO_EVENTS,
      "P/Ann.md": "---\ntable: main.public.person\nname: Ann\n---\n",
      "P/_archive/Old.md": "---\ntable: main.public.person\nname: Old\n---\n",
      "E/Score.md": "---\ntable: metrics.event\nvalue: 3\n---\n",
      "E/Both.md": "---\ntable: event\n---\n",
    });
    const defs = [
      { full: "main.public.person", def: { options: {}, layout: { archive: "P/_archive" } } },
      { full: "main.metrics.event", def: { options: { exclude: ["X"] }, layout: { archive: "E/_archive" } } },
    ] as unknown as Parameters<typeof catalogRowFilesOf>[2];
    expect([...catalogRowFilesOf(v.app, v.settings, defs).values()].map((l) => l.length)).toEqual([0, 0]);
    await loadMetastore(v.app, v.settings);
    const rows = catalogRowFilesOf(v.app, v.settings, defs);
    expect(rows.get("main.public.person")!.map((f) => f.path)).toEqual(["P/Ann.md"]);
    expect(rows.get("main.metrics.event")!.map((f) => f.path)).toEqual(["E/Score.md"]);
    expect(catalogRowFiles(v.app, v.settings, "main.public.person", defs[0]!.def).map((f) => f.path)).toEqual(["P/Ann.md"]);
  });
});

describe("the change feed's newest events", () => {
  const call = (n: number) => ({ tool: "select_rows", args: { n }, ok: true, durationMs: 1, value: null, servedBy: "engine" });

  it("a feed that starts on its files serves the newest events from memory", async () => {
    const v = logVault({}, "fake");
    const first = new ChangeFeed(v.app, () => v.settings);
    await first.start();
    for (let i = 1; i <= 3; i++) await first.recordToolCall(call(i));
    await first.flush();
    first.stop();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const reads = countReads(v.app.store!, (p) => p.startsWith("changes/"));
    expect((await feed.read({ ops: ["tool_call"], since: 1 })).events.map((e) => e.seq)).toEqual([2, 3]);
    expect(reads.n).toBe(0);
  });

  it("a read from the start reads the day files only until its page is full", async () => {
    const v = logVault({}, "fake");
    const ev = (seq: number, day: string) => JSON.stringify({ seq, at: `2026-09-${day}T10:00:00.000Z`, op: "tool_call", path: "", source: "engine", tool: "x" });
    fs.mkdirSync(v.abs("store:changes"), { recursive: true });
    fs.writeFileSync(v.abs("store:changes/2026-09-01.jsonl"), `${ev(1, "01")}\n${ev(2, "01")}\n`);
    fs.writeFileSync(v.abs("store:changes/2026-09-02.jsonl"), `${ev(3, "02")}\n${ev(4, "02")}\n`);
    fs.writeFileSync(v.abs("store:changes/2026-09-03.jsonl"), `${ev(5, "03")}\n`);
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    // memory holds the newest day only: older reads go to the files
    const reads = countReads(v.app.store!, (p) => p.startsWith("changes/"));
    const page = await feed.read({ ops: ["tool_call"], since: 0, limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.last).toBe(2);
    expect(reads.n).toBe(1);
    expect((await feed.read({ ops: ["tool_call"], since: 0, limit: 3 })).events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await feed.read({ ops: ["tool_call"], since: 2, limit: 10 })).events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
});

describe("adoption of new notes", () => {
  it("a row with its id is never adopted, and a note that cannot be read is no row", async () => {
    const v = logVault({ "Datanotes/main/public/log/x.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-0000000000aa\nkind: walk\n---\n" }, "fake");
    await loadMetastore(v.app, v.settings);
    expect(await adoptCreatedNote(v.app, v.settings, v.file("Datanotes/main/public/log/x.md"))).toEqual({ adopted: false });
    expect(await adoptCreatedNote(v.app, v.settings, v.file("Elsewhere/none.md"))).toEqual({ adopted: false });
    expect(await adoptCreatedNote(v.app, v.settings, v.file("Daily/picture.png"))).toEqual({ adopted: false });
  });
});
