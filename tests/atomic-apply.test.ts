/**
 * A write that fails partway (a file another program holds, a note changed since it was read) is
 * rolled back by the engine itself: what it had written is put back from its journal entry, the
 * answer says so (`rolled_back`), the transaction log records no half-applied version and the
 * change feed hears of nothing. When the rollback fails too, the answer names the files left and
 * undo_migration on the write's migration_id finishes it. Runs on both hosts (`VAULT_HOST=node`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { describeRefusal } from "../src/api/results";
import { applyChangeSet, bodyOf, emptyChangeSet, readJournal, type NoteEdit } from "../src/core/changeset";
import { configureDatabase } from "../src/core/database";
import { emptyResult, finish, INDEX_RETRY, onApplied, undoOperation } from "../src/core/engine";
import { fmSet, readOrderedFromMarkdown } from "../src/core/frontmatter";
import { describeHistory } from "../src/core/history";
import { docsUrl, refusalGuidance } from "../src/core/hints";
import { listMigrations } from "../src/core/journal";
import { createPublicApi } from "../src/core/public-api";
import type { TFile } from "../src/core/host";
import { createHandlers, dispatch } from "../src/server/rest";
import { LOG_DIR, logVault, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const C = "Daily/c.md";
const ROW_C = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000c\nkind: walk\noccurred_at: 2026-09-27T08:00\n---\nC\n";
const ROWS = ["Daily/a.md", "Daily/b.md", C];

afterEach(() => {
  vi.restoreAllMocks();
});

/** The log vault with three rows and time travel on. */
async function vault(): Promise<DbVault> {
  const v = logVault({ [C]: ROW_C });
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  return v;
}

/** An edit setting `metric_drinks` on a row, from its whole front matter. */
function edit(v: DbVault, path: string, drinks: number): NoteEdit {
  const before = readOrderedFromMarkdown(v.read(path)).ordered;
  return { path, before, after: fmSet(before, "metric_drinks", drinks) };
}

const texts = (v: DbVault) => Object.fromEntries(ROWS.map((p) => [p, v.read(p)]));

/**
 * Make the frontmatter writes of the host fail by their number (1 = the first write from now):
 * `fail(2, 4)` lets the first and the third through and rejects the second and the fourth.
 */
function failWrites(v: DbVault, ...which: number[]): { paths: string[] } {
  const fm = v.app.fileManager as unknown as { processFrontMatter(f: TFile, fn: (fm: Record<string, unknown>) => void): Promise<void> };
  const real = fm.processFrontMatter.bind(fm);
  const paths: string[] = [];
  let n = 0;
  vi.spyOn(fm, "processFrontMatter").mockImplementation(async (f, fn) => {
    n++;
    paths.push(f.path);
    if (which.includes(n)) throw new Error(`EBUSY: resource busy or locked, open '${f.path}'`);
    return real(f, fn);
  });
  return { paths };
}

describe("a write that fails partway is rolled back", () => {
  it("puts back the rows already written; the journal, the log and the change feed agree", async () => {
    const v = await vault();
    const api = createPublicApi(v.app, () => v.settings);
    const before = texts(v);
    const heard: string[] = [];
    const off = onApplied(v.app, (e) => heard.push(e.op));
    const { paths } = failWrites(v, 2);

    const r = await api.updateRows({ table: "log", set: { metric_drinks: 3 } });
    off();
    expect(r).toMatchObject({ ok: false, rolled_back: true, notes_changed: 0, conflicts: [], violations: [] });
    expect(r.failed).toEqual([{ path: paths[1], error: expect.stringMatching(/^EBUSY/) }]);
    expect(texts(v)).toEqual(before);
    expect(heard).toEqual([]);

    // the journal: the failed write, undone by its rollback
    const { migrations } = await listMigrations(v.app, v.settings);
    const failed = migrations.find((m) => m.migration_id === r.migration_id)!;
    expect(failed).toMatchObject({ op: "update_rows", undone: true, files_failed: 1, notes_changed: 1 });
    const rollback = migrations.find((m) => m.undoes === r.migration_id)!;
    expect(rollback).toMatchObject({ op: "rollback", undone: false, files_failed: 0 });
    // neither can be undone: the write is undone already, its rollback is no write of its own
    expect((await undoOperation(v.app, v.settings, r.migration_id!)).conflicts[0]!.message).toBe("migration already undone");
    expect((await undoOperation(v.app, v.settings, rollback.migration_id)).conflicts[0]!.message).toMatch(/^the rollback of a failed write cannot be undone/);

    // the transaction log has no version of the half-applied write (only the table's first one)
    const log = (await describeHistory(v.app, v.settings, { table: "log" })).history;
    expect(log.map((c) => c.operation)).toEqual(["CREATE TABLE"]);

    // the answer says nothing is left written, and how to go on
    expect(refusalGuidance(r)).toEqual({ hint: expect.stringContaining("nothing changed"), docs: docsUrl("failedWrite") });
    expect(describeRefusal(r as unknown as Record<string, unknown>)).toMatch(/^update_rows failed — the engine rolled back what it had written, nothing is left written:\nfailed /);

    // the same write succeeds once the file is free
    vi.restoreAllMocks();
    expect((await api.updateRows({ table: "log", set: { metric_drinks: 3 } })).ok).toBe(true);
  });

  it("a write that fails before writing anything is marked undone, with no rollback entry", async () => {
    const v = await vault();
    const api = createPublicApi(v.app, () => v.settings);
    const before = texts(v);
    failWrites(v, 1);
    const r = await api.updateRows({ table: "log", set: { metric_drinks: 3 } });
    expect(r).toMatchObject({ ok: false, rolled_back: true });
    expect(texts(v)).toEqual(before);
    const { migrations } = await listMigrations(v.app, v.settings);
    expect(migrations.find((m) => m.migration_id === r.migration_id)).toMatchObject({ undone: true, notes_changed: 0 });
    expect(migrations.some((m) => m.undoes === r.migration_id)).toBe(false);
  });

  it("puts back created, moved and deleted files too", async () => {
    const v = await vault();
    const before = texts(v);
    const cs = emptyChangeSet("custom", "create, edit, move and delete");
    cs.creates.push({ path: "Notes/new.md", content: "new\n" });
    cs.edits.push(edit(v, "Daily/a.md", 1));
    cs.deletes.push(C);
    cs.moves.push({ from: "Daily/b.md", to: "Daily/moved.md" });
    const fm = v.app.fileManager as unknown as { trashFile(f: TFile): Promise<void> };
    vi.spyOn(fm, "trashFile").mockRejectedValueOnce(new Error("EPERM: operation not permitted, unlink 'Daily/c.md'"));
    const r = await finish(v.app, v.settings, cs, [], [], {});
    expect(r).toMatchObject({ ok: false, rolled_back: true, failed: [{ path: C, error: expect.stringMatching(/^EPERM/) }] });
    expect(v.exists("Notes/new.md")).toBe(false);
    expect(v.exists("Daily/moved.md")).toBe(false);
    expect(texts(v)).toEqual(before);
  });

  it("a failed move is rolled back with the writes before it", async () => {
    const v = await vault();
    const before = texts(v);
    const cs = emptyChangeSet("custom", "edit and move");
    cs.edits.push(edit(v, "Daily/a.md", 1));
    cs.moves.push({ from: "Daily/b.md", to: "Daily/moved.md" });
    const fm = v.app.fileManager as unknown as { renameFile(f: TFile, to: string): Promise<void> };
    vi.spyOn(fm, "renameFile").mockRejectedValueOnce(new Error("EBUSY: resource busy or locked, rename 'Daily/b.md'"));
    const r = await finish(v.app, v.settings, cs, [], [], {});
    expect(r).toMatchObject({ ok: false, rolled_back: true, failed: [{ path: "Daily/b.md" }] });
    expect(texts(v)).toEqual(before);
  });
});

describe("when the rollback fails too", () => {
  it("names the files left; undo_migration on the write finishes the rollback", async () => {
    const v = await vault();
    const api = createPublicApi(v.app, () => v.settings);
    const before = texts(v);
    // writes 1 and 2 pass, 3 fails; the rollback puts back the first (4) and fails on the second (5)
    const { paths } = failWrites(v, 3, 5);
    const r = await api.updateRows({ table: "log", set: { metric_drinks: 3 } });
    expect(r).toMatchObject({ ok: false, rolled_back: false });
    const [first, second, third] = paths;
    expect(r.failed).toEqual([
      { path: third, error: expect.stringMatching(/^EBUSY/) },
      { path: second, error: expect.stringMatching(/^not rolled back: EBUSY/) },
    ]);
    expect(v.read(first!)).toBe(before[first!]);
    expect(v.read(second!)).not.toBe(before[second!]);
    expect(refusalGuidance(r)).toEqual({ hint: expect.stringContaining("undo_migration with the migration_id"), docs: docsUrl("rollbackFailed") });
    expect(describeRefusal(r as unknown as Record<string, unknown>)).toContain(`could NOT be rolled back (journal ${r.migration_id}; undo_migration on it retries the rollback)`);

    // the write is not undone yet; the retry skips the row already back
    expect((await listMigrations(v.app, v.settings)).migrations.find((m) => m.migration_id === r.migration_id)!.undone).toBe(false);
    vi.restoreAllMocks();
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok, JSON.stringify(u.conflicts)).toBe(true);
    expect(texts(v)).toEqual(before);
    expect((await listMigrations(v.app, v.settings)).migrations.find((m) => m.migration_id === r.migration_id)!.undone).toBe(true);
  });

  it("a rollback refused by a file changed meanwhile leaves every written file, named", async () => {
    const v = await vault();
    const cs = emptyChangeSet("custom", "two edits");
    cs.edits.push(edit(v, "Daily/a.md", 1));
    cs.edits.push(edit(v, "Daily/b.md", 2));
    const fm = v.app.fileManager as unknown as { processFrontMatter(f: TFile, fn: (fm: Record<string, unknown>) => void): Promise<void> };
    const real = fm.processFrontMatter.bind(fm);
    vi.spyOn(fm, "processFrontMatter").mockImplementation(async (f, fn) => {
      if (f.path === "Daily/b.md") {
        // another program edits the first note, then holds the second
        v.write("Daily/a.md", v.read("Daily/a.md").replace("metric_drinks: 1", "metric_drinks: 5"));
        throw new Error("EBUSY: resource busy or locked");
      }
      return real(f, fn);
    });
    const r = await finish(v.app, v.settings, cs, [], [], {});
    expect(r).toMatchObject({ ok: false, rolled_back: false });
    expect(r.failed).toEqual([
      { path: "Daily/b.md", error: "EBUSY: resource busy or locked" },
      { path: "Daily/a.md", error: 'not rolled back: "metric_drinks" changed since the operation' },
    ]);
    expect(v.read("Daily/a.md")).toContain("metric_drinks: 5");
  });

  it("a retried rollback skips every kind of change already back: texts, rows, moves, creates, deletes", async () => {
    const extra = { "Notes/plain.md": "plain\n", "Notes/old.md": "old\n", "Notes/old2.md": "old 2\n" };
    const v = logVault({ [C]: ROW_C, ...extra });
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    const all = [...ROWS, ...Object.keys(extra)];
    const before = Object.fromEntries(all.map((p) => [p, v.read(p)]));
    const cs = emptyChangeSet("custom", "every kind of change, then a missing file");
    cs.creates.push({ path: "Notes/new.md", content: "new\n" });
    cs.texts.push({ path: "Notes/plain.md", before: "plain\n", after: "plain, linked\n" });
    cs.edits.push(edit(v, "Daily/a.md", 1));
    const bodyB = bodyOf(v.read("Daily/b.md"));
    cs.edits.push({ ...edit(v, "Daily/b.md", 2), bodyBefore: bodyB, bodyAfter: `${bodyB}edited\n` });
    cs.moves.push({ from: C, to: "Daily/moved.md" });
    cs.deletes.push("Notes/old.md", "Notes/old2.md", "Notes/missing.md");
    // the rollback puts back everything but the last deleted note, which another program holds
    const vault = v.app.vault as unknown as { create(path: string, data: string): Promise<TFile> };
    const real = vault.create.bind(vault);
    vi.spyOn(vault, "create").mockImplementation(async (path, data) => {
      if (path === "Notes/old2.md") throw new Error("EBUSY: resource busy or locked");
      return real(path, data);
    });
    const r = await finish(v.app, v.settings, cs, [], [], {});
    expect(r).toMatchObject({ ok: false, rolled_back: false });
    expect(r.failed).toEqual([
      { path: "Notes/missing.md", error: "file not found" },
      { path: "Notes/old2.md", error: "not rolled back: EBUSY: resource busy or locked" },
    ]);
    expect(v.exists("Notes/old2.md")).toBe(false);
    expect(v.exists("Notes/new.md")).toBe(false);

    // the retry finds the rest back as before and restores only the held note
    vi.restoreAllMocks();
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok, JSON.stringify(u.conflicts)).toBe(true);
    expect(Object.fromEntries(all.map((p) => [p, v.read(p)]))).toEqual(before);
    expect(v.exists("Daily/moved.md")).toBe(false);
    const { entry } = await readJournal(v.app, v.settings, u.migration_id!);
    expect(entry).toMatchObject({ creates: ["Notes/old2.md"], rows: [], moves: [], references: [], deleted: [] });
  });

  it("a note created and deleted by the same write keeps no hash for its undo", async () => {
    const v = await vault();
    const cs = emptyChangeSet("custom", "create and delete");
    cs.creates.push({ path: "Notes/temp.md", content: "temp\n" });
    cs.deletes.push("Notes/temp.md");
    const r = await applyChangeSet(v.app, v.settings, cs);
    expect(r.failed).toEqual([]);
    expect(v.exists("Notes/temp.md")).toBe(false);
    const { entry } = await readJournal(v.app, v.settings, r.migrationId);
    expect(entry.creates).toEqual(["Notes/temp.md"]);
    expect(entry.created_hashes).toBeUndefined();
  });

  it("a rollback whose journal entry cannot be read says so", async () => {
    const v = await vault();
    const cs = emptyChangeSet("custom", "one edit");
    cs.edits.push(edit(v, "Daily/a.md", 1));
    cs.edits.push({ path: "Daily/zzz.md", before: [], after: [["metric_drinks", 2]] });
    const journal = await import("../src/core/journal");
    vi.spyOn(journal, "readJournal").mockRejectedValueOnce(new Error("journal unreadable"));
    const r = await finish(v.app, v.settings, cs, [], [], {});
    expect(r).toMatchObject({ ok: false, rolled_back: false });
    expect(r.failed.at(-1)).toEqual({ path: "undo", error: "not rolled back: journal unreadable" });
  });
});

describe("a batch with a step that fails partway", () => {
  it("leaves nothing written, and undoes each operation once", async () => {
    const v = await vault();
    const api = createPublicApi(v.app, () => v.settings);
    const before = texts(v);
    const created = `${LOG_DIR}/2026/09/28/2026-09-28 mood.md`;
    const versions = (await describeHistory(v.app, v.settings, { table: "log" })).history.length;
    // the insert writes its note with create (no frontmatter write); the update fails on its second row
    failWrites(v, 2);
    const b = await api.batch({
      operations: [
        { op: "insert_row", table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } },
        { op: "update_rows", table: "log", set: { metric_drinks: 3 } },
      ],
    });
    expect(b).toMatchObject({ ok: false, failed_at: 1, rolled_back: true });
    expect(b.steps[1]!.result).toMatchObject({ ok: false, rolled_back: true });
    // only the insert is undone by the batch: the update was rolled back by the engine already
    expect(b.rollback).toEqual([{ migration_id: b.steps[0]!.migration_id, ok: true, conflicts: [], failed: [] }]);
    expect(v.exists(created)).toBe(false);
    expect(texts(v)).toEqual(before);
    const { migrations } = await listMigrations(v.app, v.settings);
    for (const s of b.steps) expect(migrations.find((m) => m.migration_id === s.migration_id)!.undone).toBe(true);
    // the log has the insert and its undo, nothing of the failed update
    const ops = (await describeHistory(v.app, v.settings, { table: "log" })).history.slice(0, -versions).map((c) => c.operation);
    expect(ops).not.toContain("UPDATE");
    expect(emptyResult("x", false).rolled_back).toBeUndefined();
  });
});

describe("the HTTP status of a write that did not apply", () => {
  /** An operation called as a client calls it: POST /datanotes/operations/<op>/. */
  const client = (v: DbVault) => {
    const h = createHandlers(v.app, () => v.settings);
    return (op: string, body: Record<string, unknown>) => dispatch(`/operations/${op}/`, h[`/operations/${op}/`]!, body);
  };

  it("503 when it failed partway and was rolled back; 500 when the rollback failed too; 422 when refused", async () => {
    const v = await vault();
    const call = client(v);
    failWrites(v, 2);
    const rolledBack = await call("update_rows", { table: "log", where: {}, set: { metric_drinks: 3 } });
    expect(rolledBack.status).toBe(503);
    expect(rolledBack.json).toMatchObject({ ok: false, rolled_back: true });
    vi.restoreAllMocks();
    failWrites(v, 3, 5);
    const left = await call("update_rows", { table: "log", where: {}, set: { metric_drinks: 4 } });
    expect(left.status).toBe(500);
    expect(left.json).toMatchObject({ ok: false, rolled_back: false });
    vi.restoreAllMocks();
    expect((await call("update_rows", { table: "log", where: {}, set: { metric_drinks: "many" } })).status).toBe(422);
  });

  it("503 for a batch whose step failed partway, all rolled back; 422 for a batch with a refused step", async () => {
    const v = await vault();
    const call = client(v);
    failWrites(v, 2);
    const failed = await call("batch", {
      operations: [
        { op: "insert_row", table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } },
        { op: "update_rows", table: "log", where: {}, set: { metric_drinks: 3 } },
      ],
    });
    expect(failed.status).toBe(503);
    vi.restoreAllMocks();
    const refused = await call("batch", {
      operations: [
        { op: "insert_row", table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } },
        { op: "update_rows", table: "log", where: {}, set: { metric_drinks: "many" } },
      ],
    });
    expect(refused.status).toBe(422);
  });
});
