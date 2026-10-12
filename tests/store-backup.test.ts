/**
 * The store backup (src/node/store-backup.ts) and its commands (src/node/store-command.ts): the
 * store as a git repository pushed to a remote (a local bare repository here, in temp folders),
 * what it tracks and never tracks (no secret in any commit), commits on a schedule between two
 * operations (the engine's write lock held for git add and commit only), pushes after them and at
 * stop, a restart after a forced stop catching up, a failing push retried with backoff without failing an
 * operation, the status, and a restore into a fresh data home where undo, history and time travel
 * work.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRegistry, vaultKey } from "../src/api/local";
import { metastoreId } from "../src/core/database-id";
import { gitSubcommand, KILLED_CODE, runGit, type GitRunner } from "../src/node/git-sync";
import { startService, type RunningService } from "../src/node/service";
import type { App } from "../src/core/host";
import { mergeWithDefaults, type DatanotesSettings } from "../src/core/settings";
import { logLockActivity, withLogLock } from "../src/core/transaction-log";
import { parseEvery, prepareStoreRepo, redactRemote, STOP_TIMEOUT_MS, STORE_GITATTRIBUTES, STORE_GITIGNORE, StoreBackup, type BackupEngine } from "../src/node/store-backup";
import { FIRST_BACKUP_LOCAL_TIMEOUT_MS, main as storeCommand } from "../src/node/store-command";
import { StoreSetupError } from "../src/node/store-setup";
import { described } from "./helpers/descriptions";

const ID = "01a1b2c3-0000-7000-8000-000000000001";
const OWNER = "owner-token-that-must-never-be-committed";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
function bare(): string {
  const dir = path.join(tmp("store-backup-remote-"), "store.git");
  git(path.dirname(dir), "init", "-q", "--bare", dir);
  return dir;
}
/** Every file of every commit of a repository. */
const everyFile = (repo: string) => [...new Set(git(repo, "log", "--all", "--name-only", "--format=").split("\n").filter(Boolean))].sort();
/** Whether a text appears in any version of any file of a repository. */
function inHistory(repo: string, text: string): boolean {
  const revs = git(repo, "rev-list", "--all").split("\n").filter(Boolean);
  try {
    execFileSync("git", ["grep", "-q", "-F", text, ...revs], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("what the store backup tracks", { timeout: 30_000 }, () => {
  it("only journal, blobs, transaction logs, the change feed, moves and token hashes: never the settings, webhooks or this machine's state", async () => {
    const store = tmp("store-backup-");
    const remote = bare();
    const files: Record<string, string> = {
      "settings.json": JSON.stringify({ httpServerToken: OWNER }),
      "webhooks.json": JSON.stringify([{ id: "wh_1", secret: "webhook-secret" }]),
      "engine.lock": "{}",
      "store.json": "{}",
      "migration.json": "{}",
      "vaults.json": "{}",
      "semantic/shard-00.json": "{}",
      "logs/2026-10-10.service.jsonl": "{}\n",
      "ext/program/state.json": "{}",
      "tokens.json.123.tmp": "{}",
      "journal/2026-10.jsonl": "{}\n",
      "journal/2026-10.jsonl.migrating": "{}\n",
      "blobs/abc.txt": "text\r\nwith CRLF\r\n",
      "transaction_log/main.public.log/00000000000000000000.json": "{}\n",
      "changes/2026-10-10.jsonl": "{}\n",
      "database_moves.jsonl": "{}\n",
      "tokens.json": JSON.stringify([{ name: "bot", tokenHash: "ab".repeat(32) }]),
    };
    for (const [rel, text] of Object.entries(files)) write(store, rel, text);
    const b = new StoreBackup({ store, databaseId: ID, remote, every: 3_600_000 });
    expect(await b.start()).toBe(true);
    await b.idle();
    await b.stop();
    expect(fs.readFileSync(path.join(store, ".gitignore"), "utf8")).toBe(STORE_GITIGNORE);
    expect(fs.readFileSync(path.join(store, ".gitattributes"), "utf8")).toBe(STORE_GITATTRIBUTES);
    expect(everyFile(remote)).toEqual([
      ".gitattributes",
      ".gitignore",
      "blobs/abc.txt",
      "changes/2026-10-10.jsonl",
      "database_moves.jsonl",
      "journal/2026-10.jsonl",
      "tokens.json",
      "transaction_log/main.public.log/00000000000000000000.json",
    ]);
    expect(inHistory(remote, OWNER)).toBe(false);
    expect(inHistory(remote, "webhook-secret")).toBe(false);
    // byte for byte, whatever core.autocrlf says
    expect(execFileSync("git", ["cat-file", "blob", "main:blobs/abc.txt"], { cwd: remote, encoding: "utf8" })).toBe("text\r\nwith CRLF\r\n");
    expect(git(remote, "log", "-1", "--format=%B", "main")).toMatch(/^store backup: 8 files changed\n\nChanges outside operations: hand edits, the change feed, tokens\.\n\nDatabase-Id: 01a1b2c3-0000-7000-8000-000000000001\nBacked-up-by: datanotes$/);
    expect(b.status).toMatchObject({ enabled: false, remote, pendingOperations: 0, pendingCommits: 0 });
    expect(b.status.lastPush).toBeDefined();
    expect(b.status.lastError).toBeUndefined();
  });

  it("prepares a repository once: an identity when git has none, the remote set, changed or kept", async () => {
    const store = tmp("store-backup-prep-");
    await prepareStoreRepo(store, "https://example.com/a.git");
    expect(git(store, "remote", "get-url", "origin")).toBe("https://example.com/a.git");
    expect(git(store, "config", "core.autocrlf")).toBe("false");
    expect(git(store, "config", "core.longpaths")).toBe("true"); // Git for Windows: paths over 260 characters
    expect(git(store, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    await prepareStoreRepo(store, "https://example.com/b.git");
    expect(git(store, "remote", "get-url", "origin")).toBe("https://example.com/b.git");
    await prepareStoreRepo(store, null);
    expect(git(store, "remote", "get-url", "origin")).toBe("https://example.com/b.git");
    // a store that is not a repository and a git that fails: the error says what git said
    const failing: GitRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: https://me:pw@host/x.git denied" });
    await expect(prepareStoreRepo(tmp("store-backup-prep-"), "u", failing)).rejects.toThrow("git init: fatal: https://host/x.git denied");
    // set-url and add that fail
    const noRemote: GitRunner = async (args) => (args[0] === "remote" ? { code: args[1] === "get-url" ? (args[2] === "origin" ? 2 : 0) : 1, stdout: "", stderr: "no" } : { code: 0, stdout: "", stderr: "" });
    await expect(prepareStoreRepo(store, "u", noRemote)).rejects.toThrow("git remote add: no");
    const otherRemote: GitRunner = async (args) => (args[0] === "remote" ? (args[1] === "get-url" ? { code: 0, stdout: "x\n", stderr: "" } : { code: 1, stdout: "", stderr: "bad" }) : { code: 0, stdout: "", stderr: "" });
    await expect(prepareStoreRepo(store, "u", otherRemote)).rejects.toThrow("git remote set-url: bad");
  });

  it("shows a remote without its credentials", () => {
    expect(redactRemote("https://me:ghp_secret@github.com/me/store.git")).toBe("https://github.com/me/store.git");
    expect(redactRemote("https://github.com/me/store.git")).toBe("https://github.com/me/store.git");
    expect(redactRemote("git@github.com:me/store.git")).toBe("git@github.com:me/store.git");
  });
});

/**
 * A git that only pretends: the store's files change when `touch` says so; pushes fail as told;
 * `holdCommit` keeps the next `git commit` running until its release is called.
 */
function fakeGit(pushCodes: number[] = []) {
  const calls: string[][] = [];
  let dirty = false;
  let staged = false;
  let commits = 0;
  let pushed = 0;
  let hold: Promise<void> | null = null;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run: GitRunner = async (given) => {
    // without the global options (-c gc.auto=0): the command as the backup means it
    const args = given.slice(Math.max(0, given.indexOf(gitSubcommand(given))));
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "config" && args.length === 2) return ok("me@example.com\n");
    if (cmd === "remote" && sub === "get-url") return ok("https://me:secret@example.com/store.git\n");
    if (cmd === "status") return ok(dirty ? " M journal/2026-10.jsonl\n" : "");
    if (cmd === "add") {
      staged = dirty;
      return ok();
    }
    if (cmd === "diff") return ok(staged ? "journal/2026-10.jsonl\n" : "");
    if (cmd === "commit") {
      if (hold) await hold;
      dirty = staged = false;
      commits++;
      return ok();
    }
    if (cmd === "rev-parse" && args.includes("--short")) return ok(`c${commits}\n`);
    if (cmd === "rev-parse") return commits ? ok("x\n") : { code: 1, stdout: "", stderr: "" };
    if (cmd === "rev-list") return ok(`${commits - pushed}\n`);
    if (cmd === "push") {
      const code = pushCodes.shift() ?? 0;
      if (code === 0) pushed = commits;
      return { code, stdout: "", stderr: code ? "fatal: unable to access 'https://me:secret@example.com/store.git/': The requested URL returned error: 403" : "" };
    }
    return ok();
  };
  return {
    run,
    calls,
    touch: () => void (dirty = true),
    holdCommit: () => {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
    commitMessages: () => calls.filter((c) => c[0] === "commit").map((c) => c[c.indexOf("-m") + 1]!),
    adds: () => calls.filter((c) => c[0] === "add").length,
    pushes: () => calls.filter((c) => c[0] === "push").length,
  };
}

/** An engine as the backup sees it: the real write lock (`withLogLock`) on an app of its own. */
function fakeEngine() {
  const app = {} as App;
  const engine: BackupEngine = { activity: () => logLockActivity(app), exclusive: (fn) => withLogLock(app, fn) };
  return {
    engine,
    /** An operation that writes the store and is noted, as the engine runs one. */
    operation: (b: StoreBackup, g: ReturnType<typeof fakeGit>, summary: string) =>
      withLogLock(app, async () => {
        g.touch();
        b.noteOperation({ summary });
      }),
    /** An operation that runs until its release is called. */
    hold: (b: StoreBackup, g: ReturnType<typeof fakeGit>, summary: string) => {
      let release!: () => void;
      const done = withLogLock(app, async () => {
        g.touch();
        await new Promise<void>((r) => (release = r));
        b.noteOperation({ summary });
      });
      return { done, release: () => release() };
    },
  };
}

describe("when the store backup commits and pushes", () => {
  it("by default, every 60 s, between two operations: one commit of whatever changed, then a push; nothing changed, no commit", async () => {
    vi.useFakeTimers();
    const g = fakeGit();
    const e = fakeEngine();
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: g.run, engine: e.engine });
    expect(await b.start()).toBe(true);
    await b.idle();
    expect(b.status.every).toBe(60);
    expect(g.commitMessages()).toEqual([]); // nothing to commit at start
    const adds = g.adds();
    // a tick with nothing changed: no git add, no commit, no push
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.adds()).toBe(adds);
    for (const op of ["insert a", "insert b"]) {
      await e.operation(b, g, op);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await vi.advanceTimersByTimeAsync(39_999);
    expect(g.commitMessages()).toEqual([]);
    expect(b.status.pendingOperations).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.commitMessages()).toEqual([`store backup: 2 operations, 1 file\n\n- insert a\n- insert b\n\nDatabase-Id: ${ID}\nBacked-up-by: datanotes`]);
    expect(g.pushes()).toBe(1);
    expect(b.status).toMatchObject({ pendingOperations: 0, pendingCommits: 0, lastCommit: "c1" });
    expect(b.lastLockMs).toBeGreaterThanOrEqual(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.commitMessages()).toHaveLength(1);
    expect(g.pushes()).toBe(1);
    // a hand edit (no operation) is committed at the next tick
    g.touch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.commitMessages()[1]).toMatch(/^store backup: 1 file changed\n\nChanges outside operations/);
    expect(g.pushes()).toBe(2);
    await b.stop();
  });

  it("every N seconds, as set", async () => {
    vi.useFakeTimers();
    const g = fakeGit();
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: g.run, every: 10_000, engine: fakeEngine().engine });
    await b.start();
    await b.idle();
    expect(b.status.every).toBe(10);
    g.touch();
    b.noteOperation({ summary: "insert", actor: "claude-code" });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(g.commitMessages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.commitMessages()).toEqual([`store backup: 1 operation, 1 file\n\n- insert (claude-code)\n\nDatabase-Id: ${ID}\nBacked-up-by: datanotes`]);
    expect(g.pushes()).toBe(1);
    await b.stop();
  });

  it("waits while an operation runs, and commits once the engine has been quiet for 3 s, with the operation in it", async () => {
    vi.useFakeTimers();
    const g = fakeGit();
    const e = fakeEngine();
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: g.run, every: 10_000, engine: e.engine });
    await b.start();
    await b.idle();
    await vi.advanceTimersByTimeAsync(5_000);
    const op = e.hold(b, g, "a long import"); // t=5000: running, its files half written
    await vi.advanceTimersByTimeAsync(6_000); // t=11000: the tick found changes, the engine busy
    expect(g.adds()).toBe(2); // the two at start: outside the lock, then under it
    expect(g.commitMessages()).toEqual([]);
    op.release();
    await op.done;
    await vi.advanceTimersByTimeAsync(2_900); // t=13900: quiet for 2.9 s only
    expect(g.commitMessages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); // t=14100: quiet for 3 s, then the commit
    expect(g.commitMessages()).toEqual([`store backup: 1 operation, 1 file\n\n- a long import\n\nDatabase-Id: ${ID}\nBacked-up-by: datanotes`]);
    expect(g.pushes()).toBe(1);
    await b.stop();
  });

  it("an operation that starts during a commit waits for it", async () => {
    vi.useFakeTimers();
    const g = fakeGit();
    const e = fakeEngine();
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: g.run, every: 10_000, engine: e.engine });
    await b.start();
    await b.idle();
    await e.operation(b, g, "insert a");
    const release = g.holdCommit();
    await vi.advanceTimersByTimeAsync(10_000); // the tick: git commit runs, holding the lock
    expect(g.commitMessages()).toHaveLength(1);
    let ran = false;
    const next = e.operation(b, g, "insert b").then(() => (ran = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ran).toBe(false);
    expect(e.engine.activity().busy).toBe(true);
    release();
    await next;
    expect(ran).toBe(true);
    // the commit holds only the first operation; the second waits for the next tick
    expect(g.commitMessages()[0]).toContain("- insert a\n");
    expect(b.status.pendingOperations).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.commitMessages()[1]).toContain("- insert b\n");
    await b.stop();
  });

  it("an engine busy for 5 ticks in a row: the 6th commits at the first gap between two operations", async () => {
    vi.useFakeTimers();
    const g = fakeGit();
    const e = fakeEngine();
    const logs: string[] = [];
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: g.run, every: 10_000, engine: e.engine, log: (_l, m) => logs.push(m) });
    await b.start();
    await b.idle();
    // an operation of 600 ms every second (from t=1500 to 2100, 2500 to 3100…): never 3 s of quiet
    await vi.advanceTimersByTimeAsync(500);
    let n = 0;
    const busy = setInterval(() => {
      const op = e.hold(b, g, `op ${n++}`);
      setTimeout(op.release, 600);
    }, 1_000);
    await vi.advanceTimersByTimeAsync(59_499); // t=59999
    expect(g.commitMessages()).toEqual([]);
    expect(logs.filter((m) => m === "datanotes store backup waits: the engine is busy")).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(51); // t=60050: the 6th tick waits for the operation running since 59500
    expect(g.commitMessages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100); // t=60150: that operation ended at 60100, the commit took the gap
    expect(g.commitMessages()).toHaveLength(1);
    expect(g.commitMessages()[0]).toMatch(/^store backup: 59 operations, 1 file\n/);
    clearInterval(busy);
    await vi.advanceTimersByTimeAsync(1_000);
    await b.stop();
  });

  it("lists at most 50 operations in a message, and forgets operations that changed no file", async () => {
    vi.useFakeTimers();
    const g = fakeGit();
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: g.run, every: 10_000, engine: fakeEngine().engine });
    await b.start();
    await b.idle();
    g.touch();
    for (let i = 0; i < 52; i++) b.noteOperation({ summary: `op ${i}` });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.commitMessages()[0]).toContain("- op 49\n- … and 2 more\n");
    b.noteOperation({ summary: "a dry run: no file changed" });
    expect(b.status.pendingOperations).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.commitMessages()).toHaveLength(1);
    expect(b.status.pendingOperations).toBe(0);
    await b.stop();
  });

  it("a failing push is retried with backoff (doubled, capped) and reported without credentials", async () => {
    vi.useFakeTimers();
    const g = fakeGit([1, 1, 1]);
    const logs: string[] = [];
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: g.run, every: 1000, maxBackoffMs: 3000, log: (_l, m) => logs.push(m) });
    await b.start();
    await b.idle();
    g.touch();
    b.noteOperation({ summary: "insert" });
    await vi.advanceTimersByTimeAsync(1000); // t=1000: push 1 fails, retry at 2000
    expect(g.pushes()).toBe(1);
    expect(b.status.lastError).toBe("git push: fatal: unable to access 'https://example.com/store.git/': The requested URL returned error: 403");
    expect(b.status.nextRetry).toBe(new Date(Date.now() + 1000).toISOString());
    await vi.advanceTimersByTimeAsync(1000); // t=2000: push 2 fails, retry at 4000
    expect(g.pushes()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); // t=3000: waits
    expect(g.pushes()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); // t=4000: push 3 fails, retry at 7000 (capped at 3000)
    expect(g.pushes()).toBe(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(g.pushes()).toBe(3);
    await vi.advanceTimersByTimeAsync(1000); // t=7000: push 4 succeeds
    expect(g.pushes()).toBe(4);
    expect(b.status.lastError).toBeUndefined();
    expect(b.status.nextRetry).toBeUndefined();
    expect(b.status.lastPush).toBeDefined();
    expect(logs).toContain("datanotes store backup could not push (retried with backoff)");
    await vi.advanceTimersByTimeAsync(1000); // nothing new: no push
    expect(g.pushes()).toBe(4);
    await b.stop();
  });

  it("stop pushes even while a failing push waits, and ends a wait for an idle engine; a git that fails keeps the operations for the next commit", async () => {
    vi.useFakeTimers();
    const g = fakeGit([1]);
    const e = fakeEngine();
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: g.run, every: 10_000, engine: e.engine });
    await b.start();
    await b.idle();
    await e.operation(b, g, "insert");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.status.lastError).toMatch(/^git push/);
    // a tick waits for a running operation; stop ends the wait, the operation ends, the last commit follows
    g.touch();
    const op = e.hold(b, g, "update");
    await vi.advanceTimersByTimeAsync(10_000);
    const stopped = b.stop();
    await vi.advanceTimersByTimeAsync(10);
    op.release();
    await stopped;
    await b.tick(); // stopped: a tick does nothing
    expect(g.commitMessages()).toHaveLength(2);
    expect(g.commitMessages()[1]).toContain("- update\n");
    expect(g.pushes()).toBe(2);
    expect(b.status.lastError).toBeUndefined();

    // git add fails: the error is reported, the operation stays pending, nothing throws
    const broken: GitRunner = async (args) => (gitSubcommand(args) === "add" ? { code: 1, stdout: "", stderr: "index.lock exists" } : g.run(args, ""));
    const c = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: broken, every: 10_000 });
    expect(await c.start()).toBe(true);
    await c.idle();
    expect(c.status.lastError).toBe("git add: index.lock exists");
    g.touch();
    c.noteOperation({ summary: "insert" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.status.pendingOperations).toBe(1);
    await c.stop();
  });

  it("does not start when git cannot prepare the store, and an operation noted then waits", async () => {
    const failing: GitRunner = async () => ({ code: 127, stdout: "", stderr: "git: not found" });
    const b = new StoreBackup({ store: tmp("store-backup-fake-"), databaseId: ID, run: failing });
    expect(await b.start()).toBe(false);
    await b.idle();
    expect(b.status).toMatchObject({ enabled: false, lastError: "git init: git: not found" });
    b.noteOperation({ summary: "insert" });
    expect(b.status.pendingOperations).toBe(1);
    await b.tick(); // not started: nothing
    await b.stop();
  });

  it("takes whole seconds of at least 10; a saved setting below that, or the old \"operation\", falls back to 60", () => {
    expect(parseEvery(10)).toBe(10);
    expect(parseEvery(" 90 ")).toBe(90);
    for (const bad of [9, 0, "operation", "1.5", 30.5, null]) expect(parseEvery(bad)).toBeNull();
    expect(mergeWithDefaults({ storeBackupIntervalSeconds: "operation" } as unknown as Partial<DatanotesSettings>).storeBackupIntervalSeconds).toBe(60);
    expect(mergeWithDefaults({ storeBackupIntervalSeconds: 5 }).storeBackupIntervalSeconds).toBe(60);
    expect(mergeWithDefaults({ storeBackupIntervalSeconds: 10 }).storeBackupIntervalSeconds).toBe(10);
    // the lock of an app no operation ever used: idle
    expect(logLockActivity({} as App)).toEqual({ busy: false, lastEnd: 0 });
  });

  it("commits only, without a remote", async () => {
    const store = tmp("store-backup-local-");
    write(store, "journal/2026-10.jsonl", "{}\n");
    const b = new StoreBackup({ store, databaseId: ID, every: 3_600_000 });
    expect(await b.start()).toBe(true);
    await b.idle();
    await b.stop();
    expect(b.status).toMatchObject({ remote: null, pendingCommits: 0 });
    expect(b.status.lastCommit).toBeDefined();
    expect(b.status.lastPush).toBeUndefined();
    // a file the engine deletes (vacuum_table) is a deletion in the next commit; the history keeps it
    fs.rmSync(path.join(store, "journal", "2026-10.jsonl"));
    const c = new StoreBackup({ store, databaseId: ID, every: 3_600_000 });
    await c.start();
    await c.idle();
    await c.stop();
    expect(git(store, "show", "--name-status", "--format=", "HEAD")).toBe("D\tjournal/2026-10.jsonl");
    expect(git(store, "show", "HEAD~1:journal/2026-10.jsonl")).toBe("{}");
  }, 30_000);
});

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

async function until(ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The table the tests write: one string column, its rows named after it. */
async function createNote(post: ReturnType<typeof caller>): Promise<void> {
  const r = await post("operations/create_table/", described({ name: "note", columns: [{ name: "title", type: "string" }], filename: "{title}" }));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

function caller(port: number, token: string) {
  return async (route: string, body: unknown = {}): Promise<{ status: number; json: Record<string, any> }> => {
    const r = await fetch(`http://127.0.0.1:${port}/datanotes/${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
}

describe("the engine backs up its store, and a restore brings undo, history and time travel back", () => {
  const running: RunningService[] = [];
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
  });

  it("commits after operations, pushes at stop, never commits the owner token; restored into a fresh data home, everything works", async () => {
    // the original machine: a store named with --store, its settings written before the first start
    const vault = tmp("store-backup-vault-");
    const store = tmp("store-backup-store-");
    const remote = bare();
    const port = await freePort();
    write(store, "settings.json", JSON.stringify({ httpServerPort: port, httpServerToken: OWNER, fileLogEnabled: true, autoRecompute: false }));
    const svc = await startService({ vault, watch: "poll", pollMs: 100, store, storeBackup: { remote, every: 3_600_000, quietMs: 100 } }, {});
    running.push(svc);
    const post = caller(port, OWNER);
    await createNote(post);
    expect((await post("operations/configure_database/", { history: true })).status).toBe(200);
    const first = await post("operations/insert_row/", { table: "note", values: { title: "first" } });
    expect(first.status).toBe(200);
    const firstPath = (first.json.planned_creates as string[])[0]!;
    expect((await post("operations/insert_row/", { table: "note", values: { title: "second" } })).status).toBe(200);
    const created = await post("tokens/create/", { name: "phone", write: ["main.public.note"] });
    expect(created.status).toBe(200);
    // a tick: the store changed, the engine idle for 100 ms, a commit between two operations
    await svc.backup!.tick();
    expect(svc.backup!.status.pendingOperations).toBe(0);
    expect(svc.backup!.lastLockMs).toBeGreaterThan(0);
    const status = (await post("status/")).json;
    expect(status.store_backup).toMatchObject({ enabled: true, interval_s: 3600, remote, pending_operations: 0 });
    expect(status.store_backup.last_commit).toMatch(/^[0-9a-f]{7,}$/);
    await until(() => svc.backup!.status.lastPush !== undefined);
    expect(status.healthy).toBe(true);
    const local = git(store, "log", "--format=%s");
    expect(local).toMatch(/store backup: \d+ operations?/);
    expect(git(store, "log", "--format=%B")).toContain("- insert into note");

    await svc.stop();
    running.pop();
    // pushed at stop: the remote has the journal, the history, the token hashes; never a secret
    expect(git(remote, "rev-parse", "main")).toBe(git(store, "rev-parse", "HEAD"));
    const tracked = everyFile(remote);
    expect(tracked).toContain("tokens.json");
    expect(tracked.some((f) => f.startsWith("journal/"))).toBe(true);
    expect(tracked.some((f) => f.startsWith("transaction_log/"))).toBe(true);
    expect(tracked.some((f) => f.startsWith("changes/"))).toBe(true);
    expect(tracked.filter((f) => /service\.json|webhooks\.json|engine\.lock|store\.json|^logs\/|^semantic\//.test(f))).toEqual([]);
    expect(inHistory(remote, OWNER)).toBe(false);
    expect(inHistory(remote, created.json.token as string)).toBe(false);

    // another machine: the vault from its own git (a copy here), the store from its backup
    const vault2 = tmp("store-backup-vault2-");
    fs.cpSync(vault, vault2, { recursive: true });
    const home2 = tmp("store-backup-home2-");
    const env = { DATANOTES_DATA_HOME: home2 };
    const port2 = await freePort();
    let out = "";
    expect(await storeCommand(["restore", "--from", remote, "--vault", vault2, "--port", String(port2)], { env, write: (t) => (out += t) })).toBe(0);
    const id = metastoreId(fs.readFileSync(path.join(vault2, "datanotes", "metastore.yaml"), "utf8"))!;
    const store2 = path.join(home2, id);
    const settings2 = JSON.parse(fs.readFileSync(path.join(store2, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings2).toMatchObject({ httpServerPort: port2, storeBackupEnabled: true, storeBackupRemote: remote });
    expect(settings2.httpServerToken).toMatch(/^[0-9a-f]{48}$/);
    expect(out).toContain(`owner token  ${settings2.httpServerToken as string}\n`);
    expect(out).toContain(`store        ${store2}\n`);
    expect(out).toContain("1 named token restored. Webhooks are not backed up");
    expect(fs.existsSync(path.join(store2, "logs"))).toBe(true);
    expect(git(store2, "config", "core.longpaths")).toBe("true"); // Git for Windows: paths over 260 characters
    expect(readRegistry(home2)[vaultKey(vault2)]).toEqual({ id: metastoreId(fs.readFileSync(path.join(vault2, "datanotes", "metastore.yaml"), "utf8")), database: "datanotes" });

    const svc2 = await startService({ vault: vault2, watch: "poll", pollMs: 100 }, env);
    running.push(svc2);
    expect(svc2.store.store).toBe(store2);
    expect(svc2.backup?.status).toMatchObject({ enabled: true, every: 60 });
    const post2 = caller(port2, settings2.httpServerToken as string);
    // describe_history: the versions written on the first machine
    const history = (await post2("operations/describe_history/", { table: "note" })).json.history as { version: number; operation: string }[];
    expect(history.map((h) => h.operation)).toEqual(expect.arrayContaining(["WRITE"]));
    const versions = history.map((h) => h.version);
    // time travel: the table as it was before the second insert
    const before = (await post2("operations/select_rows/", { table: "note", version: Math.max(...versions) - 1 })).json.rows as { title: string }[];
    expect(before.map((r) => r.title)).toEqual(["first"]);
    expect(((await post2("operations/select_rows/", { table: "note" })).json.rows as unknown[]).length).toBe(2);
    // undo of an operation journaled on the first machine
    const list = (await post2("operations/list_migrations/", { op: "insert_row" })).json.migrations as { migration_id: string; summary: string }[];
    const oldest = list[list.length - 1]!;
    expect((await post2("operations/undo_migration/", { migration_id: oldest.migration_id })).status).toBe(200);
    expect(fs.existsSync(path.join(vault2, firstPath))).toBe(false);
    // the named token's hash came back: listed with its permissions
    expect(((await post2("tokens/")).json.tokens as { name: string }[]).map((t) => t.name)).toEqual(["phone"]);
    // the restored engine goes on backing up to the same remote
    await svc2.stop();
    running.pop();
    expect(git(remote, "log", "-1", "--format=%B", "main")).toContain(`Database-Id: ${id}`);
  }, 120_000);

  it("a push that fails never fails an operation: the status says why, and the next push after the remote is back succeeds", async () => {
    const vault = tmp("store-backup-vault-");
    const store = tmp("store-backup-store-");
    const missing = path.join(tmp("store-backup-gone-"), "later.git");
    const port = await freePort();
    write(store, "settings.json", JSON.stringify({ httpServerPort: port, httpServerToken: OWNER, storeBackupEnabled: true, storeBackupRemote: missing, storeBackupIntervalSeconds: 3600 }));
    const svc = await startService({ vault, watch: "poll", pollMs: 100, store, storeBackup: { quietMs: 50 } }, {});
    running.push(svc);
    const post = caller(port, OWNER);
    await createNote(post);
    expect((await post("operations/insert_row/", { table: "note", values: { title: "a" } })).status).toBe(200);
    await svc.backup!.tick();
    expect(svc.backup!.status).toMatchObject({ every: 3600, pendingOperations: 0 });
    await svc.backup!.push(true);
    const status = (await post("status/")).json;
    expect(status.healthy).toBe(false);
    expect(status.store_backup.last_error).toMatch(/^git push: /);
    expect(status.store_backup.next_retry_at).toBeDefined();
    expect(status.problems).toContainEqual(expect.stringMatching(/^store backup failing: git push: /));
    expect((await post("operations/insert_row/", { table: "note", values: { title: "b" } })).status).toBe(200);

    git(path.dirname(missing), "init", "-q", "--bare", missing);
    await svc.backup!.sync();
    expect(svc.backup!.status.lastError).toBeUndefined();
    expect((await post("status/")).json.store_backup.last_error).toBeUndefined();
    expect(git(missing, "rev-parse", "main")).toBe(git(store, "rev-parse", "HEAD"));
  }, 60_000);

  it("after a forced stop, the next start commits and pushes what the last run left at once", async () => {
    const vault = tmp("store-backup-vault-");
    const store = tmp("store-backup-store-");
    const remote = bare();
    const port = await freePort();
    write(store, "settings.json", JSON.stringify({ httpServerPort: port, httpServerToken: OWNER, storeBackupEnabled: true, storeBackupRemote: remote }));
    const svc = await startService({ vault, watch: "poll", pollMs: 100, store }, {});
    running.push(svc);
    expect(svc.backup!.status.every).toBe(60);
    await svc.backup!.idle();
    const post = caller(port, OWNER);
    await createNote(post);
    expect((await post("operations/insert_row/", { table: "note", values: { title: "before the kill" } })).status).toBe(200);
    // a kill: no last commit (the stop of the backup never runs)
    svc.backup!.stop = async () => undefined;
    await svc.stop();
    running.pop();
    expect(git(store, "status", "--porcelain")).not.toBe("");
    const pushedBefore = git(remote, "rev-parse", "main");

    const again = await startService({ vault, watch: "poll", pollMs: 100, store }, {});
    running.push(again);
    await again.backup!.idle();
    expect(git(store, "status", "--porcelain")).toBe("");
    expect(git(remote, "rev-parse", "main")).not.toBe(pushedBefore);
    expect(git(remote, "rev-parse", "main")).toBe(git(store, "rev-parse", "HEAD"));
    expect(git(remote, "log", "-1", "--format=%B", "main")).toMatch(/^store backup: \d+ files changed/);
    expect(again.backup!.status).toMatchObject({ pendingCommits: 0, pendingOperations: 0 });
  }, 60_000);

  it("is off unless the settings or a flag turn it on; a flag turns it off for a run", async () => {
    const vault = tmp("store-backup-vault-");
    const store = tmp("store-backup-store-");
    const port = await freePort();
    write(store, "settings.json", JSON.stringify({ httpServerPort: port, httpServerToken: OWNER, storeBackupEnabled: true }));
    const svc = await startService({ vault, watch: "poll", pollMs: 100, store, storeBackup: { enabled: false } }, {});
    running.push(svc);
    expect(svc.backup).toBeNull();
    expect((await caller(port, OWNER)("status/")).json.store_backup).toBeNull();
    expect(fs.existsSync(path.join(store, ".git"))).toBe(false);
  }, 60_000);
});

describe("datanotes store backup", { timeout: 60_000 }, () => {
  /** A vault and its store, as the engine leaves them after a first start. */
  function stored() {
    const home = tmp("store-backup-home-");
    const vault = tmp("store-backup-vault-");
    write(vault, "datanotes/metastore.yaml", `id: ${ID}\ncatalogs: {}\n`);
    const store = path.join(home, ID);
    write(store, "settings.json", JSON.stringify({ httpServerPort: 1234, httpServerToken: OWNER }));
    write(store, "journal/2026-10.jsonl", "{}\n");
    write(home, "vaults.json", "{}");
    return { home, vault, store, env: { DATANOTES_DATA_HOME: home } };
  }

  it("shows the backup, turns it on with a first push, sets the cadence, and turns it off", async () => {
    const { vault, store, env } = stored();
    const remote = bare();
    let out = "";
    const w = (t: string) => void (out += t);
    expect(await storeCommand(["backup", "--vault", vault], { env, write: w })).toBe(0);
    expect(out).toBe(`store backup off\nstore        ${store}\nremote       none\ncommits      every 60 s when something changed, each followed by a push\nlast commit  none\n`);

    out = "";
    expect(await storeCommand(["backup", "--vault", vault, "--remote", remote, "--interval-s", "30"], { env, write: w })).toBe(0);
    expect(out).toMatch(new RegExp(`^datanotes store: committing 3 files of the store\ndatanotes store: pushing 1 commit to .*\ndatanotes store: the store backup is on\nstore       .*\nremote       .*\ncommits      every 30 s when something changed, each followed by a push\nlast commit  [0-9a-f]+\nlast push    \\d{4}-`));
    const settings = JSON.parse(fs.readFileSync(path.join(store, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings).toEqual({ httpServerPort: 1234, httpServerToken: OWNER, storeBackupEnabled: true, storeBackupRemote: remote, storeBackupIntervalSeconds: 30 });
    expect(everyFile(remote)).toEqual([".gitattributes", ".gitignore", "journal/2026-10.jsonl"]);
    expect(git(remote, "log", "-1", "--format=%B", "main")).toContain(`Database-Id: ${ID}`);

    out = "";
    expect(await storeCommand(["backup", "--vault", vault, "--json"], { env, write: w })).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ store, enabled: true, remote, interval_s: 30 });
    expect((JSON.parse(out) as { last_commit: string }).last_commit).toMatch(/^[0-9a-f]+ \d{4}-/);

    out = "";
    expect(await storeCommand(["backup", "--vault", vault, "--interval-s", "45"], { env, write: w })).toBe(0);
    expect(out).toBe("datanotes store: the store backup commits every 45 s when something changed, each followed by a push\n");
    out = "";
    expect(await storeCommand(["backup", "--vault", vault, "--off"], { env, write: w })).toBe(0);
    expect(out).toContain("the store backup is off");
    expect(JSON.parse(fs.readFileSync(path.join(store, "settings.json"), "utf8"))).toMatchObject({ storeBackupEnabled: false, storeBackupRemote: remote, storeBackupIntervalSeconds: 45 });
    expect(fs.existsSync(path.join(store, ".git"))).toBe(true);
  });

  it("saves the setting but exits 1 when the first push fails, with the reason and no credentials", async () => {
    const { vault, store, env } = stored();
    let out = "";
    const remote = `file:///${path.join(tmp("store-backup-gone-"), "missing.git").replace(/\\/g, "/")}`;
    expect(await storeCommand(["backup", "--vault", vault, "--remote", remote], { env, write: (t) => (out += t) })).toBe(1);
    expect(out).toMatch(/\nerror        git push: /);
    expect(out).toContain("The setting is saved");
    expect(JSON.parse(fs.readFileSync(path.join(store, "settings.json"), "utf8"))).toMatchObject({ storeBackupEnabled: true, storeBackupRemote: remote });
    // a git that cannot even prepare the store
    out = "";
    const failing: GitRunner = async () => ({ code: 127, stdout: "", stderr: "git: not found" });
    const other = stored();
    fs.rmSync(path.join(other.store, ".git"), { recursive: true, force: true });
    expect(await storeCommand(["backup", "--vault", other.vault, "--remote", remote], { env: other.env, write: (t) => (out += t), run: failing })).toBe(1);
    expect(out).toContain("error        git init: git: not found");
  });

  it("completes a first backup of thousands of files that takes longer than the stop deadline, saying each step", async () => {
    const { vault, store, env } = stored();
    const remote = bare();
    for (let i = 0; i < 3000; i++) write(store, `blobs/${String(i).padStart(4, "0")}.txt`, `blob ${i}\n`);
    const timeouts: Record<string, number | undefined> = {};
    // a push slower than the stop deadline of the engine's backup: the command waits for it
    const slow: GitRunner = async (args, cwd, options) => {
      const sub = gitSubcommand(args);
      if (sub === "add" || sub === "push") timeouts[sub] = options?.timeoutMs;
      if (sub === "push") await new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS + 1000));
      return runGit(args, cwd, options);
    };
    let out = "";
    const started = Date.now();
    expect(await storeCommand(["backup", "--vault", vault, "--remote", remote], { env, write: (t) => (out += t), run: slow })).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(STOP_TIMEOUT_MS);
    expect(out).toMatch(new RegExp(`^datanotes store: committing 3003 files of the store\ndatanotes store: pushing 1 commit to .*\ndatanotes store: the store backup is on\n`));
    expect(out).toMatch(/\nlast push    \d{4}-/);
    expect(out).not.toContain("error");
    // the local steps get a generous limit; the push keeps the network one
    expect(timeouts).toEqual({ add: FIRST_BACKUP_LOCAL_TIMEOUT_MS, push: undefined });
    expect(git(remote, "rev-list", "--count", "main")).toBe("1");
    expect(git(remote, "ls-tree", "-r", "--name-only", "main").split("\n")).toHaveLength(3003);
    expect(fs.existsSync(path.join(store, ".git", "index.lock"))).toBe(false);
  }, 120_000);

  it("leaves no index.lock when git is stopped by its time limit in the first commit", async () => {
    const { vault, store, env } = stored();
    const remote = bare();
    // what a git killed in the middle of a commit leaves: its lock
    const killed: GitRunner = async (args, cwd, options) => {
      if (gitSubcommand(args) !== "commit") return runGit(args, cwd, options);
      fs.writeFileSync(path.join(store, ".git", "index.lock"), "");
      return { code: KILLED_CODE, stdout: "", stderr: "git commit timed out after 1800 s and was stopped" };
    };
    let out = "";
    expect(await storeCommand(["backup", "--vault", vault, "--remote", remote], { env, write: (t) => (out += t), run: killed })).toBe(1);
    expect(out).toContain("error        git commit: git commit timed out after 1800 s and was stopped");
    expect(out).not.toContain("pushing");
    expect(fs.existsSync(path.join(store, ".git", "index.lock"))).toBe(false);
    // run again: it works
    out = "";
    expect(await storeCommand(["backup", "--vault", vault, "--remote", remote], { env, write: (t) => (out += t) })).toBe(0);
    expect(git(remote, "rev-list", "--count", "main")).toBe("1");
  });

  describe("the SSH command of the store's repository", () => {
    const sshOf = (repo: string) => {
      try {
        return git(repo, "config", "--local", "--get", "core.sshCommand");
      } catch {
        return null;
      }
    };
    /** A vault in a git repository of its own, with an SSH command, as git sync uses it. */
    function vaultRepo(vault: string, ssh: string): void {
      git(vault, "init", "-q");
      git(vault, "config", "core.sshCommand", ssh);
    }

    it("takes the one of the vault's repository when it has none", async () => {
      const { vault, store, env } = stored();
      vaultRepo(vault, "C:/Windows/System32/OpenSSH/ssh.exe");
      expect(await storeCommand(["backup", "--vault", vault, "--remote", bare()], { env, write: () => undefined })).toBe(0);
      expect(sshOf(store)).toBe("C:/Windows/System32/OpenSSH/ssh.exe");
      // one of its own stays
      git(store, "config", "core.sshCommand", "ssh -i mykey");
      expect(await storeCommand(["backup", "--vault", vault, "--remote", bare()], { env, write: () => undefined })).toBe(0);
      expect(sshOf(store)).toBe("ssh -i mykey");
    });

    it("saves the one --ssh-command names, over any other", async () => {
      const { vault, store, env } = stored();
      vaultRepo(vault, "C:/Windows/System32/OpenSSH/ssh.exe");
      git(store, "init", "-q");
      git(store, "config", "core.sshCommand", "ssh -i old");
      expect(await storeCommand(["backup", "--vault", vault, "--remote", bare(), "--ssh-command", "ssh -i new"], { env, write: () => undefined })).toBe(0);
      expect(sshOf(store)).toBe("ssh -i new");
    });

    it("sets none when neither the option nor the vault's repository names one", async () => {
      const { vault, store, env } = stored();
      expect(await storeCommand(["backup", "--vault", vault, "--remote", bare()], { env, write: () => undefined })).toBe(0);
      expect(sshOf(store)).toBeNull();
      // a vault repository without one
      git(vault, "init", "-q");
      expect(await storeCommand(["backup", "--vault", vault, "--remote", bare()], { env, write: () => undefined })).toBe(0);
      expect(sshOf(store)).toBeNull();
    });

    it("is used by the push: the fake SSH program git runs is the vault's", async () => {
      const { vault, store, env } = stored();
      const bin = tmp("store-backup-ssh-");
      const called = path.join(bin, "called.txt");
      // a fake ssh: records that it ran, then fails the push
      const script = path.join(bin, "fake-ssh.sh");
      fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> '${called.replace(/\\/g, "/")}'\nexit 255\n`, { mode: 0o755 });
      vaultRepo(vault, `sh '${script.replace(/\\/g, "/")}'`);
      let out = "";
      expect(await storeCommand(["backup", "--vault", vault, "--remote", "git@example.invalid:you/store.git"], { env, write: (t) => (out += t) })).toBe(1);
      expect(out).toContain("error        git push:");
      expect(fs.readFileSync(called, "utf8")).toContain("git@example.invalid");
      // the user's SSH command: no BatchMode added
      expect(fs.readFileSync(called, "utf8")).not.toContain("BatchMode");
      expect(sshOf(store)).toBe(`sh '${script.replace(/\\/g, "/")}'`);
    });
  });

  it("refuses while an engine runs, without a store, and with options that do not fit", async () => {
    const { vault, store, env } = stored();
    const expectRefused = async (args: string[], message: string | RegExp, e: Record<string, string> = env) => {
      let err: unknown;
      try {
        await storeCommand(args, { env: e, write: () => undefined });
      } catch (x) {
        err = x;
      }
      expect(err).toBeInstanceOf(StoreSetupError);
      expect((err as Error).message).toMatch(message);
      expect((err as StoreSetupError).hint).toBeTruthy();
      expect((err as StoreSetupError).docs).toMatch(/^https:\/\/datanotes\.dev\/guides\/history\/back-up\.md#/);
    };
    await expectRefused(["backup", "--vault", vault, "--remote", ""], "--remote needs the URL of a git repository");
    // an option without its value is refused by the command line itself
    await expect(storeCommand(["backup", "--vault", vault, "--remote"], { env })).rejects.toMatchObject({ message: "--remote needs a value", docs: "https://datanotes.dev/reference/cli.md" });
    await expect(storeCommand(["backup", "--vault", vault, "--every", "30"], { env })).rejects.toMatchObject({ message: "unknown option --every" });
    await expectRefused(["backup", "--vault", vault, "--remote", "u", "--off"], "--remote and --off cannot go together");
    await expectRefused(["backup", "--vault", vault, "--ssh-command", "ssh"], "--ssh-command needs a command, and goes with --remote <url>");
    await expectRefused(["backup", "--vault", vault, "--remote", "u", "--ssh-command", ""], "--ssh-command needs a command, and goes with --remote <url>");
    await expectRefused(["backup", "--vault", vault, "--interval-s", "9"], '--interval-s must be a whole number of seconds, at least 10: "9"');
    await expectRefused(["backup", "--vault", vault, "--interval-s", "operation"], '--interval-s must be a whole number of seconds, at least 10: "operation"');
    write(store, "engine.lock", JSON.stringify({ kind: "service", pid: 1, host: os.hostname(), port: 9, startedAt: "", heartbeat: new Date().toISOString() }));
    await expectRefused(["backup", "--vault", vault, "--off"], /^an engine holds this database \(pid 1 on /);
    await expectRefused(["backup", "--vault", tmp("store-backup-empty-")], /^no store yet for /);
    await expect(storeCommand(["bogus"], { env })).rejects.toThrow(/path \| new-id \| backup \| restore/);
  });
});

describe("datanotes store restore", { timeout: 60_000 }, () => {
  /** A backup of the database ID in a bare remote, and a vault holding that database. */
  async function backedUp(id = ID) {
    const remote = bare();
    const store = tmp("store-backup-src-");
    write(store, "journal/2026-10.jsonl", "{}\n");
    write(store, "tokens.json", "[]");
    const b = new StoreBackup({ store, databaseId: id, remote, every: 3_600_000 });
    await b.start();
    await b.idle();
    await b.stop();
    const vault = tmp("store-backup-vault-");
    write(vault, "datanotes/metastore.yaml", `id: ${ID}\ncatalogs: {}\n`);
    const home = tmp("store-backup-home-");
    return { remote, vault, home, env: { DATANOTES_DATA_HOME: home } };
  }
  const refused = async (args: string[], env: Record<string, string>, message: string | RegExp) => {
    let err: unknown;
    try {
      await storeCommand(args, { env, write: () => undefined });
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(StoreSetupError);
    expect((err as Error).message).toMatch(message);
    expect((err as StoreSetupError).docs).toBe("https://datanotes.dev/guides/history/back-up.md#restore-the-store-from-its-backup");
  };

  it("refuses a store that exists unless --force, which keeps the old one aside; --no-backup and --store", async () => {
    const { remote, vault, home, env } = await backedUp();
    const target = path.join(home, ID);
    write(target, "journal/old.jsonl", "old\n");
    await refused(["restore", "--from", remote, "--vault", vault], env, `the store ${target} already exists and is not empty`);
    let out = "";
    expect(await storeCommand(["restore", "--from", remote, "--vault", vault, "--force", "--no-backup"], { env, write: (t) => (out += t) })).toBe(0);
    const aside = fs.readdirSync(home).find((f) => f.startsWith(`${ID}.before-restore-`))!;
    expect(fs.readFileSync(path.join(home, aside, "journal", "old.jsonl"), "utf8")).toBe("old\n");
    expect(out).toContain(`kept aside   ${path.join(home, aside)}`);
    expect(out).toContain("0 named tokens restored");
    expect(fs.existsSync(path.join(target, "journal", "2026-10.jsonl"))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(target, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings.storeBackupEnabled).toBe(false);
    expect(settings.storeBackupRemote).toBeUndefined();
    expect(readRegistry(home)[vaultKey(vault)]).toEqual({ id: ID, database: "datanotes" });

    const named = tmp("store-backup-named-");
    fs.rmSync(named, { recursive: true });
    expect(await storeCommand(["restore", "--from", remote, "--vault", vault, "--store", named], { env, write: () => undefined })).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(named, "store.json"), "utf8"))).toMatchObject({ id: ID, database: "datanotes" });
  });

  it("refuses the backup of another database, an empty repository, a clone that fails, and a vault without its database", async () => {
    const other = "01a1b2c3-0000-7000-8000-0000000000ff";
    const { remote, vault, home, env } = await backedUp(other);
    await refused(["restore", "--from", remote, "--vault", vault], env, `is the store backup of the database ${other}, not of this vault's database ${ID}`);
    expect(fs.readdirSync(home)).toEqual([]); // the clone is gone, nothing registered
    await refused(["restore", "--from", bare(), "--vault", vault], env, /holds no commit: it is not a store backup/);
    await refused(["restore", "--from", path.join(tmp("store-backup-gone-"), "x.git"), "--vault", vault], env, /^git clone .* failed: /);
    await refused(["restore", "--vault", vault], env, "pass --from <url>: the git repository the store was backed up to");
    await refused(["restore", "--from", remote, "--vault", vault, "--port", "80"], env, '--port must be from 1024 to 65535, or 0 for any free port: "80"');
    await refused(["restore", "--from", remote, "--vault", tmp("store-backup-empty-")], env, /datanotes\/metastore\.yaml does not exist in /);
    const noId = tmp("store-backup-noid-");
    write(noId, "datanotes/metastore.yaml", "catalogs: {}\n");
    await refused(["restore", "--from", remote, "--vault", noId], env, "datanotes/metastore.yaml has no id: the store backup cannot be matched to the database");
    // while an engine holds the store
    const target = path.join(home, ID);
    write(target, "engine.lock", JSON.stringify({ kind: "service", pid: 1, host: os.hostname(), port: 9, startedAt: "", heartbeat: new Date().toISOString() }));
    let err: unknown;
    try {
      await storeCommand(["restore", "--from", remote, "--vault", vault], { env, write: () => undefined });
    } catch (x) {
      err = x;
    }
    expect((err as Error).message).toMatch(/^an engine holds this database/);
  });

  it("keeps the store that was there when --force meets a backup that does not fit", async () => {
    const other = "01a1b2c3-0000-7000-8000-0000000000ff";
    const { remote, vault, home, env } = await backedUp(other);
    write(path.join(home, ID), "journal/old.jsonl", "old\n");
    await refused(["restore", "--from", remote, "--vault", vault, "--force"], env, /is the store backup of the database/);
    expect(fs.readFileSync(path.join(home, ID, "journal", "old.jsonl"), "utf8")).toBe("old\n");
    expect(fs.readdirSync(home)).toEqual([ID]);
  });
});
