/**
 * Read permissions of named tokens, lane A: what a query reads (src/core/select.ts, where.ts,
 * catalog-ops.ts). A table the caller names (a plain select, time travel, a join, a union branch, a
 * dotted key's target, `within`'s target, a view and every table it reads, `this_note`) is refused
 * with 403 when the token may not read it; a set the caller did not enumerate (`base:<name>`,
 * `system.information_schema`) is filtered; an `expand` into an unreadable row keeps the link text.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { runWithReadScope, type ReadScope } from "../src/core/read-scope";
import { select, type SelectInput } from "../src/core/select";
import type { HandlerResponse } from "../src/server/rest";
import { createDbVault } from "./helpers/db-vault";
import {
  BASE,
  DIARY_PATH,
  expectNoLeak,
  MEALS,
  noteRefusal,
  PANTRY,
  readRefusal,
  rowsOf,
  setupReadTokens,
  VW_HEAVY,
  VW_MIXED,
  WEIGHT,
  type ReadSetup,
  type ReadTokenName,
} from "./helpers/read-tokens";

/** Views of the food schema (a name `cook` may read) that reach health data in other ways. */
const VW_UNION = "personal.food.vw_union";
const VW_NESTED = "personal.food.vw_nested";
const VW_DOTTED = "personal.food.vw_dotted";
const VW_NOTED = "personal.food.vw_noted";
const VW_PANTRY = "personal.food.vw_pantry";

/** The views and constraints these tests add to the fixture, as the owner. */
async function addViews(s: ReadSetup): Promise<void> {
  const ok = async (op: string, args: Record<string, unknown>) => {
    const r = await s.op("owner", op, args);
    if (r.status !== 200) throw new Error(`${op}: ${r.status} ${JSON.stringify(r.json)}`);
  };
  await ok("create_view", { name: VW_UNION, description: "Pantry and weight rows", query: { union: [{ table: PANTRY }, { table: WEIGHT }] } });
  await ok("create_view", { name: VW_NESTED, description: "The heavy weigh-ins, again", query: { table: VW_HEAVY } });
  await ok("create_view", { name: VW_DOTTED, description: "Items bought for a heavy weigh-in", query: { table: PANTRY, where: { "for_weight.kg": { gt: 80 } } } });
  await ok("create_view", { name: VW_NOTED, description: "Every row with a note", query: { table: `base:${BASE}` } });
  await ok("create_view", { name: VW_PANTRY, description: "The pantry", query: { table: PANTRY, columns: ["item", "qty"] } });
  // history on: time travel reads them
  await ok("alter_table", { table: MEALS, history: true });
  await ok("alter_table", { table: WEIGHT, history: true });
  await ok("update_row", { table: WEIGHT, path: s.paths.light, set: { kg: 78.5 } });
  await ok("add_constraint", { table: WEIGHT, name: "positive_kg", check: { kg: { gt: 0 } } });
  await ok("add_constraint", { table: PANTRY, name: "no_negative_qty", check: { qty: { gte: 0 } } });
}

/** A 200 answer that carries no secret. */
function okNoLeak(r: HandlerResponse): HandlerResponse {
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expectNoLeak(r.json);
  return r;
}

let s: ReadSetup;
beforeAll(async () => {
  s = await setupReadTokens();
  await addViews(s);
});

/** Every read of these tests, by name: legacy and star must get the owner's answers to each. */
const READS: [string, string, Record<string, unknown>][] = [
  ["pantry", "select_rows", { table: "pantry", columns: ["item", "qty"], order_by: "item" }],
  ["meals", "select_rows", { table: "meals", columns: ["dish", "ingredients"] }],
  ["weight", "select_rows", { table: "weight", columns: ["label", "kg", "note"], order_by: "kg" }],
  ["vw_heavy", "select_rows", { table: VW_HEAVY, columns: ["label", "kg"] }],
  ["vw_mixed", "select_rows", { table: VW_MIXED }],
  ["vw_union", "select_rows", { table: VW_UNION, columns: ["note"], order_by: "note" }],
  ["vw_nested", "select_rows", { table: VW_NESTED, columns: ["label"] }],
  ["vw_dotted", "select_rows", { table: VW_DOTTED, columns: ["item"] }],
  ["vw_noted", "select_rows", { table: VW_NOTED, columns: ["note"], order_by: "note" }],
  ["join", "select_rows", { table: "meals", columns: ["dish"], join: { table: "weight", on: { file_link: "after_meal" }, as: "w", columns: ["kg"] } }],
  ["group", "select_rows", { table: "meals", join: { table: "weight", on: { file_link: "after_meal" }, as: "w" }, group_by: "dish", aggregates: { heaviest: "max:w.kg" } }],
  ["dotted", "select_rows", { table: "pantry", columns: ["item"], where: { "for_weight.kg": { gt: 0 } } }],
  ["within", "select_rows", { table: "pantry", columns: ["item"], where: { for_weight: { within: "Morning weigh-in" } } }],
  ["expand", "select_rows", { table: "pantry", columns: ["item", "for_weight"], expand: ["for_weight"], order_by: "item" }],
  ["base", "select_rows", { table: `base:${BASE}`, columns: ["note"], order_by: "note" }],
  ["info tables", "select_rows", { table: "system.information_schema.tables", columns: ["full_name", "table_type", "row_count"], order_by: "full_name" }],
  ["info columns", "select_rows", { table: "system.information_schema.columns", columns: ["table_schema", "table_name", "column_name"], limit: 1000 }],
  ["info views", "select_rows", { table: "system.information_schema.views", columns: ["table_schema", "table_name"], order_by: "table_name" }],
  ["info checks", "select_rows", { table: "system.information_schema.check_constraints", columns: ["table_name", "constraint_name"], order_by: "table_name" }],
  ["info schemata", "select_rows", { table: "information_schema.schemata", columns: ["catalog_name", "schema_name"], order_by: "schema_name" }],
  ["info catalogs", "select_rows", { table: "information_schema.catalogs", columns: ["catalog_name"] }],
  ["version", "select_rows", { table: "weight", version: 1 }],
  ["timestamp", "select_rows", { table: "weight", timestamp: "2999-01-01T00:00:00Z" }],
];
const args = (name: string) => READS.find(([n]) => n === name)![2];
const read = (token: ReadTokenName | "owner", name: string) => s.op(token, "select_rows", args(name));

describe("cook (reads personal.food.*): tables and views", () => {
  it("reads pantry and meals, not weight; not the health view, nor the food view that joins weight (D5)", async () => {
    expect(rowsOf(okNoLeak(await read("cook", "pantry")))).toEqual([
      { path: s.paths.eggs, item: "eggs", qty: 6 },
      { path: s.paths.flour, item: "flour", qty: 1 },
    ]);
    expect(rowsOf(okNoLeak(await read("cook", "meals")))).toEqual([{ path: s.paths.pasta, dish: "Pasta", ingredients: ["[[eggs]]", "[[flour]]"] }]);
    expect(await read("cook", "weight")).toEqual(readRefusal("cook", WEIGHT));
    expect(await read("cook", "vw_heavy")).toEqual(readRefusal("cook", VW_HEAVY));
    expect(await read("cook", "vw_mixed")).toEqual(readRefusal("cook", WEIGHT));
  });

  it("refuses a join with weight, a union branch of weight, and the group of a join on alias.column", async () => {
    expect(await read("cook", "join")).toEqual(readRefusal("cook", WEIGHT));
    expect(await read("cook", "vw_union")).toEqual(readRefusal("cook", WEIGHT));
    expect(await read("cook", "group")).toEqual(readRefusal("cook", WEIGHT));
  });

  it("refuses a food view over a health view, and one whose filter follows a link into health", async () => {
    expect(await read("cook", "vw_nested")).toEqual(readRefusal("cook", VW_HEAVY));
    expect(await read("cook", "vw_dotted")).toEqual(readRefusal("cook", WEIGHT));
    // a food view of a food table: read
    expect(rowsOf(okNoLeak(await s.op("cook", "select_rows", { table: VW_PANTRY, order_by: "item" }))).map((r) => r.item)).toEqual(["eggs", "flour"]);
  });

  it("refuses a dotted where key and a within that reach into health", async () => {
    expect(await read("cook", "dotted")).toEqual(readRefusal("cook", WEIGHT));
    expect(await read("cook", "within")).toEqual(readRefusal("cook", WEIGHT));
  });

  it("keeps the link text of an expand into an unreadable row (D9): no kg, no note", async () => {
    const r = okNoLeak(await read("cook", "expand"));
    expect(rowsOf(r)).toEqual([
      { path: s.paths.eggs, item: "eggs", for_weight: "[[Morning weigh-in]]" },
      { path: s.paths.flour, item: "flour", for_weight: null },
    ]);
    // the owner gets the linked row's properties
    const own = rowsOf(await read("owner", "expand"));
    expect(own[0]!.for_weight).toMatchObject({ path: s.paths.heavy, kg: 81.5, note: "ZZSECRETHEALTH day" });
    // an expand into a readable row still expands
    const meals = okNoLeak(await s.op("cook", "select_rows", { table: "meals", columns: ["ingredients"], expand: ["ingredients"] }));
    expect(rowsOf(meals)[0]!.ingredients).toEqual([
      expect.objectContaining({ path: s.paths.eggs, item: "eggs", qty: 6 }),
      expect.objectContaining({ path: s.paths.flour, item: "flour", qty: 1 }),
    ]);
  });

  it("refuses this_note on a weight row and on the diary (D8); a pantry row is read", async () => {
    const q = { table: "pantry", columns: ["item"], where: { item: "{this.item}" } };
    expect(await s.op("cook", "select_rows", { ...q, this_note: s.paths.heavy })).toEqual(noteRefusal("cook", s.paths.heavy));
    expect(await s.op("cook", "select_rows", { ...q, this_note: DIARY_PATH })).toEqual(noteRefusal("cook", DIARY_PATH));
    // a path that names no note is refused the same way: a restricted token cannot tell which exist
    expect(await s.op("cook", "select_rows", { ...q, this_note: "Diary/nothing.md" })).toEqual(noteRefusal("cook", "Diary/nothing.md"));
    expect(rowsOf(okNoLeak(await s.op("cook", "select_rows", { ...q, this_note: s.paths.eggs })))).toEqual([{ path: s.paths.eggs, item: "eggs" }]);
    // the owner reads with any note
    expect((await s.op("owner", "select_rows", { ...q, this_note: DIARY_PATH })).status).toBe(200);
  });

  it("filters system.information_schema to the readable tables and views", async () => {
    const tables = rowsOf(okNoLeak(await read("cook", "info tables")));
    expect(tables.map((r) => [r.full_name, r.table_type])).toEqual([
      [MEALS, "TABLE"],
      [PANTRY, "TABLE"],
      // a view is listed when cook may read its name and every table it reads: vw_dotted follows a
      // link into weight, vw_noted reads a base (no static answer), vw_mixed and vw_union read weight
      [VW_PANTRY, "VIEW"],
    ]);
    const columns = rowsOf(okNoLeak(await read("cook", "info columns")));
    expect(new Set(columns.map((r) => `${r.table_schema}.${r.table_name}`))).toEqual(new Set(["food.pantry", "food.meals"]));
    expect(rowsOf(okNoLeak(await read("cook", "info views")))).toEqual([{ path: expect.any(String), table_schema: "food", table_name: "vw_pantry" }]);
    expect(rowsOf(okNoLeak(await read("cook", "info checks"))).map((r) => [r.table_name, r.constraint_name])).toEqual([["pantry", "no_negative_qty"]]);
    // a schema with nothing readable is not listed
    expect(rowsOf(okNoLeak(await read("cook", "info schemata"))).map((r) => r.schema_name)).toEqual(["food"]);
    expect(rowsOf(okNoLeak(await read("cook", "info catalogs"))).map((r) => r.catalog_name)).toEqual(["personal"]);
    for (const name of ["info tables", "info columns", "info views", "info checks", "info schemata", "info catalogs"]) {
      expect(JSON.stringify((await read("cook", name)).json), name).not.toMatch(/health|"weight"|vw_heavy|vw_mixed|vw_union|vw_nested/);
    }
  });

  it("reads only the food rows of a base across food and health, directly and through a view", async () => {
    expect(rowsOf(okNoLeak(await read("cook", "base"))).map((r) => [r.path, r.note])).toEqual([
      [s.paths.eggs, "fresh"],
      [s.paths.flour, null],
    ]);
    expect(rowsOf(okNoLeak(await read("cook", "vw_noted"))).map((r) => r.note)).toEqual(["fresh", null]);
    // the owner reads the weight rows too
    expect(rowsOf(await read("owner", "base"))).toHaveLength(4);
  });

  it("refuses time travel on weight, by version and by timestamp", async () => {
    expect(await read("cook", "version")).toEqual(readRefusal("cook", WEIGHT));
    expect(await read("cook", "timestamp")).toEqual(readRefusal("cook", WEIGHT));
  });
});

describe("other tokens", () => {
  it("nurse (reads personal.health.*) reads weight and vw_heavy, not vw_mixed nor a join with meals", async () => {
    expect(rowsOf(await read("nurse", "weight")).map((r) => r.kg)).toEqual([78.5, 81.5]);
    expect(rowsOf(await read("nurse", "vw_heavy"))).toEqual([{ path: s.paths.heavy, label: "Morning weigh-in", kg: 81.5 }]);
    expect(await read("nurse", "vw_mixed")).toEqual(readRefusal("nurse", VW_MIXED));
    expect(await s.op("nurse", "select_rows", { table: "weight", join: { table: "meals", on: { after_meal: "file_link" } } })).toEqual(readRefusal("nurse", MEALS));
  });

  it("blind (reads nothing) gets an empty base and an empty information_schema", async () => {
    expect(okNoLeak(await read("blind", "base")).json).toEqual({ table: `base:${BASE}`, total: 0, rows: [] });
    for (const name of ["info tables", "info columns", "info views", "info checks", "info schemata", "info catalogs"]) {
      expect(rowsOf(okNoLeak(await read("blind", name))), name).toEqual([]);
    }
  });

  it("legacy (no read) and star (read *) get the owner's answer to every read above (D2)", async () => {
    // the owner's answers are rows, also by time travel (history is on)
    expect(rowsOf(await read("owner", "version")).map((r) => r.kg)).toEqual([81.5, 78.5]);
    expect(rowsOf(await read("owner", "timestamp")).map((r) => r.kg)).toEqual([81.5, 78.5]);
    for (const [name, op, a] of READS) {
      const owner = await s.op("owner", op, a);
      expect(await s.op("legacy", op, a), name).toEqual(owner);
      expect(await s.op("star", op, a), name).toEqual(owner);
    }
    for (const note of [s.paths.heavy, DIARY_PATH]) {
      const a = { table: "pantry", columns: ["item"], where: { item: "{this.item}" }, this_note: note };
      const owner = await s.op("owner", "select_rows", a);
      expect(owner.status).toBe(200);
      expect(await s.op("legacy", "select_rows", a)).toEqual(owner);
      expect(await s.op("star", "select_rows", a)).toEqual(owner);
    }
  });
});

describe("a write's filter is a read", () => {
  it("cook's update_rows on pantry with a dotted where into health is refused, and writes nothing", async () => {
    const w = await setupReadTokens();
    const r = await w.op("cook", "update_rows", { table: "pantry", where: { "for_weight.kg": { gt: 80 } }, set: { qty: 0 } });
    expect(r).toEqual(readRefusal("cook", WEIGHT));
    const rows = rowsOf(await w.op("owner", "select_rows", { table: "pantry", columns: ["item", "qty"], order_by: "item" }));
    expect(rows.map((x) => [x.item, x.qty])).toEqual([["eggs", 6], ["flour", 1]]);
    // the same filter on a readable link is a write cook may make
    const ok = await w.op("cook", "update_rows", { table: "pantry", where: { item: "flour" }, set: { qty: 2 } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expectNoLeak(ok.json);
  });
});

describe("the engine's read sites, without the guard's pre-check", () => {
  const COOK: ReadScope = { token: "cook", patterns: ["personal.food.*"] };
  const asCook = (input: SelectInput) => runWithReadScope(COOK, () => select(s.v.app, s.v.settings, input));
  const denied = (full: string) => ({ name: "ReadDeniedError", message: `token cook may not read ${full}` });

  it("refuses a plain select, a select by version and by timestamp, and a join by timestamp", async () => {
    await expect(asCook({ table: "weight" })).rejects.toMatchObject(denied(WEIGHT));
    await expect(asCook({ table: "personal.health.weight", version: 1 })).rejects.toMatchObject(denied(WEIGHT));
    await expect(asCook({ table: "weight", timestamp: "2999-01-01T00:00:00Z" })).rejects.toMatchObject(denied(WEIGHT));
    await expect(asCook({ table: "meals", timestamp: "2999-01-01T00:00:00Z", join: { table: "weight", on: { file_link: "after_meal" } } })).rejects.toMatchObject(denied(WEIGHT));
    // the same reads of food tables run
    expect((await asCook({ table: "pantry" })).total).toBe(2);
  });

  it("leaves a name that is no table to the read that follows: not found, as for the owner", async () => {
    await expect(asCook({ table: "pantri", timestamp: "2999-01-01T00:00:00Z" })).rejects.toMatchObject({ name: "TableNotFoundError" });
    await expect(asCook({ table: "meals", timestamp: "2999-01-01T00:00:00Z", join: { table: "nothing", on: { file_link: "x" } } })).rejects.toMatchObject({ name: "TableNotFoundError" });
    // a vault without a metastore has no table to refuse
    const empty = createDbVault({});
    await expect(runWithReadScope(COOK, () => select(empty.app, empty.settings, { table: "weight", version: 1 }))).rejects.toMatchObject({ name: "TableNotFoundError" });
  });

  it("without a scope, reads everything", async () => {
    expect((await select(s.v.app, s.v.settings, { table: "weight" })).total).toBe(2);
    expect((await select(s.v.app, s.v.settings, { table: `base:${BASE}` })).total).toBe(4);
  });
});
