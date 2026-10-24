/**
 * alter_table that moves or renames a table rewrites what names it in other definitions: the
 * `ref` and `vocabulary` of link and string columns (lists of links and base columns included)
 * and the tables of view queries (`table`, `union[].table`, `join.table`). The dry run lists
 * them in `schema_references`; undo_migration puts the old names back.
 */

import { describe, expect, it } from "vitest";
import { addConstraint, createView, defineBase, setTableBases } from "../src/core/catalog-ops";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { parseMetastore } from "../src/core/metastore";
import { alterTable, checkTable, insertRow, select } from "../src/core/rows";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const OLD = "family.feeding.food";
const FOOD_DIR = "Datanotes/family/feeding/food";
const REFERRING = ["food_introduction", "recipe", "meal_item"];

async function ok(p: Promise<{ ok: boolean; conflicts?: unknown; violations?: unknown }>): Promise<void> {
  const r = await p;
  expect(r.ok, JSON.stringify([r.conflicts, r.violations])).toBe(true);
}

/**
 * The ticket's database: `family.feeding.food`, linked by `food_introduction.food` (a link, and
 * `favourite`, a vocabulary), `recipe.ingredients` (a list of links) and `meal_item.ingredients`
 * (a list of links of base `meal_part`); views read it directly, in a union and in a join.
 */
async function feeding(): Promise<DbVault> {
  const v = createDbVault({});
  const at = { catalog: "family", schema: "feeding" };
  await ok(createTable(v.app, v.settings, described({
    ...at, name: "food", options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true, dense: true },
      { name: "kind", type: "enum", values: ["protein", "fruit", "grain"] },
    ],
  })));
  await ok(createTable(v.app, v.settings, described({
    ...at, name: "food_introduction", options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true, dense: true },
      { name: "food", type: "link", ref: OLD },
      { name: "favourite", type: "string", vocabulary: OLD },
    ],
  })));
  await ok(createTable(v.app, v.settings, described({
    ...at, name: "recipe", options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true, dense: true },
      { name: "ingredients", type: "list", items: "link", ref: OLD },
    ],
  })));
  await ok(defineBase(v.app, v.settings, describedBase({ name: "meal_part", columns: [{ name: "ingredients", type: "list", items: "link", ref: OLD }] })));
  await ok(createTable(v.app, v.settings, described({ ...at, name: "meal_item", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true, dense: true }] })));
  await ok(setTableBases(v.app, v.settings, { table: "meal_item", bases: ["meal_part"] }));
  for (const [name, kind] of [["Uovo", "protein"], ["Mela", "fruit"], ["Riso", "grain"]]) {
    await ok(insertRow(v.app, v.settings, { table: "food", values: { name, kind } }));
  }
  await ok(insertRow(v.app, v.settings, { table: "food_introduction", values: { name: "First egg", food: `[[${FOOD_DIR}/Uovo]]`, favourite: "Mela" } }));
  await ok(insertRow(v.app, v.settings, { table: "recipe", values: { name: "Pappa", ingredients: [`[[${FOOD_DIR}/Riso]]`, "[[Mela]]"] } }));
  await ok(insertRow(v.app, v.settings, { table: "meal_item", values: { name: "Lunch", ingredients: [`[[${FOOD_DIR}/Uovo]]`, `[[${FOOD_DIR}/Riso]]`] } }));
  await ok(createView(v.app, v.settings, { ...at, name: "vw_food", query: { table: OLD, columns: ["name"], order_by: "name" } }));
  await ok(createView(v.app, v.settings, { ...at, name: "vw_short", query: { table: "food", columns: ["name"], order_by: "name" } }));
  await ok(createView(v.app, v.settings, { ...at, name: "vw_named", query: { union: [{ table: "family.feeding.recipe" }, { table: OLD }], columns: ["name"], order_by: "name" } }));
  await ok(createView(v.app, v.settings, { ...at, name: "vw_firsts", query: { table: "food_introduction", columns: ["name"], join: { table: OLD, on: { food: "file_link" }, columns: ["kind"] } } }));
  return v;
}

async function violationsOf(v: DbVault, tables: readonly string[]): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = (await checkTable(v.app, v.settings, { table: t })).violations;
  return out;
}

const NONE = Object.fromEntries(REFERRING.map((t) => [t, []]));

/** The views, as they answer. */
async function views(v: DbVault): Promise<Record<string, unknown>> {
  const names = async (view: string) => (await select(v.app, v.settings, { table: view })).rows.map((r) => r.name);
  const firsts = (await select(v.app, v.settings, { table: "vw_firsts" })).rows.map((r) => [r.name, (r as Record<string, any>).food?.map((f: Record<string, unknown>) => f.kind) ?? (r as Record<string, any>)["family.feeding.food"]]);
  return { vw_food: await names("vw_food"), vw_short: await names("vw_short"), vw_named: await names("vw_named"), vw_firsts: firsts.length };
}

const ANSWERS = { vw_food: ["Mela", "Riso", "Uovo"], vw_short: ["Mela", "Riso", "Uovo"], vw_named: ["Mela", "Pappa", "Riso", "Uovo"], vw_firsts: 1 };

function model(v: DbVault) {
  const m = parseMetastore(v.read(METASTORE));
  const sch = (s: string) => m.catalogs.family!.schemas[s]!;
  const col = (t: string, c: string) => sch("feeding").tables[t]!.columns.find((x) => x.name === c)!;
  return { m, sch, col };
}

describe("alter_table rewrites the references to the table it moves", () => {
  it("a move to another schema (the ticket): links, lists of links, base columns, vocabularies and views follow; check_table finds nothing", async () => {
    const v = await feeding();
    expect(await violationsOf(v, REFERRING)).toEqual(NONE);
    const NEW = "family.babycare.food";
    const r = await alterTable(v.app, v.settings, { table: OLD, schema: "babycare" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    const { m, col } = model(v);
    expect(col("food_introduction", "food").ref).toBe(NEW);
    expect(col("food_introduction", "favourite").vocabulary).toBe(NEW);
    expect(col("recipe", "ingredients").ref).toBe(NEW);
    expect(m.bases.meal_part!.columns.find((c) => c.name === "ingredients")!.ref).toBe(NEW);
    const q = (name: string) => m.catalogs.family!.schemas.feeding!.views[name]!.query as Record<string, any>;
    expect(q("vw_food").table).toBe(NEW);
    expect(q("vw_short").table).toBe("food"); // still names the table: left as written
    expect(q("vw_named").union.map((b: { table: string }) => b.table)).toEqual(["family.feeding.recipe", NEW]);
    expect(q("vw_firsts").join.table).toBe(NEW);
    expect(await violationsOf(v, REFERRING)).toEqual(NONE);
    expect((await checkTable(v.app, v.settings, { table: NEW })).violations).toEqual([]);
    expect(await views(v)).toEqual(ANSWERS);
    // a new link to a food row is accepted under the new name, one to another table refused
    await ok(insertRow(v.app, v.settings, { table: "food_introduction", values: { name: "First apple", food: "[[Mela]]", favourite: "Uovo" } }));
    expect((await insertRow(v.app, v.settings, { table: "food_introduction", values: { name: "Odd", food: "[[Pappa]]" } })).ok).toBe(false);
  });

  it("a rename: the same references follow the new name, the short view name included", async () => {
    const v = await feeding();
    const NEW = "family.feeding.ingredient";
    const r = await alterTable(v.app, v.settings, { table: OLD, name: "ingredient" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    const { m, col } = model(v);
    expect([col("food_introduction", "food").ref, col("food_introduction", "favourite").vocabulary, col("recipe", "ingredients").ref]).toEqual([NEW, NEW, NEW]);
    expect(m.bases.meal_part!.columns.find((c) => c.name === "ingredients")!.ref).toBe(NEW);
    expect((m.catalogs.family!.schemas.feeding!.views.vw_short!.query as Record<string, unknown>).table).toBe(NEW);
    expect(await violationsOf(v, REFERRING)).toEqual(NONE);
    expect(await views(v)).toEqual(ANSWERS);
  });

  it("the dry run lists every reference it would rewrite and writes nothing", async () => {
    const v = await feeding();
    const before = v.read(METASTORE);
    const NEW = "family.babycare.food";
    const r = await alterTable(v.app, v.settings, { table: OLD, schema: "babycare" }, { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.schema_references).toEqual([
      { base: "meal_part", column: "ingredients", key: "ref", from: OLD, to: NEW },
      { table: "family.feeding.food_introduction", column: "food", key: "ref", from: OLD, to: NEW },
      { table: "family.feeding.food_introduction", column: "favourite", key: "vocabulary", from: OLD, to: NEW },
      { table: "family.feeding.recipe", column: "ingredients", key: "ref", from: OLD, to: NEW },
      { view: "family.feeding.vw_firsts", key: "join.table", from: OLD, to: NEW },
      { view: "family.feeding.vw_food", key: "table", from: OLD, to: NEW },
      { view: "family.feeding.vw_named", key: "union[1].table", from: OLD, to: NEW },
    ]);
    expect(v.read(METASTORE)).toBe(before);
    // a change of metadata only names nothing
    expect((await alterTable(v.app, v.settings, { table: OLD, description: "Foods" }, { dryRun: true })).schema_references).toBeUndefined();
  });

  it("undo_migration puts the old references and views back", async () => {
    const v = await feeding();
    const before = v.read(METASTORE);
    const r = await alterTable(v.app, v.settings, { table: OLD, name: "ingredient", schema: "babycare" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(r.schema_references).toHaveLength(8);
    const undo = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(undo.ok, JSON.stringify(undo.conflicts)).toBe(true);
    expect(v.read(METASTORE)).toBe(before);
    expect(v.exists(`${FOOD_DIR}/Uovo.md`)).toBe(true);
    expect(await violationsOf(v, REFERRING)).toEqual(NONE);
    expect(await views(v)).toEqual(ANSWERS);
  });

  it("a vocabulary of the moved table itself follows its new name", async () => {
    const v = await feeding();
    const { addColumn } = await import("../src/core/engine");
    await ok(addColumn(v.app, v.settings, described({ table: OLD, column: { name: "pairs_with", type: "string", vocabulary: OLD } })));
    await ok(alterTable(v.app, v.settings, { table: OLD, name: "ingredient" }));
    const own = parseMetastore(v.read(METASTORE)).catalogs.family!.schemas.feeding!.tables.ingredient!.columns.find((c) => c.name === "pairs_with")!;
    expect(own.vocabulary).toBe("family.feeding.ingredient");
    await ok(insertRow(v.app, v.settings, { table: "ingredient", values: { name: "Pera", pairs_with: "Mela" } }));
  });

  it("a view whose name matches several tables names none of them: it is left as written", async () => {
    const v = await feeding();
    await ok(createTable(v.app, v.settings, described({ catalog: "family", schema: "pantry", name: "food", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }] })));
    const r = await alterTable(v.app, v.settings, { table: OLD, schema: "babycare" }, { dryRun: true });
    expect(r.schema_references?.filter((x) => x.view === "family.feeding.vw_short")).toEqual([]);
    expect(r.schema_references?.map((x) => x.view ?? x.table ?? x.base)).toContain("family.feeding.vw_food");
  });

  it("a CHECK and a ref_where that read the table through a link no longer refuse the move, and still hold after it", async () => {
    const v = await feeding();
    await ok(addConstraint(v.app, v.settings, { table: "food_introduction", name: "no_grain_first", check: { "food.kind": { ne: "grain" } } }));
    const { alterColumn } = await import("../src/core/engine");
    await ok(alterColumn(v.app, v.settings, { table: "recipe", name: "ingredients", changes: { ref_where: { kind: { in: ["grain", "fruit"] } } } }));
    const r = await alterTable(v.app, v.settings, { table: OLD, schema: "babycare", name: "ingredient" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(await violationsOf(v, REFERRING)).toEqual(NONE);
    const grain = await insertRow(v.app, v.settings, { table: "food_introduction", values: { name: "First rice", food: "[[Riso]]" } });
    expect([grain.ok, grain.violations[0]?.violations.map((x) => x.constraint)]).toEqual([false, ["no_grain_first"]]);
    const egg = await insertRow(v.app, v.settings, { table: "recipe", values: { name: "Frittata", ingredients: ["[[Uovo]]"] } });
    expect([egg.ok, egg.violations[0]?.violations.map((x) => x.code)]).toEqual([false, ["ref"]]);
  });
});
