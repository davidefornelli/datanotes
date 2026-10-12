/**
 * Row writes on the test vault, one row or a filtered set at a time: insert and update, each refused
 * with its reason when it breaks a rule, and undone back to the exact previous files. Deletes:
 * rows-delete.ts.
 */

import { expect } from "vitest";
import { expectFiles, person, project, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

export const scenarios: Scenario[] = [
  {
    name: "insert_row: defaults, ids, body, inverse links; every rule refused with its reason, a CHECK through a link among them; undo",
    ops: ["insert_row", "undo_migration"],
    async run(t) {
      const before = t.files();
      const values = { title: "Write the tests", project: "[[Data platform]]", assignee: "[[Ada Lovelace]]", priority: "high", due: "2026-12-01" };
      const dry = await t.ok<WriteResult>("insert_row", { table: "task", values, dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, planned_creates: [task("Write the tests")] });
      expect(t.exists(task("Write the tests"))).toBe(false);

      const ins = await t.ok<WriteResult>("insert_row", { table: "task", values, body: "Cover every operation.\n" });
      expect(ins.planned_creates).toEqual([task("Write the tests")]);
      const text = t.read(task("Write the tests"));
      expect(text).toMatch(/^---\ntable: work\.planning\.task\nid: [0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\n/);
      expect(text).toContain("\nstatus: todo\n"); // the column's default
      expect(text.endsWith("---\nCover every operation.\n")).toBe(true);
      const row = (await t.ok<Rows>("select_rows", { table: "task", where: { title: "Write the tests" } })).rows[0]!;
      expect(row).toMatchObject({ ...values, status: "todo", path: task("Write the tests") });

      // a new workstream at the level ref_by gives it, a task on it (the CHECK reads its kind through the link)
      const ws = await t.ok<WriteResult>("insert_row", { table: "project", values: { name: "Search", kind: "workstream", parent: "[[Data platform]]" } });
      const onWs = await t.ok<WriteResult>("insert_row", { table: "task", values: { title: "Index the docs", project: "[[Search]]" } });
      // a person on a project: the project lists the person too (inverse links kept in step)
      const barbara = await t.ok<WriteResult>("insert_row", { table: "person", values: { name: "Barbara Liskov", role: "engineer", projects: ["[[Office move]]"] } });
      expect(t.read(project("Office move"))).toContain('members:\n  - "[[Grace Hopper]]"\n  - "[[Barbara Liskov]]"\n');

      const refusals: [string, Record<string, unknown>, string][] = [
        ["task", { title: "Pick a query engine", project: "[[Data platform]]" }, "title must be unique (also used by datanotes/work/planning/task/Pick a query engine.md)"],
        ["task", { title: "Plan", project: "[[Data platform]]", priority: "urgent" }, "priority must be one of: low; medium; high"],
        ["task", { title: "Plan", project: "[[Data platform]]", estimate_h: 100 }, "estimate_h must be <= 80"],
        ["task", { title: "Plan" }, "project is required"],
        ["task", { title: "Plan", project: "[[Data platform]]", assignee: "[[Nobody]]" }, "assignee link does not resolve: Nobody"],
        ["task", { title: "Plan the year", project: "[[Engineering]]" }, "not_on_an_area violates CHECK not_on_an_area"],
        ["task", { title: "Ship it", project: "[[Website relaunch]]", status: "done" }, "done_has_date violates CHECK done_has_date"],
        ["project", { name: "Hiring", kind: "workstream", parent: "[[Operations]]" }, 'parent [[Operations]] is not a valid parent for kind "workstream" (needs kind project); valid: Data platform, Office move, Website relaunch'],
        ["project", { name: "Hiring", kind: "area", parent: "[[Operations]]" }, 'parent must be empty for kind "area": it is a top level (no parent)'],
        ["project", { name: "Hiring", kind: "project", parent: "[[Hiring]]" }, "parent"],
      ];
      const now = t.files();
      for (const [table, v, reason] of refusals) {
        const r = await t.refused("insert_row", { table, values: v });
        expect(r.startsWith("insert_row refused — nothing was written:"), r).toBe(true);
        expect(r).toContain(reason);
      }
      expect(await t.refused("insert_row", { table: "task", values: { title: "Plan", project: "[[Data platform]]", colour: "red" } })).toBe('unknown column "colour" for table "task"');
      expectFiles(t, now);
      await undoBackTo(t, before, ins.migration_id, ws.migration_id, onWs.migration_id, barbara.migration_id);
    },
  },
  {
    name: "update_row and update_rows: set, unset, body sections, compare-and-set, rules re-checked through links; undo restores every byte",
    ops: ["update_row", "update_rows", "undo_migration"],
    async run(t) {
      const before = t.files();
      const u1 = await t.ok<WriteResult>("update_row", { table: "task", path: task("Pick a query engine"), set: { priority: "high", estimate_h: 16 }, unset: ["assignee"] });
      expect(u1.planned_edits).toEqual([{ path: task("Pick a query engine"), set: { priority: "high", estimate_h: 16 }, remove: ["assignee"] }]);
      const text = t.read(task("Pick a query engine"));
      expect(text).toContain("\npriority: high\n");
      expect(text).toContain("\nestimate_h: 16\n");
      expect(text).not.toContain("assignee:");

      // by id
      const grace = (await t.ok<Rows>("select_rows", { table: "person", where: { name: "Grace Hopper" } })).rows[0]!;
      const u2 = await t.ok<WriteResult>("update_row", { table: "person", id: grace.id, set: { email: "grace@navy.example" } });
      expect(t.read(person("Grace Hopper"))).toContain("\nemail: grace@navy.example\n");
      await t.refused("update_row", { table: "person", id: grace.id, path: person("Ada Lovelace"), set: { email: "x@example.com" } });
      expect(await t.refused("update_row", { table: "task", path: task("Nope"), set: { priority: "high" } })).toBe(`task has no row at ${task("Nope")}`);

      // the body: one section replaced, the rest kept; text added at the end
      const u3 = await t.ok<WriteResult>("update_row", {
        table: "project",
        path: project("Website relaunch"),
        body_sections: { Risks: "The old URLs must keep working.\nThe launch post is late." },
        body_append: "## Decisions\n\nShip in November.",
      });
      const body = (await t.ok<Rows>("select_rows", { table: "project", where: { name: "Website relaunch" }, columns: ["name"], include_body: true })).rows[0]!.body as string;
      expect(body).toContain("## Goals\n\nA faster site on the new design system.\n");
      expect(body).toContain("## Risks\n");
      expect(body).toContain("The launch post is late.");
      expect(body.indexOf("## Decisions")).toBeGreaterThan(body.indexOf("The launch post is late."));
      expect(body.match(/## Risks/g)).toHaveLength(1);

      // compare-and-set: written only if the row still has the values the caller read
      expect(await t.refused("update_row", { table: "task", path: task("Redirect the old URLs"), set: { assignee: "[[Ada Lovelace]]" }, expect: { status: "doing" } })).toContain(
        'row changed: expected status = "doing", found "todo" — read it again',
      );
      const u4 = await t.ok<WriteResult>("update_row", { table: "task", path: task("Redirect the old URLs"), set: { assignee: "[[Ada Lovelace]]" }, expect: { status: "todo" } });

      // many rows: the where follows the link to the project
      const u5 = await t.ok<WriteResult>("update_rows", { table: "task", where: { "project.kind": "workstream", status: "todo" }, set: { priority: "low" }, expect_count: 2 });
      expect(u5.planned_edits.map((p) => p.path)).toEqual([task("Export the old pages")]); // Redirect the old URLs is low already: matched, not rewritten
      expect(u5.notes_changed).toBe(1);
      expect(await t.refused("update_rows", { table: "task", where: { status: "todo" }, set: { priority: "low" }, expect_count: 2 })).toBe(`update_rows refused — nothing was written:\nconflict datanotes/work/planning/task: "where" matched 4 rows, expected 2: nothing was written`);
      const done = await t.refused("update_rows", { table: "task", where: { status: "todo" }, set: { status: "done" } });
      expect(done.match(/violates CHECK done_has_date/g)).toHaveLength(4);
      // changing a linked row re-checks the rows that link to it: Data platform cannot become an area
      const area = await t.refused("update_row", { table: "project", path: project("Data platform"), set: { kind: "area" }, unset: ["parent"] });
      expect(area).toContain(`invalid ${task("Pick a query engine")}: not_on_an_area violates CHECK not_on_an_area`);
      expect(area).toContain("(after this change to [[Data platform]], a row it links to)");
      expect(area).toContain(`invalid ${project("Ingestion")}`); // a workstream's parent must be a project
      const u6 = await t.ok<WriteResult>("update_row", { table: "task", path: task("Find the new office"), body: "Three offices to visit.\n" });
      expect(t.read(task("Find the new office")).endsWith("---\nThree offices to visit.\n")).toBe(true);

      await undoBackTo(t, before, u1.migration_id, u2.migration_id, u3.migration_id, u4.migration_id, u5.migration_id, u6.migration_id);
    },
  },
  {
    name: "automatic links: a body links the people and projects it names; a doubtful name is asked about; off for one write; undo",
    ops: ["insert_row", "update_row", "undo_migration"],
    async run(t) {
      type Linked = WriteResult & { links_added?: { text: string; target: string; link: string }[]; ambiguous_mentions?: { text: string; reason: string; candidates: string[] }[] };
      const before = t.files();
      const values = { title: "Review the slides", project: "[[Website relaunch]]" };
      const body = "Ask Ada Lovelace and grace hopper about the design system.\n";
      const dry = await t.ok<Linked>("insert_row", { table: "task", values, body, dry_run: true });
      expect(dry.links_added?.map((l) => l.target)).toEqual([person("Ada Lovelace"), person("Grace Hopper"), project("Design system")]);
      expect(t.exists(task("Review the slides"))).toBe(false);

      const ins = await t.ok<Linked>("insert_row", { table: "task", values, body });
      expect(ins.links_added?.map((l) => l.link)).toEqual(["[[Ada Lovelace]]", "[[Grace Hopper|grace hopper]]", "[[Design system|design system]]"]);
      expect(t.read(task("Review the slides")).endsWith("---\nAsk [[Ada Lovelace]] and [[Grace Hopper|grace hopper]] about the [[Design system|design system]].\n")).toBe(true);

      // "Alan Turing Institute": the name of a person inside a longer name
      const asked = await t.ok<Linked>("update_row", { table: "task", path: task("Pick a query engine"), body_append: "Ask the Alan Turing Institute.\n" });
      expect(asked.links_added).toBeUndefined();
      expect(asked.ambiguous_mentions).toMatchObject([{ text: "Alan Turing", reason: "part_of_name", candidates: [person("Alan Turing")] }]);
      expect(t.read(task("Pick a query engine")).endsWith("\nAsk the Alan Turing Institute.\n")).toBe(true);

      // the agent decides, and writes the text as it wants it
      const off = await t.ok<Linked>("update_row", { table: "task", path: task("Pick a query engine"), body_append: "Edith Clarke reviews the choice.\n", autolink: false });
      expect(off.links_added).toBeUndefined();
      expect(t.read(task("Pick a query engine")).endsWith("\nEdith Clarke reviews the choice.\n")).toBe(true);

      await undoBackTo(t, before, ins.migration_id, asked.migration_id, off.migration_id);
    },
  },
];
