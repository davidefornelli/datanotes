import { describe, expect, it } from "vitest";
import {
  compileExpr,
  computeAggregate,
  groupDisplay,
  joinRows,
  keysOf,
  parseAggregates,
  QueryInputError,
  type QueryRow,
} from "../src/core/query";
import { INDEX_RETRY } from "../src/core/engine";
import { select } from "../src/core/rows";
import { createDbVault, METASTORE, withTables } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const row = (path: string, values: Record<string, unknown>): QueryRow => ({ path, get: (c) => values[c] });
const known = new Set(["occurred_at", "kind", "people", "path"]);

describe("expressions", () => {
  it("columns, path and shifted dates", () => {
    const r = row("a.md", { occurred_at: "2026-09-30T22:30", kind: "alcohol", people: ["2026-01-31"] });
    expect(compileExpr("kind", known, new Map()).eval(r)).toBe("alcohol");
    expect(compileExpr("path", known, new Map()).eval(r)).toBe("a.md");
    expect(compileExpr("date(occurred_at)", known, new Map()).eval(r)).toBe("2026-09-30");
    expect(compileExpr("date(occurred_at)+1", known, new Map()).eval(r)).toBe("2026-10-01");
    expect(compileExpr(" date( occurred_at ) - 30 ", known, new Map()).eval(r)).toBe("2026-08-31");
    expect(compileExpr("date(people)+1", known, new Map()).eval(r)).toEqual(["2026-02-01"]);
    expect(compileExpr("date(kind)", known, new Map()).eval(r)).toBeNull();
    expect(compileExpr("date(kind)", known, new Map()).eval(row("b", { kind: 3 }))).toBeNull();
    expect(() => compileExpr("date(zzz)", known, new Map())).toThrow(QueryInputError);
    expect(() => compileExpr("zzz", known, new Map())).toThrow(/unknown column or expression/);
  });

  it("keysOf normalizes links, lists and empties", () => {
    expect(keysOf("[[People/Alice|G]]")).toEqual(["link:alice"]);
    expect(keysOf(["[[Alice.md]]", null, "", "x", 3])).toEqual(["link:alice", '"x"', "3"]);
    expect(keysOf(undefined)).toEqual([]);
  });
});

describe("joinRows", () => {
  it("inner and left joins, list keys and deduplication", () => {
    const left = [
      row("l1", { d: "2026-09-25", p: ["[[A]]", "[[B]]"] }),
      row("l2", { d: "2026-09-27", p: [] }),
    ];
    const right = [row("r1", { d: "2026-09-25", who: "[[A]]" }), row("r2", { d: "2026-09-25", who: "[[B]]" })];
    const k = new Set(["d", "p", "who"]);
    const inner = joinRows(left, compileExpr("d", k, new Map()), { rows: right, on: compileExpr("d", k, new Map()), type: "inner" });
    expect(inner.map((j) => [j.row.path, j.matches.map((m) => m.path)])).toEqual([["l1", ["r1", "r2"]]]);
    const leftJ = joinRows(left, compileExpr("p", k, new Map()), { rows: right, on: compileExpr("who", k, new Map()), type: "left" });
    expect(leftJ.map((j) => [j.row.path, j.matches.map((m) => m.path)])).toEqual([
      ["l1", ["r1", "r2"]],
      ["l2", []],
    ]);
  });
});

describe("aggregates", () => {
  it("parses specs and computes values", () => {
    expect(parseAggregates(undefined)).toEqual([]);
    expect(parseAggregates({ n: "count", c: "count:kind", s: "sum:meal.kcal" })).toEqual([
      { name: "n", fn: "count" },
      { name: "c", fn: "count", column: "kind" },
      { name: "s", fn: "sum", column: "meal.kcal" },
    ]);
    expect(() => parseAggregates({ x: "median:a" })).toThrow(/must be count/);
    expect(() => parseAggregates({ x: 3 })).toThrow(/must be count/);
    expect(() => parseAggregates({ x: "sum" })).toThrow(/needs a column/);
    expect(computeAggregate("count", [], 4)).toBe(4);
    expect(computeAggregate("sum", [1, 2.5, "x", null], 0)).toBe(3.5);
    expect(computeAggregate("avg", [1, 2], 0)).toBe(1.5);
    expect(computeAggregate("min", [3, 1], 0)).toBe(1);
    expect(computeAggregate("max", [3, 1], 0)).toBe(3);
    expect(computeAggregate("avg", ["x"], 0)).toBeNull();
    expect(groupDisplay(["a", "b"])).toBe("a, b");
    expect(groupDisplay([])).toBeNull();
    expect(groupDisplay(undefined)).toBeNull();
    expect(groupDisplay(3)).toBe(3);
  });
});

const YAML = withTables(`meal:
  options:
    filename: "{timestamp:YYYY-MM-DD[T]HHmm}"
  columns:
    - { name: meal_type, type: enum, values: [lunch, dinner] }
    - { name: timestamp, type: datetime }
    - { name: kcal, type: number, min: 0 }
`);

function dbVault() {
  return createDbVault({
    [METASTORE]: YAML,
    "Daily/a.md": '---\ntable: main.public.log\nkind: alcohol\noccurred_at: 2026-09-24T22:30\nmetric_drinks: 7\npeople:\n  - "[[Alice]]"\n  - "[[Mark]]"\n---\n',
    "Daily/b.md": '---\ntable: main.public.log\nkind: alcohol\noccurred_at: 2026-09-25T23:00\nmetric_drinks: 3\npeople:\n  - "[[Alice]]"\n---\n',
    "Daily/c.md": '---\ntable: main.public.log\nkind: mood\noccurred_at: 2026-09-25T08:00\n---\n',
    "Meals/1.md": '---\ntable: main.public.meal\nmeal_type: lunch\ntimestamp: 2026-09-25T13:00\nkcal: 900\n---\n',
    "Meals/2.md": '---\ntable: main.public.meal\nmeal_type: dinner\ntimestamp: 2026-09-25T20:00\nkcal: 700\n---\n',
    "Meals/3.md": '---\ntable: main.public.meal\nmeal_type: lunch\ntimestamp: 2026-09-26T13:00\nkcal: 500\n---\n',
  });
}

describe("select with join and group_by", () => {
  it("joins alcohol nights to the next day's meals", async () => {
    const v = dbVault();
    const r = await select(v.app, v.settings, {
      table: "log",
      columns: ["occurred_at", "metric_drinks"],
      where: { kind: "alcohol" },
      join: { table: "meal", on: { "date(occurred_at)+1": "date(timestamp)" }, as: "next_day_meals", columns: ["meal_type", "kcal"] },
    });
    expect(r.rows).toEqual([
      {
        path: "Daily/a.md",
        occurred_at: "2026-09-24T22:30",
        metric_drinks: 7,
        next_day_meals: [
          { path: "Meals/1.md", meal_type: "lunch", kcal: 900 },
          { path: "Meals/2.md", meal_type: "dinner", kcal: 700 },
        ],
      },
      { path: "Daily/b.md", occurred_at: "2026-09-25T23:00", metric_drinks: 3, next_day_meals: [{ path: "Meals/3.md", meal_type: "lunch", kcal: 500 }] },
    ]);
    const left = await select(v.app, v.settings, {
      table: "log",
      columns: ["kind"],
      join: { table: "main.public.meal", on: { "date(occurred_at)": "date(timestamp)" }, type: "left", where: { meal_type: "dinner" } },
    });
    expect(left.rows.map((x) => [x.path, (x.meal as unknown[]).length])).toEqual([
      ["Daily/a.md", 0],
      ["Daily/b.md", 1],
      ["Daily/c.md", 1],
    ]);
    const all = await select(v.app, v.settings, { table: "log", columns: ["kind"], where: { kind: "mood" }, join: { table: "meal", on: { "date(occurred_at)": "date(timestamp)" } } });
    expect(Object.keys((all.rows[0]!.meal as Record<string, unknown>[])[0]!)).toEqual(["path", "meal_type", "timestamp", "kcal"]);
  });

  it("groups by day with aggregates, including joined columns", async () => {
    const v = dbVault();
    const r = await select(v.app, v.settings, {
      table: "log",
      where: { kind: "alcohol" },
      join: { table: "meal", on: { "date(occurred_at)+1": "date(timestamp)" } },
      groupBy: "date(occurred_at)",
      aggregates: { nights: "count", drinks: "sum:metric_drinks", next_day_kcal: "sum:meal.kcal", meals: "count:meal.kcal", max_meal: "max:meal.kcal" },
      orderBy: "-drinks",
    });
    expect(r.total).toBe(2);
    expect(r.rows).toEqual([
      { "date(occurred_at)": "2026-09-24", nights: 1, drinks: 7, next_day_kcal: 1600, meals: 2, max_meal: 900 },
      { "date(occurred_at)": "2026-09-25", nights: 1, drinks: 3, next_day_kcal: 500, meals: 1, max_meal: 500 },
    ]);
    const byKind = await select(v.app, v.settings, { table: "log", groupBy: ["kind"], aggregates: { n: "count", avg: "avg:metric_drinks", min: "min:metric_drinks" } });
    expect(byKind.rows).toEqual([
      { kind: "alcohol", n: 2, avg: 5, min: 3 },
      { kind: "mood", n: 1, avg: null, min: null },
    ]);
    // two log rows on the same day match the same meals: joined rows are counted once per group
    const noFanOut = await select(v.app, v.settings, {
      table: "log",
      where: { occurred_at: { gte: "2026-09-25T00:00" } },
      join: { table: "meal", on: { "date(occurred_at)": "date(timestamp)" } },
      groupBy: "date(occurred_at)",
      aggregates: { entries: "count", meals: "count:meal.kcal", kcal: "sum:meal.kcal" },
    });
    expect(noFanOut.rows).toEqual([{ "date(occurred_at)": "2026-09-25", entries: 2, meals: 2, kcal: 1600 }]);
    await expect(select(v.app, v.settings, { table: "log", where: { people: { not_null: true } } })).rejects.toThrow(/unknown operator "not_null"/);
    await expect(select(v.app, v.settings, { table: "log", where: { metric_drinks: { gte: 3, foo: 1 } } })).rejects.toThrow(/unknown operator "foo"/);
    const withPeople = await select(v.app, v.settings, { table: "log", where: { people: { exists: true } } });
    // icontains: case- and accent-insensitive, on text and on list items (links compare by note name)
    expect((await select(v.app, v.settings, { table: "log", where: { people: { icontains: "alic" } } })).total).toBe(2);
    expect((await select(v.app, v.settings, { table: "log", where: { people: { contains: "alic" } } })).total).toBe(0);
    expect((await select(v.app, v.settings, { table: "log", where: { kind: { icontains: "ALCOH" } } })).total).toBe(2);
    expect(withPeople.total).toBe(2);
    const totals = await select(v.app, v.settings, { table: "log", aggregates: { n: "count" }, limit: 1 });
    // a list column counts once per item (UNNEST); an empty list is the null group
    const byPerson = await select(v.app, v.settings, { table: "log", groupBy: "people", aggregates: { n: "count" }, orderBy: "-n" });
    expect(byPerson.rows).toEqual([
      { people: "[[Alice]]", n: 2 },
      { people: "[[Mark]]", n: 1 },
      { people: null, n: 1 },
    ]);
    expect(totals.rows).toEqual([{ n: 3 }]);
  });

  it("rejects bad join and group inputs", async () => {
    const v = dbVault();
    const base = { table: "log" };
    await expect(select(v.app, v.settings, { ...base, join: { table: "meal", on: {} } })).rejects.toThrow(/exactly one/);
    await expect(select(v.app, v.settings, { ...base, join: { table: "meal", on: { kind: 3 as never } } })).rejects.toThrow(/must be strings/);
    await expect(select(v.app, v.settings, { ...base, join: { table: "meal", on: { kind: "meal_type" }, columns: ["zzz"] } })).rejects.toThrow(/join.columns/);
    await expect(select(v.app, v.settings, { ...base, join: { table: "meal", on: { zzz: "meal_type" } } })).rejects.toThrow(QueryInputError);
    await expect(select(v.app, v.settings, { ...base, groupBy: "kind", aggregates: { s: "sum:zzz" } })).rejects.toThrow(/unknown column "zzz"/);
    await expect(select(v.app, v.settings, { ...base, join: { table: "meal", on: { kind: "meal_type" } }, aggregates: { s: "sum:meal.zzz" } })).rejects.toThrow(/unknown column "meal.zzz"/);
    await expect(select(v.app, v.settings, { ...base, aggregates: { s: "sum:other.kcal" } })).rejects.toThrow(/unknown column "other.kcal"/);
    await expect(select(v.app, v.settings, { ...base, groupBy: "kind", orderBy: "path" })).rejects.toThrow(/order_by "path"/);
  });
});
