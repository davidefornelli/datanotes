import { describe, expect, it } from "vitest";
import { addConstraint, createView } from "../src/core/catalog-ops";
import { columnAliases, resolveNameList, resolveValueKeys } from "../src/core/column-aliases";
import { INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { adoptRows, moveRows } from "../src/core/move-rows";
import { deleteRows, insertRow, mergeRows, updateRow, updateRows } from "../src/core/row-ops";
import { select } from "../src/core/select";
import { DOCS_BASE, DOCS, type GuidedError } from "../src/core/hints";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/**
 * task: `title` has the aliases name, nome, titolo and a label; `priority` and `estimate` both
 * declare `rank` (ambiguous); `notes` declares `title`, a real name (never redirects).
 */
const YAML = `catalogs:
  main:
    schemas:
      public:
        tables:
          project:
            options: { filename: "{name}" }
            columns:
              - ${ID}
              - { name: name, type: string, required: true, dense: true }
              - { name: area, type: string, aliases: [zone] }
          person:
            options: { filename: "{name}" }
            columns:
              - ${ID}
              - { name: name, type: string, required: true, dense: true }
              - { name: email, type: string, aliases: [mail] }
          task:
            options: { filename: "{title}" }
            columns:
              - ${ID}
              - { name: title, type: string, required: true, dense: true, label: Task title, aliases: [name, nome, titolo] }
              - { name: priority, type: integer, aliases: [prio, rank] }
              - { name: estimate, type: integer, aliases: [rank, effort] }
              - { name: owner, type: string, aliases: [assignee] }
              - { name: project, type: link, ref: main.public.project, aliases: [proj] }
              - { name: notes, type: string, aliases: [title, memo] }
          archive:
            options: { filename: "{title}" }
            columns:
              - ${ID}
              - { name: title, type: string, required: true, dense: true, aliases: [heading] }
              - { name: priority, type: integer, aliases: [prio] }
              - { name: assigned_to, type: string, aliases: [who] }
`;

const uuid = (n: number) => `01a0f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const row = (table: string, n: number, extra: string) => `---\ntable: main.public.${table}\nid: ${uuid(n)}\n${extra}---\n`;

function vault(): DbVault {
  return createDbVault({
    [METASTORE]: YAML,
    "Projects/House.md": row("project", 1, "name: House\narea: Home\n"),
    "Projects/Launch.md": row("project", 2, "name: Launch\narea: Work\n"),
    "People/Ada.md": row("person", 3, "name: Ada\nemail: ada@example.org\n"),
    "Tasks/Paint.md": row("task", 4, 'title: Paint\npriority: 2\nowner: Ada\nproject: "[[House]]"\nnotes: walls\n'),
    "Tasks/Ship.md": row("task", 5, 'title: Ship\npriority: 1\nproject: "[[Launch]]"\n'),
    "Tasks/Plan.md": row("task", 6, 'title: Plan\npriority: 2\nproject: "[[Launch]]"\n'),
    "Notes/Loose.md": "---\ntitle: Loose\npriority: 3\n---\n",
  });
}

async function refused(p: Promise<unknown>, message: string): Promise<GuidedError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(OperationInputError);
  expect((e as Error).message).toBe(message);
  return e as GuidedError;
}

const titles = (rows: Record<string, unknown>[]) => rows.map((r) => r.title);

describe("reads take a column's aliases", () => {
  it("columns: an alias returns the column under its real name", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "task", columns: ["name", "prio"], orderBy: "name" });
    expect(r.rows).toEqual([
      { path: "Tasks/Paint.md", title: "Paint", priority: 2 },
      { path: "Tasks/Plan.md", title: "Plan", priority: 2 },
      { path: "Tasks/Ship.md", title: "Ship", priority: 1 },
    ]);
  });

  it("a column and its alias in columns give the column once", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "task", columns: ["title", "nome", "titolo"], where: { title: "Ship" } });
    expect(r.rows).toEqual([{ path: "Tasks/Ship.md", title: "Ship" }]);
  });

  it("where, nested and/or/not, and order_by take aliases", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, {
      table: "task",
      columns: ["title"],
      where: { or: [{ nome: "Ship" }, { and: [{ prio: { gte: 2 } }, { not: { assignee: "Ada" } }] }] },
      orderBy: ["-prio", "titolo"],
    });
    expect(titles(r.rows)).toEqual(["Plan", "Ship"]);
  });

  it("a real name wins over another column's alias: title is the title, never notes", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "task", columns: ["title", "memo"], where: { title: "Paint" } });
    expect(r.rows).toEqual([{ path: "Tasks/Paint.md", title: "Paint", notes: "walls" }]);
  });

  it("a dotted key follows a link named by its alias, to a column named by its alias", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "task", columns: ["title"], where: { "proj.zone": "Work", nome: { ne: "Plan" } } });
    expect(titles(r.rows)).toEqual(["Ship"]);
  });

  it("a dotted key and a condition on the same link, by name and by alias, both apply", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "task", columns: ["title"], where: { project: { exists: true }, "proj.area": "Home" } });
    expect(titles(r.rows)).toEqual(["Paint"]);
  });

  it("expand takes an alias", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "task", columns: ["name", "proj"], expand: ["proj"], where: { name: "Paint" } });
    expect(r.rows[0]!.project).toMatchObject({ path: "Projects/House.md", name: "House", area: "Home" });
  });

  it("group_by and aggregates take aliases; the groups are keyed by the real name", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "task", groupBy: "prio", aggregates: { n: "count", most: "max:prio" }, orderBy: "-prio" });
    expect(r.rows).toEqual([
      { priority: 2, n: 2, most: 2 },
      { priority: 1, n: 1, most: 1 },
    ]);
  });

  it("an alias inside an expression reads its column; the expression keeps its text", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "task", groupBy: "date(name)", aggregates: { n: "count" } });
    expect(r.rows).toEqual([{ "date(name)": null, n: 3 }]);
  });

  it("join: on, columns, where and aggregates of the joined table take its aliases", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, {
      table: "task",
      columns: ["name"],
      join: { table: "person", on: { assignee: "name" }, columns: ["mail"], where: { mail: { contains: "@" } } },
    });
    expect(r.rows).toEqual([{ path: "Tasks/Paint.md", title: "Paint", person: [{ path: "People/Ada.md", email: "ada@example.org" }] }]);
    const g = await select(v.app, v.settings, {
      table: "task",
      join: { table: "person", on: { assignee: "name" } },
      groupBy: "assignee",
      aggregates: { mails: "count:person.mail" },
    });
    expect(g.rows).toEqual([{ owner: "Ada", mails: 1 }]);
  });

  it("a view's stored query takes aliases", async () => {
    const v = vault();
    expect((await createView(v.app, v.settings, { name: "vw_urgent", description: "Urgent tasks", query: { table: "task", columns: ["name"], where: { prio: 1 } } })).ok).toBe(true);
    const r = await select(v.app, v.settings, { table: "vw_urgent", where: { titolo: { ne: "x" } } });
    expect(r.rows).toEqual([{ path: "Tasks/Ship.md", title: "Ship" }]);
  });
});

describe("refusals", () => {
  it("an alias two columns declare is ambiguous: the error names them, with hint and docs", async () => {
    const v = vault();
    const e = await refused(select(v.app, v.settings, { table: "task", where: { rank: 1 } }), `"rank" is an alias of several columns of main.public.task: "priority", "estimate"`);
    expect(e.hint).toBe(`Name the column itself: "priority" or "estimate". alter_column changes a column's aliases; describe_table("main.public.task") lists them.`);
    expect(e.docs).toBe(`${DOCS_BASE}${DOCS.columnAliases}`);
    await refused(select(v.app, v.settings, { table: "task", columns: ["rank"] }), `"rank" is an alias of several columns of main.public.task: "priority", "estimate"`);
    await refused(insertRow(v.app, v.settings, { table: "task", values: { title: "X", rank: 1 } }), `"rank" is an alias of several columns of main.public.task: "priority", "estimate"`);
  });

  it("an unknown column's hint prefers the column whose alias or label matches, before a near spelling", async () => {
    const v = vault();
    const e = await refused(select(v.app, v.settings, { table: "task", columns: ["Name"] }), `unknown column: "Name"`);
    expect(e.hint).toMatch(/^Did you mean "title"\?/);
    const l = await refused(select(v.app, v.settings, { table: "task", where: { "task title": "Paint" } }), `unknown column in where: "task title"`);
    expect(l.hint).toMatch(/^Did you mean "title"\?/);
    const w = await refused(insertRow(v.app, v.settings, { table: "task", values: { title: "X", Assignee: "Ada" } }), `unknown column "Assignee" for table "task"`);
    expect(w.hint).toMatch(/^Did you mean "owner"\?/);
  });

  it("a write naming a column twice, by its name and an alias, is refused", async () => {
    const v = vault();
    const e = await refused(insertRow(v.app, v.settings, { table: "task", values: { title: "A", name: "B" } }), `values names column "title" twice: as "title" and as "name"`);
    expect(e.hint).toBe(`"title" and "name" both mean the column "title" (an alias stands for its column): keep one of the two keys.`);
    expect(e.docs).toBe(`${DOCS_BASE}${DOCS.columnAliases}`);
    await refused(updateRows(v.app, v.settings, { table: "task", where: { name: "Paint" }, set: { nome: "A", titolo: "B" } }), `set names column "title" twice: as "nome" and as "titolo"`);
  });

  it("a CHECK names real columns only: an alias in it is an unknown column", async () => {
    const v = vault();
    await expect(addConstraint(v.app, v.settings, { table: "task", name: "prio_positive", check: { prio: { gte: 0 } } })).rejects.toThrow(`unknown column in where: "prio"`);
    expect((await addConstraint(v.app, v.settings, { table: "task", name: "prio_positive", check: { priority: { gte: 0 } } })).ok).toBe(true);
  });
});

describe("writes take a column's aliases", () => {
  it("insert_row values", async () => {
    const v = vault();
    const r = await insertRow(v.app, v.settings, { table: "task", values: { nome: "Wash", prio: 3, assignee: "Ada" } });
    expect(r.ok).toBe(true);
    expect(v.read(r.planned_creates[0]!)).toMatch(/title: Wash\npriority: 3\nowner: Ada\n/);
  });

  it("update_rows where, set and unset; update_row set, unset and expect", async () => {
    const v = vault();
    expect((await updateRows(v.app, v.settings, { table: "task", where: { proj: "[[Launch]]" }, set: { prio: 9 }, unset: ["assignee", "owner"] })).ok).toBe(true);
    let r = await select(v.app, v.settings, { table: "task", columns: ["name", "prio"], where: { prio: 9 }, orderBy: "name" });
    expect(titles(r.rows)).toEqual(["Plan", "Ship"]);
    expect((await updateRow(v.app, v.settings, { table: "task", path: "Tasks/Paint.md", set: { prio: 7 }, unset: ["assignee"], expect: { nome: "Paint" } })).ok).toBe(true);
    r = await select(v.app, v.settings, { table: "task", columns: ["priority", "owner"], where: { title: "Paint" } });
    expect(r.rows).toEqual([{ path: "Tasks/Paint.md", priority: 7, owner: null }]);
    const stale = await updateRow(v.app, v.settings, { table: "task", path: "Tasks/Paint.md", set: { prio: 1 }, expect: { prio: 2 } });
    expect(stale.conflicts).toEqual([{ path: "Tasks/Paint.md", message: "row changed: expected prio = 2, found 7 — read it again" }]);
  });

  it("merge_rows on and rows", async () => {
    const v = vault();
    const r = await mergeRows(v.app, v.settings, { table: "task", on: ["name"], rows: [{ nome: "Paint", prio: 5 }, { name: "Fresh", effort: 2 }] });
    expect(r.ok).toBe(true);
    const s = await select(v.app, v.settings, { table: "task", columns: ["title", "priority", "estimate"], where: { title: { in: ["Paint", "Fresh"] } }, orderBy: "title" });
    expect(s.rows).toEqual([
      { path: "Datanotes/main/public/task/Fresh.md", title: "Fresh", priority: null, estimate: 2 },
      { path: "Tasks/Paint.md", title: "Paint", priority: 5, estimate: null },
    ]);
  });

  it("merge_rows refuses an unknown key column with the alias-aware hint", async () => {
    const v = vault();
    const e = await refused(mergeRows(v.app, v.settings, { table: "task", on: ["Titolo"], rows: [{ title: "x" }] }), `unknown key column "Titolo"`);
    expect(e.hint).toMatch(/^Did you mean "title"\?/);
    const m = await refused(mergeRows(v.app, v.settings, { table: "task", on: ["name"], rows: [{ name: "Paint", Memo: "x" }] }), `unknown column "Memo" for table "task"`);
    expect(m.hint).toMatch(/^Did you mean "notes"\?/);
  });

  it("delete_rows where", async () => {
    const v = vault();
    expect((await deleteRows(v.app, v.settings, { table: "task", where: { nome: "Plan" }, mode: "delete" })).ok).toBe(true);
    expect(v.exists("Tasks/Plan.md")).toBe(false);
  });

  it("move_rows: set and rename targets by the destination's aliases, rename keys and drop by the source's", async () => {
    const v = vault();
    const r = await moveRows(v.app, v.settings, { table: "task", where: { name: "Paint" }, toTable: "archive", rename: { assignee: "who" }, set: { heading: "Painted" }, drop: ["proj", "memo"] });
    expect({ conflicts: r.conflicts, violations: r.violations }).toEqual({ conflicts: [], violations: [] });
    const s = await select(v.app, v.settings, { table: "archive", columns: ["title", "priority", "who"] });
    expect(s.rows).toEqual([{ path: "Tasks/Paint.md", title: "Painted", priority: 2, assigned_to: "Ada" }]);
  });

  it("adopt_rows: set and per_row take the destination's aliases", async () => {
    const v = vault();
    const r = await adoptRows(v.app, v.settings, { table: "archive", paths: ["Notes/Loose.md"], set: { prio: 4 }, perRow: { "Notes/Loose": { heading: "Adopted" } }, relocate: false });
    expect(r.ok).toBe(true);
    const s = await select(v.app, v.settings, { table: "archive", columns: ["heading", "prio"] });
    expect(s.rows).toEqual([{ path: "Notes/Loose.md", title: "Adopted", priority: 4 }]);
  });
});

describe("columnAliases", () => {
  const spec = (name: string, aliases: string[], label?: string) => ({ name, type: "string" as const, required: false, aliases, ...(label ? { label } : {}) });
  const a = columnAliases([spec("title", ["name", "name"], "Title"), spec("notes", ["title"]), spec("a", ["x"]), spec("b", ["x"]), spec("c", ["x"])], new Set(["title", "notes", "a", "b", "c"]), "t");

  it("resolves an alias, keeps a real or unknown name, and lists the words of the hints", () => {
    expect(a.resolve("name")).toBe("title");
    expect(a.resolve("title")).toBe("title");
    expect(a.resolve("other")).toBe("other");
    expect(a.words).toEqual([["name", "title"], ["name", "title"], ["Title", "title"], ["title", "notes"], ["x", "a"], ["x", "b"], ["x", "c"]]);
  });

  it("an alias of three columns names them all", () => {
    expect(() => a.resolve("x")).toThrow(`"x" is an alias of several columns of t: "a", "b", "c"`);
  });

  it("resolveValueKeys and resolveNameList", () => {
    expect(resolveValueKeys({ name: 1, notes: 2 }, a, "values")).toEqual({ title: 1, notes: 2 });
    expect(resolveNameList(["name", "title", "notes"], a)).toEqual(["title", "notes"]);
  });
});
