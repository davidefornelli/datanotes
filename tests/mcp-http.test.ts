import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatanotesClient, DatanotesError } from "../src/api/client";
import { lenientInitialize, startHttp } from "../src/mcp/http";
import { Toolbox } from "../src/mcp/tools";
import { collector } from "./helpers/mcp";
import { freePort, openTestVault, type TestVault } from "./helpers/test-vault";
import { guided } from "./helpers/guidance";

// `datanotes mcp serve`: MCP over Streamable HTTP (src/mcp/http.ts) on the engine running on a copy
// of the test vault, every agent with its own token.

let vault: TestVault;
let engineUrl = "";
const TOKEN = "test-vault-token";
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  vault = await openTestVault("service");
  engineUrl = (vault.client as unknown as { o: { url: string } }).o.url;
}, 60_000);

afterAll(async () => {
  await vault?.stop();
});

afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const initialize = (name = "raw") => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } } });

async function serve(toolbox: Toolbox, extra: { idleMs?: number; sweepMs?: number; maxBody?: number } = {}) {
  const srv = await startHttp({ toolbox, host: "127.0.0.1", port: 0, version: "test", ...extra });
  cleanup.push(() => srv.close());
  return { srv, url: new URL(`http://127.0.0.1:${srv.port}/mcp`) };
}

describe("datanotes mcp serve: Streamable HTTP", () => {
  it("serves the engine's operations with the agent's token, and records the agent", async () => {
    const logs = collector();
    const { url } = await serve(new Toolbox(engineUrl, logs.exporter.log.bind(logs.exporter)));

    // a wrong token is refused before any session
    const bad = await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong-token-0123456789", ...JSON_HEADERS }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toBeNull();
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);

    // a sparse initialize (no version, no capabilities) still opens a session
    const sparse = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, ...JSON_HEADERS }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "bare" } } }) });
    expect(sparse.status).toBe(200);
    expect(sparse.headers.get("mcp-session-id")).toBeTruthy();

    const client = new Client({ name: "test-agent", version: "1.2" });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
    await client.connect(transport);
    cleanup.push(() => client.close());
    expect(client.getServerVersion()?.name).toBe("datanotes");
    expect(client.getInstructions()).toContain("list_tables");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["select_rows", "insert_row", "read_note", "undo_migration"]));
    expect(tools.some((t) => "responseSchema" in t)).toBe(false); // OpenAPI-only field, not for agents

    const ins = await client.callTool({ name: "insert_row", arguments: { table: "person", values: { name: "Mcp Agent Person", role: "engineer" } } });
    expect(ins.isError, text(ins)).toBeFalsy();
    const refused = await client.callTool({ name: "insert_row", arguments: { table: "person", values: { name: "Nobody", role: "astronaut" } } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/refused — nothing was written/);
    const sel = await client.callTool({ name: "select_rows", arguments: { table: "person", where: { name: "Mcp Agent Person" } } });
    expect((sel.structuredContent as { total: number }).total).toBe(1);
    const none = await client.callTool({ name: "list_tables" });
    expect(none.isError).toBeFalsy();

    // the engine's journal names the agent; its change feed has the tool calls
    const owner = new DatanotesClient({ url: engineUrl, token: TOKEN });
    const migs = await owner.post<{ migrations: { by: string }[] }>("/operations/list_migrations/", { op: "insert_row" });
    expect(migs.migrations[0]!.by).toBe("test-agent");
    let calls: unknown[] = [];
    for (let i = 0; i < 50 && calls.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const feed = await owner.post<{ events: { call: { tool: string; ok: boolean }; actor?: { harness?: string } }[] }>("/operations/list_changes/", { since: 0, kinds: ["tool_call"] });
      calls = feed.events.map((e) => [e.call.tool, e.call.ok, e.actor?.harness]);
    }
    expect(calls).toEqual(expect.arrayContaining([["insert_row", true, "test-agent"], ["insert_row", false, "test-agent"], ["select_rows", true, "test-agent"]]));

    // the same calls in the OTLP logs, with the session the engine received; refusals and sessions too, never the token
    const session = transport.sessionId!.slice(0, 16);
    await transport.terminateSession();
    const records = await logs.records();
    const toolLogs = records.filter((r) => r.attributes.tool);
    expect(toolLogs.map((r) => [r.attributes.tool, r.attributes.ok, r.severity, r.attributes.harness, r.attributes.session])).toEqual([
      ["insert_row", true, "INFO", "test-agent", session],
      ["insert_row", false, "WARN", "test-agent", session],
      ["select_rows", true, "INFO", "test-agent", session],
      ["list_tables", true, "INFO", "test-agent", session],
    ]);
    expect(records.filter((r) => r.attributes.reason && r.attributes.status).map((r) => [r.severity, r.attributes.status, r.attributes.reason])).toEqual([
      ["WARN", 401, "token refused by Datanotes"],
      ["WARN", 401, "missing bearer token"],
    ]);
    expect(records.filter((r) => r.body.startsWith("session opened")).map((r) => r.attributes.harness)).toEqual(["bare", "test-agent"]);
    expect(records.some((r) => r.body === "session closed: closed by the client" && r.attributes.session === session)).toBe(true);
    expect(logs.bodies.join("\n")).not.toContain(TOKEN);
  });

  it("answers its status without a token, and refuses what is not an MCP session", async () => {
    const logs = collector();
    const { url } = await serve(new Toolbox(engineUrl, logs.exporter.log.bind(logs.exporter)), { maxBody: 1000 });
    const status = await fetch(new URL("/", url));
    expect(await status.json()).toEqual({ status: "OK", service: "datanotes-mcp", version: "test", engine: true });
    expect((await fetch(new URL("/other", url))).status).toBe(404);
    const auth = { Authorization: `Bearer ${TOKEN}`, ...JSON_HEADERS };
    const parse = await fetch(url, { method: "POST", headers: auth, body: "{not json" });
    expect([parse.status, await parse.json()]).toEqual([400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }]);
    const unknown = await fetch(url, { method: "POST", headers: { ...auth, "mcp-session-id": "no-such-session" }, body: "{}" });
    expect(unknown.status).toBe(404);
    const noSession = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    expect(noSession.status).toBe(400);
    expect((await fetch(url, { method: "GET", headers: auth })).status).toBe(400);
    // the token is asked to the engine once a minute
    const again = await fetch(url, { method: "POST", headers: auth, body: "{}" });
    expect(again.status).toBe(400);
    // a body over the limit is refused
    const big = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ pad: "x".repeat(5000) }) }).then((r) => r.status, () => "connection closed");
    expect([400, "connection closed"]).toContain(big);
    const reasons = (await logs.records()).filter((r) => r.attributes.reason).map((r) => r.attributes.reason);
    expect(reasons).toEqual(expect.arrayContaining(["parse error", "session not found", "no session: start with initialize"]));
  });

  it("closes sessions left unused, and every session when it stops", async () => {
    const logs = collector();
    const { srv, url } = await serve(new Toolbox(engineUrl, logs.exporter.log.bind(logs.exporter)), { idleMs: 400, sweepMs: 50 });
    const open = async (name: string) => (await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, ...JSON_HEADERS }, body: initialize(name) })).headers.get("mcp-session-id")!;
    const idle = await open("idle");
    for (let i = 0; i < 50; i++) {
      if ((await logs.records()).some((r) => r.body === "session closed: expired")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const gone = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": idle, ...JSON_HEADERS }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    expect(gone.status).toBe(404);
    await open("last");
    await srv.close();
    cleanup.length = 0;
    const closed = (await logs.records()).filter((r) => r.body.startsWith("session closed")).map((r) => r.attributes.reason);
    expect(closed).toEqual(["expired", "server stopped"]);
  });

  it("an engine that cannot be reached is a 502; a token it answers for is let through", async () => {
    const down = await serve(new Toolbox(`http://127.0.0.1:${await freePort()}`));
    const r = await fetch(down.url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, ...JSON_HEADERS }, body: initialize() });
    expect([r.status, await r.json()]).toEqual([502, guided("Datanotes engine unreachable")]);

    // the engine answered with something else than a refusal: it knew the token
    class Answering extends Toolbox {
      override client(token: string): DatanotesClient {
        const real = super.client(token);
        return Object.assign(Object.create(real) as DatanotesClient, { post: async () => Promise.reject(new DatanotesError("busy", "http", 503)) });
      }
    }
    const answering = await serve(new Answering(engineUrl));
    const ok = await fetch(answering.url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, ...JSON_HEADERS }, body: initialize() });
    expect(ok.status).toBe(200);
  });

  it("a token the engine accepts is asked once, then remembered", async () => {
    const asked: string[] = [];
    class Accepting extends Toolbox {
      override client(token: string): DatanotesClient {
        const real = super.client(token);
        return Object.assign(Object.create(real) as DatanotesClient, { post: async (route: string) => void asked.push(route) });
      }
    }
    const { url } = await serve(new Accepting(engineUrl));
    for (const name of ["first", "second"]) {
      const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, ...JSON_HEADERS }, body: initialize(name) });
      expect(r.status).toBe(200);
    }
    expect(asked).toHaveLength(1);
  });

  it("an unexpected failure is a 500 and an ERROR record", async () => {
    const logs = collector();
    class Broken extends Toolbox {
      override instructions(): string {
        throw new Error("instructions failed");
      }
    }
    const { url } = await serve(new Broken(engineUrl, logs.exporter.log.bind(logs.exporter)));
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, ...JSON_HEADERS }, body: initialize() });
    expect([r.status, await r.json()]).toEqual([500, { error: "instructions failed" }]);
    const error = (await logs.records()).find((x) => x.severity === "ERROR")!;
    expect(error.attributes).toMatchObject({ method: "POST", path: "/mcp", error: "instructions failed" });
  });

  it("refuses to start on a port in use", async () => {
    const { srv } = await serve(new Toolbox(engineUrl));
    await expect(startHttp({ toolbox: new Toolbox(engineUrl), host: "127.0.0.1", port: srv.port, version: "test" })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe("datanotes mcp serve: lenient initialize", () => {
  it("fills what a sparse initialize leaves out, and leaves everything else as it is", () => {
    expect(lenientInitialize(undefined)).toBeUndefined();
    expect(lenientInitialize(null)).toBeNull();
    expect(lenientInitialize("x")).toBe("x");
    expect(lenientInitialize([{ method: "initialize" }])).toEqual([{ method: "initialize" }]);
    expect(lenientInitialize({ method: "tools/list" })).toEqual({ method: "tools/list" });
    expect(lenientInitialize({ jsonrpc: "2.0", id: 1, method: "initialize" })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "unknown", version: "0" } },
    });
    const full = { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: { roots: {} }, clientInfo: { name: "c", version: "2" } } };
    expect(lenientInitialize(full)).toEqual(full);
  });
});
