/**
 * Table history at its edges: time travel and restore refusals (version and timestamp together,
 * versions that are no integer or not in the log, a dropped table), a history read from the log
 * when metastore.yaml is gone, a restore that puts back a note that stopped being a row, and the
 * refusals of table_changes and vacuum.
 */

import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { createTable, dropTable, INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { describeHistory, loadTableAsOf, restoreTable, tableChanges, vacuumTable } from "../src/core/history";
import { insertRow, select } from "../src/core/rows";
import { TableNotFoundError } from "../src/core/table-registry";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const T = "Datanotes/main/travel/trip";
const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });

async function refused(p: Promise<unknown>, message: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(OperationInputError);
  await expect(p).rejects.toThrow(message);
}

/** `main.travel.trip`: v0 create, v1 Rome, v2 Oslo (history on, or off). */
async function trips(history = true): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { history }, async () => {});
  const columns = [
    { name: "place", type: "string", required: true, dense: true },
    { name: "days", type: "integer" },
  ];
  expect((await createTable(v.app, v.settings, described({ schema: "travel", name: "trip", options: { filename: "{place}" }, columns }), at(0))).ok).toBe(true);
  expect((await insertRow(v.app, v.settings, { table: "trip", values: { place: "Rome", days: 3 } }, at(1))).ok).toBe(true);
  expect((await insertRow(v.app, v.settings, { table: "trip", values: { place: "Oslo", days: 5 } }, at(2))).ok).toBe(true);
  return v;
}

describe("time travel and restore refuse", () => {
  it("version and timestamp together, and a version that is no non-negative integer", async () => {
    const v = await trips();
    await refused(loadTableAsOf(v.app, v.settings, "trip", { version: 1, timestamp: "2026-09-01T10:01:00Z" }), `pass "version" or "timestamp", not both`);
    await refused(loadTableAsOf(v.app, v.settings, "trip", { version: 1.5 }), `"version" must be a non-negative integer`);
    await refused(loadTableAsOf(v.app, v.settings, "trip", { version: -1 }), `"version" must be a non-negative integer`);
    await refused(restoreTable(v.app, v.settings, { table: "trip", version: -1 }), `"version" must be a non-negative integer`);
  });

  it("a version the log does not have, or a timestamp that is no date-time", async () => {
    const v = await trips();
    await refused(loadTableAsOf(v.app, v.settings, "trip", { version: 9 }), "main.travel.trip has no version 9 (available: 0..2)");
    await refused(loadTableAsOf(v.app, v.settings, "trip", { timestamp: "last week" }), `"timestamp" is not a date-time: last week`);
    await refused(restoreTable(v.app, v.settings, { table: "trip", version: 9 }), "main.travel.trip has no version 9 (available: 0..2)");
  });

  it("the version that dropped the table: it did not exist then", async () => {
    const v = await trips();
    expect((await dropTable(v.app, v.settings, { table: "trip", mode: "archive" }, at(3))).ok).toBe(true);
    await refused(loadTableAsOf(v.app, v.settings, "main.travel.trip", { version: 3 }), "main.travel.trip did not exist at version 3 (dropped)");
    const before = await loadTableAsOf(v.app, v.settings, "main.travel.trip", { version: 2 });
    expect([before.version, before.rows.map((r) => r.file.path)]).toEqual([2, [`${T}/Oslo.md`, `${T}/Rome.md`]]);
  });
});

describe("with metastore.yaml gone", () => {
  it("a table's history is read from its log by its full name; restore writes its entry back", async () => {
    const v = await trips();
    v.remove(METASTORE);
    await expect(describeHistory(v.app, v.settings, { table: "trip" })).rejects.toBeInstanceOf(TableNotFoundError);
    const h = await describeHistory(v.app, v.settings, { table: "main.travel.trip" });
    expect(h.history.map((c) => [c.version, c.operation])).toEqual([
      [2, "WRITE"],
      [1, "WRITE"],
      [0, "CREATE TABLE"],
    ]);
    const old = await loadTableAsOf(v.app, v.settings, "main.travel.trip", { version: 1 });
    expect([old.table.def.name, old.rows.map((r) => r.file.path)]).toEqual(["trip", [`${T}/Rome.md`]]);
    const r = await restoreTable(v.app, v.settings, { table: "main.travel.trip", version: 2 });
    // the table entry, and its rows put back as they were (no table defined them any more)
    expect([r.ok, r.planned_texts]).toEqual([true, [METASTORE, `${T}/Rome.md`, `${T}/Oslo.md`]]);
    expect((await select(v.app, v.settings, { table: "trip", columns: ["place"] })).rows).toEqual([
      { path: `${T}/Oslo.md`, place: "Oslo" },
      { path: `${T}/Rome.md`, place: "Rome" },
    ]);
  });
});

describe("restore_table", () => {
  it("puts back the content of a note that stopped being a row of the table", async () => {
    const v = await trips();
    const rome = v.read(`${T}/Rome.md`);
    v.write(`${T}/Rome.md`, "Just a note about Rome.\n");
    const r = await restoreTable(v.app, v.settings, { table: "trip", version: 2 });
    expect([r.ok, r.planned_texts, r.planned_creates, r.planned_deletes]).toEqual([true, [`${T}/Rome.md`], [], []]);
    expect(v.read(`${T}/Rome.md`)).toBe(rome);
  });
});

describe("table_changes refuses", () => {
  it("a table without history", async () => {
    const v = await trips(false);
    await refused(tableChanges(v.app, v.settings, { table: "trip", startVersion: 0 }), "main.travel.trip has no history");
  });

  it("versions that are no integers, a start after the end, an end after the latest", async () => {
    const v = await trips();
    const message = `"start_version" and "end_version" must be integers with start <= end`;
    await refused(tableChanges(v.app, v.settings, { table: "trip", startVersion: 2, endVersion: 1 }), message);
    await refused(tableChanges(v.app, v.settings, { table: "trip", startVersion: -1 }), message);
    await refused(tableChanges(v.app, v.settings, { table: "trip", startVersion: 0.5 }), message);
    await refused(tableChanges(v.app, v.settings, { table: "trip", startVersion: 1, endVersion: 9 }), "main.travel.trip has no version 9 (latest: 2)");
    expect((await tableChanges(v.app, v.settings, { table: "trip", startVersion: 2 })).changes.map((c) => [c._change_type, c.place])).toEqual([["insert", "Oslo"]]);
  });
});

describe("vacuum refuses", () => {
  it("a version to keep the log does not have, and a table without history", async () => {
    const v = await trips();
    await refused(vacuumTable(v.app, v.settings, { table: "trip", retainFrom: 9 }), "main.travel.trip has no version 9 (available: 0..2)");
    const off = await trips(false);
    await refused(vacuumTable(off.app, off.settings, { table: "trip" }), "main.travel.trip has no history");
  });
});
