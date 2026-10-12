/**
 * Rules and shared definitions on the test vault: CHECK constraints (one following links), filtered
 * link targets (ref_where, ref_by), views, bases, comments and the database configuration.
 */

import { expect } from "vitest";
import { person, pluck, project, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

export const scenarios: Scenario[] = [
  {
    name: "constraints: refused while rows break them, a CHECK through a link enforced on writes to the linked row; drop; undo",
    ops: ["add_constraint", "drop_constraint", "undo_migration"],
    async run(t) {
      const before = t.files();
      const small = await t.refused("add_constraint", { table: "task", name: "small", check: { estimate_h: { lte: 10 } } });
      expect(small.split("\n").slice(1)).toEqual([`conflict ${task("Build the button component")}: violates CHECK small`, `conflict ${task("Load the sales events")}: violates CHECK small`]);
      // through a link: only engineers and designers do tasks (Grace is a manager)
      const staffed = await t.refused("add_constraint", { table: "task", name: "staffed", check: { "assignee.role": { in: ["engineer", "designer"] } } });
      expect(staffed.split("\n").slice(1)).toEqual([`conflict ${task("Find the new office")}: violates CHECK staffed`, `conflict ${task("Write the launch post")}: violates CHECK staffed`]);

      // an open task's project is not done
      const rule = { or: [{ status: "done" }, { "project.status": { ne: "done" } }] };
      const dry = await t.ok<WriteResult>("add_constraint", { table: "task", name: "open_on_live_project", check: rule, dry_run: true });
      expect(dry.dry_run).toBe(true);
      expect(t.files()).toEqual(before);
      const added = await t.ok<WriteResult>("add_constraint", { table: "task", name: "open_on_live_project", check: rule });
      expect(pluck(await t.ok<Rows>("select_rows", { table: "system.information_schema.check_constraints" }), "constraint_name")).toEqual(["done_has_date", "not_on_an_area", "open_on_live_project"]);
      // a write to the linked row re-checks the rows that link to it
      const closing = await t.refused("update_row", { table: "project", path: project("Data platform"), set: { status: "done" } });
      expect(closing).toContain(`invalid ${task("Pick a query engine")}: open_on_live_project violates CHECK open_on_live_project`);
      expect(closing).toContain("(after this change to [[Data platform]], a row it links to)");
      expect(await t.refused("insert_row", { table: "task", values: { title: "More ingestion", project: "[[Ingestion]]" } })).toContain("open_on_live_project");
      const doneTask = await t.ok<WriteResult>("insert_row", { table: "task", values: { title: "Archive the raw files", project: "[[Ingestion]]", status: "done", done_on: "2026-09-12" } });
      expect(await t.refused("drop_constraint", { table: "task", name: "nope" })).toContain("nope");
      const dropped = await t.ok<WriteResult>("drop_constraint", { table: "task", name: "open_on_live_project" });
      const closed = await t.ok<WriteResult>("update_row", { table: "project", path: project("Data platform"), set: { status: "done" } });
      await undoBackTo(t, before, added.migration_id, doneTask.migration_id, dropped.migration_id, closed.migration_id);
    },
  },
  {
    name: "filtered link targets: ref_where refused until the rows fit, ref_by as a map; list_link_targets follows; undo",
    ops: ["alter_column", "list_link_targets", "update_rows", "undo_migration"],
    async run(t) {
      const before = t.files();
      const onlyMakers = { ref_where: { role: { in: ["engineer", "designer"] } } };
      const refused = await t.refused("alter_column", { table: "task", column: "assignee", changes: onlyMakers });
      expect(refused).toContain(
        `invalid ${task("Find the new office")}: assignee [[Grace Hopper]] is not a valid assignee (needs ref_where {"role":{"in":["engineer","designer"]}}); valid: Ada Lovelace, Alan Turing, Edith Clarke`,
      );
      expect(refused).toContain(`invalid ${task("Write the launch post")}`);
      // Grace's tasks go to Ada first
      const handed = await t.ok<WriteResult>("update_rows", { table: "task", where: { assignee: "[[Grace Hopper]]" }, set: { assignee: "[[Ada Lovelace]]" }, expect_count: 2 });
      const filtered = await t.ok<WriteResult>("alter_column", { table: "task", column: "assignee", changes: onlyMakers });
      const options = await t.ok<{ rows: { name: string }[]; reason: string }>("list_link_targets", { table: "task", column: "assignee", values: { title: "New" } });
      expect(options.rows.map((r) => r.name)).toEqual(["Ada Lovelace", "Alan Turing", "Edith Clarke"]);
      const toGrace = await t.refused("insert_row", { table: "task", values: { title: "Budget", project: "[[Office move]]", assignee: "[[Grace Hopper]]" } });
      expect(toGrace).toContain("assignee [[Grace Hopper]] is not a valid assignee");
      // a row the filter reads cannot leave it while tasks link to it: Ada stays an engineer
      expect(await t.refused("update_row", { table: "person", path: person("Ada Lovelace"), set: { role: "manager" } })).toContain("is not a valid assignee");

      // ref_by as a map: a workstream may also sit under another workstream
      const map = { column: "kind", map: { area: null, project: ["area"], workstream: ["project", "workstream"] } };
      const nested = await t.ok<WriteResult>("alter_column", { table: "project", column: "parent", changes: { ref_by: map } });
      const forWs = await t.ok<{ rows: { name: string }[] }>("list_link_targets", { table: "project", column: "parent", values: { kind: "workstream" } });
      expect(forWs.rows.map((r) => r.name)).toEqual(["Content migration", "Data platform", "Design system", "Ingestion", "Office move", "Website relaunch"]);
      const sub = await t.ok<WriteResult>("insert_row", { table: "project", values: { name: "Icons", kind: "workstream", parent: "[[Design system]]" } });
      expect(pluck(await t.ok<Rows>("select_rows", { table: "vw_engineering", where: { kind: "workstream" } }), "name")).toContain("Icons");
      // the expanded map in describe_table
      const parent = (await t.ok<{ columns: Record<string, any>[] }>("describe_table", { table: "project" })).columns.find((c) => c.name === "parent");
      expect(parent!.ref_by).toMatchObject({ column: "kind", map: { area: null, project: ["area"], workstream: ["project", "workstream"] } });
      // a level the map allows as a target cannot be dropped from the enum
      expect(await t.refused("alter_column", { table: "project", column: "kind", changes: { values: ["area", "project"] } })).toContain("workstream");
      await undoBackTo(t, before, handed.migration_id, filtered.migration_id, nested.migration_id, sub.migration_id);
    },
  },
  {
    name: "views: create with labels and aliases, group, union, {this.*}; replace; refused when the query cannot run; drop; undo",
    ops: ["create_view", "drop_view", "select_rows", "undo_migration"],
    async run(t) {
      const before = t.files();
      const load = await t.ok<WriteResult>("create_view", {
        name: "vw_load",
        query: { table: "task", where: { status: { ne: "done" } }, group_by: "assignee", aggregates: { tasks: "count", hours: "sum:estimate_h" }, order_by: "-tasks" },
        description: "Open work per person",
        aliases: ["workload"],
        labels: { tasks: "Open tasks", hours: "Hours" },
      });
      const rows = (await t.ok<Rows>("select_rows", { table: "vw_load" })).rows;
      expect(rows[0]).toMatchObject({ assignee: "[[Grace Hopper]]", tasks: 2 });
      expect(Object.fromEntries(rows.map((r) => [String(r.assignee), r.tasks]))).toEqual({
        "[[Grace Hopper]]": 2,
        "[[Ada Lovelace]]": 1,
        "[[Alan Turing]]": 1,
        "[[Edith Clarke]]": 1,
        null: 1,
      });
      expect(rows.find((r) => r.assignee === "[[Edith Clarke]]")!.hours).toBe(12);
      const everything = await t.ok<WriteResult>("create_view", { name: "vw_names", query: { union: [{ table: "person", columns: ["name"] }, { table: "project", columns: ["name"], where: { kind: "area" } }], order_by: "name" } });
      const names = await t.ok<Rows>("select_rows", { table: "vw_names" });
      expect(names.rows.map((r) => `${r.name} ${r._source}`)).toEqual(["Ada Lovelace person", "Alan Turing person", "Edith Clarke person", "Engineering project", "Grace Hopper person", "Operations project"]);
      // a view for every person's note
      const mine = await t.ok<WriteResult>("create_view", { name: "vw_my_tasks", query: { table: "task", columns: ["title", "status"], where: { assignee: "{this.link}" }, order_by: "title" }, description: "Tasks of the person a note is about" });
      expect(pluck(await t.ok<Rows>("select_rows", { table: "vw_my_tasks", this_note: person("Alan Turing") }), "title")).toEqual(["Load the sales events", "Pick a query engine"]);
      expect((await t.ok<Rows>("select_rows", { table: "vw_my_tasks" })).total).toBe(0); // no note: nothing
      const view = (await t.ok<Rows>("select_rows", { table: "system.information_schema.views", where: { table_name: "vw_load" } })).rows[0]!;
      expect(view).toMatchObject({ comment: "Open work per person", aliases: ["workload"] });

      expect(await t.refused("create_view", { name: "vw_open_tasks", query: { table: "task" } })).toContain("work.planning.vw_open_tasks already exists (pass replace)");
      const replaced = await t.ok<WriteResult>("create_view", { name: "vw_open_tasks", replace: true, query: { table: "task", columns: ["title"], where: { status: "todo" }, order_by: "title" } });
      expect((await t.ok<Rows>("select_rows", { table: "vw_open_tasks" })).total).toBe(4);
      expect(await t.refused("create_view", { name: "vw_bad", query: { table: "task", columns: ["nope"] } })).toBe('unknown column: "nope"');
      expect(await t.refused("create_view", { name: "vw_bad", query: { table: "nope" } })).toContain("nope");
      const dropped = await t.ok<WriteResult>("drop_view", { view: "vw_engineering" });
      expect(await t.refused("select_rows", { table: "vw_engineering" })).toContain("vw_engineering");
      expect(await t.refused("drop_view", { view: "vw_nope" })).toContain("vw_nope");
      await undoBackTo(t, before, load.migration_id, everything.migration_id, mine.migration_id, replaced.migration_id, dropped.migration_id);
    },
  },
];
