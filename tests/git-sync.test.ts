import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitSync, gitExecutable, realPath, runGit, type GitRunner } from "../src/node/git-sync";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

/** A bare remote and two clones: `a` holds the vault in `Vault/`, `b` plays another machine. */
function repos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "git-sync-"));
  const remote = path.join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const clone = (name: string) => {
    const dir = path.join(base, name);
    // Git for Windows sets core.autocrlf=true system-wide: checked-out files would get CRLF endings
    git(base, "clone", "-q", "-c", "core.autocrlf=false", remote, dir);
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "checkout", "-q", "-B", "main");
    return dir;
  };
  const a = clone("a");
  write(a, "Vault/note.md", "one\n");
  write(a, "README.md", "repo\n");
  git(a, "add", "-A");
  git(a, "commit", "-q", "-m", "init");
  git(a, "push", "-q", "-u", "origin", "main");
  const b = clone("b");
  git(b, "pull", "-q", "origin", "main");
  git(b, "branch", "-q", "--set-upstream-to=origin/main");
  return { a, b, vault: path.join(a, "Vault"), remote };
}

// every test runs a few dozen git processes: slow on Windows under load
describe("git sync", { timeout: 30_000 }, () => {
  it("commits the vault's changes with the operations, leaves .obsidian and other staged paths alone, and pushes", async () => {
    const { a, vault, remote } = repos();
    const sync = new GitSync({ vault, intervalMs: 3_600_000 });
    expect(await sync.start()).toBe(true);
    write(vault, "note.md", "two\n");
    write(vault, "Datanotes/row.md", "row\n");
    write(vault, ".obsidian/workspace.json", "{}");
    write(a, "README.md", "staged by someone\n");
    git(a, "add", "README.md");
    sync.noteOperation({ summary: "insert into task", actor: "claude-code" });
    await sync.cycle();
    sync.stop();
    expect(sync.status.blocked).toBeUndefined();
    const msg = git(remote, "log", "-1", "--format=%B", "main");
    expect(msg).toMatch(/^vault sync: 1 operation, 2 files/);
    expect(msg).toContain("- insert into task (claude-code)");
    expect(git(remote, "show", "--name-only", "--format=", "main").split("\n").sort()).toEqual(["Vault/Datanotes/row.md", "Vault/note.md"]);
    expect(git(a, "status", "--porcelain")).toContain("M  README.md"); // still staged, not committed
    expect(git(a, "status", "--porcelain", "--untracked-files=all")).toContain("Vault/.obsidian/workspace.json");
    expect(sync.status.pendingOperations).toBe(0);
  });

  it("shows the last commit from the start, and drops operations whose changes cancel out", async () => {
    const { a, vault, remote } = repos();
    const sync = new GitSync({ vault, intervalMs: 3_600_000 });
    expect(await sync.start()).toBe(true);
    // the repository's last commit, before this run commits anything
    expect(sync.status.lastCommit).toBe(git(a, "rev-parse", "--short", "HEAD"));
    // a rename and back: two operations, nothing to commit
    fs.renameSync(path.join(vault, "note.md"), path.join(vault, "renamed.md"));
    sync.noteOperation({ summary: "rename note" });
    fs.renameSync(path.join(vault, "renamed.md"), path.join(vault, "note.md"));
    sync.noteOperation({ summary: "rename note back" });
    await sync.cycle();
    expect(sync.status.pendingOperations).toBe(0);
    // the next commit names only its own operation
    write(vault, "note.md", "three\n");
    sync.noteOperation({ summary: "update note" });
    await sync.cycle();
    sync.stop();
    const msg = git(remote, "log", "-1", "--format=%B", "main");
    expect(msg).toMatch(/^vault sync: 1 operation, 1 file/);
    expect(msg).not.toContain("rename note");
  });

  // macOS: os.tmpdir() is /var/folders/…, a symlink to /private/var/…, and git reports the real path.
  it.skipIf(process.platform === "win32")("commits when the vault is reached through a symlink", async () => {
    const { a, remote } = repos();
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "git-sync-link-")), "vault");
    fs.symlinkSync(path.join(a, "Vault"), link, "dir");
    const sync = new GitSync({ vault: link, intervalMs: 3_600_000 });
    expect(await sync.start()).toBe(true);
    write(link, "note.md", "via the link\n");
    await sync.cycle();
    sync.stop();
    expect(sync.status.blocked).toBeUndefined();
    expect(git(remote, "show", "--name-only", "--format=", "main").split("\n")).toEqual(["Vault/note.md"]);
  });

  it("never commits a file on its way to a new name in case only (.datanotes-rename-*)", async () => {
    const { remote, vault } = repos();
    const sync = new GitSync({ vault, intervalMs: 3_600_000 });
    expect(await sync.start()).toBe(true);
    write(vault, ".datanotes-rename-7-1--Note.md", "between two renames\n");
    write(vault, "Sub/.datanotes-rename-7-2--Plan.md", "between two renames\n");
    write(vault, "note.md", "two\n");
    await sync.cycle();
    sync.stop();
    expect(sync.status.blocked).toBeUndefined();
    expect(git(remote, "show", "--name-only", "--format=", "main").split("\n")).toEqual(["Vault/note.md"]);
  });

  it("realPath resolves an existing path and gives back one that does not exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-sync-real-"));
    expect(realPath(dir)).toBe(fs.realpathSync.native(dir));
    const missing = path.join(dir, "missing");
    expect(realPath(missing)).toBe(missing);
  });

  it("pulls new remote commits before pushing", async () => {
    const { b, vault, remote } = repos();
    write(b, "Vault/other.md", "from b\n");
    git(b, "add", "-A");
    git(b, "commit", "-q", "-m", "from b");
    git(b, "push", "-q");
    const sync = new GitSync({ vault });
    await sync.start();
    write(vault, "note.md", "mine\n");
    await sync.cycle();
    sync.stop();
    expect(sync.status.blocked).toBeUndefined();
    expect(fs.readFileSync(path.join(vault, "other.md"), "utf8")).toBe("from b\n");
    expect(git(remote, "log", "--format=%s", "main").split("\n").slice(0, 2)).toEqual(["vault sync: 1 file changed", "from b"]);
  });

  it("stops on a conflict without losing anything, and does nothing outside a repository", async () => {
    const { b, vault, a } = repos();
    write(b, "Vault/note.md", "theirs\n");
    git(b, "commit", "-q", "-am", "theirs");
    git(b, "push", "-q");
    const sync = new GitSync({ vault });
    await sync.start();
    write(vault, "note.md", "ours\n");
    await sync.cycle();
    sync.stop();
    expect(sync.status.blocked).toMatch(/pull conflict/);
    expect(fs.readFileSync(path.join(vault, "note.md"), "utf8")).toBe("ours\n"); // our commit is kept
    expect(git(a, "log", "-1", "--format=%s")).toBe("vault sync: 1 file changed");
    expect(fs.existsSync(path.join(a, ".git", "rebase-merge"))).toBe(false);
    const outside = new GitSync({ vault: fs.mkdtempSync(path.join(os.tmpdir(), "no-repo-")) });
    expect(await outside.start()).toBe(false);
  });

  it("never commits the .datanotes/ store of a Datanotes 2 vault, nor the engine's .datanotes-*.tmp files, and warns once", async () => {
    const { remote, vault } = repos();
    // a vault from Datanotes 2: the store, with the owner token, is a folder of the vault
    write(vault, ".datanotes/service.json", '{"ownerToken":"dn_secret"}\n');
    write(vault, ".datanotes/journal/0001.json", "{}\n");
    write(vault, ".datanotes-7-1700000000000-1.tmp", "half written\n");
    write(vault, "Sub/.datanotes-7-1700000000000-2.tmp", "half written\n");
    write(vault, "note.md", "two\n");
    const logs: [string, string, Record<string, unknown> | undefined][] = [];
    // the service passes its own exclude list: the store is left out all the same
    const sync = new GitSync({ vault, intervalMs: 3_600_000, exclude: [".obsidian", ".trash"], log: (level, message, attrs) => void logs.push([level, message, attrs]) });
    expect(await sync.start()).toBe(true);
    await sync.cycle();
    sync.stop();
    expect(sync.status.blocked).toBeUndefined();
    expect(git(remote, "show", "--name-only", "--format=", "main").split("\n")).toEqual(["Vault/note.md"]);
    expect(git(remote, "log", "--all", "--name-only", "--format=")).not.toContain(".datanotes");
    const warn = logs.find(([, message]) => message.includes(".datanotes/"));
    expect(warn?.[0]).toBe("WARN");
    expect(warn?.[2]).toMatchObject({ path: "Vault/.datanotes", tracked: false, hint: "Add .datanotes/ to .gitignore, or move the folder out of the vault." });
  });

  it("says when the Datanotes 2 store is already in the repository, and how to take it out", async () => {
    const { a, vault } = repos();
    write(vault, ".datanotes/service.json", '{"ownerToken":"dn_secret"}\n');
    git(a, "add", "-A");
    git(a, "commit", "-q", "-m", "a store committed by hand");
    const logs: [string, string, Record<string, unknown> | undefined][] = [];
    const sync = new GitSync({ vault, intervalMs: 3_600_000, log: (level, message, attrs) => void logs.push([level, message, attrs]) });
    expect(await sync.start()).toBe(true);
    sync.stop();
    const warn = logs.find(([, message]) => message.includes(".datanotes/"));
    expect(warn?.[2]).toMatchObject({ tracked: true });
    expect(String(warn?.[2]?.hint)).toContain("git rm -r --cached Vault/.datanotes");
  });

  it("stops when a pull's autostash conflicts, and never commits or pushes the conflict markers", async () => {
    const { a, b, vault, remote } = repos();
    write(b, "Vault/note.md", "theirs\n");
    git(b, "commit", "-q", "-am", "theirs");
    git(b, "push", "-q");
    // the engine writes the note after the commit, while the pull runs: git stashes it, rebases,
    // and putting the stash back conflicts (git exits 0)
    const run: GitRunner = async (args, cwd, o) => {
      if (args[0] === "pull") write(vault, "note.md", "ours\n");
      return runGit(args, cwd, o);
    };
    const sync = new GitSync({ vault, run, intervalMs: 3_600_000 });
    await sync.start();
    await sync.cycle();
    expect(sync.status.blocked).toMatch(/^pull conflict: 1 file in conflict \(Vault\/note\.md\)/);
    expect(fs.readFileSync(path.join(vault, "note.md"), "utf8")).toContain("<<<<<<<");
    // the next cycles commit nothing while the file is in conflict
    await sync.cycle();
    expect(sync.status.blocked).toMatch(/^pull conflict/);
    expect(git(remote, "show", "main:Vault/note.md")).toBe("theirs");
    expect(git(a, "log", "-1", "--format=%s")).toBe("theirs");
    // resolved by hand: the sync goes on
    write(vault, "note.md", "both\n");
    git(a, "add", "Vault/note.md");
    git(a, "stash", "drop", "-q");
    await sync.cycle();
    sync.stop();
    expect(sync.status.blocked).toBeUndefined();
    expect(git(remote, "show", "main:Vault/note.md")).toBe("both");
  });

  it.runIf(process.platform === "win32")("runs git from PATH, never a git.exe in the vault folder (Windows)", async () => {
    const { vault } = repos();
    // any program but git, named git.exe in the folder git runs in
    fs.copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), path.join(vault, "git.exe"));
    // without it, Windows looks for a bare program name in the current folder first
    const saved = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      const r = await runGit(["--version"], vault);
      expect(r.stdout).toMatch(/^git version /);
    } finally {
      if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
    }
    expect(path.isAbsolute(gitExecutable())).toBe(true);
    expect(path.dirname(gitExecutable()).toLowerCase()).not.toBe(vault.toLowerCase());
  });

  it("finds git on absolute PATH folders only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-sync-path-"));
    const win = process.platform === "win32";
    const name = win ? "git.exe" : "git";
    fs.writeFileSync(path.join(dir, name), "", { mode: 0o755 });
    const sep = win ? ";" : ":";
    expect(gitExecutable({ PATH: ["relative-folder", "", dir].join(sep) })).toBe(path.join(dir, name));
    // a relative entry would be the current folder: skipped
    expect(gitExecutable({ PATH: ["."].join(sep) })).toBe("git");
    expect(gitExecutable({})).toBe("git");
  });
});
