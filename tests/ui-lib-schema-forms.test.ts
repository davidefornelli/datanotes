/**
 * Operation forms from the OpenAPI document (src/ui/lib/schema-forms.ts), checked against the
 * engine's real document: every operation has a schema and fields, and inputs parse to JSON.
 */

import { describe, expect, it } from "vitest";
import { openApiDocument } from "../src/server/openapi";
import {
  buildArgs,
  fieldsOf,
  operationSchema,
  operationsOf,
  operationWrites,
  parseField,
  rawOf,
  type FieldSpec,
} from "../src/ui/lib/schema-forms";

const doc = JSON.parse(JSON.stringify(openApiDocument("t"))) as Record<string, any>;
const field = (op: string, name: string) => fieldsOf(operationSchema(doc, op)!).find((f) => f.name === name);

describe("schema forms on the real OpenAPI document", () => {
  const ops = operationsOf(doc);

  it("lists every operation with its tag and summary", () => {
    expect(ops.length).toBeGreaterThan(50);
    const sel = ops.find((o) => o.op === "select_rows")!;
    expect(sel.tag).toBe("Queries");
    expect(sel.summary).toContain("Query rows");
  });

  it("lists only operations, with Other for an untagged one", () => {
    expect(
      operationsOf({
        paths: {
          "/datanotes/tokens/": { post: {} },
          "/datanotes/operations/a/": { post: { tags: [1], summary: 2 } },
          "/datanotes/operations/b/": { get: {} },
          "/datanotes/operations/c/": null,
          "/datanotes/operations/d/": { post: { tags: ["T"], summary: "S" } },
        },
      }),
    ).toEqual([
      { op: "a", tag: "Other", summary: "" },
      { op: "d", tag: "T", summary: "S" },
    ]);
    expect(operationsOf({})).toEqual([]);
    expect(operationsOf(null as never)).toEqual([]);
  });

  it("finds every operation's schema, and fieldsOf does not throw", () => {
    for (const { op } of ops) {
      const schema = operationSchema(doc, op);
      expect(schema, op).not.toBeNull();
      expect(() => fieldsOf(schema!)).not.toThrow();
      expect(fieldsOf(schema!).some((f) => f.name === "dry_run")).toBe(false);
    }
  });

  it("maps argument types to field kinds", () => {
    expect(field("select_rows", "table")).toEqual({ name: "table", kind: "string", required: true });
    expect(field("select_rows", "order_by")!.kind).toBe("json");
    expect(field("select_rows", "limit")!.kind).toBe("integer");
    expect(field("select_rows", "include_body")).toMatchObject({ kind: "boolean", defaultValue: false, required: false });
    expect(field("select_rows", "columns")!.kind).toBe("string-list");
    expect(field("delete_rows", "mode")).toMatchObject({ kind: "enum" });
    expect(field("delete_rows", "mode")!.enumValues!.length).toBeGreaterThan(1);
    expect(field("create_table", "description")!.kind).toBe("text");
  });

  it("tells writes from reads", () => {
    expect(operationWrites(doc, "insert_row")).toBe(true);
    expect(operationWrites(doc, "select_rows")).toBe(false);
    expect(operationWrites(doc, "nope")).toBe(false);
    expect(operationWrites({ paths: { "/datanotes/operations/x/": { post: { parameters: [{ name: "a" }] } } } }, "x")).toBe(false);
  });
});

describe("schemas and fields", () => {
  it("answers null for an unknown operation or a missing schema", () => {
    expect(operationSchema(doc, "nope")).toBeNull();
    expect(operationSchema({}, "x")).toBeNull();
    expect(operationSchema({ paths: { "/datanotes/operations/x/": { post: 1 } } }, "x")).toBeNull();
    expect(operationSchema({ paths: { "/datanotes/operations/x/": { post: {} } } }, "x")).toBeNull();
  });

  it("resolves local $refs, leaves the others, and stops on a cycle", () => {
    const d = {
      components: { schemas: { Name: { type: "string", description: "a name" }, "a/b": { type: "integer" }, Loop: { $ref: "#/components/schemas/Loop" } } },
      paths: {
        "/datanotes/operations/x/": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: {
                      name: { $ref: "#/components/schemas/Name" },
                      n: { $ref: "#/components/schemas/a~1b" },
                      far: { $ref: "https://example.com/s.json" },
                      gone: { $ref: "#/components/schemas/Missing/deeper" },
                      loop: { $ref: "#/components/schemas/Loop" },
                      list: { type: "array", items: [{ $ref: "#/components/schemas/Name" }] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const s = operationSchema(d, "x")!;
    expect(s.properties.name).toEqual({ type: "string", description: "a name" });
    expect(s.properties.n).toEqual({ type: "integer" });
    expect(s.properties.far).toEqual({ $ref: "https://example.com/s.json" });
    expect(s.properties.gone).toEqual({ $ref: "#/components/schemas/Missing/deeper" });
    expect(s.properties.loop).toEqual({ $ref: "#/components/schemas/Loop" });
    expect(s.properties.list.items[0]).toEqual({ type: "string", description: "a name" });
    expect(fieldsOf(s)).toEqual([
      { name: "name", kind: "string", required: true, description: "a name" },
      { name: "n", kind: "integer", required: false },
      { name: "far", kind: "json", required: false },
      { name: "gone", kind: "json", required: false },
      { name: "loop", kind: "json", required: false },
      { name: "list", kind: "json", required: false },
    ]);
  });

  it("follows the kind rules", () => {
    const s = {
      properties: {
        body: { type: "string" },
        title: { type: "string", default: null },
        level: { type: "string", enum: ["a", "b"], default: "a" },
        n: { anyOf: [{ type: "number" }, { type: "null" }], description: "outer" },
        flag: { oneOf: [{ type: "boolean", description: "inner" }] },
        many: { anyOf: [{ type: "string" }, { type: "integer" }] },
        nothing: { anyOf: [{ type: "null" }] },
        nul: { anyOf: [null] },
        tags: { type: "array", items: { type: "string", enum: ["x"] } },
        names: { type: "array", items: { type: "string" } },
        nums: { type: "array", items: { type: "integer" } },
        obj: { type: "object" },
        bare: null,
        dry_run: { type: "boolean" },
      },
    };
    expect(fieldsOf(s)).toEqual([
      { name: "body", kind: "text", required: false },
      { name: "title", kind: "string", required: false },
      { name: "level", kind: "enum", required: false, enumValues: ["a", "b"], defaultValue: "a" },
      { name: "n", kind: "number", required: false, description: "outer" },
      { name: "flag", kind: "boolean", required: false, description: "inner" },
      { name: "many", kind: "json", required: false },
      { name: "nothing", kind: "json", required: false },
      { name: "nul", kind: "json", required: false },
      { name: "tags", kind: "json", required: false },
      { name: "names", kind: "string-list", required: false },
      { name: "nums", kind: "json", required: false },
      { name: "obj", kind: "json", required: false },
      { name: "bare", kind: "json", required: false },
    ]);
    expect(fieldsOf({})).toEqual([]);
    expect(fieldsOf(null as never)).toEqual([]);
  });
});

describe("parsing inputs", () => {
  const spec = (kind: FieldSpec["kind"], required = false): FieldSpec => ({ name: "f", kind, required });

  it("leaves empty input out, or refuses it when required", () => {
    expect(parseField(spec("string"), "")).toEqual({});
    expect(parseField(spec("integer"), "  ")).toEqual({});
    expect(parseField(spec("json"), null)).toEqual({});
    expect(parseField(spec("string", true), "")).toEqual({ error: '"f" is required' });
    expect(parseField(spec("string"), "  ")).toEqual({ value: "  " });
    expect(parseField(spec("text"), " a\n")).toEqual({ value: " a\n" });
    expect(parseField(spec("enum"), "a")).toEqual({ value: "a" });
  });

  it("parses numbers, booleans, lists and JSON", () => {
    expect(parseField(spec("integer"), " -12 ")).toEqual({ value: -12 });
    expect(parseField(spec("integer"), "1.5")).toEqual({ error: '"f" takes a whole number' });
    expect(parseField(spec("number"), "1.5e2")).toEqual({ value: 150 });
    expect(parseField(spec("number"), "abc")).toEqual({ error: '"f" takes a number' });
    expect(parseField(spec("boolean"), true)).toEqual({ value: true });
    expect(parseField(spec("boolean"), "false")).toEqual({ value: false });
    expect(parseField(spec("boolean"), "yes")).toEqual({ error: '"f" takes true or false' });
    expect(parseField(spec("string"), false)).toEqual({ value: "false" });
    expect(parseField(spec("string-list"), "a\n\n b \n")).toEqual({ value: ["a", "b"] });
    expect(parseField(spec("json"), '{"a":[1]}')).toEqual({ value: { a: [1] } });
    expect(parseField(spec("json"), "{a")!.error).toMatch(/^"f" is not valid JSON: /);
  });

  it("buildArgs collects values and errors", () => {
    const specs: FieldSpec[] = [
      { name: "table", kind: "string", required: true },
      { name: "limit", kind: "integer", required: false },
      { name: "where", kind: "json", required: false },
      { name: "include_body", kind: "boolean", required: false },
    ];
    expect(buildArgs(specs, { table: "t", limit: "10", include_body: "true" })).toEqual({
      args: { table: "t", limit: 10, include_body: true },
      errors: {},
    });
    expect(buildArgs(specs, { limit: "x", where: "" })).toEqual({
      args: {},
      errors: { table: '"table" is required', limit: '"limit" takes a whole number' },
    });
  });

  it("rawOf writes a value back as form text", () => {
    expect(rawOf(spec("string"), undefined)).toBe("");
    expect(rawOf(spec("string"), null)).toBe("");
    expect(rawOf(spec("string-list"), ["a", 1])).toBe("a\n1");
    expect(rawOf(spec("json"), { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(rawOf(spec("string"), "x")).toBe("x");
    expect(rawOf(spec("integer"), 5)).toBe("5");
    expect(rawOf(spec("boolean"), true)).toBe("true");
  });
});
