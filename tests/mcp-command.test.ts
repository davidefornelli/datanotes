import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ENGINE_STOP_TIMEOUT_MS, engineStartTimeoutMs, mcp, startEngine, stopEngine, type McpRun } from "../src/mcp/command";
import { ALL_TOOLS, OWNER_TOOLS, profileTools, selectTools } from "../src/mcp/selection";
import { OPERATION_KIND, OPERATIONS } from "../src/api/catalog";
import { mcpHelp } from "../src/mcp/help";
import { help } from "../src/node/help";
import { fakeIo, StreamClientTransport, type FakeIo } from "./helpers/mcp";
import { freePort, openTestVault, type TestVault } from "./helpers/test-vault";
import { DEFAULT_DATABASE_FOLDER, storeLocation } from "../src/api/local";
import { seedStoreSettings } from "./helpers/store-settings";

// `datanotes mcp` run in the test's process (src/mcp/command.ts), with the process's streams,
// environment, exit and signals faked (helpers/mcp.ts). tests/mcp-bundle.test.ts runs the built command.

const TOKEN = "test-vault-token";
let vault: TestVault;
let engineUrl = "";
const temp: string[] = [];
const runs: McpRun[] = [];

beforeAll(async () => {
  vault = await openTestVault("service");
  engineUrl = (vault.client as unknown as { o: { url: string } }).o.url;
}, 60_000);

afterAll(async () => {
  await vault?.stop();
  for (const d of temp) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterEach(async () => {
  for (const r of runs.splice(0)) {
    r.child?.kill();
    await r.stop();
  }
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dn-mcp-cmd-"));
  temp.push(d);
  return d;
}

const until = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function run(argv: string[], io: FakeIo): Promise<McpRun | null> {
  const r = await mcp(argv, "9.9.9", io);
  if (r) runs.push(r);
  return r;
}

async function connect(io: FakeIo, name = "stdio-agent"): Promise<Client> {
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamClientTransport(io.stdin, io.stdout));
  return client;
}

/**
 * A stand-in for `datanotes serve`: writes the lock an engine holds in the database's store (this
 * host, a fresh heartbeat, the port of the settings) and, a moment later (as the engine does), answers
 * `GET /` on that port; every other request is a 404. Runs until stopped.
 */
const FAKE_ENGINE = `
const IGNORES_STOP = false;
const fs = require("fs"), http = require("http"), os = require("os"), path = require("path");
const vault = process.argv[process.argv.indexOf("--vault") + 1];
const id = fs.readFileSync(path.join(vault, ${JSON.stringify(DEFAULT_DATABASE_FOLDER)}, "metastore.yaml"), "utf8").match(/^id: (.+)$/m)[1].trim();
const store = path.join(process.env.DATANOTES_DATA_HOME, id);
const s = JSON.parse(fs.readFileSync(path.join(store, "settings.json"), "utf8"));
setTimeout(() => fs.writeFileSync(path.join(store, "engine.lock"), JSON.stringify({ kind: "service", pid: process.pid, host: os.hostname(), port: s.httpServerPort, startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() })), 100);
setTimeout(() => http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/datanotes/stop/") {
    // as the engine: only the owner's token stops it; it answers at once, then exits
    res.statusCode = req.headers.authorization === "Bearer " + s.httpServerToken ? 200 : 401;
    res.end(JSON.stringify({ stopping: true }));
    if (res.statusCode === 200 && !IGNORES_STOP) setTimeout(() => process.exit(0), 50);
    return;
  }
  res.statusCode = req.url === "/" ? 200 : 404; res.end("{}");
}).listen(s.httpServerPort, "127.0.0.1"), 400);
`;

/** The store of the database in `root`. */
const storeOf = (root: string) => storeLocation(root)!.store;

async function emptyVault(): Promise<string> {
  const root = tempDir();
  seedStoreSettings(root, { httpServerPort: await freePort(), httpServerToken: "fake-owner-token" });
  return root;
}

describe("datanotes mcp: help and errors", () => {
  it("--help and --version print and return", async () => {
    for (const arg of ["--help", "-h", "help"]) {
      const io = fakeIo();
      expect(await run([arg], io)).toBeNull();
      expect(io.out()).toBe(`${mcpHelp("9.9.9")}\n`);
    }
    for (const arg of ["--version", "-v", "version"]) {
      const io = fakeIo();
      await run([arg], io);
      expect(io.out()).toBe("9.9.9\n");
    }
  });

  it("the help names every option and environment variable; datanotes --help includes them", () => {
    const text = mcpHelp("3.0.0");
    for (const word of ["--vault", "--url", "--token-file", "--host", "--port", "--otlp-endpoint", "serve", "DATANOTES_VAULT", "DATANOTES_URL", "DATANOTES_TOKEN_FILE", "DATANOTES_TOKEN", "DATANOTES_MCP_HOST", "DATANOTES_MCP_PORT", "--profile", "--tools", "--except", "--owner-tools", "DATANOTES_MCP_PROFILE", "DATANOTES_MCP_TOOLS", "DATANOTES_MCP_EXCEPT", "DATANOTES_MCP_OWNER_TOOLS"]) {
      expect(text).toContain(word);
    }
    expect(help("3.0.0")).toContain("datanotes mcp serve [options]");
    expect(help("3.0.0")).toContain("--otlp-endpoint");
    expect(help("3.0.0")).toContain("npx -y datanotes mcp");
  });

  it("an unknown command, or no engine to talk to, exits 1 with the reason", async () => {
    const unknown = fakeIo();
    expect(await run(["bogus"], unknown)).toBeNull();
    expect(unknown.err()).toBe('datanotes mcp: unknown command "bogus" (datanotes mcp --help)\n');
    await until(() => unknown.exits.length > 0);
    expect(unknown.exits).toEqual([1]);

    const nothing = fakeIo();
    await run([], nothing);
    expect(nothing.err()).toMatch(/pass --database <folder> \(or --vault <folder>\), or --url <engine>/);
    await until(() => nothing.exits.length > 0);
    expect(nothing.exits).toEqual([1]);

    const noToken = fakeIo({ DATANOTES_URL: engineUrl });
    await run([], noToken);
    expect(noToken.err()).toMatch(/pass --database/);

    const missingFile = fakeIo();
    await run(["--url", engineUrl, "--token-file", path.join(tempDir(), "none")], missingFile);
    expect(missingFile.err()).toMatch(/^datanotes mcp: ENOENT/);

    // an option it does not know is refused with the closest one, never ignored
    const typo = fakeIo();
    expect(await run(["--valt", vault.root], typo)).toBeNull();
    expect(typo.err()).toBe('datanotes mcp: unknown option --valt\nDid you mean "--vault"? datanotes mcp takes: --vault, --database, --url, --token-file, --otlp-endpoint, --profile, --tools, --except, --owner-tools (datanotes mcp --help).\n');
    const both = fakeIo();
    await run(["--vault", vault.root, "--url", engineUrl], both);
    expect(both.err()).toContain("pass --database (or --vault), or --url with --token-file, not both");
    const serveTypo = fakeIo();
    await run(["serve", "--engine", engineUrl], serveTypo);
    expect(serveTypo.err()).toMatch(/unknown option --engine/);
  });

  it("the failure is logged too, and the logs are sent before the exit", async () => {
    const got: string[] = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        got.push(body);
        res.end("{}");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    try {
      const io = fakeIo({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" });
      await run(["bogus", "--otlp-endpoint", `http://127.0.0.1:${(srv.address() as AddressInfo).port}`], io);
      await until(() => io.exits.length > 0);
      expect(got.join("")).toContain("datanotes mcp failed: unknown command");
      expect(got.join("")).toContain('"severityText":"ERROR"');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("datanotes mcp: stdio", () => {
  it("--vault: uses the engine running on the vault, with the owner's token, until stdin ends", async () => {
    const io = fakeIo();
    const r = (await run(["--vault", vault.root], io))!;
    expect(r).toMatchObject({ mode: "stdio", url: engineUrl, child: null });
    expect(io.err()).toBe(`datanotes mcp: using the engine on ${path.resolve(vault.root)} (${engineUrl})\n`);
    const client = await connect(io);
    expect(client.getServerVersion()).toMatchObject({ name: "datanotes", version: "9.9.9" });
    const tables = await client.callTool({ name: "list_tables", arguments: {} });
    expect(JSON.stringify(tables.content)).toContain("person");
    expect((await client.listTools()).tools.length).toBeGreaterThan(50);
    // a tool call names the client and the process's session
    const owner = vault.client;
    let feed: { events: { actor?: { harness?: string; session?: string } }[] } = { events: [] };
    for (let i = 0; i < 50 && !feed.events.some((e) => e.actor?.harness === "stdio-agent"); i++) {
      await new Promise((res) => setTimeout(res, 100));
      feed = await owner.post("/operations/list_changes/", { since: 0, kinds: ["tool_call"] });
    }
    expect(feed.events.find((e) => e.actor?.harness === "stdio-agent")!.actor!.session).toMatch(/^[0-9a-f-]{16}$/);
    io.stdin.end();
    await until(() => io.exits.length > 0);
    expect(io.exits).toEqual([0]);
    // stopping again (a signal after the end) does nothing more
    io.signal("SIGTERM");
    await r.stop();
    await new Promise((res) => setTimeout(res, 50));
    expect(io.exits).toEqual([0]);
  });

  it("DATANOTES_VAULT instead of --vault; a signal stops it", async () => {
    const io = fakeIo({ DATANOTES_VAULT: vault.root });
    await run([], io);
    expect(io.err()).toMatch(/using the engine on/);
    io.signal("SIGINT");
    await until(() => io.exits.length > 0);
    expect(io.exits).toEqual([0]);
  });

  it("--url with --token-file, DATANOTES_TOKEN_FILE or DATANOTES_TOKEN: an engine at an address", async () => {
    const file = path.join(tempDir(), "token");
    fs.writeFileSync(file, `${TOKEN}\n`);
    for (const [argv, env] of [
      [["--url", engineUrl, "--token-file", file], {}],
      [[], { DATANOTES_URL: engineUrl, DATANOTES_TOKEN_FILE: file }],
      [["--url", engineUrl], { DATANOTES_TOKEN: ` ${TOKEN} ` }],
      // --name=value as well
      [[`--url=${engineUrl}`, `--token-file=${file}`], {}],
      // an engine named on the command line wins over the environment's vault (and its owner token)
      [["--url", engineUrl, "--token-file", file], { DATANOTES_VAULT: path.join(tempDir(), "another-vault") }],
    ] as [string[], Record<string, string>][]) {
      const io = fakeIo(env);
      const r = (await run(argv, io))!;
      expect(r.url).toBe(engineUrl);
      const client = await connect(io);
      const res = await client.callTool({ name: "describe_table", arguments: { table: "person" } });
      expect(res.isError).toBeFalsy();
      await client.close();
      await until(() => io.exits.length > 0);
    }
  });

  it("--vault with no engine running: starts one for the session and stops it at the end", async () => {
    const root = await emptyVault();
    const io = fakeIo({}, [process.execPath, "-e", FAKE_ENGINE]);
    const r = (await run(["--vault", root], io))!;
    expect(r.child).not.toBeNull();
    expect(io.err()).toMatch(/^datanotes mcp: started an engine on /);
    expect(r.url).toBe(`http://127.0.0.1:${JSON.parse(fs.readFileSync(path.join(storeOf(root), "settings.json"), "utf8")).httpServerPort}`);
    // the stand-in has no apps (its routes are 404s): the operations are listed all the same
    const client = await connect(io);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("select_rows");
    const exited = new Promise((res) => r.child!.once("exit", (code) => res(code)));
    io.stdin.end();
    // asked to stop with the owner's token (POST /datanotes/stop/), it exits by itself: no kill
    expect(await exited).toBe(0);
    expect(r.child!.killed).toBe(false);
    await until(() => io.exits.length > 0);
    expect(io.exits).toEqual([0]);
  });

  it("--vault while the engine starts on any free port (port 0 in its lock): waits until it gives its port", async () => {
    const root = await emptyVault();
    const lock = (port: number) => {
      const now = new Date().toISOString();
      fs.writeFileSync(path.join(storeOf(root), "engine.lock"), JSON.stringify({ kind: "service", pid: process.pid, host: os.hostname(), port, startedAt: now, heartbeat: now }));
    };
    lock(0);
    const port = await freePort();
    setTimeout(() => lock(port), 700);
    const io = fakeIo({}, [process.execPath, "-e", "process.exit(3)"]);
    const r = (await run(["--vault", root], io))!;
    expect([r.url, r.child]).toEqual([`http://127.0.0.1:${port}`, null]);
    expect(io.err()).toMatch(/^datanotes mcp: using the engine on /);
  });

  it("an engine that cannot start is an error", async () => {
    const io = fakeIo({}, [process.execPath, "-e", "process.exit(3)"]);
    await run(["--vault", await emptyVault()], io);
    expect(io.err()).toBe("datanotes mcp: the engine stopped (exit 3)\n");
  });
});

describe("datanotes mcp: starting an engine", () => {
  it("waits until the engine holds the vault", async () => {
    const root = await emptyVault();
    const { engine, child } = await startEngine(root, [process.execPath, "-e", FAKE_ENGINE], 10_000, 50);
    child.kill();
    expect(engine.token).toBe("fake-owner-token");
  });

  it("stops it with POST /datanotes/stop/, and kills it only when it does not stop in time", async () => {
    expect(ENGINE_STOP_TIMEOUT_MS).toBe(35_000);
    // an engine that stops when asked
    const polite = await startEngine(await emptyVault(), [process.execPath, "-e", FAKE_ENGINE], 10_000, 50);
    expect(await stopEngine(polite.child, polite.engine, 10_000)).toBe("stopped");
    expect([polite.child.exitCode, polite.child.killed]).toEqual([0, false]);
    // already stopped: nothing more to do
    expect(await stopEngine(polite.child, polite.engine, 10_000)).toBe("stopped");

    // an engine that answers but goes on running: killed after the timeout
    const deaf = await startEngine(await emptyVault(), [process.execPath, "-e", FAKE_ENGINE.replace("IGNORES_STOP = false", "IGNORES_STOP = true")], 10_000, 50);
    const started = Date.now();
    expect(await stopEngine(deaf.child, deaf.engine, 300)).toBe("killed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(deaf.child.killed).toBe(true);

    // an engine that refuses the token: killed at once
    const refusing = await startEngine(await emptyVault(), [process.execPath, "-e", FAKE_ENGINE], 10_000, 50);
    expect(await stopEngine(refusing.child, { ...refusing.engine, token: "not-the-owner" }, 10_000)).toBe("killed");
    expect(refusing.child.killed).toBe(true);
  });

  it("the stdio session reports an engine it had to kill", async () => {
    const root = await emptyVault();
    // an engine without the stop route: the stop cannot be asked, so the kill comes at once
    const io = fakeIo({}, [process.execPath, "-e", FAKE_ENGINE.replace('req.url === "/datanotes/stop/"', "false")]);
    const r = (await run(["--vault", root], io))!;
    await r.stop();
    expect(r.child!.killed).toBe(true);
    expect(io.err()).toContain("datanotes mcp: the engine did not stop within 35 s: killed it\n");
    await until(() => io.exits.length > 0);
    expect(io.exits).toEqual([0]);
  });

  it("gives up after the timeout, and stops what it started", async () => {
    const root = await emptyVault();
    const failure = startEngine(root, [process.execPath, "-e", "setInterval(() => {}, 1000)"], 300, 50);
    await expect(failure).rejects.toThrow("the engine did not start within 0 s");
    // what to do: wait longer, or keep the engine running as a service
    await expect(failure).rejects.toThrow(/DATANOTES_ENGINE_START_TIMEOUT_S.*datanotes serve as a service \(https:\/\/datanotes\.dev\/administration\/limits\.md#/);
  });

  it("waits 60 s by default, or the seconds of DATANOTES_ENGINE_START_TIMEOUT_S", () => {
    expect(engineStartTimeoutMs({})).toBe(60_000);
    expect(engineStartTimeoutMs({ DATANOTES_ENGINE_START_TIMEOUT_S: "300" })).toBe(300_000);
    expect(engineStartTimeoutMs({ DATANOTES_ENGINE_START_TIMEOUT_S: "2.5" })).toBe(2500);
    for (const bad of ["0", "-5", "soon", ""]) expect(engineStartTimeoutMs({ DATANOTES_ENGINE_START_TIMEOUT_S: bad })).toBe(60_000);
  });
});

describe("datanotes mcp serve", () => {
  it("listens, says where on stdout, and stops on a signal", async () => {
    const io = fakeIo();
    const r = (await run(["serve", "--port", "0", "--url", engineUrl, "--host", "127.0.0.1"], io))!;
    expect(r.mode).toBe("http");
    expect(io.out()).toBe(`datanotes mcp 9.9.9: ${r.url} -> ${engineUrl}\n`);
    const status = await (await fetch(new URL("/", r.url))).json();
    expect(status).toMatchObject({ service: "datanotes-mcp", engine: true });
    io.signal("SIGTERM");
    await until(() => io.exits.length > 0);
    expect(io.exits).toEqual([0]);
    await expect(fetch(r.url)).rejects.toThrow();
    await r.stop(); // already stopped
    expect(io.exits).toEqual([0]);
  });

  it("the engine, address and port from the environment", async () => {
    const io = fakeIo({ DATANOTES_URL: engineUrl, DATANOTES_MCP_HOST: "127.0.0.1", DATANOTES_MCP_PORT: "0" });
    const r = (await run(["serve"], io))!;
    expect(io.out()).toContain(`-> ${engineUrl}`);
    await r.stop();
    await until(() => io.exits.length > 0);
  });

  it("a port in use is an error (exit 1)", async () => {
    const io = fakeIo({ DATANOTES_MCP_PORT: "0" });
    const first = (await run(["serve", "--url", engineUrl], io))!;
    const port = new URL(first.url).port;
    const second = fakeIo();
    expect(await run(["serve", "--url", engineUrl, "--port", port], second)).toBeNull();
    expect(second.err()).toMatch(/EADDRINUSE/);
    await until(() => second.exits.length > 0);
    expect(second.exits).toEqual([1]);
  });

  it("without --url, the engine of the default address", async () => {
    const spy = vi.fn();
    const io = fakeIo({ DATANOTES_MCP_PORT: "0" });
    io.onSignal = spy;
    await run(["serve"], io);
    expect(io.out()).toContain("-> http://127.0.0.1:27150");
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["SIGINT", "SIGTERM"]);
  });
});

describe("datanotes mcp: the tools an agent sees", () => {
  const names = async (io: FakeIo) => (await (await connect(io)).listTools()).tools.map((t) => t.name);
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

  it("the profiles: by default every tool but the webhook tools; read, write, all", () => {
    expect(OWNER_TOOLS).toEqual(["create_webhook", "delete_webhook"]);
    const byDefault = profileTools(null);
    expect(byDefault).toEqual(ALL_TOOLS.filter((n) => !OWNER_TOOLS.includes(n)));
    expect(byDefault).toEqual(expect.arrayContaining(["select_rows", "insert_row", "create_table", "list_webhooks", "list_docs"]));
    expect(profileTools("all")).toEqual([...ALL_TOOLS]);
    const read = profileTools("read");
    expect(read).toEqual(expect.arrayContaining(["select_rows", "describe_table", "list_changes", "read_docs"]));
    for (const n of read) expect(OPERATIONS.find((o) => o.name === n)?.annotations.readOnlyHint ?? n.endsWith("_docs")).toBe(true);
    const write = profileTools("write");
    expect(write).toEqual(expect.arrayContaining(["insert_row", "update_rows", "undo_migration", "select_rows", "search_docs"]));
    for (const n of write) expect(OPERATION_KIND[n]).not.toBe("schema");
    expect(write).not.toContain("configure_database");
    for (const n of OWNER_TOOLS) expect(write).not.toContain(n);
  });

  it("--tools, --except and --owner-tools; wrong names are refused with the closest one", () => {
    expect(selectTools({ tools: " select_rows, insert_row ,read_docs" })).toEqual(["insert_row", "select_rows", "read_docs"]);
    expect(selectTools({ profile: "read", except: "read_note" })).not.toContain("read_note");
    expect(selectTools({ ownerTools: true })).toEqual([...ALL_TOOLS]);
    expect(selectTools({ profile: "read", ownerTools: true })).toEqual(expect.arrayContaining([...OWNER_TOOLS]));
    expect(selectTools({ ownerTools: true, except: "delete_webhook" })).toContain("create_webhook");
    const refused = (s: Parameters<typeof selectTools>[0]) => {
      try {
        selectTools(s);
      } catch (e) {
        const g = e as Error & { hint: string; docs: string };
        return { message: g.message, hint: g.hint, docs: g.docs };
      }
      throw new Error("not refused");
    };
    const docs = "https://datanotes.dev/start/connect-agents.md#choose-the-tools-an-agent-sees";
    expect(refused({ tools: "select_row" })).toEqual({ message: '--tools: unknown tool "select_row"', hint: expect.stringMatching(/^Did you mean "select_rows"\? --tools takes tool names separated by commas/), docs });
    expect(refused({ except: "create_webhok" })).toMatchObject({ message: '--except: unknown tool "create_webhok"', hint: expect.stringContaining('Did you mean "create_webhook"?'), docs });
    expect(refused({ profile: "reed" })).toMatchObject({ message: '--profile: unknown profile "reed"', hint: 'Did you mean "read"? --profile takes read, write or all.', docs });
    expect(refused({ profile: "read", tools: "select_rows" })).toMatchObject({ message: "pass --profile or --tools, not both", docs });
    expect(refused({ tools: "select_rows", except: "select_rows" })).toMatchObject({ message: "no tool left to offer", docs });
  });

  it("stdio: the default leaves out the webhook tools, and a call to one is an unknown tool", async () => {
    const io = fakeIo();
    await run(["--vault", vault.root], io);
    const client = await connect(io);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("list_webhooks");
    expect(tools).not.toContain("create_webhook");
    expect(tools).not.toContain("delete_webhook");
    const r = await client.callTool({ name: "create_webhook", arguments: { url: "http://127.0.0.1:9/hook" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^unknown tool: create_webhook/);
  });

  it("stdio: --owner-tools adds them; --profile read leaves out every write; the environment too", async () => {
    const owner = fakeIo();
    await run(["--vault", vault.root, "--owner-tools"], owner);
    expect(await names(owner)).toEqual(expect.arrayContaining([...OWNER_TOOLS]));

    const read = fakeIo();
    await run(["--vault", vault.root, "--profile", "read"], read);
    const client = await connect(read, "reader");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(profileTools("read"));
    const refused = await client.callTool({ name: "insert_row", arguments: { table: "person", values: { name: "Nobody Writes" } } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^unknown tool: insert_row/);
    const docs = await client.callTool({ name: "list_docs", arguments: {} });
    // offered (a checkout without built docs answers that it has none, not an unknown tool)
    expect(text(docs)).not.toMatch(/unknown tool/);

    const env = fakeIo({ DATANOTES_VAULT: vault.root, DATANOTES_MCP_TOOLS: "select_rows,list_docs", DATANOTES_MCP_EXCEPT: "list_docs", DATANOTES_MCP_OWNER_TOOLS: "1" });
    await run([], env);
    expect(await names(env)).toEqual(["select_rows", "create_webhook", "delete_webhook"]);
    // the command line wins over the environment
    const both = fakeIo({ DATANOTES_VAULT: vault.root, DATANOTES_MCP_PROFILE: "write" });
    await run(["--profile=read"], both);
    expect(await names(both)).toEqual(profileTools("read"));
  });

  it("a wrong selection exits 1 before any engine starts, with the hint and the docs", async () => {
    const io = fakeIo({}, [process.execPath, "-e", "process.exit(3)"]);
    expect(await run(["--vault", await emptyVault(), "--tools", "select_row"], io)).toBeNull();
    expect(io.err()).toBe(
      'datanotes mcp: --tools: unknown tool "select_row"\nDid you mean "select_rows"? --tools takes tool names separated by commas, such as --tools select_rows,insert_row; the reference lists every operation.\nDocs: https://datanotes.dev/start/connect-agents.md#choose-the-tools-an-agent-sees\n',
    );
    await until(() => io.exits.length > 0);
    expect(io.exits).toEqual([1]);
    const flag = fakeIo({ DATANOTES_VAULT: vault.root, DATANOTES_MCP_OWNER_TOOLS: "yes" });
    await run([], flag);
    expect(flag.err()).toMatch(/^datanotes mcp: DATANOTES_MCP_OWNER_TOOLS must be 1 or 0: "yes"\nSet DATANOTES_MCP_OWNER_TOOLS=1/);
    const flagValue = fakeIo();
    await run(["--vault", vault.root, "--owner-tools=1"], flagValue);
    expect(flagValue.err()).toMatch(/--owner-tools takes no value/);
  });

  it("serve: the same options for every agent over HTTP", async () => {
    const io = fakeIo();
    const r = (await run(["serve", "--port", "0", "--url", engineUrl, "--profile", "write", "--except", "delete_rows"], io))!;
    const client = new Client({ name: "http-agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(r.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(profileTools("write").filter((n) => n !== "delete_rows"));
      const refused = await client.callTool({ name: "create_table", arguments: { name: "nothing" } });
      expect(text(refused)).toMatch(/^unknown tool: create_table/);
    } finally {
      await client.close();
    }
    const bad = fakeIo();
    expect(await run(["serve", "--port", "0", "--url", engineUrl, "--profile", "admin"], bad)).toBeNull();
    expect(bad.err()).toMatch(/^datanotes mcp: --profile: unknown profile "admin"\n/);
  });
});
