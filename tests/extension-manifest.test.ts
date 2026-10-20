import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BATCH_OPERATIONS,
  bindRoles,
  COLUMN_ATTRS,
  COLUMN_TYPES,
  compareVersions,
  DATA_OPERATIONS,
  EXT_DOCS,
  ExtensionError,
  ExtensionManifestError,
  parseManifest,
  parseVersion,
  rolesNamed,
  satisfiesEngine,
  validateManifest,
} from "../src/api/extension-manifest";
import { defineExtension, EXTENSION_API_VERSION, ExtensionToolError } from "../src/api/extension-sdk";
import * as entry from "../src/api/extensions";
import { COLUMN_ATTRS as ENGINE_COLUMN_ATTRS } from "../src/core/table-loader";
import { SCALAR_COLUMN_TYPES } from "../src/core/types-table";
import { BATCH_OPERATIONS as ENGINE_BATCH } from "../src/server/rest";

const books = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "extensions", "books");
const read = (version: string) => fs.readFileSync(path.join(books, version, "datanotes-extension.json"), "utf8");
const raw = (): any => JSON.parse(read("v0.1.0"));

function problemsOf(m: unknown): string[] {
  try {
    validateManifest(m);
  } catch (e) {
    expect(e).toBeInstanceOf(ExtensionManifestError);
    return (e as ExtensionManifestError).problems;
  }
  throw new Error("the manifest was accepted");
}

describe("parseManifest", () => {
  it("reads the books fixture", () => {
    const m = parseManifest(read("v0.1.0"));
    expect(m.name).toBe("books");
    expect(m.roles).toEqual(["person", "book"]);
    expect(m.tables.book!.owned).toBe(true);
    expect(m.tables.book!.columns[3]!.need).toBe("optional");
    expect(m.tables.book!.columns[0]!.need).toBe("required");
    expect(m.bases.shelved!.columns[0]!.name).toBe("shelf");
    expect(m.bases.shelved!.columns[0]!.need).toBe("required");
    expect(m.views.vw_reading!.query).toEqual({ table: "@book", where: { status: "reading" } });
    expect(m.tools.map((t) => t.name)).toEqual(["list_reading", "finish_book"]);
    expect(m.migrations).toEqual([]);
  });

  it("reads v0.2.0 with its migration", () => {
    const m = parseManifest(read("v0.2.0"));
    expect(m.version).toBe("0.2.0");
    expect(m.migrations[0]!.version).toBe("0.2.0");
    expect(m.migrations[0]!.operations[0]!.op).toBe("add_column");
  });

  it("refuses a text that is not JSON", () => {
    let error: unknown;
    try {
      parseManifest("{nope");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ExtensionManifestError);
    expect(error).toBeInstanceOf(ExtensionError);
    const e = error as ExtensionManifestError;
    expect(e.problems[0]).toMatch(/^not JSON:/);
    expect(e.message.startsWith("datanotes-extension.json: 1 problem: not JSON:")).toBe(true);
    expect(e.hint).toContain("datanotes extension check");
    expect(e.docs).toBe(EXT_DOCS.manifest);
    expect(e.code).toBe("manifest");
    expect(e.name).toBe("ExtensionManifestError");
  });

  it("names the file it was given", () => {
    expect(() => parseManifest("[]", "other.json")).toThrow("other.json: 1 problem: the manifest must be a JSON object");
  });

  it("a BOM is not a problem", () => {
    expect(parseManifest(`\uFEFF${read("v0.1.0")}`).name).toBe("books");
  });

  it("fills in the defaults of a small manifest", () => {
    const m = parseManifest(
      JSON.stringify({
        manifest_version: 1,
        name: "tiny",
        version: "1.0.0",
        description: "Tiny",
        datanotes: ">=3.2.0",
        api: 1,
        entry: "lib/x.mjs",
        default_schema: "tiny",
        tables: { thing: { owned: true, description: "A thing", columns: [{ name: "title", type: "string", description: "Title" }] } },
        permissions: { write: [] },
        tools: [{ name: "peek", description: "Peek", inputSchema: { type: "object", additionalProperties: false } }],
      }),
    );
    expect(m.bases).toEqual({});
    expect(m.views).toEqual({});
    expect(m.migrations).toEqual([]);
    expect(m.tools[0]).toMatchObject({ annotations: {}, tables: [], writes: [] });
    expect(m.tables.thing!.columns[0]!.need).toBe("required");
  });
});

type Case = [string, (m: any) => void, string];
const cases: Case[] = [
  ["an unknown top-level key", (m) => (m.descripton = "x"), `unknown key "descripton" (did you mean "description"?)`],
  ["an unknown key with no near name", (m) => (m.zzzzzzzzzz = 1), `unknown key "zzzzzzzzzz"`],
  ["manifest_version", (m) => (m.manifest_version = 2), "manifest_version: must be 1"],
  ["a capital in the name", (m) => (m.name = "Books"), "name: must be 2 to 40 lowercase letters, digits or -, starting with a letter"],
  ["a name that is not text", (m) => (m.name = 4), "name: must be 2 to 40 lowercase letters, digits or -, starting with a letter"],
  ["a version that is not text", (m) => (m.version = 5), `version: "5" is not a version (MAJOR.MINOR.PATCH)`],
  ["a short version", (m) => (m.version = "1.0"), `version: "1.0" is not a version (MAJOR.MINOR.PATCH)`],
  ["an empty description", (m) => (m.description = ""), "description: is required (1 to 300 characters)"],
  ["a long description", (m) => (m.description = "x".repeat(301)), "description: is required (1 to 300 characters)"],
  ["a caret range", (m) => (m.datanotes = "^3.2.0"), `datanotes: must be ">=X.Y.Z", such as ">=3.3.0"`],
  ["a datanotes range that is not text", (m) => (m.datanotes = 3), `datanotes: must be ">=X.Y.Z", such as ">=3.3.0"`],
  ["api 2", (m) => (m.api = 2), "api: must be 1"],
  ["an entry outside the repository", (m) => (m.entry = "../x.mjs"), "entry: must be a relative path to a .mjs file inside the repository"],
  ["an entry that is not .mjs", (m) => (m.entry = "lib/x.js"), "entry: must be a relative path to a .mjs file inside the repository"],
  ["an absolute entry", (m) => (m.entry = "/abs.mjs"), "entry: must be a relative path to a .mjs file inside the repository"],
  ["a drive entry", (m) => (m.entry = "C:/abs.mjs"), "entry: must be a relative path to a .mjs file inside the repository"],
  ["a backslash entry", (m) => (m.entry = "lib\\x.mjs"), "entry: must be a relative path to a .mjs file inside the repository"],
  ["an entry with a dot segment", (m) => (m.entry = "./x.mjs"), "entry: must be a relative path to a .mjs file inside the repository"],
  ["an entry with an empty segment", (m) => (m.entry = "lib//x.mjs"), "entry: must be a relative path to a .mjs file inside the repository"],
  ["a default schema with a capital", (m) => (m.default_schema = "Books"), "default_schema: must be lowercase letters, digits and _"],
  ["empty instructions", (m) => (m.instructions = ""), "instructions: must be 1 to 400 characters"],
  ["long instructions", (m) => (m.instructions = "x".repeat(401)), "instructions: must be 1 to 400 characters"],
  ["no tables", (m) => (m.tables = {}), "tables: needs at least one table"],
  ["tables that are not an object", (m) => (m.tables = []), "tables: needs at least one table"],
  ["a role with a capital", (m) => (m.tables.Bad = { ...m.tables.person }), "tables.Bad: a role is lowercase letters, digits and _"],
  ["a table that is not an object", (m) => (m.tables.thing = 1), "tables.thing: must be an object"],
  ["owned that is not a boolean", (m) => (m.tables.book.owned = "yes"), "tables.book.owned: must be true or false"],
  ["a table name with a capital", (m) => (m.tables.book.name = "Book"), "tables.book.name: must be lowercase letters, digits and _"],
  ["a schema with a dash", (m) => (m.tables.book.schema = "my-books"), "tables.book.schema: must be lowercase letters, digits and _"],
  ["names on the owned table", (m) => (m.tables.book.names = ["book"]), "tables.book.names: only a table the extension depends on has names"],
  ["names that are not a list", (m) => (m.tables.person.names = "person"), "tables.person.names: must be a list of names"],
  ["names with a number", (m) => (m.tables.person.names = [1]), "tables.person.names: must be a list of names"],
  ["a table without description", (m) => delete m.tables.book.description, "tables.book.description: is required"],
  ["columns that are not a list", (m) => (m.tables.book.columns = "x"), "tables.book.columns: must be a list"],
  ["a column that is not an object", (m) => (m.tables.book.columns[0] = 1), "tables.book.columns[0]: must be an object"],
  ["a column name with a capital", (m) => (m.tables.book.columns[0].name = "Title"), "tables.book.columns[0].name: must be lowercase letters, digits and _"],
  ["a column called id", (m) => (m.tables.book.columns[0].name = "id"), `tables.book.columns[0]: "id" is the engine's own column: leave it out`],
  ["a column twice", (m) => (m.tables.book.columns[2].name = "title"), `tables.book.columns: column "title" twice`],
  ["a column type text", (m) => (m.tables.book.columns[0].type = "text"), `tables.book.columns[0].type: "text" is not a column type (${COLUMN_TYPES.join(", ")})`],
  ["a list without items", (m) => (m.tables.book.columns[0] = { name: "tags", type: "list", description: "Tags" }), "tables.book.columns[0].items: a list column needs items"],
  ["a column attribute that does not exist", (m) => (m.tables.book.columns[0].requird = true), `tables.book.columns[0]: unknown key "requird" (did you mean "required"?)`],
  ["a need that is neither", (m) => (m.tables.book.columns[0].need = "maybe"), `tables.book.columns[0].need: must be "required" or "optional"`],
  ["a ref to the own role", (m) => (m.tables.book.columns[1].ref = "@book"), `tables.book.columns[1].ref: must be "self" or "@<role>" of a table declared before this one`],
  ["a ref to a role that is not there", (m) => (m.tables.book.columns[1].ref = "@nowhere"), `tables.book.columns[1].ref: must be "self" or "@<role>" of a table declared before this one`],
  ["a ref to a later role", (m) => (m.tables.person.columns[0] = { name: "book", type: "link", ref: "@book", description: "A book" }), `tables.person.columns[0].ref: must be "self" or "@<role>" of a table declared before this one`],
  ["a ref to a qualified table", (m) => (m.tables.book.columns[1].ref = "work.planning.person"), `tables.book.columns[1].ref: must be "self" or "@<role>" of a table declared before this one`],
  ["a ref that is not text", (m) => (m.tables.book.columns[1].ref = 3), `tables.book.columns[1].ref: must be "self" or "@<role>" of a table declared before this one`],
  ["an inverse with another ref", (m) => (m.tables.book.columns[1].inverse = "books"), `tables.book.columns[1].inverse: only on a column with ref "self" in manifest version 1`],
  ["a column without description", (m) => delete m.tables.book.columns[0].description, "tables.book.columns[0].description: is required"],
  ["constraints on the dependency", (m) => (m.tables.person.constraints = []), "tables.person.constraints: only a table the extension owns has constraints"],
  ["instructions on the dependency", (m) => (m.tables.person.instructions = "x"), "tables.person.instructions: only a table the extension owns has instructions"],
  ["bases on the dependency", (m) => (m.tables.person.bases = []), "tables.person.bases: only a table the extension owns has bases"],
  ["constraints that are not a list", (m) => (m.tables.book.constraints = {}), "tables.book.constraints: must be a list"],
  ["a constraint that is not an object", (m) => (m.tables.book.constraints = [1]), "tables.book.constraints[0]: must be an object"],
  ["a constraint name with a capital", (m) => (m.tables.book.constraints[0].name = "Rated"), "tables.book.constraints[0].name: must be lowercase letters, digits and _"],
  ["a check that is not an object", (m) => (m.tables.book.constraints[0].check = "x"), "tables.book.constraints[0].check: must be an object"],
  ["a hint that is not text", (m) => (m.tables.book.constraints[0].hint = 1), "tables.book.constraints[0].hint: must be a string"],
  ["a constraint key that does not exist", (m) => (m.tables.book.constraints[0].hints = "x"), `tables.book.constraints[0]: unknown key "hints" (did you mean "hint"?)`],
  ["a constraint twice", (m) => m.tables.book.constraints.push({ ...m.tables.book.constraints[0] }), `tables.book.constraints: constraint "rating_only_when_read" twice`],
  ["empty table instructions", (m) => (m.tables.book.instructions = ""), "tables.book.instructions: must be a non-empty string"],
  ["bases that are not a list", (m) => (m.tables.book.bases = "shelved"), "tables.book.bases: must be a list"],
  ["a base that is not in bases", (m) => (m.tables.book.bases = ["nope"]), `tables.book.bases[0]: base "nope" is not in bases`],
  ["a base that is not text", (m) => (m.tables.book.bases = [1]), `tables.book.bases[0]: base "1" is not in bases`],
  ["bases that are not an object", (m) => (m.bases = []), "bases: must be an object"],
  ["a base name with a capital", (m) => (m.bases.Shelf = m.bases.shelved), "bases.Shelf: a base name is lowercase letters, digits and _"],
  ["a base that is not an object", (m) => (m.bases.other = 1), "bases.other: must be an object"],
  ["a base without description", (m) => delete m.bases.shelved.description, "bases.shelved.description: is required"],
  ["base columns that are not a list", (m) => (m.bases.shelved.columns = {}), "bases.shelved.columns: must be a list"],
  ["a ref in a base", (m) => (m.bases.shelved.columns[0] = { name: "owner", type: "link", ref: "@person", description: "Who" }), `bases.shelved.columns[0].ref: must be "self" in a base`],
  ["views that are not an object", (m) => (m.views = []), "views: must be an object"],
  ["a view without vw_", (m) => (m.views.reading = m.views.vw_reading), "views.reading: a view name starts with vw_ and is lowercase letters, digits and _"],
  ["a view that is not an object", (m) => (m.views.vw_other = 1), "views.vw_other: must be an object"],
  ["a view without description", (m) => delete m.views.vw_reading.description, "views.vw_reading.description: is required"],
  ["a view query that is not an object", (m) => (m.views.vw_reading.query = "x"), "views.vw_reading.query: must be an object"],
  ["no permissions", (m) => delete m.permissions, `permissions: must be an object with a "write" list of roles`],
  ["a permission that is not a role", (m) => (m.permissions.write = ["nope"]), `permissions.write[0]: "nope" is not a role`],
  ["write that is not a list", (m) => (m.permissions.write = "book"), "permissions.write: must be a list of roles"],
  ["a permission key that does not exist", (m) => (m.permissions.read = []), `permissions: unknown key "read"`],
  ["tools that are not a list", (m) => (m.tools = {}), "tools: must be a list"],
  ["a tool that is not an object", (m) => (m.tools[0] = 1), "tools[0]: must be an object"],
  ["a tool name with a capital", (m) => (m.tools[0].name = "List"), "tools[0].name: must be snake_case, 1 to 64 characters"],
  ["a tool twice", (m) => (m.tools[1].name = "list_reading"), `tools: tool "list_reading" twice`],
  ["a tool without description", (m) => delete m.tools[0].description, "tools[0].description: is required"],
  ["an input schema without additionalProperties false", (m) => delete m.tools[0].inputSchema.additionalProperties, `tools[0].inputSchema: must be an object schema with "type": "object" and "additionalProperties": false`],
  ["an input schema that is not an object", (m) => (m.tools[0].inputSchema = []), `tools[0].inputSchema: must be an object schema with "type": "object" and "additionalProperties": false`],
  ["a readOnlyHint that is not a boolean", (m) => (m.tools[0].annotations.readOnlyHint = "yes"), "tools[0].annotations.readOnlyHint: must be true or false"],
  ["tool tables that are not a list", (m) => (m.tools[0].tables = "book"), "tools[0].tables: must be a list of roles"],
  ["a tool table that is not a role", (m) => (m.tools[0].tables = ["nope"]), `tools[0].tables[0]: "nope" is not a role`],
  ["tool writes that are not a list", (m) => (m.tools[1].writes = "book"), "tools[1].writes: must be a list of roles"],
  ["a tool write outside the permissions", (m) => (m.tools[1].writes = ["person"]), `tools[1].writes[0]: "person" is not in permissions.write`],
  ["a read-only tool with writes", (m) => (m.tools[0].writes = ["book"]), "tools[0]: a read-only tool writes nothing (empty writes, or readOnlyHint false)"],
  ["a writing tool without readOnlyHint", (m) => delete m.tools[1].annotations.readOnlyHint, "tools[1]: a tool that writes has readOnlyHint false"],
  ["migrations that are not a list", (m) => (m.migrations = {}), "migrations: must be a list"],
  ["a migration that is not an object", (m) => (m.migrations = [1]), "migrations[0]: must be an object"],
  ["a migration version that is not one", (m) => (m.migrations = [{ version: "x", description: "d", operations: [] }]), `migrations[0].version: "x" is not a version`],
  ["a migration later than the extension", (m) => (m.migrations = [{ version: "0.3.0", description: "d", operations: [] }]), "migrations[0].version: 0.3.0 is later than the extension's version 0.1.0"],
  [
    "migrations out of order",
    (m) =>
      (m.migrations = [
        { version: "0.1.0", description: "d", operations: [] },
        { version: "0.0.9", description: "d", operations: [] },
      ]),
    "migrations: versions must increase (0.1.0 before 0.0.9)",
  ],
  ["a migration without description", (m) => (m.migrations = [{ version: "0.1.0", operations: [] }]), "migrations[0].description: is required"],
  ["migration operations that are not a list", (m) => (m.migrations = [{ version: "0.1.0", description: "d", operations: "x" }]), "migrations[0].operations: must be a list"],
  ["a migration operation that is not a batch one", (m) => (m.migrations = [{ version: "0.1.0", description: "d", operations: [{ op: "drop_database" }] }]), `migrations[0].operations[0].op: "drop_database" is not an operation a batch takes`],
  ["a migration operation that is not an object", (m) => (m.migrations = [{ version: "0.1.0", description: "d", operations: [3] }]), `migrations[0].operations[0].op: "undefined" is not an operation a batch takes`],
  ["a text role that is not there", (m) => (m.tables.book.instructions += "@{nobody}"), `tables.book.instructions: "@{nobody}" names no role`],
  ["a view role that is not there", (m) => (m.views.vw_reading.query.table = "@nobody"), `views.vw_reading.query.table: "@nobody" names no role`],
  ["a migration role that is not there", (m) => (m.migrations = [{ version: "0.1.0", description: "d", operations: [{ op: "add_column", table: "@nobody", column: {} }] }]), `migrations[0].operations[0].table: "@nobody" names no role`],
  ["a role in a list that is not there", (m) => (m.views.vw_reading.aliases = ["@{ghost}"]), `views.vw_reading.aliases[0]: "@{ghost}" names no role`],
];

describe("validateManifest", () => {
  it("has the cases of every row of the table", () => expect(cases.length).toBeGreaterThanOrEqual(40));

  it.each(cases)("refuses %s", (_title, mutate, expected) => {
    const m = raw();
    mutate(m);
    expect(problemsOf(m)).toContain(expected);
  });

  it("refuses what is not an object", () => {
    expect(problemsOf([])).toEqual(["the manifest must be a JSON object"]);
    expect(problemsOf(null)).toEqual(["the manifest must be a JSON object"]);
  });

  it("lists every problem, in order", () => {
    const m = raw();
    m.name = "Books";
    m.tables.book.columns[0].name = "id";
    m.tools[0].name = "List";
    expect(problemsOf(m)).toEqual([
      "name: must be 2 to 40 lowercase letters, digits or -, starting with a letter",
      `tables.book.columns[0]: "id" is the engine's own column: leave it out`,
      "tools[0].name: must be snake_case, 1 to 64 characters",
    ]);
  });

  it("puts unknown keys first and counts the problems in the message", () => {
    const m = raw();
    m.api = 3;
    m.extra = true;
    let error: unknown;
    try {
      validateManifest(m);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ExtensionManifestError);
    expect((error as ExtensionManifestError).problems[0]).toBe(`unknown key "extra"`);
    expect((error as ExtensionManifestError).message).toContain("2 problems: ");
  });

  it("does not change its input", () => {
    const m = raw();
    const before = JSON.stringify(m);
    validateManifest(m);
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe("roles", () => {
  const tables = { person: "work.planning.person", book: "work.books.book" };

  it("binds both forms and leaves keys and numbers alone", () => {
    const input = { ref: "@person", t: "a row of @{person}.", k: { "@person": 1 }, list: ["@book", 2], flag: true };
    const before = JSON.stringify(input);
    expect(bindRoles(input, tables)).toEqual({
      ref: "work.planning.person",
      t: "a row of work.planning.person.",
      k: { "@person": 1 },
      list: ["work.books.book", 2],
      flag: true,
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("throws for a role with no table", () => {
    expect(() => bindRoles("@ghost", {})).toThrow("no table for role ghost");
    expect(() => bindRoles("see @{ghost}", { toString: "x" })).toThrow("no table for role ghost");
  });

  it("names the roles of a value in order of first appearance", () => {
    expect(rolesNamed(["@b", "x @{a} @{b}", { y: "@a" }, 3, null])).toEqual(["b", "a"]);
  });
});

describe("versions", () => {
  it("parses versions", () => {
    expect(parseVersion("1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3, pre: "rc.1" });
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    for (const bad of ["v1.2.3", "1.2", "1.2.3.4", "", "1.2.3-"]) expect(parseVersion(bad)).toBeNull();
  });

  it("orders versions", () => {
    const sorted = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
    const shuffled = [...sorted].reverse().sort((a, b) => (a < b ? 1 : -1));
    expect([...shuffled].sort(compareVersions)).toEqual(sorted);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.2", "1.0.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-b", "1.0.0-a")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
  });

  it("throws for text that is not a version", () => {
    expect(() => compareVersions("x", "1.0.0")).toThrow("not a version: x");
    expect(() => compareVersions("1.0.0", "y")).toThrow("not a version: y");
  });

  it("checks the engine range", () => {
    expect(satisfiesEngine(">=3.2.0", "3.2.0")).toBe(true);
    expect(satisfiesEngine(">=3.2.0", "3.10.0")).toBe(true);
    expect(satisfiesEngine(">=3.2.0", "4.0.0")).toBe(true);
    expect(satisfiesEngine(">=3.2.0", "3.1.9")).toBe(false);
    expect(satisfiesEngine(">=3.2.0", "2.9.9")).toBe(false);
    expect(satisfiesEngine(">=3.2.0", "dev")).toBe(true);
    expect(satisfiesEngine(">=3.2.0", "")).toBe(true);
    expect(satisfiesEngine(">=3.3.0", "3.3.0-rc.1")).toBe(true);
    expect(satisfiesEngine(">=3.2", "3.2.0")).toBe(false);
    expect(satisfiesEngine(">=3.2.0", "abc")).toBe(false);
  });
});

describe("the mirrored lists", () => {
  it("agree with the engine", () => {
    expect([...COLUMN_TYPES]).toEqual([...SCALAR_COLUMN_TYPES, "list"]);
    expect([...COLUMN_ATTRS]).toEqual([...ENGINE_COLUMN_ATTRS]);
    expect([...BATCH_OPERATIONS]).toEqual([...ENGINE_BATCH]);
    for (const op of DATA_OPERATIONS) expect(BATCH_OPERATIONS).toContain(op);
  });
});

describe("the module API", () => {
  it("has a tool error the host recognises by name", () => {
    const e = new ExtensionToolError("m", "h", "tools#x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ToolError");
    expect(e.hint).toBe("h");
    expect(e.docs).toBe("tools#x");
  });

  it("types an extension and gives it back", () => {
    const m = { api: 1 as const, handlers: {} };
    expect(defineExtension(m)).toBe(m);
    expect(EXTENSION_API_VERSION).toBe(1);
  });

  it("publishes the subpath", () => {
    for (const name of ["defineExtension", "ExtensionToolError", "parseManifest", "extensionsHome", "codeDir", "tokenPath", "satisfiesEngine", "EXT_DOCS"]) {
      expect(typeof (entry as Record<string, unknown>)[name]).not.toBe("undefined");
    }
  });
});
