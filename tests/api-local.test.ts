import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dataHome,
  databaseIdIn,
  LOCK_STALE_MS,
  localEngine,
  readDatabaseId,
  readRegistry,
  storeLocation,
  vaultKey,
  vaultSettingsPath,
  type EngineLock,
  vaultMetastores,
} from "../src/api/local";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-08T10:00:00Z");
const ID = "0192e000-0000-7000-8000-000000000001";

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

function lockAt(heartbeatMs: number, host = os.hostname()): EngineLock {
  return { kind: "service", pid: 4242, host, port: 27199, startedAt: "2026-10-08T09:00:00.000Z", heartbeat: new Date(heartbeatMs).toISOString() };
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * A vault whose database has the id {@link ID}, a data home, and the engine's store in it (its
 * settings and, optionally, the lock it holds while it runs).
 */
function setup(settings: Record<string, unknown> | string | null, lock: EngineLock | null) {
  const root = tmp("datanotes-local-");
  const home = tmp("datanotes-local-home-");
  const env = { DATANOTES_DATA_HOME: home };
  write(path.join(root, "Datanotes", "metastore.yaml"), `id: ${ID}\ncatalogs: {}\n`);
  const store = path.join(home, ID);
  if (settings !== null) write(path.join(store, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  if (lock) write(path.join(store, "engine.lock"), JSON.stringify(lock));
  return { root, home, env, store };
}

describe("the data home: where the stores of this user's databases are", () => {
  it("is the operating system's per-user data folder, or DATANOTES_DATA_HOME", () => {
    expect(dataHome({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a")).toBe(path.join("C:\\Users\\a\\AppData\\Local", "Datanotes"));
    expect(dataHome({}, "win32", "/home/a")).toBe(path.join("/home/a", "AppData", "Local", "Datanotes"));
    expect(dataHome({}, "darwin", "/Users/a")).toBe(path.join("/Users/a", "Library", "Application Support", "Datanotes"));
    expect(dataHome({ XDG_DATA_HOME: "/x/data" }, "linux", "/home/a")).toBe(path.join("/x/data", "datanotes"));
    expect(dataHome({}, "linux", "/home/a")).toBe(path.join("/home/a", ".local", "share", "datanotes"));
    expect(dataHome({ DATANOTES_DATA_HOME: "rel/home" }, "linux", "/home/a")).toBe(path.resolve("rel/home"));
    expect(dataHome()).toBe(path.resolve(process.env.DATANOTES_DATA_HOME!));
  });
});

describe("the database id in metastore.yaml", () => {
  it("is the top-level id: a UUID, quoted or not, a comment after it allowed", () => {
    expect(readDatabaseId(`# Metastore\nid: ${ID}\ncatalogs: {}\n`)).toBe(ID);
    expect(readDatabaseId(`id: "${ID.toUpperCase()}" # the database\n`)).toBe(ID);
    expect(readDatabaseId(`catalogs:\n  id: ${ID}\n`)).toBeNull();
    expect(readDatabaseId("id: not-a-uuid\n")).toBeNull();
    expect(readDatabaseId("catalogs: {}\n")).toBeNull();
    expect(databaseIdIn(tmp("datanotes-local-"), "Datanotes")).toBeNull();
  });
});

describe("the registry of the vaults this machine opened", () => {
  it("names a vault by its real path, lowercase on Windows; a vault that is gone keeps the path given", () => {
    const root = tmp("datanotes-local-");
    expect(vaultKey(root, "linux")).toBe(fs.realpathSync.native(root));
    expect(vaultKey(root, "win32")).toBe(fs.realpathSync.native(root).toLowerCase());
    expect(vaultKey(path.join(root, "gone"), "linux")).toBe(path.join(root, "gone"));
    expect(vaultKey(root)).toBe(process.platform === "win32" ? fs.realpathSync.native(root).toLowerCase() : fs.realpathSync.native(root));
  });

  it("keeps only well-formed entries; a missing or broken file is empty", () => {
    const home = tmp("datanotes-local-home-");
    expect(readRegistry(home)).toEqual({});
    write(path.join(home, "vaults.json"), "[1, 2]");
    expect(readRegistry(home)).toEqual({});
    write(path.join(home, "vaults.json"), JSON.stringify({ a: { id: ID, database: "Db" }, b: { id: "x", database: "Db" }, c: { id: ID }, d: null }));
    expect(readRegistry(home)).toEqual({ a: { id: ID, database: "Db" } });
  });
});

describe("storeLocation: where a vault's store is, as the engine finds it", () => {
  it("is <data home>/<id> by the id in the vault's one metastore.yaml, at any depth; datanotes/ first", () => {
    const { root, env, home } = setup(null, null);
    expect(storeLocation(root, { env })).toEqual({ store: path.join(home, ID), id: ID, database: "Datanotes" });
    fs.renameSync(path.join(root, "Datanotes"), path.join(root, "Life"));
    fs.mkdirSync(path.join(root, "Notes"));
    fs.renameSync(path.join(root, "Life"), path.join(root, "Notes", "Db"));
    expect(storeLocation(root, { env })?.database).toBe("Notes/Db");
    expect(vaultMetastores(root)).toEqual(["Notes/Db"]);
    write(path.join(root, "datanotes", "metastore.yaml"), `id: ${ID.replace(/1$/, "2")}\n`);
    expect(storeLocation(root, { env })?.id).toBe(ID.replace(/1$/, "2"));
    // more than one elsewhere and none in datanotes/: no database (the engine refuses to start)
    fs.rmSync(path.join(root, "datanotes"), { recursive: true });
    write(path.join(root, "B", ".hidden", "metastore.yaml"), `id: ${ID}\n`);
    write(path.join(root, "B", "node_modules", "metastore.yaml"), `id: ${ID}\n`);
    expect(vaultMetastores(root)).toEqual(["Notes/Db"]);
    write(path.join(root, "A", "metastore.yaml"), `id: ${ID}\n`);
    expect(storeLocation(root, { env })).toBeNull();
    expect(vaultMetastores(path.join(root, "nope"))).toEqual([]);
  });

  it("follows the registry: the database this machine last opened on the vault, moved or not", () => {
    const { root, env, home } = setup(null, null);
    write(path.join(home, "vaults.json"), JSON.stringify({ [vaultKey(root)]: { id: ID, database: "Moved/Db" } }));
    expect(storeLocation(root, { env })).toEqual({ store: path.join(home, ID), id: ID, database: "Moved/Db" });
  });

  it("is the folder named by --store or DATANOTES_STORE, with the database its record names", () => {
    const { root, env } = setup(null, null);
    const store = tmp("datanotes-local-store-");
    expect(storeLocation(root, { env, store })).toEqual({ store, id: ID, database: "Datanotes" });
    write(path.join(store, "store.json"), JSON.stringify({ id: "rec-id", database: "Db" }));
    expect(storeLocation(root, { env: { ...env, DATANOTES_STORE: store } })).toEqual({ store, id: "rec-id", database: "Db" });
    expect(storeLocation(tmp("datanotes-local-"), { env, store: path.join(store, "new") })).toEqual({ store: path.join(store, "new"), id: null, database: "datanotes" });
  });

  it("uses the process environment by default", () => {
    expect(storeLocation(tmp("datanotes-local-"))).toBeNull();
  });
});

describe("localEngine: the engine running on a vault of this machine", () => {
  it("is the address in its lock and the owner's token from the settings in its store", () => {
    const lock = lockAt(NOW - 5_000);
    const { root, env, store } = setup({ httpServerToken: "owner-token" }, lock);
    expect(vaultSettingsPath(root, { env })).toBe(path.join(store, "settings.json"));
    expect(localEngine(root, { env, now: NOW })).toEqual({ url: "http://127.0.0.1:27199", token: "owner-token", lock });
    expect(localEngine(root, { env, now: NOW, host: "localhost" })?.url).toBe("http://localhost:27199");
  });

  it("reads a settings file given apart", () => {
    const { root, env } = setup({ httpServerToken: "t" }, lockAt(NOW));
    const elsewhere = path.join(root, "custom-service.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ httpServerToken: "other" }));
    expect(localEngine(root, { env, now: NOW, settingsFile: elsewhere })?.token).toBe("other");
  });

  it("finds no engine and no settings file in a vault without a store", () => {
    const root = tmp("datanotes-local-");
    const env = { DATANOTES_DATA_HOME: tmp("datanotes-local-home-") };
    expect(vaultSettingsPath(root, { env })).toBeNull();
    expect(localEngine(root, { env, now: NOW })).toBeNull();
  });

  it("is null when no engine runs: no lock, a lock whose heartbeat is stale, or a broken lock file", () => {
    expect(localEngine(setup({ httpServerToken: "t" }, null).root, { env: setup(null, null).env, now: NOW })).toBeNull();
    const fresh = setup({ httpServerToken: "t" }, null);
    expect(localEngine(fresh.root, { env: fresh.env, now: NOW })).toBeNull();
    const stale = setup({ httpServerToken: "t" }, lockAt(NOW - LOCK_STALE_MS));
    expect(localEngine(stale.root, { env: stale.env, now: NOW })).toBeNull();
    const young = setup({ httpServerToken: "t" }, lockAt(NOW - LOCK_STALE_MS + 1));
    expect(localEngine(young.root, { env: young.env, now: NOW })).not.toBeNull();
    const broken = setup({ httpServerToken: "t" }, null);
    write(path.join(broken.store, "engine.lock"), "{ half written");
    expect(localEngine(broken.root, { env: broken.env, now: NOW })).toBeNull();
  });

  it("is null without an owner token (missing or unreadable settings, or no token in them)", () => {
    for (const settings of [null, "not json", { httpServerToken: "" }, { httpServerToken: 42 }]) {
      const s = setup(settings, lockAt(NOW));
      expect(localEngine(s.root, { env: s.env, now: NOW })).toBeNull();
    }
  });

  it("refuses a vault held by an engine on another machine (a store on a shared folder)", () => {
    const s = setup({ httpServerToken: "t" }, lockAt(NOW, "nas-01"));
    expect(() => localEngine(s.root, { env: s.env, now: NOW })).toThrow("the vault is held by an engine on nas-01; connect to it by its address");
  });

  it("uses the current time and the process environment by default", () => {
    const s = setup({ httpServerToken: "t" }, lockAt(Date.now()));
    expect(localEngine(s.root, { env: s.env })?.token).toBe("t");
    expect(localEngine(tmp("datanotes-local-"))).toBeNull();
  });
});
