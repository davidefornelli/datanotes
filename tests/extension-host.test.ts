/**
 * The extension host (src/api/extension-host.ts) on a real engine: the `books` fixture extension is
 * installed as the CLI would leave it (tests/helpers/extensions.ts), then loaded and called the way
 * `datanotes mcp` does. Skips, refusals and the client-token check each have a case.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatanotesClient, DatanotesError, fetchTransport, type HttpRequest, type HttpResponse, type Transport } from "../src/api/client";
import { codeDir, sha256Hex, tokenPath, writeTokenFile } from "../src/api/extension-files";
import { ClientTokens, engineActor, extensionDocs, loadExtensions, sourceLabel, tableAllowed, validateModule, type ExtensionCaller, type ExtensionLoad, type HostLog, type LoadedExtension, type LoadOptions } from "../src/api/extension-host";
import { parseManifest } from "../src/api/extension-manifest";
import { DATABASE_ID, type InstalledExtension } from "../src/api/extension-record";
import { storeLocation } from "../src/api/local";
import { BOOKS_V1, installFixture, type FixtureInstall } from "./helpers/extensions";
import { openTestVault, type TestVault } from "./helpers/test-vault";

const OWNER = "test-vault-token";
const WHERE_PERMISSIONS = "administration/extensions.md#what-an-extension-can-do";

let vault: TestVault;
let tmp: string;
let home: string;
let env: Record<string, string>;
let fx: FixtureInstall;
let reader: string;
let writer: string;
let logs: { level: string; body: string; attributes?: Record<string, unknown> }[] = [];
const log: HostLog = (level, body, attributes) => void logs.push({ level, body, ...(attributes ? { attributes } : {}) });
const logged = (body: string) => logs.filter((l) => l.body === body);

beforeAll(async () => {
  vault = await openTestVault("service");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-ext-host-"));
  home = path.join(tmp, "main", "extensions");
  env = { DATANOTES_DATA_HOME: path.join(tmp, "main") };
  fx = await installFixture(vault.client, { home });
  reader = (await vault.client.post<{ token: string }>("/tokens/create/", { name: "reader" })).token;
  writer = (await vault.client.post<{ token: string }>("/tokens/create/", { name: "writer", write: ["work.books.*"] })).token;
}, 60_000);

afterAll(async () => {
  await vault?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  logs = [];
  // records and tokens other tests wrote are gone before the next one; the first install stays
  for (const name of ["books2", "zbooks"]) {
    await vault.client.post("/extensions/delete/", { name });
    await vault.client.post("/tokens/delete/", { name: `ext-${name}` });
  }
  await record(fx.record);
  // every install of the name rotates the token: the main home gets the current secret again
  const rotated = await vault.client.post<{ token: string }>("/tokens/rotate/", { name: "ext-books" });
  writeTokenFile(tokenPath(home, fx.databaseId, "books"), rotated.token);
}, 30_000);

const url = () => vault.client.url;
const record = (r: InstalledExtension) => vault.client.post("/extensions/record/", r);
const load = (o: Partial<LoadOptions> = {}): Promise<ExtensionLoad> => loadExtensions({ engineUrl: url(), token: OWNER, env, log, ...o });
const caller = (clientToken = OWNER, actor: ExtensionCaller["actor"] = { harness: "test-agent", session: "s1" }): ExtensionCaller => ({ actor, clientToken });
const books = async (o: Partial<LoadOptions> = {}): Promise<LoadedExtension> => (await load(o)).loaded[0]!;

/** A transport that answers some requests itself and sends the rest to the engine. */
function intercept(answer: (req: HttpRequest) => HttpResponse | undefined | Promise<HttpResponse | undefined>): Transport {
  return async (req) => (await answer(req)) ?? fetchTransport(req);
}
const json = (status: number, body: unknown): HttpResponse => ({ status, text: JSON.stringify(body) });

/** A copy of the books fixture, with its manifest and entry changed. */
function bookFolder(name: string, edit: { manifest?: (m: any) => void; entry?: string } = {}): string {
  const dir = path.join(tmp, name);
  fs.cpSync(BOOKS_V1, dir, { recursive: true });
  if (edit.manifest) {
    const file = path.join(dir, "datanotes-extension.json");
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    edit.manifest(m);
    fs.writeFileSync(file, JSON.stringify(m, null, 2));
  }
  if (edit.entry !== undefined) fs.writeFileSync(path.join(dir, "lib", "extension.mjs"), edit.entry);
  return dir;
}

/** Install a copy in a home of its own; the registry then holds it. */
async function installIn(name: string, folder: string): Promise<{ fx: FixtureInstall; home: string; env: Record<string, string> }> {
  const h = path.join(tmp, name, "extensions");
  const installed = await installFixture(vault.client, { home: h, folder, createTables: false, commit: `local-${name}` });
  return { fx: installed, home: h, env: { DATANOTES_DATA_HOME: path.join(tmp, name) } };
}

// one test here installs a copy of the fixture (token, record, files): slow under load
describe("loading", { timeout: 30_000 }, () => {
  it("loads the installed books extension", async () => {
    const r = await load();
    expect(r.skipped).toEqual([]);
    expect(r.loaded).toHaveLength(1);
    const ext = r.loaded[0]!;
    expect(ext.name).toBe("books");
    expect(ext.version).toBe("0.1.0");
    expect(ext.servedBy).toBe("ext-books");
    expect(ext.tools.map((t) => t.name)).toEqual(["list_reading", "finish_book"]);
    expect(ext.tools[0]!._meta).toEqual({ "datanotes/extension": "books", "datanotes/tables": ["work.books.book", "work.planning.person"] });
    expect(ext.tools[1]!.annotations).toMatchObject({ readOnlyHint: false });
    expect(ext.tools[1]!.inputSchema).toMatchObject({ required: ["title"] });
    expect(ext.has("finish_book")).toBe(true);
    expect(ext.has("nope")).toBe(false);
    expect(ext.instructions).toBe('Extension books 0.1.0 (list_reading, finish_book): Keep the reading list: list_reading shows what is being read, finish_book marks a book read. Docs: read_docs("extensions/books").');
    expect(r.docsMounts).toEqual([{ prefix: "extensions/books", dir: path.join(fx.dir, "docs") }]);
    expect(r.databaseId).toBe(fx.databaseId);
    expect(logged("extension loaded")).toEqual([{ level: "INFO", body: "extension loaded", attributes: { "datanotes.extension.name": "books", "datanotes.extension.version": "0.1.0" } }]);
  });

  it("the record's database id is the store's", async () => {
    const listed = await vault.client.post<{ database_id: string }>("/extensions/", {});
    expect(listed.database_id).toBe(storeLocation(vault.root)!.id);
    expect(listed.database_id).toMatch(DATABASE_ID);
    expect(fx.databaseId).toBe(listed.database_id);
  });

  it("falls back to the manifest's description when it has no instructions", async () => {
    const folder = bookFolder("noinstr", { manifest: (m) => delete m.instructions });
    const c = await installIn("noinstr", folder);
    const ext = await books({ env: c.env });
    expect(ext.instructions).toBe('Extension books 0.1.0 (list_reading, finish_book): A reading list: books, who wrote them, and what you are reading now Docs: read_docs("extensions/books").');
  });

  it("offers only the read-only tools with readOnlyOnly, and knows no other", async () => {
    const ext = await books({ readOnlyOnly: true });
    expect(ext.tools.map((t) => t.name)).toEqual(["list_reading"]);
    expect(ext.has("list_reading")).toBe(true);
    // a write tool cannot be called by name past --profile read
    expect(ext.has("finish_book")).toBe(false);
    expect(await ext.call("finish_book", { title: "Dune" }, caller())).toEqual({ ok: false, value: "extension books has no tool finish_book" });
    expect((await ext.call("list_reading", {}, caller())).ok).toBe(true);
  });

  it("an engine without the registry gives an empty load", async () => {
    const transport = intercept((req) => (req.url.endsWith("/datanotes/extensions/") ? json(404, { error: "not found" }) : undefined));
    expect(await load({ transport })).toEqual({ databaseId: null, loaded: [], skipped: [], docsMounts: [] });
    expect(logged("extensions not loaded")).toEqual([{ level: "DEBUG", body: "extensions not loaded", attributes: { "datanotes.extension.reason": "no_registry" } }]);
  });

  it("an unreachable engine throws", async () => {
    const transport: Transport = async () => {
      throw new Error("connection refused");
    };
    const e = await load({ transport }).catch((x) => x);
    expect(e).toBeInstanceOf(DatanotesError);
    expect(e.kind).toBe("unreachable");
  });

  it("any other error of the registry route propagates", async () => {
    const transport = intercept((req) => (req.url.endsWith("/datanotes/extensions/") ? json(403, { error: "no" }) : undefined));
    const e = await load({ transport }).catch((x) => x);
    expect(e).toBeInstanceOf(DatanotesError);
    expect(e.status).toBe(403);
  });

  it("works without a log, and gives no time zone when the engine refuses describe_database", async () => {
    const transport = intercept((req) => (req.url.endsWith("/operations/describe_database/") ? json(500, { error: "broken" }) : undefined));
    const r = await load({ transport, log: undefined });
    expect(r.loaded).toHaveLength(1);
    const lines: string[] = [];
    await load({ transport, log: (_l, body) => void lines.push(body) });
    expect(lines).toContain("extension time zone unknown");
  });

  it("an engine that gives no time zone or version leaves them empty", async () => {
    const transport = intercept((req) => {
      if (req.url.endsWith("/operations/describe_database/")) return json(200, { config: {} });
      if (req.method === "GET" && req.url.endsWith("/")) return json(200, {});
      return undefined;
    });
    const ext = await books({ transport });
    const asked = await ext.call("list_reading", {}, caller());
    expect(asked.ok).toBe(true);
    expect((asked.value as { timezone: string }).timezone).toBe("");
    const none = intercept((req) => (req.url.endsWith("/operations/describe_database/") ? json(200, null) : req.method === "GET" && req.url.endsWith("/") ? { status: 200, text: "" } : undefined));
    expect((await books({ transport: none })).name).toBe("books");
  });

  it("loads nothing, and asks nothing else, when no extension is installed", async () => {
    await vault.client.post("/extensions/delete/", { name: "books" });
    const seen: string[] = [];
    const transport = intercept((req) => void seen.push(req.url));
    const r = await load({ transport });
    expect(r).toEqual({ databaseId: fx.databaseId, loaded: [], skipped: [], docsMounts: [] });
    expect(seen).toEqual([`${url()}/datanotes/extensions/`]);
  });

  it("a record without a database id cannot find its token", async () => {
    const transport = intercept(async (req) => (req.url.endsWith("/datanotes/extensions/") ? json(200, { database_id: null, extensions: [fx.record] }) : undefined));
    const r = await load({ transport });
    expect(r.skipped.map((s) => s.code)).toEqual(["token_missing"]);
  });

  it("a record that lacks a role gives the tool no table for it", async () => {
    await record({ ...fx.record, tables: { book: fx.record.tables.book! } });
    const ext = await books();
    expect(ext.tools[0]!._meta["datanotes/tables"]).toEqual(["work.books.book"]);
    await record({ ...fx.record, tables: { person: fx.record.tables.person! } });
    const failed = await (await books()).call("finish_book", { title: "Dune" }, caller());
    expect(failed).toEqual({ ok: false, value: "extension books failed in finish_book: no table for role book" });
    expect(logged("extension tool failed")[0]!.attributes).toMatchObject({ error: "no table for role book", "gen_ai.tool.name": "finish_book", "datanotes.ok": false });
  });
});

describe("a tool call", () => {
  it("runs with the extension's token, for the agent", async () => {
    await vault.ok("insert_row", { table: "work.books.book", values: { title: "Dune", status: "reading" } });
    const ext = await books();
    const listed = await ext.call("list_reading", {}, caller());
    expect(listed.ok).toBe(true);
    expect(listed.value).toMatchObject({ table: "work.books.book", books: [{ title: "Dune" }], timezone: "Europe/Rome", harness: "test-agent" });
    const done = await ext.call("finish_book", { title: "Dune", rating: 5 }, caller());
    expect(done.ok).toBe(true);
    expect(done.value).toMatchObject({ status: "read" });
    const changes = await vault.ok<{ events: { op: string; table: string; actor?: Record<string, string> }[] }>("list_changes", { since: 0 });
    const update = changes.events.find((e) => e.op === "update_row" && e.table === "work.books.book");
    expect(update?.actor).toMatchObject({ auth: "ext-books", harness: "test-agent via owner", tool: "finish_book" });
    expect(logged("extension tool call").map((l) => l.attributes)).toEqual([
      expect.objectContaining({ "gen_ai.tool.name": "list_reading", "datanotes.ok": true, duration_ms: expect.any(Number) }),
      expect.objectContaining({ "gen_ai.tool.name": "finish_book", "datanotes.ok": true }),
    ]);
  });

  it("answers a tool the extension does not have", async () => {
    expect(await (await books()).call("nope", {}, caller())).toEqual({ ok: false, value: "extension books has no tool nope" });
  });

  it("a refusal ends with the extension's docs", async () => {
    const r = await (await books()).call("finish_book", { title: "Nope" }, caller());
    expect(r).toEqual({ ok: false, value: 'no book titled "Nope"\nHint: Call list_reading, or select_rows on the book table, to find the title as written.\nDocs: read_docs("extensions/books/tools#finish_book")' });
    expect(logged("extension tool refused")).toHaveLength(1);
  });

  it("checks the arguments first", async () => {
    const before = await vault.ok<{ rows: unknown[] }>("select_rows", { table: "work.books.book" });
    const r = await (await books()).call("finish_book", { titel: "x" }, caller());
    expect(r.ok).toBe(false);
    expect(String(r.value)).toMatch(/^finish_book: unknown argument "titel"/);
    expect(String(r.value)).toMatch(/\nHint: .*\nDocs: read_docs\("extensions\/books"\)$/);
    expect(await vault.ok("select_rows", { table: "work.books.book" })).toEqual(before);
    expect(logged("extension tool refused")).toHaveLength(1);
  });

  it("refuses a write tool to a client token that may not write the table, before the handler runs", async () => {
    const ext = await books();
    const refused = await ext.call("finish_book", { title: "Dune" }, caller(reader));
    expect(refused.ok).toBe(false);
    const text = String(refused.value);
    expect(text).toMatch(/^token reader may not write work\.books\.book: tool finish_book of extension books writes it\nHint: Ask the owner to add work\.books\.book \(or work\.books\.\*\) to the token's write patterns \(POST \/datanotes\/tokens\/update\/\), or call the tool with a token that may write it\.\nDocs: /);
    expect(text).toContain(WHERE_PERMISSIONS);
    expect((await ext.call("list_reading", {}, caller(reader))).ok).toBe(true);
    expect((await ext.call("finish_book", { title: "Dune" }, caller(writer))).ok).toBe(true);
  });

  it("refuses a token the engine does not know", async () => {
    const r = await (await books()).call("list_reading", {}, caller("not-a-token-the-engine-knows"));
    expect(r.ok).toBe(false);
    expect(String(r.value)).toMatch(/^the engine refused the client's token\nHint: Connect with a token the engine knows/);
    expect(String(r.value)).toContain(WHERE_PERMISSIONS);
  });

  it("passes an engine refusal through with its own guidance", async () => {
    const ext = await books();
    await vault.ok("update_row", { table: "work.books.book", path: (await vault.ok<{ rows: { path: string }[] }>("select_rows", { table: "work.books.book", where: { title: "Dune" } })).rows[0]!.path, unset: ["rating"] });
    await vault.ok("add_constraint", { table: "work.books.book", name: "dune_is_never_rated", check: { or: [{ title: { ne: "Dune" } }, { rating: { exists: false } }] }, hint: "Dune is never rated." });
    try {
      const r = await ext.call("finish_book", { title: "Dune", rating: 4 }, caller());
      expect(r.ok).toBe(false);
      expect(String(r.value)).toContain("Hint: Dune is never rated.");
      expect(String(r.value)).toMatch(/\nDocs: https:\/\/datanotes\.dev\//);
      expect(String(r.value)).not.toContain("read_docs(\"extensions/");
      const rows = await vault.ok<{ rows: { rating?: number }[] }>("select_rows", { table: "work.books.book", where: { title: "Dune" } });
      expect(rows.rows[0]!.rating).toBeUndefined();
    } finally {
      await vault.ok("drop_constraint", { table: "work.books.book", name: "dune_is_never_rated" });
    }
  });
});

/** An entry whose tools probe the context and the shapes of refusals. */
const PROBE = `
class ToolError extends Error {
  constructor(message, hint, docs) { super(message); this.name = "ToolError"; this.hint = hint; this.docs = docs; }
}
export default {
  api: 1,
  handlers: {
    async list_reading(_args, ctx) {
      const out = {};
      for (const [k, op, a] of [
        ["insert", "insert_row", { table: ctx.table("book"), values: { title: "Sneaky" } }],
        ["batch", "batch", { operations: [{ op: "insert_row", table: ctx.table("book"), values: { title: "Sneaky" } }] }],
        ["restore", "restore_table", { table: ctx.table("book") }],
        ["update", "update_rows", { table: ctx.table("book"), where: {}, set: { status: "read" } }],
      ]) out[k] = await ctx.callTool(op, a);
      out.read = (await ctx.callTool("select_rows", { table: ctx.table("book"), where: { title: "Sneaky" } })).ok;
      return out;
    },
    async finish_book(args, ctx) {
      const t = args.title;
      if (t === "plain") throw new Error("kaput");
      if (t === "string") throw "just text";
      if (t === "hint") throw new ToolError("what is wrong", "how to fix it");
      if (t === "hint-text") throw new ToolError("what is wrong\\nHint: already there\\nDocs: read_docs(\\"x\\")", "ignored");
      if (t === "docs-index") throw new ToolError("what is wrong", "fix", "index#top");
      if (t === "docs-empty") throw new ToolError("what is wrong", "fix", "");
      if (t === "docs-only") throw new ToolError("what is wrong", undefined, "tools");
      if (t === "empty-hint") throw new ToolError("what is wrong", "");
      if (t === "none") throw new ToolError("what is wrong");
      if (t === "offline") { const r = await ctx.callTool("select_rows", { table: ctx.table("book") }); return r; }
      const attempt = (f) => { try { return f(); } catch (e) { return "throws: " + e.message; } };
      ctx.log("INFO", "probe", { n: 1 });
      return {
        session: ctx.session ?? null,
        actor: ctx.actor(),
        book: ctx.table("book"),
        person: ctx.table("person"),
        title: ctx.column("book", "title"),
        name: ctx.column("person", "name"),
        other: ctx.column("person", "email"),
        hasName: ctx.hasColumn("person", "name"),
        hasShelf: ctx.hasColumn("person", "shelf"),
        tz: ctx.timezone,
        ext: ctx.extension,
        noTable: attempt(() => ctx.table("nope")),
        noColumn: attempt(() => ctx.column("nope", "x")),
        noHas: attempt(() => ctx.hasColumn("nope", "x")),
      };
    },
  },
};
`;

describe("the context and the refusals of a tool", () => {
  async function probe(name: string, over: Partial<InstalledExtension> = {}) {
    const c = await installIn(name, bookFolder(name, { entry: PROBE }));
    await record({ ...c.fx.record, ...over });
    return { ext: await books({ env: c.env }), c };
  }

  it("gives the handler the table bindings, the mapping, the session and the time zone", async () => {
    const { ext } = await probe("ctx", { tables: { person: { table: "work.planning.person", owned: false, columns: { name: "full_name" }, absent: ["shelf"] }, book: { table: "work.books.book", owned: true } } });
    const r = await ext.call("finish_book", { title: "context" }, caller(OWNER, { harness: "test-agent", session: "s9", model: "m1" }));
    expect(r.value).toEqual({
      session: "s9",
      actor: { harness: "test-agent", session: "s9", model: "m1" },
      book: "work.books.book",
      person: "work.planning.person",
      title: "title",
      name: "full_name",
      other: "email",
      hasName: true,
      hasShelf: false,
      tz: "Europe/Rome",
      ext: { name: "books", version: "0.1.0" },
      noTable: "throws: no table for role nope",
      noColumn: "throws: no table for role nope",
      noHas: "throws: no table for role nope",
    });
    expect(logs.find((l) => l.body === "probe")).toEqual({ level: "INFO", body: "probe", attributes: { n: 1, "datanotes.extension.name": "books", "datanotes.extension.version": "0.1.0" } });
    const noSession = await ext.call("finish_book", { title: "context" }, caller(OWNER, {}));
    expect((noSession.value as { session: unknown }).session).toBeNull();
  });

  it("keeps the manifest's column names when the record maps and drops none", async () => {
    const { ext } = await probe("plainbinding");
    const r = await ext.call("finish_book", { title: "context" }, caller());
    expect(r.value).toMatchObject({ name: "name", other: "email", hasName: true, hasShelf: true });
  });

  it("a tool that declares no writes may not write rows, whatever its token can do", async () => {
    const { ext } = await probe("readonly");
    const r = (await ext.call("list_reading", {}, caller())).value as Record<string, { ok: boolean; value: string } | boolean>;
    for (const k of ["insert", "batch", "restore", "update"]) {
      const a = r[k] as { ok: boolean; value: string };
      expect(a.ok).toBe(false);
      expect(a.value).toMatch(/^tool list_reading of extension books declares no writes: it may not call (insert_row|batch|restore_table|update_rows)\nHint: Declare the roles the tool writes in the manifest/);
      expect(a.value).toContain("write-an-extension.md#write-the-tools");
    }
    expect(r.read).toBe(true);
    const rows = await vault.ok<{ rows: unknown[] }>("select_rows", { table: "work.books.book", where: { title: "Sneaky" } });
    expect(rows.rows).toEqual([]);
  });

  it("shows a tool that declares writes the rows it may write", async () => {
    const { ext } = await probe("writes");
    const ok = await ext.call("finish_book", { title: "offline" }, caller());
    expect(ok.ok).toBe(true);
    expect((ok.value as { ok: boolean }).ok).toBe(true);
  });

  it.each([
    ["hint", 'what is wrong\nHint: how to fix it\nDocs: read_docs("extensions/books")'],
    ["hint-text", 'what is wrong\nHint: already there\nDocs: read_docs("x")'],
    ["docs-index", 'what is wrong\nHint: fix\nDocs: read_docs("extensions/books#top")'],
    ["docs-empty", 'what is wrong\nHint: fix\nDocs: read_docs("extensions/books")'],
    ["docs-only", 'what is wrong\nDocs: read_docs("extensions/books/tools")'],
    ["empty-hint", "what is wrong"],
    ["none", "what is wrong"],
  ])("answers a ToolError (%s) as a refusal", async (title, text) => {
    const { ext } = await probe(`tool-${title}`);
    const r = await ext.call("finish_book", { title }, caller());
    expect(r).toEqual({ ok: false, value: text });
    expect(logged("extension tool refused")).toHaveLength(1);
    expect(logged("extension tool failed")).toHaveLength(0);
  });

  it.each([
    ["plain", "kaput"],
    ["string", "just text"],
  ])("any other error (%s) is a failure, logged", async (title, message) => {
    const { ext } = await probe(`fail-${title}`);
    const r = await ext.call("finish_book", { title }, caller());
    expect(r).toEqual({ ok: false, value: `extension books failed in finish_book: ${message}` });
    expect(logged("extension tool failed")).toEqual([{ level: "ERROR", body: "extension tool failed", attributes: expect.objectContaining({ error: message, "gen_ai.tool.name": "finish_book", "datanotes.ok": false }) }]);
  });

  it("cuts a long error to 300 characters in the log, and answers it whole", async () => {
    const long = "x".repeat(400);
    const c = await installIn("long", bookFolder("long", { entry: `export default { api: 1, handlers: { list_reading: async () => ({}), finish_book: async () => { throw new Error("${long}"); } } };` }));
    const r = await (await books({ env: c.env })).call("finish_book", { title: "a" }, caller());
    expect(String(r.value)).toContain(long);
    expect(String(logged("extension tool failed")[0]!.attributes!.error)).toHaveLength(300);
  });

  it("an engine call that cannot reach the engine answers its message", async () => {
    const c = await installIn("unreachable", bookFolder("unreachable", { entry: `export default { api: 1, handlers: { list_reading: async (_a, ctx) => ctx.callTool("select_rows", { table: ctx.table("book") }), finish_book: async () => ({}) } };` }));
    let down = false;
    const ext = await books({
      env: c.env,
      transport: intercept(async (req) => {
        if (down && req.headers.Authorization === `Bearer ${c.fx.token}`) throw new Error("offline");
        return undefined;
      }),
    });
    down = true;
    const r = await ext.call("list_reading", {}, caller());
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ ok: false, value: expect.stringContaining("engine unreachable") });
  });
});

// each test installs one or two copies of the fixture: up to 25 s seen under load
describe("what is skipped", { timeout: 60_000 }, () => {
  const skipped = (r: ExtensionLoad) => r.skipped.map((s) => [s.code, s.reason]);

  it("code_missing: the cached code is gone", async () => {
    const c = await installIn("missing", bookFolder("missing"));
    fs.rmSync(c.fx.dir, { recursive: true });
    const r = await load({ env: c.env });
    expect(skipped(r)).toEqual([["code_missing", `the code of books 0.1.0 is not on this machine (${c.fx.dir}): run datanotes extension install ${c.fx.record.source.path} again, which repairs the installation`]]);
    expect(r.loaded).toEqual([]);
    expect(r.docsMounts).toEqual([]);
    expect(logged("extension skipped")).toEqual([{ level: "WARN", body: "extension skipped", attributes: { "datanotes.extension.name": "books", "datanotes.extension.version": "0.1.0", "datanotes.extension.reason": "code_missing" } }]);
  });

  it("code_changed: the cached entry or manifest differs from the record", async () => {
    const c = await installIn("changed", bookFolder("changed"));
    const reason = `the cached code of books differs from what was installed: run datanotes extension install ${c.fx.record.source.path} again`;
    const entry = path.join(c.fx.dir, "lib", "extension.mjs");
    const original = fs.readFileSync(entry);
    fs.appendFileSync(entry, "\n");
    expect(skipped(await load({ env: c.env }))).toEqual([["code_changed", reason]]);
    fs.rmSync(entry);
    expect(skipped(await load({ env: c.env }))).toEqual([["code_changed", reason]]);
    fs.writeFileSync(entry, original);
    fs.appendFileSync(path.join(c.fx.dir, "datanotes-extension.json"), " ");
    expect(skipped(await load({ env: c.env }))).toEqual([["code_changed", reason]]);
  });

  it("token_missing: this machine has no token for it", async () => {
    const c = await installIn("notoken", bookFolder("notoken"));
    fs.rmSync(tokenPath(c.home, c.fx.databaseId, "books"));
    expect(skipped(await load({ env: c.env }))).toEqual([["token_missing", `the token of books is not on this machine: run datanotes extension install ${c.fx.record.source.path} again (it gives the extension a new token)`]]);
  });

  it("code_missing: a record whose name or commit is not a plain folder name, even when that path holds the code (R2-Q3)", async () => {
    const c = await installIn("traverse", bookFolder("traverse"));
    // <home>/code/books/../elsewhere is <home>/code/elsewhere: a copy of the code waits there
    expect(codeDir(c.home, "books", "../elsewhere")).toBe(path.join(c.home, "code", "elsewhere"));
    fs.cpSync(c.fx.dir, path.join(c.home, "code", "elsewhere"), { recursive: true });
    const listing = (r: Record<string, unknown>): Transport =>
      intercept((req) => (req.url.endsWith("/datanotes/extensions/") ? json(200, { database_id: c.fx.databaseId, extensions: [r] }) : undefined));
    const reason = (name: string) => `the record of ${name} 0.1.0 has an invalid name or commit: run datanotes extension install ${c.fx.record.source.path} again, which repairs the installation`;
    const cases: [Record<string, unknown>, string][] = [
      [{ commit: "../elsewhere" }, "books"],
      [{ commit: "local-../elsewhere" }, "books"],
      [{ name: "../books" }, "../books"],
      // JSON drops the key: the record arrives without a name
      [{ name: undefined }, "undefined"],
    ];
    for (const [over, shown] of cases) {
      const r = await load({ env: c.env, transport: listing({ ...c.fx.record, ...over }) });
      expect(skipped(r), JSON.stringify(over)).toEqual([["code_missing", reason(shown)]]);
      expect(r.loaded).toEqual([]);
      expect(r.docsMounts).toEqual([]);
    }
    // the same listing with the record's own commit loads it: the listing is not the cause
    expect((await load({ env: c.env, transport: listing({ ...c.fx.record }) })).loaded.map((e) => e.name)).toEqual(["books"]);
  });

  it("token_missing: a database id that is not a UUID counts as none, even when its path holds a token (R2-Q3)", async () => {
    // <home>/tokens/../stolen/books.token is <home>/stolen/books.token: a valid token waits there
    const stolen = tokenPath(home, "../stolen", "books");
    expect(stolen).toBe(path.join(home, "stolen", "books.token"));
    fs.mkdirSync(path.dirname(stolen), { recursive: true });
    fs.copyFileSync(tokenPath(home, fx.databaseId, "books"), stolen);
    try {
      const transport = intercept((req) => (req.url.endsWith("/datanotes/extensions/") ? json(200, { database_id: "../stolen", extensions: [fx.record] }) : undefined));
      const r = await load({ transport });
      expect(r.databaseId).toBeNull();
      expect(r.loaded).toEqual([]);
      expect(skipped(r)).toEqual([["token_missing", `the token of books is not on this machine: run datanotes extension install ${fx.record.source.path} again (it gives the extension a new token)`]]);
    } finally {
      fs.rmSync(path.join(home, "stolen"), { recursive: true, force: true });
    }
  });

  it("api: the record names a newer module API", async () => {
    const c = await installIn("api", bookFolder("api"));
    await record({ ...c.fx.record, api: 2 });
    expect(skipped(await load({ env: c.env }))).toEqual([["api", "extension books uses extension API 2; this server supports 1: update Datanotes"]]);
  });

  it("engine: the engine is older than the manifest needs", async () => {
    const c = await installIn("engine", bookFolder("engine", { manifest: (m) => (m.datanotes = ">=99.0.0") }));
    const transport = intercept((req) => (req.method === "GET" && req.url.endsWith("/") ? json(200, { status: "ok", version: "3.2.0" }) : undefined));
    expect(skipped(await load({ env: c.env, transport }))).toEqual([["engine", "books 0.1.0 needs Datanotes >=99.0.0; the engine is 3.2.0"]]);
    // a source run ("dev") meets every range
    expect((await load({ env: c.env })).loaded).toHaveLength(1);
  });

  it("tool_taken: a tool of the server, and a tool of another extension", async () => {
    const c = await installIn("taken", bookFolder("taken"));
    expect(skipped(await load({ env: c.env, reserved: ["list_reading"] }))).toEqual([["tool_taken", "tool list_reading of books is also a tool of this server"]]);
    const second = await installIn("taken2", bookFolder("taken2", { manifest: (m) => (m.name = "books2") }));
    // both extensions in one home: copy the second's code and token next to the first's
    fs.cpSync(second.home, c.home, { recursive: true });
    const r = await load({ env: c.env });
    expect(r.loaded.map((e) => e.name)).toEqual(["books"]);
    expect(skipped(r)).toEqual([["tool_taken", "tool list_reading of books2 is also a tool of extension books"]]);
    expect(r.docsMounts.map((m) => m.prefix)).toEqual(["extensions/books"]);
  });

  it("an extension skipped for another reason does not hold its tools", async () => {
    const c = await installIn("holds", bookFolder("holds", { entry: "throw new Error('boom');\nexport default {};" }));
    const second = await installIn("holds2", bookFolder("holds2", { manifest: (m) => (m.name = "books2") }));
    fs.cpSync(second.home, c.home, { recursive: true });
    const r = await load({ env: c.env });
    expect(r.loaded.map((e) => e.name)).toEqual(["books2"]);
    expect(skipped(r)).toEqual([["entry", "the code of books did not load: boom"]]);
  });

  it("entry: the code throws when it loads", async () => {
    const c = await installIn("throws", bookFolder("throws", { entry: "throw new Error('boom');\nexport default {};" }));
    expect(skipped(await load({ env: c.env }))).toEqual([["entry", "the code of books did not load: boom"]]);
    const text = await installIn("throwstext", bookFolder("throwstext", { entry: "throw 'plain';\nexport default {};" }));
    expect(skipped(await load({ env: text.env }))).toEqual([["entry", "the code of books did not load: plain"]]);
  });

  it("entry: the cached manifest cannot be read", async () => {
    const c = await installIn("badmanifest", bookFolder("badmanifest"));
    const file = path.join(c.fx.dir, "datanotes-extension.json");
    fs.writeFileSync(file, "{");
    await record({ ...c.fx.record, manifest_sha256: sha256Hex("{") });
    const [code, reason] = skipped(await load({ env: c.env }))[0]!;
    expect(code).toBe("entry");
    expect(reason).toMatch(/^the code of books did not load: .*not JSON/);
  });

  it("entry: a tool whose annotations are not an object", async () => {
    const c = await installIn("annotations", bookFolder("annotations"));
    const file = path.join(c.fx.dir, "datanotes-extension.json");
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.tools[0].annotations = "read only";
    const text = JSON.stringify(m);
    fs.writeFileSync(file, text);
    await record({ ...c.fx.record, manifest_sha256: sha256Hex(text) });
    expect(skipped(await load({ env: c.env }))).toEqual([["entry", "the code of books did not load: tools[0].annotations: must be an object"]]);
  });

  it("handler: the code does not fit its manifest", async () => {
    const c = await installIn("nohandler", bookFolder("nohandler", { entry: "export default { api: 1, handlers: { list_reading: async () => ({}) } };" }));
    expect(skipped(await load({ env: c.env }))).toEqual([["handler", "the code of books does not fit its manifest: no handler for tool finish_book"]]);
  });

  it("loads the other extensions when one is skipped", async () => {
    const good = await installIn("good", bookFolder("good", { manifest: (m) => (m.name = "zbooks") }));
    const bad = await installIn("bad", bookFolder("bad", { entry: "export default 5;" }));
    fs.cpSync(good.home, bad.home, { recursive: true });
    const r = await load({ env: bad.env });
    expect(r.loaded.map((e) => e.name)).toEqual(["zbooks"]);
    expect(skipped(r)).toEqual([["handler", "the code of books does not fit its manifest: the default export is not an object"]]);
  });
});

describe("pure helpers", () => {
  it("tableAllowed follows the rule of the engine's named tokens", () => {
    expect(tableAllowed("work.books.book", ["*"])).toBe(true);
    expect(tableAllowed("work.books.book", ["work.*"])).toBe(true);
    expect(tableAllowed("work.books.book", ["work.books.*"])).toBe(true);
    expect(tableAllowed("work.books.book", ["work.books.book"])).toBe(true);
    expect(tableAllowed("work.books.book", ["work.books.bookmark"])).toBe(false);
    expect(tableAllowed("work.books.book", ["work.book.*"])).toBe(false);
    expect(tableAllowed("work.books.book", ["other.*", "work.books.book"])).toBe(true);
    expect(tableAllowed("work.books.book", [])).toBe(false);
  });

  it("engineActor names the client in the harness", () => {
    expect(engineActor({ harness: "claude-code", session: "s" }, "start_task", "phone")).toEqual({ harness: "claude-code via phone", session: "s", tool: "start_task" });
    expect(engineActor({}, "t", "phone")).toEqual({ harness: "phone", tool: "t" });
    expect(engineActor({ harness: "phone" }, "t", "phone")).toEqual({ harness: "phone", tool: "t" });
    expect(engineActor({ harness: "claude-code" }, "t", null)).toEqual({ harness: "claude-code", tool: "t" });
    expect(engineActor({}, "t", null)).toEqual({ tool: "t" });
  });

  it("sourceLabel gives the git url with its ref, or the folder", () => {
    const r = (source: InstalledExtension["source"]) => ({ ...fx.record, source });
    expect(sourceLabel(r({ kind: "git", url: "https://example.com/books.git", ref: "v0.1.0" }))).toBe("https://example.com/books.git#v0.1.0");
    expect(sourceLabel(r({ kind: "git", url: "https://example.com/books.git" }))).toBe("https://example.com/books.git");
    expect(sourceLabel(r({ kind: "git" }))).toBe("");
    expect(sourceLabel(r({ kind: "local", path: "C:/work/books" }))).toBe("C:/work/books");
    expect(sourceLabel(r({ kind: "local" }))).toBe("");
  });

  it("validateModule lists what does not fit", () => {
    const manifest = parseManifest(fs.readFileSync(path.join(BOOKS_V1, "datanotes-extension.json"), "utf8"));
    const fine = { api: 1, handlers: { list_reading: () => 1, finish_book: () => 2, extra: () => 3 } };
    expect(validateModule(fine, manifest)).toEqual([]);
    expect(validateModule(null, manifest)).toEqual(["the default export is not an object"]);
    expect(validateModule(7, manifest)).toEqual(["the default export is not an object"]);
    expect(validateModule({ api: 2, handlers: {} }, manifest)).toEqual(["api must be 1, not 2", "no handler for tool list_reading", "no handler for tool finish_book"]);
    expect(validateModule({ handlers: null }, manifest)).toEqual(["api must be 1, not undefined", "handlers must be an object"]);
    expect(validateModule({ api: 1 }, manifest)).toEqual(["handlers must be an object"]);
    expect(validateModule({ api: 1, handlers: { list_reading: () => 1, finish_book: "no" } }, manifest)).toEqual(["handlers.finish_book is not a function"]);
  });

  it("extensionDocs opens the package docs with the mounts", () => {
    const mounts = [{ prefix: "extensions/books", dir: path.join(BOOKS_V1, "docs") }];
    const lib = extensionDocs(mounts, null);
    expect(lib.dir).toBeNull();
    expect(lib.mounts).toEqual(mounts);
    expect(extensionDocs(mounts, null)).toBe(lib);
    expect(extensionDocs(mounts).mounts).toEqual(mounts);
  });
});

describe("ClientTokens", () => {
  const tokenMe = (answers: HttpResponse[]) => {
    const seen: string[] = [];
    const transport: Transport = async (req) => {
      seen.push(req.headers.Authorization!);
      return answers.shift()!;
    };
    return { seen, transport };
  };

  it("describes a named token, the owner and a refused token, and caches what the engine said", async () => {
    let now = 1_000;
    const t = tokenMe([json(200, { entry: { name: "writer", write: ["work.books.*"] } }), json(400, { error: "call this with a named token" }), json(401, { error: "no" }), json(401, { error: "no" })]);
    const tokens = new ClientTokens("http://127.0.0.1:1", t.transport, 60_000, () => now);
    expect(await tokens.describe("named-token-secret-1")).toEqual({ name: "writer", write: ["work.books.*"] });
    expect(await tokens.describe("named-token-secret-1")).toEqual({ name: "writer", write: ["work.books.*"] });
    expect(t.seen).toHaveLength(1);
    expect(await tokens.describe("owner-token-secret-123")).toEqual({ name: "owner", write: "all" });
    // a refused token is not cached
    expect(await tokens.describe("refused-token-secret-1")).toBeNull();
    expect(await tokens.describe("refused-token-secret-1")).toBeNull();
    expect(t.seen).toHaveLength(4);
    // the cache ends after its time
    now += 60_001;
    const again = tokenMe([json(200, { entry: { name: "writer" } })]);
    const later = new ClientTokens("http://127.0.0.1:1", again.transport, 60_000, () => now);
    expect(await later.describe("named-token-secret-1")).toEqual({ name: "writer", write: [] });
  });

  it("expires an answer, and reads a token with no entry as unknown", async () => {
    let now = 0;
    const t = tokenMe([json(200, { entry: { name: "a", write: [] } }), json(200, { entry: { name: "b", write: ["*"] } }), json(200, { entry: null }), json(200, {})]);
    const tokens = new ClientTokens("http://127.0.0.1:1", t.transport, 10, () => now);
    expect(await tokens.describe("some-token-secret-12345")).toEqual({ name: "a", write: [] });
    now = 11;
    expect(await tokens.describe("some-token-secret-12345")).toEqual({ name: "b", write: ["*"] });
    expect(await tokens.describe("entry-null-secret-12345")).toBeNull();
    expect(await tokens.describe("entry-none-secret-12345")).toBeNull();
  });

  it("propagates the other errors", async () => {
    const down = new ClientTokens("http://127.0.0.1:1", async () => {
      throw new Error("down");
    });
    const e = await down.describe("some-token-secret-12345").catch((x) => x);
    expect(e).toBeInstanceOf(DatanotesError);
    expect(e.kind).toBe("unreachable");
    const odd = new ClientTokens("http://127.0.0.1:1", async () => json(404, { error: "no route" }));
    const f = await odd.describe("some-token-secret-12345").catch((x) => x);
    expect(f).toBeInstanceOf(DatanotesError);
    expect(f.status).toBe(404);
  });

  it("works with the default transport, ttl and clock", async () => {
    expect(await new ClientTokens(url()).describe(OWNER)).toEqual({ name: "owner", write: "all" });
    expect(await new ClientTokens(url()).describe(reader)).toEqual({ name: "reader", write: [] });
  });
});

it("keeps the fixture's source label for a folder with forward slashes", () => {
  expect(fx.record.source.path).not.toContain("\\");
  expect(codeDir(home, "books", fx.record.commit)).toBe(fx.dir);
});

export type { InstalledExtension };
