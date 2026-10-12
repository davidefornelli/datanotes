/**
 * The store is private on POSIX systems (src/node/private-files.ts): the data home and the store
 * 0700, the settings file, webhooks.json and the store's other files 0600, also when an older
 * version left them open. Windows has no such modes: those tests are skipped there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeStoreAdapter } from "../src/node/node-app";
import { makePrivateDir, posixModes, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, tightenPrivate } from "../src/node/private-files";
import { openStore, writeJson } from "../src/node/store-setup";

const ID = "0192e000-0000-7000-8000-0000000000a1";
const META = `id: ${ID}\n# Metastore (Datanotes): catalogs, schemas, tables, columns, views.\ncatalogs: {}\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "private-store-"));
  dirs.push(d);
  return d;
}

const mode = (p: string) => fs.statSync(p).mode & 0o777;

function vaultWithDatabase(): string {
  const vault = tmp();
  fs.mkdirSync(path.join(vault, "datanotes"));
  fs.writeFileSync(path.join(vault, "datanotes", "metastore.yaml"), META);
  return vault;
}

const open = (vault: string, home: string, log?: string[]) =>
  openStore({ vault, env: { DATANOTES_DATA_HOME: home }, files: () => ["datanotes/metastore.yaml"], ...(log ? { log: (l, m) => log.push(`${l} ${m}`) } : {}) });

describe("the private modes", () => {
  it("are 0700 for folders and 0600 for files", () => {
    expect(PRIVATE_DIR_MODE).toBe(0o700);
    expect(PRIVATE_FILE_MODE).toBe(0o600);
  });

  it("apply on every platform but Windows, where tightening does nothing", () => {
    expect(posixModes("linux")).toBe(true);
    expect(posixModes("darwin")).toBe(true);
    expect(posixModes("win32")).toBe(false);
    const file = path.join(tmp(), "settings.json");
    fs.writeFileSync(file, "{}");
    const before = fs.statSync(file).mode;
    expect(tightenPrivate([file], "win32")).toEqual([]);
    expect(fs.statSync(file).mode).toBe(before);
  });

  it("leave a path that does not exist alone", () => {
    expect(tightenPrivate([path.join(tmp(), "missing.json")])).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("the store on POSIX systems", () => {
  it("is created private: the data home and the store 0700, their files 0600", () => {
    const home = path.join(tmp(), "home");
    const r = open(vaultWithDatabase(), home);
    expect(mode(home)).toBe(0o700);
    expect(mode(r.store)).toBe(0o700);
    for (const f of ["store.json", "engine.lock"]) expect(mode(path.join(r.store, f))).toBe(0o600);
    expect(mode(path.join(home, "vaults.json"))).toBe(0o600);
  });

  it("only the folder itself is made private, not missing parents", () => {
    const parent = path.join(tmp(), "shared");
    const dir = path.join(parent, "datanotes");
    makePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
    expect(mode(parent)).not.toBe(0o700);
  });

  it("is tightened at start when an older version left it open", () => {
    const home = tmp();
    const vault = vaultWithDatabase();
    const store = open(vault, home).store;
    const settings = path.join(store, "settings.json");
    const webhooks = path.join(store, "webhooks.json");
    fs.writeFileSync(settings, '{ "httpServerToken": "a-test-token" }');
    fs.writeFileSync(webhooks, "[]");
    for (const f of [settings, webhooks]) fs.chmodSync(f, 0o644);
    for (const d of [home, store]) fs.chmodSync(d, 0o755);
    fs.rmSync(path.join(store, "engine.lock"));

    const log: string[] = [];
    open(vault, home, log);
    expect(mode(home)).toBe(0o700);
    expect(mode(store)).toBe(0o700);
    expect(mode(settings)).toBe(0o600);
    expect(mode(webhooks)).toBe(0o600);
    expect(log.filter((l) => l.startsWith("WARN"))).toEqual([]);
  });

  it("tightens a settings file given with --settings", () => {
    const settings = path.join(tmp(), "settings.json");
    fs.writeFileSync(settings, "{}");
    fs.chmodSync(settings, 0o644);
    openStore({ vault: vaultWithDatabase(), env: { DATANOTES_DATA_HOME: tmp() }, settingsFile: settings, files: () => ["datanotes/metastore.yaml"] });
    expect(mode(settings)).toBe(0o600);
  });

  it("writes JSON files 0600, even over a temporary file a crash left open", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(`${file}.${process.pid}.tmp`, "left over");
    fs.chmodSync(`${file}.${process.pid}.tmp`, 0o644);
    writeJson(file, { httpServerToken: "a-test-token" });
    expect(mode(file)).toBe(0o600);
  });

  it("writes the store's files 0600 and its folders 0700 (webhooks.json, the journal)", async () => {
    const store = tmp();
    const adapter = nodeStoreAdapter(store);
    await adapter.write("webhooks.json", "[]");
    await adapter.append("journal/2026-10.jsonl", "{}\n");
    await adapter.mkdir("semantic");
    expect(mode(path.join(store, "webhooks.json"))).toBe(0o600);
    expect(mode(path.join(store, "journal", "2026-10.jsonl"))).toBe(0o600);
    expect(mode(path.join(store, "journal"))).toBe(0o700);
    expect(mode(path.join(store, "semantic"))).toBe(0o700);
  });
});
