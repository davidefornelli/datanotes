/**
 * The store backup and git sync as a production engine meets them (a large store on Windows, an
 * SSH remote, a service killed by force): no secret in the change feed or any backup commit, no
 * `git gc` under the engine's write lock, git that never prompts and never hangs (time limits,
 * kills), stale git locks after a forced stop, a bounded stop in the right order, files too large
 * for GitHub, a torn change feed line, the stop route POST only, and the database id of every
 * commit and restore.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED, redactToolCall } from "../src/api/redact";
import { GitSync, gitEnv, gitSubcommand, gitTimeoutMs, KILLED_CODE, LOCAL_TIMEOUT_MS, NETWORK_TIMEOUT_MS, runGit, type GitRunner } from "../src/node/git-sync";
import { lastGitSync, startService, type RunningService } from "../src/node/service";
import { MAX_FILE_BYTES, StoreBackup, type BackupEngine } from "../src/node/store-backup";
import { main as storeCommand } from "../src/node/store-command";
import { StoreSetupError } from "../src/node/store-setup";
import { Toolbox } from "../src/mcp/tools";
import { openDocs } from "../src/api/docs";

const ID = "01a1b2c3-0000-7000-8000-000000000002";
const OWNER = "owner-token-production-test";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function write(root: string, rel: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
function bare(): string {
  const dir = path.join(tmp("prod-backup-remote-"), "store.git");
  git(path.dirname(dir), "init", "-q", "--bare", dir);
  return dir;
}
/** Whether a text appears in any version of any file of a repository. */
function inHistory(repo: string, text: string): boolean {
  const revs = git(repo, "rev-list", "--all").split("\n").filter(Boolean);
  if (revs.length === 0) return false;
  try {
    execFileSync("git", ["grep", "-q", "-F", text, ...revs], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}
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
/** Every text of the store's change feed files. */
const changesText = (store: string) =>
  fs.existsSync(path.join(store, "changes"))
    ? fs
        .readdirSync(path.join(store, "changes"))
        .map((f) => fs.readFileSync(path.join(store, "changes", f), "utf8"))
        .join("")
    : "";

afterEach(() => {
  vi.useRealTimers();
});

describe("secrets never reach the change feed", () => {
  it("redacts the catalogue's sensitive results and any key that names a secret, in objects and texts", () => {
    const r = redactToolCall("create_webhook", { url: "https://x.example/h", token: "t-1" }, { id: "wh_1", secret: "s-1", url: "https://x.example/h" });
    expect(r.args).toEqual({ url: "https://x.example/h", token: REDACTED });
    expect(r.value).toEqual({ id: "wh_1", secret: REDACTED, url: "https://x.example/h" });
    // any tool, at any depth, a result sent as text too
    const other = redactToolCall("some_tool", { nested: [{ apiKey: "k", api_key: "k2", keep: 1 }] }, '{"ok":true,"access_token":"abc\\"def","n":2}');
    expect(other.args).toEqual({ nested: [{ apiKey: REDACTED, api_key: REDACTED, keep: 1 }] });
    expect(other.value).toBe(`{"ok":true,"access_token":"${REDACTED}","n":2}`);
    // nothing to remove: equal values
    expect(redactToolCall("select_rows", { table: "t" }, { rows: [{ a: 1 }] })).toEqual({ args: { table: "t" }, value: { rows: [{ a: 1 }] } });
  });

  it("create_webhook through the MCP server: the agent gets the secret, the change feed and every backup commit never do", async () => {
    const vault = tmp("prod-backup-vault-");
    const store = tmp("prod-backup-store-");
    const remote = bare();
    const port = await freePort();
    write(store, "settings.json", JSON.stringify({ httpServerPort: port, httpServerToken: OWNER, autoRecompute: false }));
    const svc = await startService({ vault, watch: "poll", pollMs: 100, store, storeBackup: { remote, every: 3_600_000, quietMs: 100 } }, {});
    try {
      const url = `http://127.0.0.1:${port}`;
      const toolbox = new Toolbox(url, undefined, openDocs());
      const made = await toolbox.call(OWNER, "create_webhook", { url: "http://127.0.0.1:9/hook" }, { harness: "test-agent", session: "s1" });
      expect(made.isError).toBeUndefined();
      const secret = (made.structuredContent as { secret: string }).secret;
      expect(secret).toMatch(/\S{16,}/);
      // an MCP server of an older version reports the call with the secret: the engine removes it
      const r = await fetch(`${url}/datanotes/tool-calls/record/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "create_webhook", args: { url: "http://127.0.0.1:9/hook" }, ok: true, durationMs: 1, value: { id: "wh_x", secret } }),
      });
      expect(r.status).toBe(200);
      const feed = await toolbox.client(OWNER).call("list_changes", { kinds: ["tool_call"] });
      const events = (feed.value as { events: { call: { tool: string; value: unknown } }[] }).events.filter((e) => e.call.tool === "create_webhook");
      expect(events).toHaveLength(2);
      for (const e of events) expect(e.call.value).toMatchObject({ secret: REDACTED });
      expect(JSON.stringify(feed.value)).not.toContain(secret);
      expect(changesText(store)).not.toContain(secret);
      expect(changesText(store)).toContain(REDACTED);
    } finally {
      await svc.stop();
    }
    // the last commit and push at stop: the change feed is in the backup, the secret never
    expect(git(remote, "ls-tree", "-r", "--name-only", "main")).toMatch(/^changes\//m);
    const secretFile = JSON.parse(fs.readFileSync(path.join(store, "webhooks.json"), "utf8")) as { secret: string }[];
    expect(secretFile[0]!.secret).toBeTruthy();
    expect(inHistory(remote, secretFile[0]!.secret)).toBe(false);
    expect(inHistory(store, secretFile[0]!.secret)).toBe(false);
  }, 60_000);
});

describe("git never prompts and never hangs", () => {
  it("knows the subcommand behind global options, and gives network commands a longer time limit", () => {
    expect(gitSubcommand(["-c", "gc.auto=0", "-C", "x", "--no-optional-locks", "commit", "-m", "x"])).toBe("commit");
    expect(gitSubcommand([])).toBe("");
    expect(gitTimeoutMs(["status"])).toBe(LOCAL_TIMEOUT_MS);
    expect(gitTimeoutMs(["-c", "a=b", "push", "origin"], {})).toBe(NETWORK_TIMEOUT_MS);
    expect(gitTimeoutMs(["fetch"], { DATANOTES_GIT_NETWORK_TIMEOUT_S: "30" })).toBe(30_000);
    expect(gitTimeoutMs(["pull"], { DATANOTES_GIT_NETWORK_TIMEOUT_S: "soon" })).toBe(NETWORK_TIMEOUT_MS);
  });

  it("runs without a terminal prompt, a credential window or an SSH question, unless the user chose an SSH command", async () => {
    expect(gitEnv({ PATH: "p" })).toEqual({ PATH: "p", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
    expect(gitEnv({ GIT_SSH_COMMAND: "ssh -i key" }).GIT_SSH_COMMAND).toBe("ssh -i key");
    expect(gitEnv({ GIT_SSH: "plink" }).GIT_SSH_COMMAND).toBeUndefined();
    expect(gitEnv({}, true).GIT_SSH_COMMAND).toBeUndefined();
    // what a real git sees
    const dir = tmp("prod-git-env-");
    const r = await runGit(["-c", 'alias.env=!echo "$GIT_TERMINAL_PROMPT|$GCM_INTERACTIVE"', "env"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("0|never");
  });

  it("kills a git past its time limit, or when stopped, and answers at once with a failure that says why", async () => {
    const dir = tmp("prod-git-hang-");
    const hang = ["-c", "alias.hang=!sleep 30", "hang"];
    let started = Date.now();
    const timedOut = await runGit(hang, dir, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(timedOut.code).toBe(KILLED_CODE);
    expect(timedOut.stderr).toMatch(/git hang timed out after 0 s and was stopped$/);
    const stop = new AbortController();
    started = Date.now();
    const pending = runGit(hang, dir, { signal: stop.signal });
    setTimeout(() => stop.abort(), 300);
    const stopped = await pending;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stopped).toMatchObject({ code: KILLED_CODE, stderr: expect.stringMatching(/git hang stopped: the engine is stopping$/) });
    // already stopped: git does not even start
    expect(await runGit(["status"], dir, { signal: stop.signal })).toMatchObject({ code: KILLED_CODE, stderr: "git status not run: stopped" });
    // a git that cannot start at all
    expect((await runGit(["status"], path.join(dir, "missing"))).code).not.toBe(0);
  }, 30_000);
});

describe("git sync never hangs a stop", () => {
  /** A vault repository as git sync sees it: one commit behind its upstream; `hang` never answers until killed. */
  function fakeVault(hang: string | null, pullCode = 0) {
    const vault = tmp("prod-sync-");
    const calls: string[] = [];
    const run: GitRunner = (args, _cwd, o) => {
      const sub = gitSubcommand(args);
      calls.push(sub);
      const ok = (stdout = "") => Promise.resolve({ code: 0, stdout, stderr: "" });
      if (sub === hang) {
        const killed = { code: KILLED_CODE, stdout: "", stderr: `git ${sub} stopped: the engine is stopping` };
        return new Promise((resolve) => (o?.signal?.aborted ? resolve(killed) : o?.signal?.addEventListener("abort", () => resolve(killed))));
      }
      if (sub === "rev-parse" && args.includes("--show-toplevel")) return ok(`${vault}\n`);
      if (sub === "rev-parse" && args.includes("--git-path")) return ok("");
      if (sub === "check-ignore") return Promise.resolve({ code: 1, stdout: "", stderr: "" });
      if (sub === "rev-list") return ok("0\t1\n");
      if (sub === "pull") return Promise.resolve({ code: pullCode, stdout: "", stderr: pullCode ? "git pull timed out after 600 s and was stopped" : "" });
      return ok();
    };
    return { sync: new GitSync({ vault, run, intervalMs: 3_600_000 }), calls };
  }

  it("a pull killed by its time limit is a failure the next cycle retries, not a conflict", async () => {
    const { sync, calls } = fakeVault(null, KILLED_CODE);
    expect(await sync.start()).toBe(true);
    await sync.cycle();
    expect(sync.status.blocked).toBe("git pull: git pull timed out after 600 s and was stopped");
    expect(calls).toContain("rebase"); // a rebase half done is aborted all the same
    sync.stop();
  });

  it("a last cycle that does not end in time: git is killed, the stop goes on", async () => {
    const { sync } = fakeVault("fetch");
    expect(await sync.start()).toBe(true);
    sync.stop();
    const started = Date.now();
    await lastGitSync(sync, 200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(sync.status.blocked).toBe("git fetch: git fetch stopped: the engine is stopping");
    // a cycle that ends in time is simply awaited
    const quick = fakeVault(null);
    await quick.sync.start();
    quick.sync.stop();
    await lastGitSync(quick.sync, 5_000);
    expect(quick.sync.status.blocked).toBeUndefined();
  });
});

/** A runner over real git that records each command and whether the engine's lock was held. */
function recording(inner: GitRunner = runGit) {
  let locked = false;
  const calls: { args: string[]; locked: boolean }[] = [];
  const run: GitRunner = (args, cwd, o) => {
    calls.push({ args, locked });
    return inner(args, cwd, o);
  };
  const engine: BackupEngine = {
    activity: () => ({ busy: false, lastEnd: 0 }),
    exclusive: async (fn) => {
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
      }
    },
  };
  const of = (sub: string) => calls.filter((c) => gitSubcommand(c.args) === sub);
  return { run, engine, calls, of };
}

describe("the store backup in production", () => {
  it("no automatic git gc under the engine's lock: a first add outside it, and git gc --auto after the push", async () => {
    const store = tmp("prod-backup-gc-");
    const remote = bare();
    write(store, "journal/2026-10.jsonl", "{}\n");
    const g = recording();
    const b = new StoreBackup({ store, databaseId: ID, remote, every: 3_600_000, run: g.run, engine: g.engine });
    expect(await b.start()).toBe(true);
    await b.idle();
    const adds = g.of("add");
    expect(adds.map((c) => c.locked)).toEqual([false, true]);
    for (const c of [...adds, ...g.of("commit")]) expect(c.args.slice(0, 4)).toEqual(["-c", "gc.auto=0", "-c", "maintenance.auto=false"]);
    expect(g.of("commit").every((c) => c.locked)).toBe(true);
    const order = g.calls.map((c) => gitSubcommand(c.args));
    expect(order.indexOf("gc")).toBeGreaterThan(order.indexOf("push"));
    expect(g.of("gc")).toEqual([{ args: ["-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false", "gc", "--auto", "--quiet"], locked: false }]);
    // nothing committed since: no housekeeping
    await b.sync();
    expect(g.of("gc")).toHaveLength(1);
    await b.stop();
    expect(g.of("gc")).toHaveLength(1); // never at stop
    expect(git(remote, "log", "-1", "--format=%B", "main")).toContain(`Database-Id: ${ID}`);
  }, 30_000);

  it("removes the git locks a killed git left, then commits and pushes", async () => {
    const store = tmp("prod-backup-lock-");
    const remote = bare();
    write(store, "journal/2026-10.jsonl", "{}\n");
    const first = new StoreBackup({ store, databaseId: ID, remote, every: 3_600_000 });
    await first.start();
    await first.stop();
    // a service killed during git add, then during the update of the branch
    write(store, ".git/index.lock", "");
    write(store, ".git/refs/heads/main.lock", "");
    write(store, "journal/2026-10.jsonl", "{}\n{}\n");
    const logs: string[] = [];
    const again = new StoreBackup({ store, databaseId: ID, remote, every: 3_600_000, log: (_l, m, a) => logs.push(`${m} ${String(a?.file)}`) });
    expect(await again.start()).toBe(true);
    await again.idle();
    await again.stop();
    expect(again.status.lastError).toBeUndefined();
    expect(fs.existsSync(path.join(store, ".git", "index.lock"))).toBe(false);
    expect(logs).toContain("datanotes store backup removed a git lock left by a stopped git .git/index.lock");
    expect(logs).toContain("datanotes store backup removed a git lock left by a stopped git .git/refs/heads/main.lock");
    expect(git(remote, "show", "main:journal/2026-10.jsonl")).toBe("{}\n{}");
  }, 30_000);

  it("refuses to push a file over the size limit, with a hint, and does not try again and again", async () => {
    expect(MAX_FILE_BYTES).toBe(95 * 1024 * 1024);
    const store = tmp("prod-backup-big-");
    const remote = bare();
    write(store, "journal/2026-10.jsonl", "{}\n");
    write(store, "blobs/big.bin", Buffer.alloc(4096, 7));
    const g = recording();
    const b = new StoreBackup({ store, databaseId: ID, remote, every: 3_600_000, run: g.run, maxFileBytes: 2048 });
    await b.start();
    await b.idle();
    expect(b.status.lastError).toBe("git push refused: blobs/big.bin is 0.0 MB, over the 0.001953125 MB a file of the store backup can have (GitHub refuses files over 100 MB)");
    expect(b.status.hint).toMatch(/^Make the file smaller \(vacuum_table removes a table's old history\)/);
    expect(b.status.docs).toBe("https://datanotes.dev/guides/history/back-up.md#keep-each-file-under-95-mb");
    expect(b.status.nextRetry).toBeUndefined();
    await b.sync();
    await b.tick();
    expect(g.of("push")).toEqual([]);
    expect(git(remote, "rev-list", "--all")).toBe("");
    await b.stop();
    // the file made small again, the backup repository started again: the push goes
    fs.rmSync(path.join(store, ".git"), { recursive: true, force: true });
    write(store, "blobs/big.bin", "small");
    const c = new StoreBackup({ store, databaseId: ID, remote, every: 3_600_000, maxFileBytes: 2048 });
    await c.start();
    await c.idle();
    await c.stop();
    expect(c.status).toMatchObject({ pendingCommits: 0 });
    expect(c.status.lastError).toBeUndefined();
    expect(c.status.hint).toBeUndefined();
  }, 30_000);

  it("never commits without the database id", async () => {
    const store = tmp("prod-backup-noid-");
    write(store, "journal/2026-10.jsonl", "{}\n");
    const b = new StoreBackup({ store, databaseId: " ", every: 3_600_000 });
    expect(await b.start()).toBe(false);
    expect(b.status).toMatchObject({ enabled: false, lastError: "the database has no id: a store backup could not be matched to it", docs: "https://datanotes.dev/guides/history/back-up.md#turn-on-the-store-backup" });
    expect(b.status.hint).toMatch(/^Start the engine once on the vault/);
    expect(fs.existsSync(path.join(store, ".git"))).toBe(false);
    await b.stop();
  });

  it("a push that times out is a failure retried with backoff", async () => {
    const store = tmp("prod-backup-timeout-");
    write(store, "journal/2026-10.jsonl", "{}\n");
    const slow: GitRunner = async (args, cwd, o) =>
      gitSubcommand(args) === "push" ? { code: KILLED_CODE, stdout: "", stderr: "git push timed out after 600 s and was stopped" } : runGit(args, cwd, o);
    const b = new StoreBackup({ store, databaseId: ID, remote: bare(), every: 3_600_000, run: slow });
    await b.start();
    await b.idle();
    expect(b.status.lastError).toBe("git push: git push timed out after 600 s and was stopped");
    expect(b.status.nextRetry).toBeDefined();
    await b.stop();
  }, 30_000);

  it("a stop waits for the last push only so long, then kills git: the next start pushes", async () => {
    const store = tmp("prod-backup-stop-");
    const remote = bare();
    write(store, "journal/2026-10.jsonl", "{}\n");
    let hung = 0;
    // a push that hangs (a remote that never answers) until git is killed
    const hanging: GitRunner = (args, cwd, o) => {
      if (gitSubcommand(args) !== "push") return runGit(args, cwd, o);
      hung++;
      const killed = { code: KILLED_CODE, stdout: "", stderr: "git push stopped: the engine is stopping" };
      return new Promise((resolve) => (o?.signal?.aborted ? resolve(killed) : o?.signal?.addEventListener("abort", () => resolve(killed))));
    };
    const logs: string[] = [];
    const b = new StoreBackup({ store, databaseId: ID, remote, every: 3_600_000, run: hanging, stopTimeoutMs: 300, log: (_l, m) => logs.push(m) });
    await b.start();
    // the first push (at start) hangs
    for (const deadline = Date.now() + 20_000; hung === 0 && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await b.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(hung).toBeGreaterThan(0);
    expect(b.status.enabled).toBe(false);
    expect(b.status.lastError).toBe("the last commit and push did not end within 0.3 s of the stop: git was stopped, and the next start makes them");
    expect(logs).toContain("datanotes store backup stopped before its last push ended");
    const again = new StoreBackup({ store, databaseId: ID, remote, every: 3_600_000 });
    await again.start();
    await again.idle();
    await again.stop();
    expect(again.status.pendingCommits).toBe(0);
    expect(git(remote, "show", "main:journal/2026-10.jsonl")).toBe("{}");
  }, 30_000);
});

describe("the engine's stop", () => {
  const running: RunningService[] = [];
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
  });

  it("GET /datanotes/stop/ does nothing: the stop takes POST", async () => {
    const vault = tmp("prod-stop-vault-");
    const store = tmp("prod-stop-store-");
    const port = await freePort();
    write(store, "settings.json", JSON.stringify({ httpServerPort: port, httpServerToken: OWNER }));
    const svc = await startService({ vault, watch: "poll", pollMs: 100, store }, {});
    running.push(svc);
    const r = await fetch(`http://127.0.0.1:${port}/datanotes/stop/`, { headers: { Authorization: `Bearer ${OWNER}` } });
    expect(r.status).toBe(405);
    expect(await r.json()).toEqual({
      error: "GET /datanotes/stop/ does nothing: the stop takes POST",
      hint: "Send POST /datanotes/stop/ with the owner token, or run datanotes stop --vault <folder>.",
      docs: "https://datanotes.dev/administration/run-the-service.md#stop-the-engine",
    });
    const status = await fetch(`http://127.0.0.1:${port}/datanotes/status/`, { method: "POST", headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" }, body: "{}" });
    expect(status.status).toBe(200); // still running
  }, 30_000);

  it("the engine stops writing, then the store backup's last push, then git sync's last commit, and the lock goes last", async () => {
    const vault = tmp("prod-stop-vault-");
    const store = tmp("prod-stop-store-");
    const remote = bare();
    const port = await freePort();
    git(vault, "init", "-q");
    git(vault, "config", "user.email", "t@example.com");
    git(vault, "config", "user.name", "T");
    write(vault, "Welcome.md", "hello\n");
    git(vault, "add", "-A");
    git(vault, "commit", "-qm", "init");
    write(store, "settings.json", JSON.stringify({ httpServerPort: port, httpServerToken: OWNER }));
    const lock = path.join(store, "engine.lock").replace(/\\/g, "/");
    const saw = (name: string) => path.join(tmp(`prod-stop-${name}-`), "saw.txt").replace(/\\/g, "/");
    const backupSaw = saw("backup");
    const syncSaw = saw("sync");
    // hooks that note whether the engine still holds its lock, and what ran before them
    const hook = (file: string, note: string) => `#!/bin/sh\nif [ -f "${lock}" ]; then echo "${note} held" >> "${file}"; else echo "${note} free" >> "${file}"; fi\nexit 0\n`;
    const svc = await startService({ vault, watch: "poll", pollMs: 100, store, gitSync: { intervalMs: 3_600_000, quietMs: 3_600_000, push: false }, storeBackup: { remote, every: 3_600_000, quietMs: 100 } }, {});
    await svc.backup!.idle();
    write(store, ".git/hooks/pre-push", hook(backupSaw, "backup"));
    fs.chmodSync(path.join(store, ".git", "hooks", "pre-push"), 0o755);
    write(vault, ".git/hooks/pre-commit", `${hook(syncSaw, "sync")}`.replace("exit 0", `cat "${backupSaw}" >> "${syncSaw}"\nexit 0`));
    fs.chmodSync(path.join(vault, ".git", "hooks", "pre-commit"), 0o755);
    write(vault, "Note.md", "a note written while the engine runs\n");
    write(store, "journal/2026-10.jsonl", "{}\n"); // something for the last backup commit
    await svc.stop();
    expect(fs.readFileSync(backupSaw, "utf8")).toBe("backup held\n");
    // git sync's last commit came after the store backup's last push, the lock still held
    expect(fs.readFileSync(syncSaw, "utf8")).toBe("sync held\nbackup held\n");
    expect(fs.existsSync(path.join(store, "engine.lock"))).toBe(false);
    expect(git(vault, "log", "-1", "--format=%s")).toMatch(/^vault sync: /);
  }, 60_000);
});

describe("the database id of the store backup", () => {
  it("datanotes store backup refuses a database without an id, with a hint", async () => {
    const vault = tmp("prod-noid-vault-");
    write(vault, "datanotes/metastore.yaml", "catalogs: {}\n");
    const store = tmp("prod-noid-store-");
    write(store, "journal/2026-10.jsonl", "{}\n");
    let err: unknown;
    try {
      await storeCommand(["backup", "--vault", vault, "--remote", bare()], { env: { DATANOTES_STORE: store }, write: () => undefined });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreSetupError);
    expect((err as Error).message).toMatch(/has no id yet: a store backup could not be matched to it$/);
    expect((err as StoreSetupError).hint).toMatch(/^Start the engine once on the vault/);
    expect((err as StoreSetupError).docs).toBe("https://datanotes.dev/guides/history/back-up.md#turn-on-the-store-backup");
    expect(fs.existsSync(path.join(store, ".git"))).toBe(false);
  });

  it("a restore reads an empty Database-Id trailer as none, not the next line's first word", async () => {
    const remote = bare();
    const src = tmp("prod-restore-src-");
    git(src, "init", "-q", "-b", "main");
    write(src, "journal/2026-10.jsonl", "{}\n");
    git(src, "add", "-A");
    git(src, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "store backup: 1 file changed\n\nDatabase-Id:\nBacked-up-by: datanotes");
    git(src, "push", "-q", remote, "main");
    const vault = tmp("prod-restore-vault-");
    write(vault, "datanotes/metastore.yaml", `id: ${ID}\ncatalogs: {}\n`);
    const home = tmp("prod-restore-home-");
    expect(await storeCommand(["restore", "--from", remote, "--vault", vault, "--no-backup"], { env: { DATANOTES_DATA_HOME: home }, write: () => undefined })).toBe(0);
    expect(fs.readFileSync(path.join(home, ID, "journal", "2026-10.jsonl"), "utf8")).toBe("{}\n");
  }, 30_000);
});
