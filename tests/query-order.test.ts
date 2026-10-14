/**
 * Filters compiled once and sorts on keys read once per row (select.ts, where.ts) answer exactly
 * as comparing every pair did: the same rows, in the same order (ties keep the rows' order), for
 * every page, whether the rows are sorted in full, picked by a heap or already in order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, loadTable, OperationInputError, type LoadedRow, type LoadedTable } from "../src/core/engine";
import type { TFile } from "../src/core/host";
import { select } from "../src/core/select";
import type { ColumnSpec } from "../src/core/types-table";
import { isEmptyValue } from "../src/core/validate";
import { comparable, compileWhere, rowGetter } from "../src/core/where";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const DIR = "Datanotes/main/public/item";

/** A deterministic sequence of numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** The sort as select did it before keys: every comparison reads both values again. */
function compareValues(a: unknown, b: unknown): number {
  const ea = isEmptyValue(a);
  const eb = isEmptyValue(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

let v: DbVault;
let all: Record<string, unknown>[];
let specs: Map<string, ColumnSpec>;

beforeAll(async () => {
  v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  await createTable(v.app, v.settings, described({
    schema: "public", name: "item", options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true },
      { name: "n", type: "number" },
      { name: "label", type: "string" },
      { name: "day", type: "date" },
      { name: "when", type: "datetime" },
      { name: "prio", type: "enum", values: ["low", "mid", "high"], ordered: true },
      { name: "tags", type: "list", items: "string" },
      { name: "ref", type: "link" },
    ],
  }));
  const r = random(7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  // few distinct values, so many ties; some values missing or empty; labels mix numbers and words
  for (let i = 0; i < 64; i++) {
    const lines = [`table: main.public.item`, `name: Item ${String(i).padStart(2, "0")}`];
    if (r() > 0.15) lines.push(`n: ${pick([1, 2, 2.5, 10, -3, 0])}`);
    if (r() > 0.15) lines.push(`label: ${pick(["alpha", "Beta", "beta", "10", "9", "école", "Zeta", '""', "7"])}`);
    if (r() > 0.2) lines.push(`day: ${pick(["2026-01-02", "2025-12-31", "2026-01-02", "not a date"])}`);
    if (r() > 0.2) lines.push(`when: ${pick(["2026-01-02T10:00:00+01:00", "2026-01-02T09:00:00Z", "2026-01-01T23:30:00-02:00"])}`);
    if (r() > 0.2) lines.push(`prio: ${pick(["low", "mid", "high", "urgent"])}`);
    if (r() > 0.3) lines.push(`tags: [${pick(["a", "b, c", "", "c"])}]`);
    if (r() > 0.3) lines.push(`ref: "${pick(["[[Alice]]", "[[People/Bob|B]]", "[[alice]]", "plain text"])}"`);
    v.write(`${DIR}/Item ${String(i).padStart(2, "0")}.md`, `---\n${lines.join("\n")}\n---\nBody ${i}.\n`);
  }
  all = (await select(v.app, v.settings, { table: "item", limit: 1000 })).rows;
  specs = new Map((await loadTable(v.app, v.settings, "item")).def.columns.map((c) => [c.name, c]));
});

/** The page the old sort gave: a stable sort of the rows (in path order) comparing every pair. */
function expected(order: string[], offset: number, limit: number): string[] {
  const parsed = order.map((o) => (o.startsWith("-") ? { col: o.slice(1), desc: true } : { col: o, desc: false }));
  const value = (row: Record<string, unknown>, col: string) => (col === "path" ? row.path : col === "file_name" ? String(row.path).split("/").pop()!.replace(/\.md$/, "") : row[col]);
  return [...all]
    .sort((a, b) => {
      for (const o of parsed) {
        const c = compareValues(comparable(specs.get(o.col), value(a, o.col)), comparable(specs.get(o.col), value(b, o.col)));
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    })
    .slice(offset, offset + limit)
    .map((row) => String(row.path));
}

describe("select order_by on keys read once per row", () => {
  const orders = [["n"], ["-n"], ["label"], ["-label", "n"], ["day"], ["-when"], ["prio", "-n"], ["-prio"], ["tags"], ["ref"], ["-ref", "-label"], ["file_name"], ["path"], ["-path"]];
  const pages = [
    { offset: 0, limit: 5 }, // a heap of 5
    { offset: 9, limit: 3 }, // a heap of 12
    { offset: 0, limit: 20 }, // sorted in full (20 is more than a quarter of 64)
    { offset: 40, limit: 100 }, // past the end
    { offset: 0, limit: 0 }, // nothing
    { offset: 63, limit: 1 }, // the last one
  ];
  for (const order of orders) {
    it(`order_by ${order.join(", ")}: every page as the full sort gives it`, async () => {
      for (const { offset, limit } of pages) {
        const r = await select(v.app, v.settings, { table: "item", orderBy: order, offset, limit, columns: ["name"] });
        expect(r.total).toBe(64);
        expect(r.rows.map((x) => x.path), `offset ${offset}, limit ${limit}`).toEqual(expected(order, offset, limit));
      }
    });
  }

  it("rows already in order come back as they are (the default order is the path)", async () => {
    const r = await select(v.app, v.settings, { table: "item", limit: 10, offset: 5 });
    expect(r.rows.map((x) => x.path)).toEqual(all.slice(5, 15).map((x) => x.path));
  });

  it("a union and a group_by order their rows the same way", async () => {
    const u = await select(v.app, v.settings, { table: "item", union: [{ table: "item", where: { n: { gte: 2 } } }, { table: "item", where: { n: { lt: 2 } } }], orderBy: ["-label", "name"], offset: 2, limit: 4, columns: ["name", "label"] });
    const rows = [...all.filter((x) => typeof x.n === "number" && x.n >= 2), ...all.filter((x) => typeof x.n === "number" && x.n < 2)];
    const want = [...rows].sort((a, b) => -compareValues(a.label, b.label) || compareValues(a.name, b.name)).slice(2, 6).map((x) => x.name);
    expect(u.rows.map((x) => x.name)).toEqual(want);
    const g = await select(v.app, v.settings, { table: "item", groupBy: "label", aggregates: { k: "count" }, orderBy: ["-k", "label"], limit: 3, offset: 1 });
    const counts = new Map<unknown, number>();
    for (const x of all) counts.set(x.label ?? null, (counts.get(x.label ?? null) ?? 0) + 1);
    const groups = [...counts].map(([label, k]) => ({ label, k })).sort((a, b) => -compareValues(a.k, b.k) || compareValues(a.label, b.label));
    expect(g.rows).toEqual(groups.slice(1, 4));
  });
});

/** The filter as where.ts tested it before compiling: one operator, one row, every value read again. */
function matchOp(op: string, actual: unknown, expectedValue: unknown, spec: ColumnSpec | undefined): boolean {
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const fold = (x: unknown) => String(x).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (op === "exists") return (expectedValue === false) === isEmptyValue(actual);
  if (op === "icontains") {
    if (expectedValue == null || typeof expectedValue === "object") return false;
    return (Array.isArray(actual) ? actual : [actual]).some((x) => x != null && typeof x !== "object" && fold(comparable(spec, x)).includes(fold(expectedValue)));
  }
  if (op === "contains") {
    if (Array.isArray(actual)) return actual.some((x) => eq(comparable(spec, x), comparable(spec, expectedValue)));
    return typeof actual === "string" && typeof expectedValue === "string" && actual.includes(expectedValue);
  }
  const a = comparable(spec, actual);
  if (op === "in") return (expectedValue as unknown[]).some((e) => eq(a, comparable(spec, e)));
  const e = comparable(spec, expectedValue);
  if (op === "eq") return eq(a, e);
  if (op === "ne") return !eq(a, e);
  if (isEmptyValue(a)) return false;
  const x = a as number | string;
  const y = e as number | string;
  return op === "gt" ? x > y : op === "gte" ? x >= y : op === "lt" ? x < y : x <= y;
}

describe("compiled filters keep their meaning", () => {
  const values: unknown[] = [
    undefined, null, "", [], 0, 1, 2.5, -3, "1", "2.5", "alpha", "Alpha", "école", "ECOLE", true, false,
    ["a"], ["a", "b"], [1, "1"], { k: 1 }, "2026-01-02", "2026-01-02T10:00:00+01:00", "not a date",
    "[[Alice]]", "[[People/Alice|A]]", "[[alice.md]]", "low", "high", "urgent",
  ];
  const ops = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "icontains", "exists"];
  const columns = ["n", "label", "day", "when", "prio", "tags", "ref", "name"];

  it("every operator, on every kind of column, against every kind of value", async () => {
    const t: LoadedTable = await loadTable(v.app, v.settings, "item");
    const get = rowGetter(null, t, v.settings);
    const file = { path: `${DIR}/X.md`, name: "X.md", basename: "X", extension: "md" } as unknown as TFile;
    let checked = 0;
    for (const col of columns) {
      for (const op of ops) {
        for (const want of op === "in" ? [values.slice(0, 8), values.slice(8, 20), values.slice(20)] : op === "exists" ? [true, false] : values) {
          if (want === undefined) continue;
          const pred = compileWhere({ [col]: { [op]: want } }, t, v.settings, get);
          for (const actual of values) {
            const row: LoadedRow = { file, ordered: actual === undefined ? [] : [[col, actual]] };
            expect(pred(row), `${col} ${op} ${JSON.stringify(want)} on ${JSON.stringify(actual)}`).toBe(matchOp(op, actual, want, specs.get(col)));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it("a misuse is refused when a row is tested, as before: `in` without a list, `within` outside select", async () => {
    const t = await loadTable(v.app, v.settings, "item");
    const row: LoadedRow = { file: { path: `${DIR}/X.md` } as TFile, ordered: [["n", 1]] };
    const notList = compileWhere({ n: { in: 1 } }, t, v.settings);
    expect(() => notList(row)).toThrow(new OperationInputError(`"in" expects a list`));
    const within = compileWhere({ ref: { within: "Alice" } }, t, v.settings);
    expect(() => within(row)).toThrow(/"within" is not available here/);
    // nothing tested, nothing refused
    expect([].filter(notList)).toEqual([]);
  });
});
