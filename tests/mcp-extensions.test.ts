import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Options } from "../src/api/cli-options";
import { extensionsHome, tokenPath } from "../src/api/extension-files";
import type { ExtensionLoad, LoadedExtension } from "../src/api/extension-host";
import { ENGINE_INSTRUCTIONS } from "../src/api/mcp";
import { openDocs } from "../src/api/docs";
import { mcp, type McpRun } from "../src/mcp/command";
import { EXTENSIONS_ENV, ExtensionSet, extensionsEnabled, readOnlyProfile } from "../src/mcp/extensions";
import type { Log } from "../src/mcp/log";
import { ToolSelectionError } from "../src/mcp/selection";
import { Toolbox } from "../src/mcp/tools";
import { docsFixture } from "./helpers/docs-fixture";
import { installFixture, type FixtureInstall } from "./helpers/extensions";
import { fakeIo, StreamClientTransport, type FakeIo } from "./helpers/mcp";
import { copyTestVault, openTestVault, until, type TestVault } from "./helpers/test-vault";

// `datanotes mcp` with the books fixture extension installed (tests/helpers/extensions.ts): its
// tools after the engine's, in both modes, its docs mounted, its options (src/mcp/extensions.ts).

const TOKEN = "test-vault-token";
let vault: TestVault;
let engineUrl = "";
let fx: FixtureInstall;
let docs = "";
/** The book Dune: being read at the start of every test of the first describe. */
let dune = "";
const runs: McpRun[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  vault = await openTestVault("service");
  engineUrl = (vault.client as unknown as { o: { url: string } }).o.url;
  fx = await installFixture(vault.client);
  dune = (await vault.ok<{ planned_creates: string[] }>("insert_row", { table: "work.books.book", values: { title: "Dune", status: "reading" } })).planned_creates[0]!;
  docs = docsFixture();
}, 60_000);

afterAll(async () => {
  await vault?.stop();
  if (docs) fs.rmSync(docs, { recursive: true, force: true });
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const r of runs.splice(0)) await r.stop();
});

/** The process of `datanotes mcp`: the tests' data home (where installFixture put the code and token) and the docs fixture. */
const io = (env: Record<string, string> = {}): FakeIo => fakeIo({ DATANOTES_DATA_HOME: process.env.DATANOTES_DATA_HOME, DATANOTES_DOCS_DIR: docs, ...env });

async function run(argv: string[], fake: FakeIo): Promise<McpRun | null> {
  const r = await mcp(argv, "9.9.9", fake);
  if (r) runs.push(r);
  return r;
}

async function stdioClient(argv: string[], fake: FakeIo, name = "ext-agent"): Promise<Client> {
  expect(await run(argv, fake), fake.err()).not.toBeNull();
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamClientTransport(fake.stdin, fake.stdout));
  clients.push(client);
  return client;
}

async function httpClient(url: string, token: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
const statusOfDune = async () => (await vault.ok<{ rows: { status: string }[] }>("select_rows", { table: "work.books.book", where: { title: "Dune" }, columns: ["status"] })).rows[0]!.status;

type Event = { op?: string; kind?: string; table?: string; actor?: Record<string, string>; call?: { tool: string; served_by: string } };
/** The newest number of the change feed: a test reads only the changes after it (R4-Q1). */
const head = async () => (await vault.ok<{ head: number }>("list_changes", { since: 0, limit: 1 })).head;

async function changes(found: (events: Event[]) => boolean, since = 0): Promise<Event[]> {
  let events: Event[] = [];
  for (let i = 0; i < 50; i++) {
    // tool calls come only when asked for
    const calls = (await vault.ok<{ events: Event[] }>("list_changes", { since, limit: 1000, kinds: ["tool_call"] })).events;
    events = [...calls, ...(await vault.ok<{ events: Event[] }>("list_changes", { since, limit: 1000 })).events];
    if (found(events)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return events;
}

// --- fakes for the units ----------------------------------------------------------------------------

function fakeExtension(call: LoadedExtension["call"] = async () => ({ ok: true, value: { done: true } })): LoadedExtension {
  return {
    name: "fake",
    version: "1.0.0",
    servedBy: "ext-fake",
    tools: [{ name: "fake_tool", description: "A fake tool.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, _meta: { "datanotes/extension": "fake", "datanotes/tables": [] } }],
    instructions: 'Extension fake 1.0.0 (fake_tool): Fake things. Docs: read_docs("extensions/fake").',
    has: (tool) => tool === "fake_tool",
    call,
  };
}

const fakeLoad = (ext: LoadedExtension | null): ExtensionLoad => ({
  databaseId: null,
  loaded: ext ? [ext] : [],
  skipped: [],
  docsMounts: ext ? [{ prefix: "extensions/fake", dir: path.join(docs, "nowhere") }] : [],
});

function logs(): { log: Log; records: { severity: string; body: string; attributes?: Record<string, unknown> }[] } {
  const records: { severity: string; body: string; attributes?: Record<string, unknown> }[] = [];
  return { records, log: (severity, body, attributes) => void records.push({ severity, body, ...(attributes ? { attributes } : {}) }) };
}

const options = (values: Record<string, string> = {}, flags: string[] = []): Options => ({ get: (n) => values[n], has: (n) => flags.includes(n) });

function fakeSet(load: (token: string) => Promise<ExtensionLoad>, log: Log = () => undefined, stderr: { write(s: string): unknown } | null = null): ExtensionSet {
  return new ExtensionSet({ engineUrl, log, readOnlyOnly: false, reserved: [], env: {}, stderr, load: ((o: { token: string }) => load(o.token)) as never });
}

describe("datanotes mcp with an installed extension", { timeout: 60_000 }, () => {
  // two tests finish Dune, and vitest may run them in any order: each test starts with Dune being read (R4-Q1)
  beforeEach(async () => {
    if ((await statusOfDune()) !== "reading") await vault.ok("update_row", { table: "work.books.book", path: dune, set: { status: "reading" } });
  });

  it("stdio lists the extension's tools after the engine's", async () => {
    const fake = io();
    const client = await stdioClient(["--vault", vault.root], fake);
    const { tools } = await client.listTools();
    expect(tools.slice(-2).map((t) => [t.name, t._meta?.["datanotes/extension"]])).toEqual([
      ["list_reading", "books"],
      ["finish_book", "books"],
    ]);
    expect(tools.length).toBeGreaterThan(50);
    const instructions = client.getInstructions()!;
    expect(instructions.startsWith(ENGINE_INSTRUCTIONS)).toBe(true);
    expect(instructions.slice(ENGINE_INSTRUCTIONS.length)).toMatch(/^\n\nExtensions:\n- Extension books 0\.1\.0 \(list_reading, finish_book\): Keep the reading list[^\n]*Docs: read_docs\("extensions\/books"\)\.$/);
    expect(fake.err()).toContain("datanotes mcp: extension books 0.1.0: 2 tools\n");
  });

  it("a call runs in the extension", async () => {
    const since = await head();
    const client = await stdioClient(["--vault", vault.root], io(), "reading-agent");
    const listed = await client.callTool({ name: "list_reading", arguments: {} });
    expect(listed.isError, text(listed)).toBeFalsy();
    expect(text(listed)).toContain("Dune");
    const nope = await client.callTool({ name: "finish_book", arguments: { title: "Nope" } });
    expect(nope.isError).toBe(true);
    expect(text(nope).endsWith('Docs: read_docs("extensions/books/tools#finish_book")')).toBe(true);
    const done = await client.callTool({ name: "finish_book", arguments: { title: "Dune" } });
    expect(done.isError, text(done)).toBeFalsy();
    const events = await changes((es) => es.some((e) => e.kind === "tool_call" && e.call?.tool === "finish_book" && e.call.served_by === "ext-books") && es.some((e) => e.op === "update_row" && e.table === "work.books.book"), since);
    expect(events.find((e) => e.kind === "tool_call" && e.call?.tool === "finish_book")?.call?.served_by).toBe("ext-books");
    const update = events.find((e) => e.op === "update_row" && e.table === "work.books.book");
    expect(update?.actor).toMatchObject({ auth: "ext-books", harness: "reading-agent via owner", tool: "finish_book" });
  });

  it("the docs tools read the extension's pages", async () => {
    const client = await stdioClient(["--vault", vault.root], io());
    const list = text(await client.callTool({ name: "list_docs", arguments: { prefix: "extensions/" } }));
    expect(list).toContain("extensions/books:");
    expect(list).toContain("extensions/books/tools:");
    expect(text(await client.callTool({ name: "read_docs", arguments: { path: "extensions/books/tools#finish_book" } }))).toMatch(/^## finish_book\n/);
    expect(text(await client.callTool({ name: "search_docs", arguments: { query: "finish book" } }))).toContain("extensions/books/tools#finish_book");
  });

  it("--no-extensions and DATANOTES_MCP_EXTENSIONS=0 leave them out; another value is refused", async () => {
    const engineOnly = await names(await stdioClient(["--vault", vault.root, "--no-extensions"], io()));
    expect(engineOnly).not.toContain("list_reading");
    expect(engineOnly).toContain("select_rows");
    const byEnv = await names(await stdioClient(["--vault", vault.root], io({ [EXTENSIONS_ENV]: "0" })));
    expect(byEnv).toEqual(engineOnly);

    // serve, too
    const served = (await run(["serve", "--url", engineUrl, "--port", "0", "--no-extensions"], io()))!;
    expect(await names(await httpClient(served.url, TOKEN, "http-agent"))).toEqual(engineOnly);

    // a vault no engine runs on: were the variable read after the engine lookup, the command would start
    // fakeIo's engine stub (process.exit(9)) and print "the engine stopped (exit 9)" (R4-Q2)
    const fresh = copyTestVault();
    try {
      const bad = io({ [EXTENSIONS_ENV]: "maybe" });
      expect(await run(["--vault", fresh], bad)).toBeNull();
      await until(() => bad.exits.length > 0, 10_000, "the exit code");
      expect(bad.exits).toEqual([1]);
      // the refusal and nothing else: no engine was looked for or started
      expect(bad.err()).toBe(
        `datanotes mcp: ${EXTENSIONS_ENV} must be 1 or 0: "maybe"\nSet ${EXTENSIONS_ENV}=0 to leave the extensions' tools out, or leave it unset.\nDocs: ${new ToolSelectionError("", "").docs}\n`,
      );
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("--profile read keeps only the read-only extension tools", async () => {
    const fake = io();
    const client = await stdioClient(["--vault", vault.root, "--profile", "read"], fake);
    const listed = await names(client);
    expect(listed).toContain("list_reading");
    expect(listed).not.toContain("finish_book");
    expect(fake.err()).toContain("datanotes mcp: extension books 0.1.0: 1 tools\n");
    const before = await statusOfDune();
    const refused = await client.callTool({ name: "finish_book", arguments: { title: "Dune" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("finish_book");
    expect(await statusOfDune()).toBe(before);
  });

  it("a skipped extension does not stop the server", async () => {
    const file = tokenPath(extensionsHome({ DATANOTES_DATA_HOME: process.env.DATANOTES_DATA_HOME }), fx.databaseId, "books");
    fs.renameSync(file, `${file}.away`);
    try {
      const fake = io();
      const client = await stdioClient(["--vault", vault.root], fake);
      const listed = await names(client);
      expect(listed).not.toContain("list_reading");
      expect(listed).toContain("select_rows");
      expect(fake.err()).toContain("datanotes mcp: extension books skipped: the token of books is not on this machine");
      // the docs tools read the package's docs alone
      const pages = await client.callTool({ name: "list_docs", arguments: {} });
      expect(pages.isError, text(pages)).toBeFalsy();
      expect(text(pages)).not.toContain("extensions/books");
    } finally {
      fs.renameSync(`${file}.away`, file);
    }
  });

  it("HTTP: each session gets the extensions, and a read-only client is refused a write", async () => {
    const reader = await vault.client.post<{ token: string }>("/tokens/create/", { name: "reader", write: [] });
    const fake = io();
    const served = (await run(["serve", "--url", engineUrl, "--port", "0"], fake))!;
    const agent = await httpClient(served.url, reader.token, "reader-agent");
    expect(await names(agent)).toContain("finish_book");
    expect(agent.getInstructions()).toContain("\n\nExtensions:\n- Extension books 0.1.0");
    const refused = await agent.callTool({ name: "finish_book", arguments: { title: "Dune" } });
    expect(refused.isError).toBe(true);
    expect(text(refused).startsWith("token reader may not write work.books.book")).toBe(true);
    const listed = await agent.callTool({ name: "list_reading", arguments: {} });
    expect(listed.isError, text(listed)).toBeFalsy();
    const owner = await httpClient(served.url, TOKEN, "owner-agent");
    const done = await owner.callTool({ name: "finish_book", arguments: { title: "Dune" } });
    expect(done.isError, text(done)).toBeFalsy();
    expect(fake.err().split("datanotes mcp: extension books 0.1.0: 2 tools\n").length - 1).toBe(1);
  });
});

describe("ExtensionSet and the toolbox", () => {
  it("a failed load is tried again, and concurrent prepares share one load", async () => {
    const l = logs();
    let calls = 0;
    const set = fakeSet(async () => {
      calls++;
      if (calls === 1) throw new Error("engine away");
      return fakeLoad(fakeExtension());
    }, l.log);
    expect([set.tools(), set.mounts(), set.instructions(), set.owner("fake_tool")]).toEqual([[], [], "", undefined]);
    await set.prepare("t");
    expect(set.tools()).toEqual([]);
    expect(l.records).toEqual([{ severity: "WARN", body: "datanotes mcp could not load the extensions", attributes: { error: "engine away" } }]);
    await set.prepare("t");
    expect(set.tools().map((t) => t.name)).toEqual(["fake_tool"]);
    expect(set.owner("fake_tool")?.name).toBe("fake");
    expect(set.owner("select_rows")).toBeUndefined();
    await set.prepare("t");
    expect(calls).toBe(2);

    // a fresh set: two prepares at once, one load
    let loads = 0;
    const shared = fakeSet(async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return fakeLoad(fakeExtension());
    });
    await Promise.all([shared.prepare("a"), shared.prepare("b")]);
    expect(loads).toBe(1);

    // a throw that is not an Error is logged too, cut to 300 characters
    const odd = logs();
    await fakeSet(async () => Promise.reject("x".repeat(400)), odd.log).prepare("t");
    expect(odd.records[0]!.attributes).toEqual({ error: "x".repeat(300) });

    // the operator's lines: loaded and skipped extensions
    let err = "";
    await fakeSet(async () => ({ ...fakeLoad(fakeExtension()), skipped: [{ name: "gone", version: "2.0.0", code: "entry", reason: "the code of gone did not load: boom" }] }), undefined, { write: (s: string) => (err += s) }).prepare("t");
    expect(err).toBe("datanotes mcp: extension fake 1.0.0: 1 tools\ndatanotes mcp: extension gone skipped: the code of gone did not load: boom\n");
  });

  it("extensionsEnabled and readOnlyProfile read the options and the environment", () => {
    expect(extensionsEnabled(options({}, ["no-extensions"]), {})).toBe(false);
    expect(extensionsEnabled(options({}, ["no-extensions"]), { [EXTENSIONS_ENV]: "1" })).toBe(false);
    const cases: [string | undefined, boolean][] = [
      [undefined, true],
      ["", true],
      ["1", true],
      [" TRUE ", true],
      ["0", false],
      ["false", false],
    ];
    for (const [v, want] of cases) expect(extensionsEnabled(options(), { [EXTENSIONS_ENV]: v }), String(v)).toBe(want);
    let thrown: unknown;
    try {
      extensionsEnabled(options(), { [EXTENSIONS_ENV]: "maybe" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ToolSelectionError);
    expect((thrown as ToolSelectionError).message).toBe(`${EXTENSIONS_ENV} must be 1 or 0: "maybe"`);
    expect((thrown as ToolSelectionError).hint).toBe(`Set ${EXTENSIONS_ENV}=0 to leave the extensions' tools out, or leave it unset.`);

    expect(readOnlyProfile(options({ profile: "read" }), {})).toBe(true);
    expect(readOnlyProfile(options(), { DATANOTES_MCP_PROFILE: "read" })).toBe(true);
    expect(readOnlyProfile(options({ profile: "write" }), { DATANOTES_MCP_PROFILE: "read" })).toBe(false);
    expect(readOnlyProfile(options(), {})).toBe(false);
  });

  it("instructions and mounts: empty without extensions, filled with them", async () => {
    const lib = openDocs(docs);
    const plain = new Toolbox(engineUrl, undefined, lib);
    expect(plain.instructions()).toBe(ENGINE_INSTRUCTIONS);
    await plain.prepare(TOKEN);
    const engineTools = plain.list();
    expect(engineTools.some((t) => t.name === "fake_tool")).toBe(false);

    const none = fakeSet(async () => fakeLoad(null));
    await none.prepare("t");
    const empty = new Toolbox(engineUrl, undefined, lib, undefined, null, none);
    expect(empty.instructions()).toBe(ENGINE_INSTRUCTIONS);
    expect(empty.list()).toEqual(engineTools);
    expect(none.mounts()).toEqual([]);

    const set = fakeSet(async () => fakeLoad(fakeExtension()));
    await set.prepare("t");
    const box = new Toolbox(engineUrl, undefined, lib, undefined, null, set);
    expect(box.instructions()).toBe(`${ENGINE_INSTRUCTIONS}\n\nExtensions:\n- ${fakeExtension().instructions}`);
    expect(box.list().map((t) => t.name).slice(-1)).toEqual(["fake_tool"]);
    expect(set.mounts()).toEqual([{ prefix: "extensions/fake", dir: path.join(docs, "nowhere") }]);
  });

  it("an extension call that throws is an error result and an ERROR log, without a session too", async () => {
    const l = logs();
    let n = 0;
    const set = fakeSet(async () =>
      fakeLoad(
        fakeExtension(async () => {
          n++;
          if (n === 1) throw new Error("boom");
          throw "bang";
        }),
      ),
    );
    await set.prepare("t");
    const box = new Toolbox(engineUrl, l.log, openDocs(docs), undefined, null, set);
    const first = await box.call(TOKEN, "fake_tool", {}, { harness: "unit", session: "0123456789abcdef" });
    expect(first.isError).toBe(true);
    expect(text(first)).toContain("boom");
    const second = await box.call(TOKEN, "fake_tool", { a: 1 }, { harness: "unit" });
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("bang");
    const failed = l.records.filter((r) => r.body.startsWith("tool fake_tool: failed"));
    expect(failed.map((r) => r.severity)).toEqual(["ERROR", "ERROR"]);
    expect(failed[0]!.attributes).toMatchObject({ served_by: "ext-fake", session: "0123456789abcdef", ok: false });
    expect(failed[1]!.attributes).toMatchObject({ served_by: "ext-fake", arg_names: "a" });
  });
});
