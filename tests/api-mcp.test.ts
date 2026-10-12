/**
 * `datanotes/mcp` (src/api/mcp.ts): the engine's operations as MCP tool definitions, for people who
 * build their own MCP server. Unit tests on a fake transport, then a server of one's own (the
 * example of the docs' "Build on Datanotes" page) built with the MCP SDK on a real engine.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";
import { ACTOR_HEADER, DatanotesClient, type HttpRequest, type HttpResponse, type Transport } from "../src/api/client";
import { DocsLibrary } from "../src/api/docs";
import { callDocsTool, callEngineTool, docsTools, ENGINE_INSTRUCTIONS, engineTools, isDocsTool, isEngineTool, offlineDocs, toolContent } from "../src/api/mcp";
import { startService, type RunningService } from "../src/node/service";
import { METASTORE, withTables } from "./helpers/db-vault";
import { guidedTextOf } from "./helpers/guidance";
import { seedStoreSettings } from "./helpers/store-settings";

const ENGINE = "http://engine.test:27199";
const TOKEN = "tok-0123456789abcdef";

function fake(answer: (req: HttpRequest) => HttpResponse | Error = () => ({ status: 200, text: "{}" })) {
  const sent: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    sent.push(req);
    const a = answer(req);
    if (a instanceof Error) throw a;
    return a;
  };
  return { sent, client: new DatanotesClient({ url: ENGINE, token: TOKEN, actor: { harness: "film-night" }, transport }) };
}

const json = (status: number, body: unknown): HttpResponse => ({ status, text: JSON.stringify(body) });

describe("engineTools", () => {
  it("lists every operation of the catalogue as an MCP tool definition, without the response schema", () => {
    const tools = engineTools();
    expect(tools.map((t) => t.name)).toEqual(OPERATIONS.map((o) => o.name));
    const select = tools.find((t) => t.name === "select_rows")!;
    const op = OPERATIONS.find((o) => o.name === "select_rows")!;
    expect(select).toEqual({ name: op.name, description: op.description, inputSchema: op.inputSchema, annotations: op.annotations });
    expect(Object.keys(select)).toEqual(["name", "description", "inputSchema", "annotations"]);
  });

  it("destructiveHint: true for every write that may overwrite or remove existing data; false for reads and purely additive writes", () => {
    // writes that only add (a table, a column, a row, a CHECK, a copy of a table): a new one is
    // destructive unless it is added here on purpose
    const ADDITIVE = new Set(["create_table", "add_column", "insert_row", "add_constraint", "clone_table"]);
    for (const t of [...engineTools(), ...docsTools()]) {
      const { readOnlyHint, destructiveHint } = t.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean };
      const expected = readOnlyHint === true ? false : !ADDITIVE.has(t.name);
      expect({ tool: t.name, destructiveHint }).toEqual({ tool: t.name, destructiveHint: expected });
    }
    for (const name of ["configure_database", "create_webhook", "drop_constraint", "update_rows", "update_row", "merge_rows", "rename_value", "delete_rows", "undo_migration"]) {
      expect(OPERATIONS.find((o) => o.name === name)!.annotations.destructiveHint).toBe(true);
    }
    for (const name of ADDITIVE) expect(OPERATIONS.find((o) => o.name === name)!.annotations.readOnlyHint).toBe(false);
  });

  it("keeps only the names asked for, in the catalogue's order, and leaves out the excepted ones", () => {
    expect(engineTools({ only: ["select_rows", "list_tables", "describe_table"] }).map((t) => t.name)).toEqual(
      OPERATIONS.map((o) => o.name).filter((n) => ["select_rows", "list_tables", "describe_table"].includes(n)),
    );
    const without = engineTools({ except: ["drop_table", "delete_rows"] }).map((t) => t.name);
    expect(without).toHaveLength(OPERATIONS.length - 2);
    expect(without).not.toContain("drop_table");
    expect(engineTools({ only: ["select_rows", "drop_table"], except: ["drop_table"] }).map((t) => t.name)).toEqual(["select_rows"]);
    expect(engineTools({ only: [] })).toEqual([]);
  });

  it("refuses a name that is no engine tool, so a typo shows at once", () => {
    expect(() => engineTools({ only: ["select_row"] })).toThrow(`only: "select_row" is not an engine tool`);
    expect(() => engineTools({ except: ["pick_film_for_tonight"] })).toThrow(`except: "pick_film_for_tonight" is not an engine tool`);
  });

  it("gives copies: changing one changes neither the catalogue nor the next list", () => {
    const [first] = engineTools({ only: ["select_rows"] });
    first!.description = "changed";
    (first!.inputSchema as { properties: Record<string, unknown> }).properties.table = { type: "number" };
    const again = engineTools({ only: ["select_rows"] })[0]!;
    expect(again.description).toBe(OPERATIONS.find((o) => o.name === "select_rows")!.description);
    expect((again.inputSchema as { properties: Record<string, { type: string }> }).properties.table!.type).toBe("string");
  });
});

describe("isEngineTool", () => {
  it("knows the engine's tools, filtered when a filter is given", () => {
    expect(isEngineTool("select_rows")).toBe(true);
    expect(isEngineTool("pick_film_for_tonight")).toBe(false);
    expect(isEngineTool("select_rows", { only: ["select_rows"] })).toBe(true);
    expect(isEngineTool("insert_row", { only: ["select_rows"] })).toBe(false);
    expect(isEngineTool("drop_table", { except: ["drop_table"] })).toBe(false);
    // a filter does not make another name an engine tool
    expect(isEngineTool("pick_film_for_tonight", { only: ["pick_film_for_tonight"] })).toBe(false);
  });
});

describe("toolContent", () => {
  it("a refusal is an error text; an object is also structured content; text and arrays are text only", () => {
    expect(toolContent(false, "refused")).toEqual({ content: [{ type: "text", text: "refused" }], isError: true });
    expect(toolContent(true, { a: 1 })).toEqual({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } });
    expect(toolContent(true, "plain")).toEqual({ content: [{ type: "text", text: "plain" }] });
    expect(toolContent(true, [1])).toEqual({ content: [{ type: "text", text: "[1]" }] });
    expect(toolContent(true, null)).toEqual({ content: [{ type: "text", text: "null" }] });
  });
});

describe("offlineDocs", () => {
  it("keeps only the read_docs call on each docs line of an error, for a server that serves the docs tools", async () => {
    const refused = fake(() => json(403, { error: "token film-night may not write main.public.actor", hint: "Ask the owner.", docs: "https://datanotes.dev/guides/security/tokens.md#choose-what-a-token-can-do" }));
    const r = offlineDocs(await callEngineTool(refused.client, "update_rows", { table: "actor", where: {}, set: { born: "1906-03-17" } }));
    expect(r).toEqual({
      content: [{ type: "text", text: 'token film-night may not write main.public.actor\nHint: Ask the owner.\nDocs: read_docs("guides/security/tokens#choose-what-a-token-can-do")' }],
      isError: true,
    });
    // a docs tool's own error too; a library without the docs answers the same in any checkout
    const missing = offlineDocs(await callDocsTool("read_docs", { path: "no/such-page" }, { docs: new DocsLibrary(null) }));
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/\nDocs: read_docs\("guides\/agents\/docs-offline#[a-z0-9-]+"\)$/);
    expect(missing.content[0]!.text).not.toContain("https://datanotes.dev/guides/agents/docs-offline.md");
  });

  it("leaves a result, and an address that is no page of the docs, as they are", () => {
    const ok = toolContent(true, { text: "Docs: https://datanotes.dev/x.md (offline: read_docs(\"x\"))" });
    expect(offlineDocs(ok)).toBe(ok);
    const elsewhere = toolContent(false, "x\nHint: y\nDocs: https://example.com/page");
    expect(offlineDocs(elsewhere)).toEqual(elsewhere);
  });
});

describe("callEngineTool", () => {
  it("runs the operation through the client and answers its MCP content", async () => {
    const f = fake(() => json(200, { total: 1, rows: [{ title: "Metropolis" }] }));
    expect(await callEngineTool(f.client, "select_rows", { table: "film" })).toEqual({
      content: [{ type: "text", text: '{"total":1,"rows":[{"title":"Metropolis"}]}' }],
      structuredContent: { total: 1, rows: [{ title: "Metropolis" }] },
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ url: `${ENGINE}/datanotes/operations/select_rows/`, method: "POST", body: '{"table":"film"}' });
    expect(f.sent[0]!.headers[ACTOR_HEADER]).toBe('{"harness":"film-night"}');
  });

  it("names the agent it calls for, and sends no arguments as {}", async () => {
    const f = fake(() => json(200, { tables: [] }));
    await callEngineTool(f.client, "list_tables", undefined, { actor: { harness: "claude-code", session: "s-1", tool: "list_tables" } });
    expect(f.sent[0]).toMatchObject({ body: "{}", headers: { [ACTOR_HEADER]: '{"harness":"claude-code","session":"s-1","tool":"list_tables"}' } });
  });

  it("answers a refusal, bad arguments and an engine that does not answer as an error result", async () => {
    const refused = fake(() => json(403, { error: "token film-night may not write main.public.actor", hint: "Ask the owner.", docs: "https://datanotes.dev/guides/security/tokens.md#choose-what-a-token-can-do" }));
    expect(await callEngineTool(refused.client, "update_rows", { table: "actor", where: {}, set: { born: "1906-03-17" } })).toEqual({
      content: [{ type: "text", text: "token film-night may not write main.public.actor\nHint: Ask the owner.\nDocs: https://datanotes.dev/guides/security/tokens.md#choose-what-a-token-can-do (offline: read_docs(\"guides/security/tokens#choose-what-a-token-can-do\"))" }],
      isError: true,
    });
    const down = fake(() => new Error("connect ECONNREFUSED"));
    expect(await callEngineTool(down.client, "list_tables")).toEqual({ content: [{ type: "text", text: guidedTextOf(`engine unreachable at ${ENGINE}: connect ECONNREFUSED`) }], isError: true });
    const unused = fake();
    // arguments the tool does not take, a required one missing, a value of the wrong type: never sent
    expect(await callEngineTool(unused.client, "select_rows", { tabel: "film", limit: "10" })).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringMatching(
            /^select_rows: unknown argument "tabel"; missing required argument "table" \(string\); "limit" must be an integer, not string "10"\nHint: For "tabel" use "table"\. select_rows takes: table \(string, required\), .+\nDocs: https:\/\/datanotes\.dev\/reference\/operations\/queries\.md#select_rows \(offline: read_docs\("reference\/operations\/queries#select_rows"\)\)$/,
          ),
        },
      ],
      isError: true,
    });
    expect(unused.sent).toEqual([]);
  });

  it("refuses a name that is no engine tool, or that the filter leaves out, without a request", async () => {
    const f = fake();
    expect(await callEngineTool(f.client, "pick_film_for_tonight", {})).toEqual({ content: [{ type: "text", text: guidedTextOf("unknown tool: pick_film_for_tonight") }], isError: true });
    // the closest tool the agent may call, not one the filter leaves out
    expect(await callEngineTool(f.client, "drop_table", { table: "film" }, { only: ["select_rows"] })).toEqual({
      content: [{ type: "text", text: "unknown tool: drop_table\nHint: tools/list (MCP) and the reference list every operation with its arguments.\nDocs: https://datanotes.dev/reference/operations.md (offline: read_docs(\"reference/operations\"))" }],
      isError: true,
    });
    expect((await callEngineTool(f.client, "selectrows", {}, { only: ["select_rows"] })).content[0]!.text).toContain('Hint: Did you mean "select_rows"?');
    expect(await callEngineTool(f.client, "drop_table", { table: "film" }, { except: ["drop_table"] })).toMatchObject({ isError: true });
    expect(f.sent).toEqual([]);
  });

  it("throws what is not the engine's answer: a programming error", async () => {
    const f = fake();
    await expect(callEngineTool(f.client, "select_rows", null as unknown as Record<string, unknown>)).rejects.toThrow(TypeError);
  });
});

describe("ENGINE_INSTRUCTIONS", () => {
  it("tells an agent how to start and how to change the schema", () => {
    expect(ENGINE_INSTRUCTIONS).toMatch(/^Database of Markdown notes/);
    expect(ENGINE_INSTRUCTIONS).toContain("never edit metastore.yaml");
    // a write may leave doubtful mentions as text: the agent resolves them
    expect(ENGINE_INSTRUCTIONS).toContain("ambiguous_mentions");
  });
});

// --- a server of one's own, on a real engine -----------------------------------------------------

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of running.splice(0).reverse()) await s.stop();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

const FILM_YAML = withTables(`film:
  options: { filename: "{title}" }
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: title, type: string, required: true }
    - { name: minutes, type: integer, min: 1 }
    - { name: status, type: enum, values: [to watch, watched], required: true }
`);

/** The server of the docs' example: three engine tools, the docs tools, one tool of its own, its own instructions. */
function filmNightServer(db: DatanotesClient): Server {
  const reads = { only: ["list_tables", "describe_table", "select_rows"] };
  const pickFilm = {
    name: "pick_film_for_tonight",
    description: "Pick the longest film still to watch that fits in max_minutes.",
    inputSchema: { type: "object" as const, properties: { max_minutes: { type: "integer", minimum: 1 } } },
  };
  const server = new Server(
    { name: "film-night", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: `${ENGINE_INSTRUCTIONS}\n\nTo suggest a film for tonight, call pick_film_for_tonight.` },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...engineTools(reads), ...docsTools(), pickFilm] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (isEngineTool(name, reads)) return offlineDocs(await callEngineTool(db, name, args, reads));
    if (isDocsTool(name)) return offlineDocs(await callDocsTool(name, args, { client: db }));
    if (name !== pickFilm.name) return toolContent(false, `unknown tool: ${name}`);
    const r = await db.call("select_rows", { table: "film", where: { status: "to watch" }, order_by: "minutes" });
    if (!r.ok) return toolContent(false, r.value);
    const max = typeof args.max_minutes === "number" ? args.max_minutes : Infinity;
    const film = (r.value as { rows: { title: string; minutes: number }[] }).rows.filter((f) => f.minutes <= max).at(-1);
    return toolContent(true, film ? { film: film.title, minutes: film.minutes } : { film: null });
  });
  return server;
}

describe("a server of one's own, with the MCP SDK and datanotes/mcp", () => {
  it("serves a curated subset of the engine's tools next to its own, with its own instructions, through its own token", async () => {
    const p = await freePort();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-mcp-"));
    fs.mkdirSync(path.join(root, "Datanotes"), { recursive: true });
    fs.writeFileSync(path.join(root, METASTORE), FILM_YAML);
    seedStoreSettings(root, { httpServerPort: p, httpServerToken: "owner-token", fileLogEnabled: false, autoRecompute: false }, METASTORE);
    const svc: RunningService = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
    running.push(svc);
    const url = `http://127.0.0.1:${p}`;
    const owner = new DatanotesClient({ url, token: "owner-token" });
    for (const [title, minutes] of [["Metropolis", 153], ["Battleship Potemkin", 75]] as const) {
      expect((await owner.call("insert_row", { table: "film", values: { title, minutes, status: "to watch" } })).ok).toBe(true);
    }
    const { token } = await owner.post<{ token: string }>("/tokens/create/", { name: "film-night", write: [] });
    const db = new DatanotesClient({ url, token, actor: { harness: "film-night" } });

    const server = filmNightServer(db);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const agent = new Client({ name: "test-agent", version: "1.0.0" });
    await agent.connect(clientSide);
    running.push({ stop: () => agent.close() });

    expect(agent.getInstructions()).toBe(`${ENGINE_INSTRUCTIONS}\n\nTo suggest a film for tonight, call pick_film_for_tonight.`);
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_tables", "describe_table", "select_rows", "list_docs", "read_docs", "search_docs", "pick_film_for_tonight"]);
    // the docs tools answer without the engine: the docs of the package, or how to build them in a checkout
    expect((await agent.callTool({ name: "list_docs", arguments: {} })).content).toEqual([{ type: "text", text: expect.stringMatching(/^(\d+ pages\.|the Datanotes docs are not in this installation)/) }]);

    const picked = await agent.callTool({ name: "pick_film_for_tonight", arguments: { max_minutes: 120 } });
    expect(picked.structuredContent).toEqual({ film: "Battleship Potemkin", minutes: 75 });
    const selected = await agent.callTool({ name: "select_rows", arguments: { table: "film", columns: ["title"], order_by: "title" } });
    expect((selected.structuredContent as { rows: { title: string }[] }).rows.map((r) => r.title)).toEqual(["Battleship Potemkin", "Metropolis"]);
    // an error the agent reads names only the read_docs call: the server serves the docs tools
    expect((await agent.callTool({ name: "select_rows", arguments: { tabel: "film" } })).content).toEqual([{ type: "text", text: expect.stringMatching(/\nDocs: read_docs\("reference\/operations\/queries#select_rows"\)$/) }]);
    // a tool the server leaves out is unknown to the agent, even though the engine has it
    expect(await agent.callTool({ name: "drop_table", arguments: { table: "film" } })).toEqual({ content: [{ type: "text", text: "unknown tool: drop_table" }], isError: true });
    expect(await agent.callTool({ name: "nope", arguments: {} })).toEqual({ content: [{ type: "text", text: "unknown tool: nope" }], isError: true });
    // the server's token has its own permissions: read only
    expect(await callEngineTool(db, "insert_row", { table: "film", values: { title: "Nosferatu", status: "to watch" } })).toEqual({
      content: [{ type: "text", text: guidedTextOf("token film-night may not write main.public.film") }],
      isError: true,
    });
  }, 30_000);
});
