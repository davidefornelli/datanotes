/**
 * Where the headless engine keeps its store and which folder is the database (src/node/store-setup.ts):
 * the order the database is found in, the id written into metastore.yaml, the store's record and
 * the registry, a copied database refused, a moved vault followed. Also: transient Windows file
 * errors retried, the locks of other engines read by their process, two starts on the same vault
 * taking turns.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_FOLDER, readRegistry, vaultKey } from "../src/api/local";
import { metastoreId } from "../src/core/database-id";
import { docsUrl } from "../src/core/hints";
import {
  CLAIM_HEARTBEAT,
  claimStore,
  discoverDatabase,
  fileRetry,
  freshLock,
  heldLock,
  metastoreFolders,
  openStore,
  recordStore,
  retrying,
  setupLockFile,
  StoreSetupError,
  writeJson,
  type StoreOptions,
} from "../src/node/store-setup";
import { main as storeCommand } from "../src/node/store-command";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ID = "0192e000-0000-7000-8000-000000000001";
const OTHER = "0192e000-0000-7000-8000-000000000002";
const META = "# Metastore (Datanotes): catalogs, schemas, tables, columns, views.\ncatalogs: {}\n";

function tmp(prefix = "store-setup-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function write(root: string, rel: string, text: string): void {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

/** The vault's files as the host's index lists them (dot-folders left out). */
function files(root: string): string[] {
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

function open(vault: string, home: string, o: Partial<StoreOptions> = {}) {
  const logs: string[] = [];
  const r = openStore({ vault, env: { DATANOTES_DATA_HOME: home }, files: () => files(vault), log: (level, msg) => logs.push(`${level} ${msg}`), ...o });
  return { ...r, logs };
}

describe("the database folder: the folder of the vault's one metastore.yaml", () => {
  it("is the one metastore of the vault, at any depth; the last known folder that moved is reported as moved", () => {
    const vault = tmp();
    write(vault, "Life/Areas/Db/metastore.yaml", `id: ${ID}\n${META}`);
    write(vault, "Notes/x.md", "x\n");
    const d = (o: Partial<Parameters<typeof discoverDatabase>[0]>) => discoverDatabase({ vault, files: files(vault), ...o });
    expect(d({})).toEqual({ database: "Life/Areas/Db", movedFrom: null, exists: true });
    expect(d({ known: { id: ID, database: "Life/Areas/Db" } })).toEqual({ database: "Life/Areas/Db", movedFrom: null, exists: true });
    // moved by hand into a subfolder, or out of one: found by its id
    expect(d({ known: { id: ID, database: "Datanotes" } })).toEqual({ database: "Life/Areas/Db", movedFrom: "Datanotes", exists: true });
    // another database's id: not a move (the id change is handled by openStore)
    expect(d({ known: { id: OTHER, database: "Datanotes" } }).movedFrom).toBeNull();
  });

  it("finds the root too (\"\"), and leaves out node_modules (a package's own metastore)", () => {
    expect(metastoreFolders(["metastore.yaml", "node_modules/x/metastore.yaml", "Db/metastore.yaml", "Db/metastore.yaml.bak", "A/B/node_modules/metastore.yaml"])).toEqual(["", "Db"]);
    expect(metastoreFolders(["metastore.yaml", "notes.md"])).toEqual([""]);
  });

  it("--database: the folder is the database; a database in a subfolder is refused, naming --vault", () => {
    const at = (files: string[]) => discoverDatabase({ vault: "/f", files, atRoot: true });
    expect(at([])).toEqual({ database: "", movedFrom: null, exists: false });
    expect(at(["metastore.yaml", "main/public/film/Metropolis.md"])).toEqual({ database: "", movedFrom: null, exists: true });
    let e: unknown;
    try {
      at(["Db/metastore.yaml"]);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(StoreSetupError);
    expect((e as StoreSetupError).message).toBe("/f is not a database folder: its database is in Db/ (Db/metastore.yaml)");
    expect((e as StoreSetupError).hint).toMatch(/^Open the folder as a vault with --vault "\/f", or the database itself with --database ".*Db"/);
    expect((e as StoreSetupError).docs).toBe(docsUrl("databaseOrVault"));
    // --vault finds a database at its root too
    expect(discoverDatabase({ vault: "/f", files: ["metastore.yaml"] })).toEqual({ database: "", movedFrom: null, exists: true });
  });

  it("is refused when the vault holds more than one metastore.yaml, at any depth: the error lists them", () => {
    const vault = tmp();
    write(vault, "datanotes/metastore.yaml", `id: ${ID}\n`);
    write(vault, "Archive/Old/Db/metastore.yaml", META);
    let err: StoreSetupError | undefined;
    try {
      open(vault, tmp());
    } catch (e) {
      err = e as StoreSetupError;
    }
    expect(err?.message).toBe("the vault holds more than one database: Archive/Old/Db/metastore.yaml, datanotes/metastore.yaml");
    expect(err?.hint).toBe("A vault holds exactly one database. Keep the database's folder, then remove the extra metastore.yaml (or move its tables into the database with create_table and insert_row) and start the engine again.");
    expect(err?.docs).toBe("https://datanotes.dev/administration/run-the-service.md#one-database-per-vault");
    // the last known folder does not settle it either
    expect(() => discoverDatabase({ vault, files: files(vault), known: { id: ID, database: "datanotes" } })).toThrow(StoreSetupError);
  });

  it("is a new database without any metastore: datanotes/, or the last known folder", () => {
    const vault = tmp();
    expect(discoverDatabase({ vault, files: [] })).toEqual({ database: "datanotes", movedFrom: null, exists: false });
    expect(discoverDatabase({ vault, files: [], known: { id: ID, database: "Known" } }).database).toBe("Known");
  });

  it("keeps an existing Datanotes/ or Database/ folder as it is found", () => {
    for (const name of ["Datanotes", "Database"]) {
      const vault = tmp();
      write(vault, `${name}/metastore.yaml`, META);
      const r = open(vault, tmp());
      expect(r.database).toBe(name);
      expect(fs.existsSync(path.join(vault, name, "metastore.yaml"))).toBe(true);
    }
  });
});

describe("the database id and the store", () => {
  it("writes an id into a metastore without one, once, and keeps the store at <data home>/<id>", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", META);
    const first = open(vault, home);
    expect(first.idAdded).toBe(true);
    const id = metastoreId(read(vault, "Datanotes/metastore.yaml"))!;
    expect(first.id).toBe(id);
    expect(read(vault, "Datanotes/metastore.yaml")).toBe(`# Metastore (Datanotes): catalogs, schemas, tables, columns, views.\nid: ${id}\ncatalogs: {}\n`);
    expect(first.store).toBe(path.join(home, id));
    expect(first.settingsFile).toBe(path.join(home, id, "settings.json"));
    expect(JSON.parse(read(first.store, "store.json"))).toMatchObject({ id, vault: fs.realpathSync.native(vault), database: "Datanotes" });
    expect(readRegistry(home)).toEqual({ [vaultKey(vault)]: { id, database: "Datanotes" } });
    const again = open(vault, home);
    expect([again.idAdded, again.id, again.moved, again.movedVault]).toEqual([false, id, null, null]);
  });

  it("keeps the id it knew for the vault when the metastore lost it, and gives a database without a metastore its id", () => {
    const vault = tmp();
    const home = tmp();
    const first = open(vault, home);
    expect(first.idAdded).toBe(false);
    expect(fs.existsSync(path.join(vault, DEFAULT_DATABASE_FOLDER))).toBe(false);
    write(vault, `${DEFAULT_DATABASE_FOLDER}/metastore.yaml`, META);
    const later = open(vault, home);
    expect([later.id, later.idAdded]).toEqual([first.id, true]);
  });

  it("uses DATANOTES_STORE / --store as the store itself, not registered, and refuses a store of another database", () => {
    const vault = tmp();
    const home = tmp();
    const store = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    const r = open(vault, home, { env: { DATANOTES_DATA_HOME: home, DATANOTES_STORE: store } });
    expect([r.store, r.home]).toEqual([store, null]);
    expect(readRegistry(home)).toEqual({});
    // another vault's database
    const other = tmp();
    write(other, "Datanotes/metastore.yaml", `id: ${OTHER}\n`);
    expect(() => open(other, home, { store })).toThrow(`the store ${store} belongs to the database ${ID}, not to this vault's database ${OTHER}`);
    // this vault's database, whose id changed: the store's record follows
    write(vault, "Datanotes/metastore.yaml", `id: ${OTHER}\n`);
    const changed = open(vault, home, { store });
    expect(changed.logs).toContain(`INFO datanotes: the database's id changed from ${ID} to ${OTHER}: the store is ${store}`);
    expect(JSON.parse(read(store, "store.json")).id).toBe(OTHER);
  });

  it("follows an id another copy of a synced vault gave the database: the store moves to the new id", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    const first = open(vault, home);
    write(first.store, "journal/2026-10.jsonl", "{}\n");
    write(vault, "Datanotes/metastore.yaml", `id: ${OTHER}\n`);
    const r = open(vault, home);
    expect(r.store).toBe(path.join(home, OTHER));
    expect(read(r.store, "journal/2026-10.jsonl")).toBe("{}\n");
    expect(fs.existsSync(path.join(home, ID))).toBe(false);
    expect(readRegistry(home)[vaultKey(vault)]).toEqual({ id: OTHER, database: "Datanotes" });
  });

  it("ignores DATANOTES_DATABASE: the database is found by its metastore", () => {
    const vault = tmp();
    write(vault, "B/metastore.yaml", META);
    expect(open(vault, tmp(), { env: { DATANOTES_DATA_HOME: tmp(), DATANOTES_DATABASE: "A" } }).database).toBe("B");
  });
});

describe("a copied database, a moved vault", () => {
  it("refuses a copy while the original vault holds the database, and says how to give it its own id", () => {
    const home = tmp();
    const original = tmp();
    write(original, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    open(original, home);
    const copy = tmp();
    fs.cpSync(original, copy, { recursive: true });
    let err: StoreSetupError | undefined;
    try {
      open(copy, home);
    } catch (e) {
      err = e as StoreSetupError;
    }
    expect(err?.message).toBe(`this database (id ${ID}) is a copy: the vault ${fs.realpathSync.native(original)} holds it too, and its store ${path.join(home, ID)} is that vault's`);
    expect(err?.hint).toContain(`datanotes store new-id --vault "${copy}"`);
    expect(err?.docs).toBe("https://datanotes.dev/administration/run-the-service.md#run-a-copy-of-a-vault");
    // the original keeps the id in another folder: still a copy
    fs.renameSync(path.join(original, "Datanotes"), path.join(original, "Moved"));
    expect(() => open(copy, home)).toThrow(/is a copy/);
  });

  it("gives the copy its own id and an empty store with datanotes store new-id; path shows where", async () => {
    const home = tmp();
    const original = tmp();
    write(original, "Datanotes/metastore.yaml", `id: ${ID}\ncatalogs: {}\n`);
    open(original, home);
    const copy = tmp();
    fs.cpSync(original, copy, { recursive: true });
    let out = "";
    const env = { DATANOTES_DATA_HOME: home };
    expect(await storeCommand(["new-id", "--vault", copy], { env, write: (t) => (out += t) })).toBe(0);
    const id = metastoreId(read(copy, "Datanotes/metastore.yaml"))!;
    expect(id).not.toBe(ID);
    expect(read(copy, "Datanotes/metastore.yaml")).toBe(`id: ${id}\ncatalogs: {}\n`);
    expect(out).toContain(`has the new id ${id} (was ${ID})`);
    expect(readRegistry(home)[vaultKey(copy)]).toEqual({ id, database: "Datanotes" });
    const r = open(copy, home);
    expect([r.id, r.store, fs.existsSync(path.join(r.store, "settings.json"))]).toEqual([id, path.join(home, id), false]);
    out = "";
    expect(await storeCommand(["path", "--vault", copy], { env, write: (t) => (out += t) })).toBe(0);
    expect(out).toBe(`store      ${path.join(home, id)}\ndatabase   Datanotes (id ${id})\n`);
    out = "";
    await storeCommand(["path", "--vault", copy, "--json"], { env, write: (t) => (out += t) });
    expect(JSON.parse(out)).toEqual({ vault: copy, store: path.join(home, id), database_id: id, database_folder: "Datanotes", database_path: path.join(copy, "Datanotes") });
    out = "";
    expect(await storeCommand(["path", "--vault", tmp()], { env, write: (t) => (out += t) })).toBe(2);
    expect(out).toMatch(/^datanotes store: no store yet for /);
  });

  it("path with --database names the folder itself as the database, not an empty folder", async () => {
    const home = tmp();
    const db = tmp();
    write(db, "metastore.yaml", `id: ${ID}\ncatalogs: {}\n`);
    let out = "";
    const env = { DATANOTES_DATA_HOME: home };
    expect(await storeCommand(["path", "--database", db], { env, write: (t) => (out += t) })).toBe(0);
    expect(out).toBe(`store      ${path.join(home, ID)}\ndatabase   ${db} (id ${ID})\n`);
    out = "";
    await storeCommand(["path", "--database", db, "--json"], { env, write: (t) => (out += t) });
    expect(JSON.parse(out)).toMatchObject({ vault: db, database_id: ID, database_folder: "", database_path: db });
  });

  it("new-id refuses while an engine holds the database, without a metastore, and without a known command or vault", async () => {
    const home = tmp();
    const vault = tmp();
    const env = { DATANOTES_DATA_HOME: home };
    await expect(storeCommand(["new-id", "--vault", vault], { env, write: () => undefined })).rejects.toThrow("datanotes/metastore.yaml does not exist: there is no database to give a new id");
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    write(home, `${ID}/engine.lock`, JSON.stringify({ kind: "service", pid: process.ppid, host: os.hostname(), port: 9, startedAt: "", heartbeat: new Date().toISOString() }));
    await expect(storeCommand(["new-id", "--vault", vault], { env, write: () => undefined })).rejects.toThrow(`an engine holds this database (pid ${process.ppid} on`);
    write(vault, "Datanotes/metastore.yaml", "catalogs: {}\n");
    let out = "";
    expect(await storeCommand(["new-id", "--vault", vault], { env, write: (t) => (out += t) })).toBe(0);
    expect(out).not.toContain("(was");
    await expect(storeCommand(["bogus"], { env })).rejects.toThrow(/unknown store command "bogus"/);
    await expect(storeCommand(["path"], { env: {} })).rejects.toThrow(/pass --database <folder> \(or --vault <folder>\)/);
  });

  it("follows a vault that moved: the record and the registry take the new path", () => {
    const home = tmp();
    const parent = tmp();
    const before = path.join(parent, "Vault");
    write(before, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    open(before, home);
    const after = path.join(parent, "Renamed");
    fs.renameSync(before, after);
    const r = open(after, home);
    expect(r.movedVault).toBe(fs.realpathSync.native(parent) + path.sep + "Vault");
    expect(r.logs.some((l) => l.includes("the vault moved from"))).toBe(true);
    expect(readRegistry(home)).toEqual({ [vaultKey(after)]: { id: ID, database: "Datanotes" } });
    expect(JSON.parse(read(r.store, "store.json")).vault).toBe(fs.realpathSync.native(after));
  });

  it("records a store without rewriting a registry that already says it", () => {
    const home = tmp();
    const store = tmp();
    const vault = tmp();
    recordStore(home, store, vault, ID, "Db");
    const at = fs.statSync(path.join(home, "vaults.json")).mtimeMs;
    recordStore(home, store, path.join(vault, "gone", ".."), ID, "Db");
    expect(fs.statSync(path.join(home, "vaults.json")).mtimeMs).toBe(at);
    recordStore(home, store, path.join(vault, "missing"), ID, "Db");
    expect(JSON.parse(read(store, "store.json")).vault).toBe(path.join(vault, "missing"));
  });
});

/** Make `fs[name]` fail with `code` for the calls `when` picks (its first argument), until restored. */
function failing(name: "renameSync" | "writeFileSync" | "copyFileSync" | "readFileSync" | "statSync", when: (first: string) => string | null): () => void {
  const real = fs[name] as (...a: unknown[]) => unknown;
  (fs as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
    const code = when(String(a[0]));
    if (code) throw Object.assign(new Error(`${code}: operation not permitted, ${name} '${String(a[0])}'`), { code });
    return real(...a);
  };
  return () => {
    (fs as unknown as Record<string, unknown>)[name] = real;
  };
}

describe("transient file errors on Windows (EPERM, EBUSY, EACCES)", () => {
  const retry = { ...fileRetry };
  beforeEach(() => {
    fileRetry.delayMs = 1;
  });
  afterEach(() => {
    Object.assign(fileRetry, retry);
  });

  /** Fails the first `n` calls whose first argument matches, with `code`. */
  const times = (n: number, match: (p: string) => boolean, code = "EPERM") => (p: string) => (match(p) && n-- > 0 ? code : null);

  it("writes the id into metastore.yaml atomically: retried, and no temporary file left when it fails for good", () => {
    const vault = tmp();
    write(vault, "Datanotes/metastore.yaml", META);
    const meta = path.join(vault, "Datanotes", "metastore.yaml");
    let undo = failing("renameSync", times(3, (p) => p.startsWith(`${meta}.`)));
    let r: ReturnType<typeof open>;
    try {
      r = open(vault, tmp());
    } finally {
      undo();
    }
    expect(r.idAdded).toBe(true);
    expect(metastoreId(read(vault, "Datanotes/metastore.yaml"))).toBe(r.id);
    expect(fs.readdirSync(path.join(vault, "Datanotes"))).toEqual(["metastore.yaml"]);
    // a lasting error: the file is unchanged, the temporary file removed
    const other = tmp();
    write(other, "Datanotes/metastore.yaml", META);
    const meta2 = path.join(other, "Datanotes", "metastore.yaml");
    undo = failing("renameSync", (p) => (p.startsWith(`${meta2}.`) ? "EPERM" : null));
    try {
      expect(() => open(other, tmp())).toThrow(/^EPERM/);
    } finally {
      undo();
    }
    expect(read(other, "Datanotes/metastore.yaml")).toBe(META);
    expect(fs.readdirSync(path.join(other, "Datanotes"))).toEqual(["metastore.yaml"]);
  });

  it("does not retry other errors, and removes with retries", () => {
    const file = path.join(tmp(), "a.json");
    let calls = 0;
    const undo = failing("renameSync", () => (calls++ === 0 ? "ENOSPC" : null));
    try {
      expect(() => writeJson(file, {})).toThrow(/^ENOSPC/);
    } finally {
      undo();
    }
    expect(calls).toBe(1);
    expect(retrying(() => 7)).toBe(7);
    // a write that goes through once the file is free again
    const again = path.join(tmp(), "b.json");
    const undoBusy = failing("renameSync", times(2, (p) => p.startsWith(again)));
    try {
      writeJson(again, { ok: true });
    } finally {
      undoBusy();
    }
    expect(JSON.parse(fs.readFileSync(again, "utf8"))).toEqual({ ok: true });
  });
});

/** A pid no process has any more: a child that ran and ended. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid!;
}

const lockAt = (pid: number, heartbeat: Date, host = os.hostname()) => JSON.stringify({ kind: "service", pid, host, port: 27150, startedAt: "", heartbeat: heartbeat.toISOString() });
/**
 * A heartbeat long stale (over LOCK_STALE_MS) but after the machine started: an hour ago, or a
 * few seconds after the start on a machine up for less (a CI runner boots just before the job).
 */
const staleBeat = (now: number) => now - Math.min(3_600_000, os.uptime() * 1000 - 5_000);

describe("the lock of another engine", () => {
  it("refuses while an engine of another machine has a fresh heartbeat on the store", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    write(home, `${ID}/engine.lock`, lockAt(7, new Date(), "box"));
    let err: StoreSetupError | undefined;
    try {
      open(vault, home);
    } catch (e) {
      err = e as StoreSetupError;
    }
    expect(err?.message).toBe("another engine holds the vault (pid 7 on box, port 27150)");
    expect(err?.docs).toBe("https://datanotes.dev/administration/run-the-service.md#run-one-engine-per-database");
    expect(freshLock(path.join(home, ID))?.pid).toBe(7);
    expect(freshLock(path.join(vault, "none"))).toBeNull();
  });

  it("does not wait for an engine of this machine ended by force: its process is gone, even with a fresh heartbeat", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    write(home, `${ID}/engine.lock`, lockAt(deadPid(), new Date()));
    expect(open(vault, home).id).toBe(ID);
  });

  it("refuses while the engine of this machine lives, even with a stale heartbeat (hung: nothing changes underneath it)", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    write(home, `${ID}/engine.lock`, lockAt(process.ppid, new Date(staleBeat(Date.now()))));
    expect(() => open(vault, home)).toThrow(`another engine holds the vault (pid ${process.ppid} on ${os.hostname()}, port 27150)`);
    expect(fs.existsSync(path.join(home, ID, "engine.lock"))).toBe(true);
  });

  it("reads the lock by host, process and the machine's start", () => {
    const dir = tmp();
    const now = Date.now();
    const at = (pid: number, ms: number, host?: string) => {
      write(dir, "engine.lock", lockAt(pid, new Date(ms), host));
      return heldLock(dir, { now, alive: (p) => p === 42 })?.pid ?? null;
    };
    expect(at(42, staleBeat(now))).toBe(42); // alive, stale heartbeat
    expect(at(43, now)).toBeNull(); // gone, fresh heartbeat
    expect(at(process.pid, now)).toBeNull(); // this process
    expect(at(42, now - os.uptime() * 1000 - 60_000)).toBeNull(); // written before the machine started: the pid is another process now
    expect(at(43, now, "box")).toBe(43); // another machine: the heartbeat decides
    expect(at(43, now - 60_000, "box")).toBeNull();
    write(dir, "engine.lock", "{ half");
    expect(heldLock(dir)).toBeNull();
    expect(heldLock(path.join(dir, "none"))).toBeNull();
  });

  it("refuses a second start while the first holds the store, naming the process", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n`);
    write(home, `${ID}/engine.lock`, lockAt(process.ppid, new Date()));
    let err: StoreSetupError | undefined;
    try {
      open(vault, home);
    } catch (e) {
      err = e as StoreSetupError;
    }
    expect(err?.message).toBe(`another engine holds the vault (pid ${process.ppid} on ${os.hostname()}, port 27150)`);
    expect(err?.hint).toContain(`datanotes stop --vault "${vault}"`);
    expect(err?.docs).toBe("https://datanotes.dev/administration/run-the-service.md#run-one-engine-per-database");
    expect(fs.existsSync(path.join(home, ID, "store.json"))).toBe(false);
  });
});

describe("a command that claims the store", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("names this process in the lock, port 0: a start meanwhile refuses; the release lets the store go", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}
`);
    const store = path.join(home, ID);
    fs.mkdirSync(store, { recursive: true });
    const release = claimStore({ vault, store, env: { DATANOTES_DATA_HOME: home } }, (l) => new Error(`held by ${l.pid}`));
    expect(JSON.parse(read(store, "engine.lock"))).toMatchObject({ kind: "service", pid: process.pid, host: os.hostname(), port: 0 });
    expect(fs.existsSync(setupLockFile(home, undefined, vault))).toBe(false);
    expect(() => open(vault, home, { pid: process.ppid })).toThrow(`another engine holds the vault (pid ${process.pid} on ${os.hostname()}, port 0)`);
    release();
    expect(fs.existsSync(path.join(store, "engine.lock"))).toBe(false);
    expect(open(vault, home, { pid: process.ppid }).id).toBe(ID);
  });

  it("is refused while an engine holds the store, and writes nothing: another machine's fresh heartbeat, a live engine of this machine whose heartbeat stopped", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}
`);
    const store = path.join(home, ID);
    for (const lock of [lockAt(7, new Date(), "box"), lockAt(process.ppid, new Date(staleBeat(Date.now())))]) {
      write(home, `${ID}/engine.lock`, lock);
      const pid = (JSON.parse(lock) as { pid: number }).pid;
      expect(() => claimStore({ vault, store, env: { DATANOTES_DATA_HOME: home } }, (l) => new Error(`held by ${l.pid}`))).toThrow(`held by ${pid}`);
      expect(read(store, "engine.lock")).toBe(lock);
      expect(fs.existsSync(setupLockFile(home, undefined, vault))).toBe(false);
    }
  });

  it("keeps its heartbeat fresh, and leaves a lock another took over", async () => {
    const vault = tmp();
    const home = tmp();
    const store = path.join(home, ID);
    fs.mkdirSync(store, { recursive: true });
    const saved = CLAIM_HEARTBEAT.ms;
    CLAIM_HEARTBEAT.ms = 20;
    try {
      const release = claimStore({ vault, store, env: { DATANOTES_DATA_HOME: home } }, (l) => new Error(`held by ${l.pid}`));
      const first = (JSON.parse(read(store, "engine.lock")) as { heartbeat: string }).heartbeat;
      await wait(80);
      expect(Date.parse((JSON.parse(read(store, "engine.lock")) as { heartbeat: string }).heartbeat)).toBeGreaterThan(Date.parse(first));
      // another took the store over (a lock with another startedAt): never overwritten, never removed
      const other = JSON.stringify({ kind: "service", pid: process.pid, host: os.hostname(), port: 0, startedAt: "2026-10-01T10:00:00.000Z", heartbeat: "2026-10-01T10:00:00.000Z" });
      write(store, "engine.lock", other);
      await wait(80);
      expect(read(store, "engine.lock")).toBe(other);
      release();
      expect(read(store, "engine.lock")).toBe(other);
    } finally {
      CLAIM_HEARTBEAT.ms = saved;
    }
  });

  it("new-id holds the old id's store while the id changes; a live engine whose heartbeat stopped refuses it; without a store nothing is claimed", async () => {
    const home = tmp();
    const vault = tmp();
    const env = { DATANOTES_DATA_HOME: home };
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\ncatalogs: {}\n`);
    // no store of the old id: nothing claimed, no folder made
    expect(await storeCommand(["new-id", "--vault", vault], { env, write: () => undefined })).toBe(0);
    expect(fs.existsSync(path.join(home, ID))).toBe(false);
    const id2 = metastoreId(read(vault, "Datanotes/metastore.yaml"))!;
    // its store held by a live engine whose heartbeat stopped (hung): refused, nothing changes
    const hung = lockAt(process.ppid, new Date(staleBeat(Date.now())));
    write(home, `${id2}/engine.lock`, hung);
    await expect(storeCommand(["new-id", "--vault", vault], { env, write: () => undefined })).rejects.toThrow(`an engine holds this database (pid ${process.ppid} on ${os.hostname()}, port 27150)`);
    expect(metastoreId(read(vault, "Datanotes/metastore.yaml"))).toBe(id2);
    expect(read(home, `${id2}/engine.lock`)).toBe(hung);
    // the store free: claimed while the id changes, let go after
    fs.rmSync(path.join(home, id2, "engine.lock"));
    expect(await storeCommand(["new-id", "--vault", vault], { env, write: () => undefined })).toBe(0);
    expect(metastoreId(read(vault, "Datanotes/metastore.yaml"))).not.toBe(id2);
    expect(fs.readdirSync(path.join(home, id2))).toEqual([]);
    expect(fs.existsSync(setupLockFile(home, undefined, vault))).toBe(false);
  });
});

describe("two starts on the same vault at once", () => {
  it("take turns: the second waits while the first sets up, then refuses since the first holds the store", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", META);
    // the second start (another process: pid stands in) begins while the first is setting up
    let during: unknown;
    const first = open(vault, home, {
      files: () => {
        try {
          open(vault, home, { pid: process.ppid, setupWaitMs: 200 });
        } catch (e) {
          during = e;
        }
        return files(vault);
      },
    });
    expect((during as StoreSetupError).message).toBe(`another engine is starting on this vault (pid ${process.pid} on ${os.hostname()}): it holds ${setupLockFile(home, undefined, vault)}`);
    expect((during as StoreSetupError).docs).toBe("https://datanotes.dev/administration/run-the-service.md#run-one-engine-per-database");
    // the first set up alone: one id, its setup lock released
    expect(metastoreId(read(vault, "Datanotes/metastore.yaml"))).toBe(first.id);
    expect(fs.existsSync(setupLockFile(home, undefined, vault))).toBe(false);
    // after it: the first holds the store (until its service holds it), so the second refuses
    expect(() => open(vault, home, { pid: process.ppid })).toThrow(`another engine holds the vault (pid ${process.pid} on ${os.hostname()}, port 0)`);
    expect(metastoreId(read(vault, "Datanotes/metastore.yaml"))).toBe(first.id);
  });

  it("waits for a start of another process, and takes over the lock of a start that is gone", async () => {
    const vault = tmp();
    const home = tmp();
    const file = setupLockFile(home, undefined, vault);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // a process that holds the setup lock for 400 ms
    const child = spawn(process.execPath, ["-e", `setTimeout(() => require("fs").rmSync(${JSON.stringify(file)}, { force: true }), 400)`]);
    await new Promise((resolve) => child.once("spawn", resolve));
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, host: os.hostname(), at: new Date().toISOString() }));
    const t0 = Date.now();
    open(vault, home, { setupWaitMs: 20_000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve(null)));
    // a start that is gone left its lock: taken over at once
    const other = tmp();
    const left = setupLockFile(home, undefined, other);
    fs.writeFileSync(left, JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString() }));
    const t1 = Date.now();
    open(other, home, { setupWaitMs: 20_000 });
    expect(Date.now() - t1).toBeLessThan(5_000);
    expect(fs.existsSync(left)).toBe(false);
    // with --store, the lock is in the store
    expect(setupLockFile(home, path.join(home, "s"), vault)).toBe(path.join(home, "s", "setup.lock"));
  });
});

describe("the setup lock: what another start left", () => {
  /** Write the setup lock of `vault` as another start would have, with `text`. */
  function leave(home: string, vault: string, text: string): string {
    const file = setupLockFile(home, undefined, vault);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }
  const lockOf = (pid: number, at: Date, host = os.hostname()) => JSON.stringify({ pid, host, at: at.toISOString() });

  it("a start of another machine holds it until it is old: waited for, then refused", () => {
    const vault = tmp();
    const home = tmp();
    const file = leave(home, vault, lockOf(4242, new Date(), "another-machine"));
    expect(() => open(vault, home, { setupWaitMs: 150 })).toThrow(`another engine is starting on this vault (pid 4242 on another-machine): it holds ${file}`);
    // ten minutes old: the start is gone, its lock taken over
    fs.writeFileSync(file, lockOf(4242, new Date(Date.now() - 11 * 60_000), "another-machine"));
    expect(open(vault, home, { setupWaitMs: 150 }).id).toBeTruthy();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a lock naming this very process, or written before the machine started, is left over", () => {
    const vault = tmp();
    const home = tmp();
    const file = leave(home, vault, lockOf(process.pid, new Date()));
    open(vault, home, { setupWaitMs: 150 });
    expect(fs.existsSync(file)).toBe(false);
    // another vault: the first start holds the store of this one
    const other = tmp();
    const left = leave(home, other, lockOf(process.ppid, new Date(Date.now() - os.uptime() * 1000 - 60_000)));
    open(other, home, { setupWaitMs: 150 });
    expect(fs.existsSync(left)).toBe(false);
  });

  it("a lock that cannot be read (half written, or not a lock): waited for while new, taken over once 5 s old", () => {
    const vault = tmp();
    const home = tmp();
    const file = leave(home, vault, "{");
    expect(() => open(vault, home, { setupWaitMs: 150 })).toThrow(`another engine is starting on this vault (another process): it holds ${file}`);
    fs.writeFileSync(file, JSON.stringify({ pid: "1" }));
    expect(() => open(vault, home, { setupWaitMs: 150 })).toThrow("(another process)");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    open(vault, home, { setupWaitMs: 150 });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a lock gone before its time could be read is taken over", () => {
    const vault = tmp();
    const home = tmp();
    const file = leave(home, vault, "{");
    const undo = failing("statSync", (p) => (p === file ? "ENOENT" : null));
    try {
      open(vault, home, { setupWaitMs: 5_000 });
    } finally {
      undo();
    }
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a lock that cannot be read for a moment is read again", () => {
    const vault = tmp();
    const home = tmp();
    const file = leave(home, vault, lockOf(process.pid, new Date()));
    // the first read fails (held by the system), then the second read of the left-over check
    let reads = 0;
    const undo = failing("readFileSync", (p) => (p === file && [1, 3].includes(++reads) ? "EBUSY" : null));
    try {
      open(vault, home, { setupWaitMs: 5_000 });
    } finally {
      undo();
    }
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a lock that cannot be created for another reason fails the start at once", () => {
    const vault = tmp();
    const home = tmp();
    const file = setupLockFile(home, undefined, vault);
    const real = fs.writeFileSync;
    let calls = 0;
    (fs as unknown as Record<string, unknown>).writeFileSync = (...a: unknown[]) => {
      if (a[0] === file) {
        calls++;
        throw new Error("the disk went away"); // an error without a code
      }
      return (real as (...b: unknown[]) => unknown)(...a);
    };
    try {
      expect(() => open(vault, home)).toThrow("the disk went away");
    } finally {
      (fs as unknown as Record<string, unknown>).writeFileSync = real;
    }
    expect(calls).toBe(1);
    const undo = failing("writeFileSync", (p) => (p === file ? "ENOSPC" : null));
    try {
      expect(() => open(vault, home)).toThrow(/^ENOSPC/);
    } finally {
      undo();
    }
  });

  it("a lock removed by someone else while the start sets up: the release has nothing to do", () => {
    const vault = tmp();
    const home = tmp();
    const file = setupLockFile(home, undefined, vault);
    const r = open(vault, home, {
      files: () => {
        fs.rmSync(file);
        return files(vault);
      },
    });
    expect(r.id).toBeTruthy();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("store records and the registry, in odd shapes", () => {
  it("a --store record that is not an object is no record; the process environment when none is given", () => {
    const vault = tmp();
    const store = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n${META}`);
    fs.writeFileSync(path.join(store, "store.json"), "[1, 2]");
    const r = openStore({ vault, store, files: () => files(vault) });
    expect(r).toMatchObject({ store: path.resolve(store), id: ID, database: "Datanotes", home: null });
    expect(JSON.parse(read(store, "store.json"))).toMatchObject({ id: ID, database: "Datanotes" });
  });

  it("a database without an id in another folder than the registry knew: a new id, not the registry's", () => {
    const vault = tmp();
    const home = tmp();
    write(vault, "Datanotes/metastore.yaml", META);
    const first = open(vault, home);
    fs.rmSync(first.store, { recursive: true });
    fs.rmSync(path.join(vault, "Datanotes"), { recursive: true });
    write(vault, "Elsewhere/metastore.yaml", META);
    const second = open(vault, home);
    expect(second.database).toBe("Elsewhere");
    expect(second.id).not.toBe(first.id);
    expect(second.idAdded).toBe(true);
  });

  it("a store whose record names another vault without a database folder: the default folder is checked", () => {
    const vault = tmp();
    const home = tmp();
    const other = tmp();
    write(vault, "Datanotes/metastore.yaml", `id: ${ID}\n${META}`);
    write(other, "Datanotes/metastore.yaml", `id: ${ID}\n${META}`);
    fs.mkdirSync(path.join(home, ID), { recursive: true });
    fs.writeFileSync(path.join(home, ID, "store.json"), JSON.stringify({ id: ID, vault: other }));
    expect(() => open(vault, home)).toThrow(`this database (id ${ID}) is a copy: the vault ${other} holds it too`);
  });
});

describe("retried file operations", () => {
  it("an error without a code is not retried", () => {
    let calls = 0;
    expect(() =>
      retrying(() => {
        calls++;
        throw new Error("not a file error");
      }),
    ).toThrow("not a file error");
    expect(calls).toBe(1);
  });
});
