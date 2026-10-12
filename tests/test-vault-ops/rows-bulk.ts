/**
 * Row writes on many rows or across tables on the test vault: merge (upsert), move to another table,
 * adopting plain notes, recomputing generated columns, aligning inverse links, batches.
 */

import { expect } from "vitest";
import { until } from "../helpers/test-vault";
import { MEETINGS, person, project, task, undoBackTo, type Rows, type Scenario, type WriteResult } from "./harness";

export const scenarios: Scenario[] = [
  {
    name: "merge_rows: upsert by a key, matched rows updated or kept, conflicts refused; undo",
    ops: ["merge_rows", "undo_migration"],
    async run(t) {
      const before = t.files();
      const rows = [
        { title: "Pick a query engine", priority: "high", estimate_h: 4 },
        { title: "Benchmark the engines", project: "[[Data platform]]", assignee: "[[Alan Turing]]" },
      ];
      const dry = await t.ok<WriteResult>("merge_rows", { table: "task", on: ["title"], rows, dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, planned_creates: [task("Benchmark the engines")] });
      expect(t.files()).toEqual(before);
      const merged = await t.ok<WriteResult>("merge_rows", { table: "task", on: ["title"], rows });
      expect(merged.planned_edits).toEqual([{ path: task("Pick a query engine"), set: { priority: "high", estimate_h: 4 }, remove: [] }]);
      expect(merged.planned_creates).toEqual([task("Benchmark the engines")]);
      const now = await t.ok<Rows>("select_rows", { table: "task", where: { title: { in: ["Pick a query engine", "Benchmark the engines"] } }, order_by: "title", columns: ["title", "priority", "status", "assignee"] });
      expect(now.rows.map(({ path: _p, ...r }) => r)).toEqual([
        { title: "Benchmark the engines", priority: null, status: "todo", assignee: "[[Alan Turing]]" },
        { title: "Pick a query engine", priority: "high", status: "doing", assignee: "[[Alan Turing]]" },
      ]);
      // ignore both: nothing to write
      const idle = await t.ok<WriteResult>("merge_rows", { table: "task", on: ["title"], rows: [{ title: "Pick a query engine", priority: "low" }, { title: "Yet another", project: "[[Data platform]]" }], when_matched: "ignore", when_not_matched: "ignore" });
      expect(idle).toMatchObject({ notes_changed: 0, files_created: 0, planned_edits: [], planned_creates: [] });
      // by the system id
      const id = (await t.ok<Rows>("select_rows", { table: "task", where: { title: "Find the new office" } })).rows[0]!.id;
      const byId = await t.ok<WriteResult>("merge_rows", { table: "task", on: ["id"], rows: [{ id, priority: "medium" }], when_not_matched: "ignore" });
      expect(byId.planned_edits).toEqual([{ path: task("Find the new office"), set: { priority: "medium" }, remove: [] }]);
      expect(await t.refused("merge_rows", { table: "task", on: ["title"], rows: [{ title: "Pick a query engine", priority: "low" }, { title: "Pick a query engine", priority: "high" }] })).toContain(
        'conflict rows[1]: repeats key ["Pick a query engine"]',
      );
      // a merged row is validated like an insert: a CHECK through the link refuses it
      expect(await t.refused("merge_rows", { table: "task", on: ["title"], rows: [{ title: "Plan the year", project: "[[Engineering]]" }] })).toContain("not_on_an_area");
      await undoBackTo(t, before, merged.migration_id, byId.migration_id);
    },
  },
  {
    name: "move_rows: a task becomes a someday idea in another table, its unknown keys refused until dropped; undo",
    ops: ["move_rows", "create_table", "undo_migration"],
    async run(t) {
      const before = t.files();
      const made = await t.ok<WriteResult>("create_table", {
        name: "someday",
        columns: [
          { name: "title", type: "string", required: true, unique: true, description: "The idea, in a few words" },
          { name: "project", type: "link", ref: "work.planning.project", description: "The project it would belong to" },
          { name: "importance", type: "enum", values: ["low", "medium", "high"], description: "How much it matters" },
          { name: "reason", type: "string", description: "Why it waits" },
        ],
        filename: "{title}",
        description: "Ideas for later",
      });
      const unknown = await t.refused("move_rows", { table: "task", to_table: "someday", where: { title: "Find the new office" } });
      expect(unknown).toContain('assignee is not a column of table "someday"');
      expect(unknown).toContain('priority is not a column of table "someday"');
      const args = { table: "task", to_table: "someday", where: { title: "Find the new office" }, rename: { priority: "importance" }, drop: ["assignee", "status"], set: { reason: "the lease runs until 2028" } };
      const dry = await t.ok<WriteResult>("move_rows", { ...args, relocate: true, dry_run: true });
      expect(dry.planned_moves).toEqual([{ from: task("Find the new office"), to: "datanotes/work/planning/someday/Find the new office.md" }]);
      const moved = await t.ok<WriteResult>("move_rows", { ...args, relocate: true });
      expect(moved.files_moved).toBe(1);
      const idea = await t.ok<Rows>("select_rows", { table: "someday" });
      expect(idea.rows.map(({ id: _i, ...r }) => r)).toEqual([
        { path: "datanotes/work/planning/someday/Find the new office.md", title: "Find the new office", project: "[[Office move]]", importance: "low", reason: "the lease runs until 2028" },
      ]);
      expect(t.read("datanotes/work/planning/someday/Find the new office.md")).toMatch(/^---\ntable: work\.planning\.someday\n/);
      expect((await t.ok<Rows>("select_rows", { table: "task" })).total).toBe(7);
      await undoBackTo(t, before, made.migration_id, moved.migration_id);
    },
  },
  {
    name: "adopt_rows: the meeting notes become rows of a new table, keys renamed, dropped and set per note; undo puts them back",
    ops: ["adopt_rows", "infer_table", "create_table", "undo_migration"],
    async run(t) {
      const before = t.files();
      const inf = await t.ok<{ proposal: { columns: Record<string, unknown>[]; time_column?: string } }>("infer_table", { folder: "Meetings", name: "meeting" });
      expect(inf.proposal.time_column).toBe("date");
      // the proposal, reviewed: `date` is named held_on, `mood` is left out, a note taker is added, each column described
      const meaning: Record<string, string> = {
        attendees: "The people at the meeting",
        held_on: "The day of the meeting",
        kind: "What kind of meeting it was",
        project: "The project the meeting was about",
      };
      const columns = [
        ...inf.proposal.columns
          .filter((c) => c.name !== "mood")
          .map((c) => (c.name === "date" ? { ...c, name: "held_on" } : c))
          .map((c) => ({ ...c, description: meaning[String(c.name)] })),
        { name: "note_taker", type: "link", ref: "work.planning.person", description: "Who wrote the notes" },
        { name: "status", type: "enum", values: ["planned", "held"], description: "Whether the meeting took place" },
      ];
      const made = await t.ok<WriteResult>("create_table", { name: "meeting", time_column: "held_on", columns, description: "Meetings about the projects" });
      const args = { table: "meeting", paths: MEETINGS, rename: { date: "held_on" }, set: { status: "held" }, per_row: { [MEETINGS[2]!]: { note_taker: "[[Grace Hopper]]" } } };
      const unknown = await t.refused("adopt_rows", args);
      expect(unknown).toContain(MEETINGS[2]);
      expect(unknown).toContain("mood");
      expect(t.files()).toEqual({ ...before, "datanotes/metastore.yaml": t.read("datanotes/metastore.yaml") });
      const dry = await t.ok<WriteResult>("adopt_rows", { ...args, drop: ["mood"], dry_run: true });
      expect(dry.planned_moves.map((m) => m.from)).toEqual(MEETINGS);
      const adopted = await t.ok<WriteResult>("adopt_rows", { ...args, drop: ["mood"] });
      expect(adopted.files_moved).toBe(4);
      const meetings = await t.ok<Rows>("select_rows", { table: "meeting", order_by: "held_on", columns: ["held_on", "kind", "project", "status", "note_taker"] });
      expect(meetings.rows.map(({ path: _p, ...r }) => r)).toEqual([
        { held_on: "2026-09-02", kind: "kickoff", project: "[[Website relaunch]]", status: "held", note_taker: null },
        { held_on: "2026-09-09", kind: "kickoff", project: "[[Data platform]]", status: "held", note_taker: null },
        { held_on: "2026-09-23", kind: "review", project: "[[Website relaunch]]", status: "held", note_taker: "[[Grace Hopper]]" },
        { held_on: "2026-09-30", kind: "review", project: "[[Data platform]]", status: "held", note_taker: null },
      ]);
      expect(meetings.rows.every((r) => r.path.startsWith("datanotes/work/planning/meeting/"))).toBe(true);
      const review = t.read(meetings.rows[2]!.path);
      expect(review).toMatch(/^---\ntable: work\.planning\.meeting\nid: /);
      expect(review).not.toContain("mood");
      expect(review.endsWith("The button component is late; the launch post moves to November.\n")).toBe(true);
      // every row is valid against the new table, links to people and projects included
      expect((await t.ok<{ rows: number; violations: unknown[] }>("check_table", { table: "meeting" })).violations).toEqual([]);
      await undoBackTo(t, before, made.migration_id, adopted.migration_id);
    },
  },
];
