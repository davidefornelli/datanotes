/**
 * The token registry (`src/server/tokens.ts`) without sockets: requests run through the same chain
 * the HTTP server uses (actor of the request, permission guard, dispatch, real route handlers).
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithActor, type Actor } from "../src/core/actor";
import { INDEX_RETRY } from "../src/core/engine";
import { NOOP_TELEMETRY, setTelemetry, type AttrValue } from "../src/core/telemetry";
import { sha256Hex, TokenRegistry, tokenNameOf, type PublicToken } from "../src/server/tokens";
import { BadRequest, createHandlers, dispatch, Forbidden, type Handler, type HandlerResponse } from "../src/server/rest";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { guided } from "./helpers/guidance";
import { described } from "./helpers/descriptions";

beforeAll(() => {
  INDEX_RETRY.delayMs = 1;
});

const NOW = "2026-10-08T09:00:00.000Z";

/** Log records of the engine, as the telemetry sink receives them. */
let logs: { severity: string; body: string; attributes?: Record<string, AttrValue> }[] = [];
beforeEach(() => {
  vi.setSystemTime(new Date(NOW));
  logs = [];
  setTelemetry({ log: (severity, body, attributes) => void logs.push({ severity, body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
});
afterEach(() => {
  vi.useRealTimers();
  setTelemetry(NOOP_TELEMETRY);
});
const logged = (body: string) => logs.filter((l) => l.body === body);

/** A personal vault: a food catalog (pantry, meals) and health data (weight). */
const FOOD_YAML = `catalogs:
  personal:
    schemas:
      food:
        tables:
          pantry:
            options: { filename: "{item}" }
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: item, type: string, required: true }
              - { name: qty, type: number, min: 0 }
          meals:
            options: { filename: "{dish}" }
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: dish, type: string, required: true }
      health:
        tables:
          weight:
            options: { filename: "{day:YYYY-MM-DD}" }
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: day, type: date, required: true }
              - { name: kg, type: number, required: true }
`;

interface Setup {
  v: DbVault;
  registry: TokenRegistry;
  /** A request with the owner's token. */
  owner(route: string, body?: unknown): Promise<HandlerResponse>;
  /** A request with a named token (the agent it acts for, if any). */
  as(token: string, route: string, body?: unknown, agent?: Actor): Promise<HandlerResponse>;
  tokensFile(): unknown;
}

function setup(opts: { yaml?: string; vault?: DbVault } = {}): Setup {
  const v = opts.vault ?? createDbVault({ [METASTORE]: opts.yaml ?? FOOD_YAML });
  const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
  // the engine's routes and the registry's, behind the permission guard (as the HTTP server runs them)
  const routes: Record<string, Handler> = { ...createHandlers(v.app, () => v.settings), ...registry.handlers() };
  const guarded = registry.guard(dispatch);
  const run = (actor: Actor, route: string, body: unknown) => runWithActor(actor, () => guarded(route, routes[route]!, body));
  return {
    v,
    registry,
    owner: (route, body = {}) => run({ auth: "owner" }, route, body),
    as: (token, route, body = {}, agent = { harness: token }) => run({ ...agent, auth: token }, route, body),
    tokensFile: () => JSON.parse(v.read("store:tokens.json")),
  };
}

/** What `/tokens/create/` answers. */
async function create(s: Setup, body: Record<string, unknown>): Promise<{ entry: PublicToken; token: string }> {
  const r = await s.owner("/tokens/create/", body);
  expect(r.status).toBe(200);
  return r.json as { entry: PublicToken; token: string };
}

/** The error a call throws (it must throw). */
async function thrown(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to throw");
}

const bad = (error: string) => ({ status: 400, json: guided(error) });
const forbidden = (error: string) => ({ status: 403, json: guided(error) });

describe("tokenNameOf", () => {
  it.each<[string, Actor | undefined, string | undefined]>([
    ["no actor", undefined, undefined],
    ["an actor without a credential (a request inside the engine)", { harness: "obsidian" }, undefined],
    ["the owner's token", { auth: "owner", harness: "claude-code" }, undefined],
    ["a named token", { auth: "pantry", harness: "claude-code" }, "pantry"],
  ])("reads %s", (_title, actor, expected) => {
    expect(tokenNameOf(actor)).toBe(expected);
  });
});

describe("token registry: the registry file", () => {
  it("starts empty when tokens.json cannot be parsed, logs why, and writes a valid file at the next change", async () => {
    const s = setup();
    const broken = '[{"name": "pantry", ';
    s.v.write("store:tokens.json", broken);
    let parseError = "";
    try {
      JSON.parse(broken);
    } catch (e) {
      parseError = (e as Error).message;
    }

    expect(await s.owner("/tokens/")).toEqual({ status: 200, json: { tokens: [] } });
    expect(logged("datanotes could not read the token registry")).toEqual([{ severity: "WARN", body: "datanotes could not read the token registry", attributes: { error: parseError } }]);

    await create(s, { name: "pantry", write: ["personal.food.*"] });
    expect((s.tokensFile() as { name: string }[]).map((t) => t.name)).toEqual(["pantry"]);
  });

  it("is read back by a restarted engine: the tokens, their permissions and their hashes", async () => {
    const first = setup();
    const { token } = await create(first, { name: "pantry", description: "the kitchen tablet", write: ["personal.food.pantry"], maintain: true });
    await create(first, { name: "reporting" });

    const restarted = setup({ vault: first.v });
    expect((await restarted.owner("/tokens/")).json).toEqual({ tokens: first.registry.list() });
    expect(restarted.registry.list()).toEqual([
      { name: "pantry", description: "the kitchen tablet", read: ["*"], write: ["personal.food.pantry"], ddl: false, maintain: true, created_at: NOW, updated_at: NOW },
      { name: "reporting", read: ["*"], write: [], ddl: false, created_at: NOW, updated_at: NOW },
    ]);
    expect((await restarted.registry.authenticate(token))?.name).toBe("pantry");
  });

  it("keeps the tokens in memory when tokens.json cannot be written, and logs it", async () => {
    const s = setup();
    fs.rmSync(s.v.storeRoot, { recursive: true });
    fs.writeFileSync(s.v.storeRoot, "a file where the store folder should be");
    const { entry, token } = await create(s, { name: "pantry", write: ["personal.food.*"] });
    expect(entry.name).toBe("pantry");
    const saves = logged("datanotes could not save tokens.json");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.severity).toBe("WARN");
    expect(String(saves[0]!.attributes?.error)).toMatch(/^E(NOTDIR|NOENT|EXIST)\b/);
    // the token works for this process
    expect((await s.registry.authenticate(token))?.name).toBe("pantry");
  });
});

describe("token registry: creating a token", () => {
  it("refuses bad names, values of the wrong type and bad write patterns, with the reason", async () => {
    const s = setup();
    expect(await s.owner("/tokens/create/", { name: "Pantry" })).toEqual(bad(`"name" must be kebab-case (a-z, 0-9, -)`));
    expect(await s.owner("/tokens/create/", { name: "-pantry" })).toEqual(bad(`"name" must be kebab-case (a-z, 0-9, -)`));
    expect(await s.owner("/tokens/create/", {})).toEqual(bad(`"name" must be kebab-case (a-z, 0-9, -)`));
    expect(await s.owner("/tokens/create/", { name: "owner" })).toEqual(bad(`"owner" is reserved (the owner's token)`));
    expect(await s.owner("/tokens/create/", { name: 42 })).toEqual(bad(`"name" must be a string`));
    expect(await s.owner("/tokens/create/", { name: "pantry", description: ["groceries"] })).toEqual(bad(`"description" must be a string`));
    expect(await s.owner("/tokens/create/", { name: "pantry", write: "personal.food.*" })).toEqual(bad(`"write" must be a list of strings`));
    expect(await s.owner("/tokens/create/", { name: "pantry", write: ["personal.food.pantry", 7] })).toEqual(bad(`"write" must be a list of strings`));
    expect(await s.owner("/tokens/create/", { name: "pantry", write: ["personal..food"] })).toEqual(bad(`write pattern "personal..food" must be a table name, catalog.schema.*, catalog.* or *`));
    expect(await s.owner("/tokens/create/", { name: "pantry", write: ["personal.food.pantry.notes"] })).toEqual(
      bad(`write pattern "personal.food.pantry.notes" must be a table name, catalog.schema.*, catalog.* or *`),
    );
    expect(await s.owner("/tokens/create/", { name: "pantry", write: ["personal.*.pantry"] })).toEqual(bad(`write pattern "personal.*.pantry" must be a table name, catalog.schema.*, catalog.* or *`));
    // nothing was registered by a refused request
    expect(s.registry.list()).toEqual([]);
    expect(s.v.exists("store:tokens.json")).toBe(false);

    await create(s, { name: "pantry" });
    expect(await s.owner("/tokens/create/", { name: "pantry", write: ["*"] })).toEqual(bad("token pantry already exists (update it, or delete it first)"));
    expect(s.registry.get("pantry")?.write).toEqual([]);
  });

  it("stores what the owner gives (repeated patterns once) and only the hash of the token", async () => {
    const s = setup();
    const { entry, token } = await create(s, { name: "pantry", description: "the kitchen tablet", write: ["personal.food.*", "personal.food.pantry", "personal.food.*"], ddl: true, maintain: true });
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(entry).toEqual({ name: "pantry", description: "the kitchen tablet", read: ["*"], write: ["personal.food.*", "personal.food.pantry"], ddl: true, maintain: true, created_at: NOW, updated_at: NOW });
    // the file keeps its own keys (camelCase); the answer is snake_case
    expect(s.tokensFile()).toEqual([{ name: "pantry", description: "the kitchen tablet", tokenHash: await sha256Hex(token), write: ["personal.food.*", "personal.food.pantry"], ddl: true, maintain: true, createdAt: NOW, updatedAt: NOW }]);
    expect(s.v.read("store:tokens.json")).not.toContain(token);
    expect(logged("datanotes token created")).toEqual([{ severity: "INFO", body: "datanotes token created", attributes: { token_name: "pantry" } }]);
  });

  it("gives a token with only a name no permissions; the plugin fields of former apps are ignored", async () => {
    const s = setup();
    const { entry } = await create(s, { name: "reporting", ddl: "yes", maintain: 1, mcp_url: "https://reporting.example/mcp", mcp_token: "secret", instructions: "Be brief." });
    expect(entry).toEqual({ name: "reporting", read: ["*"], write: [], ddl: false, created_at: NOW, updated_at: NOW });
    expect(s.v.read("store:tokens.json")).not.toMatch(/mcp|secret|Be brief/);
  });
});

describe("token registry: updating a token", () => {
  it("refuses an unknown token, a missing name and values of the wrong type", async () => {
    const s = setup();
    await create(s, { name: "pantry" });
    expect(await s.owner("/tokens/update/", { name: "ghost", description: "x" })).toEqual(bad("no token ghost"));
    expect(await s.owner("/tokens/update/", { description: "x" })).toEqual(bad(`"name" is required`));
    expect(await s.owner("/tokens/update/", { name: "pantry", ddl: "yes" })).toEqual(bad(`"ddl" must be true or false`));
    expect(await s.owner("/tokens/update/", { name: "pantry", maintain: 1 })).toEqual(bad(`"maintain" must be true or false`));
    expect(await s.owner("/tokens/update/", { name: "pantry", write: [true] })).toEqual(bad(`"write" must be a list of strings`));
    expect(await s.owner("/tokens/update/", { name: "pantry", description: 8080 })).toEqual(bad(`"description" must be a string`));
    expect(await s.owner("/tokens/update/", { name: "pantry", write: ["personal food"] })).toEqual(bad(`write pattern "personal food" must be a table name, catalog.schema.*, catalog.* or *`));
    expect(s.registry.get("pantry")).toMatchObject({ write: [], ddl: false, updatedAt: NOW });
  });

  it("lets a token change its own description, never its permissions nor another token", async () => {
    const s = setup();
    await create(s, { name: "pantry", write: ["personal.food.pantry"] });
    await create(s, { name: "reporting" });
    const refused = forbidden("a token cannot change its own permissions");
    expect(await s.as("pantry", "/tokens/update/", { write: ["*"] })).toEqual(refused);
    expect(await s.as("pantry", "/tokens/update/", { ddl: true })).toEqual(refused);
    expect(await s.as("pantry", "/tokens/update/", { maintain: true })).toEqual(refused);
    expect(await s.as("pantry", "/tokens/update/", { ddl: false })).toEqual(refused);
    // a token updates its own entry, whatever name it sends
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
    const r = await s.as("pantry", "/tokens/update/", { name: "reporting", description: "the kitchen tablet" });
    expect(r).toEqual({
      status: 200,
      json: { entry: { name: "pantry", description: "the kitchen tablet", read: ["*"], write: ["personal.food.pantry"], ddl: false, created_at: NOW, updated_at: "2026-10-08T10:00:00.000Z" } },
    });
    expect(s.registry.get("reporting")).not.toHaveProperty("description");
    // an empty description removes it
    await s.as("pantry", "/tokens/update/", { description: "" });
    expect(s.registry.get("pantry")).not.toHaveProperty("description");
  });

  it("lets the owner grant and take back permissions", async () => {
    const s = setup();
    await create(s, { name: "assistant" });
    const grant = await s.owner("/tokens/update/", { name: "assistant", write: ["personal.*", "personal.*"], ddl: true, maintain: true });
    expect(grant.json).toMatchObject({ entry: { write: ["personal.*"], ddl: true, maintain: true } });
    const revoke = await s.owner("/tokens/update/", { name: "assistant", write: [], ddl: false, maintain: false });
    expect((revoke.json as { entry: PublicToken }).entry).toEqual({ name: "assistant", read: ["*"], write: [], ddl: false, created_at: NOW, updated_at: NOW });
    expect((s.tokensFile() as Record<string, unknown>[])[0]).not.toHaveProperty("maintain");
  });
});

describe("token registry: revoking, rotating, authenticating", () => {
  it("deletes a token (false when there is none) and it stops working", async () => {
    const s = setup();
    const { token } = await create(s, { name: "pantry" });
    expect(await s.owner("/tokens/delete/", { name: "ghost" })).toEqual({ status: 200, json: { deleted: false } });
    expect(await s.owner("/tokens/delete/", { name: "pantry" })).toEqual({ status: 200, json: { deleted: true } });
    expect(await s.registry.authenticate(token)).toBeNull();
    expect(s.tokensFile()).toEqual([]);
  });

  it("rotates a token: the old value stops working, the new one works", async () => {
    const s = setup();
    const { token } = await create(s, { name: "pantry" });
    expect(await s.owner("/tokens/rotate/", { name: "ghost" })).toEqual(bad("no token ghost"));
    const r = await s.owner("/tokens/rotate/", { name: "pantry" });
    const rotated = (r.json as { token: string }).token;
    expect(rotated).toMatch(/^[0-9a-f]{48}$/);
    expect(await s.registry.authenticate(token)).toBeNull();
    expect((await s.registry.authenticate(rotated))?.name).toBe("pantry");
    expect((s.tokensFile() as { tokenHash: string }[])[0]!.tokenHash).toBe(await sha256Hex(rotated));
  });

  it("never matches a short or unknown token; records when a token was last seen, saved within a minute", async () => {
    vi.useRealTimers(); // the clock of beforeEach, replaced by fake timers
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date(NOW) });
    const s = setup();
    const { token } = await create(s, { name: "pantry" });
    expect(await s.registry.authenticate(token.slice(0, 15))).toBeNull();
    expect(await s.registry.authenticate("f".repeat(48))).toBeNull();
    vi.setSystemTime(new Date("2026-10-08T09:05:00.000Z"));
    expect((await s.registry.authenticate(token))?.lastSeen).toBe("2026-10-08T09:05:00.000Z");
    vi.setSystemTime(new Date("2026-10-08T09:05:30.000Z"));
    expect((await s.registry.authenticate(token))?.lastSeen).toBe("2026-10-08T09:05:30.000Z");
    expect((s.tokensFile() as Record<string, unknown>[])[0]).not.toHaveProperty("lastSeen");
    await vi.advanceTimersByTimeAsync(60_000);
    await s.registry.stop(); // waits for the save
    expect((s.tokensFile() as Record<string, unknown>[])[0]!.lastSeen).toBe("2026-10-08T09:05:30.000Z");
  });

  it("stops before the last-seen save: nothing pending is left", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date(NOW) });
    const s = setup();
    const { token } = await create(s, { name: "pantry" });
    await s.registry.authenticate(token);
    await s.registry.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect((s.tokensFile() as Record<string, unknown>[])[0]).not.toHaveProperty("lastSeen");
  });
});

describe("token registry: the routes a token may call about itself", () => {
  it("keeps the registry's administration to the owner: through the permission guard and without it", async () => {
    const s = setup();
    await create(s, { name: "pantry", maintain: true });
    // through the guard (the HTTP server)
    for (const route of ["/tokens/", "/tokens/create/", "/tokens/delete/", "/tokens/rotate/"]) {
      expect(await s.as("pantry", route, { name: "pantry" })).toEqual(forbidden(`token pantry may not call ${route} (reserved to the owner)`));
    }
    // the handlers refuse it too when they run without the guard
    const routes = s.registry.handlers();
    for (const route of ["/tokens/", "/tokens/create/", "/tokens/delete/", "/tokens/rotate/"]) {
      const out = await runWithActor({ auth: "pantry" }, () => dispatch(route, routes[route]!, { name: "evil" }));
      expect(out).toEqual(forbidden("reserved to the owner"));
    }
    const e = await thrown(runWithActor({ auth: "pantry" }, () => routes["/tokens/"]!({})));
    expect(e).toBeInstanceOf(Forbidden);
    expect(s.registry.list().map((t) => t.name)).toEqual(["pantry"]);
  });

  it("lists every token for the owner, and tells a token about itself only", async () => {
    const s = setup();
    await create(s, { name: "pantry", write: ["personal.food.*"] });
    await create(s, { name: "reporting" });
    const all = await s.owner("/tokens/");
    expect((all.json as { tokens: PublicToken[] }).tokens.map((t) => t.name)).toEqual(["pantry", "reporting"]);
    expect(await s.as("reporting", "/tokens/me/")).toEqual({ status: 200, json: { entry: { name: "reporting", read: ["*"], write: [], ddl: false, created_at: NOW, updated_at: NOW } } });
    expect(await s.owner("/tokens/me/")).toEqual(bad("call this with a named token"));
    const e = await thrown(runWithActor({ auth: "owner" }, () => s.registry.handlers()["/tokens/me/"]!({})));
    expect(e).toBeInstanceOf(BadRequest);
  });

  it("answers null to a token deleted while it still calls, and refuses its other requests", async () => {
    const s = setup();
    await create(s, { name: "pantry", write: ["personal.food.*"] });
    await s.owner("/tokens/delete/", { name: "pantry" });
    const routes = s.registry.handlers();
    expect(await runWithActor({ auth: "pantry" }, () => dispatch("/tokens/me/", routes["/tokens/me/"]!, {}))).toEqual({ status: 200, json: { entry: null } });
    expect(await s.as("pantry", "/operations/insert_row/", { table: "pantry", values: { item: "eggs" } })).toEqual(forbidden("unknown token"));
    expect(await s.registry.check("pantry", "/operations/select_rows/", {})).toBe("unknown token");
  });

  it("has no routes of the former plugin mechanism", () => {
    const routes = Object.keys(setup().registry.handlers());
    expect(routes).toEqual(["/tokens/", "/tokens/me/", "/tokens/create/", "/tokens/update/", "/tokens/delete/", "/tokens/rotate/"]);
  });
});

describe("token registry: what a token may write", () => {
  async function tokens(yaml?: string) {
    const s = setup(yaml ? { yaml } : {});
    await create(s, { name: "pantry", write: ["personal.food.*"] });
    await create(s, { name: "reporting" });
    await create(s, { name: "architect", write: ["personal.food.pantry"], ddl: true });
    await create(s, { name: "assistant", write: ["*"], maintain: true });
    return s;
  }

  it("lets every token read, and report its agents' sessions and tool calls", async () => {
    const s = await tokens();
    for (const route of ["/operations/list_tables/", "/operations/select_rows/", "/operations/describe_table/", "/operations/list_changes/", "/operations/describe_history/", "/operations/list_migrations/", "/tokens/me/", "/sessions/identify/", "/tool-calls/record/", "/manual/search/"]) {
      expect(await s.registry.check("reporting", route, { table: "weight" })).toBeNull();
    }
    const r = await s.as("reporting", "/operations/select_rows/", { table: "pantry" });
    expect(r.status).toBe(200);
  });

  it("writes rows only into the tables its patterns name, by qualified name", async () => {
    const s = await tokens();
    const ins = await s.as("pantry", "/operations/insert_row/", { table: "pantry", values: { item: "eggs", qty: 6 } });
    expect(ins.status).toBe(200);
    expect((ins.json as { ok: boolean }).ok).toBe(true);
    expect(await s.as("pantry", "/operations/insert_row/", { table: "weight", values: { day: "2026-10-08", kg: 71.5 } })).toEqual(forbidden("token pantry may not write personal.health.weight"));
    expect(await s.as("reporting", "/operations/insert_row/", { table: "personal.food.pantry", values: { item: "milk" } })).toEqual(forbidden("token reporting may not write personal.food.pantry"));
    // a move checks both tables
    expect(await s.registry.check("pantry", "/operations/move_rows/", { table: "pantry", to_table: "meals" })).toBeNull();
    expect(await s.as("pantry", "/operations/move_rows/", { table: "pantry", to_table: "weight", where: {} })).toEqual(forbidden("token pantry may not write personal.health.weight"));
    expect(await s.as("architect", "/operations/move_rows/", { table: "pantry", to_table: "personal.food.meals" })).toEqual(forbidden("token architect may not write personal.food.meals"));
    // a table missing from the request is the route's own error
    expect(await s.as("pantry", "/operations/move_rows/", { table: "pantry" })).toEqual(bad(`move_rows: missing required argument "to_table" (string); missing required argument "where" (object)`));
    // a name the metastore does not know is checked as written
    expect(await s.as("architect", "/operations/delete_rows/", { table: "snacks" })).toEqual(forbidden("token architect may not write snacks"));
    expect(await s.registry.check("pantry", "/operations/update_rows/", { table: "personal.food.snacks" })).toBeNull();
    // only the inserted row is there
    const rows = await s.owner("/operations/select_rows/", { table: "pantry" });
    expect((rows.json as { rows: Record<string, unknown>[] }).rows.map((r) => [r.item, r.qty])).toEqual([["eggs", 6]]);
    expect(logged("datanotes token refused").map((l) => l.attributes)).toEqual([
      { token_name: "pantry", "http.route": "/operations/insert_row/", reason: "token pantry may not write personal.health.weight" },
      { token_name: "reporting", "http.route": "/operations/insert_row/", reason: "token reporting may not write personal.food.pantry" },
      { token_name: "pantry", "http.route": "/operations/move_rows/", reason: "token pantry may not write personal.health.weight" },
      { token_name: "architect", "http.route": "/operations/move_rows/", reason: "token architect may not write personal.food.meals" },
      { token_name: "architect", "http.route": "/operations/delete_rows/", reason: "token architect may not write snacks" },
    ]);
  });

  it("does not take a name every object inherits for a row route", async () => {
    const s = await tokens();
    expect(await s.registry.check("pantry", "toString", { table: "pantry" })).toBe("token pantry may not call toString (reserved to the owner)");
    expect(await s.registry.check("pantry", "constructor", {})).toBe("token pantry may not call constructor (reserved to the owner)");
    expect(await s.registry.check("assistant", "toString", { table: "pantry" })).toBeNull();
  });

  it("changes the schema only with ddl", async () => {
    const s = await tokens();
    const add = described({ table: "pantry", column: { name: "expires", type: "date" } });
    expect(await s.as("pantry", "/operations/add_column/", add)).toEqual(forbidden("token pantry may not change the schema"));
    expect(await s.as("assistant", "/operations/add_column/", add)).toEqual(forbidden("token assistant may not change the schema"));
    const r = await s.as("architect", "/operations/add_column/", add);
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
  });

  it("checks every operation of a batch and names the first one refused", async () => {
    const s = await tokens();
    const refused = await s.as("pantry", "/operations/batch/", {
      operations: [
        { op: "insert_row", table: "pantry", values: { item: "rice", qty: 1 } },
        { op: "update_rows", table: "weight", where: {}, set: { kg: 70 } },
      ],
    });
    expect(refused).toEqual(forbidden("operation 1: token pantry may not write personal.health.weight"));
    expect(await s.as("pantry", "/operations/batch/", { operations: [described({ op: "create_table", table: "personal.food.snacks", columns: [] })] })).toEqual(forbidden("operation 0: token pantry may not change the schema"));
    // an operation without a name, or no object at all, counts as a schema change
    expect(await s.registry.check("pantry", "/operations/batch/", { operations: [{ table: "pantry" }] })).toBe("operation 0: token pantry may not change the schema");
    expect(await s.registry.check("pantry", "/operations/batch/", { operations: [{ op: "insert_row", table: "pantry" }, null] })).toBe("operation 1: token pantry may not change the schema");
    expect(await s.registry.check("pantry", "/operations/batch/", { operations: [{ op: "restore_table", table: "pantry", version: 1 }] })).toBe("operation 0: token pantry may not call restore_table (reserved to the owner)");
    expect(await s.registry.check("assistant", "/operations/batch/", { operations: [{ op: "restore_table", table: "pantry", version: 1 }] })).toBeNull();
    expect(await s.registry.check("architect", "/operations/batch/", { operations: [described({ op: "add_column", table: "pantry" }), { op: "insert_row", table: "pantry" }] })).toBeNull();
    // a name every object inherits is not a row operation: it counts as a schema change too
    expect(await s.registry.check("assistant", "/operations/batch/", { operations: [{ op: "toString", table: "pantry" }] })).toBe("operation 0: token assistant may not change the schema");
    // no list of operations: nothing to refuse here, the route says what is wrong
    expect(await s.as("pantry", "/operations/batch/", { operations: "insert_row" })).toEqual(bad(`batch: "operations" must be a list of objects, not string "insert_row"`));

    const ok = await s.as("pantry", "/operations/batch/", {
      operations: [
        { op: "insert_row", table: "pantry", values: { item: "rice", qty: 1 } },
        { op: "insert_row", table: "meals", values: { dish: "risotto" } },
      ],
    });
    expect(ok.status).toBe(200);
    const rows = await s.owner("/operations/select_rows/", { table: "meals" });
    expect((rows.json as { rows: Record<string, unknown>[] }).rows.map((r) => r.dish)).toEqual(["risotto"]);
  });

  it("keeps the owner's data routes to the owner, unless the token maintains; administration always", async () => {
    const s = await tokens();
    expect(await s.as("pantry", "/operations/undo_migration/", { migration_id: "m-1" })).toEqual(forbidden("token pantry may not call undo_migration (reserved to the owner)"));
    expect(await s.registry.check("assistant", "/operations/undo_migration/", { migration_id: "m-1" })).toBeNull();
    expect(await s.registry.check("assistant", "/vacuum/", {})).toBeNull();
    for (const op of ["create_webhook", "delete_webhook"]) {
      expect(await s.registry.check("assistant", `/operations/${op}/`, {})).toBe(`token assistant may not call ${op} (reserved to the owner)`);
    }
    for (const route of ["/tokens/create/", "/tokens/rotate/", "/status/", "/stop/"]) {
      expect(await s.registry.check("assistant", route, {})).toBe(`token assistant may not call ${route} (reserved to the owner)`);
    }
    // every token reads the targets of a link column and the vault's notes
    for (const op of ["list_link_targets", "read_note", "list_folder", "search_notes", "describe_semantic_index"]) expect(await s.registry.check("pantry", `/operations/${op}/`, {})).toBeNull();
    // the semantic index is synced by a token that maintains
    expect(await s.registry.check("pantry", "/operations/sync_semantic_index/", {})).toBe("token pantry may not call sync_semantic_index (reserved to the owner)");
  });

  it("checks the names as written when metastore.yaml cannot be read, so short names are refused", async () => {
    const s = await tokens("catalogs: [\n");
    expect(await s.registry.check("pantry", "/operations/insert_row/", { table: "pantry" })).toBe("token pantry may not write pantry");
    expect(await s.registry.check("pantry", "/operations/insert_row/", { table: "personal.food.pantry" })).toBeNull();
    expect(await s.registry.check("assistant", "/operations/insert_row/", { table: "pantry" })).toBeNull();
  });

  it("treats a body that is not an object as empty", async () => {
    const s = await tokens();
    expect(await s.registry.check("pantry", "/operations/insert_row/", null)).toBeNull();
    expect(await s.registry.check("pantry", "/operations/insert_row/", "pantry")).toBeNull();
    expect(await s.registry.check("pantry", "/operations/batch/", ["insert_row"])).toBeNull();
    expect(await s.as("pantry", "/operations/insert_row/", ["pantry"])).toEqual(bad("request body must be a JSON object"));
  });

  it("checks nothing for the owner", async () => {
    const s = await tokens();
    const r = await s.owner("/operations/insert_row/", { table: "weight", values: { day: "2026-10-08", kg: 71.5 } });
    expect(r.status).toBe(200);
    expect(logged("datanotes token refused")).toEqual([]);
  });
});
