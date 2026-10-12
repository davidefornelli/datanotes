/**
 * Moves of the database folder (configure_database root, or by hand and found again by its id):
 * recorded in the store, the journal and every table's history, so undo of an operation made
 * before the move finds its rows, time travel and restores give today's paths, and links into the
 * old folder are repaired. Also the database id in metastore.yaml, and journal entries of older
 * engines read as they are today.
 */

import { describe, expect, it } from "vitest";
import { metastoreId, newDatabaseId, withMetastoreId } from "../src/core/database-id";
import { databaseMoves, moveEntryPaths, moveLinks, movePath, moveValue, translateJournalEntry, type DatabaseMove } from "../src/core/database-move";
import { configureDatabase, recordDatabaseMove } from "../src/core/database";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { describeHistory, restoreTable, tableChanges } from "../src/core/history";
import { listMigrations, readJournal } from "../src/core/journal";
import { alterTable, insertRow, select, updateRows } from "../src/core/rows";
import { tableStateAt, vacuum } from "../src/core/transaction-log";
import type { JournalEntry } from "../src/core/changeset";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const ID = "0192e000-0000-7000-8000-000000000001";
const COLUMNS = [
  { name: "occurred_at", type: "datetime", required: true, dense: true },
  { name: "value", type: "integer", min: 1, max: 5, dense: true },
  { name: "about", type: "link" },
];
const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });
const MOOD = "main.metrics.mood";

/** mood with history: v0 create, v1 insert, v2 insert (linking to a note), then a note linking into the database. */
async function moodVault(): Promise<{ v: DbVault; first: string }> {
  const v = createDbVault({ "Notes/Day.md": "---\ntitle: day\n---\nSee [[Datanotes/main/metrics/mood/2026-09-26T0900]] and [x](Datanotes/main/metrics/mood/2026-09-26T0900.md).\n" });
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }), at(0));
  const first = await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } }, at(1));
  await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T10:00", value: 3, about: "[[Datanotes/main/metrics/mood/2026-09-26T0900]]" } }, at(2));
  return { v, first: first.migration_id! };
}

const paths = async (v: DbVault, extra: Record<string, unknown> = {}) => (await select(v.app, v.settings, { table: "mood", ...extra })).rows.map((r) => r.path).sort();

describe("configure_database root", () => {
  it("is recorded: the journal (move_database, never undone), every table's history, and the store", async () => {
    const { v, first } = await moodVault();
    await configureDatabase(v.app, v.settings, { root: "Life/DB" }, async () => {});
    expect(v.settings.databaseFolder).toBe("Life/DB");
    const moves = await databaseMoves(v.app);
    expect(moves).toEqual([{ from: "Datanotes", to: "Life/DB", at: expect.any(String), by: "configure_database" }]);
    const list = (await listMigrations(v.app, v.settings)).migrations;
    expect(list[0]).toMatchObject({ op: "move_database", summary: "move the database folder from Datanotes to Life/DB", files_changed: 0 });
    const refused = await undoOperation(v.app, v.settings, list[0]!.migration_id);
    expect(refused.ok).toBe(false);
    expect(refused.conflicts[0]!.message).toBe("a move of the database folder cannot be undone: move it back with configure_database (root)");
    const h = await describeHistory(v.app, v.settings, { table: "mood" });
    expect(h.history[0]).toMatchObject({ operation: "MOVE DATABASE", operationParameters: { from: "Datanotes", to: "Life/DB", by: "configure_database" } });

    // undo of an operation made before the move finds its row in the new folder
    const undo = await undoOperation(v.app, v.settings, first);
    expect(undo.ok).toBe(true);
    expect(await paths(v)).toEqual(["Life/DB/main/metrics/mood/2026-09-26T1000.md"]);
    // time travel: every version with today's paths
    expect(await paths(v, { version: 1 })).toEqual(["Life/DB/main/metrics/mood/2026-09-26T0900.md"]);
    expect((await tableStateAt(v.app, v.settings, MOOD, { version: 2 })).files.has("Life/DB/main/metrics/mood/2026-09-26T1000.md")).toBe(true);
    const changes = await tableChanges(v.app, v.settings, { table: "mood", startVersion: 1, endVersion: 2 });
    expect(changes.changes.map((c) => [c._change_type, c.path])).toEqual([
      ["insert", "Life/DB/main/metrics/mood/2026-09-26T0900.md"],
      ["insert", "Life/DB/main/metrics/mood/2026-09-26T1000.md"],
    ]);
    // a restore puts the old version back in the new folder
    const restored = await restoreTable(v.app, v.settings, { table: "mood", version: 2 });
    expect(restored.ok).toBe(true);
    expect(await paths(v)).toEqual(["Life/DB/main/metrics/mood/2026-09-26T0900.md", "Life/DB/main/metrics/mood/2026-09-26T1000.md"]);
    expect(v.exists("Datanotes")).toBe(false);
  });
});

describe("a move of the database folder is one operation", () => {
  it("rewrites links and recomputes generated columns in the one move_database entry, which lists the rows it recomputed", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ name: "day", columns: [{ name: "date", type: "date", required: true }], timeColumn: "date", options: { filename: "{date:YYYY-MM-DD}" } }), at(0));
    await createTable(v.app, v.settings, described({ name: "task", columns: [{ name: "title", type: "string" }, { name: "due", type: "date" }, { name: "day_note", type: "link", ref: "main.public.day", generated: "link({due:YYYY-MM-DD})" }], options: { filename: "{title}" } }), at(1));
    await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-09-01" } }, at(2));
    await insertRow(v.app, v.settings, { table: "task", values: { title: "a", due: "2026-09-01" } }, at(3));
    const before = (await listMigrations(v.app, v.settings)).migrations.length;
    // the vault's file manager rewrites links its own way: the generated value is computed again
    await configureDatabase(v.app, v.settings, { root: "Areas/Db" }, async () => {});
    const list = (await listMigrations(v.app, v.settings)).migrations;
    expect(list).toHaveLength(before + 1);
    expect(list[0]).toMatchObject({ op: "move_database" });
    const row = (await select(v.app, v.settings, { table: "task" })).rows[0]!;
    expect(row).toMatchObject({ path: "Areas/Db/main/public/task/a.md", day_note: expect.stringMatching(/^\[\[Areas\/Db\/main\/public\/day\/2026-09-01/) });
    // by hand: the links the vault did not rewrite are repaired, the value recomputed if it differs
    await v.rename("Areas/Db", "Db");
    v.settings.databaseFolder = "Db";
    const r = await recordDatabaseMove(v.app, v.settings, { from: "Areas/Db", to: "Db", by: "hand" });
    expect(r.linksRepaired).toEqual(["Db/main/public/task/a.md"]);
    expect(r.recomputed).toEqual([]);
    expect((await select(v.app, v.settings, { table: "task" })).rows[0]!.day_note).toMatch(/^\[\[Db\/main\/public\/day\/2026-09-01/);
    const entry = (await readJournal(v.app, v.settings, r.migrationId)).entry;
    expect(entry.op).toBe("move_database");
    expect((await undoOperation(v.app, v.settings, r.migrationId)).ok).toBe(false);
  });
});

describe("a database folder moved by hand", () => {
  it("is recorded like configure_database root: links repaired, table paths moved, undo and time travel in the new folder", async () => {
    const { v, first } = await moodVault();
    await updateRows(v.app, v.settings, { table: "mood", where: { value: 3 }, set: { value: 4 } }, at(3));
    // an excluded folder given as a vault path inside the database folder
    expect((await alterTable(v.app, v.settings, { table: "mood", exclude: ["Datanotes/drafts"] })).ok).toBe(true);
    await v.rename("Datanotes", "Moved");
    v.settings.databaseFolder = "Moved";
    const r = await recordDatabaseMove(v.app, v.settings, { from: "Datanotes", to: "Moved", by: "hand" });
    expect(r).toMatchObject({ from: "Datanotes", to: "Moved", by: "hand", tables: [MOOD] });
    expect(r.linksRepaired.sort()).toEqual(["Moved/main/metrics/mood/2026-09-26T1000.md", "Notes/Day.md"]);
    expect(v.read("Notes/Day.md")).toContain("See [[Moved/main/metrics/mood/2026-09-26T0900]] and [x](Moved/main/metrics/mood/2026-09-26T0900.md).");
    expect(v.read("Moved/metastore.yaml")).toContain("Moved/drafts");
    expect((await listMigrations(v.app, v.settings)).migrations[0]!.summary).toBe("move the database folder from Datanotes to Moved (moved by hand)");

    // the row whose link was repaired: undo of the update before the move still matches it
    const updated = (await listMigrations(v.app, v.settings, { op: "update_rows" })).migrations[0]!.migration_id;
    expect((await readJournal(v.app, v.settings, updated)).entry.rows[0]!.path).toBe("Moved/main/metrics/mood/2026-09-26T1000.md");
    expect((await undoOperation(v.app, v.settings, updated)).ok).toBe(true);
    expect((await undoOperation(v.app, v.settings, first)).ok).toBe(true);
    expect(await paths(v)).toEqual(["Moved/main/metrics/mood/2026-09-26T1000.md"]);
    // time travel before the move: today's paths and links
    const v2 = await tableStateAt(v.app, v.settings, MOOD, { version: 2 });
    expect([...v2.files.keys()].sort()).toEqual(["Moved/main/metrics/mood/2026-09-26T0900.md", "Moved/main/metrics/mood/2026-09-26T1000.md"]);
    expect(v2.files.get("Moved/main/metrics/mood/2026-09-26T1000.md")!.content).toContain("[[Moved/main/metrics/mood/2026-09-26T0900]]");
  });

  it("keeps the links of a vault where the old folder exists again (nothing to repair)", async () => {
    const { v } = await moodVault();
    await v.rename("Datanotes", "Moved");
    v.write("Datanotes/README.md", "a new folder with the old name\n");
    v.settings.databaseFolder = "Moved";
    const r = await recordDatabaseMove(v.app, v.settings, { from: "Datanotes", to: "Moved", by: "hand" });
    expect(r.linksRepaired).toEqual([]);
  });

  it("reads checkpoints written after a move with the moves they already reflect", async () => {
    const { v } = await moodVault();
    await configureDatabase(v.app, v.settings, { root: "A" }, async () => {});
    // a checkpoint at the latest version, with today's paths
    await vacuum(v.app, v.settings, MOOD, undefined, false);
    await configureDatabase(v.app, v.settings, { root: "B" }, async () => {});
    await configureDatabase(v.app, v.settings, { root: "A" }, async () => {});
    expect(await paths(v)).toEqual(["A/main/metrics/mood/2026-09-26T0900.md", "A/main/metrics/mood/2026-09-26T1000.md"]);
    const latest = await tableStateAt(v.app, v.settings, MOOD);
    expect([...latest.files.keys()].sort()).toEqual(["A/main/metrics/mood/2026-09-26T0900.md", "A/main/metrics/mood/2026-09-26T1000.md"]);
    expect(latest.movesApplied).toBe(3);
  });
});

describe("the database id in metastore.yaml", () => {
  it("is read from the top-level id line and written at the top, after the leading comments", () => {
    expect(metastoreId(`id: ${ID}\n`)).toBe(ID);
    expect(metastoreId(`id: '${ID.toUpperCase()}' # mine\n`)).toBe(ID);
    expect(metastoreId("id: nope\n")).toBeNull();
    expect(metastoreId("config: {}\n")).toBeNull();
    expect(withMetastoreId("", ID)).toBe(`id: ${ID}\n`);
    expect(withMetastoreId("{}\n", ID)).toBe(`id: ${ID}\n`);
    expect(withMetastoreId("# a\n# b\ncatalogs: {}\n", ID)).toBe(`# a\n# b\nid: ${ID}\ncatalogs: {}\n`);
    expect(withMetastoreId("id: old\ncatalogs: {}\n", ID)).toBe(`id: ${ID}\ncatalogs: {}\n`);
    expect(withMetastoreId(`id: ${ID}\n`, ID)).toBe(`id: ${ID}\n`);
    expect(newDatabaseId(Date.UTC(2026, 9, 10))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it("is written into the metastore the engine creates, and an undo of the first table keeps it", async () => {
    const v = createDbVault({}, { databaseId: ID });
    const created = await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }), at(0));
    expect(metastoreId(v.read("Datanotes/metastore.yaml"))).toBe(ID);
    expect((await undoOperation(v.app, v.settings, created.migration_id!)).ok).toBe(true);
    expect(v.read("Datanotes/metastore.yaml")).toBe(`id: ${ID}\n`);
    const w = createDbVault({}, { databaseId: ID });
    await configureDatabase(w.app, w.settings, { timezone: "Europe/Rome" }, async () => {});
    expect(metastoreId(w.read("Datanotes/metastore.yaml"))).toBe(ID);
  });

  it("added at the first start is not a change undo takes back: older metastore texts read with it", async () => {
    const v = createDbVault({});
    const created = await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }), at(0));
    const added = await createTable(v.app, v.settings, described({ schema: "metrics", name: "sleep", timeColumn: "occurred_at", columns: COLUMNS }), at(1));
    v.write("Datanotes/metastore.yaml", withMetastoreId(v.read("Datanotes/metastore.yaml"), ID));
    v.settings.databaseId = ID;
    expect((await undoOperation(v.app, v.settings, added.migration_id!)).ok).toBe(true);
    expect(metastoreId(v.read("Datanotes/metastore.yaml"))).toBe(ID);
    expect((await undoOperation(v.app, v.settings, created.migration_id!)).ok).toBe(true);
    expect(v.read("Datanotes/metastore.yaml")).toBe(`id: ${ID}\n`);
  });
});

describe("journal entries as they read today", () => {
  const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
    migration_id: "m",
    op: "update_rows",
    summary: "s",
    executed_at: "2026-09-01T10:00:00.000Z",
    rows: [{ path: "Datanotes/a.md", before: { about: "[[Datanotes/b]]", n: 1, list: ["[[Datanotes/c]]"], map: { x: "[[Datanotes/d]]" } }, before_absent: [], before_order: [], after: {}, after_absent: [], body_before: "[[Datanotes/b]]", body_after: "x" }],
    creates: ["Datanotes/new.md"],
    moves: [{ from: "store:transaction_log/t/0.json", to: "store:transaction_log/u/0.json" }],
    references: [
      { path: "Datanotes/metastore.yaml", before_text: "", after_text: "catalogs: {}\n" },
      { path: "Datanotes/n.md", before_text: "[[Datanotes/b]]", after_text: "y" },
      { path: "Datanotes/other.txt", before_text: "Datanotes/b", after_text: "z" },
    ],
    deleted: [{ path: "Datanotes/gone.md", content: "[[Datanotes/b]]" }],
    failed: [{ path: "Datanotes/f.md", error: "e" }],
    schema: "Datanotes/metastore.yaml#main.x.y",
    ...over,
  });
  const move = (at: string, from = "Datanotes", to = "DB"): DatabaseMove => ({ from, to, at, by: "hand" });

  it("keep store: paths, and move paths, links and metastore texts written before a move", () => {
    const e = translateJournalEntry(entry(), [move("2026-08-01T00:00:00.000Z", "Old", "Datanotes"), move("2026-09-02T00:00:00.000Z")], ID);
    expect(e.moves).toEqual([{ from: "store:transaction_log/t/0.json", to: "store:transaction_log/u/0.json" }]);
    expect(e.rows[0]).toMatchObject({ path: "DB/a.md", before: { about: "[[DB/b]]", n: 1, list: ["[[DB/c]]"], map: { x: "[[DB/d]]" } }, body_before: "[[DB/b]]", body_after: "x" });
    expect(e.creates).toEqual(["DB/new.md"]);
    expect(e.references).toEqual([
      { path: "DB/metastore.yaml", before_text: `id: ${ID}\n`, after_text: `id: ${ID}\ncatalogs: {}\n` },
      { path: "DB/n.md", before_text: "[[DB/b]]", after_text: "y" },
      { path: "DB/other.txt", before_text: "Datanotes/b", after_text: "z" },
    ]);
    expect(e.deleted).toEqual([{ path: "DB/gone.md", content: "[[DB/b]]" }]);
    expect(e.failed).toEqual([{ path: "DB/f.md", error: "e" }]);
    expect(e.schema).toBe("DB/metastore.yaml#main.x.y");
    // an entry without the optional parts, and no id to add
    const bare = translateJournalEntry(entry({ deleted: undefined, schema: undefined, rows: [{ path: "x.md", before: {}, before_absent: [], before_order: [], after: {}, after_absent: [] }], references: [{ path: "metastore.yaml", before_text: "catalogs: [", after_text: "" }] }), [move("2026-09-02T00:00:00.000Z")]);
    expect(bare.deleted).toBeUndefined();
    expect(bare.schema).toBeUndefined();
    expect(bare.references[0]!.before_text).toBe("catalogs: [");
  });

  it("move paths, links, values and table paths", () => {
    expect([movePath("Datanotes", "Datanotes", "DB"), movePath("Datanotes/x", "Datanotes", "DB"), movePath("Datanotesy/x", "Datanotes", "DB")]).toEqual(["DB", "DB/x", "Datanotesy/x"]);
    expect(moveLinks("[[/My Db/x]] ![[My Db/y.png]] [a](My%20Db/z.md) [b](<My Db/w.md>) [[My Dbz/q]]", "My Db", "New Db")).toBe("[[/New Db/x]] ![[New Db/y.png]] [a](New%20Db/z.md) [b](<New Db/w.md>) [[My Dbz/q]]");
    expect(moveLinks("nothing here", "Datanotes", "DB")).toBe("nothing here");
    expect(moveValue([1, null, { a: "[[Datanotes/x]]" }], "Datanotes", "DB")).toEqual([1, null, { a: "[[DB/x]]" }]);
    const entry = { columns: [], options: { archive: "Datanotes/old", exclude: ["Datanotes/tmp", "Elsewhere"] } };
    expect(moveEntryPaths(entry, "Datanotes", "DB")).toEqual({ columns: [], options: { archive: "DB/old", exclude: ["DB/tmp", "Elsewhere"] } });
    expect(moveEntryPaths({ columns: [], options: { archive: "_archive", exclude: "Datanotes/x" } }, "Datanotes", "DB")).toEqual({ columns: [], options: { archive: "_archive", exclude: "DB/x" } });
    const same = { columns: [], options: { archive: "_archive" } };
    expect(moveEntryPaths(same, "Datanotes", "DB")).toBe(same);
    expect(moveEntryPaths(null, "Datanotes", "DB")).toBeNull();
    expect(moveEntryPaths({ columns: [] }, "Datanotes", "DB")).toEqual({ columns: [] });
  });

  it("the store's record of the moves skips torn lines", async () => {
    const v = createDbVault({ "store:database_moves.jsonl": `${JSON.stringify(move("2026-09-02T00:00:00.000Z"))}\n{"from":\n{"to":"x"}\n` });
    expect(await databaseMoves(v.app)).toEqual([move("2026-09-02T00:00:00.000Z")]);
  });
});
