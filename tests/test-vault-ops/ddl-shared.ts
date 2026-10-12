/**
 * Definitions shared across tables on the test vault: bases (inherited columns), comments on catalogs and\n * schemas, the database configuration and its root folder.
 */

import { expect } from "vitest";
import { person, project, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

export const scenarios: Scenario[] = [
  {
    name: "bases: define, inherit, extend, rename and drop a shared column across tables; set_table_bases; undo",
    ops: ["define_base", "set_table_bases", "undo_migration"],
    async run(t) {
      const before = t.files();
      const owned = await t.ok<WriteResult>("define_base", { name: "owned", description: "Someone answers for it", columns: [{ name: "owner", type: "link", ref: "work.planning.person", description: "Who answers for it" }] });
      const onProject = await t.ok<WriteResult>("set_table_bases", { table: "project", bases: ["dated", "owned"] });
      const cols = (await t.ok<{ columns: { name: string }[] }>("describe_table", { table: "project" })).columns.map((c) => c.name);
      expect(cols.slice(0, 4)).toEqual(["id", "started_on", "summary", "owner"]);
      const set = await t.ok<WriteResult>("update_row", { table: "project", path: project("Data platform"), set: { owner: "[[Grace Hopper]]" } });
      const base = await t.ok<Rows>("select_rows", { table: "base:owned", where: { owner: { exists: true } } });
      expect(base.rows.map((r) => [r._source, r.owner])).toEqual([["work.planning.project", "[[Grace Hopper]]"]]);
      // a base built on another
      const reviewed = await t.ok<WriteResult>("define_base", { name: "reviewed", bases: ["dated"], description: "Looked over on a given day", columns: [{ name: "reviewed_on", type: "date", description: "When it was last reviewed" }] });
      expect((await t.ok<{ bases: { name: string; tables: string[] }[] }>("describe_database")).bases.map((b) => `${b.name}: ${b.tables.join(", ")}`)).toEqual([
        "dated: work.planning.project, work.planning.task",
        "owned: work.planning.project",
        "reviewed: ",
      ]);
      // replacing the base: a renamed column is renamed on the rows; one left out must be dropped explicitly
      const renamed = await t.ok<WriteResult>("define_base", { name: "owned", columns: [{ name: "lead", type: "link", ref: "work.planning.person" }], rename_columns: { owner: "lead" } });
      expect(t.read(project("Data platform"))).toContain('\nlead: "[[Grace Hopper]]"\n');
      expect(await t.refused("define_base", { name: "owned", columns: [] })).toBe('base "owned" would lose column "lead": list it in drop_columns (its values are removed from the rows) or rename_columns');
      const emptied = await t.ok<WriteResult>("define_base", { name: "owned", columns: [], drop_columns: ["lead"] });
      expect(t.read(project("Data platform"))).not.toContain("lead:");
      // a table cannot leave a base while its rows hold the base's values
      const leaving = await t.refused("set_table_bases", { table: "task", bases: [] });
      expect(leaving).toContain(`invalid ${task("Load the sales events")}: started_on is not a column of table "task"`);
      expect(leaving).toContain(`invalid ${task("Write the launch post")}: summary is not a column of table "task"`);
      await undoBackTo(t, before, owned.migration_id, onProject.migration_id, set.migration_id, reviewed.migration_id, renamed.migration_id, emptied.migration_id);
    },
  },
  {
    name: "the database: comments on catalog and schema (undoable), configuration and the root folder renamed and back (not journaled)",
    ops: ["comment_on", "configure_database", "describe_database"],
    async run(t) {
      const before = t.files();
      const c1 = await t.ok<WriteResult>("comment_on", { catalog: "work", description: "Everything about work" });
      const c2 = await t.ok<WriteResult>("comment_on", { catalog: "work", schema: "planning", description: "" });
      const db = await t.ok<{ catalogs: { description?: string; schemas: { description?: string }[] }[] }>("describe_database");
      expect(db.catalogs[0]!.description).toBe("Everything about work");
      expect(db.catalogs[0]!.schemas[0]!.description).toBeUndefined();
      expect((await t.ok<Rows>("select_rows", { table: "system.information_schema.catalogs" })).rows[0]!.comment).toBe("Everything about work");
      expect(await t.refused("comment_on", { catalog: "nope", description: "x" })).toBe('unknown catalog "nope" (catalogs: work)');
      expect(await t.refused("comment_on", { catalog: "work", schema: "nope", description: "x" })).toContain('"nope"');
      await undoBackTo(t, before, c1.migration_id, c2.migration_id);

      // configuration: returned as describe_database, not journaled, reverted by calling again
      const tz = await t.ok<{ config: Record<string, unknown>; migration_id?: string }>("configure_database", { timezone: "UTC", archive_folder: "_old" });
      expect(tz.config).toMatchObject({ timezone: "UTC", archive_folder: "_old" });
      expect(tz.migration_id).toBeUndefined();
      expect(await t.refused("configure_database", { timezone: "Mars/Olympus" })).toBe('"timezone" must be an IANA time zone such as Europe/Rome');
      await t.ok("configure_database", { timezone: "Europe/Rome", archive_folder: "_archive" });
      expect(t.files()).toEqual(before);

      // the root folder: every table follows, and back
      const moved = await t.ok<{ root: string; metastore: string }>("configure_database", { root: "Data" });
      expect(moved).toMatchObject({ root: "Data", metastore: "Data/metastore.yaml" });
      expect(t.exists("datanotes/metastore.yaml")).toBe(false);
      expect(Object.keys(t.files()).filter((p) => p.startsWith("Data/"))).toHaveLength(21);
      expect((await t.ok<Rows>("select_rows", { table: "task", where: { title: "Pick a query engine" } })).rows[0]!.path).toBe("Data/work/planning/task/Pick a query engine.md");
      const row = await t.ok<WriteResult>("insert_row", { table: "task", values: { title: "Rename the folder back", project: "[[Data platform]]" }, dry_run: true });
      expect(row.planned_creates).toEqual(["Data/work/planning/task/Rename the folder back.md"]);
      await t.ok("configure_database", { root: "datanotes" });
      expect(t.files()).toEqual(before);
    },
  },
];
