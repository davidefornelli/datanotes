/**
 * The shared fixture of the read-permission tests (`read` patterns of named tokens:
 * src/core/read-scope.ts, src/server/tokens.ts): a personal vault with food data a restricted
 * token may read and health data and a diary it may not, the tokens that read it differently, and
 * `expectNoLeak`, which fails when an answer carries a secret.
 *
 * The vault, built through the engine's operations on the metastore of `READ_YAML`:
 *
 * - `personal.food.pantry` (`item`, `qty`, `for_weight`: a link into health, and `note` from the
 *   base `noted`): rows `eggs` (linked to the weight row `Morning weigh-in`) and `flour`
 * - `personal.food.meals` (`dish`, `ingredients`: a list of links to the pantry): row `Pasta`
 * - `personal.health.weight` (`label`, `day`, `kg`, `after_meal`: a link to a meal, and `note`):
 *   rows `Morning weigh-in` (kg 81.5, after Pasta) and `ZZSECRETHEALTH evening` (kg 79)
 * - the base `noted` (column `note`) on `pantry` and `weight`: `base:noted` reads both schemas
 * - the views `personal.health.vw_heavy` (weight rows with kg over 80) and `personal.food.vw_mixed`
 *   (the meals joined with the weight rows taken after them: a food name, health data)
 * - a free note `Diary/ZZSECRETDIARY.md` (no `table` property) that mentions eggs
 *
 * Every value of a weight row that a restricted token must never see holds `ZZSECRETHEALTH`, the
 * diary `ZZSECRETDIARY` (`SENTINELS`). The weight row `eggs` links to is named `Morning weigh-in`
 * on purpose: a link's text inside a readable row stays visible (a foreign-key value), so that name
 * is no secret, while its `kg` and `note` are.
 *
 * The tokens (`TOKENS`): `legacy` (no `read`: reads everything), `cook` (reads `personal.food.*`,
 * writes the pantry), `blind` (reads nothing), `nurse` (reads `personal.health.*`), `star`
 * (`read: ["*"]`: reads everything).
 *
 * In process (`setupReadTokens`): the engine's routes and the registry's behind the permission
 * guard, as the HTTP server runs them (the setup of tests/tokens-edges.test.ts). Over HTTP
 * (`startReadEngine`): a started engine on a vault on disk, with its HTTP server, read cache and
 * change feed; call `dispose()` when the test ends. A test with an engine of its own writes
 * `READ_YAML` and `DIARY_PATH` into its vault and calls `seedReadVault` and `createReadTokens` with
 * a function that sends a request as the owner.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { runWithActor, type Actor } from "../../src/core/actor";
import type { Transport } from "../../src/core/embeddings";
import { mergeWithDefaults, type DatanotesSettings } from "../../src/core/settings";
import { openNodeVault, type NodeHost } from "../../src/node/node-app";
import { EngineRuntime } from "../../src/server/runtime";
import { READ_DENIED_GUIDANCE } from "../../src/core/read-scope";
import { TokenRegistry, type PublicToken } from "../../src/server/tokens";
import { createHandlers, dispatch, type Handler, type HandlerResponse } from "../../src/server/rest";
import { createDbVault, METASTORE, TEST_DATABASE_FOLDER, type DbVault } from "./db-vault";
import { guided } from "./guidance";

/** What no answer to a restricted token may contain: a value of the health data, the diary's text. */
export const SENTINELS: readonly string[] = ["ZZSECRETHEALTH", "ZZSECRETDIARY"];

/**
 * Fail when the answer (as JSON) contains a sentinel, in any case and also slugified (a file
 * name, an anchor, an id made from it: `zzsecrethealth-evening`).
 */
export function expectNoLeak(answer: unknown, sentinels: readonly string[] = SENTINELS): void {
  const text = (JSON.stringify(answer) ?? "").toLowerCase();
  const folded = text.replace(/[\s_-]+/g, "");
  for (const s of sentinels) {
    const needle = s.toLowerCase();
    const slug = needle.replace(/[\s_-]+/g, "");
    if (text.includes(needle) || folded.includes(slug)) {
      const at = text.includes(needle) ? text.indexOf(needle) : folded.indexOf(slug);
      expect.fail(`the answer leaks ${s}: …${(text.includes(needle) ? text : folded).slice(Math.max(0, at - 80), at + 80)}…`);
    }
  }
}

/** The metastore the vault starts with: the food catalog of tests/tokens-edges.test.ts, weight named by `label`. */
export const READ_YAML = `catalogs:
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
            options: { filename: "{label}" }
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: label, type: string, required: true }
              - { name: day, type: date, required: true }
              - { name: kg, type: number, required: true }
`;

/** The free note: no `table` property, a word a pantry row has too (`eggs`). */
export const DIARY_PATH = "Diary/ZZSECRETDIARY.md";
export const DIARY_TEXT = "# Diary\n\nBought eggs today. ZZSECRETDIARY\n";

/** The tables by full name. */
export const PANTRY = "personal.food.pantry";
export const MEALS = "personal.food.meals";
export const WEIGHT = "personal.health.weight";
export const VW_HEAVY = "personal.health.vw_heavy";
export const VW_MIXED = "personal.food.vw_mixed";
export const BASE = "noted";

/** The tokens and what `/tokens/create/` gets for each. */
export const TOKENS = {
  legacy: { name: "legacy", write: ["personal.food.*"] },
  cook: { name: "cook", read: ["personal.food.*"], write: ["personal.food.pantry"] },
  blind: { name: "blind", read: [] as string[] },
  nurse: { name: "nurse", read: ["personal.health.*"] },
  star: { name: "star", read: ["*"] },
} as const;

export type ReadTokenName = keyof typeof TOKENS;
export const READ_TOKEN_NAMES = Object.keys(TOKENS) as ReadTokenName[];

/** A request as the owner: a route (`/operations/select_rows/`, `/tokens/create/`) and its body. */
export type OwnerCall = (route: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

/** The rows' vault paths, as the engine named them. */
export interface ReadPaths {
  eggs: string;
  flour: string;
  pasta: string;
  /** The weight row `eggs` links to (kg 81.5; `note` holds the sentinel; after Pasta). */
  heavy: string;
  /** The other weight row (its name holds the sentinel; kg 79). */
  light: string;
  /** Both weight rows. */
  weight: readonly string[];
  diary: string;
}

/** The answer of an operation that must have worked. */
async function ok(owner: OwnerCall, op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await owner(`/operations/${op}/`, body);
  if (r.status !== 200) throw new Error(`seed: ${op} answered ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json as Record<string, unknown>;
}

/** The path of the row an insert_row created. */
async function insert(owner: OwnerCall, table: string, values: Record<string, unknown>): Promise<string> {
  const r = await ok(owner, "insert_row", { table, values });
  const path = (r.planned_creates as string[] | undefined)?.[0];
  if (!path) throw new Error(`seed: insert_row into ${table} answered no path: ${JSON.stringify(r)}`);
  return path;
}

/**
 * Build the vault's links, base, rows and views with the owner's operations, on a vault whose
 * metastore is `READ_YAML`. Returns the rows' paths (`diary`: `DIARY_PATH`, which the caller writes).
 */
export async function seedReadVault(owner: OwnerCall): Promise<ReadPaths> {
  const column = async (table: string, c: Record<string, unknown>) => ok(owner, "add_column", { table, column: c });
  await column(MEALS, { name: "ingredients", type: "list", items: "link", ref: PANTRY, description: "What the dish is made of" });
  await column(WEIGHT, { name: "after_meal", type: "link", ref: MEALS, description: "The meal before the weigh-in" });
  await column(PANTRY, { name: "for_weight", type: "link", ref: WEIGHT, description: "The weigh-in this item was bought for" });
  await ok(owner, "define_base", { name: BASE, description: "A row with a free-text note", columns: [{ name: "note", type: "string", description: "Free text" }] });
  await ok(owner, "set_table_bases", { table: PANTRY, bases: [BASE] });
  await ok(owner, "set_table_bases", { table: WEIGHT, bases: [BASE] });

  const flour = await insert(owner, PANTRY, { item: "flour", qty: 1 });
  const eggs = await insert(owner, PANTRY, { item: "eggs", qty: 6, note: "fresh" });
  const pasta = await insert(owner, MEALS, { dish: "Pasta", ingredients: ["[[eggs]]", "[[flour]]"] });
  const heavy = await insert(owner, WEIGHT, { label: "Morning weigh-in", day: "2026-10-01", kg: 81.5, note: "ZZSECRETHEALTH day", after_meal: "[[Pasta]]" });
  const light = await insert(owner, WEIGHT, { label: "ZZSECRETHEALTH evening", day: "2026-10-02", kg: 79, note: "ZZSECRETHEALTH light" });
  await ok(owner, "update_row", { table: PANTRY, path: eggs, set: { for_weight: "[[Morning weigh-in]]" } });

  await ok(owner, "create_view", { name: VW_HEAVY, description: "Weigh-ins over 80 kg", query: { table: WEIGHT, where: { kg: { gt: 80 } } } });
  await ok(owner, "create_view", {
    name: VW_MIXED,
    description: "Each meal with the weigh-ins taken after it",
    query: { table: MEALS, columns: ["dish"], join: { table: WEIGHT, on: { file_link: "after_meal" }, as: "weighings", type: "left", columns: ["kg", "note"] } },
  });
  return { eggs: eggs, flour, pasta, heavy, light, weight: [heavy, light], diary: DIARY_PATH };
}

/** Create the five tokens as the owner; their secrets by name (for a test over HTTP). */
export async function createReadTokens(owner: OwnerCall): Promise<Record<ReadTokenName, string>> {
  const out = {} as Record<ReadTokenName, string>;
  for (const name of READ_TOKEN_NAMES) {
    const r = await owner("/tokens/create/", TOKENS[name]);
    if (r.status !== 200) throw new Error(`seed: tokens/create ${name} answered ${r.status}: ${JSON.stringify(r.json)}`);
    out[name] = (r.json as { token: string }).token;
  }
  return out;
}

/** A request with a token, in process: its route and body. */
export type Caller = (route: string, body?: unknown, agent?: Actor) => Promise<HandlerResponse>;

export interface ReadSetup {
  v: DbVault;
  registry: TokenRegistry;
  /** A request with the owner's token. */
  owner(route: string, body?: unknown): Promise<HandlerResponse>;
  /** A request with a named token (the agent it acts for, if any). */
  as(token: string, route: string, body?: unknown, agent?: Actor): Promise<HandlerResponse>;
  /** An operation (`select_rows`) with a token, or the owner's (`"owner"`). */
  op(token: ReadTokenName | "owner", op: string, args?: Record<string, unknown>): Promise<HandlerResponse>;
  /** A request with each token. */
  callers: Record<ReadTokenName, Caller>;
  /** The tokens' registry entries, by name. */
  entries: Record<ReadTokenName, PublicToken>;
  paths: ReadPaths;
}

/**
 * The vault, its rows and the five tokens, in process: requests run through the same chain the
 * HTTP server uses (the actor of the request, the permission guard, dispatch, the real handlers).
 * `readScopeSupported: false` stands for a runtime without AsyncLocalStorage (the guard's 503).
 */
export async function setupReadTokens(opts: { readScopeSupported?: boolean; host?: "fake" | "node" } = {}): Promise<ReadSetup> {
  const v = createDbVault({ [METASTORE]: READ_YAML, [DIARY_PATH]: DIARY_TEXT }, {}, opts.host ? { host: opts.host } : {});
  const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings, ...(opts.readScopeSupported !== undefined ? { readScopeSupported: opts.readScopeSupported } : {}) });
  const routes: Record<string, Handler> = { ...createHandlers(v.app, () => v.settings), ...registry.handlers() };
  const guarded = registry.guard(dispatch);
  const run = (actor: Actor, route: string, body: unknown) => {
    const handler = routes[route];
    if (!handler) throw new Error(`no route ${route}`);
    return runWithActor(actor, () => guarded(route, handler, body));
  };
  const owner = (route: string, body: unknown = {}) => run({ auth: "owner" }, route, body);
  const as = (token: string, route: string, body: unknown = {}, agent: Actor = { harness: token }) => run({ ...agent, auth: token }, route, body);
  const paths = await seedReadVault(owner);
  const entries = {} as Record<ReadTokenName, PublicToken>;
  for (const name of READ_TOKEN_NAMES) {
    const r = await owner("/tokens/create/", TOKENS[name]);
    if (r.status !== 200) throw new Error(`setup: tokens/create ${name} answered ${r.status}: ${JSON.stringify(r.json)}`);
    entries[name] = (r.json as { entry: PublicToken }).entry;
  }
  const callers = Object.fromEntries(READ_TOKEN_NAMES.map((n) => [n, ((route, body, agent) => as(n, route, body, agent)) as Caller])) as Record<ReadTokenName, Caller>;
  return {
    v,
    registry,
    owner,
    as,
    op: (token, op, args = {}) => (token === "owner" ? owner(`/operations/${op}/`, args) : as(token, `/operations/${op}/`, args)),
    callers,
    entries,
    paths,
  };
}

/** The answer of a read the token may not make: 403, `token <token> may not read <what>`, the read guidance. */
export function readRefusal(token: string, full: string): { status: 403; json: { error: string; hint: string; docs: string } } {
  return { status: 403, json: { error: `token ${token} may not read ${full}`, ...READ_DENIED_GUIDANCE } };
}

/** The same for a note: `token <token> may not read the note <path>`. */
export function noteRefusal(token: string, path: string): { status: 403; json: { error: string; hint: string; docs: string } } {
  return { status: 403, json: { error: `token ${token} may not read the note ${path}`, ...READ_DENIED_GUIDANCE } };
}

/** A refusal with any guidance (for refusals that are not reads: 400 bad input, 403 writes). */
export const refusal = (status: number, error: string) => ({ status, json: guided(error) });

/** The rows of a select_rows answer. */
export function rowsOf(r: HandlerResponse): Record<string, unknown>[] {
  return ((r.json as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
}

/** The owner token of `startReadEngine`'s engines. */
export const READ_OWNER_TOKEN = "owner-token-read-fixture";

export interface ReadEngine {
  runtime: EngineRuntime;
  host: NodeHost;
  /** The vault folder on disk. */
  root: string;
  settings: DatanotesSettings;
  /** `http://127.0.0.1:<port>/datanotes`. */
  url: string;
  /** The tokens' secrets, by name (Authorization: Bearer <secret>). */
  secrets: Record<ReadTokenName, string>;
  paths: ReadPaths;
  /** An operation over HTTP with a token's secret, or the owner's (`"owner"`); `text` is the body as sent. */
  op(token: ReadTokenName | "owner", op: string, args?: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown>; text: string }>;
  /** A route (`/tokens/me/`) over HTTP, the same way. */
  route(token: ReadTokenName | "owner", route: string, body?: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown>; text: string }>;
  /** Stop the engine and remove its folders. */
  dispose(): Promise<void>;
}

/**
 * The same vault and tokens on a started engine over HTTP (a free port of 127.0.0.1, folders of
 * its own in the system's temp folder): for what only the real server does, such as the read
 * cache, the change feed's stream or webhooks. `settings` are merged over the defaults; `transport`
 * answers the embedding provider's requests (semantic search), by default with an error.
 */
export async function startReadEngine(settings: Partial<DatanotesSettings> = {}, transport: Transport = async () => ({ status: 500, text: "" })): Promise<ReadEngine> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-tokens-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "read-tokens-store-"));
  for (const [rel, text] of Object.entries({ [METASTORE]: READ_YAML, [DIARY_PATH]: DIARY_TEXT })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const host = openNodeVault(root, undefined, { store });
  const s = mergeWithDefaults({ fileLogEnabled: false, autoRecompute: false, databaseFolder: TEST_DATABASE_FOLDER, httpServerToken: READ_OWNER_TOKEN, ...settings });
  s.httpServerPort = 0;
  const runtime = new EngineRuntime({
    app: host.app,
    getSettings: () => s,
    saveSettings: async () => {},
    transport,
    embeddingKey: () => undefined,
    version: "3.0.0-test",
    hostName: "service",
    canServeHttp: true,
    httpHost: "127.0.0.1",
    env: {},
  });
  const dispose = async () => {
    await runtime.dispose();
    for (const d of [root, store]) fs.rmSync(d, { recursive: true, force: true });
  };
  try {
    await runtime.start();
    runtime.setHostSettler(() => void host.vault.rescan());
    const url = `http://127.0.0.1:${runtime.httpPort}/datanotes`;
    let secrets = {} as Record<ReadTokenName, string>;
    const post = async (token: ReadTokenName | "owner", route: string, body: unknown) => {
      const bearer = token === "owner" ? READ_OWNER_TOKEN : secrets[token];
      const res = await fetch(`${url}${route}`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const text = await res.text();
      return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
    };
    const owner: OwnerCall = (route, body) => post("owner", route, body);
    const paths = await seedReadVault(owner);
    secrets = await createReadTokens(owner);
    return {
      runtime,
      host,
      root,
      settings: s,
      url,
      secrets,
      paths,
      op: (token, op, args = {}) => post(token, `/operations/${op}/`, args),
      route: (token, route, body = {}) => post(token, route, body),
      dispose,
    };
  } catch (e) {
    await dispose();
    throw e;
  }
}
