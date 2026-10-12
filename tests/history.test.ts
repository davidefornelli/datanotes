import { describe, expect, it, onTestFinished } from "vitest";
import { CHECKPOINT_POLICY, listVersions, parseCommit } from "../src/core/transaction-log";
import { createTable, dropTable, INDEX_RETRY, logExternalEdits, undoOperation } from "../src/core/engine";
import { describeHistory, restoreTable, tableChanges, vacuumTable } from "../src/core/history";
import { alterTable, deleteRows, insertRow, select, updateRows } from "../src/core/rows";
import { configureDatabase } from "../src/core/database";
import { createDbVault, type DbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

/** A vault with time travel on (it is off by default). */
async function historyVault(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  return v;
}

INDEX_RETRY.delayMs = 1;

const COLUMNS = [
  { name: "occurred_at", type: "datetime", required: true, dense: true },
  { name: "value", type: "integer", min: 1, max: 5, dense: true },
];

const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });

/** mood with history: v0 create, v1-v2 inserts, v3 update, v4 delete, v5 hand edit. */
async function moodWithHistory(): Promise<DbVault> {
  const v = await historyVault();
  await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }), at(0));
  await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } }, at(1));
  await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T10:00", value: 3 } }, at(2));
  await updateRows(v.app, v.settings, { table: "mood", where: { occurred_at: "2026-09-26T09:00" }, set: { value: 4 } }, at(3));
  await deleteRows(v.app, v.settings, { table: "mood", where: { occurred_at: "2026-09-26T10:00" } }, at(4));
  v.write("Datanotes/main/metrics/mood/2026-09-26T0900.md", v.read("Datanotes/main/metrics/mood/2026-09-26T0900.md").replace("value: 4", "value: 5"));
  await logExternalEdits(v.app, v.settings);
  return v;
}

const values = async (v: DbVault, extra: Record<string, unknown> = {}) =>
  (await select(v.app, v.settings, { table: "mood", ...extra })).rows.map((r) => [r.path, r.value]);

describe("transaction log", () => {
  it("records one commit per operation, hand edits included", async () => {
    const v = await moodWithHistory();
    const h = await describeHistory(v.app, v.settings, { table: "mood" });
    expect(h.table).toBe("main.metrics.mood");
    expect(h.history.map((c) => [c.version, c.operation])).toEqual([
      [5, "EXTERNAL_EDIT"],
      [4, "DELETE"],
      [3, "UPDATE"],
      [2, "WRITE"],
      [1, "WRITE"],
      [0, "CREATE TABLE"],
    ]);
    expect(h.history[3]!.timestamp).toBe("2026-09-01T10:02:00.000Z");
    expect(h.history[4]!.operationMetrics).toEqual({ numAddedFiles: 1, numRemovedFiles: 0, metadataChanged: false });
    expect(h.history[1]!.migrationId).toMatch(/.+/);
    const commit = parseCommit(v.read("store:transaction_log/main.metrics.mood/00000000000000000003.json"));
    expect(commit.remove.map((r) => r.path)).toEqual(["Datanotes/main/metrics/mood/2026-09-26T0900.md"]);
    expect(commit.add[0]!.content).toContain("value: 4");
    // nothing changed: no new commit
    expect(await logExternalEdits(v.app, v.settings)).toEqual([]);
  });

  it("time travel by version and by timestamp", async () => {
    const v = await moodWithHistory();
    const p1 = "Datanotes/main/metrics/mood/2026-09-26T0900.md";
    const p2 = "Datanotes/main/metrics/mood/2026-09-26T1000.md";
    expect(await values(v)).toEqual([[p1, 5]]);
    expect(await values(v, { version: 1 })).toEqual([[p1, 2]]);
    expect(await values(v, { version: 3 })).toEqual([[p1, 4], [p2, 3]]);
    const r = await select(v.app, v.settings, { table: "mood", timestamp: "2026-09-01T10:02:30Z", where: { value: { gte: 3 } } });
    expect([r.version, r.total]).toEqual([2, 1]);
    await expect(select(v.app, v.settings, { table: "mood", version: 9 })).rejects.toThrow(/no version 9/);
    await expect(select(v.app, v.settings, { table: "mood", timestamp: "2026-08-01T00:00:00Z" })).rejects.toThrow(/did not exist/);
  });

  it("table_changes returns the change data feed", async () => {
    const v = await moodWithHistory();
    const { changes } = await tableChanges(v.app, v.settings, { table: "mood", startVersion: 1 });
    expect(changes.map((c) => [c._commit_version, c._change_type, c.value])).toEqual([
      [1, "insert", 2],
      [2, "insert", 3],
      [3, "update_preimage", 2],
      [3, "update_postimage", 4],
      [4, "delete", 3],
      [5, "update_preimage", 4],
      [5, "update_postimage", 5],
    ]);
    expect(changes[0]).not.toHaveProperty("table");
    expect((await tableChanges(v.app, v.settings, { table: "mood", startVersion: 3, endVersion: 3 })).changes).toHaveLength(2);
  });

  it("restore_table brings rows back and is itself a new version, undoable", async () => {
    const v = await moodWithHistory();
    const r = await restoreTable(v.app, v.settings, { table: "mood", version: 2 }, at(10));
    expect(r.ok).toBe(true);
    expect(r.planned_creates).toEqual(["Datanotes/main/metrics/mood/2026-09-26T1000.md"]);
    expect(await values(v)).toEqual([
      ["Datanotes/main/metrics/mood/2026-09-26T0900.md", 2],
      ["Datanotes/main/metrics/mood/2026-09-26T1000.md", 3],
    ]);
    expect((await describeHistory(v.app, v.settings, { table: "mood", limit: 1 })).history[0]!.operation).toBe("RESTORE");
    const undo = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(undo.ok).toBe(true);
    expect(await values(v)).toEqual([["Datanotes/main/metrics/mood/2026-09-26T0900.md", 5]]);
    const top = (await describeHistory(v.app, v.settings, { table: "mood", limit: 1 })).history[0]!;
    expect([top.version, top.operation]).toEqual([7, "UNDO"]);
  });

  it("writes checkpoints, and vacuum drops older history", async () => {
    const policy = { ...CHECKPOINT_POLICY };
    CHECKPOINT_POLICY.maxVersions = 10;
    onTestFinished(() => {
      Object.assign(CHECKPOINT_POLICY, policy);
    });
    const v = await historyVault();
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    for (let i = 0; i < 11; i++) {
      await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: `2026-09-${String(10 + i).padStart(2, "0")}T09:00`, value: 1 } });
    }
    // 10 commits (v0..v9) since the start: checkpoint at version 9.
    expect(v.exists("store:transaction_log/main.metrics.mood/00000000000000000009.checkpoint.json")).toBe(true);
    expect((await select(v.app, v.settings, { table: "mood", version: 10 })).total).toBe(10);
    const dry = await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 10 }, { dryRun: true });
    expect(dry.deleted).toHaveLength(11); // commits 0..9 and checkpoint 9
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toHaveLength(12);
    await vacuumTable(v.app, v.settings, { table: "mood", retainFrom: 10 });
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toEqual([10, 11]);
    expect((await select(v.app, v.settings, { table: "mood", version: 10 })).total).toBe(10);
    await expect(select(v.app, v.settings, { table: "mood", version: 5 })).rejects.toThrow(/no version 5/);
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-30T09:00", value: 1 } });
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toEqual([10, 11, 12]);
  });

  it("history follows a renamed table and outlives a dropped one", async () => {
    const v = await moodWithHistory();
    await alterTable(v.app, v.settings, { table: "mood", name: "feeling" }, at(20));
    const h = await describeHistory(v.app, v.settings, { table: "feeling" });
    expect(h.history.map((c) => c.operation).slice(0, 2)).toEqual(["ALTER TABLE", "EXTERNAL_EDIT"]);
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toEqual([]);
    const drop = await dropTable(v.app, v.settings, { table: "feeling", mode: "archive" }, at(21));
    expect(drop.ok).toBe(true);
    const after = await describeHistory(v.app, v.settings, { table: "main.metrics.feeling", limit: 1 });
    expect(after.history[0]!.operation).toBe("DROP TABLE");
    const back = await restoreTable(v.app, v.settings, { table: "main.metrics.feeling", version: 6 }, at(22));
    expect(back.ok).toBe(true);
    expect((await select(v.app, v.settings, { table: "feeling" })).rows.map((r) => r.value)).toEqual([5]);
  });

  it("undoing a rename or a move takes the whole log back: commits made under the new name follow it", async () => {
    const v = await moodWithHistory();
    const renamed = await alterTable(v.app, v.settings, { table: "mood", name: "feeling" }, at(20));
    await updateRows(v.app, v.settings, { table: "feeling", set: { value: 3 } }, at(21));
    expect(await listVersions(v.app, v.settings, "main.metrics.feeling")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const undo = await undoOperation(v.app, v.settings, renamed.migration_id!);
    expect(undo.ok, JSON.stringify(undo.conflicts)).toBe(true);
    expect(await listVersions(v.app, v.settings, "main.metrics.feeling")).toEqual([]);
    const h = await describeHistory(v.app, v.settings, { table: "mood", limit: 4 });
    expect(h.history.map((c) => [c.version, c.operation])).toEqual([[8, "UNDO"], [7, "UPDATE"], [6, "ALTER TABLE"], [5, "EXTERNAL_EDIT"]]);
    expect(await values(v)).toEqual([["Datanotes/main/metrics/mood/2026-09-26T0900.md", 3]]);
    expect(await values(v, { version: 5 })).toEqual([["Datanotes/main/metrics/mood/2026-09-26T0900.md", 5]]);
    expect(await values(v, { version: 7 })).toEqual([["Datanotes/main/metrics/feeling/2026-09-26T0900.md", 3]]);
    // to another schema, and back
    const moved = await alterTable(v.app, v.settings, { table: "mood", schema: "logs" }, at(22));
    expect(await listVersions(v.app, v.settings, "main.logs.mood")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await undoOperation(v.app, v.settings, moved.migration_id!)).ok).toBe(true);
    expect(await listVersions(v.app, v.settings, "main.logs.mood")).toEqual([]);
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("an undo of a rename is refused, nothing moved, when the old name has a log again", async () => {
    const v = await moodWithHistory();
    const renamed = await alterTable(v.app, v.settings, { table: "mood", name: "feeling" }, at(20));
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }), at(21));
    const undo = await undoOperation(v.app, v.settings, renamed.migration_id!);
    expect(undo.ok).toBe(false);
    expect(undo.conflicts).toContainEqual({ path: "store:transaction_log/main.metrics.mood/00000000000000000000.json", message: "original path is occupied" });
    expect(await listVersions(v.app, v.settings, "main.metrics.feeling")).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("an undo of a rename takes back what vacuum left of the log", async () => {
    const v = await moodWithHistory();
    const renamed = await alterTable(v.app, v.settings, { table: "mood", name: "feeling" }, at(20));
    await vacuumTable(v.app, v.settings, { table: "feeling", retainFrom: 5 });
    expect((await undoOperation(v.app, v.settings, renamed.migration_id!)).ok).toBe(true);
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toEqual([5, 6, 7]);
    expect(await values(v, { version: 5 })).toEqual([["Datanotes/main/metrics/mood/2026-09-26T0900.md", 5]]);
  });

  it("checkpoints by bytes written, not by version count", async () => {
    const v = await historyVault();
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    for (let i = 0; i < 25; i++) {
      await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: `2026-09-${String(1 + i).padStart(2, "0")}T09:00`, value: 1 } });
    }
    // 26 small commits stay far below the byte threshold: no checkpoint, history intact.
    expect(v.listAll().filter((p) => p.endsWith(".checkpoint.json"))).toEqual([]);
    expect((await select(v.app, v.settings, { table: "mood", version: 12 })).total).toBe(12);
    const policy = { ...CHECKPOINT_POLICY };
    CHECKPOINT_POLICY.minBytes = 1;
    onTestFinished(() => {
      Object.assign(CHECKPOINT_POLICY, policy);
    });
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-30T09:00", value: 1 } });
    expect(v.listAll().filter((p) => p.endsWith(".checkpoint.json"))).toEqual(["store:transaction_log/main.metrics.mood/00000000000000000026.checkpoint.json"]);
    expect((await select(v.app, v.settings, { table: "mood", version: 26 })).total).toBe(26);
  });

  it("is on in a database the engine creates", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    expect(v.read(METASTORE)).toMatch(/^config:\n  history: true$/m);
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    expect((await select(v.app, v.settings, { table: "mood" })).total).toBe(1);
    expect((await listVersions(v.app, v.settings, "main.metrics.mood")).length).toBeGreaterThan(0);
  });

  it("is off in an existing database without the setting; a table can opt in or out", async () => {
    // a metastore written before history was on by default: no `history` in its config
    const v = createDbVault({ [METASTORE]: "catalogs: {}\n" });
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "sleep", timeColumn: "occurred_at", columns: COLUMNS }));
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    expect(v.listAll().filter((p) => p.includes("transaction_log"))).toEqual([]);
    await expect(select(v.app, v.settings, { table: "mood", version: 0 })).rejects.toThrow(/time travel is off/);
    // Opt one table in: its log starts at the current state.
    expect((await alterTable(v.app, v.settings, { table: "mood", history: true })).ok).toBe(true);
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-27T09:00", value: 3 } });
    await insertRow(v.app, v.settings, { table: "sleep", values: { occurred_at: "2026-09-27T09:00", value: 3 } });
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toEqual([0, 1]);
    expect(await listVersions(v.app, v.settings, "main.metrics.sleep")).toEqual([]);
    expect((await select(v.app, v.settings, { table: "mood", version: 0 })).total).toBe(1);
    // Global on, one table out.
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    expect((await alterTable(v.app, v.settings, { table: "mood", history: false })).ok).toBe(true);
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-28T09:00", value: 4 } });
    await insertRow(v.app, v.settings, { table: "sleep", values: { occurred_at: "2026-09-28T09:00", value: 4 } });
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toEqual([0, 1]); // paused, kept
    // sleep: version 0 = snapshot when history turned on (next operation), version 1 = the insert
    expect(await listVersions(v.app, v.settings, "main.metrics.sleep")).toEqual([0, 1]);
    expect(v.read(METASTORE)).toMatch(/history: false/);
  });

  it("logs rows whose frontmatter has lists of mappings (e.g. TaskNotes reminders)", async () => {
    const v = await historyVault();
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }), at(0));
    v.write(
      "Datanotes/main/metrics/mood/2026-09-26T0900.md",
      "---\ntable: main.metrics.mood\noccurred_at: 2026-09-26T09:00\nvalue: 3\nreminders:\n  - id: r1\n    type: relative\n    offset: -PT30M\n---\n",
    );
    await logExternalEdits(v.app, v.settings);
    const h = await describeHistory(v.app, v.settings, { table: "mood" });
    expect(h.history[0]!.operationMetrics).toMatchObject({ numAddedFiles: 1 });
  });
});
