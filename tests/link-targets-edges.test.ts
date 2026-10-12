/**
 * Filtered link columns (ref_where / ref_by) and link_options at their edges: valid targets
 * sharing a name, more valid targets than a refusal lists, targets without the level column,
 * values that are no links, lists naming several missing rows or the row itself, an invalid
 * ref_where given to add_column, and rows named by a partial path or not found.
 */

import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { addColumn, createTable, INDEX_RETRY, OperationInputError, type OpResult } from "../src/core/engine";
import { checkTable, insertRow, linkOptions, mergeRows } from "../src/core/rows";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const P = "Datanotes/main/work/project";
const ref = (n: string) => `[[${P}/${n}|${n}]]`;
const MAP = { area: null, project: ["area"], workstream: ["project"] };

/**
 * `project` (self-referencing `parent` by level: an area has none, a project's is an area, a
 * workstream's is a project; `related`: other projects of kind project): Home (area) ← Site,
 * Shop (projects).
 */
async function projects(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  const created = await createTable(v.app, v.settings, described({
    schema: "work",
    name: "project",
    options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true, dense: true },
      { name: "kind", type: "enum", values: ["area", "project", "workstream"], dense: true },
      { name: "parent", type: "link", ref: "self", ref_by: { column: "kind", map: MAP } },
      { name: "related", type: "list", items: "link", ref: "self", ref_where: { kind: "project" } },
    ],
  }));
  expect(created.ok, JSON.stringify(created.conflicts)).toBe(true);
  for (const [name, kind, parent] of [
    ["Home", "area", null],
    ["Site", "project", "Home"],
    ["Shop", "project", "Home"],
  ] as const) {
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name, kind, ...(parent ? { parent: ref(parent) } : {}) } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  }
  return v;
}

const violations = (r: OpResult) => r.violations.flatMap((x) => x.violations.map((v) => ({ path: x.path, column: v.column, code: v.code, message: v.message })));

async function refused(p: Promise<unknown>, message: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(OperationInputError);
  await expect(p).rejects.toThrow(message);
}

describe("refusals of a filtered link", () => {
  it("lists at most 20 valid targets, then how many more", async () => {
    const v = await projects();
    const names = Array.from({ length: 21 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`);
    expect((await mergeRows(v.app, v.settings, { table: "project", on: ["name"], rows: names.map((name) => ({ name, kind: "project", parent: ref("Home") })) })).ok).toBe(true);
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Home") } });
    const valid = [...names, "Shop", "Site"];
    expect(violations(r)).toEqual([
      { path: `${P}/Roof.md`, column: "parent", code: "ref", message: `[[Home]] is not a valid parent for kind "workstream" (needs kind project); valid: ${valid.slice(0, 20).join(", ")} (+3 more)` },
    ]);
  });

  it("valid targets sharing a name are listed by path; a target without the level column is not valid", async () => {
    const v = await projects();
    v.write("Old/Site.md", "---\ntable: main.work.project\nid: 01a0f000-0000-7000-8000-0000000000b1\nname: Site\nkind: project\nparent: \"[[Home]]\"\n---\n");
    v.write(`${P}/Loose.md`, "---\ntable: main.work.project\nid: 01a0f000-0000-7000-8000-0000000000b2\nname: Loose\n---\n");
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "workstream", parent: ref("Home") } });
    expect(violations(r)).toEqual([
      { path: `${P}/Roof.md`, column: "parent", code: "ref", message: `[[Home]] is not a valid parent for kind "workstream" (needs kind project); valid: Shop, Site, Site` },
    ]);
    const options = await linkOptions(v.app, v.settings, { table: "project", column: "parent", values: { kind: "workstream" } });
    expect(options.rows.map((x) => x.path)).toEqual([`${P}/Shop.md`, `${P}/Site.md`, "Old/Site.md"]);
  });

  it("a value that is no link, a list naming several missing rows and the row itself: check_table says each", async () => {
    const v = await projects();
    // a write reports a value that is no link once, by the column type
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name: "Roof", kind: "project", parent: "Nowhere" } });
    expect(violations(r)).toEqual([{ path: `${P}/Roof.md`, column: "parent", code: "type", message: `expected a wikilink "[[Note]]"` }]);
    v.write(`${P}/Roof.md`, '---\ntable: main.work.project\nid: 01a0f000-0000-7000-8000-0000000000b9\nname: Roof\nkind: project\nparent: Nowhere\nrelated: ["[[Gone]]", "[[Lost]]", "[[Roof]]"]\n---\n');
    const check = await checkTable(v.app, v.settings, { table: "project" });
    expect(check.violations.map((x) => [x.path, x.violations.map((y) => [y.index !== undefined ? `${y.column}[${y.index}]` : y.column, y.code, y.message])])).toEqual([
      [
        `${P}/Roof.md`,
        [
          ["parent", "type", `expected a wikilink "[[Note]]"`],
          ["related[0]", "broken_link", "link does not resolve: Gone"],
          ["related[1]", "broken_link", "link does not resolve: Lost"],
          ["parent", "broken_link", "[[Nowhere]] is not a row of main.work.project; valid: Home"],
          ["related", "broken_link", "[[Gone]], [[Lost]] are not rows of main.work.project; valid: Shop, Site"],
          ["related", "ref", "related cannot hold the row itself"],
        ],
      ],
    ]);
  });
});

describe("add_column", () => {
  it("refuses a ref_where that is not a valid filter, naming the column", async () => {
    const v = await projects();
    await refused(
      addColumn(v.app, v.settings, described({ table: "project", column: { name: "lead", type: "link", ref: "self", ref_where: { owner: "me" } } })),
      `ref_where of lead: `,
    );
  });
});

describe("link_options", () => {
  it("without the level column's value: every level's targets, the level of each (null when missing)", async () => {
    const v = await projects();
    v.write(`${P}/Loose.md`, "---\ntable: main.work.project\nid: 01a0f000-0000-7000-8000-0000000000b2\nname: Loose\n---\n");
    const r = await linkOptions(v.app, v.settings, { table: "project", column: "parent" });
    expect(r.reason).toBe("no kind given: every level's targets (ref_by on kind picks them)");
    expect(r.rows.map((x) => [x.name, x.kind])).toEqual([
      ["Home", "area"],
      ["Loose", null],
      ["Shop", "project"],
      ["Site", "project"],
    ]);
  });

  it("finds the row by a partial path, and refuses a row that is not there", async () => {
    const v = await projects();
    const r = await linkOptions(v.app, v.settings, { table: "project", column: "related", row: "project/Site" });
    expect(r.rows.map((x) => x.name)).toEqual(["Shop"]);
    await refused(linkOptions(v.app, v.settings, { table: "project", column: "related", row: "Nope" }), `no row of main.work.project is "Nope"`);
  });
});
