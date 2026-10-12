/**
 * Where the headless engine keeps its store, and which folder of the vault is the database, worked
 * out at start (`openStore`):
 *
 * 1. the database folder: the folder of the vault's one `metastore.yaml` (dot-folders and
 *    node_modules left out; the vault root is never the database folder). A vault holds exactly
 *    one database: more than one `metastore.yaml` and the engine refuses to start. When it is not
 *    the folder this machine last opened on the vault (`vaults.json` in the data home, or the
 *    record of the `--store` store) and has the same id, the database folder was moved by hand.
 *    None: a new database, in the last known folder, else `datanotes/`.
 * 2. the database id: `id` in that `metastore.yaml`; a metastore without one gets one, written
 *    once (the id this machine already knew for the vault, else a new one); a database without a
 *    metastore yet keeps its id in the registry until the engine creates the metastore.
 * 3. the store: `--store` (DATANOTES_STORE), else `<data home>/<id>/` (src/api/local.ts).
 * 4. the store's record (`store.json`): the vault's real path. The same id opened from another
 *    vault while the recorded vault still holds it is a copied database: refused (`datanotes store
 *    new-id` gives the copy a new id). A recorded vault that is gone (or no longer holds the id)
 *    was moved: the record follows.
 *
 * Two starts on the same vault take turns (a setup lock, created with `wx`), and the store's
 * `engine.lock` names the start until its service holds it. On Windows a file another program
 * holds for a moment (EPERM, EBUSY, EACCES) is retried with a growing pause.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dataHome,
  DEFAULT_DATABASE_FOLDER,
  LOCK_FILE,
  LOCK_STALE_MS,
  METASTORE,
  readDatabaseId,
  readRegistry,
  REGISTRY_FILE,
  vaultMetastores,
  SETTINGS_FILE,
  STORE_RECORD_FILE,
  vaultKey,
  type EngineLock,
  type VaultRecord,
} from "../api/local";
import { newDatabaseId, withMetastoreId } from "../core/database-id";
import { guide, GuidedError } from "../core/hints";
import { processAlive } from "./stop";
import { inDatabase } from "../core/db-paths";
import { makePrivateDir, posixModes, PRIVATE_FILE_MODE, tightenPrivate } from "./private-files";

type Env = Record<string, string | undefined>;

/** The webhooks and their secrets, in the store. */
const WEBHOOKS_FILE = "webhooks.json";

export class StoreSetupError extends GuidedError {
  override readonly name = "StoreSetupError";
}

export interface StoreOptions {
  vault: string;
  /**
   * `--database`: the folder is the database itself (its metastore.yaml at the root, created there
   * for a new database), not a vault holding the database in a subfolder.
   */
  atRoot?: boolean;
  env?: Env;
  /** `--store`: the store folder itself. */
  store?: string;
  /** `--settings`: the settings file (default `<store>/settings.json`). */
  settingsFile?: string;
  /** The vault's files, vault-relative with `/` (the host's index: dot-folders left out). */
  files: () => string[];
  log?: (level: "INFO" | "WARN", message: string, attrs?: Record<string, unknown>) => void;
  /** How long to wait for another start on the same vault (default SETUP_WAIT_MS). */
  setupWaitMs?: number;
  /** This process's pid (default process.pid; tests stand in for another process). */
  pid?: number;
}

export interface OpenedStore {
  store: string;
  id: string;
  database: string;
  settingsFile: string;
  /** The data home whose registry knows the vault; null for a store named by --store (not registered). */
  home: string | null;
  /** The metastore had no id: this one was written into it. */
  idAdded: boolean;
  /** The database folder was moved by hand since the last start. */
  moved: { from: string; to: string } | null;
  /** The vault was moved (or renamed) since the last start: its old path. */
  movedVault: string | null;
}


function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The errors Windows gives for a moment while an antivirus, the search indexer or a sync tool holds
 * a file: worth a few retries before failing.
 */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

/** How often, and how long first, a file operation is retried on a transient error (doubling). */
export const fileRetry = { attempts: 6, delayMs: 50 };

/** Block the thread for `ms` (openStore runs before the event loop has anything to do). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run a file operation, again after a pause when it fails with a transient error (TRANSIENT). */
export function retrying<T>(op: () => T): T {
  for (let i = 0; ; i++) {
    try {
      return op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= fileRetry.attempts - 1 || !code || !TRANSIENT.has(code)) throw e;
      sleepSync(fileRetry.delayMs * 2 ** i);
    }
  }
}

/** Remove a file or folder, retried on a transient error. */
function remove(p: string, recursive = false): void {
  fs.rmSync(p, { recursive, force: true, maxRetries: fileRetry.attempts, retryDelay: fileRetry.delayMs });
}

/**
 * Write a text file atomically: a temporary file renamed over it, both retried on a transient
 * error. With `mode` (POSIX), the temporary file, so the file after the rename, has that mode.
 */
export function writeTextAtomic(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    retrying(() => fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode }));
    // a temporary file left by a crash keeps its mode on overwrite: set it
    if (mode !== undefined && posixModes()) fs.chmodSync(tmp, mode);
    retrying(() => fs.renameSync(tmp, file));
  } catch (e) {
    remove(tmp);
    throw e;
  }
}

/**
 * Write a JSON file of the data home or a store atomically (writeTextAtomic): the settings, the
 * registry, a store's record and lock. It is private (0600, private-files.ts).
 */
export function writeJson(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`, PRIVATE_FILE_MODE);
}

/** The folders of `metastore.yaml` files among `files` ("" for the root; node_modules left out). */
export function metastoreFolders(files: readonly string[]): string[] {
  return files
    .filter((f) => (f === METASTORE || f.endsWith(`/${METASTORE}`)) && !f.split("/").includes("node_modules"))
    .map((f) => (f === METASTORE ? "" : f.slice(0, -(METASTORE.length + 1))))
    .sort();
}

const idAt = (vault: string, database: string) => {
  try {
    return readDatabaseId(fs.readFileSync(path.join(vault, ...database.split("/"), METASTORE), "utf8"));
  } catch {
    return null;
  }
};

/** Whether a vault on disk holds the database `id` (in `database`, or in any folder). */
function holdsDatabase(vault: string, database: string, id: string): boolean {
  if (idAt(vault, database) === id) return true;
  return vaultMetastores(vault).some((f) => idAt(vault, f) === id);
}

export interface Discovery {
  database: string;
  /** The database folder moved by hand: the folder the registry knew. */
  movedFrom: string | null;
  /** Whether `<database>/metastore.yaml` exists. */
  exists: boolean;
}

/**
 * The database folder of the vault (step 1 above). With `atRoot` (`--database`) it is the root
 * itself: a metastore.yaml in a subfolder instead is refused, naming the two ways to open it.
 */
export function discoverDatabase(o: { vault: string; files: readonly string[]; known?: VaultRecord | null; atRoot?: boolean }): Discovery {
  const folders = metastoreFolders(o.files);
  const known = o.known ?? null;
  if (folders.length > 1) throw multiple(folders);
  if (o.atRoot) {
    if (folders.length === 1 && folders[0] !== "") throw notAtRoot(o.vault, folders[0]!);
    return { database: "", movedFrom: null, exists: folders.length === 1 };
  }
  if (folders.length === 1) {
    const database = folders[0]!;
    const moved = known !== null && known.database !== database && idAt(o.vault, database) === known.id;
    return { database, movedFrom: moved ? known.database : null, exists: true };
  }
  return { database: known?.database ?? DEFAULT_DATABASE_FOLDER, movedFrom: null, exists: false };
}

function notAtRoot(folder: string, database: string): StoreSetupError {
  return new StoreSetupError(
    `${folder} is not a database folder: its database is in ${database}/ (${database}/${METASTORE})`,
    guide(`Open the folder as a vault with --vault "${folder}", or the database itself with --database "${path.join(folder, ...database.split("/"))}". configure_database root "" moves the database to the root of the folder.`, "databaseOrVault"),
  );
}

function multiple(folders: readonly string[]): StoreSetupError {
  return new StoreSetupError(
    `the vault holds more than one database: ${folders.map((f) => inDatabase(f, METASTORE)).join(", ")}`,
    guide(`A vault holds exactly one database. Keep the database's folder, then remove the extra ${METASTORE} (or move its tables into the database with create_table and insert_row) and start the engine again.`, "oneDatabase"),
  );
}

/**
 * Record where the database is: the store's record and the data home's registry (step 4). A store
 * named by `--store` is not registered (`home` null): it is found by naming it again.
 */
export function recordStore(home: string | null, store: string, vault: string, id: string, database: string, movedVault: string | null = null): void {
  const rec = readJson(path.join(store, STORE_RECORD_FILE)) ?? {};
  let real = path.resolve(vault);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // keep the path given
  }
  writeJson(path.join(store, STORE_RECORD_FILE), { ...rec, id, vault: real, database, updated_at: new Date().toISOString() });
  if (home === null) return;
  const registryFile = path.join(home, REGISTRY_FILE);
  const registry = readRegistry(home);
  if (movedVault) delete registry[vaultKey(movedVault)];
  const key = vaultKey(vault);
  if (registry[key]?.id === id && registry[key]?.database === database) return;
  registry[key] = { id, database };
  writeJson(registryFile, registry);
}

/**
 * The lock of a store folder, when an engine refreshed its heartbeat lately (the commands of
 * `datanotes store`). A lock naming this process (openStore claims the store) does not count.
 */
export function freshLock(dir: string, now = Date.now()): EngineLock | null {
  const lock = readJson(path.join(dir, LOCK_FILE)) as EngineLock | null;
  if (lock && lock.pid === process.pid && lock.host === os.hostname()) return null;
  return lock && now - Date.parse(lock.heartbeat) < LOCK_STALE_MS ? lock : null;
}

/** When this machine started, ms: a lock written before it is left by a process that is gone. */
const bootTime = (now: number) => now - os.uptime() * 1000;

/**
 * The lock of a store folder, when another engine holds it. On this machine the process decides:
 * a live process holds it, even one whose heartbeat stopped (hung: its store must not change
 * underneath it); a process that is gone does not, even with a fresh heartbeat (ended by force).
 * A lock written before the machine started is left over. On another machine, the heartbeat
 * decides. `self` is this process: its own lock does not count.
 */
export function heldLock(dir: string, o: { now?: number; self?: number; alive?: (pid: number) => boolean } = {}): EngineLock | null {
  const lock = readJson(path.join(dir, LOCK_FILE)) as EngineLock | null;
  if (!lock || typeof lock.pid !== "number") return null;
  const now = o.now ?? Date.now();
  const beat = Date.parse(lock.heartbeat);
  if (lock.host !== os.hostname()) return now - beat < LOCK_STALE_MS ? lock : null;
  if (lock.pid === (o.self ?? process.pid) || beat < bootTime(now)) return null;
  return (o.alive ?? processAlive)(lock.pid) ? lock : null;
}

/** How long a start waits for another start on the same vault to finish setting up, ms. */
export const SETUP_WAIT_MS = 60_000;
/** The lock a start holds while it sets up the store (in `<data home>/setup/`, or in the `--store` store). */
export const SETUP_LOCK_FILE = "setup.lock";
/** A setup lock of another machine (a shared data home) older than this is left over. */
const SETUP_STALE_MS = 10 * 60_000;

interface SetupLock {
  pid: number;
  host: string;
  at: string;
}

/** Whether the start that wrote a setup lock may still run. */
function setupAlive(h: SetupLock, self: number, now: number): boolean {
  const at = Date.parse(h.at);
  if (h.host !== os.hostname()) return now - at < SETUP_STALE_MS;
  if (h.pid === self || at < bootTime(now)) return false;
  return processAlive(h.pid);
}

/**
 * Take the setup lock of a vault: created with `wx`, so of two starts only one sets up the store
 * (writes the id, moves a store in); the other waits for it, up to `waitMs`, then refuses. A lock
 * left by a start that is gone is taken over. Returns the release.
 */
function takeSetupLock(file: string, self: number, waitMs: number): () => void {
  const mine = JSON.stringify({ pid: self, host: os.hostname(), at: new Date().toISOString(), nonce: Math.random() });
  makePrivateDir(path.dirname(file));
  const start = Date.now();
  let holder: SetupLock | null = null;
  for (let first = true; ; first = false) {
    if (!first) {
      if (Date.now() - start >= waitMs) {
        const who = holder ? `pid ${holder.pid} on ${holder.host}` : "another process";
        throw new StoreSetupError(
          `another engine is starting on this vault (${who}): it holds ${file}`,
          guide(`Wait until it has started: a database runs one engine at a time. If no engine is starting, the lock is left over: delete ${file} and start again.`, "oneEngine"),
        );
      }
      sleepSync(100);
    }
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === mine) remove(file);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code !== "EEXIST" && !TRANSIENT.has(code)) throw e;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // released meanwhile, or held for a moment by the system: try again
    }
    holder = readSetupLock(text);
    const leftOver = holder ? !setupAlive(holder, self, Date.now()) : Date.now() - mtimeOf(file) > 5_000;
    if (leftOver) {
      try {
        if (fs.readFileSync(file, "utf8") === text) remove(file);
      } catch {
        // gone already
      }
    }
  }
}

function readSetupLock(text: string): SetupLock | null {
  try {
    const v = JSON.parse(text) as Partial<SetupLock>;
    return typeof v.pid === "number" && typeof v.host === "string" && typeof v.at === "string" ? (v as SetupLock) : null;
  } catch {
    return null;
  }
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Where the setup lock of a vault is: in the `--store` store, else in the data home, named by the vault. */
export function setupLockFile(home: string, explicit: string | undefined, vault: string): string {
  if (explicit) return path.join(path.resolve(explicit), SETUP_LOCK_FILE);
  return path.join(home, "setup", `${createHash("sha256").update(vaultKey(vault)).digest("hex").slice(0, 32)}.lock`);
}

function engineHolds(lock: EngineLock, dir: string, what: string, stop: string): StoreSetupError {
  return new StoreSetupError(
    `${what} (pid ${lock.pid} on ${lock.host}, port ${lock.port})`,
    guide(`${stop} If pid ${lock.pid} is not a Datanotes engine, the lock is left over: delete ${path.join(dir, LOCK_FILE)} and start again.`, "oneEngine"),
  );
}

/**
 * Steps 1 to 5 above: the store ready, the database found. Two starts on the same vault take
 * turns (the setup lock); the store's `engine.lock` then names this process, with port 0 (not
 * serving yet), until the service holds it: a second start refuses.
 */
export function openStore(o: StoreOptions): OpenedStore {
  const env = o.env ?? process.env;
  const vault = path.resolve(o.vault);
  const home = dataHome(env);
  const explicit = o.store ?? env.DATANOTES_STORE;
  const self = o.pid ?? process.pid;
  // The data home (or the --store store) is private before anything is written in it.
  makePrivateDir(explicit ? path.resolve(explicit) : home);
  const release = takeSetupLock(setupLockFile(home, explicit, vault), self, o.setupWaitMs ?? SETUP_WAIT_MS);
  try {
    return setUp(o, vault, home, explicit, self);
  } finally {
    release();
  }
}

function setUp(o: StoreOptions, vault: string, home: string, explicit: string | undefined, self: number): OpenedStore {
  // What this machine knows of the vault: the --store store's record, else the registry.
  const record = explicit ? readJson(path.join(path.resolve(explicit), STORE_RECORD_FILE)) : null;
  const known: VaultRecord | null = explicit
    ? typeof record?.id === "string" && typeof record.database === "string"
      ? { id: record.id, database: record.database }
      : null
    : (readRegistry(home)[vaultKey(vault)] ?? null);

  const found = discoverDatabase({ vault, files: o.files(), known, ...(o.atRoot ? { atRoot: true } : {}) });
  const database = found.database;
  const inFile = found.exists ? idAt(vault, database) : null;
  const id = inFile ?? (known && (!found.exists || known.database === database || found.movedFrom) ? known.id : null) ?? newDatabaseId();
  const store = explicit ? path.resolve(explicit) : path.join(home, id);
  // A running engine holds the database: nothing changes underneath it.
  const running = heldLock(store, { self });
  if (running) throw engineHolds(running, store, "another engine holds the vault", `Stop it first (datanotes stop --vault "${vault}"): a database runs one engine at a time.`);
  let idAdded = false;
  if (found.exists && !inFile) {
    // before the store exists (its place depends on the id): the host re-reads the file after
    const file = path.join(vault, ...database.split("/"), METASTORE);
    writeTextAtomic(file, withMetastoreId(fs.readFileSync(file, "utf8"), id));
    idAdded = true;
  }
  // The id in metastore.yaml changed since the last start (another copy of a synced vault gave
  // it, or new-id ran): this vault's store follows it.
  const ownedHere = (rec: Record<string, unknown> | null) => !rec || (typeof rec.vault === "string" && vaultKey(rec.vault) === vaultKey(vault));
  if (known && known.id !== id && inFile && !found.movedFrom) {
    const previous = explicit ? null : path.join(home, known.id);
    if (explicit && !ownedHere(record)) {
      throw new StoreSetupError(
        `the store ${store} belongs to the database ${known.id}, not to this vault's database ${id}`,
        guide("Pass the store of this database with --store (or DATANOTES_STORE), or leave it out: the engine then finds the store by the id.", "store"),
      );
    }
    if (previous && fs.existsSync(previous) && !fs.existsSync(store) && ownedHere(readJson(path.join(previous, STORE_RECORD_FILE)))) retrying(() => fs.renameSync(previous, store));
    o.log?.("INFO", `datanotes: the database's id changed from ${known.id} to ${id}: the store is ${store}`);
  }

  // A copied database, or a moved vault.
  const rec = readJson(path.join(store, STORE_RECORD_FILE));
  let movedVault: string | null = null;
  if (rec && typeof rec.vault === "string" && vaultKey(rec.vault) !== vaultKey(vault)) {
    const recDb = typeof rec.database === "string" ? rec.database : DEFAULT_DATABASE_FOLDER;
    if (fs.existsSync(rec.vault) && holdsDatabase(rec.vault, recDb, id)) {
      throw new StoreSetupError(
        `this database (id ${id}) is a copy: the vault ${rec.vault} holds it too, and its store ${store} is that vault's`,
        guide(`Give the copy its own id and a new, empty store: datanotes store new-id --vault "${vault}". Or, to keep the copy's history, open it with its own --store.`, "copiedDatabase"),
      );
    }
    movedVault = rec.vault;
    o.log?.("INFO", `datanotes: the vault moved from ${rec.vault} to ${vault}: the store follows it`);
  }

  const registry = explicit ? null : home;
  const settingsFile = o.settingsFile ? path.resolve(o.settingsFile) : path.join(store, SETTINGS_FILE);
  // The store, its secrets and the data home private: also what an older version created open.
  makePrivateDir(store);
  const open = tightenPrivate([...(registry ? [registry] : []), store, settingsFile, path.join(store, WEBHOOKS_FILE)]);
  /* v8 ignore next -- only a file owned by another user refuses the change */
  if (open.length > 0) o.log?.("WARN", `datanotes: could not make private (0700 folders, 0600 files): ${open.join(", ")}`);
  recordStore(registry, store, vault, id, database, movedVault);
  // The database is this process's until the service holds it (port 0: not serving yet).
  const at = new Date().toISOString();
  writeJson(path.join(store, LOCK_FILE), { kind: "service", pid: self, host: os.hostname(), port: 0, startedAt: at, heartbeat: at } satisfies EngineLock);
  const moved = found.movedFrom ? { from: found.movedFrom, to: database } : null;
  return { store, id, database, settingsFile, home: registry, idAdded, moved, movedVault };
}
