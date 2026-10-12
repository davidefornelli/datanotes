/**
 * Undoing an undo is a redo, whatever the operation: a row update, an insert (the file comes
 * back), a delete (the file goes again), a schema change (the metastore's text comes back), an
 * adopt that moved notes, and a batch (its undo is journaled as a batch of undos).
 */

import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { readJournal } from "../src/core/journal";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { createPublicApi } from "../src/core/public-api";
import { adoptRows, deleteRows, insertRow, updateRow } from "../src/core/rows";
import { LOG_DIR, logVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const keys = (v: DbVault, p: string) => readOrderedFromMarkdown(v.read(p)).ordered.map(([k]) => k);

async function undo(v: DbVault, id: string): Promise<string> {
  const r = await undoOperation(v.app, v.settings, id);
  expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
  return r.migration_id!;
}

describe("undo of an undo", () => {
  it("redoes an update, keys in their order", async () => {
    const v = logVault();
    const order = keys(v, "Daily/b.md");
    const r = await updateRow(v.app, v.settings, { table: "log", path: "Daily/b.md", set: { metric_drinks: 2 } });
    const after = keys(v, "Daily/b.md");
    const u = await undo(v, r.migration_id!);
    expect(keys(v, "Daily/b.md")).toEqual(order);
    const redo = await undo(v, u);
    expect(fm(v, "Daily/b.md").metric_drinks).toBe(2);
    expect(keys(v, "Daily/b.md")).toEqual(after);
    await undo(v, redo);
    expect(fm(v, "Daily/b.md")).not.toHaveProperty("metric_drinks");
  });

  it("redoes an insert: the file comes back as it was, and goes again", async () => {
    const v = logVault();
    const P = `${LOG_DIR}/2026/09/27/2026-09-27 walk.md`;
    const r = await insertRow(v.app, v.settings, { table: "log", values: { kind: "walk", occurred_at: "2026-09-27T19:00" }, body: "Park.\n" });
    expect(r.ok).toBe(true);
    const text = v.read(P);
    const u = await undo(v, r.migration_id!);
    expect(v.exists(P)).toBe(false);
    expect((await readJournal(v.app, v.settings, u)).entry.deleted).toEqual([{ path: P, content: text }]);
    const redo = await undo(v, u);
    expect(v.read(P)).toBe(text);
    expect((await readJournal(v.app, v.settings, redo)).entry.creates).toEqual([P]);
    await undo(v, redo);
    expect(v.exists(P)).toBe(false);
  });

  it("redoes a delete: the file goes again", async () => {
    const v = logVault();
    const text = v.read("Daily/b.md");
    const r = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" }, mode: "delete" });
    expect(r.ok).toBe(true);
    const u = await undo(v, r.migration_id!);
    expect(v.read("Daily/b.md")).toBe(text);
    await undo(v, u);
    expect(v.exists("Daily/b.md")).toBe(false);
  });

  it("redoes a schema change: the metastore gets the redone text back", async () => {
    const v = logVault();
    const r = await createTable(v.app, v.settings, described({ schema: "public", name: "memo", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] }));
    expect(r.ok).toBe(true);
    const withMemo = v.read(METASTORE);
    const u = await undo(v, r.migration_id!);
    expect(v.read(METASTORE)).not.toContain("memo");
    await undo(v, u);
    expect(v.read(METASTORE)).toBe(withMemo);
    expect((await insertRow(v.app, v.settings, { table: "memo", values: { title: "x" }, path: "Memo/x.md" })).ok).toBe(true);
  });

  it("redoes an adopt that moved the notes", async () => {
    const v = logVault({ "Inbox/walk.md": "---\nkind: walk\noccurred_at: 2026-09-20T10:00\n---\nLake.\n" });
    const P = `${LOG_DIR}/2026/09/20/2026-09-20 walk.md`;
    const r = await adoptRows(v.app, v.settings, { table: "log", paths: ["Inbox/walk.md"] });
    expect(r.ok, JSON.stringify([r.conflicts, r.violations])).toBe(true);
    const u = await undo(v, r.migration_id!);
    expect([v.exists(P), v.exists("Inbox/walk.md")]).toEqual([false, true]);
    expect(fm(v, "Inbox/walk.md")).not.toHaveProperty("table");
    await undo(v, u);
    expect([v.exists(P), v.exists("Inbox/walk.md")]).toEqual([true, false]);
    expect(fm(v, P)).toMatchObject({ table: "main.public.log", kind: "walk" });
  });

  it("redoes a whole batch: its undo is a batch of the undos", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const P = `${LOG_DIR}/2026/09/27/2026-09-27 walk.md`;
    const r = await api.batch({
      operations: [
        { op: "insertRow", table: "log", values: { kind: "walk", occurred_at: "2026-09-27T19:00" } },
        { op: "updateRow", table: "log", path: "Daily/b.md", set: { metric_drinks: 1 } },
      ],
    });
    expect(r.ok).toBe(true);
    const u = await undo(v, r.migration_id!);
    const entry = (await readJournal(v.app, v.settings, u)).entry;
    expect([entry.op, entry.undoes, entry.members?.length]).toEqual(["batch", r.migration_id, 2]);
    expect([v.exists(P), fm(v, "Daily/b.md").metric_drinks]).toEqual([false, undefined]);
    const redo = await undo(v, u);
    expect([v.exists(P), fm(v, "Daily/b.md").metric_drinks]).toEqual([true, 1]);
    await undo(v, redo);
    expect([v.exists(P), fm(v, "Daily/b.md").metric_drinks]).toEqual([false, undefined]);
  });
});
