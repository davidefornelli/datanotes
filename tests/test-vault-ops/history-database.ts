/**
 * History of the whole database on the test vault (history is on for every table): an agent's run
 * across tables seen in the database's history, read as it was through a view, a join and a base,
 * then rewound with restore_database by time and to just before the run (dry run first), each
 * restore undone back to the same bytes; tables created and dropped since the point, a table
 * without history skipped; a restore refused as a whole by a CHECK across tables.
 */

import { expect } from "vitest";
import { expectFiles, METASTORE, person, pluck, project, task, type Rows, type Scenario, type WriteResult } from "./harness";

const P = "work.planning";
const IDEA = "datanotes/work/planning/idea";
const MILESTONE = "datanotes/work/planning/milestone";

interface Commit {
  table: string;
  version: number;
  timestamp: string;
  operation: string;
  migrationId?: string;
  batch?: string;
  tables?: string[];
}
type DatabaseHistory = { tables: string[]; history: Commit[] };

interface TablePlan {
  table: string;
  action: string;
  version: number | null;
  definition_changed: boolean;
  creates: string[];
  texts: string[];
  deletes: string[];
  archived: { from: string; to: string }[];
}
type Restore = WriteResult & { restored_to: string; tables: TablePlan[]; unchanged: string[]; skipped: { table: string; reason: string }[] };

/** A few milliseconds: commits on either side of a moment get different timestamps. */
const pause = () => new Promise((r) => setTimeout(r, 20));

/** A moment between two writes. */
async function moment(): Promise<string> {
  await pause();
  const at = new Date().toISOString();
  await pause();
  return at;
}

export const scenarios: Scenario[] = [
  {
    name: "an agent's run across tables: the database's history groups it, time travel through a view, a join and a base, restore_database by time and before the run, each undone byte for byte",
    ops: ["batch", "describe_history", "select_rows", "restore_database", "undo_migration", "drop_table", "create_table", "alter_table"],
    timeout: 40_000,
    async run(t) {
      // before the point: a table dropped after it, and a table without history
      await t.ok("create_table", { name: "idea", description: "Ideas for new projects", columns: [{ name: "name", type: "string", required: true, description: "The idea, in a few words" }], filename: "{name}" });
      await t.ok("insert_row", { table: "idea", values: { name: "Dark mode" } });
      await t.ok("create_table", { name: "scratch", description: "Throwaway notes", columns: [{ name: "name", type: "string", description: "The note, in a few words" }], filename: "{name}" });
      await t.ok("alter_table", { table: "scratch", history: false });
      const point = await moment();
      const atPoint = t.files();

      // the agent's run: one batch over three tables, then a table created, one dropped, a write without history
      const run = await t.ok<WriteResult>("batch", {
        summary: "the agent's run",
        operations: [
          { op: "insert_row", table: "task", values: { title: "Plan the beta", project: "[[Website relaunch]]", assignee: "[[Ada Lovelace]]", started_on: "2026-10-01" } },
          { op: "update_row", table: "project", path: project("Website relaunch"), set: { status: "paused" } },
          { op: "update_row", table: "person", path: person("Grace Hopper"), set: { role: "engineer" } },
        ],
      });
      await t.ok("create_table", { name: "milestone", description: "Dates a project must meet", columns: [{ name: "name", type: "string", required: true, description: "What the project must have reached" }, { name: "project", type: "link", ref: `${P}.project`, description: "The project the milestone belongs to" }], filename: "{name}" });
      await t.ok("insert_row", { table: "milestone", values: { name: "Beta online", project: "[[Website relaunch]]" } });
      await t.ok("drop_table", { table: "idea", mode: "archive" });
      await t.ok("insert_row", { table: "scratch", values: { name: "a note" } });
      const afterRun = t.files();

      // the database's history: every logged table, newest first; the batch's commits grouped
      const db = await t.ok<DatabaseHistory>("describe_history", { since: point });
      expect(db.tables).toEqual([`${P}.idea`, `${P}.milestone`, `${P}.person`, `${P}.project`, `${P}.scratch`, `${P}.task`]);
      expect(db.history.slice(0, 3).map((c) => `${c.table} ${c.operation}`)).toEqual([`${P}.idea DROP TABLE`, `${P}.milestone WRITE`, `${P}.milestone CREATE TABLE`]);
      const ofRun = db.history.filter((c) => c.batch === run.migration_id);
      expect(ofRun.map((c) => `${c.table} ${c.operation}`).sort()).toEqual([`${P}.person UPDATE`, `${P}.project UPDATE`, `${P}.task WRITE`]);
      for (const c of ofRun) expect(c.tables).toEqual([`${P}.person`, `${P}.project`, `${P}.task`]);
      expect(db.history).toHaveLength(6); // scratch keeps no log since history went off for it
      expect(db.history[0]!.tables).toBeUndefined(); // one table
      expect((await t.ok<DatabaseHistory>("describe_history", { limit: 2 })).history).toHaveLength(2);
      expect((await t.ok<DatabaseHistory>("describe_history", { since: "2999-01-01" })).history).toEqual([]);
      expect(await t.refused("describe_history", { since: "soon" })).toContain('"since" is not a date or date-time');

      // the database as it was at the point: a view, a join and a base read every table as of then
      const open = await t.ok<Rows & { version: number }>("select_rows", { table: "vw_open_tasks", timestamp: point });
      expect(pluck(open, "title")).not.toContain("Plan the beta");
      expect(pluck(await t.ok<Rows>("select_rows", { table: "vw_open_tasks" }), "title")).toContain("Plan the beta");
      const join = { table: "person", on: { assignee: "file_link" }, as: "who", columns: ["name", "role"] };
      const who = async (args: Record<string, unknown>) =>
        (await t.ok<Rows & { versions?: Record<string, number> }>("select_rows", { table: "task", where: { title: "Write the launch post" }, columns: ["title"], join, ...args }));
      const then = await who({ timestamp: point });
      expect(then.rows[0]!.who).toEqual([{ path: person("Grace Hopper"), name: "Grace Hopper", role: "manager" }]);
      expect(Object.keys(then.versions!)).toEqual([`${P}.person`, `${P}.task`]);
      expect((await who({})).rows[0]!.who[0].role).toBe("engineer");
      expect(await t.refused("select_rows", { table: "task", version: 0, join })).toContain('"version" numbers the versions of one table, and a join reads two tables');
      const dated = async (args: Record<string, unknown>) => t.ok<Rows & { versions?: Record<string, number> }>("select_rows", { table: "base:dated", where: { started_on: { exists: true } }, columns: ["started_on"], order_by: "started_on", ...args });
      const datedThen = await dated({ timestamp: point });
      expect(datedThen.rows.map((r) => r._source)).toEqual([`${P}.project`, `${P}.task`, `${P}.project`]);
      expect(Object.keys(datedThen.versions!)).toEqual([`${P}.project`, `${P}.task`]);
      expect(pluck(await dated({}), "path")).toContain(task("Plan the beta"));
      expect(await t.refused("select_rows", { table: "base:dated", version: 1 })).toContain("base:dated reads every table that extends it");
      expect(await t.refused("select_rows", { table: "system.information_schema.tables", timestamp: point })).toBe("information_schema has no history");

      // restore_database by time: a dry run first, nothing written
      const dry = await t.ok<Restore>("restore_database", { timestamp: point, dry_run: true });
      expect(t.files()).toEqual(afterRun);
      const plan = Object.fromEntries(dry.tables.map((p) => [p.table.split(".").pop(), p]));
      expect(Object.keys(plan)).toEqual(["idea", "milestone", "person", "project", "task"]);
      expect(plan.idea).toMatchObject({ action: "recreate", definition_changed: true, creates: [`${IDEA}/Dark mode.md`] });
      expect(plan.milestone).toMatchObject({ action: "drop", version: null, archived: [{ from: `${MILESTONE}/Beta online.md`, to: `${MILESTONE}/_archive/Beta online.md` }] });
      expect(plan.person).toMatchObject({ action: "restore", definition_changed: false, texts: [person("Grace Hopper")] });
      expect(plan.project).toMatchObject({ action: "restore", texts: [project("Website relaunch")] });
      expect(plan.task).toMatchObject({ action: "restore", deletes: [task("Plan the beta")], creates: [], texts: [] });
      expect(dry.skipped).toEqual([{ table: `${P}.scratch`, reason: expect.stringContaining("history is off for it") }]);
      expect(dry.unchanged).toEqual([]);
      expect(dry.planned_texts[0]).toBe(METASTORE);

      // for real: the rows are back byte for byte (the table without history keeps its new row)
      const restored = await t.ok<Restore>("restore_database", { timestamp: point });
      const now = t.files();
      for (const [path, text] of Object.entries(atPoint)) if (path !== METASTORE) expect(now[path], path).toBe(text);
      expect(Object.keys(now).filter((p) => !(p in atPoint)).sort()).toEqual([
        `${IDEA}/_archive/Dark mode.md`, // archived by the drop, still there
        `${MILESTONE}/_archive/Beta online.md`,
        "datanotes/work/planning/scratch/a note.md",
      ]);
      expect(pluck(await t.ok<Rows>("select_rows", { table: "idea" }), "name")).toEqual(["Dark mode"]);
      expect(await t.refused("select_rows", { table: "milestone" })).toContain("milestone");
      // one RESTORE version per table, one migrationId
      const restores = (await t.ok<DatabaseHistory>("describe_history", { limit: 5 })).history;
      expect(restores.map((c) => `${c.table} ${c.operation}`).sort()).toEqual(["idea", "milestone", "person", "project", "task"].map((n) => `${P}.${n} RESTORE`));
      for (const c of restores) expect(c).toMatchObject({ migration_id: restored.migration_id, tables: ["idea", "milestone", "person", "project", "task"].map((n) => `${P}.${n}`) });
      // restoring to the same moment again changes nothing
      expect(await t.ok<Restore>("restore_database", { timestamp: point, dry_run: true })).toMatchObject({ tables: [], unchanged: ["idea", "milestone", "person", "project", "task"].map((n) => `${P}.${n}`) });
      // undone: every table as after the run, byte for byte
      await t.ok("undo_migration", { migration_id: restored.migration_id });
      expectFiles(t, afterRun);

      // to just before the run (its batch): the same moment, found in the journal
      const rewind = await t.ok<Restore>("restore_database", { before_migration: run.migration_id });
      // the last moment before the run: as a timestamp, it names the same state
      expect(rewind.restored_to).toBe(new Date(Date.parse(ofRun.map((c) => c.timestamp).sort()[0]!) - 1).toISOString());
      expect(rewind.tables.map((p) => `${p.table.split(".").pop()} ${p.action}`)).toEqual(["idea recreate", "milestone drop", "person restore", "project restore", "task restore"]);
      expect(t.read(person("Grace Hopper"))).toBe(atPoint[person("Grace Hopper")]);
      await t.ok("undo_migration", { migration_id: rewind.migration_id });
      // restored_to, given back as a timestamp, names the same moment
      const same = await t.ok<Restore>("restore_database", { timestamp: rewind.restored_to, dry_run: true });
      expect(same.tables.map((p) => `${p.table.split(".").pop()} ${p.action}`)).toEqual(["idea recreate", "milestone drop", "person restore", "project restore", "task restore"]);
      expectFiles(t, afterRun);
      expect(await t.refused("restore_database", { before_migration: "nope" })).toBe("Migration not found: nope");
      expect(await t.refused("restore_database", {})).toContain('pass "timestamp" or "before_migration"');

      // the batch undone on its own: the undos of its operations are grouped too
      const undo = await t.ok<{ migration_id: string }>("undo_migration", { migration_id: run.migration_id });
      const undos = (await t.ok<DatabaseHistory>("describe_history", { limit: 3 })).history;
      expect(undos.map((c) => `${c.table} ${c.operation}`).sort()).toEqual([`${P}.person UNDO`, `${P}.project UNDO`, `${P}.task UNDO`]);
      for (const c of undos) expect(c).toMatchObject({ batch: undo.migration_id, tables: [`${P}.person`, `${P}.project`, `${P}.task`] });
      for (const p of [person("Grace Hopper"), project("Website relaunch")]) expect(t.read(p)).toBe(atPoint[p]);
      expect(t.exists(task("Plan the beta"))).toBe(false);
    },
  },
  {
    name: "restore_database refused as a whole by a CHECK across tables, when a table without history changed since",
    ops: ["alter_table", "update_row", "restore_database"],
    async run(t) {
      await t.ok("alter_table", { table: "project", history: false });
      const point = await moment();
      // the task leaves the office move, which then becomes an area (no task may sit on an area)
      await t.ok("update_row", { table: "task", path: task("Find the new office"), set: { project: "[[Data platform]]" } });
      await t.ok("update_row", { table: "project", path: project("Office move"), set: { kind: "area" }, unset: ["parent"] });
      const files = t.files();
      const dry = await t.call("restore_database", { timestamp: point, dry_run: true });
      expect(dry.ok).toBe(false);
      const refused = await t.refused("restore_database", { timestamp: point });
      expect(refused).toContain("restore_database refused — nothing was written");
      expect(refused).toContain(`invalid ${task("Find the new office")}: not_on_an_area violates CHECK not_on_an_area`);
      expect(refused).toContain("to restore, fix the row first");
      expect(t.files()).toEqual(files);
      // the way out: put the project back first, then the restore goes through
      await t.ok("update_row", { table: "project", path: project("Office move"), set: { kind: "project", parent: "[[Operations]]" } });
      const ok = await t.ok<Restore>("restore_database", { timestamp: point });
      expect(ok.tables.map((p) => p.table)).toEqual([`${P}.task`]);
      expect(ok.skipped.map((s) => s.table)).toEqual([`${P}.project`]);
      expect(t.read(task("Find the new office"))).toContain('project: "[[Office move]]"');
    },
  },
];
