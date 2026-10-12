/**
 * Find the engine running on a vault of this machine (Node only): its address and the owner's
 * token, read from the database's store, where the engine keeps its settings and the lock it holds
 * while it runs.
 *
 * The store is outside the vault, in the operating system's per-user data folder:
 * `<data home>/<database id>/`, the id being `id` in the database's `metastore.yaml`. The data home
 * is `%LOCALAPPDATA%\Datanotes` on Windows, `~/Library/Application Support/Datanotes` on macOS and
 * `$XDG_DATA_HOME/datanotes` (`~/.local/share/datanotes`) elsewhere. `DATANOTES_DATA_HOME` moves the
 * data home, `DATANOTES_STORE` (or `--store`) names the store folder itself. The engine finds a
 * vault's database again through `vaults.json` in the data home (vault → id and database folder).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The lock an engine writes in its store (`<store>/engine.lock`). */
export interface EngineLock {
  kind: "service";
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  heartbeat: string;
}

/** A lock whose heartbeat is older than this belongs to an engine that stopped. */
export const LOCK_STALE_MS = 30_000;

/** The engine's settings file, in the store. */
export const SETTINGS_FILE = "settings.json";
/** The lock, in the store. */
export const LOCK_FILE = "engine.lock";
/** The store's record of its database: id, vault, database folder. */
export const STORE_RECORD_FILE = "store.json";
/** In the data home: the vaults this machine's engines opened, with their database. */
export const REGISTRY_FILE = "vaults.json";
/** The database folder of a new database: a top-level folder of the vault. */
export const DEFAULT_DATABASE_FOLDER = "datanotes";
export const METASTORE = "metastore.yaml";

type Env = Record<string, string | undefined>;

/** The data home: the folder that holds the stores of this user's databases. */
export function dataHome(env: Env = process.env, platform: string = process.platform, home: string = os.homedir()): string {
  if (env.DATANOTES_DATA_HOME) return path.resolve(env.DATANOTES_DATA_HOME);
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Datanotes");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Datanotes");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "datanotes");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The database id of a `metastore.yaml` text (its top-level `id:`), or null. */
export function readDatabaseId(text: string): string | null {
  const m = /^id:[ \t]*(.*)$/m.exec(text);
  const value = m ? m[1]!.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "") : "";
  return UUID.test(value) ? value.toLowerCase() : null;
}

/** The database id of a vault's database folder, or null (no metastore, or no id in it). */
export function databaseIdIn(vault: string, database: string): string | null {
  try {
    return readDatabaseId(fs.readFileSync(path.join(vault, ...database.split("/"), METASTORE), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The folders of a vault on disk that hold a `metastore.yaml` (vault-relative with `/`, sorted).
  * A vault has exactly one database folder, anywhere ("" for the root: --database). Dot-folders and
 * `node_modules` are left out.
 */
export function vaultMetastores(vault: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name === METASTORE) out.push(rel);
    }
  };
  walk(vault, "");
  return out.sort();
}

/** A vault as the registry names it: its real path (lowercase on Windows, whose paths ignore case). */
export function vaultKey(vault: string, platform: string = process.platform): string {
  let real = path.resolve(vault);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // a vault that does not exist (any more) keeps the path given
  }
  return platform === "win32" ? real.toLowerCase() : real;
}

export interface VaultRecord {
  /** The database id. */
  id: string;
  /** The database folder, vault-relative. */
  database: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The registry of a data home: vault key → database id and folder. */
export function readRegistry(home: string): Record<string, VaultRecord> {
  const raw = readJson(path.join(home, REGISTRY_FILE)) ?? {};
  const out: Record<string, VaultRecord> = {};
  for (const [k, v] of Object.entries(raw)) {
    const r = v as Partial<VaultRecord> | null;
    if (r && typeof r.id === "string" && UUID.test(r.id) && typeof r.database === "string") out[k] = { id: r.id, database: r.database };
  }
  return out;
}

export interface StoreLocation {
  /** The store folder. */
  store: string;
  /** The database id (null: a store named by DATANOTES_STORE whose record does not say it). */
  id: string | null;
  /** The database folder, vault-relative. */
  database: string;
}

export interface LocateOptions {
  env?: Env;
  /** The store folder itself (`--store`; else DATANOTES_STORE). */
  store?: string;
}

/** The vault's one folder with a `metastore.yaml`, else `datanotes`. */
export function vaultDatabaseFolder(vault: string): string {
  const found = vaultMetastores(vault);
  return found.length === 1 ? found[0]! : DEFAULT_DATABASE_FOLDER;
}

/**
 * Where the store of a vault's database is, as the engine finds it: the store named by `--store`
 * or DATANOTES_STORE; else the database this machine last opened on the vault (`vaults.json`);
 * else the id in the vault's one `metastore.yaml`. Null when none of them says.
 */
export function storeLocation(vault: string, opts: LocateOptions = {}): StoreLocation | null {
  const env = opts.env ?? process.env;
  const explicit = opts.store ?? env.DATANOTES_STORE;
  if (explicit) {
    const store = path.resolve(explicit);
    const rec = readJson(path.join(store, STORE_RECORD_FILE));
    const database = typeof rec?.database === "string" ? rec.database : vaultDatabaseFolder(vault);
    return { store, id: typeof rec?.id === "string" ? rec.id : databaseIdIn(vault, database), database };
  }
  const home = dataHome(env);
  const known = readRegistry(home)[vaultKey(vault)];
  if (known) return { store: path.join(home, known.id), id: known.id, database: known.database };
  const database = vaultDatabaseFolder(vault);
  const id = databaseIdIn(vault, database);
  return id ? { store: path.join(home, id), id, database } : null;
}

export interface LocalEngine {
  url: string;
  token: string;
  lock: EngineLock;
}

/** The settings file of a vault's engine, in its store; null while the vault has no store yet. */
export function vaultSettingsPath(vault: string, opts: LocateOptions = {}): string | null {
  const loc = storeLocation(vault, opts);
  return loc ? path.join(loc.store, SETTINGS_FILE) : null;
}

/**
 * The engine holding `vault`, or null when none runs. Throws when the lock is fresh but held on
 * another machine (a store on a shared folder): that engine is not reachable from here.
 */
export function localEngine(vault: string, opts: LocateOptions & { settingsFile?: string; host?: string; now?: number } = {}): LocalEngine | null {
  const loc = storeLocation(vault, opts);
  if (!loc) return null;
  const lock = readJson(path.join(loc.store, LOCK_FILE)) as EngineLock | null;
  if (!lock || (opts.now ?? Date.now()) - Date.parse(lock.heartbeat) >= LOCK_STALE_MS) return null;
  if (lock.host !== os.hostname()) throw new Error(`the vault is held by an engine on ${lock.host}; connect to it by its address`);
  const settings = readJson(opts.settingsFile ?? path.join(loc.store, SETTINGS_FILE)) ?? {};
  const token = typeof settings.httpServerToken === "string" ? settings.httpServerToken : "";
  if (!token) return null;
  return { url: `http://${opts.host ?? "127.0.0.1"}:${lock.port}`, token, lock };
}
