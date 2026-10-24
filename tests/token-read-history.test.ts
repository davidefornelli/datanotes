/**
 * Read permissions of named tokens on history and the change feed (lane D of the read-permission
 * plan): table_changes, describe_history (with and without a table), list_migrations,
 * list_changes, the change feed's Server-Sent Events stream and list_webhooks. A restricted token
 * gets 403 for a table it names and may not read, and never sees an event, a commit, an operation
 * or a webhook about one; the owner, `legacy` and `star` see everything (D2).
 */

import { afterEach, describe, expect, it } from "vitest";
import { describeDatabaseHistory } from "../src/core/database-history";
import { eventForScope, eventVisible, type ChangeEvent, type ChangeFeed, type ChangePage } from "../src/core/change-feed";
import { tableChanges, describeHistory } from "../src/core/history";
import { listMigrations } from "../src/core/journal";
import { ReadDeniedError, runWithReadScope, type ReadScope } from "../src/core/read-scope";
import { HttpApiServer } from "../src/server/http-server";
import { WebhookDispatcher } from "../src/server/webhooks";
import { expectNoLeak, MEALS, PANTRY, readRefusal, setupReadTokens, startReadEngine, WEIGHT, type ReadEngine } from "./helpers/read-tokens";

const COOK: ReadScope = { token: "cook", patterns: ["personal.food.*"] };

type Json = Record<string, unknown>;

/** The tables named by the commits of a describe_history answer. */
const commitTables = (j: unknown) => ((j as { history: { table: string }[] }).history ?? []).map((c) => c.table);

/** Owner writes with history on: one weight row, one pantry row, and a batch writing both. */
async function historyWrites(op: (token: "owner", op: string, args?: Json) => Promise<{ status: number; json: unknown }>) {
  const ok = async (name: string, args: Json) => {
    const r = await op("owner", name, args);
    expect([name, r.status, r.json]).toEqual([name, 200, expect.anything()]);
    return r.json as Json;
  };
  await ok("configure_database", { history: true });
  await ok("insert_row", { table: WEIGHT, values: { label: "ZZSECRETHEALTH later", day: "2026-10-03", kg: 80.5, note: "ZZSECRETHEALTH again" } });
  await ok("insert_row", { table: PANTRY, values: { item: "salt", qty: 1 } });
  const batch = await ok("batch", {
    operations: [
      { op: "insert_row", table: PANTRY, values: { item: "sugar", qty: 2 } },
      { op: "insert_row", table: WEIGHT, values: { label: "ZZSECRETHEALTH batch", day: "2026-10-04", kg: 78, note: "ZZSECRETHEALTH batched" } },
    ],
  });
  return { batch: batch.migration_id as string };
}

describe("history: table_changes and describe_history", () => {
  it("table_changes and describe_history on an unreadable table are 403, in the guard and in the engine", async () => {
    const s = await setupReadTokens();
    await historyWrites(s.op);
    for (const table of ["weight", WEIGHT]) {
      const changes = await s.op("cook", "table_changes", { table, start_version: 0 });
      expect([changes.status, changes.json]).toEqual([403, readRefusal("cook", WEIGHT).json]);
      const described = await s.op("cook", "describe_history", { table });
      expect([described.status, described.json]).toEqual([403, readRefusal("cook", WEIGHT).json]);
    }
    // the engine's own sites, for a name the guard lets through (an alias, a dropped table's log)
    await expect(runWithReadScope(COOK, () => tableChanges(s.v.app, s.v.settings, { table: WEIGHT, startVersion: 0 }))).rejects.toThrow(new ReadDeniedError(`token cook may not read ${WEIGHT}`));
    await expect(runWithReadScope(COOK, () => describeHistory(s.v.app, s.v.settings, { table: WEIGHT }))).rejects.toThrow(new ReadDeniedError(`token cook may not read ${WEIGHT}`));
    // a readable table answers as it does for the owner
    const own = await s.op("cook", "table_changes", { table: PANTRY, start_version: 0 });
    expect([own.status, own.json]).toEqual([200, (await s.op("owner", "table_changes", { table: PANTRY, start_version: 0 })).json]);
    expectNoLeak(own.json);
    const hist = await s.op("cook", "describe_history", { table: "pantry" });
    expect([hist.status, hist.json]).toEqual([200, (await s.op("owner", "describe_history", { table: "pantry" })).json]);
  });

  it("describe_history without a table keeps only the commits whose every table is readable", async () => {
    const s = await setupReadTokens();
    const { batch } = await historyWrites(s.op);
    const owner = (await s.op("owner", "describe_history", {})).json as { tables: string[]; history: Json[] };
    expect(owner.tables).toEqual([MEALS, PANTRY, WEIGHT].sort());
    expect(new Set(commitTables(owner))).toEqual(new Set([MEALS, PANTRY, WEIGHT]));
    // the batch's pantry commit names both tables: the owner sees it
    expect(owner.history.filter((c) => c.batch === batch).map((c) => [c.table, c.tables]).sort()).toEqual([
      [PANTRY, [PANTRY, WEIGHT]],
      [WEIGHT, [PANTRY, WEIGHT]],
    ]);

    const cook = await s.op("cook", "describe_history", {});
    expect(cook.status).toBe(200);
    const j = cook.json as { tables: string[]; history: Json[] };
    expect(j.tables).toEqual([MEALS, PANTRY]);
    // every commit of a readable table, but not the batch's, which also wrote a weight row
    const wanted = owner.history.filter((c) => c.table !== WEIGHT && c.batch !== batch);
    expect(j.history).toEqual(wanted);
    expect(j.history.length).toBeGreaterThan(0);
    expectNoLeak(cook.json);
    expect(JSON.stringify(cook.json)).not.toContain("health");

    // `limit` counts the commits the token sees: one asked, one given
    const one = (await s.op("cook", "describe_history", { limit: 1 })).json as { history: Json[] };
    expect(one.history).toEqual(wanted.slice(0, 1));

    // `blind` sees no commit and no table; legacy and star what the owner sees
    expect((await s.op("blind", "describe_history", {})).json).toEqual({ tables: [], history: [] });
    for (const t of ["legacy", "star"] as const) expect((await s.op(t, "describe_history", {})).json).toEqual(owner);
  });

  it("describe_history without a table reads further back when the newest commits are hidden", async () => {
    const s = await setupReadTokens();
    await historyWrites(s.op);
    // many weight commits after the last pantry one: the pantry commits are still found
    for (let i = 0; i < 4; i++) {
      expect((await s.op("owner", "insert_row", { table: WEIGHT, values: { label: `ZZSECRETHEALTH more ${i}`, day: "2026-10-05", kg: 70 + i } })).status).toBe(200);
    }
    const owner = await describeDatabaseHistory(s.v.app, s.v.settings, {});
    const wanted = owner.history.filter((c) => c.table !== WEIGHT && !(c.tables ?? []).includes(WEIGHT)).slice(0, 2);
    const cook = await runWithReadScope(COOK, () => describeDatabaseHistory(s.v.app, s.v.settings, { limit: 2 }));
    expect(cook.history).toEqual(wanted);
    expect(cook.history).toHaveLength(2);
    expectNoLeak(cook);
    // `since` and `limit: 0` work under a scope as for the owner
    const since = wanted[1]!.timestamp;
    const recent = await runWithReadScope(COOK, () => describeDatabaseHistory(s.v.app, s.v.settings, { since }));
    expect(recent.history).toEqual(owner.history.filter((c) => c.timestamp >= since && c.table !== WEIGHT && !(c.tables ?? []).includes(WEIGHT)));
    expect(await runWithReadScope(COOK, () => describeDatabaseHistory(s.v.app, s.v.settings, { limit: 0 }))).toEqual({ tables: [MEALS, PANTRY], history: [] });
  });
});

describe("history: list_migrations", () => {
  it("lists only the operations about readable tables, counted in total; a batch and the bases are hidden", async () => {
    const s = await setupReadTokens();
    const { batch } = await historyWrites(s.op);
    const owner = (await s.op("owner", "list_migrations", { limit: 1000 })).json as { total: number; migrations: Json[] };
    expect(owner.migrations.some((m) => m.table === WEIGHT)).toBe(true);
    expect(owner.migrations.some((m) => m.migration_id === batch)).toBe(true);

    const cook = await s.op("cook", "list_migrations", { limit: 1000 });
    expect(cook.status).toBe(200);
    const j = cook.json as { total: number; migrations: Json[] };
    const readable = (m: Json) => typeof m.table === "string" && m.table.startsWith("personal.food.");
    expect(j.migrations).toEqual(owner.migrations.filter(readable));
    expect(j.total).toBe(j.migrations.length);
    expect(j.migrations.map((m) => m.table)).not.toContain(WEIGHT);
    expect(j.migrations.map((m) => m.migration_id)).not.toContain(batch);
    expect(j.migrations.map((m) => m.table)).not.toContain("bases.noted");
    expect(JSON.stringify(cook.json)).not.toContain("health");
    expectNoLeak(cook.json);

    // `table` is a filter, not a check: "health" finds nothing for cook, the weight writes for the owner
    const filtered = await s.op("cook", "list_migrations", { table: "health" });
    expect([filtered.status, filtered.json]).toEqual([200, { total: 0, migrations: [] }]);
    expect(((await s.op("owner", "list_migrations", { table: "health" })).json as { total: number }).total).toBeGreaterThan(0);
    // `limit` keeps the newest the token sees; `total` still counts them all
    const two = (await s.op("cook", "list_migrations", { limit: 2 })).json as { total: number; migrations: Json[] };
    expect(two).toEqual({ total: j.total, migrations: j.migrations.slice(0, 2) });

    expect((await s.op("blind", "list_migrations", {})).json).toEqual({ total: 0, migrations: [] });
    for (const t of ["legacy", "star"] as const) expect((await s.op(t, "list_migrations", { limit: 1000 })).json).toEqual(owner);
    // the engine's own function, with the scope set by hand
    expect(await runWithReadScope(COOK, () => listMigrations(s.v.app, s.v.settings, { limit: 1000 }))).toEqual(j);
  });
});

describe("change feed: eventVisible", () => {
  it("shows a row event of a readable table, drops what it names of unreadable rows and notes", async () => {
    const s = await setupReadTokens();
    const { app, settings } = s.v;
    const base = { seq: 1, at: "2026-10-23T10:00:00.000Z", source: "external" as const };
    const pantry: ChangeEvent = {
      ...base,
      table: PANTRY,
      op: "update",
      path: s.paths.eggs,
      changes: { qty: { before: 6, after: 5 } },
      violations: [
        { path: s.paths.eggs, code: "min", message: "qty below min" } as never,
        { path: s.paths.heavy, code: "broken_link", message: "ZZSECRETHEALTH link" } as never,
        { path: s.paths.pasta, code: "broken_link", message: "a meal" } as never,
      ],
      violationsTotal: 140,
      cause: [
        { path: s.paths.diary, oldPath: "Old/ZZSECRETDIARY.md" },
        { path: s.paths.flour, oldPath: "Old/flour.md", seq: 3 },
      ],
    };
    const shown = eventForScope(pantry, COOK, app, settings)!;
    expect(shown).toEqual({
      ...pantry,
      violations: [pantry.violations![0], pantry.violations![2]],
      violationsTotal: undefined,
      cause: [{ path: s.paths.flour, oldPath: "Old/flour.md", seq: 3 }],
    });
    expectNoLeak(shown);
    expect(eventVisible(pantry, COOK, app, settings)).toBe(true);
    // nothing to drop: the same event
    const plain: ChangeEvent = { ...base, table: PANTRY, op: "insert", path: s.paths.eggs, violations: [{ path: s.paths.eggs, code: "min", message: "m" } as never], violationsTotal: 120 };
    expect(eventForScope(plain, COOK, app, settings)).toBe(plain);
    // a deleted row's own violations stay (its path is gone from the vault)
    const gone: ChangeEvent = { ...base, table: PANTRY, op: "delete", path: "Gone/salt.md", violations: [{ path: "Gone/salt.md", code: "x", message: "m" } as never] };
    expect(eventForScope(gone, COOK, app, settings)).toBe(gone);
    // the owner's scope (none) sees every event as it is
    expect(eventForScope(pantry, null, app, settings)).toBe(pantry);

    // unreadable tables, schema events, tool calls of another token
    const weight: ChangeEvent = { ...base, table: WEIGHT, op: "insert", path: s.paths.heavy };
    const unreadable: ChangeEvent = { ...base, table: WEIGHT, op: "unreadable", path: s.paths.heavy };
    const schema: ChangeEvent = { ...base, table: null, op: "schema", path: "Datanotes/metastore.yaml" };
    const call = { tool: "select_rows", args: {}, ok: true, durationMs: 1, value: "ZZSECRETHEALTH", servedBy: "engine" };
    const nurseCall: ChangeEvent = { ...base, table: null, op: "tool_call", path: "", actor: { auth: "nurse", harness: "nurse" }, call };
    const ownCall: ChangeEvent = { ...nurseCall, actor: { auth: "cook", harness: "claude" } };
    const anonCall: ChangeEvent = { ...nurseCall, actor: undefined };
    for (const e of [weight, unreadable, schema, nurseCall, anonCall]) {
      expect([e.op, e.table, eventForScope(e, COOK, app, settings), eventVisible(e, COOK, app, settings)]).toEqual([e.op, e.table, null, false]);
      expect(eventVisible(e, null, app, settings)).toBe(true);
    }
    expect(eventForScope(ownCall, COOK, app, settings)).toBe(ownCall);
    // a table named by its short name in an old event is resolved as the metastore names it
    expect(eventVisible({ ...weight, table: "weight" }, COOK, app, settings)).toBe(false);
    expect(eventVisible({ ...weight, table: "pantry", path: s.paths.eggs }, COOK, app, settings)).toBe(true);
    // nurse reads health: the weight event, not the pantry one
    const NURSE: ReadScope = { token: "nurse", patterns: ["personal.health.*"] };
    expect([eventVisible(weight, NURSE, app, settings), eventVisible(pantry, NURSE, app, settings)]).toEqual([true, false]);
  });
});

describe("change feed over HTTP: list_changes, the stream, webhooks", () => {
  let engine: ReadEngine | null = null;
  afterEach(async () => {
    await engine?.dispose();
    engine = null;
  });

  /** The events of a list_changes answer. */
  const eventsOf = (r: { json: Json }) => (r.json.events ?? []) as Json[];

  it("list_changes shows a restricted token only the events of its tables and its own tool calls", async () => {
    engine = await startReadEngine();
    const e = engine;
    const head = ((await e.op("owner", "list_changes", { limit: 1 })).json.head as number) ?? 0;
    expect((await e.op("owner", "insert_row", { table: WEIGHT, values: { label: "ZZSECRETHEALTH later", day: "2026-10-03", kg: 80.5, note: "ZZSECRETHEALTH again" } })).status).toBe(200);
    expect((await e.op("owner", "insert_row", { table: PANTRY, values: { item: "salt", qty: 1 } })).status).toBe(200);
    expect((await e.route("nurse", "/tool-calls/record/", { tool: "select_rows", args: { table: "weight" }, ok: true, value: "ZZSECRETHEALTH result" })).status).toBe(200);
    expect((await e.route("cook", "/tool-calls/record/", { tool: "pantry", args: {}, ok: true, value: "my own" })).status).toBe(200);

    const owner = eventsOf(await e.op("owner", "list_changes", { since: head, kinds: ["insert", "tool_call"] }));
    expect(owner.map((x) => [x.kind, x.table])).toEqual([
      ["insert", WEIGHT],
      ["insert", PANTRY],
      ["tool_call", null],
      ["tool_call", null],
    ]);

    const cook = await e.op("cook", "list_changes", { since: head, kinds: ["insert", "tool_call"] });
    expect(cook.status).toBe(200);
    expect(eventsOf(cook).map((x) => [x.kind, x.table, (x.actor as Json | undefined)?.auth])).toEqual([
      ["insert", PANTRY, "owner"],
      ["tool_call", null, "cook"],
    ]);
    expectNoLeak(cook.json);
    // `last` moves past the hidden events too: a client polls on from there
    expect(cook.json.last).toBe((await e.op("owner", "list_changes", { since: head, kinds: ["insert", "tool_call"] })).json.last);

    // every event from the start: the seed's weight rows and the schema changes are hidden
    const all = await e.op("cook", "list_changes", { since: 0, limit: 5000 });
    expect(eventsOf(all).length).toBeGreaterThan(0);
    expect(eventsOf(all).every((x) => typeof x.table === "string" && (x.table as string).startsWith("personal.food."))).toBe(true);
    expectNoLeak(all.json);
    // `limit` counts the events the token sees
    const first = await e.op("cook", "list_changes", { since: 0, limit: 1 });
    expect(eventsOf(first)).toEqual(eventsOf(all).slice(0, 1));

    // `blind` sees nothing; legacy and star what the owner sees; nurse the weight event and not the pantry one
    expect(eventsOf(await e.op("blind", "list_changes", { since: 0, limit: 5000 }))).toEqual([]);
    const ownerAll = eventsOf(await e.op("owner", "list_changes", { since: 0, limit: 5000 }));
    for (const t of ["legacy", "star"] as const) {
      // their own tool calls are the owner's too: no tool_call asked here
      expect(eventsOf(await e.op(t, "list_changes", { since: 0, limit: 5000 }))).toEqual(ownerAll);
    }
    const nurse = eventsOf(await e.op("nurse", "list_changes", { since: head, kinds: ["insert", "tool_call"] }));
    expect(nurse.map((x) => [x.kind, x.table])).toEqual([
      ["insert", WEIGHT],
      ["tool_call", null],
    ]);
  });

  it("the change stream sends a restricted token only the events of its tables", async () => {
    engine = await startReadEngine();
    const e = engine;
    const head = (await e.op("owner", "list_changes", { limit: 1 })).json.head as number;
    const ac = new AbortController();
    const res = await fetch(`${e.url}/changes/stream?since=${head}`, { headers: { Authorization: `Bearer ${e.secrets.cook}` }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = "";
    const until = async (re: RegExp) => {
      const deadline = Date.now() + 8000;
      while (!re.test(text) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return text;
    };
    try {
      await until(/datanotes change feed from/);
      expect((await e.op("owner", "insert_row", { table: WEIGHT, values: { label: "ZZSECRETHEALTH streamed", day: "2026-10-03", kg: 80.5, note: "ZZSECRETHEALTH stream" } })).status).toBe(200);
      expect((await e.route("nurse", "/tool-calls/record/", { tool: "select_rows", ok: true, value: "ZZSECRETHEALTH result" })).status).toBe(200);
      expect((await e.op("owner", "insert_row", { table: PANTRY, values: { item: "salt", qty: 1 } })).status).toBe(200);
      const got = await until(/"table":"personal\.food\.pantry"/);
      const events = [...got.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!) as Json);
      expect(events.map((x) => [x.kind, x.table])).toEqual([["insert", PANTRY]]);
      expect((events[0]!.row as Json).item).toBe("salt");
      expectNoLeak(got);
      // the owner's stream gets the weight event the cook's did not
      const owner = eventsOf(await e.op("owner", "list_changes", { since: head }));
      expect(owner.map((x) => [x.kind, x.table])).toEqual([
        ["insert", WEIGHT],
        ["insert", PANTRY],
      ]);
      // the cook's event ids are the feed's: the weight event's number is skipped
      expect([...got.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([owner[1]!.seq]);
    } finally {
      ac.abort();
    }
  });

  it("list_webhooks shows a restricted token only the webhooks on tables it may read", async () => {
    engine = await startReadEngine();
    const e = engine;
    const create = async (args: Json) => {
      const r = await e.op("owner", "create_webhook", { url: "http://127.0.0.1:9/hook", ...args });
      expect(r.status).toBe(200);
      return r.json.id as string;
    };
    const onWeight = await create({ tables: ["weight"] });
    const onPantry = await create({ tables: [PANTRY] });
    const onBoth = await create({ tables: ["pantry", WEIGHT] });
    const onAll = await create({});
    const onMeals = await create({ tables: ["meals", "pantry"] });
    const ids = (r: { json: Json }) => ((r.json.webhooks ?? []) as Json[]).map((w) => w.id);
    expect(ids(await e.op("owner", "list_webhooks"))).toEqual([onWeight, onPantry, onBoth, onAll, onMeals]);
    const cook = await e.op("cook", "list_webhooks");
    expect([cook.status, ids(cook)]).toEqual([200, [onPantry, onMeals]]);
    expect(cook.text).not.toContain("weight");
    expect(ids(await e.op("nurse", "list_webhooks"))).toEqual([onWeight]);
    expect(ids(await e.op("blind", "list_webhooks"))).toEqual([]);
    for (const t of ["legacy", "star"] as const) expect(ids(await e.op(t, "list_webhooks"))).toEqual([onWeight, onPantry, onBoth, onAll, onMeals]);
  });
});

describe("change stream: the scope of the token", () => {
  /** A feed whose pages are given, recording the scope each wait got. */
  function feedOf(pages: Partial<ChangePage>[]) {
    const scopes: (ReadScope | null | undefined)[] = [];
    const feed = {
      lastSeq: 0,
      async wait(q: { since?: number }, _ms: number, scope?: ReadScope | null): Promise<ChangePage> {
        scopes.push(scope);
        const p = pages.shift();
        if (!p) await new Promise((r) => setTimeout(r, 20));
        return { events: [], last: q.since ?? 0, head: 0, ...p };
      },
    };
    return { feed: feed as unknown as ChangeFeed, scopes };
  }

  async function serve(opts: { readScopeSupported?: boolean; readScopeOf?: (name: string) => ReadScope | null; feed: ChangeFeed }) {
    const s = await setupReadTokens();
    const server = new HttpApiServer({
      app: s.v.app,
      handlers: {},
      token: "owner-token",
      port: 0,
      host: "127.0.0.1",
      changeFeed: () => opts.feed,
      tokens: { authenticate: async (t) => (t === "cook-secret" ? { name: "cook" } : null) },
      ...(opts.readScopeOf ? { readScopeOf: opts.readScopeOf } : {}),
      ...(opts.readScopeSupported !== undefined ? { readScopeSupported: opts.readScopeSupported } : {}),
    });
    const port = await server.start();
    return { s, server, url: `http://127.0.0.1:${port}/datanotes/changes/stream` };
  }

  it("is 503 for a restricted token where a read scope cannot be carried, as the guard answers", async () => {
    const { feed } = feedOf([]);
    const { server, url } = await serve({ feed, readScopeOf: () => COOK, readScopeSupported: false });
    try {
      const res = await fetch(url, { headers: { Authorization: "Bearer cook-secret" } });
      const body = await res.json();
      const guard = await (await setupReadTokens({ readScopeSupported: false })).op("cook", "select_rows", { table: PANTRY });
      expect([res.status, body]).toEqual([503, guard.json]);
      expect(guard.status).toBe(503);
    } finally {
      await server.stop();
    }
  });

  it("passes the token's scope to the feed, and none for the owner or a token that reads everything", async () => {
    const asked: string[] = [];
    const { feed, scopes } = feedOf([{}]);
    const { server, url } = await serve({
      feed,
      readScopeOf: (name) => {
        asked.push(name);
        return COOK;
      },
      readScopeSupported: true,
    });
    try {
      const ac = new AbortController();
      const res = await fetch(`${url}?since=0`, { headers: { Authorization: "Bearer cook-secret" }, signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read();
      for (let i = 0; i < 50 && scopes.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      expect(asked).toEqual(["cook"]);
      expect(scopes[0]).toEqual(COOK);

      const ac2 = new AbortController();
      const owner = await fetch(`${url}?since=0`, { headers: { Authorization: "Bearer owner-token" }, signal: ac2.signal });
      expect(owner.status).toBe(200);
      const before = scopes.length;
      await owner.body!.getReader().read();
      for (let i = 0; i < 50 && scopes.length === before; i++) await new Promise((r) => setTimeout(r, 10));
      ac2.abort();
      expect(scopes[before]).toBeNull();
      expect(asked).toEqual(["cook"]); // the owner has no token to look up
    } finally {
      await server.stop();
    }
  });

  it("a webhook's deliveries are the owner's, whatever scope the code that started them runs in", async () => {
    const s = await setupReadTokens();
    const { feed, scopes } = feedOf([]);
    const hooks = new WebhookDispatcher(s.v.app, () => s.v.settings, () => feed, async () => ({ status: 200 }));
    await runWithReadScope(COOK, async () => {
      await hooks.start();
      await hooks.create({ url: "http://127.0.0.1:9/hook", tables: [PANTRY] });
    });
    for (let i = 0; i < 50 && scopes.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await hooks.stop();
    expect(scopes[0]).toBeNull();
  });
});
