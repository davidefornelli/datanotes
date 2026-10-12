/**
 * Reads on the test vault: the catalog and select_rows in all its forms (views, `{this.*}`, bases,
 * information_schema).
 */

import { expect } from "vitest";
import { person, pluck, project, task, type Rows, type Scenario } from "./harness";

const TASKS = [
  "Build the button component",
  "Choose the colour palette",
  "Export the old pages",
  "Find the new office",
  "Load the sales events",
  "Pick a query engine",
  "Redirect the old URLs",
  "Write the launch post",
];

export const scenarios: Scenario[] = [
  {
    name: "the catalog: tables, views, bases, comments and tags, also in information_schema",
    ops: ["list_tables", "describe_table", "describe_database", "select_rows", "check_table"],
    async run(t) {
      const listed = await t.ok<{ tables: Record<string, any>[]; views: Record<string, any>[] }>("list_tables");
      expect(listed.tables.map((x) => x.qualified)).toEqual(["work.planning.person", "work.planning.project", "work.planning.task"]);
      expect(listed.views.map((x) => x.name)).toEqual(["vw_engineering", "vw_open_tasks", "vw_project_tasks"]);
      expect(listed.tables.find((x) => x.name === "task")).toMatchObject({ aliases: ["tasks", "todo"], tags: { domain: "work" } });
      expect(listed.tables.find((x) => x.name === "project")!.tags).toEqual({ domain: "work", review: "weekly" });
      expect(listed.views.find((x) => x.name === "vw_open_tasks")!.aliases).toEqual(["open tasks", "what is left"]);

      const d = await t.ok<Record<string, any>>("describe_table", { table: "task" });
      // inherited columns come after id, before the table's own
      expect(d.columns.map((c: { name: string }) => c.name)).toEqual(["id", "started_on", "summary", "title", "project", "assignee", "status", "priority", "due", "done_on", "estimate_h"]);
      expect(d).toMatchObject({ qualified: "work.planning.task", row_count: 8, options: { filename: "{title}", archive: "_archive" }, tags: { domain: "work" } });
      // the whole definition: its bases and its CHECKs too
      expect(d.bases).toEqual(["dated"]);
      expect(Object.keys(d.constraints)).toEqual(["done_has_date", "not_on_an_area"]);
      expect(d.constraints.not_on_an_area).toEqual({ "project.kind": { in: ["project", "workstream"] } });
      const col = (name: string) => d.columns.find((c: { name: string }) => c.name === name);
      expect(col("status")).toMatchObject({ type: "enum", required: true, default: "todo", values: ["todo", "doing", "done"] });
      expect(col("priority")).toMatchObject({ ordered: true });
      expect(col("project")).toMatchObject({ type: "link", ref: "work.planning.project", required: true });
      expect(col("started_on")).toMatchObject({ description: "When the work began" });
      const people = await t.ok<Record<string, any>>("describe_table", { table: "work.planning.person" });
      expect(people.columns.find((c: { name: string }) => c.name === "role").value_descriptions).toEqual({ engineer: "builds the software", designer: "designs the product", manager: "plans the work" });
      expect(await t.refused("describe_table", { table: "meeting" })).toContain("meeting");

      const db = await t.ok<Record<string, any>>("describe_database");
      expect(db).toMatchObject({ root: "datanotes", metastore: "datanotes/metastore.yaml", config: { default_catalog: "work", default_schema: "planning", timezone: "Europe/Rome", history: true } });
      expect(db.catalogs).toHaveLength(1);
      expect(db.catalogs[0]).toMatchObject({ catalog: "work", description: "Work: projects, tasks and the people on them", default: true });
      const schema = db.catalogs[0].schemas[0];
      expect(schema.description).toBe("Areas, projects, workstreams and their tasks");
      expect(Object.fromEntries(schema.tables.map((x: { name: string; row_count: number }) => [x.name, x.row_count]))).toEqual({ person: 4, project: 8, task: 8 });
      expect(db.bases).toEqual([{ name: "dated", description: "Work that starts on a day", columns: ["started_on", "summary"], tables: ["work.planning.project", "work.planning.task"] }]);

      const is = (name: string, args: Record<string, unknown> = {}) => t.ok<Rows>("select_rows", { table: `system.information_schema.${name}`, ...args });
      expect((await is("catalogs")).rows).toMatchObject([{ catalog_name: "work", comment: "Work: projects, tasks and the people on them", is_default: true }]);
      expect((await is("schemata")).rows).toMatchObject([{ catalog_name: "work", schema_name: "planning" }]);
      const tables = await is("tables");
      expect(Object.fromEntries(tables.rows.map((r) => [r.table_name, r.table_type]))).toEqual({
        person: "TABLE",
        project: "TABLE",
        task: "TABLE",
        vw_engineering: "VIEW",
        vw_open_tasks: "VIEW",
        vw_project_tasks: "VIEW",
      });
      expect(tables.rows.find((r) => r.table_name === "project")).toMatchObject({ row_count: 8, tags: { domain: "work", review: "weekly" } });
      const columns = await is("columns", { where: { table_name: "task", inherited_from: "dated" } });
      expect(pluck(columns, "column_name")).toEqual(["started_on", "summary"]);
      expect(pluck(await is("check_constraints"), "constraint_name")).toEqual(["done_has_date", "not_on_an_area"]);
      const views = await is("views", { where: { table_name: "vw_project_tasks" } });
      expect(views.rows[0]!.view_definition).toContain("{this.link}");

      const all = await t.ok<{ tables_checked: number; rows_checked: number; violations: unknown[]; total: number }>("check_table", {});
      expect(all).toMatchObject({ tables_checked: 3, rows_checked: 20, total: 0, violations: [] });
      expect(await t.ok("check_table", { table: "project" })).toMatchObject({ rows_checked: 8, violations: [] });
    },
  },
  {
    name: "select_rows: filters through links and hierarchies, ordered enums, paging, expand, body, groups, joins, bases",
    ops: ["select_rows"],
    async run(t) {
      const sel = (args: Record<string, unknown>) => t.ok<Rows>("select_rows", args);
      // a dotted key follows the link: tasks whose project is a workstream
      expect(pluck(await sel({ table: "task", where: { "project.kind": "workstream" }, order_by: "title" }), "title")).toEqual([
        "Build the button component",
        "Choose the colour palette",
        "Export the old pages",
        "Load the sales events",
        "Redirect the old URLs",
      ]);
      // within: the row and everything below it in the tree
      expect(pluck(await sel({ table: "project", where: { parent: { within: "[[Website relaunch]]" } }, order_by: "name" }), "name")).toEqual(["Content migration", "Design system"]);
      expect(pluck(await sel({ table: "task", where: { project: { within: "[[Engineering]]" }, status: { ne: "done" } }, order_by: "title" }), "title")).toEqual([
        "Build the button component",
        "Export the old pages",
        "Pick a query engine",
        "Redirect the old URLs",
        "Write the launch post",
      ]);
      // ordered enum: compared by position, sorted by position
      const urgent = await sel({ table: "task", where: { priority: { gte: "medium" } }, columns: ["title", "priority"], order_by: ["-priority", "title"] });
      expect(urgent.total).toBe(6);
      expect(pluck(urgent, "priority")).toEqual(["high", "high", "high", "medium", "medium", "medium"]);
      // or / not / in / exists / icontains, paths as a pseudo-column
      const mixed = await sel({
        table: "task",
        where: { or: [{ assignee: { exists: false } }, { and: [{ status: { in: ["doing"] } }, { not: { title: { icontains: "BUTTON" } } }] }] },
        order_by: "title",
      });
      expect(pluck(mixed, "title")).toEqual(["Pick a query engine", "Redirect the old URLs"]);
      expect((await sel({ table: "task", where: { path: task("Pick a query engine") } })).rows[0]!.status).toBe("doing");
      // paging keeps the total
      const page = await sel({ table: "task", columns: ["title"], order_by: "title", limit: 3, offset: 3 });
      expect(page.total).toBe(8);
      expect(pluck(page, "title")).toEqual(TASKS.slice(3, 6));
      // expand inlines the linked row; include_body adds the note text
      const expanded = await sel({ table: "task", where: { title: "Export the old pages" }, columns: ["title", "project"], expand: ["project"] });
      expect(expanded.rows[0]!.project).toMatchObject({ name: "Content migration", kind: "workstream", parent: "[[Website relaunch]]", path: project("Content migration") });
      const body = await sel({ table: "project", where: { name: "Website relaunch" }, columns: ["name"], include_body: true });
      expect(body.rows[0]!.body).toBe("## Goals\n\nA faster site on the new design system.\n\n## Risks\n\nThe old URLs must keep working.\n");
      // groups and aggregates
      const grouped = await sel({ table: "task", group_by: "status", aggregates: { n: "count", hours: "sum:estimate_h", longest: "max:estimate_h" } });
      expect(grouped.rows).toEqual([
        { status: "doing", n: 2, hours: 12, longest: 12 },
        { status: "done", n: 2, hours: 26, longest: 20 },
        { status: "todo", n: 4, hours: 8, longest: 8 },
      ]);
      // a list column counts once per item
      const members = await sel({ table: "project", group_by: "members", aggregates: { n: "count" }, where: { members: { exists: true } } });
      expect(Object.fromEntries(members.rows.map((r) => [r.members, r.n]))).toEqual({ "[[Ada Lovelace]]": 2, "[[Alan Turing]]": 2, "[[Edith Clarke]]": 2, "[[Grace Hopper]]": 2 });
      // join: the assignee's row next to each task
      const joined = await sel({ table: "task", where: { status: "doing" }, columns: ["title"], order_by: "title", join: { table: "person", on: { assignee: "file_link" }, as: "who", columns: ["name", "role"] } });
      expect(joined.rows.map((r) => [r.title, r.who.map((w: { name: string; role: string }) => `${w.name} (${w.role})`)])).toEqual([
        ["Build the button component", ["Edith Clarke (designer)"]],
        ["Pick a query engine", ["Alan Turing (engineer)"]],
      ]);
      // base:<name>: every table that extends it, on the base's columns, tagged with the source
      const dated = await sel({ table: "base:dated", where: { started_on: { exists: true } }, order_by: "started_on" });
      expect(dated.rows.map((r) => [r._source, r.started_on])).toEqual([
        ["work.planning.project", "2026-07-15"],
        ["work.planning.task", "2026-08-01"],
        ["work.planning.project", "2026-09-01"],
      ]);
      expect(await t.refused("select_rows", { table: "task", where: { nope: 1 } })).toBe('unknown column in where: "nope"');
      expect(await t.refused("select_rows", { table: "task", aggregates: { n: "median:estimate_h" } })).toBe('aggregate "n" must be count, count:col, sum:col, avg:col, min:col or max:col');
    },
  },
  {
    name: "views: stored selects narrowed by the caller, and {this.*} filled from the note they are shown on",
    ops: ["select_rows"],
    async run(t) {
      const open = await t.ok<Rows>("select_rows", { table: "vw_open_tasks" });
      expect(open.view).toBe("work.planning.vw_open_tasks");
      expect(pluck(open, "title")).toEqual(["Build the button component", "Export the old pages", "Pick a query engine", "Redirect the old URLs", "Write the launch post", "Find the new office"]);
      expect(Object.keys(open.rows[0]!)).toEqual(["path", "title", "project", "assignee", "priority", "due"]);
      const narrowed = await t.ok<Rows>("select_rows", { table: "vw_open_tasks", where: { priority: "high" }, columns: ["title"] });
      expect(pluck(narrowed, "title")).toEqual(["Build the button component", "Export the old pages"]);
      expect(pluck(await t.ok<Rows>("select_rows", { table: "vw_engineering" }), "name")).toEqual(["Content migration", "Data platform", "Design system", "Ingestion", "Website relaunch"]);
      // one view for every project note: its tasks and its workstreams' tasks
      const website = await t.ok<Rows>("select_rows", { table: "vw_project_tasks", this_note: project("Website relaunch") });
      expect(pluck(website, "title")).toEqual(["Build the button component", "Choose the colour palette", "Export the old pages", "Redirect the old URLs", "Write the launch post"]);
      const data = await t.ok<Rows>("select_rows", { table: "vw_project_tasks", this_note: project("Data platform"), where: { status: { ne: "done" } } });
      expect(pluck(data, "title")).toEqual(["Pick a query engine"]);
      // {this.*} in the caller's where, on a person's note
      const mine = await t.ok<Rows>("select_rows", { table: "task", where: { assignee: "{this.link}" }, this_note: person("Edith Clarke"), order_by: "title" });
      expect(pluck(mine, "title")).toEqual(["Build the button component", "Choose the colour palette"]);
      expect(await t.refused("select_rows", { table: "vw_project_tasks", this_note: "datanotes/nowhere.md" })).toContain("no note at");
    },
  },
  {
    name: "a view whose {this.link} has no note to fill it matches nothing",
    ops: ["select_rows"],
    async run(t) {
      const r = await t.ok<Rows>("select_rows", { table: "vw_project_tasks" });
      expect(r.total).toBe(0);
      // whatever the operator: a token no note fills matches no row
      expect((await t.ok<Rows>("select_rows", { table: "task", where: { assignee: { ne: "{this.link}" } } })).total).toBe(0);
    },
  },
];
