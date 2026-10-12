import { describe, expect, it } from "vitest";
import type { ColumnSpec, TableDefinition } from "../src/core/types-table";
import {
  isEmptyValue,
  isValidDate,
  isValidDatetime,
  parseWikilink,
  validateRow,
  validateValue,
} from "../src/core/validate";
import { METASTORE } from "./helpers/db-vault";

function col(partial: Partial<ColumnSpec> & Pick<ColumnSpec, "name" | "type">): ColumnSpec {
  return { required: false, aliases: [], ...partial };
}

describe("helpers", () => {
  it("isEmptyValue", () => {
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue("")).toBe(true);
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(["a"])).toBe(false);
  });

  it("parseWikilink", () => {
    expect(parseWikilink("[[Alice]]")).toBe("Alice");
    expect(parseWikilink("[[Kin/Alice|G]]")).toBe("Kin/Alice");
    expect(parseWikilink(" [[Note#Heading]] ")).toBe("Note");
    expect(parseWikilink("Alice")).toBeNull();
    expect(parseWikilink(3)).toBeNull();
  });

  it("isValidDate / isValidDatetime", () => {
    expect(isValidDate("2026-09-25")).toBe(true);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-9-25")).toBe(false);
    expect(isValidDate(20260925)).toBe(false);
    expect(isValidDatetime("2026-09-25T22:30")).toBe(true);
    expect(isValidDatetime("2026-09-25T22:30:15")).toBe(true);
    expect(isValidDatetime("2026-09-25T22:30:15.123+02:00")).toBe(true);
    expect(isValidDatetime("2026-09-25T22:30Z")).toBe(true);
    expect(isValidDatetime("2026-09-25")).toBe(false);
    expect(isValidDatetime("2026-02-30T10:00")).toBe(false);
    expect(isValidDatetime("2026-09-25T25:99")).toBe(false);
    expect(isValidDatetime(null)).toBe(false);
  });
});

describe("validateValue", () => {
  it.each([
    [col({ name: "s", type: "string" }), "x", 0],
    [col({ name: "s", type: "string" }), 3, 1],
    [col({ name: "b", type: "boolean" }), true, 0],
    [col({ name: "b", type: "boolean" }), "true", 1],
    [col({ name: "d", type: "date" }), "2026-09-25", 0],
    [col({ name: "d", type: "date" }), "yesterday", 1],
    [col({ name: "t", type: "datetime" }), "2026-09-25T22:30", 0],
    [col({ name: "t", type: "datetime" }), "2026-09-25", 1],
    [col({ name: "e", type: "enum", values: ["a", "1"] }), "a", 0],
    [col({ name: "e", type: "enum", values: ["a", "1"] }), 1, 0],
    [col({ name: "e", type: "enum", values: ["a"] }), "b", 1],
    [col({ name: "e", type: "enum", values: ["a"] }), true, 1],
    [col({ name: "e", type: "enum" }), "a", 1],
  ])("%j with %j → %i violations", (spec, value, n) => {
    expect(validateValue(spec, value)).toHaveLength(n);
  });

  it("numbers: type, integer, min, max, step", () => {
    const n = col({ name: "n", type: "number", min: 0, max: 10, step: 0.5 });
    expect(validateValue(n, 2.5)).toEqual([]);
    expect(validateValue(n, "2").map((v) => v.code)).toEqual(["type"]);
    expect(validateValue(n, Number.NaN).map((v) => v.code)).toEqual(["type"]);
    expect(validateValue(n, -1).map((v) => v.code)).toEqual(["min"]);
    expect(validateValue(n, 11).map((v) => v.code)).toEqual(["max"]);
    expect(validateValue(n, 2.3).map((v) => v.code)).toEqual(["step"]);
    const i = col({ name: "i", type: "integer", step: 2 });
    expect(validateValue(i, 4)).toEqual([]);
    expect(validateValue(i, 3).map((v) => v.code)).toEqual(["step"]);
    expect(validateValue(i, 1.5).map((v) => v.code)).toEqual(["type"]);
  });

  it("links: syntax, resolution, ref table", () => {
    const l = col({ name: "p", type: "link", ref: "person" });
    expect(validateValue(l, "Alice").map((v) => v.code)).toEqual(["type"]);
    expect(validateValue(l, "[[Alice]]")).toEqual([]);
    const ctx = {
      resolveLink: (p: string) => (p === "Alice" ? "People/Alice.md" : p === "Household" ? "Household.md" : null),
      tableOfPath: (p: string) => (p === "People/Alice.md" ? "person" : null),
    };
    expect(validateValue(l, "[[Alice]]", ctx)).toEqual([]);
    expect(validateValue(l, "[[Nobody]]", ctx).map((v) => v.code)).toEqual(["broken_link"]);
    expect(validateValue(l, "[[Household]]", ctx).map((v) => v.code)).toEqual(["ref"]);
    const free = col({ name: "n", type: "link" });
    expect(validateValue(free, "[[Household]]", ctx)).toEqual([]);
    expect(validateValue(free, "[[Household]]", { resolveLink: ctx.resolveLink })).toEqual([]);
  });

  it("lists validate each item with an indexed column name", () => {
    const l = col({ name: "people", type: "list", items: "link" });
    expect(validateValue(l, ["[[A]]", "[[B]]"])).toEqual([]);
    const bad = validateValue(l, ["[[A]]", "B"]);
    expect(bad).toHaveLength(1);
    expect([bad[0]!.column, bad[0]!.index]).toEqual(["people", 1]);
    expect(validateValue(l, "[[A]]").map((v) => v.code)).toEqual(["type"]);
    const defaultItems = col({ name: "tags", type: "list" });
    expect(validateValue(defaultItems, ["a", 2]).map((v) => [v.column, v.index])).toEqual([["tags", 1]]);
  });
});

describe("validateRow", () => {
  const table: TableDefinition = {
    schemaPath: `${METASTORE}#main.public.log`,
    name: "log",
    schema: "public",
    catalog: "main",
    layout: { folder: "Datanotes/main/public/log", inDatabase: true, rowPath: "Datanotes/main/public/log", archive: "Datanotes/main/public/log/_archive" },
    options: {},
    columns: [
      { ...col({ name: "kind", type: "enum", values: ["alcohol"], required: true }), dense: true },
      { ...col({ name: "metric_units", type: "number", min: 0 }), dense: false },
    ],
    untypedFields: ["description"],
  };
  const opts = { tableKey: "table" };
  it("accepts a valid row, sparse columns may be absent, extra keys allowed", () => {
    expect(
      validateRow(
        table,
        [
          ["kind", "alcohol"],
          ["created", "x"],
        ],
        { ...opts, extraAllowedKeys: ["created"] },
      ),
    ).toEqual([]);
    expect(
      validateRow(table, [["kind", "alcohol"], ["mystery", 1]], { ...opts, reportUnknown: false }),
    ).toEqual([]);
  });
});
