import { describe, expect, it } from "vitest";
import {
  applyChangeSet,
  applyDiff,
  diffOrdered,
  editIsNoop,
  emptyChangeSet,
  ensureFolder,
  readJournal,
  undoMigration,
} from "../src/core/changeset";
import {
  listTables,
  validationContextFor,
  TableNotFoundError,
} from "../src/core/table-registry";
import { createDbVault, logVault } from "./helpers/db-vault";
import { INDEX_RETRY } from "../src/core/engine";

INDEX_RETRY.delayMs = 1;

describe("diff helpers", () => {
  it("diffOrdered / applyDiff / editIsNoop", () => {
    const d = diffOrdered(
      [["a", 1], ["b", [1]], ["c", 3]],
      [["a", 1], ["b", [2]], ["d", 4]],
    );
    expect(d.set).toEqual([["b", [2]], ["d", 4]]);
    expect(d.remove).toEqual(["c"]);
    expect(d.beforeAbsent).toEqual(["d"]);
    expect(d.afterAbsent).toEqual(["c"]);
    expect(applyDiff([["x", 0], ["a", 1], ["c", 3]], d.set, d.remove, ["a", "b", "d"])).toEqual([
      ["a", 1],
      ["b", [2]],
      ["d", 4],
      ["x", 0],
    ]);
    expect(editIsNoop({ path: "p", before: [["a", 1]], after: [["a", 1]] })).toBe(true);
    expect(editIsNoop({ path: "p", before: [["a", 1], ["b", 2]], after: [["b", 2], ["a", 1]] })).toBe(false);
  });
});

describe("applyChangeSet failure handling", () => {
  it("stops at the first failure and journals only what was applied", async () => {
    const v = logVault();
    const cs = emptyChangeSet("custom", "partial");
    cs.creates.push({ path: "New/x.md", content: "x" });
    cs.edits.push({ path: "Daily/a.md", before: [["kind", "alcohol"]], after: [["kind", "mood"]] });
    cs.edits.push({ path: "Daily/missing.md", before: [], after: [["a", 1]] });
    cs.moves.push({ from: "Daily/b.md", to: "Daily/c.md" });
    const r = await applyChangeSet(v.app, v.settings, cs);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual([{ path: "Daily/missing.md", error: "file not found" }]);
    expect(r.filesCreated).toBe(1);
    expect(r.notesChanged).toBe(1);
    expect(r.filesMoved).toBe(0);
    const { entry } = await readJournal(v.app, v.settings, r.migrationId);
    expect(entry.rows.map((x) => x.path)).toEqual(["Daily/a.md"]);
    // the partial run can be undone
    const u = await undoMigration(v.app, v.settings, r.migrationId);
    expect(u.ok).toBe(true);
    expect(v.exists("New/x.md")).toBe(false);
    expect(v.read("Daily/a.md")).toContain("kind: alcohol");
  });

  it("reports create and move failures", async () => {
    const v = logVault();
    const c1 = emptyChangeSet("c", "create exists");
    c1.creates.push({ path: "Daily/a.md", content: "" });
    expect((await applyChangeSet(v.app, v.settings, c1)).failed[0]!.error).toMatch(/file exists/);

    const c3 = emptyChangeSet("c", "bad moves");
    c3.moves.push({ from: "nope.md", to: "x.md" });
    expect((await applyChangeSet(v.app, v.settings, c3)).failed[0]!.error).toMatch(/file not found/);
    const c4 = emptyChangeSet("c", "");
    c4.moves.push({ from: "Daily/a.md", to: "Daily/b.md" });
    const r4 = await applyChangeSet(v.app, v.settings, c4);
    expect(r4.failed[0]!.error).toMatch(/target exists/);
    expect(r4.migrationId).toMatch(/-c$/);
  });

  it("journal ids are unique within the same second", async () => {
    const v = createDbVault();
    const now = new Date(2026, 0, 2, 3, 4, 5);
    const a = await applyChangeSet(v.app, v.settings, emptyChangeSet("op", "same"), now);
    const b = await applyChangeSet(v.app, v.settings, emptyChangeSet("op", "same"), now);
    expect(a.migrationId).toBe("20260102T030405-op-same");
    expect(b.migrationId).toBe("20260102T030405-op-same-2");
  });

  it("readJournal ignores journal notes of the old format", async () => {
    const v = createDbVault({ "_meta/migrations/x.md": "---\ntype: migration\n---\nno json" });
    await expect(readJournal(v.app, v.settings, "x")).rejects.toThrow(/Migration not found: x/);
  });

  it("undo conflicts: deleted row, added key, moved/created files", async () => {
    const v = logVault({ "T/log.md": "a file to move" });
    const cs = emptyChangeSet("custom", "many");
    cs.creates.push({ path: "New/x.md", content: "x" });
    cs.edits.push({ path: "Daily/a.md", before: [["kind", "alcohol"]], after: [] });
    cs.edits.push({ path: "Daily/b.md", before: [["kind", "mood"]], after: [["kind", "walk"]] });
    cs.moves.push({ from: "T/log.md", to: "T2/log.md" });
    const r = await applyChangeSet(v.app, v.settings, cs);
    expect(r.ok).toBe(true);
    v.write("Daily/a.md", "---\ntable: main.public.log\nkind: again\n---\n");
    v.write("T/log.md", "occupied");
    const u = await undoMigration(v.app, v.settings, r.migrationId);
    expect(u.ok).toBe(false);
    expect(u.conflicts.map((c) => c.path).sort()).toEqual(["Daily/a.md", "T/log.md"]);

    const v2 = logVault();
    const cs2 = emptyChangeSet("custom", "gone");
    cs2.creates.push({ path: "New/y.md", content: "y" });
    cs2.edits.push({ path: "Daily/a.md", before: [["kind", "alcohol"]], after: [["kind", "mood"]] });
    cs2.moves.push({ from: "Daily/b.md", to: "Daily/z.md" });
    const r2 = await applyChangeSet(v2.app, v2.settings, cs2);
    await v2.app.fileManager.trashFile!(v2.file("New/y.md"));
    await v2.app.fileManager.trashFile!(v2.file("Daily/a.md"));
    await v2.app.fileManager.trashFile!(v2.file("Daily/z.md"));
    const u2 = await undoMigration(v2.app, v2.settings, r2.migrationId);
    expect(u2.conflicts.map((c) => c.message).sort()).toEqual([
      "created file no longer exists",
      "moved file no longer exists",
      "note no longer exists",
    ]);
  });

  it("undo falls back to vault.trash and reports revert failures", async () => {
    const v = createDbVault();
    (v.app.fileManager as unknown as { trashFile?: unknown }).trashFile = undefined;
    const cs = emptyChangeSet("c", "x");
    cs.creates.push({ path: "a.md", content: "a" });
    const r = await applyChangeSet(v.app, v.settings, cs);
    expect((await undoMigration(v.app, v.settings, r.migrationId)).ok).toBe(true);
    expect(v.exists("a.md")).toBe(false);

    const v2 = createDbVault();
    const cs2 = emptyChangeSet("c", "y");
    cs2.creates.push({ path: "b.md", content: "b" });
    const r2 = await applyChangeSet(v2.app, v2.settings, cs2);
    (v2.app.fileManager as unknown as { trashFile: () => Promise<void> }).trashFile = async () => {
      throw new Error("locked");
    };
    const u2 = await undoMigration(v2.app, v2.settings, r2.migrationId);
    expect(u2.ok).toBe(false);
    expect(u2.failed[0]!.error).toBe("locked");
    const u3 = await undoMigration(v2.app, v2.settings, r2.migrationId);
    expect(u3.failed[0]!.error).toBe("locked"); // journal not marked undone after failure
  });

  it("ensureFolder creates nested folders once", async () => {
    const v = createDbVault();
    await ensureFolder(v.app, "a/b/c");
    await ensureFolder(v.app, "a/b/c");
    expect(v.exists("a/b/c")).toBe(true);
  });
});

