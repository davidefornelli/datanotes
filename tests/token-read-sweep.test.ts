/**
 * The leak sweep of the read permissions (phase 2 of the read-permission plan): every read
 * operation (`READ_OPERATIONS`, the operations whose `readOnlyHint` is true) runs over HTTP on a
 * started engine with argument variants that try to reach the health data or the diary, as a
 * token that may not read them. The lanes' own tests check each site; this one is the net under
 * them, and the guard of the next read operation:
 *
 * - `cook` (reads `personal.food.*`): every answer is a 403, or a 200/400/404/422 without a secret
 *   (`expectNoLeak`).
 * - `blind` (reads nothing): every answer is a 403, or one that holds no row of any table.
 * - `legacy` (no `read`) and `star` (`read: ["*"]`): every answer equals the owner's (D2).
 * - A read operation without variants fails the coverage check, naming it.
 *
 * Variants name rows with placeholders (`@heavy`, `@diary`, ...) that the sweep replaces with the
 * fixture's vault paths; every operation is also called with no arguments at all.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HttpRequest, Transport } from "../src/core/embeddings";
import { READ_OPERATIONS } from "../src/server/token-routes";
import { BASE, expectNoLeak, MEALS, PANTRY, startReadEngine, VW_HEAVY, VW_MIXED, WEIGHT, type ReadEngine, type ReadPaths, type ReadTokenName } from "./helpers/read-tokens";

type Json = Record<string, unknown>;

/** Every name a token may give for a table it may not read, or for a set that holds one. */
const HIDDEN_TABLES = [
  "weight",
  WEIGHT,
  "health.weight",
  "vw_heavy",
  VW_HEAVY,
  "vw_mixed",
  VW_MIXED,
  "personal.food.vw_union",
  `base:${BASE}`,
  "system.information_schema.tables",
  "system.information_schema.columns",
  "system.information_schema.views",
  "system.information_schema.check_constraints",
  "information_schema.schemata",
  "information_schema.catalogs",
  "weigth",
];

/** `{table: <name>, ...extra}` for every hidden name, and for the readable pantry. */
const onTables = (extra: Json = {}): Json[] => [...HIDDEN_TABLES, PANTRY].map((table) => ({ table, ...extra }));

/** The start (or end) nodes of the graph operations that reach health data or the diary. */
const NODES: Json[] = [
  { paths: ["@heavy"] },
  { paths: ["@light"] },
  { paths: ["@diary"] },
  { paths: ["@heavy-no-ext"] },
  { paths: ["@eggs"] },
  { paths: ["@eggs", "@heavy"] },
  { table: "weight" },
  { table: WEIGHT, where: { kg: { gt: 0 } } },
  { table: "pantry", where: { "for_weight.kg": { gt: 0 } } },
  { tables: ["*"] },
  { tables: ["personal.*"] },
  { tables: ["personal.health.*"] },
  { tables: ["weight"] },
  { tables: [WEIGHT, PANTRY] },
];

/**
 * The argument variants of every read operation, by operation: each tries to reach the health data
 * (`personal.health.*`), its views, or the free note `Diary/ZZSECRETDIARY.md`.
 */
const VARIANTS: Record<string, Json[]> = {
  read_note: [{ path: "@heavy" }, { path: "@light" }, { path: "@diary" }, { path: "@heavy-no-ext" }, { path: "/@diary" }, { path: "@eggs" }, { path: "@pasta" }],
  list_folder: [
    { folder: "" },
    { folder: "Diary" },
    { folder: "Datanotes" },
    { folder: "Datanotes/personal" },
    { folder: "Datanotes/personal/health" },
    { folder: "Datanotes/personal/health/weight" },
    { folder: "Datanotes/personal/food/pantry" },
  ],
  search_notes: [{ query: "ZZSECRETHEALTH" }, { query: "ZZSECRETDIARY" }, { query: "eggs", context_length: 2000 }, { query: "weigh" }, { query: "kg" }, { query: "Morning" }, { query: "evening" }],
  list_tables: [],
  describe_table: onTables(),
  describe_database: [],
  select_rows: [
    ...onTables(),
    ...onTables({ version: 1 }),
    ...onTables({ timestamp: "2999-01-01T00:00:00Z" }),
    { table: "meals", join: { table: "weight", on: { file_link: "after_meal" }, as: "w", columns: ["kg", "note"] } },
    { table: "meals", join: { table: WEIGHT, on: { file_link: "after_meal" }, as: "w" }, group_by: "dish", aggregates: { heaviest: "max:w.kg", n: "count" } },
    { table: "pantry", where: { "for_weight.kg": { gt: 0 } } },
    { table: "pantry", where: { "for_weight.note": { contains: "ZZ" } } },
    { table: "pantry", where: { for_weight: { within: "Morning weigh-in" } } },
    { table: "pantry", expand: ["for_weight"] },
    { table: "meals", expand: ["ingredients"], include_body: true },
    { table: "pantry", this_note: "@heavy" },
    { table: "pantry", this_note: "@diary" },
    { table: "pantry", where: { item: "{this.name}" }, this_note: "@light" },
    { table: "pantry", columns: ["item", "file_backlink_count", "for_weight"], include_body: true },
    { table: "pantry", order_by: "for_weight.kg" },
    { table: "pantry", where: { note: { contains: "ZZSECRET" } } },
  ],
  check_table: [...onTables(), { limit: 1000 }],
  list_link_targets: [
    { table: "pantry", column: "for_weight" },
    { table: PANTRY, column: "for_weight", row: "eggs" },
    { table: "pantry", column: "for_weight", values: ["Morning weigh-in", "ZZSECRETHEALTH evening"] },
    { table: "weight", column: "after_meal" },
    { table: "meals", column: "ingredients" },
    { table: "meals", column: "ingredients", values: ["eggs", "nothing"] },
    { table: "vw_mixed", column: "weighings" },
    { table: "pantry", column: "nope" },
  ],
  infer_table: [
    { folder: "Diary" },
    { folder: "" },
    { folder: "Datanotes/personal/health/weight" },
    { folder: "Datanotes/personal/food/pantry" },
    { paths: ["@diary"] },
    { paths: ["@heavy", "@eggs"] },
    { table: "weight" },
    { table: WEIGHT, max_enum_values: 50 },
    { table: "pantry" },
    { name: "health_copy", folder: "Datanotes/personal/health" },
  ],
  semantic_search: [
    { query: "ZZSECRETHEALTH morning weigh", limit: 100 },
    { query: "diary ZZSECRETDIARY", limit: 100 },
    { query: "eggs", tables: ["*"], limit: 100 },
    { query: "eggs", tables: ["personal.*"], limit: 100 },
    { query: "eggs", tables: ["personal.health.*"] },
    { query: "eggs", tables: ["weight"] },
    { query: "eggs", tables: [WEIGHT] },
    { query: "eggs", tables: ["vw_heavy"] },
    { query: "eggs", folder: "Diary" },
    { query: "eggs", folder: "Datanotes/personal/health", min_score: 0 },
  ],
  search: [
    { query: "ZZSECRETHEALTH", limit: 100 },
    { query: "ZZSECRETDIARY diary", limit: 100 },
    { query: "eggs", limit: 100 },
    { query: "morning weigh kg", limit: 100 },
    { query: "evening +ZZSECRETHEALTH" },
    { query: '"Bought eggs"' },
    { query: "eggs -flour", tables: ["*"] },
    { query: "eggs", tables: ["personal.*"] },
    { query: "eggs", tables: ["weight"] },
    { query: "eggs", tables: [WEIGHT, PANTRY] },
    { query: "eggs", tables: ["vw_heavy"] },
    { query: "eggs", folder: "Diary" },
    { query: "eggs", folder: "Datanotes/personal/health", min_score: 0 },
    { query: "-eggs" },
  ],
  describe_semantic_index: [],
  list_migrations: [{ limit: 1000 }, { table: "weight" }, { table: "health" }, { op: "insert_row" }, { op: "update_row", limit: 1000 }, { since: "2000-01-01T00:00:00Z" }],
  describe_history: [...onTables(), { limit: 1000 }, { since: "2000-01-01T00:00:00Z" }],
  table_changes: [...onTables({ start_version: 0 }), { table: "weight", start_version: 1, end_version: 3 }],
  list_changes: [
    { since: 0, limit: 1000 },
    { tables: ["weight"] },
    { tables: [WEIGHT] },
    { tables: ["*"], since: 0 },
    { tables: ["personal.*"], since: 0 },
    { kinds: ["insert", "update"], since: 0 },
    { columns: ["kg", "note"], since: 0 },
    { where: { kg: { gt: 0 } }, since: 0 },
    { where: { note: { contains: "ZZ" } }, since: 0 },
    { exclude_actor: "cook", since: 0 },
  ],
  list_webhooks: [],
  graph_neighbors: [...NODES.map((from_nodes) => ({ from_nodes })), { from_nodes: { paths: ["@eggs"] }, direction: "out", edges: ["for_weight"] }],
  graph_traverse: [
    ...NODES.map((from_nodes) => ({ from_nodes, direction: "both", max_depth: 5 })),
    { from_nodes: { paths: ["@eggs"] }, tables: ["*"], direction: "both", max_depth: 5 },
    { from_nodes: { paths: ["@eggs"] }, tables: ["personal.*"], max_depth: 5 },
    { from_nodes: { paths: ["@eggs"] }, tables: ["weight"] },
    { from_nodes: { paths: ["@eggs"] }, through: ["*"], direction: "both", max_depth: 5 },
    { from_nodes: { paths: ["@eggs"] }, through: [WEIGHT], direction: "both" },
    { from_nodes: { tables: ["*"] }, min_depth: 0, direction: "both", limit: 1000 },
    { from_nodes: { paths: ["@eggs"] }, edges: ["for_weight", "after_meal"], direction: "both", max_depth: 5 },
  ],
  graph_path: [
    { from_nodes: { paths: ["@eggs"] }, to_nodes: { paths: ["@heavy"] } },
    { from_nodes: { paths: ["@eggs"] }, to_nodes: { paths: ["@diary"] } },
    { from_nodes: { paths: ["@eggs"] }, to_nodes: { paths: ["@pasta"] }, direction: "out", max_depth: 5 },
    { from_nodes: { paths: ["@eggs"] }, to_nodes: { paths: ["@pasta"] } },
    { from_nodes: { tables: ["*"] }, to_nodes: { tables: ["*"] }, direction: "both" },
    { from_nodes: { tables: ["personal.*"] }, to_nodes: { table: "weight" } },
    { from_nodes: { paths: ["@heavy"] }, to_nodes: { paths: ["@pasta"] } },
  ],
};

/** The variants of an operation as sent: no arguments at all first, then the table's. */
const variantsOf = (op: string): Json[] => [{}, ...(VARIANTS[op] ?? [])];

/** Replace the placeholders of a variant with the fixture's vault paths. */
function resolve(value: unknown, p: ReadPaths): unknown {
  if (typeof value === "string") {
    const map: Record<string, string> = { "@heavy-no-ext": p.heavy.replace(/\.md$/, ""), "@heavy": p.heavy, "@light": p.light, "@diary": p.diary, "@eggs": p.eggs, "@pasta": p.pasta };
    return Object.entries(map).reduce((s, [k, v]) => s.split(k).join(v), value);
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, p));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, p)]));
  return value;
}

/** Every string inside the arguments. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

/**
 * The answer without the caller's own input: an answer may repeat what it was asked (search_notes
 * repeats its `query`, a 404 names the note it did not find), and that tells the caller nothing it
 * did not know. Only whole values are removed, never a part of a longer text: a result that holds a
 * secret beside the caller's word still leaks. A vault path the caller gave is also removed inside
 * a message (`no note <path>`), since its name is the caller's own (D7: guessed names are not secret).
 */
function withoutEchoes(answer: unknown, args: Json): unknown {
  let text = JSON.stringify(answer) ?? "";
  for (const s of stringsOf(args).sort((a, b) => b.length - a.length)) {
    text = text.split(JSON.stringify(s)).join('"<argument>"');
    if (s.includes("/")) for (const v of [s, s.replace(/^\//, "")]) text = text.split(JSON.stringify(v).slice(1, -1)).join("<argument>");
  }
  return JSON.parse(text) as unknown;
}

/** Every array under a key `rows`, at any depth. */
function rowArrays(value: unknown): unknown[][] {
  if (Array.isArray(value)) return value.flatMap(rowArrays);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => (k === "rows" && Array.isArray(v) ? [v, ...rowArrays(v)] : rowArrays(v)));
}

/** Bag-of-words vectors over the fixture's words: a local stand-in for the embedding provider. */
const VOCAB = ["eggs", "flour", "pasta", "weigh", "zzsecrethealth", "zzsecretdiary", "diary", "morning", "evening"];
const fakeTransport: Transport = async (req: HttpRequest) => {
  const { input } = JSON.parse(req.body) as { input: string[] };
  const data = input.map((text, index) => ({ embedding: VOCAB.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01), index }));
  return { status: 200, text: JSON.stringify({ data }) };
};

let e: ReadEngine;
beforeAll(async () => {
  e = await startReadEngine({ semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake", semanticScope: "vault" }, fakeTransport);
  const ok = async (op: string, args: Json) => {
    const r = await e.op("owner", op, args);
    if (r.status !== 200) throw new Error(`${op}: ${r.status} ${r.text}`);
  };
  // history, a union view, a CHECK, webhooks and more writes: every read has something to show
  await ok("configure_database", { history: true });
  await ok("create_view", { name: "personal.food.vw_union", description: "Pantry and weight rows", query: { union: [{ table: PANTRY }, { table: WEIGHT }] } });
  await ok("add_constraint", { table: WEIGHT, name: "positive_kg", check: { kg: { gt: 0 } } });
  await ok("update_row", { table: WEIGHT, path: e.paths.light, set: { kg: 78.5, note: "ZZSECRETHEALTH updated" } });
  await ok("insert_row", { table: WEIGHT, values: { label: "ZZSECRETHEALTH later", day: "2026-10-03", kg: 80.5, note: "ZZSECRETHEALTH again", after_meal: "[[Pasta]]" } });
  await ok("insert_row", { table: PANTRY, values: { item: "salt", qty: 1 } });
  await ok("update_row", { table: MEALS, path: e.paths.pasta, set: { ingredients: ["[[eggs]]", "[[flour]]", "[[salt]]"] } });
  await ok("create_webhook", { url: "http://127.0.0.1:9/hook", tables: [WEIGHT] });
  await ok("create_webhook", { url: "http://127.0.0.1:9/hook", tables: [PANTRY] });
  await e.runtime.semantic.sync();
}, 60_000);
afterAll(async () => {
  await e?.dispose();
});

describe("the leak sweep's coverage", () => {
  it("has variants for every read operation, and none for an operation that is not one", () => {
    const missing = [...READ_OPERATIONS].filter((op) => !(op in VARIANTS)).sort();
    expect(missing, `read operations without a read-permission scenario in VARIANTS: ${missing.join(", ")}`).toEqual([]);
    expect(Object.keys(VARIANTS).filter((op) => !READ_OPERATIONS.has(op))).toEqual([]);
  });

  it("finds what the sweep looks for: the owner reads the health data and the diary", async () => {
    const all = [
      await e.op("owner", "select_rows", { table: "weight" }),
      await e.op("owner", "read_note", { path: e.paths.diary }),
      await e.op("owner", "semantic_search", { query: "ZZSECRETHEALTH", limit: 100 }),
      await e.op("owner", "list_changes", { since: 0, limit: 1000 }),
    ];
    for (const r of all) {
      expect(r.status, r.text).toBe(200);
      expect(() => expectNoLeak(r.json)).toThrow(/leaks ZZSECRET/);
    }
  });
});

const OPS = [...READ_OPERATIONS].sort();

/** A sweep reads only, so its requests run side by side; a name that is not found takes the engine a second. */
const TIMEOUT_MS = 120_000;

/** Each variant of an operation with its arguments resolved, sent as a token. */
async function sweep(token: ReadTokenName | "owner", op: string): Promise<{ args: Json; status: number; json: Json; text: string }[]> {
  return Promise.all(
    variantsOf(op).map(async (v) => {
      const args = resolve(v, e.paths) as Json;
      return { args, ...(await e.op(token, op, args)) };
    }),
  );
}

describe("cook (reads personal.food.*) never gets a secret", () => {
  it.each(OPS)("%s", async (op) => {
    for (const r of await sweep("cook", op)) {
      const what = `${op} ${JSON.stringify(r.args)} -> ${r.status} ${r.text.slice(0, 400)}`;
      expect([200, 400, 403, 404, 422], what).toContain(r.status);
      if (r.status === 403) {
        expect(r.json.error, what).toMatch(/^token cook may not read /);
        continue;
      }
      try {
        expectNoLeak(withoutEchoes(r.json, r.args));
      } catch (err) {
        throw new Error(`${what}\n${(err as Error).message}`);
      }
    }
  }, TIMEOUT_MS);
});

describe("blind (reads nothing) never gets a row", () => {
  it.each(OPS)("%s", async (op) => {
    const rowPaths = [e.paths.eggs, e.paths.flour, e.paths.pasta, ...e.paths.weight].map((p) => p.replace(/\.md$/, ""));
    for (const r of await sweep("blind", op)) {
      const what = `${op} ${JSON.stringify(r.args)} -> ${r.status} ${r.text.slice(0, 400)}`;
      expect([200, 400, 403, 404, 422], what).toContain(r.status);
      if (r.status === 403) {
        expect(r.json.error, what).toMatch(/^token blind may not read /);
        continue;
      }
      const answer = withoutEchoes(r.json, r.args);
      for (const rows of rowArrays(answer)) expect(rows, what).toEqual([]);
      const text = JSON.stringify(answer);
      for (const p of rowPaths) expect(text.includes(p), `${what}\nholds the row ${p}`).toBe(false);
      try {
        expectNoLeak(answer);
      } catch (err) {
        throw new Error(`${what}\n${(err as Error).message}`);
      }
    }
  }, TIMEOUT_MS);
});

describe("legacy (no read) and star (read *) get the owner's answers (D2)", () => {
  it.each(OPS)("%s", async (op) => {
    const [owner, legacy, star] = await Promise.all([sweep("owner", op), sweep("legacy", op), sweep("star", op)]);
    for (const [t, answers] of [["legacy", legacy], ["star", star]] as const) {
      answers.forEach((r, i) => {
        expect({ status: r.status, json: r.json }, `${t} ${op} ${JSON.stringify(r.args)}`).toEqual({ status: owner[i]!.status, json: owner[i]!.json });
      });
    }
  }, TIMEOUT_MS);
});
