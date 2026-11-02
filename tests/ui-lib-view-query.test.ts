/**
 * A view's query as select_rows arguments, and qualified names (src/ui/lib/view-query.ts).
 */

import { describe, expect, it } from "vitest";
import { PREVIEW_KEYS, previewArgs, splitQualified } from "../src/ui/lib/view-query";

describe("previewArgs", () => {
  it("keeps the select_rows keys and adds a limit", () => {
    expect(previewArgs({ table: "t", columns: ["a"], where: { a: 1 }, order_by: "a", other: 1, expand: undefined })).toEqual({
      table: "t",
      columns: ["a"],
      where: { a: 1 },
      order_by: "a",
      limit: 20,
    });
    expect(PREVIEW_KEYS).toContain("aggregates");
  });
  it("the query's own limit when smaller", () => {
    expect(previewArgs({ table: "t", limit: 5 })).toEqual({ table: "t", limit: 5 });
    expect(previewArgs({ table: "t", limit: 500 }, 50)).toEqual({ table: "t", limit: 50 });
    expect(previewArgs({ table: "t", limit: "x" })).toEqual({ table: "t", limit: 20 });
  });
  it("null for a union", () => {
    expect(previewArgs({ union: [{ table: "a" }] })).toBeNull();
  });
});

describe("splitQualified", () => {
  it("splits each length", () => {
    expect(splitQualified("work.planning.task")).toEqual({ catalog: "work", schema: "planning", name: "task" });
    expect(splitQualified("planning.task")).toEqual({ catalog: "", schema: "planning", name: "task" });
    expect(splitQualified("task")).toEqual({ catalog: "", schema: "", name: "task" });
  });
});
