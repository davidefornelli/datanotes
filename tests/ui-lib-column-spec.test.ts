/**
 * Column specs of the database browser's structure screens (src/ui/lib/column-spec.ts), and their
 * parity with the engine's column attributes and types.
 */

import { describe, expect, it } from "vitest";
import { COLUMN_ATTRS } from "../src/core/table-loader";
import { SCALAR_COLUMN_TYPES } from "../src/core/types-table";
import { COLUMN_TYPES, SPEC_ATTRS, alterChanges, attrsForType, cleanSpec, specFromColumn, specProblems } from "../src/ui/lib/column-spec";

describe("parity with the engine", () => {
  it("SPEC_ATTRS holds every COLUMN_ATTRS member, plus dense", () => {
    for (const a of COLUMN_ATTRS) expect(SPEC_ATTRS).toContain(a);
    expect(SPEC_ATTRS).toContain("dense");
    expect(SPEC_ATTRS.length).toBe(COLUMN_ATTRS.size + 1);
  });
  it("COLUMN_TYPES holds every scalar type, plus list", () => {
    for (const t of SCALAR_COLUMN_TYPES) expect(COLUMN_TYPES).toContain(t);
    expect(COLUMN_TYPES).toContain("list");
    expect(COLUMN_TYPES.length).toBe(SCALAR_COLUMN_TYPES.length + 1);
  });
});

describe("specFromColumn", () => {
  it("keeps the spec attributes and drops empty aliases and other keys", () => {
    expect(
      specFromColumn({ name: "due", type: "date", required: false, aliases: [], description: "d", dense: false, inherited_from: "dated", default: undefined }),
    ).toEqual({ name: "due", type: "date", required: false, description: "d", dense: false });
  });
  it("keeps aliases that are there", () => {
    expect(specFromColumn({ name: "a", aliases: ["b"] })).toEqual({ name: "a", aliases: ["b"] });
  });
});

describe("cleanSpec", () => {
  it("drops empty values and false required / dense", () => {
    expect(
      cleanSpec({ name: "x", a: undefined, b: null, c: "", d: [], e: {}, required: false, dense: false, unique: false, min: 0, values: ["v"], f: { k: 1 } }),
    ).toEqual({ name: "x", unique: false, min: 0, values: ["v"], f: { k: 1 } });
  });
  it("keeps true flags", () => {
    expect(cleanSpec({ required: true, dense: true })).toEqual({ required: true, dense: true });
  });
});

describe("alterChanges", () => {
  const before = { name: "estimate_h", type: "number", required: false, min: 0, max: 80, description: "Hours", dense: false, ref_by: { a: 1, b: 2 } };
  it("is empty for the same spec, keys in any order", () => {
    expect(alterChanges(before, { ...before, ref_by: { b: 2, a: 1 } })).toEqual({});
  });
  it("sends a removed attribute as null, a removed flag as false", () => {
    const { max: _m, ...noMax } = before;
    expect(alterChanges(before, noMax)).toEqual({ max: null });
    expect(alterChanges({ ...before, required: true, dense: true }, before)).toEqual({ required: false, dense: false });
  });
  it("sends changed and new attributes, never the name, never a null description", () => {
    expect(alterChanges(before, { ...before, name: "other", min: 1, step: 0.5, description: "" })).toEqual({ min: 1, step: 0.5 });
    expect(alterChanges({ name: "s", values: ["a", "b"] }, { name: "s", values: ["a", "c"] })).toEqual({ values: ["a", "c"] });
    expect(alterChanges({ name: "s", values: ["a", "b"] }, { name: "s", values: ["a", "b"] })).toEqual({});
  });
});

describe("attrsForType", () => {
  it("a string", () => {
    expect(attrsForType("string")).toEqual([
      "name", "type", "description", "required", "unique", "default", "vocabulary", "identity", "generated", "aliases", "label", "note", "dense",
    ]);
  });
  it("numbers", () => {
    expect(attrsForType("number")).toContain("step");
    expect(attrsForType("integer")).toContain("min");
  });
  it("an enum", () => {
    expect(attrsForType("enum")).toEqual(expect.arrayContaining(["values", "value_descriptions", "ordered"]));
    expect(attrsForType("enum")).not.toContain("identity");
  });
  it("a link and a list of links", () => {
    expect(attrsForType("link")).toEqual(expect.arrayContaining(["ref", "inverse", "hierarchy", "acyclic", "ref_where", "ref_by", "unique"]));
    const list = attrsForType("list", "link");
    expect(list).toEqual(expect.arrayContaining(["items", "ref", "acyclic"]));
    expect(list).not.toContain("hierarchy");
    expect(list).not.toContain("unique");
  });
  it("dates have identity, a list of strings has a vocabulary but no identity", () => {
    expect(attrsForType("date")).toContain("identity");
    expect(attrsForType("datetime")).toContain("identity");
    expect(attrsForType("list")).toContain("vocabulary");
    expect(attrsForType("list")).not.toContain("identity");
    expect(attrsForType("boolean")).not.toContain("identity");
    expect(attrsForType("json")).not.toContain("vocabulary");
  });
});

describe("specProblems", () => {
  it("a good spec has none", () => {
    expect(specProblems({ name: "kind", type: "enum", values: ["a"], description: "What" })).toEqual([]);
    expect(specProblems({ name: "p", type: "list", items: "link", ref: "self", description: "d" })).toEqual([]);
  });
  it("names each problem", () => {
    expect(specProblems({ name: "1x", type: "string", description: " " })).toHaveLength(2);
    expect(specProblems({ type: "enum", description: "d" })).toEqual([
      'The name starts with a letter and holds only letters, digits, "_" or "-".',
      "An enum column needs its values.",
    ]);
    expect(specProblems({ name: "e", type: "enum", values: [], description: "d" })).toEqual(["An enum column needs its values."]);
    expect(specProblems({ name: "l", type: "link", ref: "", description: "d" })).toEqual(["A link column needs the table it links to (ref)."]);
    expect(specProblems({ name: "l", type: "list", description: "d" })).toEqual(["A list column needs the type of its items."]);
    expect(specProblems({ name: "l", description: "d" })).toEqual([]);
  });
});
