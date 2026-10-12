import { describe, expect, it } from "vitest";
import { refOf } from "../src/core/metastore";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { MalformedColumnError, MalformedTableOptionsError, parseColumn, parseLinkLevels, parseTableOptions, tableDefinitionFromOrdered } from "../src/core/table-loader";
import type { TableDefinition } from "../src/core/types-table";
import { METASTORE } from "./helpers/db-vault";

const PROJECT = "work.planning.project";
const PERSON = "work.planning.person";
const PARENT = { name: "parent", type: "link", ref: PROJECT };
const PRIORITY = { name: "priority", type: "enum", values: ["low", "medium", "high"] };
const LEVELS = { column: "level", levels: ["area", "project", "task"] };

/** What `fn` throws: its class and its message (toThrow compares the message only). */
function refusal(fn: () => unknown): [unknown, string] {
  try {
    fn();
  } catch (e) {
    return [(e as Error).constructor, (e as Error).message];
  }
  return [undefined, "no refusal"];
}

/** The engine's view of table work.planning.project with these `_columns`. */
const project = (columns: Record<string, unknown>[]): TableDefinition =>
  tableDefinitionFromOrdered(
    refOf("work", "planning", "project"),
    `${METASTORE}#${PROJECT}`,
    [
      ["table", PROJECT],
      ["_table", [{ name: "project", filename: "{title}" }]],
      ["_columns", columns],
    ],
    DEFAULT_SETTINGS,
  );

describe("ref_by (link levels)", () => {
  it.each<[string, unknown, string]>([
    ["a word", "level", `"ref_by" must be {column, levels} or {column, map}`],
    ["a list", ["level"], `"ref_by" must be {column, levels} or {column, map}`],
    ["an unknown key", { ...LEVELS, order: "asc" }, `"ref_by": unknown key "order" (column, target_column, levels, map)`],
    ["a column that is not a name", { ...LEVELS, column: "2nd level" }, `"ref_by.column" must be a column name`],
    ["a column that is a number", { ...LEVELS, column: 3 }, `"ref_by.column" must be a column name`],
    ["a target column that is not a name", { ...LEVELS, target_column: "parent level" }, `"ref_by.target_column" must be a column name`],
    ["no column", { levels: LEVELS.levels }, `"ref_by.column" is required: the column of the row that picks the allowed targets`],
    ["an empty column", { column: null, levels: LEVELS.levels }, `"ref_by.column" is required: the column of the row that picks the allowed targets`],
    ["neither levels nor map", { column: "level" }, `"ref_by" needs either "levels" or "map"`],
    ["both levels and map", { ...LEVELS, map: { area: null } }, `"ref_by" needs either "levels" or "map"`],
    ["levels as a word", { column: "level", levels: "area" }, `"ref_by.levels" must be a non-empty list of values`],
    ["no levels", { column: "level", levels: [] }, `"ref_by.levels" must be a non-empty list of values`],
    ["an empty level", { column: "level", levels: ["area", ""] }, `"ref_by.levels" must be a non-empty list of values`],
    ["a level that is a number", { column: "level", levels: ["area", 2] }, `"ref_by.levels" must be a non-empty list of values`],
    ["a level twice", { column: "level", levels: ["area", "project", "area"] }, `"ref_by.levels" lists a value twice`],
    ["a map that is a list", { column: "level", map: ["area", "project"] }, `"ref_by.map" must map each value of "level" to null (top level) or its allowed targets`],
    ["a map that is a word", { column: "level", map: "area" }, `"ref_by.map" must map each value of "level" to null (top level) or its allowed targets`],
    ["an empty map", { column: "level", map: {} }, `"ref_by.map" must map each value of "level" to null (top level) or its allowed targets`],
    ["map targets as a word", { column: "level", map: { area: null, project: "area" } }, `"ref_by.map.project" must be a non-empty list of values`],
    ["a map target twice", { column: "level", map: { area: null, task: ["project", "project"] } }, `"ref_by.map.task" lists a value twice`],
  ])("refuses %s", (_what, refBy, message) => {
    expect(refusal(() => parseColumn({ ...PARENT, ref_by: refBy }, 2))).toEqual([MalformedColumnError, `columns[2]: ${message}`]);
    expect(refusal(() => parseLinkLevels(refBy, 2))).toEqual([MalformedColumnError, `columns[2]: ${message}`]);
  });

  it("expands levels into the map, each level's targets the level before it", () => {
    expect(parseColumn({ ...PARENT, ref_by: { column: "kind", target_column: "level", levels: ["area", "project", "task"] } }, 0)).toEqual({
      name: "parent",
      type: "link",
      required: false,
      ref: PROJECT,
      aliases: [],
      ref_by: { column: "kind", target_column: "level", levels: ["area", "project", "task"], map: { area: null, project: ["area"], task: ["project"] } },
    });
  });

  it("keeps a map as written, with no levels", () => {
    const map = { area: null, project: ["area"], task: ["area", "project"] };
    expect(parseLinkLevels({ column: "level", map, levels: null }, 0)).toEqual({ column: "level", map });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["is not a column of the table", { name: "title", type: "string" }, `"ref_by.column": no column "level" in the table`],
    ["is a number column", { name: "level", type: "integer" }, `"ref_by.column": "level" must be an enum or string column`],
    ["is a list of enum values", { name: "level", type: "list", items: "enum", values: ["area", "project", "task"] }, `"ref_by.column": "level" must be an enum or string column`],
    ["is an enum without the map's values", { name: "level", type: "enum", values: ["area", "project", "task"] }, `"ref_by": "epic", "story" not a value of level (area, project, task)`],
  ])("refuses a ref_by whose column %s", (_what, level, message) => {
    const refBy = level.type === "enum" ? { column: "level", map: { epic: null, story: ["epic"], task: ["story"] } } : LEVELS;
    expect(refusal(() => project([level, { ...PARENT, ref_by: refBy }]))).toEqual([MalformedColumnError, `columns[1]: ${message}`]);
  });

  it("accepts an enum column with every map key among its values, and a string column with any", () => {
    const enumLevel = project([{ name: "level", type: "enum", values: ["area", "project", "task"] }, { ...PARENT, ref_by: LEVELS }]);
    expect(enumLevel.columns.find((c) => c.name === "parent")!.ref_by).toEqual({ ...LEVELS, map: { area: null, project: ["area"], task: ["project"] } });
    const stringLevel = project([{ name: "level", type: "string" }, { ...PARENT, ref_by: { column: "level", map: { epic: null, story: ["epic"] } } }]);
    expect(stringLevel.columns.find((c) => c.name === "parent")!.ref_by).toEqual({ column: "level", map: { epic: null, story: ["epic"] } });
  });
});

describe("parseColumn options", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["value descriptions on a string column", { name: "priority", type: "string", value_descriptions: { low: "Can wait" } }, `"value_descriptions" is only valid for enum columns`],
    ["value descriptions as a word", { ...PRIORITY, value_descriptions: "low means later" }, `"value_descriptions" must map each value to its meaning`],
    ["value descriptions as a list", { ...PRIORITY, value_descriptions: ["Can wait"] }, `"value_descriptions" must map each value to its meaning`],
    ["a description of an unknown value", { ...PRIORITY, value_descriptions: { urgent: "Now" } }, `"value_descriptions": "urgent" is not one of the values (low, medium, high)`],
    ["a blank description", { ...PRIORITY, value_descriptions: { low: "  " } }, `"value_descriptions.low" must be a non-empty string`],
    ["a description that is a number", { ...PRIORITY, value_descriptions: { high: 1 } }, `"value_descriptions.high" must be a non-empty string`],
    ["an external default that is not a value", { ...PRIORITY, external_default: "urgent" }, `"external_default" must be one of the values (low, medium, high)`],
    ["a blank generated expression", { name: "full_name", type: "string", generated: "   " }, `"generated" must be an expression`],
    ["an unknown identity", { name: "id", type: "string", identity: "serial" }, `"identity" must be "uuid", "filename" or "created"`],
    ["identity created on a string column", { name: "created_at", type: "string", identity: "created" }, `"identity: created" needs a date or datetime column`],
    ["identity created on a list of datetimes", { name: "created_at", type: "list", items: "datetime", identity: "created" }, `"identity: created" needs a date or datetime column`],
    ["identity uuid on an integer column", { name: "id", type: "integer", identity: "uuid" }, `"identity: uuid" is only valid for string columns`],
    ["identity filename on a link column", { name: "slug", type: "link", ref: PROJECT, identity: "filename" }, `"identity: filename" is only valid for string columns`],
    ["identity uuid on a list of strings", { name: "ids", type: "list", items: "string", identity: "uuid" }, `"identity: uuid" is only valid for string columns, not lists`],
    ["identity filename on a list (of strings by default)", { name: "names", type: "list", identity: "filename" }, `"identity: filename" is only valid for string columns, not lists`],
    ["hierarchy that is not a boolean", { ...PARENT, hierarchy: "yes" }, `"hierarchy" must be true or false`],
    ["hierarchy on a string column", { name: "parent", type: "string", hierarchy: true }, `"hierarchy" needs a single link column with "ref" (one parent per row)`],
    ["hierarchy on a link without ref", { name: "parent", type: "link", hierarchy: true }, `"hierarchy" needs a single link column with "ref" (one parent per row)`],
    ["hierarchy on a list of links", { name: "parents", type: "list", items: "link", ref: PROJECT, hierarchy: true }, `"hierarchy" needs a single link column with "ref" (one parent per row)`],
    ["an inverse that is a number", { ...PARENT, inverse: 3 }, `"inverse" must be the name of a column of the linked table`],
    ["an inverse that is not a name", { ...PARENT, inverse: "sub projects" }, `"inverse" must be the name of a column of the linked table`],
    ["an inverse on a string column", { name: "owner", type: "string", inverse: "projects" }, `"inverse" needs a link column (or list of links) with "ref"`],
    ["an inverse on a link without ref", { name: "owner", type: "link", inverse: "projects" }, `"inverse" needs a link column (or list of links) with "ref"`],
    ["a vocabulary that is a number", { name: "topic", type: "string", vocabulary: 3 }, `"vocabulary" must be a table name`],
    ["a blank vocabulary", { name: "topic", type: "string", vocabulary: "  " }, `"vocabulary" must be a table name`],
    ["a vocabulary on an enum column", { ...PRIORITY, vocabulary: "priorities" }, `"vocabulary" is only valid for string columns and lists of strings`],
    ["ref_where as a word", { ...PARENT, ref_where: "status = active" }, `"ref_where" must be a non-empty where filter on the linked table`],
    ["ref_where as a list", { ...PARENT, ref_where: [{ status: "active" }] }, `"ref_where" must be a non-empty where filter on the linked table`],
    ["an empty ref_where", { ...PARENT, ref_where: {} }, `"ref_where" must be a non-empty where filter on the linked table`],
    ["ref_where on a link without ref", { name: "project", type: "link", ref_where: { status: "active" } }, `"ref_where" needs a link column (or list of links) with "ref"`],
    ["ref_by on a string column", { name: "level", type: "string", ref_by: LEVELS }, `"ref_by" needs a link column (or list of links) with "ref"`],
    ["ref_by on a link without ref", { name: "parent", type: "link", ref_by: LEVELS }, `"ref_by" needs a link column (or list of links) with "ref"`],
    ["a default on a generated column", { name: "full_name", type: "string", generated: "{first} {last}", default: "Anonymous" }, `a generated or identity column cannot have a "default"`],
    ["a default on an identity column", { name: "id", type: "string", identity: "uuid", default: "0000" }, `a generated or identity column cannot have a "default"`],
    ["{now} on a string column", { name: "title", type: "string", default: "{now}" }, `"{now}" is only valid for date and datetime columns`],
    ["{today} on an integer column", { name: "week", type: "integer", default: "{today}" }, `"{today}" is only valid for date and datetime columns`],
  ])("refuses %s", (_what, raw, message) => {
    expect(refusal(() => parseColumn(raw, 2))).toEqual([MalformedColumnError, `columns[2]: ${message}`]);
  });

  it("accepts identity created on date and datetime columns, and an identity with an empty default", () => {
    expect(parseColumn({ name: "created_at", type: "datetime", identity: "created" }, 0)).toEqual({ name: "created_at", type: "datetime", required: false, aliases: [], identity: "created" });
    expect(parseColumn({ name: "day", type: "date", identity: "created" }, 0)).toEqual({ name: "day", type: "date", required: false, aliases: [], identity: "created" });
    expect(parseColumn({ name: "id", type: "string", identity: "uuid", default: null }, 0)).toEqual({ name: "id", type: "string", required: false, aliases: [], identity: "uuid" });
    expect(parseColumn({ name: "full_name", type: "string", generated: " {first} {last} " }, 0)).toEqual({ name: "full_name", type: "string", required: false, aliases: [], generated: "{first} {last}" });
  });

  it("accepts hierarchy, inverse, ref_where and vocabulary where they apply, trimmed", () => {
    expect(parseColumn({ ...PARENT, hierarchy: true, inverse: " children " }, 0)).toEqual({ ...PARENT, required: false, aliases: [], hierarchy: true, inverse: "children" });
    expect(parseColumn({ name: "parent_name", type: "string", hierarchy: false }, 0)).toEqual({ name: "parent_name", type: "string", required: false, aliases: [] });
    expect(parseColumn({ name: "reviewers", type: "list", items: "link", ref: PERSON, inverse: "reviews", ref_where: { team: "data" } }, 0)).toEqual({
      name: "reviewers",
      type: "list",
      items: "link",
      required: false,
      ref: PERSON,
      aliases: [],
      inverse: "reviews",
      ref_where: { team: "data" },
    });
    expect(parseColumn({ name: "topics", type: "list", items: "string", vocabulary: " topics " }, 0)).toEqual({ name: "topics", type: "list", items: "string", required: false, aliases: [], vocabulary: "topics" });
  });

  it("accepts value descriptions (trimmed) and an external default among the values", () => {
    expect(parseColumn({ ...PRIORITY, value_descriptions: { low: " Can wait ", high: "Today" }, external_default: "medium" }, 0)).toEqual({
      ...PRIORITY,
      required: false,
      value_descriptions: { low: "Can wait", high: "Today" },
      external_default: "medium",
      aliases: [],
    });
    expect(parseColumn({ name: "status", type: "string", external_default: "inbox" }, 0).external_default).toBe("inbox");
  });

  it("accepts {now} on datetime and {today} on date columns", () => {
    expect(parseColumn({ name: "logged_at", type: "datetime", default: "{now}" }, 0).default).toBe("{now}");
    expect(parseColumn({ name: "day", type: "date", default: "{today}" }, 0).default).toBe("{today}");
  });
});

describe("generated columns of a table", () => {
  it("refuses an expression that does not parse, with the expression's own message", () => {
    expect(refusal(() => project([{ name: "amount", type: "number" }, { name: "total", type: "number", generated: "sum(amount, tip)" }]))).toEqual([
      MalformedColumnError,
      `columns[1]: "sum(amount, tip)" is not a generated expression: use a column, date(column)±N or a template like "{name} {surname}"`,
    ]);
  });

  it("refuses a generated column that reads a generated column declared after it", () => {
    expect(
      refusal(() =>
        project([
          { name: "contact", type: "string", generated: "{full_name} <{email}>" },
          { name: "full_name", type: "string", generated: "{first} {last}" },
          { name: "first", type: "string" },
          { name: "last", type: "string" },
          { name: "email", type: "string" },
        ]),
      ),
    ).toEqual([MalformedColumnError, `columns[0]: "generated" reads generated column "full_name", declared after it`]);
  });

  it("accepts reading path, a plain column declared after it and a generated column declared before it", () => {
    const def = project([
      { name: "file", type: "string", generated: "path" },
      { name: "full_name", type: "string", generated: "{first} {last}" },
      { name: "contact", type: "string", generated: "{full_name} ({file})" },
      { name: "first", type: "string" },
      { name: "last", type: "string" },
    ]);
    expect(def.columns.map((c) => [c.name, c.generated])).toEqual([
      ["file", "path"],
      ["full_name", "{first} {last}"],
      ["contact", "{full_name} ({file})"],
      ["first", undefined],
      ["last", undefined],
    ]);
  });
});

describe("parseTableOptions", () => {
  it.each([2026, ["{kind}"], { by: "kind" }])("refuses a partition that is not a folder pattern (%j)", (partition) => {
    expect(refusal(() => parseTableOptions([{ name: "log", partition }]))).toEqual([MalformedTableOptionsError, `"partition" must be a folder pattern`]);
  });
});
