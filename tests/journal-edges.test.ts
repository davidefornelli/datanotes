import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { applyChangeSet, emptyChangeSet, undoMigration } from "../src/core/changeset";
import { createView } from "../src/core/catalog-ops";
import { INDEX_RETRY, undoOperation } from "../src/core/engine";
import { BLOB_MIN, compactJournal, journalFileFor, listMigrations, MigrationNotFoundError, readJournal } from "../src/core/journal";
import { createPublicApi } from "../src/core/public-api";
import { deleteRows, insertRow } from "../src/core/rows";
import { createDbVault, type DbVault, logVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const now = (iso: string) => ({ now: new Date(iso) });
const SEPT = "store:journal/2026-09.jsonl";

/** Rewrite a hidden store file as another process (a crash, a sync client, git) would: no engine involved. */
function storeFile(v: DbVault, rel: string, text: string): void {
  fs.writeFileSync(v.abs(rel), text);
}

async function insertMood(v: DbVault, at: string, occurred: string): Promise<string> {
  const r = await insertRow(v.app, v.settings, { table: "log", values: { kind: "mood", occurred_at: occurred } }, now(at));
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  return r.migration_id!;
}

describe("journal lines that are not JSON", () => {
  it("skips git conflict markers and a torn last line: the entries of both sides list and undo", async () => {
    const v = logVault();
    const a = await insertMood(v, "2026-09-26T08:00:00Z", "2026-09-26T07:00");
    const b = await insertMood(v, "2026-09-26T09:00:00Z", "2026-09-26T08:30");
    const [la, lb] = v.read(SEPT).trim().split("\n");
    // A sync merge left conflict markers around the two sides, and a crash tore the last append.
    storeFile(v, SEPT, `<<<<<<< HEAD\n${la}\n=======\n${lb}\n>>>>>>> origin/main\n{"type":"migration","migration_id":"20260926T1`);
    const listed = await listMigrations(v.app, v.settings);
    expect(listed.total).toBe(2);
    expect(listed.migrations.map((m) => [m.migration_id, m.op, m.undone])).toEqual([
      [b, "insert_row", false],
      [a, "insert_row", false],
    ]);
    expect((await readJournal(v.app, v.settings, a)).entry.creates).toEqual(["Datanotes/main/public/log/2026/09/26/2026-09-26 mood.md"]);
    const [created] = (await readJournal(v.app, v.settings, b)).entry.creates;
    expect(v.exists(created!)).toBe(true);
    const u = await undoMigration(v.app, v.settings, b, new Date("2026-09-26T10:00:00Z"));
    expect(u.ok).toBe(true);
    expect(v.exists(created!)).toBe(false);
  });
});

describe("journal blobs", () => {
  it("an entry whose blob file is gone cannot be read or undone, and names the blob", async () => {
    const v = createDbVault({});
    const r = await createView(v.app, v.settings, { schema: "public", name: "big", description: "c".repeat(BLOB_MIN), query: { table: "system.information_schema.tables" } }, now("2026-09-25T10:00:00Z"));
    expect(r.ok).toBe(true);
    const line = JSON.parse(v.read(SEPT).trim()) as { references: { after_text: string }[] };
    const ref = line.references[0]!.after_text;
    expect(ref).toMatch(/^blob:[0-9a-f]{14}-[0-9a-z]+$/);
    // the blob was not synced to this device
    fs.rmSync(path.join(v.storeRoot, "blobs", `${ref.slice("blob:".length)}.txt`));
    await expect(readJournal(v.app, v.settings, r.migration_id!)).rejects.toThrow(new Error(`journal blob missing: ${ref}`));
    await expect(undoOperation(v.app, v.settings, r.migration_id!)).rejects.toThrow(`journal blob missing: ${ref}`);
  });

  it("a short text that starts like a blob reference is stored as a blob, so undo gives it back as written", async () => {
    const text = "blob: a database type for large binary objects.\n";
    const v = createDbVault({ "Notes/blob.md": text });
    const cs = emptyChangeSet("custom", "remove a note");
    cs.deletes.push("Notes/blob.md");
    const r = await applyChangeSet(v.app, v.settings, cs, new Date("2026-09-25T10:00:00Z"));
    expect(r.ok).toBe(true);
    expect(v.read(SEPT)).not.toContain(text.trim());
    expect((await readJournal(v.app, v.settings, r.migrationId)).entry.deleted).toEqual([{ path: "Notes/blob.md", content: text }]);
    expect((await undoMigration(v.app, v.settings, r.migrationId, new Date("2026-09-25T11:00:00Z"))).ok).toBe(true);
    expect(v.read("Notes/blob.md")).toBe(text);
  });
});

describe("readJournal", () => {
  it("refuses an id its month file does not hold, and an undated id reads the undated file", async () => {
    const v = logVault();
    await insertMood(v, "2026-09-26T08:00:00Z", "2026-09-26T07:00");
    const missing = "20260926T080000-insert_row-other";
    await expect(readJournal(v.app, v.settings, missing)).rejects.toThrow(new MigrationNotFoundError(missing));
    await expect(readJournal(v.app, v.settings, missing)).rejects.toBeInstanceOf(MigrationNotFoundError);
    expect(journalFileFor(v.settings, "manual-fix")).toBe("store:journal/undated.jsonl");
    await expect(readJournal(v.app, v.settings, "manual-fix")).rejects.toThrow("Migration not found: manual-fix");
  });
});

describe("listMigrations filters", () => {
  it("by table: entries without a schema (a batch) match on their summary", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    await insertMood(v, "2026-09-26T08:00:00Z", "2026-09-26T07:00");
    const batch = await api.batch({ summary: "evening log", operations: [{ op: "insert_row", table: "log", values: { kind: "walk", occurred_at: "2026-09-26T19:00" } }] });
    expect(batch.ok).toBe(true);
    const other = await api.batch({ summary: "views", operations: [{ op: "create_view", schema: "public", name: "v", query: { table: "log" } }] });
    expect(other.ok, JSON.stringify(other.steps)).toBe(true);
    const byTable = await listMigrations(v.app, v.settings, { table: "log" });
    // the view's batch and its create_view (schema main.public.v) do not name the table
    expect(byTable.total).toBe(3);
    expect(byTable.migrations.map((m) => [m.op, m.summary, m.table ?? null, m.batch ?? null])).toEqual([
      ["batch", "evening log", null, null],
      ["insert_row", "insert into log", "main.public.log", batch.migration_id],
      ["insert_row", "insert into log", "main.public.log", null],
    ]);
    expect((await listMigrations(v.app, v.settings)).migrations.map((m) => m.migration_id)).toContain(other.migration_id);
  });

  it("a journal file removed while the list runs (a compaction elsewhere) counts as empty", async () => {
    const v = logVault();
    const old = await insertMood(v, "2026-08-20T08:00:00Z", "2026-08-20T07:00");
    const kept = await insertMood(v, "2026-09-26T08:00:00Z", "2026-09-26T07:00");
    expect((await listMigrations(v.app, v.settings)).migrations.map((m) => m.migration_id)).toEqual([kept, old]);
    const adapter = v.app.store! as unknown as { list(p: string): Promise<{ files: string[]; folders: string[] }> };
    const list = adapter.list.bind(adapter);
    const spy = vi.spyOn(adapter, "list").mockImplementation(async (p: string) => {
      const r = await list(p);
      if (p === "journal") fs.rmSync(path.join(v.storeRoot, "journal", "2026-08.jsonl"));
      return r;
    });
    onTestFinished(() => spy.mockRestore());
    expect(await listMigrations(v.app, v.settings)).toEqual({ total: 1, migrations: [expect.objectContaining({ migration_id: kept })] });
  });
});

describe("compactJournal", () => {
  it("rewrites a month file keeping only recent entries, their undo marks and the blobs they use", async () => {
    const v = logVault();
    const big = `${v.read("Daily/a.md")}${"long note body. ".repeat(200)}\n`;
    v.write("Daily/a.md", big);
    // Early September: an insert, undone the next day; a delete of a long note (its content is a blob).
    const early = await insertMood(v, "2026-09-02T08:00:00Z", "2026-09-02T07:00");
    expect((await undoMigration(v.app, v.settings, early, new Date("2026-09-03T08:00:00Z"))).ok).toBe(true);
    v.write("Daily/b.md", `${v.read("Daily/b.md")}${"another long body. ".repeat(200)}\n`);
    const gone = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" }, mode: "delete" }, now("2026-09-04T08:00:00Z"));
    expect(gone.ok, JSON.stringify(gone.conflicts)).toBe(true);
    // Late September: a delete of the other long note, undone, then deleted again.
    const late = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "alcohol" }, mode: "delete" }, now("2026-09-28T08:00:00Z"));
    expect(late.ok, JSON.stringify(late.conflicts)).toBe(true);
    const undo = await undoMigration(v.app, v.settings, late.migration_id!, new Date("2026-09-29T08:00:00Z"));
    expect(undo.ok).toBe(true);
    expect(v.read("Daily/a.md")).toBe(big);
    const blobs = () => v.listAll().filter((p) => p.startsWith("store:blobs/"));
    expect(blobs()).toHaveLength(2);
    const lines = () => v.read(SEPT).trim().split("\n").map((l) => JSON.parse(l) as { type: string; migration_id: string });

    const res = await compactJournal(v.app, { ...v.settings, journalRetentionDays: 10 }, new Date("2026-10-01T00:00:00Z"));
    expect(res).toEqual({ kept: 2, dropped: 3, blobsRemoved: 1 });
    expect(lines().map((l) => [l.type, l.migration_id])).toEqual([
      ["migration", late.migration_id],
      ["migration", undo.migration_id],
      ["undone", late.migration_id],
    ]);
    expect(blobs()).toHaveLength(1);
    expect((await readJournal(v.app, v.settings, late.migration_id!)).entry.deleted).toEqual([{ path: "Daily/a.md", content: big }]);
    await expect(readJournal(v.app, v.settings, early)).rejects.toThrow(`Migration not found: ${early}`);
  });

  it("keeps the blobs of an entry written before `deleted` was always recorded", async () => {
    const v = createDbVault({});
    const r = await createView(v.app, v.settings, { schema: "public", name: "big", description: "c".repeat(BLOB_MIN), query: { table: "system.information_schema.tables" } }, now("2026-09-25T10:00:00Z"));
    expect(r.ok).toBe(true);
    // An older engine wrote the line without `deleted`.
    const line = JSON.parse(v.read(SEPT).trim()) as Record<string, unknown>;
    expect(line.deleted).toEqual([]);
    delete line.deleted;
    storeFile(v, SEPT, `${JSON.stringify(line)}\n`);
    const blobs = () => v.listAll().filter((p) => p.startsWith("store:blobs/"));
    const before = blobs();
    expect(before.length).toBeGreaterThan(0);
    expect(await compactJournal(v.app, { ...v.settings, journalRetentionDays: 30 }, new Date("2026-10-01T00:00:00Z"))).toEqual({ kept: 1, dropped: 0, blobsRemoved: 0 });
    expect(blobs()).toEqual(before);
    expect((await readJournal(v.app, v.settings, r.migration_id!)).entry.references[0]!.after_text).toContain("c".repeat(BLOB_MIN));
    // it reads as deleting nothing, and is undone like any other
    expect((await readJournal(v.app, v.settings, r.migration_id!)).entry.deleted).toEqual([]);
    expect((await undoMigration(v.app, v.settings, r.migration_id!)).ok).toBe(true);
  });

  it("a journal file removed by another compaction meanwhile is skipped", async () => {
    const v = logVault();
    await insertMood(v, "2026-08-20T08:00:00Z", "2026-08-20T07:00");
    const kept = await insertMood(v, "2026-09-26T08:00:00Z", "2026-09-26T07:00");
    const adapter = v.app.store! as unknown as { list(p: string): Promise<{ files: string[]; folders: string[] }> };
    const list = adapter.list.bind(adapter);
    const spy = vi.spyOn(adapter, "list").mockImplementation(async (p: string) => {
      const r = await list(p);
      if (p === "journal") fs.rmSync(path.join(v.storeRoot, "journal", "2026-08.jsonl"));
      return r;
    });
    onTestFinished(() => spy.mockRestore());
    expect(await compactJournal(v.app, { ...v.settings, journalRetentionDays: 30 }, new Date("2026-10-01T00:00:00Z"))).toEqual({ kept: 1, dropped: 0, blobsRemoved: 0 });
    spy.mockRestore();
    expect(v.listAll().filter((p) => p.startsWith("store:journal/"))).toEqual([SEPT]);
    expect((await readJournal(v.app, v.settings, kept)).undone).toBe(false);
  });
});

describe("list_migrations: the table filter", () => {
  it("finds the operations on a table's columns, by the table's qualified name", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    expect((await api.addColumn({ table: "log", column: { name: "note", type: "string", description: "A note" } })).ok).toBe(true);
    expect((await api.alterColumn({ table: "log", name: "note", changes: { description: "A short note" } })).ok).toBe(true);
    expect((await api.renameColumn({ table: "log", from: "note", to: "remark" })).ok).toBe(true);
    const listed = (await listMigrations(v.app, v.settings, { table: "main.public.log" })).migrations;
    expect(listed.map((m) => [m.op, m.table])).toEqual([
      ["rename_column", "main.public.log"],
      ["alter_column", "main.public.log"],
      ["add_column", "main.public.log"],
    ]);
  });
});
