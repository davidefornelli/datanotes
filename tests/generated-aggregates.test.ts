/**
 * Generated columns that aggregate a json list of objects: `count(feeds)`, `count(feeds, side = "left")`,
 * `count(feeds.left_min)`, `sum(feeds.left_min)`, `avg` / `min` / `max`, with an optional filter.
 * The expression is parsed and checked when the table is defined, computed on every write, reported
 * stale by check_table after a hand edit and fixed by recompute_columns.
 */

import { describe, expect, it } from "vitest";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { AGGREGATE_GUIDANCE, evalGenerated, GeneratedExpressionError, generatedRefs } from "../src/core/generated";
import { docsUrl } from "../src/core/hints";
import { checkTable, insertRow, recomputeColumns, updateRow } from "../src/core/rows";
import { MalformedColumnError } from "../src/core/table-loader";
import { createHandlers, dispatch } from "../src/server/rest";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const PATH = "datanotes/main/public/day/2026-10-24.md";
const row = (values: Record<string, unknown>) => (column: string) => values[column];
const ev = (expr: string, values: Record<string, unknown>) => evalGenerated(expr, row(values), PATH);

/** A day of feedings: three on the left (one without minutes, one from a bottle), one on the right. */
const FEEDS = [
  { side: "left", min: 12, at: "07:10" },
  { side: "right", min: 8 },
  { side: "left", min: 10, bottle: true },
  { side: "left" },
];

describe("generatedRefs: an aggregate reads its json column", () => {
  it.each([
    ["count(feeds)", ["feeds"]],
    [" count( feeds , side=\"left\" ) ", ["feeds"]],
    ["count(feeds.min)", ["feeds"]],
    ["sum(feeds.min, side = 'left')", ["feeds"]],
    ["avg(feeds.min)", ["feeds"]],
    ["min(sleeps.duration_min, nap != true)", ["sleeps"]],
    ["max(sleeps.duration_min, duration_min >= 0.5)", ["sleeps"]],
  ])("%s reads %j", (expr, refs) => {
    expect(generatedRefs(expr)).toEqual(refs);
  });

  /** The error of a malformed aggregate: its class, message and guidance. */
  const refusal = (expr: string) => {
    try {
      generatedRefs(expr);
    } catch (e) {
      const g = e as GeneratedExpressionError;
      return [g.constructor, g.message, g.hint, g.docs];
    }
    throw new Error(`${expr} should be refused`);
  };

  it.each([
    ["count()", `"count()" is not an aggregate: write count(column), count(column, field = value) or sum|avg|min|max(column.field), with an optional filter`],
    ["count(feeds", `"count(feeds" is not an aggregate: write count(column), count(column, field = value) or sum|avg|min|max(column.field), with an optional filter`],
    ["sum(feeds.a.b)", `"sum(feeds.a.b)" is not an aggregate: write count(column), count(column, field = value) or sum|avg|min|max(column.field), with an optional filter`],
    ["sum(feeds)", `"sum(feeds)": sum() needs a field of the items, like sum(feeds.minutes)`],
    ["avg(feeds, side = \"left\")", `"avg(feeds, side = "left")": avg() needs a field of the items, like avg(feeds.minutes)`],
    ["count(feeds, side)", `"count(feeds, side)": the filter "side" must compare a field with a value, like side = "left"`],
    ["count(feeds, side = \"a\"b\")", `"count(feeds, side = "a"b")": the filter value "a"b" is not "text", a number, true or false`],
    ["count(feeds, side = left)", `"count(feeds, side = left)": the filter value left is not "text", a number, true or false`],
    ["count(feeds, side = \"left\" and min > 2)", `"count(feeds, side = "left" and min > 2)": the filter value "left" and min > 2 is not "text", a number, true or false`],
    ["count(feeds, side > \"a\")", `"count(feeds, side > "a")": > compares numbers: the filter value must be a number, like min > 5`],
    ["count(feeds, ok <= true)", `"count(feeds, ok <= true)": <= compares numbers: the filter value must be a number, like min <= 5`],
  ])("refuses %s with the aggregates' hint and docs", (expr, message) => {
    expect(refusal(expr)).toEqual([GeneratedExpressionError, message, AGGREGATE_GUIDANCE.hint, docsUrl("jsonAggregates")]);
  });

  it("the guidance shows every form and the filter grammar", () => {
    expect(AGGREGATE_GUIDANCE.hint).toBe(
      `An aggregate reads a json column holding a list of objects: count(feeds), count(feeds, side = "left"), count(feeds.min) (the items with a min), sum(feeds.min), avg|min|max(feeds.min, side != "right"). A filter compares one field of the item with "text", a number, true or false, using =, !=, <, <=, > or >=.`,
    );
  });

  it("a plain expression that is not an aggregate keeps its own message", () => {
    expect(() => generatedRefs("amount + tip")).toThrow(`"amount + tip" is not a generated expression`);
    expect(generatedRefs("count")).toEqual(["count"]);
  });
});

describe("evalGenerated: count", () => {
  it("counts the items, the items a filter keeps, or the items with a value in a field", () => {
    const r = { feeds: FEEDS };
    expect([
      ev("count(feeds)", r),
      ev("count(feeds, side = \"left\")", r),
      ev("count(feeds, side = 'left')", r),
      ev("count(feeds, side != \"left\")", r),
      ev("count(feeds.min)", r),
      ev("count(feeds.min, side = \"left\")", r),
      ev("count(feeds, bottle = true)", r),
      ev("count(feeds, bottle = false)", r),
      ev("count(feeds, bottle != true)", r),
    ]).toEqual([4, 3, 3, 1, 3, 2, 1, 0, 3]);
  });

  it("compares numbers with = and the four orderings; items without a number never match an ordering", () => {
    const r = { feeds: FEEDS };
    expect(["min = 12", "min != 12", "min > 9", "min >= 10", "min < 10", "min <= 8", "min > -1.5", "side < 1"].map((f) => ev(`count(feeds, ${f})`, r))).toEqual([1, 3, 2, 2, 1, 1, 3, 0]);
  });

  it("= is strict: the number 12 is not the text \"12\", true is not \"true\"", () => {
    const r = { feeds: [{ min: 12, ok: true }, { min: "12", ok: "true" }] };
    expect([ev("count(feeds, min = 12)", r), ev("count(feeds, min = \"12\")", r), ev("count(feeds, ok = true)", r), ev("count(feeds, ok = \"true\")", r)]).toEqual([1, 1, 1, 1]);
  });

  it("a text value may hold quotes and escapes", () => {
    const r = { notes: [{ said: `a "big" one` }, { said: "it's fine" }] };
    expect([ev(String.raw`count(notes, said = "a \"big\" one")`, r), ev(`count(notes, said = "it's fine")`, r)]).toEqual([1, 1]);
  });

  it("an item that is not an object is counted, has no field and matches only !=", () => {
    const r = { feeds: [1, "left", null, ["left"], { side: "left", min: 2 }] };
    expect([ev("count(feeds)", r), ev("count(feeds.side)", r), ev("count(feeds, side = \"left\")", r), ev("count(feeds, side != \"left\")", r)]).toEqual([5, 1, 1, 4]);
  });
});

describe("evalGenerated: sum, avg, min and max of a field", () => {
  it("total, average, smallest and largest of the numbers, items without the field left out", () => {
    const r = { feeds: FEEDS };
    expect(["sum", "avg", "min", "max"].map((fn) => ev(`${fn}(feeds.min)`, r))).toEqual([30, 10, 8, 12]);
    expect(["sum", "avg", "min", "max"].map((fn) => ev(`${fn}(feeds.min, side = "left")`, r))).toEqual([22, 11, 10, 12]);
  });

  it("no number to aggregate: sum is 0, avg, min and max are empty (null)", () => {
    const r = { feeds: FEEDS };
    expect(["sum", "avg", "min", "max", "count"].map((fn) => ev(`${fn}(feeds.min, side = "nope")`, r))).toEqual([0, null, null, null, 0]);
    expect(["sum", "avg", "min", "max"].map((fn) => ev(`${fn}(feeds.min, side = "left")`, { feeds: [{ side: "left" }, { side: "left", min: null }] }))).toEqual([0, null, null, null]);
  });

  it("an empty list, a missing column and null all read as no items", () => {
    for (const r of [{ feeds: [] }, {}, { feeds: null }]) {
      expect(["count(feeds)", "count(feeds.min)", "sum(feeds.min)", "avg(feeds.min)", "min(feeds.min)", "max(feeds.min)"].map((x) => ev(x, r))).toEqual([0, 0, 0, null, null, null]);
    }
  });

  it("a value that is not a list gives empty (null) for every aggregate, never a number", () => {
    for (const feeds of [{ side: "left", min: 12 }, "12 minutes", 12, true]) {
      expect(["count(feeds)", "count(feeds, side = \"left\")", "sum(feeds.min)", "avg(feeds.min)", "min(feeds.min)", "max(feeds.min)"].map((x) => ev(x, { feeds }))).toEqual([null, null, null, null, null, null]);
    }
  });

  it("a field that holds something other than a number makes the result empty (null), not a wrong number", () => {
    for (const bad of ["ten", "10", true, { m: 1 }, [10], Number.POSITIVE_INFINITY, Number.NaN]) {
      const r = { feeds: [{ min: 5 }, { min: bad }] };
      expect(["sum", "avg", "min", "max"].map((fn) => ev(`${fn}(feeds.min)`, r))).toEqual([null, null, null, null]);
      // count only asks whether the field has a value
      expect(ev("count(feeds.min)", r)).toBe(2);
    }
    // the filter leaves the bad item out: the result is a number again
    expect(ev("sum(feeds.min, side = \"left\")", { feeds: [{ side: "left", min: 5 }, { side: "right", min: "ten" }] })).toBe(5);
  });

  it("totals and averages lose the noise of binary fractions (15 significant digits)", () => {
    expect(ev("sum(xs.v)", { xs: [{ v: 0.1 }, { v: 0.2 }] })).toBe(0.3);
    expect(ev("avg(xs.v)", { xs: [{ v: 1 }, { v: 2 }, { v: 2 }] })).toBe(1.66666666666667);
    expect(ev("sum(xs.v)", { xs: [{ v: -2.5 }, { v: 1 }] })).toBe(-1.5);
  });
});

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const DAY = "datanotes/main/public/day";

/** A table of days with the feedings in a json column and their totals. */
const DAY_TABLE = {
  name: "day",
  options: { filename: "{date:YYYY-MM-DD}" },
  columns: [
    { name: "date", type: "date", required: true },
    { name: "feeds", type: "json" },
    { name: "naps", type: "list", items: "json" },
    { name: "feeds_count", type: "integer", generated: "count(feeds)" },
    { name: "left_count", type: "integer", generated: "count(feeds, side = \"left\")" },
    { name: "left_min", type: "integer", generated: "sum(feeds.min, side = \"left\")" },
    { name: "avg_min", type: "number", generated: "avg(feeds.min)" },
    { name: "longest_min", type: "number", generated: "max(feeds.min)" },
    { name: "shortest_min", type: "integer", generated: "min(feeds.min)" },
    { name: "nap_count", type: "number", generated: "count(naps)", dense: true },
  ],
};

async function days(): Promise<DbVault> {
  const v = createDbVault({}, { databaseFolder: "datanotes" });
  const r = await createTable(v.app, v.settings, described(DAY_TABLE));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return v;
}

/** The computed columns of a day's note. */
const totals = (v: DbVault, day: string) => {
  const f = fm(v, `${DAY}/${day}.md`);
  return Object.fromEntries(["feeds_count", "left_count", "left_min", "avg_min", "longest_min", "shortest_min", "nap_count"].map((k) => [k, f[k]]));
};

describe("aggregate columns on writes", () => {
  it("are computed on insert and on every update of the json column", async () => {
    const v = await days();
    const ins = await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-10-24", feeds: FEEDS, naps: [{ start: "13:00" }] } });
    expect(ins.ok, JSON.stringify(ins.violations)).toBe(true);
    expect(totals(v, "2026-10-24")).toEqual({ feeds_count: 4, left_count: 3, left_min: 22, avg_min: 10, longest_min: 12, shortest_min: 8, nap_count: 1 });
    const up = await updateRow(v.app, v.settings, { table: "day", path: `${DAY}/2026-10-24.md`, set: { feeds: [...FEEDS, { side: "left", min: 15 }] } });
    expect(up.ok, JSON.stringify(up.violations)).toBe(true);
    expect(totals(v, "2026-10-24")).toEqual({ feeds_count: 5, left_count: 4, left_min: 37, avg_min: 11.25, longest_min: 15, shortest_min: 8, nap_count: 1 });
  });

  it("a day without feedings counts 0 and totals 0; avg, min and max stay empty", async () => {
    const v = await days();
    expect((await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-10-25" } })).ok).toBe(true);
    expect(totals(v, "2026-10-25")).toEqual({ feeds_count: 0, left_count: 0, left_min: 0, avg_min: undefined, longest_min: undefined, shortest_min: undefined, nap_count: 0 });
  });

  it("an integer column refuses a write whose total is not whole: no rounded number is stored", async () => {
    const v = await days();
    const r = await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-10-26", feeds: [{ side: "left", min: 7.5 }] } });
    expect(r.ok).toBe(false);
    expect(r.violations.flatMap((x) => x.violations.map((y) => [y.column, y.code]))).toEqual([
      ["left_min", "type"],
      ["shortest_min", "type"],
    ]);
  });
});

describe("aggregate columns after a hand edit", () => {
  it("check_table reports the stale totals and recompute_columns fixes them", async () => {
    const v = await days();
    expect((await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-10-24", feeds: FEEDS } })).ok).toBe(true);
    const p = `${DAY}/2026-10-24.md`;
    const before = v.read(p);
    expect(before).toContain("min: 12");
    v.write(p, before.replace("min: 12", "min: 15"));
    const c = await checkTable(v.app, v.settings, { table: "day" });
    expect(c.violations.flatMap((x) => x.violations.map((y) => [x.path, y.column, y.code, y.message]))).toEqual([
      [p, "left_min", "generated", "should be 25 (computed)"],
      [p, "avg_min", "generated", "should be 11 (computed)"],
      [p, "longest_min", "generated", "should be 15 (computed)"],
    ]);
    const r = await recomputeColumns(v.app, v.settings, { table: "day" });
    expect([r.ok, r.planned_edits.map((x) => x.path)]).toEqual([true, [p]]);
    expect(totals(v, "2026-10-24")).toMatchObject({ left_min: 25, avg_min: 11, longest_min: 15 });
    expect((await checkTable(v.app, v.settings, { table: "day" })).violations).toEqual([]);
  });
});

/** The table's definition error: class and message. */
async function defined(columns: Record<string, unknown>[]): Promise<[unknown, string, string | undefined, string | undefined]> {
  const v = createDbVault({});
  try {
    await createTable(v.app, v.settings, described({ name: "day", options: { filename: "{date}" }, columns: [{ name: "date", type: "date", required: true }, ...columns] }));
  } catch (e) {
    const m = e as MalformedColumnError & { hint?: string; docs?: string };
    return [m.constructor, m.message, m.hint, m.docs];
  }
  throw new Error("the table should be refused");
}

describe("aggregate columns are checked when the table is defined", () => {
  it("a malformed aggregate: the expression's message, hint and docs", async () => {
    expect(await defined([{ name: "feeds", type: "json" }, { name: "n", type: "integer", generated: "sum(feeds)" }])).toEqual([
      MalformedColumnError,
      `columns[3]: "sum(feeds)": sum() needs a field of the items, like sum(feeds.minutes)`,
      AGGREGATE_GUIDANCE.hint,
      docsUrl("jsonAggregates"),
    ]);
  });

  it("an unknown column keeps its usual message", async () => {
    expect((await defined([{ name: "n", type: "integer", generated: "count(feeds)" }]))[1]).toBe(`columns[2]: "generated" reads unknown column "feeds"`);
  });

  it.each([
    [{ name: "feeds", type: "string" }, `"feeds" has type string`],
    [{ name: "feeds", type: "list", items: "string" }, `"feeds" is a list of string`],
    [{ name: "feeds", type: "list" }, `"feeds" is a list of string`],
  ])("a column that is not json: %j", async (source, what) => {
    expect(await defined([source, { name: "n", type: "integer", generated: "count(feeds)" }])).toEqual([
      MalformedColumnError,
      `columns[3]: "generated" aggregates "feeds", which is not a json column`,
      `count() reads a json column (type json, or a list of json) holding a list of objects, such as [{side: left, min: 12}]; ${what}. describe_table shows the type of each column.`,
      docsUrl("jsonAggregates"),
    ]);
  });

  it("the row's path is not a json column", async () => {
    expect((await defined([{ name: "n", type: "integer", generated: "count(path)" }]))[2]).toBe(
      `count() reads a json column (type json, or a list of json) holding a list of objects, such as [{side: left, min: 12}]; "path" is the row's path. describe_table shows the type of each column.`,
    );
  });

  it("an untyped field is not a json column either", async () => {
    const v = createDbVault({});
    await expect(
      createTable(v.app, v.settings, described({ name: "day", options: { filename: "{date}" }, fields: { feeds: [] }, columns: [{ name: "date", type: "date", required: true }, { name: "n", type: "integer", generated: "count(feeds)" }] })),
    ).rejects.toMatchObject({
      message: `columns[2]: "generated" aggregates "feeds", which is not a json column`,
      hint: `count() reads a json column (type json, or a list of json) holding a list of objects, such as [{side: left, min: 12}]; "feeds" is an untyped field. describe_table shows the type of each column.`,
    });
  });

  it.each([
    ["count(feeds)", "string", `count() makes a whole number: "n" must be an integer or number column`, `Give "n" type "integer" or "number".`],
    ["sum(feeds.min)", "date", `sum() makes a number: "n" must be a number or integer column`, `Give "n" type "number", or "integer" when the field holds only whole numbers.`],
    ["min(feeds.min)", "string", `min() makes a number: "n" must be a number or integer column`, `Give "n" type "number", or "integer" when the field holds only whole numbers.`],
    ["max(feeds.min)", "boolean", `max() makes a number: "n" must be a number or integer column`, `Give "n" type "number", or "integer" when the field holds only whole numbers.`],
    ["avg(feeds.min)", "integer", `avg() makes a number: "n" must be a number column`, `Give "n" type "number": an average is seldom a whole number.`],
  ])("%s in a %s column", async (expr, type, message, hint) => {
    expect(await defined([{ name: "feeds", type: "json" }, { name: "n", type, generated: expr }])).toEqual([MalformedColumnError, `columns[3]: ${message}`, hint, docsUrl("jsonAggregates")]);
  });

  it("a list of json is a json column too", async () => {
    const v = createDbVault({});
    const r = await createTable(v.app, v.settings, described({ name: "day", options: { filename: "{date}" }, columns: [{ name: "date", type: "date", required: true }, { name: "feeds", type: "list", items: "json" }, { name: "n", type: "integer", generated: "count(feeds)" }] }));
    expect(r.ok).toBe(true);
  });
});

describe("through the HTTP API", () => {
  async function call(v: DbVault, op: string, args: Record<string, unknown>) {
    const handlers = createHandlers(v.app, () => v.settings);
    const req = operationRequest(op, args);
    const route = req.path.slice(ROUTE_PREFIX.length);
    return (await dispatch(route, handlers[route]!, req.body)) as { status: number; json: Record<string, unknown> };
  }

  it("add_column refuses an aggregate of a column that is not json, with its hint and docs", async () => {
    const v = await days();
    const r = await call(v, "add_column", described({ table: "day", column: { name: "dates", type: "integer", generated: "count(date)" } }));
    expect(r).toEqual({
      status: 400,
      json: {
        error: `columns[11]: "generated" aggregates "date", which is not a json column`,
        hint: `count() reads a json column (type json, or a list of json) holding a list of objects, such as [{side: left, min: 12}]; "date" has type date. describe_table shows the type of each column.`,
        docs: docsUrl("jsonAggregates"),
      },
    });
  });

  it("an aggregate added by add_column: check_table reports the rows written before, recompute_columns fills them", async () => {
    const v = await days();
    expect((await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-10-24", feeds: FEEDS } })).ok).toBe(true);
    const r = await call(v, "add_column", described({ table: "day", column: { name: "right_min", type: "integer", generated: "sum(feeds.min, side = \"right\")" } }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const c = await checkTable(v.app, v.settings, { table: "day" });
    expect(c.violations.flatMap((x) => x.violations.map((y) => [y.column, y.message]))).toEqual([["right_min", "should be 8 (computed)"]]);
    expect((await recomputeColumns(v.app, v.settings, { table: "day" })).ok).toBe(true);
    expect(fm(v, `${DAY}/2026-10-24.md`).right_min).toBe(8);
  });
});
