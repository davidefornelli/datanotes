/**
 * Git sync: the vault's own git repository kept committed and pushed by the service, as a backup
 * and as the way a copy elsewhere (a VPS, another machine) follows it. Git is transport only:
 * operations, undo and history stay in the engine's journal.
 *
 * A cycle runs every `intervalMs`, and `quietMs` after the last engine write:
 *   1. commit the vault's changes (all files under the vault folder except the excluded paths:
 *      `.obsidian/` and `.trash/` by default; the engine's store is outside the vault, and a
 *      Datanotes 2 store left in it, `.datanotes/`, is never committed, nor the engine's
 *      `.datanotes-*` temporary files) with a message listing the operations applied since the
 *      last commit and who made them;
 *   2. fetch; when the remote has new commits, `pull --rebase --autostash`. A conflict aborts the
 *      rebase and stops pushing until someone resolves it, so nothing is lost. The autostash keeps
 *      a pull possible while excluded files (`.obsidian/`) or files outside the vault are changed;
 *      when putting it back conflicts (git still exits 0), the files in conflict stop the sync
 *      the same way, and no cycle commits them until someone resolves them;
 *   3. push when ahead.
 *
 * Git runs as the user running the service (its identity and SSH keys), never prompting, and is
 * killed past its time limit (`runGit`): 60 s, 10 min for fetch, pull and push. It runs from its
 * absolute path on PATH (`gitExecutable`), never from the vault folder.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { messageOf } from "../core/message";

/** How a git command runs: a longer or shorter time limit, and a signal that ends it at once. */
export interface GitRunOptions {
  /** Milliseconds before git is killed (default: {@link gitTimeoutMs}). */
  timeoutMs?: number;
  /** Aborted: git is killed, and the command fails. */
  signal?: AbortSignal;
}

export type GitRunner = (args: string[], cwd: string, options?: GitRunOptions) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The commands that talk to a remote (and may wait on the network). */
const NETWORK = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);

/** Whether a git command talks to a remote (and may wait on the network). */
export function isNetworkGit(args: readonly string[]): boolean {
  return NETWORK.has(gitSubcommand(args));
}

/** A local command's time limit: 60 s. */
export const LOCAL_TIMEOUT_MS = 60_000;

/** A network command's time limit: 10 min, or `DATANOTES_GIT_NETWORK_TIMEOUT_S` seconds. */
export const NETWORK_TIMEOUT_MS = 10 * 60_000;

/** The exit code of a git killed by its time limit or by a stop (as `timeout(1)` reports it). */
export const KILLED_CODE = 124;

/** The git subcommand of an argument list (after `-c x=y`, `-C dir` and the other global options). */
export function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" || a === "-C") i++;
    else if (!a.startsWith("-")) return a;
  }
  return "";
}

/** The time limit of a git command: network commands get longer. */
export function gitTimeoutMs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  if (!isNetworkGit(args)) return LOCAL_TIMEOUT_MS;
  const s = Number(env.DATANOTES_GIT_NETWORK_TIMEOUT_S);
  return Number.isFinite(s) && s > 0 ? s * 1000 : NETWORK_TIMEOUT_MS;
}

/**
 * The environment git runs in: never a prompt, since nobody is there to answer one. No username or
 * password asked on a terminal, no Git Credential Manager window, and SSH in batch mode, unless
 * the user chose an SSH command (`GIT_SSH_COMMAND`, `GIT_SSH`, or `core.sshCommand` in git's config:
 * `sshCommand` says so).
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env, sshCommand = false): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !sshCommand) out.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return out;
}

/** End a process and the ones it started (git starts ssh, a credential helper). */
function killTree(pid: number | undefined, child: ChildProcess): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    } catch {
      child.kill();
    }
  } else child.kill("SIGKILL");
}

/** Per folder: whether git's config names an SSH command (asked once). */
const sshCommandSet = new Map<string, Promise<boolean>>();

function hasSshCommand(cwd: string): Promise<boolean> {
  let known = sshCommandSet.get(cwd);
  if (!known) {
    known = spawnGit(["config", "--get", "core.sshCommand"], cwd, { timeoutMs: LOCAL_TIMEOUT_MS }, gitEnv(process.env, true)).then((r) => r.code === 0 && r.stdout.trim() !== "");
    sshCommandSet.set(cwd, known);
  }
  return known;
}

/** Forget what {@link runGit} knows of a folder's `core.sshCommand`: call it after setting one. */
export function forgetSshCommand(cwd: string): void {
  sshCommandSet.delete(cwd);
}

function spawnGit(args: string[], cwd: string, o: GitRunOptions, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const sub = gitSubcommand(args);
    if (o.signal?.aborted) {
      resolve({ code: KILLED_CODE, stdout: "", stderr: `git ${sub} not run: stopped` });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    let child: ChildProcess;
    const finish = (r: { code: number; stdout: string; stderr: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    // killed: answered at once, without waiting for the pipes a child of git may still hold open
    const kill = (why: string) => {
      killTree(child.pid, child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ code: KILLED_CODE, stdout: out, stderr: `${err.trim() ? `${err.trim()}\n` : ""}git ${sub} ${why}` });
    };
    const ms = o.timeoutMs ?? gitTimeoutMs(args);
    const timer = setTimeout(() => kill(`timed out after ${Math.round(ms / 1000)} s and was stopped`), ms);
    const onAbort = () => kill("stopped: the engine is stopping");
    const exe = gitExecutable(env);
    // a bare name on Windows would be looked up in the vault folder first: never run that
    if (exe === "git" && process.platform === "win32") {
      finish({ code: 1, stdout: "", stderr: "git was not found in any folder of PATH: install Git for Windows, or add its cmd folder to PATH" });
      return;
    }
    try {
      child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ code: 1, stdout: "", stderr: messageOf(e) });
      return;
    }
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (err.length < MAX_OUTPUT) err += d.toString();
    });
    child.on("error", (e) => finish({ code: 1, stdout: out, stderr: `${err}${messageOf(e)}` }));
    child.on("close", (code) => finish({ code: typeof code === "number" ? code : 1, stdout: out, stderr: err }));
  });
}

/** {@link gitExecutable}'s last answer, for the PATH it was found on. */
let foundGit: { key: string; file: string } | null = null;

/**
 * git's absolute path, looked up on PATH alone. A bare `git` given to spawn would be looked up in
 * the current folder first on Windows, and git runs with the vault as its current folder: a
 * `git.exe` in the vault would run. A relative PATH entry is skipped for the same reason. Found once
 * per PATH value; when git is on no PATH folder, `git` (spawn then fails, or on Windows a refusal).
 */
export function gitExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const name = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const pathValue = (name ? env[name] : undefined) ?? "";
  const key = `${platform}|${pathValue}`;
  if (foundGit?.key === key) return foundGit.file;
  const win = platform === "win32";
  const names = win ? ["git.exe", "git.com"] : ["git"];
  let file = "git";
  search: for (const raw of pathValue.split(win ? ";" : ":")) {
    const dir = win ? raw.trim().replace(/^"(.*)"$/, "$1") : raw;
    if (!dir || !(win ? path.win32.isAbsolute(dir) : path.posix.isAbsolute(dir))) continue;
    for (const n of names) {
      const candidate = path.join(dir, n);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!win) fs.accessSync(candidate, fs.constants.X_OK);
        file = candidate;
        break search;
      } catch {
        // not there, or not runnable: the next folder
      }
    }
  }
  foundGit = { key, file };
  return file;
}

/** The most output kept of one git command. */
const MAX_OUTPUT = 32 * 1024 * 1024;

/** The path with symlinks and Windows short names resolved; as given when it does not exist. */
export function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Run git, never waiting on a person: no prompt (see {@link gitEnv}), and a time limit after which
 * git and what it started are killed (60 s, 10 min for a command that talks to a remote). A git
 * killed fails with code {@link KILLED_CODE} and says why in `stderr`.
 */
export const runGit: GitRunner = async (args, cwd, options = {}) => {
  const ssh = isNetworkGit(args) && !process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH ? await hasSshCommand(cwd) : false;
  return spawnGit(args, cwd, options, gitEnv(process.env, ssh));
};

export interface GitSyncOptions {
  /** The vault folder (inside a git working tree). */
  vault: string;
  intervalMs?: number;
  /** Quiet time after the last engine write before a cycle. */
  quietMs?: number;
  /** Vault-relative folders never committed, whatever .gitignore says (the service adds the engine's store). */
  exclude?: string[];
  push?: boolean;
  run?: GitRunner;
  log?(level: "INFO" | "WARN" | "ERROR", message: string, attributes?: Record<string, unknown>): void;
}

export interface GitSyncStatus {
  enabled: boolean;
  repo?: string;
  lastRun?: string;
  lastCommit?: string;
  lastPush?: string;
  /** Set while a pull conflict (or another failure) stops the sync; cleared by the next good cycle. */
  blocked?: string;
  pendingOperations: number;
}

interface Operation {
  summary: string;
  actor?: string;
}

/**
 * Vault folders git sync never commits, whatever `exclude` says: `.datanotes/` is the store of a
 * Datanotes 2 vault, with the owner token in `service.json`.
 */
export const ENGINE_FOLDERS = [".datanotes"] as const;

/** The unmerged paths of `git ls-files -u` output (one line per stage: each path once). */
function unmergedPaths(lsFiles: string): string[] {
  const paths = lsFiles
    .split("\n")
    .map((l) => l.split("\t").slice(1).join("\t"))
    .filter(Boolean);
  return paths.filter((p, i) => paths.indexOf(p) === i);
}

export class GitSync {
  private repo: string | null = null;
  private vaultRel = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private ops: Operation[] = [];
  readonly status: GitSyncStatus = { enabled: false, pendingOperations: 0 };
  /** True while a pull runs. */
  pulling = false;
  private readonly run: GitRunner;

  constructor(private readonly o: GitSyncOptions) {
    this.run = o.run ?? runGit;
  }

  private log(level: "INFO" | "WARN" | "ERROR", message: string, attributes: Record<string, unknown> = {}): void {
    this.o.log?.(level, message, attributes);
  }

  private async git(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.run(args, this.repo ?? this.o.vault, { signal: this.killer.signal });
  }

  /** Aborted by {@link kill}: the git still running is killed. */
  private readonly killer = new AbortController();

  /** Kill the git still running (a stop out of time): its cycle fails, the next start syncs again. */
  kill(): void {
    this.killer.abort();
  }

  /** Find the repository; false when the vault is not in one. */
  async start(): Promise<boolean> {
    const top = await this.run(["rev-parse", "--show-toplevel"], this.o.vault);
    if (top.code !== 0) {
      this.log("WARN", "datanotes git sync: the vault is not in a git repository", { vault: this.o.vault });
      return false;
    }
    // git reports the real path; the vault path may go through a symlink (macOS /var → /private/var)
    // or a Windows 8.3 short name, so both are compared as real paths
    this.repo = realPath(path.resolve(top.stdout.trim()));
    this.vaultRel = path.relative(this.repo, realPath(path.resolve(this.o.vault))).split(path.sep).join("/");
    this.status.enabled = true;
    this.status.repo = this.repo;
    // the last commit before this run, until this run commits (none in a new repository)
    const head = await this.git("rev-parse", "--short", "--verify", "-q", "HEAD");
    if (head.code === 0 && head.stdout.trim()) this.status.lastCommit = head.stdout.trim();
    await this.warnEngineFolders();
    this.timer = setInterval(() => void this.cycle(), this.o.intervalMs ?? 10 * 60_000);
    this.log("INFO", "datanotes git sync started", { repo: this.repo, vault_path: this.vaultRel || ".", interval_ms: this.o.intervalMs ?? 600_000 });
    return true;
  }

  /**
   * A Datanotes 2 store left in the vault (`.datanotes/`, with the owner token): never committed,
   * and said once, with how to keep it out of the repository for good.
   */
  private async warnEngineFolders(): Promise<void> {
    for (const folder of ENGINE_FOLDERS) {
      if (!fs.existsSync(path.join(this.o.vault, folder))) continue;
      const rel = `${this.vaultRel ? `${this.vaultRel}/` : ""}${folder}`;
      const tracked = (await this.git("ls-files", "--", rel)).stdout.trim() !== "";
      this.log("WARN", `datanotes git sync: the vault holds ${folder}/, a Datanotes 2 store with the owner token; git sync never commits it`, {
        path: rel,
        tracked,
        hint: tracked
          ? `It is already in the repository: run git rm -r --cached ${rel}, add ${folder}/ to .gitignore, commit, and change the owner token.`
          : `Add ${folder}/ to .gitignore, or move the folder out of the vault.`,
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.quiet) clearTimeout(this.quiet);
    this.timer = this.quiet = null;
    this.status.enabled = false;
  }

  /** An engine operation was applied: remember it for the commit message, sync after a quiet time. */
  noteOperation(op: Operation): void {
    this.ops.push(op);
    this.status.pendingOperations = this.ops.length;
    if (!this.status.enabled) return;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => void this.cycle(), this.o.quietMs ?? 60_000);
  }

  /**
   * The vault folder minus the excluded paths. A path .gitignore already ignores is left out of the
   * pathspecs (git refuses to name an ignored path, even to exclude it).
   */
  private async pathspecs(): Promise<string[]> {
    const base = this.vaultRel ? `${this.vaultRel}/` : "";
    const out = ["--", base || "."];
    const excluded = [...(this.o.exclude ?? [".obsidian", ".trash"]), ...ENGINE_FOLDERS];
    for (const e of excluded.filter((x, i) => excluded.indexOf(x) === i)) {
      const rel = `${base}${e.replace(/^\/+|\/+$/g, "")}`;
      const ignored = await this.git("check-ignore", "-q", "--no-index", rel);
      const dirIgnored = ignored.code === 0 ? ignored : await this.git("check-ignore", "-q", "--no-index", `${rel}/`);
      if (dirIgnored.code !== 0) out.push(`:(exclude)${rel}`);
    }
    // a file on its way to a new name in case only (node-app.ts): never committed
    out.push(`:(exclude,glob)${base}**/.datanotes-rename-*`);
    // a file the engine is writing, before it takes its name (node-app.ts): never committed
    out.push(`:(exclude,glob)${base}**/.datanotes-*.tmp`);
    return out;
  }

  private message(files: number): string {
    const ops = this.ops;
    const head = ops.length ? `vault sync: ${ops.length} operation${ops.length === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}` : `vault sync: ${files} file${files === 1 ? "" : "s"} changed`;
    const lines = ops.slice(0, 50).map((o) => `- ${o.summary}${o.actor ? ` (${o.actor})` : ""}`);
    if (ops.length > 50) lines.push(`- … and ${ops.length - 50} more`);
    return [head, "", ...(lines.length ? lines : ["Edits made outside the engine (by hand, other tools)."]), "", "Synced-by: datanotes"].join("\n");
  }

  /** One sync cycle (cycles never overlap). */
  cycle(): Promise<void> {
    if (!this.repo) return Promise.resolve();
    this.running ??= this.doCycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * Whether the repository has unmerged paths (`git ls-files -u`): the sync is then blocked, and
   * says which files and how to resolve them, until someone does.
   */
  private async blockedByConflicts(): Promise<boolean> {
    const ls = await this.git("ls-files", "-u");
    if (ls.code !== 0) throw new Error(`git ls-files: ${ls.stderr.trim()}`);
    const files = unmergedPaths(ls.stdout);
    if (!files.length) return false;
    const shown = files.length > 5 ? `${files.slice(0, 5).join(", ")} and ${files.length - 5} more` : files.join(", ");
    this.status.blocked = `pull conflict: ${files.length} file${files.length === 1 ? "" : "s"} in conflict (${shown}) — resolve them in the repository, git add them, then git stash drop if git kept an autostash`;
    this.log("WARN", "datanotes git sync stopped by files in conflict", { files: files.slice(0, 50) });
    return true;
  }

  private async doCycle(): Promise<void> {
    this.status.lastRun = new Date().toISOString();
    try {
      // a rebase someone left half-done: do not touch the repository
      for (const dir of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
        const p = (await this.git("rev-parse", "--git-path", dir)).stdout.trim();
        if (p && fs.existsSync(path.resolve(this.repo!, p))) {
          this.status.blocked = "a rebase or merge is in progress in the vault repository";
          return;
        }
      }
      // files left in conflict (a pull's autostash): committing them would push the markers
      if (await this.blockedByConflicts()) return;
      const specs = await this.pathspecs();
      const changed = await this.git("status", "--porcelain", "--untracked-files=all", ...specs);
      const files = changed.stdout.split("\n").filter(Boolean).length;
      if (files > 0) {
        const add = await this.git("add", "-A", ...specs);
        if (add.code !== 0) throw new Error(`git add: ${add.stderr.trim()}`);
        // only the vault's paths: whatever else someone staged stays staged
        const commit = await this.git("commit", "-q", "-m", this.message(files), ...specs);
        if (commit.code !== 0 && !/nothing to commit/.test(commit.stdout + commit.stderr)) throw new Error(`git commit: ${commit.stderr.trim() || commit.stdout.trim()}`);
        const head = await this.git("rev-parse", "--short", "HEAD");
        this.status.lastCommit = head.stdout.trim();
        this.log("INFO", "datanotes git sync committed", { commit: this.status.lastCommit, files, operations: this.ops.length });
        this.ops = [];
        this.status.pendingOperations = 0;
      } else {
        // operations whose changes cancel out (an edit undone, a rename and back) leave nothing to
        // commit: they are not pending any more, and must not name the next commit
        this.ops = [];
        this.status.pendingOperations = 0;
      }
      if (this.o.push === false) {
        delete this.status.blocked;
        return;
      }
      const upstream = await this.git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
      if (upstream.code !== 0) {
        this.status.blocked = "the branch has no upstream (git push -u once)";
        return;
      }
      const fetch = await this.git("fetch", "-q");
      if (fetch.code !== 0) throw new Error(`git fetch: ${fetch.stderr.trim()}`);
      const counts = await this.git("rev-list", "--left-right", "--count", "HEAD...@{u}");
      const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number) as [number, number];
      if (behind > 0) {
        this.pulling = true; // the vault's files change under the engine (hand-move repairs wait)
        const pull = await this.git("pull", "-q", "--rebase", "--autostash").finally(() => {
          this.pulling = false;
        });
        if (pull.code !== 0) {
          await this.git("rebase", "--abort");
          // a pull killed (time limit) is a failure, not a conflict: the next cycle tries again
          if (pull.code === KILLED_CODE) throw new Error(`git pull: ${pull.stderr.trim()}`);
          this.status.blocked = `pull conflict: ${pull.stderr.trim().split("\n")[0]!} — resolve it in the repository`;
          this.log("WARN", "datanotes git sync stopped by a pull conflict", { error: pull.stderr.trim().slice(0, 500) });
          return;
        }
        // the rebase went through, but putting back the autostash may have conflicted (git still
        // exits 0): the files hold conflict markers, and the cycle stops before pushing anything
        if (await this.blockedByConflicts()) return;
      }
      if (ahead > 0 || behind > 0) {
        const again = await this.git("rev-list", "--count", "@{u}..HEAD");
        if (Number(again.stdout.trim()) > 0) {
          const push = await this.git("push", "-q");
          if (push.code !== 0) throw new Error(`git push: ${push.stderr.trim()}`);
          this.status.lastPush = new Date().toISOString();
          this.log("INFO", "datanotes git sync pushed", { commits: Number(again.stdout.trim()) });
        }
      }
      delete this.status.blocked;
    } catch (e) {
      this.status.blocked = messageOf(e);
      this.log("WARN", "datanotes git sync failed", { error: this.status.blocked });
    }
  }
}
