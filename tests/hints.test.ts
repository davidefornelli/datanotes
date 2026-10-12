/**
 * The standard every error follows (src/core/hints.ts for the engine, src/api/guidance.ts for the
 * client and the MCP server): what is wrong, how to fix it (`hint`), where to read more (`docs`).
 * Pure functions here; the engine's errors are in hints-engine.test.ts, an agent's mistakes over
 * the real MCP server in mcp-agent-mistakes.test.ts, the docs links in error-docs.test.ts.
 */

import { describe, expect, it } from "vitest";
import * as api from "../src/api/guidance";
import { OPERATIONS } from "../src/api/catalog";
import {
  closestNames,
  CONFLICTS,
  didYouMean,
  DOCS,
  DOCS_BASE,
  docsUrl,
  editDistance,
  guidanceOf,
  guide,
  GuidedError,
  nameList,
  refusalGuidance,
  sentences,
  undoGuidance,
  unknownColumn,
  unknownName,
  unknownOperator,
  unknownWriteColumn,
  violationGuidance,
} from "../src/core/hints";
import type { ViolationCode } from "../src/core/types-table";
import { DOCS_URL_RE } from "./helpers/guidance";

const OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "icontains", "exists", "within"];

describe("docs addresses", () => {
  it("are Markdown pages of datanotes.dev, the same base for the engine and the client", () => {
    expect(DOCS_BASE).toBe("https://datanotes.dev");
    expect(api.DOCS_BASE).toBe(DOCS_BASE);
    for (const topic of Object.keys(DOCS) as (keyof typeof DOCS)[]) expect(docsUrl(topic)).toMatch(DOCS_URL_RE);
    expect(api.toolDocs("insert_row")).toBe("https://datanotes.dev/reference/operations/rows.md#insert_row");
    expect(api.toolDocs("select_rows")).toBe("https://datanotes.dev/reference/operations/queries.md#select_rows");
    expect(api.toolDocs("nothing")).toBe(api.OPERATIONS_DOCS);
    expect(api.ERRORS_DOCS).toBe(docsUrl("errors"));
    expect(guide("Do this.", "filters")).toEqual({ hint: "Do this.", docs: "https://datanotes.dev/guides/read-and-write/read-and-filter.md#compare-values-with-operators" });
  });
});

describe("guidance on errors", () => {
  it("an error carries it as hint and docs; other values carry none", () => {
    const g = guide("Call list_tables.", "findTable");
    const e = new GuidedError("Table not found: flim", g);
    expect(e).toBeInstanceOf(Error);
    expect([e.message, e.hint, e.docs]).toEqual(["Table not found: flim", g.hint, g.docs]);
    expect(guidanceOf(e)).toEqual(g);
    const bare = new GuidedError("no guidance", null);
    expect([bare.hint, bare.docs]).toEqual([undefined, undefined]);
    expect(guidanceOf(bare)).toBeNull();
    expect(guidanceOf(new GuidedError("x"))).toBeNull();
    for (const v of [null, undefined, "text", 42, { hint: "only a hint" }, { hint: 1, docs: "x" }]) expect(guidanceOf(v)).toBeNull();
    expect(guidanceOf({ hint: "h", docs: "d", other: 1 })).toEqual({ hint: "h", docs: "d" });
  });

  it("the client reads it from an answer and appends it to the text an agent reads", () => {
    expect(api.guidanceIn({ error: "x", hint: "h", docs: "d" })).toEqual({ hint: "h", docs: "d" });
    for (const v of [null, "x", { error: "x" }, { hint: "h" }, { hint: "h", docs: 3 }]) expect(api.guidanceIn(v)).toBeNull();
    expect(api.guidedText("unknown column", { hint: "Use title.", docs: "https://datanotes.dev/x.md" })).toBe('unknown column\nHint: Use title.\nDocs: https://datanotes.dev/x.md (offline: read_docs("x"))');
    expect(api.guidedText("unknown column", { hint: "Use title.", docs: "https://example.com/x.md" })).toBe("unknown column\nHint: Use title.\nDocs: https://example.com/x.md");
    expect(api.localDocs("https://datanotes.dev/guides/read-and-write/read-and-filter.md#compare-values-with-operators")).toBe('read_docs("guides/read-and-write/read-and-filter#compare-values-with-operators")');
    expect(api.localDocs("https://datanotes.dev/guides/read-and-write/read-and-filter/")).toBeNull();
    expect(api.guidedText("plain", null)).toBe("plain");
  });
});

describe("did you mean", () => {
  it("measures edits, a swap of two letters being one", () => {
    expect(editDistance("title", "title")).toBe(0);
    expect(editDistance("Title", "title")).toBe(0);
    expect(editDistance("titel", "title")).toBe(1);
    expect(editDistance("flim", "film")).toBe(1);
    expect(editDistance("tile", "title")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("finds the same name in another case or spelling, then one that contains it, then one a few edits away", () => {
    const columns = ["title", "year", "minutes", "status", "rating", "watched_on", "subtitle"];
    expect(closestNames("TITLE", columns)).toEqual(["title"]);
    expect(closestNames("watched-on", columns)).toEqual(["watched_on"]);
    expect(closestNames("titel", columns)).toEqual(["title"]);
    expect(closestNames("watched", columns)).toEqual(["watched_on"]);
    expect(closestNames("minute", columns)).toEqual(["minutes"]);
    // the nearer of two names that contain it
    expect(closestNames("gtee", OPERATORS)).toEqual(["gte"]);
    // nothing close: nothing
    expect(closestNames("director", columns)).toEqual([]);
    expect(closestNames("", columns)).toEqual([]);
    // two equally close names are both given, at most `max`
    expect(closestNames("ab", ["ac", "ad", "ae", "af"])).toEqual(["ac", "ad", "ae"]);
    expect(closestNames("ab", ["ac", "ad", "ae"], { max: 2 })).toEqual(["ac", "ad"]);
    // a name one edit away hides one two edits away
    expect(closestNames("selct_rows", ["select_rows", "delete_rows"])).toEqual(["select_rows"]);
  });

  it("knows other words for a name (a table's aliases)", () => {
    const aliases = new Map([
      ["movies", "film"],
      ["watchlist", "film"],
    ]);
    expect(closestNames("Movies", ["film", "person"], { aliases })).toEqual(["film"]);
    // an alias and a close name of the same table count once
    expect(closestNames("watchlist", ["film", "watchlists"], { aliases })).toEqual(["film"]);
    expect(closestNames("", ["film"], { aliases: new Map([["", "film"]]) })).toEqual(["film"]);
  });

  it("asks about one, two or three names, or says nothing", () => {
    expect(didYouMean("titel", ["title", "year"])).toBe(`Did you mean "title"?`);
    expect(didYouMean("ab", ["ac", "ad"])).toBe(`Did you mean "ac" or "ad"?`);
    expect(didYouMean("ab", ["ac", "ad", "ae"])).toBe(`Did you mean "ac", "ad" or "ae"?`);
    expect(didYouMean("zzz", ["title"])).toBe("");
    expect(didYouMean("films", ["film"], { aliases: new Map([["films", "film"]]) })).toBe(`Did you mean "film"?`);
  });

  it("the client's matching is the engine's", () => {
    const names = ["select_rows", "delete_rows", "insert_row", "update_row", "update_rows", "list_tables", "describe_table", "title", "watched_on", "gt", "gte"];
    for (const input of ["selct_rows", "insertrow", "update-row", "UPDATE_ROWS", "list_table", "describe", "titel", "watched", "gtee", "zzz", "", "ab"]) {
      expect(api.closestNames(input, names), input).toEqual(closestNames(input, names));
      expect(api.didYouMean(input, names), input).toBe(didYouMean(input, names));
    }
    expect(api.closestNames("ab", ["ac", "ad", "ae", "af"], 2)).toEqual(["ac", "ad"]);
  });
});

describe("unknown names", () => {
  it("joins sentences and cuts long lists", () => {
    expect(sentences("A.", "", "B.")).toBe("A. B.");
    expect(sentences("", "")).toBe("");
    expect(nameList(["a", "b"])).toBe("a, b");
    const many = Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, "0")}`);
    expect(nameList(many)).toBe(`${many.slice(0, 25).join(", ")}, … (30 in all)`);
    expect(nameList(many, 2)).toBe("c00, c01, … (30 in all)");
  });

  it("names the closest one, lists them (sorted, once) and the operation that lists them all", () => {
    expect(unknownName("bse", ["thing", "base", "base"], "bases", "describe_database lists them.", "bases")).toEqual({
      hint: `Did you mean "base"? Bases: base, thing. describe_database lists them.`,
      docs: docsUrl("bases"),
    });
    expect(unknownName("x", [], "bases", "define_base makes one.", "bases").hint).toBe("There are no bases yet. define_base makes one.");
    expect(unknownName("films", ["film"], "tables", "list_tables lists them.", "findTable", new Map([["films", "film"]])).hint).toBe(`Did you mean "film"? Tables: film. list_tables lists them.`);
  });

  it("a column: the table's columns and describe_table; for a write, also add_column", () => {
    expect(unknownColumn("titel", ["title", "year"], "main.public.film")).toEqual({
      hint: `Did you mean "title"? Columns of main.public.film: title, year. describe_table("main.public.film") lists them with their types and allowed values.`,
      docs: docsUrl("describeTable"),
    });
    expect(unknownColumn("x", ["title"], "t", "select").docs).toBe(docsUrl("select"));
    expect(unknownWriteColumn("titel", ["title"], "main.public.film").hint).toMatch(/lists them with their types and allowed values\. To keep a new front matter key, add_column first\.$/);
  });
});

describe("unknown operators", () => {
  it("names the operator meant, for other words and for typos, then every operator and the shape", () => {
    const g = unknownOperator([">=", "LIKE", "gtee", "nonsense"], OPERATORS);
    expect(g.docs).toBe(docsUrl("filters"));
    expect(g.hint).toBe(
      `For ">=" use "gte". For "LIKE" use "icontains" (case-insensitive substring). For "gtee" use "gte". ` +
        `Write a condition as {"<column>": value} (equals) or {"<column>": {"<operator>": value}}; the operators are ${OPERATORS.join(", ")}; combine conditions with "and", "or", "not".`,
    );
    // names every object has are no synonyms
    expect(unknownOperator(["constructor"], OPERATORS).hint).toMatch(/^Write a condition/);
    expect(unknownOperator([], OPERATORS).hint).toMatch(/^Write a condition/);
    expect(unknownOperator(["$in", "not_in", "between", "is_null", "not_null", "!="], OPERATORS).hint).toMatch(
      /^For "\$in" use "in"\. For "not_in" use \{"not": \{"<column>": \{"in": \[\.\.\.\]\}\}\}\. For "between" use "gte" and "lte" together: .+ For "is_null" use \{"exists": false\}\. For "not_null" use \{"exists": true\}\. For "!=" use "ne"\./,
    );
  });
});

describe("refusals", () => {
  const CODES: ViolationCode[] = ["required", "inverse", "type", "min", "max", "step", "enum", "broken_link", "ref", "unique", "unknown_column", "check", "generated", "cycle", "vocabulary", "unreadable"];

  it("every kind of violation says what to do and links its page", () => {
    for (const code of CODES) {
      const g = violationGuidance(code);
      expect(g.hint.length, code).toBeGreaterThan(20);
      expect(g.docs, code).toMatch(DOCS_URL_RE);
    }
    expect(violationGuidance("check").docs).toBe(docsUrl("check"));
    expect(violationGuidance("enum").docs).toBe(docsUrl("enumValues"));
    expect(violationGuidance("unreadable")).toEqual({ hint: expect.stringContaining("fix the YAML"), docs: docsUrl("unreadable") });
  });

  it("a refusal joins the hints of its first three kinds of violation, once each, and links the first", () => {
    const rv = (...codes: ViolationCode[]) => ({ path: "x.md", violations: codes.map((code) => ({ code })) });
    const g = refusalGuidance({ op: "insert_row", violations: [rv("enum", "min"), rv("max", "enum", "check", "type")] });
    expect(g.docs).toBe(docsUrl("enumValues"));
    // min and max give the same hint: it is there once; "check" (the fourth kind) is left out
    expect(g.hint).toBe(`${violationGuidance("enum").hint} ${violationGuidance("min").hint} Then call insert_row again (dry_run: true checks without writing).`);
  });

  it("a conflict says what it usually means; a failed write how to revert it", () => {
    const messages: [string, keyof typeof DOCS][] = [
      ['row changed: expected status = "to watch", found "watched" — read it again', "expect"],
      ['"where" matched 2 rows, expected 1: nothing was written', "updateRows"],
      ["referenced by People/Ada.md", "referenced"],
      ["linked from a.md, which must link to a row of x: change or clear those links first", "referenced"],
      ['"film" is required and would be left empty: change or delete this row first, or use on_referenced "ignore"', "referenced"],
      ["violates CHECK rated_when_watched", "check"],
      ["CHECK rated reads film.rating: drop or change it first", "check"],
      ['table has 3 rows; pass mode: "archive" to archive them with the table', "dropTable"],
      ["note already exists", "sameNameCase"],
      ['note already exists in another case: "Films/Metropolis.md" (one file on Windows and macOS)', "sameNameCase"],
      ["main.public.film already exists", "catalogs"],
      ["main.public.film is a table", "catalogs"],
      ['repeats key ["Metropolis"]', "merge"],
      ['2 rows match key ["Metropolis"]', "merge"],
      ["already a row of main.public.film: use move_rows", "moveRows"],
    ];
    for (const [message, topic] of messages) expect(refusalGuidance({ op: "update_row", conflicts: [{ message }] }).docs, message).toBe(docsUrl(topic));
    expect(CONFLICTS).toHaveLength(10);
    expect(refusalGuidance({ op: "insert_row", conflicts: [{ message: "note already exists" }] }).hint).toMatch(/another case .* update_row\. Then call insert_row again\.$/);
    expect(refusalGuidance({ op: "update_row", conflicts: [{ message: 'row changed: expected x = 1, found 2 — read it again' }] }).hint).toContain("retry update_row");
    expect(refusalGuidance({ op: "move_rows", conflicts: [{ message: "target exists: a.md" }] })).toEqual(
      guide("Resolve what the message names, then call move_rows again; dry_run: true checks without writing.", "errors"),
    );
    expect(refusalGuidance({ op: "drop_column" })).toEqual(guide("Resolve what the message names, then call drop_column again; dry_run: true checks without writing.", "errors"));
    expect(refusalGuidance({ op: "update_rows", conflicts: [], violations: [], failed: [{ path: "a.md" }] }).docs).toBe(docsUrl("undo"));
    // a write that failed partway: rolled back by the engine, or not even that
    expect(refusalGuidance({ op: "update_rows", failed: [{ path: "a.md" }], rolled_back: true })).toEqual(
      guide("A file could not be written (another program may hold it): the engine put back what it had written, so nothing changed. Close that program, then call update_rows again.", "failedWrite"),
    );
    expect(refusalGuidance({ op: "update_rows", failed: [{ path: "a.md" }], rolled_back: false }).docs).toBe(docsUrl("rollbackFailed"));
  });

  it("an undo says whether it is undone already, blocked by later changes, or half written", () => {
    expect(undoGuidance({ conflicts: [{ message: "migration already undone" }], failed: [] }).hint).toMatch(/^This write is undone already/);
    expect(undoGuidance({ conflicts: [{ message: '"rating" changed since the operation' }], failed: [] }).docs).toBe(docsUrl("undoConflict"));
    expect(undoGuidance({ conflicts: [], failed: [{ path: "a.md" }] }).hint).toMatch(/^Some files could not be written back/);
  });
});

describe("a tool's arguments", () => {
  it("checks a value against a type", () => {
    expect(api.typeOk("x", {})).toBe(true);
    expect(api.typeOk(1, { type: ["string", "integer"] })).toBe(true);
    expect(api.typeOk(1.5, { type: ["string", "integer"] })).toBe(false);
    expect(api.typeOk("x", { type: "null" })).toBe(false);
    expect(api.typeOk({}, { anyOf: [{ type: "array" }, { type: "object" }] })).toBe(true);
    expect(api.checkArguments("insert_row", { table: { name: "film" }, values: {} })!.message).toBe('insert_row: "table" must be a string, not an object');
    expect(api.didYouMean("titel", ["title"])).toBe('Did you mean "title"?');
    expect(api.didYouMean("ab", ["ac", "ad"])).toBe('Did you mean "ac" or "ad"?');
  });

  it("names each type in words", () => {
    expect(api.typeName({ type: "string" })).toBe("string");
    expect(api.typeName({ type: ["integer", "null"] })).toBe("integer");
    expect(api.typeName({ type: "null" })).toBe("null");
    expect(api.typeName({})).toBe("any");
    expect(api.typeName({ type: "array", items: { type: "string" } })).toBe("list of strings");
    expect(api.typeName({ type: "array" })).toBe("list");
    expect(api.typeName({ anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { type: "null" }] })).toBe("string or list of strings");
  });

  it("lists an operation's arguments, the required ones marked", () => {
    expect(api.argumentsOf("insert_row")).toMatch(/^table \(string, required\), values \(object, required\), /);
    expect(api.argumentsOf("list_tables")).toBe("no arguments");
    expect(api.argumentsOf("no_such_operation")).toBe("no arguments");
  });

  it("accepts right arguments, and null for an optional or required one is not given", () => {
    expect(api.checkArguments("select_rows", { table: "film", where: { status: "watched" }, limit: 10, columns: ["title"], include_body: false, order_by: "title" })).toBeNull();
    expect(api.checkArguments("select_rows", { table: "film", limit: null, offset: undefined })).toBeNull();
    expect(api.checkArguments("no_such_operation", { anything: 1 })).toBeNull();
    // any tool, from its own schema (the docs tools): a schema without arguments takes none
    expect(api.checkToolArguments("my_tool", {}, { x: 1 }, "https://example.com/my-tool")).toEqual({ message: 'my_tool: unknown argument "x"', hint: "my_tool takes: no arguments.", docs: "https://example.com/my-tool" });
    // every operation's own example of required arguments passes
    for (const op of OPERATIONS) {
      const schema = op.inputSchema as { required?: string[]; properties?: Record<string, { type?: string }> };
      const args = Object.fromEntries((schema.required ?? []).map((k) => [k, sample(schema.properties![k]!)]));
      expect(api.checkArguments(op.name, args), op.name).toBeNull();
    }
  });

  it("refuses unknown names (with the one meant), missing required ones and values of the wrong type", () => {
    const p = api.checkArguments("select_rows", { tabel: "film", limit: "10", columns: "title", where: [], include_body: "yes", min_score: 1, extra: true })!;
    expect(p.message).toBe(
      'select_rows: unknown argument "tabel"; unknown argument "min_score"; unknown argument "extra"; missing required argument "table" (string); "limit" must be an integer, not string "10"; "columns" must be a list of strings, not string "title"; "where" must be an object, not a list; "include_body" must be a boolean, not string "yes"',
    );
    expect(p.hint).toMatch(/^For "tabel" use "table"\. select_rows takes: table \(string, required\), /);
    expect(p.docs).toBe(api.toolDocs("select_rows"));
    expect(api.checkArguments("insert_row", { table: "film", values: { x: 1 }, path: 7 })!.message).toBe('insert_row: "path" must be a string, not number 7');
    expect(api.checkArguments("select_rows", { table: "film", limit: 2.5 })!.message).toBe('select_rows: "limit" must be an integer, not number 2.5');
    expect(api.checkArguments("semantic_search", { query: "x", min_score: Infinity })!.message).toBe('semantic_search: "min_score" must be a number, not number Infinity');
    expect(api.checkArguments("insert_row", { table: "film", values: ["x"] })!.message).toBe('insert_row: "values" must be an object, not a list');
    expect(api.checkArguments("insert_row", { values: {} })!.message).toBe('insert_row: missing required argument "table" (string)');
  });

  it("an unknown tool: the closest one the agent may call", () => {
    expect(api.unknownTool("select_row", ["select_rows", "insert_row"])).toEqual({
      message: "unknown tool: select_row",
      hint: `Did you mean "select_rows"? tools/list (MCP) and the reference list every operation with its arguments.`,
      docs: "https://datanotes.dev/reference/operations.md",
    });
    expect(api.unknownTool("pick_film", ["select_rows"]).hint).toBe("tools/list (MCP) and the reference list every operation with its arguments.");
  });
});

/** A value of a schema's type. */
function sample(s: { type?: string; anyOf?: { type?: string }[] }): unknown {
  const type = s.type ?? s.anyOf?.find((x) => x.type !== "null")?.type;
  return { string: "x", integer: 1, number: 1, boolean: true, array: [], object: {} }[type as "string"];
}
