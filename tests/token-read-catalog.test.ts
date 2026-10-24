/**
 * Read permissions of named tokens, lane B: what the catalog and the metadata operations tell a
 * token with restricted `read` patterns (src/core/read-scope.ts). list_tables and describe_database
 * list only the tables and views it may read; describe_table, check_table, infer_table and
 * list_link_targets refuse what it may not read, or leave it out where it named no table; the
 * violations of a link filtered into a table it may not read do not list that table's rows
 * (the Postgres CVE-2014-8161 rule); a misspelled name suggests only what it may read.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { guide } from "../src/core/hints";
import { BASE, DIARY_PATH, expectNoLeak, MEALS, noteRefusal, PANTRY, readRefusal, setupReadTokens, VW_HEAVY, VW_MIXED, WEIGHT, type ReadSetup, type ReadTokenName } from "./helpers/read-tokens";

const HOST = process.env.VAULT_HOST === "node" ? ({ host: "node" } as const) : {};
const setup = () => setupReadTokens(HOST);

interface Listed {
  tables: { qualified: string }[];
  views: { qualified: string }[];
}
const names = (r: { json: unknown }) => {
  const l = r.json as Listed;
  return { tables: l.tables.map((t) => t.qualified), views: l.views.map((v) => v.qualified) };
};

/** The tokens that read everything: their answers are the owner's (D2). */
const WIDE: readonly ReadTokenName[] = ["legacy", "star"];

describe("token read permissions: listings", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setup();
  });

  it("list_tables lists only the tables and views a token may read", async () => {
    const all = { tables: [PANTRY, MEALS, WEIGHT].sort(), views: [VW_HEAVY, VW_MIXED] };
    const sorted = (r: { json: unknown }) => {
      const n = names(r);
      return { tables: [...n.tables].sort(), views: [...n.views].sort() };
    };
    expect(sorted(await s.op("owner", "list_tables"))).toEqual({ tables: all.tables, views: [VW_MIXED, VW_HEAVY].sort() });
    const cook = await s.op("cook", "list_tables");
    expect(cook.status).toBe(200);
    // vw_mixed lives in food but joins the weight rows: hidden (D5)
    expect(sorted(cook)).toEqual({ tables: [MEALS, PANTRY], views: [] });
    expectNoLeak(cook.json);
    expect(JSON.stringify(cook.json)).not.toContain("health");
    // vw_heavy reads only weight; vw_mixed also reads meals
    expect(sorted(await s.op("nurse", "list_tables"))).toEqual({ tables: [WEIGHT], views: [VW_HEAVY] });
    expect(await s.op("blind", "list_tables")).toEqual({ status: 200, json: { tables: [], views: [] } });
    const owner = await s.op("owner", "list_tables");
    for (const t of WIDE) expect(await s.op(t, "list_tables")).toEqual(owner);
  });

  it("describe_database leaves out what a token may not read: tables, views, schemas, catalogs, bases", async () => {
    const owner = await s.op("owner", "describe_database");
    const shape = (r: { json: unknown }) =>
      (r.json as { catalogs: { catalog: string; schemas: { schema: string; tables: { qualified: string; row_count: number }[]; views: { qualified: string }[] }[] }[] }).catalogs.map((c) => ({
        catalog: c.catalog,
        schemas: c.schemas.map((x) => ({ schema: x.schema, tables: x.tables.map((t) => [t.qualified, t.row_count]), views: x.views.map((v) => v.qualified) })),
      }));
    const bases = (r: { json: unknown }) => (r.json as { bases: { name: string; tables: string[] }[] }).bases.map((b) => [b.name, b.tables]);
    expect(shape(owner)).toEqual([
      {
        catalog: "personal",
        schemas: [
          { schema: "food", tables: [[PANTRY, 2], [MEALS, 1]], views: [VW_MIXED] },
          { schema: "health", tables: [[WEIGHT, 2]], views: [VW_HEAVY] },
        ],
      },
    ]);
    expect(bases(owner)).toEqual([[BASE, [PANTRY, WEIGHT]]]);

    const cook = await s.op("cook", "describe_database");
    expect(cook.status).toBe(200);
    expect(shape(cook)).toEqual([{ catalog: "personal", schemas: [{ schema: "food", tables: [[PANTRY, 2], [MEALS, 1]], views: [] }] }]);
    expect(bases(cook)).toEqual([[BASE, [PANTRY]]]);
    expectNoLeak(cook.json);
    expect(JSON.stringify(cook.json)).not.toContain("health");
    // the rest of the answer is the owner's
    const { catalogs: _c, bases: _b, ...rest } = owner.json as Record<string, unknown>;
    expect(cook.json).toMatchObject(rest);

    expect(shape(await s.op("nurse", "describe_database"))).toEqual([{ catalog: "personal", schemas: [{ schema: "health", tables: [[WEIGHT, 2]], views: [VW_HEAVY] }] }]);
    const blind = await s.op("blind", "describe_database");
    expect(shape(blind)).toEqual([]);
    expect(bases(blind)).toEqual([]);
    for (const t of WIDE) expect(await s.op(t, "describe_database")).toEqual(owner);
  });

  it("describe_table refuses a table or a view the token may not read", async () => {
    expect(await s.op("cook", "describe_table", { table: "weight" })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "describe_table", { table: WEIGHT })).toEqual(readRefusal("cook", WEIGHT));
    // a view: its own name (vw_heavy) or a table it reads (vw_mixed joins weight)
    expect(await s.op("cook", "describe_table", { table: "vw_heavy" })).toEqual(readRefusal("cook", VW_HEAVY));
    expect(await s.op("cook", "describe_table", { table: "vw_mixed" })).toEqual(readRefusal("cook", VW_MIXED));
    expect(await s.op("nurse", "describe_table", { table: "vw_mixed" })).toEqual(readRefusal("nurse", VW_MIXED));
    const pantry = await s.op("cook", "describe_table", { table: "pantry" });
    expect(pantry.status).toBe(200);
    expect((pantry.json as { qualified: string; row_count: number }).qualified).toBe(PANTRY);
    expectNoLeak(pantry.json);
    expect((await s.op("nurse", "describe_table", { table: "weight" })).status).toBe(200);
    // a view the token may read answers as it answers the owner
    const view = await s.op("owner", "describe_table", { table: "vw_heavy" });
    expect(await s.op("nurse", "describe_table", { table: "vw_heavy" })).toEqual(view);
  });

  it("describe_table answers a token that reads everything as it answers the owner", async () => {
    for (const t of WIDE) {
      expect(await s.op(t, "describe_table", { table: "weight" })).toEqual(await s.op("owner", "describe_table", { table: "weight" }));
      expect(await s.op(t, "describe_table", { table: "vw_mixed" })).toEqual(await s.op("owner", "describe_table", { table: "vw_mixed" }));
    }
  });

  it("a misspelled table suggests only the tables and views the token may read", async () => {
    const owner = await s.op("owner", "select_rows", { table: "weigth" });
    expect(owner.status).toBe(404);
    expect((owner.json as { hint: string }).hint).toContain(`Did you mean "weight"?`);
    const cook = await s.op("cook", "select_rows", { table: "weigth" });
    expect(cook).toEqual({
      status: 404,
      json: { error: "Table not found: weigth", ...guide("Tables: meals, pantry. list_tables lists them with their descriptions and aliases.", "findTable") },
    });
    expect(await s.op("cook", "describe_table", { table: "weigth" })).toEqual({
      status: 404,
      json: { error: "Table not found: weigth", ...guide("Tables: meals, pantry. list_tables lists them with their descriptions and aliases.", "findTable") },
    });
  });

  // each "not found" waits for the vault index (about a second): a few per test
  it("a misspelled view suggests only the views the token may read", async () => {
    // a view's name is not suggested either, and the view list leaves out the hidden ones
    const view = await s.op("cook", "select_rows", { table: "vw_heavvy" });
    expect(view.status).toBe(404);
    expect((view.json as { hint: string }).hint).toBe("Tables: meals, pantry. list_tables lists them with their descriptions and aliases.");
    const nurse = await s.op("nurse", "select_rows", { table: "vw_heavvy" });
    expect((nurse.json as { hint: string }).hint).toBe(`Did you mean "vw_heavy"? Tables: weight. Views: vw_heavy. list_tables lists them with their descriptions and aliases.`);
  });

  it("a misspelled table suggests nothing to a token that reads nothing, and everything to one that reads everything", async () => {
    const owner = await s.op("owner", "select_rows", { table: "weigth" });
    expect(await s.op("blind", "select_rows", { table: "weigth" })).toEqual({
      status: 404,
      json: { error: "Table not found: weigth", ...guide("Token blind may read no table. list_tables lists them with their descriptions and aliases.", "findTable") },
    });
    for (const t of WIDE) expect(await s.op(t, "select_rows", { table: "weigth" })).toEqual(owner);
  });
});

describe("token read permissions: check_table", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setup();
    // hand edits that break a rule: a weight row (a secret in its path and value) and a pantry row
    const light = s.paths.light;
    s.v.write(light, s.v.read(light).replace(/^kg: .*$/m, "kg: ZZSECRETHEALTH"));
    s.v.write(s.paths.flour, s.v.read(s.paths.flour).replace(/^qty: .*$/m, "qty: -1"));
    await s.op("owner", "list_tables"); // the host settles the edits
  });

  it("checks only the tables the token may read when no table is named", async () => {
    const owner = await s.op("owner", "check_table");
    const paths = (r: { json: unknown }) => (r.json as { violations: { path: string }[] }).violations.map((v) => v.path);
    expect(paths(owner).sort()).toEqual([s.paths.flour, s.paths.light].sort());
    expect(owner.json).toMatchObject({ table: null, tables_checked: 3, rows_checked: 5, total: 2 });
    const cook = await s.op("cook", "check_table");
    expect(cook.status).toBe(200);
    expect(cook.json).toMatchObject({ table: null, tables_checked: 2, rows_checked: 3, total: 1 });
    expect(paths(cook)).toEqual([s.paths.flour]);
    expectNoLeak(cook.json);
    expect(await s.op("blind", "check_table")).toEqual({ status: 200, json: { table: null, rows_checked: 0, tables_checked: 0, total: 0, violations: [] } });
    for (const t of WIDE) expect(await s.op(t, "check_table")).toEqual(owner);
  });

  it("refuses a table the token may not read, and checks one it may", async () => {
    expect(await s.op("cook", "check_table", { table: "weight" })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "check_table", { table: WEIGHT })).toEqual(readRefusal("cook", WEIGHT));
    const pantry = await s.op("cook", "check_table", { table: "pantry" });
    expect(pantry.json).toMatchObject({ table: "pantry", rows_checked: 2, total: 1 });
    expectNoLeak(pantry.json);
    const nurse = await s.op("nurse", "check_table", { table: "weight" });
    expect((nurse.json as { violations: { path: string }[] }).violations.map((v) => v.path)).toEqual([s.paths.light]);
  });
});

describe("token read permissions: check_table on a note whose front matter cannot be read", () => {
  it("reports it to a token that reads its table, never to one that does not", async () => {
    // the Node host, like Obsidian, indexes such a note without properties
    const s = await setupReadTokens({ host: "node" });
    const pantryNote = "Datanotes/personal/food/pantry/broken.md";
    const weightNote = "Datanotes/personal/health/weight/broken.md";
    s.v.write(pantryNote, "---\ntable: personal.food.pantry\nitem: [salt\n---\n");
    s.v.write(weightNote, "---\ntable: personal.health.weight\nlabel: [ZZSECRETHEALTH\n---\n");
    await s.op("owner", "list_tables"); // the host settles the edits
    const unreadable = (r: { json: unknown }) =>
      (r.json as { violations: { path: string; violations: { code: string }[] }[] }).violations.filter((v) => v.violations.every((x) => x.code === "unreadable")).map((v) => v.path);
    expect(unreadable(await s.op("owner", "check_table")).sort()).toEqual([pantryNote, weightNote].sort());
    expect(unreadable(await s.op("cook", "check_table", { table: "pantry" }))).toEqual([pantryNote]);
    const cook = await s.op("cook", "check_table");
    expect(unreadable(cook)).toEqual([pantryNote]);
    expectNoLeak(cook.json);
    expect(unreadable(await s.op("nurse", "check_table", { table: "weight" }))).toEqual([weightNote]);
  });
});

describe("token read permissions: infer_table", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setup();
  });

  it("leaves out the notes of a folder the token may not read", async () => {
    const owner = await s.op("owner", "infer_table", { folder: "Diary" });
    expect((owner.json as { paths: string[] }).paths).toEqual([DIARY_PATH]);
    const cook = await s.op("cook", "infer_table", { folder: "Diary" });
    expect(cook.status).toBe(200);
    expect(cook.json).toMatchObject({ files: 0, paths: [], skipped: [], columns: [] });
    expectNoLeak(cook.json);
    // the whole vault: the food rows are skipped (rows already), nothing of health or the diary shows
    const all = await s.op("cook", "infer_table", { folder: "" });
    expect(all.json).toMatchObject({ files: 0, paths: [] });
    expect((all.json as { skipped: { path: string; reason: string }[] }).skipped.map((x) => x.path).sort()).toEqual([s.paths.eggs, s.paths.flour, s.paths.pasta].sort());
    expectNoLeak(all.json);
    for (const t of WIDE) expect(await s.op(t, "infer_table", { folder: "" })).toEqual(await s.op("owner", "infer_table", { folder: "" }));
  });

  it("refuses a note or a table the token may not read", async () => {
    expect(await s.op("cook", "infer_table", { paths: [DIARY_PATH] })).toEqual(noteRefusal("cook", DIARY_PATH));
    expect(await s.op("cook", "infer_table", { paths: ["Diary/ZZSECRETDIARY"] })).toEqual(noteRefusal("cook", DIARY_PATH));
    expect(await s.op("cook", "infer_table", { paths: [s.paths.heavy] })).toEqual(noteRefusal("cook", s.paths.heavy));
    expect(await s.op("cook", "infer_table", { table: "weight" })).toEqual(readRefusal("cook", WEIGHT));
    // a row of a table it reads: skipped as a row, as for the owner
    const eggs = await s.op("cook", "infer_table", { paths: [s.paths.eggs] });
    expect(eggs.json).toMatchObject({ files: 0, skipped: [{ path: s.paths.eggs, reason: `already a row of ${PANTRY}` }] });
    const pantry = await s.op("cook", "infer_table", { table: "pantry" });
    expect(pantry.status).toBe(200);
    expectNoLeak(pantry.json);
    for (const t of WIDE) expect((await s.op(t, "infer_table", { paths: [DIARY_PATH] })).status).toBe(200);
  });
});

describe("token read permissions: link targets", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setup();
    // a filtered link from food into health: its refusals list the valid targets
    const r = await s.op("owner", "add_column", {
      table: PANTRY,
      column: { name: "weighed_in", type: "link", ref: WEIGHT, ref_where: { kg: { lt: 80 } }, description: "A light weigh-in" },
    });
    expect(r.status).toBe(200);
  });

  it("list_link_targets refuses a column that links into a table the token may not read", async () => {
    expect(await s.op("cook", "list_link_targets", { table: "pantry", column: "for_weight" })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "list_link_targets", { table: "pantry", column: "weighed_in" })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "list_link_targets", { table: "weight", column: "after_meal" })).toEqual(readRefusal("cook", WEIGHT));
    // nurse reads weight, whose after_meal links into food
    expect(await s.op("nurse", "list_link_targets", { table: "weight", column: "after_meal" })).toEqual(readRefusal("nurse", MEALS));
    const ingredients = await s.op("cook", "list_link_targets", { table: "meals", column: "ingredients" });
    expect(ingredients.status).toBe(200);
    expect(ingredients.json).toMatchObject({ table: MEALS, column: "ingredients", ref: PANTRY, total: 2 });
    expectNoLeak(ingredients.json);
    for (const t of WIDE) expect(await s.op(t, "list_link_targets", { table: "pantry", column: "for_weight" })).toEqual(await s.op("owner", "list_link_targets", { table: "pantry", column: "for_weight" }));
  });

  it("a write with a broken link into a table the token may not read is refused without that table's rows", async () => {
    const values = { item: "milk", for_weight: "[[Nobody]]" };
    const cook = await s.op("cook", "insert_row", { table: PANTRY, values });
    expect(cook.status).toBe(422);
    expect((cook.json as { violations: { violations: { column: string; code: string; message: string }[] }[] }).violations[0]!.violations).toEqual([
      { column: "for_weight", code: "broken_link", message: "link does not resolve: Nobody", value: "[[Nobody]]" },
    ]);
    expectNoLeak(cook.json);
    expect(JSON.stringify(cook.json)).not.toContain("Morning weigh-in");
  });

  it("a filtered link's refusal lists the valid targets only when the token may read them", async () => {
    // Morning weigh-in weighs 81.5: no valid target of a filter kg < 80; the light one is
    const values = { item: "milk", weighed_in: "[[Morning weigh-in]]" };
    const violation = (r: { json: unknown }) => (r.json as { violations: { violations: { column: string; message: string }[] }[] }).violations[0]!.violations.find((v) => v.column === "weighed_in")!.message;
    const needs = `[[Morning weigh-in]] is not a valid weighed_in (needs ref_where {"kg":{"lt":80}});`;
    const owner = await s.op("owner", "insert_row", { table: PANTRY, values, dry_run: true });
    expect(owner.status).toBe(422);
    expect(violation(owner)).toBe(`${needs} valid: ZZSECRETHEALTH evening`);
    const cook = await s.op("cook", "insert_row", { table: PANTRY, values });
    expect(cook.status).toBe(422);
    expect(violation(cook)).toBe(`${needs} the link must name a row of weighed_in's target table`);
    expectNoLeak(cook.json);
    const dry = await s.op("cook", "insert_row", { table: PANTRY, values, dry_run: true });
    expect((dry.json as { violations: unknown }).violations).toEqual((cook.json as { violations: unknown }).violations);
    expectNoLeak(dry.json);
    // legacy writes the pantry and reads everything (star may not write)
    expect(violation(await s.op("legacy", "insert_row", { table: PANTRY, values }))).toBe(violation(owner));
    // nothing was written
    const rows = await s.op("owner", "select_rows", { table: PANTRY, where: { item: "milk" } });
    expect((rows.json as { rows: unknown[] }).rows).toEqual([]);
  });

  it("check_table reports a hand-broken filtered link without the hidden table's rows", async () => {
    const egg = s.paths.eggs;
    s.v.write(egg, s.v.read(egg).replace(/^item: .*$/m, (line) => `${line}\nweighed_in: "[[Morning weigh-in]]"`));
    await s.op("owner", "list_tables");
    const message = (r: { json: unknown }) => (r.json as { violations: { path: string; violations: { column?: string; message: string }[] }[] }).violations.find((v) => v.path === egg)!.violations.find((v) => v.column === "weighed_in")!.message;
    const needs = `[[Morning weigh-in]] is not a valid weighed_in (needs ref_where {"kg":{"lt":80}});`;
    expect(message(await s.op("owner", "check_table", { table: "pantry" }))).toBe(`${needs} valid: ZZSECRETHEALTH evening`);
    const cook = await s.op("cook", "check_table", { table: "pantry" });
    expect(message(cook)).toBe(`${needs} the link must name a row of weighed_in's target table`);
    expectNoLeak(cook.json);
  });
});
