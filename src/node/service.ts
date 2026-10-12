/**
 * The headless service: the engine on a vault folder, without Obsidian.
 *
 *   datanotes serve --vault <folder> [--watch events|poll] [--poll-ms 3000]
 *                                [--store <folder>]
 *                                [--settings <file>] [--embedding-key-file <file>] [--log <file>]
 *                                [--host 127.0.0.1] [--port 27150 | 0]
 *                                [--git-sync [--git-interval-min 10] [--git-quiet-s 60] [--git-no-push]]
 *                                [--store-backup [--store-backup-remote <url>] [--store-backup-interval-s 60]]
 *
 * The engine's store (settings `settings.json`, tokens, journal, transaction log, change feed,
 * logs, the lock `engine.lock`) is outside the vault: `<data home>/<database id>/`, found at start
 * (store-setup.ts). The HTTP API is how programs, MCP servers and plugins reach the
 * engine. While it runs, the service holds the lock, so a second engine does not start on the
 * same database.
 *
 * The store backup (store-backup.ts) keeps the store a git repository of its own, pushed to a
 * private remote: on with the setting `storeBackupEnabled` (`datanotes store backup`), or `--store-backup`
 * for this run.
 *
 * The embedding API key (semantic search with a paid provider) comes from the environment
 * (`DATANOTES_EMBEDDING_KEY`) or `--embedding-key-file`.
 *
 * The port is `--port` (or DATANOTES_PORT) for this run, else the setting `httpServerPort`; 0 lets
 * the system choose a free one. The port bound is the one the lock, the status and the start line
 * give. A port that cannot be bound stops the start with an error that says why and what to do.
 *
 * A graceful stop (a signal, or `POST /datanotes/stop/` that `datanotes stop` sends) lets
 * the requests under way finish, refuses new ones, makes the last git sync and store backup commit
 * and push, and releases the lock.
 */

import fs from "node:fs";
import { folderArg, readOptions } from "../api/cli-options";
import os from "node:os";
import path from "node:path";
import { mergeWithDefaults, RUNTIME_KEYS, type DatanotesSettings } from "../core/settings";
import { telemetry } from "../core/telemetry";
import { LockHolder } from "../server/engine-lock";
import { EngineRuntime } from "../server/runtime";
import { onApplied } from "../core/engine";
import { recordDatabaseMove } from "../core/database";
import { setBulkWriter } from "../core/vault-settle";
import { writeJournal } from "../core/journal";
import { METASTORE_FILE } from "../core/metastore";
import { GitSync } from "./git-sync";
import { gitBusy, gitDirOf } from "./git-state";
import { setRepairGate } from "../core/hand-moves";
import { MIN_EVERY_S, parseEvery, StoreBackup } from "./store-backup";
import { logLockActivity, withLogLock } from "../core/transaction-log";
import { nodeStoreAdapter, openNodeVault } from "./node-app";
import { PRIVATE_FILE_MODE } from "./private-files";
import { nodeVersionWarning } from "./node-version";
import { NodeWatcher } from "./watcher";
import { openStore, recordStore, StoreSetupError, type OpenedStore } from "./store-setup";
import { SETTINGS_FILE } from "../api/local";
import { guide, guidanceOf, GuidedError } from "../core/hints";
import { ListenError } from "../server/http-server";

declare const SERVICE_VERSION: string | undefined;
/* v8 ignore next -- only the built command defines SERVICE_VERSION (esbuild); tests run the source */
const VERSION = typeof SERVICE_VERSION === "string" ? SERVICE_VERSION : "dev";

export interface ServiceOptions {
  /** The folder the engine serves: a vault holding the database, or the database itself (`atRoot`). */
  vault: string;
  /** `--database`: the folder is the database (metastore.yaml at its root), not a vault. */
  atRoot?: boolean;
  watch: "events" | "poll";
  pollMs: number;
  settingsFile?: string;
  /** `--store`: the store folder itself (default `<data home>/<database id>/`). */
  store?: string;
  embeddingKeyFile?: string;
  /** How long to wait for the port (a previous engine may still be closing), ms. */
  httpWaitMs?: number;
  /** Listen address (default 127.0.0.1). */
  host?: string;
  /** `--port`: the HTTP port for this run, over the setting `httpServerPort` (0: any free port); not saved. */
  port?: number;
  /** How long a graceful stop waits for the requests under way, ms (default 30 s). */
  drainMs?: number;
  /** Commit, pull and push the vault's git repository (see `git-sync.ts`). */
  gitSync?: { intervalMs: number; quietMs: number; push: boolean };
  /** How long a stop waits for git sync's last commit and push, ms (default {@link GIT_SYNC_STOP_MS}). */
  gitSyncStopMs?: number;
  /** `--log`: the file console output is appended to (shown by `datanotes status`). */
  logFile?: string;
  /**
   * The store backup for this run, over the settings (`storeBackupEnabled`, `storeBackupRemote`,
   * `storeBackupIntervalSeconds`): `enabled` false turns it off, a `remote` turns it on; `every` in ms
   * (`quietMs`, the engine's idle time before a commit, is for tests).
   */
  storeBackup?: { enabled?: boolean; remote?: string; every?: number; quietMs?: number; stopTimeoutMs?: number };
}

/**
 * A port as `--port` or DATANOTES_PORT give it: 1024 to 65535, or 0 for any free port (the rule of
 * the setting `httpServerPort`).
 */
export function parsePort(raw: string, from = "--port"): number {
  const n = /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (n === 0 || (Number.isInteger(n) && n >= 1024 && n <= 65535)) return n;
  throw new GuidedError(
    `${from} must be a port from 1024 to 65535, or 0 for any free port: "${raw}"`,
    guide("Pass --port 27150 (the default), another port from 1024 to 65535, or --port 0 to let the system choose a free one; datanotes status shows the port the engine listens on.", "port"),
  );
}

/** The options of `datanotes serve`. */
export const SERVE_OPTIONS = {
  values: ["vault", "database", "watch", "poll-ms", "settings", "store", "embedding-key-file", "host", "port", "log", "git-interval-min", "git-quiet-s", "store-backup-remote", "store-backup-interval-s"],
  flags: ["git-sync", "git-no-push", "store-backup", "no-store-backup"],
};

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServiceOptions {
  const o = readOptions(argv, SERVE_OPTIONS, "datanotes serve");
  const get = (name: string) => o.get(name);
  const portArg = get("port");
  const port = portArg !== undefined ? parsePort(portArg) : env.DATANOTES_PORT ? parsePort(env.DATANOTES_PORT, "DATANOTES_PORT") : undefined;
  const { folder: vault, atRoot } = folderArg(o, env, "datanotes serve")!;
  const watch = (get("watch") ?? env.DATANOTES_WATCH ?? "events") as ServiceOptions["watch"];
  if (watch !== "events" && watch !== "poll") throw new Error(`--watch must be "events" or "poll"`);
  const pollMs = Number(get("poll-ms") ?? env.DATANOTES_POLL_MS ?? 3000);
  const settingsFile = get("settings") ?? env.DATANOTES_SETTINGS;
  const store = get("store");
  const embeddingKeyFile = get("embedding-key-file") ?? env.DATANOTES_EMBEDDING_KEY_FILE;
  const host = get("host") ?? env.DATANOTES_HOST;
  const logFile = get("log");
  const gitOn = o.has("git-sync") || env.DATANOTES_GIT_SYNC === "1";
  const minutes = Number(get("git-interval-min") ?? env.DATANOTES_GIT_INTERVAL_MIN ?? 10);
  const quiet = Number(get("git-quiet-s") ?? env.DATANOTES_GIT_QUIET_S ?? 60);
  const gitSync = gitOn
    ? { intervalMs: (Number.isFinite(minutes) && minutes >= 1 ? minutes : 10) * 60_000, quietMs: (Number.isFinite(quiet) && quiet >= 5 ? quiet : 60) * 1000, push: !o.has("git-no-push") }
    : undefined;
  const backupFlag = o.has("no-store-backup") || env.DATANOTES_STORE_BACKUP === "0" ? false : o.has("store-backup") || env.DATANOTES_STORE_BACKUP === "1" ? true : undefined;
  const backupRemote = get("store-backup-remote") ?? env.DATANOTES_STORE_BACKUP_REMOTE;
  const everyRaw = get("store-backup-interval-s") ?? env.DATANOTES_STORE_BACKUP_INTERVAL_S;
  const every = everyRaw === undefined ? undefined : parseEvery(everyRaw);
  if (every === null) {
    throw new StoreSetupError(
      `--store-backup-interval-s must be a whole number of seconds, at least ${MIN_EVERY_S}: "${everyRaw}"`,
      guide(`Pass --store-backup-interval-s 60 (a commit every 60 s when something changed, the default), or any number of seconds from ${MIN_EVERY_S}.`, "storeBackupCadence"),
    );
  }
  const storeBackup = {
    ...(backupFlag !== undefined ? { enabled: backupFlag } : backupRemote ? { enabled: true } : {}),
    ...(backupRemote ? { remote: backupRemote } : {}),
    ...(every !== undefined ? { every: every * 1000 } : {}),
  };
  return {
    vault: path.resolve(vault),
    ...(atRoot ? { atRoot } : {}),
    watch,
    ...(Object.keys(storeBackup).length > 0 ? { storeBackup } : {}),
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(gitSync ? { gitSync } : {}),
    pollMs: Number.isFinite(pollMs) && pollMs >= 200 ? pollMs : 3000,
    ...(settingsFile ? { settingsFile } : {}),
    ...(store ? { store: path.resolve(store) } : {}),
    ...(embeddingKeyFile ? { embeddingKeyFile } : {}),
    ...(logFile ? { logFile: path.resolve(logFile) } : {}),
  };
}

/** The settings file: `--settings`, else `settings.json` in the store. */
export function settingsPath(o: Pick<ServiceOptions, "settingsFile">, store: string): string {
  return o.settingsFile ? path.resolve(o.settingsFile) : path.join(store, SETTINGS_FILE);
}

/** The variables that say where the store is: read from the process when the given environment leaves them out. */
const LOCATION_VARS = ["DATANOTES_DATA_HOME", "DATANOTES_STORE"] as const;

export interface RunningService {
  runtime: EngineRuntime;
  git: GitSync | null;
  /** The store backup, when on. */
  backup: StoreBackup | null;
  watcher: NodeWatcher;
  settings: DatanotesSettings;
  port: number;
  /** Where the store is, which database it serves, and what the start found (migration, moves). */
  store: OpenedStore;
  /** A graceful stop (once; a second call waits for the first). */
  stop(): Promise<void>;
  /** Settles once the engine has stopped, whatever stopped it (`stop()`, or `POST /datanotes/stop/`). */
  stopped: Promise<void>;
}

export async function startService(o: ServiceOptions, env: NodeJS.ProcessEnv = process.env): Promise<RunningService> {
  const locEnv: Record<string, string | undefined> = { ...Object.fromEntries(LOCATION_VARS.map((k) => [k, process.env[k]])), ...env };
  // Tests never write to the user's data folder (tests/setup.ts sets DATANOTES_DATA_HOME).
  if (process.env.VITEST && !locEnv.DATANOTES_DATA_HOME && !locEnv.DATANOTES_STORE && !o.store) throw new Error("set DATANOTES_DATA_HOME in tests");
  if (!fs.statSync(o.vault, { throwIfNoEntry: false })?.isDirectory()) {
    const option = o.atRoot ? "--database" : "--vault";
    throw new GuidedError(
      `${option} ${o.vault}: no such folder`,
      guide(`Create the folder first (an empty folder starts a new database), or fix the path in ${option}; the engine never creates the folder it serves.`, "startEngine"),
    );
  }
  const host = openNodeVault(o.vault);
  const notes: [level: "INFO" | "WARN", message: string, attrs?: Record<string, unknown>][] = [];
  let opened: OpenedStore;
  try {
    opened = openStore({
      vault: o.vault,
      ...(o.atRoot ? { atRoot: true } : {}),
      env: locEnv,
      ...(o.store ? { store: o.store } : {}),
      ...(o.settingsFile ? { settingsFile: o.settingsFile } : {}),
      files: () => host.vault.getFiles().map((f) => f.path),
      log: (level, message, attrs) => notes.push([level, message, attrs]),
    });
  } catch (e) {
    host.metadataCache.dispose();
    throw e;
  }
  // the id written into the metastore before the store existed: the index reads it again
  if (opened.idAdded) host.vault.syncPath(`${opened.database}/${METASTORE_FILE}`);
  const app = host.app;
  app.store = nodeStoreAdapter(opened.store);
  const file = settingsPath(o, opened.store);

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  for (const k of RUNTIME_KEYS) delete raw[k];
  const settings = mergeWithDefaults(raw);
  settings.databaseFolder = opened.database;
  settings.databaseId = opened.id;
  let recorded = opened.database;
  const save = async () => {
    // Keep keys this version does not know (another version may have written them).
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    const out: Record<string, unknown> = { ...current, ...settings };
    for (const k of RUNTIME_KEYS) delete out[k];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // it holds the owner token: created private (0600); an existing one was tightened at start
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: PRIVATE_FILE_MODE });
    // the database folder moved (configure_database, or by hand): the store's record follows
    if (settings.databaseFolder !== recorded) {
      recordStore(opened.home, opened.store, o.vault, opened.id, settings.databaseFolder);
      recorded = settings.databaseFolder;
    }
  };

  const watcher = new NodeWatcher(host.vault, { mode: o.watch, intervalMs: o.pollMs });
  const keyFromFile = () => {
    if (!o.embeddingKeyFile) return undefined;
    try {
      return fs.readFileSync(o.embeddingKeyFile, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const runtime = new EngineRuntime({
    ...(o.host ? { httpHost: o.host } : {}),
    app,
    getSettings: () => settings,
    saveSettings: save,
    transport: async (req) => {
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      return { status: res.status, text: await res.text() };
    },
    env,
    embeddingKey: () => env.DATANOTES_EMBEDDING_KEY || keyFromFile(),
    version: VERSION,
    hostName: "service",
    canServeHttp: true,
    ...(o.port !== undefined ? { httpPort: o.port } : {}),
  });
  runtime.startTelemetry();
  for (const [level, message, attrs] of notes) {
    telemetry().log(level, message, attrs as never);
    console.log(message);
  }
  // Claim the database before serving: tools find the running engine through the lock (datanotes/local).
  // Until the server listens, the lock gives the port asked for: 0 (any free port) says "not yet".
  const lock = new LockHolder(app.store, "", { kind: "service", pid: process.pid, host: os.hostname(), port: o.port ?? settings.httpServerPort });
  await lock.acquire();
  // renames in case only that a crash left half done: finished once no other engine can be renaming
  const renames = host.vault.recoverRenames();
  for (const p of renames.recovered) host.vault.syncPath(p);
  if (renames.recovered.length + renames.left.length > 0) telemetry().log(renames.left.length > 0 ? "WARN" : "INFO", "datanotes finished renames a crash left half done", { recovered: renames.recovered.join(", "), left: renames.left.join(", ") });
  if (opened.idAdded) {
    // listed in the journal; not undone (the store is found by the id)
    const now = new Date();
    await writeJournal(app, settings, { op: "set_database_id", summary: `give the database the id ${opened.id}`, executed_at: now.toISOString(), rows: [], creates: [], moves: [], references: [], deleted: [], failed: [] }, now);
  }
  // The database folder was moved by hand while the engine was stopped: recorded as a move.
  if (opened.moved) await recordDatabaseMove(app, settings, { ...opened.moved, by: "hand" });
  watcher.start();
  // every operation first applies the changes the watcher has seen but not applied yet
  runtime.setHostSettler(() => watcher.flush());
  // many writes at once (a move of the database folder): the watcher stops meanwhile, then compares the vault
  setBulkWriter(app, async (work) => {
    watcher.stop();
    try {
      return await work();
    } finally {
      watcher.start();
    }
  });
  await runtime.start({ http: false });
  if (opened.moved) await runtime.changeFeed?.databaseMoved(opened.moved.from, opened.moved.to, false);

  let git: GitSync | null = null;
  // links to notes moved by hand are not repaired while git changes the vault (a pull, a rebase)
  const gitDir = gitDirOf(o.vault);
  setRepairGate(app, () => gitBusy(gitDir, git?.pulling));
  let offApplied: (() => void) | null = null;
  let backup: StoreBackup | null = null;
  let offBackup: (() => void) | null = null;
  let stopping: Promise<void> | null = null;
  let markStopped!: () => void;
  const stopped = new Promise<void>((r) => (markStopped = r));
  /**
   * A graceful stop: the requests under way finish first, then the engine stops writing, then the
   * store backup's last commit and push, then git sync's, and the lock goes last: no other engine
   * starts on the store while git still runs in it. Each git step has its time limit, so the whole
   * stop ends within the 60 s that `datanotes stop` waits.
   */
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // new requests are refused (503) from here on; the ones under way finish
      const drainMs = o.drainMs ?? 30_000;
      const drained = await runtime.drain(drainMs);
      if (!drained) telemetry().log("WARN", "datanotes stopped before every request under way was answered", { waited_ms: drainMs });
      offApplied?.();
      offBackup?.();
      git?.stop();
      runtime.setHostSettler(null);
      setBulkWriter(app, null);
      watcher.stop();
      await runtime.dispose();
      setRepairGate(app, null);
      host.metadataCache.dispose();
      // after the engine's last writes (change feed, tokens): a last commit and push
      await backup?.stop();
      if (git) await lastGitSync(git, o.gitSyncStopMs ?? GIT_SYNC_STOP_MS);
      await lock.release();
    })().finally(markStopped);
    return stopping;
  };
  // `POST /datanotes/stop/` (`datanotes stop`): answered first, then the same graceful stop
  runtime.setHostStop(() => {
    console.log("datanotes service: stop requested, stopping");
    void stop();
  });

  const deadline = Date.now() + (o.httpWaitMs ?? 45_000);
  let waiting = false;
  for (;;) {
    await runtime.applyHttpServer();
    if (runtime.httpServerRunning || Date.now() >= deadline) break;
    // only a busy port is waited for (a previous engine may still be closing): any other failure is final
    if (!(runtime.httpServerFailure instanceof ListenError) || runtime.httpServerFailure.code !== "EADDRINUSE") break;
    if (!waiting) {
      waiting = true;
      console.log(`datanotes service: ${runtime.httpServerError!}; waiting up to ${Math.ceil((deadline - Date.now()) / 1000)} s for it to be free`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!runtime.httpServerRunning) {
    await lock.release();
    await runtime.dispose();
    watcher.stop();
    host.metadataCache.dispose();
    // a server not running says why, and what to do
    throw new GuidedError(`HTTP server did not start: ${runtime.httpServerError!}`, guidanceOf(runtime.httpServerFailure) ?? guide("Check --host and --port; datanotes status shows what holds the vault.", "port"));
  }
  // The port bound, not the setting: with 0 the system chose it, and tools read it from the lock.
  const port = runtime.httpPort!;
  await lock.setPort(port);
  if (o.gitSync) {
    git = new GitSync({ vault: o.vault, ...o.gitSync, exclude: [".obsidian", ".trash"], log: (level, msg, attrs) => telemetry().log(level, msg, attrs as never) });
    if (await git.start()) {
      offApplied = onApplied(app, (e) => git!.noteOperation({ summary: e.summary, ...(e.actor?.harness ? { actor: e.actor.harness } : {}) }));
      void git.cycle();
    } else git = null;
  }
  // The store backup: every N seconds, a commit between two operations when something changed, then a push; a last one at stop.
  const b = o.storeBackup ?? {};
  if (b.enabled ?? (b.remote ? true : settings.storeBackupEnabled)) {
    backup = new StoreBackup({
      store: opened.store,
      databaseId: opened.id,
      // its repository takes the vault repository's SSH command (Windows OpenSSH and its agent)
      vault: o.vault,
      remote: b.remote ?? (settings.storeBackupRemote || null),
      every: b.every ?? settings.storeBackupIntervalSeconds * 1000,
      // the engine's write lock: a commit is a snapshot between two operations
      engine: { activity: () => logLockActivity(app), exclusive: (fn) => withLogLock(app, fn) },
      ...(b.quietMs !== undefined ? { quietMs: b.quietMs } : {}),
      ...(b.stopTimeoutMs !== undefined ? { stopTimeoutMs: b.stopTimeoutMs } : {}),
      log: (level, msg, attrs) => telemetry().log(level, msg, attrs as never),
    });
    // a backup that cannot start (git missing) is reported by the status; the engine runs on
    if (await backup.start()) offBackup = onApplied(app, (e) => backup!.noteOperation({ summary: e.summary, ...(e.actor?.harness ? { actor: e.actor.harness } : {}) }));
  }
  // what only this host knows, for `/status/` (`datanotes status`)
  runtime.setHostStatus(() => ({
    pid: process.pid,
    hostName: os.hostname(),
    vault: o.vault,
    watch: o.watch,
    settingsFile: file,
    store: opened.store,
    ...(o.logFile ? { logFile: o.logFile } : {}),
    git: git ? { ...git.status } : null,
    storeBackup: backup ? { ...backup.status } : null,
  }));
  telemetry().log("INFO", "datanotes service started", { vault: o.vault, port, watch: o.watch, settings: file, store: opened.store, database: settings.databaseFolder, database_id: opened.id });

  return {
    runtime,
    watcher,
    git,
    backup,
    settings,
    port,
    store: opened,
    stop,
    stopped,
  };
}

/** How long a stop waits for git sync's last commit and push (after the store backup's 15 s). */
export const GIT_SYNC_STOP_MS = 10_000;

/** Git sync's last commit and push, within `ms`: past it, git is killed and the next start syncs. */
export async function lastGitSync(git: GitSync, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cycle = git.cycle().catch(() => undefined);
  const late = await Promise.race([cycle.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), ms)))]);
  clearTimeout(timer);
  if (!late) return;
  git.kill();
  telemetry().log("WARN", "datanotes git sync stopped before its last push ended", { waited_ms: ms });
  await Promise.race([cycle, new Promise((r) => setTimeout(r, 1000))]);
}

/** `datanotes serve` (the command line is in `cli.ts`). */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const o = parseArgs(argv);
  // --log <file>: console output appended to a file (the service usually runs without a window).
  if (o.logFile) {
    const logFile = o.logFile;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const write = (level: string, args: unknown[]) =>
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
    console.log = (...a: unknown[]) => write("INFO", a);
    console.error = (...a: unknown[]) => write("ERROR", a);
  }
  const warning = nodeVersionWarning();
  if (warning) console.error(warning);
  const svc = await startService(o);
  console.log(`datanotes service ${VERSION}: ${o.atRoot ? "database" : "vault"} ${o.vault}, http://${o.host ?? "127.0.0.1"}:${svc.port}, watch ${o.watch}, store ${svc.store.store}`);
  // a signal, or a stop asked over HTTP (`datanotes stop`): the same graceful stop, then the process ends
  void svc.stopped.then(() => {
    console.log("datanotes service: stopped");
    process.exit(0);
  });
  const shutdown = (signal: string) => {
    console.log(`datanotes service: ${signal}, stopping`);
    void svc.stop();
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(sig, () => shutdown(sig));
}
