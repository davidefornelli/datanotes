import { describe, expect, it, vi } from "vitest";
import { addConstraint, createView } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { resolveDateToken } from "../src/core/datetime";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { checkTable, insertRow, select } from "../src/core/rows";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;
const P = "Datanotes/main/public/project";

async function projects(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  await createTable(v.app, v.settings, described({
    name: "project", options: { filename: "{name}" },
    columns: [{ name: "name", type: "string" }, { name: "status", type: "enum", values: ["ongoing", "closed"] }, { name: "due", type: "date" }],
  }));
  await insertRow(v.app, v.settings, { table: "project", values: { name: "Alpha", status: "ongoing", due: "2026-09-20" } });
  await insertRow(v.app, v.settings, { table: "project", values: { name: "Beta | 2", status: "closed", due: "2026-10-10" } });
  await insertRow(v.app, v.settings, { table: "project", values: { name: "Gamma", status: "ongoing" } });
  return v;
}

describe("relative dates", () => {
  const now = new Date("2026-09-29T22:30:00Z"); // 00:30 on the 30th in Rome
  it("resolve in the database time zone", () => {
    expect(resolveDateToken("{today}", "Europe/Rome", now)).toBe("2026-09-30");
    expect(resolveDateToken("{today-7d}", "Europe/Rome", now)).toBe("2026-09-23");
    expect(resolveDateToken("{today+1w}", "Europe/Rome", now)).toBe("2026-10-07");
    expect(resolveDateToken("{now-2h}", "Europe/Rome", now)).toBe("2026-09-29T22:30:00+02:00");
    expect(resolveDateToken("{tomorrow}", "Europe/Rome", now)).toBe("{tomorrow}");
    expect(resolveDateToken(3, "Europe/Rome", now)).toBe(3);
  });
  it("work in where", async () => {
    const v = await projects();
    const r = await select(v.app, v.settings, { table: "project", where: { due: { lt: "{today+400d}", gte: "2026-09-21" } }, columns: ["name"] });
    expect(r.rows.map((x) => x.name)).toEqual(["Beta | 2"]);
  });
  it("a date-time against a date column counts by its calendar date: {now-7d} as {today-7d}", async () => {
    const v = await projects();
    const names = async (due: Record<string, unknown>) => (await select(v.app, v.settings, { table: "project", where: { due }, columns: ["name"] })).rows.map((x) => x.name);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-12T08:00:00Z") });
    try {
      expect(await names({ gte: "{now-7d}" })).toEqual(["Beta | 2"]);
      expect(await names({ gte: "{now-7d}" })).toEqual(await names({ gte: "{today-7d}" }));
      expect(await names({ lt: "{now-24h}" })).toEqual(["Alpha", "Beta | 2"]);
    } finally {
      vi.useRealTimers();
    }
    // the day as written: 2026-10-10 is not before a date-time of that same day
    expect(await names({ lt: "2026-10-10T08:00:00+02:00" })).toEqual(["Alpha"]);
    expect(await names({ gte: "2026-09-20T23:59:00+02:00" })).toEqual(["Alpha", "Beta | 2"]);
  });
});

describe("file columns", () => {
  it("file_name, file_link and file_modified can be selected, filtered and sorted", async () => {
    const v = await projects();
    const r = await select(v.app, v.settings, { table: "project", columns: ["file_name", "file_link", "file_modified"], where: { file_name: "Alpha" } });
    expect(r.rows[0]).toMatchObject({ file_name: "Alpha", file_link: `[[${P}/Alpha|Alpha]]` });
    expect(String(r.rows[0]!.file_modified)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const g = await select(v.app, v.settings, { table: "project", groupBy: "status", aggregates: { n: "count" } });
    expect(g.rows).toEqual([{ status: "closed", n: 1 }, { status: "ongoing", n: 2 }]);
    await expect(insertRow(v.app, v.settings, { table: "project", values: { name: "X", file_name: "y" } })).rejects.toThrow(/unknown column/);
  });
});

describe("views", () => {
  it("keep aliases and labels, are listed, and narrow with the caller's where", async () => {
    const v = await projects();
    const c = await createView(v.app, v.settings, {
      name: "active_projects", description: "Ongoing projects", aliases: ["active projects"], labels: { name: "Project" },
      query: { table: "project", where: { status: "ongoing" }, columns: ["name", "due"], order_by: "name" },
    });
    expect(c.ok).toBe(true);
    const info = await select(v.app, v.settings, { table: "system.information_schema.views", columns: ["table_name", "aliases", "labels"] });
    expect(info.rows[0]).toMatchObject({ table_name: "active_projects", aliases: ["active projects"], labels: JSON.stringify({ name: "Project" }) });
    const r = await select(v.app, v.settings, { table: "active_projects", where: { due: { exists: true } } });
    expect(r.rows.map((x) => x.name)).toEqual(["Alpha"]);
  });
});

describe("or / and / not", () => {
  it("combine conditions, nest, and work in views, constraints and updates", async () => {
    const v = await projects();
    const names = async (where: Record<string, unknown>) =>
      (await select(v.app, v.settings, { table: "project", where, columns: ["name"], orderBy: "name" })).rows.map((r) => r.name);
    expect(await names({ or: [{ status: "closed" }, { due: { exists: false } }] })).toEqual(["Beta | 2", "Gamma"]);
    expect(await names({ not: { status: "ongoing" } })).toEqual(["Beta | 2"]);
    expect(await names({ status: "ongoing", not: { or: [{ due: { exists: false } }, { name: "Beta | 2" }] } })).toEqual(["Alpha"]);
    expect(await names({ and: [{ status: "ongoing" }, { due: { exists: true } }] })).toEqual(["Alpha"]);
    await expect(names({ or: [] })).rejects.toThrow(/non-empty list/);
    await expect(names({ or: { status: "x" } })).rejects.toThrow(/non-empty list/);
    await expect(names({ not: [{ status: "x" }] })).rejects.toThrow(/where object/);
    await expect(names({ or: [{ nope: 1 }] })).rejects.toThrow(/unknown column/);

    await createView(v.app, v.settings, { name: "gaps", query: { table: "project", where: { or: [{ due: { exists: false } }, { status: "closed" }] }, columns: ["name"] } });
    const narrowed = await select(v.app, v.settings, { table: "gaps", where: { status: "ongoing" } });
    expect(narrowed.rows.map((r) => r.name)).toEqual(["Gamma"]);

    // CHECK: a closed project needs a due date
    expect((await addConstraint(v.app, v.settings, { table: "project", name: "closed_has_due", check: { or: [{ status: "ongoing" }, { due: { exists: true } }] } })).ok).toBe(true);
    const bad = await insertRow(v.app, v.settings, { table: "project", values: { name: "Delta", status: "closed" } });
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]!.violations[0]!.code).toBe("check");
  });
});

describe("json columns", () => {
  it("store any YAML value (lists of objects) without validation", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({
      name: "task", options: { filename: "{t}" },
      columns: [{ name: "t", type: "string" }, { name: "reminders", type: "json" }, { name: "blocked_by", type: "list", items: "json" }],
    }));
    const r = await insertRow(v.app, v.settings, { table: "task", values: { t: "a", reminders: [{ type: "relative", offset: "-PT30M" }], blocked_by: [{ uid: "x.md", reltype: "FINISHTOSTART" }] } });
    expect(r.ok).toBe(true);
    const s = await select(v.app, v.settings, { table: "task", columns: ["reminders", "blocked_by"] });
    expect(s.rows[0]).toMatchObject({ reminders: [{ type: "relative", offset: "-PT30M" }], blocked_by: [{ uid: "x.md", reltype: "FINISHTOSTART" }] });
  });
});

describe("vocabulary columns", () => {
  it("accept only the names of the vocabulary table's rows", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ name: "tag", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true, unique: true }] }));
    for (const name of ["household", "kin"]) await insertRow(v.app, v.settings, { table: "tag", values: { name } });
    await expect(createTable(v.app, v.settings, described({ name: "bad", options: { filename: "{t}" }, columns: [{ name: "t", type: "string" }, { name: "tags", type: "list", items: "string", vocabulary: "tag" }] }))).rejects.toThrow(/full table name/);
    await expect(createTable(v.app, v.settings, described({ name: "bad2", options: { filename: "{t}" }, columns: [{ name: "t", type: "integer", vocabulary: "main.public.tag" }] }))).rejects.toThrow(/string/);
    await createTable(v.app, v.settings, described({ name: "task", options: { filename: "{t}" }, columns: [{ name: "t", type: "string" }, { name: "tags", type: "list", items: "string", vocabulary: "main.public.tag" }] }));
    expect((await insertRow(v.app, v.settings, { table: "task", values: { t: "ok", tags: ["household"] } })).ok).toBe(true);
    const bad = await insertRow(v.app, v.settings, { table: "task", values: { t: "ko", tags: ["household", "family"] } });
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]!.violations[0]).toMatchObject({ code: "vocabulary", column: "tags", index: 1 });
    expect(bad.violations[0]!.violations[0]!.message).toContain("household, kin");
    await insertRow(v.app, v.settings, { table: "tag", values: { name: "family" } });  // add it to the vocabulary: now accepted
    expect((await insertRow(v.app, v.settings, { table: "task", values: { t: "ko", tags: ["family"] } })).ok).toBe(true);
    v.write("Datanotes/main/public/task/manual.md", "---\ntable: main.public.task\nt: manual\ntags: [nope]\n---\n");
    const check = await checkTable(v.app, v.settings, { table: "task" });
    expect(check.violations.flatMap((x) => x.violations.map((y) => y.code))).toContain("vocabulary");
  });
});

describe("union views", () => {
  async function twoTables(): Promise<DbVault> {
    const v = await projects();
    await createTable(v.app, v.settings, described({
      name: "idea", options: { filename: "{name}" },
      columns: [{ name: "name", type: "string" }, { name: "status", type: "enum", values: ["ongoing", "closed"] }, { name: "due", type: "date" }],
    }));
    await insertRow(v.app, v.settings, { table: "idea", values: { name: "Delta", status: "ongoing", due: "2026-09-25" } });
    await insertRow(v.app, v.settings, { table: "idea", values: { name: "Epsilon", status: "closed" } });
    return v;
  }

  it("combine tables, tag rows with _source, sort, page and narrow", async () => {
    const v = await twoTables();
    const c = await createView(v.app, v.settings, {
      name: "everything_active",
      query: { union: [{ table: "project", where: { status: "ongoing" } }, { table: "idea" }], columns: ["name", "due"], order_by: "due" },
    });
    expect(c.ok).toBe(true);
    const r = await select(v.app, v.settings, { table: "everything_active" });
    expect(r.rows.map((x) => [x.name, x._source])).toEqual([
      ["Alpha", "project"], ["Delta", "idea"], ["Gamma", "project"], ["Epsilon", "idea"],
    ]);
    expect(r.total).toBe(4);
    // the caller's where applies inside every branch
    const n = await select(v.app, v.settings, { table: "everything_active", where: { due: { exists: true } }, limit: 1 });
    expect(n.total).toBe(2);
    expect(n.rows.map((x) => x.name)).toEqual(["Alpha"]);
    // _source may be asked for, like the view's own columns (the view's comment names it)
    const s = await select(v.app, v.settings, { table: "everything_active", columns: ["name", "_source"], limit: 1 });
    expect(s.rows).toEqual([{ path: expect.any(String), name: "Alpha", _source: "project" }]);
  });

  it("reject bad definitions", async () => {
    const v = await twoTables();
    await expect(createView(v.app, v.settings, { name: "x", query: { union: [{ table: "project" }] } })).rejects.toThrow(/two branches/);
    await expect(createView(v.app, v.settings, { name: "x", query: { table: "project", union: [{ table: "idea" }, { table: "project" }] } })).rejects.toThrow(/not both/);
    await expect(createView(v.app, v.settings, { name: "x", query: { union: [{ table: "idea", order_by: "name" }, { table: "project" }] } })).rejects.toThrow(/unknown: order_by/);
    await expect(createView(v.app, v.settings, { name: "x", query: { union: [{ table: "idea" }, { table: "project" }], group_by: "status" } })).rejects.toThrow(/does not support/);
  });
});

describe("aggregates on dates", () => {
  it("min and max return the earliest and latest date", async () => {
    const v = await projects();
    const r = await select(v.app, v.settings, { table: "project", groupBy: "status", aggregates: { first: "min:due", last: "max:due" } });
    expect(r.rows).toEqual([{ status: "closed", first: "2026-10-10", last: "2026-10-10" }, { status: "ongoing", first: "2026-09-20", last: "2026-09-20" }]);
  });
});

describe("where through a link", () => {
  it("\"projects.area\" follows the link and tests the linked rows (any of a list)", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    await createTable(v.app, v.settings, described({ name: "area", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }] }));
    await createTable(v.app, v.settings, described({ name: "proj", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }, { name: "area", type: "link", ref: "main.public.area" }] }));
    await createTable(v.app, v.settings, described({ name: "todo", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }, { name: "projects", type: "list", items: "link", ref: "main.public.proj" }] }));
    await insertRow(v.app, v.settings, { table: "area", values: { name: "Household" } });
    await insertRow(v.app, v.settings, { table: "area", values: { name: "Work" } });
    await insertRow(v.app, v.settings, { table: "proj", values: { name: "Bathroom", area: "[[Household]]" } });
    await insertRow(v.app, v.settings, { table: "proj", values: { name: "Report", area: "[[Work]]" } });
    await insertRow(v.app, v.settings, { table: "todo", values: { title: "Tiles", projects: ["[[Bathroom]]"] } });
    await insertRow(v.app, v.settings, { table: "todo", values: { title: "Slide", projects: ["[[Report]]", "[[Bathroom]]"] } });
    await insertRow(v.app, v.settings, { table: "todo", values: { title: "Mail", projects: ["[[Report]]"] } });
    const r = await select(v.app, v.settings, { table: "todo", where: { "projects.area": "[[Household]]" }, columns: ["title"], orderBy: "title" });
    expect(r.rows.map((x) => x.title)).toEqual(["Slide", "Tiles"]);
    const o = await select(v.app, v.settings, { table: "todo", where: { or: [{ "projects.area": "[[Work]]" }, { title: "Tiles" }] }, columns: ["title"], orderBy: "title" });
    expect(o.rows.map((x) => x.title)).toEqual(["Mail", "Slide", "Tiles"]);
    await expect(select(v.app, v.settings, { table: "todo", where: { "title.x": 1 } })).rejects.toThrow(/not a link column/);
  });
});
