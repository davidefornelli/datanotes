import { afterEach, describe, expect, it } from "vitest";
import type { ChangeFeed, ChangePage, ChangeQuery } from "../src/core/change-feed";
import { setTelemetry, telemetry, type AttrValue } from "../src/core/telemetry";
import { WebhookDispatcher, type Post } from "../src/server/webhooks";
import { createDbVault, type DbVault } from "./helpers/db-vault";

const previousTelemetry = telemetry();
afterEach(() => setTelemetry(previousTelemetry));

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

/**
 * A change feed playing a script: each `wait` takes the next page (or, when the script is over,
 * answers "nothing new" after a few ms), and records the query it got.
 */
function scriptedFeed(lastSeq: number, pages: Partial<ChangePage>[] = []) {
  const queries: ChangeQuery[] = [];
  const feed = {
    lastSeq,
    async wait(q: ChangeQuery): Promise<ChangePage> {
      queries.push(q);
      const next = pages.shift();
      if (next) return { events: [], last: q.since ?? 0, head: lastSeq, ...next };
      await new Promise((r) => setTimeout(r, 5));
      return { events: [], last: q.since ?? 0, head: lastSeq };
    },
  };
  return { feed: feed as unknown as ChangeFeed, queries, pages };
}

const event = (seq: number) => ({ seq, at: "2026-10-08T10:00:00.000Z", table: "personal.health.mood", op: "insert", path: `Mood/${seq}.md` });

function dispatcher(v: DbVault, feed: ChangeFeed | null, post: Post) {
  return new WebhookDispatcher(v.app, () => v.settings, () => feed, post, 5);
}

describe("webhooks: what a webhook asks the feed", () => {
  it("every filter given at creation, from the cursor given or the feed's last event", async () => {
    const v = createDbVault({});
    const s = scriptedFeed(41);
    const hooks = dispatcher(v, s.feed, async () => ({ status: 200 }));
    await hooks.start();
    const created = await hooks.create({
      url: "https://n8n.example.com/webhook/mood",
      tables: ["personal.health.mood"],
      ops: ["insert", "update"],
      columns: ["score"],
      excludeActor: "pantry-app",
      where: { score: { lte: 3 } },
      since: 12,
    });
    expect(created).toMatchObject({ cursor: 12, enabled: true, status: "ok", failures: 0, tables: ["personal.health.mood"], kinds: ["insert", "update"], columns: ["score"], exclude_actor: "pantry-app", where: { score: { lte: 3 } } });
    await until(() => s.queries.length > 0);
    expect(s.queries[0]).toEqual({ since: 12, limit: 100, tables: ["personal.health.mood"], ops: ["insert", "update"], columns: ["score"], excludeActor: "pantry-app", where: { score: { lte: 3 } } });
    const plain = await hooks.create({ url: "http://receiver.test/all", tables: [], ops: [], columns: [], where: {} });
    expect(plain).not.toHaveProperty("tables");
    expect(plain).not.toHaveProperty("where");
    expect(plain.cursor).toBe(41);
    await hooks.stop();
  });

  it("a webhook created while no feed runs starts from 0", async () => {
    const v = createDbVault({});
    const hooks = dispatcher(v, null, async () => ({ status: 200 }));
    expect((await hooks.create({ url: "http://receiver.test/x" })).cursor).toBe(0);
  });
});

describe("webhooks: delivery", () => {
  it("moves the cursor past events its filter skipped, without calling the receiver", async () => {
    const v = createDbVault({});
    const s = scriptedFeed(0, [{ events: [], last: 7 }]);
    const calls: string[] = [];
    const hooks = dispatcher(v, s.feed, async (_u, body) => (calls.push(body), { status: 200 }));
    await hooks.start();
    await hooks.create({ url: "http://receiver.test/x", since: 0 });
    await until(() => hooks.list()[0]!.cursor === 7);
    expect(calls).toEqual([]);
    await hooks.stop();
    expect(JSON.parse(v.read("store:webhooks.json"))[0].cursor).toBe(7);
  });

  it("tells the receiver about a gap (events lost to retention) before the events", async () => {
    const v = createDbVault({});
    const s = scriptedFeed(0, [{ events: [event(50) as never], last: 50, gap: true }]);
    const bodies: unknown[] = [];
    const hooks = dispatcher(v, s.feed, async (_u, body) => (bodies.push(JSON.parse(body)), { status: 200 }));
    await hooks.start();
    const { id } = await hooks.create({ url: "http://receiver.test/x", since: 3 });
    await until(() => bodies.length === 1);
    // the gap on top, as list_changes answers it; the events as callers see them
    expect(bodies[0]).toEqual({ webhook: id, events: [{ seq: 50, at: "2026-10-08T10:00:00.000Z", table: "personal.health.mood", kind: "insert", path: "Mood/50.md" }], last: 50, gap: true, since: 3 });
    await hooks.stop();
  });

  it("a receiver that cannot be reached: the error is kept, logged once, retried with backoff; disabling stops it", async () => {
    const logged: { severity: string; body: string; attrs?: Record<string, AttrValue> }[] = [];
    setTelemetry({ log: (severity, body, attrs) => void logged.push({ severity, body, attrs }), flush: async () => {} });
    const v = createDbVault({});
    const s = scriptedFeed(0);
    let down = true;
    const delivered: number[] = [];
    const post: Post = async (_u, body) => {
      if (down) throw new Error("connect ECONNREFUSED 10.0.0.5:443");
      delivered.push(JSON.parse(body).last);
      return { status: 202 };
    };
    const hooks = dispatcher(v, s.feed, post);
    await hooks.start();
    const { id } = await hooks.create({ url: "https://receiver.test/x", since: 0 });
    s.pages.push({ events: [event(1) as never], last: 1 }, { events: [event(1) as never], last: 1 }, { events: [event(1) as never], last: 1 });
    await until(() => hooks.list()[0]!.failures >= 2);
    expect(hooks.list()[0]).toMatchObject({ status: "failing", last_error: "connect ECONNREFUSED 10.0.0.5:443", cursor: 0 });
    expect(logged.filter((l) => l.body === "datanotes webhook delivery failed")).toHaveLength(1);
    expect(logged[0]!.attrs).toMatchObject({ webhook: id, url: "https://receiver.test/x", failures: 1, error: "connect ECONNREFUSED 10.0.0.5:443" });

    expect(await hooks.setEnabled(id, false)).toMatchObject({ status: "disabled", enabled: false });
    down = false;
    expect(await hooks.setEnabled(id, true)).toMatchObject({ status: "ok", enabled: true, failures: 0 });
    s.pages.push({ events: [event(1) as never], last: 1 });
    await until(() => delivered.length > 0);
    await until(() => hooks.list()[0]!.cursor === 1);
    expect(hooks.list()[0]).not.toHaveProperty("last_error");
    expect(await hooks.setEnabled("wh_missing", true)).toBeNull();
    await hooks.stop();
  });
});

describe("webhooks: the dispatcher", () => {
  it("starts with no webhooks when webhooks.json is unreadable, and keeps disabled ones idle", async () => {
    const v = createDbVault({});
    v.write("store:webhooks.json", "[{ broken");
    const s = scriptedFeed(0);
    const broken = dispatcher(v, s.feed, async () => ({ status: 200 }));
    await broken.start();
    expect(broken.list()).toEqual([]);
    await broken.stop();

    const off = { id: "wh_off", url: "http://receiver.test/x", secret: "s", enabled: false, cursor: 4, createdAt: "2026-10-01T00:00:00.000Z", failures: 0 };
    v.write("store:webhooks.json", JSON.stringify([off]));
    const again = dispatcher(v, s.feed, async () => ({ status: 200 }));
    await again.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.queries).toEqual([]); // never polled
    expect(again.list()).toEqual([{ id: "wh_off", url: "http://receiver.test/x", enabled: false, cursor: 4, created_at: "2026-10-01T00:00:00.000Z", failures: 0, status: "disabled" }]);
    expect(await again.remove("wh_unknown")).toBe(false);
    await again.stop();
  });

  it("waits for the change feed while it is not running, and stop() wakes the wait at once", async () => {
    const v = createDbVault({});
    const hooks = dispatcher(v, null, async () => ({ status: 200 }));
    await hooks.start();
    await hooks.create({ url: "http://receiver.test/x" });
    await new Promise((r) => setTimeout(r, 20));
    const t = Date.now();
    await hooks.stop();
    expect(Date.now() - t).toBeLessThan(900); // the 1 s wait was cut short
  });
});
