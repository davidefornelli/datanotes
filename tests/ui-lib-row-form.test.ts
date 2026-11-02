import { describe, expect, it } from "vitest";
import { buildExpect, diffRow, insertValues, parseValue, rawOf, readOnlyColumn, splitFrontMatter, type ColumnInfo } from "../src/ui/lib/row-form";

const col = (name: string, type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({ name, type, required: false, ...extra });

describe("readOnlyColumn", () => {
  it("is true for generated and identity columns", () => {
    expect(readOnlyColumn(col("id", "string", { identity: "uuid" }))).toBe(true);
    expect(readOnlyColumn(col("total", "number", { generated: "a + b" }))).toBe(true);
    expect(readOnlyColumn(col("title", "string"))).toBe(false);
  });
});

describe("rawOf", () => {
  it("shows each type as its input does", () => {
    expect(rawOf(col("b", "boolean"), true)).toBe(true);
    expect(rawOf(col("b", "boolean"), false)).toBe(false);
    expect(rawOf(col("b", "boolean"), "yes")).toBeNull();
    expect(rawOf(col("b", "boolean"), undefined)).toBeNull();
    expect(rawOf(col("l", "list"), undefined)).toEqual([]);
    expect(rawOf(col("l", "list"), null)).toEqual([]);
    expect(rawOf(col("l", "list"), ["[[A]]", 2, { x: 1 }, null])).toEqual(["[[A]]", "2", '{"x":1}', ""]);
    expect(rawOf(col("l", "list"), "one")).toEqual(["one"]);
    expect(rawOf(col("j", "json"), { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(rawOf(col("j", "json"), null)).toBe("");
    expect(rawOf(col("j", "json"), undefined)).toBe("");
    expect(rawOf(col("s", "string"), "x")).toBe("x");
    expect(rawOf(col("n", "number"), 12)).toBe("12");
    expect(rawOf(col("s", "string"), null)).toBe("");
    expect(rawOf(col("s", "string"), { a: 1 })).toBe('{"a":1}');
    expect(rawOf(col("s", "string"), true)).toBe("true");
  });
});

describe("parseValue", () => {
  it("parses text and enums, empty when blank", () => {
    expect(parseValue(col("s", "string"), "a b")).toEqual({ value: "a b", empty: false });
    expect(parseValue(col("s", "string"), "")).toEqual({ empty: true });
    expect(parseValue(col("s", "string"), null)).toEqual({ empty: true });
    expect(parseValue(col("e", "enum"), "todo")).toEqual({ value: "todo", empty: false });
    expect(parseValue(col("x", "mystery"), " raw ")).toEqual({ value: " raw ", empty: false });
    expect(parseValue(col("s", "string"), ["a", "b"])).toEqual({ value: "a, b", empty: false });
  });

  it("parses whole numbers and numbers", () => {
    expect(parseValue(col("i", "integer"), " -12 ")).toEqual({ value: -12, empty: false });
    expect(parseValue(col("i", "integer"), "1.5")).toEqual({ empty: false, error: "must be a whole number" });
    expect(parseValue(col("n", "number"), "2.5")).toEqual({ value: 2.5, empty: false });
    expect(parseValue(col("n", "number"), "abc")).toEqual({ empty: false, error: "must be a number" });
    expect(parseValue(col("n", "number"), "  ")).toEqual({ empty: true });
  });

  it("checks the form of dates and date-times", () => {
    expect(parseValue(col("d", "date"), "2026-11-01")).toEqual({ value: "2026-11-01", empty: false });
    expect(parseValue(col("d", "date"), "1/11/2026")).toEqual({ empty: false, error: "use YYYY-MM-DD" });
    expect(parseValue(col("t", "datetime"), "2026-11-01T09:30")).toEqual({ value: "2026-11-01T09:30", empty: false });
    expect(parseValue(col("t", "datetime"), "soon")).toEqual({ empty: false, error: "use an ISO date-time such as 2026-11-01T09:30" });
  });

  it("takes booleans from the tri-state select or as text", () => {
    expect(parseValue(col("b", "boolean"), true)).toEqual({ value: true, empty: false });
    expect(parseValue(col("b", "boolean"), null)).toEqual({ empty: true });
    expect(parseValue(col("b", "boolean"), "false")).toEqual({ value: false, empty: false });
    expect(parseValue(col("b", "boolean"), "maybe")).toEqual({ empty: false, error: "must be true or false" });
  });

  it("adds the brackets a link lacks", () => {
    expect(parseValue(col("l", "link"), "Design system")).toEqual({ value: "[[Design system]]", empty: false });
    expect(parseValue(col("l", "link"), "[[Design system]]")).toEqual({ value: "[[Design system]]", empty: false });
  });

  it("parses JSON", () => {
    expect(parseValue(col("j", "json"), '{"a": [1]}')).toEqual({ value: { a: [1] }, empty: false });
    expect(parseValue(col("j", "json"), "{a")).toEqual({ empty: false, error: "not valid JSON" });
  });

  it("parses each item of a list by its items type", () => {
    expect(parseValue(col("m", "list", { items: "link" }), ["Ada Lovelace", "[[Alan Turing]]", " "])).toEqual({ value: ["[[Ada Lovelace]]", "[[Alan Turing]]"], empty: false });
    expect(parseValue(col("m", "list", { items: "integer" }), ["1", "x"])).toEqual({ empty: false, error: "item 2: must be a whole number" });
    expect(parseValue(col("m", "list"), [])).toEqual({ empty: true });
    expect(parseValue(col("m", "list"), "one")).toEqual({ value: ["one"], empty: false });
    expect(parseValue(col("m", "list"), "")).toEqual({ empty: true });
  });
});

const cols: ColumnInfo[] = [
  col("id", "string", { identity: "uuid" }),
  col("title", "string", { required: true }),
  col("estimate_h", "number"),
  col("due", "date"),
  col("members", "list", { items: "link" }),
  col("meta", "json"),
  col("done_on", "date"),
];
const original = { id: "x", title: "T", estimate_h: 12, due: "2026-10-15", members: ["[[A]]"], meta: { a: 1 }, bad: 1 };

describe("diffRow", () => {
  it("sets what changed, unsets what was emptied, skips the rest", () => {
    const raws = { id: "other", title: "T", estimate_h: "10", due: "", members: ["[[A]]", "B"], done_on: "", meta: rawOf(cols[5]!, original.meta) };
    expect(diffRow(cols, original, raws)).toEqual({
      set: { estimate_h: 10, members: ["[[A]]", "[[B]]"] },
      unset: ["due"],
      changed: ["estimate_h", "due", "members"],
      errors: {},
    });
  });

  it("does not send a value that parses to the same", () => {
    expect(diffRow(cols, original, { estimate_h: "12.0" })).toEqual({ set: {}, unset: [], changed: [], errors: {} });
  });

  it("reports inputs that do not parse, and leaves untouched ones alone", () => {
    expect(diffRow(cols, { ...original, due: "soon" }, { due: "soon", estimate_h: "many", meta: "{" }).errors).toEqual({
      estimate_h: "must be a number",
      meta: "not valid JSON",
    });
  });
});

describe("buildExpect", () => {
  it("expects each changed column as read, a missing one absent, json skipped", () => {
    expect(buildExpect(cols, { ...original, done_on: null }, ["estimate_h", "members", "done_on", "meta", "nothing"])).toEqual({
      estimate_h: 12,
      members: ["[[A]]"],
      done_on: { exists: false },
      nothing: { exists: false },
    });
  });
});

describe("insertValues", () => {
  it("sends the inputs given, parsed, and no read-only or empty one", () => {
    expect(insertValues(cols, { id: "x", title: "New", estimate_h: "3", due: "", members: ["Ada"], meta: "[" })).toEqual({
      values: { title: "New", estimate_h: 3, members: ["[[Ada]]"] },
      errors: { meta: "not valid JSON" },
    });
  });
});

describe("splitFrontMatter", () => {
  it("splits at the front matter", () => {
    expect(splitFrontMatter("---\na: 1\nb: 2\n---\n# Body\n")).toEqual({ frontMatter: "a: 1\nb: 2", body: "# Body\n" });
  });
  it("is all body without front matter", () => {
    expect(splitFrontMatter("# Title\n---\nx")).toEqual({ frontMatter: "", body: "# Title\n---\nx" });
    expect(splitFrontMatter("---\nnever closed")).toEqual({ frontMatter: "", body: "---\nnever closed" });
  });
  it("handles CRLF, an empty front matter and a closing line at the end", () => {
    expect(splitFrontMatter("---\r\na: 1\r\n---\r\nbody\r\n")).toEqual({ frontMatter: "a: 1", body: "body\r\n" });
    expect(splitFrontMatter("---\n---\nbody")).toEqual({ frontMatter: "", body: "body" });
    expect(splitFrontMatter("---\na: 1\n---")).toEqual({ frontMatter: "a: 1", body: "" });
  });
  it("keeps a --- of the body in the body", () => {
    expect(splitFrontMatter("---\na: 1\n---\nintro\n---\nmore\n")).toEqual({ frontMatter: "a: 1", body: "intro\n---\nmore\n" });
  });
});
