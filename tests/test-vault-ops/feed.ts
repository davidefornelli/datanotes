/**
 * The change feed on the test vault: engine writes as numbered events, with their actor and
 * migration; filters, cursors and the long poll. Hand edits: hand-edits.ts; webhooks: webhooks.ts.
 */

import { expect } from "vitest";
import { until } from "../helpers/test-vault";
import { head, project, task, type FeedPage, type Scenario, type WriteResult } from "./harness";

export const scenarios: Scenario[] = [
  {
    name: "list_changes: engine writes with actor and migration, cursors, filters, and the long poll",
    ops: ["list_changes"],
    async run(t) {
      expect(await t.ok("list_changes")).toEqual({ events: [], last: 0, head: 0 });
      // a long poll waits for the next change
      const started = Date.now();
      const poll = t.call("list_changes", { since: 0, wait_ms: 10_000, tables: ["task"] });
      await new Promise((r) => setTimeout(r, 150));
      const ins = await t.ok<WriteResult>("insert_row", { table: "task", values: { title: "Benchmark the engines", project: "[[Data platform]]", assignee: "[[Alan Turing]]" } });
      const polled = await poll;
      expect(polled.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      const first = (polled.value as FeedPage).events[0]!;
      expect(first).toMatchObject({
        seq: 1,
        table: "work.planning.task",
        kind: "insert",
        op: "insert_row",
        path: task("Benchmark the engines"),
        source: "engine",
        actor: { harness: "test-vault-ops" },
        migration_id: ins.migration_id,
        changes: { title: { after: "Benchmark the engines" }, status: { after: "todo" } },
      });
      const paused = await t.ok<WriteResult>("update_row", { table: "project", path: project("Office move"), set: { status: "active" } });
      await t.ok("update_row", { table: "task", path: task("Pick a query engine"), set: { priority: "high" } });
      await t.ok("add_column", { table: "task", column: { name: "effort", type: "integer", description: "Hours of work the task takes" } });

      await until(async () => (await head(t)) === 4, 5000, "the schema event"); // recorded a moment after the write
      const all = await t.ok<FeedPage>("list_changes");
      expect(all.events.map((e) => `${e.seq} ${e.kind} ${e.table}`)).toEqual(["1 insert work.planning.task", "2 update work.planning.project", "3 update work.planning.task", "4 metastore null"]);
      expect(all.events[3]!.path).toBe("datanotes/metastore.yaml");
      expect(all).toMatchObject({ last: 4, head: 4 });
      expect(all.events[1]).toMatchObject({ changes: { status: { before: "paused", after: "active" } }, migration_id: paused.migration_id });
      const pick = (args: Record<string, unknown>) => t.ok<FeedPage>("list_changes", args).then((p) => p.events.map((e) => e.seq));
      expect(await pick({ tables: ["project"] })).toEqual([2]);
      expect(await pick({ kinds: ["insert", "metastore"] })).toEqual([1, 4]);
      expect(await pick({ columns: ["priority"] })).toEqual([1, 3, 4]); // inserts and schema events pass a column filter
      expect(await pick({ where: { status: "active" } })).toEqual([2]);
      expect(await pick({ exclude_actor: "test-vault-ops" })).toEqual([]);
      const paged = await t.ok<FeedPage>("list_changes", { limit: 2 });
      expect(paged).toMatchObject({ last: 2, head: 4 });
      expect(await pick({ since: paged.last })).toEqual([3, 4]);
      // nothing new: the long poll returns empty when its time is up
      const idle = Date.now();
      expect(await t.ok("list_changes", { since: 4, wait_ms: 300 })).toEqual({ events: [], last: 4, head: 4 });
      expect(Date.now() - idle).toBeGreaterThanOrEqual(250);
      expect(await t.refused("list_changes", { kinds: ["explode"] })).toBe('list_changes: "kinds": item "explode" must be "insert", "update", "delete", "move", "metastore", "tool_call" or "unreadable"');
    },
  },
];
