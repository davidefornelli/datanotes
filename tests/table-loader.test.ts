import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TFile } from "../src/core/host";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import {
  MalformedColumnError,
  MalformedTableOptionsError,
  parseColumn,
  parseColumns,
  parseTableOptions,
  tableDefinitionFromOrdered,
} from "../src/core/table-loader";
import { METASTORE } from "./helpers/db-vault";

describe("tableDefinitionFromOrdered", () => {
  it("builds a metastore table: columns, dense fields, layout in the table folder", () => {
    const ref = { catalog: "main", schema: "public", table: "log", full: "main.public.log" };
    const def = tableDefinitionFromOrdered(
      ref,
      `${METASTORE}#main.public.log`,
      [
        ["table", "main.public.log"],
        ["kind", null],
        ["type", "log"],
        ["_table", [{ name: "log", filename: "{kind}", partition: "{kind}" }]],
        ["_columns", [{ name: "kind", type: "enum", values: ["a", "b"], required: true }, { name: "note", type: "string" }]],
      ],
      DEFAULT_SETTINGS,
    );
    expect(def).toMatchObject({ name: "log", schema: "public", catalog: "main", untypedFields: ["table", "type"] });
    expect(def.columns.map((c) => [c.name, c.dense])).toEqual([["kind", true], ["note", false]]);
    expect(def.layout).toEqual({
      folder: "datanotes/main/public/log",
      inDatabase: true,
      rowPath: "datanotes/main/public/log/{kind}",
      archive: "datanotes/main/public/log/_archive",
    });
  });
});

describe("parseColumn", () => {
  const ok = (e: Record<string, unknown>) => parseColumn(e, 0);
  const bad = (e: unknown, msg: RegExp) => expect(() => parseColumn(e, 2)).toThrow(msg);

  it("parses minimal and full specs", () => {
    expect(ok({ name: "a", type: "string" })).toEqual({
      name: "a",
      type: "string",
      required: false,
      aliases: [],
    });
    expect(ok({ name: "tags", type: "list" }).items).toBe("string");
    const full = ok({
      name: "m",
      type: "number",
      min: 0,
      max: 5,
      step: 1,
      required: true,
      label: "M",
      description: "d",
      note: "[[m]]",
      aliases: ["x", 2],
      default: 3,
    });
    expect(full).toMatchObject({ min: 0, max: 5, step: 1, label: "M", default: 3, aliases: ["x", "2"] });
    expect(ok({ name: "e", type: "enum", values: ["a"], default: "" }).default).toBeUndefined();
    expect(ok({ name: "l", type: "link", ref: "person" }).ref).toBe("person");
    expect(ok({ name: "v", type: "list", items: "enum", values: ["a"] }).values).toEqual(["a"]);
  });

  it("rejects malformed specs with indexed messages", () => {
    bad(null, /columns\[2\]: expected a mapping/);
    bad(["x"], /expected a mapping/);
    bad({ name: "a", type: "string", colour: "red" }, /unknown attribute "colour"/);
    bad({ name: "1a", type: "string" }, /"name" must start with a letter/);
    bad({ type: "string" }, /"name"/);
    bad({ name: "a", type: "decimal" }, /"type" must be one of/);
    bad({ name: "a", type: "list", items: "list" }, /"items" must be a scalar/);
    bad({ name: "a", type: "string", items: "string" }, /only valid for list/);
    bad({ name: "a", type: "string", required: "yes" }, /"required" must be true or false/);
    bad({ name: "a", type: "string", min: 1 }, /only valid for number/);
    bad({ name: "a", type: "number", min: "1" }, /"min" must be a number/);
    bad({ name: "a", type: "number", min: 5, max: 1 }, /"min" must be <= "max"/);
    bad({ name: "a", type: "number", step: 0 }, /"step" must be > 0/);
    bad({ name: "a", type: "enum" }, /non-empty "values"/);
    bad({ name: "a", type: "enum", values: [] }, /non-empty "values"/);
    bad({ name: "a", type: "enum", values: "a" }, /"values" must be a list/);
    bad({ name: "a", type: "enum", values: [true] }, /items must be strings/);
    bad({ name: "a", type: "string", values: ["a"] }, /only valid for enum/);
    bad({ name: "a", type: "string", ref: "x" }, /only valid for link/);
    bad({ name: "a", type: "string", label: 3 }, /"label" must be a string/);
    bad({ name: "a", type: "number", max: 3, default: 9 }, /"default" is invalid/);
    expect(() => parseColumn({ name: "reserved", type: "string" }, 0, new Set(["reserved"]))).toThrow(
      /reserved front matter key/,
    );
  });

  it("MalformedColumnError carries the index", () => {
    const e = new MalformedColumnError(4, "x");
    expect(e.index).toBe(4);
    expect(e.message).toBe("columns[4]: x");
  });
});

describe("parseColumns / parseTableOptions", () => {
  it("parses lists and rejects duplicates and non-lists", () => {
    expect(parseColumns(undefined)).toEqual([]);
    expect(parseColumns(null)).toEqual([]);
    expect(() => parseColumns("x")).toThrow(/must be a list/);
    expect(() =>
      parseColumns([
        { name: "a", type: "string" },
        { name: "a", type: "number" },
      ]),
    ).toThrow(/columns\[1\]: duplicate column "a"/);
  });

  it("parses table options", () => {
    expect(parseTableOptions(undefined)).toEqual({});
    expect(parseTableOptions([])).toEqual({});
    expect(parseTableOptions([{ name: " log ", partition: "/{kind}/", archive: null }])).toEqual({
      name: "log",
      partition: "{kind}",
    });
    expect(() => parseTableOptions("x")).toThrow(MalformedTableOptionsError);
    expect(() => parseTableOptions([{}, {}])).toThrow(/exactly one/);
    expect(() => parseTableOptions([{ colour: "x" }])).toThrow(/unknown attribute/);
    expect(() => parseTableOptions([{ path: "P" }])).toThrow(/unknown attribute "path"/);
    expect(() => parseTableOptions([{ filename: "" }])).toThrow(/non-empty string/);
    expect(() => parseTableOptions([{ filename: 3 }])).toThrow(/non-empty string/);
  });
});


