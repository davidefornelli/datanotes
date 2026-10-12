import { readJournal } from "../src/core/journal";
import { describe, expect, it } from "vitest";
import {
  addColumn,
  alterColumn,
  archiveFolder,
  createTable,
  dropColumn,
  dropTable,
  loadTable,
  OperationInputError,
  renameColumn,
  serializeColumn,
  undoOperation,
} from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { catalogLayout } from "../src/core/table-loader";
import { TableNotFoundError } from "../src/core/table-registry";
import { createDbVault, logVault, LOG_DIR, METASTORE } from "./helpers/db-vault";
import { INDEX_RETRY } from "../src/core/engine";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const now = new Date(2026, 8, 26, 13, 5, 12);

function fm(v: { read(rel: string): string }, rel: string): Record<string, unknown> {
  return Object.fromEntries(readOrderedFromMarkdown(v.read(rel)).ordered);
}

describe("rename_column", () => {
  it("renames in metastore.yaml and rows; journals; undo restores", async () => {
    const v = logVault();
    const r = await renameColumn(v.app, v.settings, { table: "log", from: "metric_drinks", to: "metric_alcohol_units" }, { now });
    expect(r.ok).toBe(true);
    expect(r.notes_changed).toBe(1); // row a (metastore.yaml is not a note)
    expect(fm(v, "Daily/a.md").metric_alcohol_units).toBe(7);
    expect(fm(v, "Daily/a.md")).not.toHaveProperty("metric_drinks");
    const t = await loadTable(v.app, v.settings, "log");
    expect(t.def.columns.map((c) => c.name)).toContain("metric_alcohol_units");
    expect(r.migration_id).toMatch(/^20260926T130512-rename_column/);
    expect(v.read("store:journal/2026-09.jsonl")).toContain(r.migration_id!);
    expect(v.exists("store:journal/2026-09.jsonl")).toBe(true);
    expect(v.list().some((p) => p.includes("migrations"))).toBe(false); // nothing in the vault's notes

    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok).toBe(true);
    expect(fm(v, "Daily/a.md").metric_drinks).toBe(7);
    expect(Object.keys(fm(v, "Daily/a.md"))).toEqual(["table", "id", "kind", "occurred_at", "metric_drinks"]);
    expect((await readJournal(v.app, v.settings, r.migration_id!)).undone).toBe(true);

    const again = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(again.ok).toBe(false);
    expect(again.conflicts[0]!.message).toMatch(/already undone/);
  });

  it("dry run plans without writing", async () => {
    const v = logVault();
    const before = v.list();
    const r = await renameColumn(v.app, v.settings, { table: "main.public.log", from: "metric_drinks", to: "units" }, { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(r.planned_edits.map((p) => p.path)).toEqual(["Daily/a.md"]);
    expect(v.list()).toEqual(before);
  });

  it("refuses the whole operation on one conflicting row", async () => {
    const v = logVault({
      "Daily/c.md": '---\ntable: main.public.log\nkind: mood\nmetric_drinks: 1\nunits: 2\n---\n',
    });
    const r = await renameColumn(v.app, v.settings, { table: "log", from: "metric_drinks", to: "units" });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ path: "Daily/c.md", message: 'row has both "metric_drinks" and "units" with different values' }]);
    expect(fm(v, "Daily/a.md").metric_drinks).toBe(7);
    expect(v.exists("_meta/migrations")).toBe(false);
  });

  it("overwrites an empty target key", async () => {
    const v = logVault({ "Daily/c.md": '---\ntable: main.public.log\nkind: mood\nmetric_drinks: 1\nunits:\n---\n' });
    expect((await renameColumn(v.app, v.settings, { table: "log", from: "metric_drinks", to: "units" })).ok).toBe(true);
    expect(fm(v, "Daily/c.md").units).toBe(1);
  });

  it("validates inputs", async () => {
    const v = logVault();
    await expect(renameColumn(v.app, v.settings, { table: "log", from: "nope", to: "x" })).rejects.toThrow(OperationInputError);
    await expect(renameColumn(v.app, v.settings, { table: "log", from: "kind", to: "occurred_at" })).rejects.toThrow(/already exists/);
    await expect(renameColumn(v.app, v.settings, { table: "log", from: "kind", to: "_columns" })).rejects.toThrow(/must start with a letter/);
    await expect(renameColumn(v.app, v.settings, { table: "log", from: "kind", to: "table" })).rejects.toThrow(/already exists/);
    await expect(renameColumn(v.app, v.settings, { table: "nope", from: "kind", to: "x" })).rejects.toThrow(TableNotFoundError);
  });
});

describe("add_column / alter_column / drop_column", () => {
  it("adds a sparse column without touching rows", async () => {
    const v = logVault();
    const r = await addColumn(v.app, v.settings, described({
      table: "log",
      column: { name: "metric_mood", type: "integer", min: 1, max: 5, aliases: ["feeling"] },
    }));
    expect(r.ok).toBe(true);
    expect(r.notes_changed).toBe(0);
    const t = await loadTable(v.app, v.settings, "log");
    const c = t.def.columns.find((x) => x.name === "metric_mood")!;
    expect(c.dense).toBe(false);
    expect(c.aliases).toEqual(["feeling"]);
  });

  it("adds a dense column with default to schema and rows, before meta keys", async () => {
    const v = logVault();
    const r = await addColumn(v.app, v.settings, described({
      table: "log",
      column: { name: "source", type: "string", default: "manual", dense: true },
    }));
    expect(r.ok).toBe(true);
    expect(fm(v, "Daily/b.md").source).toBe("manual");
    expect((await loadTable(v.app, v.settings, "log")).def.columns.find((c) => c.name === "source")!.dense).toBe(true);
  });

  it("evaluates a {today} / {now} default for existing rows instead of writing the token", async () => {
    const v = logVault();
    const sparse = await addColumn(v.app, v.settings, described({ table: "log", column: { name: "added", type: "date", default: "{today}" } }));
    expect(sparse.ok, JSON.stringify(sparse.violations)).toBe(true);
    expect(fm(v, "Daily/b.md").added).toBeUndefined();
    const dense = await addColumn(v.app, v.settings, described({ table: "log", column: { name: "seen_at", type: "datetime", default: "{now}", dense: true } }));
    expect(dense.ok, JSON.stringify(dense.violations)).toBe(true);
    expect(String(fm(v, "Daily/b.md").seen_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const def = (await loadTable(v.app, v.settings, "log")).def.columns.find((c) => c.name === "seen_at")!;
    expect(def.default).toBe("{now}");
  });

  it("refuses a required column that existing rows cannot satisfy, and duplicates", async () => {
    const v = logVault();
    const r = await addColumn(v.app, v.settings, described({ table: "log", column: { name: "mood", type: "integer", required: true } }));
    expect(r.ok).toBe(false);
    expect(r.violations.map((x) => x.path)).toEqual(["Daily/a.md", "Daily/b.md"]);
    await expect(addColumn(v.app, v.settings, described({ table: "log", column: { name: "kind", type: "string" } }))).rejects.toThrow(/already exists/);
    const bad = await addColumn(v.app, v.settings, described({ table: "log", column: { name: "table", type: "integer" } })).catch((e) => e);
    expect(bad).toBeInstanceOf(OperationInputError);
  });

  it("add_column validates existing values of a column already present on rows", async () => {
    const v = logVault({ "Daily/c.md": '---\ntable: main.public.log\nkind: mood\nscore: 9\n---\n' });
    const r = await addColumn(v.app, v.settings, described({ table: "log", column: { name: "score", type: "integer", max: 5 } }));
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.violations[0]!.code).toBe("max");
  });

  it("alter_column tightens constraints only when rows comply", async () => {
    const v = logVault();
    const bad = await alterColumn(v.app, v.settings, { table: "log", name: "metric_drinks", changes: { max: 5 } });
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]!.path).toBe("Daily/a.md");
    const ok = await alterColumn(v.app, v.settings, {
      table: "log",
      name: "metric_drinks",
      changes: { max: 20, label: "Drinks", min: null },
    });
    expect(ok.ok).toBe(true);
    const c = (await loadTable(v.app, v.settings, "log")).def.columns.find((x) => x.name === "metric_drinks")!;
    expect(c.max).toBe(20);
    expect(c.min).toBeUndefined();
    expect(c.label).toBe("Drinks");
    const req = await alterColumn(v.app, v.settings, { table: "log", name: "metric_drinks", changes: { required: true } });
    expect(req.violations.map((x) => x.path)).toEqual(["Daily/b.md"]);
  });

  it("alter_column dense on/off and input errors", async () => {
    const v = logVault();
    const on = await alterColumn(v.app, v.settings, {
      table: "log",
      name: "metric_drinks",
      changes: { dense: true, default: 0, required: true },
    });
    expect(on.ok).toBe(true);
    expect(fm(v, "Daily/b.md").metric_drinks).toBe(0);
    const off = await alterColumn(v.app, v.settings, { table: "log", name: "metric_drinks", changes: { dense: false } });
    expect(off.ok).toBe(true);
    expect((await loadTable(v.app, v.settings, "log")).def.columns.find((c) => c.name === "metric_drinks")!.dense).toBe(false);
    await expect(alterColumn(v.app, v.settings, { table: "log", name: "zzz", changes: {} })).rejects.toThrow(/not found/);
    await expect(alterColumn(v.app, v.settings, { table: "log", name: "kind", changes: { name: "k" } })).rejects.toThrow(/rename_column/);
  });

  it("drop_column removes the column everywhere and undo brings values back", async () => {
    const v = logVault();
    const r = await dropColumn(v.app, v.settings, { table: "log", name: "metric_drinks" }, { now });
    expect(r.ok).toBe(true);
    expect(fm(v, "Daily/a.md")).not.toHaveProperty("metric_drinks");
    expect((await loadTable(v.app, v.settings, "log")).def.columns.map((c) => c.name)).not.toContain("metric_drinks");
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok).toBe(true);
    expect(fm(v, "Daily/a.md").metric_drinks).toBe(7);
    expect((await loadTable(v.app, v.settings, "log")).def.columns.map((c) => c.name)).toContain("metric_drinks");
    await expect(dropColumn(v.app, v.settings, { table: "log", name: "nope" })).rejects.toThrow(/not found/);
  });

  it("undo refuses when a row changed after the operation", async () => {
    const v = logVault();
    const r = await dropColumn(v.app, v.settings, { table: "log", name: "metric_drinks" });
    v.write("Daily/a.md", '---\ntable: main.public.log\nkind: alcohol\nmetric_drinks: 2\n---\n');
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok).toBe(false);
    expect(u.conflicts.some((c) => c.path === "Daily/a.md")).toBe(true);
    await expect(undoOperation(v.app, v.settings, "missing")).rejects.toThrow(/Migration not found/);
  });
});

describe("tables", () => {
  it("create_table writes a catalog entry; undo removes it", async () => {
    const v = logVault();
    const before = v.read(METASTORE);
    const r = await createTable(v.app, v.settings, described({
      name: "person",
      options: { filename: "{name}" },
      fields: { kind: "person" },
      columns: [
        { name: "name", type: "string", required: true, dense: true },
        { name: "birthday", type: "date" },
      ],
    }));
    expect(r.ok).toBe(true);
    const t = await loadTable(v.app, v.settings, "main.public.person");
    expect(t.def.name).toBe("person");
    expect(t.def.columns.map((c) => `${c.name}:${c.dense}`)).toEqual(["id:true", "name:true", "birthday:false"]);
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok).toBe(true);
    expect(v.read(METASTORE)).toBe(before);
  });

  it("create_table input errors and existing table conflict", async () => {
    const v = logVault();
    const dup = await createTable(v.app, v.settings, described({ name: "log", options: { filename: "{id}" }, columns: [] }));
    expect(dup.conflicts[0]!.message).toMatch(/already exists/);
    const opts = { filename: "{a}" };
    await expect(
      createTable(v.app, v.settings, described({ name: "x", options: opts, columns: [{ name: "a", type: "string" }, { name: "a", type: "string" }] })),
    ).rejects.toThrow(/duplicate/);
    await expect(createTable(v.app, v.settings, described({ name: "x", options: opts, fields: { _table: 1 }, columns: [] }))).rejects.toThrow(/reserved/);
    await expect(
      createTable(v.app, v.settings, described({ name: "x", options: opts, fields: { a: 1 }, columns: [{ name: "a", type: "string" }] })),
    ).rejects.toThrow(/is in both "fields" and "columns"/);
    await expect(createTable(v.app, v.settings, described({ name: "x", columns: [] }))).rejects.toThrow(/file names/);
  });

  it("drop_table refuses with rows unless cascade archive", async () => {
    const v = logVault();
    const refused = await dropTable(v.app, v.settings, { table: "log" });
    expect(refused.ok).toBe(false);
    expect(refused.conflicts[0]!.message).toMatch(/2 rows/);
    const r = await dropTable(v.app, v.settings, { table: "log", mode: "archive" });
    expect(r.ok).toBe(true);
    expect(r.files_moved).toBe(2);
    expect(v.exists(`${LOG_DIR}/_archive/a.md`)).toBe(true);
    expect(v.read(METASTORE)).not.toContain("log:");
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok).toBe(true);
    expect(v.exists("Daily/a.md")).toBe(true);
    expect(v.read(METASTORE)).toContain("log:");
  });

  it("drop_table reports archive collisions", async () => {
    const v = logVault({ [`${LOG_DIR}/_archive/a.md`]: "x" });
    const r = await dropTable(v.app, v.settings, { table: "log", mode: "archive" });
    expect(r.conflicts.map((c) => c.path)).toEqual(["Daily/a.md"]);
  });

  it("archive defaults to _archive inside the table folder", () => {
    const ref = { catalog: "main", schema: "metrics", table: "mood", full: "main.metrics.mood" };
    expect(catalogLayout("Datanotes", ref, {})).toEqual({
      folder: "Datanotes/main/metrics/mood",
      inDatabase: true,
      rowPath: "Datanotes/main/metrics/mood",
      archive: "Datanotes/main/metrics/mood/_archive",
    });
    expect(catalogLayout("Datanotes", ref, { partition: "{occurred_at:YYYY/MM}", archive: "_old" })).toMatchObject({
      rowPath: "Datanotes/main/metrics/mood/{occurred_at:YYYY/MM}",
      archive: "Datanotes/main/metrics/mood/_old",
    });
    expect(catalogLayout("Datanotes", ref, { archive: "Old/mood" }).archive).toBe("Old/mood");
    const def = { schemaPath: `${METASTORE}#main.metrics.mood`, name: "mood", schema: "metrics", catalog: "main", options: {}, columns: [], untypedFields: [], layout: catalogLayout("Datanotes", ref, {}) };
    expect(archiveFolder(def)).toBe("Datanotes/main/metrics/mood/_archive");
  });

  it("serializeColumn omits empty attributes", () => {
    expect(serializeColumn({ name: "a", type: "string", required: false, aliases: [] })).toEqual({ name: "a", type: "string" });
  });
});

describe("index retry", () => {
  it("retries while the vault briefly misses metastore.yaml", async () => {
    const v = logVault();
    const real = v.app.vault.getAbstractFileByPath.bind(v.app.vault);
    let misses = 3;
    (v.app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }).getAbstractFileByPath = (p: string) =>
      p === METASTORE && misses-- > 0 ? null : real(p);
    const t = await loadTable(v.app, v.settings, "log");
    expect(t.def.name).toBe("log");
  });
});
