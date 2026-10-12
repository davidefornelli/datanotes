/**
 * The docs tools of `datanotes mcp` (list_docs, read_docs, search_docs) over the stdio MCP server,
 * run in the test's process (helpers/mcp.ts) on the docs of helpers/docs-fixture.ts
 * (DATANOTES_DOCS_DIR). They need no engine: the server points to an address where none runs.
 */

import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_INSTRUCTIONS } from "../src/api/mcp";
import { DocsLibrary, READ_DOCS_MAX } from "../src/api/docs";
import { mcp, type McpRun } from "../src/mcp/command";
import { Toolbox } from "../src/mcp/tools";
import { docsFixture } from "./helpers/docs-fixture";
import { hintOfText, offlineGuidedTextOf } from "./helpers/guidance";
import { collector, fakeIo, StreamClientTransport } from "./helpers/mcp";
import { freePort } from "./helpers/test-vault";

let dir = "";
let engine = "";
const runs: McpRun[] = [];

beforeAll(async () => {
  dir = docsFixture();
  engine = `http://127.0.0.1:${await freePort()}`;
});

afterEach(async () => {
  for (const r of runs.splice(0)) await r.stop();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

async function agent(env: Record<string, string> = { DATANOTES_DOCS_DIR: dir }): Promise<Client> {
  const io = fakeIo({ DATANOTES_TOKEN: "no-engine-needed", ...env });
  const r = (await mcp(["--url", engine], "9.9.9", io))!;
  runs.push(r);
  const client = new Client({ name: "docs-agent", version: "1" });
  await client.connect(new StreamClientTransport(io.stdin, io.stdout));
  return client;
}

describe("datanotes mcp: the docs tools over stdio", () => {
  it("lists them next to the engine's operations, and the instructions name them", async () => {
    const client = await agent();
    const tools = (await client.listTools()).tools;
    expect(tools.slice(-3).map((t) => t.name)).toEqual(["list_docs", "read_docs", "search_docs"]);
    expect(tools.find((t) => t.name === "read_docs")!.annotations).toMatchObject({ readOnlyHint: true });
    expect(client.getInstructions()).toBe(ENGINE_INSTRUCTIONS);
    expect(ENGINE_INSTRUCTIONS).toContain("search_docs and read_docs");
  });

  it("list_docs, read_docs (a page, a section) and search_docs, with no engine running", async () => {
    const client = await agent();
    const list = await client.callTool({ name: "list_docs", arguments: { prefix: "examples/" } });
    expect(text(list)).toBe('1 pages. Read one with read_docs("<path>").\nexamples/queries: Querying rows — Read rows with select_rows: filters, operators and views.');
    const page = await client.callTool({ name: "read_docs", arguments: { path: "examples/queries" } });
    expect(text(page)).toBe(fs.readFileSync(path.join(dir, "examples", "queries.md"), "utf8"));
    const section = await client.callTool({ name: "read_docs", arguments: { path: "examples/queries#store-a-query-as-a-view" } });
    expect(text(section)).toBe("## Store a query as a view\n\n`create_view` stores a select_rows query under a name.\n");
    const found = await client.callTool({ name: "search_docs", arguments: { query: "compare values with operators", limit: 3 } });
    expect(text(found).split("\n")[0]).toBe("examples/queries#compare-values-with-operators — Querying rows › Compare values with operators");
  });

  it("an unknown page: an error result with the closest page, list_docs and the docs of the tools", async () => {
    const client = await agent();
    const r = await client.callTool({ name: "read_docs", arguments: { path: "examples/query" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toEqual(offlineGuidedTextOf('no docs page "examples/query"'));
    expect(hintOfText(text(r))).toBe('Did you mean "examples/queries"? list_docs lists the pages (list_docs("guides/") those of a folder); search_docs finds the sections on a topic.');
    const s = await client.callTool({ name: "read_docs", arguments: { path: "examples/queries", section: "store-a-view" } });
    expect(hintOfText(text(s))).toMatch(/^Did you mean "examples\/queries#store-a-query-as-a-view"\?/);
  });

  it("a long page is cut, with how to read the rest", async () => {
    const client = await agent();
    const first = text(await client.callTool({ name: "read_docs", arguments: { path: "reference/tools" } }));
    const m = /\n\[Cut at character (\d+) of (\d+)\. Read on with read_docs\("reference\/tools", offset: \1\)\. One section at a time: read_docs\("reference\/tools#(op_\d+)"\)/.exec(first)!;
    expect(Number(m[1])).toBeLessThanOrEqual(READ_DOCS_MAX);
    const next = text(await client.callTool({ name: "read_docs", arguments: { path: "reference/tools", offset: Number(m[1]) } }));
    expect(next).toMatch(new RegExp(`^## \`${m[3]}\``));
  });

  it("without the docs: says how to build them; the calls are logged (a Toolbox with its own docs)", async () => {
    const logs = collector();
    const toolbox = new Toolbox(engine, logs.exporter.log.bind(logs.exporter), new DocsLibrary(null));
    const actor = { harness: "docs-agent", harness_version: "1", session: "s-1" };
    const missing = await toolbox.call("t", "list_docs", {}, actor);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^the Datanotes docs are not in this installation\nHint: .*cd docs && npm ci && npm run build/);
    const withDocs = new Toolbox(engine, logs.exporter.log.bind(logs.exporter), new DocsLibrary(dir));
    expect(text(await withDocs.call("t", "read_docs", { path: "index" }, actor))).toMatch(/^# Datanotes/);
    const records = await logs.records();
    expect(records.map((r) => [r.severity, r.body])).toEqual([
      ["WARN", expect.stringMatching(/^tool list_docs: failed \(\d+ ms\)$/)],
      ["INFO", expect.stringMatching(/^tool read_docs: ok \(\d+ ms\)$/)],
    ]);
    expect(records[0]!.attributes).toMatchObject({ tool: "list_docs", ok: false, harness: "docs-agent", session: "s-1" });
    expect(records[1]!.attributes).toMatchObject({ tool: "read_docs", ok: true, arg_names: "path" });
    expect(records[1]!.attributes.error).toBeUndefined();
  });
});
