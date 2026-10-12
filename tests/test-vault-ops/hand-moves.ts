/**
 * Notes renamed or moved by hand on the test vault (a file manager, git, a sync tool): the engine
 * rewrites every link to the old path across the vault, rows and plain notes alike, as one
 * operation undo takes back, and reports it on the change feed after the move it follows. With the
 * setting off, the links stay and the move reports what they break; the inverse links never double.
 * A rename in case only keeps one file on disk and one row.
 */

import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { until, type TestVault } from "../helpers/test-vault";
import { head, MEETINGS, nextEventAbout, person, project, TABLE_DIR, task, type FeedEvent, type FeedPage, type Rows, type Scenario, type WriteResult, flatViolations } from "./harness";

type Migrations = { migrations: { migration_id: string; op: string; summary: string }[] };

const ADA = person("Ada Lovelace");
const KING = person("Ada King");

/** The members of a project, as select_rows reads them. */
async function members(t: TestVault, name: string): Promise<unknown> {
  return (await t.ok<Rows>("select_rows", { table: "project", where: { name }, columns: ["members"] })).rows[0]!.members;
}

/** The events after `since` until `n` of them come from the operation `op`. */
async function eventsOf(t: TestVault, since: number, op: string, n: number): Promise<FeedEvent[]> {
  return until(
    async () => {
      const events = (await t.ok<FeedPage>("list_changes", { since, wait_ms: 1000 })).events.filter((e) => e.op === op);
      return events.length >= n ? events : undefined;
    },
    15_000,
    `${n} events of ${op}`,
  );
}

export const scenarios: Scenario[] = [
  {
    name: "a row renamed by hand: every link to it follows, in rows and plain notes, as one operation undo takes back (Ada Lovelace to Ada King)",
    ops: ["list_changes", "list_migrations", "undo_migration", "select_rows"],
    timeout: 40_000,
    async run(t) {
      const since = await head(t);
      await t.handMove(ADA, KING);
      // the move breaks nothing: its links are repaired once the vault is quiet, as after an engine rename
      const move = await nextEventAbout(t, since, KING);
      expect(move).toMatchObject({ kind: "move", source: "external", old_path: ADA, violations: [] });
      // then the repair's writes, each naming the move it follows
      const repaired = await eventsOf(t, since, "repair_links", 3);
      expect(repaired.map((e) => e.path).sort()).toEqual([project("Content migration"), project("Website relaunch"), task("Export the old pages")]);
      for (const e of repaired) expect(e).toMatchObject({ source: "engine", kind: "update", cause: [{ path: KING, old_path: ADA, seq: move.seq }] });
      expect(repaired.every((e) => e.seq > move.seq)).toBe(true);
      // Ada once in each project (the inverse links do not add her again), in the task, and in the meeting note
      expect(await members(t, "Website relaunch")).toEqual(["[[Ada King]]", "[[Edith Clarke]]"]);
      expect(await members(t, "Content migration")).toEqual(["[[Ada King]]"]);
      expect(t.read(task("Export the old pages"))).toContain('assignee: "[[Ada King]]"');
      expect(t.read(MEETINGS[0]!)).toContain('  - "[[Ada King]]"\n');
      expect(Object.entries(t.files()).filter(([, text]) => text.includes("Ada Lovelace]]")).map(([p]) => p)).toEqual([]);

      // one journal entry, which undo takes back: the links name the old file again
      const [entry] = (await t.ok<Migrations>("list_migrations", { limit: 1 })).migrations;
      expect(entry).toMatchObject({ op: "repair_links", summary: `repair the links after the hand move of ${ADA} to ${KING}` });
      await t.ok("undo_migration", { migration_id: entry!.migration_id });
      expect(await members(t, "Website relaunch")).toEqual(["[[Ada Lovelace]]", "[[Edith Clarke]]"]);
      expect(t.read(MEETINGS[0]!)).toContain('  - "[[Ada Lovelace]]"\n');

      // renamed back by hand, the links work again: nothing to repair, nothing written
      const back = await head(t);
      await t.handMove(KING, ADA);
      expect(await nextEventAbout(t, back, ADA)).toMatchObject({ kind: "move", old_path: KING, violations: [] });
      expect((await t.ok<Migrations>("list_migrations", { limit: 1 })).migrations[0]!.op).toBe("undo_migration");
    },
  },
  {
    name: "a plain note moved by hand to another folder (its name kept): links to it by path and Markdown links follow",
    ops: ["list_migrations"],
    timeout: 30_000,
    async run(t) {
      const kickoff = MEETINGS[0]!;
      const moved = "Meetings/2026/2026-09-02 Website kickoff.md";
      t.handEdit("Welcome.md", `${t.read("Welcome.md")}\nThe first meeting: [[Meetings/2026-09-02 Website kickoff|the kickoff]], also [as a Markdown link](Meetings/2026-09-02%20Website%20kickoff.md).\n`);
      await t.handMove(kickoff, moved);
      const entry = await until(async () => (await t.ok<Migrations>("list_migrations", { limit: 1 })).migrations.find((m) => m.op === "repair_links"), 15_000, "the repair");
      expect(entry.summary).toBe(`repair the links after the hand move of ${kickoff} to ${moved}`);
      // in the vault's link format, as a rename by the engine writes them: the shortest unique path
      const welcome = t.read("Welcome.md");
      expect(welcome).toContain("The first meeting: [[2026-09-02 Website kickoff|the kickoff]], also [as a Markdown link](2026-09-02%20Website%20kickoff.md).");
    },
  },
  {
    name: "repairLinksOnHandMove off: the move reports the links it breaks, nothing is rewritten, and the inverse links do not double",
    // the inverse links of hand edits are kept by the engine runtime following the vault (the service)
    hosts: ["service"],
    open: async () => ({ options: { settings: { repairLinksOnHandMove: false } }, close: async () => {} }),
    ops: ["list_changes", "list_migrations", "select_rows"],
    timeout: 40_000,
    async run(t) {
      const at = new Date().toISOString();
      let since = await head(t);
      await t.handMove(ADA, KING);
      const move = await nextEventAbout(t, since, KING);
      expect(flatViolations(move.violations).map((v) => `${v.path} ${v.code}`).sort()).toEqual([
        `${project("Content migration")} broken_link`,
        `${project("Website relaunch")} broken_link`,
        `${task("Export the old pages")} broken_link`,
      ]);
      // renamed back, then renamed and edited at once: seen as a delete and a create of the same row
      since = await head(t);
      await t.handMove(KING, ADA);
      await nextEventAbout(t, since, ADA);
      since = await head(t);
      const abs = (rel: string) => path.join(t.root, ...rel.split("/"));
      fs.writeFileSync(abs(KING), t.read(ADA).replace("ada@example.com", "ada.king@example.com"));
      fs.rmSync(abs(ADA));
      expect(await nextEventAbout(t, since, KING)).toMatchObject({ kind: "move", old_path: ADA });
      // the engine mirrors hand-edited links about 2 s later: Ada stays once in each project, her old link
      await new Promise((r) => setTimeout(r, 3000));
      expect(await members(t, "Website relaunch")).toEqual(["[[Ada Lovelace]]", "[[Edith Clarke]]"]);
      expect(await members(t, "Content migration")).toEqual(["[[Ada Lovelace]]"]);
      expect((await t.ok<Migrations>("list_migrations", { since: at })).migrations).toEqual([]);
      // renamed back: the vault is valid again
      since = await head(t);
      await t.handMove(KING, ADA);
      await nextEventAbout(t, since, ADA);
    },
  },
  {
    name: "a rename in case only (update_row, then by hand): one file on disk and one row, links follow",
    ops: ["update_row", "select_rows", "list_changes"],
    timeout: 30_000,
    async run(t) {
      const lower = task("Pick a query engine");
      const upper = task("Pick a Query engine");
      const onDisk = () => fs.readdirSync(path.join(t.root, ...TABLE_DIR.task.split("/"))).filter((n) => n.toLowerCase() === "pick a query engine.md");
      const rows = async () => (await t.ok<Rows>("select_rows", { table: "task", columns: ["title"] })).rows.map((r) => r.path).filter((p) => p.toLowerCase() === lower.toLowerCase());
      t.handEdit("Welcome.md", `${t.read("Welcome.md")}\nNext: [[Pick a query engine]].\n`);
      const r = await t.ok<WriteResult>("update_row", { table: "task", path: lower, set: { title: "Pick a Query engine" } });
      expect(r.planned_moves).toEqual([{ from: lower, to: upper }]);
      expect(onDisk()).toEqual(["Pick a Query engine.md"]);
      expect(await rows()).toEqual([upper]);
      // the host's rename relinks it in the new case (the fake vault of the in-memory tests does not
      // relink): links ignore case, so it leads to the task either way
      expect(t.read("Welcome.md")).toMatch(/Next: \[\[Pick a [qQ]uery engine\]\]\./);
      // the watcher sees the engine's own rename: still one row
      await new Promise((r) => setTimeout(r, 1000));
      expect(await rows()).toEqual([upper]);
      // by hand, back in case only: a rename of the same row, the links follow
      const since = await head(t);
      await t.handMove(upper, lower);
      expect(await nextEventAbout(t, since, lower)).toMatchObject({ kind: "move", old_path: upper, violations: [] });
      expect(onDisk()).toEqual(["Pick a query engine.md"]);
      expect(await rows()).toEqual([lower]);
      await until(() => t.read("Welcome.md").includes("Next: [[Pick a query engine]]."), 10_000, "the link in its old case");
      await t.ok("update_row", { table: "task", path: lower, set: { title: "Pick a query engine" } });
      expect(onDisk()).toEqual(["Pick a query engine.md"]);
      expect(await rows()).toEqual([lower]);
    },
  },
];
