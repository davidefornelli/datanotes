import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ChangeFeed } from "../src/core/change-feed";
import { INDEX_RETRY } from "../src/core/engine";
import { createPublicApi } from "../src/core/public-api";
import { updateRow } from "../src/core/rows";
import { createHandlers } from "../src/server/rest";
import { WebhookDispatcher, type Post } from "../src/server/webhooks";
import { logVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

async function setup(post: Post) {
  const v = logVault();
  const feed = new ChangeFeed(v.app, () => v.settings);
  await feed.start();
  const hooks = new WebhookDispatcher(v.app, () => v.settings, () => feed, post, 10);
  await hooks.start();
  return { v, feed, hooks };
}

describe("webhooks", () => {
  it("deliver signed batches of matching changes, in order, and move the cursor", async () => {
    const got: { url: string; body: string; headers: Record<string, string> }[] = [];
    const { v, feed, hooks } = await setup(async (url, body, headers) => (got.push({ url, body, headers }), { status: 204 }));
    const created = (await hooks.create({ url: "http://receiver.test/hook", tables: ["log"], ops: ["update"] })) as { id: string; secret: string; cursor: number };
    expect(created.cursor).toBe(0);
    expect(hooks.list()[0]).not.toHaveProperty("secret");
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 2 } });
    await feed.flush();
    await until(() => got.length === 1);
    const { body, headers } = got[0]!;
    expect(headers["X-Datanotes-Signature"]).toBe(`sha256=${createHmac("sha256", created.secret).update(body).digest("hex")}`);
    const payload = JSON.parse(body) as { webhook: string; events: { op: string; changes: unknown }[]; last: number };
    expect(payload).toMatchObject({ webhook: created.id, last: 1, events: [{ kind: "update", op: "update_row", changes: { metric_drinks: { before: 7, after: 2 } } }] });
    await until(() => (hooks.list()[0] as { cursor: number }).cursor === 1);
    expect(hooks.list()[0]).toMatchObject({ status: "ok", failures: 0 });
    await hooks.stop();
    feed.stop();
  });

  it("retry after failures until delivered, keep the cursor across restarts, and stop when deleted", async () => {
    let fail = 2;
    const got: string[] = [];
    const post: Post = async (_u, body) => {
      if (fail-- > 0) return { status: 500 };
      got.push(body);
      return { status: 200 };
    };
    const { v, feed, hooks } = await setup(post);
    const { id } = (await hooks.create({ url: "http://receiver.test/hook" })) as { id: string };
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 3 } });
    await feed.flush();
    await until(() => got.length === 1);
    expect(hooks.list()[0]).toMatchObject({ failures: 0, cursor: 1 });
    await hooks.stop();
    // a new dispatcher (engine restart) continues from the saved cursor
    const again = new WebhookDispatcher(v.app, () => v.settings, () => feed, post, 10);
    await again.start();
    expect(again.list()[0]).toMatchObject({ id, cursor: 1 });
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 4 } });
    await feed.flush();
    await until(() => got.length === 2);
    expect(JSON.parse(got[1]!).events.map((e: { seq: number }) => e.seq)).toEqual([2]);
    expect(await again.remove(id)).toBe(true);
    expect(again.list()).toEqual([]);
    await again.stop();
    feed.stop();
  });

  it("refuse non-http URLs, and are managed through the API and the REST routes", async () => {
    const { v, feed, hooks } = await setup(async () => ({ status: 200 }));
    await expect(hooks.create({ url: "file:///etc/passwd" })).rejects.toThrow(/http/);
    const api = createPublicApi(v.app, () => v.settings, async () => {}, undefined, () => feed, () => hooks);
    const h = createHandlers(v.app, () => v.settings, async () => {}, undefined, api);
    const made = await h["/operations/create_webhook/"]!({ url: "https://example.test/x", tables: ["log"] });
    const id = (made.json as { id: string }).id;
    expect(((await h["/operations/list_webhooks/"]!({})).json as { webhooks: { id: string }[] }).webhooks.map((w) => w.id)).toEqual([id]);
    expect((await h["/operations/delete_webhook/"]!({ id })).status).toBe(200);
    expect(createPublicApi(v.app, () => v.settings).listWebhooks).toThrow(/not available/);
    await hooks.stop();
    feed.stop();
  });
});
