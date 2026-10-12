/**
 * rename_value / rename_column / drop_column edges (engine.ts): the `ref_by` levels that name a
 * renamed value or column follow it, on the table itself (`ref: self`) and on the tables linking
 * to it (levels written out as a map when only one side changes), CHECKs keep their operators,
 * and untyped fields (a table's `fields`) are renamed and dropped like columns.
 */

import { describe, expect, it } from "vitest";
import { addConstraint } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { createTable, dropColumn, INDEX_RETRY, OperationInputError, renameColumn, renameValue } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { parseMetastore } from "../src/core/metastore";
import { checkTable, insertRow } from "../src/core/rows";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const entryOf = (v: DbVault, table: string) => parseMetastore(v.read(METASTORE)).catalogs.main!.schemas.work!.tables[table]!;
const column = (v: DbVault, table: string, name: string) => entryOf(v, table).columns.find((c) => c.name === name);

async function refused(p: Promise<unknown>, cls: abstract new (...args: never[]) => Error, message: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(cls);
  expect((e as Error).message).toBe(message);
}

const P = "Datanotes/main/work/project";
const I = "Datanotes/main/work/item";
const T = "Datanotes/main/work/task";
const ref = (n: string) => `[[${n}]]`;
const LEVELS = ["area", "project", "workstream"];

/**
 * `project`: a tree whose `parent` follows the levels of `kind` (ref: self), a `status` with a
 * CHECK, an untyped field `category`. `item` links to a project with the same levels (its own
 * `kind`); `task` links to a project through a map (`scope` → the project's `kind`).
 */
async function workVault(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  const tables = [
    {
      name: "project",
      options: { filename: "{name}" },
      fields: { category: "work" },
      columns: [
        { name: "name", type: "string", required: true, dense: true },
        { name: "kind", type: "enum", values: LEVELS, default: "project", dense: true },
        { name: "status", type: "enum", values: ["open", "done", "dropped"] },
        { name: "parent", type: "link", ref: "self", ref_by: { column: "kind", levels: LEVELS } },
      ],
    },
    {
      name: "item",
      options: { filename: "{title}" },
      columns: [
        { name: "title", type: "string", required: true, dense: true },
        { name: "kind", type: "enum", values: LEVELS },
        { name: "state", type: "enum", values: ["open", "done"] },
        { name: "parent", type: "link", ref: "main.work.project", ref_by: { column: "kind", levels: LEVELS } },
      ],
    },
    {
      name: "task",
      options: { filename: "{title}" },
      columns: [
        { name: "title", type: "string", required: true, dense: true },
        { name: "scope", type: "enum", values: ["project", "workstream"] },
        { name: "under", type: "link", ref: "main.work.project", ref_by: { column: "scope", target_column: "kind", map: { project: ["area"], workstream: ["project"] } } },
      ],
    },
  ];
  for (const t of tables) {
    const r = await createTable(v.app, v.settings, described({ schema: "work", ...t }));
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
  }
  const rows: [string, Record<string, unknown>][] = [
    ["project", { name: "Home", kind: "area", status: "open" }],
    ["project", { name: "Site", kind: "project", status: "open", parent: ref("Home") }],
    ["project", { name: "Build", kind: "workstream", status: "dropped", parent: ref("Site") }],
    ["item", { title: "Plan", kind: "project", state: "open", parent: ref("Home") }],
    ["item", { title: "Paint", kind: "workstream", state: "done", parent: ref("Site") }],
    ["task", { title: "Order", scope: "workstream", under: ref("Site") }],
  ];
  for (const [table, values] of rows) {
    const r = await insertRow(v.app, v.settings, { table, values });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  }
  return v;
}

describe("rename_value", () => {
  it("refuses a column the table does not have, and an empty from / to", async () => {
    const v = await workVault();
    await refused(renameValue(v.app, v.settings, { table: "project", column: "stage", from: "area", to: "domain" }), OperationInputError, `column "stage" not found in table "project"`);
    await refused(
      renameValue(v.app, v.settings, { table: "project", column: "kind", from: undefined as never, to: undefined as never }),
      OperationInputError,
      `"from" and "to" must be non-empty`,
    );
  });

  it("renames the column's default and the levels that name the value, here and on the tables linking to it", async () => {
    const v = await workVault();
    const r = await renameValue(v.app, v.settings, { table: "project", column: "kind", from: "project", to: "initiative" });
    expect(r.ok, JSON.stringify([r.conflicts, r.violations])).toBe(true);
    expect(r.planned_edits.map((p) => [p.path, p.set])).toEqual([[`${P}/Site.md`, { kind: "initiative" }]]);
    expect(column(v, "project", "kind")).toEqual({ name: "kind", type: "enum", values: ["area", "initiative", "workstream"], default: "initiative", dense: true, description: "Test column kind" });
    // its own tree: both sides of the levels are this column, they stay levels
    expect(column(v, "project", "parent")).toEqual({ name: "parent", type: "link", ref: "self", ref_by: { column: "kind", levels: ["area", "initiative", "workstream"] }, description: "Test column parent" });
    // another table with the same words: only the target side changes, written out as a map
    expect(column(v, "item", "parent")!.ref_by).toEqual({ column: "kind", map: { area: null, project: ["area"], workstream: ["initiative"] } });
    // a map: the targets it allows follow
    expect(column(v, "task", "under")!.ref_by).toEqual({ column: "scope", target_column: "kind", map: { project: ["area"], workstream: ["initiative"] } });
    // the item's own values are not the project's: untouched
    expect(fm(v, `${I}/Plan.md`).kind).toBe("project");
    expect((await checkTable(v.app, v.settings, {})).violations).toEqual([]);
    // a new project gets the renamed default
    const added = await insertRow(v.app, v.settings, { table: "project", values: { name: "Shop", status: "open", parent: ref("Home") } });
    expect(added.ok, JSON.stringify(added.violations)).toBe(true);
    expect(fm(v, `${P}/Shop.md`).kind).toBe("initiative");
  });

  it("keeps the other operators of a CHECK on the column and leaves levels that read another column alone", async () => {
    const v = await workVault();
    await insertRow(v.app, v.settings, { table: "project", values: { name: "Shop", kind: "project", status: "open", parent: ref("Home") } });
    const added = await addConstraint(v.app, v.settings, { table: "project", name: "live", check: { status: { exists: true, ne: "done" } } });
    expect(added.ok, JSON.stringify(added.conflicts)).toBe(true);
    const parentBefore = column(v, "project", "parent");
    const r = await renameValue(v.app, v.settings, { table: "project", column: "status", from: "done", to: "closed" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(entryOf(v, "project").constraints).toEqual({ live: { status: { exists: true, ne: "closed" } } });
    expect(column(v, "project", "parent")).toEqual(parentBefore);
    expect(column(v, "project", "status")!.values).toEqual(["open", "closed", "dropped"]);
  });

  it("renames the row side of levels pointing at another table: written out as a map", async () => {
    const v = await workVault();
    const r = await renameValue(v.app, v.settings, { table: "item", column: "kind", from: "workstream", to: "stream" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(column(v, "item", "parent")!.ref_by).toEqual({ column: "kind", map: { area: null, project: ["area"], stream: ["project"] } });
    expect(fm(v, `${I}/Paint.md`).kind).toBe("stream");
    // the project's own levels are another table's words: untouched
    expect(column(v, "project", "parent")!.ref_by).toEqual({ column: "kind", levels: LEVELS });
    expect((await checkTable(v.app, v.settings, { table: "item" })).violations).toEqual([]);
  });

  it("renames the keys of a ref_by map when the row's column is renamed", async () => {
    const v = await workVault();
    const r = await renameValue(v.app, v.settings, { table: "task", column: "scope", from: "workstream", to: "stream" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(column(v, "task", "under")!.ref_by).toEqual({ column: "scope", target_column: "kind", map: { project: ["area"], stream: ["project"] } });
    expect(fm(v, `${T}/Order.md`).scope).toBe("stream");
  });
});

describe("rename_column", () => {
  it("of a column read by other tables' ref_by: their target column follows", async () => {
    const v = await workVault();
    const r = await renameColumn(v.app, v.settings, { table: "project", from: "kind", to: "stage" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(column(v, "project", "parent")!.ref_by).toEqual({ column: "stage", levels: LEVELS });
    expect(column(v, "item", "parent")!.ref_by).toEqual({ column: "kind", levels: LEVELS, target_column: "stage" });
    expect(column(v, "task", "under")!.ref_by).toEqual({ column: "scope", target_column: "stage", map: { project: ["area"], workstream: ["project"] } });
    expect(fm(v, `${P}/Site.md`)).toMatchObject({ stage: "project" });
    expect((await checkTable(v.app, v.settings, {})).violations).toEqual([]);
  });

  it("of the row side of levels pointing at another table: the target column stays, named", async () => {
    const v = await workVault();
    const r = await renameColumn(v.app, v.settings, { table: "item", from: "kind", to: "level" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(column(v, "item", "parent")!.ref_by).toEqual({ column: "level", target_column: "kind", levels: LEVELS });
    expect(fm(v, `${I}/Paint.md`)).toMatchObject({ level: "workstream" });
    expect((await checkTable(v.app, v.settings, { table: "item" })).violations).toEqual([]);
  });

  it("of an untyped field: the table's default and the rows follow", async () => {
    const v = await workVault();
    expect(entryOf(v, "project").fields).toEqual({ category: "work" });
    expect(fm(v, `${P}/Home.md`).category).toBe("work");
    const r = await renameColumn(v.app, v.settings, { table: "project", from: "category", to: "domain" });
    expect([r.ok, r.notes_changed]).toEqual([true, 3]);
    expect(entryOf(v, "project").fields).toEqual({ domain: "work" });
    expect(fm(v, `${P}/Home.md`)).toMatchObject({ domain: "work" });
    expect(fm(v, `${P}/Home.md`)).not.toHaveProperty("category");
  });
});

describe("drop_column", () => {
  it("of an untyped field removes the table's default and the rows' values; columns are untouched", async () => {
    const v = await workVault();
    const columns = entryOf(v, "project").columns;
    const r = await dropColumn(v.app, v.settings, { table: "project", name: "category" });
    expect([r.ok, r.notes_changed]).toEqual([true, 3]);
    expect(entryOf(v, "project")).not.toHaveProperty("defaults");
    expect(entryOf(v, "project").columns).toEqual(columns);
    expect(fm(v, `${P}/Build.md`)).not.toHaveProperty("category");
    // a typed column next: its definition goes too
    const typed = await dropColumn(v.app, v.settings, { table: "item", name: "state" });
    expect([typed.ok, typed.notes_changed]).toEqual([true, 2]);
    expect(entryOf(v, "item").columns.map((c) => c.name)).toEqual(["id", "title", "kind", "parent"]);
    expect(fm(v, `${I}/Paint.md`)).not.toHaveProperty("state");
  });
});

describe("rename_value and value descriptions", () => {
  it("the renamed value's description follows it; a value without one leaves them alone", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { default_schema: "work" }, async () => {});
    const status = { name: "status", type: "enum", values: ["to watch", "seen"], value_descriptions: { seen: "seen at least once" } };
    expect((await createTable(v.app, v.settings, described({ name: "film", options: { filename: "{title}" }, columns: [{ name: "title", type: "string", required: true }, status] }))).ok).toBe(true);
    const r = await renameValue(v.app, v.settings, { table: "film", column: "status", from: "seen", to: "watched" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const c = column(v, "film", "status")!;
    expect(c.values).toEqual(["to watch", "watched"]);
    expect(c.value_descriptions).toEqual({ watched: "seen at least once" });
    // a value without a description: the descriptions stay as they are
    expect((await renameValue(v.app, v.settings, { table: "film", column: "status", from: "to watch", to: "wishlist" })).ok).toBe(true);
    expect(column(v, "film", "status")!.value_descriptions).toEqual({ watched: "seen at least once" });
  });
});
