/**
 * Tables changed as a whole on the test vault: alter_table (metadata, folders, file names, a new name or\n * schema), clone_table and drop_table, each refused when rules stand in the way, and undone exactly.
 */

import { expect } from "vitest";
import { METASTORE, pluck, project, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

const TASK_DIR = "datanotes/work/planning/task";

export const scenarios: Scenario[] = [
  {
    name: "alter_table: tags, description, aliases, template, fields, archive, history; folders and names, refused when a CHECK of another table reads it; undo",
    ops: ["alter_table", "undo_migration"],
    async run(t) {
      const before = t.files();
      const ids: string[] = [];
      const alter = async (args: Record<string, unknown>) => {
        const r = await t.ok<WriteResult>("alter_table", args);
        ids.push(r.migration_id);
        return r;
      };
      // metadata only: the table entry changes, no row is touched
      const meta = await alter({ table: "person", tags: { domain: null, team: "core" }, description: "Everyone on the projects", aliases: ["staff"], row_template: "## Notes\n", fields: { nickname: "" } });
      expect(meta.notes_changed).toBe(0);
      expect(meta.planned_texts).toEqual([METASTORE]);
      let d = await t.ok<Record<string, any>>("describe_table", { table: "person" });
      expect(d).toMatchObject({ tags: { team: "core" }, description: "Everyone on the projects", aliases: ["staff"] });
      expect(d.untyped_fields).toContain("nickname");
      await alter({ table: "person", clear_tags: true, tags: { kind: "people" }, row_template: "" });
      d = await t.ok<Record<string, any>>("describe_table", { table: "person" });
      expect(d.tags).toEqual({ kind: "people" });
      // a table's own history setting, written under its properties (the database has it on too)
      await alter({ table: "person", history: true });
      await alter({ table: "task", exclude: ["drafts"] });
      expect(t.read(METASTORE)).toContain("              history: true\n");
      expect(t.read(METASTORE)).toContain("              exclude: drafts\n");

      // folders: a partition by status (dry run), a new archive folder that archived rows move to
      const part = await t.ok<WriteResult>("alter_table", { table: "task", partition: "{status}", dry_run: true });
      expect(part.planned_moves.find((m) => m.from === task("Pick a query engine"))!.to).toBe(`${TASK_DIR}/doing/Pick a query engine.md`);
      expect(part.planned_moves).toHaveLength(8);
      const del = await t.ok<WriteResult>("delete_rows", { table: "task", where: { title: "Find the new office" } });
      ids.push(del.migration_id);
      const arch = await alter({ table: "task", archive: "_done" });
      expect(arch.planned_moves).toEqual([{ from: `${TASK_DIR}/_archive/Find the new office.md`, to: `${TASK_DIR}/_done/Find the new office.md` }]);
      const pattern = await alter({ table: "task", filename: "{status} - {title}" });
      expect(t.exists(`${TASK_DIR}/doing - Pick a query engine.md`)).toBe(true);
      expect(pattern.files_moved).toBe(7);

      // a new name and a new schema: rows move; a table read through a link by a CHECK cannot
      const moved = await alter({ table: "task", name: "todo", schema: "ops" });
      expect(t.exists("datanotes/work/ops/todo/doing - Pick a query engine.md")).toBe(true);
      expect(t.read("datanotes/work/ops/todo/doing - Pick a query engine.md")).toMatch(/^---\ntable: work\.ops\.todo\n/);
      expect((await t.ok<Rows>("select_rows", { table: "work.ops.todo" })).total).toBe(7);
      void moved;
      const refused = await t.refused("alter_table", { table: "project", name: "initiative" });
      expect(refused).toContain("CHECK not_on_an_area of work.ops.todo reads work.planning.project through a link: drop or change it before you rename the table (link targets are not rewritten)");
      await undoBackTo(t, before, ...ids);
    },
  },
  {
    name: "clone_table and drop_table: deep and shallow copies in another catalog, drops refused while rows or rules depend on the table; undo",
    ops: ["clone_table", "drop_table", "undo_migration"],
    async run(t) {
      const before = t.files();
      const deep = await t.ok<WriteResult>("clone_table", { source: "task", target: "sandbox.lab.task" });
      expect(deep.planned_creates).toHaveLength(8);
      const copies = await t.ok<Rows>("select_rows", { table: "sandbox.lab.task", columns: ["id", "title", "project"], order_by: "title" });
      const originals = await t.ok<Rows>("select_rows", { table: "work.planning.task", columns: ["id", "title", "project"], order_by: "title" });
      expect(pluck(copies, "title")).toEqual(pluck(originals, "title"));
      expect(pluck(copies, "project")).toEqual(pluck(originals, "project"));
      expect(pluck(copies, "id").some((id) => pluck(originals, "id").includes(id))).toBe(false); // independent rows
      // the copy keeps the rules: its CHECK follows links into work.planning.project
      expect(await t.refused("insert_row", { table: "sandbox.lab.task", values: { title: "Plan the year", project: "[[Engineering]]" } })).toContain("not_on_an_area");
      expect(await t.refused("clone_table", { source: "task", target: "task_template", copy_rows: false })).toBe('"task" matches sandbox.lab.task, work.planning.task; use catalog.schema.table');
      const shallow = await t.ok<WriteResult>("clone_table", { source: "work.planning.task", target: "task_template", copy_rows: false });
      expect(shallow.files_created).toBe(0);
      expect((await t.ok<Record<string, any>>("describe_table", { table: "task_template" })).row_count).toBe(0);
      const db = await t.ok<{ catalogs: { catalog: string }[] }>("describe_database");
      expect(db.catalogs.map((c) => c.catalog)).toEqual(["work", "sandbox"]);
      expect(await t.refused("clone_table", { source: "work.planning.task", target: "project" })).toContain("already exists");

      // drop: refused with rows, or while a CHECK of another table reads it through a link
      expect(await t.refused("drop_table", { table: "sandbox.lab.task" })).toContain('table has 8 rows; pass mode: "archive" to archive them with the table');
      const project = await t.refused("drop_table", { table: "project", mode: "archive" });
      expect(project).toContain("CHECK not_on_an_area of work.planning.task reads work.planning.project through a link");
      expect(project).toContain("CHECK not_on_an_area of sandbox.lab.task reads work.planning.project through a link");
      const archived = await t.ok<WriteResult>("drop_table", { table: "sandbox.lab.task", mode: "archive" });
      expect(archived.planned_moves).toHaveLength(8);
      expect(archived.planned_moves.every((m) => m.to.startsWith("datanotes/sandbox/lab/task/_archive/"))).toBe(true);
      const empty = await t.ok<WriteResult>("drop_table", { table: "task_template" });
      expect(await t.refused("describe_table", { table: "task_template" })).toContain("task_template");
      expect(await t.refused("select_rows", { table: "sandbox.lab.task" })).toContain("sandbox.lab.task");
      // the catalog and schema the clone created stay, empty
      expect(t.read(METASTORE)).toContain("  sandbox:\n    schemas:\n      lab:\n        tables: {}\n");
      await undoBackTo(t, before, deep.migration_id, shallow.migration_id, archived.migration_id, empty.migration_id);
    },
  },
  {
    name: "a table renamed or moved with history on is undone, its transaction log moved back",
    ops: ["alter_table", "undo_migration", "describe_history"],
    async run(t) {
      const before = t.files();
      type History = { table: string; history: { version: number; operation: string }[] };
      const on = await t.ok<WriteResult>("alter_table", { table: "task", history: true });
      const renamed = await t.ok<WriteResult>("alter_table", { table: "task", name: "todo" });
      expect(renamed.planned_moves).toContainEqual({ from: "store:transaction_log/work.planning.task/00000000000000000000.json", to: "store:transaction_log/work.planning.todo/00000000000000000000.json" });
      await t.ok("undo_migration", { migration_id: renamed.migration_id });
      // the whole log comes back, the commit of the rename included, and the undo is a new version
      const back = await t.ok<History>("describe_history", { table: "task" });
      expect(back.history.map((c) => [c.version, c.operation])).toEqual([[3, "UNDO"], [2, "ALTER TABLE"], [1, "ALTER TABLE"], [0, "CREATE TABLE"]]);
      expect(await t.refused("describe_history", { table: "work.planning.todo" })).toContain("todo");
      expect((await t.ok<Rows>("select_rows", { table: "task", version: 0 })).total).toBe(8);
      // moved to another schema: the same
      const moved = await t.ok<WriteResult>("alter_table", { table: "task", schema: "later" });
      expect((await t.ok<History>("describe_history", { table: "work.later.task" })).history[0]).toMatchObject({ version: 4, operation: "ALTER TABLE" });
      await t.ok("undo_migration", { migration_id: moved.migration_id });
      expect((await t.ok<History>("describe_history", { table: "work.planning.task", limit: 1 })).history).toMatchObject([{ version: 5, operation: "UNDO" }]);
      await undoBackTo(t, before, on.migration_id);
    },
  },
];
