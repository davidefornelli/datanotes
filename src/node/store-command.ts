/**
 * `datanotes store`: the engine's store of a vault's database, from the command line.
 *
 *   datanotes store path --vault <folder> [--store <folder>] [--json]
 *   datanotes store new-id --vault <folder>
 *   datanotes store backup --vault <folder> [--remote <url>] [--ssh-command <cmd>] [--interval-s <seconds>]
 *                          [--off] [--json]
 *   datanotes store restore --from <url> --vault <folder> [--store <folder>]
 *                           [--port <port>] [--force] [--no-backup]
 *   datanotes store convert-log --to <files | segments> --vault <folder> [--store <folder>]
 *                               [--settings <file>] [--json]
 *
 * `path` says where the store is and which database it serves (with `--json`, the database folder
 * on disk too: `database_path`). `new-id` gives the database a new
 * id: a copy of a vault (its database holds the original's id, and the engine refuses to share the
 * original's store) then gets a new, empty store of its own. Run it with the engine stopped.
 *
 * `backup` shows or sets the store backup (store-backup.ts): `--remote` turns it on (the settings
 * `storeBackupEnabled`, `storeBackupRemote`), makes the store a git repository and pushes it once, with
 * no stop deadline (a large store takes minutes); `--ssh-command` saves the store repository's
 * `core.sshCommand` (otherwise the vault repository's is copied); `--off` turns it off (the
 * repository stays). `restore` clones a store backup next to the store of the vault's database
 * (found by the id in its metastore.yaml), checks it, then puts it in place, with new settings and
 * a new owner token, printed once. `new-id`, `backup` (when it changes something), `restore` and
 * `convert-log` hold the store while they run (claimStore): only while no engine runs on it, and
 * an engine started meanwhile refuses to start.
 *
 * `convert-log` writes every table's transaction log in the other format (transaction-log.ts:
 * `files`, one file per version, which Datanotes 3.0 reads; `segments`, a few large files) and
 * sets `transactionLogFormat` in the settings, so the engine keeps writing that format. Run it
 * with the engine stopped; `--to files` before going back to Datanotes 3.0. It holds the store
 * while it runs.
 */

import { randomBytes } from "node:crypto";
import { folderArg, readOptions, type OptionSpec } from "../api/cli-options";
import { inDatabase } from "../core/db-paths";
import fs from "node:fs";
import path from "node:path";
import { dataHome, LOCK_FILE, METASTORE, readDatabaseId, readRegistry, REGISTRY_FILE, SETTINGS_FILE, storeLocation, vaultKey, type EngineLock } from "../api/local";
import { newDatabaseId, withMetastoreId } from "../core/database-id";
import { guide } from "../core/hints";
import { messageOf } from "../core/message";
import { runGit, type GitRunner } from "./git-sync";
import { tightenPrivate } from "./private-files";
import { DATABASE_ID_TRAILER, MIN_EVERY_S, parseEvery, prepareStoreRepo, redactRemote, StoreBackup } from "./store-backup";
import type { App } from "../core/host";
import { storeFlush } from "../core/store";
import { convertLog, loggedTables, type ConvertedLog } from "../core/transaction-log";
import { nodeStoreFiles } from "./store-files";
import { claimStore, discoverDatabase, fileRetry, recordStore, retrying, StoreSetupError, writeJson, writeTextAtomic } from "./store-setup";

type Env = Record<string, string | undefined>;

/** The vault's files (vault-relative, dot-folders left out), for the database's discovery. */
function vaultFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(root, "");
  return out;
}

export interface StoreCommandIo {
  env?: Env;
  write?: (text: string) => void;
  /** How git runs (tests). */
  run?: GitRunner;
}

const COMMANDS = ["path", "new-id", "backup", "restore", "convert-log"];

/** The options of each `datanotes store` command. */
/** The options of each `datanotes store` command. */
export const STORE_OPTIONS: Record<string, OptionSpec> = {
  path: { values: ["vault", "database", "store"], flags: ["json"] },
  "new-id": { values: ["vault", "database", "store"] },
  backup: { values: ["vault", "database", "store", "settings", "remote", "interval-s", "ssh-command"], flags: ["off", "json"] },
  restore: { values: ["vault", "database", "store", "settings", "from", "port"], flags: ["force", "no-backup"] },
  "convert-log": { values: ["vault", "database", "store", "settings", "to"], flags: ["json"] },
};

/** `datanotes store <path | new-id>`: returns the exit code. */
export async function main(argv: string[], io: StoreCommandIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const write = io.write ?? ((t: string) => void process.stdout.write(t));
  const [sub, ...rest] = argv;
  if (!COMMANDS.includes(sub ?? "")) throw new Error(`unknown store command "${sub ?? ""}": datanotes store path | new-id | backup | restore | convert-log --database <folder>`);
  const o = readOptions(rest, STORE_OPTIONS[sub!]!, `datanotes store ${sub}`);
  const get = (name: string) => o.get(name);
  const has = (name: string) => o.has(name);
  const folder = folderArg(o, env, `datanotes store ${sub}`)!;
  const vault = path.resolve(folder.folder);
  const store = get("store") ?? env.DATANOTES_STORE;

  if (sub === "path") {
    const loc = storeLocation(vault, { env, ...(store ? { store } : {}) });
    // the database folder on disk, metastore.yaml at its root ("" with --database: the folder itself)
    const databasePath = loc ? path.join(vault, ...loc.database.split("/")) : null;
    if (has("json")) write(`${JSON.stringify({ vault, store: loc?.store ?? null, database_id: loc?.id ?? null, database_folder: loc?.database ?? null, database_path: databasePath }, null, 2)}\n`);
    else if (!loc) write(`datanotes store: no store yet for ${vault} (the engine makes it at its first start)\n`);
    // a database at the folder's root (--database) is the folder "": the folder itself is shown
    else write(`store      ${loc.store}\ndatabase   ${loc.database || vault} (id ${loc.id ?? "unknown"})\n`);
    return loc ? 0 : 2;
  }

  const ctx: Ctx = { vault, env, write, run: io.run ?? runGit, ...(store ? { store } : {}) };
  if (sub === "backup") return backupCommand(has, get, ctx);
  if (sub === "restore") return restoreCommand(has, get, ctx);
  if (sub === "convert-log") return convertLogCommand(has, get, ctx);

  const home = dataHome(env);
  const known = readRegistry(home)[vaultKey(vault)] ?? null;
  const found = discoverDatabase({ vault, files: vaultFiles(vault), known, ...(folder.atRoot ? { atRoot: true } : {}) });
  const file = path.join(vault, ...found.database.split("/"), METASTORE);
  if (!found.exists) {
    throw new StoreSetupError(`${inDatabase(found.database, METASTORE)} does not exist: there is no database to give a new id`, guide("Start the engine once on the folder: it creates the database with its id.", "copiedDatabase"));
  }
  const text = fs.readFileSync(file, "utf8");
  const old = readDatabaseId(text);
  const held = old ? (store ? path.resolve(store) : path.join(home, old)) : null;
  // the old id's store is this command's while the id changes (when it exists): an engine of this
  // machine that lives (even hung), or a fresh one elsewhere, refuses it; one started meanwhile refuses to start
  const release =
    held && fs.existsSync(held)
      ? claimStore(
          { vault, store: held, env, ...(store ? { explicit: store } : {}) },
          (lock) => new StoreSetupError(`an engine holds this database (pid ${lock.pid} on ${lock.host}, port ${lock.port})`, guide("Stop the engine first: the id changes only while no engine runs on the database.", "copiedDatabase")),
        )
      : null;
  const id = newDatabaseId();
  try {
    writeTextAtomic(file, withMetastoreId(text, id));
    const registry = readRegistry(home);
    registry[vaultKey(vault)] = { id, database: found.database };
    writeJson(path.join(home, REGISTRY_FILE), registry);
  } finally {
    release?.();
  }
  write(
    `datanotes store: ${found.database}/${METASTORE} has the new id ${id}${old ? ` (was ${old})` : ""}\n` +
      `store      ${store ? path.resolve(store) : path.join(home, id)} (new and empty: the next start makes new settings, owner token, journal and history)\n`,
  );
  return 0;
}

interface Ctx {
  vault: string;
  env: Env;
  write: (text: string) => void;
  run: GitRunner;
  store?: string;
}

function readSettings(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A text (a git error) without the credentials of the URLs in it. */
const redactText = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]*@/gi, "$1");

/**
 * The time limit of the local git commands (`add`, `commit`) of the first backup: the first commit
 * of a large store hashes every file (3,400 files, 150 MB take well over a minute on a slow disk).
 * The push keeps its own: 10 min, or `DATANOTES_GIT_NETWORK_TIMEOUT_S` seconds.
 */
export const FIRST_BACKUP_LOCAL_TIMEOUT_MS = 30 * 60_000;

/** "every 60 s when something changed, each followed by a push". */
const cadenceText = (every: number) => `every ${every} s when something changed, each followed by a push`;

/** The refusal of a command that changes the store while an engine holds it (claimStore's `refuse`). */
function engineRunning(lock: EngineLock, what: string): StoreSetupError {
  return new StoreSetupError(
    `an engine holds this database (pid ${lock.pid} on ${lock.host}, port ${lock.port})`,
    guide(`Stop the engine first: ${what} runs only while no engine runs on the database. To back up a running engine for this run only, restart it with --store-backup-remote <url>.`, "storeBackup"),
  );
}

/**
 * The refusal of a restore whose swap failed (a virus scan holding the clone's files, an engine
 * started meanwhile): the store that was there goes back in place when it can, the clone goes.
 * `moved`: the store in place was already moved aside (`keptAside`) or, holding only a lock, removed.
 * `existed`: a store was there before the restore; otherwise the folder held only this command's claim.
 */
function notPlaced(e: unknown, o: { target: string; tmp: string; keptAside: string | null; moved: boolean; existed: boolean }): StoreSetupError {
  const code = (e as NodeJS.ErrnoException).code ?? messageOf(e);
  let where: string;
  let back = true;
  let taken = false;
  if (!o.moved) where = `the store ${o.target} is unchanged`;
  else if (!o.keptAside) where = o.existed ? `the store ${o.target} held only the lock of an engine that is gone` : `there was no store in ${o.target}, and there is none now`;
  else {
    const aside = o.keptAside;
    try {
      // an engine started meanwhile made a new store there: never rename over it
      if (fs.existsSync(o.target)) {
        taken = true;
        throw new Error("taken");
      }
      retrying(() => fs.renameSync(aside, o.target));
      where = `the store that was there is back in ${o.target}`;
    } catch {
      back = false;
      where = `the store that was there is in ${aside}`;
    }
  }
  let clone: string;
  try {
    fs.rmSync(o.tmp, { recursive: true, force: true, maxRetries: fileRetry.attempts, retryDelay: fileRetry.delayMs });
    clone = `the clone ${o.tmp} is removed`;
  } catch {
    clone = `the clone is left in ${o.tmp}`;
  }
  const close = "Close what holds files in the store folder (an engine started meanwhile, a virus scan, an editor)";
  const again = "run datanotes store restore again.";
  return new StoreSetupError(
    `could not put the restored store in place (${code}): ${where}; ${clone}`,
    guide(
      back
        ? `${close}, then ${again}`
        : taken
          ? `Stop the engine that started (datanotes stop), move away the store it made in ${o.target}, rename ${o.keptAside} back to ${o.target}, then ${again}`
          : `${close}. Rename ${o.keptAside} back to ${o.target}, then ${again}`,
      "restoreStore",
    ),
  );
}

/**
 * `datanotes store convert-log --to <files | segments>`: every table's transaction log in that
 * format, and the setting `transactionLogFormat` set to it. Only while no engine runs on the store.
 */
async function convertLogCommand(has: (name: string) => boolean, get: (name: string) => string | undefined, c: Ctx): Promise<number> {
  const to = get("to");
  if (to !== "files" && to !== "segments") {
    throw new StoreSetupError(
      to === undefined ? "--to is required: files or segments" : `--to must be files or segments: "${to}"`,
      guide("Pass --to segments to write the transaction log in a few large files, or --to files to write one file per version, which Datanotes 3.0 reads.", "convertLog"),
    );
  }
  const loc = storeLocation(c.vault, { env: c.env, ...(c.store ? { store: c.store } : {}) });
  if (!loc || !fs.existsSync(loc.store)) {
    throw new StoreSetupError(`no store yet for ${c.vault}: there is no transaction log to convert`, guide("Start the engine once on the vault (datanotes serve --vault <folder>): it makes the store.", "convertLog"));
  }
  // the store is this command's while it converts: an engine of this machine that lives (even
  // hung), or a fresh one elsewhere, refuses it; an engine started meanwhile refuses to start
  const release = claimStore(
    { vault: c.vault, store: loc.store, env: c.env, ...(c.store ? { explicit: c.store } : {}) },
    (lock) => new StoreSetupError(`an engine holds this database (pid ${lock.pid} on ${lock.host}, port ${lock.port})`, guide("Stop the engine first (datanotes stop): the log is converted only while no engine runs on the database.", "convertLog")),
  );
  const converted: ConvertedLog[] = [];
  try {
    // the store alone: the engine's functions reach it through App.store
    const app = { store: nodeStoreFiles(loc.store) } as unknown as App;
    for (const full of await loggedTables(app, {})) converted.push(await convertLog(app, {}, full, to));
    await storeFlush(app);
    const settingsFile = path.resolve(get("settings") ?? c.env.DATANOTES_SETTINGS ?? path.join(loc.store, SETTINGS_FILE));
    writeJson(settingsFile, { ...readSettings(settingsFile), transactionLogFormat: to });
  } finally {
    release();
  }
  const written = converted.reduce((n, t) => n + t.written, 0);
  const removed = converted.reduce((n, t) => n + t.removed, 0);
  if (has("json")) c.write(`${JSON.stringify({ store: loc.store, to, tables: converted.map((t) => ({ table: t.table, versions: t.versions, files_written: t.written, files_removed: t.removed })) }, null, 2)}\n`);
  else {
    c.write(
      `datanotes store convert-log: ${converted.length} table${converted.length === 1 ? "" : "s"}, ${written} file${written === 1 ? "" : "s"} written, ${removed} removed\n` +
        `setting    transactionLogFormat: ${to} (new versions are written ${to === "files" ? "one file each" : "to segments"})\n`,
    );
  }
  return 0;
}

/** `datanotes store backup`: show the store backup, or turn it on (`--remote`) or off (`--off`). */
async function backupCommand(has: (name: string) => boolean, get: (name: string) => string | undefined, c: Ctx): Promise<number> {
  const loc = storeLocation(c.vault, { env: c.env, ...(c.store ? { store: c.store } : {}) });
  if (!loc || !fs.existsSync(loc.store)) {
    throw new StoreSetupError(`no store yet for ${c.vault}: there is nothing to back up`, guide("Start the engine once on the vault (datanotes serve --vault <folder>): it makes the store. Then turn the backup on.", "storeBackup"));
  }
  const settingsFile = path.resolve(get("settings") ?? c.env.DATANOTES_SETTINGS ?? path.join(loc.store, SETTINGS_FILE));
  const settings = readSettings(settingsFile);
  const remote = get("remote")?.trim();
  const everyRaw = get("interval-s");
  const every = everyRaw === undefined ? undefined : parseEvery(everyRaw);
  const off = has("off");
  const sshCommand = get("ssh-command")?.trim();
  if (get("remote") !== undefined && !remote) {
    throw new StoreSetupError("--remote needs the URL of a git repository", guide("Pass the URL of an empty private repository, e.g. --remote git@github.com:you/vault-store.git, or --off to turn the backup off.", "storeBackup"));
  }
  if (get("ssh-command") !== undefined && (!sshCommand || !remote)) {
    throw new StoreSetupError(
      "--ssh-command needs a command, and goes with --remote <url>",
      guide("Pass the SSH command git uses for the store, with the remote, e.g. --remote git@github.com:you/vault-store.git --ssh-command C:/Windows/System32/OpenSSH/ssh.exe.", "storeBackupSsh"),
    );
  }
  if (remote && off) throw new StoreSetupError("--remote and --off cannot go together", guide("Pass --remote <url> to turn the backup on, or --off to turn it off.", "storeBackup"));
  if (every === null) {
    throw new StoreSetupError(
      `--interval-s must be a whole number of seconds, at least ${MIN_EVERY_S}: "${everyRaw}"`,
      guide(`Pass --interval-s 60 (a commit and push every 60 s when something changed, the default), or any number of seconds from ${MIN_EVERY_S}.`, "storeBackupCadence"),
    );
  }

  if (!remote && !off && every === undefined) {
    const on = settings.storeBackupEnabled === true;
    const url = typeof settings.storeBackupRemote === "string" && settings.storeBackupRemote ? redactRemote(settings.storeBackupRemote) : null;
    const cadence = parseEvery(settings.storeBackupIntervalSeconds) ?? 60;
    const last = fs.existsSync(path.join(loc.store, ".git")) ? await c.run(["log", "-1", "--format=%h %cI"], loc.store) : null;
    const lastCommit = last && last.code === 0 && last.stdout.trim() ? last.stdout.trim() : null;
    if (has("json")) c.write(`${JSON.stringify({ store: loc.store, enabled: on, remote: url, interval_s: cadence, last_commit: lastCommit }, null, 2)}\n`);
    else c.write(`store backup ${on ? "on" : "off"}\nstore        ${loc.store}\nremote       ${url ?? "none"}\ncommits      ${cadenceText(cadence)}\nlast commit  ${lastCommit ?? "none"}\n`);
    return 0;
  }

  // the store is this command's while it changes the settings and makes the first push: an engine
  // of this machine that lives (even hung), or a fresh one elsewhere, refuses it; one started meanwhile refuses to start
  const release = claimStore({ vault: c.vault, store: loc.store, env: c.env, ...(c.store ? { explicit: c.store } : {}) }, (lock) => engineRunning(lock, "datanotes store backup"));
  try {
    if (remote && !loc.id) {
      // every commit names the database: a restore checks it
      throw new StoreSetupError(
        `the database of ${c.vault} has no id yet: a store backup could not be matched to it`,
        guide("Start the engine once on the vault (datanotes serve --vault <folder>): it writes the id in metastore.yaml. Then turn the backup on.", "storeBackup"),
      );
    }
    if (every !== undefined) settings.storeBackupIntervalSeconds = every;
    if (off) {
      settings.storeBackupEnabled = false;
      writeJson(settingsFile, settings);
      c.write(`datanotes store: the store backup is off (the repository in ${loc.store} stays; --remote turns it on again)\n`);
      return 0;
    }
    if (!remote) {
      writeJson(settingsFile, settings);
      c.write(`datanotes store: the store backup commits ${cadenceText(every!)}\n`);
      return 0;
    }
    settings.storeBackupEnabled = true;
    settings.storeBackupRemote = remote;
    writeJson(settingsFile, settings);
    // the repository now, and a first push: a wrong URL or missing credentials show at once. No
    // stop deadline: the first commit and push of a large store take minutes
    const backup = new StoreBackup({
      store: loc.store,
      databaseId: loc.id!,
      remote,
      run: c.run,
      vault: c.vault,
      localTimeoutMs: FIRST_BACKUP_LOCAL_TIMEOUT_MS,
      ...(sshCommand ? { sshCommand } : {}),
    });
    const started = await backup.once((m) => c.write(`datanotes store: ${m}
`));
    const st = backup.status;
    c.write(`datanotes store: the store backup is on\nstore        ${loc.store}\nremote       ${redactRemote(remote)}\ncommits      ${cadenceText(parseEvery(settings.storeBackupIntervalSeconds) ?? 60)}\nlast commit  ${st.lastCommit ?? "none"}\nlast push    ${st.lastPush ?? "none"}\n`);
    // once() fails exactly when it set lastError
    if (!started) {
      c.write(
        `error        ${st.lastError!}\n` +
          `The setting is saved: the engine commits ${cadenceText(parseEvery(settings.storeBackupIntervalSeconds) ?? 60)} and retries the push. Check the URL, and that git push works from ${loc.store}.\n`,
      );
      return 1;
    }
    return 0;
  } finally {
    release();
  }
}

/** `datanotes store restore`: clone a store backup into the store of the vault's database. */
async function restoreCommand(has: (name: string) => boolean, get: (name: string) => string | undefined, c: Ctx): Promise<number> {
  const from = get("from")?.trim();
  if (!from) throw new StoreSetupError("pass --from <url>: the git repository the store was backed up to", guide("Name the store backup's repository, e.g. --from git@github.com:you/vault-store.git.", "restoreStore"));
  const shown = redactRemote(from);
  const portRaw = get("port");
  if (portRaw !== undefined && !(Number.isInteger(Number(portRaw)) && (Number(portRaw) === 0 || (Number(portRaw) >= 1024 && Number(portRaw) <= 65535)))) {
    throw new StoreSetupError(`--port must be from 1024 to 65535, or 0 for any free port: "${portRaw}"`, guide("Pass the port of the engine's HTTP API, e.g. --port 27150 (the default).", "restoreStore"));
  }
  const home = dataHome(c.env);
  const known = readRegistry(home)[vaultKey(c.vault)] ?? null;
  const found = discoverDatabase({ vault: c.vault, files: vaultFiles(c.vault), known });
  if (!found.exists) {
    throw new StoreSetupError(
      `${found.database}/${METASTORE} does not exist in ${c.vault}: there is no database to restore the store of`,
      guide("Restore the vault first (clone its git repository), then run datanotes store restore --vault on that folder.", "restoreStore"),
    );
  }
  const id = readDatabaseId(fs.readFileSync(path.join(c.vault, ...found.database.split("/"), METASTORE), "utf8"));
  if (!id) {
    throw new StoreSetupError(
      `${found.database}/${METASTORE} has no id: the store backup cannot be matched to the database`,
      guide("Restore the vault from the moment of the store backup: its metastore.yaml has the database's id on its first line.", "restoreStore"),
    );
  }
  const target = c.store ? path.resolve(c.store) : path.join(home, id);
  // the store is this command's while it restores: an engine of this machine that lives (even
  // hung), or a fresh one elsewhere, refuses it; one started meanwhile refuses to start. The store
  // in place keeps the claim during the clone; the clone takes its place with the claim in it.
  const existed = fs.existsSync(target);
  const release = claimStore({ vault: c.vault, store: target, env: c.env, ...(c.store ? { explicit: c.store } : {}) }, (lock) => engineRunning(lock, "datanotes store restore"));
  let placed = false;
  try {
    const held = fs.readdirSync(target).filter((f) => f !== LOCK_FILE);
    if (held.length > 0 && !has("force")) {
      throw new StoreSetupError(`the store ${target} already exists and is not empty`, guide("Pass --force to restore anyway: the existing store is kept aside, renamed <store>.before-restore-<time>, never deleted.", "restoreStore"));
    }
    // clone next to the store and check it: the store in place stays as it is until then
    const tmp = `${target}.restoring-${process.pid}`;
    const giveUp = (message: string, hint: string): StoreSetupError => {
      fs.rmSync(tmp, { recursive: true, force: true });
      return new StoreSetupError(message, guide(hint, "restoreStore"));
    };
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    // core.longpaths: Git for Windows refuses paths over 260 characters without it, during the
    // clone itself (the leading -c) and in the clone's own config afterwards
    const clone = await c.run(["-c", "core.longpaths=true", "clone", "-q", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", from, tmp], path.dirname(tmp));
    if (clone.code !== 0) throw giveUp(`git clone ${shown} failed: ${redactText(clone.stderr.trim() || clone.stdout.trim())}`, "Check the URL, and that git can read it as this user (git clone <url> works).");
    // the engine pushes to main, whatever branch the remote's HEAD names
    if ((await c.run(["rev-parse", "-q", "--verify", "refs/remotes/origin/main"], tmp)).code === 0) await c.run(["checkout", "-q", "-B", "main", "origin/main"], tmp);
    const head = await c.run(["log", "-1", "--format=%h %cI%n%B"], tmp);
    if (head.code !== 0 || !head.stdout.trim()) throw giveUp(`${shown} holds no commit: it is not a store backup`, "Name the repository the engine pushed the store to (datanotes store backup shows it).");
    const [first = "", ...body] = head.stdout.trim().split("\n");
    // [ \t]*: an empty trailer never takes the next line's first word as the id
    const trailer = new RegExp(`^${DATABASE_ID_TRAILER}:[ \\t]*(\\S+)`, "m").exec(body.join("\n"));
    if (trailer && trailer[1]!.toLowerCase() !== id) {
      throw giveUp(`${shown} is the store backup of the database ${trailer[1]}, not of this vault's database ${id}`, "Restore the vault that holds that database (its metastore.yaml has its id), or name the store backup of this one.");
    }
    // the clone takes the store's place with the claim in it: the store is never without the lock.
    // Synchronous from here to the last rename: no heartbeat writes in between
    let keptAside: string | null = null;
    let moved = false;
    try {
      fs.copyFileSync(path.join(target, LOCK_FILE), path.join(tmp, LOCK_FILE));
      if (held.length > 0) {
        const aside = `${target}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        retrying(() => fs.renameSync(target, aside));
        keptAside = aside;
        moved = true;
        fs.rmSync(path.join(aside, LOCK_FILE), { force: true });
      } else {
        moved = true;
        fs.rmSync(target, { recursive: true, force: true, maxRetries: fileRetry.attempts, retryDelay: fileRetry.delayMs });
      }
      retrying(() => fs.renameSync(tmp, target));
    } catch (e) {
      throw notPlaced(e, { target, tmp, keptAside, moved, existed });
    }
    placed = true;
    // git clone made the folder with the default mode: the store is private (private-files.ts)
    tightenPrivate([target]);
    try {
      await prepareStoreRepo(target, from, c.run, { vault: c.vault });
    } catch (e) {
      c.write(`datanotes store: warning: ${messageOf(e)}\n`);
    }
    for (const dir of ["logs", "semantic"]) fs.mkdirSync(path.join(target, dir), { recursive: true });
    recordStore(c.store ? null : home, target, c.vault, id, found.database);

    // what is not backed up: new settings, with a new owner token
    const token = randomBytes(24).toString("hex");
    const settingsFile = path.resolve(get("settings") ?? c.env.DATANOTES_SETTINGS ?? path.join(target, SETTINGS_FILE));
    const backupOn = !has("no-backup");
    const settings: Record<string, unknown> = { ...readSettings(settingsFile), httpServerToken: token, storeBackupEnabled: backupOn, ...(backupOn ? { storeBackupRemote: from } : {}) };
    if (portRaw !== undefined) settings.httpServerPort = Number(portRaw);
    writeJson(settingsFile, settings);
    let tokens = 0;
    try {
      tokens = (JSON.parse(fs.readFileSync(path.join(target, "tokens.json"), "utf8")) as unknown[]).length;
    } catch {
      tokens = 0;
    }
    c.write(
      `datanotes store: restored ${shown} (commit ${first})\n` +
        `store        ${target}\n` +
        `database     ${found.database} (id ${id})\n` +
        (keptAside ? `kept aside   ${keptAside} (the store that was there)\n` : "") +
        `settings     ${settingsFile} (store backup ${backupOn ? "on" : "off"})\n` +
        `owner token  ${token}\n` +
        `The owner token is new and shown only here; it is also in the settings file. ` +
        `${tokens} named token${tokens === 1 ? "" : "s"} restored. Webhooks are not backed up (their secrets): create them again.\n`,
    );
    return 0;
  } finally {
    release();
    // a store folder made only to hold the claim goes again (rmdir removes only an empty folder)
    if (!existed && !placed) {
      try {
        fs.rmdirSync(target);
      } catch {
        // not empty, or gone
      }
    }
  }
}
