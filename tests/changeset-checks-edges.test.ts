/**
 * Rules that follow links, checked on the state a write leaves, at their edges: a CHECK under
 * `not`, a row broken two links away (no row of its own links changed), a row reaching several
 * changed rows, and a CHECK written wrong.
 */

import { describe, expect, it } from "vitest";
import { INDEX_RETRY, undoOperation, type OpResult } from "../src/core/engine";
import { loadMetastore } from "../src/core/metastore";
import { insertRow, updateRows } from "../src/core/rows";
import { createDbVault, logVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/**
 * `project` (kind area / project, `parent` a project); `task`: its `project` is never an area
 * (CHECK not_area), `projects` only of kind project; `tour`: its project's parent is an area
 * (CHECK under_area); `chore`: a CHECK whose `or` holds a value that is no condition.
 */
const TABLES = `project:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string, required: true, dense: true }
    - { name: kind, type: enum, values: [area, project], dense: true }
    - { name: parent, type: link, ref: self }
task:
  options: { filename: "{title}" }
  constraints:
    not_area: { not: { "project.kind": area } }
  columns:
    - ${ID}
    - { name: title, type: string, required: true, dense: true }
    - { name: project, type: link, ref: main.public.project }
    - { name: projects, type: list, items: link, ref: main.public.project, ref_where: { kind: project } }
tour:
  options: { filename: "{title}" }
  constraints:
    under_area: { "project.parent.kind": area }
  columns:
    - ${ID}
    - { name: title, type: string, required: true, dense: true }
    - { name: project, type: link, ref: main.public.project }
chore:
  options: { filename: "{title}" }
  constraints:
    odd: { or: [weekly, { "project.kind": project }] }
  columns:
    - ${ID}
    - { name: title, type: string, required: true, dense: true }
    - { name: project, type: link, ref: main.public.project }
`;

let n = 0;
const row = (table: string, extra: string) => `---\ntable: main.public.${table}\nid: 01a0f000-0000-7000-8000-${String(++n).padStart(12, "0")}\n${extra}---\n`;

function vault(): DbVault {
  return createDbVault({
    [METASTORE]: withTables(TABLES),
    "Prj/Home.md": row("project", "name: Home\nkind: area\n"),
    "Prj/Site.md": row("project", 'name: Site\nkind: project\nparent: "[[Home]]"\n'),
    "Prj/Shop.md": row("project", 'name: Shop\nkind: project\nparent: "[[Home]]"\n'),
    "Tsk/Paint.md": row("task", 'title: Paint\nprojects: ["[[Site]]", "[[Shop]]"]\n'),
    "Tour/Walk.md": row("tour", 'title: Walk\nproject: "[[Site]]"\n'),
  });
}

const violations = (r: OpResult) => r.violations.flatMap((x) => x.violations.map((v) => ({ path: x.path, ...(v.constraint !== undefined ? { constraint: v.constraint } : { column: v.column }), code: v.code, message: v.message })));

describe("CHECKs that follow links", () => {
  it("a CHECK under `not` refuses a row it fails, with its text", async () => {
    const v = vault();
    const r = await insertRow(v.app, v.settings, { table: "task", values: { title: "Mow", project: "[[Home]]" } });
    expect(violations(r)).toEqual([
      { path: "Datanotes/main/public/task/Mow.md", constraint: "not_area", code: "check", message: `violates CHECK not_area: {"not":{"project.kind":"area"}}` },
    ]);
    expect((await insertRow(v.app, v.settings, { table: "task", values: { title: "Mow", project: "[[Site]]" } })).ok).toBe(true);
  });

  it("a row broken two links away is refused without naming a row it links to", async () => {
    const v = vault();
    const r = await updateRows(v.app, v.settings, { table: "project", where: { name: "Home" }, set: { kind: "project" } });
    expect(violations(r)).toEqual([
      {
        path: "Tour/Walk.md",
        constraint: "under_area",
        code: "check",
        message: `violates CHECK under_area: {"project.parent.kind":"area"} (after this change to a row it links to)`,
      },
    ]);
  });

  it("a CHECK written wrong refuses the rows written, saying why", async () => {
    const v = vault();
    const r = await insertRow(v.app, v.settings, { table: "chore", values: { title: "Dust", project: "[[Site]]" } });
    expect(r.ok).toBe(false);
    expect(violations(r).map((x) => [x.path, "constraint" in x ? x.constraint : undefined, x.code])).toEqual([["Datanotes/main/public/chore/Dust.md", "odd", "check"]]);
    expect(violations(r)[0]!.message).toMatch(/^CHECK odd is invalid: /);
  });
});

describe("filtered link columns", () => {
  it("a row reaching several changed rows names them all", async () => {
    const v = vault();
    const r = await updateRows(v.app, v.settings, { table: "project", where: { name: { in: ["Site", "Shop"] } }, set: { kind: "area" } });
    expect(violations(r).filter((x) => x.path === "Tsk/Paint.md")).toEqual([
      {
        path: "Tsk/Paint.md",
        column: "projects",
        code: "ref",
        message: `[[Site]], [[Shop]] are not valid targets in projects (needs ref_where {"kind":"project"}); valid: none (after this change to [[Shop]], [[Site]], rows it links to)`,
      },
    ]);
  });
});

describe("an undo when the database has no metastore any more", () => {
  it("has no link rules to check: the rows are put back", async () => {
    const v = logVault();
    const before = v.read("Daily/a.md");
    const r = await updateRows(v.app, v.settings, { table: "log", where: { kind: "alcohol" }, set: { metric_drinks: 2 } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    v.remove(METASTORE);
    await loadMetastore(v.app, v.settings);
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok, JSON.stringify(u)).toBe(true);
    expect(v.read("Daily/a.md")).toBe(before);
  });
});
