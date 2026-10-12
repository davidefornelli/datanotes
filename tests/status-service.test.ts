/**
 * `datanotes status` against a real service (temporary vaults, free ports): healthy, git sync
 * blocked, a failing webhook, hand edits breaking the rules, the change feed not running, an app
 * token refused, and no engine running (no lock, a stale lock, a lock of another machine, a lock
 * nothing answers behind). Text and JSON output, exit codes, the route's schema in the OpenAPI.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openApiDocument } from "../src/server/openapi";
import { startService, type RunningService, type ServiceOptions } from "../src/node/service";
import { collectStatus, EXIT_ATTENTION, EXIT_UNCHECKED, EXIT_HEALTHY, EXIT_NOT_RUNNING, main } from "../src/node/status";
import { storeLocation } from "../src/api/local";
import { LOG_YAML, METASTORE } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";
import { validate, type Schema } from "./helpers/schema";

const TOKEN = "owner-secret-token-0123";
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});

function vault(port: number, settings: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "status-"));
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w(METASTORE, LOG_YAML);
  w("Daily/a.md", "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: alcohol\noccurred_at: 2026-09-25T22:30\n---\nA\n");
  seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false, autoRecompute: false, ...settings }, METASTORE);
  return root;
}

/** The store the engine of `root` keeps. */
const storeOf = (root: string) => storeLocation(root)!.store;

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

async function start(root: string, o: Partial<ServiceOptions> = {}): Promise<RunningService> {
  const svc = await startService({ vault: root, watch: "poll", pollMs: 100, ...o }, {});
  running.push(svc);
  return svc;
}

/** `datanotes status` as the command runs it: exit code and output. */
async function status(...argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await main(argv, { env: { DATANOTES_DATA_HOME: process.env.DATANOTES_DATA_HOME }, write: (t) => (out += t) });
  return { code, out };
}

async function json(...argv: string[]): Promise<{ code: number; r: Record<string, any> }> {
  const { code, out } = await status(...argv, "--json");
  return { code, r: JSON.parse(out) as Record<string, any> };
}

async function post(port: number, route: string, body: unknown, token = TOKEN): Promise<{ status: number; json: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}/datanotes/${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

/** Wait until the status matches. */
async function until(root: string, ok: (r: Record<string, any>) => boolean, ms = 8000): Promise<{ code: number; r: Record<string, any> }> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await json("--vault", root);
    if (ok(s.r) || Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const SCHEMA = (openApiDocument("x") as { components: { schemas: Record<string, Schema> } }).components.schemas.EngineStatus!;
/** The report minus what the command adds to the route's answer. */
function routeBody(r: Record<string, any>): Record<string, unknown> {
  const { exit_code: _c, running: _r, url: _u, ...body } = r;
  return body;
}

describe("datanotes status: a running engine", () => {
  it("healthy: exit 0, every part reported, no token anywhere, the route's answer matches its schema", async () => {
    const p = await freePort();
    const root = vault(p, { fileLogEnabled: true });
    const svc = await start(root, { logFile: path.join(root, "service.log") });
    // named tokens with their permissions (their values never show)
    const bot = await post(p, "tokens/create/", { name: "bot", write: ["main.public.*"], ddl: true });
    const agent = await post(p, "tokens/create/", { name: "agent", write: [], maintain: true });
    expect(bot.status).toBe(200);
    expect((await post(p, "operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-10-09T08:00" } })).json.ok).toBe(true);

    const { code, r } = await json("--vault", root);
    expect(code).toBe(EXIT_HEALTHY);
    expect(validate(SCHEMA, routeBody(r))).toEqual([]);
    expect(r).toMatchObject({
      exit_code: 0,
      running: true,
      url: `http://127.0.0.1:${p}`,
      healthy: true,
      problems: [],
      engine: { pid: process.pid, host_name: os.hostname(), http: { host: "127.0.0.1", port: p }, watch: "poll", vault: root, settings_file: path.join(svc.store.store, "settings.json"), store: svc.store.store, database_id: svc.store.id, database_folder: "Datanotes" },
      // the id the first start wrote into metastore.yaml (set_database_id), and the insert
      database: { metastore: "Datanotes/metastore.yaml", readable: true, tables: 1, views: 0, history_tables: 0, journal: { window_hours: 24, operations: 1, last: { op: "insert_row" } } },
      git_sync: null,
      change_feed: { running: true, head: svc.runtime.changeFeed!.lastSeq },
      webhooks: { count: 0, failing: [] },
      tokens: [
        { name: "bot", write: ["main.public.*"], ddl: true, maintain: false, last_seen: null },
        { name: "agent", write: [], ddl: false, maintain: true, last_seen: null },
      ],
      hand_edits: { window_hours: 24, checked: true, rows: 0, violations: 0, latest: [] },
      logs: { folder: path.join(svc.store.store, "logs"), console_log: path.join(root, "service.log"), telemetry: null },
    });
    expect(r.engine.uptime_s).toBeGreaterThanOrEqual(0);

    const text = await status("--vault", root);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^datanotes status: healthy\nengine {5}dev, pid \d+ on .+, up \d+s, http:\/\/127\.0\.0\.1:\d+, watch poll\n/);
    for (const s of ["git sync   off", "changes    feed running", "tokens     bot (write main.public.*, ddl); agent (read only, maintain)", "none breaking the tables' rules"]) expect(text.out).toContain(s);
    for (const secret of [TOKEN, bot.json.token as string, agent.json.token as string]) {
      expect(text.out).not.toContain(secret);
      expect(JSON.stringify(r)).not.toContain(secret);
    }

    // --url and --token reach the same engine; --settings names another settings file
    expect((await status("--url", `http://127.0.0.1:${p}/`, "--token", TOKEN)).code).toBe(0);
    const other = path.join(root, "other.json");
    fs.writeFileSync(other, JSON.stringify({ httpServerToken: TOKEN }));
    expect((await status("--vault", root, "--settings", other)).code).toBe(0);
  }, 30_000);

  it("refuses a named token, even one with maintain, and a wrong token: exit 3, the status could not be read", async () => {
    const p = await freePort();
    const root = vault(p);
    await start(root);
    const agent = (await post(p, "tokens/create/", { name: "agent", write: ["*"], ddl: true, maintain: true })).json.token as string;
    expect((await post(p, "status/", {}, agent)).status).toBe(403);
    const refused = await json("--url", `http://127.0.0.1:${p}`, "--token", agent);
    expect(refused.code).toBe(EXIT_UNCHECKED);
    expect(refused.r).toEqual({ exit_code: 3, running: true, url: `http://127.0.0.1:${p}`, error: expect.stringMatching(/^a named token cannot read the status \(403\).*: token agent may not call \/status\/ \(reserved to the owner\)$/) });
    const wrong = await status("--url", `http://127.0.0.1:${p}`, "--token", "not-the-token-at-all");
    expect(wrong.code).toBe(EXIT_UNCHECKED);
    expect(wrong.out).toBe(`datanotes status: engine at http://127.0.0.1:${p} did not answer the status\nerror      the token was refused (401): status needs the owner's token: missing or wrong bearer token\n`);
  });

  it("git sync blocked by a merge left in progress: exit 1, the reason in the report", async () => {
    const p = await freePort();
    const root = vault(p);
    const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    sh("init", "-q", "-b", "main");
    sh("config", "user.name", "Test");
    sh("config", "user.email", "t@example.com");
    fs.writeFileSync(path.join(root, ".gitignore"), "");
    sh("add", "-A");
    sh("commit", "-q", "-m", "init");
    const svc = await start(root, { gitSync: { intervalMs: 3_600_000, quietMs: 3_600_000, push: false } });
    await svc.git!.cycle();
    const ok = await json("--vault", root);
    expect(ok.code).toBe(0);
    expect(ok.r.git_sync).toMatchObject({ enabled: true, pending_operations: 0 });
    expect(ok.r.git_sync.last_run_at).toBeTruthy();
    fs.writeFileSync(path.join(root, ".git/MERGE_HEAD"), "0000000000000000000000000000000000000000\n");
    await svc.git!.cycle();
    const { code, r } = await json("--vault", root);
    expect(code).toBe(EXIT_ATTENTION);
    expect(r.git_sync.blocked).toBe("a rebase or merge is in progress in the vault repository");
    expect(r.problems).toEqual(["git sync blocked: a rebase or merge is in progress in the vault repository"]);
    expect((await status("--vault", root)).out).toContain("git sync   BLOCKED: a rebase or merge is in progress in the vault repository\n");
  }, 30_000);

  it("a webhook whose receiver is down: exit 1, its host and error, never its secret or path", async () => {
    const p = await freePort();
    const root = vault(p);
    await start(root);
    const dead = await freePort(); // nothing listens there
    const hook = await post(p, "operations/create_webhook/", { url: `http://127.0.0.1:${dead}/hook/path?key=abc`, since: 0 });
    expect(hook.status).toBe(200);
    expect((await post(p, "operations/insert_row/", { table: "log", values: { kind: "walk", occurred_at: "2026-10-09T09:00" } })).json.ok).toBe(true);
    const { code, r } = await until(root, (x) => x.webhooks.failing.length > 0);
    expect(code).toBe(EXIT_ATTENTION);
    expect(r.webhooks).toMatchObject({ count: 1, failing: [{ id: hook.json.id, url_host: `127.0.0.1:${dead}`, failures: expect.any(Number), last_error: expect.any(String) }] });
    expect(r.problems[0]).toMatch(new RegExp(`^webhook ${hook.json.id} \\(127\\.0\\.0\\.1:${dead}\\) failing: `));
    const text = (await status("--vault", root)).out;
    expect(text).toContain(`  ! ${hook.json.id} 127.0.0.1:${dead}: `);
    for (const s of [hook.json.secret as string, "/hook/path", "key=abc"]) expect(JSON.stringify(r) + text).not.toContain(s);
  }, 30_000);

  it("a hand edit that breaks the table's rules: exit 1 until a later edit fixes the row", async () => {
    const p = await freePort();
    const root = vault(p);
    await start(root);
    const bad = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: nope\noccurred_at: 2026-10-09T10:00\n---\n";
    fs.writeFileSync(path.join(root, "Daily/b.md"), bad);
    const broken = await until(root, (x) => x.hand_edits.rows > 0);
    expect(broken.code).toBe(EXIT_ATTENTION);
    expect(broken.r.hand_edits).toMatchObject({ checked: true, rows: 1, violations: 1, latest: [{ path: "Daily/b.md", table: "main.public.log", violations: 1 }] });
    expect(broken.r.problems).toEqual(["1 row edited by hand breaks the tables' rules (1 violation)"]);
    expect((await status("--vault", root)).out).toMatch(/hand edits 1 hand edit in the last 24 h; 1 row breaks the tables' rules \(1 violation\)\n {2}! Daily\/b\.md \(main\.public\.log\): /);
    fs.writeFileSync(path.join(root, "Daily/b.md"), bad.replace("kind: nope", "kind: walk"));
    const fixed = await until(root, (x) => x.hand_edits.rows === 0);
    expect(fixed.code).toBe(EXIT_HEALTHY);
    expect(fixed.r.hand_edits.edits).toBe(2);
  }, 30_000);

  it("the change feed not running (metastore.yaml cannot be read): exit 1, and why", async () => {
    const p = await freePort();
    const root = vault(p);
    // broken YAML, its id line whole: the store (with the settings) is still this database's
    const idLine = fs.readFileSync(path.join(root, METASTORE), "utf8").split("\n").find((l) => l.startsWith("id: "))!;
    fs.writeFileSync(path.join(root, METASTORE), `${idLine}\ncatalogs: [\n`);
    await start(root);
    const { code, r } = await json("--vault", root);
    expect(code).toBe(EXIT_ATTENTION);
    expect(validate(SCHEMA, routeBody(r))).toEqual([]);
    expect(r.change_feed).toEqual({ running: false, reason: expect.stringMatching(/^metastore\.yaml cannot be read: /), head: null });
    expect(r.database).toMatchObject({ readable: false, error: expect.stringMatching(/^cannot be read: /), tables: 0 });
    expect(r.hand_edits).toEqual({ window_hours: 24, checked: false, reason: "the change feed is not running" });
    const text = (await status("--vault", root)).out;
    expect(text).toContain("changes    feed NOT RUNNING: metastore.yaml cannot be read: ");
    expect(text).toContain("problems:\n  - metastore.yaml cannot be read: ");
  });
});

describe("datanotes status: no engine running", () => {
  it("no lock: exit 2, with what the files say", async () => {
    const root = vault(1);
    const { code, r } = await json("--vault", root);
    expect(code).toBe(EXIT_NOT_RUNNING);
    expect(r).toEqual({
      exit_code: 2,
      running: false,
      reason: "no engine holds the vault (no lock)",
      vault: root,
      lock: { state: "none" },
      settings: { file: path.join(storeOf(root), "settings.json"), found: true, owner_token_set: true },
      metastore: { path: path.join(root, "Datanotes/metastore.yaml"), found: true, tables: 1 },
      store: { path: storeOf(root), database_id: expect.any(String) },
    });
    expect((await status("--vault", root)).out).toContain("datanotes status: not running\n");
  });

  it("a stale lock, a lock of another machine, a fresh lock nothing answers behind", async () => {
    const root = vault(1);
    const lockFile = path.join(storeOf(root), "engine.lock");
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const port = await freePort();
    const lock = (heartbeat: Date, host = os.hostname()) => fs.writeFileSync(lockFile, JSON.stringify({ kind: "service", pid: 4242, host, port, startedAt: heartbeat.toISOString(), heartbeat: heartbeat.toISOString() }));

    lock(new Date(Date.now() - 120_000));
    const stale = await json("--vault", root);
    expect(stale.code).toBe(EXIT_NOT_RUNNING);
    expect(stale.r).toMatchObject({ reason: `the lock is stale: engine pid 4242 on ${os.hostname()} stopped without removing it`, lock: { state: "stale", pid: 4242, port }, metastore: { path: path.join(root, "Datanotes/metastore.yaml"), found: true } });

    lock(new Date(), "elsewhere");
    const other = await json("--vault", root);
    expect(other.code).toBe(EXIT_NOT_RUNNING);
    expect(other.r).toMatchObject({ reason: "the vault is held by an engine on elsewhere (pid 4242): pass its --url and --token", lock: { state: "other_host", host_name: "elsewhere" } });

    lock(new Date());
    const gone = await json("--vault", root);
    expect(gone.code).toBe(EXIT_NOT_RUNNING);
    expect(gone.r.reason).toBe(`nothing answers at http://127.0.0.1:${port} (ECONNREFUSED)`);
    expect(gone.r.lock.state).toBe("fresh");
    expect((await status("--vault", root)).out).toContain(`lock       held (pid 4242 on ${os.hostname()}, port ${port}, heartbeat `);
  });

  it("no settings file, no owner token, a metastore that cannot be read, a fetch that fails without a cause", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "status-"));
    fs.mkdirSync(path.join(root, "Datanotes"));
    fs.writeFileSync(path.join(root, METASTORE), "catalogs: [\n");
    const bare = await json("--vault", root);
    // no store yet: no settings file to read
    expect(bare.r).toMatchObject({ settings: null, store: null, metastore: { found: true, error: expect.any(String) } });
    // a fresh lock but no token to call the engine with
    const tokenless = vault(1);
    const store = seedStoreSettings(tokenless, {}, METASTORE);
    fs.writeFileSync(path.join(store, "engine.lock"), JSON.stringify({ kind: "service", pid: 1, host: os.hostname(), port: 9, startedAt: "", heartbeat: new Date().toISOString() }));
    const noToken = await json("--vault", tokenless);
    expect(noToken.code).toBe(EXIT_UNCHECKED);
    expect(noToken.r.error).toBe(`no owner token: httpServerToken is not in ${path.join(store, "settings.json")} (or pass --token)`);
    const urlOnly = await collectStatus({ url: "http://x", json: false });
    expect(urlOnly).toEqual({ code: EXIT_UNCHECKED, report: { running: true, url: "http://x", error: "no owner token: httpServerToken is not in the settings (or pass --token)" } });
    const failing = await collectStatus({ url: "http://x", token: "t", json: false }, { fetch: async () => Promise.reject(new Error("timed out")) });
    expect(failing).toMatchObject({ code: EXIT_NOT_RUNNING, report: { running: false, reason: "nothing answers at http://x (timed out)", vault: null, lock: { state: "none" }, settings: null, metastore: null } });
    // an answer that is not JSON, with another status
    const odd = await collectStatus({ url: "http://x", token: "t", json: false }, { fetch: async () => new Response("<html>", { status: 502 }) });
    expect(odd).toEqual({ code: EXIT_UNCHECKED, report: { running: true, url: "http://x", error: "HTTP 502" } });
  });
});
