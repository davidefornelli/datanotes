/**
 * define_base / set_table_bases edges (catalog-ops.ts): refusals with their messages, base
 * columns given in metastore words, inherited dense columns filled on the rows, a base column an
 * inheriting table cannot have, and a renamed base column followed by its own link filters, the
 * CHECKs of the inheriting tables and the `ref_by` of tables linking to them.
 */

import { describe, expect, it } from "vitest";
import { addConstraint, defineBase, setTableBases } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { parseMetastore } from "../src/core/metastore";
import { checkTable, insertRow } from "../src/core/rows";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const model = (v: DbVault) => parseMetastore(v.read(METASTORE));
const table = (v: DbVault, name: string) => model(v).catalogs.main!.schemas.plan!.tables[name]!;

async function refused(p: Promise<unknown>, cls: abstract new (...args: never[]) => Error, message: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(cls);
  expect((e as Error).message).toBe(message);
}

const G = "Datanotes/main/plan/goal";
const LEVELS = ["area", "project", "task"];
const ref = (n: string) => `[[${n}]]`;
const PARENT = { name: "parent", type: "link", ref: "self", ref_where: { level: { ne: "task" } }, ref_by: { column: "level", levels: LEVELS } };

/**
 * Base `leveled` (a `level` and a `parent` that follows the levels, `ref: self`); `main.plan.goal`
 * extends it (CHECK has_level); `main.plan.note` links to a goal of its own level (`ref_by` map).
 */
async function planVault(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  const base = await defineBase(v.app, v.settings, describedBase({ name: "leveled", columns: [{ name: "level", type: "enum", values: LEVELS }, PARENT] }));
  expect(base.ok).toBe(true);
  expect((await createTable(v.app, v.settings, described({ schema: "plan", name: "goal", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true, dense: true }] }))).ok).toBe(true);
  expect((await setTableBases(v.app, v.settings, { table: "goal", bases: ["leveled"] })).ok).toBe(true);
  expect((await addConstraint(v.app, v.settings, { table: "goal", name: "has_level", check: { level: { exists: true } } })).ok).toBe(true);
  const note = await createTable(v.app, v.settings, described({
    schema: "plan",
    name: "note",
    options: { filename: "{title}" },
    columns: [
      { name: "title", type: "string", required: true, dense: true },
      { name: "scope", type: "enum", values: LEVELS },
      { name: "about", type: "link", ref: "main.plan.goal", ref_by: { column: "scope", target_column: "level", map: { area: ["area"], project: ["project"], task: ["task"] } } },
    ],
  }));
  expect(note.ok, JSON.stringify(note.conflicts)).toBe(true);
  for (const [t, values] of [
    ["goal", { name: "Home", level: "area" }],
    ["goal", { name: "Site", level: "project", parent: ref("Home") }],
    ["goal", { name: "Paint", level: "task", parent: ref("Site") }],
    ["note", { title: "Ideas", scope: "project", about: ref("Site") }],
  ] as const) {
    const r = await insertRow(v.app, v.settings, { table: t, values });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  }
  return v;
}

describe("define_base refusals", () => {
  it("refuses a column listed twice, the system id, and renames that do not match the columns", async () => {
    const v = await planVault();
    const before = v.read(METASTORE);
    await refused(
      defineBase(v.app, v.settings, describedBase({ name: "dated", columns: [{ name: "on", type: "date" }, { name: "on", type: "datetime" }] })),
      OperationInputError,
      `duplicate column in base "dated"`,
    );
    await refused(defineBase(v.app, v.settings, describedBase({ name: "dated", columns: [{ name: "id", type: "string" }] })), OperationInputError, `"id" is the system column of every table: it cannot be in a base`);
    await refused(
      defineBase(v.app, v.settings, describedBase({ name: "leveled", columns: [{ name: "tier", type: "enum", values: LEVELS }, PARENT], renameColumns: { kind: "tier" } })),
      OperationInputError,
      `rename: "kind" is not a column of base "leveled"`,
    );
    await refused(
      defineBase(v.app, v.settings, describedBase({ name: "leveled", columns: [{ name: "level", type: "enum", values: LEVELS }, PARENT], renameColumns: { level: "tier" } })),
      OperationInputError,
      `rename: "tier" must be in the new columns`,
    );
    expect(v.read(METASTORE)).toBe(before);
  });

  it("refuses an unknown base to extend and an inheritance cycle", async () => {
    const v = await planVault();
    await refused(defineBase(v.app, v.settings, describedBase({ name: "dated", columns: [{ name: "on", type: "date" }], bases: ["timed"] })), OperationInputError, `bases.dated: unknown base "timed"`);
    expect((await defineBase(v.app, v.settings, describedBase({ name: "dated", columns: [{ name: "on", type: "date" }], bases: ["leveled"] }))).ok).toBe(true);
    await refused(
      defineBase(v.app, v.settings, describedBase({ name: "leveled", columns: [{ name: "level", type: "enum", values: LEVELS }, PARENT], bases: ["dated"] })),
      OperationInputError,
      `bases: inheritance cycle leveled → dated → leveled`,
    );
  });

  it("refuses inverse on a base column: it names a column of one table", async () => {
    const v = await planVault();
    await refused(
      defineBase(v.app, v.settings, describedBase({ name: "assigned", columns: [{ name: "goal", type: "link", ref: "main.plan.goal", inverse: "notes" }] })),
      OperationInputError,
      `bases.assigned.goal: "inverse" is only valid on table columns`,
    );
  });

  it("refuses a base column an inheriting table cannot have, naming the table", async () => {
    const v = await planVault();
    expect((await defineBase(v.app, v.settings, describedBase({ name: "labeled", columns: [{ name: "tags", type: "list", items: "string" }] }))).ok).toBe(true);
    expect((await setTableBases(v.app, v.settings, { table: "goal", bases: ["leveled", "labeled"] })).ok).toBe(true);
    expect((await setTableBases(v.app, v.settings, { table: "note", bases: ["labeled"] })).ok).toBe(true);
    // the goal has a name, the note only a title
    await refused(
      defineBase(v.app, v.settings, describedBase({ name: "labeled", columns: [{ name: "tags", type: "list", items: "string" }, { name: "display", type: "string", generated: "{name}" }] })),
      OperationInputError,
      `main.plan.note: columns[2]: "generated" reads unknown column "name"`,
    );
  });

  it("names the table once when a base column clashes with a table's own column", async () => {
    const v = await planVault();
    // the goal's own `name` is required: a base `name` would redefine it
    await refused(
      defineBase(v.app, v.settings, describedBase({ name: "leveled", columns: [{ name: "level", type: "enum", values: LEVELS }, PARENT, { name: "name", type: "string" }] })),
      OperationInputError,
      `main.plan.goal: column "name" is inherited from base "leveled"; change the base (a table may only change label, description, aliases, note, dense)`,
    );
  });
});

describe("set_table_bases", () => {
  it("refuses a base that does not exist", async () => {
    const v = await planVault();
    await refused(setTableBases(v.app, v.settings, { table: "note", bases: ["leveled", "timed"] }), OperationInputError, `unknown base "timed"`);
  });

  it("fills the inherited dense columns on every row: the default, else empty", async () => {
    const v = await planVault();
    const tracked = await defineBase(v.app, v.settings, describedBase({
      name: "tracked",
      columns: [
        { name: "status", type: "enum", values: ["active", "paused"], default: "active", dense: true },
        { name: "reviewed", type: "boolean", dense: true },
      ],
    }));
    expect(tracked.ok).toBe(true);
    const r = await setTableBases(v.app, v.settings, { table: "goal", bases: ["leveled", "tracked"] });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    expect(r.planned_edits.find((p) => p.path === `${G}/Home.md`)!.set).toEqual({ status: "active", reviewed: null });
    expect(fm(v, `${G}/Paint.md`)).toMatchObject({ status: "active", reviewed: null });
  });
});

describe("define_base", () => {
  it("takes columns in the file's words, the operations' own; a required column refuses rows without it", async () => {
    const v = await planVault();
    const r = await defineBase(v.app, v.settings, {
      name: "described",
      description: "What a note found somewhere says",
      columns: [
        { name: "summary", type: "string", description: "One line", required: true },
        { name: "source", type: "string", description: "Where it was found" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(model(v).bases.described).toEqual({
      description: "What a note found somewhere says",
      columns: [
        { name: "summary", type: "string", required: true, description: "One line" },
        { name: "source", type: "string", description: "Where it was found" },
      ],
    });
    const inherit = await setTableBases(v.app, v.settings, { table: "note", bases: ["described"] });
    expect(inherit.ok).toBe(false);
    expect(inherit.violations.map((x) => [x.path, x.violations.map((y) => [y.column, y.code])])).toEqual([["Datanotes/main/plan/note/Ideas.md", [["summary", "required"]]]]);
  });

  it("a renamed base column is followed by its own link filters, the inheriting tables' CHECKs and the ref_by of tables linking to them", async () => {
    const v = await planVault();
    // a table with the same words that does not inherit the base: left alone
    const own = await createTable(v.app, v.settings, described({
      schema: "plan",
      name: "milestone",
      options: { filename: "{name}" },
      columns: [
        { name: "name", type: "string", required: true, dense: true },
        { name: "level", type: "enum", values: LEVELS },
        { name: "parent", type: "link", ref: "self", ref_by: { column: "level", levels: LEVELS } },
      ],
    }));
    expect(own.ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "milestone", values: { name: "Launch", level: "area" } })).ok).toBe(true);
    const milestone = table(v, "milestone");
    // a column given without a description keeps the base's, a renamed one its old name's
    const r = await defineBase(v.app, v.settings, {
      name: "leveled",
      columns: [{ name: "tier", type: "enum", values: LEVELS }, PARENT],
      renameColumns: { level: "tier" },
    });
    expect(r.ok, JSON.stringify([r.conflicts, r.violations])).toBe(true);
    expect(table(v, "milestone")).toEqual(milestone);
    expect(fm(v, "Datanotes/main/plan/milestone/Launch.md")).toMatchObject({ level: "area" });
    expect(model(v).bases.leveled!.columns).toEqual([
      { name: "tier", type: "enum", values: LEVELS, description: "Test column level" },
      { name: "parent", type: "link", ref: "self", ref_where: { tier: { ne: "task" } }, ref_by: { column: "tier", levels: LEVELS }, description: "Test column parent" },
    ]);
    expect(table(v, "goal").constraints).toEqual({ has_level: { tier: { exists: true } } });
    expect(table(v, "note").columns.find((c) => c.name === "about")!.ref_by).toEqual({ column: "scope", target_column: "tier", map: { area: ["area"], project: ["project"], task: ["task"] } });
    expect(fm(v, `${G}/Site.md`)).toMatchObject({ name: "Site", tier: "project", parent: ref("Home") });
    expect(fm(v, `${G}/Site.md`)).not.toHaveProperty("level");
    expect((await checkTable(v.app, v.settings, {})).violations).toEqual([]);
    // the rules still hold: a task cannot be a parent
    const bad = await insertRow(v.app, v.settings, { table: "goal", values: { name: "Trim", tier: "task", parent: ref("Paint") } });
    expect(bad.violations.map((x) => x.violations.map((y) => [y.column, y.code]))).toEqual([[["parent", "ref"]]]);
  });

  it("a renamed base column is followed past a self link in the base's own dotted ref_where, also through the heirs' shared links", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    const parent = {
      name: "parent",
      type: "link",
      ref: "self",
      // the parent's parent, and the row the parent's `up` names (a link both heirs make to themselves)
      ref_where: { level: { ne: "task" }, "parent.level": { ne: "task" }, or: [{ "up.level": { ne: "task" } }, { "owner.level": "x" }] },
    };
    expect((await defineBase(v.app, v.settings, describedBase({ name: "leveled", columns: [{ name: "level", type: "enum", values: LEVELS }, parent] }))).ok).toBe(true);
    expect((await createTable(v.app, v.settings, described({ schema: "plan", name: "person", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }] }))).ok).toBe(true);
    for (const [name, owner] of [["goal", "main.plan.person"], ["epic", "self"]] as const) {
      const t = await createTable(v.app, v.settings, described({
        schema: "plan",
        name,
        options: { filename: "{name}" },
        columns: [
          { name: "name", type: "string" },
          { name: "up", type: "link", ref: "self" },
          // linked differently by the two heirs: the walk ends there
          { name: "owner", type: "link", ref: owner },
        ],
      }));
      expect(t.ok).toBe(true);
      expect((await setTableBases(v.app, v.settings, { table: name, bases: ["leveled"] })).ok).toBe(true);
    }
    const r = await defineBase(v.app, v.settings, describedBase({
      name: "leveled",
      columns: [{ name: "tier", type: "enum", values: LEVELS }, parent],
      renameColumns: { level: "tier" },
    }));
    expect(r.ok, JSON.stringify([r.conflicts, r.violations])).toBe(true);
    expect(model(v).bases.leveled!.columns[1]!.ref_where).toEqual({
      tier: { ne: "task" },
      "parent.tier": { ne: "task" },
      or: [{ "up.tier": { ne: "task" } }, { "owner.level": "x" }],
    });
  });
});

describe("define_base renames past a link to another table", () => {
  it("a dotted ref_where of a base column linking to another table reads that table's columns", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    expect((await createTable(v.app, v.settings, described({ schema: "plan", name: "person", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }, { name: "mentor", type: "link", ref: "self" }] }))).ok).toBe(true);
    const lead = { name: "lead", type: "link", ref: "main.plan.person", ref_where: { "mentor.name": { ne: "Nobody" } } };
    expect((await defineBase(v.app, v.settings, describedBase({ name: "staffed", columns: [{ name: "level", type: "enum", values: LEVELS }, lead] }))).ok).toBe(true);
    const r = await defineBase(v.app, v.settings, describedBase({ name: "staffed", columns: [{ name: "tier", type: "enum", values: LEVELS }, lead], renameColumns: { level: "tier" } }));
    expect(r.ok, JSON.stringify([r.conflicts, r.violations])).toBe(true);
    expect(model(v).bases.staffed!.columns[1]!.ref_where).toEqual({ "mentor.name": { ne: "Nobody" } });
  });
});
