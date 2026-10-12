import { describe, expect, it } from "vitest";
import { defineBase, setTableBases } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { addColumn, alterColumn, createTable, dropColumn, INDEX_RETRY, renameColumn, renameValue, undoOperation, type OpResult } from "../src/core/engine";
import { describeHistory, restoreTable } from "../src/core/history";
import { loadMetastore } from "../src/core/metastore";
import { createPublicApi, describeTable } from "../src/core/public-api";
import { alterTable, checkTable, deleteRows, insertRow, linkOptions, updateRow } from "../src/core/rows";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const P = "Datanotes/main/work/project";
const ref = (n: string) => `[[${P}/${n}|${n}]]`;
const LEVELS = { column: "kind", levels: ["area", "project", "workstream"] };
const MAP = { area: null, project: ["area"], workstream: ["project"] };

/** `project` (self-referencing): Home (area) ← Site, Shop (projects) ← Build, Paint (workstreams of Site). */
async function projects(parent: Record<string, unknown> = {}, history = false): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome", ...(history ? { history: true } : {}) }, async () => {});
  const created = await createTable(v.app, v.settings, described({
    schema: "work",
    name: "project",
    options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true, unique: true, dense: true },
      { name: "kind", type: "enum", values: ["area", "project", "workstream"], dense: true },
      { name: "parent", type: "link", ref: "self", hierarchy: true, ...parent },
    ],
  }));
  expect(created.ok, JSON.stringify(created.conflicts)).toBe(true);
  for (const [name, kind, p] of [
    ["Home", "area", null],
    ["Site", "project", "Home"],
    ["Shop", "project", "Home"],
    ["Build", "workstream", "Site"],
    ["Paint", "workstream", "Site"],
  ] as const) {
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name, kind, ...(p ? { parent: ref(p) } : {}) } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  }
  return v;
}

const codes = (r: OpResult) => r.violations.flatMap((x) => x.violations.map((v) => [x.path, v.column, v.code]));
const message = (r: OpResult) => r.violations[0]?.violations[0]?.message ?? "";

describe("filtered link targets (ref_where / ref_by)", () => {
  it("describe_table shows the levels shortcut expanded; metastore.yaml keeps the shortcut", async () => {
    const v = await projects({ ref_by: LEVELS });
    const d = await describeTable(v.app, v.settings, "project");
    const parent = (d.columns as { name: string; ref_by?: unknown }[]).find((c) => c.name === "parent")!;
    expect(parent.ref_by).toEqual({ column: "kind", levels: ["area", "project", "workstream"], map: MAP });
    const ms = await loadMetastore(v.app, v.settings);
    const col = ms!.model.catalogs.main!.schemas.work!.tables.project!.columns.find((c) => c.name === "parent")!;
    expect(col.ref_by).toEqual(LEVELS);
    expect(ms!.text).toContain("levels:");
    expect(ms!.text).not.toContain("map:");
  });

  it("a workstream with no parent is refused with required, saying why", async () => {
    const v = await projects({ ref_by: LEVELS });
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream" } });
    expect(codes(r)).toEqual([[`${P}/Roof.md`, "parent", "required"]]);
    expect(message(r)).toBe(`is required for kind "workstream": it needs a parent with kind project`);
  });

  it("a parent of the wrong level is refused, listing the valid parents", async () => {
    const v = await projects({ ref_by: LEVELS });
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Home") } });
    expect(codes(r)).toEqual([[`${P}/Roof.md`, "parent", "ref"]]);
    expect(message(r)).toBe(`[[Home]] is not a valid parent for kind "workstream" (needs kind project); valid: Shop, Site`);
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Shop") } })).ok).toBe(true);
  });

  it("an area (top level) with a parent is refused", async () => {
    const v = await projects({ ref_by: { column: "kind", map: MAP } });
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name: "Work", kind: "area", parent: ref("Home") } });
    expect(codes(r)).toEqual([[`${P}/Work.md`, "parent", "ref"]]);
    expect(message(r)).toBe(`must be empty for kind "area": it is a top level (no parent)`);
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Work", kind: "area" } })).ok).toBe(true);
  });

  it("a value with no entry in the map is refused", async () => {
    const v = await projects();
    const r = await alterColumn(v.app, v.settings, { table: "project", name: "parent", changes: { ref_by: { column: "kind", map: { area: null, project: ["area"] } } } });
    expect(codes(r)).toEqual([
      [`${P}/Build.md`, "parent", "ref"],
      [`${P}/Paint.md`, "parent", "ref"],
    ]);
    expect(message(r)).toBe(`kind "workstream" has no entry in ref_by of parent (it has: area, project)`);
  });

  it("link_options returns only projects for a workstream, nothing for an area", async () => {
    const v = await projects({ ref_by: LEVELS });
    const ws = await linkOptions(v.app, v.settings, { table: "project", column: "parent", values: { kind: "workstream" } });
    expect(ws.rows).toEqual([
      { name: "Shop", link: ref("Shop"), path: `${P}/Shop.md`, kind: "project" },
      { name: "Site", link: ref("Site"), path: `${P}/Site.md`, kind: "project" },
    ]);
    expect(ws).toMatchObject({ total: 2, required: true, empty: false, ref: "main.work.project" });
    // an existing row: its own kind is read
    expect((await linkOptions(v.app, v.settings, { table: "project", column: "parent", row: "Site" })).rows.map((r) => r.name)).toEqual(["Home"]);
    expect((await linkOptions(v.app, v.settings, { table: "project", column: "parent", row: ref("Home") })).empty).toBe(true);
    const api = createPublicApi(v.app, () => v.settings);
    expect((await api.linkOptions({ table: "project", column: "parent", row: `${P}/Build.md`, values: { kind: "project" } })).rows.map((r) => r.name)).toEqual(["Home"]);
  });

  it("changing a project's kind re-checks its workstreams; a batch that moves them first succeeds", async () => {
    const v = await projects({ ref_by: LEVELS });
    const r = await updateRow(v.app, v.settings, { table: "project", path: `${P}/Site.md`, set: { kind: "area" }, unset: ["parent"] });
    expect(codes(r)).toEqual([
      [`${P}/Build.md`, "parent", "ref"],
      [`${P}/Paint.md`, "parent", "ref"],
    ]);
    expect(message(r)).toContain("(after this change to [[Site]], a row it links to)");
    const api = createPublicApi(v.app, () => v.settings);
    const ok = await api.batch({
      operations: [
        { op: "update_rows", table: "project", where: { parent: ref("Site") }, set: { parent: ref("Shop") } },
        { op: "update_row", table: "project", path: `${P}/Site.md`, set: { kind: "area" }, unset: ["parent"] },
      ],
    });
    expect(ok.ok, JSON.stringify(ok.steps.map((s) => s.error ?? s.result?.violations))).toBe(true);
    // the workstream's own kind change is checked too
    expect(codes(await updateRow(v.app, v.settings, { table: "project", path: `${P}/Build.md`, set: { kind: "project" } }))).toEqual([[`${P}/Build.md`, "parent", "ref"]]);
  });

  it("adding ref_by to a populated table with a violating row is refused, listing it", async () => {
    const v = await projects();
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Home") } })).ok).toBe(true);
    const refused = await alterColumn(v.app, v.settings, { table: "project", name: "parent", changes: { ref_by: LEVELS } });
    expect(refused.ok).toBe(false);
    expect(codes(refused)).toEqual([[`${P}/Roof.md`, "parent", "ref"]]);
    // a new column too: every workstream lacks it
    const added = await addColumn(v.app, v.settings, described({ table: "project", column: { name: "lead", type: "link", ref: "self", ref_by: LEVELS } }));
    expect(added.ok).toBe(false);
    expect(codes(added).map(([p, , c]) => [p, c])).toEqual([
      [`${P}/Build.md`, "required"],
      [`${P}/Paint.md`, "required"],
      [`${P}/Roof.md`, "required"],
      [`${P}/Shop.md`, "required"],
      [`${P}/Site.md`, "required"],
    ]);
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Roof.md`, set: { parent: ref("Site") } })).ok).toBe(true);
    expect((await alterColumn(v.app, v.settings, { table: "project", name: "parent", changes: { ref_by: LEVELS } })).ok).toBe(true);
    // removing it: null
    expect((await alterColumn(v.app, v.settings, { table: "project", name: "parent", changes: { ref_by: null } })).ok).toBe(true);
  });

  it("ref_where alone filters the targets; an empty link is fine", async () => {
    const v = await projects({ ref_where: { kind: { in: ["area", "project"] } } });
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Build") } });
    expect(codes(r)).toEqual([[`${P}/Roof.md`, "parent", "ref"]]);
    expect(message(r)).toBe(`[[Build]] is not a valid parent (needs ref_where {"kind":{"in":["area","project"]}}); valid: Home, Shop, Site`);
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream" } })).ok).toBe(true);
    expect((await linkOptions(v.app, v.settings, { table: "project", column: "parent" })).total).toBe(3);
    // changing a target re-checks the rows linking to it
    expect(codes(await updateRow(v.app, v.settings, { table: "project", path: `${P}/Site.md`, set: { kind: "workstream" } })).map(([p]) => p)).toEqual([
      `${P}/Build.md`,
      `${P}/Paint.md`,
    ]);
    // an invalid filter is refused when declared
    await expect(alterColumn(v.app, v.settings, { table: "project", name: "parent", changes: { ref_where: { nope: 1 } } })).rejects.toThrow(/unknown column/);
  });

  it("lists of links: every linked row must be a valid target", async () => {
    const v = await projects();
    await createTable(v.app, v.settings, described({
      schema: "work",
      name: "task",
      options: { filename: "{name}" },
      columns: [
        { name: "name", type: "string", required: true },
        { name: "projects", type: "list", items: "link", ref: "main.work.project", ref_where: { kind: "project" } },
      ],
    }));
    const r = await insertRow(v.app, v.settings, { table: "task", values: { name: "Plan", projects: [ref("Site"), ref("Home")] } });
    expect(codes(r)).toEqual([["Datanotes/main/work/task/Plan.md", "projects", "ref"]]);
    expect(message(r)).toBe(`[[Home]] is not a valid target in projects (needs ref_where {"kind":"project"}); valid: Shop, Site`);
    expect((await insertRow(v.app, v.settings, { table: "task", values: { name: "Plan", projects: [ref("Site"), ref("Shop")] } })).ok).toBe(true);
    // a project becoming an area breaks the task
    expect(codes(await updateRow(v.app, v.settings, { table: "project", path: `${P}/Shop.md`, set: { kind: "area" }, unset: ["parent"] }))).toEqual([
      ["Datanotes/main/work/task/Plan.md", "projects", "ref"],
    ]);
  });

  it("validates the spec: link columns only, a known enum/string column, values of the enum", async () => {
    const v = await projects();
    await expect(addColumn(v.app, v.settings, described({ table: "project", column: { name: "x", type: "string", ref_where: { kind: "area" } } }))).rejects.toThrow(/ref_where" needs a link column/);
    await expect(addColumn(v.app, v.settings, described({ table: "project", column: { name: "x", type: "link", ref: "self", ref_by: { column: "nope", levels: ["a"] } } }))).rejects.toThrow(/column "nope"/);
    await expect(addColumn(v.app, v.settings, described({ table: "project", column: { name: "x", type: "link", ref: "self", ref_by: { column: "kind", levels: ["area", "team"] } } }))).rejects.toThrow(/"team" not a value of kind/);
    await expect(addColumn(v.app, v.settings, described({ table: "project", column: { name: "x", type: "link", ref: "self", ref_by: { column: "kind", levels: ["area"], map: MAP } } }))).rejects.toThrow(/either "levels" or "map"/);
    // a rename of the ref_by column follows it
    expect((await alterColumn(v.app, v.settings, { table: "project", name: "parent", changes: { ref_by: LEVELS } })).ok).toBe(true);
    expect((await renameColumn(v.app, v.settings, { table: "project", from: "kind", to: "level" })).ok).toBe(true);
    const d = await describeTable(v.app, v.settings, "project");
    expect((d.columns as { name: string; ref_by?: { column: string; target_column?: string } }[]).find((c) => c.name === "parent")!.ref_by).toMatchObject({ column: "level" });
    expect((await checkTable(v.app, v.settings, { table: "project" })).violations).toEqual([]);
  });
});

describe("filtered link targets: renames, same names, missing tables, schema changes", () => {
  it("renaming a row others link to succeeds; a set_null refusal names the deleted row (B1, N5)", async () => {
    const v = await projects({ ref_by: LEVELS });
    const r = await updateRow(v.app, v.settings, { table: "project", path: `${P}/Site.md`, set: { name: "Site2" } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    const w = await projects({ ref_by: LEVELS });
    const gone = await deleteRows(w.app, w.settings, { table: "project", where: { name: "Site" }, onReferenced: "set_null" });
    expect(codes(gone)).toEqual([
      [`${P}/Build.md`, "parent", "required"],
      [`${P}/Paint.md`, "parent", "required"],
    ]);
    expect(message(gone)).toBe(`is required for kind "workstream": it needs a parent with kind project (after this change to [[Site]], a row it links to)`);
  });

  it("links resolve by path: a same-named row in another folder is not mixed up (M2)", async () => {
    const v = await projects();
    await createTable(v.app, v.settings, described({
      schema: "work", name: "person", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string", required: true }, { name: "active", type: "boolean" }],
    }));
    await createTable(v.app, v.settings, described({
      schema: "work", name: "task", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string", required: true }, { name: "owner", type: "link", ref: "main.work.person", ref_where: { active: true } }],
    }));
    const D = "Datanotes/main/work/person";
    expect((await insertRow(v.app, v.settings, { table: "person", path: `${D}/a/Dan.md`, values: { name: "Dan", active: true } })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "person", path: `${D}/b/Dan.md`, values: { name: "Dan", active: false } })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "task", values: { name: "Plan", owner: `[[${D}/a/Dan|Dan]]` } })).ok).toBe(true);
    const bad = await insertRow(v.app, v.settings, { table: "task", values: { name: "Ship", owner: `[[${D}/b/Dan|Dan]]` } });
    expect(message(bad)).toBe(`[[Dan]] is not a valid owner (needs ref_where {"active":true}); valid: Dan`);
    const opts = await linkOptions(v.app, v.settings, { table: "task", column: "owner" });
    expect(opts.rows.map((r) => r.path)).toEqual([`${D}/a/Dan.md`]);
  });

  it("a ref_where reading a table refuses its rename; a ref that is not a table only refuses the rows written (B2)", async () => {
    const v = await projects();
    await createTable(v.app, v.settings, described({
      schema: "work", name: "task", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string", required: true }, { name: "project", type: "link", ref: "main.work.project", ref_where: { kind: "project" } }],
    }));
    expect((await insertRow(v.app, v.settings, { table: "task", values: { name: "Plan", project: ref("Site") } })).ok).toBe(true);
    const rename = await alterTable(v.app, v.settings, { table: "project", name: "initiative" });
    expect(rename.conflicts.map((c) => c.message)).toEqual([expect.stringMatching(/^project \(ref_where \/ ref_by\) of main\.work\.task reads main\.work\.project through a link/)]);
    v.write(METASTORE, v.read(METASTORE).replace("ref: main.work.project", "ref: main.work.nobody"));
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Lab", kind: "project", parent: ref("Home") } })).ok).toBe(true);
    const write = await updateRow(v.app, v.settings, { table: "task", path: "Datanotes/main/work/task/Plan.md", set: { name: "Plan" } });
    expect(write.violations.flatMap((x) => x.violations.map((y) => y.message))).toContainEqual(
      `project cannot be checked: "project" links to main.work.nobody, which is not a table (renamed or dropped?)`,
    );
    expect((await checkTable(v.app, v.settings, { table: "task" })).rows_checked).toBe(1);
    await expect(linkOptions(v.app, v.settings, { table: "task", column: "project" })).rejects.toThrow(/not a table/);
  });

  it("rename_value follows into ref_by levels and ref_where; drop_column of a column they read is refused (N1)", async () => {
    const v = await projects({ ref_by: LEVELS });
    await createTable(v.app, v.settings, described({
      schema: "work", name: "task", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string", required: true }, { name: "project", type: "link", ref: "main.work.project", ref_where: { kind: { in: ["project"] } } }],
    }));
    expect((await renameValue(v.app, v.settings, { table: "project", column: "kind", from: "project", to: "initiative" })).ok).toBe(true);
    const ms = await loadMetastore(v.app, v.settings);
    const tables = ms!.model.catalogs.main!.schemas.work!.tables;
    expect(tables.project!.columns.find((c) => c.name === "parent")!.ref_by).toEqual({ column: "kind", levels: ["area", "initiative", "workstream"] });
    expect(tables.task!.columns.find((c) => c.name === "project")!.ref_where).toEqual({ kind: { in: ["initiative"] } });
    expect((await checkTable(v.app, v.settings, { table: "project" })).violations).toEqual([]);
    expect((await insertRow(v.app, v.settings, { table: "task", values: { name: "Plan", project: ref("Site") } })).ok).toBe(true);
    const drop = await dropColumn(v.app, v.settings, { table: "project", name: "kind" });
    expect(drop.conflicts.map((c) => c.message)).toEqual([
      "ref_by of main.work.project.parent reads project.kind: drop or change it first",
      "ref_where of main.work.task.project reads project.kind: drop or change it first",
    ]);
  });
});

describe("filtered link targets: undo_migration and restore_table judge the schema they put back", () => {
  const parentRule = async (v: DbVault, table = "project", column = "parent") =>
    (await loadMetastore(v.app, v.settings))!.model.catalogs.main!.schemas.work!.tables[table]!.columns.find((c) => c.name === column);

  it("undo of rename_value on a ref_by level succeeds", async () => {
    const v = await projects({ ref_by: LEVELS });
    const renamed = await renameValue(v.app, v.settings, { table: "project", column: "kind", from: "project", to: "initiative" });
    expect(renamed.ok).toBe(true);
    const undo = await undoOperation(v.app, v.settings, renamed.migration_id!);
    expect(undo.ok, JSON.stringify(undo.conflicts)).toBe(true);
    expect((await parentRule(v))!.ref_by).toEqual(LEVELS);
    expect(v.read(`${P}/Site.md`)).toMatch(/^kind: project$/m);
  });

  it("undo of rename_column on a ref_by link column succeeds", async () => {
    const v = await projects({ ref_by: LEVELS });
    const renamed = await renameColumn(v.app, v.settings, { table: "project", from: "parent", to: "up" });
    expect(renamed.ok).toBe(true);
    const undo = await undoOperation(v.app, v.settings, renamed.migration_id!);
    expect(undo.ok, JSON.stringify(undo.conflicts)).toBe(true);
    expect(v.read(`${P}/Build.md`)).toMatch(/^parent: /m);
    expect((await checkTable(v.app, v.settings, { table: "project" })).violations).toEqual([]);
  });

  it("restore_table to a version from before the rule existed succeeds", async () => {
    const v = await projects({}, true);
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Home") } })).ok).toBe(true);
    const version = (await describeHistory(v.app, v.settings, { table: "project" })).history[0]!.version;
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Roof.md`, set: { parent: ref("Site") } })).ok).toBe(true);
    expect((await alterColumn(v.app, v.settings, { table: "project", name: "parent", changes: { ref_by: LEVELS } })).ok).toBe(true);
    const restore = await restoreTable(v.app, v.settings, { table: "project", version });
    expect(restore.ok, JSON.stringify(restore.violations)).toBe(true);
    expect(v.read(`${P}/Roof.md`)).toContain("project/Home");
    expect((await parentRule(v))!.ref_by).toBeUndefined();
  });

  it("an undo that puts a rule back refuses the rows that break it, naming the way out; a restore puts the rows back too", async () => {
    const v = await projects({ ref_by: LEVELS }, true);
    const version = (await describeHistory(v.app, v.settings, { table: "project" })).history[0]!.version;
    const off = await alterColumn(v.app, v.settings, { table: "project", name: "parent", changes: { ref_by: null } });
    expect(off.ok).toBe(true);
    // Shop moves under Site: a project under a project, fine without the rule
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Shop.md`, set: { parent: ref("Site") } })).ok).toBe(true);
    const undo = await undoOperation(v.app, v.settings, off.migration_id!);
    expect(undo.ok).toBe(false);
    expect(undo.conflicts.map((c) => c.path)).toEqual([`${P}/Shop.md`]);
    expect(undo.conflicts[0]!.message).toBe(
      `parent [[Site]] is not a valid parent for kind "project" (needs kind area); valid: Home (the ref_where / ref_by of parent comes back with this change); to undo, fix the row first, or drop the rule that refuses it (alter_column ref_where / ref_by: null, drop_constraint)`,
    );
    expect((await parentRule(v))!.ref_by).toBeUndefined();
    // restore_table to the version with the rule puts that version's rows back with it
    const restore = await restoreTable(v.app, v.settings, { table: "project", version });
    expect(restore.ok, JSON.stringify(restore.violations)).toBe(true);
    expect(v.read(`${P}/Shop.md`)).toContain("project/Home");
    expect((await parentRule(v))!.ref_by).toEqual(LEVELS);
  });

  it("a batch undo is checked on the state it leaves before anything is written; a retry works", async () => {
    const v = await projects({ ref_by: LEVELS });
    const api = createPublicApi(v.app, () => v.settings);
    const b = await api.batch({
      operations: [
        { op: "update_row", table: "project", path: `${P}/Build.md`, set: { parent: ref("Shop") } },
        { op: "insert_row", table: "project", values: { name: "Lab", kind: "project", parent: ref("Home") } },
      ],
    });
    expect(b.ok).toBe(true);
    expect((await deleteRows(v.app, v.settings, { table: "project", where: { name: "Paint" }, mode: "delete" })).ok).toBe(true);
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Site.md`, set: { kind: "area" }, unset: ["parent"] })).ok).toBe(true);
    // undoing the batch puts Build back under Site, now an area: refused before Lab is removed
    const undo = await undoOperation(v.app, v.settings, b.migration_id!);
    expect(undo.ok).toBe(false);
    expect(undo.conflicts.map((c) => c.path)).toEqual([`${P}/Build.md`]);
    expect(v.exists(`${P}/Lab.md`)).toBe(true);
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Site.md`, set: { kind: "project", parent: ref("Home") } })).ok).toBe(true);
    const again = await undoOperation(v.app, v.settings, b.migration_id!);
    expect(again.ok, JSON.stringify(again.conflicts)).toBe(true);
    expect(v.exists(`${P}/Lab.md`)).toBe(false);
    expect(v.read(`${P}/Build.md`)).toContain("project/Site");
  });
});

describe("filtered link targets from bases", () => {
  const STAGE = { column: "stage", target_column: "kind", map: { idea: null, active: ["project"] } };
  /** `task` (Plan → Home, an area): a table to give a base with a filtered link column. */
  async function tasks(): Promise<DbVault> {
    const v = await projects();
    await createTable(v.app, v.settings, described({
      schema: "work", name: "task", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string", required: true }, { name: "project", type: "link", ref: "main.work.project" }],
    }));
    expect((await insertRow(v.app, v.settings, { table: "task", values: { name: "Plan", project: ref("Home") } })).ok).toBe(true);
    return v;
  }
  const baseColumns = async (v: DbVault, name: string) => (await loadMetastore(v.app, v.settings))!.model.bases[name]!.columns;

  it("set_table_bases and define_base check the inherited ref_where / ref_by on the rows", async () => {
    const v = await tasks();
    expect((await defineBase(v.app, v.settings, describedBase({ name: "tracked", columns: [{ name: "project", type: "link", ref: "main.work.project", ref_where: { kind: "project" } }] }))).ok).toBe(true);
    const r = await setTableBases(v.app, v.settings, { table: "task", bases: ["tracked"] });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual([["Datanotes/main/work/task/Plan.md", "project", "ref"]]);
    expect(message(r)).toMatch(/^\[\[Home\]\] is not a valid project \(needs ref_where \{"kind":"project"\}\); valid: Shop, Site/);
    // without the filter it inherits; adding the filter to the base is then refused the same way
    expect((await defineBase(v.app, v.settings, describedBase({ name: "tracked", columns: [{ name: "project", type: "link", ref: "main.work.project" }] }))).ok).toBe(true);
    expect((await setTableBases(v.app, v.settings, { table: "task", bases: ["tracked"] })).ok).toBe(true);
    const again = await defineBase(v.app, v.settings, describedBase({ name: "tracked", columns: [{ name: "project", type: "link", ref: "main.work.project", ref_where: { kind: "project" } }] }));
    expect(codes(again)).toEqual([["Datanotes/main/work/task/Plan.md", "project", "ref"]]);
    expect((await updateRow(v.app, v.settings, { table: "task", path: "Datanotes/main/work/task/Plan.md", set: { project: ref("Site") } })).ok).toBe(true);
    expect((await defineBase(v.app, v.settings, describedBase({ name: "tracked", columns: [{ name: "project", type: "link", ref: "main.work.project", ref_where: { kind: "project" } }] }))).ok).toBe(true);
  });

  it("define_base: dropping a column a base's ref_by reads is refused; a rename follows into it", async () => {
    const v = await tasks();
    const columns = (stage: string) => [
      { name: stage, type: "enum", values: ["idea", "active"] },
      { name: "project", type: "link", ref: "main.work.project", ref_by: { ...STAGE, column: stage } },
    ];
    expect((await defineBase(v.app, v.settings, describedBase({ name: "tracked", columns: columns("stage") }))).ok).toBe(true);
    expect((await setTableBases(v.app, v.settings, { table: "task", bases: ["tracked"] })).ok).toBe(true);
    const drop = await defineBase(v.app, v.settings, describedBase({ name: "tracked", columns: columns("stage").slice(1), dropColumns: ["stage"] }));
    expect(drop.ok).toBe(false);
    expect(drop.conflicts.map((c) => c.message)).toEqual(["ref_by of main.work.task.project reads main.work.task.stage: drop or change it first"]);
    // the new list still names the old column in ref_by: the rename rewrites it
    const rename = await defineBase(v.app, v.settings, describedBase({
      name: "tracked",
      columns: [{ name: "phase", type: "enum", values: ["idea", "active"] }, columns("stage")[1]!],
      renameColumns: { stage: "phase" },
    }));
    expect(rename.ok, JSON.stringify([rename.conflicts, rename.violations])).toBe(true);
    expect((await baseColumns(v, "tracked")).find((c) => c.name === "project")!.ref_by).toEqual({ ...STAGE, column: "phase" });
    // the inherited rule holds on writes
    const w = await updateRow(v.app, v.settings, { table: "task", path: "Datanotes/main/work/task/Plan.md", set: { phase: "active" } });
    expect(codes(w)).toEqual([["Datanotes/main/work/task/Plan.md", "project", "ref"]]);
  });
});

describe("filtered link targets: self-links, missing targets, map values", () => {
  it("a row linking to itself is refused, as link_options never offers it", async () => {
    const v = await projects({ hierarchy: false, ref_by: { column: "kind", map: { area: null, project: ["area", "project"], workstream: ["project"] } } });
    const r = await updateRow(v.app, v.settings, { table: "project", path: `${P}/Site.md`, set: { parent: ref("Site") } });
    expect(codes(r)).toEqual([[`${P}/Site.md`, "parent", "ref"]]);
    expect(message(r)).toBe("a parent cannot be the row itself");
    expect((await linkOptions(v.app, v.settings, { table: "project", column: "parent", row: "Site" })).rows.map((x) => x.name)).toEqual(["Home", "Shop"]);
  });

  it("a ref_by link to a missing row is refused, also after a delete with on_referenced ignore and an undone insert", async () => {
    const v = await projects({ ref_by: LEVELS });
    const ghost = await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Ghost") } });
    expect(ghost.ok).toBe(false);
    expect(codes(ghost)).toEqual([[`${P}/Roof.md`, "parent", "broken_link"]]);
    expect(ghost.violations[0]!.violations.map((x) => x.message)).toEqual(["link does not resolve: Datanotes/main/work/project/Ghost"]);
    const gone = await deleteRows(v.app, v.settings, { table: "project", where: { name: "Site" }, mode: "delete", onReferenced: "ignore" });
    expect(codes(gone)).toEqual([
      [`${P}/Build.md`, "parent", "broken_link"],
      [`${P}/Paint.md`, "parent", "broken_link"],
    ]);
    expect(message(gone)).toBe("[[Site]] is not a row of main.work.project; valid: Shop (after this change to [[Site]], a row it links to)");
    const lab = await insertRow(v.app, v.settings, { table: "project", values: { name: "Lab", kind: "project", parent: ref("Home") } });
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Lab") } })).ok).toBe(true);
    const undo = await undoOperation(v.app, v.settings, lab.migration_id!);
    expect(undo.ok).toBe(false);
    expect(undo.conflicts.map((c) => c.path)).toEqual([`${P}/Roof.md`]);
    expect(v.exists(`${P}/Lab.md`)).toBe(true);
  });

  it("link_options: an ambiguous row name is refused listing the rows, limit is checked, a level not in the map is a reason", async () => {
    const v = await projects({ ref_by: { column: "kind", map: MAP } });
    expect((await insertRow(v.app, v.settings, { table: "project", path: `${P}/b/Twin.md`, values: { name: "Twin", kind: "area" } })).ok).toBe(true);
    await alterColumn(v.app, v.settings, { table: "project", name: "name", changes: { unique: null } });
    expect((await insertRow(v.app, v.settings, { table: "project", path: `${P}/c/Twin.md`, values: { name: "Twin", kind: "area" } })).ok).toBe(true);
    await expect(linkOptions(v.app, v.settings, { table: "project", column: "parent", row: "Twin" })).rejects.toThrow(
      `"Twin" names 2 rows of main.work.project: give the path of one (${P}/b/Twin.md, ${P}/c/Twin.md)`,
    );
    expect((await linkOptions(v.app, v.settings, { table: "project", column: "parent", row: `${P}/c/Twin.md` })).empty).toBe(true);
    expect((await linkOptions(v.app, v.settings, { table: "project", column: "parent", row: `[[${P}/b/Twin|Twin]]` })).empty).toBe(true);
    for (const limit of [0, -1, 2.5]) {
      await expect(linkOptions(v.app, v.settings, { table: "project", column: "parent", limit })).rejects.toThrow(/"limit" must be a positive integer/);
    }
    expect((await linkOptions(v.app, v.settings, { table: "project", column: "parent", values: { kind: "workstream" }, limit: 1 })).rows.length).toBe(1);
    await alterColumn(v.app, v.settings, { table: "project", name: "kind", changes: { values: ["area", "project", "workstream", "task"] } });
    const task = await linkOptions(v.app, v.settings, { table: "project", column: "parent", values: { kind: "task" } });
    expect(task).toMatchObject({ rows: [], total: 0, reason: `kind "task" has no entry in ref_by of parent (it has: area, project, workstream): no target is valid` });
  });

  it("dropping an enum value a ref_by map allows is refused; a string target column takes any value", async () => {
    const v = await projects();
    await createTable(v.app, v.settings, described({
      schema: "work", name: "task", options: { filename: "{name}" },
      columns: [
        { name: "name", type: "string", required: true },
        { name: "scope", type: "enum", values: ["big", "small"] },
        { name: "project", type: "link", ref: "main.work.project", ref_by: { column: "scope", target_column: "kind", map: { big: ["area", "project"], small: ["workstream"] } } },
        // a string target: map values are not checked (any value is a possible name)
        { name: "named", type: "link", ref: "main.work.project", ref_by: { column: "scope", target_column: "name", map: { big: ["Home"], small: ["Anything"] } } },
      ],
    }));
    const r = await alterColumn(v.app, v.settings, { table: "project", name: "kind", changes: { values: ["area", "project"] } });
    expect(r.ok).toBe(false);
    expect(r.conflicts.map((c) => c.message)).toEqual([
      `main.work.task.project: ref_by allows "workstream", not a value of main.work.project.kind (area, project): change that ref_by first`,
    ]);
    await expect(addColumn(v.app, v.settings, described({ table: "task", column: { name: "x", type: "link", ref: "main.work.project", ref_by: { column: "scope", target_column: "kind", map: { big: ["team"] } } } }))).rejects.toThrow(
      /ref_by allows "team", not a value of main\.work\.project\.kind/,
    );
  });
});
