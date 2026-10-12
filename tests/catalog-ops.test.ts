import { describe, expect, it } from "vitest";
import { addConstraint, cloneTable, createView, dropConstraint, dropView } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { alterTable, checkTable, insertRow, mergeRows, select, updateRows } from "../src/core/rows";
import { createDbVault, type DbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);

async function moodVault(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome", default_catalog: "personal", history: true }, async () => {});
  await createTable(v.app, v.settings, described({
    schema: "metrics",
    name: "mood",
    timeColumn: "occurred_at",
    columns: [
      { name: "key", type: "string", identity: "filename" },
      { name: "occurred_at", type: "datetime", required: true, dense: true },
      { name: "day", type: "date", generated: "date(occurred_at)" },
      { name: "value", type: "integer", dense: true },
      { name: "logged_at", type: "datetime", default: "{now}" },
    ],
  }));
  return v;
}

const P = "Datanotes/personal/metrics/mood";

describe("column rules", () => {
  it("generated, identity and {now} columns are computed on every write", async () => {
    const v = await moodVault();
    const r = await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T23:30", value: 3 } }, { now: new Date("2026-09-27T06:00:00Z") });
    expect(r.ok).toBe(true);
    expect(fm(v, `${P}/2026-09-26T2330.md`)).toMatchObject({
      key: "2026-09-26T2330",
      day: "2026-09-26",
      logged_at: "2026-09-27T08:00:00+02:00",
    });
    await updateRows(v.app, v.settings, { table: "mood", set: { occurred_at: "2026-09-28T07:00" } });
    // the file follows its time column; the identity column follows the file
    expect(v.exists(`${P}/2026-09-26T2330.md`)).toBe(false);
    expect(fm(v, `${P}/2026-09-28T0700.md`)).toMatchObject({ day: "2026-09-28", key: "2026-09-28T0700" });
    await updateRows(v.app, v.settings, { table: "mood", set: { occurred_at: "2026-09-26T23:30" } });
    await expect(insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T10:00", day: "x" } })).rejects.toThrow(/generated/);
    await expect(updateRows(v.app, v.settings, { table: "mood", set: { key: "x" } })).rejects.toThrow(/generated/);
    v.write(`${P}/2026-09-26T2330.md`, v.read(`${P}/2026-09-26T2330.md`).replace("day: 2026-09-26", "day: 2020-01-01"));
    const check = await checkTable(v.app, v.settings, { table: "mood" });
    expect(check.violations[0]!.violations.map((x) => [x.column, x.code])).toEqual([["day", "generated"]]);
  });
});

describe("CHECK constraints", () => {
  it("are refused while rows violate them, then enforced on writes", async () => {
    const v = await moodVault();
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 9 } });
    const refused = await addConstraint(v.app, v.settings, { table: "mood", name: "value_range", check: { value: { gte: 1, lte: 5 } } });
    expect(refused.ok).toBe(false);
    expect(refused.conflicts.map((c) => c.message)).toEqual(["violates CHECK value_range"]);
    await updateRows(v.app, v.settings, { table: "mood", set: { value: 4 } });
    expect((await addConstraint(v.app, v.settings, { table: "mood", name: "value_range", check: { value: { gte: 1, lte: 5 } } })).ok).toBe(true);
    const bad = await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T10:00", value: 7 } });
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]!.violations.map((x) => [x.constraint, x.code])).toEqual([["value_range", "check"]]);
    // an empty value passes, like SQL
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T11:00" } })).ok).toBe(true);
    await expect(addConstraint(v.app, v.settings, { table: "mood", name: "x", check: { nope: 1 } })).rejects.toThrow(/unknown column/);
    expect((await dropConstraint(v.app, v.settings, { table: "mood", name: "value_range" })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T12:00", value: 7 } })).ok).toBe(true);
  });

  it("check existing rows with the same rule as writes, logical keys included", async () => {
    const v = await moodVault();
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 9 } });
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T10:00", value: 3 } });
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T11:00" } });
    const checks = {
      top_or: { or: [{ value: { exists: false } }, { value: { lte: 5 } }] },
      top_not: { not: { value: { gt: 5 } } },
      top_and: { and: [{ occurred_at: { exists: true } }, { or: [{ value: { exists: false } }, { value: { lte: 5 } }] }] },
    };
    for (const [name, check] of Object.entries(checks)) {
      const refused = await addConstraint(v.app, v.settings, { table: "mood", name, check });
      expect(refused.ok, name).toBe(false);
      expect(refused.conflicts.map((c) => [c.path, c.message])).toEqual([[`${P}/2026-09-26T0900.md`, `violates CHECK ${name}`]]);
    }
    // nested parts get no empty-value skip: the row without a value fails `exists: true`, here and on writes
    const nested = { or: [{ value: { exists: true } }, { occurred_at: { lt: "2000-01-01" } }] };
    const refused = await addConstraint(v.app, v.settings, { table: "mood", name: "has_value", check: nested });
    expect(refused.conflicts.map((c) => c.path)).toEqual([`${P}/2026-09-26T1100.md`]);
    await updateRows(v.app, v.settings, { table: "mood", where: { value: 9 }, set: { value: 4 } });
    for (const [name, check] of Object.entries(checks)) {
      expect((await addConstraint(v.app, v.settings, { table: "mood", name, check })).ok, name).toBe(true);
    }
    const bad = await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T12:00", value: 7 } });
    expect(bad.violations[0]!.violations.map((x) => x.constraint)).toEqual(["top_or", "top_not", "top_and"]);
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T13:00" } })).ok).toBe(true);
  });
});

describe("merge_rows", () => {
  it("updates matched rows and inserts the others in one operation", async () => {
    const v = await moodVault();
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    const r = await mergeRows(v.app, v.settings, {
      table: "mood",
      on: ["occurred_at"],
      rows: [
        { occurred_at: "2026-09-26T09:00", value: 4 },
        { occurred_at: "2026-09-27T09:00", value: 1 },
        { occurred_at: "2026-09-27T09:00:00+02:00", value: 5 },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.conflicts[0]!.message).toMatch(/repeats key/);
    const ok = await mergeRows(v.app, v.settings, {
      table: "mood",
      on: ["occurred_at"],
      rows: [
        { occurred_at: "2026-09-26T09:00", value: 4 },
        { occurred_at: "2026-09-27T09:00", value: 1 },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.planned_creates).toEqual([`${P}/2026-09-27T0900.md`]);
    expect(ok.planned_edits.map((p) => p.path)).toEqual([`${P}/2026-09-26T0900.md`]);
    expect((await select(v.app, v.settings, { table: "mood", columns: ["value"] })).rows.map((x) => x.value)).toEqual([4, 1]);
    const ignore = await mergeRows(v.app, v.settings, { table: "mood", on: ["occurred_at"], rows: [{ occurred_at: "2026-09-26T09:00", value: 5 }], whenMatched: "ignore" });
    expect([ignore.ok, ignore.notes_changed]).toEqual([true, 0]);
  });
});

describe("views and information_schema", () => {
  it("stores a view in metastore.yaml and selects through it", async () => {
    const v = await moodVault();
    for (const [t, value] of [["09", 1], ["10", 4], ["11", 2]] as const) {
      await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: `2026-09-26T${t}:00`, value } });
    }
    const c = await createView(v.app, v.settings, { schema: "metrics", name: "low_mood", description: "Low days", query: { table: "mood", where: { value: { lte: 2 } }, columns: ["occurred_at", "value"] } });
    expect(c.ok).toBe(true);
    expect(v.read(METASTORE)).toContain("low_mood");
    const r = await select(v.app, v.settings, { table: "low_mood" });
    expect([r.view, r.total, r.rows.map((x) => x.value)]).toEqual(["personal.metrics.low_mood", 2, [1, 2]]);
    const narrowed = await select(v.app, v.settings, { table: "metrics.low_mood", where: { value: { gte: 2 } } });
    expect(narrowed.rows.map((x) => x.value)).toEqual([2]);
    await expect(createView(v.app, v.settings, { name: "bad", query: { table: "nope" } })).rejects.toThrow(/not found/i);
    const dup = await createView(v.app, v.settings, { schema: "metrics", name: "mood", query: { table: "mood" } });
    expect(dup.ok).toBe(false);

    const tables = await select(v.app, v.settings, { table: "system.information_schema.tables", columns: ["full_name", "table_type", "row_count"] });
    expect(tables.rows.map((x) => [x.full_name, x.table_type, x.row_count])).toEqual([
      ["personal.metrics.mood", "TABLE", 3],
      ["personal.metrics.low_mood", "VIEW", null],
    ]);
    const cols = await select(v.app, v.settings, { table: "information_schema.columns", where: { column_name: "day" } });
    expect(cols.rows[0]).toMatchObject({ data_type: "date", generation_expression: "date(occurred_at)", is_nullable: "YES" });
    const cats = await select(v.app, v.settings, { table: "information_schema.catalogs" });
    expect(cats.rows.map((x) => [x.catalog_name, x.is_default])).toEqual([["personal", true]]);
    // a view lives only in metastore.yaml: no note is written for it
    expect(v.exists("Datanotes/personal/metrics/low_mood.md")).toBe(false);
    await createView(v.app, v.settings, { schema: "metrics", name: "low_mood", description: "Low days", aliases: ["feeling minor"], replace: true, query: { table: "mood", where: { value: { lte: 2 } } } });
    expect(v.read(METASTORE)).toContain("Low days");
    // a note of the same name in the schema folder is left alone
    v.write("Datanotes/personal/metrics/mine.md", "# my note\n");
    expect((await createView(v.app, v.settings, { schema: "metrics", name: "mine", query: { table: "mood" } })).ok).toBe(true);
    expect(v.read("Datanotes/personal/metrics/mine.md")).toBe("# my note\n");
    expect((await dropView(v.app, v.settings, { view: "low_mood" })).ok).toBe(true);
    await expect(select(v.app, v.settings, { table: "low_mood" })).rejects.toThrow(/not found/i);
    expect(v.exists("Datanotes/personal/metrics/mine.md")).toBe(true);
  });
});

describe("clone_table", () => {
  it("deep-clones rows (optionally as of a version) or only the definition", async () => {
    const v = await moodVault();
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T10:00", value: 3 } });
    const deep = await cloneTable(v.app, v.settings, { source: "mood", target: "agent.sandbox.mood" });
    expect(deep.ok).toBe(true);
    expect(deep.planned_creates).toEqual([
      "Datanotes/agent/sandbox/mood/2026-09-26T0900.md",
      "Datanotes/agent/sandbox/mood/2026-09-26T1000.md",
    ]);
    expect(fm(v, "Datanotes/agent/sandbox/mood/2026-09-26T0900.md")).toMatchObject({ table: "agent.sandbox.mood", value: 2, key: "2026-09-26T0900" });
    expect((await select(v.app, v.settings, { table: "agent.sandbox.mood" })).total).toBe(2);
    const past = await cloneTable(v.app, v.settings, { source: "personal.metrics.mood", target: "mood_v1", version: 1 });
    expect(past.planned_creates).toEqual(["Datanotes/personal/metrics/mood_v1/2026-09-26T0900.md"]);
    const like = await cloneTable(v.app, v.settings, { source: "personal.metrics.mood", target: "mood_empty", shallow: true });
    expect([like.ok, like.planned_creates]).toEqual([true, []]);
    expect((await select(v.app, v.settings, { table: "mood_empty" })).total).toBe(0);
    const again = await cloneTable(v.app, v.settings, { source: "personal.metrics.mood", target: "mood_empty" });
    expect(again.ok).toBe(false);
  });

  it("deep-clones a table with its own history setting (properties.history is not a row option)", async () => {
    const v = await moodVault();
    expect((await alterTable(v.app, v.settings, { table: "mood", history: true })).ok).toBe(true);
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    const copy = await cloneTable(v.app, v.settings, { source: "mood", target: "mood_copy" });
    expect([copy.ok, copy.planned_creates]).toEqual([true, ["Datanotes/personal/metrics/mood_copy/2026-09-26T0900.md"]]);
    const past = await cloneTable(v.app, v.settings, { source: "mood", target: "mood_then", version: 2 });
    expect(past.ok).toBe(true);
  });
});
