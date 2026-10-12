/**
 * Webhooks on the test vault: the change feed pushed to a local receiver, signed, filtered, with hand
 * edits and their violations; a failing receiver reported; webhooks listed and deleted.
 */

import { createHmac } from "node:crypto";
import { expect } from "vitest";
import { receiver, until } from "../helpers/test-vault";
import { head, task, type FeedEvent, type Scenario } from "./harness";

export const scenarios: Scenario[] = [
  {
    name: "webhooks: signed batches to a local receiver, hand edits included, a failing receiver reported, deleted",
    ops: ["create_webhook", "list_webhooks", "delete_webhook"],
    timeout: 30_000,
    async run(t) {
      const ok = await receiver();
      const down = await receiver(() => ({ status: 500, body: "{}" }));
      try {
        type Hook = { id: string; url: string; secret?: string; cursor: number; status: string; failures: number; last_error?: string; last_delivery?: string };
        const hook = await t.ok<Hook>("create_webhook", { url: `${ok.url}/datanotes`, tables: ["task"], kinds: ["insert", "update"] });
        expect(hook).toMatchObject({ url: `${ok.url}/datanotes`, cursor: 0, status: "ok", failures: 0 });
        expect(hook.secret).toMatch(/^[0-9a-f]{48}$/);
        const listed = await t.ok<{ webhooks: Hook[] }>("list_webhooks");
        expect(listed.webhooks).toHaveLength(1);
        expect(listed.webhooks[0]).not.toHaveProperty("secret");

        await t.ok("insert_row", { table: "project", values: { name: "Search", kind: "workstream", parent: "[[Data platform]]" } }); // not a task: not sent
        await t.ok("update_row", { table: "task", path: task("Pick a query engine"), set: { priority: "high" } });
        await until(() => ok.received.length >= 1, 10_000, "the first delivery");
        const first = ok.received[0]!;
        expect(first.headers["x-datanotes-signature"]).toBe(`sha256=${createHmac("sha256", hook.secret!).update(first.body).digest("hex")}`);
        const payload = JSON.parse(first.body) as { webhook: string; events: FeedEvent[]; last: number };
        expect(payload.webhook).toBe(hook.id);
        expect(payload.events.map((e) => `${e.kind} ${e.op} ${e.path}`)).toEqual([`update update_row ${task("Pick a query engine")}`]);
        expect(payload.events[0]!.changes).toEqual({ priority: { before: "medium", after: "high" } });

        // a hand edit reaches the receiver too, with what it breaks
        t.handEdit(task("Export the old pages"), t.read(task("Export the old pages")).replace("status: todo", "status: done"));
        await until(() => ok.received.some((r) => r.body.includes('"source":"external"')), 10_000, "the hand edit delivered");
        const edit = (JSON.parse(ok.received.find((r) => r.body.includes('"source":"external"'))!.body) as { events: FeedEvent[] }).events.find((e) => e.source === "external")!;
        expect(edit).toMatchObject({ path: task("Export the old pages"), violations: [{ path: task("Export the old pages"), violations: [{ code: "check", constraint: "done_has_date" }] }] });
        await t.ok("update_row", { table: "task", path: task("Export the old pages"), set: { status: "todo" } });

        const delivered = await until(async () => {
          const h = (await t.ok<{ webhooks: Hook[] }>("list_webhooks")).webhooks.find((w) => w.id === hook.id)!;
          return h.last_delivery && h.cursor === (await head(t)) ? h : undefined;
        }, 10_000, "the cursor at the head");
        expect(delivered).toMatchObject({ status: "ok", failures: 0 });

        // a receiver that answers 500: the webhook is failing, retried later
        const failing = await t.ok<Hook>("create_webhook", { url: down.url, tables: ["task"] });
        await t.ok("update_row", { table: "task", path: task("Pick a query engine"), set: { priority: "medium" } });
        const reported = await until(async () => (await t.ok<{ webhooks: Hook[] }>("list_webhooks")).webhooks.find((w) => w.id === failing.id && w.status === "failing"), 10_000, "the failure reported");
        expect(reported.failures).toBeGreaterThanOrEqual(1);
        expect(reported.last_error).toContain("500");
        expect(down.received.length).toBeGreaterThanOrEqual(1);

        expect(await t.ok("delete_webhook", { id: failing.id })).toEqual({ deleted: true });
        expect(await t.ok("delete_webhook", { id: hook.id })).toEqual({ deleted: true });
        expect(await t.ok("list_webhooks")).toEqual({ webhooks: [] });
        expect(await t.refused("delete_webhook", { id: hook.id })).toBe(`no webhook ${hook.id}`);
        expect(await t.refused("create_webhook", { url: "ftp://example.com/x" })).toBe('"url" must be an http(s) URL');
      } finally {
        await ok.close();
        await down.close();
      }
    },
  },
];
