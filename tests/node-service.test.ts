import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuidedError } from "../src/core/hints";
import { isFresh, readLock } from "../src/server/engine-lock";
import { parseArgs, settingsPath, startService, type RunningService } from "../src/node/service";
import { nodeStoreAdapter } from "../src/node/node-app";
import { LOG_YAML, METASTORE } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";

const running: RunningService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of running.splice(0)) await s.stop();
});

function vault(extraKey: boolean, port: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "svc-"));
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w(METASTORE, LOG_YAML);
  w("Daily/a.md", "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: alcohol\noccurred_at: 2026-09-25T22:30\n---\nA\n");
  const settings = { httpServerPort: port, httpServerToken: "secret-token", fileLogEnabled: false, autoRecompute: false };
  seedStoreSettings(root, extraKey ? { ...settings, someOtherKey: 1 } : settings, METASTORE);
  return root;
}

/** A port the operating system says is free. */
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

describe("headless service", () => {
  it("parses arguments and finds the settings", async () => {
    expect(parseArgs(["--vault", "/v", "--watch", "poll", "--poll-ms", "500"], {})).toMatchObject({ vault: path.resolve("/v"), watch: "poll", pollMs: 500 });
    expect(parseArgs([], { DATANOTES_VAULT: "/x" }).watch).toBe("events");
    expect(() => parseArgs([], {})).toThrow(/--vault/);
    expect(() => parseArgs(["--vault", "/v", "--watch", "nope"], {})).toThrow(/events/);
    const p = await freePort();
    const a = vault(true, p);
    expect(settingsPath({ settingsFile: "x/s.json" }, a)).toBe(path.resolve("x/s.json"));
    const b = vault(false, p);
    expect(settingsPath({}, b)).toBe(path.join(b, "settings.json"));
  });

  it("serves the vault over HTTP, follows hand edits, holds the lock", async () => {
    const p = await freePort();
    const root = vault(true, p);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 100 }, {});
    running.push(svc);
    const base = `http://127.0.0.1:${p}`;
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };
    const tables = await (await fetch(`${base}/datanotes/operations/list_tables/`, { method: "POST", headers: auth })).json();
    expect((tables as { tables: { qualified: string }[] }).tables.map((t) => t.qualified)).toEqual(["main.public.log"]);

    // Writes and reads through the operations' routes.
    const post = async (route: string, body: unknown) => {
      const r = await fetch(`${base}/datanotes/${route}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    const ins = await post("operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-09-26T08:00" } });
    expect(ins.status).toBe(200);
    expect(ins.json.ok).toBe(true);
    expect(fs.existsSync(path.join(root, (ins.json.planned_creates as string[])[0]!))).toBe(true);
    const refused = await post("operations/insert_row/", { table: "log", values: { kind: "nope", occurred_at: "2026-09-26T09:00" } });
    expect(refused.status).toBe(422);
    expect(refused.json.ok).toBe(false);
    const missing = await post("operations/select_rows/", { table: "nope" });
    expect(missing.status).toBe(404);
    expect(String(missing.json.error)).toMatch(/Table not found/);

    // A hand edit (another editor) reaches the engine through the watcher.
    fs.writeFileSync(path.join(root, "Daily/b.md"), "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: walk\noccurred_at: 2026-09-27T10:00\n---\n");
    let total = 0;
    for (let i = 0; i < 40 && total < 3; i++) {
      await new Promise((r) => setTimeout(r, 50));
      total = (await post("operations/select_rows/", { table: "log" })).json.total as number;
    }
    expect(total).toBe(3);

    const lock = await readLock(nodeStoreAdapter(svc.store.store), "");
    expect(lock).toMatchObject({ kind: "service", port: p, pid: process.pid });
    expect(isFresh(lock)).toBe(true);
    // The plugin's settings file keeps its other keys.
    expect(JSON.parse(fs.readFileSync(path.join(svc.store.store, "settings.json"), "utf8")).someOtherKey).toBe(1);

    await svc.stop();
    running.pop();
    expect(fs.existsSync(path.join(svc.store.store, "engine.lock"))).toBe(false);
    await expect(fetch(`${base}/`)).rejects.toThrow();
  });

  it("with port 0, reports the port the system chose, in the lock and to the caller", async () => {
    const root = vault(false, 0);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 1000 }, {});
    running.push(svc);
    expect(svc.port).toBeGreaterThan(0);
    expect(svc.runtime.httpPort).toBe(svc.port);
    const lock = JSON.parse(fs.readFileSync(path.join(svc.store.store, "engine.lock"), "utf8")) as { port: number };
    expect(lock.port).toBe(svc.port);
    const r = await fetch(`http://127.0.0.1:${lock.port}/datanotes/operations/list_tables/`, { method: "POST", headers: { Authorization: "Bearer secret-token" }, body: "{}" });
    expect(r.status).toBe(200);
    await svc.stop();
    running.pop();
    expect(svc.runtime.httpPort).toBeNull();
  });

  it("refuses a second engine on a vault another live engine holds", async () => {
    const p = await freePort();
    const root = vault(false, p);
    const first = await startService({ vault: root, watch: "poll", pollMs: 1000 }, {});
    running.push(first);
    const other = await freePort();
    fs.writeFileSync(path.join(root, "..", `other-${other}.json`), JSON.stringify({ httpServerPort: other, httpServerToken: "t", fileLogEnabled: false }));
    // same process (same pid) is allowed to restart; a lock left by another live process is not
    const lockFile = path.join(first.store.store, "engine.lock");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number };
    fs.writeFileSync(lockFile, JSON.stringify({ ...lock, pid: process.ppid }));
    await expect(startService({ vault: root, watch: "poll", pollMs: 1000, settingsFile: path.join(root, "..", `other-${other}.json`) }, {})).rejects.toThrow(/another engine holds the vault/);
  });

  it("refuses to start when the port is taken, saying why and what to do", async () => {
    const p = await freePort();
    const first = await startService({ vault: vault(false, p), watch: "poll", pollMs: 1000 }, {});
    running.push(first);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // the server's own retries take about 3 s; the service then waits for the port, and says so
    const refused = await startService({ vault: vault(false, p), watch: "poll", pollMs: 1000, httpWaitMs: 3_500 }, {}).catch((e: unknown) => e as GuidedError);
    expect(refused).toMatchObject({
      message: `HTTP server did not start: port ${p} is already in use (127.0.0.1:${p})`,
      hint: expect.stringMatching(/--port 0 for any free port/),
      docs: "https://datanotes.dev/administration/run-the-service.md#choose-the-port",
    });
    expect(log.mock.calls.flat().join("\n")).toMatch(new RegExp(`datanotes service: port ${p} is already in use \\(127\\.0\\.0\\.1:${p}\\); waiting up to \\d+ s for it to be free`));
  }, 30_000);

  it("an address that is not this machine's fails at once (only a busy port is waited for)", async () => {
    const root = vault(false, 0);
    const t0 = Date.now();
    const refused = await startService({ vault: root, watch: "poll", pollMs: 1000, host: "203.0.113.1", httpWaitMs: 30_000 }, {}).catch((e: unknown) => e as GuidedError);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(refused).toMatchObject({ message: "HTTP server did not start: 203.0.113.1 is not an address of this machine (EADDRNOTAVAIL)", hint: expect.stringMatching(/^Give --host an address of this machine/), docs: expect.stringMatching(/#choose-the-port$/) });
  });

  it("--port is this run's port, over the setting and never saved; with 0 the lock and the status give the port bound", async () => {
    const setting = await freePort();
    const root = vault(false, setting);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 1000, port: 0 }, {});
    running.push(svc);
    expect(svc.port).not.toBe(setting);
    expect(svc.port).toBeGreaterThan(0);
    const lock = JSON.parse(fs.readFileSync(path.join(svc.store.store, "engine.lock"), "utf8")) as { port: number };
    expect(lock.port).toBe(svc.port);
    const status = (await (await fetch(`http://127.0.0.1:${svc.port}/datanotes/status/`, { method: "POST", headers: { Authorization: "Bearer secret-token" }, body: "{}" })).json()) as { engine: { http: { port: number } } };
    expect(status.engine.http.port).toBe(svc.port);
    // the setting stays as it was, the engine saving its settings or not
    expect(JSON.parse(fs.readFileSync(path.join(svc.store.store, "settings.json"), "utf8")).httpServerPort).toBe(setting);
  });

  it("stops gracefully when the owner asks over HTTP: the answer first, then the lock released and the port freed", async () => {
    const p = await freePort();
    const root = vault(false, p);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 100 }, {});
    running.push(svc);
    const post = (route: string, body: unknown, token = "secret-token") =>
      fetch(`http://127.0.0.1:${p}/datanotes/${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    // a named token may not stop the engine, even with maintain
    const created = (await (await post("tokens/create/", { name: "agent", write: ["*"], maintain: true })).json()) as { token: string };
    expect((await post("stop/", {}, created.token)).status).toBe(403);
    // a long poll under way answers at once with what it has, instead of holding the stop
    const poll = post("operations/list_changes/", { since: 0, wait_ms: 20_000, tables: ["nope"] });
    await new Promise((r) => setTimeout(r, 200));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t0 = Date.now();
    const stop = await post("stop/", {});
    expect([stop.status, await stop.json()]).toEqual([200, { ok: true, stopping: true, pid: process.pid }]);
    expect((await poll).status).toBe(200);
    await svc.stopped;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(log.mock.calls.flat()).toContain("datanotes service: stop requested, stopping");
    expect(fs.existsSync(path.join(svc.store.store, "engine.lock"))).toBe(false);
    await expect(fetch(`http://127.0.0.1:${p}/`)).rejects.toThrow();
    // stop() after it: the same stop, already done
    await svc.stop();
  });

  it("answers unauthenticated requests with 401 and no OAuth challenge", async () => {
    const p = await freePort();
    const svc = await startService({ vault: vault(false, p), watch: "poll", pollMs: 1000 }, {});
    running.push(svc);
    const rest = await fetch(`http://127.0.0.1:${p}/datanotes/operations/list_tables/`, { method: "POST", headers: { Authorization: "Bearer nope-0123456789" }, body: "{}" });
    expect(rest.status).toBe(401);
    expect(rest.headers.get("www-authenticate")).toBeNull();
    expect((await fetch(`http://127.0.0.1:${p}/mcp`, { method: "POST", headers: { Authorization: "Bearer secret-token" }, body: "{}" })).status).toBe(404);
  });

  it("syncs the vault's git repository with --git-sync, commit message listing the operations", async () => {
    const p = await freePort();
    const root = vault(false, p);
    const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    sh("init", "-q", "-b", "main");
    sh("config", "user.name", "Test");
    sh("config", "user.email", "t@example.com");
    fs.writeFileSync(path.join(root, ".gitignore"), "");
    sh("add", "-A");
    sh("commit", "-q", "-m", "init");
    expect(parseArgs(["--vault", root, "--git-sync", "--git-interval-min", "5", "--git-no-push"], {}).gitSync).toEqual({ intervalMs: 300_000, quietMs: 60_000, push: false });
    const svc = await startService({ vault: root, watch: "poll", pollMs: 1000, gitSync: { intervalMs: 3_600_000, quietMs: 3_600_000, push: false } }, {});
    running.push(svc);
    await svc.git!.cycle(); // the startup cycle (nothing to commit) is over before the write
    const r = await fetch(`http://127.0.0.1:${p}/datanotes/operations/update_row/`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json", "X-Datanotes-Actor": JSON.stringify({ harness: "claude-code" }) },
      body: JSON.stringify({ table: "log", path: "Daily/a.md", set: { kind: "mood" } }),
    });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    await svc.git!.cycle();
    const msg = sh("log", "-1", "--format=%B");
    expect(msg).toMatch(/^vault sync: 1 operation, 2 files/); // the note was renamed (its name uses kind)
    expect(msg).toMatch(/- update .*\(claude-code\)/);
    expect(sh("status", "--porcelain")).toBe("");
  }, 30_000); // about 20 git processes: slow on Windows under load

  it("an operation right after a hand edit reads it, and the log records the edit before the operation", async () => {
    const p = await freePort();
    const root = vault(false, p);
    fs.writeFileSync(path.join(root, "Daily/b.md"), "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: mood\noccurred_at: 2026-09-26T08:00\n---\nB\n");
    // the poll never comes round during the test: only the settle before each operation sees the edits
    const svc = await startService({ vault: root, watch: "poll", pollMs: 3_600_000 }, {});
    running.push(svc);
    const post = async (route: string, body: unknown) => {
      const r = await fetch(`http://127.0.0.1:${p}/datanotes/${route}`, { method: "POST", headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return (await r.json()) as Record<string, unknown>;
    };
    expect(await post("operations/configure_database/", { history: true })).toMatchObject({ config: { history: true } });
    const first = (await post("operations/update_row/", { table: "log", path: "Daily/b.md", set: { kind: "alcohol" } })) as { planned_moves: { to: string }[] }; // the first version (renamed: its name uses kind)
    fs.writeFileSync(path.join(root, "Daily/a.md"), fs.readFileSync(path.join(root, "Daily/a.md"), "utf8").replace("\nA\n", "\nA, by hand\n"));
    const upd = await post("operations/update_row/", { table: "log", path: first.planned_moves[0]!.to, set: { kind: "mood" } });
    expect(upd).toMatchObject({ ok: true });
    const h = (await post("operations/describe_history/", { table: "log" })) as { history: { operation: string }[] };
    expect(h.history.slice(0, 2).map((v) => v.operation)).toEqual(["UPDATE", "EXTERNAL_EDIT"]);
    // the row edited by hand is read as it is on disk: the write keeps the hand edit
    fs.writeFileSync(path.join(root, "Daily/a.md"), fs.readFileSync(path.join(root, "Daily/a.md"), "utf8").replace("A, by hand", "A, by hand again"));
    const again = (await post("operations/update_row/", { table: "log", path: "Daily/a.md", set: { kind: "mood" } })) as { ok: boolean; planned_moves: { to: string }[] };
    expect(again.ok).toBe(true);
    const text = fs.readFileSync(path.join(root, again.planned_moves[0]?.to ?? "Daily/a.md"), "utf8");
    expect(text).toContain("A, by hand again");
    expect(text).toContain("kind: mood");
  }, 30_000);

  it("starts the change feed and webhooks once a metastore that could not be read at start is fixed", async () => {
    const p = await freePort();
    const root = vault(false, p);
    // broken YAML, its id line whole (the store, with the settings, is the database's): the service starts, the change feed waits
    const idLine = fs.readFileSync(path.join(root, METASTORE), "utf8").split("\n").find((l) => l.startsWith("id: "))!;
    fs.writeFileSync(path.join(root, METASTORE), `${idLine}\ncatalogs: [\n`);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 100 }, {});
    running.push(svc);
    expect(svc.runtime.changeFeed).toBeNull();
    const post = (route: string, body: Record<string, unknown> = {}) =>
      fetch(`http://127.0.0.1:${p}/datanotes/${route}`, { method: "POST", headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("operations/list_changes/")).status).toBe(400);
    expect((await post("operations/list_webhooks/")).status).toBe(400);
    // The file is fixed: the watcher's modify event re-reads it, and the change feed starts with that read (no restart).
    fs.writeFileSync(path.join(root, METASTORE), `${idLine}\n${LOG_YAML}`);
    for (let i = 0; i < 40 && !svc.runtime.changeFeed; i++) await new Promise((r) => setTimeout(r, 50));
    expect(svc.runtime.api.listTables().map((t) => t.qualified)).toEqual(["main.public.log"]);
    expect((await post("operations/select_rows/", { table: "log" })).status).toBe(200);
    expect((await post("operations/list_changes/")).status).toBe(200);
    expect((await post("operations/list_webhooks/")).status).toBe(200);
  });

  it("re-reads metastore.yaml when a checkout moves it away and back, and keeps the tables listed", async () => {
    const p = await freePort();
    const root = vault(false, p);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 100 }, {});
    running.push(svc);
    const tables = () => svc.runtime.api.listTables().map((t) => t.qualified);
    const settle = async (want: string[]) => {
      for (let i = 0; i < 40 && JSON.stringify(tables()) !== JSON.stringify(want); i++) await new Promise((r) => setTimeout(r, 50));
      expect(tables()).toEqual(want);
    };
    expect(tables()).toEqual(["main.public.log"]);
    // End to end: the runtime's re-read or the change feed's; the runtime alone is covered in metastore-file.test.ts.
    fs.renameSync(path.join(root, METASTORE), path.join(root, "Datanotes/old.yaml"));
    await settle([]);
    fs.renameSync(path.join(root, "Datanotes/old.yaml"), path.join(root, METASTORE));
    await settle(["main.public.log"]);
  });

  it("streams the change feed as Server-Sent Events and resumes from Last-Event-ID", async () => {
    const p = await freePort();
    const root = vault(false, p);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 100 }, {});
    running.push(svc);
    const open = async (headers: Record<string, string> = {}, query = "since=0") => {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${p}/datanotes/changes/stream?${query}`, { headers: { Authorization: "Bearer secret-token", ...headers }, signal: ac.signal });
      const reader = res.body!.getReader();
      let text = "";
      const until = async (re: RegExp) => {
        const deadline = Date.now() + 8000;
        while (!re.test(text) && Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
        return text;
      };
      return { res, until, close: () => ac.abort() };
    };
    const s1 = await open({}, "since=0&tables=log");
    expect(s1.res.headers.get("content-type")).toMatch(/text\/event-stream/);
    fs.writeFileSync(path.join(root, "Daily/a.md"), "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: walk\noccurred_at: 2026-09-25T22:30\n---\nA\n");
    const got = await s1.until(/id: 1\ndata: /);
    expect(got).toMatch(/"kind":"update"/);
    expect(got).toMatch(/"kind":\{"before":"alcohol","after":"walk"\}/);
    s1.close();
    fs.writeFileSync(path.join(root, "Daily/a.md"), "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: mood\noccurred_at: 2026-09-25T22:30\n---\nA\n");
    const s2 = await open({ "Last-Event-ID": "1" }, "");
    const resumed = await s2.until(/id: 2\ndata: /);
    expect(resumed).not.toMatch(/id: 1\n/);
    s2.close();
    expect((await fetch(`http://127.0.0.1:${p}/datanotes/changes/stream`)).status).toBe(401);
  });

});
