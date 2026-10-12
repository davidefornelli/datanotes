import { describe, expect, it } from "vitest";
import { defineBase, setTableBases } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { addColumn, alterColumn, createTable, INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { parseMetastore } from "../src/core/metastore";
import { checkTable, insertRow, recomputeColumns, select, updateRow } from "../src/core/rows";
import { createDbVault, type DbVault, METASTORE } from "./helpers/db-vault";
import { described, describedBase } from "./helpers/descriptions";
import { CREATED_DESCRIPTION } from "../src/core/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const yaml = (v: DbVault) => parseMetastore(v.read(METASTORE));
const A = "Datanotes/main/knowledge/area";

const ENTITY = [
  { name: "created_at", type: "datetime", identity: "created", label: "Created" },
  { name: "description", type: "string", description: "One line" },
  { name: "topics", type: "list", items: "string" },
];
const HIER = [{ name: "parent", type: "link", ref: "self", hierarchy: true }];

async function areas(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  expect((await defineBase(v.app, v.settings, describedBase({ name: "entity", columns: ENTITY, description: "Common columns" }))).ok).toBe(true);
  expect((await defineBase(v.app, v.settings, describedBase({ name: "hierarchical", columns: HIER }))).ok).toBe(true);
  await createTable(v.app, v.settings, described({ schema: "knowledge", name: "area", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true, unique: true, dense: true }] }));
  expect((await setTableBases(v.app, v.settings, { table: "area", bases: ["entity", "hierarchical"] })).ok).toBe(true);
  const link = (n: string) => `[[${A}/${n}|${n}]]`;
  for (const [name, parent] of [["Homelab", null], ["AI & MCP", "Homelab"], ["MCP Servers", "AI & MCP"], ["Household", null]] as const) {
    const r = await insertRow(v.app, v.settings, { table: "area", values: { name, ...(parent ? { parent: link(parent) } : {}) } }, { now: new Date("2026-09-29T08:00:00Z") });
    expect(r.ok).toBe(true);
  }
  return v;
}

describe("bases", () => {
  it("a table inherits the columns of its bases; ref: self means that table", async () => {
    const v = await areas();
    const y = yaml(v);
    expect(Object.keys(y.bases)).toEqual(["entity", "hierarchical"]);
    const own = y.catalogs.main!.schemas.knowledge!.tables.area!;
    expect(own.bases).toEqual(["entity", "hierarchical"]);
    expect(own.columns.map((c) => c.name)).toEqual(["id", "name"]); // inherited columns are not copied
    // the engine describes a column it sets itself
    expect(y.bases.entity!.columns[0]).toEqual({ name: "created_at", type: "datetime", identity: "created", label: "Created", description: CREATED_DESCRIPTION });
    expect(y.bases.entity!.columns[1]).toEqual({ name: "description", type: "string", description: "One line" });
    const cols = await select(v.app, v.settings, { table: "system.information_schema.columns", where: { table_name: "area" }, columns: ["column_name", "inherited_from", "is_hierarchy"] });
    expect(cols.rows.map((r) => [r.column_name, r.inherited_from ?? "-"])).toEqual([
      ["id", "-"], ["created_at", "entity"], ["description", "entity"], ["topics", "entity"], ["parent", "hierarchical"], ["name", "-"],
    ]);
    expect(fm(v, `${A}/AI & MCP.md`)).toMatchObject({ created_at: "2026-09-29T10:00:00+02:00", parent: `[[${A}/Homelab|Homelab]]` });
  });

  it("a table may restyle an inherited column but not redefine it", async () => {
    const v = await areas();
    expect((await addColumn(v.app, v.settings, described({ table: "area", column: { name: "note", type: "string" } }))).ok).toBe(true);
    await expect(addColumn(v.app, v.settings, described({ table: "area", column: { name: "topics", type: "string" } }))).rejects.toThrow();
    const y = yaml(v).catalogs.main!.schemas.knowledge!.tables.area!;
    expect(y.columns.map((c) => c.name)).toEqual(["id", "name", "note"]);
  });

  it("renaming or dropping a base column changes every inheriting table's rows", async () => {
    const v = await areas();
    await updateRow(v.app, v.settings, { table: "area", path: `${A}/Household.md`, set: { topics: ["household"] } });
    const r = await defineBase(v.app, v.settings, describedBase({
      name: "entity",
      columns: [ENTITY[0]!, ENTITY[1]!, { name: "tags", type: "list", items: "string" }],
      renameColumns: { topics: "tags" },
    }));
    expect(r.ok).toBe(true);
    expect(fm(v, `${A}/Household.md`).tags).toEqual(["household"]);
    expect(fm(v, `${A}/Household.md`)).not.toHaveProperty("topics");
    await expect(defineBase(v.app, v.settings, describedBase({ name: "entity", columns: [ENTITY[0]!] }))).rejects.toThrow(/would lose column "description"/);
    expect((await defineBase(v.app, v.settings, describedBase({ name: "entity", columns: [ENTITY[0]!, { name: "tags", type: "list", items: "string" }], dropColumns: ["description"] }))).ok).toBe(true);
    expect((await checkTable(v.app, v.settings, { table: "area" })).violations).toEqual([]);
  });

  it("identity: created is filled from the file's creation time for existing notes, and never changes", async () => {
    const v = await areas();
    v.write(`${A}/Health.md`, "---\ntable: main.knowledge.area\nname: Health\n---\n");
    const check = await checkTable(v.app, v.settings, { table: "area" });
    expect(check.violations.flatMap((x) => x.violations.map((y) => `${y.column}:${y.code}`))).toEqual(expect.arrayContaining(["created_at:generated", "id:generated"]));
    expect((await recomputeColumns(v.app, v.settings, { table: "area" })).ok).toBe(true);
    const created = fm(v, `${A}/Health.md`).created_at as string;
    expect(created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    await updateRow(v.app, v.settings, { table: "area", path: `${A}/Health.md`, set: { description: "Health" } });
    expect(fm(v, `${A}/Health.md`).created_at).toBe(created);
    await expect(updateRow(v.app, v.settings, { table: "area", path: `${A}/Health.md`, set: { created_at: "2020-01-01T00:00" } })).rejects.toThrow(/generated/);
  });
});

describe("set_table_bases", () => {
  it("keeps an own column's presentation and dense flag, and refuses to drop its constraints", async () => {
    const v = createDbVault({});
    await defineBase(v.app, v.settings, describedBase({ name: "entity", columns: ENTITY }));
    await createTable(v.app, v.settings, described({
      name: "skill", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string" }, { name: "description", type: "string", required: true, dense: true, label: "What it does" }],
    }));
    await expect(setTableBases(v.app, v.settings, { table: "skill", bases: ["entity"] })).rejects.toThrow(/"description" has required/);
    await createTable(v.app, v.settings, described({
      name: "note", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string" }, { name: "description", type: "string", dense: true, label: "What it does", description: "One line" }],
    }));
    expect((await setTableBases(v.app, v.settings, { table: "note", bases: ["entity"] })).ok).toBe(true);
    const own = yaml(v).catalogs.main!.schemas.public!.tables.note!.columns;
    expect(own.find((c) => c.name === "description")).toEqual({ name: "description", label: "What it does", dense: true });
  });
});

describe("alter_column date -> datetime", () => {
  it("widens every date to midnight in the database time zone", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    await createTable(v.app, v.settings, described({ name: "doc", options: { filename: "{t}" }, columns: [{ name: "t", type: "string" }, { name: "created_on", type: "date" }] }));
    await insertRow(v.app, v.settings, { table: "doc", values: { t: "a", created_on: "2026-01-15" } });
    await insertRow(v.app, v.settings, { table: "doc", values: { t: "b" } });
    expect((await alterColumn(v.app, v.settings, { table: "doc", name: "created_on", changes: { type: "datetime" } })).ok).toBe(true);
    expect(fm(v, "Datanotes/main/public/doc/a.md").created_on).toBe("2026-01-15T00:00:00+01:00");
    expect(fm(v, "Datanotes/main/public/doc/b.md")).not.toHaveProperty("created_on");
  });
});

describe("alter_column ref", () => {
  it("refuses a ref that existing links do not satisfy", async () => {
    const v = createDbVault({});
    for (const name of ["log", "mood"]) await createTable(v.app, v.settings, described({ name, options: { filename: "{n}" }, columns: [{ name: "n", type: "string" }] }));
    await insertRow(v.app, v.settings, { table: "mood", values: { n: "m1" } });
    await addColumn(v.app, v.settings, described({ table: "log", column: { name: "event", type: "link" } }));
    await insertRow(v.app, v.settings, { table: "log", values: { n: "l1", event: "[[m1]]" } });
    const r = await alterColumn(v.app, v.settings, { table: "log", name: "event", changes: { ref: "main.public.log" } }, { dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.violations[0]!.code).toBe("ref");
  });
});

describe("full-name refs", () => {
  it("link columns name their target table in full (or self)", async () => {
    const v = createDbVault({});
    await expect(createTable(v.app, v.settings, described({ name: "a", options: { filename: "{n}" }, columns: [{ name: "n", type: "string" }, { name: "p", type: "link", ref: "person" }] }))).rejects.toThrow(/full table name/);
    await expect(createTable(v.app, v.settings, described({ name: "a", options: { filename: "{n}" }, columns: [{ name: "n", type: "string" }, { name: "p", type: "link", ref: "main.public.person" }] }))).rejects.toThrow(/is not a table/);
    expect((await createTable(v.app, v.settings, described({ name: "a", options: { filename: "{n}" }, columns: [{ name: "n", type: "string" }, { name: "up", type: "link", ref: "self", hierarchy: true }] }))).ok).toBe(true);
    // a table written before full names were required: its other columns can still change, one ref at a time
    const y = v.read(METASTORE).replace("ref: self", "ref: a");
    expect(y).toContain("ref: a\n");
    v.write(METASTORE, y);
    await createTable(v.app, v.settings, described({ name: "b", options: { filename: "{n}" }, columns: [{ name: "n", type: "string" }] }));
    await addColumn(v.app, v.settings, described({ table: "a", column: { name: "b", type: "link", ref: "main.public.b" } }));
    expect((await alterColumn(v.app, v.settings, { table: "a", name: "up", changes: { ref: "main.public.a" } })).ok).toBe(true);
  });
});

describe("hierarchy", () => {
  it("refuses a parent that would make a row its own ancestor", async () => {
    const v = await areas();
    const r = await updateRow(v.app, v.settings, { table: "area", path: `${A}/Homelab.md`, set: { parent: `[[${A}/MCP Servers|MCP Servers]]` } });
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.violations[0]).toMatchObject({ column: "parent", code: "cycle" });
    expect(r.violations[0]!.violations[0]!.message).toContain("Homelab → MCP Servers → AI & MCP → Homelab");
    const self = await updateRow(v.app, v.settings, { table: "area", path: `${A}/Household.md`, set: { parent: `[[${A}/Household|Household]]` } });
    expect(self.violations[0]!.violations[0]!.code).toBe("cycle");
    expect((await updateRow(v.app, v.settings, { table: "area", path: `${A}/Household.md`, set: { parent: `[[${A}/Homelab|Homelab]]` } })).ok).toBe(true);
  });

  it("within selects a whole branch, root included, also through another table's link column", async () => {
    const v = await areas();
    const sub = await select(v.app, v.settings, { table: "area", where: { parent: { within: "Homelab" } }, columns: ["name"] });
    expect(sub.rows.map((r) => r.name).sort()).toEqual(["AI & MCP", "MCP Servers"]);
    const either = await select(v.app, v.settings, { table: "area", where: { or: [{ parent: { within: "AI & MCP" } }, { name: "Household" }] }, columns: ["name"] });
    expect(either.rows.map((r) => r.name).sort()).toEqual(["Household", "MCP Servers"]);
    await createTable(v.app, v.settings, described({
      schema: "knowledge", name: "document", options: { filename: "{title}" },
      columns: [{ name: "title", type: "string", required: true }, { name: "area", type: "link", ref: "main.knowledge.area" }],
    }));
    for (const [title, area] of [["MCP guide", "MCP Servers"], ["Homelab map", "Homelab"], ["Tiles", "Household"]] as const) {
      await insertRow(v.app, v.settings, { table: "document", values: { title, area: `[[${A}/${area}|${area}]]` } });
    }
    const docs = await select(v.app, v.settings, { table: "document", where: { area: { within: "[[Homelab]]" } }, columns: ["title"] });
    expect(docs.rows.map((r) => r.title).sort()).toEqual(["Homelab map", "MCP guide"]);
    await expect(select(v.app, v.settings, { table: "document", where: { title: { within: "x" } } })).rejects.toThrow(/link column/);
    await expect(select(v.app, v.settings, { table: "document", where: { area: { within: "Nowhere" } } })).rejects.toThrow(/no row/);
  });

  it("refuses a caller-supplied in_any (the internal operator within resolves into), alone or mixed, on any column", async () => {
    const v = await areas();
    const unknown = /unknown operator "in_any" \(use eq, ne, gt, gte, lt, lte, in, contains, icontains, exists, within\)/;
    for (const where of [
      { parent: { in_any: ["[[Homelab]]"] } },
      { parent: { within: "Homelab", in_any: [] } },
      { parent: { ne: "[[Household]]", in_any: ["[[Homelab]]"] } },
      { path: { in_any: [`${A}/Homelab.md`] } },
      { or: [{ name: "Household" }, { parent: { in_any: ["[[Homelab]]"] } }] },
    ]) {
      await expect(select(v.app, v.settings, { table: "area", where })).rejects.toThrow(unknown);
    }
    // within, which resolves into in_any, still works, also mixed with another operator
    const sub = await select(v.app, v.settings, { table: "area", where: { parent: { within: "Homelab", ne: "[[AI & MCP]]" } }, columns: ["name"] });
    expect(sub.rows.map((r) => r.name)).toEqual(["AI & MCP"]);
  });
});
