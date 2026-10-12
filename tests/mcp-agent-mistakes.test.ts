/**
 * An agent makes mistakes, through the real MCP server (`datanotes mcp`, stdio) on a real engine
 * with a film diary: every error it gets back says what is wrong, how to fix it (the allowed
 * values, the closest real name, the right shape) and where to read more (a Markdown page of the
 * docs, with its anchor). The standard is src/core/hints.ts; the page for agents is
 * docs/src/content/docs/guides/agents/reading-errors.md.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatanotesClient } from "../src/api/client";
import { INDEX_RETRY } from "../src/core/engine";
import { mcp, type McpRun } from "../src/mcp/command";
import { startService, type RunningService } from "../src/node/service";
import { docsOfText, hintOfText, messageOfText } from "./helpers/guidance";
import { fakeIo, StreamClientTransport, type FakeIo } from "./helpers/mcp";
import { freePort } from "./helpers/test-vault";
import { seedStoreSettings } from "./helpers/store-settings";

INDEX_RETRY.delayMs = 1;

const TOKEN = "film-diary-owner-token";
const DOCS = "https://datanotes.dev";
let root = "";
let svc: RunningService;
let run: McpRun;
let io: FakeIo;
let agent: Client;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dn-agent-mistakes-"));
  const port = await freePort();
  seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false });
  svc = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
  const url = `http://127.0.0.1:${port}`;
  // the film diary of the docs' examples, made with the engine's operations
  const owner = new DatanotesClient({ url, token: TOKEN });
  const ok = async (op: string, args: Record<string, unknown>) => expect((await owner.call(op, args)).ok, op).toBe(true);
  await ok("create_table", {
    name: "film",
    columns: [
      { name: "title", type: "string", required: true, unique: true, description: "The film's title, as on its poster" },
      { name: "year", type: "integer", description: "Year the film first came out" },
      { name: "minutes", type: "integer", min: 1, description: "Running time in minutes" },
      { name: "status", type: "enum", values: ["to watch", "watched"], ordered: true, default: "to watch", description: "Where the film is on my list" },
      { name: "rating", type: "integer", min: 1, max: 5, description: "My rating, from 1 to 5" },
      { name: "watched_on", type: "date", description: "The day I last watched it" },
    ],
    filename: "{title}",
    description: "Classic films I watched or want to watch",
    aliases: ["films", "movies", "watchlist"],
  });
  await ok("alter_column", { table: "film", column: "status", changes: { value_descriptions: { "to watch": "on the list, not seen yet", watched: "seen at least once" } } });
  await ok("add_constraint", { table: "film", name: "rated_when_watched", check: { or: [{ status: "watched" }, { rating: { exists: false } }] } });
  await ok("insert_row", { table: "film", values: { title: "Metropolis", year: 1927, minutes: 153 } });

  io = fakeIo({ DATANOTES_TOKEN: TOKEN });
  run = (await mcp(["--url", url], "9.9.9", io))!;
  agent = new Client({ name: "careless-agent", version: "1" });
  await agent.connect(new StreamClientTransport(io.stdin, io.stdout));
}, 60_000);

afterAll(async () => {
  await agent?.close();
  await run?.stop();
  await svc?.stop();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Call a tool that must fail: the text the agent reads, split in message, hint and docs. */
async function mistake(name: string, args: Record<string, unknown>): Promise<{ text: string; message: string; hint: string; docs: string }> {
  const r = (await agent.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content.map((c) => c.text).join("\n");
  expect(r.isError, `${name} should fail: ${text}`).toBe(true);
  // every error ends with how to fix it and the read_docs call of a page of the docs
  expect(text).toMatch(/\nHint: [^\n]+\nDocs: read_docs\("[a-z0-9\/_#-]+"\)$/);
  return { text, message: messageOfText(text), hint: hintOfText(text), docs: docsOfText(text) };
}

describe("an agent's mistakes, as the MCP server answers them", () => {
  it("a wrong operator in a view's where: the valid operators, the one meant, and the filters page", async () => {
    const e = await mistake("create_view", { name: "vw_good_films", query: { table: "film", where: { rating: { ">=": 4 } } } });
    expect(e.message).toContain(`where "rating": unknown operator ">="`);
    expect(e.hint).toContain(`For ">=" use "gte".`);
    expect(e.hint).toContain("the operators are eq, ne, gt, gte, lt, lte, in, contains, icontains, exists, within");
    expect(e.docs).toBe(`${DOCS}/guides/read-and-write/read-and-filter.md#compare-values-with-operators`);
    // a typo of an operator gets the closest one
    expect((await mistake("select_rows", { table: "film", where: { rating: { gtee: 4 } } })).hint).toContain(`For "gtee" use "gte".`);
  });

  it("an enum value that is not allowed: the allowed values with their meaning", async () => {
    const e = await mistake("insert_row", { table: "film", values: { title: "Nosferatu", status: "seen" } });
    expect(e.message).toContain("status must be one of: to watch (on the list, not seen yet); watched (seen at least once)");
    expect(e.hint).toContain("Use one of the allowed values listed in the message");
    expect(e.hint).toContain("describe_table");
    expect(e.docs).toBe(`${DOCS}/guides/database-objects/columns.md#describe-what-each-enum-value-means`);
  });

  it("an unknown column: the closest real one, the columns, and describe_table", async () => {
    const e = await mistake("insert_row", { table: "film", values: { titel: "Nosferatu" } });
    expect(e.message).toBe(`unknown column "titel" for table "film"`);
    expect(e.hint).toMatch(/^Did you mean "title"\? Columns of main\.public\.film: .*minutes.*rating.*title.*\. describe_table\("main\.public\.film"\) lists them/);
    expect(e.hint).toContain("add_column");
    expect(e.docs).toBe(`${DOCS}/guides/database-objects/tables.md#describe-a-table-before-writing-to-it`);
  });

  it("a value of the wrong type: the type the column takes", async () => {
    const e = await mistake("insert_row", { table: "film", values: { title: "Nosferatu", minutes: "ninety-four" } });
    expect(e.message).toContain("minutes expected a number");
    expect(e.hint).toContain("numbers unquoted, dates as YYYY-MM-DD");
    expect(e.docs).toBe(`${DOCS}/guides/database-objects/tables.md#create-a-table-with-typed-columns`);
    // an argument of the wrong type never reaches the engine
    const arg = await mistake("insert_row", { table: "film", values: "title=Nosferatu" });
    expect(arg.message).toBe(`insert_row: "values" must be an object, not string "title=Nosferatu"`);
    expect(arg.docs).toBe(`${DOCS}/reference/operations/rows.md#insert_row`);
  });

  it("a missing required argument: the tool's arguments and its reference", async () => {
    const e = await mistake("insert_row", { values: { title: "Nosferatu" } });
    expect(e.message).toBe(`insert_row: missing required argument "table" (string)`);
    expect(e.hint).toMatch(/^insert_row takes: table \(string, required\), values \(object, required\), /);
    expect(e.docs).toBe(`${DOCS}/reference/operations/rows.md#insert_row`);
  });

  it("a misspelled table: the closest table, by name or alias, and list_tables", async () => {
    const typo = await mistake("select_rows", { table: "flim" });
    expect(typo.message).toBe("Table not found: flim");
    expect(typo.hint).toBe(`Did you mean "film"? Tables: film. list_tables lists them with their descriptions and aliases.`);
    expect(typo.docs).toBe(`${DOCS}/guides/database-objects/tables.md#find-the-table-that-matches-a-request`);
    // an alias of the table names it
    expect((await mistake("insert_row", { table: "movies", values: { title: "Nosferatu" } })).hint).toMatch(/^Did you mean "film"\?/);
  });

  it("a misspelled argument of a tool: the argument meant", async () => {
    const e = await mistake("select_rows", { table: "film", wehre: { status: "watched" } });
    expect(e.message).toBe(`select_rows: unknown argument "wehre"`);
    expect(e.hint).toMatch(/^For "wehre" use "where"\. select_rows takes: table \(string, required\), columns \(list of strings\), where \(object\), /);
    expect(e.docs).toBe(`${DOCS}/reference/operations/queries.md#select_rows`);
  });

  it("update_row on a path that does not exist: the row meant and how to find rows", async () => {
    const e = await mistake("update_row", { table: "film", path: "Films/Metropoliss.md", set: { rating: 5 } });
    expect(e.message).toBe("film has no row at Films/Metropoliss.md");
    expect(e.hint).toMatch(/^Did you mean "datanotes\/main\/public\/film\/Metropolis\.md"\? Name the row by its "path"/);
    expect(e.hint).toContain("select_rows");
    expect(e.docs).toBe(`${DOCS}/guides/read-and-write/write-rows.md#update-one-row`);
  });

  it("a CHECK refusal: the rule broken and how to read the table's rules", async () => {
    const e = await mistake("insert_row", { table: "film", values: { title: "Nosferatu", rating: 5 } });
    expect(e.message).toContain("insert_row refused — nothing was written");
    expect(e.message).toContain("violates CHECK rated_when_watched");
    expect(e.hint).toContain("The row breaks a CHECK constraint of the table");
    expect(e.hint).toContain("describe_table lists the table's constraints");
    expect(e.docs).toBe(`${DOCS}/guides/data-quality/check-constraints.md#enforce-rules-with-check-constraints`);
  });

  it("a table and columns without descriptions: every missing one, the shape with each in place", async () => {
    const e = await mistake("create_table", {
      name: "watch",
      time_column: "occurred_at",
      columns: [
        { name: "film", type: "link", ref: "main.public.film", required: true },
        { name: "occurred_at", type: "datetime", required: true },
        { name: "where", type: "enum", values: ["cinema", "home"], description: "The kind of place I watched it in" },
      ],
    });
    expect(e.message).toBe("descriptions are required: main.public.watch has none for the table and columns film, occurred_at");
    expect(e.hint).toBe(
      `Say what a row records in "description" and what each column holds in its own "description": {"name": "watch", "description": "<what a row of watch records>", "columns": [{"name": "film", "type": "link", "description": "<what film holds>"}, …]}. Agents and people understand the schema through them.`,
    );
    expect(e.docs).toBe(`${DOCS}/guides/database-objects/tables.md#describe-every-table-and-column`);
    // a description changes, never goes
    const removed = await mistake("alter_column", { table: "film", column: "year", changes: { description: "" } });
    expect(removed.message).toBe("the description of column year of main.public.film cannot be removed (null or empty): every column needs one");
    expect(removed.docs).toBe(`${DOCS}/guides/database-objects/tables.md#describe-every-table-and-column`);
  });

  it("a tool that does not exist: the closest tool", async () => {
    const e = await mistake("select_row", { table: "film" });
    expect(e.message).toBe("unknown tool: select_row");
    expect(e.hint).toMatch(/^Did you mean "select_rows"\? /);
    expect(e.docs).toBe(`${DOCS}/reference/operations.md`);
  });

  it("a write to a view: it is a view, read it, write to its table", async () => {
    expect((await agent.callTool({ name: "create_view", arguments: { name: "vw_watchlist", query: { table: "film", where: { status: "to watch" } } } })).isError).toBeFalsy();
    const e = await mistake("insert_row", { table: "vw_watchlist", values: { title: "Nosferatu" } });
    expect(e.message).toBe("Table not found: vw_watchlist");
    expect(e.hint).toBe("main.public.vw_watchlist is a view: read it with select_rows; it cannot be written or changed like a table. Write to its table, film, instead (describe_table shows it).");
    expect(e.docs).toBe(`${DOCS}/guides/database-objects/views.md#store-a-query-as-a-view`);
  });
});
