/**
 * `datanotes serve` (src/node/service.ts) at its edges: the guard that keeps tests out of the
 * user's data folder, what the store's setup noted (a moved vault), renames a crash left half
 * done, a stop that cannot wait for a request, a port the server cannot take, git sync on a
 * vault outside any repository, a store backup with no remote and its operations' actors, the
 * repair of a hand move while git sync runs, and the Node version warning in `--log`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { storeLocation } from "../src/api/local";
import { HAND_MOVE_TIMING } from "../src/core/hand-moves";
import { IndexDb } from "../src/node/index-db";
import { main, startService, type RunningService } from "../src/node/service";
import { LockHolder } from "../src/server/engine-lock";
import { LOG_YAML, METASTORE } from "./helpers/db-vault";

const warning = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("../src/node/node-version", () => ({ nodeVersionWarning: () => warning.text }));

const TOKEN = "service-edges-owner-token-0123";
const running: RunningService[] = [];
const TIMING = { ...HAND_MOVE_TIMING };
afterEach(async () => {
  vi.restoreAllMocks();
  Object.assign(HAND_MOVE_TIMING, TIMING);
  warning.text = null;
  for (const s of running.splice(0)) await s.stop();
});

const tmp = (prefix = "svc-edges-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/** A vault with the `log` table in a folder of its own, its settings file beside it, and a data home. */
function setup() {
  const dir = tmp();
  const root = path.join(dir, "vault");
  write(root, METASTORE, LOG_YAML);
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ httpServerToken: TOKEN, fileLogEnabled: true, autoRecompute: false }));
  return { dir, root, settingsFile, env: { DATANOTES_DATA_HOME: path.join(dir, "home") } };
}

async function start(s: ReturnType<typeof setup>, o: Partial<Parameters<typeof startService>[0]> = {}): Promise<RunningService> {
  const svc = await startService({ vault: s.root, settingsFile: s.settingsFile, watch: "poll", pollMs: 200, port: 0, ...o }, s.env);
  running.push(svc);
  return svc;
}

/** Stop an engine this file started. */
async function stop(svc: RunningService): Promise<void> {
  running.splice(running.indexOf(svc), 1);
  await svc.stop();
}

/** The engine's log records (`logs/` in its store), as "<severity> <message>". */
function logged(svc: RunningService): string[] {
  const dir = path.join(svc.store.store, "logs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .map((r) => `${String(r.level)} ${String(r.msg)}`);
}

const post = (port: number, route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/datanotes/${route}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("datanotes serve: starting", () => {
  it("in tests, refuses to start without a data home or a store named", async () => {
    const saved = process.env.DATANOTES_DATA_HOME;
    const savedStore = process.env.DATANOTES_STORE;
    delete process.env.DATANOTES_DATA_HOME;
    delete process.env.DATANOTES_STORE;
    try {
      await expect(startService({ vault: tmp(), watch: "poll", pollMs: 1000, port: 0 }, {})).rejects.toThrow("set DATANOTES_DATA_HOME in tests");
    } finally {
      process.env.DATANOTES_DATA_HOME = saved;
      if (savedStore !== undefined) process.env.DATANOTES_STORE = savedStore;
    }
  });

  it("says what the store's setup found: a vault moved since the last start", async () => {
    const s = setup();
    await stop(await start(s));
    const moved = path.join(s.dir, "moved");
    fs.renameSync(s.root, moved);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    await start({ ...s, root: moved });
    expect(lines.some((l) => l.startsWith("datanotes: the vault moved from ") && l.endsWith(": the store follows it"))).toBe(true);
  });

  it("finishes the renames a crash left half done, and says which it could not", async () => {
    const s = setup();
    write(s.root, "Notes/.datanotes-rename-99-1--plan.md", "plan\n");
    const first = await start(s);
    expect(fs.readFileSync(path.join(s.root, "Notes", "plan.md"), "utf8")).toBe("plan\n");
    await stop(first);
    expect(logged(first)).toContain("INFO datanotes finished renames a crash left half done");
    write(s.root, "Notes/.datanotes-rename-99-2--plan.md", "a file has that name by now\n");
    const second = await start(s);
    await stop(second);
    expect(logged(second)).toContain("WARN datanotes finished renames a crash left half done");
  });

  it("a port the server cannot take at all: refused with what to check", async () => {
    const s = setup();
    const err = (await start(s, { port: 70_000 }).catch((e: unknown) => e)) as Error & { hint?: string };
    expect(err.message).toMatch(/^HTTP server did not start: /);
    expect(err.hint).toBe("Check --host and --port; datanotes status shows what holds the vault.");
    // the store is let go once the host is closed
    expect(fs.existsSync(path.join(storeLocation(s.root, { env: s.env })!.store, "engine.lock"))).toBe(false);
  });

  it("claims the store with a heartbeat before it reads the vault, says it is starting until it listens, and lets the store go when the start fails", async () => {
    const s = setup();
    onTestFinished(() => void vi.restoreAllMocks());
    const order: string[] = [];
    const acquire = LockHolder.prototype.acquire;
    vi.spyOn(LockHolder.prototype, "acquire").mockImplementation(function (this: LockHolder) {
      order.push("lock");
      return acquire.call(this);
    });
    const open = IndexDb.open.bind(IndexDb);
    let during: Record<string, unknown> | null = null;
    const opening = vi.spyOn(IndexDb, "open").mockImplementation((store, o) => {
      order.push("index");
      during = JSON.parse(fs.readFileSync(path.join(store, "engine.lock"), "utf8")) as Record<string, unknown>;
      return open(store, o);
    });
    const svc = await start(s);
    expect(order).toEqual(["lock", "index"]);
    expect(during).toMatchObject({ kind: "service", pid: process.pid, port: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(svc.store.store, "engine.lock"), "utf8"))).toMatchObject({ pid: process.pid, port: svc.port });
    await stop(svc);
    // a start that fails once it holds the store: its lock goes (no heartbeat keeps the process alive)
    opening.mockImplementation(() => {
      throw new Error("the disk went away");
    });
    await expect(start(s)).rejects.toThrow("the disk went away");
    expect(fs.existsSync(path.join(storeLocation(s.root, { env: s.env })!.store, "engine.lock"))).toBe(false);
  });

  it("git sync on a vault outside any repository stays off", async () => {
    const s = setup();
    const svc = await start(s, { gitSync: { intervalMs: 3_600_000, quietMs: 60_000, push: false } });
    expect(svc.git).toBeNull();
  });

  it("keeps the vault index in its store: the next start reads only what changed, and the index checks agree", async () => {
    const s = setup();
    write(s.root, "Daily/a.md", "---\ntable: log\nkind: walk\noccurred_at: 2026-09-25T08:00\n---\nA walk with [[b]].\n");
    write(s.root, "Daily/b.md", "---\ntable: log\nkind: mood\noccurred_at: 2026-09-25T09:00\n---\n");
    const past = Date.now() / 1000 - 3600; // written long ago: recorded at once, not in the racy window
    for (const f of ["Daily/a.md", "Daily/b.md", METASTORE]) fs.utimesSync(path.join(s.root, f), past, past);
    const read = (svc: RunningService) => {
      const dir = path.join(svc.store.store, "logs");
      const records = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n")).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      return records.filter((r) => r.msg === "datanotes read the vault").map(({ notes, notes_read, notes_moved, vault_index }) => ({ notes, notes_read, notes_moved, vault_index }));
    };
    const first = await start(s);
    await stop(first);
    expect(fs.existsSync(path.join(first.store.store, "index", "vault.sqlite"))).toBe(true);
    write(s.root, "Daily/b.md", "---\ntable: log\nkind: mood\noccurred_at: 2026-09-25T09:30\n---\n");
    fs.utimesSync(path.join(s.root, "Daily/b.md"), past + 60, past + 60);
    const second = await start(s);
    const { verifyIndex } = await import("../src/core/index-check");
    expect(await verifyIndex(second.runtime.app, second.settings)).toEqual([]);
    await stop(second);
    expect(read(second)).toEqual([
      { notes: 2, notes_read: 2, notes_moved: 0, vault_index: "built: none yet" },
      { notes: 2, notes_read: 1, notes_moved: 0, vault_index: "used" },
    ]);
    // turned off: every note read, the index deleted
    fs.writeFileSync(s.settingsFile, JSON.stringify({ httpServerToken: TOKEN, fileLogEnabled: true, autoRecompute: false, vaultIndexEnabled: false }));
    const third = await start(s);
    await stop(third);
    expect(read(third).at(-1)).toEqual({ notes: 2, notes_read: 2, notes_moved: 0, vault_index: "off" });
    expect(fs.existsSync(path.join(third.store.store, "index", "vault.sqlite"))).toBe(false);
  });

  it("follows the OS's reports once the notes are read, compares what changed meanwhile without blocking, and closes them when the start fails", async () => {
    const s = setup();
    const watch = vi.spyOn(fs, "watch");
    const svc = await start(s, { watch: "events" });
    expect(watch).toHaveBeenCalledTimes(1);
    await svc.watcher.flush(); // the comparison after the walk
    expect(svc.watcher.rescans).toBe(1);
    // a comparison asked for (the OS's buffer overflowed) runs at once while the engine does not write
    const os = (svc.watcher as unknown as { watcher: fs.FSWatcher }).watcher;
    write(s.root, "Daily/new.md", "---\ntable: log\n---\n");
    os.emit("error", new Error("overflow"));
    svc.watcher.flush();
    expect(svc.watcher.rescans).toBe(2);
    await stop(svc);
    // a start that fails after its walk (a port setting no engine takes) follows nothing
    fs.writeFileSync(s.settingsFile, JSON.stringify({ httpServerToken: TOKEN, httpServerPort: 1 }));
    watch.mockClear();
    await expect(start(s, { watch: "events", port: undefined })).rejects.toThrow("invalid setting httpServerPort");
    expect(watch).not.toHaveBeenCalled();
  });
});

describe("datanotes serve: running and stopping", () => {
  it("a stop that cannot wait for a request under way says so", async () => {
    const s = setup();
    const svc = await start(s, { drainMs: 50 });
    // a request whose body never comes: under way until the stop drops the connection
    const socket = net.connect(svc.port, "127.0.0.1");
    socket.on("error", () => undefined);
    await new Promise((r) => socket.once("connect", r));
    socket.write(`POST /datanotes/operations/list_tables/ HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    await new Promise((r) => setTimeout(r, 200));
    await stop(svc);
    socket.destroy();
    expect(logged(svc)).toContain("WARN datanotes stopped before every request under way was answered");
  });

  it("a store backup turned on without a remote commits only, and names who made each operation", async () => {
    const s = setup();
    const svc = await start(s, { storeBackup: { enabled: true, stopTimeoutMs: 5_000 } });
    expect(svc.backup?.status.remote).toBeNull();
    const r = await post(svc.port, "operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-09-26T08:00" } }, { "X-Datanotes-Actor": JSON.stringify({ harness: "claude-code" }) });
    expect(r.status).toBe(200);
    await stop(svc);
    expect(git(svc.store.store, "log", "--format=%B")).toContain("(claude-code)");
  });

  it("with git sync on, a note moved by hand is repaired once git is not busy", async () => {
    HAND_MOVE_TIMING.quietMs = 100;
    HAND_MOVE_TIMING.retryMs = 100;
    const s = setup();
    write(s.root, "Notes/a.md", "A plan for the quarter, long enough to be known by its text.\n");
    write(s.root, "Notes/b.md", "see [[a]]\n");
    git(s.root, "init", "-q", "-b", "main");
    for (const [k, v] of [["core.autocrlf", "false"], ["user.name", "Test"], ["user.email", "test@example.com"]] as const) git(s.root, "config", k, v);
    git(s.root, "add", "-A");
    git(s.root, "commit", "-q", "-m", "init");
    const svc = await start(s, { gitSync: { intervalMs: 3_600_000, quietMs: 3_600_000, push: false } });
    expect(svc.git).not.toBeNull();
    fs.renameSync(path.join(s.root, "Notes", "a.md"), path.join(s.root, "Notes", "c.md"));
    await until(() => fs.readFileSync(path.join(s.root, "Notes", "b.md"), "utf8") !== "see [[a]]\n");
    expect(fs.readFileSync(path.join(s.root, "Notes", "b.md"), "utf8")).toBe("see [[c]]\n");
  }, 30_000);
});

describe("datanotes serve: the entry point", () => {
  it("writes the Node version warning to --log as an error, and takes --store", async () => {
    warning.text = "datanotes: WARNING this Node version can crash";
    const s = setup();
    const store = path.join(s.dir, "store");
    const logFile = path.join(s.dir, "logs", "service.log");
    const signals = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;
    const before = new Map(signals.map((sig) => [sig, process.listeners(sig)]));
    const { log, error } = console;
    const saved = Object.entries(process.env).filter(([k]) => k.startsWith("DATANOTES_") && k !== "DATANOTES_DATA_HOME");
    for (const [k] of saved) delete process.env[k];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await main(["--vault", s.root, "--settings", s.settingsFile, "--store", store, "--port", "0", "--watch", "poll", "--log", logFile]);
      const text = () => fs.readFileSync(logFile, "utf8");
      expect(text()).toMatch(/^\S+ ERROR datanotes: WARNING this Node version can crash\n/);
      expect(text()).toContain(`store ${store}\n`);
      process.listeners("SIGTERM").find((l) => !before.get("SIGTERM")!.includes(l))!("SIGTERM");
      await until(() => exit.mock.calls.length > 0);
    } finally {
      console.log = log;
      console.error = error;
      for (const sig of signals) for (const l of process.listeners(sig)) if (!before.get(sig)!.includes(l)) process.removeListener(sig, l);
      for (const [k, v] of saved) process.env[k] = v;
    }
  });
});
