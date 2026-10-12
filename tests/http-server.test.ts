import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DocsLibrary } from "../src/api/docs";
import { INDEX_RETRY } from "../src/core/engine";
import { listenError, newToken, HttpApiServer } from "../src/server/http-server";
import { searchNotes } from "../src/core/vault-read";
import { createHandlers } from "../src/server/rest";
import { listMigrations } from "../src/core/journal";
import { logVault } from "./helpers/db-vault";
import { docsFixture } from "./helpers/docs-fixture";
import { guided } from "./helpers/guidance";

INDEX_RETRY.delayMs = 1;

let server: HttpApiServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function start(extra: Record<string, string> = {}) {
  const v = logVault({ "Notes/Café.md": "---\ntags: [trip]\n---\nA dinner in Paris with Alice.\n#memory\n", ...extra });
  const token = newToken();
  server = new HttpApiServer({ app: v.app, handlers: createHandlers(v.app, () => v.settings), token, port: 0, version: "9.9.9" });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}, auth = true) =>
    fetch(`${base}${path}`, { ...init, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  return { v, call, token, port };
}

describe("plugin HTTP server", () => {
  it("status is public, everything else needs the bearer token", async () => {
    const { call } = await start();
    expect(await (await call("/", {}, false)).json()).toEqual({ status: "OK", service: "datanotes", version: "9.9.9", authenticated: false, auth: null });
    expect(await (await call("/")).json()).toMatchObject({ authenticated: true, auth: "owner" });
    expect((await call("/datanotes/operations/list_tables/", { method: "POST" }, false)).status).toBe(401);
    expect((await call("/datanotes/operations/list_folder/", { method: "POST" }, false)).status).toBe(401);
    expect((await call("/datanotes/operations/list_tables/", { method: "POST", headers: { Authorization: "Bearer wrong" } }, false)).status).toBe(401);
  });

  it("serves the database routes with the actor header", async () => {
    const { v, call } = await start();
    const tables = await call("/datanotes/operations/list_tables/", { method: "POST" });
    expect(tables.status).toBe(200);
    expect(((await tables.json()) as { tables: { qualified: string }[] }).tables.map((t) => t.qualified)).toEqual(["main.public.log"]);
    const ins = await call("/datanotes/operations/insert_row/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Datanotes-Actor": JSON.stringify({ harness: "test", model: "m" }) },
      body: JSON.stringify({ table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } }),
    });
    expect(ins.status).toBe(200);
    const ops = await listMigrations(v.app, v.settings, { op: "insert_row" });
    expect(ops.migrations[0]).toMatchObject({ by: "test / m" });
    expect((await call("/datanotes/operations/select_rows/", { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await call("/datanotes/nope/", { method: "POST" })).status).toBe(404);
    const unknown = await call("/datanotes/operations/select_row/", { method: "POST" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "unknown operation select_row", hint: expect.stringMatching(/^Did you mean select_rows\? /) });
    // an operation answers POST only
    expect((await call("/datanotes/operations/list_tables/")).status).toBe(405);
    expect((await call("/datanotes/operations/insert_row/", { method: "POST", body: JSON.stringify({ table: "log", values: { kind: "bad", occurred_at: "2026-09-28T10:00" } }) })).status).toBe(422);
    // an argument the operation does not take is refused, never ignored
    const misspelled = await call("/datanotes/operations/select_rows/", { method: "POST", body: JSON.stringify({ table: "log", wher: { kind: "mood" } }) });
    expect(misspelled.status).toBe(400);
    expect(await misspelled.json()).toMatchObject({ error: `select_rows: unknown argument "wher"`, hint: expect.stringMatching(/^For "wher" use "where"\./) });
  });

  it("serves notes, folders and plain-text search as operations", async () => {
    const { call } = await start();
    const op = (name: string, args: Record<string, unknown>) => call(`/datanotes/operations/${name}/`, { method: "POST", body: JSON.stringify(args) });
    const root = (await (await op("list_folder", {})).json()) as { folders: string[] };
    expect(root.folders).toEqual(expect.arrayContaining(["Daily", "Datanotes", "Notes"]));
    expect(await (await op("list_folder", { folder: "Notes" })).json()).toEqual({ folder: "Notes", folders: [], files: ["Notes/Café.md"] });
    const json = (await (await op("read_note", { path: "Notes/Café.md" })).json()) as Record<string, unknown>;
    expect(json).toMatchObject({ path: "Notes/Café.md", front_matter: { tags: ["trip"] } });
    expect(json.content).toContain("A dinner in Paris");
    expect(json.tags).toEqual(expect.arrayContaining(["trip"]));
    expect((await op("read_note", { path: "Nope.md" })).status).toBe(404);
    expect((await op("list_folder", { folder: "Nope" })).status).toBe(404);
    const hits = (await (await op("search_notes", { query: "dinner ALICE", context_length: 5 })).json()) as { results: { path: string; matches: { context: string }[] }[] };
    expect(hits.results.map((h) => h.path)).toEqual(["Notes/Café.md"]);
    expect(hits.results[0]!.matches[0]!.context).toContain("dinner");
    expect((await call("/elsewhere", { method: "POST" })).status).toBe(404);
  });

  it("plain-text search matches accents and file names, and refuses a busy port", async () => {
    const { v, port } = await start();
    expect((await searchNotes(v.app, "cafe")).results.map((h) => h.path)).toEqual(["Notes/Café.md"]);
    expect(await searchNotes(v.app, "   ")).toEqual({ query: "   ", results: [], total: 0 });
    const other = new HttpApiServer({ app: v.app, handlers: {}, token: "t", port });
    await expect(other.start(1, 10)).rejects.toThrow(/already in use/);
  });

  it("stop frees the port at once even with keep-alive clients connected", async () => {
    const { call, port, v } = await start();
    const agent = await import("node:http");
    const keep = new agent.Agent({ keepAlive: true });
    await new Promise<void>((resolve) => {
      agent.get({ host: "127.0.0.1", port, path: "/", agent: keep }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
    });
    void call; // the connection stays open in the agent
    const t0 = Date.now();
    await server!.stop();
    server = null;
    expect(Date.now() - t0).toBeLessThan(1500);
    const again = new HttpApiServer({ app: v.app, handlers: {}, token: "t", port });
    expect(await again.start(0, 10)).toBe(port);
    await again.stop();
    keep.destroy();
  });
});

describe("GET /datanotes/manual/: the docs of this version", () => {
  const dir = docsFixture();
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function manual(docs: DocsLibrary | undefined) {
    const v = logVault({});
    const token = newToken();
    server = new HttpApiServer({ app: v.app, handlers: createHandlers(v.app, () => v.settings), token, port: 0, version: "9.9.9", ...(docs ? { docs } : {}) });
    const base = `http://127.0.0.1:${await server.start()}`;
    return (p: string, auth = true) => fetch(`${base}${p}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });
  }

  it("an index, a page, a section; with a token like the other routes", async () => {
    const get = await manual(new DocsLibrary(dir));
    expect((await get("/datanotes/manual/", false)).status).toBe(401);
    const index = await get("/datanotes/manual");
    expect(index.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await index.text();
    expect(text).toMatch(/^# Datanotes documentation\n\nThe docs of this engine's version, as Markdown: GET \/datanotes\/manual\/<page>\.md/);
    expect(text).toContain("- [Querying rows](/datanotes/manual/examples/queries.md): Read rows with select_rows: filters, operators and views.");
    expect(text).toContain("- [Give each program its own token](/datanotes/manual/guides/tokens.md)\n");
    expect(await (await get("/datanotes/manual/examples/queries.md")).text()).toBe(fs.readFileSync(path.join(dir, "examples", "queries.md"), "utf8"));
    expect(await (await get("/datanotes/manual/examples%2Fqueries.md?section=store-a-query-as-a-view")).text()).toBe("## Store a query as a view\n\n`create_view` stores a select_rows query under a name.\n");
  });

  it("an unknown page or section is a 404 with the closest ones; no docs is a 503 that says how to build them", async () => {
    const get = await manual(new DocsLibrary(dir));
    const page = await get("/datanotes/manual/examples/querys.md");
    expect(page.status).toBe(404);
    expect(await page.json()).toEqual(guided('no docs page "examples/querys"', { hint: expect.stringMatching(/^Did you mean "examples\/queries"\?/) }));
    const section = await get("/datanotes/manual/examples/queries.md?section=nope");
    expect([section.status, ((await section.json()) as { error: string }).error]).toEqual([404, 'examples/queries has no section "#nope"']);
    await server!.stop();
    const none = await (await manual(new DocsLibrary(null)))("/datanotes/manual/");
    expect(none.status).toBe(503);
    expect(await none.json()).toEqual(guided("the Datanotes docs are not in this installation", { hint: expect.stringContaining("npm run build") }));
  });

  it("the package's own docs by default; an unexpected failure is a 500", async () => {
    const own = await (await manual(undefined))("/datanotes/manual/");
    expect([200, 503]).toContain(own.status);
    await server!.stop();
    const broken = { list: () => { throw new Error("disk gone"); } } as unknown as DocsLibrary;
    const failed = await (await manual(broken))("/datanotes/manual/");
    expect([failed.status, await failed.json()]).toEqual([500, { error: "disk gone" }]);
  });
});

describe("a graceful stop: the server drains", () => {
  /** A server whose `/slow/` route answers once `release` is called. */
  async function slowServer() {
    const v = logVault({});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    server = new HttpApiServer({
      app: v.app,
      handlers: {
        "/slow/": async () => {
          entered();
          await gate;
          return { status: 200, json: { done: true } };
        },
      },
      token: "t",
      port: 0,
    });
    const port = await server.start();
    const call = (p: string, method = "POST") => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Authorization: "Bearer t" } });
    return { call, release, inside };
  }

  it("lets the requests under way finish, answers new ones 503 with how to go on, and says when none is left", async () => {
    const { call, release, inside } = await slowServer();
    const slow = call("/datanotes/slow/");
    await inside;
    expect(server!.requestsInFlight).toBe(1);
    const drained = server!.drain(10_000);
    const refused = await call("/datanotes/slow/");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual(guided("the engine is stopping", { docs: "https://datanotes.dev/administration/run-the-service.md#stop-the-engine" }));
    expect((await call("/", "GET")).status).toBe(503);
    release();
    expect(await (await slow).json()).toEqual({ done: true });
    expect(await drained).toBe(true);
    expect(server!.requestsInFlight).toBe(0);
    expect(await server!.drain(10)).toBe(true); // nothing under way: at once
  });

  it("gives up after its timeout while a request still runs", async () => {
    const { call, release, inside } = await slowServer();
    const slow = call("/datanotes/slow/");
    await inside;
    expect(await server!.drain(50)).toBe(false);
    release();
    expect((await slow).status).toBe(200);
  });
});

describe("an address the server cannot listen on: why, and what to do", () => {
  it("a port in use, a reserved port, an address of another machine, anything else", () => {
    const err = (code: string | undefined, message = "boom") => Object.assign(new Error(message), code ? { code } : {});
    const busy = listenError(err("EADDRINUSE"), "127.0.0.1", 27150);
    expect([busy.message, busy.code, busy.docs]).toEqual(["port 27150 is already in use (127.0.0.1:27150)", "EADDRINUSE", "https://datanotes.dev/administration/run-the-service.md#choose-the-port"]);
    expect(busy.hint).toMatch(/^Another program holds the port, often another engine\. Stop that program, or start the engine on another port: --port <port>/);
    const reserved = listenError(err("EACCES"), "127.0.0.1", 1500);
    expect(reserved.message).toBe("the system does not let the engine listen on 127.0.0.1:1500 (EACCES)");
    expect(reserved.hint).toMatch(/excludedportrange/);
    for (const code of ["EADDRNOTAVAIL", "ENOTFOUND"]) {
      const elsewhere = listenError(err(code), "203.0.113.1", 0);
      expect(elsewhere.message).toBe(`203.0.113.1 is not an address of this machine (${code})`);
      expect(elsewhere.hint).toMatch(/^Give --host an address of this machine/);
    }
    const other = listenError(err(undefined, "something odd"), "::1", 8080);
    expect([other.message, other.code, other.hint]).toEqual(["the HTTP server cannot listen on ::1:8080: something odd", undefined, expect.stringMatching(/^Check --host and --port/)]);
  });

  it("start rejects at once on an address that is not this machine's: only a busy port is retried", async () => {
    const v = logVault({});
    server = new HttpApiServer({ app: v.app, handlers: {}, token: "t", port: 0, host: "203.0.113.1" });
    const t0 = Date.now();
    await expect(server.start(6, 1000)).rejects.toMatchObject({ code: "EADDRNOTAVAIL", hint: expect.stringMatching(/--host/) });
    expect(Date.now() - t0).toBeLessThan(900);
  });
});
