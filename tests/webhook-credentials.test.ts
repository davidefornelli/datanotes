/**
 * A webhook address with a user and password (`https://user:password@host/...`, R2w3-8): a delivery
 * sends them only to the receiver, as HTTP Basic authentication, to the address without them; the
 * store's webhooks.json keeps the address as given. No answer, `/status/`, `last_error`, log line,
 * span, change-feed tool-call record or other store file holds them.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeFeed, ChangePage, ChangeQuery } from "../src/core/change-feed";
import { setTelemetry, telemetry, type AttrValue } from "../src/core/telemetry";
import { configureTracer, setContextStore, type SpanData } from "../src/core/tracing";
import { AsyncContextStore } from "../src/server/tracing";
import { deliveryTarget, publicView, WebhookDispatcher, type Post, type Webhook } from "../src/server/webhooks";
import { startService, type RunningService } from "../src/node/service";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";
import { filesWith } from "./helpers/store-grep";
import { copyTestVault, until } from "./helpers/test-vault";

const S = "SENTINEL-WH";
const OWNER = "owner-token-webhook-credentials-0123456789";
const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");

const previous = telemetry();
const running: RunningService[] = [];
const servers: http.Server[] = [];
const folders: string[] = [];
const dispatchers: WebhookDispatcher[] = [];

afterEach(async () => {
  setTelemetry(previous);
  configureTracer(null);
  setContextStore(null);
  vi.restoreAllMocks();
  for (const d of dispatchers.splice(0)) await d.stop();
  for (const svc of running.splice(0)) await svc.stop();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of folders.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

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
  const d = new WebhookDispatcher(v.app, () => v.settings, () => feed, post, 5);
  dispatchers.push(d);
  return d;
}

const stored = (v: DbVault) => JSON.parse(v.read("store:webhooks.json")) as Webhook[];
const withoutUrl = (hooks: Webhook[]) => JSON.stringify(hooks.map(({ url: _url, ...rest }) => rest));

describe("deliveryTarget", () => {
  it("sends the user info as HTTP Basic authentication, to the address without it", () => {
    expect(deliveryTarget(`https://u:${S}@hooks.example.com/x?a=1`)).toEqual({ url: "https://hooks.example.com/x?a=1", authorization: `Basic ${b64(`u:${S}`)}` });
    expect(deliveryTarget("https://me%40corp:p%3Ass@h.example/x")).toEqual({ url: "https://h.example/x", authorization: `Basic ${b64("me@corp:p:ss")}` });
    expect(deliveryTarget("https://token@h.example/x")).toEqual({ url: "https://h.example/x", authorization: `Basic ${b64("token:")}` });
    expect(deliveryTarget("https://us%C3%A9r:p%C3%A4ss@h.example/")).toEqual({ url: "https://h.example/", authorization: `Basic ${b64("usér:päss")}` });
    expect(deliveryTarget("https://u%zz:p@h.example/")).toEqual({ url: "https://h.example/", authorization: `Basic ${b64("u%zz:p")}` });
  });

  it("leaves an address without user info as it is, byte for byte", () => {
    for (const url of ["http://127.0.0.1:9/hook", "https://h.example/x@y", "https://h.example/?q=a@b", "HTTPS://H.EXAMPLE/X"]) expect(deliveryTarget(url)).toEqual({ url });
  });

  it("an address new URL refuses loses its user info and gets no authentication", () => {
    expect(deliveryTarget(`https://u:${S}@h.example:431800/x`)).toEqual({ url: "https://h.example:431800/x" });
  });
});

describe("publicView", () => {
  it("shows the host a delivery goes to, also with a backslash before the @", () => {
    const url = "http://u:p@evil.invalid\\@good.example/x";
    const shown = publicView({ id: "wh_c", url, secret: "s", enabled: true, cursor: 0, createdAt: "x", failures: 0 }).url as string;
    expect(shown).not.toContain("u:p");
    expect(new URL(shown).host).toBe("evil.invalid");
    expect(new URL(shown).host).toBe(new URL(deliveryTarget(url).url).host);
    expect(deliveryTarget(url).authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("shows the address without user info and errors without URL credentials", () => {
    expect(
      publicView({
        id: "wh_a",
        url: `https://u:${S}@hooks.example.com/x`,
        secret: "s",
        enabled: true,
        cursor: 3,
        createdAt: "2026-10-01T00:00:00.000Z",
        failures: 2,
        lastError: `Request cannot be constructed from a URL that includes credentials: https://u:${S}@hooks.example.com/x`,
      }),
    ).toEqual({
      id: "wh_a",
      url: "https://hooks.example.com/x",
      enabled: true,
      cursor: 3,
      created_at: "2026-10-01T00:00:00.000Z",
      last_error: "Request cannot be constructed from a URL that includes credentials: https://hooks.example.com/x",
      failures: 2,
      status: "failing",
    });
    // a malformed stored entry does not throw (status.ts maps the file through publicView)
    expect(publicView({ id: "wh_b", secret: "s", enabled: false, cursor: 0, createdAt: "x", failures: 0, lastError: 5 } as unknown as Webhook)).toMatchObject({
      id: "wh_b",
      last_error: 5,
      status: "disabled",
    });
  });
});

describe("the dispatcher", () => {
  type Got = { url: string; headers: Record<string, string> };
  const recording = (got: Got[]): Post => async (url, _body, headers) => {
    got.push({ url, headers });
    return { status: 204 };
  };

  it("a delivery sends the user and password as Basic authentication, never in the address", async () => {
    const v = createDbVault({});
    const s = scriptedFeed(0);
    const got: Got[] = [];
    const hooks = dispatcher(v, s.feed, recording(got));
    await hooks.start();
    const made = await hooks.create({ url: `https://u:${S}@receiver.test/hook`, since: 0 });
    expect(made.url).toBe("https://receiver.test/hook");
    expect(JSON.stringify({ ...made, secret: "" })).not.toContain(S);
    s.pages.push({ events: [event(1) as never], last: 1 });
    await until(() => got.length === 1, 3000, "a delivery");
    expect(got[0]!.url).toBe("https://receiver.test/hook");
    expect(got[0]!.headers.Authorization).toBe(`Basic ${b64(`u:${S}`)}`);
    expect(got[0]!.headers["X-Datanotes-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(hooks.list()[0]).toMatchObject({ url: "https://receiver.test/hook", status: "ok" });
    await hooks.stop();
    // the definition every delivery reads
    expect(stored(v)[0]!.url).toBe(`https://u:${S}@receiver.test/hook`);
  });

  it("an address without user info sends no Authorization header", async () => {
    const v = createDbVault({});
    const s = scriptedFeed(0);
    const got: Got[] = [];
    const hooks = dispatcher(v, s.feed, recording(got));
    await hooks.start();
    await hooks.create({ url: "http://plain.test/hook", since: 0 });
    s.pages.push({ events: [event(1) as never], last: 1 });
    await until(() => got.length === 1, 3000, "a delivery");
    expect(got[0]!.url).toBe("http://plain.test/hook");
    expect(Object.keys(got[0]!.headers)).not.toContain("Authorization");
    await hooks.stop();
  });

  it("a transport error that quotes the address: last_error, the log line, the span and webhooks.json keep no credentials", async () => {
    const logged: { body: string; attrs?: Record<string, AttrValue> }[] = [];
    setTelemetry({ log: (_sev, body, attrs) => void logged.push({ body, attrs }), flush: async () => {} });
    const spans: SpanData[] = [];
    setContextStore(new AsyncContextStore());
    configureTracer({ export: (x) => void spans.push(...x), enabled: () => true, sampleRatio: () => 1, maxSpansPerTrace: () => 1000 });
    const v = createDbVault({});
    const s = scriptedFeed(0);
    const hooks = dispatcher(v, s.feed, async () => {
      throw new TypeError(`Request cannot be constructed from a URL that includes credentials: https://u:${S}@receiver.test/hook`);
    });
    await hooks.start();
    await hooks.create({ url: `https://u:${S}@receiver.test/hook`, since: 0 });
    s.pages.push({ events: [event(1) as never], last: 1 });
    await until(() => hooks.list()[0]!.failures >= 1, 3000, "a failed delivery");
    await hooks.stop();
    const clean = "Request cannot be constructed from a URL that includes credentials: https://receiver.test/hook";
    expect(hooks.list()[0]).toMatchObject({ status: "failing", last_error: clean });
    const warn = logged.find((l) => l.body === "datanotes webhook delivery failed");
    expect(warn?.attrs).toMatchObject({ url: "https://receiver.test/hook", error: clean });
    expect(JSON.stringify(logged)).not.toContain(S);
    expect(spans.some((x) => x.name === "POST")).toBe(true);
    expect(JSON.stringify(spans)).toContain(clean);
    expect(JSON.stringify(spans)).not.toContain(S);
    const file = stored(v);
    expect(file[0]!.lastError).toBe(clean);
    expect(withoutUrl(file)).not.toContain(S);
  });

  it("a string thrown by the transport loses the credentials too", async () => {
    const v = createDbVault({});
    const s = scriptedFeed(0);
    const hooks = dispatcher(v, s.feed, async () => {
      throw `down: https://u:${S}@receiver.test/hook`;
    });
    await hooks.start();
    await hooks.create({ url: `https://u:${S}@receiver.test/hook`, since: 0 });
    s.pages.push({ events: [event(1) as never], last: 1 });
    await until(() => hooks.list()[0]!.failures >= 1, 3000, "a failed delivery");
    await hooks.stop();
    expect(hooks.list()[0]!.last_error).toBe("down: https://receiver.test/hook");
  });

  it("a webhooks.json of an older version: its stored error is cleaned at start; a clean file is not written again", async () => {
    const v = createDbVault({});
    const old = {
      id: "wh_old",
      url: `https://u:${S}@receiver.test/hook`,
      secret: "s",
      enabled: false,
      cursor: 4,
      createdAt: "2026-10-01T00:00:00.000Z",
      failures: 3,
      lastError: `Request cannot be constructed from a URL that includes credentials: https://u:${S}@receiver.test/hook`,
    };
    v.write("store:webhooks.json", JSON.stringify([old]));
    const hooks = dispatcher(v, scriptedFeed(0).feed, async () => ({ status: 204 }));
    await hooks.start();
    expect(hooks.list()).toEqual([
      {
        id: "wh_old",
        url: "https://receiver.test/hook",
        enabled: false,
        cursor: 4,
        created_at: "2026-10-01T00:00:00.000Z",
        last_error: "Request cannot be constructed from a URL that includes credentials: https://receiver.test/hook",
        failures: 3,
        status: "disabled",
      },
    ]);
    const file = stored(v);
    expect(file[0]!.lastError).not.toContain(S);
    expect(file[0]!.url).toBe(old.url);
    await hooks.stop();

    const tidy = JSON.stringify([
      { ...old, id: "wh_tidy", lastError: "HTTP 500" },
      { ...old, id: "wh_none", lastError: undefined },
    ]);
    v.write("store:webhooks.json", tidy);
    const again = dispatcher(v, scriptedFeed(0).feed, async () => ({ status: 204 }));
    await again.start();
    expect(v.read("store:webhooks.json")).toBe(tidy);
    await again.stop();
  });
});

describe("on the service", () => {
  let exports: { url: string; body: string }[] = [];

  beforeEach(() => {
    exports = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/logs") || url.includes("/v1/traces")) {
        const b = init?.body;
        exports.push({ url, body: typeof b === "string" ? b : b instanceof Uint8Array ? Buffer.from(b).toString("latin1") : "" });
        return new Response(null, { status: 200 });
      }
      // a transport that quotes the address as the webhook holds it
      if (url.startsWith("https://127.0.0.1:9/")) throw new TypeError(`fetch failed: https://u:${S}@127.0.0.1:9/hook`);
      return realFetch(input, init);
    });
  });

  async function post(svc: RunningService, route: string, body: unknown, token = OWNER): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
    const res = await fetch(`http://127.0.0.1:${svc.port}/datanotes${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
  }

  it("only the receiver and webhooks.json get the credentials: no answer, status, log, trace, tool-call record or other store file", { timeout: 60_000 }, async () => {
    const received: { url: string | undefined; authorization: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
      received.push({ url: req.url, authorization: req.headers.authorization });
      req.resume();
      req.on("end", () => {
        res.statusCode = 204;
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const recvPort = (server.address() as { port: number }).port;

    const root = copyTestVault();
    folders.push(root);
    seedStoreSettings(root, {
      httpServerPort: 0,
      httpServerToken: OWNER,
      fileLogEnabled: true,
      autoRecompute: false,
      telemetryEnabled: true,
      telemetryEndpoint: "http://collector.test:4318",
      telemetryProtocol: "http/json",
    });
    const svc = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
    running.push(svc);

    const reader = (await post(svc, "/tokens/create/", { name: "reader", write: [] })).json.token as string;
    expect(typeof reader).toBe("string");

    const ok = `http://u:${S}@127.0.0.1:${recvPort}/hook`;
    const refused = `https://u:${S}@127.0.0.1:9/hook`;
    const unparsable = `https://u:${S}@127.0.0.1:431800/hook`;
    for (const url of [ok, refused, unparsable]) {
      const r = await post(svc, "/operations/create_webhook/", { url });
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(S);
    }

    const write = await post(svc, "/operations/update_row/", { table: "work.planning.task", path: "datanotes/work/planning/task/Build the button component.md", set: { estimate_h: 11 }, autolink: false });
    expect(write.status).toBe(200);

    await until(() => received.length > 0, 15_000, "the delivery");
    expect(received[0]).toEqual({ url: "/hook", authorization: `Basic ${b64(`u:${S}`)}` });

    type Listed = { url: string; failures: number; last_error?: string };
    let listed: { text: string; hooks: Listed[] } = { text: "", hooks: [] };
    await until(
      async () => {
        const r = await post(svc, "/operations/list_webhooks/", {}, reader);
        const value = (r.json.value ?? r.json) as { webhooks?: Listed[] } | Listed[];
        const hooks = Array.isArray(value) ? value : (value.webhooks ?? []);
        listed = { text: r.text, hooks };
        return hooks.filter((h) => h.failures > 0).length >= 2;
      },
      15_000,
      "two failing webhooks",
    );
    expect(listed.text).not.toContain(S);
    expect(listed.hooks.map((h) => h.url).sort()).toEqual([`http://127.0.0.1:${recvPort}/hook`, "https://127.0.0.1:431800/hook", "https://127.0.0.1:9/hook"]);
    expect(listed.hooks.find((h) => h.url === "https://127.0.0.1:9/hook")!.last_error).toBe("fetch failed: https://127.0.0.1:9/hook");
    expect(listed.hooks.find((h) => h.url === "https://127.0.0.1:431800/hook")!.last_error).toContain("https://127.0.0.1:431800/hook");

    expect((await post(svc, "/status/", {})).text).not.toContain(S);

    // an agent's call, as the MCP server reports it
    const recorded = await post(svc, "/tool-calls/record/", { tool: "create_webhook", args: { url: refused }, ok: true, duration_ms: 1, value: { id: "wh_x", url: refused } });
    expect(recorded.status).toBe(200);
    const changes = await post(svc, "/operations/list_changes/", { kinds: ["tool_call"] });
    expect(changes.text).toContain("https://127.0.0.1:9/hook");
    expect(changes.text).not.toContain(S);

    const store = svc.store.store;
    await svc.stop();
    running.splice(running.indexOf(svc), 1);

    expect(exports.some((x) => x.url.includes("/v1/traces"))).toBe(true);
    const bodies = exports.map((x) => x.body).join("\n");
    expect(bodies).toContain("fetch failed: https://127.0.0.1:9/hook");
    expect(bodies).not.toContain(S);
    const logsDir = path.join(store, "logs");
    const logs = fs.readdirSync(logsDir).map((f) => fs.readFileSync(path.join(logsDir, f), "utf8")).join("\n");
    expect(logs).toContain("datanotes webhook delivery failed");
    expect(logs).not.toContain(S);
    expect(filesWith(store, S)).toEqual(["webhooks.json"]);
    const file = JSON.parse(fs.readFileSync(path.join(store, "webhooks.json"), "utf8")) as Webhook[];
    expect(file).toHaveLength(3);
    expect(withoutUrl(file)).not.toContain(S);
  });
});
