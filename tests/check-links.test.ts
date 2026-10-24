import { describe, expect, it } from "vitest";
import { addConstraint, dropConstraint } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { addColumn, alterColumn, createTable, dropColumn, dropTable, INDEX_RETRY, renameColumn, renameValue, undoOperation } from "../src/core/engine";
import { describeHistory, restoreTable } from "../src/core/history";
import { loadMetastore } from "../src/core/metastore";
import { createPublicApi } from "../src/core/public-api";
import { alterTable, checkTable, deleteRows, insertRow, select, updateRow, updateRows } from "../src/core/rows";
import type { OpResult } from "../src/core/engine";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const P = "Datanotes/main/work/project";
const ref = (n: string) => `[[${P}/${n}|${n}]]`;
const PARENT_BY_LEVEL = {
  or: [
    { kind: "area", parent: { exists: false } },
    { kind: "project", "parent.kind": "area" },
    { kind: "workstream", "parent.kind": "project" },
  ],
};

/** `project` (self-referencing): Home (area) ← Site, Shop (projects) ← Build, Paint (workstreams of Site). */
async function projects(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  await createTable(v.app, v.settings, described({
    schema: "work",
    name: "project",
    options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true, unique: true, dense: true },
      { name: "kind", type: "enum", values: ["area", "project", "workstream"], dense: true },
      { name: "parent", type: "link", ref: "self", hierarchy: true },
    ],
  }));
  for (const [name, kind, parent] of [
    ["Home", "area", null],
    ["Site", "project", "Home"],
    ["Shop", "project", "Home"],
    ["Build", "workstream", "Site"],
    ["Paint", "workstream", "Site"],
  ] as const) {
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name, kind, ...(parent ? { parent: ref(parent) } : {}) } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  }
  return v;
}

const messages = (r: OpResult) => r.violations.flatMap((x) => x.violations.map((v) => [x.path, v.message.replace(/:.*/s, "")]));

describe("CHECKs that follow links", () => {
  it("add_constraint accepts a dotted path; writes that break it are refused", async () => {
    const v = await projects();
    const added = await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL });
    expect(added.ok, JSON.stringify(added.conflicts)).toBe(true);
    // a workstream under an area
    const bad = await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Home") } });
    expect(bad.ok).toBe(false);
    expect(messages(bad)).toEqual([[`${P}/Roof.md`, "violates CHECK parent_by_level"]]);
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Site") } })).ok).toBe(true);
    const moved = await updateRow(v.app, v.settings, { table: "project", path: `${P}/Build.md`, set: { parent: ref("Home") } });
    expect(messages(moved)).toEqual([[`${P}/Build.md`, "violates CHECK parent_by_level"]]);
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Build.md`, set: { parent: ref("Shop") } })).ok).toBe(true);
    // an area with a parent, a project with none
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Home.md`, set: { parent: ref("Shop") } })).ok).toBe(false);
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Shop.md`, unset: ["parent"] })).ok).toBe(false);
    expect((await checkTable(v.app, v.settings, { table: "project" })).violations).toEqual([]);
  });

  it("add_constraint is refused while an existing row violates it, listing the row", async () => {
    const v = await projects();
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Home") } })).ok).toBe(true);
    const refused = await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL });
    expect(refused.ok).toBe(false);
    expect(refused.conflicts.map((c) => [c.path, c.message])).toEqual([[`${P}/Roof.md`, "violates CHECK parent_by_level"]]);
    // a bad path fails like any unknown column
    await expect(addConstraint(v.app, v.settings, { table: "project", name: "x", check: { "parent.nope": 1 } })).rejects.toThrow(/unknown column/);
    await expect(addConstraint(v.app, v.settings, { table: "project", name: "x", check: { "name.kind": "area" } })).rejects.toThrow(/not a link column/);
  });

  it("re-checks the rows that link to a changed row; a batch that re-parents them first succeeds", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    const refused = await updateRow(v.app, v.settings, { table: "project", path: `${P}/Site.md`, set: { kind: "area" }, unset: ["parent"] });
    expect(refused.ok).toBe(false);
    expect(messages(refused)).toEqual([
      [`${P}/Build.md`, "violates CHECK parent_by_level"],
      [`${P}/Paint.md`, "violates CHECK parent_by_level"],
    ]);
    expect(refused.violations[0]!.violations[0]!.message).toContain("(after this change to [[Site]], a row it links to)");
    const api = createPublicApi(v.app, () => v.settings);
    const ok = await api.batch({
      operations: [
        { op: "update_rows", table: "project", where: { parent: ref("Site") }, set: { parent: ref("Shop") } },
        { op: "update_row", table: "project", path: `${P}/Site.md`, set: { kind: "area" }, unset: ["parent"] },
      ],
    });
    expect(ok.ok, JSON.stringify(ok.steps.map((s) => s.error ?? s.result?.violations))).toBe(true);
    const rows = await select(v.app, v.settings, { table: "project", columns: ["name", "kind"], orderBy: "name" });
    expect(rows.rows.map((r) => `${r.name}:${r.kind}`)).toEqual(["Build:workstream", "Home:area", "Paint:workstream", "Shop:project", "Site:area"]);
  });

  it("one operation is checked on its final state", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    // Site and Shop become areas together; their workstreams break, the projects themselves pass
    const both = await updateRows(v.app, v.settings, { table: "project", where: { kind: "project" }, set: { kind: "area" }, unset: ["parent"] });
    expect(messages(both).map(([p]) => p)).toEqual([`${P}/Build.md`, `${P}/Paint.md`]);
  });

  it("deleting a row others link to: restrict refuses it, ignore leaves links to a missing row that the CHECK refuses", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    const restrict = await deleteRows(v.app, v.settings, { table: "project", where: { name: "Site" } });
    expect(restrict.conflicts.map((c) => c.message)).toEqual([expect.stringMatching(/referenced by/)]);
    const ignore = await deleteRows(v.app, v.settings, { table: "project", where: { name: "Site" }, onReferenced: "ignore" });
    expect(ignore.ok).toBe(false);
    expect(messages(ignore).map(([p, m]) => [p, m])).toEqual([
      [`${P}/Build.md`, "violates CHECK parent_by_level"],
      [`${P}/Paint.md`, "violates CHECK parent_by_level"],
    ]);
    const setNull = await deleteRows(v.app, v.settings, { table: "project", where: { name: "Site" }, onReferenced: "set_null" });
    expect(setNull.ok).toBe(false);
    expect(messages(setNull).map(([p]) => p)).toEqual([`${P}/Build.md`, `${P}/Paint.md`]);
    // a row nobody links to goes
    expect((await deleteRows(v.app, v.settings, { table: "project", where: { name: "Paint" } })).ok).toBe(true);
  });

  it("an archived row is no link target, as a deleted one: check_table, new links and expand treat it as gone", async () => {
    const gone = async (mode: "archive" | "delete", archive?: string) => {
      const v = await projects();
      if (archive) expect((await alterTable(v.app, v.settings, { table: "project", archive })).ok).toBe(true);
      const del = await deleteRows(v.app, v.settings, { table: "project", where: { name: "Site" }, onReferenced: "ignore", mode });
      expect(del.ok).toBe(true);
      const found = (await checkTable(v.app, v.settings, { table: "project" })).violations.flatMap((x) => x.violations.map((y) => [x.path, y.column, y.code]));
      const insert = messages(await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: "[[Site]]" } }));
      const expanded = (await select(v.app, v.settings, { table: "project", where: { name: "Build" }, expand: ["parent"] })).rows[0]!.parent;
      return { v, del, found, insert, expanded };
    };
    const deleted = await gone("delete");
    expect(deleted.found).toEqual([
      [`${P}/Build.md`, "parent", "broken_link"],
      [`${P}/Paint.md`, "parent", "broken_link"],
    ]);
    expect(deleted.insert).toEqual([[`${P}/Roof.md`, "link does not resolve"]]);
    expect(deleted.expanded).toBe(ref("Site"));
    for (const archived of [await gone("archive"), await gone("archive", "old")]) {
      expect(archived.del.planned_moves).toHaveLength(1);
      expect([archived.found, archived.insert]).toEqual([deleted.found, deleted.insert]);
      // not inlined: a link (that the host may have rewritten to the note's new place)
      expect(archived.expanded).toEqual(expect.stringMatching(/^\[\[(.*\/)?Site\|Site\]\]$/));
      // undone, the row is a link target again
      expect((await undoOperation(archived.v.app, archived.v.settings, archived.del.migration_id!)).ok).toBe(true);
      expect((await checkTable(archived.v.app, archived.v.settings, { table: "project" })).violations).toEqual([]);
    }
  });

  it("empty links pass at the top level and fail inside or; a link to a missing row fails", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "under_area", check: { "parent.kind": { in: ["area", "project"] } } })).ok).toBe(true);
    // top level: no parent, nothing to check
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Garden", kind: "area" } })).ok).toBe(true);
    // a link to a row that does not exist (written by hand)
    v.write(`${P}/Ghost.md`, "---\ntable: main.work.project\nname: Ghost\nkind: workstream\nparent: \"[[Nowhere]]\"\n---\n");
    const check = await checkTable(v.app, v.settings, { table: "project" });
    expect(check.violations.flatMap((x) => x.violations.filter((y) => y.code === "check").map((y) => [x.path, y.constraint]))).toEqual([[`${P}/Ghost.md`, "under_area"]]);
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "again", check: { "parent.kind": { in: ["area", "project"] } } })).conflicts.map((c) => c.path)).toEqual([`${P}/Ghost.md`]);

    const w = await projects();
    const inOr = { or: [{ "parent.kind": "area" }, { kind: "area" }] };
    // inside or the empty link is false: a project with no parent fails both parts
    expect((await updateRow(w.app, w.settings, { table: "project", path: `${P}/Shop.md`, unset: ["parent"] })).ok).toBe(true);
    const refused = await addConstraint(w.app, w.settings, { table: "project", name: "in_or", check: inOr });
    expect(refused.conflicts.map((c) => c.path)).toEqual([`${P}/Build.md`, `${P}/Paint.md`, `${P}/Shop.md`]);
  });

  it("on a list of links every linked row must match, here and when a linked row changes", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    await createTable(v.app, v.settings, described({
      schema: "work", name: "person", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string", required: true, dense: true }, { name: "active", type: "boolean", dense: true }],
    }));
    await createTable(v.app, v.settings, described({
      schema: "work", name: "meeting", options: { filename: "{title}" },
      columns: [{ name: "title", type: "string", required: true, dense: true }, { name: "attendees", type: "list", items: "link", ref: "main.work.person" }],
    }));
    const who = (n: string) => `[[Datanotes/main/work/person/${n}|${n}]]`;
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Ada", active: true } });
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Bob", active: false } });
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Cy", active: true } });
    expect((await addConstraint(v.app, v.settings, { table: "meeting", name: "active_attendees", check: { "attendees.active": true } })).ok).toBe(true);
    const mixed = await insertRow(v.app, v.settings, { table: "meeting", values: { title: "Kickoff", attendees: [who("Ada"), who("Bob")] } });
    expect(messages(mixed)).toEqual([["Datanotes/main/work/meeting/Kickoff.md", "violates CHECK active_attendees"]]);
    expect((await insertRow(v.app, v.settings, { table: "meeting", values: { title: "Kickoff", attendees: [who("Ada"), who("Cy")] } })).ok).toBe(true);
    // an empty list is an empty value: skipped at the top level
    expect((await insertRow(v.app, v.settings, { table: "meeting", values: { title: "Solo" } })).ok).toBe(true);
    // the change comes from the other table: Cy may not go inactive while a meeting lists Cy
    const off = await updateRow(v.app, v.settings, { table: "person", path: "Datanotes/main/work/person/Cy.md", set: { active: false } });
    expect(messages(off)).toEqual([["Datanotes/main/work/meeting/Kickoff.md", "violates CHECK active_attendees"]]);
    expect((await updateRow(v.app, v.settings, { table: "person", path: "Datanotes/main/work/person/Bob.md", set: { active: true } })).ok).toBe(true);
  });

  it("leaves within and the cycle check as they were", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    const under = await select(v.app, v.settings, { table: "project", where: { parent: { within: "Site" } }, columns: ["name"] });
    expect(under.rows.map((r) => r.name).sort()).toEqual(["Build", "Paint"]);
    const viaDot = await select(v.app, v.settings, { table: "project", where: { "parent.kind": "project" }, columns: ["name"] });
    expect(viaDot.rows.map((r) => r.name).sort()).toEqual(["Build", "Paint"]);
    const cycle = await updateRow(v.app, v.settings, { table: "project", path: `${P}/Home.md`, set: { parent: ref("Build") } });
    expect(cycle.violations.flatMap((x) => x.violations.map((y) => y.code))).toContain("cycle");
  });
});

const PERSON = "Datanotes/main/work/person";
const who = (n: string) => `[[${PERSON}/${n}|${n}]]`;

/** `person` (Ada, Bob inactive, Cy) and `meeting` (attendees: people), with `active_attendees` on meeting. */
async function people(history = false): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome", ...(history ? { history: true } : {}) }, async () => {});
  await createTable(v.app, v.settings, described({
    schema: "work", name: "person", options: { filename: "{name}" },
    columns: [{ name: "name", type: "string", required: true, dense: true }, { name: "active", type: "boolean", dense: true }],
  }));
  await createTable(v.app, v.settings, described({
    schema: "work", name: "meeting", options: { filename: "{title}" },
    columns: [{ name: "title", type: "string", required: true, dense: true }, { name: "attendees", type: "list", items: "link", ref: "main.work.person" }],
  }));
  for (const [name, active] of [["Ada", true], ["Bob", false], ["Cy", true]] as const) {
    expect((await insertRow(v.app, v.settings, { table: "person", values: { name, active } })).ok).toBe(true);
  }
  expect((await addConstraint(v.app, v.settings, { table: "meeting", name: "active_attendees", check: { "attendees.active": true } })).ok).toBe(true);
  return v;
}

const constraintsOf = async (v: DbVault, table: string) => {
  const ms = await loadMetastore(v.app, v.settings);
  return ms!.model.catalogs.main!.schemas.work!.tables[table]!.constraints;
};

describe("CHECKs that follow links: renames, missing tables, inverse edits, undo, schema changes", () => {
  it("renaming a row others link to succeeds: their links follow it (B1)", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    const renamed = await updateRow(v.app, v.settings, { table: "project", path: `${P}/Site.md`, set: { name: "Site2" } });
    expect(renamed.ok, JSON.stringify(renamed.violations)).toBe(true);
    expect(renamed.planned_moves).toEqual([{ from: `${P}/Site.md`, to: `${P}/Site2.md` }]);
    // the rename and a change that breaks the workstreams, in one operation: still refused
    const w = await projects();
    expect((await addConstraint(w.app, w.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    const both = await updateRow(w.app, w.settings, { table: "project", path: `${P}/Site.md`, set: { name: "Site2", kind: "area" }, unset: ["parent"] });
    expect(messages(both)).toEqual([
      [`${P}/Build.md`, "violates CHECK parent_by_level"],
      [`${P}/Paint.md`, "violates CHECK parent_by_level"],
    ]);
    expect(both.violations[0]!.violations[0]!.message).toContain("(after this change to [[Site2]], a row it links to)");
  });

  it("renaming a person a meeting lists succeeds (list links) (B1)", async () => {
    const v = await people();
    expect((await insertRow(v.app, v.settings, { table: "meeting", values: { title: "Kickoff", attendees: [who("Ada"), who("Cy")] } })).ok).toBe(true);
    const r = await updateRow(v.app, v.settings, { table: "person", path: `${PERSON}/Cy.md`, set: { name: "Cyrus" } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    expect(v.exists(`${PERSON}/Cyrus.md`)).toBe(true);
  });

  it("links resolve by path: same-named rows in different folders stay apart (M2)", async () => {
    const v = await people();
    expect((await insertRow(v.app, v.settings, { table: "person", path: `${PERSON}/a/Dan.md`, values: { name: "Dan", active: true } })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "person", path: `${PERSON}/b/Dan.md`, values: { name: "Dan", active: false } })).ok).toBe(true);
    const ok = await insertRow(v.app, v.settings, { table: "meeting", values: { title: "One", attendees: [`[[${PERSON}/a/Dan|Dan]]`] } });
    expect(ok.ok, JSON.stringify(ok.violations)).toBe(true);
    const bad = await insertRow(v.app, v.settings, { table: "meeting", values: { title: "Two", attendees: [`[[${PERSON}/b/Dan|Dan]]`] } });
    expect(messages(bad)).toEqual([["Datanotes/main/work/meeting/Two.md", "violates CHECK active_attendees"]]);
    // a link to a row created in the same batch step resolves to it
    const api = createPublicApi(v.app, () => v.settings);
    const batch = await api.batch({
      operations: [
        { op: "insert_row", table: "person", values: { name: "Eve", active: true } },
        { op: "insert_row", table: "meeting", values: { title: "Three", attendees: [who("Eve")] } },
      ],
    });
    expect(batch.ok, JSON.stringify(batch.steps.map((s) => s.error ?? s.result?.violations))).toBe(true);
  });

  it("renaming a table a CHECK reads through a link rewrites the link's ref, dropping it is refused; a missing ref table never fails unrelated writes (B2)", async () => {
    const v = await people();
    const rename = await alterTable(v.app, v.settings, { table: "person", name: "people" }, { dryRun: true });
    expect([rename.ok, rename.conflicts]).toEqual([true, []]);
    expect(rename.schema_references).toEqual([{ table: "main.work.meeting", column: "attendees", key: "ref", from: "main.work.person", to: "main.work.people" }]);
    const drop = await dropTable(v.app, v.settings, { table: "person", mode: "archive" });
    expect(drop.conflicts.map((c) => c.message)).toContainEqual(expect.stringMatching(/^CHECK active_attendees of main\.work\.meeting reads main\.work\.person/));
    expect((await insertRow(v.app, v.settings, { table: "meeting", values: { title: "Kickoff", attendees: [who("Cy")] } })).ok).toBe(true);
    // a ref to a table that is not there (metastore.yaml edited by hand)
    v.write(METASTORE, v.read(METASTORE).replace("ref: main.work.person", "ref: main.work.nobody"));
    expect((await insertRow(v.app, v.settings, { table: "person", values: { name: "Dee", active: true } })).ok).toBe(true);
    expect((await updateRow(v.app, v.settings, { table: "person", path: `${PERSON}/Ada.md`, set: { active: false } })).ok).toBe(true);
    const write = await insertRow(v.app, v.settings, { table: "meeting", values: { title: "Standup", attendees: [who("Ada")] } });
    expect(write.ok).toBe(false);
    expect(write.violations.flatMap((x) => x.violations.map((y) => y.message))).toContainEqual(
      `CHECK active_attendees is invalid: "attendees" links to main.work.nobody, which is not a table (renamed or dropped?)`,
    );
    const check = await checkTable(v.app, v.settings, { table: "meeting" });
    expect(check.violations.flatMap((x) => x.violations.filter((y) => y.code === "check").map((y) => [x.path, y.message.slice(0, 33)]))).toEqual([
      ["Datanotes/main/work/meeting/Kickoff.md", "CHECK active_attendees is invalid"],
    ]);
  });

  it("inverse-link edits are checked too (M1)", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    await createTable(v.app, v.settings, described({
      schema: "work", name: "person", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string", required: true, dense: true }],
    }));
    await createTable(v.app, v.settings, described({
      schema: "work", name: "project", options: { filename: "{title}" },
      columns: [
        { name: "title", type: "string", required: true, dense: true },
        { name: "status", type: "enum", values: ["active", "closed"], dense: true },
        { name: "members", type: "list", items: "link", ref: "main.work.person" },
      ],
    }));
    expect((await addColumn(v.app, v.settings, described({ table: "person", column: { name: "projects", type: "list", items: "link", ref: "main.work.project", inverse: "members" } }))).ok).toBe(true);
    expect((await alterColumn(v.app, v.settings, { table: "project", name: "members", changes: { inverse: "projects" } })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "person", values: { name: "Ada" } })).ok).toBe(true);
    expect((await addConstraint(v.app, v.settings, { table: "person", name: "active_projects", check: { "projects.status": "active" } })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "project", values: { title: "New", status: "active", members: [who("Ada")] } })).ok).toBe(true);
    // the project itself has no CHECK; the back-link it adds to Ada breaks hers
    const r = await insertRow(v.app, v.settings, { table: "project", values: { title: "Old", status: "closed", members: [who("Ada")] } });
    expect(r.ok).toBe(false);
    expect(messages(r)).toEqual([[`${PERSON}/Ada.md`, "violates CHECK active_projects"]]);
    expect(r.violations[0]!.violations[0]!.message).toContain("(after this change to [[Old]], a row it links to)");
    expect(v.exists("Datanotes/main/work/project/Old.md")).toBe(false);
  });

  it("undo_migration and restore_table are refused when they would break rows that link to what they restore (M3)", async () => {
    const v = await people(true);
    const on = await updateRow(v.app, v.settings, { table: "person", path: `${PERSON}/Bob.md`, set: { active: true } });
    expect(on.ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "meeting", values: { title: "Kickoff", attendees: [who("Bob")] } })).ok).toBe(true);
    const undo = await undoOperation(v.app, v.settings, on.migration_id!);
    expect(undo.ok).toBe(false);
    expect(undo.conflicts.map((c) => [c.path, c.message.replace(/:.*?(\(|$)/s, "$1")])).toEqual([
      ["Datanotes/main/work/meeting/Kickoff.md", "violates CHECK active_attendees(after this change to [[Bob]], a row it links to); to undo, fix the row first, or drop the rule that refuses it (alter_column ref_where / ref_by: null, drop_constraint)"],
    ]);
    expect(v.read(`${PERSON}/Bob.md`)).toMatch(/active: true/);
    const h = await describeHistory(v.app, v.settings, { table: "person" });
    const before = h.history.find((c) => c.operation === "UPDATE")!.version - 1;
    const restore = await restoreTable(v.app, v.settings, { table: "person", version: before });
    expect(restore.ok).toBe(false);
    expect(messages(restore)).toEqual([["Datanotes/main/work/meeting/Kickoff.md", "violates CHECK active_attendees"]]);
    // with the meeting gone, both work
    expect((await deleteRows(v.app, v.settings, { table: "meeting", where: { title: "Kickoff" }, mode: "delete" })).ok).toBe(true);
    expect((await undoOperation(v.app, v.settings, on.migration_id!)).ok).toBe(true);
  });

  it("set_null refusals name the deleted row (N5)", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    const r = await deleteRows(v.app, v.settings, { table: "project", where: { name: "Site" }, onReferenced: "set_null" });
    expect(r.violations.map((x) => x.violations[0]!.message.slice(x.violations[0]!.message.indexOf(" (after")))).toEqual([
      " (after this change to [[Site]], a row it links to)",
      " (after this change to [[Site]], a row it links to)",
    ]);
  });

  it("rename_column and rename_value follow into CHECKs, here and through links; drop_column of a column a CHECK reads is refused (N1)", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    expect((await renameColumn(v.app, v.settings, { table: "project", from: "kind", to: "level" })).ok).toBe(true);
    expect((await renameValue(v.app, v.settings, { table: "project", column: "level", from: "project", to: "initiative" })).ok).toBe(true);
    expect((await constraintsOf(v, "project"))!.parent_by_level).toEqual({
      or: [
        { level: "area", parent: { exists: false } },
        { level: "initiative", "parent.level": "area" },
        { level: "workstream", "parent.level": "initiative" },
      ],
    });
    expect((await checkTable(v.app, v.settings, { table: "project" })).violations).toEqual([]);
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", level: "workstream", parent: ref("Home") } })).ok).toBe(false);
    const drop = await dropColumn(v.app, v.settings, { table: "project", name: "level" });
    expect(drop.ok).toBe(false);
    expect(drop.conflicts.map((c) => c.message)).toEqual(["CHECK parent_by_level of main.work.project reads project.level: drop or change it first"]);

    const w = await people();
    expect((await renameColumn(w.app, w.settings, { table: "person", from: "active", to: "present" })).ok).toBe(true);
    expect((await constraintsOf(w, "meeting"))!.active_attendees).toEqual({ "attendees.present": true });
    const off = await dropColumn(w.app, w.settings, { table: "person", name: "present" });
    expect(off.conflicts.map((c) => c.message)).toEqual(["CHECK active_attendees of main.work.meeting reads person.present: drop or change it first"]);
    expect((await dropColumn(w.app, w.settings, { table: "meeting", name: "attendees" })).conflicts.map((c) => c.message)).toEqual([
      "CHECK active_attendees of main.work.meeting reads meeting.attendees: drop or change it first",
    ]);
  });
});

describe("CHECKs that follow links: undo that puts a CHECK back", () => {
  it("undo of drop_constraint refuses the rows that break the CHECK it puts back, naming the way out", async () => {
    const v = await projects();
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
    const off = await dropConstraint(v.app, v.settings, { table: "project", name: "parent_by_level" });
    expect(off.ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Home") } })).ok).toBe(true);
    const undo = await undoOperation(v.app, v.settings, off.migration_id!);
    expect(undo.ok).toBe(false);
    expect(undo.conflicts.map((c) => [c.path, c.message.replace(/: \{.*\}/s, "")])).toEqual([
      [`${P}/Roof.md`, "violates CHECK parent_by_level (CHECK parent_by_level comes back with this change); to undo, fix the row first, or drop the rule that refuses it (alter_column ref_where / ref_by: null, drop_constraint)"],
    ]);
    expect((await constraintsOf(v, "project"))?.parent_by_level).toBeUndefined();
    expect((await updateRow(v.app, v.settings, { table: "project", path: `${P}/Roof.md`, set: { parent: ref("Site") } })).ok).toBe(true);
    expect((await undoOperation(v.app, v.settings, off.migration_id!)).ok).toBe(true);
    expect((await constraintsOf(v, "project"))!.parent_by_level).toEqual(PARENT_BY_LEVEL);
  });
});
