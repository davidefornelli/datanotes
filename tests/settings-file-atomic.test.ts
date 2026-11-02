/**
 * The service writes its settings file atomically (R1w2-10): a new file renamed over the old one,
 * so a crash or a failed write never leaves half a file (the next start would read {} and make a
 * new owner token).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { METASTORE, withTables } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";
import { startService, type RunningService } from "../src/node/service";
import { posixModes } from "../src/node/private-files";

const OWNER = "owner-token-settings-atomic-0123456789";

const running: RunningService[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const svc of running.splice(0)) await svc.stop();
  for (const d of folders.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A vault with its settings seeded in its store; returns the vault, the store and the settings file. */
function vault(): { root: string; store: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-atomic-"));
  folders.push(root);
  fs.mkdirSync(path.join(root, "Datanotes"), { recursive: true });
  fs.writeFileSync(path.join(root, METASTORE), withTables("task:\n  columns:\n    - { name: title, type: string }\n"));
  const store = seedStoreSettings(root, { httpServerPort: 0, httpServerToken: OWNER, fileLogEnabled: false, autoRecompute: false }, METASTORE);
  return { root, store, file: path.join(store, "settings.json") };
}

async function start(root: string): Promise<RunningService> {
  const svc = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
  running.push(svc);
  return svc;
}

async function post(svc: RunningService, route: string, body: unknown, token = OWNER): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${svc.port}/datanotes${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const readFile = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

describe("the settings file, written atomically", () => {
  it("saves the settings file by renaming a new file over it", async () => {
    const { root, store, file } = vault();
    const svc = await start(root);
    const ino = fs.statSync(file).ino;
    // a temporary file a crash left behind, with a mode too open
    fs.writeFileSync(`${file}.${process.pid}.tmp`, "{ half", { mode: 0o644 });
    const read = await post(svc, "/settings/", {});
    const r = await post(svc, "/settings/update/", { expect_version: read.json.settings_version, changes: { logRetentionDays: 45 } });
    expect(r.status).toBe(200);
    expect(readFile(file)).toMatchObject({ logRetentionDays: 45, httpServerToken: OWNER });
    if (posixModes()) {
      expect(fs.statSync(file).ino).not.toBe(ino);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(store).filter((n) => n.startsWith("settings.json."))).toEqual([]);
    expect((await post(svc, "/settings/", {})).json.file_changed_on_disk).toBe(false);
  });

  it("a save that fails leaves the old file whole", async () => {
    const { root, file } = vault();
    const svc = await start(root);
    const before = fs.readFileSync(file, "utf8");
    const tmp = `${file}.${process.pid}.tmp`;
    // a folder where the temporary file goes: the write fails on every platform, also as root
    fs.mkdirSync(tmp);
    const read = await post(svc, "/settings/", {});
    const failed = await post(svc, "/settings/update/", { expect_version: read.json.settings_version, changes: { logRetentionDays: 50 } });
    expect(failed.status).toBe(503);
    expect(String(failed.json.error)).toMatch(/^the settings could not be saved: /);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(svc.settings.logRetentionDays).toBe(30);
    fs.rmdirSync(tmp);
    // a failed save does not move the version
    const r = await post(svc, "/settings/update/", { expect_version: read.json.settings_version, changes: { logRetentionDays: 50 } });
    expect(r.status).toBe(200);
    expect(readFile(file).logRetentionDays).toBe(50);
  });
});
