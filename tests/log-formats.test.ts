/**
 * The transaction log in its two formats (versions in files of their own, or appended to
 * segments) and its checkpoints (a single document, or a manifest and parts): what a replay reads
 * is the same whatever the files, mixed folders included, and a conversion keeps every version.
 */

import fs from "node:fs";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { tableChanges, vacuumTable } from "../src/core/history";
import type { StoreAdapter } from "../src/core/host";
import { CHECKPOINT_PART, forgetLogTocs, framed, pad, parseSegment, SEGMENT_POLICY } from "../src/core/log-files";
import { deleteRows, insertRow, select, updateRows } from "../src/core/rows";
import {
  CHECKPOINT_POLICY,
  commitInfos,
  convertLog,
  dueCheckpoints,
  EXTERNAL_EDIT,
  forgetLoggedStates,
  HistoryError,
  LEGACY_CHECKPOINT,
  listVersions,
  loggedTexts,
  setCheckpointRunner,
  syncTransactionLogs,
  tableStateAt,
  warmLoggedStates,
  writeDueCheckpoints,
  type ExternalLogChange,
  type LoggedState,
} from "../src/core/transaction-log";
import { docsUrl, guidanceOf } from "../src/core/hints";
import { createDbVault, folderStore, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const MOOD = "main.metrics.mood";
const LOG_DIR = `store:transaction_log/${MOOD}`;
const COLUMNS = [
  { name: "occurred_at", type: "datetime", required: true, dense: true },
  { name: "value", type: "integer", min: 1, max: 5, dense: true },
];
const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });
/** The path of the row `writes` inserts at `hour` (from minute 1). */
const rowPath = (hour: string) => `Datanotes/main/metrics/mood/2026-09-26T${hour}01.md`;

const policies = { checkpoint: { ...CHECKPOINT_POLICY }, segment: { ...SEGMENT_POLICY }, part: { ...CHECKPOINT_PART }, legacy: { ...LEGACY_CHECKPOINT } };
afterEach(() => {
  Object.assign(CHECKPOINT_POLICY, policies.checkpoint);
  Object.assign(SEGMENT_POLICY, policies.segment);
  Object.assign(CHECKPOINT_PART, policies.part);
  Object.assign(LEGACY_CHECKPOINT, policies.legacy);
});

/** A vault with time travel on, `mood` created (version 0), its log in `format` (the default when none). */
async function moodVault(format?: "files" | "segments", store?: StoreAdapter): Promise<DbVault> {
  const v = createDbVault({}, format === undefined ? {} : { transactionLogFormat: format });
  if (store) (v.app as { store?: StoreAdapter }).store = store;
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  expect((await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }), at(0))).ok).toBe(true);
  return v;
}

/** Inserts, updates, a delete and a hand edit: versions 1 to 7, from minute `from` on. */
async function writes(v: DbVault, from = 1): Promise<void> {
  for (const [i, hour] of ["01", "02", "03"].entries()) {
    const r = await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: `2026-09-26T${hour}:${String(from).padStart(2, "0")}`, value: i + 1 } }, at(from + i));
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  }
  expect((await updateRows(v.app, v.settings, { table: "mood", where: { value: 1 }, set: { value: 5 } }, at(from + 3))).ok).toBe(true);
  expect((await deleteRows(v.app, v.settings, { table: "mood", where: { value: 2 }, mode: "delete" }, at(from + 4))).ok).toBe(true);
  const row = v.list().find((p) => p.includes("/main/metrics/mood/") && v.read(p).includes("value: 3"))!;
  v.write(row, `${v.read(row)}\nA line written by hand.\n`);
  expect(await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, now: at(from + 5).now })).toHaveLength(1);
}

/** Every version of the log as a replay from its files reads it: commits, states, changes. */
async function replayed(v: DbVault): Promise<unknown> {
  // nothing kept in memory: every read goes to the files
  forgetLogTocs(v.app);
  forgetLoggedStates(v.app);
  const versions = await listVersions(v.app, v.settings, MOOD);
  const states = [];
  for (const version of versions) {
    const s = await tableStateAt(v.app, v.settings, MOOD, { version });
    forgetLoggedStates(v.app);
    states.push({ version: s.version, timestamp: s.timestamp, entry: s.entry, files: [...s.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, f]) => [p, f.hash, f.content]) });
  }
  // from the oldest version kept (a vacuumed log: the one after it, whose version before is there)
  const changes = (await tableChanges(v.app, v.settings, { table: MOOD, startVersion: versions[0] === 0 ? 0 : versions[0]! + 1 })).changes;
  return { versions, infos: await commitInfos(v.app, v.settings, MOOD), states, changes };
}

const logFiles = (v: DbVault) => v.listAll().filter((p) => p.startsWith(`${LOG_DIR}/`)).map((p) => p.slice(LOG_DIR.length + 1));

describe("the transaction log's formats", () => {
  it("versions appended to segments replay as versions in files of their own", async () => {
    const v = await moodVault("segments");
    await writes(v);
    expect(logFiles(v)).toEqual(["00000000000000000000.segment.jsonl"]);
    const before = await replayed(v);
    expect((before as { versions: number[] }).versions).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(await convertLog(v.app, v.settings, MOOD, "files")).toEqual({ table: MOOD, versions: 7, written: 7, removed: 1 });
    expect(logFiles(v)).toEqual([0, 1, 2, 3, 4, 5, 6].map((n) => `0000000000000000000${n}.json`));
    expect(await replayed(v)).toEqual(before);
  });

  it("a log in files converted to segments replays the same, and keeps growing in segments", async () => {
    const v = await moodVault("files");
    await writes(v);
    const before = await replayed(v);
    expect(await convertLog(v.app, v.settings, MOOD, "segments")).toEqual({ table: MOOD, versions: 7, written: 1, removed: 7 });
    expect(logFiles(v)).toEqual(["00000000000000000000-00000000000000000006.segment.jsonl"]);
    expect(await replayed(v)).toEqual(before);
    v.settings.transactionLogFormat = "segments";
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T04:00", value: 4 } }, at(30))).ok).toBe(true);
    expect(logFiles(v)).toEqual(["00000000000000000000-00000000000000000006.segment.jsonl", "00000000000000000007.segment.jsonl"]);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("a folder with both formats (the setting changed twice) reads every version in order", async () => {
    const v = await moodVault("files");
    await writes(v, 1);
    v.settings.transactionLogFormat = "segments";
    await writes(v, 10);
    v.settings.transactionLogFormat = "files";
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-27T01:00", value: 4 } }, at(30))).ok).toBe(true);
    const files = logFiles(v);
    // the segment stays open (sealed by the next version written to a segment)
    expect(files.filter((f) => f.endsWith(".segment.jsonl"))).toEqual(["00000000000000000007.segment.jsonl"]);
    expect(files.filter((f) => /^\d{20}\.json$/.test(f))).toHaveLength(8); // 0..6 and 13
    const mixed = await replayed(v);
    expect((mixed as { versions: number[] }).versions).toEqual([...Array(14).keys()]);
    await convertLog(v.app, v.settings, MOOD, "files");
    expect(logFiles(v).every((f) => /^\d{20}\.json$/.test(f))).toBe(true);
    expect(await replayed(v)).toEqual(mixed);
  });

  it("a segment is sealed once it holds its share of versions: its name then says which", async () => {
    SEGMENT_POLICY.maxVersions = 3;
    const v = await moodVault("segments");
    await writes(v);
    expect(logFiles(v)).toEqual(["00000000000000000000-00000000000000000002.segment.jsonl", "00000000000000000003-00000000000000000005.segment.jsonl", "00000000000000000006.segment.jsonl"]);
    // the versions of a sealed segment are known from its name: only the open one is read to list them
    forgetLogTocs(v.app);
    const reads: string[] = [];
    const read = v.app.store!.read.bind(v.app.store);
    vi.spyOn(v.app.store!, "read").mockImplementation(async (p: string) => {
      reads.push(p);
      return read(p);
    });
    onTestFinished(() => void vi.restoreAllMocks());
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(reads.map((p) => p.split("/").pop())).toEqual(["00000000000000000006.segment.jsonl"]);
  });

  it("a segment's tail torn by a crash is left out, and the next write cuts it off", async () => {
    const v = await moodVault("segments");
    await writes(v);
    const segment = `${LOG_DIR}/00000000000000000000.segment.jsonl`;
    const whole = v.read(segment);
    // the header of version 7 and half its lines: the power went off while it was appended
    fs.appendFileSync(v.abs(segment), `{"commit":{"version":7,"lines":3,"hash":"0"}}\n{"commitInfo":{"version":7`);
    forgetLogTocs(v.app);
    forgetLoggedStates(v.app);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect((await select(v.app, v.settings, { table: "mood", version: 6 })).total).toBe(2);
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T05:00", value: 2 } }, at(40))).ok).toBe(true);
    expect(v.read(segment).startsWith(whole)).toBe(true);
    expect(v.read(segment)).not.toContain('"lines":3,"hash":"0"');
    forgetLogTocs(v.app);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect((await select(v.app, v.settings, { table: "mood", version: 7 })).total).toBe(3);
  });

  it("vacuum keeps the versions of a segment from the version kept on, in a segment of their own", async () => {
    SEGMENT_POLICY.maxVersions = 4;
    const v = await moodVault("segments");
    await writes(v);
    expect(logFiles(v)).toEqual(["00000000000000000000-00000000000000000003.segment.jsonl", "00000000000000000004.segment.jsonl"]);
    const at5 = await tableStateAt(v.app, v.settings, MOOD, { version: 5 });
    const dry = await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 5 }, { dryRun: true });
    expect(dry.deleted).toEqual([`${LOG_DIR}/00000000000000000000-00000000000000000003.segment.jsonl`, `${LOG_DIR}/00000000000000000004.segment.jsonl`]);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 5 });
    expect(logFiles(v)).toEqual(["00000000000000000005-00000000000000000006.segment.jsonl", "00000000000000000005.manifest.jsonl", "00000000000000000005.part-0.jsonl"]);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([5, 6]);
    forgetLoggedStates(v.app);
    const sorted = (files: Map<string, { hash: string; content: string }>) => [...files].map(([p, f]) => [p, f.hash, f.content]).sort();
    expect(sorted((await tableStateAt(v.app, v.settings, MOOD, { version: 5 })).files)).toEqual(sorted(at5.files));
    await expect(select(v.app, v.settings, { table: "mood", version: 4 })).rejects.toThrow(/no version 4/);
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T06:00", value: 2 } }, at(50))).ok).toBe(true);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([5, 6, 7]);
  });
});

describe("checkpoints as a manifest and parts", () => {
  /** A checkpoint at each version from 2 on (`maxVersions` 1, every commit outweighs the table). */
  function everyVersion(): void {
    CHECKPOINT_POLICY.maxVersions = 3;
  }

  it("the start reads a checkpoint's manifest, not its rows' texts; time travel reads them", async () => {
    everyVersion();
    const v = await moodVault("files");
    await writes(v);
    expect(logFiles(v).filter((f) => !/^\d{20}\.json$/.test(f))).toEqual(["00000000000000000002.manifest.jsonl", "00000000000000000002.part-0.jsonl", "00000000000000000005.manifest.jsonl", "00000000000000000005.part-0.jsonl"]);
    forgetLoggedStates(v.app);
    forgetLogTocs(v.app);
    const reads: string[] = [];
    const read = v.app.store!.read.bind(v.app.store);
    vi.spyOn(v.app.store!, "read").mockImplementation(async (p: string) => {
      reads.push(p.split("/").pop()!);
      return read(p);
    });
    onTestFinished(() => void vi.restoreAllMocks());
    expect(await warmLoggedStates(v.app, v.settings)).toBe(1);
    expect(reads).toContain("00000000000000000005.manifest.jsonl");
    expect(reads.filter((r) => r.includes(".part-") || /^0{19}[0-5].json$/.test(r))).toEqual([]);
    reads.length = 0;
    expect((await select(v.app, v.settings, { table: "mood", version: 5 })).total).toBe(2);
    expect(reads).toContain("00000000000000000005.part-0.jsonl");
  });

  it("parts are gzip where the store holds binary files", async () => {
    everyVersion();
    const dir = fs.mkdtempSync(`${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/datanotes-binary-`);
    const plain = folderStore(dir);
    const store: StoreAdapter = {
      ...plain,
      readBinary: async (p) => {
        const b = fs.readFileSync(`${dir}/${p}`);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
      writeBinary: async (p, data) => {
        await plain.mkdir(p.slice(0, p.lastIndexOf("/")));
        fs.writeFileSync(`${dir}/${p}`, new Uint8Array(data));
      },
    };
    const v = await moodVault("files", store);
    await writes(v);
    const part = `${dir}/transaction_log/${MOOD}/00000000000000000005.part-0.jsonl.gz`;
    expect(fs.readFileSync(part).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // gzip
    const latest = await tableStateAt(v.app, v.settings, MOOD, { version: 5 });
    forgetLoggedStates(v.app);
    fs.rmSync(`${dir}/transaction_log/${MOOD}/00000000000000000003.json`); // only the checkpoint holds version 3's rows now
    expect([...(await tableStateAt(v.app, v.settings, MOOD, { version: 5 })).files].map(([p, f]) => [p, f.content])).toEqual([...latest.files].map(([p, f]) => [p, f.content]));
  });

  it("a large table's checkpoint is split into parts and manifest files under the size limit", async () => {
    everyVersion();
    CHECKPOINT_PART.maxChars = 100;
    const v = await moodVault("files");
    await writes(v);
    const files = logFiles(v).filter((f) => f.startsWith("00000000000000000005.") && f !== "00000000000000000005.json");
    expect(files.filter((f) => f.includes(".part-")).length).toBeGreaterThan(1);
    expect(files.filter((f) => f.includes(".manifest-")).length).toBeGreaterThan(0);
    // one row (a line longer than the limit) per file; the manifest's first file holds its header too
    for (const f of files.filter((x) => !x.endsWith(".manifest.jsonl"))) expect([f, v.read(`${LOG_DIR}/${f}`).trim().split("\n")]).toEqual([f, [expect.any(String)]]);
    const want = await tableStateAt(v.app, v.settings, MOOD, { version: 5 });
    forgetLoggedStates(v.app);
    for (const n of [0, 1, 2, 3, 4]) fs.rmSync(v.abs(`${LOG_DIR}/0000000000000000000${n}.json`));
    forgetLogTocs(v.app);
    expect([...(await tableStateAt(v.app, v.settings, MOOD, { version: 5 })).files].map(([p, f]) => [p, f.content])).toEqual([...want.files].map(([p, f]) => [p, f.content]));
  });

  it("a checkpoint a write makes due is written after it, by the runner's job", async () => {
    everyVersion();
    const v = await moodVault("files");
    let asked = 0;
    setCheckpointRunner(v.app, () => asked++);
    onTestFinished(() => setCheckpointRunner(v.app, null));
    await writes(v);
    expect(asked).toBeGreaterThan(0);
    expect(logFiles(v).filter((f) => f.includes(".manifest"))).toEqual([]);
    expect(dueCheckpoints(v.app)).toEqual([MOOD]);
    expect(await writeDueCheckpoints(v.app)).toBe(1);
    expect(dueCheckpoints(v.app)).toEqual([]);
    expect(logFiles(v).filter((f) => f.includes(".manifest"))).toEqual(["00000000000000000006.manifest.jsonl"]);
    expect(await writeDueCheckpoints(v.app, () => true)).toBe(0);
  });

  it("a vacuum writes the single document Datanotes 3.0 reads, unless it would be too large", async () => {
    const v = await moodVault("files");
    await writes(v);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 3 });
    expect(logFiles(v).filter((f) => !/^\d{20}\.json$/.test(f))).toEqual(["00000000000000000003.checkpoint.json"]);
    LEGACY_CHECKPOINT.maxChars = 10;
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 5 });
    expect(logFiles(v).filter((f) => !/^\d{20}\.json$/.test(f))).toEqual(["00000000000000000005.manifest.jsonl", "00000000000000000005.part-0.jsonl"]);
    forgetLoggedStates(v.app);
    expect((await select(v.app, v.settings, { table: "mood", version: 5 })).total).toBe(2);
  });

  it("a vacuum writes again a single-document checkpoint a crash tore at the version it keeps; a whole one is kept", async () => {
    const v = await moodVault("files");
    await writes(v);
    const sorted = (files: Map<string, { content: string }>) => [...files].map(([p, f]) => [p, f.content]).sort();
    const at3 = sorted((await tableStateAt(v.app, v.settings, MOOD, { version: 3 })).files);
    const checkpoint = `${LOG_DIR}/00000000000000000003.checkpoint.json`;
    v.write(checkpoint, '{"version":3,"timestamp":"');
    forgetLogTocs(v.app);
    forgetLoggedStates(v.app);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 3 });
    expect((JSON.parse(v.read(checkpoint)) as { version: number }).version).toBe(3);
    forgetLoggedStates(v.app);
    expect(sorted((await tableStateAt(v.app, v.settings, MOOD, { version: 3 })).files)).toEqual(at3);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([3, 4, 5, 6]);
    const whole = v.read(checkpoint);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 3 });
    expect(v.read(checkpoint)).toBe(whole);
  });

  it("the check of a hand edit gets the text the log had, from the checkpoint's part when no commit after it holds the row", async () => {
    everyVersion();
    const v = await moodVault("files");
    await writes(v);
    const row = rowPath("03");
    const before = v.read(row);
    forgetLoggedStates(v.app); // the row's text is in checkpoint 5 only (version 6 does not touch it)
    v.write(row, before.replace("value: 3", "value: 4"));
    let seen: ExternalLogChange[] = [];
    const commits = await syncTransactionLogs(v.app, v.settings, {
      operation: EXTERNAL_EDIT,
      now: at(40).now,
      check: async (changes) => {
        seen = [...changes];
        return new Map();
      },
    });
    expect(commits).toEqual([{ table: MOOD, version: 7, operation: EXTERNAL_EDIT }]);
    expect([...seen[0]!.before].map(([p, f]) => [p, f.content])).toEqual([[row, before]]);
  });
});

describe("the log's states and texts at their edges", () => {
  /** The rows of a state as path → text, sorted. */
  const texts = (files: Map<string, { content: string }>) => [...files].map(([p, f]) => [p, f.content]).sort();

  it("a table without a log is at no version", async () => {
    const v = await moodVault("files");
    expect(await tableStateAt(v.app, v.settings, "main.metrics.none")).toEqual({ full: "main.metrics.none", version: -1, timestamp: "", entry: null, files: new Map() });
  });

  it("a single-document checkpoint of an earlier engine is read; one removed after it was listed is skipped", async () => {
    const v = await moodVault("files");
    await writes(v);
    const at4 = await tableStateAt(v.app, v.settings, MOOD, { version: 4 });
    forgetLoggedStates(v.app);
    const want = texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files);
    // what Datanotes 3.0 wrote at version 4
    const doc = { version: 4, timestamp: at4.timestamp, entry: at4.entry, files: [...at4.files].map(([p, f]) => ({ path: p, hash: f.hash, content: f.content })) };
    v.write(`${LOG_DIR}/00000000000000000004.checkpoint.json`, JSON.stringify(doc));
    for (const n of [0, 1, 2, 3]) v.remove(`${LOG_DIR}/${pad20(n)}.json`); // only the checkpoint holds the rows before 4
    forgetLogTocs(v.app);
    forgetLoggedStates(v.app);
    expect(await warmLoggedStates(v.app, v.settings)).toBe(1);
    expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files)).toEqual(want);
    forgetLoggedStates(v.app);
    expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files)).toEqual(want);
    const store = v.app.store!;
    const exists = store.exists.bind(store);
    vi.spyOn(store, "exists").mockImplementation(async (p: string) => {
      if (p.endsWith(".checkpoint.json")) fs.rmSync(v.abs(`store:${p}`), { force: true }); // gone right before the read
      return exists(p);
    });
    onTestFinished(() => void vi.restoreAllMocks());
    forgetLoggedStates(v.app);
    expect(await warmLoggedStates(v.app, v.settings)).toBe(1);
    forgetLoggedStates(v.app);
    expect((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).version).toBe(6);
  });

  it("a single-document checkpoint a crash tore, or that is no checkpoint, is skipped: the versions before it are replayed", async () => {
    const v = await moodVault("files");
    await writes(v);
    const at4 = texts((await tableStateAt(v.app, v.settings, MOOD, { version: 4 })).files);
    forgetLoggedStates(v.app);
    const want = texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files);
    for (const text of ['{"version":4,"timestamp":"', "null", "{}"]) {
      v.write(`${LOG_DIR}/00000000000000000004.checkpoint.json`, text);
      forgetLogTocs(v.app);
      forgetLoggedStates(v.app);
      expect(await warmLoggedStates(v.app, v.settings)).toBe(1);
      forgetLoggedStates(v.app);
      expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files)).toEqual(want);
      forgetLoggedStates(v.app);
      expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: 4 })).files)).toEqual(at4);
    }
  });

  it("a manifest whose part is missing, or lacks a row, is skipped: the versions before it are replayed", async () => {
    CHECKPOINT_POLICY.maxVersions = 3;
    const v = await moodVault("files");
    await writes(v);
    const want = texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files);
    const part = `${LOG_DIR}/00000000000000000005.part-0.jsonl`;
    const lines = v.read(part).trim().split("\n");
    v.write(part, `${lines[0]}\n`); // a row of the manifest has no text
    forgetLoggedStates(v.app);
    forgetLogTocs(v.app);
    expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files)).toEqual(want);
    v.remove(part);
    forgetLoggedStates(v.app);
    forgetLogTocs(v.app);
    expect(await warmLoggedStates(v.app, v.settings)).toBe(1); // from checkpoint 2
    expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files)).toEqual(want);
    v.write(`${LOG_DIR}/00000000000000000002.manifest.jsonl`, "not json\n");
    forgetLoggedStates(v.app);
    forgetLogTocs(v.app);
    expect(await warmLoggedStates(v.app, v.settings)).toBe(1); // from version 0
    expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: 6 })).files)).toEqual(want);
    // a vacuum names what it can of a manifest it cannot read
    expect((await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 6 }, { dryRun: true })).deleted.filter((p) => !/\d{20}\.json$/.test(p))).toEqual([
      `${LOG_DIR}/00000000000000000002.manifest.jsonl`,
      `${LOG_DIR}/00000000000000000002.part-0.jsonl`,
      `${LOG_DIR}/00000000000000000005.manifest.jsonl`,
      part,
    ].filter((p) => p !== `${LOG_DIR}/00000000000000000002.part-0.jsonl`));
  });

  it("checkpoints written after a move of the database folder name today's paths; one before a move replays its rows", async () => {
    CHECKPOINT_POLICY.maxVersions = 3;
    const v = await moodVault("files");
    await writes(v);
    await configureDatabase(v.app, v.settings, { root: "Moved/DB" }, async () => {});
    await writes(v, 20);
    const latest = (await listVersions(v.app, v.settings, MOOD)).at(-1)!;
    forgetLoggedStates(v.app);
    const want = texts((await tableStateAt(v.app, v.settings, MOOD, { version: latest })).files);
    expect(want.every(([p]) => p!.startsWith("Moved/DB/"))).toBe(true);
    const manifests = logFiles(v).filter((f) => f.endsWith(".manifest.jsonl"));
    expect(JSON.parse(v.read(`${LOG_DIR}/${manifests.at(-1)!}`).split("\n")[0]!).checkpoint.moves).toBe(1);
    forgetLoggedStates(v.app);
    forgetLogTocs(v.app);
    expect(await warmLoggedStates(v.app, v.settings)).toBe(1);
    expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: latest })).files)).toEqual(want);
    // the checkpoints after the move gone: the start replays from one written before it
    for (const f of logFiles(v).filter((x) => /\.(manifest|part-)/.test(x) && Number(x.slice(0, 20)) > 2)) v.remove(`${LOG_DIR}/${f}`);
    forgetLoggedStates(v.app);
    forgetLogTocs(v.app);
    expect(await warmLoggedStates(v.app, v.settings)).toBe(1);
    expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: latest })).files)).toEqual(want);
    // a hand edit of a row whose text that checkpoint held: checked against the log's text
    const row = want.find(([, t]) => t!.includes("value: 5"))![0]!;
    const before = v.read(row);
    v.write(row, before.replace("value: 5", "value: 4"));
    let seen: ExternalLogChange[] = [];
    await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, now: at(50).now, check: async (c) => ((seen = [...c]), new Map()) });
    expect([...seen[0]!.before].map(([p, f]) => [p, f.content])).toEqual([[row, before]]);
    // a vacuum of a large table after the move: its manifest says so
    LEGACY_CHECKPOINT.maxChars = 10;
    const last = (await listVersions(v.app, v.settings, MOOD)).at(-1)!;
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: last });
    expect(JSON.parse(v.read(`${LOG_DIR}/${pad20(last)}.manifest.jsonl`).split("\n")[0]!).checkpoint.moves).toBe(1);
  });

  it("a single-document checkpoint written after a move of the database folder says so, and a replay from it keeps today's paths", async () => {
    const v = await moodVault("files");
    await writes(v);
    await configureDatabase(v.app, v.settings, { root: "Moved/DB" }, async () => {});
    await writes(v, 20);
    const last = (await listVersions(v.app, v.settings, MOOD)).at(-1)!;
    forgetLoggedStates(v.app);
    const want = texts((await tableStateAt(v.app, v.settings, MOOD, { version: last })).files);
    expect(want.every(([p]) => p!.startsWith("Moved/DB/"))).toBe(true);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: last });
    expect(JSON.parse(v.read(`${LOG_DIR}/${pad20(last)}.checkpoint.json`)).moves).toBe(1);
    forgetLoggedStates(v.app);
    forgetLogTocs(v.app);
    expect(texts((await tableStateAt(v.app, v.settings, MOOD, { version: last })).files)).toEqual(want);
  });
});

const pad20 = (n: number) => String(n).padStart(20, "0");

describe("the texts of a logged state", () => {
  it("come from the notes, the commits, the checkpoints, or a replay; a text found nowhere is left out", async () => {
    CHECKPOINT_POLICY.maxVersions = 3;
    const v = await moodVault("files");
    await writes(v);
    const s6 = await tableStateAt(v.app, v.settings, MOOD, { version: 6 });
    const paths = [...s6.files.keys()].sort();
    const [a, b] = paths as [string, string];
    const file = (p: string, at: number, cp?: true) => ({ hash: s6.files.get(p)!.hash, size: 1, at, ...(cp ? { cp } : {}) });
    const state = (files: [string, ReturnType<typeof file>][], version = 6): LoggedState => ({ full: MOOD, version, timestamp: "", entry: null, files: new Map(files), sinceCheckpoint: { versions: 0, bytes: 0 }, bytes: 0 });
    const want = (p: string) => s6.files.get(p)!.content;
    // the notes changed since: every text from the log
    for (const p of paths) v.write(p, `${v.read(p)}\nchanged\n`);
    // both from checkpoint 5 (a manifest's part); from a checkpoint not there: a replay
    expect(await loggedTexts(v.app, v.settings, state([[a, file(a, 5, true)], [b, file(b, 5, true)]]), [a, b])).toEqual(new Map([[a, want(a)], [b, want(b)]]));
    expect(await loggedTexts(v.app, v.settings, state([[a, file(a, 4, true)]]), [a])).toEqual(new Map([[a, want(a)]]));
    // two rows of one commit (version 0 created none: the replay finds them)
    expect(await loggedTexts(v.app, v.settings, state([[a, file(a, 1)], [b, file(b, 1)]]), [a, b])).toEqual(new Map([[a, want(a)], [b, want(b)]]));
    // a version the log does not hold: found nowhere
    expect(await loggedTexts(v.app, v.settings, state([[a, file(a, 9)]], 9), [a])).toEqual(new Map());
    // a manifest that cannot be read, a part missing: replayed
    const manifest = `${LOG_DIR}/00000000000000000005.manifest.jsonl`;
    const kept = v.read(manifest);
    v.write(manifest, "");
    expect(await loggedTexts(v.app, v.settings, state([[a, file(a, 5, true)]]), [a])).toEqual(new Map([[a, want(a)]]));
    v.write(manifest, kept);
    v.remove(`${LOG_DIR}/00000000000000000005.part-0.jsonl`);
    expect(await loggedTexts(v.app, v.settings, state([[a, file(a, 5, true)]]), [a])).toEqual(new Map([[a, want(a)]]));
    // a single-document checkpoint (a vacuum's)
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 6 });
    expect(await loggedTexts(v.app, v.settings, state([[a, file(a, 6, true)]]), [a])).toEqual(new Map([[a, want(a)]]));
    // a note as the log has it, which the host cannot read right now: from the log
    v.write(a, want(a));
    const vault = v.app.vault as unknown as { read(f: { path: string }): Promise<string> };
    const read = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (f) => {
      if (f.path === a) throw new Error("EBUSY: resource busy or locked");
      return read(f);
    });
    onTestFinished(() => void vi.restoreAllMocks());
    expect(await loggedTexts(v.app, v.settings, state([[a, file(a, 6, true)]]), [a])).toEqual(new Map([[a, want(a)]]));
  });
});

describe("checkpoints made due", () => {
  it("are skipped when the state is forgotten, not due any more, no longer the log's latest, or its texts cannot be found", async () => {
    CHECKPOINT_POLICY.maxVersions = 3;
    const v = await moodVault("files");
    expect(dueCheckpoints(createDbVault({}).app)).toEqual([]);
    expect(await writeDueCheckpoints(createDbVault({}).app)).toBe(0);
    setCheckpointRunner(v.app, () => {});
    onTestFinished(() => setCheckpointRunner(v.app, null));
    const insert = async (hour: string, minute: number) => expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: `2026-09-27T${hour}:00`, value: 2 } }, at(minute))).ok).toBe(true);
    await insert("01", 1);
    await insert("02", 2);
    expect(dueCheckpoints(v.app)).toEqual([MOOD]);
    forgetLoggedStates(v.app);
    expect(await writeDueCheckpoints(v.app)).toBe(0); // forgotten: the next write finds it due again
    await insert("03", 3);
    expect(dueCheckpoints(v.app)).toEqual([MOOD]);
    CHECKPOINT_POLICY.maxVersions = 1000;
    expect(await writeDueCheckpoints(v.app)).toBe(0); // not due any more
    CHECKPOINT_POLICY.maxVersions = 3;
    await insert("04", 4);
    expect(dueCheckpoints(v.app)).toEqual([MOOD]);
    // another writer wrote the next version
    v.write(`${LOG_DIR}/00000000000000000005.json`, v.read(`${LOG_DIR}/00000000000000000004.json`).replace('"version":4', '"version":5'));
    forgetLogTocs(v.app);
    expect(await writeDueCheckpoints(v.app)).toBe(0);
    v.remove(`${LOG_DIR}/00000000000000000005.json`);
    forgetLogTocs(v.app);
    forgetLoggedStates(v.app);
    // the texts gone: the notes changed and the versions holding them removed
    await insert("05", 5);
    expect(dueCheckpoints(v.app)).toEqual([MOOD]);
    for (const p of v.list().filter((x) => x.startsWith("Datanotes/main/metrics/mood/"))) v.write(p, `${v.read(p)}\nchanged\n`);
    for (const n of [0, 1, 2, 3, 4]) v.remove(`${LOG_DIR}/${pad20(n)}.json`);
    forgetLogTocs(v.app);
    expect(await writeDueCheckpoints(v.app)).toBe(0);
    expect(logFiles(v).filter((f) => f.includes(".manifest"))).toEqual([]);
  });
});

describe("segments, the default since 3.1", () => {
  it("a new store writes segments; a store of 3.0 keeps its files and grows in segments; converted to files it replays the same", async () => {
    const fresh = await moodVault();
    await writes(fresh);
    expect(logFiles(fresh)).toEqual(["00000000000000000000.segment.jsonl"]);
    // a 3.0 store: one file per version, then a 3.1 engine with the default settings
    const v = await moodVault("files");
    await writes(v, 1);
    delete (v.settings as Partial<typeof v.settings>).transactionLogFormat;
    await writes(v, 10);
    const files = logFiles(v);
    expect(files.filter((f) => /^\d{20}\.json$/.test(f))).toHaveLength(7);
    expect(files.filter((f) => f.endsWith(".segment.jsonl"))).toEqual(["00000000000000000007.segment.jsonl"]);
    const upgraded = await replayed(v);
    expect((upgraded as { versions: number[] }).versions).toEqual([...Array(13).keys()]);
    // before a downgrade to 3.0: every version in a file of its own, replayed the same
    await convertLog(v.app, v.settings, MOOD, "files");
    expect(logFiles(v).every((f) => /^\d{20}\.json$/.test(f))).toBe(true);
    expect(await replayed(v)).toEqual(upgraded);
  });
});

describe("converting the log", () => {
  it("twice to segments packs nothing more; to files after a vacuum writes the checkpoint Datanotes 3.0 starts from", async () => {
    const v = await moodVault("segments");
    await writes(v);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 3 });
    expect(logFiles(v)).toEqual(["00000000000000000003-00000000000000000006.segment.jsonl", "00000000000000000003.manifest.jsonl", "00000000000000000003.part-0.jsonl"]);
    expect(await convertLog(v.app, v.settings, MOOD, "segments")).toEqual({ table: MOOD, versions: 4, written: 0, removed: 0 });
    const before = await replayed(v);
    expect(await convertLog(v.app, v.settings, MOOD, "files")).toEqual({ table: MOOD, versions: 4, written: 5, removed: 1 });
    expect(logFiles(v).filter((f) => !/^\d{20}\.json$/.test(f))).toEqual(["00000000000000000003.checkpoint.json", "00000000000000000003.manifest.jsonl", "00000000000000000003.part-0.jsonl"]);
    expect(await replayed(v)).toEqual(before);
  });
});

describe("the texts of a logged state, from files gone since", () => {
  it("a single-document checkpoint removed: the text is found nowhere; the latest version without its texts is replayed", async () => {
    const v = await moodVault("files");
    await writes(v);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 6 });
    const s6 = await tableStateAt(v.app, v.settings, MOOD, { version: 6 });
    const a = [...s6.files.keys()].sort()[0]!;
    v.write(a, `${v.read(a)}\nchanged\n`);
    fs.rmSync(v.abs(`${LOG_DIR}/00000000000000000006.checkpoint.json`)); // after the log was listed
    const state: LoggedState = { full: MOOD, version: 6, timestamp: "", entry: null, files: new Map([[a, { hash: s6.files.get(a)!.hash, size: 1, at: 6, cp: true }]]), sinceCheckpoint: { versions: 0, bytes: 0 }, bytes: 0 };
    expect(await loggedTexts(v.app, v.settings, state, [a])).toEqual(new Map());
  });

  it("the latest version whose texts cannot all be found is replayed from the log's files", async () => {
    const v = await moodVault("files");
    await writes(v);
    await warmLoggedStates(v.app, v.settings);
    const row = v.list().find((p) => p.includes("/main/metrics/mood/") && v.read(p).includes("value: 5"))!;
    v.write(row, `${v.read(row)}\nchanged\n`); // not logged yet
    v.remove(`${LOG_DIR}/00000000000000000004.json`); // the version that wrote it
    forgetLogTocs(v.app);
    const s = await tableStateAt(v.app, v.settings, MOOD);
    // the replay without version 4: the row as version 1 wrote it
    expect([s.version, s.files.get(row)!.content.includes("value: 1")]).toEqual([6, true]);
  });
});

describe("a vacuum or a conversion cut short", () => {
  /** The vault's store, its syncs and removes recorded (file names) in `calls`; `fail` makes every sync fail. */
  function recorded(v: DbVault, calls: string[], fail = false): void {
    const base = v.app.store!;
    // the Node host's store is a class: its methods stay on the prototype
    const store: StoreAdapter = Object.assign(Object.create(base) as StoreAdapter, {
      sync: async (paths: readonly string[]) => {
        if (fail) throw new Error("sync failed");
        calls.push(...paths.map((p) => `sync ${p.split("/").pop()!}`));
      },
      remove: async (p: string) => {
        calls.push(`remove ${p.split("/").pop()!}`);
        await base.remove(p);
      },
    });
    (v.app as { store?: StoreAdapter }).store = store;
  }

  it("a vacuum and a conversion sync the files they write before they remove the old ones", async () => {
    SEGMENT_POLICY.maxVersions = 4;
    const v = await moodVault("segments");
    await writes(v);
    const calls: string[] = [];
    recorded(v, calls);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 5 });
    const first = calls.findIndex((c) => c.startsWith("remove "));
    expect(first).toBeGreaterThan(0);
    expect(calls.slice(0, first)).toEqual(expect.arrayContaining(["sync 00000000000000000005-00000000000000000006.segment.jsonl", "sync 00000000000000000005.manifest.jsonl"]));
    calls.length = 0;
    await convertLog(v.app, v.settings, MOOD, "files");
    const removed = calls.findIndex((c) => c.startsWith("remove "));
    expect(removed).toBeGreaterThan(0);
    expect(calls.slice(0, removed)).toEqual(expect.arrayContaining(["sync 00000000000000000005.json", "sync 00000000000000000006.json", "sync 00000000000000000005.checkpoint.json"]));
    calls.length = 0;
    await convertLog(v.app, v.settings, MOOD, "segments");
    const packed = calls.findIndex((c) => c.startsWith("remove "));
    expect(packed).toBeGreaterThan(0);
    expect(calls.slice(0, packed)).toEqual(expect.arrayContaining(["sync 00000000000000000005-00000000000000000006.segment.jsonl"]));
  });

  it("a conversion to segments run again after a crash tore its first segment writes it again whole before it removes the files", async () => {
    const v = await moodVault("files");
    await writes(v);
    const before = await replayed(v);
    // the first run wrote 0-3 but a crash tore it before the sync; 4-6 never written
    SEGMENT_POLICY.maxVersions = 4;
    const first = `${LOG_DIR}/${pad(0)}-${pad(3)}.segment.jsonl`;
    v.write(first, framed(0, v.read(`${LOG_DIR}/${pad(0)}.json`)) + framed(1, v.read(`${LOG_DIR}/${pad(1)}.json`)).slice(0, 20));
    forgetLogTocs(v.app);
    const calls: string[] = [];
    recorded(v, calls);
    expect(await convertLog(v.app, v.settings, MOOD, "segments")).toEqual({ table: MOOD, versions: 7, written: 2, removed: 7 });
    const removes = calls.findIndex((c) => c.startsWith("remove "));
    expect(calls.slice(0, removes)).toEqual(expect.arrayContaining([`sync ${pad(0)}-${pad(3)}.segment.jsonl`, `sync ${pad(4)}-${pad(6)}.segment.jsonl`]));
    expect(logFiles(v)).toEqual([`${pad(0)}-${pad(3)}.segment.jsonl`, `${pad(4)}-${pad(6)}.segment.jsonl`]);
    expect(parseSegment(v.read(first)).commits.map((c) => c.version)).toEqual([0, 1, 2, 3]);
    expect(await replayed(v)).toEqual(before);
  });

  it("a conversion to files run again after a crash tore the checkpoint at the oldest version writes it again", async () => {
    const v = await moodVault("segments");
    await writes(v);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 3 });
    const before = await replayed(v);
    const cp = `${LOG_DIR}/${pad(3)}.checkpoint.json`;
    v.write(cp, '{"version":3,"timestamp":"'); // the first run wrote it, a crash tore it before the sync
    forgetLogTocs(v.app);
    expect(await convertLog(v.app, v.settings, MOOD, "files")).toEqual({ table: MOOD, versions: 4, written: 5, removed: 1 });
    // what Datanotes 3.0 reads: the whole checkpoint at the oldest version
    expect((JSON.parse(v.read(cp)) as { version: number }).version).toBe(3);
    expect(await replayed(v)).toEqual(before);
  });

  it("a sync that fails stops a vacuum before it removes anything", async () => {
    SEGMENT_POLICY.maxVersions = 4;
    const v = await moodVault("segments");
    await writes(v);
    const before = logFiles(v);
    const calls: string[] = [];
    recorded(v, calls, true);
    await expect(vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 5 })).rejects.toThrow("sync failed");
    expect(calls).toEqual([]);
    expect(logFiles(v)).toEqual(expect.arrayContaining(before));
  });
});

describe("a conversion run again after a kill", () => {
  /** The vault's store, its syncs and removes recorded (file names) in `calls`. */
  function recorded(v: DbVault, calls: string[]): void {
    const base = v.app.store!;
    const store: StoreAdapter = Object.assign(Object.create(base) as StoreAdapter, {
      sync: async (paths: readonly string[]) => void calls.push(...paths.map((p) => `sync ${p.split("/").pop()!}`)),
      remove: async (p: string) => {
        calls.push(`remove ${p.split("/").pop()!}`);
        await base.remove(p);
      },
    });
    (v.app as { store?: StoreAdapter }).store = store;
  }
  /** The calls before the first remove. */
  const beforeRemoves = (calls: string[]) => calls.slice(0, calls.findIndex((c) => c.startsWith("remove ")));

  it("to segments syncs a whole segment the killed run wrote but never synced, before it removes the files", async () => {
    const v = await moodVault("files");
    await writes(v);
    const before = await replayed(v);
    // the killed run wrote 0-3 whole, not synced; 4-6 never written
    SEGMENT_POLICY.maxVersions = 4;
    v.write(`${LOG_DIR}/${pad(0)}-${pad(3)}.segment.jsonl`, [0, 1, 2, 3].map((n) => framed(n, v.read(`${LOG_DIR}/${pad(n)}.json`))).join(""));
    forgetLogTocs(v.app);
    const calls: string[] = [];
    recorded(v, calls);
    expect(await convertLog(v.app, v.settings, MOOD, "segments")).toEqual({ table: MOOD, versions: 7, written: 1, removed: 7 });
    expect(beforeRemoves(calls)).toEqual(expect.arrayContaining([`sync ${pad(0)}-${pad(3)}.segment.jsonl`, `sync ${pad(4)}-${pad(6)}.segment.jsonl`]));
    expect(await replayed(v)).toEqual(before);
  });

  it("to files syncs the version files and the checkpoint the killed run wrote but never synced, before it removes the segment", async () => {
    const v = await moodVault("segments");
    await writes(v);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 3 });
    const before = await replayed(v);
    const segment = `${LOG_DIR}/${pad(3)}-${pad(6)}.segment.jsonl`;
    const text = v.read(segment);
    // the killed run wrote 3, 4 and the checkpoint whole, not synced, and removed nothing
    await convertLog(v.app, v.settings, MOOD, "files");
    v.write(segment, text);
    v.remove(`${LOG_DIR}/${pad(5)}.json`);
    v.remove(`${LOG_DIR}/${pad(6)}.json`);
    forgetLogTocs(v.app);
    const calls: string[] = [];
    recorded(v, calls);
    expect(await convertLog(v.app, v.settings, MOOD, "files")).toEqual({ table: MOOD, versions: 4, written: 2, removed: 1 });
    expect(beforeRemoves(calls)).toEqual(
      expect.arrayContaining([3, 4, 5, 6].map((n) => `sync ${pad(n)}.json`).concat(`sync ${pad(3)}.checkpoint.json`)),
    );
    expect(await replayed(v)).toEqual(before);
  });

  it("a version no file holds whole stops it before it removes anything, and says to restore the store from its backup", async () => {
    const v = await moodVault("files");
    await writes(v);
    // a crash tore 0-3, and the files of 1 and 2 are gone
    SEGMENT_POLICY.maxVersions = 4;
    v.write(`${LOG_DIR}/${pad(0)}-${pad(3)}.segment.jsonl`, framed(0, v.read(`${LOG_DIR}/${pad(0)}.json`)));
    v.remove(`${LOG_DIR}/${pad(1)}.json`);
    v.remove(`${LOG_DIR}/${pad(2)}.json`);
    forgetLogTocs(v.app);
    const files = logFiles(v);
    const e = await convertLog(v.app, v.settings, MOOD, "segments").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HistoryError);
    expect((e as Error).message).toMatch(/does not hold version 1 whole$/);
    expect(guidanceOf(e)).toEqual({ hint: expect.stringContaining("datanotes store restore --from <backup url> --database <folder> --force") as string, docs: docsUrl("restoreStore") });
    expect(logFiles(v)).toEqual(files);
  });
});
