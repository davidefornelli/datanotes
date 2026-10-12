import { describe, expect, it } from "vitest";
import { addColumn, createTable, INDEX_RETRY, loadTable, OperationInputError } from "../src/core/engine";
import { CheckLinks, followsLinks, tableIn, type MetastoreState } from "../src/core/check-links";
import { emptyChangeSet } from "../src/core/changeset";
import { loadMetastore } from "../src/core/metastore";
import { insertRow } from "../src/core/rows";
import { TableNotFoundError } from "../src/core/table-registry";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

/** Matches an error of the same class with the same message (toThrow alone compares messages only). */
const exactly = (e: Error) => expect.objectContaining({ constructor: e.constructor, message: e.message });

const P = "Datanotes/main/work/project";
const T = "Datanotes/main/work/task";
const ref = (n: string) => `[[${P}/${n}|${n}]]`;

/**
 * `project` (self-referencing): Home (area) ← Site (project) ← Build (workstream); `task` linking to
 * a project, created after `before` (the metastore as it was without it); a plain note.
 */
async function work(): Promise<{ v: DbVault; before: MetastoreState }> {
  const v = createDbVault({ "Notes/Ideas.md": "# Ideas\n" });
  await createTable(v.app, v.settings, described({
    schema: "work",
    name: "project",
    options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true, dense: true },
      { name: "kind", type: "enum", values: ["area", "project", "workstream"], dense: true },
      { name: "parent", type: "link", ref: "self", hierarchy: true },
    ],
  }));
  for (const [name, kind, parent] of [["Home", "area", null], ["Site", "project", "Home"], ["Build", "workstream", "Site"]] as const) {
    expect((await insertRow(v.app, v.settings, { table: "project", values: { name, kind, ...(parent ? { parent: ref(parent) } : {}) } })).ok).toBe(true);
  }
  const before = (await loadMetastore(v.app, v.settings))!;
  await createTable(v.app, v.settings, described({
    schema: "work",
    name: "task",
    options: { filename: "{title}" },
    columns: [
      { name: "title", type: "string", required: true },
      { name: "project", type: "link", ref: "main.work.project" },
    ],
  }));
  for (const [title, project] of [["Call", "Build"], ["Plan", "Site"]] as const) {
    expect((await insertRow(v.app, v.settings, { table: "task", values: { title, project: ref(project) } })).ok).toBe(true);
  }
  return { v, before };
}

describe("followsLinks", () => {
  it.each([
    [{ "parent.kind": "area" }, true],
    [{ or: [{ kind: "area" }, { "parent.kind": "area" }] }, true],
    [{ not: { "parent.parent.kind": "area" } }, true],
    [{ and: [{ kind: "area" }, { or: [{ name: "Home" }] }] }, false],
    [{ ".kind": "area", kind: "area" }, false],
    [[{ "parent.kind": "area" }], false],
    [{ or: [[{ "parent.kind": "area" }]] }, false],
    [null, false],
    ["parent.kind", false],
  ])("%j → %s", (where, expected) => {
    expect(followsLinks(where)).toBe(expected);
  });
});

describe("CheckLinks: the rows a CHECK reads through links", () => {
  it("linked() refuses a column that is not a link with ref", async () => {
    const { v } = await work();
    expect((await addColumn(v.app, v.settings, described({ table: "task", column: { name: "see_also", type: "link" } }))).ok).toBe(true);
    const task = await loadTable(v.app, v.settings, "task");
    const links = new CheckLinks(v.app, v.settings);
    await expect(links.linked(task, "title")).rejects.toThrow(exactly(new OperationInputError(`"title" is not a link column with ref`)));
    await expect(links.linked(task, "see_also")).rejects.toThrow(exactly(new OperationInputError(`"see_also" is not a link column with ref`)));
    const { table, rows } = await links.linked(task, "project");
    expect([table.catalog.ref.full, [...rows.keys()].sort()]).toEqual(["main.work.project", [`${P}/Build.md`, `${P}/Home.md`, `${P}/Site.md`]]);
  });

  it("rowsOf is empty until the table is loaded", async () => {
    const { v } = await work();
    const project = await loadTable(v.app, v.settings, "project");
    const links = new CheckLinks(v.app, v.settings);
    expect(links.rowsOf(project)).toEqual([]);
    await links.prepare(project, null);
    expect(links.rowsOf(project).map((r) => r.file.path).sort()).toEqual([`${P}/Build.md`, `${P}/Home.md`, `${P}/Site.md`]);
  });

  it("reads() names the tables a CHECK's dotted keys reach, through not and further links, once prepared", async () => {
    const { v } = await work();
    const task = await loadTable(v.app, v.settings, "task");
    const where = { title: { exists: true }, not: { "project.parent.kind": "area" } };
    const links = new CheckLinks(v.app, v.settings);
    expect(links.reads(task, where)).toEqual(new Set());
    await links.prepare(task, where);
    expect(links.reads(task, where)).toEqual(new Set(["main.work.project"]));
    expect(links.loadedTables().sort()).toEqual(["main.work.project", "main.work.task"]);
  });

  it("test() needs the links prepared first", async () => {
    const { v } = await work();
    const task = await loadTable(v.app, v.settings, "task");
    const links = new CheckLinks(v.app, v.settings);
    expect(() => links.test(task, "project.kind", "workstream")).toThrow(exactly(new OperationInputError(`CHECK links not loaded for "project.kind"`)));
    await links.prepare(task, { "project.kind": "workstream" });
    const pred = links.test(task, "project.kind", "workstream");
    expect(links.rowsOf(task).map((r) => [r.file.path, pred(r)]).sort()).toEqual([
      [`${T}/Call.md`, true],
      [`${T}/Plan.md`, false],
    ]);
  });
});

describe("CheckLinks.tableOf: the table of the row at a path", () => {
  it("without a change set, as the vault has it", async () => {
    const { v } = await work();
    const links = new CheckLinks(v.app, v.settings);
    expect([`${P}/Home.md`, `${T}/Call.md`, "Notes/Ideas.md", "Notes/Nowhere.md"].map((p) => links.tableOf(p))).toEqual([
      "main.work.project",
      "main.work.task",
      null,
      null,
    ]);
  });

  it("with a change set, its notes as it leaves them and the others as the vault has them", async () => {
    const { v } = await work();
    const cs = emptyChangeSet("test", "edits, creations, deletions and moves");
    // Call leaves its table; Ideas joins task, then moves
    cs.edits.push({ path: `${T}/Call.md`, before: [["table", "main.work.task"], ["title", "Call"]], after: [["title", "Call"]] });
    cs.edits.push({ path: "Notes/Ideas.md", before: [], after: [["table", "main.work.task"], ["title", "Ideas"]] });
    cs.moves.push({ from: "Notes/Ideas.md", to: "Notes/Old ideas.md" });
    cs.creates.push({ path: "Notes/Draft.md", content: "---\ntitle: Draft\n---\nNo table.\n" });
    cs.creates.push({ path: `${P}/Roof.md`, content: "---\ntable: main.work.project\nname: Roof\n---\n" });
    cs.deletes.push(`${P}/Build.md`);
    // a rename the change set does not otherwise touch
    cs.moves.push({ from: `${P}/Site.md`, to: `${P}/Building site.md` });
    const links = new CheckLinks(v.app, v.settings, cs);
    const paths = [
      `${T}/Call.md`,
      "Notes/Ideas.md",
      "Notes/Old ideas.md",
      "Notes/Draft.md",
      `${P}/Roof.md`,
      `${P}/Build.md`,
      `${P}/Site.md`,
      `${P}/Building site.md`,
      `${P}/Home.md`,
      `${T}/Plan.md`,
    ];
    expect(Object.fromEntries(paths.map((p) => [p, links.tableOf(p)]))).toEqual({
      [`${T}/Call.md`]: null,
      "Notes/Ideas.md": null,
      "Notes/Old ideas.md": "main.work.task",
      "Notes/Draft.md": null,
      [`${P}/Roof.md`]: "main.work.project",
      [`${P}/Build.md`]: null,
      [`${P}/Site.md`]: null,
      [`${P}/Building site.md`]: "main.work.project",
      [`${P}/Home.md`]: "main.work.project",
      [`${T}/Plan.md`]: "main.work.task",
    });
  });

  it("with the metastore a change set leaves, table names resolve in it", async () => {
    const { v, before } = await work();
    const cs = emptyChangeSet("test", "a note joins task");
    cs.edits.push({ path: "Notes/Ideas.md", before: [], after: [["table", "main.work.task"], ["title", "Ideas"]] });
    expect(new CheckLinks(v.app, v.settings, cs).tableOf("Notes/Ideas.md")).toBe("main.work.task");
    // the metastore before task was created knows no such table
    expect(new CheckLinks(v.app, v.settings, cs, before).tableOf("Notes/Ideas.md")).toBeNull();
  });
});

describe("tableIn", () => {
  it("loads a table from the current metastore or from a given one, refusing a table it does not have", async () => {
    const { v, before } = await work();
    expect((await tableIn(v.app, v.settings, undefined, "task")).catalog.ref.full).toBe("main.work.task");
    const project = await tableIn(v.app, v.settings, before, "main.work.project");
    expect([project.catalog.ref.full, project.def.columns.map((c) => c.name)]).toEqual(["main.work.project", ["id", "name", "kind", "parent"]]);
    await expect(tableIn(v.app, v.settings, before, "main.work.task")).rejects.toThrow(exactly(new TableNotFoundError("main.work.task")));
    await expect(tableIn(v.app, v.settings, before, "main.work.task")).rejects.toThrow("Table not found: main.work.task");
  });
});
