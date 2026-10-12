/**
 * Row writes the engine derives or groups on the test vault: generated columns recomputed, inverse links\n * aligned, and batches of writes and DDL that succeed or fail together.
 */

import { expect } from "vitest";
import { until } from "../helpers/test-vault";
import { person, pluck, project, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

export const scenarios: Scenario[] = [
  {
    name: "recompute_columns: a generated column filled on existing rows, kept current by writes, recomputed after a hand edit; undo",
    ops: ["recompute_columns", "add_column", "undo_migration", "check_table"],
    async run(t) {
      const before = t.files();
      const added = await t.ok<WriteResult>("add_column", { table: "task", column: { name: "label", type: "string", generated: "{title} ({status})", description: "Title and status, for lists" } });
      const stale = await t.ok<{ violations: { path: string; violations: { column: string; code: string; message: string }[] }[] }>("check_table", { table: "task" });
      expect(stale.violations).toHaveLength(8);
      expect(stale.violations.find((v) => v.path === task("Pick a query engine"))!.violations).toEqual([
        { column: "label", code: "generated", message: 'should be "Pick a query engine (doing)" (computed)' },
      ]);
      const dry = await t.ok<WriteResult>("recompute_columns", { table: "task", dry_run: true });
      expect(dry.planned_edits).toHaveLength(8);
      expect(t.read(task("Pick a query engine"))).not.toContain("label:");
      const all = await t.ok<WriteResult>("recompute_columns", { table: "task" });
      expect(all.notes_changed).toBe(8);
      expect(t.read(task("Pick a query engine"))).toContain("\nlabel: Pick a query engine (doing)\n");
      expect(await t.ok("recompute_columns", { table: "task" })).toMatchObject({ notes_changed: 0, planned_edits: [] }); // nothing stale
      // a write through the engine keeps it current
      const write = await t.ok<WriteResult>("update_row", { table: "task", path: task("Pick a query engine"), set: { status: "todo" } });
      expect(t.read(task("Pick a query engine"))).toContain("\nlabel: Pick a query engine (todo)\n");
      // a hand edit does not: check_table finds it, recompute_columns on that path fixes it
      const edited = t.read(task("Redirect the old URLs")).replace("status: todo", "status: doing");
      t.handEdit(task("Redirect the old URLs"), edited);
      await until(async () => (await t.ok<{ violations: unknown[] }>("check_table", { table: "task" })).violations.length === 1, 5000, "the hand edit is seen");
      const one = await t.ok<WriteResult>("recompute_columns", { table: "task", paths: [task("Redirect the old URLs")] });
      expect(one.planned_edits).toEqual([{ path: task("Redirect the old URLs"), set: { label: "Redirect the old URLs (doing)" }, remove: [] }]);
      // new ids, only where asked
      const id = (await t.ok<Rows>("select_rows", { table: "task", where: { title: "Find the new office" } })).rows[0]!.id;
      const ids = await t.ok<WriteResult>("recompute_columns", { table: "task", paths: [task("Find the new office")], new_ids: true });
      const newId = (await t.ok<Rows>("select_rows", { table: "task", where: { title: "Find the new office" } })).rows[0]!.id;
      expect(newId).not.toBe(id);
      expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      // undo back to the hand edit, then the edit is reverted by hand
      for (const m of [ids, one, write, all, added].map((x) => x.migration_id)) await t.ok("undo_migration", { migration_id: m });
      t.handEdit(task("Redirect the old URLs"), before[task("Redirect the old URLs")]!);
      expect(t.files()).toEqual(before);
    },
  },
  {
    name: "align_relations: an inverse declared on existing links, the missing reciprocal links added; undo",
    ops: ["align_relations", "add_column", "undo_migration", "check_table"],
    async run(t) {
      const before = t.files();
      // every person lists the tasks assigned to them, kept in step with task.assignee
      const added = await t.ok<WriteResult>("add_column", { table: "person", column: { name: "tasks", type: "list", items: "link", ref: "work.planning.task", inverse: "assignee", description: "Tasks assigned to the person" } });
      const missing = await t.ok<{ violations: { path: string; violations: { column: string; code: string; message: string }[] }[] }>("check_table", {});
      expect(missing.violations.map((v) => v.path).sort()).toEqual(
        ["Build the button component", "Choose the colour palette", "Export the old pages", "Find the new office", "Load the sales events", "Pick a query engine", "Write the launch post"].map(task),
      );
      expect(missing.violations[0]!.violations[0]).toMatchObject({ column: "assignee", code: "inverse" });
      const dry = await t.ok<WriteResult>("align_relations", { table: "task", dry_run: true });
      expect(Object.fromEntries(dry.planned_edits.map((p) => [p.path, p.set]))).toEqual({
        [person("Edith Clarke")]: { tasks: ["[[Build the button component]]", "[[Choose the colour palette]]"] },
        [person("Ada Lovelace")]: { tasks: ["[[Export the old pages]]"] },
        [person("Grace Hopper")]: { tasks: ["[[Find the new office]]", "[[Write the launch post]]"] },
        [person("Alan Turing")]: { tasks: ["[[Load the sales events]]", "[[Pick a query engine]]"] },
      });
      const aligned = await t.ok<WriteResult>("align_relations", { table: "task" });
      expect(aligned.notes_changed).toBe(4);
      expect((await t.ok<{ violations: unknown[] }>("check_table", {})).violations).toEqual([]);
      // from now on writes keep both sides in step
      const moved = await t.ok<WriteResult>("update_row", { table: "task", path: task("Redirect the old URLs"), set: { assignee: "[[Ada Lovelace]]" } });
      expect(pluck(await t.ok<Rows>("select_rows", { table: "person", where: { name: "Ada Lovelace" } }), "tasks")).toEqual([["[[Export the old pages]]", "[[Redirect the old URLs]]"]]);
      expect(await t.ok("align_relations", { table: "task" })).toMatchObject({ notes_changed: 0 });
      await undoBackTo(t, before, added.migration_id, aligned.migration_id, moved.migration_id);
    },
  },
  {
    name: "batch: writes and DDL that succeed or fail together; a refused step undoes the others; undo the whole batch",
    ops: ["batch", "undo_migration"],
    async run(t) {
      const before = t.files();
      const ops = [
        { op: "insert_row", table: "project", values: { name: "Search", kind: "workstream", parent: "[[Data platform]]", members: ["[[Alan Turing]]"] } },
        { op: "add_column", table: "task", column: { name: "effort", type: "enum", values: ["small", "large"], description: "How much work the task takes" } },
        { op: "insert_row", table: "task", values: { title: "Index the docs", project: "[[Search]]", assignee: "[[Alan Turing]]", effort: "large" } },
        { op: "update_row", table: "task", path: task("Pick a query engine"), set: { project: "[[Search]]" } },
      ];
      const dry = await t.ok<{ dryRun: boolean; steps: unknown[] }>("batch", { operations: ops.slice(0, 2), dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, steps: [{ index: 0, ok: true }, { index: 1, ok: true }] });
      expect(t.files()).toEqual(before);
      const done = await t.ok<{ migration_id: string; steps: { index: number; op: string; ok: boolean }[] }>("batch", { operations: ops, summary: "plan the search workstream" });
      expect(done.steps.map((s) => `${s.index} ${s.op} ${s.ok}`)).toEqual(["0 insert_row true", "1 add_column true", "2 insert_row true", "3 update_row true"]);
      expect(pluck(await t.ok<Rows>("select_rows", { table: "vw_project_tasks", this_note: project("Search") }), "title")).toEqual(["Index the docs", "Pick a query engine"]);
      expect(t.read(person("Alan Turing"))).toContain('  - "[[Search]]"'); // the inverse link, inside the batch
      expect((await t.ok<{ migrations: { migration_id: string; summary: string }[] }>("list_migrations", { limit: 1 })).migrations[0]).toMatchObject({ migration_id: done.migration_id, summary: "plan the search workstream" });
      await undoBackTo(t, before, done.migration_id);

      // the second step is refused (a task on an area): the first is undone, nothing is left
      const refused = await t.refused("batch", {
        operations: [
          { op: "insert_row", table: "project", values: { name: "Billing", kind: "workstream", parent: "[[Data platform]]" } },
          { op: "insert_row", table: "task", values: { title: "Plan billing", project: "[[Operations]]" } },
        ],
      });
      expect(refused).toContain("batch refused at operation 1 — the operations before it were undone, nothing is left written");
      expect(refused).toContain("not_on_an_area");
      expect(t.files()).toEqual(before);
      expect(await t.refused("batch", { operations: [{ op: "explode" }] })).toContain('"op" must be one of');
    },
  },
];
