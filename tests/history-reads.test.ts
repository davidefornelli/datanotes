/**
 * History reads that do less work answer as before: table_changes applies each commit of its range
 * to the version before it (no replay per version), describe_history reads each commit's first
 * line, and time travel keeps its replays while the table's log and the moves of the database
 * folder are unchanged.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { describeHistory, loadTableAsOf, tableChanges, TIME_TRAVEL_CACHE, vacuumTable, type TableChange } from "../src/core/history";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { deleteRows, insertRow, select, updateRows } from "../src/core/rows";
import { storeGeneration } from "../src/core/store";
import { listVersions, readCommit, tableStateAt, transactionLogDir } from "../src/core/transaction-log";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const TRIP = "main.travel.trip";
const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });
const limits = { ...TIME_TRAVEL_CACHE };
afterEach(() => {
  Object.assign(TIME_TRAVEL_CACHE, limits);
  vi.restoreAllMocks();
});

/** `trip` with history: v0 create, then inserts, updates and deletes, and a move of the database folder at v6. */
async function trips(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  const columns = [
    { name: "place", type: "string", required: true, dense: true },
    { name: "days", type: "integer" },
    { name: "with", type: "link" },
  ];
  expect((await createTable(v.app, v.settings, described({ schema: "travel", name: "trip", options: { filename: "{place}" }, columns }), at(0))).ok).toBe(true);
  for (const [i, place] of ["Rome", "Oslo", "Lima"].entries()) {
    expect((await insertRow(v.app, v.settings, { table: "trip", values: { place, days: i + 1 } }, at(i + 1))).ok).toBe(true);
  }
  expect((await updateRows(v.app, v.settings, { table: "trip", where: { place: "Rome" }, set: { days: 9, with: "[[Datanotes/main/travel/trip/Oslo]]" } }, at(4))).ok).toBe(true);
  expect((await deleteRows(v.app, v.settings, { table: "trip", where: { place: "Lima" }, mode: "delete" }, at(5))).ok).toBe(true);
  await configureDatabase(v.app, v.settings, { root: "Travel/DB" }, async () => {});
  expect((await insertRow(v.app, v.settings, { table: "trip", values: { place: "Kyiv", days: 4, with: "[[Travel/DB/main/travel/trip/Rome]]" } }, at(7))).ok).toBe(true);
  expect((await updateRows(v.app, v.settings, { table: "trip", where: { place: "Oslo" }, set: { days: 6 } }, at(8))).ok).toBe(true);
  return v;
}

/** table_changes as it was: the log replayed up to each version of the range. */
async function replayedChanges(v: DbVault, start: number, end: number): Promise<TableChange[]> {
  const values = (content: string) => Object.fromEntries(readOrderedFromMarkdown(content, new Set([v.settings.tableKey])).ordered.filter(([k]) => k !== v.settings.tableKey));
  const out: TableChange[] = [];
  let prev = start === 0 ? null : await tableStateAt(v.app, v.settings, TRIP, { version: start - 1 });
  for (const ver of await listVersions(v.app, v.settings, TRIP)) {
    if (ver < start || ver > end) continue;
    const c = await readCommit(v.app, v.settings, TRIP, ver);
    const meta = { _commit_version: ver, _commit_timestamp: c.commitInfo.timestamp, _operation: c.commitInfo.operation };
    if (c.metaData !== undefined && ver > 0) out.push({ _change_type: "metadata", ...meta });
    for (const r of c.remove) {
      const after = c.add.find((a) => a.path === r.path);
      out.push({ ...values(prev!.files.get(r.path)!.content), path: r.path, _change_type: after ? "update_preimage" : "delete", ...meta });
      if (after) out.push({ ...values(after.content), path: r.path, _change_type: "update_postimage", ...meta });
    }
    for (const a of c.add) if (!c.remove.some((r) => r.path === a.path)) out.push({ ...values(a.content), path: a.path, _change_type: "insert", ...meta });
    prev = await tableStateAt(v.app, v.settings, TRIP, { version: ver });
  }
  return out;
}

describe("table_changes", () => {
  it("applies each commit to the version before it: the same changes as replaying every version, a move of the database folder included", async () => {
    const v = await trips();
    const latest = (await listVersions(v.app, v.settings, TRIP)).at(-1)!;
    expect(latest).toBe(8);
    for (const [start, end] of [[0, latest], [1, latest], [4, 6], [5, 5], [6, latest], [3, 7]] as const) {
      const r = await tableChanges(v.app, v.settings, { table: "trip", startVersion: start, endVersion: end });
      expect(r.changes, `${start}..${end}`).toEqual(await replayedChanges(v, start, end));
    }
    const all = await tableChanges(v.app, v.settings, { table: "trip", startVersion: 0 });
    // the paths are today's, before the move too
    expect(all.changes.filter((c) => c._change_type !== "metadata").every((c) => String(c.path).startsWith("Travel/DB/"))).toBe(true);
    expect(all.changes.map((c) => c._change_type)).toContain("update_preimage");
  });
});

describe("describe_history", () => {
  it("reads the newest commits' first lines: the same infos, and a limit that is no count keeps as many as before", async () => {
    const v = await trips();
    const h = await describeHistory(v.app, v.settings, { table: "trip" });
    expect(h.history.map((c) => c.version)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(h.history[2]).toMatchObject({ operation: "MOVE DATABASE" });
    for (const [limit, n] of [[3, 3], [2.5, 2], [0, 0], [-4, 0], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 9]] as const) {
      expect((await describeHistory(v.app, v.settings, { table: "trip", limit })).history.map((c) => c.version), String(limit)).toEqual(h.history.slice(0, n).map((c) => c.version));
    }
    const since = await describeHistory(v.app, v.settings, { table: "trip", since: "2026-09-01T10:04:00Z", limit: 3 });
    expect(since.history.map((c) => c.version)).toEqual([8, 7, 6]);
  });
});

describe("time travel keeps its replays", () => {
  it("a second read of the same version or time is not replayed again, and answers the same", async () => {
    const v = await trips();
    const first = await select(v.app, v.settings, { table: "trip", version: 4 });
    const replays = vi.spyOn(await import("../src/core/transaction-log"), "tableStateAt");
    const again = await select(v.app, v.settings, { table: "trip", version: 4 });
    expect(again).toEqual(first);
    expect(first.rows.map((r) => [r.place, r.days])).toEqual([["Lima", 3], ["Oslo", 2], ["Rome", 9]]);
    const byTime = await select(v.app, v.settings, { table: "trip", timestamp: "2026-09-01T10:02:30Z" });
    expect(byTime.rows.map((r) => r.place)).toEqual(["Oslo", "Rome"]);
    expect((await select(v.app, v.settings, { table: "trip", timestamp: "2026-09-01T10:02:30Z" })).rows).toEqual(byTime.rows);
    // each caller gets rows and a definition of its own: changing them changes no later read
    const hist = await loadTableAsOf(v.app, v.settings, "trip", { version: 4 });
    (hist.rows[0]!.ordered as [string, unknown][]).push(["days", 100]);
    hist.table.catalog.entry.description = "changed";
    expect((await select(v.app, v.settings, { table: "trip", version: 4 })).rows).toEqual(first.rows);
    expect((await loadTableAsOf(v.app, v.settings, "trip", { version: 4 })).table.catalog.entry.description).not.toBe("changed");
    // replayed once: the first read by that time (version 4 was replayed before the spy)
    expect(replays).toHaveBeenCalledTimes(1);
  });

  it("a new commit moves the table's log: a time that now names a newer version reads it", async () => {
    const v = await trips();
    const future = "2030-01-01T00:00:00Z";
    expect((await select(v.app, v.settings, { table: "trip", timestamp: future })).version).toBe(8);
    const gen = storeGeneration(v.app, transactionLogDir(v.settings, TRIP));
    expect((await insertRow(v.app, v.settings, { table: "trip", values: { place: "Faro", days: 1 } }, at(9))).ok).toBe(true);
    expect(storeGeneration(v.app, transactionLogDir(v.settings, TRIP))).toBeGreaterThan(gen);
    const now = await select(v.app, v.settings, { table: "trip", timestamp: future });
    expect([now.version, now.rows.map((r) => r.place)]).toEqual([9, ["Faro", "Kyiv", "Oslo", "Rome"]]);
  });

  it("a vacuum drops the versions it removed, and a move of the database folder gives today's paths", async () => {
    const v = await trips();
    expect((await select(v.app, v.settings, { table: "trip", version: 2 })).rows.map((r) => r.path)).toEqual(["Travel/DB/main/travel/trip/Oslo.md", "Travel/DB/main/travel/trip/Rome.md"]);
    await configureDatabase(v.app, v.settings, { root: "Away" }, async () => {});
    expect((await select(v.app, v.settings, { table: "trip", version: 2 })).rows.map((r) => r.path)).toEqual(["Away/main/travel/trip/Oslo.md", "Away/main/travel/trip/Rome.md"]);
    await vacuumTable(v.app, v.settings, { table: "trip", retainFrom: 5 }, { dryRun: false });
    await expect(select(v.app, v.settings, { table: "trip", version: 2 })).rejects.toThrow("main.travel.trip has no version 2");
    expect((await select(v.app, v.settings, { table: "trip", version: 5 })).rows.map((r) => r.place)).toEqual(["Oslo", "Rome"]);
  });

  it("within its budget: the least recently read out first, a replay larger than the budget not kept", async () => {
    const v = await trips();
    const read = async (version: number) => (await select(v.app, v.settings, { table: "trip", version })).rows.map((r) => [r.place, r.days]);
    const replays = vi.spyOn(await import("../src/core/transaction-log"), "tableStateAt");
    TIME_TRAVEL_CACHE.maxEntries = 2;
    const want = new Map<number, unknown>();
    for (const ver of [1, 2, 3, 4]) want.set(ver, await read(ver));
    expect(replays).toHaveBeenCalledTimes(4);
    // 3 and 4 are kept; 1 and 2 were let go
    for (const ver of [4, 3, 1, 4, 2, 2, 3]) expect(await read(ver), `version ${ver}`).toEqual(want.get(ver));
    expect(replays).toHaveBeenCalledTimes(8);
    TIME_TRAVEL_CACHE.maxChars = 10;
    for (const ver of [4, 4, 1]) expect(await read(ver)).toEqual(want.get(ver));
    expect(replays).toHaveBeenCalledTimes(11);
  });
});
