/**
 * Store backup: the engine's store (`<data home>/<database id>/`) kept as a git repository of its
 * own, committed on a regular schedule (every 60 s by default) and pushed to a private remote (a
 * GitHub repository, any git server). The store holds what the vault does not: the journal (undo),
 * the transaction logs (history, time travel, restores), the blobs they point to, the change feed
 * and the named tokens' hashes. With the vault's own git sync (git-sync.ts), a restore finds both at
 * the same moment.
 *
 * What is tracked is a fixed list (`.gitignore` written by the engine ignores everything else), so
 * a file the engine adds later, or a program drops in the store, is never pushed by surprise:
 *
 *   tracked      journal/, blobs/, transaction_log/ (and delta_log/ of older engines), changes/,
 *                database_moves.jsonl, tokens.json (SHA-256 hashes only, never a token)
 *   not tracked  settings.json (the owner token, settings), webhooks.json (the webhooks' secrets),
 *                engine.lock, store.json, migration.json (this machine's state), semantic/ and
 *                logs/ (rebuilt or rewritten by the engine), anything else
 *
 * Timing (`every`, the setting `storeBackupIntervalSeconds`, at least 10 s):
 *   - at each tick, nothing changed (`git status --porcelain` empty): nothing happens;
 *   - something changed: the backup waits until the engine is idle, no operation running and none
 *     for `quietMs` (3 s), then holds the engine's write lock (`withLogLock`, which every write of
 *     the journal, transaction logs and blobs takes, hand edits included) only for `git add -A` and
 *     `git commit`. An operation writes several files (a journal line, log versions, blobs): a
 *     commit between two operations is a consistent snapshot. Operations that arrive meanwhile wait;
 *   - the engine still busy when half the interval has passed: the next tick tries again. After
 *     `MAX_BUSY_TICKS` (5) busy ticks in a row, the next tick takes the lock anyway, at the first
 *     gap between two operations;
 *   - the push runs once the lock is released; a failed push is retried with backoff (the period,
 *     doubled at each failure, at most 30 min);
 *   - at start: a commit and push at once (after a forced stop, what the last run left
 *     uncommitted, once the git locks it left are removed); on stop: a last commit and push,
 *     whatever the backoff, within `stopTimeoutMs` (15 s): past it, git is killed;
 *   - under the lock, no automatic `git gc` (`-c gc.auto=0`); `git gc --auto` runs after the push;
 *   - a file over 95 MB (GitHub refuses files over 100 MB) stops the push, with a hint in the status.
 *
 * Git never prompts and has a time limit (`runGit` in git-sync.ts): a git killed is a failure.
 * `datanotes store backup` makes the first commit and push with {@link StoreBackup.once}: no stop
 * deadline, a long limit for the local steps (a large store's first commit takes minutes).
 *
 * Git runs as the user running the engine (its identity, credential helper and SSH keys), as in
 * git-sync.ts. The store's repository takes the `core.sshCommand` of the vault's repository when
 * it has none (Windows: OpenSSH and its agent, not Git's bundled ssh). Files are stored byte for byte (`.gitattributes`: `* -text`).
 */

import fs from "node:fs";
import path from "node:path";
import { guide, type Guidance } from "../core/hints";
import { messageOf } from "../core/message";
import { forgetSshCommand, isNetworkGit, NETWORK_TIMEOUT_MS, runGit, type GitRunner } from "./git-sync";

/** What the backup keeps: folders end with `/`. */
export const BACKUP_TRACKED = ["journal/", "blobs/", "transaction_log/", "changes/", "database_moves.jsonl", "tokens.json"] as const;

/** The store's `.gitignore`: everything ignored but the tracked list (and temporary files in it). */
export const STORE_GITIGNORE = [
  "# Written by the Datanotes engine (store backup): only the files that rebuild history and undo",
  "# are tracked. Secrets (settings.json, webhooks.json) and this machine's state stay out.",
  "/*",
  "!/.gitignore",
  "!/.gitattributes",
  ...BACKUP_TRACKED.map((t) => `!/${t}`),
  "*.tmp",
  "*.migrating",
  "",
].join("\n");

/** Files kept byte for byte: no line-ending conversion on any machine. */
export const STORE_GITATTRIBUTES = "* -text\n";

/** The commit trailer naming the database: a restore checks it against the vault's id. */
export const DATABASE_ID_TRAILER = "Database-Id";

const BRANCH = "main";

/** Lock files of the store's repository that a killed git leaves behind (relative to `.git/`). */
const STALE_LOCKS = ["index.lock", "HEAD.lock", `refs/heads/${BRANCH}.lock`, `refs/remotes/origin/${BRANCH}.lock`];

/**
 * Options of the git commands run under the engine's write lock: no automatic housekeeping (a
 * `git gc` of a large store takes minutes, and every operation would wait for it). It runs after
 * the push instead ({@link StoreBackup.housekeeping}).
 */
const NO_AUTO_GC = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];

/** The largest file the backup pushes: 95 MB, under GitHub's limit of 100 MB a file. */
export const MAX_FILE_BYTES = 95 * 1024 * 1024;

/** How long a stop waits for the last commit and push before it kills git (the stop of `datanotes stop` waits 60 s). */
export const STOP_TIMEOUT_MS = 15_000;

/** A remote URL without its credentials (`https://user:token@host/x` → `https://host/x`). */
export function redactRemote(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** A text (a git error) with every URL's credentials removed. */
function redactText(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]*@/gi, "$1");
}

async function git(run: GitRunner, cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(args, cwd);
}

function writeIfChanged(file: string, text: string): void {
  try {
    if (fs.readFileSync(file, "utf8") === text) return;
  } catch {
    // not there yet
  }
  fs.writeFileSync(file, text);
}

/** How the store's repository reaches its remote over SSH. */
export interface StoreRepoSsh {
  /** The vault: when the store's repository has no `core.sshCommand`, the one of the vault's repository is copied. */
  vault?: string;
  /** The SSH command to save as the store's `core.sshCommand`, whatever is there. */
  sshCommand?: string;
}

/**
 * The SSH command of the store's repository: `ssh.sshCommand` when given; otherwise, when the
 * store has none, the `core.sshCommand` of the vault's own repository (git sync's). On Windows the
 * user's key often lives in the Windows ssh-agent, which only Windows' OpenSSH
 * (`C:/Windows/System32/OpenSSH/ssh.exe`) reaches: Git's bundled ssh does not, and fails with
 * "Permission denied (publickey)".
 */
async function setSshCommand(store: string, ssh: StoreRepoSsh, run: GitRunner): Promise<void> {
  let command = ssh.sshCommand?.trim();
  if (!command) {
    if (!ssh.vault || (await git(run, store, "config", "--local", "--get", "core.sshCommand")).code === 0) return;
    // --local: the vault's repository only (a global setting already applies to the store)
    const inherited = fs.existsSync(ssh.vault) ? await git(run, ssh.vault, "config", "--local", "--get", "core.sshCommand") : null;
    command = inherited?.code === 0 ? inherited.stdout.trim() : "";
    if (!command) return;
  }
  const set = await git(run, store, "config", "core.sshCommand", command);
  if (set.code !== 0) throw new Error(`git config core.sshCommand: ${set.stderr.trim() || set.stdout.trim()}`);
  forgetSshCommand(store);
}

/**
 * Make the store a git repository ready to back up: `git init` (branch main) when it is not one,
 * the engine's `.gitignore` and `.gitattributes`, an identity when git has none, the SSH command
 * ({@link StoreRepoSsh}), and the remote `origin` set to `remote` (left as it is when `remote` is
 * null). Throws when git fails.
 */
export async function prepareStoreRepo(store: string, remote: string | null, run: GitRunner = runGit, ssh: StoreRepoSsh = {}): Promise<void> {
  fs.mkdirSync(store, { recursive: true });
  const fail = (what: string, r: { stderr: string; stdout: string }) => new Error(`git ${what}: ${redactText(r.stderr.trim() || r.stdout.trim())}`);
  if (!fs.existsSync(path.join(store, ".git"))) {
    const init = await git(run, store, "init", "-q");
    if (init.code !== 0) throw fail("init", init);
    await git(run, store, "symbolic-ref", "HEAD", `refs/heads/${BRANCH}`);
  }
  writeIfChanged(path.join(store, ".gitignore"), STORE_GITIGNORE);
  writeIfChanged(path.join(store, ".gitattributes"), STORE_GITATTRIBUTES);
  await git(run, store, "config", "core.autocrlf", "false");
  // Git for Windows refuses paths over 260 characters without it (the store sits under the user's
  // data folder, so a long user name or note name gets there); other systems ignore it
  await git(run, store, "config", "core.longpaths", "true");
  if ((await git(run, store, "config", "user.email")).code !== 0) {
    await git(run, store, "config", "user.name", "Datanotes");
    await git(run, store, "config", "user.email", "datanotes@localhost");
  }
  await setSshCommand(store, ssh, run);
  if (remote !== null) {
    const current = await git(run, store, "remote", "get-url", "origin");
    if (current.code !== 0) {
      const add = await git(run, store, "remote", "add", "origin", remote);
      if (add.code !== 0) throw fail("remote add", add);
    } else if (current.stdout.trim() !== remote) {
      const set = await git(run, store, "remote", "set-url", "origin", remote);
      if (set.code !== 0) throw fail("remote set-url", set);
    }
  }
}

/** The default cadence: every 60 s. */
export const DEFAULT_EVERY_MS = 60_000;

/** The shortest interval between two commits, in seconds. */
export const MIN_EVERY_S = 10;

/**
 * How long the engine must have been idle before a commit. Agents and scripts send operations in
 * bursts, with gaps well under a second; 3 s lets a burst end, and lets the change feed and the
 * tokens' last use (written right after an operation, outside the write lock) land, while keeping
 * the commit close to its tick.
 */
export const QUIET_MS = 3_000;

/** Busy ticks in a row after which the backup takes the lock at the next gap between two operations. */
export const MAX_BUSY_TICKS = 5;

/** Whole seconds of at least {@link MIN_EVERY_S}, as the setting, the flags and the CLI take them; null otherwise. */
export function parseEvery(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= MIN_EVERY_S ? n : null;
}

/** The engine as the backup sees it: whether it is writing, and its write lock. */
export interface BackupEngine {
  /** Whether an operation runs or waits for the write lock, and when the lock was last released (ms since the epoch). */
  activity(): { busy: boolean; lastEnd: number };
  /** Run `fn` holding the engine's write lock: operations that arrive meanwhile wait. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export interface StoreBackupOptions {
  /** The store folder. */
  store: string;
  /** The database's id: written in every commit (`Database-Id:`), checked by a restore. */
  databaseId: string;
  /** The remote to push to; null keeps the repository's `origin` (none: commits only). */
  remote?: string | null;
  /** Milliseconds between two ticks (default 60 s). */
  every?: number;
  /** The running engine; none (`datanotes store backup`, the engine stopped): commits at once. */
  engine?: BackupEngine;
  /** How long the engine must have been idle before a commit (default {@link QUIET_MS}). */
  quietMs?: number;
  /** The longest wait between two attempts of a failing push. */
  maxBackoffMs?: number;
  /** How long `stop()` waits for the last commit and push before it kills git (default {@link STOP_TIMEOUT_MS}). */
  stopTimeoutMs?: number;
  /** The largest file pushed (default {@link MAX_FILE_BYTES}). */
  maxFileBytes?: number;
  /** The vault: the store's repository takes the `core.sshCommand` of the vault's repository when it has none. */
  vault?: string;
  /** The SSH command saved as the store's `core.sshCommand` (`datanotes store backup --ssh-command`). */
  sshCommand?: string;
  /** The time limit of the git commands that stay local (`add`, `commit`…), default 60 s; pushes keep theirs. */
  localTimeoutMs?: number;
  run?: GitRunner;
  log?(level: "INFO" | "WARN" | "ERROR", message: string, attributes?: Record<string, unknown>): void;
}

export interface StoreBackupStatus {
  enabled: boolean;
  /** The seconds between two ticks. */
  every: number;
  /** The remote, without credentials; null when the repository has none (commits only). */
  remote: string | null;
  lastCommit?: string;
  lastCommitAt?: string;
  lastPush?: string;
  /** Operations applied since the last commit. */
  pendingOperations: number;
  /** Commits not pushed yet. */
  pendingCommits: number;
  /** The last failure (a push refused, git missing…), until a good push. */
  lastError?: string;
  /** When a failing push is tried again. */
  nextRetry?: string;
  /** How to fix what `lastError` says, when only a person can (a file too large to push). */
  hint?: string;
  /** Where to read more about it. */
  docs?: string;
}

interface Operation {
  summary: string;
  actor?: string;
}

/** How often a wait for the engine to be idle looks again, ms. */
const IDLE_POLL_MS = 250;

export class StoreBackup {
  readonly status: StoreBackupStatus;
  private readonly run: GitRunner;
  private ops: Operation[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;
  private retryAt = 0;
  private hasRemote = false;
  /** Ticks in a row that found changes but a busy engine. */
  private busyTicks = 0;
  /** The tick running, if any: ticks never overlap. */
  private ticking: Promise<void> | null = null;
  private stopping = false;
  /** Aborted when a stop runs out of time: the git still running is killed. */
  private readonly abort = new AbortController();
  /** A commit since the last housekeeping of the repository (`git gc --auto`). */
  private committed = false;
  /** Wakes a wait for the engine to be idle (stop). */
  private wake: (() => void) | null = null;
  /** How long the last commit held the engine's write lock, ms. */
  lastLockMs = 0;

  constructor(private readonly o: StoreBackupOptions) {
    this.run = o.run ?? runGit;
    this.status = { enabled: false, every: Math.round(this.tickMs / 1000), remote: null, pendingOperations: 0, pendingCommits: 0 };
  }

  private get maxFileBytes(): number {
    return this.o.maxFileBytes ?? MAX_FILE_BYTES;
  }

  /** The timer's period. */
  private get tickMs(): number {
    return this.o.every ?? DEFAULT_EVERY_MS;
  }

  private log(level: "INFO" | "WARN" | "ERROR", message: string, attributes: Record<string, unknown> = {}): void {
    this.o.log?.(level, message, attributes);
  }

  private git(...args: string[]) {
    const local = this.o.localTimeoutMs !== undefined && !isNetworkGit(args) ? { timeoutMs: this.o.localTimeoutMs } : {};
    return this.run(args, this.o.store, { signal: this.abort.signal, ...local });
  }

  /** One git step after another: commits and pushes never overlap. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn).catch((e: unknown) => {
      this.setError(redactText(messageOf(e)));
      this.log("WARN", "datanotes store backup failed", { error: this.status.lastError });
    });
    this.chain = next;
    return next;
  }

  /** The status says what failed, and how to fix it when a person must. */
  private setError(error: string, g?: Guidance): void {
    this.status.lastError = error;
    if (g) {
      this.status.hint = g.hint;
      this.status.docs = g.docs;
    } else {
      delete this.status.hint;
      delete this.status.docs;
    }
  }

  /** Prepare the repository, commit and push what is there at once, and start the timer; false when git fails. */
  async start(): Promise<boolean> {
    if (!(await this.prepare())) return false;
    this.status.enabled = true;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.log("INFO", "datanotes store backup started", { store: this.o.store, remote: this.status.remote, every: this.status.every });
    // what an earlier run left uncommitted (a forced stop): committed at once, pushed in the
    // background, so a slow remote never delays the engine's start
    void this.sync(false);
    return true;
  }

  /**
   * One commit and push, then done: the first backup of `datanotes store backup`, with no engine.
   * No stop deadline: the first commit of a large store (thousands of files, hundreds of MB) and
   * its push take what they need, within git's time limits ({@link StoreBackupOptions.localTimeoutMs},
   * 10 min for the push). `progress` says what runs. A failure leaves no git lock behind. Returns
   * false when the repository could not be prepared or git failed (the status says why).
   */
  async once(progress: (message: string) => void = () => undefined): Promise<boolean> {
    if (!(await this.prepare())) return false;
    this.status.enabled = true;
    try {
      const st = await this.git("--no-optional-locks", "status", "--porcelain", "--untracked-files=all");
      const files = st.code === 0 ? st.stdout.split("\n").filter(Boolean).length : 0;
      if (files > 0) progress(`committing ${files} file${files === 1 ? "" : "s"} of the store`);
      await this.commit();
      if (this.hasRemote && !this.status.lastError) {
        await this.countPending();
        const n = this.status.pendingCommits;
        if (n > 0) progress(`pushing ${n} commit${n === 1 ? "" : "s"} to ${this.status.remote ?? "origin"}`);
        await this.push(true);
      }
    } finally {
      this.status.enabled = false;
    }
    if (this.status.lastError) await this.clearLocksAfterFailure();
    return !this.status.lastError;
  }

  /**
   * After a git that failed or was killed (a time limit): its lock files go, so the next git works.
   * A killed git may hold them a moment longer (Windows), so a few tries.
   */
  private async clearLocksAfterFailure(): Promise<void> {
    const until = Date.now() + 5_000;
    while (this.removeStaleLocks() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  }

  /** The repository ready to back up, the remote and the last commit known; false (the status says why) otherwise. */
  private async prepare(): Promise<boolean> {
    if (!this.o.databaseId.trim()) {
      // every commit names the database (Database-Id), and a restore checks it
      this.setError(
        "the database has no id: a store backup could not be matched to it",
        guide("Start the engine once on the vault (datanotes serve --vault <folder>): it writes the id in metastore.yaml. Then turn the backup on.", "storeBackup"),
      );
      this.log("WARN", "datanotes store backup could not start", { store: this.o.store, error: this.status.lastError });
      return false;
    }
    this.removeStaleLocks();
    try {
      await prepareStoreRepo(this.o.store, this.o.remote ?? null, this.run, {
        ...(this.o.vault ? { vault: this.o.vault } : {}),
        ...(this.o.sshCommand ? { sshCommand: this.o.sshCommand } : {}),
      });
    } catch (e) {
      this.setError(redactText(messageOf(e)));
      this.log("WARN", "datanotes store backup could not start", { store: this.o.store, error: this.status.lastError });
      return false;
    }
    const url = await this.git("remote", "get-url", "origin");
    this.hasRemote = url.code === 0 && url.stdout.trim() !== "";
    this.status.remote = this.hasRemote ? redactRemote(url.stdout.trim()) : null;
    // the last commit of an earlier run, until this one commits (none in a new repository)
    const head = await this.git("rev-parse", "--short", "--verify", "-q", "HEAD");
    if (head.code === 0 && head.stdout.trim()) this.status.lastCommit = head.stdout.trim();
    return true;
  }

  /**
   * The lock files a git killed in the middle of a command leaves (a stop by force, a time limit):
   * with them, every later `git add` and `git commit` fails. Safe to remove at start: the engine's
   * lock (engine.lock) lets one engine at a time use the store, and `datanotes store backup` runs
   * only while none does.
   */
  private removeStaleLocks(): boolean {
    let left = false;
    for (const rel of STALE_LOCKS) {
      const file = path.join(this.o.store, ".git", ...rel.split("/"));
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue; // not there
      }
      try {
        fs.rmSync(file, { force: true });
        this.log("WARN", "datanotes store backup removed a git lock left by a stopped git", { store: this.o.store, file: `.git/${rel}` });
      } catch {
        left = true; // still held (Windows): a later try removes it
      }
    }
    return left;
  }

  /** An engine operation was applied: remembered for the next commit's message. */
  noteOperation(op: Operation): void {
    this.ops.push(op);
    this.status.pendingOperations = this.ops.length;
  }

  /** Whether the tracked files changed since the last commit (a git that fails says yes: the commit reports it). */
  private async changed(): Promise<boolean> {
    // --no-optional-locks: a read that never takes the index lock
    const st = await this.git("--no-optional-locks", "status", "--porcelain");
    return st.code !== 0 || st.stdout.trim() !== "";
  }

  /**
   * Resolves true once the engine is idle (no operation running or waiting, none for `quietMs`),
   * false when `deadline` comes first or the backup stops.
   */
  private async waitIdle(deadline: number): Promise<boolean> {
    const engine = this.o.engine;
    if (!engine) return true;
    const quiet = this.o.quietMs ?? QUIET_MS;
    for (;;) {
      if (this.stopping) return false;
      const now = Date.now();
      const a = engine.activity();
      const left = a.busy ? IDLE_POLL_MS : a.lastEnd + quiet - now;
      if (!a.busy && left <= 0) return true;
      if (now >= deadline) return false;
      await new Promise<void>((resolve) => {
        const t = setTimeout(
          () => {
            this.wake = null;
            resolve();
          },
          Math.max(1, Math.min(left, IDLE_POLL_MS, deadline - now)),
        );
        this.wake = () => {
          clearTimeout(t);
          this.wake = null;
          resolve();
        };
      });
    }
  }

  /**
   * What the timer runs: nothing when nothing changed (a failed push may be retried); otherwise a
   * commit once the engine is idle, then a push. A busy engine waits for the next tick, at most
   * {@link MAX_BUSY_TICKS} ticks in a row.
   */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    if (!this.status.enabled || this.stopping) return Promise.resolve();
    const work = (async () => {
      const noted = this.ops.length;
      if (!(await this.changed())) {
        // operations that changed no tracked file (a dry run): nothing to list
        this.ops.splice(0, noted);
        this.status.pendingOperations = this.ops.length;
        this.busyTicks = 0;
        await this.push(false);
        return;
      }
      if (this.busyTicks < MAX_BUSY_TICKS && !(await this.waitIdle(Date.now() + this.tickMs / 2))) {
        if (this.stopping) return;
        this.busyTicks++;
        this.log("INFO", "datanotes store backup waits: the engine is busy", { busy_ticks: this.busyTicks });
        return;
      }
      await this.sync(false);
    })().finally(() => {
      this.ticking = null;
    });
    this.ticking = work;
    return work;
  }

  private message(files: number, ops: readonly Operation[]): string {
    const head = ops.length ? `store backup: ${ops.length} operation${ops.length === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}` : `store backup: ${files} file${files === 1 ? "" : "s"} changed`;
    const lines = ops.slice(0, 50).map((o) => `- ${o.summary}${o.actor ? ` (${o.actor})` : ""}`);
    if (ops.length > 50) lines.push(`- … and ${ops.length - 50} more`);
    const body = lines.length ? lines : ["Changes outside operations: hand edits, the change feed, tokens."];
    return [head, "", ...body, "", `${DATABASE_ID_TRAILER}: ${this.o.databaseId}`, "Backed-up-by: datanotes"].join("\n");
  }

  /**
   * Commit what changed in the tracked files (nothing when nothing changed), holding the engine's
   * write lock for `git add` and `git commit` only: the commit is a snapshot between two operations.
   * A first `git add` outside the lock hashes the new files, so the one under it has little left
   * to do, and no automatic `git gc` runs under the lock ({@link NO_AUTO_GC}).
   */
  commit(): Promise<void> {
    return this.serial(async () => {
      const engine = this.o.engine;
      let ops: Operation[] = [];
      // outside the lock: what it stages, the add under the lock brings up to date
      await this.git(...NO_AUTO_GC, "add", "-A");
      const snapshot = async (): Promise<number> => {
        const started = performance.now();
        // the operations this commit covers: every one noted so far is written, as the lock says
        ops = this.ops;
        this.ops = [];
        try {
          const add = await this.git(...NO_AUTO_GC, "add", "-A");
          if (add.code !== 0) throw new Error(`git add: ${add.stderr.trim()}`);
          const staged = await this.git("diff", "--cached", "--name-only");
          const n = staged.stdout.split("\n").filter(Boolean).length;
          if (n > 0) {
            const commit = await this.git(...NO_AUTO_GC, "commit", "-q", "-m", this.message(n, ops));
            if (commit.code !== 0) throw new Error(`git commit: ${commit.stderr.trim() || commit.stdout.trim()}`);
          }
          return n;
        } catch (e) {
          this.ops = [...ops, ...this.ops];
          throw e;
        } finally {
          this.lastLockMs = performance.now() - started;
          this.status.pendingOperations = this.ops.length;
        }
      };
      const files = engine ? await engine.exclusive(snapshot) : await snapshot();
      this.busyTicks = 0;
      if (files > 0) {
        this.committed = true;
        const head = await this.git("rev-parse", "--short", "HEAD");
        this.status.lastCommit = head.stdout.trim();
        this.status.lastCommitAt = new Date().toISOString();
        this.log("INFO", "datanotes store backup committed", { commit: this.status.lastCommit, files, operations: ops.length, lock_ms: Math.round(this.lastLockMs) });
      }
      await this.countPending();
    });
  }

  private async countPending(): Promise<void> {
    const head = await this.git("rev-parse", "-q", "--verify", "HEAD");
    if (head.code !== 0 || !this.hasRemote) {
      this.status.pendingCommits = 0;
      return;
    }
    const n = await this.git("rev-list", "--count", "HEAD", "--not", "--remotes=origin");
    this.status.pendingCommits = Number(n.stdout.trim()) || 0;
  }

  /**
   * A file of the commits to push over {@link MAX_FILE_BYTES}, or null. GitHub refuses a push with
   * a file over 100 MB, every time: retrying would never end.
   */
  private async oversized(): Promise<{ path: string; bytes: number } | null> {
    const range = ["HEAD", "--not", "--remotes=origin"];
    const omitted = await this.git("rev-list", "--objects", `--filter=blob:limit=${this.maxFileBytes + 1}`, "--filter-print-omitted", ...range);
    const big = omitted.code === 0 ? omitted.stdout.split("\n").find((l) => l.startsWith("~")) : undefined;
    if (!big) return null;
    const oid = big.slice(1).trim();
    const all = await this.git("rev-list", "--objects", ...range);
    const line = all.stdout.split("\n").find((l) => l.startsWith(`${oid} `));
    const size = await this.git("cat-file", "-s", oid);
    return { path: line ? line.slice(oid.length + 1).trim() : oid, bytes: Number(size.stdout.trim()) || 0 };
  }

  /** Push the commits the remote lacks. `force`: even while a failing push waits for its retry. */
  push(force = false): Promise<void> {
    return this.serial(async () => {
      if (!this.hasRemote) return;
      if (!force && Date.now() < this.retryAt) return;
      await this.countPending();
      if (this.status.pendingCommits === 0) return;
      const big = await this.oversized();
      if (big) {
        const was = this.status.lastError;
        this.setError(
          `git push refused: ${big.path} is ${(big.bytes / 1024 / 1024).toFixed(1)} MB, over the ${this.maxFileBytes / 1024 / 1024} MB a file of the store backup can have (GitHub refuses files over 100 MB)`,
          guide("Make the file smaller (vacuum_table removes a table's old history), then start the backup repository again, as Keep the backup repository small shows.", "storeBackupFileSize"),
        );
        delete this.status.nextRetry;
        if (was !== this.status.lastError) this.log("ERROR", "datanotes store backup cannot push a file over the size limit", { file: big.path, bytes: big.bytes });
        return;
      }
      const push = await this.git("push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
      if (push.code !== 0) {
        this.failures++;
        const delay = Math.min(this.tickMs * 2 ** (this.failures - 1), this.o.maxBackoffMs ?? 30 * 60_000);
        this.retryAt = Date.now() + delay;
        this.setError(`git push: ${redactText(push.stderr.trim() || push.stdout.trim())}`);
        this.status.nextRetry = new Date(this.retryAt).toISOString();
        this.log("WARN", "datanotes store backup could not push (retried with backoff)", { error: this.status.lastError, failures: this.failures, retry_in_ms: delay });
        return;
      }
      // the remote-tracking ref follows, so the commits still to push count right
      await this.git("update-ref", `refs/remotes/origin/${BRANCH}`, "HEAD");
      this.failures = 0;
      this.retryAt = 0;
      delete this.status.lastError;
      delete this.status.nextRetry;
      delete this.status.hint;
      delete this.status.docs;
      this.status.lastPush = new Date().toISOString();
      this.log("INFO", "datanotes store backup pushed", { commits: this.status.pendingCommits });
      this.status.pendingCommits = 0;
    });
  }

  /**
   * The repository's housekeeping (`git gc --auto`: packs loose objects when there are many), after
   * the push and outside the engine's write lock: operations never wait for it. Not at stop.
   */
  housekeeping(): Promise<void> {
    return this.serial(async () => {
      if (!this.committed || this.stopping) return;
      this.committed = false;
      const started = performance.now();
      const gc = await this.run(["-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false", "gc", "--auto", "--quiet"], this.o.store, { signal: this.abort.signal, timeoutMs: NETWORK_TIMEOUT_MS });
      if (gc.code !== 0) this.log("WARN", "datanotes store backup: git gc --auto failed", { error: redactText(gc.stderr.trim()).slice(0, 500) });
      else if (performance.now() - started > 1000) this.log("INFO", "datanotes store backup packed the repository", { ms: Math.round(performance.now() - started) });
    });
  }

  /** Commit at once (at the next gap between two operations), then push, then the housekeeping. `force`: push even while a failing push waits. */
  async sync(force = true): Promise<void> {
    await this.commit();
    await this.push(force);
    await this.housekeeping();
  }

  /** Resolves once the commits and pushes started so far are done (a push that follows a commit too). */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
  }

  /**
   * Stop the timer and any wait, then a last commit and push, within `stopTimeoutMs`
   * ({@link STOP_TIMEOUT_MS}): past it, git is killed and the next start commits and pushes what is
   * left. Never throws.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping = true;
    this.wake?.();
    const limit = this.o.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    const last = (async () => {
      await this.ticking;
      if (this.status.enabled) await this.sync(true);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = await Promise.race([last.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), limit)))]);
    clearTimeout(timer);
    if (late) {
      this.abort.abort();
      this.log("WARN", "datanotes store backup stopped before its last push ended", { waited_ms: limit });
      // git killed answers at once; an engine lock still held is not waited for
      await Promise.race([last, new Promise((r) => setTimeout(r, 1000))]);
      this.setError(`the last commit and push did not end within ${limit / 1000} s of the stop: git was stopped, and the next start makes them`);
    }
    this.status.enabled = false;
  }
}
