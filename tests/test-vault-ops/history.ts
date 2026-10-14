/**
 * History of one table on the test vault (history is on for the whole database): the transaction
 * log (every kind of version, time travel, changes between versions, clone as of, restore, vacuum),
 * a table's own setting against the database's, a dropped table, and the operation journal
 * (list_migrations, undo_migration, its refusals and redo). The database as a whole: history-database.ts.
 */

import { expect } from "vitest";
import { until } from "../helpers/test-vault";
import { METASTORE, person, pluck, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

interface Version {
  version: number;
  timestamp: string;
  operation: string;
  migration_id?: string;
  operation_metrics: Record<string, unknown>;
  actor?: Record<string, unknown>;
}
type History = { table: string; history: Version[] };

export const scenarios: Scenario[] = [
  {
    name: "a table's history: every kind of version (schema, writes, hand edits, restore, undo, clone), time travel by version and timestamp, changes between versions, clone as of, restore and its undo, vacuum",
    ops: ["alter_table", "add_column", "update_row", "insert_row", "delete_rows", "describe_history", "select_rows", "table_changes", "clone_table", "restore_table", "vacuum_table", "undo_migration"],
    timeout: 30_000,
    async run(t) {
      const before = t.files();
      // history is on for the whole database: version 0 is every table as the engine first saw it
      const v1 = await t.ok<WriteResult & { commits: unknown[] }>("alter_table", { table: "task", description: "Things to do" });
      expect(v1.commits).toContainEqual({ table: "work.planning.task", version: 1, operation: "ALTER TABLE" });
      const v2 = await t.ok<WriteResult>("add_column", { table: "task", column: { name: "effort", type: "integer", description: "Hours of work the task takes" } });
      const v3 = await t.ok<WriteResult>("update_row", { table: "task", path: task("Pick a query engine"), set: { priority: "high" } });
      const v4 = await t.ok<WriteResult>("insert_row", { table: "task", values: { title: "Benchmark the engines", project: "[[Data platform]]" } });
      const v5 = await t.ok<WriteResult>("delete_rows", { table: "task", where: { title: "Find the new office" } });
      // a hand edit: an EXTERNAL_EDIT version once the engine sees it: the service's watcher reports it;
      // the in-process host has no watcher, its next write logs it first
      t.handEdit(task("Export the old pages"), t.read(task("Export the old pages")).replace("status: todo", "status: doing"));
      if (t.host === "in-process") await t.ok("update_row", { table: "person", path: person("Ada Lovelace"), set: { email: "ada@engine.example" } });
      const h = await until(async () => {
        const r = await t.ok<History>("describe_history", { table: "task" });
        return r.history[0]!.operation === "EXTERNAL_EDIT" && r;
      }, 15_000, "the hand edit logged");
      expect(h.history.map((v) => `${v.version} ${v.operation}`)).toEqual(["6 EXTERNAL_EDIT", "5 DELETE", "4 WRITE", "3 UPDATE", "2 ADD COLUMNS", "1 ALTER TABLE", "0 CREATE TABLE"]);
      expect(h.history.map((v) => v.migration_id)).toEqual([undefined, v5.migration_id, v4.migration_id, v3.migration_id, v2.migration_id, v1.migration_id, undefined]);
      expect(h.history[1]).toMatchObject({ actor: { harness: "test-vault-ops" }, operation_metrics: { num_removed_files: 1, metadata_changed: false } });
      expect(h.history[0]).toMatchObject({ operation_metrics: { num_added_files: 1, num_removed_files: 1 } });
      expect(h.history[0]!.actor).toBeUndefined(); // a hand edit has no agent
      expect(h.history[5]!.operation_metrics).toMatchObject({ num_added_files: 0, num_removed_files: 0, metadata_changed: true });
      expect((await t.ok<History>("describe_history", { table: "task", limit: 2 })).history).toHaveLength(2);
      const since = h.history.find((v) => v.version === 4)!.timestamp;
      expect((await t.ok<History>("describe_history", { table: "task", since })).history.map((v) => v.version)).toEqual([6, 5, 4]);

      // time travel
      const at0 = await t.ok<Rows & { version: number }>("select_rows", { table: "task", version: 0, columns: ["title", "priority"] });
      expect(at0.total).toBe(8);
      expect(at0.rows.find((r) => r.title === "Pick a query engine")!.priority).toBe("medium");
      expect(pluck(at0, "title")).toContain("Find the new office");
      expect(await t.refused("select_rows", { table: "task", version: 1, columns: ["effort"] })).toBe('unknown column: "effort"'); // not a column yet then
      const at4 = await t.ok<Rows & { version: number }>("select_rows", { table: "task", timestamp: since, where: { priority: "high" }, columns: ["title"], order_by: "title" });
      expect(at4.version).toBe(4);
      expect(pluck(at4, "title")).toEqual(["Build the button component", "Export the old pages", "Load the sales events", "Pick a query engine"]);
      expect(await t.refused("select_rows", { table: "task", timestamp: "2000-01-01T00:00:00Z" })).toBe("work.planning.task did not exist at 2000-01-01T00:00:00Z");

      // the changes between versions: definition changes, updates as pre- and post-image, inserts, deletes, the hand edit
      type Change = Record<string, unknown> & { _change_type: string; _commit_version: number; _operation: string; title?: string };
      const changes = (await t.ok<{ changes: Change[] }>("table_changes", { table: "task", start_version: 1 })).changes;
      expect(changes.map((c) => `${c._commit_version} ${c._change_type}${c.title ? ` ${c.title}` : ""}${c._change_type.startsWith("update") ? ` ${c.priority}/${c.status}` : ""}`)).toEqual([
        "1 metadata",
        "2 metadata",
        "3 update_preimage Pick a query engine medium/doing",
        "3 update_postimage Pick a query engine high/doing",
        "4 insert Benchmark the engines",
        "5 delete Find the new office",
        "6 update_preimage Export the old pages high/todo",
        "6 update_postimage Export the old pages high/doing",
      ]);
      expect(changes.at(-1)!._operation).toBe("EXTERNAL_EDIT");
      expect((await t.ok<{ changes: Change[] }>("table_changes", { table: "task", start_version: 4, end_version: 4 })).changes.map((c) => c._change_type)).toEqual(["insert"]);

      // a copy as of version 0: a new table whose history starts with CLONE
      const copy = await t.ok<WriteResult>("clone_table", { source: "task", target: "task_at_start", version: 0 });
      expect(copy.planned_creates).toHaveLength(8);
      expect((await t.ok<Rows>("select_rows", { table: "task_at_start", where: { title: "Pick a query engine" } })).rows[0]!.priority).toBe("medium");
      expect((await t.ok<History>("describe_history", { table: "task_at_start" })).history.map((v) => v.operation)).toEqual(["CLONE"]);

      // restore: dry run, then for real (a new version, rows and definition), then undone (another one)
      const dry = await t.ok<WriteResult>("restore_table", { table: "task", version: 0, dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, planned_creates: [task("Find the new office")], planned_deletes: [task("Benchmark the engines")] });
      expect([...dry.planned_texts].sort()).toEqual([METASTORE, task("Export the old pages"), task("Pick a query engine")]); // the definition and the changed rows
      const restored = await t.ok<WriteResult>("restore_table", { table: "task", version: 0 });
      const now = t.files();
      for (const title of ["Find the new office", "Pick a query engine", "Export the old pages"]) expect(now[task(title)]).toBe(before[task(title)]);
      expect(now[task("Benchmark the engines")]).toBeUndefined();
      const d = await t.ok<{ columns: { name: string }[]; description: string }>("describe_table", { table: "task" });
      expect([d.columns.map((c) => c.name), d.description]).toEqual([expect.not.arrayContaining(["effort"]), "Things to do, each in a project or a workstream"]);
      expect((await t.ok<History>("describe_history", { table: "task", limit: 1 })).history[0]).toMatchObject({ version: 7, operation: "RESTORE", migration_id: restored.migration_id });
      await t.ok("undo_migration", { migration_id: restored.migration_id });
      expect((await t.ok<History>("describe_history", { table: "task", limit: 1 })).history[0]).toMatchObject({ version: 8, operation: "UNDO" });
      expect(pluck(await t.ok<Rows>("select_rows", { table: "task", where: { title: { in: ["Find the new office", "Benchmark the engines"] } } }), "title")).toEqual(["Benchmark the engines"]);

      // vacuum: a dry run unless asked; then time travel before the kept version is gone
      const dryVacuum = await t.ok<{ retained_from: number; deleted: string[]; dry_run: boolean }>("vacuum_table", { table: "task" });
      expect(dryVacuum).toMatchObject({ retained_from: 8, dry_run: true });
      // versions 0 to 8 are in one segment (the default format): that file goes
      expect(dryVacuum.deleted).toEqual(["store:transaction_log/work.planning.task/00000000000000000000.segment.jsonl"]);
      expect((await t.ok<Rows>("select_rows", { table: "task", version: 1 })).total).toBe(8);
      const vacuumed = await t.ok<{ deleted: string[]; dry_run: boolean }>("vacuum_table", { table: "task", retain_from_version: 3, dry_run: false });
      // the versions from 3 on are written to a segment of their own, the old one goes
      expect(vacuumed.deleted).toEqual(["store:transaction_log/work.planning.task/00000000000000000000.segment.jsonl"]);
      expect(await t.refused("select_rows", { table: "task", version: 1 })).toBe("work.planning.task has no version 1 (available: 3..8)");
      expect((await t.ok<History>("describe_history", { table: "task" })).history.map((v) => v.version)).toEqual([8, 7, 6, 5, 4, 3]);
      expect((await t.ok<Rows>("select_rows", { table: "task", version: 3 })).total).toBe(8);
    },
  },
  {
    name: "history for every table from configure_database; a table's own setting wins; a dropped table described and restored",
    ops: ["configure_database", "describe_history", "drop_table", "restore_table", "alter_table"],
    async run(t) {
      expect(await t.ok("configure_database", { history: true })).toMatchObject({ config: { history: true } });
      await t.ok("create_table", { name: "milestone", description: "Dates a project must meet", columns: [{ name: "name", type: "string", required: true, description: "What the project must have reached" }, { name: "project", type: "link", ref: "work.planning.project", description: "The project the milestone belongs to" }], filename: "{name}" });
      await t.ok("insert_row", { table: "milestone", values: { name: "Beta online", project: "[[Website relaunch]]" } });
      expect((await t.ok<History>("describe_history", { table: "milestone" })).history.map((v) => `${v.version} ${v.operation}`)).toEqual(["1 WRITE", "0 CREATE TABLE"]);

      // "off" on a table wins over the database; "inherit" follows it again
      await t.ok("alter_table", { table: "person", history: false });
      await t.ok("update_row", { table: "person", path: "datanotes/work/planning/person/Ada Lovelace.md", set: { email: "ada@engine.example" } });
      expect((await t.ok<History>("describe_history", { table: "person" })).history.map((v) => v.operation)).not.toContain("UPDATE");
      await t.ok("alter_table", { table: "person", history: "default" });
      await t.ok("update_row", { table: "person", path: "datanotes/work/planning/person/Ada Lovelace.md", set: { email: "ada@example.com" } });
      expect((await t.ok<History>("describe_history", { table: "person" })).history.map((v) => v.operation)).toContain("UPDATE");

      // dropped: its history stays readable by full name, and it can be brought back
      const dropped = await t.ok<WriteResult>("drop_table", { table: "milestone", mode: "archive" });
      expect(await t.refused("select_rows", { table: "milestone" })).toContain("milestone");
      const h = await t.ok<History>("describe_history", { table: "work.planning.milestone" });
      expect(h.history[0]!.migration_id).toBe(dropped.migration_id);
      await t.ok("restore_table", { table: "work.planning.milestone", version: 1 });
      expect(pluck(await t.ok<Rows>("select_rows", { table: "milestone" }), "name")).toEqual(["Beta online"]);

      expect(await t.ok("configure_database", { history: false })).toMatchObject({ config: { history: false } });
    },
  },
  {
    name: "the journal: list_migrations with filters, undo refused when a row changed since or already undone, undo flags, redo by undoing the undo",
    ops: ["list_migrations", "undo_migration"],
    async run(t) {
      const before = t.files();
      const u1 = await t.ok<WriteResult>("update_row", { table: "task", path: task("Export the old pages"), set: { estimate_h: 9 } });
      const ins = await t.ok<WriteResult>("insert_row", { table: "task", values: { title: "Benchmark the engines", project: "[[Data platform]]" } });
      const u2 = await t.ok<WriteResult>("update_row", { table: "task", path: task("Export the old pages"), set: { estimate_h: 10 } });

      type Entry = { migration_id: string; op: string; summary: string; table: string; notes_changed: number; files_changed: number; undone: boolean; undoes?: string; by: string };
      type Journal = { total: number; migrations: Entry[] };
      const all = await t.ok<Journal>("list_migrations");
      expect(all.migrations.map((m) => m.migration_id)).toEqual([u2.migration_id, ins.migration_id, u1.migration_id]); // newest first
      expect(all.migrations[1]).toMatchObject({ op: "insert_row", summary: "insert into task", table: "work.planning.task", files_changed: 1, undone: false, by: "test-vault-ops" });
      expect((await t.ok<Journal>("list_migrations", { op: "update_row" })).migrations.map((m) => m.migration_id)).toEqual([u2.migration_id, u1.migration_id]);
      expect((await t.ok<Journal>("list_migrations", { op: "update_row", limit: 1 })).migrations.map((m) => m.migration_id)).toEqual([u2.migration_id]);
      // update_row is journaled under its own name, not as update_rows
      expect((await t.ok<Journal>("list_migrations", { op: "update_rows" })).total).toBe(0);
      expect((await t.ok<Journal>("list_migrations", { table: "person" })).total).toBe(0);
      expect((await t.ok<Journal>("list_migrations", { since: "2099-01-01" })).total).toBe(0);
      expect((await t.ok<Journal>("list_migrations", { since: "2000-01-01", table: "work.planning.task" })).total).toBe(3);

      // the row changed since u1: refused, nothing written
      const files = t.files();
      expect(await t.refused("undo_migration", { migration_id: u1.migration_id })).toBe(
        `undo_migration refused — nothing was written:\nconflict ${task("Export the old pages")}: "estimate_h" changed since the operation`,
      );
      expect(t.files()).toEqual(files);
      expect(await t.refused("undo_migration", { migration_id: "nope" })).toBe("Migration not found: nope");
      // the answer: the undo's own id, and the operation it undid
      const undone = await t.ok<{ migration_id: string; undoes: string }>("undo_migration", { migration_id: u2.migration_id });
      expect(undone).toMatchObject({ ok: true, op: "undo_migration", undoes: u2.migration_id });
      expect(undone).not.toHaveProperty("touched");
      expect(await t.refused("undo_migration", { migration_id: u2.migration_id })).toContain(u2.migration_id);
      const journal = await t.ok<Journal>("list_migrations", { limit: 2 });
      expect(journal.migrations[0]).toMatchObject({ migration_id: undone.migration_id, op: "undo_migration", undoes: u2.migration_id });
      expect(journal.migrations[1]).toMatchObject({ migration_id: u2.migration_id, undone: true });
      // undoing the undo is a redo; undoing that undoes again
      const redo = await t.ok<{ migration_id: string }>("undo_migration", { migration_id: undone.migration_id });
      expect(t.read(task("Export the old pages"))).toContain("estimate_h: 10");
      expect((await t.ok<Journal>("list_migrations", { limit: 1 })).migrations[0]).toMatchObject({ op: "undo_migration", undoes: undone.migration_id });
      await t.ok("undo_migration", { migration_id: redo.migration_id });
      expect(t.read(task("Export the old pages"))).toContain("estimate_h: 9");
      await undoBackTo(t, before, u1.migration_id, ins.migration_id);
    },
  },
];
