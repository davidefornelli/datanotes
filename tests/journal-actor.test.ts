/**
 * The journal's actor in `list_migrations` (src/core/journal.ts): `actor` with the credential,
 * session, harness and model each write recorded, the `auth` filter, and `before` to page back.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guided } from "./helpers/guidance";
import { PANTRY, READ_OWNER_TOKEN, startReadEngine, WEIGHT, type ReadEngine } from "./helpers/read-tokens";
import { createDbVault, METASTORE } from "./helpers/db-vault";
import { READ_YAML } from "./helpers/read-tokens";
import { runWithActor } from "../src/core/actor";
import { createHandlers } from "../src/server/rest";
import { DOCS, DOCS_BASE } from "../src/core/hints";

const SESSION = "s-cook-journal-0123456789";
const AGENT = { harness: "claude-code", model: "claude-opus-5-5", session: SESSION };

interface Migration {
  migration_id: string;
  op: string;
  executed_at: string;
  by?: string;
  table?: string;
  actor?: { auth?: string; session?: string; harness?: string; model?: string };
}

let e: ReadEngine;

async function post(token: "owner" | "cook", route: string, body: unknown, actor?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token === "owner" ? READ_OWNER_TOKEN : e.secrets.cook}`, "Content-Type": "application/json" };
  if (actor) headers["X-Datanotes-Actor"] = JSON.stringify(actor);
  const res = await fetch(`${e.url}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const migrations = async (token: "owner" | "cook", args: Record<string, unknown>) => {
  const r = await post(token, "/operations/list_migrations/", args);
  expect(r.status).toBe(200);
  return r.json.migrations as Migration[];
};

const pause = () => new Promise((r) => setTimeout(r, 5));

beforeAll(async () => {
  e = await startReadEngine();
  expect((await post("cook", "/sessions/identify/", { session: SESSION, harness: AGENT.harness, model: AGENT.model })).status).toBe(200);
  await pause();
  expect((await post("cook", "/operations/insert_row/", { table: PANTRY, values: { item: "rice", qty: 2 } }, AGENT)).status).toBe(200);
  await pause();
  expect((await post("owner", "/operations/insert_row/", { table: PANTRY, values: { item: "salt", qty: 1 } })).status).toBe(200);
  await pause();
  expect((await post("owner", "/operations/insert_row/", { table: WEIGHT, values: { label: "Noon", day: "2026-10-03", kg: 80 } })).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await e?.dispose();
});

describe("list_migrations actor", () => {
  it("gives a cook write its credential, session, harness and model, and keeps by", async () => {
    const [cook] = await migrations("owner", { auth: "cook" });
    expect(cook).toMatchObject({ op: "insert_row", actor: { auth: "cook", session: SESSION, harness: "claude-code", model: "claude-opus-5-5" } });
    expect(cook!.by).toEqual(expect.stringContaining("claude-code"));
  });

  it("gives an owner write actor {auth: owner}", async () => {
    const [latest] = await migrations("owner", { limit: 1 });
    expect(latest!.actor).toEqual({ auth: "owner" });
  });

  it("keeps the operations of one credential", async () => {
    const cook = await migrations("owner", { auth: "cook" });
    expect(cook).toHaveLength(1);
    expect(await migrations("owner", { auth: "nobody" })).toEqual([]);
    expect((await migrations("owner", { auth: "owner" })).every((m) => m.actor?.auth === "owner")).toBe(true);
  });

  it("pages back one operation at a time with before", async () => {
    const all = await migrations("owner", { limit: 3 });
    expect(all).toHaveLength(3);
    const walked: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await migrations("owner", { limit: 1, ...(before !== undefined ? { before } : {}) });
      expect(page).toHaveLength(1);
      walked.push(page[0]!.migration_id);
      before = page[0]!.executed_at;
    }
    expect(walked).toEqual(all.map((m) => m.migration_id));
  });

  it("refuses a before that is not a date-time, with hint and docs", async () => {
    const r = await post("owner", "/operations/list_migrations/", { before: "yesterday" });
    expect(r).toEqual({ status: 400, json: guided(`"before" must be a date-time (ISO 8601), such as 2026-11-01T12:00:00Z`) });
    expect(r.json.docs).toBe(`${DOCS_BASE}${DOCS.journalPaging}`);
  });

  it("still hides from cook the writes of tables it may not read", async () => {
    const seen = await migrations("cook", { limit: 1000 });
    expect(seen.some((m) => m.table === WEIGHT)).toBe(false);
    expect(seen.some((m) => m.actor?.auth === "cook")).toBe(true);
  });
});

describe("list_migrations actor of in-process writes", () => {
  it("has no actor when the write recorded none, or only fields it does not show", async () => {
    const v = createDbVault({ [METASTORE]: READ_YAML });
    const h = createHandlers(v.app, () => v.settings);
    expect((await h["/operations/insert_row/"]!({ table: PANTRY, values: { item: "a" } })).status).toBe(200);
    expect((await runWithActor({ tool: "insert_row" }, () => h["/operations/insert_row/"]!({ table: PANTRY, values: { item: "b" } }))).status).toBe(200);
    const r = await h["/operations/list_migrations/"]!({});
    const list = (r.json as { migrations: Migration[] }).migrations;
    expect(list).toHaveLength(2);
    for (const m of list) expect(m.actor).toBeUndefined();
  });
});
