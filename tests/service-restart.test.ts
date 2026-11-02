/**
 * The engine restarted in its own process (runService, src/node/service.ts; POST
 * /datanotes/restart/): the restart applies the settings waiting for it, keeps the lock, the port
 * and the data, is refused before anything stops when the next start would fail, is cancelled when
 * a request is still under way, and ends the run when the new start fails.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStartedBy, restartCheck, runService, settingsPath, type RestartCheckInput, type ServiceOptions, type ServiceRun } from "../src/node/service";
import { ListenError } from "../src/server/http-server";
import { guide } from "../src/core/hints";
import { SETTING_RULES } from "../src/core/settings";
import { guided } from "./helpers/guidance";
import { seedStoreSettings } from "./helpers/store-settings";
import { copyTestVault, freePort, until } from "./helpers/test-vault";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210";

const runs: ServiceRun[] = [];
const folders: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const r of runs.splice(0)) await r.stop();
  for (const d of folders.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Json = Record<string, unknown>;

/** A copy of the test vault on a free port, run by runService. */
async function start(o: Partial<ServiceOptions> = {}): Promise<{ run: ServiceRun; root: string; port: number; file: string }> {
  const root = copyTestVault();
  folders.push(root);
  const port = await freePort();
  const store = seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false, autoRecompute: false });
  const run = await runService({ vault: root, watch: "poll", pollMs: 200, httpWaitMs: 10_000, ...o }, {}, { startedBy: "unknown" });
  runs.push(run);
  return { run, root, port: run.current.port, file: settingsPath({}, store) };
}

/**
 * POST on a connection of its own (no keep-alive pool): a pooled connection to the engine before
 * the restart would be reset when the client reuses it.
 */
function post(port: number, route: string, body: unknown = {}, token = TOKEN, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/datanotes${route}`, method: "POST", agent: false, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, json: JSON.parse(text) as Json });
          } catch (e) {
            reject(e as Error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const dry = async (port: number, token = TOKEN) => (await post(port, "/restart/", { dry_run: true }, token)).json;

/** Poll the dry run every 100 ms until it answers another started_at (at most 30 s). */
async function waitBack(port: number, before: string, token = TOKEN): Promise<Json> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await post(port, "/restart/", { dry_run: true }, token);
      if (r.status === 200 && r.json.started_at !== before) return r.json;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the engine did not come back");
}

async function updateSettings(port: number, changes: Json): Promise<{ status: number; json: Json }> {
  const read = await post(port, "/settings/", {});
  return post(port, "/settings/update/", { expect_version: read.json.settings_version, changes });
}

const lockOf = (run: ServiceRun) => JSON.parse(fs.readFileSync(path.join(run.current.store.store, "engine.lock"), "utf8")) as Json;

/** p, or a rejection after ms: a run that never ends fails the test at once instead of hanging it. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: not settled within ${ms} ms`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("a restart over HTTP", () => {
  it("answers a dry run with what runs now", async () => {
    const { port } = await start();
    const d = await dry(port);
    expect(d).toMatchObject({ ready: true, will_apply: [], port, port_after: port, pid: process.pid, started_by: "unknown" });
    const status = await post(port, "/status/");
    expect(d.started_at).toBe((status.json.engine as Json).started_at);
  });

  it("applies a setting waiting for a restart, and keeps the lock", async () => {
    const { run, port } = await start();
    expect((await updateSettings(port, { vaultIndexEnabled: false })).status).toBe(200);
    const d = await dry(port);
    expect(d.will_apply).toEqual(["vaultIndexEnabled"]);
    expect(d.warnings).toEqual([`vaultIndexEnabled: ${SETTING_RULES.vaultIndexEnabled.warning}`]);
    const old = run.current;
    const r = await post(port, "/restart/", {});
    expect(r.status).toBe(200);
    await waitBack(port, d.started_at as string);
    expect(run.restarts).toBe(1);
    expect(run.current).not.toBe(old);
    const s = await post(port, "/settings/", {});
    expect(s.json.restart_pending).toEqual([]);
    expect(run.current.settings.vaultIndexEnabled).toBe(false);
    expect(lockOf(run)).toMatchObject({ pid: process.pid, port });
  });

  it("keeps the writes on both sides, and the change feed goes on", async () => {
    const { port } = await start();
    const first = await post(port, "/operations/insert_row/", { table: "person", values: { name: "Before Restart" } });
    expect(first.status).toBe(200);
    const head = (await post(port, "/operations/list_changes/", { since: 0 })).json.head as number;
    const before = (await dry(port)).started_at as string;
    expect((await post(port, "/restart/", {})).status).toBe(200);
    await waitBack(port, before);
    const second = await post(port, "/operations/insert_row/", { table: "person", values: { name: "After Restart" } });
    expect(second.status).toBe(200);
    const ids = ((await post(port, "/operations/list_migrations/", {})).json.migrations as Json[]).map((m) => m.migration_id);
    expect(ids).toEqual(expect.arrayContaining([first.json.migration_id, second.json.migration_id]));
    const changes = (await post(port, "/operations/list_changes/", { since: head })).json;
    expect(changes.head as number).toBeGreaterThan(head);
    expect(JSON.stringify(changes.events)).toContain("After Restart");
  });

  it("keeps its port when it listens on any free one", async () => {
    const { run } = await start({ port: 0 });
    const port = run.current.port;
    const before = (await dry(port)).started_at as string;
    expect((await post(port, "/restart/", {})).status).toBe(200);
    await waitBack(port, before);
    expect(run.current.port).toBe(port);
  });

  it("applies a new owner token", async () => {
    const { port } = await start();
    expect((await updateSettings(port, { httpServerToken: OTHER })).status).toBe(200);
    const before = (await dry(port)).started_at as string;
    expect((await post(port, "/restart/", {})).status).toBe(200);
    await waitBack(port, before, OTHER);
    expect((await post(port, "/status/", {}, TOKEN)).status).toBe(401);
    const root = await fetch(`http://127.0.0.1:${port}/`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(((await root.json()) as Json).authenticated).toBe(false);
    expect((await post(port, "/status/", {}, OTHER)).status).toBe(200);
  });

  it("is cancelled when a request is still under way after the drain", async () => {
    const { port } = await start({ drainMs: 300 });
    const before = (await dry(port)).started_at as string;
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    let answer = "";
    socket.on("data", (d: Buffer) => (answer += d.toString()));
    socket.write(`POST /datanotes/operations/list_tables/ HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{`);
    await new Promise((r) => setTimeout(r, 100));
    const r = await post(port, "/restart/", {});
    expect(r.status).toBe(200);
    const requestedAt = r.json.requested_at;
    let d: Json = {};
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const x = await post(port, "/restart/", { dry_run: true });
      if (x.status === 200 && x.json.last_cancelled) {
        d = x.json;
        break;
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(d.last_cancelled).toMatchObject({ requested_at: requestedAt, reason: expect.stringContaining("still under way") });
    expect(d.started_at).toBe(before);
    expect((await post(port, "/operations/list_tables/", {})).status).toBe(200);
    const closed = new Promise((res) => socket.once("close", res));
    socket.write("}");
    await closed;
    expect(answer).toMatch(/^HTTP\/1\.1 200 /);
  });

  it("refuses before stopping when the settings file is not JSON", async () => {
    const { port, file } = await start();
    const old = fs.readFileSync(file, "utf8");
    const before = (await dry(port)).started_at;
    fs.writeFileSync(file, "not json");
    try {
      const d = await dry(port);
      expect(d.ready).toBe(false);
      expect((d.problems as Json[])[0]!.error).toMatch(/^the settings file /);
      const r = await post(port, "/restart/", {});
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject(guided((d.problems as Json[])[0]!.error as string, { problems: d.problems }));
      expect(r.json.docs).toBe("https://datanotes.dev/administration/run-the-service.md#restart-the-engine");
      expect((await dry(port)).started_at).toBe(before);
    } finally {
      fs.writeFileSync(file, old);
    }
  });

  it("refuses before stopping when the new port is taken", async () => {
    const { port, file } = await start();
    const busy = await freePort();
    const holder = net.createServer();
    servers.push(holder);
    await new Promise<void>((r) => holder.listen(busy, "127.0.0.1", () => r()));
    const old = fs.readFileSync(file, "utf8");
    const before = (await dry(port)).started_at;
    expect((await updateSettings(port, { httpServerPort: busy })).status).toBe(200);
    try {
      const d = await dry(port);
      expect(d.port_after).toBe(busy);
      expect((d.problems as Json[])[0]!.error).toMatch(new RegExp(`^after the restart the engine could not listen: port ${busy} is already in use`));
      expect((await post(port, "/restart/", {})).status).toBe(409);
      expect((await dry(port)).started_at).toBe(before);
    } finally {
      fs.writeFileSync(file, old);
    }
  });

  it("refuses before stopping when the settings file has no owner token", async () => {
    const { port, file } = await start();
    const old = fs.readFileSync(file, "utf8");
    const before = (await dry(port)).started_at;
    const parsed = JSON.parse(old) as Json;
    delete parsed.httpServerToken;
    fs.writeFileSync(file, JSON.stringify(parsed));
    try {
      const d = await dry(port);
      expect((d.problems as Json[]).map((p) => p.error)).toEqual([expect.stringContaining("has no owner token (httpServerToken)")]);
      expect((await post(port, "/restart/", {})).status).toBe(409);
      expect((await dry(port)).started_at).toBe(before);
    } finally {
      fs.writeFileSync(file, old);
    }
  });

  it("refuses before stopping when the settings file is gone", async () => {
    const { port, file } = await start();
    const old = fs.readFileSync(file, "utf8");
    fs.rmSync(file);
    try {
      const d = await dry(port);
      expect((d.problems as Json[]).map((p) => p.error)).toEqual([`the settings file ${file} is missing: the next start would make a new owner token`]);
      expect(d.will_apply).toEqual([]);
    } finally {
      fs.writeFileSync(file, old);
    }
  });

  it("refuses while the engine is still starting", async () => {
    const root = copyTestVault();
    folders.push(root);
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "dn-restart-remote-"));
    folders.push(remote);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const port = await freePort();
    seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false, autoRecompute: false });
    let done = false;
    const starting = runService({ vault: root, watch: "poll", pollMs: 200, httpWaitMs: 10_000, storeBackup: { enabled: true, remote, every: 3_600_000 } }, {}, { startedBy: "unknown" }).finally(() => (done = true));
    let early: Json | null = null;
    while (!done && !early) {
      const r = await post(port, "/restart/", { dry_run: true }).catch(() => null);
      if (r?.status === 200 && !done) early = r.json;
      else await new Promise((res) => setTimeout(res, 2));
    }
    runs.push(await starting);
    expect(early, "the engine answered only once started").not.toBeNull();
    expect(early!.ready).toBe(false);
    expect(early!.problems).toEqual([guided("the engine is still starting")]);
    expect((await dry(port)).ready).toBe(true);
  });

  it("is POST only, and the owner's alone", async () => {
    const { port } = await start();
    const get = await fetch(`http://127.0.0.1:${port}/datanotes/restart/`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    const cook = (await post(port, "/tokens/create/", { name: "cook" })).json.token as string;
    expect((await post(port, "/restart/", { dry_run: true }, cook)).status).toBe(403);
    const admin = (await post(port, "/tokens/create/", { name: "admin", maintain: true })).json.token as string;
    expect((await post(port, "/restart/", { dry_run: true }, admin)).status).toBe(403);
    const viewAs = await post(port, "/restart/", { dry_run: true }, TOKEN, { "X-Datanotes-View-As": "cook" });
    expect(viewAs.status).toBe(400);
    expect(viewAs.json).toEqual(guided("view as cook only reads: POST /datanotes/restart/ is not a read"));
  });
});

describe("the run", () => {
  it("a stop during a restart ends the run and lets the lock go", async () => {
    const { run, port } = await start();
    const lock = path.join(run.current.store.store, "engine.lock");
    const r = run.restart();
    const s = run.stop();
    await Promise.allSettled([r, s]);
    expect(await run.ended).toEqual({ code: 0 });
    expect(fs.existsSync(lock)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(run.restart).toBeDefined();
    await expect(run.restart()).rejects.toThrow("the engine is ended");
  });

  it("a stop asked once the restarted engine has started ends the run, after the last pushes, with the lock released", { timeout: 90_000 }, async () => {
    const root = copyTestVault();
    folders.push(root);
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "dn-restart-remote-"));
    folders.push(remote);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const port = await freePort();
    seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false, autoRecompute: false });
    let run!: ServiceRun;
    let stopFromAnnounce: Promise<void> | undefined;
    run = await runService(
      { vault: root, watch: "poll", pollMs: 200, httpWaitMs: 10_000, gitSync: { intervalMs: 3_600_000, quietMs: 3_600_000, push: false }, storeBackup: { enabled: true, remote, every: 3_600_000, quietMs: 100 } },
      {},
      {
        startedBy: "unknown",
        announce: (svc, restarted) => {
          if (!restarted) return;
          // written once the new engine runs: only the last commits of its stop can carry them
          fs.mkdirSync(path.join(svc.store.store, "journal"), { recursive: true });
          fs.writeFileSync(path.join(svc.store.store, "journal", "2099-01.jsonl"), "{}\n");
          fs.writeFileSync(path.join(root, "after-restart.txt"), "written once the engine restarted\n");
          stopFromAnnounce = run.stop();
        },
      },
    );
    runs.push(run);
    const store = run.current.store.store;

    const restarted = run.restart();
    expect(await within(run.ended, 60_000, "run.ended")).toEqual({ code: 0 });
    await within(restarted, 5_000, "the restart");
    expect(stopFromAnnounce).toBeDefined();
    await within(stopFromAnnounce!, 5_000, "the stop asked from announce");
    expect(run.restarts).toBe(1);

    expect(fs.existsSync(path.join(store, "engine.lock"))).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

    expect(execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" })).toMatch(/^journal\/2099-01\.jsonl$/m);
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(git(store, "rev-parse", "HEAD"));

    expect(git(root, "ls-files", "after-restart.txt")).toBe("after-restart.txt");
    expect(git(root, "log", "-1", "--format=%s")).toMatch(/^vault sync: /);
  });

  it("a stop while the restarted engine is still starting ends the run once it has started", { timeout: 90_000 }, async () => {
    const { run, port } = await start();
    const old = run.current;
    const lockFile = path.join(old.store.store, "engine.lock");
    // once the old engine has let its port go, hold the port: the new start waits for it (httpWaitMs 10 s)
    const blocker = net.createServer();
    const held = old.stopped.then(
      () =>
        new Promise<void>((resolve, reject) => {
          blocker.once("error", reject);
          blocker.listen(port, "127.0.0.1", () => resolve());
        }),
    );
    const restarted = run.restart();
    void restarted.catch(() => undefined); // awaited below; an early failure must not be an unhandled rejection
    try {
      await within(held, 30_000, "the old engine's stop");
      // the new start runs: its own lock says port 0 until it listens, which the blocker prevents
      await until(
        () => {
          try {
            return (JSON.parse(fs.readFileSync(lockFile, "utf8")) as Json).port === 0;
          } catch {
            return false;
          }
        },
        10_000,
        "the new start's lock",
      );
      const stopped = run.stop();
      await new Promise<void>((r) => blocker.close(() => r()));
      expect(await within(run.ended, 60_000, "run.ended")).toEqual({ code: 0 });
      await within(stopped, 5_000, "run.stop()");
      expect(await within(restarted, 5_000, "the restart")).not.toBe(old);
    } finally {
      if (blocker.listening) await new Promise<void>((r) => blocker.close(() => r()));
    }
    expect(run.restarts).toBe(1);
    expect(fs.existsSync(lockFile)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("a restart whose start fails ends the run with code 1 and the error", async () => {
    const { run, root } = await start();
    const lock = path.join(run.current.store.store, "engine.lock");
    fs.mkdirSync(path.join(root, "extra"), { recursive: true });
    fs.writeFileSync(path.join(root, "extra", "metastore.yaml"), "tables: {}\n");
    await expect(run.restart()).rejects.toThrow(/more than one database/);
    const end = await run.ended;
    expect(end.code).toBe(1);
    expect(String((end.error as Error).message)).toMatch(/more than one database/);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a second restart while one runs is refused", async () => {
    const { run, port } = await start();
    const before = (await dry(port)).started_at as string;
    const first = run.restart();
    await expect(run.restart()).rejects.toThrow("the engine is already restarting");
    await first;
    expect((await waitBack(port, before)).started_at).not.toBe(before);
  });

  it("POST /datanotes/stop/ ends the run", async () => {
    const { run, port } = await start();
    expect((await post(port, "/stop/", {})).status).toBe(200);
    expect(await run.ended).toEqual({ code: 0 });
  });

  it("a stop of the engine itself ends the run", async () => {
    const { run } = await start();
    await run.current.stop();
    expect(await run.ended).toEqual({ code: 0 });
  });
});

describe("restartCheck", () => {
  const o: ServiceOptions = { vault: "/v", watch: "poll", pollMs: 200 };
  const GOOD = JSON.stringify({ httpServerToken: TOKEN, httpServerPort: 27150 });
  function input(over: Partial<RestartCheckInput> = {}): RestartCheckInput & { portCalls: number[] } {
    const portCalls: number[] = [];
    return {
      o,
      file: "/s/settings.json",
      portNow: 27150,
      readText: () => GOOD,
      folderExists: () => true,
      portFree: async (port) => {
        portCalls.push(port);
        return null;
      },
      ...over,
      portCalls,
    };
  }
  const errors = async (i: RestartCheckInput) => (await restartCheck(i)).problems.map((p) => p.error);

  it("finds nothing wrong, and does not check a port that does not change", async () => {
    const i = input();
    const r = await restartCheck(i);
    expect(r.problems).toEqual([]);
    expect(r.next?.httpServerToken).toBe(TOKEN);
    expect(r.portAfter).toBe(27150);
    expect(i.portCalls).toEqual([]);
  });

  it("says why the next start would fail, each problem guided", async () => {
    const all = await restartCheck(input({ folderExists: () => false, readText: () => null }));
    expect(all.problems).toEqual([guided("the folder /v is gone: the engine could not start on it again"), guided("the settings file /s/settings.json is missing: the next start would make a new owner token")]);
    expect(all.problems[0]!.docs).toBe("https://datanotes.dev/administration/run-the-service.md#restart-the-engine");
    expect(all.next).toBeNull();
    expect((await errors(input({ readText: () => "{ nope" })))[0]).toMatch(/^the settings file \/s\/settings\.json is not a JSON object \(.+\): the next start would ignore it and make a new owner token$/);
    expect(await errors(input({ readText: () => "[]" }))).toEqual([expect.stringContaining("(it holds an array)")]);
    expect(await errors(input({ readText: () => "null" }))).toEqual([expect.stringContaining("(it holds null)")]);
    expect(await errors(input({ readText: () => "5" }))).toEqual([expect.stringContaining("(it holds a number)")]);
    expect(await errors(input({ readText: () => JSON.stringify({ httpServerToken: TOKEN, httpServerPort: 80 }) }))).toEqual([expect.stringMatching(/^the settings file \/s\/settings\.json has a value the next start refuses: /)]);
    expect(await errors(input({ readText: () => JSON.stringify({ httpServerToken: "" }) }))).toEqual(["the settings file /s/settings.json has no owner token (httpServerToken): the next start would make a new one"]);
  });

  it("checks a new port, the option winning over the file, 0 keeping the port", async () => {
    const busy = new ListenError("port 28000 is already in use (127.0.0.1:28000)", "EADDRINUSE", guide("x", "port"));
    const i = input({ readText: () => JSON.stringify({ httpServerToken: TOKEN, httpServerPort: 28000 }), portFree: async () => busy });
    const r = await restartCheck(i);
    expect(r.portAfter).toBe(28000);
    expect(r.problems.map((p) => p.error)).toEqual(["after the restart the engine could not listen: port 28000 is already in use (127.0.0.1:28000)"]);
    const opt = input({ o: { ...o, port: 27150 }, readText: () => JSON.stringify({ httpServerToken: TOKEN, httpServerPort: 28000 }) });
    expect((await restartCheck(opt)).portAfter).toBe(27150);
    expect(opt.portCalls).toEqual([]);
    const any = input({ readText: () => JSON.stringify({ httpServerToken: TOKEN, httpServerPort: 0 }) });
    expect((await restartCheck(any)).portAfter).toBe(27150);
    const other = input({ o: { ...o, host: "0.0.0.0" }, readText: () => JSON.stringify({ httpServerToken: TOKEN, httpServerPort: 28001 }) });
    expect((await restartCheck(other)).problems).toEqual([]);
    expect(other.portCalls).toEqual([28001]);
  });
});

describe("detectStartedBy", () => {
  const none = () => false;
  it("tells a container, then systemd, then a terminal", () => {
    expect(detectStartedBy({}, (f) => f === "/.dockerenv", true)).toBe("container");
    expect(detectStartedBy({ INVOCATION_ID: "x" }, (f) => f === "/run/.containerenv", true)).toBe("container");
    expect(detectStartedBy({ container: "podman", INVOCATION_ID: "x" }, none, true)).toBe("container");
    expect(detectStartedBy({ INVOCATION_ID: "x" }, none, true)).toBe("systemd");
    expect(detectStartedBy({ INVOCATION_ID: "" }, none, true)).toBe("terminal");
    expect(detectStartedBy({}, none, false)).toBe("unknown");
  });
});
