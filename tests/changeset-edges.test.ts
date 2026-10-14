import { describe, expect, it, onTestFinished, vi } from "vitest";
import { applyChangeSet, emptyChangeSet, readJournal, undoMigration } from "../src/core/changeset";
import { configureDatabase } from "../src/core/database";
import { listVersions } from "../src/core/transaction-log";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { createPublicApi } from "../src/core/public-api";
import { alterTable, insertRow } from "../src/core/rows";
import { createDbVault, LOG_DIR, LOG_YAML, logVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const at = (iso: string) => new Date(iso);

describe("applyChangeSet: whole-text rewrites (the metastore)", () => {
  it("refuses to rewrite a text that is gone, and writes nothing after it", async () => {
    const v = createDbVault({ "Notes/n.md": "---\nstatus: open\n---\n" });
    const cs = emptyChangeSet("custom", "rewrite a deleted metastore");
    cs.texts.push({ path: METASTORE, before: LOG_YAML, after: `${LOG_YAML}# changed\n` });
    cs.edits.push({ path: "Notes/n.md", before: [["status", "open"]], after: [["status", "done"]] });
    const r = await applyChangeSet(v.app, v.settings, cs, at("2026-09-26T10:00:00Z"));
    expect(r).toMatchObject({ ok: false, notesChanged: 0, failed: [{ path: METASTORE, error: "file not found" }] });
    expect(v.exists(METASTORE)).toBe(false);
    expect(v.read("Notes/n.md")).toBe("---\nstatus: open\n---\n");
    const { entry } = await readJournal(v.app, v.settings, r.migrationId);
    expect([entry.references, entry.rows, entry.failed]).toEqual([[], [], [{ path: METASTORE, error: "file not found" }]]);
  });

  it("refuses to rewrite a text edited since it was read, keeping the edit", async () => {
    const v = logVault();
    const edited = `${LOG_YAML}# edited by hand\n`;
    v.write(METASTORE, edited);
    const cs = emptyChangeSet("custom", "stale metastore");
    cs.texts.push({ path: METASTORE, before: LOG_YAML, after: LOG_YAML.replace("walk", "run") });
    const r = await applyChangeSet(v.app, v.settings, cs);
    expect(r.failed).toEqual([{ path: METASTORE, error: "file changed since it was read" }]);
    expect(v.read(METASTORE)).toBe(edited);
  });
});

describe("applyChangeSet: deletes", () => {
  it("a note deleted by hand meanwhile stops the change set", async () => {
    const v = logVault({ "Notes/x.md": "x", "Notes/y.md": "y" });
    const cs = emptyChangeSet("custom", "delete two");
    cs.deletes.push("Notes/x.md", "Notes/gone.md", "Notes/y.md");
    const r = await applyChangeSet(v.app, v.settings, cs);
    expect(r).toMatchObject({ ok: false, filesDeleted: 1, failed: [{ path: "Notes/gone.md", error: "file not found" }] });
    expect([v.exists("Notes/x.md"), v.exists("Notes/y.md")]).toEqual([false, true]);
    // what was deleted comes back with undo
    expect((await undoMigration(v.app, v.settings, r.migrationId)).ok).toBe(true);
    expect(v.read("Notes/x.md")).toBe("x");
  });
});

describe("failures that are not Error objects", () => {
  it("a host write rejected with a plain string is reported with that string", async () => {
    const v = createDbVault({});
    const spy = vi.spyOn(v.app.vault, "create").mockRejectedValueOnce("EACCES: permission denied");
    onTestFinished(() => spy.mockRestore());
    const cs = emptyChangeSet("custom", "create");
    cs.creates.push({ path: "Notes/new.md", content: "new" });
    const r = await applyChangeSet(v.app, v.settings, cs);
    expect(r.failed).toEqual([{ path: "Notes/new.md", error: "EACCES: permission denied" }]);
    expect(r.filesCreated).toBe(0);
  });

  it("an undo whose host write is rejected with a plain string reports it, and stays undoable", async () => {
    const v = createDbVault({});
    const cs = emptyChangeSet("custom", "create");
    cs.creates.push({ path: "Notes/new.md", content: "new" });
    const r = await applyChangeSet(v.app, v.settings, cs);
    const fm = v.app.fileManager as unknown as { trashFile(f: unknown): Promise<void> };
    const spy = vi.spyOn(fm, "trashFile").mockRejectedValueOnce("EBUSY: resource busy or locked");
    onTestFinished(() => spy.mockRestore());
    const u = await undoMigration(v.app, v.settings, r.migrationId);
    expect(u).toMatchObject({ ok: false, conflicts: [], failed: [{ path: "undo", error: "EBUSY: resource busy or locked" }] });
    expect(v.exists("Notes/new.md")).toBe(true);
    expect((await readJournal(v.app, v.settings, r.migrationId)).undone).toBe(false);
    expect((await undoMigration(v.app, v.settings, r.migrationId)).ok).toBe(true);
    expect(v.exists("Notes/new.md")).toBe(false);
  });
});

describe("undoing a batch: the state the undo leaves is computed first", () => {
  const X = `${LOG_DIR}/2026/09/26/2026-09-26 mood.md`;
  const Y = `${LOG_DIR}/2026/09/27/2026-09-27 mood.md`;

  async function withRow() {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const r = await insertRow(v.app, v.settings, { table: "log", values: { kind: "mood", occurred_at: "2026-09-26T07:00" } });
    expect(r.ok).toBe(true);
    return { v, api, original: v.read(X) };
  }

  it("a row moved then deleted in the batch comes back where it was", async () => {
    const { v, api, original } = await withRow();
    const b = await api.batch({
      operations: [
        { op: "update_row", table: "log", path: X, set: { occurred_at: "2026-09-27T07:00" } },
        { op: "delete_rows", table: "log", where: { occurred_at: "2026-09-27T07:00" }, mode: "delete" },
      ],
    });
    expect(b.ok, JSON.stringify(b.steps)).toBe(true);
    expect([v.exists(X), v.exists(Y)]).toEqual([false, false]);
    const u = await api.undo(b.migration_id!);
    expect(u.ok, JSON.stringify(u.conflicts)).toBe(true);
    expect(v.read(X)).toBe(original);
    expect(v.exists(Y)).toBe(false);
  });

  it("a row moved away and back in the batch stays where it is", async () => {
    const { v, api, original } = await withRow();
    const b = await api.batch({
      operations: [
        { op: "update_row", table: "log", path: X, set: { occurred_at: "2026-09-27T07:00", metric_drinks: 2 } },
        { op: "update_row", table: "log", path: Y, set: { occurred_at: "2026-09-26T07:00" } },
      ],
    });
    expect(b.ok, JSON.stringify(b.steps)).toBe(true);
    expect(v.read(X)).toContain("metric_drinks: 2");
    const u = await api.undo(b.migration_id!);
    expect(u.ok, JSON.stringify(u.conflicts)).toBe(true);
    expect(v.read(X)).toBe(original);
    expect(v.exists(Y)).toBe(false);
  });

  it("a row created then moved in the batch is removed", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const b = await api.batch({
      operations: [
        { op: "insert_row", table: "log", values: { kind: "mood", occurred_at: "2026-09-26T07:00" } },
        { op: "update_row", table: "log", path: X, set: { occurred_at: "2026-09-27T07:00" } },
      ],
    });
    expect(b.ok, JSON.stringify(b.steps)).toBe(true);
    expect(v.exists(Y)).toBe(true);
    const u = await api.undo(b.migration_id!);
    expect(u.ok, JSON.stringify(u.conflicts)).toBe(true);
    expect([v.exists(X), v.exists(Y)]).toEqual([false, false]);
  });

  it("two schema changes give back the metastore as it was before the first", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const before = v.read(METASTORE);
    const b = await api.batch({
      operations: [
        described({ op: "add_column", table: "log", column: { name: "place", type: "string" } }),
        described({ op: "add_column", table: "log", column: { name: "with_whom", type: "string" } }),
      ],
    });
    expect(b.ok, JSON.stringify(b.steps)).toBe(true);
    expect(v.read(METASTORE)).toContain("with_whom");
    const u = await api.undo(b.migration_id!);
    expect(u.ok, JSON.stringify(u.conflicts)).toBe(true);
    expect(v.read(METASTORE)).toBe(before);
  });

  it("a row deleted by hand since the batch refuses the undo, naming the operation", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const b = await api.batch({ operations: [{ op: "update_row", table: "log", path: "Daily/b.md", set: { metric_drinks: 1 } }] });
    expect(b.ok, JSON.stringify(b.steps)).toBe(true);
    v.remove("Daily/b.md");
    const u = await api.undo(b.migration_id!);
    expect(u).toMatchObject({ ok: false, conflicts: [{ path: "Daily/b.md", message: `${b.steps[0]!.migration_id}: note no longer exists` }] });
    expect(v.exists("Daily/b.md")).toBe(false);
  });
});

describe("undoing a table rename with time travel on", () => {
  it("is refused, nothing moved, when a commit made under the new name would land on a version the old name has again", async () => {
    // one file per version: the conflicts name them
    const v = createDbVault({}, { transactionLogFormat: "files" });
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    const columns = [{ name: "occurred_at", type: "datetime", required: true, dense: true }];
    const mood = (hour: string) => ({ table: "mood", values: { occurred_at: `2026-09-26T${hour}:00` } });
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns }));
    await insertRow(v.app, v.settings, mood("09"));
    // the rename moves versions 0-1 to the new name and commits version 2 there
    const renamed = await alterTable(v.app, v.settings, { table: "mood", name: "feeling" });
    expect(await listVersions(v.app, v.settings, "main.metrics.feeling")).toEqual([0, 1, 2]);
    // a new `mood` table: its log has versions 0-2 again
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns }));
    await insertRow(v.app, v.settings, mood("10"));
    await insertRow(v.app, v.settings, mood("11"));
    const u = await undoOperation(v.app, v.settings, renamed.migration_id!);
    expect(u.ok).toBe(false);
    const dir = "store:transaction_log/main.metrics.mood";
    expect(u.conflicts).toEqual([
      { path: METASTORE, message: "text changed since the operation" }, // the new table's definition
      ...[0, 1, 2].map((n) => ({ path: `${dir}/0000000000000000000${n}.json`, message: "original path is occupied" })),
    ]);
    expect(await listVersions(v.app, v.settings, "main.metrics.feeling")).toEqual([0, 1, 2]);
    expect(await listVersions(v.app, v.settings, "main.metrics.mood")).toEqual([0, 1, 2]);
  });
});
