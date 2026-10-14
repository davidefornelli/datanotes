/**
 * The read cache (src/server/read-cache.ts) on a running engine over HTTP: a read asked again is
 * answered from memory, and never with a stale answer: writes, undo, hand edits on disk, schema
 * changes, views, tokens and the current time all count. Write priority (scheduler.ts) on the
 * same engine: a long poll does not hold writes, a read held by a write says so in its trace.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/host";
import { DEFAULT_SETTINGS, mergeWithDefaults, type DatanotesSettings } from "../src/core/settings";
import { openNodeVault, type NodeHost } from "../src/node/node-app";
import { canonicalJson, PATH_VERSIONS, ReadCache, readDeps } from "../src/server/read-cache";
import { EngineRuntime } from "../src/server/runtime";
import { parseMetastore } from "../src/core/metastore";
import { METASTORE, TEST_DATABASE_FOLDER, withTables } from "./helpers/db-vault";

const YAML = withTables(`contact:
  options:
    filename: "{name}"
  columns:
    - { name: name, type: string, required: true }
    - { name: city, type: string }
`);

const ROW_A = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: alcohol\noccurred_at: 2026-09-25T22:30\nmetric_drinks: 7\n---\nA\n";
const ROW_B = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: mood\noccurred_at: 2026-09-26T08:00\n---\nB\n";

const open: { runtime: EngineRuntime; dirs: string[] }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.runtime.dispose();
    for (const d of o.dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

interface Engine {
  runtime: EngineRuntime;
  host: NodeHost;
  root: string;
  s: DatanotesSettings;
  call(op: string, body?: Record<string, unknown>, token?: string): Promise<{ status: number; json: Record<string, unknown>; text: string }>;
  route(route: string, body?: Record<string, unknown>, token?: string): Promise<{ status: number; json: Record<string, unknown> }>;
  stats(): { hits: number; misses: number; entries: number; bytes: number };
  posts: { url: string; body: string }[];
}

/** A started engine on a vault on disk; hand edits reach it through its settler (as the service's watcher). */
async function engine(settings: Partial<DatanotesSettings> = {}): Promise<Engine> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-cache-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "read-cache-store-"));
  const files: Record<string, string> = { [METASTORE]: YAML, "Daily/a.md": ROW_A, "Daily/b.md": ROW_B, "Ideas/garden.md": "Plant [[a]].\n" };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const host = openNodeVault(root, undefined, { store });
  const s = mergeWithDefaults({
    fileLogEnabled: false,
    autoRecompute: false,
    databaseFolder: TEST_DATABASE_FOLDER,
    httpServerToken: "owner-token",
    telemetryEnabled: true,
    telemetryProtocol: "http/json",
    ...settings,
  });
  s.httpServerPort = 0;
  const posts: { url: string; body: string }[] = [];
  const runtime = new EngineRuntime({
    app: host.app,
    getSettings: () => s,
    saveSettings: async () => {},
    transport: async () => ({ status: 500, text: "" }),
    embeddingKey: () => undefined,
    version: "3.0.0-test",
    hostName: "service",
    canServeHttp: true,
    httpHost: "127.0.0.1",
    env: {},
    otlpSend: async (url, body) => void posts.push({ url, body: body as string }),
  });
  open.push({ runtime, dirs: [root, store] });
  runtime.startTelemetry();
  await runtime.start();
  runtime.setHostSettler(() => void host.vault.rescan());
  const url = `http://127.0.0.1:${runtime.httpPort}/datanotes`;
  const post = async (route: string, body: Record<string, unknown>, token: string) => {
    const res = await fetch(`${url}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
  };
  return {
    runtime,
    host,
    root,
    s,
    posts,
    call: (op, body = {}, token = "owner-token") => post(`/operations/${op}/`, body, token),
    route: (route, body = {}, token = "owner-token") => post(route, body, token),
    stats: () => runtime.readCache!.stats(),
  };
}

const rows = (r: { json: Record<string, unknown> }) => r.json.rows as Record<string, unknown>[];

describe("read cache", () => {
  it("answers a read asked again from memory, byte for byte, whatever the order of its arguments", async () => {
    const e = await engine();
    const first = await e.call("select_rows", { table: "log", order_by: "occurred_at", limit: 10 });
    expect(first.status).toBe(200);
    expect(rows(first)).toHaveLength(2);
    expect(e.stats()).toMatchObject({ hits: 0, misses: 1, entries: 1 });
    const again = await e.call("select_rows", { limit: 10, order_by: "occurred_at", table: "log" });
    expect(again.text).toBe(first.text);
    expect(e.stats()).toMatchObject({ hits: 1, misses: 1 });
    // other arguments are another read
    const other = await e.call("select_rows", { table: "log", order_by: "occurred_at", limit: 1 });
    expect(rows(other)).toHaveLength(1);
    expect(e.stats()).toMatchObject({ hits: 1, misses: 2 });
    // a refused read is not kept
    expect((await e.call("select_rows", { table: "nope" })).status).toBe(404);
    expect((await e.call("select_rows", { table: "nope" })).status).toBe(404);
    expect(e.stats().entries).toBe(2);
  });

  it("reads a table again after a write to it, and keeps the answers of the tables the write did not touch", async () => {
    const e = await engine();
    await e.call("select_rows", { table: "log" });
    await e.call("select_rows", { table: "contact" });
    await e.call("describe_table", { table: "log" });
    const ins = await e.call("insert_row", { table: "log", values: { kind: "walk", occurred_at: "2026-10-01T08:00" } });
    expect(ins.json.ok).toBe(true);
    const before = e.stats();
    expect(rows(await e.call("select_rows", { table: "log" }))).toHaveLength(3);
    expect((await e.call("describe_table", { table: "log" })).json.row_count).toBe(3);
    expect(e.stats().hits).toBe(before.hits);
    // the write did not touch contact: its answer is still current
    expect(rows(await e.call("select_rows", { table: "contact" }))).toHaveLength(0);
    expect(e.stats().hits).toBe(before.hits + 1);
    // undo takes the row back: the read sees it gone
    const undo = await e.call("undo_migration", { migration_id: ins.json.migration_id });
    expect(undo.status).toBe(200);
    expect(rows(await e.call("select_rows", { table: "log" }))).toHaveLength(2);
    expect((await e.call("describe_table", { table: "log" })).json.row_count).toBe(2);
  });

  it("sees hand edits on disk: a row changed, a row created, a row deleted, a note that leaves its table", async () => {
    const e = await engine();
    const drinks = async () => rows(await e.call("select_rows", { table: "log", columns: ["metric_drinks"], order_by: "occurred_at" })).map((r) => r.metric_drinks);
    expect(await drinks()).toEqual([7, null]);
    expect(await drinks()).toEqual([7, null]);
    fs.writeFileSync(path.join(e.root, "Daily/a.md"), ROW_A.replace("metric_drinks: 7", "metric_drinks: 3"));
    expect(await drinks()).toEqual([3, null]);
    fs.writeFileSync(path.join(e.root, "Daily/c.md"), ROW_B.replace("0b", "0c").replace("2026-09-26", "2026-09-27").replace("mood", "walk"));
    expect(await drinks()).toEqual([3, null, null]);
    fs.rmSync(path.join(e.root, "Daily/b.md"));
    expect(await drinks()).toEqual([3, null]);
    // the note now names another table: it leaves log and joins contact
    await e.call("select_rows", { table: "contact" });
    fs.writeFileSync(path.join(e.root, "Daily/c.md"), "---\ntable: main.public.contact\nname: Ada\n---\n");
    expect(await drinks()).toEqual([3]);
    expect(rows(await e.call("select_rows", { table: "contact", columns: ["name"] })).map((r) => r.name)).toEqual(["Ada"]);
  });

  it("reads a select again when a row it reaches through a dotted key changes in the linked table", async () => {
    const e = await engine();
    const added = await e.call("add_column", { table: "log", column: { name: "who", type: "link", ref: "main.public.contact", description: "Who it was with." } });
    expect(added.json.ok).toBe(true);
    expect((await e.call("insert_row", { table: "contact", values: { name: "Ada", city: "Rome" } })).json.ok).toBe(true);
    expect((await e.call("update_row", { table: "log", path: "Daily/a.md", set: { who: "[[Ada]]" } })).json.ok).toBe(true);
    const inRome = async () => rows(await e.call("select_rows", { table: "log", where: { "who.city": "Rome" }, columns: ["kind"] })).map((r) => r.kind);
    const team = await e.call("create_table", { name: "team", description: "Teams", filename: "{name}", columns: [{ name: "name", type: "string", required: true, description: "The team's name" }] });
    expect(team.json.ok).toBe(true);
    expect(await inRome()).toEqual(["alcohol"]);
    expect(await inRome()).toEqual(["alcohol"]);
    // the answer depends on log and contact only: a plain note or another table changed keeps it
    const hits = e.stats().hits;
    fs.writeFileSync(path.join(e.root, "Ideas/garden.md"), "Plant [[b]].\n");
    expect(await inRome()).toEqual(["alcohol"]);
    expect(e.stats().hits).toBe(hits + 1);
    expect((await e.call("insert_row", { table: "team", values: { name: "Core" } })).json.ok).toBe(true);
    expect(await inRome()).toEqual(["alcohol"]);
    expect(e.stats().hits).toBe(hits + 2);
    const moved = await e.call("update_rows", { table: "contact", where: { name: "Ada" }, set: { city: "Paris" } });
    expect(moved.json.ok).toBe(true);
    expect(await inRome()).toEqual([]);
  });

  it("sees schema changes and the tables a view reads", async () => {
    const e = await engine();
    const view = await e.call("create_view", { name: "walks", description: "Walks", query: { table: "log", where: { kind: "walk" }, columns: ["kind", "occurred_at"] } });
    expect(view.status).toBe(200);
    expect(rows(await e.call("select_rows", { table: "walks" }))).toHaveLength(0);
    expect(rows(await e.call("select_rows", { table: "walks" }))).toHaveLength(0);
    const hits = e.stats().hits;
    await e.call("insert_row", { table: "log", values: { kind: "walk", occurred_at: "2026-10-01T08:00" } });
    expect(rows(await e.call("select_rows", { table: "walks" }))).toHaveLength(1);
    expect(e.stats().hits).toBe(hits);
    // a column renamed: the rows answer with its new name
    expect(Object.keys(rows(await e.call("select_rows", { table: "log", where: { kind: "alcohol" } }))[0]!)).toContain("metric_drinks");
    const renamed = await e.call("rename_column", { table: "log", from_column: "metric_drinks", to_column: "drinks" });
    expect(renamed.status).toBe(200);
    const after = rows(await e.call("select_rows", { table: "log", where: { kind: "alcohol" } }))[0]!;
    expect(after.drinks).toBe(7);
    expect(after).not.toHaveProperty("metric_drinks");
    expect(((await e.call("describe_table", { table: "log" })).json.columns as { name: string }[]).map((c) => c.name)).toContain("drinks");
  });

  it("keeps each token's answers apart, checks the token before answering, and forgets them when its permissions change", async () => {
    const e = await engine();
    const reader = (await e.route("/tokens/create/", { name: "reader" })).json.token as string;
    const writer = (await e.route("/tokens/create/", { name: "writer", write: ["main.public.log"] })).json.token as string;
    const owner = await e.call("select_rows", { table: "log" });
    const r1 = await e.call("select_rows", { table: "log" }, reader);
    expect(r1.text).toBe(owner.text);
    expect(e.stats()).toMatchObject({ hits: 0, misses: 2 });
    await e.call("select_rows", { table: "log" }, writer);
    expect(e.stats()).toMatchObject({ hits: 0, misses: 3 });
    await e.call("select_rows", { table: "log" }, reader);
    expect(e.stats().hits).toBe(1);
    // the reader may still not write, cache or not
    expect((await e.call("insert_row", { table: "log", values: { kind: "walk", occurred_at: "2026-10-01T08:00" } }, reader)).status).toBe(403);
    // its permissions change: its answers are not reused
    expect((await e.route("/tokens/update/", { name: "reader", write: ["main.public.contact"] })).status).toBe(200);
    await e.call("select_rows", { table: "log" }, reader);
    expect(e.stats()).toMatchObject({ hits: 1, misses: 4 });
    // a token deleted reads nothing, though its answer is in memory
    expect((await e.route("/tokens/delete/", { name: "reader" })).status).toBe(200);
    expect((await e.call("select_rows", { table: "log" }, reader)).status).toBe(401);
  });

  it("never keeps a read of the current time, and keeps one of today's date", async () => {
    const e = await engine();
    const recent = { table: "log", where: { occurred_at: { gte: "{now-100000h}" } } };
    expect(rows(await e.call("select_rows", recent))).toHaveLength(2);
    expect(rows(await e.call("select_rows", recent))).toHaveLength(2);
    expect(e.stats()).toMatchObject({ hits: 0, entries: 0 });
    const days = { table: "log", where: { occurred_at: { gte: "{today-10000d}" } } };
    await e.call("select_rows", days);
    await e.call("select_rows", days);
    expect(e.stats()).toMatchObject({ hits: 1, entries: 1 });
    // reads of the store are never kept
    await e.call("list_migrations", {});
    await e.call("list_migrations", {});
    expect(e.stats().entries).toBe(1);
  });

  it("follows the whole vault for reads that follow links or search, and turns off with readCacheMaxBytes 0", async () => {
    const e = await engine();
    const found = async () => (await e.call("search_notes", { query: "plant" })).json.total;
    expect(await found()).toBe(1);
    expect(await found()).toBe(1);
    expect(e.stats().hits).toBe(1);
    // a write to any table: a read of the vault is computed again
    await e.call("insert_row", { table: "contact", values: { name: "Plant shop" } });
    const hits = e.stats().hits;
    expect(await found()).toBe(2);
    expect(e.stats().hits).toBe(hits);
    e.s.readCacheMaxBytes = 0;
    await e.call("list_tables", {});
    await e.call("list_tables", {});
    expect(e.stats().hits).toBe(hits);
  });

  it("follows the links for the graph and backlinks: an edit that keeps a note's links keeps their answers", async () => {
    const e = await engine();
    const graph = async () => (await e.call("graph_neighbors", { from_nodes: { paths: ["Daily/a.md"] } })).json;
    const backlinks = async () => rows(await e.call("select_rows", { table: "log", columns: ["file_backlink_count"], order_by: "occurred_at" })).map((r) => r.file_backlink_count);
    const first = await graph();
    expect(await backlinks()).toEqual([1, 0]);
    // the body of a note without a table changes, its links stay: both answers come from memory
    fs.writeFileSync(path.join(e.root, "Ideas/garden.md"), "Plant [[a]] in spring.\n");
    let hits = e.stats().hits;
    expect(await graph()).toEqual(first);
    expect(await backlinks()).toEqual([1, 0]);
    expect(e.stats().hits).toBe(hits + 2);
    // its links change: both are computed again
    fs.writeFileSync(path.join(e.root, "Ideas/garden.md"), "Plant [[a]] and [[b]].\n");
    hits = e.stats().hits;
    expect(await backlinks()).toEqual([1, 1]);
    await graph();
    expect(e.stats().hits).toBe(hits);
    // a note created: links may resolve to it
    fs.writeFileSync(path.join(e.root, "Ideas/c.md"), "See [[a]].\n");
    expect(await backlinks()).toEqual([2, 1]);
    expect(e.stats().hits).toBe(hits);
  });

  it("follows one note for read_note, one folder for list_folder, the metastore for list_tables", async () => {
    const e = await engine();
    const note = async () => (await e.call("read_note", { path: "Ideas/garden.md" })).json.content;
    const ideas = async () => (await e.call("list_folder", { folder: "Ideas" })).json.files;
    const tables = async () => ((await e.call("list_tables", {})).json.tables as { qualified: string }[]).map((t) => t.qualified);
    expect(await note()).toBe("Plant [[a]].\n");
    expect(await ideas()).toEqual(["Ideas/garden.md"]);
    expect(await tables()).toEqual(["main.public.contact", "main.public.log"]);
    // a write elsewhere, a note of another folder edited by hand: all three still hold
    await e.call("insert_row", { table: "contact", values: { name: "Bo" } });
    fs.writeFileSync(path.join(e.root, "Daily/a.md"), ROW_A.replace("metric_drinks: 7", "metric_drinks: 2"));
    const hits = e.stats().hits;
    expect([await note(), await ideas(), await tables()]).toEqual(["Plant [[a]].\n", ["Ideas/garden.md"], ["main.public.contact", "main.public.log"]]);
    expect(e.stats().hits).toBe(hits + 3);
    // the note changed by hand: read again; its folder's children did not change
    fs.writeFileSync(path.join(e.root, "Ideas/garden.md"), "Plant [[b]].\n");
    expect(await note()).toBe("Plant [[b]].\n");
    expect(await ideas()).toEqual(["Ideas/garden.md"]);
    expect(e.stats().hits).toBe(hits + 4);
    // a note created in the folder, and one in a sub-folder (a folder created): listed again
    fs.writeFileSync(path.join(e.root, "Ideas/pond.md"), "Fish.\n");
    expect(await ideas()).toEqual(["Ideas/garden.md", "Ideas/pond.md"]);
    fs.mkdirSync(path.join(e.root, "Ideas/old"));
    fs.writeFileSync(path.join(e.root, "Ideas/old/x.md"), "x\n");
    expect((await e.call("list_folder", { folder: "Ideas" })).json.folders).toEqual(["Ideas/old"]);
    // a note renamed out of the folder, in a case of its own
    fs.renameSync(path.join(e.root, "Ideas/pond.md"), path.join(e.root, "Daily/Pond.md"));
    expect(await ideas()).toEqual(["Ideas/garden.md"]);
    expect((await e.call("read_note", { path: "Daily/Pond.md" })).json.content).toBe("Fish.\n");
    // a table created: the metastore changed
    const made = await e.call("create_table", { name: "place", description: "Places", filename: "{name}", columns: [{ name: "name", type: "string", description: "Its name" }] });
    expect(made.json.ok, made.text).toBe(true);
    expect(await tables()).toEqual(["main.public.contact", "main.public.log", "main.public.place"]);
  });

  it("never keeps an information_schema read: asked twice, computed twice", async () => {
    const e = await engine();
    const first = await e.call("select_rows", { table: "system.information_schema.tables", columns: ["full_name"] });
    expect(first.status, first.text).toBe(200);
    const before = e.stats();
    await e.call("select_rows", { table: "system.information_schema.tables", columns: ["full_name"] });
    expect(e.stats()).toMatchObject({ hits: before.hits, entries: before.entries });
  });

  it("forgets read_note and list_folder answers under a folder deleted or renamed by hand, empty folders included", async () => {
    const e = await engine();
    const list = (folder: string) => e.call("list_folder", { folder });
    fs.mkdirSync(path.join(e.root, "Ideas/old/empty"), { recursive: true });
    fs.mkdirSync(path.join(e.root, "Ideas/old/deep/er"), { recursive: true });
    fs.writeFileSync(path.join(e.root, "Ideas/old/deep/er/x.md"), "x\n");
    fs.mkdirSync(path.join(e.root, "Ideas/keep/sub"), { recursive: true });
    expect((await list("Ideas/old/empty")).status).toBe(200);
    expect((await list("Ideas/old/deep")).json.folders).toEqual(["Ideas/old/deep/er"]);
    expect((await list("Ideas/keep/sub")).status).toBe(200);
    const hits = e.stats().hits;
    await list("Ideas/old/empty");
    await list("Ideas/old/deep");
    expect(e.stats().hits).toBe(hits + 2); // kept while nothing changed
    fs.rmSync(path.join(e.root, "Ideas/old"), { recursive: true });
    expect((await list("Ideas/old/empty")).status).toBe(404);
    expect((await list("Ideas/old/deep")).status).toBe(404);
    fs.renameSync(path.join(e.root, "Ideas/keep"), path.join(e.root, "Ideas/kept"));
    expect((await list("Ideas/keep/sub")).status).toBe(404);
    expect((await list("Ideas/kept/sub")).status).toBe(200);
  });

  it("follows every table and the rows that cannot be read for describe_database", async () => {
    const e = await engine();
    const counts = async () => {
      const d = (await e.call("describe_database", {})).json as { catalogs: { schemas: { tables: { qualified: string; row_count: number; unreadable_count?: number }[] }[] }[] };
      return d.catalogs.flatMap((c) => c.schemas.flatMap((s) => s.tables.map((t) => [t.qualified, t.row_count, t.unreadable_count ?? 0])));
    };
    expect(await counts()).toEqual([["main.public.log", 2, 0], ["main.public.contact", 0, 0]]);
    // a note with properties but no table, edited by hand: the answer holds
    fs.writeFileSync(path.join(e.root, "Ideas/plan.md"), "---\nstatus: draft\n---\nA plan.\n");
    const hits = e.stats().hits;
    expect(await counts()).toEqual([["main.public.log", 2, 0], ["main.public.contact", 0, 0]]);
    expect(e.stats().hits).toBe(hits + 1);
    // a row written: its table's count
    await e.call("insert_row", { table: "contact", values: { name: "Bo" } });
    expect(await counts()).toEqual([["main.public.log", 2, 0], ["main.public.contact", 1, 0]]);
    // a row that cannot be read, then one that names another table while it still cannot be read
    fs.writeFileSync(path.join(e.root, "Daily/a.md"), ROW_A.replace("kind: alcohol", "kind: [alcohol"));
    expect(await counts()).toEqual([["main.public.log", 1, 1], ["main.public.contact", 1, 0]]);
    fs.writeFileSync(path.join(e.root, "Daily/a.md"), ROW_A.replace("kind: alcohol", "kind: [alcohol").replace("main.public.log", "main.public.contact"));
    expect(await counts()).toEqual([["main.public.log", 1, 0], ["main.public.contact", 1, 1]]);
    // read again, as a note of no table: no row that cannot be read
    fs.writeFileSync(path.join(e.root, "Daily/a.md"), "---\nkind: alcohol\n---\nA\n");
    expect(await counts()).toEqual([["main.public.log", 1, 0], ["main.public.contact", 1, 0]]);
  });

  it("keeps at most readCacheMaxBytes, the least recently used out first", async () => {
    const e = await engine();
    // answers of one size (both rows, a limit of one digit): room for four of them
    await e.call("select_rows", { table: "log", limit: 2, include_body: true });
    const one = e.stats().bytes;
    e.s.readCacheMaxBytes = Math.floor(one * 4.5);
    for (let i = 3; i <= 7; i++) await e.call("select_rows", { table: "log", limit: i, include_body: true });
    expect(e.stats()).toMatchObject({ entries: 4, bytes: one * 4 });
    // the newest is still there, the oldest are not
    await e.call("select_rows", { table: "log", limit: 7, include_body: true });
    expect(e.stats().hits).toBe(1);
    await e.call("select_rows", { table: "log", limit: 2, include_body: true });
    expect(e.stats().hits).toBe(1);
    expect(e.stats().bytes).toBeLessThanOrEqual(e.s.readCacheMaxBytes);
  });
});

describe("settings of write priority and the read cache", () => {
  it("default to on, 100 ms and 32 MiB, take valid values and fall back on invalid ones", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ writePriority: true, writePriorityMaxWaitMs: 100, readCacheMaxBytes: 33554432 });
    expect(mergeWithDefaults({ writePriority: false, writePriorityMaxWaitMs: 0, readCacheMaxBytes: 0 })).toMatchObject({ writePriority: false, writePriorityMaxWaitMs: 0, readCacheMaxBytes: 0 });
    expect(mergeWithDefaults({ writePriorityMaxWaitMs: 60000, readCacheMaxBytes: 1024 })).toMatchObject({ writePriorityMaxWaitMs: 60000, readCacheMaxBytes: 1024 });
    const bad = mergeWithDefaults({ writePriority: "no" as never, writePriorityMaxWaitMs: 60001, readCacheMaxBytes: -1 });
    expect(bad).toMatchObject({ writePriority: true, writePriorityMaxWaitMs: 100, readCacheMaxBytes: 33554432 });
    expect(mergeWithDefaults({ writePriorityMaxWaitMs: 1.5, readCacheMaxBytes: 2.5 })).toMatchObject({ writePriorityMaxWaitMs: 100, readCacheMaxBytes: 33554432 });
  });
});

describe("read cache: what it keeps", () => {
  const model = parseMetastore(`${YAML}        views:
          walks:
            query: { table: log, where: { kind: walk } }
          soon:
            query: { table: main.public.log, where: { occurred_at: { gte: "{today}" } } }
          linked:
            query: { table: log, where: { people: { within: "[[a]]" } } }
`);

  it("reads the tables of a plain select, of its views and joins; the vault for links, bases and time travel", () => {
    expect(readDeps("select_rows", { table: "log" }, model)).toEqual({ tables: ["main.public.log"], today: false });
    expect(readDeps("select_rows", { table: "walks" }, model)).toEqual({ tables: ["main.public.log"], today: false });
    expect(readDeps("select_rows", { table: "soon" }, model)).toEqual({ tables: ["main.public.log"], today: true });
    expect(readDeps("select_rows", { table: "log", join: { table: "contact", on: { kind: "name" } } }, model)).toEqual({ tables: ["main.public.contact", "main.public.log"], today: false });
    for (const body of [{ table: "linked" }, { table: "log", expand: ["people"] }, { table: "base:dated" }, { table: "log", this_note: "Daily/a.md" }, { table: "nope" }]) {
      // a read of the whole vault may run any view: one of them reads the date
      expect(readDeps("select_rows", body, model), JSON.stringify(body)).toEqual({ tables: "vault", today: true });
    }
    const plain = parseMetastore(YAML);
    expect(readDeps("select_rows", { table: "log", expand: ["people"] }, plain)).toEqual({ tables: "vault", today: false });
    // a dotted key follows a link column into another table: the whole vault, wherever it is
    const linkedKey = parseMetastore(`${YAML}        views:
          by_person:
            query: { table: log, where: { "people.name": a } }
`);
    for (const body of [
      { table: "log", where: { "people.name": "a" } },
      { table: "log", where: { and: [{ kind: "walk" }, { not: { "people.name": "a" } }] } },
      { table: "log", where: { or: [{ "people.name": { in: ["a"] } }] } },
      { table: "log", join: { table: "contact", on: { kind: "name" }, where: { "people.name": "a" } } },
      { table: "log", union: [{ table: "log", where: { "people.name": "a" } }] },
      { table: "by_person" },
    ]) {
      expect(readDeps("select_rows", body, linkedKey), JSON.stringify(body)).toEqual({ tables: "vault", today: false });
    }
    expect(readDeps("select_rows", { table: "main.public.log", where: { kind: "a.b" } }, plain)).toEqual({ tables: ["main.public.log"], today: false });
    const withNow = parseMetastore(`${YAML}        views:
          recent:
            query: { table: log, where: { occurred_at: { gte: "{now-1h}" } } }
`);
    expect(readDeps("select_rows", { table: "recent" }, withNow)).toBeNull();
    expect(readDeps("select_rows", { table: "log", expand: ["people"] }, withNow)).toBeNull();
    expect(readDeps("select_rows", { table: "log" }, withNow)).toEqual({ tables: ["main.public.log"], today: false });
    expect(readDeps("select_rows", { table: "log", version: 1 }, model)).toBeNull();
    expect(readDeps("select_rows", { table: "log", where: { occurred_at: { gte: "{now-1h}" } } }, model)).toBeNull();
    expect(readDeps("describe_table", { table: "log" }, model)).toEqual({ tables: ["main.public.log"], today: false });
    // backlinks and the graph: the tables they read and the links between notes
    expect(readDeps("select_rows", { table: "log", order_by: "file_backlink_count" }, model)).toEqual({ tables: ["main.public.log"], today: false, links: true });
    expect(readDeps("graph_neighbors", { from_nodes: { table: "log" } }, model)).toEqual({ tables: ["main.public.contact", "main.public.log"], today: false, links: true });
    expect(readDeps("graph_neighbors", { from_nodes: { table: "log" } }, null)).toEqual({ tables: "vault", today: false });
    expect(readDeps("list_tables", {}, model)).toEqual({ tables: [], today: false });
    expect(readDeps("describe_database", {}, model)).toEqual({ tables: ["main.public.contact", "main.public.log"], today: false, loose: true });
    expect(readDeps("describe_database", {}, null)).toEqual({ tables: "vault", today: false });
    expect(readDeps("read_note", { path: "Daily/a.md" }, model)).toEqual({ tables: [], today: false, paths: ["Daily/a.md"] });
    expect(readDeps("read_note", {}, model)).toEqual({ tables: "vault", today: false });
    expect(readDeps("list_folder", {}, model)).toEqual({ tables: [], today: false, folders: [""] });
    expect(readDeps("list_folder", { folder: "Daily" }, model)).toEqual({ tables: [], today: false, folders: ["Daily"] });
    expect(readDeps("list_folder", { folder: 3 }, model)).toEqual({ tables: "vault", today: false });
    expect(readDeps("search_notes", { query: "x" }, model)).toEqual({ tables: "vault", today: false });
    for (const op of ["list_changes", "list_migrations", "describe_history", "table_changes", "semantic_search", "check_table", "insert_row"]) expect(readDeps(op, {}, model), op).toBeNull();
    expect(canonicalJson({ b: [1, { d: 1, c: undefined }], a: null })).toBe('{"a":null,"b":[1,{"d":1}]}');
  });

  it("follows dotted keys to the tables their link columns lead to; a key it cannot follow reads the whole vault", () => {
    const linked = parseMetastore(
      withTables(`contact:
  options:
    filename: "{name}"
  columns:
    - { name: name, type: string, required: true }
    - { name: city, type: string }
    - { name: team, type: link, ref: main.public.team }
team:
  options:
    filename: "{name}"
  columns:
    - { name: name, type: string, required: true }
task:
  options:
    filename: "{title}"
  columns:
    - { name: title, type: string, required: true }
    - { name: who, type: link, ref: main.public.contact }
    - { name: helpers, type: list, items: link, ref: main.public.contact }
    - { name: mentor, type: link, ref: self }
    - { name: note, type: string }
`) +
        `        views:
          by_city:
            query: { table: task, where: { "who.city": Rome } }
`,
    );
    const contact = "main.public.contact";
    const task = "main.public.task";
    const team = "main.public.team";
    const cases: [Record<string, unknown>, string[]][] = [
      [{ table: "task", where: { "who.city": "Rome" } }, [contact, task]],
      [{ table: "task", where: { "who.team.name": "Core" } }, [contact, task, team]],
      [{ table: "task", where: { "helpers.city": "Rome" } }, [contact, task]],
      [{ table: "task", where: { "mentor.title": "x" } }, [task]],
      [{ table: "task", where: { and: [{ note: "x" }, { not: { "who.city": "Rome" } }, { or: [{ "helpers.name": "a" }] }] } }, [contact, task]],
      [{ table: "task", join: { table: "contact", on: { who: "name" }, where: { "team.name": "Core" } } }, [contact, task, team]],
      [{ table: "task", union: [{ table: "task", where: { "who.city": "Rome" } }, { table: "contact" }] }, [contact, task]],
      [{ table: "by_city" }, [contact, task]],
    ];
    for (const [body, tables] of cases) expect(readDeps("select_rows", body, linked), JSON.stringify(body)).toEqual({ tables, today: false });
    for (const body of [
      { table: "task", where: { "note.x": 1 } },
      { table: "task", where: { "nope.x": 1 } },
      { table: "log", where: { "people.name": "a" } },
      { table: "by_city", where: { "who.name": "a" } },
      { table: "task", join: { table: "contact", on: { "who.city": "name" } } },
      { table: "task", where: { "who.city": "Rome" }, union: [{ table: "task" }, { table: "contact" }] },
      { table: "task", union: [], where: { "who.city": "x" } },
      { table: "task", union: [1, { table: "task", where: { "who.city": "x" } }] },
    ]) {
      expect(readDeps("select_rows", body, linked), JSON.stringify(body)).toEqual({ tables: "vault", today: false });
    }
    // a table that redefines a column of its base cannot load: its keys are not followed
    const clash = parseMetastore(`bases:
  owned:
    columns:
      - { name: who, type: link, ref: main.public.contact }
${withTables(`contact:
  columns:
    - { name: city, type: string }
odd:
  bases: [owned]
  columns:
    - { name: who, type: string }
`)}`);
    expect(readDeps("select_rows", { table: "odd", where: { "who.city": "x" } }, clash)).toEqual({ tables: "vault", today: false });
  });

  it("never keeps a read of system.information_schema, directly, in a union or through a view", () => {
    const withInfo = parseMetastore(`${YAML}        views:
          info:
            query: { table: system.information_schema.tables }
`);
    for (const body of [
      { table: "system.information_schema.tables" },
      { table: "information_schema.columns" },
      { table: " system.information_schema.views " },
      { table: "log", union: [{ table: "log" }, { table: "system.information_schema.tables" }] },
      { table: "info" },
    ]) {
      expect(readDeps("select_rows", body, withInfo), JSON.stringify(body)).toBeNull();
    }
    // a plain table of the same metastore is unaffected
    expect(readDeps("select_rows", { table: "log" }, withInfo)).toEqual({ tables: ["main.public.log"], today: false });
  });

  it("keeps nothing on a host without vault events, nor an answer computed while a table it read changed", async () => {
    const s = mergeWithDefaults({ databaseFolder: TEST_DATABASE_FOLDER });
    const silent = { vault: { getMarkdownFiles: () => [] }, metadataCache: {} } as unknown as App;
    const blind = new ReadCache(silent, () => s);
    expect(blind.watching).toBe(false);
    expect(await blind.ticket("select_rows", { table: "log" }, "owner")).toBeNull();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-cache-unit-"));
    fs.mkdirSync(path.join(root, TEST_DATABASE_FOLDER), { recursive: true });
    fs.writeFileSync(path.join(root, METASTORE), YAML);
    fs.mkdirSync(path.join(root, "Daily"), { recursive: true });
    fs.mkdirSync(path.join(root, "Ideas"), { recursive: true });
    fs.writeFileSync(path.join(root, "Daily/a.md"), ROW_A);
    const host = openNodeVault(root);
    const cache = new ReadCache(host.app, () => s, () => Date.parse("2026-10-13T10:00:00Z"));
    try {
      const t = (await cache.ticket("select_rows", { table: "log" }, "owner"))!;
      expect(t).not.toBeNull();
      // a row of log changes while the answer is computed: it is not kept
      await host.app.vault.process(host.app.vault.getAbstractFileByPath("Daily/a.md") as never, (x) => x.replace("7", "8"));
      expect(cache.set(t, { status: 200, body: "{}" })).toBe(false);
      const t2 = (await cache.ticket("select_rows", { table: "log" }, "owner"))!;
      expect(t2.key).not.toBe(t.key);
      // a note of no table changes: the answer still holds
      await host.app.vault.create("Ideas/x.md", "free\n");
      expect(cache.set(t2, { status: 200, body: "{}" })).toBe(true);
      expect(cache.get((await cache.ticket("select_rows", { table: "log" }, "owner"))!)).toEqual({ status: 200, body: "{}" });
      // the metastore changes: nothing holds
      await host.app.vault.process(host.app.vault.getAbstractFileByPath(METASTORE) as never, (x) => `${x}\n`);
      expect(cache.get((await cache.ticket("select_rows", { table: "log" }, "owner"))!)).toBeUndefined();
      // past the most paths with a version of their own, they start again: no answer kept before is reused
      const note = (await cache.ticket("read_note", { path: "Ideas/x.md" }, "owner"))!;
      expect(cache.set(note, { status: 200, body: "{}" })).toBe(true);
      const max = PATH_VERSIONS.max;
      PATH_VERSIONS.max = 3;
      try {
        for (const name of ["p", "q", "r"]) await host.app.vault.create(`Ideas/${name}.md`, "x\n");
      } finally {
        PATH_VERSIONS.max = max;
      }
      expect(cache.get((await cache.ticket("read_note", { path: "Ideas/x.md" }, "owner"))!)).toBeUndefined();
      // an answer larger than a quarter of the memory is not kept
      s.readCacheMaxBytes = 100;
      expect(cache.set((await cache.ticket("select_rows", { table: "log" }, "owner"))!, { status: 200, body: "x".repeat(200) })).toBe(false);
    } finally {
      cache.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("write priority on the engine", () => {
  it("lets a write run while a long poll of the change feed waits, and the poll sees it", async () => {
    const e = await engine();
    const head = (await e.call("list_changes", { limit: 1 })).json.head as number;
    const poll = e.call("list_changes", { since: head, wait_ms: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const ins = await e.call("insert_row", { table: "contact", values: { name: "Cy" } });
    expect(ins.json.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const page = await poll;
    expect((page.json.events as { table: string }[]).map((x) => x.table)).toContain("main.public.contact");
  });

  it("holds a read while a write runs and traces the wait", async () => {
    const e = await engine();
    const slot = await e.runtime.scheduler.acquire("write");
    let answered = false;
    const read = e.call("select_rows", { table: "contact" }).then((r) => {
      answered = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(answered).toBe(false);
    slot.release();
    expect((await read).status).toBe(200);
    await (e.runtime as unknown as { traces: { flush(): Promise<void> } }).traces.flush();
    const spans = e.posts
      .filter((p) => p.url.endsWith("/v1/traces"))
      .flatMap((p) => (JSON.parse(p.body) as { resourceSpans: { scopeSpans: { spans: { name: string; spanId: string; parentSpanId?: string; attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[] }).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((x) => x.spans)));
    const attr = (s: (typeof spans)[number], k: string) => Object.values(s.attributes.find((a) => a.key === k)?.value ?? {})[0];
    const wait = spans.find((s) => s.name === "engine.schedule.wait")!;
    expect(wait).toBeDefined();
    const op = spans.find((s) => s.spanId === wait.parentSpanId)!;
    expect(op.name).toBe("engine.op select_rows");
    expect(attr(op, "datanotes.schedule.class")).toBe("read");
    expect(attr(op, "datanotes.schedule.released")).toBe("writes_done");
    expect(Number(attr(op, "datanotes.schedule.wait_ms"))).toBeGreaterThanOrEqual(40);
    expect(attr(op, "datanotes.read_cache")).toBe("miss");
  });
});
