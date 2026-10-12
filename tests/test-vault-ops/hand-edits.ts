/**
 * Hand edits on the test vault: notes changed on disk outside the engine (an editor, git, a sync), as
 * the change feed reports them with the rules they break (on the edited row and on the rows linking to
 * it), as check_table sees them, fixed by engine writes, and as versions of a table with history on.
 */

import { expect } from "vitest";
import { until } from "../helpers/test-vault";
import { head, nextEventAbout, project, task, type FeedPage, type Scenario, flatViolations } from "./harness";

type History = { history: { version: number; operation: string; operation_metrics: Record<string, unknown> }[] };

export const scenarios: Scenario[] = [
  {
    name: "hand edits that break rules: each event lists what it breaks, on the row and on the rows linking to it; check_table agrees; writes fix them",
    ops: ["list_changes", "check_table", "update_row"],
    timeout: 30_000,
    async run(t) {
      // three notes edited at once: a workstream turned into an area (its parent is now wrong, and so
      // are the two tasks on it), a task closed without its date, a task whose new priority is fine
      const since = await head(t);
      t.handEdit(project("Content migration"), t.read(project("Content migration")).replace("kind: workstream", "kind: area"));
      t.handEdit(task("Write the launch post"), t.read(task("Write the launch post")).replace("status: todo", "status: done"));
      t.handEdit(task("Find the new office"), t.read(task("Find the new office")).replace("priority: low", "priority: medium"));
      const area = await nextEventAbout(t, since, project("Content migration"));
      const closed = await nextEventAbout(t, since, task("Write the launch post"));
      const fine = await nextEventAbout(t, since, task("Find the new office"));
      expect(area).toMatchObject({ source: "external", kind: "update", table: "work.planning.project", changes: { kind: { before: "workstream", after: "area" } } });
      expect(area.actor).toBeUndefined();
      expect(flatViolations(area.violations)).toEqual([
        { path: project("Content migration"), code: "ref", column: "parent", message: 'must be empty for kind "area": it is a top level (no parent)' },
        { path: task("Export the old pages"), code: "check", constraint: "not_on_an_area", message: "violates CHECK not_on_an_area (after the edit of [[Content migration]], a row it links to)" },
        { path: task("Redirect the old URLs"), code: "check", constraint: "not_on_an_area", message: "violates CHECK not_on_an_area (after the edit of [[Content migration]], a row it links to)" },
      ]);
      expect(closed).toMatchObject({ source: "external", changes: { status: { before: "todo", after: "done" } } });
      expect(flatViolations(closed.violations)).toEqual([{ path: task("Write the launch post"), code: "check", constraint: "done_has_date", message: "violates CHECK done_has_date" }]);
      expect(fine).toMatchObject({ source: "external", changes: { priority: { before: "low", after: "medium" } }, violations: [] });
      const check = await t.ok<{ violations: { path: string; violations: { code: string }[] }[] }>("check_table", {});
      expect(check.violations.map((v) => `${v.path} ${v.violations.map((x) => x.code).join(",")}`)).toEqual([
        `${project("Content migration")} ref`,
        `${task("Export the old pages")} check`,
        `${task("Redirect the old URLs")} check`,
        `${task("Write the launch post")} check`,
      ]);

      // fixed through the engine: those events have no violations to report
      const before = await head(t);
      await t.ok("update_row", { table: "project", path: project("Content migration"), set: { kind: "workstream" } });
      await t.ok("update_row", { table: "task", path: task("Write the launch post"), set: { done_on: "2026-10-08" } });
      const fixes = await until(async () => {
        const page = await t.ok<FeedPage>("list_changes", { since: before, wait_ms: 2000 });
        return page.events.length >= 2 ? page.events : undefined;
      }, 10_000, "the events of the fixes");
      expect(fixes.map((e) => `${e.source} ${e.path}`)).toEqual([`engine ${project("Content migration")}`, `engine ${task("Write the launch post")}`]);
      expect(fixes.every((e) => e.violations === undefined)).toBe(true);
      expect((await t.ok<{ violations: unknown[] }>("check_table", {})).violations).toEqual([]);
    },
  },
  {
    name: "hand edits become EXTERNAL_EDIT versions, with the rules they break counted",
    // The transaction log of hand edits is kept by the engine runtime following the vault (the
    // service); the in-process host has the route handlers without that runtime.
    hosts: ["service"],
    ops: ["describe_history", "table_changes"],
    timeout: 30_000,
    async run(t) {
      await t.ok("alter_table", { table: "task", history: true });
      await t.ok("update_row", { table: "task", path: task("Write the launch post"), set: { priority: "high" } });
      t.handEdit(task("Write the launch post"), t.read(task("Write the launch post")).replace("status: todo", "status: done"));
      const edit = await until(
        async () => (await t.ok<History>("describe_history", { table: "task" })).history.find((v) => v.operation === "EXTERNAL_EDIT"),
        15_000,
        "an EXTERNAL_EDIT version",
      );
      expect(edit.operation_metrics.violations).toBe(1);
      const changes = (await t.ok<{ changes: { _change_type: string; status?: string }[] }>("table_changes", { table: "task", start_version: edit.version })).changes;
      expect(changes.map((c) => `${c._change_type} ${c.status}`)).toEqual(["update_preimage todo", "update_postimage done"]);
      // the rule it breaks, fixed by a write
      await t.ok("update_row", { table: "task", path: task("Write the launch post"), set: { done_on: "2026-10-08" } });
    },
  },
];
