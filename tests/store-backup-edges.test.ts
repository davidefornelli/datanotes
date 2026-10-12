/**
 * The store backup (src/node/store-backup.ts) when git answers oddly: a status or a commit that
 * fails, an error said on stdout only, a file too large that git cannot name, git's housekeeping
 * failing or slow, a git lock that a stopped git still holds for a moment. Git is played by the
 * test (`scripted`); the store is a temp folder.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSubcommand, type GitRunner } from "../src/node/git-sync";
import { prepareStoreRepo, StoreBackup } from "../src/node/store-backup";

const ID = "01a1b2c3-0000-7000-8000-0000000000e1";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "store-backup-edges-"));

type Reply = { code?: number; stdout?: string; stderr?: string };

/**
 * git, played by the test: `replies` answers a command (its arguments from the subcommand on,
 * joined by spaces, matched by prefix, first match wins); anything else succeeds with no output.
 */
function scripted(replies: [string, Reply | (() => Reply | Promise<Reply>)][]) {
  const calls: string[] = [];
  const run: GitRunner = async (given) => {
    const cmd = given.slice(Math.max(0, given.indexOf(gitSubcommand(given)))).join(" ");
    calls.push(cmd);
    const hit = replies.find(([prefix]) => cmd.startsWith(prefix));
    const r = hit ? (typeof hit[1] === "function" ? await hit[1]() : hit[1]) : {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

function logged() {
  const logs: [string, string, Record<string, unknown> | undefined][] = [];
  return { logs, log: (level: "INFO" | "WARN" | "ERROR", message: string, attrs?: Record<string, unknown>) => void logs.push([level, message, attrs]) };
}

describe("the first backup (once)", () => {
  it("a status that fails counts no file; a commit refused on stdout says so; a lock a stopped git still holds is removed once free", async () => {
    const store = tmp();
    // a repository a stopped git left: index.lock a folder (not a lock file), HEAD.lock held a moment
    fs.mkdirSync(path.join(store, ".git", "index.lock"), { recursive: true });
    const held = path.join(store, ".git", "HEAD.lock");
    fs.writeFileSync(held, "");
    const g = scripted([
      ["remote get-url", { stdout: "https://example.com/store.git\n" }],
      ["status", { code: 128, stderr: "fatal: index file corrupt" }],
      ["diff --cached", { stdout: "journal/2026-10.jsonl\n" }],
      ["commit", { code: 1, stdout: "pre-commit hook refused the commit" }],
    ]);
    const realRm = fs.rmSync;
    let tries = 0;
    fs.rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p) === held && ++tries <= 2) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      return realRm(p, o);
    }) as typeof fs.rmSync;
    let ok: boolean;
    try {
      const b = new StoreBackup({ store, databaseId: ID, run: g.run });
      ok = await b.once();
      expect(b.status.lastError).toBe("git commit: pre-commit hook refused the commit");
      expect(b.status.pendingOperations).toBe(0);
    } finally {
      fs.rmSync = realRm;
    }
    expect(ok).toBe(false);
    expect(tries).toBe(3);
    expect(fs.existsSync(held)).toBe(false);
    expect(fs.statSync(path.join(store, ".git", "index.lock")).isDirectory()).toBe(true);
    expect(g.calls.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("says what it commits and pushes, one file and one commit; a push refused on stdout says so", async () => {
    const store = tmp();
    fs.mkdirSync(path.join(store, ".git"));
    const g = scripted([
      ["remote get-url", { stdout: "https://example.com/store.git\n" }],
      ["status", { stdout: "?? journal/2026-10.jsonl\n" }],
      ["diff --cached", { stdout: "journal/2026-10.jsonl\n" }],
      ["rev-parse --short", { stdout: "abc1234\n" }],
      ["rev-list --count", { stdout: "1\n" }],
      ["rev-list --objects", { code: 128, stderr: "fatal: bad filter" }],
      ["push", { code: 1, stdout: "remote: rejected" }],
    ]);
    const progress: string[] = [];
    const b = new StoreBackup({ store, databaseId: ID, run: g.run });
    expect(await b.once((m) => progress.push(m))).toBe(false);
    expect(progress).toEqual(["committing 1 file of the store", "pushing 1 commit to https://example.com/store.git"]);
    expect(b.status.lastError).toBe("git push: remote: rejected");
  });
});

describe("pushing and housekeeping", () => {
  it("a file over the size limit that git cannot name: its object id, size unknown", async () => {
    const store = tmp();
    fs.mkdirSync(path.join(store, ".git"));
    const g = scripted([
      ["remote get-url", { stdout: "https://example.com/store.git\n" }],
      ["rev-list --count", { stdout: "1\n" }],
      ["rev-list --objects --filter", { stdout: "abc\n~deadbeef\n" }],
      ["rev-list --objects", { stdout: "abc journal/a.jsonl\n" }],
      ["cat-file", { code: 128, stdout: "", stderr: "fatal: not a valid object" }],
    ]);
    const { logs, log } = logged();
    const b = new StoreBackup({ store, databaseId: ID, run: g.run, log });
    expect(await b.once()).toBe(false);
    expect(b.status.lastError).toMatch(/^git push refused: deadbeef is 0\.0 MB, over the /);
    expect(logs.find(([level]) => level === "ERROR")?.[2]).toEqual({ file: "deadbeef", bytes: 0 });
  });

  it("two ticks at once: the second waits for the first", async () => {
    const store = tmp();
    fs.mkdirSync(path.join(store, ".git"));
    const g = scripted([]);
    const b = new StoreBackup({ store, databaseId: ID, run: g.run, every: 3_600_000 });
    expect(await b.start()).toBe(true);
    const first = b.tick();
    expect(b.tick()).toBe(first);
    await first;
    await b.stop();
  });

  it("git gc failing is logged; a slow one says it packed the repository", async () => {
    for (const [gc, expected] of [
      [{ code: 1, stderr: "fatal: gc is already running" }, ["WARN", "datanotes store backup: git gc --auto failed"]],
      [() => new Promise<Reply>((r) => setTimeout(() => r({}), 1_100)), ["INFO", "datanotes store backup packed the repository"]],
    ] as [Reply | (() => Promise<Reply>), [string, string]][]) {
      const store = tmp();
      fs.mkdirSync(path.join(store, ".git"));
      const g = scripted([
        ["diff --cached", { stdout: "journal/2026-10.jsonl\n" }],
        ["gc", gc],
      ]);
      const { logs, log } = logged();
      const b = new StoreBackup({ store, databaseId: ID, run: g.run, log });
      await b.sync();
      expect(logs.map(([level, message]) => [level, message])).toContainEqual(expected);
    }
  });
});

describe("preparing the store's repository: its SSH command", () => {
  it("a vault folder that is gone has no SSH command to give", async () => {
    const store = tmp();
    const g = scripted([["config --local --get core.sshCommand", { code: 1 }]]);
    await prepareStoreRepo(store, null, g.run, { vault: path.join(tmp(), "gone") });
    expect(g.calls.filter((c) => c.includes("core.sshCommand"))).toEqual(["config --local --get core.sshCommand"]);
  });

  it("an SSH command git refuses to save fails the preparation, saying why", async () => {
    const g = scripted([["config core.sshCommand", { code: 1, stdout: "error: could not lock config file" }]]);
    await expect(prepareStoreRepo(tmp(), null, g.run, { sshCommand: "ssh -i key" })).rejects.toThrow("git config core.sshCommand: error: could not lock config file");
  });
});

describe("the first backup: plural and stdout", () => {
  it("says how many commits it pushes", async () => {
    const store = tmp();
    fs.mkdirSync(path.join(store, ".git"));
    const g = scripted([
      ["remote get-url", { stdout: "https://example.com/store.git\n" }],
      ["rev-list --count", { stdout: "2\n" }],
    ]);
    const progress: string[] = [];
    const b = new StoreBackup({ store, databaseId: ID, run: g.run });
    expect(await b.once((m) => progress.push(m))).toBe(true);
    expect(progress).toEqual(["pushing 2 commits to https://example.com/store.git"]);
  });

  it("a git init that fails saying it on stdout only", async () => {
    const g = scripted([["init", { code: 1, stdout: "cannot create the repository here" }]]);
    await expect(prepareStoreRepo(tmp(), null, g.run)).rejects.toThrow("git init: cannot create the repository here");
  });
});
