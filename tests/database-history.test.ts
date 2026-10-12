/**
 * History of the whole database: time travel through unions, bases, joins and views (every table
 * as of one time, `version` refused where several tables are read), describe_history without a
 * table (commits of every log, one operation's commits grouped, batches), and restore_database at
 * its edges (refusals, skipped tables, rows that changed tables, archive targets taken, a lost
 * metastore.yaml, nothing to do).
 */

import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { describeDatabaseHistory, restoreDatabase } from "../src/core/database-history";
import { createTable, dropTable, INDEX_RETRY, logExternalEdits, OperationInputError, undoOperation } from "../src/core/engine";
import { createView, defineBase, setTableBases } from "../src/core/catalog-ops";
import { describeHistory, vacuumTable } from "../src/core/history";
import { MigrationNotFoundError } from "../src/core/journal";
import { createPublicApi } from "../src/core/public-api";
import { alterTable, deleteRows, insertRow, moveRows, select, updateRows } from "../src/core/rows";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });
const time = (minute: number) => at(minute).now.toISOString();
const L = "Datanotes/main/lib";

async function refused(p: Promise<unknown>, message: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(OperationInputError);
  await expect(p).rejects.toThrow(message);
}

async function ok(p: Promise<{ ok: boolean }>): Promise<void> {
  expect((await p).ok).toBe(true);
}

async function historyVault(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  return v;
}

const named = (extra: Record<string, unknown>[] = []) => [{ name: "name", type: "string", required: true }, ...extra];

/**
 * main.lib: person (Ann, Rome → Oslo at 7), book extends base item (Dune by Ann), comic (created
 * at 3, dropped at 4); the point is 10:05; after it film (extends item) with Alien.
 */
async function shelf(): Promise<DbVault> {
  const v = await historyVault();
  const { app, settings } = v;
  await ok(defineBase(app, settings, describedBase({ name: "item", columns: [{ name: "note", type: "string" }] }), at(0)));
  await ok(createTable(app, settings, described({ schema: "lib", name: "person", columns: named([{ name: "city", type: "string" }]), options: { filename: "{name}" } }), at(0)));
  await ok(createTable(app, settings, described({ schema: "lib", name: "book", columns: named([{ name: "author", type: "link", ref: "main.lib.person" }]), options: { filename: "{name}" } }), at(1)));
  await ok(setTableBases(app, settings, { table: "book", bases: ["item"] }, at(1)));
  await ok(insertRow(app, settings, { table: "person", values: { name: "Ann", city: "Rome" } }, at(2)));
  await ok(insertRow(app, settings, { table: "book", values: { name: "Dune", author: "[[Ann]]", note: "old" } }, at(2)));
  await ok(createTable(app, settings, described({ schema: "lib", name: "comic", columns: named(), options: { filename: "{name}" } }), at(3)));
  await ok(dropTable(app, settings, { table: "comic" }, at(4)));
  await ok(updateRows(app, settings, { table: "person", where: { name: "Ann" }, set: { city: "Oslo" } }, at(7)));
  await ok(createTable(app, settings, described({ schema: "lib", name: "film", columns: named(), options: { filename: "{name}" } }), at(8)));
  await ok(setTableBases(app, settings, { table: "film", bases: ["item"] }, at(8)));
  await ok(insertRow(app, settings, { table: "film", values: { name: "Alien", note: "new" } }, at(9)));
  return v;
}

describe("time travel over several tables", () => {
  const POINT = time(5);

  it("a base, a union and a view on it read every table as of the time; tables that did not exist add no rows", async () => {
    const v = await shelf();
    const base = await select(v.app, v.settings, { table: "base:item", columns: ["note"], timestamp: POINT });
    expect([base.rows, base.timestamp, base.versions]).toEqual([[{ path: `${L}/book/Dune.md`, note: "old", _source: "main.lib.book" }], POINT, { "main.lib.book": 2 }]);
    expect((await select(v.app, v.settings, { table: "base:item", columns: ["note"] })).total).toBe(2);
    // a union naming a table dropped before then, and one created after
    const union = [{ table: "book" }, { table: "film" }, { table: "main.lib.comic" }];
    const u = await select(v.app, v.settings, { table: "", union, columns: ["name"], timestamp: POINT });
    expect([u.total, u.versions]).toEqual([1, { "main.lib.book": 2 }]);
    await ok(createView(v.app, v.settings, { schema: "lib", name: "vw_all", query: { union: [{ table: "book" }, { table: "film" }], columns: ["name"] } }, at(10)));
    const view = await select(v.app, v.settings, { table: "vw_all", timestamp: POINT });
    expect([view.view, view.total, view.versions]).toEqual(["main.lib.vw_all", 1, { "main.lib.book": 2 }]);
  });

  it("a join reads its right table as of the same time", async () => {
    const v = await shelf();
    const join = { table: "person", on: { author: "file_link" }, as: "who", columns: ["city"] };
    const then = await select(v.app, v.settings, { table: "book", columns: ["name"], join, timestamp: POINT });
    expect(then.rows[0]!.who).toEqual([{ path: `${L}/person/Ann.md`, city: "Rome" }]);
    expect([then.version, then.versions]).toEqual([2, { "main.lib.book": 2, "main.lib.person": 1 }]);
    expect((await select(v.app, v.settings, { table: "book", columns: ["name"], join })).rows[0]!.who).toEqual([{ path: `${L}/person/Ann.md`, city: "Oslo" }]);
  });

  it("`version` is refused where several tables are read", async () => {
    const v = await shelf();
    const way = `pass "timestamp" instead (every table is read as of that time)`;
    await refused(select(v.app, v.settings, { table: "base:item", version: 1 }), `"version" numbers the versions of one table, and base:item reads every table that extends it: ${way}`);
    await refused(select(v.app, v.settings, { table: "", union: [{ table: "book" }, { table: "film" }], version: 1 }), "a union reads several tables");
    await refused(select(v.app, v.settings, { table: "book", version: 1, join: { table: "person", on: { author: "file_link" } } }), "a join reads two tables");
    // a base no table extends yet refuses it too
    await ok(defineBase(v.app, v.settings, describedBase({ name: "empty", columns: [{ name: "x", type: "string" }] }), at(10)));
    await refused(select(v.app, v.settings, { table: "base:empty", version: 1 }), "base:empty reads every table");
  });
});

describe("describe_history of the database", () => {
  it("every logged table, newest first; one operation's commits across tables and a batch's are grouped; since and limit", async () => {
    const v = await shelf();
    // a hand edit: no migrationId, no group
    v.write(`${L}/film/Alien.md`, v.read(`${L}/film/Alien.md`).replace("note: new", "note: newer"));
    await logExternalEdits(v.app, v.settings);
    // one operation, two tables: the person is deleted and the book's link to her cleared
    const del = await deleteRows(v.app, v.settings, { table: "person", where: { name: "Ann" }, onReferenced: "set_null" });
    const api = createPublicApi(v.app, () => v.settings);
    const batch = await api.batch({ operations: [{ op: "insert_row", table: "person", values: { name: "Bo" } }, { op: "insert_row", table: "film", values: { name: "Heat" } }] });
    const h = await describeDatabaseHistory(v.app, v.settings);
    expect(h.tables).toEqual(["main.lib.book", "main.lib.comic", "main.lib.film", "main.lib.person"]);
    const top = h.history.slice(0, 5).map((c) => ({ table: c.table, operation: c.operation, batch: c.batch, tables: c.tables }));
    expect(top.slice(0, 2).sort((a, b) => a.table.localeCompare(b.table))).toEqual([
      { table: "main.lib.film", operation: "WRITE", batch: batch.migration_id, tables: ["main.lib.film", "main.lib.person"] },
      { table: "main.lib.person", operation: "WRITE", batch: batch.migration_id, tables: ["main.lib.film", "main.lib.person"] },
    ]);
    expect(top.slice(2, 4)).toEqual([
      { table: "main.lib.book", operation: "DELETE", batch: undefined, tables: ["main.lib.book", "main.lib.person"] },
      { table: "main.lib.person", operation: "DELETE", batch: undefined, tables: ["main.lib.book", "main.lib.person"] },
    ]);
    expect(h.history[2]!.migrationId).toBe(del.migration_id);
    expect(top[4]).toEqual({ table: "main.lib.film", operation: "EXTERNAL_EDIT", batch: undefined, tables: undefined });
    expect(h.history.at(-1)).toMatchObject({ table: "main.lib.person", version: 0, timestamp: time(0) });
    const since8 = (await describeDatabaseHistory(v.app, v.settings, { since: time(8), limit: 100 })).history;
    expect(since8.filter((c) => c.timestamp.startsWith("2026-09-01")).map((c) => `${c.table} ${c.version}`)).toEqual(["main.lib.film 2", "main.lib.film 1", "main.lib.film 0"]);
    expect((await describeDatabaseHistory(v.app, v.settings, { limit: 0 })).history).toEqual([]);
    await refused(describeDatabaseHistory(v.app, v.settings, { since: "later" }), `"since" is not a date or date-time: later`);
  });

  it("a table's history since a time", async () => {
    const v = await shelf();
    expect((await describeHistory(v.app, v.settings, { table: "person", since: time(2) })).history.map((c) => c.version)).toEqual([2, 1]);
    expect((await describeHistory(v.app, v.settings, { table: "person", since: time(2), limit: 1 })).history.map((c) => c.version)).toEqual([2]);
    await refused(describeHistory(v.app, v.settings, { table: "person", since: "x" }), `"since" is not a date or date-time: x`);
  });
});

describe("restore_database", () => {
  it("refuses a missing or doubled moment, a timestamp that is no date-time, an unknown operation, one that changed no logged table", async () => {
    const v = await shelf();
    await refused(restoreDatabase(v.app, v.settings, {}), `pass "timestamp" or "before_migration" (one of them)`);
    await refused(restoreDatabase(v.app, v.settings, { timestamp: time(1), beforeMigration: "x" }), "one of them");
    await refused(restoreDatabase(v.app, v.settings, { timestamp: "yesterday" }), `"timestamp" is not a date-time: yesterday`);
    await expect(restoreDatabase(v.app, v.settings, { beforeMigration: "nope" })).rejects.toBeInstanceOf(MigrationNotFoundError);
    await ok(alterTable(v.app, v.settings, { table: "film", history: false }, at(10)));
    const off = await insertRow(v.app, v.settings, { table: "film", values: { name: "Heat" } }, at(11));
    await refused(restoreDatabase(v.app, v.settings, { beforeMigration: off.migration_id! }), `${off.migration_id} changed no table that keeps a transaction log`);
    // nothing to restore: the hint points to undo_migration, never to a timestamp that restores nothing
    await expect(restoreDatabase(v.app, v.settings, { beforeMigration: off.migration_id! })).rejects.toMatchObject({
      hint: expect.stringContaining(`undo_migration (migration_id "${off.migration_id}")`),
      docs: "https://datanotes.dev/guides/history/journal-and-undo.md#undo-a-write",
    });
    expect((await restoreDatabase(v.app, v.settings, { timestamp: time(10) })).tables.map((t) => t.table)).not.toContain("main.lib.film");
  });

  it("to just before one operation: the tables it changed and every change after it", async () => {
    const v = await shelf();
    const before = v.list().filter((p) => !p.startsWith(".")).map((p) => [p, v.read(p)]);
    const r = await restoreDatabase(v.app, v.settings, { beforeMigration: (await updateRows(v.app, v.settings, { table: "person", where: { name: "Ann" }, set: { city: "Paris" } }, at(12))).migration_id! }, at(13));
    expect([r.ok, r.restored_to, r.tables.map((t) => t.table)]).toEqual([true, new Date(Date.parse(time(12)) - 1).toISOString(), ["main.lib.person"]]);
    expect(v.read(`${L}/person/Ann.md`)).toContain("city: Oslo");
    expect(v.list().filter((p) => !p.startsWith(".")).map((p) => [p, v.read(p)])).toEqual(before);
  });

  it("tables it cannot rewind are skipped with the reason: history off, nothing logged yet, history vacuumed", async () => {
    const v = await shelf();
    await ok(alterTable(v.app, v.settings, { table: "film", history: false }, at(10)));
    await configureDatabase(v.app, v.settings, { history: false }, async () => {});
    await ok(createTable(v.app, v.settings, described({ schema: "lib", name: "draft", columns: named(), options: { filename: "{name}" } }), at(11)));
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    await vacuumTable(v.app, v.settings, { table: "person" });
    const r = await restoreDatabase(v.app, v.settings, { timestamp: time(5) }, { dryRun: true });
    expect(r.skipped).toEqual([
      { table: "main.lib.draft", reason: "nothing is logged for it yet (its log starts with the next write)" },
      { table: "main.lib.film", reason: expect.stringContaining("history is off for it") },
      { table: "main.lib.person", reason: `its history before version 2 (${time(7)}) was removed by vacuum_table` },
    ]);
    // the book and the comic dropped before then are already as they were: nothing to do, nothing written
    expect([r.ok, r.dry_run, r.tables, r.unchanged, r.migration_id]).toEqual([true, true, [], ["main.lib.book", "main.lib.comic"], undefined]);
    const real = await restoreDatabase(v.app, v.settings, { timestamp: time(5) });
    expect([real.ok, real.dry_run, real.migration_id]).toEqual([true, false, undefined]);
  });

  it("a row that moved to a table created since goes back; the new table is dropped without archiving it", async () => {
    const v = await shelf();
    await ok(createTable(v.app, v.settings, described({ schema: "lib", name: "saga", columns: named([{ name: "author", type: "link", ref: "main.lib.person" }, { name: "note", type: "string" }]), options: { filename: "{name}" } }), at(10)));
    await ok(moveRows(v.app, v.settings, { table: "book", toTable: "saga", where: { name: "Dune" } }, at(11)));
    expect(v.read(`${L}/book/Dune.md`)).toContain("table: main.lib.saga");
    const r = await restoreDatabase(v.app, v.settings, { timestamp: time(9) }, at(12));
    const plan = Object.fromEntries(r.tables.map((t) => [t.table, t]));
    expect(plan["main.lib.book"]).toMatchObject({ action: "restore", texts: [`${L}/book/Dune.md`], deletes: [] });
    expect(plan["main.lib.saga"]).toMatchObject({ action: "drop", version: null, definition_changed: true, archived: [], deletes: [] });
    expect(v.read(`${L}/book/Dune.md`)).toContain("table: main.lib.book");
    expect((await select(v.app, v.settings, { table: "book", columns: ["name"] })).total).toBe(1);
    expect((await undoOperation(v.app, v.settings, r.migration_id!)).ok).toBe(true);
    expect(v.read(`${L}/book/Dune.md`)).toContain("table: main.lib.saga");
  });

  it("refused when the archive folder of a table it drops already has a note of that name", async () => {
    const v = await shelf();
    v.write(`${L}/film/_archive/Alien.md`, "an older Alien\n");
    const r = await restoreDatabase(v.app, v.settings, { timestamp: time(5) });
    expect([r.ok, r.conflicts]).toEqual([false, [{ path: `${L}/film/Alien.md`, message: `archive target exists: ${L}/film/_archive/Alien.md` }]]);
    expect(r.tables.find((t) => t.table === "main.lib.film")).toMatchObject({ action: "drop", archived: [{ from: `${L}/film/Alien.md`, to: `${L}/film/_archive/Alien.md` }] });
  });

  it("with metastore.yaml gone, the tables come back from their logs; rows still in place are left as they are", async () => {
    const v = await historyVault();
    await ok(createTable(v.app, v.settings, described({ schema: "lib", name: "person", columns: named([{ name: "city", type: "string" }]), options: { filename: "{name}" } }), at(0)));
    await ok(insertRow(v.app, v.settings, { table: "person", values: { name: "Ann", city: "Rome" } }, at(1)));
    const ann = v.read(`${L}/person/Ann.md`);
    v.remove(METASTORE);
    const r = await restoreDatabase(v.app, v.settings, { timestamp: time(2) });
    expect([r.ok, r.planned_texts, r.planned_creates, r.tables.map((t) => `${t.table} ${t.action}`)]).toEqual([true, [METASTORE], [], ["main.lib.person recreate"]]);
    expect(v.read(`${L}/person/Ann.md`)).toBe(ann);
    expect((await select(v.app, v.settings, { table: "person", columns: ["city"] })).rows).toEqual([{ path: `${L}/person/Ann.md`, city: "Rome" }]);
  });
});
