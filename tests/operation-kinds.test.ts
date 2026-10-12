import { describe, expect, it } from "vitest";
import { OPERATION_KIND, OPERATION_KINDS, OPERATIONS } from "../src/api/catalog";
import { OPERATIONS_DOCS, toolDocs } from "../src/api/guidance";

// The kinds of operation (src/api/catalog.ts): the reference of the docs has a page per kind
// (scripts/gen-docs.mjs), and an operation's docs link names the page of its kind.
describe("operation kinds", () => {
  it("give every operation exactly one kind", () => {
    const names = OPERATIONS.map((o) => o.name);
    expect(names.filter((n) => !Object.prototype.hasOwnProperty.call(OPERATION_KIND, n)), "operations with no kind in OPERATION_KIND").toEqual([]);
    expect(Object.keys(OPERATION_KIND).filter((n) => !names.includes(n)), "kinds of operations that do not exist").toEqual([]);
    expect(Object.keys(OPERATION_KIND)).toHaveLength(new Set(Object.keys(OPERATION_KIND)).size);
  });

  it("are the kinds of the reference, each with operations", () => {
    expect(Object.keys(OPERATION_KINDS)).toEqual(["schema", "rows", "queries", "history", "auxiliary"]);
    for (const k of Object.keys(OPERATION_KINDS)) expect(Object.values(OPERATION_KIND).filter((v) => v === k).length, k).toBeGreaterThan(0);
    expect(new Set(Object.values(OPERATION_KIND))).toEqual(new Set(Object.keys(OPERATION_KINDS)));
  });

  it("name the page of an operation's reference", () => {
    expect(toolDocs("create_table")).toBe("https://datanotes.dev/reference/operations/schema.md#create_table");
    expect(toolDocs("batch")).toBe("https://datanotes.dev/reference/operations/rows.md#batch");
    expect(toolDocs("graph_path")).toBe("https://datanotes.dev/reference/operations/queries.md#graph_path");
    expect(toolDocs("undo_migration")).toBe("https://datanotes.dev/reference/operations/history.md#undo_migration");
    expect(toolDocs("describe_table")).toBe("https://datanotes.dev/reference/operations/auxiliary.md#describe_table");
    expect(toolDocs("toString")).toBe(OPERATIONS_DOCS);
    expect(OPERATIONS_DOCS).toBe("https://datanotes.dev/reference/operations.md");
  });
});
