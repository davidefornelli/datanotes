/**
 * Read permissions of named tokens, Phase 0: the `read` field of the registry (src/server/tokens.ts)
 * and its rules, the guard's check of the tables a read names before it runs, the read scope the
 * guard sets for the engine (src/core/read-scope.ts) and its refusal, the static analysis of what a
 * query reads (src/core/query-tables.ts), and the read cache's key.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithActor } from "../src/core/actor";
import { DOCS, docsUrl, guidanceOf } from "../src/core/hints";
import {
  assertPathReadable,
  assertTableReadable,
  currentReadScope,
  matchesTablePattern,
  pathReadable,
  READ_DENIED_GUIDANCE,
  READ_SCOPE_SUPPORTED,
  ReadDeniedError,
  runWithReadScope,
  tableOfPath,
  tableReadable,
  type ReadScope,
} from "../src/core/read-scope";
import { tablesReadByQuery, tablesReadByView } from "../src/core/query-tables";
import { parseMetastore } from "../src/core/metastore";
import { NOOP_TELEMETRY, setTelemetry, type AttrValue } from "../src/core/telemetry";
import { dispatch, errorResponse, type HandlerResponse } from "../src/server/rest";
import { readCovers, scopeOf, TokenRegistry, type PublicToken, type TokenRecord } from "../src/server/tokens";
import { READ_TABLE_ARGS } from "../src/server/token-routes";
import { formatStatus } from "../src/node/status";
import type { EngineStatus } from "../src/server/status";
import { createDbVault, METASTORE } from "./helpers/db-vault";
import { DIARY_PATH, expectNoLeak, MEALS, PANTRY, READ_YAML, readRefusal, refusal, rowsOf, SENTINELS, setupReadTokens, startReadEngine, TOKENS, VW_HEAVY, VW_MIXED, WEIGHT, type ReadEngine } from "./helpers/read-tokens";

let logs: { severity: string; body: string; attributes?: Record<string, AttrValue> }[] = [];
beforeEach(() => {
  logs = [];
  setTelemetry({ log: (severity, body, attributes) => void logs.push({ severity, body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
});
const engines: ReadEngine[] = [];
afterEach(async () => {
  setTelemetry(NOOP_TELEMETRY);
  for (const e of engines.splice(0)) await e.dispose();
});

const bad = (error: string) => refusal(400, error);
const entryOf = (r: HandlerResponse) => (r.json as { entry: PublicToken }).entry;
const COOK: ReadScope = { token: "cook", patterns: ["personal.food.*"] };

describe("token registry: the read patterns of a token", () => {
  it("shows read in every entry: [\"*\"] when the token has none, its patterns when it has", async () => {
    const s = await setupReadTokens();
    expect(s.entries.legacy).toMatchObject({ name: "legacy", read: ["*"], write: ["personal.food.*"] });
    expect(s.entries.cook).toMatchObject({ name: "cook", read: ["personal.food.*"], write: ["personal.food.pantry"] });
    expect(s.entries.blind).toMatchObject({ read: [], write: [] });
    expect(s.entries.nurse).toMatchObject({ read: ["personal.health.*"] });
    expect(s.entries.star).toMatchObject({ read: ["*"] });
    // read comes right after the description, before write
    expect(Object.keys(s.entries.cook)).toEqual(["name", "read", "write", "ddl", "created_at", "updated_at"]);
    const list = (await s.owner("/tokens/")).json as { tokens: PublicToken[] };
    expect(list.tokens.map((t) => [t.name, t.read])).toEqual([
      ["legacy", ["*"]],
      ["cook", ["personal.food.*"]],
      ["blind", []],
      ["nurse", ["personal.health.*"]],
      ["star", ["*"]],
    ]);
    expect(entryOf(await s.as("cook", "/tokens/me/"))).toEqual(s.entries.cook);
    expect(entryOf(await s.as("legacy", "/tokens/me/")).read).toEqual(["*"]);
    // the registry file keeps read only where the owner gave it
    const file = JSON.parse(s.v.read("store:tokens.json")) as TokenRecord[];
    expect(file.map((t) => t.read)).toEqual([undefined, ["personal.food.*"], [], ["personal.health.*"], ["*"]]);
  });

  it("stores each pattern once, and a list with * as [\"*\"]", async () => {
    const s = await setupReadTokens();
    const r = await s.owner("/tokens/create/", { name: "twice", read: ["personal.food.*", "personal.food.*", "personal.health.weight"] });
    expect(entryOf(r).read).toEqual(["personal.food.*", "personal.health.weight"]);
    const star = await s.owner("/tokens/create/", { name: "wide", read: ["personal.food.*", "*"], write: ["personal.health.weight"], ddl: true });
    expect(entryOf(star)).toMatchObject({ read: ["*"], write: ["personal.health.weight"], ddl: true });
    // null on create is no read at all
    expect(entryOf(await s.owner("/tokens/create/", { name: "plain", read: null })).read).toEqual(["*"]);
    expect(s.registry.get("plain")).not.toHaveProperty("read");
  });

  it("refuses bad read patterns and values of the wrong type, with the reason and the read guidance", async () => {
    const s = await setupReadTokens();
    expect(await s.owner("/tokens/create/", { name: "x", read: "personal.food.*" })).toEqual(bad(`"read" must be a list of strings`));
    expect(await s.owner("/tokens/create/", { name: "x", read: ["personal.food.*", 3] })).toEqual(bad(`"read" must be a list of strings`));
    const pattern = await s.owner("/tokens/create/", { name: "x", read: ["personal..food"] });
    expect(pattern).toEqual(bad(`read pattern "personal..food" must be a table name, catalog.schema.*, catalog.* or *`));
    expect(guidanceOf(pattern.json)).toEqual({ hint: "Write each read pattern as catalog.schema.table, catalog.schema.*, catalog.* or *; list_tables gives the full names.", docs: docsUrl("tokenRead") });
    expect(await s.owner("/tokens/update/", { name: "cook", read: ["personal.*.pantry"] })).toEqual(bad(`read pattern "personal.*.pantry" must be a table name, catalog.schema.*, catalog.* or *`));
    expect(await s.owner("/tokens/update/", { name: "cook", read: [true] })).toEqual(bad(`"read" must be a list of strings`));
    // the write patterns keep their own message and the tokens' route guidance
    const write = await s.owner("/tokens/create/", { name: "x", write: ["a b"] });
    expect(write).toEqual(bad(`write pattern "a b" must be a table name, catalog.schema.*, catalog.* or *`));
    expect((write.json as { docs: string }).docs).toBe(docsUrl("manageTokens"));
    expect(s.registry.get("x")).toBeUndefined();
    expect(s.registry.get("cook")?.read).toEqual(["personal.food.*"]);
  });

  it("refuses ddl or maintain with a restricted read, on create and on update", async () => {
    const s = await setupReadTokens();
    const ddl = await s.owner("/tokens/create/", { name: "architect", read: ["personal.*"], ddl: true });
    expect(ddl).toEqual(bad(`token architect: "ddl" and "maintain" need read on every table`));
    expect(guidanceOf(ddl.json)).toEqual({ hint: `Leave "read" out (or pass ["*"]) for a token with ddl or maintain, or turn them off.`, docs: docsUrl("tokenRead") });
    expect(await s.owner("/tokens/create/", { name: "assistant", read: [], maintain: true })).toEqual(bad(`token assistant: "ddl" and "maintain" need read on every table`));
    expect(s.registry.get("architect")).toBeUndefined();
    expect(s.registry.get("assistant")).toBeUndefined();
    // on update: the token as it would be after the change
    expect(await s.owner("/tokens/update/", { name: "cook", ddl: true })).toEqual(bad(`token cook: "ddl" and "maintain" need read on every table`));
    expect(await s.owner("/tokens/update/", { name: "cook", maintain: true })).toEqual(bad(`token cook: "ddl" and "maintain" need read on every table`));
    await s.owner("/tokens/update/", { name: "legacy", maintain: true });
    expect(await s.owner("/tokens/update/", { name: "legacy", read: ["personal.food.*"] })).toEqual(bad(`token legacy: "ddl" and "maintain" need read on every table`));
    // nothing of a refused update is kept
    expect(s.registry.get("cook")).toMatchObject({ ddl: false, read: ["personal.food.*"] });
    expect(s.registry.get("cook")).not.toHaveProperty("maintain");
    expect(s.registry.get("legacy")).not.toHaveProperty("read");
    // with every table readable they are fine
    expect(entryOf(await s.owner("/tokens/update/", { name: "cook", read: ["*"], ddl: true }))).toMatchObject({ read: ["*"], ddl: true });
    expect(entryOf(await s.owner("/tokens/create/", { name: "admin", maintain: true, ddl: true }))).toMatchObject({ read: ["*"], ddl: true, maintain: true });
  });

  it("refuses a write pattern no read pattern covers, naming it in the message and the hint", async () => {
    const s = await setupReadTokens();
    const r = await s.owner("/tokens/create/", { name: "baker", read: ["personal.food.pantry"], write: ["personal.food.pantry", "personal.food.meals"] });
    expect(r).toEqual(bad("token baker writes personal.food.meals but may not read it"));
    expect(guidanceOf(r.json)).toEqual({ hint: `Add "personal.food.meals" (or a wider pattern) to "read": a write answers with the rows it touches.`, docs: docsUrl("tokenRead") });
    expect(await s.owner("/tokens/create/", { name: "baker", read: ["personal.food.*"], write: ["*"] })).toEqual(bad("token baker writes * but may not read it"));
    expect(await s.owner("/tokens/create/", { name: "baker", read: ["personal.food.*"], write: ["personal.*"] })).toEqual(bad("token baker writes personal.* but may not read it"));
    expect(s.registry.get("baker")).toBeUndefined();
    // updates: a narrower read, or a wider write
    expect(await s.owner("/tokens/update/", { name: "cook", read: ["personal.food.meals"] })).toEqual(bad("token cook writes personal.food.pantry but may not read it"));
    expect(await s.owner("/tokens/update/", { name: "cook", write: ["personal.health.weight"] })).toEqual(bad("token cook writes personal.health.weight but may not read it"));
    expect(await s.owner("/tokens/update/", { name: "legacy", read: ["personal.food.pantry"] })).toEqual(bad("token legacy writes personal.food.* but may not read it"));
    expect(s.registry.get("cook")).toMatchObject({ read: ["personal.food.*"], write: ["personal.food.pantry"] });
    // a wider read covers them
    const wider = await s.owner("/tokens/create/", { name: "baker", read: ["personal.*"], write: ["personal.food.*", "personal.health.weight"] });
    expect(entryOf(wider)).toMatchObject({ read: ["personal.*"], write: ["personal.food.*", "personal.health.weight"] });
  });

  it.each<[string, string, boolean]>([
    ["*", "*", true],
    ["*", "personal.food.pantry", true],
    ["personal.*", "personal.food.*", true],
    ["personal.*", "personal.food.pantry", true],
    ["personal.food.*", "personal.food.pantry", true],
    ["personal.food.pantry", "personal.food.pantry", true],
    ["personal.food.*", "personal.food.*", true],
    ["personal.food.*", "personal.*", false],
    ["personal.food.*", "*", false],
    ["personal.*", "*", false],
    ["personal.food.pantry", "personal.food.*", false],
    ["personal.food.*", "personal.foodstuff.pantry", false],
    ["personal.food.*", "personal.food", false],
  ])("read %s covers write %s: %s", (r, w, covers) => {
    expect(readCovers(r, w)).toBe(covers);
  });

  it("takes read back to every table with read: null", async () => {
    const s = await setupReadTokens();
    const r = await s.owner("/tokens/update/", { name: "cook", read: null });
    expect(entryOf(r)).toMatchObject({ name: "cook", read: ["*"], write: ["personal.food.pantry"] });
    expect(s.registry.get("cook")).not.toHaveProperty("read");
    expect((JSON.parse(s.v.read("store:tokens.json")) as TokenRecord[]).find((t) => t.name === "cook")).not.toHaveProperty("read");
    expect((await s.op("cook", "select_rows", { table: "weight" })).status).toBe(200);
    // and restricted again
    expect(entryOf(await s.owner("/tokens/update/", { name: "cook", read: ["personal.food.pantry"] })).read).toEqual(["personal.food.pantry"]);
    expect(await s.op("cook", "select_rows", { table: "meals" })).toEqual(readRefusal("cook", MEALS));
  });

  it("does not let a token change its own read", async () => {
    const s = await setupReadTokens();
    const refused = refusal(403, "a token cannot change its own permissions");
    expect(await s.as("cook", "/tokens/update/", { read: ["*"] })).toEqual(refused);
    expect(await s.as("cook", "/tokens/update/", { read: null })).toEqual(refused);
    expect(await s.as("legacy", "/tokens/update/", { read: [] })).toEqual(refused);
    expect(s.registry.get("cook")?.read).toEqual(["personal.food.*"]);
    expect(s.registry.get("legacy")).not.toHaveProperty("read");
    // its description it may change; read stays
    expect(entryOf(await s.as("cook", "/tokens/update/", { description: "the kitchen tablet" }))).toMatchObject({ description: "the kitchen tablet", read: ["personal.food.*"] });
  });

  it("gives a read scope only to a token whose read is restricted", () => {
    const base = { tokenHash: "h", write: [], ddl: false, createdAt: "t", updatedAt: "t" };
    expect(scopeOf({ ...base, name: "legacy" })).toBeNull();
    expect(scopeOf({ ...base, name: "star", read: ["*"] })).toBeNull();
    expect(scopeOf({ ...base, name: "cook", read: ["personal.food.*"] })).toEqual(COOK);
    expect(scopeOf({ ...base, name: "blind", read: [] })).toEqual({ token: "blind", patterns: [] });
  });
});

describe("token registry: reads before they run", () => {
  it("lets a token without read, or with *, read every table (as before read patterns)", async () => {
    const s = await setupReadTokens();
    const owner = await s.op("owner", "select_rows", { table: "weight" });
    expect(rowsOf(owner)).toHaveLength(2);
    for (const token of ["legacy", "star"] as const) {
      expect(await s.op(token, "select_rows", { table: "weight" })).toEqual(owner);
      expect(await s.op(token, "select_rows", { table: "personal.health.weight" })).toEqual(owner);
      expect((await s.op(token, "describe_table", { table: "weight" })).status).toBe(200);
    }
  });

  it("refuses a read of a table the token may not read, by short or full name, with the read guidance", async () => {
    const s = await setupReadTokens();
    expect(await s.op("cook", "select_rows", { table: "weight" })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "select_rows", { table: "personal.health.weight" })).toEqual(readRefusal("cook", WEIGHT));
    const r = await s.op("cook", "select_rows", { table: "weight" });
    expect(r.json).toEqual({
      error: "token cook may not read personal.health.weight",
      hint: `The owner grants reads with tokens/update/ and "read" patterns (catalog.schema.table, catalog.schema.*, catalog.* or *). list_tables lists the tables this token may read.`,
      docs: "https://datanotes.dev/guides/security/tokens.md#limit-what-a-token-can-read",
    });
    expectNoLeak(r.json);
    for (const op of ["describe_table", "check_table", "table_changes", "describe_history", "list_link_targets", "infer_table"]) {
      expect(await s.op("cook", op, { table: "weight" }), op).toEqual(readRefusal("cook", WEIGHT));
    }
    // the other way round, and a token that reads nothing
    expect(await s.op("nurse", "select_rows", { table: "pantry" })).toEqual(readRefusal("nurse", PANTRY));
    expect(await s.op("blind", "select_rows", { table: "meals" })).toEqual(readRefusal("blind", MEALS));
    // a table the token may read passes
    const pantry = await s.op("cook", "select_rows", { table: "pantry" });
    expect(rowsOf(pantry).map((x) => x.item)).toEqual(["eggs", "flour"]);
    expect((await s.op("nurse", "select_rows", { table: "weight" })).status).toBe(200);
    // logged as the write refusals are
    expect(logs.filter((l) => l.body === "datanotes token refused").map((l) => l.attributes?.reason)).toEqual([
      ...Array<string>(9).fill("token cook may not read personal.health.weight"),
      "token nurse may not read personal.food.pantry",
      "token blind may not read personal.food.meals",
    ]);
  });

  it("checks exactly the arguments READ_TABLE_ARGS names, and the exact names of semantic_search's tables", async () => {
    const s = await setupReadTokens();
    expect(READ_TABLE_ARGS).toEqual({
      select_rows: ["table"],
      describe_table: ["table"],
      check_table: ["table"],
      infer_table: ["table"],
      list_link_targets: ["table"],
      table_changes: ["table"],
      describe_history: ["table"],
    });
    const check = (op: string, body: unknown) => s.registry.check("cook", `/operations/${op}/`, body);
    expect(await check("semantic_search", { query: "x", tables: ["pantry", "weight"] })).toEqual(new ReadDeniedError("token cook may not read personal.health.weight"));
    expect(await s.op("cook", "semantic_search", { query: "x", tables: ["personal.health.weight"] })).toEqual(readRefusal("cook", WEIGHT));
    // patterns, the other arguments and the other operations are the engine's to narrow
    expect(await check("semantic_search", { query: "x", tables: ["personal.*", "*", 7] })).toBeNull();
    expect(await check("select_rows", { table: "pantry", join: { table: "weight" } })).toBeNull();
    expect(await check("list_changes", { tables: ["personal.health.weight"] })).toBeNull();
    expect(await check("read_note", { path: "Datanotes/personal/health/weight/x.md" })).toBeNull();
    expect(await check("list_tables", {})).toBeNull();
  });

  it("lets through the names that are no table: views, bases, the system catalog, unknown names; the engine decides", async () => {
    const s = await setupReadTokens();
    const check = (table: unknown) => s.registry.check("cook", "/operations/select_rows/", { table });
    for (const table of ["vw_heavy", VW_HEAVY, VW_MIXED, "base:noted", "system.information_schema.tables", "information_schema.columns", "weigth", "", 42, undefined, null]) {
      expect(await check(table), String(table)).toBeNull();
    }
    expect(await s.registry.check("cook", "/operations/select_rows/", null)).toBeNull();
    // a misspelled table is the engine's 404, as for the owner
    expect((await s.op("cook", "select_rows", { table: "weigth" })).status).toBe(404);
  });

  it("checks nothing when metastore.yaml cannot be read", async () => {
    const v = createDbVault({ [METASTORE]: "catalogs: [\n" });
    const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
    await registry.create({ name: "cook", read: ["personal.food.*"] });
    expect(await registry.check("cook", "/operations/select_rows/", { table: "weight" })).toBeNull();
    expect(await registry.check("cook", "/operations/select_rows/", { table: "personal.health.weight" })).toBeNull();
  });
});

describe("token registry: the read scope of a request", () => {
  it("runs a named token's request in its read scope, and every other request in none", async () => {
    const s = await setupReadTokens();
    const guarded = s.registry.guard(dispatch);
    const seen = async () => ({ status: 200, json: { scope: currentReadScope() } });
    const run = (auth: string) => runWithActor({ auth }, () => guarded("/operations/list_tables/", seen, {}));
    expect((await run("cook")).json).toEqual({ scope: COOK });
    expect((await run("blind")).json).toEqual({ scope: { token: "blind", patterns: [] } });
    expect((await run("nurse")).json).toEqual({ scope: { token: "nurse", patterns: ["personal.health.*"] } });
    for (const auth of ["legacy", "star", "owner"]) expect((await run(auth)).json, auth).toEqual({ scope: null });
    // and no scope is left after the request
    expect(currentReadScope()).toBeNull();
  });

  it("answers 503 to a restricted token where no read scope can be carried, never an unfiltered answer", async () => {
    expect(READ_SCOPE_SUPPORTED).toBe(true);
    const s = await setupReadTokens({ readScopeSupported: false });
    const unsupported = {
      status: 503,
      json: {
        error: "read permissions need Node's AsyncLocalStorage",
        hint: `This token has "read" patterns, which this runtime cannot enforce: run the engine on Node (datanotes serve), or have the owner pass "read": null to tokens/update/ for this token.`,
        docs: docsUrl("tokenRead"),
      },
    };
    for (const route of ["/operations/select_rows/", "/operations/list_tables/", "/operations/search_notes/", "/tokens/me/"]) {
      expect(await s.as("cook", route, { table: "pantry", query: "eggs" }), route).toEqual(unsupported);
    }
    expect(await s.as("blind", "/operations/list_tables/")).toEqual(unsupported);
    // a refusal comes first
    expect(await s.op("cook", "select_rows", { table: "weight" })).toEqual(readRefusal("cook", WEIGHT));
    // the tokens that read everything, and the owner, are served
    for (const token of ["owner", "legacy", "star"] as const) expect((await s.op(token, "select_rows", { table: "weight" })).status, token).toBe(200);
    expect(logs.filter((l) => l.body === "datanotes token refused").at(0)?.attributes).toEqual({ token_name: "cook", "http.route": "/operations/select_rows/", reason: "read permissions need Node's AsyncLocalStorage" });
  });

  it("nests: an inner scope wins, null reads everything again, and nothing is left outside", () => {
    expect(currentReadScope()).toBeNull();
    const nurse: ReadScope = { token: "nurse", patterns: ["personal.health.*"] };
    runWithReadScope(COOK, () => {
      expect(currentReadScope()).toEqual(COOK);
      runWithReadScope(nurse, () => expect(currentReadScope()).toBe(nurse));
      runWithReadScope(null, () => expect(currentReadScope()).toBeNull());
      expect(currentReadScope()).toBe(COOK);
    });
    expect(runWithReadScope(null, () => 7)).toBe(7);
    expect(currentReadScope()).toBeNull();
  });

  it("keeps the scope across awaits, and apart between concurrent requests", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const read = async (scope: ReadScope | null) =>
      runWithReadScope(scope, async () => {
        await tick();
        return currentReadScope()?.token ?? "none";
      });
    expect(await Promise.all([read(COOK), read(null), read({ token: "nurse", patterns: [] })])).toEqual(["cook", "none", "nurse"]);
  });
});

describe("read scope: tables", () => {
  it.each<[string, string[], boolean]>([
    ["personal.food.pantry", ["*"], true],
    ["personal.food.pantry", ["personal.*"], true],
    ["personal.food.pantry", ["personal.food.*"], true],
    ["personal.food.pantry", ["personal.food.pantry"], true],
    ["personal.food.pantry", ["personal.health.*", "personal.food.pantry"], true],
    ["personal.food.pantry", [], false],
    ["personal.food.pantry", ["personal.health.*"], false],
    ["personal.food.pantry", ["personal.food.meals"], false],
    ["personal.foodstuff.pantry", ["personal.food.*"], false],
    ["personal.food.pantry", ["pantry"], false],
  ])("%s matches %j: %s", (full, patterns, matches) => {
    expect(matchesTablePattern(full, patterns)).toBe(matches);
  });

  it("reads every table without a scope, and only the scope's tables with one", () => {
    expect(tableReadable(WEIGHT)).toBe(true);
    expect(() => assertTableReadable(WEIGHT)).not.toThrow();
    expect(tableReadable(WEIGHT, COOK)).toBe(false);
    expect(tableReadable(PANTRY, COOK)).toBe(true);
    runWithReadScope(COOK, () => {
      expect(tableReadable(PANTRY)).toBe(true);
      expect(tableReadable(WEIGHT)).toBe(false);
      expect(tableReadable(WEIGHT, null)).toBe(true);
      expect(() => assertTableReadable(PANTRY)).not.toThrow();
      expect(() => assertTableReadable(WEIGHT)).toThrow(new ReadDeniedError("token cook may not read personal.health.weight"));
    });
  });

  it("refuses with a ReadDeniedError the HTTP API answers 403, with its hint and docs", () => {
    let e: unknown;
    runWithReadScope(COOK, () => {
      try {
        assertTableReadable(WEIGHT);
      } catch (x) {
        e = x;
      }
    });
    expect(e).toBeInstanceOf(ReadDeniedError);
    expect((e as Error).name).toBe("ReadDeniedError");
    expect(guidanceOf(e)).toEqual(READ_DENIED_GUIDANCE);
    expect(READ_DENIED_GUIDANCE).toEqual({
      hint: `The owner grants reads with tokens/update/ and "read" patterns (catalog.schema.table, catalog.schema.*, catalog.* or *). list_tables lists the tables this token may read.`,
      docs: "https://datanotes.dev/guides/security/tokens.md#limit-what-a-token-can-read",
    });
    expect(DOCS.tokenRead).toBe("/guides/security/tokens.md#limit-what-a-token-can-read");
    expect(errorResponse(e, "select_rows")).toEqual(readRefusal("cook", WEIGHT));
    expect(errorResponse(new ReadDeniedError("token cook may not read the note Diary/x.md"))).toEqual({ status: 403, json: { error: "token cook may not read the note Diary/x.md", ...READ_DENIED_GUIDANCE } });
  });
});

describe.each(["fake", "node"] as const)("read scope: notes (%s host)", (host) => {
  it("reads a note only when it is a row of a readable table: never a free note, another file or no file", async () => {
    const s = await setupReadTokens({ host });
    const { app, settings } = s.v;
    const p = s.paths;
    expect(tableOfPath(app, settings, p.eggs)).toBe(PANTRY);
    expect(tableOfPath(app, settings, p.heavy)).toBe(WEIGHT);
    expect(tableOfPath(app, settings, p.diary)).toBeNull();
    expect(tableOfPath(app, settings, "Datanotes/metastore.yaml")).toBeNull();
    expect(tableOfPath(app, settings, "Nowhere/none.md")).toBeNull();
    // without a scope, everything
    for (const path of [p.eggs, p.heavy, p.diary, "Nowhere/none.md"]) expect(pathReadable(app, settings, path)).toBe(true);
    const nurse: ReadScope = { token: "nurse", patterns: ["personal.health.*"] };
    expect([p.eggs, p.flour, p.pasta, p.heavy, p.light, p.diary, "Nowhere/none.md"].map((path) => pathReadable(app, settings, path, COOK))).toEqual([true, true, true, false, false, false, false]);
    expect([p.eggs, p.pasta, p.heavy, p.light, p.diary].map((path) => pathReadable(app, settings, path, nurse))).toEqual([false, false, true, true, false]);
    expect(pathReadable(app, settings, p.diary, { token: "blind", patterns: [] })).toBe(false);
    runWithReadScope(COOK, () => {
      expect(pathReadable(app, settings, p.eggs)).toBe(true);
      expect(pathReadable(app, settings, p.heavy)).toBe(false);
      expect(pathReadable(app, settings, p.heavy, null)).toBe(true);
      expect(() => assertPathReadable(app, settings, p.pasta)).not.toThrow();
      expect(() => assertPathReadable(app, settings, p.heavy)).toThrow(new ReadDeniedError(`token cook may not read the note ${p.heavy}`));
      expect(() => assertPathReadable(app, settings, DIARY_PATH)).toThrow(new ReadDeniedError("token cook may not read the note Diary/ZZSECRETDIARY.md"));
    });
    expect(() => assertPathReadable(app, settings, DIARY_PATH)).not.toThrow();
  });
});

describe("read scope: a note's table without the vault index", () => {
  it("reads the table property with the cached metastore, and fails closed without one", async () => {
    const s = await setupReadTokens({ host: "fake" });
    const { app, settings } = s.v;
    // a host whose index throws for a note: no table can be told
    const getFileCache = app.metadataCache.getFileCache.bind(app.metadataCache);
    app.metadataCache.getFileCache = (f) => {
      if (f.path === s.paths.eggs) throw new Error("bad YAML");
      return getFileCache(f);
    };
    expect(tableOfPath(app, settings, s.paths.eggs)).toBeNull();
    expect(tableOfPath(app, settings, s.paths.flour)).toBe(PANTRY);
    expect(tableOfPath(app, settings, "Datanotes/personal/food/pantry")).toBeNull();
    // no metastore loaded yet: nothing is a row
    const fresh = createDbVault({ [METASTORE]: READ_YAML, "Food/eggs.md": "---\ntable: personal.food.pantry\nitem: eggs\n---\n" }, {}, { host: "fake" });
    expect(tableOfPath(fresh.app, fresh.settings, "Food/eggs.md")).toBeNull();
    expect(pathReadable(fresh.app, fresh.settings, "Food/eggs.md", COOK)).toBe(false);
  });
});

describe("query-tables: what a query reads", () => {
  const model = parseMetastore(`catalogs:
  personal:
    schemas:
      food:
        tables:
          pantry:
            columns:
              - { name: item, type: string }
              - { name: for_weight, type: link, ref: personal.health.weight }
          meals:
            columns:
              - { name: dish, type: string }
              - { name: ingredients, type: list, items: link, ref: personal.food.pantry }
        views:
          vw_mixed:
            query: { table: meals, join: { table: personal.health.weight, on: { file_link: after_meal } } }
          vw_nested:
            query: { table: vw_mixed, where: { dish: Pasta } }
          vw_union:
            query: { union: [{ table: pantry }, { table: vw_heavy }] }
          vw_this:
            query: { table: pantry, where: { item: "{this.item}" } }
          vw_system:
            query: { table: system.information_schema.tables }
      health:
        tables:
          weight:
            columns:
              - { name: kg, type: number }
              - { name: after_meal, type: link, ref: personal.food.meals }
        views:
          vw_heavy:
            query: { table: weight, where: { kg: { gt: 80 } } }
`);

  it.each<[string, Record<string, unknown>, string[], boolean]>([
    ["a table", { table: "pantry" }, [PANTRY], true],
    ["a table by full name", { table: WEIGHT, where: { kg: { gt: 1 } } }, [WEIGHT], true],
    ["a join", { table: "meals", join: { table: "weight", on: { file_link: "after_meal" } } }, [MEALS, WEIGHT], true],
    // a union has no top-level table: the read cache counts it as a read of the whole vault
    ["a union", { union: [{ table: "pantry" }, { table: "meals" }] }, [MEALS, PANTRY], false],
    ["a view", { table: "vw_heavy" }, [WEIGHT], true],
    ["a view over a view", { table: "vw_nested" }, [MEALS, WEIGHT], true],
    ["a view of a union", { table: "vw_union" }, [PANTRY, WEIGHT], false],
    ["a dotted key", { table: "pantry", where: { "for_weight.kg": { gt: 80 } } }, [PANTRY, WEIGHT], true],
    ["a dotted key two links deep", { table: "pantry", where: { "for_weight.after_meal.dish": "Pasta" } }, [MEALS, PANTRY, WEIGHT], true],
    ["the system catalog", { table: "system.information_schema.tables" }, [], true],
    ["a view of the system catalog", { table: "vw_system" }, [], true],
    ["a base", { table: "base:noted" }, [], false],
    ["an unknown name", { table: "weigth" }, [], false],
    ["within", { table: "pantry", where: { file_link: { within: { table: "weight" } } } }, [PANTRY], false],
    ["a view of {this.*}", { table: "vw_this" }, [PANTRY], false],
    ["expand", { table: "pantry", expand: ["for_weight"] }, [PANTRY], false],
    ["a dotted key through no link", { table: "pantry", where: { "item.kg": 1 } }, [PANTRY], false],
  ])("%s", (_title, q, tables, complete) => {
    expect(tablesReadByQuery(q, model)).toEqual({ tables, complete });
  });

  it("reads a view's stored query; an unknown view reads nothing known", () => {
    expect(tablesReadByView(model, VW_MIXED)).toEqual({ tables: [MEALS, WEIGHT], complete: true });
    expect(tablesReadByView(model, VW_HEAVY)).toEqual({ tables: [WEIGHT], complete: true });
    expect(tablesReadByView(model, "personal.food.vw_this")).toEqual({ tables: [PANTRY], complete: false });
    expect(tablesReadByView(model, "personal.food.vw_none")).toEqual({ tables: [], complete: false });
    expect(tablesReadByView(model, "nowhere.at.all")).toEqual({ tables: [], complete: false });
  });
});

describe("the fixture", () => {
  it("builds the vault the lanes read, and its sentinels sit only in what a restricted token may not read", async () => {
    const s = await setupReadTokens();
    const rows = async (table: string) => rowsOf(await s.op("owner", "select_rows", { table }));
    expect((await rows("pantry")).map((r) => [r.item, r.qty, r.for_weight ?? null, r.note ?? null])).toEqual([
      ["eggs", 6, "[[Morning weigh-in]]", "fresh"],
      ["flour", 1, null, null],
    ]);
    expect((await rows("meals")).map((r) => [r.dish, r.ingredients])).toEqual([["Pasta", ["[[eggs]]", "[[flour]]"]]]);
    expect((await rows("weight")).map((r) => [r.path, r.kg, r.note, r.after_meal ?? null])).toEqual([
      [s.paths.heavy, 81.5, "ZZSECRETHEALTH day", "[[Pasta]]"],
      [s.paths.light, 79, "ZZSECRETHEALTH light", null],
    ]);
    expect((await rows("vw_heavy")).map((r) => r.path)).toEqual([s.paths.heavy]);
    expect((await rows(VW_MIXED)).map((r) => [r.dish, (r.weighings as { kg: number }[]).map((w) => w.kg)])).toEqual([["Pasta", [81.5]]]);
    expect((await rows("base:noted")).map((r) => r._source)).toEqual([PANTRY, PANTRY, WEIGHT, WEIGHT]);
    expect(s.paths).toEqual({
      eggs: "Datanotes/personal/food/pantry/eggs.md",
      flour: "Datanotes/personal/food/pantry/flour.md",
      pasta: "Datanotes/personal/food/meals/Pasta.md",
      heavy: "Datanotes/personal/health/weight/Morning weigh-in.md",
      light: "Datanotes/personal/health/weight/ZZSECRETHEALTH evening.md",
      weight: ["Datanotes/personal/health/weight/Morning weigh-in.md", "Datanotes/personal/health/weight/ZZSECRETHEALTH evening.md"],
      diary: "Diary/ZZSECRETDIARY.md",
    });
    expect(s.v.read(DIARY_PATH)).toContain("ZZSECRETDIARY");
    expect(s.v.read(DIARY_PATH)).not.toMatch(/^---/);
    // what cook may read holds no sentinel
    expectNoLeak(await s.op("cook", "select_rows", { table: "pantry" }));
    expectNoLeak(await s.op("cook", "select_rows", { table: "meals" }));
    expect(Object.keys(TOKENS)).toEqual(["legacy", "cook", "blind", "nurse", "star"]);
  });

  it("fails expectNoLeak on any sentinel, in any case and slugified", () => {
    expect(SENTINELS).toEqual(["ZZSECRETHEALTH", "ZZSECRETDIARY"]);
    expect(() => expectNoLeak({ rows: [{ item: "eggs" }] })).not.toThrow();
    expect(() => expectNoLeak(undefined)).not.toThrow();
    for (const leak of [{ note: "ZZSECRETHEALTH day" }, ["zzsecretdiary"], { path: "w/zz-secret-health-evening.md" }, "ZzSecret_Diary", { id: "zz secret health" }]) {
      expect(() => expectNoLeak(leak), JSON.stringify(leak)).toThrow(/the answer leaks ZZSECRET(HEALTH|DIARY)/);
    }
    expect(() => expectNoLeak({ note: "my own secret" }, ["MY OWN SECRET"])).toThrow(/leaks MY OWN SECRET/);
  });

  it("starts the same vault on an engine over HTTP, with the tokens' secrets", async () => {
    const e = await startReadEngine();
    engines.push(e);
    expect(e.paths.heavy).toBe("Datanotes/personal/health/weight/Morning weigh-in.md");
    const owner = await e.op("owner", "select_rows", { table: "weight" });
    expect((owner.json.rows as unknown[]).length).toBe(2);
    expect(await e.op("legacy", "select_rows", { table: "weight" })).toEqual(owner);
    const refused = await e.op("cook", "select_rows", { table: "weight" });
    expect({ status: refused.status, json: refused.json }).toEqual(readRefusal("cook", WEIGHT));
    expect((await e.route("cook", "/tokens/me/")).json).toMatchObject({ entry: { name: "cook", read: ["personal.food.*"] } });
  });
});

describe("the read cache and status", () => {
  it("keeps a token's answers apart from its answers before read changed", async () => {
    const e = await startReadEngine();
    engines.push(e);
    const stats = () => e.runtime.readCache!.stats();
    await e.op("legacy", "select_rows", { table: "pantry" });
    await e.op("legacy", "select_rows", { table: "pantry" });
    expect(stats()).toMatchObject({ hits: 1, misses: 1 });
    // read changes: the answer is not reused
    expect((await e.route("owner", "/tokens/update/", { name: "legacy", read: ["personal.food.*"] })).status).toBe(200);
    await e.op("legacy", "select_rows", { table: "pantry" });
    expect(stats()).toMatchObject({ hits: 1, misses: 2 });
    await e.op("legacy", "select_rows", { table: "pantry" });
    expect(stats()).toMatchObject({ hits: 2, misses: 2 });
    // and it now refuses what it read before, cached or not
    expect((await e.op("legacy", "select_rows", { table: "weight" })).status).toBe(403);
    // back to the permissions it had: the answers kept for them serve again
    expect((await e.route("owner", "/tokens/update/", { name: "legacy", read: null })).status).toBe(200);
    await e.op("legacy", "select_rows", { table: "pantry" });
    expect(stats()).toMatchObject({ hits: 3, misses: 2 });
  });

  it("shows a token's read patterns in datanotes status, only where they are restricted", async () => {
    const e = await startReadEngine();
    engines.push(e);
    const r = await e.route("owner", "/status/");
    expect(r.status).toBe(200);
    const report = r.json as unknown as EngineStatus;
    expect(report.tokens).toEqual([
      { name: "legacy", write: ["personal.food.*"], ddl: false, maintain: false, last_seen: null },
      { name: "cook", read: ["personal.food.*"], write: ["personal.food.pantry"], ddl: false, maintain: false, last_seen: null },
      { name: "blind", read: [], write: [], ddl: false, maintain: false, last_seen: null },
      { name: "nurse", read: ["personal.health.*"], write: [], ddl: false, maintain: false, last_seen: null },
      { name: "star", write: [], ddl: false, maintain: false, last_seen: null },
    ]);
    const text = formatStatus({ running: true, url: e.url, ...report });
    expect(text.split("\n").find((l) => l.startsWith("tokens"))).toBe(
      "tokens     legacy (write personal.food.*); cook (read personal.food.*, write personal.food.pantry); blind (read nothing, no write); nurse (read personal.health.*, no write); star (read only)",
    );
  });
});
