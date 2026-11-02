/**
 * The agent sessions of each credential (`POST /datanotes/sessions/`, src/server/runtime.ts, read
 * from the change feed's day files by `ChangeFeed.sessions`) and the `auth` / `session` filters of
 * `list_changes`, on a started engine over HTTP.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guided } from "./helpers/guidance";
import { PANTRY, startReadEngine, type ReadEngine, READ_OWNER_TOKEN } from "./helpers/read-tokens";
import { METASTORE, TEST_DATABASE_FOLDER } from "./helpers/db-vault";
import { mergeWithDefaults } from "../src/core/settings";
import { openNodeVault } from "../src/node/node-app";
import { EngineRuntime } from "../src/server/runtime";
import { DOCS, DOCS_BASE } from "../src/core/hints";

const SESSION = "s-cook-0123456789abcdef";
const AGENT = { harness: "claude-code", model: "claude-opus-5-5", session: SESSION };

let e: ReadEngine;

/** A request over HTTP with a token's secret (or the owner's) and, when given, the agent it acts for. */
async function post(token: "owner" | "cook", route: string, body: unknown, actor?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const bearer = token === "owner" ? READ_OWNER_TOKEN : e.secrets.cook;
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
  if (actor) headers["X-Datanotes-Actor"] = JSON.stringify(actor);
  const res = await fetch(`${e.url}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface Session {
  token: string;
  session: string | null;
  harness?: string;
  model?: string;
  first_at: string;
  last_at: string;
  first_seq: number;
  last_seq: number;
  tool_call_count: number;
  failed_tool_call_count: number;
  row_change_count: number;
  migration_count: number;
  tables: string[];
  tools: { tool: string; call_count: number }[];
}

const sessionsOf = (r: { json: Record<string, unknown> }) => r.json.sessions as Session[];

beforeAll(async () => {
  e = await startReadEngine();
  expect((await post("cook", "/sessions/identify/", { session: SESSION, harness: AGENT.harness, model: AGENT.model })).status).toBe(200);
  expect((await post("cook", "/operations/insert_row/", { table: PANTRY, values: { item: "rice", qty: 2 } }, { session: SESSION })).status).toBe(200);
  expect((await post("cook", "/tool-calls/record/", { tool: "insert_row", args: {}, ok: true, duration_ms: 4, value: "ok", session: SESSION }, { session: SESSION })).status).toBe(200);
  expect((await post("cook", "/tool-calls/record/", { tool: "select_rows", args: {}, ok: false, duration_ms: 2, value: "no", session: SESSION }, { session: SESSION })).status).toBe(200);
  expect((await post("owner", "/operations/insert_row/", { table: PANTRY, values: { item: "salt", qty: 1 } })).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await e?.dispose();
});

describe("sessions/", () => {
  it("lists cook's session with exact counts, and the owner's work without a session", async () => {
    const r = await post("owner", "/sessions/", {});
    expect(r.status).toBe(200);
    expect(Date.parse(r.json.since as string)).toBeLessThan(Date.now() - 6 * 86_400_000);
    const all = sessionsOf(r);
    const cook = all.find((x) => x.token === "cook")!;
    expect(cook).toMatchObject({
      token: "cook",
      session: SESSION,
      harness: "claude-code",
      model: "claude-opus-5-5",
      tool_call_count: 2,
      failed_tool_call_count: 1,
      row_change_count: 1,
      migration_count: 1,
      tables: [PANTRY],
    });
    expect(cook.tools).toEqual([
      { tool: "insert_row", call_count: 1 },
      { tool: "select_rows", call_count: 1 },
    ]);
    expect(cook.first_seq).toBeLessThanOrEqual(cook.last_seq);
    expect(Date.parse(cook.first_at)).toBeLessThanOrEqual(Date.parse(cook.last_at));
    const owner = all.find((x) => x.token === "owner")!;
    expect(owner.session).toBeNull();
    expect(owner.row_change_count).toBeGreaterThan(0);
    // the most recent first: the owner wrote last
    expect(all[0]!.token).toBe("owner");
    expect(Date.parse(all[0]!.last_at)).toBeGreaterThanOrEqual(Date.parse(cook.last_at));
  });

  it("keeps one token's sessions, nothing after a future since, and cuts to limit", async () => {
    expect(sessionsOf(await post("owner", "/sessions/", { token: "cook" })).map((x) => x.token)).toEqual(["cook"]);
    const future = await post("owner", "/sessions/", { since: "2999-01-01T00:00:00Z" });
    expect(future.json).toEqual({ since: "2999-01-01T00:00:00.000Z", sessions: [] });
    expect(sessionsOf(await post("owner", "/sessions/", { limit: 1, since: null, token: null }))).toHaveLength(1);
  });

  it("refuses bad input with exact messages and the sessions' guidance", async () => {
    const bad = async (body: Record<string, unknown>, error: string) => {
      const r = await post("owner", "/sessions/", body);
      expect(r).toEqual({ status: 400, json: guided(error) });
      expect(r.json.docs).toBe(`${DOCS_BASE}${DOCS.listSessions}`);
    };
    const since = `"since" must be a date-time (ISO 8601), such as 2026-11-01T00:00:00Z`;
    await bad({ since: "yesterday" }, since);
    await bad({ since: 5 }, since);
    const limit = `"limit" must be an integer from 1 to 1000`;
    for (const l of [0, 1001, "x", 1.5]) await bad({ limit: l }, limit);
    await bad({ token: 5 }, `"token" must be a token's name, or "owner"`);
    const token = await post("owner", "/sessions/", { token: 5 });
    expect(token.json.hint).toBe('Pass a token\'s name (POST /datanotes/tokens/ lists them) or "owner"; leave it out for every credential.');
  });

  it("leaves out hand edits, which have no credential", async () => {
    fs.writeFileSync(path.join(e.root, e.paths.flour), fs.readFileSync(path.join(e.root, e.paths.flour), "utf8").replace("qty: 1", "qty: 3"));
    const deadline = Date.now() + 15_000;
    let external = 0;
    while (external === 0 && Date.now() < deadline) {
      const r = await post("owner", "/operations/list_changes/", { tables: [PANTRY] });
      external = (r.json.events as { source: string }[]).filter((ev) => ev.source === "external").length;
      if (external === 0) await new Promise((res) => setTimeout(res, 100));
    }
    expect(external).toBeGreaterThan(0);
    const all = sessionsOf(await post("owner", "/sessions/", {}));
    expect(all.every((x) => x.token === "owner" || x.token === "cook")).toBe(true);
    expect(all.find((x) => x.token === "cook")!.row_change_count).toBe(1);
  }, 20_000);

  it("is the owner's: cook gets 403", async () => {
    expect(await post("cook", "/sessions/", {})).toEqual({ status: 403, json: guided("token cook may not call /sessions/ (reserved to the owner)") });
  });

  it("fills the harness and model from what the session reported when its events lack them", async () => {
    const other = "s-cook-ffffffffffffffff-long";
    expect((await post("owner", "/sessions/identify/", { session: other, harness: "cursor", model: "m-1" })).status).toBe(200);
    // the tool call names its session in the call only: the actor carries none
    expect((await post("owner", "/tool-calls/record/", { tool: "list_tables", args: {}, ok: true, duration_ms: 1, value: [], session: other })).status).toBe(200);
    const found = sessionsOf(await post("owner", "/sessions/", { token: "owner" })).find((x) => x.session === other)!;
    expect(found).toMatchObject({ token: "owner", harness: "cursor", model: "m-1", tool_call_count: 1, row_change_count: 0, migration_count: 0, tables: [] });
  });
});

describe("list_changes auth and session", () => {
  it("keeps one session's tool calls, by its full id or its first 16 characters", async () => {
    for (const session of [SESSION, SESSION.slice(0, 16)]) {
      const r = await post("owner", "/operations/list_changes/", { kinds: ["tool_call"], session });
      expect(r.status).toBe(200);
      expect((r.json.events as { kind: string; call: { tool: string } }[]).map((ev) => [ev.kind, ev.call.tool])).toEqual([
        ["tool_call", "insert_row"],
        ["tool_call", "select_rows"],
      ]);
    }
  });

  it("keeps the changes of one credential", async () => {
    const r = await post("owner", "/operations/list_changes/", { auth: "cook" });
    const events = r.json.events as { kind: string; table: string; actor: { auth: string } }[];
    expect(events.map((ev) => [ev.kind, ev.table, ev.actor.auth])).toEqual([["insert", PANTRY, "cook"]]);
    const none = await post("owner", "/operations/list_changes/", { auth: "nobody", session: "x" });
    expect(none.json.events).toEqual([]);
  });
});

describe("sessions/ without a change feed", () => {
  it("answers 503 with the change feed's guidance", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-nofeed-"));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-nofeed-store-"));
    try {
      fs.mkdirSync(path.dirname(path.join(root, METASTORE)), { recursive: true });
      fs.writeFileSync(path.join(root, METASTORE), "catalogs: {}\n");
      const host = openNodeVault(root, undefined, { store });
      const s = mergeWithDefaults({ fileLogEnabled: false, databaseFolder: TEST_DATABASE_FOLDER });
      const runtime = new EngineRuntime({ app: host.app, getSettings: () => s, saveSettings: async () => {}, transport: async () => ({ status: 500, text: "" }), embeddingKey: () => undefined, version: "3.0.0-test", hostName: "service", canServeHttp: false, httpHost: "127.0.0.1", env: {} });
      const r = await runtime.handlers()["/sessions/"]!({});
      expect(r).toEqual({ status: 503, json: guided("the change feed is not available") });
      expect((r.json as { docs: string }).docs).toBe(`${DOCS_BASE}${DOCS.changeFeed}`);
      await runtime.dispose();
    } finally {
      for (const d of [root, store]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
