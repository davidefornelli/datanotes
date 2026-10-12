/**
 * Deleting rows on the test vault: archived or trashed, refused while other notes link to them, the
 * links cleared or left dangling, undone exactly.
 */

import { expect } from "vitest";
import type { TestVault } from "../helpers/test-vault";
import { MEETINGS, person, project, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

/** The rows that link to Ada Lovelace, once she is gone. */
const ADA_LINKS = [
  `${project("Content migration")} members[0]:broken_link`,
  `${project("Website relaunch")} members[0]:broken_link`,
  `${task("Export the old pages")} assignee:broken_link`,
];

async function danglingLinks(t: TestVault): Promise<string[]> {
  const check = await t.ok<{ violations: { path: string; violations: { column: string; index?: number; code: string }[] }[] }>("check_table", {});
  return check.violations.flatMap((v) => v.violations.map((x) => `${v.path} ${x.column}${x.index !== undefined ? `[${x.index}]` : ""}:${x.code}`)).sort();
}

export const scenarios: Scenario[] = [
  {
    name: "delete_rows: archive or trash, rows other notes link to refused, cleared or left dangling; undo",
    ops: ["delete_rows", "undo_migration", "check_table"],
    async run(t) {
      const before = t.files();
      const refused = await t.refused("delete_rows", { table: "person", where: { name: "Ada Lovelace" } });
      expect(refused).toContain(`conflict ${person("Ada Lovelace")}: referenced by`);
      for (const p of [project("Content migration"), project("Website relaunch"), task("Export the old pages"), MEETINGS[0]!]) expect(refused).toContain(p);

      const dry = await t.ok<WriteResult>("delete_rows", { table: "task", where: { status: "done" }, dry_run: true });
      expect(dry.planned_moves.map((m) => m.to).sort()).toEqual(["datanotes/work/planning/task/_archive/Choose the colour palette.md", "datanotes/work/planning/task/_archive/Load the sales events.md"]);
      expect(t.files()).toEqual(before);

      const archived = await t.ok<WriteResult>("delete_rows", { table: "task", where: { title: "Find the new office" } });
      expect(archived.planned_moves).toEqual([{ from: task("Find the new office"), to: "datanotes/work/planning/task/_archive/Find the new office.md" }]);
      expect(t.exists("datanotes/work/planning/task/_archive/Find the new office.md")).toBe(true);
      expect((await t.ok<Rows>("select_rows", { table: "task" })).total).toBe(7); // an archived note is no row
      await undoBackTo(t, before, archived.migration_id);

      const trashed = await t.ok<WriteResult>("delete_rows", { table: "task", where: { title: "Redirect the old URLs" }, mode: "delete" });
      expect(trashed.planned_deletes).toEqual([task("Redirect the old URLs")]);
      expect(t.exists(task("Redirect the old URLs"))).toBe(false);
      await undoBackTo(t, before, trashed.migration_id);

      // set_null: the links to Grace are cleared everywhere, in rows and in plain notes
      const cleared = await t.ok<WriteResult>("delete_rows", { table: "person", where: { name: "Grace Hopper" }, on_referenced: "set_null" });
      expect(Object.fromEntries(cleared.planned_edits.map((p) => [p.path, p.set]))).toEqual({
        [project("Data platform")]: { members: ["[[Alan Turing]]"] },
        [project("Office move")]: { members: [] },
        [task("Write the launch post")]: { assignee: null },
        [task("Find the new office")]: { assignee: null },
        [MEETINGS[1]!]: { attendees: ["[[Alan Turing]]"] },
        [MEETINGS[2]!]: { attendees: ["[[Edith Clarke]]"] },
      });
      expect(t.read(task("Write the launch post"))).toContain("\nassignee: null\n");
      expect(t.read(MEETINGS[2]!)).not.toContain("Grace Hopper");
      expect((await t.ok<{ violations: unknown[] }>("check_table", {})).violations).toEqual([]);
      await undoBackTo(t, before, cleared.migration_id);

      // ignore: refused while a CHECK reads the row through a link (a link to a missing row fails it) ...
      expect(await t.refused("delete_rows", { table: "project", where: { name: "Office move" }, on_referenced: "ignore" })).toContain(
        `invalid ${task("Find the new office")}: not_on_an_area violates CHECK not_on_an_area`,
      );
      // ... otherwise the links are left dangling, and check_table finds them
      const ignored = await t.ok<WriteResult>("delete_rows", { table: "person", where: { name: "Ada Lovelace" }, on_referenced: "ignore", mode: "delete" });
      expect(await danglingLinks(t)).toEqual(ADA_LINKS);
      await undoBackTo(t, before, ignored.migration_id);
    },
  },
  {
    name: "an archived row is no link target: links to it are reported, new ones refused",
    ops: ["delete_rows", "check_table", "insert_row", "undo_migration"],
    async run(t) {
      const before = t.files();
      const archived = await t.ok<WriteResult>("delete_rows", { table: "person", where: { name: "Ada Lovelace" }, on_referenced: "ignore" });
      expect(archived.planned_moves).toEqual([{ from: person("Ada Lovelace"), to: "datanotes/work/planning/person/_archive/Ada Lovelace.md" }]);
      expect((await t.ok<Rows>("select_rows", { table: "person", where: { name: "Ada Lovelace" } })).total).toBe(0);
      // as after mode delete: the links to her are broken_link, a new one is refused, expand leaves them links
      expect(await danglingLinks(t)).toEqual(ADA_LINKS);
      expect(await t.refused("insert_row", { table: "task", values: { title: "Plan", project: "[[Data platform]]", assignee: "[[Ada Lovelace]]" } })).toContain(
        `invalid ${task("Plan")}: assignee link does not resolve: Ada Lovelace`,
      );
      const expanded = await t.ok<Rows>("select_rows", { table: "task", where: { title: "Export the old pages" }, columns: ["assignee"], expand: ["assignee"] });
      expect(expanded.rows[0]!.assignee).toBe("[[Ada Lovelace]]");
      await undoBackTo(t, before, archived.migration_id);
      expect(await danglingLinks(t)).toEqual([]);
    },
  },
];
