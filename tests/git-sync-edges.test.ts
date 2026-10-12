import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitSync, runGit, type GitRunner } from "../src/node/git-sync";

afterEach(() => {
  vi.useRealTimers();
});

type Reply = { code?: number; stdout?: string; stderr?: string };

/**
 * git, played by the test: `replies` answers a command (its arguments joined by spaces, matched by
 * prefix, first match wins); anything else succeeds with no output. Every call is recorded.
 */
function fakeGit(replies: [string, Reply | (() => Reply)][], repo: string) {
  const calls: string[] = [];
  const run: GitRunner = async (args) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (cmd === "rev-parse --show-toplevel") return { code: 0, stdout: `${repo}\n`, stderr: "" };
    const hit = replies.find(([prefix]) => cmd.startsWith(prefix));
    const r = hit ? (typeof hit[1] === "function" ? hit[1]() : hit[1]) : {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

function repoDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "git-sync-edges-"));
}

const CHANGED: [string, Reply] = ["status --porcelain", { stdout: " M Notes/a.md\n?? Notes/b.md\n" }];

async function started(replies: [string, Reply | (() => Reply)][], o: { push?: boolean; exclude?: string[] } = {}) {
  const repo = repoDir();
  const g = fakeGit(replies, repo);
  const logs: [string, string, Record<string, unknown> | undefined][] = [];
  const sync = new GitSync({ vault: repo, run: g.run, log: (level, message, attrs) => void logs.push([level, message, attrs]), ...o });
  expect(await sync.start()).toBe(true);
  sync.stop(); // no timer: the tests run cycles themselves
  return { sync, ...g, logs, repo };
}

describe("git sync: starting", () => {
  it("a vault outside any repository: the sync stays off and says why", async () => {
    const logs: string[] = [];
    const sync = new GitSync({ vault: "/data/vault", run: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }), log: (_l, m) => void logs.push(m) });
    expect(await sync.start()).toBe(false);
    expect(logs).toEqual(["datanotes git sync: the vault is not in a git repository"]);
    expect(sync.status).toEqual({ enabled: false, pendingOperations: 0 });
    await sync.cycle(); // nothing to do without a repository
  });

  it("runs real git: a folder that is not a repository answers with a non-zero code", async () => {
    const dir = repoDir();
    const r = await runGit(["rev-parse", "--show-toplevel"], dir);
    expect(r.code).not.toBe(0);
    const missing = await runGit(["status"], path.join(dir, "missing"));
    expect(missing.code).toBe(1); // the process could not even start
  });
});

describe("git sync: a cycle", () => {
  it("commits the vault's changes with the operations in the message, then pushes what is ahead", async () => {
    const { sync, calls, logs } = await started([CHANGED, ["rev-parse --short HEAD", { stdout: "abc1234\n" }], ["rev-list --left-right", { stdout: "1\t0\n" }], ["rev-list --count", { stdout: "1\n" }]]);
    sync.noteOperation({ summary: "insert_row main.public.log", actor: "claude-code" });
    sync.noteOperation({ summary: "update_row main.public.log" });
    await sync.cycle();
    const commit = calls.find((c) => c.startsWith("commit"))!;
    expect(commit).toContain("vault sync: 2 operations, 2 files\n\n- insert_row main.public.log (claude-code)\n- update_row main.public.log\n\nSynced-by: datanotes");
    expect(calls).toContain("push -q");
    expect(sync.status).toMatchObject({ enabled: false, lastCommit: "abc1234", pendingOperations: 0 });
    expect(sync.status.lastPush).toBeDefined();
    expect(sync.status.blocked).toBeUndefined();
    expect(logs.map((l) => l[1])).toEqual(["datanotes git sync started", "datanotes git sync committed", "datanotes git sync pushed"]);
  });

  it("the message of one operation and one file, of edits made by hand, and of more than 50 operations", async () => {
    const one = await started([["status --porcelain", { stdout: " M a.md\n" }]], { push: false });
    one.sync.noteOperation({ summary: "insert_row log" });
    await one.sync.cycle();
    expect(one.calls.find((c) => c.startsWith("commit"))).toContain("vault sync: 1 operation, 1 file\n");
    const byHand = await started([CHANGED], { push: false });
    await byHand.sync.cycle();
    expect(byHand.calls.find((c) => c.startsWith("commit"))).toContain("vault sync: 2 files changed\n\nEdits made outside the engine (by hand, other tools).");
    const many = await started([CHANGED], { push: false });
    for (let i = 1; i <= 53; i++) many.sync.noteOperation({ summary: `insert_row ${i}` });
    await many.sync.cycle();
    const msg = many.calls.find((c) => c.startsWith("commit"))!;
    expect(msg).toContain("- insert_row 50\n- … and 3 more\n");
    expect(msg).not.toContain("insert_row 51");
  });

  it("nothing to commit is not an error", async () => {
    const { sync } = await started([CHANGED, ["commit", { code: 1, stdout: "nothing to commit, working tree clean" }]], { push: false });
    await sync.cycle();
    expect(sync.status.blocked).toBeUndefined();
  });

  it.each([
    ["git add", [CHANGED, ["add -A", { code: 128, stderr: "fatal: Unable to create '.git/index.lock': File exists.\n" }]], "git add: fatal: Unable to create '.git/index.lock': File exists."],
    ["git commit (stderr)", [CHANGED, ["commit", { code: 1, stderr: "Author identity unknown" }]], "git commit: Author identity unknown"],
    ["git commit (stdout only)", [CHANGED, ["commit", { code: 1, stdout: "pre-commit hook failed" }]], "git commit: pre-commit hook failed"],
    ["git fetch", [["fetch", { code: 128, stderr: "fatal: unable to access 'https://git.example.com/vault.git/'\n" }]], "git fetch: fatal: unable to access 'https://git.example.com/vault.git/'"],
    ["git push", [["rev-list --left-right", { stdout: "2\t0" }], ["rev-list --count", { stdout: "2" }], ["push", { code: 1, stderr: "! [rejected] main -> main (fetch first)" }]], "git push: ! [rejected] main -> main (fetch first)"],
  ] as [string, [string, Reply][], string][])("a failing %s stops the cycle and says why", async (_what, replies, blocked) => {
    const { sync, logs } = await started(replies);
    await sync.cycle();
    expect(sync.status.blocked).toBe(blocked);
    expect(logs.at(-1)).toEqual(["WARN", "datanotes git sync failed", { error: blocked }]);
  });

  it("a branch without upstream is not pushed, and says how to fix it", async () => {
    const { sync, calls } = await started([["rev-parse --abbrev-ref", { code: 128, stderr: "fatal: no upstream configured" }]]);
    await sync.cycle();
    expect(sync.status.blocked).toBe("the branch has no upstream (git push -u once)");
    expect(calls).not.toContain("fetch -q");
  });

  it("a pull conflict aborts the rebase and stops the sync until someone resolves it", async () => {
    const { sync, calls, logs } = await started([["rev-list --left-right", { stdout: "1\t2" }], ["pull", { code: 1, stderr: "CONFLICT (content): Merge conflict in Notes/a.md\nerror: could not apply 1a2b3c" }]]);
    await sync.cycle();
    expect(calls).toContain("rebase --abort");
    expect(calls).not.toContain("push -q");
    expect(sync.status.blocked).toBe("pull conflict: CONFLICT (content): Merge conflict in Notes/a.md — resolve it in the repository");
    expect(logs.at(-1)![1]).toBe("datanotes git sync stopped by a pull conflict");
  });

  it("a pull whose autostash conflicts (git exits 0) stops the cycle before pushing, and says which files", async () => {
    const UNMERGED = ["100644 1a2b 1\tNotes/a.md", "100644 3c4d 2\tNotes/a.md", "100644 5e6f 3\tNotes/a.md", "100644 7a8b 2\tNotes/b.md", ""].join("\n");
    let unmerged = "";
    let pulls = 0;
    const { sync, calls, logs } = await started([
      CHANGED,
      ["rev-list --left-right", { stdout: "1\t2" }],
      ["pull", () => ((unmerged = pulls++ ? "" : UNMERGED), { stderr: "Applying autostash resulted in conflicts.\nYour changes are safe in the stash.\n" })],
      ["ls-files -u", () => ({ stdout: unmerged })],
      ["rev-list --count", { stdout: "1" }],
    ]);
    await sync.cycle();
    expect(calls).not.toContain("push -q");
    expect(calls).not.toContain("rebase --abort");
    const blocked = "pull conflict: 2 files in conflict (Notes/a.md, Notes/b.md) — resolve them in the repository, git add them, then git stash drop if git kept an autostash";
    expect(sync.status.blocked).toBe(blocked);
    expect(logs.at(-1)).toEqual(["WARN", "datanotes git sync stopped by files in conflict", { files: ["Notes/a.md", "Notes/b.md"] }]);
    // the next cycle commits nothing while the files are in conflict
    calls.length = 0;
    await sync.cycle();
    expect(calls.some((c) => /^(add|commit|pull|push)\b/.test(c))).toBe(false);
    expect(sync.status.blocked).toBe(blocked);
    // resolved: the sync goes on
    unmerged = "";
    await sync.cycle();
    expect(calls.some((c) => c.startsWith("add"))).toBe(true);
    expect(calls).toContain("push -q");
    expect(sync.status.blocked).toBeUndefined();
  });

  it("files in conflict: more than five are counted, and a failing git ls-files stops the cycle", async () => {
    const many = Array.from({ length: 7 }, (_, i) => `100644 1a2b 2\tNotes/n${i}.md`).join("\n");
    const { sync } = await started([["ls-files -u", { stdout: many }]]);
    await sync.cycle();
    expect(sync.status.blocked).toMatch(/^pull conflict: 7 files in conflict \(Notes\/n0\.md, Notes\/n1\.md, Notes\/n2\.md, Notes\/n3\.md, Notes\/n4\.md and 2 more\)/);
    const failing = await started([["ls-files -u", { code: 128, stderr: "fatal: index file corrupt" }]]);
    await failing.sync.cycle();
    expect(failing.sync.status.blocked).toBe("git ls-files: fatal: index file corrupt");
  });

  it("behind only: pulls, and pushes nothing when nothing is left ahead; the next good cycle clears the block", async () => {
    let upstream: Reply = { code: 128 };
    const { sync, calls } = await started([["rev-parse --abbrev-ref", () => upstream], ["rev-list --left-right", { stdout: "0\t3" }], ["rev-list --count", { stdout: "0" }]]);
    await sync.cycle();
    expect(sync.status.blocked).toBe("the branch has no upstream (git push -u once)");
    upstream = { stdout: "origin/main" };
    await sync.cycle();
    expect(calls).toContain("pull -q --rebase --autostash");
    expect(calls).not.toContain("push -q");
    expect(sync.status.blocked).toBeUndefined();
  });

  it("does not touch a repository with a rebase or merge in progress", async () => {
    const repo = repoDir();
    fs.mkdirSync(path.join(repo, ".git", "rebase-merge"), { recursive: true });
    const g = fakeGit([["rev-parse --git-path rebase-merge", { stdout: ".git/rebase-merge\n" }]], repo);
    const sync = new GitSync({ vault: repo, run: g.run });
    await sync.start();
    sync.stop();
    await sync.cycle();
    expect(sync.status.blocked).toBe("a rebase or merge is in progress in the vault repository");
    expect(g.calls.some((c) => c.startsWith("status"))).toBe(false);
  });

  it("leaves out of the pathspecs the excluded folders .gitignore already ignores (git refuses to name them)", async () => {
    const { sync, calls } = await started([["check-ignore -q --no-index Vault/.obsidian/", { code: 0 }], ["check-ignore -q --no-index Vault/.trash", { code: 0 }], ["check-ignore", { code: 1 }]], { push: false });
    // the vault is a folder of the repository
    (sync as unknown as { vaultRel: string }).vaultRel = "Vault";
    await sync.cycle();
    expect(calls.find((c) => c.startsWith("status"))).toBe("status --porcelain --untracked-files=all -- Vault/ :(exclude)Vault/.datanotes :(exclude,glob)Vault/**/.datanotes-rename-* :(exclude,glob)Vault/**/.datanotes-*.tmp");
  });

  it("two cycles asked at once run once", async () => {
    const { sync, calls } = await started([CHANGED], { push: false });
    await Promise.all([sync.cycle(), sync.cycle()]);
    expect(calls.filter((c) => c.startsWith("add"))).toHaveLength(1);
  });
});

describe("git sync: timing", () => {
  it("runs every interval, and a quiet time after the last engine write (each write restarts it)", async () => {
    vi.useFakeTimers();
    const repo = repoDir();
    const g = fakeGit([CHANGED], repo);
    const sync = new GitSync({ vault: repo, run: g.run, push: false, intervalMs: 60_000, quietMs: 5_000 });
    sync.noteOperation({ summary: "before start" }); // remembered, no timer yet
    expect(sync.status.pendingOperations).toBe(1);
    await sync.start();
    sync.noteOperation({ summary: "a" });
    await vi.advanceTimersByTimeAsync(4_000);
    sync.noteOperation({ summary: "b" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(g.calls.filter((c) => c.startsWith("commit"))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.calls.filter((c) => c.startsWith("commit"))).toHaveLength(1);
    expect(g.calls.find((c) => c.startsWith("commit"))).toContain("vault sync: 3 operations");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.calls.filter((c) => c.startsWith("commit"))).toHaveLength(2);
    sync.noteOperation({ summary: "c" });
    sync.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(g.calls.filter((c) => c.startsWith("commit"))).toHaveLength(2);
  });
});
