/**
 * Schema changes of tables and columns on the test vault: create, alter, rename and drop tables and
 * columns, rename enum values, clone and drop tables. Each is checked in metastore.yaml and on the
 * rows, refused with its reason when rows or rules stand in the way, and undone exactly.
 */

import { expect } from "vitest";
import { METASTORE, pluck, project, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

const TASK_DIR = "datanotes/work/planning/task";

export const scenarios: Scenario[] = [
  {
    name: "create_table: a milestone table with tags, a filtered link and a row template; refusals; undo",
    ops: ["create_table", "describe_table", "insert_row", "undo_migration"],
    async run(t) {
      const before = t.files();
      const spec = {
        name: "milestone",
        columns: [
          { name: "name", type: "string", required: true, unique: true, description: "What the project must have reached" },
          { name: "project", type: "link", ref: "work.planning.project", required: true, ref_where: { kind: "project" }, description: "The project the milestone belongs to" },
          { name: "due", type: "date", required: true, description: "The day it must be reached by" },
          { name: "reached", type: "boolean", default: false, dense: true, description: "True once it is reached" },
          { name: "size", type: "enum", values: ["s", "m", "l"], value_descriptions: { s: "a week", m: "a month", l: "a quarter" }, description: "How much work it takes" },
        ],
        filename: "{name}", description: "Dates a project must meet", aliases: ["milestones", "deadline"],
        row_template: "## Criteria\n\n",
        tags: { domain: "work", owner: "pmo" },
      };
      // every column needs a description: the refusal names each missing one
      const { description: _d, ...undescribed } = spec.columns[2]!;
      expect(await t.refused("create_table", { ...spec, columns: [spec.columns[0], spec.columns[1], undescribed] })).toContain("descriptions are required: work.planning.milestone has none for column due");
      const dry = await t.ok<WriteResult>("create_table", { ...spec, dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, planned_texts: [METASTORE] });
      expect(t.files()).toEqual(before);
      const made = await t.ok<WriteResult>("create_table", spec);
      const d = await t.ok<Record<string, any>>("describe_table", { table: "milestone" });
      expect(d).toMatchObject({ qualified: "work.planning.milestone", row_count: 0, tags: { domain: "work", owner: "pmo" }, description: "Dates a project must meet", aliases: ["milestones", "deadline"] });
      expect(d.columns.map((c: { name: string }) => c.name)).toEqual(["id", "name", "project", "due", "reached", "size"]);
      expect(t.read(METASTORE)).toContain("          milestone:\n            description: Dates a project must meet\n");

      const row = await t.ok<WriteResult>("insert_row", { table: "milestone", values: { name: "Beta online", project: "[[Website relaunch]]", due: "2026-11-15", size: "m" } });
      const text = t.read("datanotes/work/planning/milestone/Beta online.md");
      expect(text).toContain("\nreached: false\n"); // dense, with its default
      expect(text.endsWith("---\n## Criteria\n\n")).toBe(true); // the row template
      // ref_where: a milestone belongs to a project, not to an area or a workstream
      expect(await t.refused("insert_row", { table: "milestone", values: { name: "Styles done", project: "[[Design system]]", due: "2026-10-30" } })).toContain(
        'project [[Design system]] is not a valid project (needs ref_where {"kind":"project"}); valid: Data platform, Office move, Website relaunch',
      );

      expect(await t.refused("create_table", { name: "task", description: "Another task table", columns: [{ name: "x", type: "string", description: "Anything" }], filename: "{x}" })).toContain("work.planning.task already exists");
      expect(await t.refused("create_table", { name: "bad", description: "A table with a wrong type", columns: [{ name: "x", type: "decimal", description: "A price" }], filename: "{x}" })).toContain('"type" must be one of: string, number, integer, boolean, date, datetime, enum, link, json, list');
      expect(await t.refused("create_table", { name: "nameless", description: "A table with no file names", columns: [{ name: "x", type: "string", description: "Anything" }] })).toBe('pass "time_column" or "filename" (e.g. "{name}") so rows get file names');
      await undoBackTo(t, before, made.migration_id, row.migration_id);
    },
  },
  {
    name: "columns: add (dense, with a default), alter, rename (followed into CHECKs), drop (refused while a CHECK reads it); undo",
    ops: ["add_column", "alter_column", "rename_column", "drop_column", "undo_migration"],
    async run(t) {
      const before = t.files();
      const added = await t.ok<WriteResult>("add_column", { table: "task", column: { name: "effort", type: "enum", values: ["s", "m", "l"], ordered: true, default: "m", label: "Effort", description: "How much work the task takes", dense: true } });
      expect(added.notes_changed).toBe(8);
      expect(pluck(await t.ok<Rows>("select_rows", { table: "task", columns: ["effort"] }), "effort")).toEqual(Array(8).fill("m"));
      expect(await t.refused("add_column", { table: "task", column: { name: "title", type: "string", description: "The task, in a few words" } })).toBe('column "title" already exists in table "task"');

      // alter: refused with the rows that would break it, applied when they fit
      const tooSmall = await t.refused("alter_column", { table: "task", column: "estimate_h", changes: { max: 10 } });
      expect(tooSmall).toContain(`invalid ${task("Build the button component")}: estimate_h must be <= 10`);
      expect(tooSmall).toContain(`invalid ${task("Load the sales events")}: estimate_h must be <= 10`);
      expect(await t.refused("alter_column", { table: "task", column: "assignee", changes: { required: true } })).toContain(`invalid ${task("Redirect the old URLs")}: assignee is required`);
      // a description changes, never goes
      expect(await t.refused("alter_column", { table: "task", column: "estimate_h", changes: { description: "" } })).toContain("the description of column estimate_h of work.planning.task cannot be removed");
      const altered = await t.ok<WriteResult>("alter_column", { table: "task", column: "estimate_h", changes: { max: 40, label: "Estimate (hours)", aliases: ["hours"], description: "Hours of work, a guess" } });
      const col = (await t.ok<{ columns: Record<string, unknown>[] }>("describe_table", { table: "task" })).columns.find((c) => c.name === "estimate_h");
      expect(col).toMatchObject({ max: 40, min: 0, label: "Estimate (hours)", aliases: ["hours"], description: "Hours of work, a guess" });
      expect(await t.refused("insert_row", { table: "task", values: { title: "Plan", project: "[[Data platform]]", estimate_h: 41 } })).toContain("estimate_h must be <= 40");

      // rename: the rows and the CHECK that reads it follow
      const renamed = await t.ok<WriteResult>("rename_column", { table: "task", from_column: "done_on", to_column: "completed_on" });
      expect(renamed.planned_edits.map((p) => p.path).sort()).toEqual([task("Choose the colour palette"), task("Load the sales events")]);
      expect(t.read(task("Load the sales events"))).toContain("\ncompleted_on: 2026-09-10\n");
      expect(t.read(METASTORE)).toContain("              done_has_date:\n                or:\n                  - status:\n                      ne: done\n                  - completed_on:\n                      exists: true\n");
      expect(await t.refused("insert_row", { table: "task", values: { title: "Ship it", project: "[[Website relaunch]]", status: "done" } })).toContain("done_has_date");
      expect(await t.refused("rename_column", { table: "task", from_column: "due", to_column: "title" })).toContain("title");

      // drop: refused while the CHECK reads it; otherwise the values go (and come back with undo)
      expect(await t.refused("drop_column", { table: "task", column: "completed_on" })).toContain("CHECK done_has_date of work.planning.task reads task.completed_on: drop or change it first");
      const dropped = await t.ok<WriteResult>("drop_column", { table: "task", column: "estimate_h" });
      expect(dropped.notes_changed).toBe(4);
      expect(t.read(task("Load the sales events"))).not.toContain("estimate_h");
      expect(await t.refused("select_rows", { table: "task", columns: ["estimate_h"] })).toContain("estimate_h");
      await undoBackTo(t, before, added.migration_id, altered.migration_id, renamed.migration_id, dropped.migration_id);
    },
  },
  {
    name: "rename_value: an ordered scale keeps its order; a level of the tree is renamed in ref_by and in a CHECK through a link; undo",
    ops: ["rename_value", "undo_migration"],
    async run(t) {
      const before = t.files();
      const urgent = await t.ok<WriteResult>("rename_value", { table: "task", column: "priority", from_value: "high", to_value: "urgent" });
      expect(urgent.notes_changed).toBe(3);
      const priority = (await t.ok<{ columns: Record<string, unknown>[] }>("describe_table", { table: "task" })).columns.find((c) => c.name === "priority");
      expect(priority).toMatchObject({ values: ["low", "medium", "urgent"], ordered: true });
      const top = await t.ok<Rows>("select_rows", { table: "task", where: { priority: { gt: "medium" } }, columns: ["title"], order_by: "title" });
      expect(pluck(top, "title")).toEqual(["Build the button component", "Export the old pages", "Load the sales events"]);

      const stream = await t.ok<WriteResult>("rename_value", { table: "project", column: "kind", from_value: "workstream", to_value: "stream" });
      expect(stream.planned_edits.map((p) => p.path).sort()).toEqual([project("Content migration"), project("Design system"), project("Ingestion")]);
      const meta = t.read(METASTORE);
      expect(meta).toContain("                ref_by:\n                  column: kind\n                  levels:\n                    - area\n                    - project\n                    - stream\n");
      expect(meta).toContain("                project.kind:\n                  in:\n                    - project\n                    - stream\n");
      // the renamed rules still hold and still refuse
      const onStream = await t.ok<WriteResult>("insert_row", { table: "task", values: { title: "Pick fonts", project: "[[Design system]]" } });
      expect(await t.refused("insert_row", { table: "project", values: { name: "Hiring", kind: "stream", parent: "[[Operations]]" } })).toContain('(needs kind project)');
      expect(await t.refused("rename_value", { table: "task", column: "priority", from_value: "low", to_value: "medium" })).toContain('"medium" is already a value of priority');
      await undoBackTo(t, before, urgent.migration_id, stream.migration_id, onStream.migration_id);
    },
  },
];
