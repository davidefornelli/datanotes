import fs from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { configureDatabase } from "../src/core/database";
import { CHECKPOINT_POLICY, EXTERNAL_EDIT, HistoryError, listVersions, readCommit, syncTransactionLogs } from "../src/core/transaction-log";
import { createTable, INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { describeHistory, vacuumTable } from "../src/core/history";
import type { App } from "../src/core/host";
import { insertRow, select } from "../src/core/rows";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const COLUMNS = [
  { name: "occurred_at", type: "datetime", required: true, dense: true },
  { name: "value", type: "integer", min: 1, max: 5, dense: true },
];
const MOOD = "main.metrics.mood";
const LOG_DIR = `store:transaction_log/${MOOD}`;
const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });
const rowPath = (hour: string) => `Datanotes/main/metrics/mood/2026-09-26T${hour}00.md`;

/** A vault with time travel on and a `mood` table (version 0). */
async function moodVault(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  expect((await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }), at(0))).ok).toBe(true);
  return v;
}

async function insertMood(v: DbVault, hour: string, minute: number): Promise<void> {
  const r = await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: `2026-09-26T${hour}:00`, value: 3 } }, at(minute));
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
}

/** Write a file of the hidden store as another process would (sync client, another engine). */
function storeFile(v: DbVault, rel: string, text: string): void {
  fs.writeFileSync(v.abs(rel), text);
}

/** Like Obsidian (and the headless host): a note whose YAML does not parse shows no properties. */
function tolerantFrontmatter(app: App): void {
  const cache = app.metadataCache as unknown as { getFileCache(f: unknown): unknown };
  const read = cache.getFileCache.bind(cache);
  const spy = vi.spyOn(cache, "getFileCache").mockImplementation((f: unknown) => {
    try {
      return read(f);
    } catch {
      return {};
    }
  });
  onTestFinished(() => spy.mockRestore());
}

describe("reading the log", () => {
  it("a commit file that lost its commitInfo line (a torn sync) is refused", async () => {
    const v = await moodVault();
    await insertMood(v, "09", 1);
    const commit = `${LOG_DIR}/00000000000000000001.json`;
    storeFile(v, commit, v.read(commit).split("\n").slice(1).join("\n"));
    await expect(describeHistory(v.app, v.settings, { table: "mood" })).rejects.toThrow(new HistoryError("log commit without commitInfo"));
  });

  it("a version the log does not hold is named", async () => {
    const v = await moodVault();
    await expect(readCommit(v.app, v.settings, MOOD, 4)).rejects.toThrow(new HistoryError("main.metrics.mood has no version 4"));
  });

  it("time travel refuses a timestamp that is not a date-time", async () => {
    const v = await moodVault();
    const p = select(v.app, v.settings, { table: "mood", timestamp: "yesterday" });
    await expect(p).rejects.toThrow(new OperationInputError('"timestamp" is not a date-time: yesterday'));
    await expect(p).rejects.toBeInstanceOf(OperationInputError);
  });
});

describe("checkpoints and time travel", () => {
  /** v0 create, v1..v6 inserts at minutes 1..6; checkpoints at versions 2 and 5. */
  async function withCheckpoints(): Promise<DbVault> {
    const policy = { ...CHECKPOINT_POLICY };
    CHECKPOINT_POLICY.maxVersions = 3;
    onTestFinished(() => {
      Object.assign(CHECKPOINT_POLICY, policy);
    });
    const v = await moodVault();
    for (const [i, hour] of ["01", "02", "03", "04", "05", "06"].entries()) await insertMood(v, hour, i + 1);
    expect(v.listAll().filter((p) => p.endsWith(".checkpoint.json"))).toEqual([
      `${LOG_DIR}/00000000000000000002.checkpoint.json`,
      `${LOG_DIR}/00000000000000000005.checkpoint.json`,
    ]);
    return v;
  }

  const paths = async (v: DbVault, asOf: { version?: number; timestamp?: string }) =>
    (await select(v.app, v.settings, { table: "mood", ...asOf })).rows.map((r) => r.path);

  it("a version older than every checkpoint replays the commits from the start", async () => {
    const v = await withCheckpoints();
    expect(await paths(v, { version: 1 })).toEqual([rowPath("01")]);
  });

  it("a timestamp starts from the newest checkpoint not after it", async () => {
    const v = await withCheckpoints();
    const r = await select(v.app, v.settings, { table: "mood", timestamp: "2026-09-01T10:03:30Z" });
    expect([r.version, r.rows.map((x) => x.path)]).toEqual([3, [rowPath("01"), rowPath("02"), rowPath("03")]]);
  });

  it("a checkpoint removed after it was listed (a sync on another device) is skipped", async () => {
    const v = await withCheckpoints();
    const checkpoint = `${LOG_DIR}/00000000000000000005.checkpoint.json`;
    const adapter = v.app.store! as unknown as { exists(p: string): Promise<boolean> };
    const exists = adapter.exists.bind(adapter);
    const spy = vi.spyOn(adapter, "exists").mockImplementation(async (p: string) => {
      if (`store:${p}` === checkpoint) fs.rmSync(v.abs(checkpoint), { force: true }); // gone right before the read
      return exists(p);
    });
    onTestFinished(() => spy.mockRestore());
    expect(await paths(v, { version: 6 })).toEqual(["01", "02", "03", "04", "05", "06"].map(rowPath));
    expect(spy).toHaveBeenCalledWith(checkpoint.slice("store:".length));
    expect(v.exists(checkpoint)).toBe(false);
  });
});

describe("syncTransactionLogs", () => {
  it("commits only the tables asked for; the others wait for the next sync", async () => {
    const v = await moodVault();
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "sleep", timeColumn: "occurred_at", columns: COLUMNS }), at(1));
    await insertMood(v, "09", 2);
    v.write("Datanotes/main/metrics/sleep/2026-09-26T2300.md", "---\ntable: main.metrics.sleep\noccurred_at: 2026-09-26T23:00\nvalue: 4\n---\n");
    v.write(rowPath("09"), v.read(rowPath("09")).replace("value: 3", "value: 5"));
    const only = await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, tables: [MOOD], now: new Date(Date.UTC(2026, 8, 1, 11)) });
    expect(only).toEqual([{ table: MOOD, version: 2, operation: EXTERNAL_EDIT }]);
    const rest = await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, now: new Date(Date.UTC(2026, 8, 1, 11, 1)) });
    expect(rest).toEqual([{ table: "main.metrics.sleep", version: 1, operation: EXTERNAL_EDIT }]);
  });

  it("a note whose YAML no longer parses keeps its last state in the log until fixed (no remove); non-rows are never added", async () => {
    const v = await moodVault();
    tolerantFrontmatter(v.app);
    await insertMood(v, "09", 1);
    const row = rowPath("09");
    const valid = v.read(row);
    v.write(row, valid.replace("value: 3", "value: [3"));
    v.write("Notes/both.md", "---\ntable: [main.metrics.mood, main.metrics.sleep]\nvalue: 2\n---\n");
    v.write("Notes/plain.md", "No properties.\n");
    const touched = [row, "Notes/both.md", "Notes/plain.md"];
    const broken = await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, touched, now: new Date(Date.UTC(2026, 8, 1, 11)) });
    expect(broken).toEqual([]);
    // fixed as it was: nothing to commit
    v.write(row, valid);
    expect(await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, touched, now: new Date(Date.UTC(2026, 8, 1, 11, 1)) })).toEqual([]);
    // broken again, then fixed with another value: one edit of the row
    v.write(row, valid.replace("value: 3", "value: [3"));
    expect(await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, touched, now: new Date(Date.UTC(2026, 8, 1, 11, 2)) })).toEqual([]);
    const fixed = valid.replace("value: 3", "value: 4");
    v.write(row, fixed);
    expect(await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, touched, now: new Date(Date.UTC(2026, 8, 1, 11, 3)) })).toEqual([
      { table: MOOD, version: 2, operation: EXTERNAL_EDIT },
    ]);
    const back = await readCommit(v.app, v.settings, MOOD, 2);
    expect([back.add.map((a) => [a.path, a.content]), back.remove.map((r) => r.path)]).toEqual([[[row, fixed]], [row]]);
  });

  it("a row that cannot be read at all (held by another program) is no broken note: the log records its removal", async () => {
    const v = await moodVault();
    await insertMood(v, "09", 1);
    const row = rowPath("09");
    v.write(row, v.read(row).replace("value: 3", "value: 4"));
    const vault = v.app.vault as unknown as { read(f: { path: string }): Promise<string> };
    const real = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (f) => {
      if (f.path === row) throw new Error("EBUSY: resource busy or locked");
      return real(f);
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    expect(await syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT, touched: [row], now: new Date(Date.UTC(2026, 8, 1, 11)) })).toEqual([
      { table: MOOD, version: 2, operation: EXTERNAL_EDIT },
    ]);
    const commit = await readCommit(v.app, v.settings, MOOD, 2);
    expect([commit.add, commit.remove.map((r) => r.path)]).toEqual([[], [row]]);
  });

  it("never overwrites a version another writer committed first", async () => {
    const v = await moodVault();
    await insertMood(v, "09", 1);
    v.write(rowPath("09"), v.read(rowPath("09")).replace("value: 3", "value: 4"));
    const target = `${LOG_DIR}/00000000000000000002.json`;
    const theirs = `${JSON.stringify({ commitInfo: { version: 2, timestamp: "2026-09-01T10:59:00.000Z", operation: "WRITE", operationMetrics: { numAddedFiles: 0, numRemovedFiles: 0, metadataChanged: false }, engineInfo: "datanotes" } })}\n`;
    const adapter = v.app.store! as unknown as { exists(p: string): Promise<boolean> };
    const exists = adapter.exists.bind(adapter);
    let raced = false;
    const spy = vi.spyOn(adapter, "exists").mockImplementation(async (p: string) => {
      if (`store:${p}` === target && !raced) {
        raced = true; // the other engine writes its version 2 right before ours
        storeFile(v, target, theirs);
      }
      return exists(p);
    });
    onTestFinished(() => spy.mockRestore());
    await expect(syncTransactionLogs(v.app, v.settings, { operation: EXTERNAL_EDIT })).rejects.toThrow(new HistoryError(`log file exists: ${target}`));
    expect(v.read(target)).toBe(theirs);
    expect(await listVersions(v.app, v.settings, MOOD)).toEqual([0, 1, 2]);
  });
});

describe("vacuum", () => {
  it("refuses a table without history, and a version the log does not hold", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS, history: false }));
    await expect(vacuumTable(v.app, v.settings, { table: "mood" })).rejects.toThrow(new OperationInputError("main.metrics.mood has no history"));
    const h = await moodVault();
    await insertMood(h, "09", 1);
    await expect(vacuumTable(h.app, h.settings, { table: "mood", retainFrom: 7 })).rejects.toThrow(
      new OperationInputError("main.metrics.mood has no version 7 (available: 0..1)"),
    );
    expect(await listVersions(h.app, h.settings, MOOD)).toEqual([0, 1]);
  });
});
