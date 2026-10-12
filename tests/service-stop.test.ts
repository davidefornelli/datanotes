/**
 * `datanotes stop` (src/node/stop.ts) and `datanotes serve --port`, on the Node host. The command's
 * paths run against engines in this process (startService) and against stand-ins (an answer
 * faked, a lock written by hand). The end-to-end checks run the command as it ships (src/node/cli.ts
 * bundled as esbuild.service.mjs bundles dist/datanotes.cjs) in child processes: serve on any free
 * port with the store backup on, stop, and the backup's last commit pushed before the process ends.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { storeLocation } from "../src/api/local";
import type { GuidedError } from "../src/core/hints";
import { parseArgs, parsePort, startService, type RunningService } from "../src/node/service";
import { collectStatus } from "../src/node/status";
import { EXIT_NOT_ASKED, EXIT_NOT_RUNNING, EXIT_NOT_STOPPED, EXIT_STOPPED, formatStop, main, parseStopArgs, processAlive, stopEngine, type StopDeps } from "../src/node/stop";
import { LOG_YAML, METASTORE } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";
import { copyTestVault, freePort } from "./helpers/test-vault";

const TOKEN = "stop-owner-token";
const temp: string[] = [];
const running: RunningService[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});
afterAll(() => {
  for (const d of temp) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temp.push(d);
  return d;
}

/** A vault with the `log` table, its settings in its store. */
function vault(port: number): string {
  const root = tempDir("dn-stop-");
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w(METASTORE, LOG_YAML);
  seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false, autoRecompute: false }, METASTORE);
  return root;
}

/** A vault whose store holds a lock and the settings: what `datanotes stop` reads, written by hand. */
function lockedVault(lock: Record<string, unknown>, token = TOKEN): string {
  const root = tempDir("dn-stop-lock-");
  const store = seedStoreSettings(root, { httpServerToken: token });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(store, "engine.lock"), JSON.stringify({ kind: "service", pid: 4242, host: os.hostname(), port: 4243, startedAt: now, heartbeat: now, ...lock }));
  return root;
}

const ENV = { DATANOTES_DATA_HOME: process.env.DATANOTES_DATA_HOME };

/** A fetch that answers the stop request with `status` and `body`, and `GET /` as `alive` says. */
function fakeFetch(status: number, body: unknown, answersGet: () => boolean = () => false): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith("/stop/")) return new Response(JSON.stringify(body), { status });
    if (answersGet()) return new Response("{}", { status: 503 });
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch;
}

describe("datanotes stop: arguments", () => {
  it("the vault or an address, the timeout in seconds, JSON; the environment when the command line does not say", () => {
    expect(parseStopArgs(["--vault", "/v"], {})).toEqual({ vault: path.resolve("/v"), timeoutMs: 60_000, json: false });
    expect(parseStopArgs(["--timeout-s", "2.5", "--json", "--store", "s", "--settings", "x.json"], { DATANOTES_VAULT: "/env" })).toEqual({
      vault: path.resolve("/env"),
      store: path.resolve("s"),
      settingsFile: path.resolve("x.json"),
      timeoutMs: 2500,
      json: true,
    });
    expect(parseStopArgs([], { DATANOTES_URL: "http://h:1/", DATANOTES_TOKEN: "t" })).toEqual({ url: "http://h:1", token: "t", timeoutMs: 60_000, json: false });
    expect(() => parseStopArgs([], {})).toThrow("pass --database <folder> (or --vault <folder>, DATANOTES_DATABASE, DATANOTES_VAULT), or --url and --token");
    expect(() => parseStopArgs(["--url", "http://h:1"], {})).toThrow(/pass --database/);
    expect(parseStopArgs(["--database", "db"], {}).vault).toBe(path.resolve("db"));
    expect(() => parseStopArgs(["--database", "db", "--vault", "v"], {})).toThrow("datanotes stop: --database and --vault name the folder twice");
  });

  it("a timeout that is not a number of seconds says what to pass", () => {
    const e = (() => {
      try {
        parseStopArgs(["--vault", "/v", "--timeout-s", "soon"], {});
      } catch (x) {
        return x as GuidedError;
      }
      return null;
    })();
    expect(e).toMatchObject({ message: '--timeout-s must be a number of seconds: "soon"', hint: expect.stringMatching(/^Pass --timeout-s 60 \(the default\)/), docs: "https://datanotes.dev/administration/run-the-service.md#stop-the-engine" });
  });
});

describe("datanotes stop: an engine in this process", () => {
  /** The engine's process is this one: it counts as gone once the service has stopped. */
  function aliveUntil(svc: RunningService): StopDeps["alive"] {
    let ended = false;
    void svc.stopped.then(() => (ended = true));
    return (pid) => (pid === process.pid ? !ended : processAlive(pid));
  }

  it("asks the engine to stop, waits for it, and reports: exit 0", async () => {
    const p = await freePort();
    const root = vault(p);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 100 }, {});
    running.push(svc);
    let out = "";
    const code = await main(["--vault", root], { env: ENV, alive: aliveUntil(svc), pollMs: 20, write: (t) => (out += t) });
    expect(code).toBe(EXIT_STOPPED);
    expect(out).toMatch(new RegExp(`^datanotes stop: the engine \\(pid ${process.pid}\\) stopped in [\\d.]+ s \\(http://127\\.0\\.0\\.1:${p}\\)\\n$`));
    expect(fs.existsSync(path.join(svc.store.store, "engine.lock"))).toBe(false);
    // nothing runs any more: exit 2
    const again = await stopEngine({ vault: root, timeoutMs: 1000, json: false, env: ENV });
    expect(again).toMatchObject({ code: EXIT_NOT_RUNNING, report: { stopped: false, message: "no engine runs on the vault (no lock held, or no owner token in the settings)" } });
  });

  it("--json: the report as JSON, with the exit code", async () => {
    const p = await freePort();
    const root = vault(p);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 100 }, {});
    running.push(svc);
    let out = "";
    expect(await main(["--vault", root, "--json"], { env: ENV, alive: aliveUntil(svc), pollMs: 20, write: (t) => (out += t) })).toBe(EXIT_STOPPED);
    expect(JSON.parse(out)).toEqual({ exit_code: 0, stopped: true, url: `http://127.0.0.1:${p}`, pid: process.pid, seconds: expect.any(Number), message: `the engine (pid ${process.pid}) stopped` });
  });
});

describe("datanotes stop: what can go wrong", () => {
  it("an engine that does not end within the timeout: exit 1, and how to stop it by force", async () => {
    const root = lockedVault({});
    const r = await stopEngine({ vault: root, timeoutMs: 0, json: false }, { fetch: fakeFetch(200, { ok: true, stopping: true, pid: 4242 }), alive: () => true });
    expect(r).toMatchObject({ code: EXIT_NOT_STOPPED, report: { stopped: false, pid: 4242, url: "http://127.0.0.1:4243", message: "the engine (pid 4242) still runs after 0 s: it may be finishing a long write or a git push" } });
    // datanotes stop first, SIGTERM next, the hard kill last, with what it may leave behind
    expect(r.report.hint).toBe(
      "Run datanotes stop again with a longer --timeout-s: the engine finishes its write, then stops. Outside Windows, kill 4242 (SIGTERM) stops it the same way. " +
        "Force it (Stop-Process -Id 4242 -Force on Windows, kill -9 4242 elsewhere) only as a last resort: a write it interrupts may stay half applied and outside the journal (run check_table after the next start), and its last git sync and store backup push are skipped (the next start makes them).",
    );
    expect(formatStop(r.report)).toBe(`datanotes stop: ${r.report.message}\n${r.report.hint}`);
  });

  it("the stop refused: a wrong token, a named token, an engine older than stop, another failure", async () => {
    const root = lockedVault({});
    const run = (status: number, body: unknown = {}) => stopEngine({ vault: root, timeoutMs: 1000, json: false }, { fetch: fakeFetch(status, body), alive: () => true });
    expect((await run(401)).report).toMatchObject({ message: "the token was refused (401): stop needs the owner's token", hint: expect.stringMatching(/^Pass the owner's token/) });
    expect((await run(403)).report).toMatchObject({ message: "a named token cannot stop the engine (403): it needs the owner's token", hint: expect.stringMatching(/^Pass the owner's token/) });
    expect((await run(404)).report).toMatchObject({ message: "this engine cannot stop on request (404): it is older than datanotes stop", hint: expect.stringMatching(/^Stop it with Ctrl\+C or a signal .*only as a last resort/) });
    expect((await run(500, { error: "disk gone" })).report).toMatchObject({ message: "HTTP 500: disk gone", hint: expect.stringMatching(/^Run datanotes stop again .*Stop-Process -Id 4242 -Force/) });
    // an answer that is not JSON
    const html = await stopEngine({ vault: root, timeoutMs: 1000, json: false }, { fetch: (async () => new Response("<html>", { status: 502 })) as typeof fetch, alive: () => true });
    expect(html.report.message).toBe("HTTP 502");
    // the stop could not be asked: exit 3
    expect((await run(401)).code).toBe(EXIT_NOT_ASKED);
  });

  it("nothing answers: a process still there is stopped by force (exit 1), none means no engine (exit 2)", async () => {
    const root = lockedVault({});
    const hung = await stopEngine({ vault: root, timeoutMs: 1000, json: false }, { fetch: (async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))) as typeof fetch, alive: () => true });
    expect(hung).toMatchObject({ code: EXIT_NOT_STOPPED, report: { message: "the engine (pid 4242) does not answer at http://127.0.0.1:4243 (ECONNREFUSED)", hint: expect.stringMatching(/Stop-Process -Id 4242 -Force/) } });
    const gone = await stopEngine({ vault: root, timeoutMs: 1000, json: false }, { fetch: (async () => Promise.reject(new Error("socket hang up"))) as typeof fetch, alive: () => false });
    expect(gone).toMatchObject({ code: EXIT_NOT_RUNNING, report: { message: "nothing answers at http://127.0.0.1:4243 (socket hang up)" } });
  });

  it("a lock of another machine, an engine still starting (port 0 in its lock)", async () => {
    const other = await stopEngine({ vault: lockedVault({ host: "elsewhere" }), timeoutMs: 1000, json: false });
    expect(other).toMatchObject({ code: EXIT_NOT_ASKED, report: { message: "the vault is held by an engine on elsewhere; connect to it by its address", hint: "Run datanotes stop on that machine, or pass the engine's --url and --token." } });
    const starting = await stopEngine({ vault: lockedVault({ port: 0 }), timeoutMs: 1000, json: false });
    expect(starting).toMatchObject({ code: EXIT_NOT_ASKED, report: { pid: 4242, message: "the engine (pid 4242) is starting: its HTTP server does not listen yet", hint: "Run datanotes stop again in a moment." } });
    // datanotes status says the same
    const status = await collectStatus({ vault: lockedVault({ port: 0 }), json: false, env: ENV });
    expect(status.report).toMatchObject({ running: false, reason: "the engine (pid 4242) is starting: its HTTP server does not listen yet" });
  });

  it("--url and --token: the end is when the address no longer answers; a stop already under way (503) is waited for too", async () => {
    let answers = 2;
    const fetchFn = fakeFetch(503, { error: "the engine is stopping" }, () => answers-- > 0);
    const r = await stopEngine({ url: "http://engine.example:27150", token: "t", timeoutMs: 5000, json: false }, { fetch: fetchFn, sleep: async () => undefined });
    expect(r).toMatchObject({ code: EXIT_STOPPED, report: { stopped: true, pid: null, url: "http://engine.example:27150", message: "the engine stopped" } });
    expect(formatStop(r.report)).toMatch(/^datanotes stop: the engine stopped in [\d.]+ s \(http:\/\/engine\.example:27150\)$/);
    // the answer's pid is not watched: the engine may be on another machine
    const remote = await stopEngine({ url: "http://engine.example:27150", token: "t", timeoutMs: 5000, json: false }, { fetch: fakeFetch(200, { ok: true, stopping: true, pid: 99 }), sleep: async () => undefined });
    expect(remote.report).toMatchObject({ stopped: true, pid: null });
    // an address that keeps answering: not stopped, and no pid to end
    const busy = await stopEngine({ url: "http://engine.example:27150", token: "t", timeoutMs: 0, json: false }, { fetch: fakeFetch(200, { ok: true }, () => true) });
    expect(busy.report).toMatchObject({ stopped: false, pid: null, message: "the engine still runs after 0 s: it may be finishing a long write or a git push" });
    expect(busy.report.hint).toMatch(/^Run datanotes stop again with a longer --timeout-s: .*kill <pid> \(SIGTERM\).*kill -9 <pid> elsewhere\) only as a last resort/);
  });

  it("--store and --settings name the engine's store and settings file", async () => {
    const root = lockedVault({});
    const store = storeLocation(root, { env: ENV })!.store;
    const r = await stopEngine(
      { vault: tempDir("dn-stop-other-"), store, settingsFile: path.join(store, "settings.json"), timeoutMs: 1000, json: false },
      { fetch: fakeFetch(200, { ok: true, stopping: true, pid: 4242 }), alive: () => false },
    );
    expect(r).toMatchObject({ code: EXIT_STOPPED, report: { stopped: true, pid: 4242, url: "http://127.0.0.1:4243" } });
  });
});

describe("datanotes stop: the vault with another address, and the output", () => {
  it("--url with --vault: the address given, the owner token of the vault's settings; the report on stdout", async () => {
    const root = lockedVault({});
    let sent: { url: string; auth: string } | null = null;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/stop/")) sent = { url: String(url), auth: (init!.headers as Record<string, string>).Authorization! };
      return new Response(JSON.stringify({ ok: true, stopping: true, pid: 4242 }), { status: 200 });
    }) as typeof fetch;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await main(["--vault", root, "--url", "http://127.0.0.1:5555"], { fetch: fetchFn, alive: () => false });
      expect(code).toBe(EXIT_STOPPED);
      expect(sent).toEqual({ url: "http://127.0.0.1:5555/datanotes/stop/", auth: `Bearer ${TOKEN}` });
      expect(String(write.mock.calls[0]![0])).toMatch(/^datanotes stop: the engine \(pid 4242\) stopped in [\d.]+ s \(http:\/\/127\.0\.0\.1:5555\)\n$/);
    } finally {
      write.mockRestore();
    }
  });
});

describe("datanotes serve --port", () => {
  it("--port and DATANOTES_PORT: 0 or 1024 to 65535; anything else says what to pass", () => {
    expect(parseArgs(["--vault", "/v", "--port", "0"], {}).port).toBe(0);
    expect(parseArgs(["--vault", "/v"], { DATANOTES_PORT: "27180" }).port).toBe(27180);
    expect(parseArgs(["--vault", "/v", "--port", "27181"], { DATANOTES_PORT: "27180" }).port).toBe(27181);
    expect(parseArgs(["--vault", "/v"], {}).port).toBeUndefined();
    for (const bad of ["80", "65536", "x", "", "-1", "1.5"]) {
      expect(() => parsePort(bad), bad).toThrow(`--port must be a port from 1024 to 65535, or 0 for any free port: "${bad}"`);
    }
    expect(() => parseArgs(["--vault", "/v"], { DATANOTES_PORT: "99999" })).toThrow(/^DATANOTES_PORT must be a port/);
    try {
      parsePort("99999");
    } catch (e) {
      expect(e).toMatchObject({ hint: expect.stringMatching(/^Pass --port 27150 \(the default\)/), docs: "https://datanotes.dev/administration/run-the-service.md#choose-the-port" });
    }
  });
});

describe("the built command: serve on any free port, stop it, its last store backup pushed", () => {
  let bin = "";

  beforeAll(async () => {
    bin = path.join(tempDir("dn-stop-bundle-"), "datanotes.cjs");
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "..", "src", "node", "cli.ts")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outfile: bin,
      define: { SERVICE_VERSION: JSON.stringify("0.0.0-test"), SWAGGER_UI_CSS: '""', SWAGGER_UI_JS: '""' },
      external: ["swagger-ui-dist/package.json"],
      logLevel: "error",
    });
  }, 60_000);

  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const c of children) if (c.exitCode === null) c.kill();
  });

  it("serve --port 0 binds a free port and gives it in the start line, the lock and the status; stop ends it with exit 0 after the last push", async () => {
    const root = copyTestVault();
    temp.push(root);
    const remote = path.join(tempDir("dn-stop-remote-"), "store.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const child = spawn(process.execPath, [bin, "serve", "--vault", root, "--port", "0", "--watch", "poll", "--store-backup-remote", remote, "--store-backup-interval-s", "3600"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    const deadline = Date.now() + 30_000;
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(out) && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 50));
    const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1]);
    expect(port, out).toBeGreaterThan(0);
    expect(port).not.toBe(27150);

    const store = storeLocation(root)!.store;
    expect(JSON.parse(fs.readFileSync(path.join(store, "engine.lock"), "utf8"))).toMatchObject({ pid: child.pid, port });
    const status = await collectStatus({ vault: root, json: true, env: ENV });
    expect(status.report).toMatchObject({ running: true, url: `http://127.0.0.1:${port}`, engine: { http: { port } } });
    // the store backup's first commit and push (in the background at start) are over before the write
    for (let i = 0; i < 300; i++) {
      const s = (await collectStatus({ vault: root, json: true, env: ENV })).report as { store_backup?: { last_push_at?: string } };
      if (s.store_backup?.last_push_at) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // a write, so the store backup has an operation to commit at the stop
    const token = JSON.parse(fs.readFileSync(path.join(store, "settings.json"), "utf8")).httpServerToken as string;
    const ins = await fetch(`http://127.0.0.1:${port}/datanotes/operations/insert_row/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ table: "person", values: { name: "Stop Person" } }),
    });
    expect(ins.status).toBe(200);

    // spawned, not spawnSync: the engine is a child of this process, and on Linux and macOS a child
    // that exits stays a zombie (kill(pid, 0) still finds it) until this process's event loop reaps it
    const stop = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn(process.execPath, [bin, "stop", "--vault", root, "--timeout-s", "60"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      c.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
      c.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
      c.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    expect([stop.status, stop.stderr]).toEqual([0, ""]);
    expect(stop.stdout).toMatch(new RegExp(`^datanotes stop: the engine \\(pid ${child.pid}\\) stopped in [\\d.]+ s \\(http://127\\.0\\.0\\.1:${port}\\)\\n$`));
    expect(await exited).toBe(0);
    expect(out).toContain("datanotes service: stop requested, stopping");
    expect(fs.existsSync(path.join(store, "engine.lock"))).toBe(false);
    // the last commit of the store backup, pushed before the process ended
    const pushed = execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" });
    expect(pushed).toMatch(/^store backup: 1 operation, \d+ files?\n\n- insert into \S*person/);
    expect(processAlive(child.pid!)).toBe(false);
  }, 90_000);

  it("serve exits 1 saying why and what to do: a port out of range, an address not this machine's (also with --log)", () => {
    const root = copyTestVault();
    temp.push(root);
    const bad = spawnSync(process.execPath, [bin, "serve", "--vault", root, "--port", "99999"], { env: process.env, encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe('datanotes: --port must be a port from 1024 to 65535, or 0 for any free port: "99999"\nPass --port 27150 (the default), another port from 1024 to 65535, or --port 0 to let the system choose a free one; datanotes status shows the port the engine listens on.\nSee https://datanotes.dev/administration/run-the-service.md#choose-the-port\n');
    const log = path.join(tempDir("dn-stop-log-"), "serve.log");
    const elsewhere = spawnSync(process.execPath, [bin, "serve", "--vault", root, "--port", "0", "--host", "203.0.113.1", "--log", log], { env: process.env, encoding: "utf8", timeout: 60_000 });
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stderr).toMatch(/^datanotes: HTTP server did not start: 203\.0\.113\.1 is not an address of this machine \(EADDRNOTAVAIL\)\nGive --host an address of this machine/);
    expect(elsewhere.stderr).toMatch(/\nSee https:\/\/datanotes\.dev\/administration\/run-the-service\.md#choose-the-port\n$/);
    expect(fs.readFileSync(log, "utf8")).toContain("ERROR datanotes: HTTP server did not start: 203.0.113.1 is not an address of this machine");
  }, 90_000);
});
