/**
 * The engine's settings over HTTP on the real service (`datanotes serve`, src/node/service.ts): a
 * change is saved to the settings file (keeping the keys this version does not know), a hand edit
 * of the file while the engine runs refuses changes, the start options that win are named, and a
 * restart setting applies at the next start.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guided } from "./helpers/guidance";
import { METASTORE, withTables } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";
import { startService, type RunningService } from "../src/node/service";
import { posixModes } from "../src/node/private-files";
import type { SettingView } from "../src/server/settings-route";

const OWNER = "owner-token-settings-service-0123456789";
const TOKEN48 = "0123456789abcdef0123456789abcdef0123456789abcdef";

const running: RunningService[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const svc of running.splice(0)) await svc.stop();
  for (const d of folders.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A vault with its settings seeded in its store; returns the vault and the settings file. */
function vault(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-service-"));
  folders.push(root);
  fs.mkdirSync(path.join(root, "Datanotes"), { recursive: true });
  fs.writeFileSync(path.join(root, METASTORE), withTables("task:\n  columns:\n    - { name: title, type: string }\n"));
  const store = seedStoreSettings(root, { httpServerPort: 0, httpServerToken: OWNER, fileLogEnabled: false, autoRecompute: false, futureKey: 1 }, METASTORE);
  return { root, file: path.join(store, "settings.json") };
}

async function start(root: string, port?: number): Promise<RunningService> {
  const svc = await startService({ vault: root, watch: "poll", pollMs: 200, ...(port !== undefined ? { port } : {}) }, {});
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

describe("settings over HTTP on the service", () => {
  it("saves a change to the settings file, keeping what it does not know", async () => {
    const { root, file } = vault();
    const svc = await start(root);
    const read = await post(svc, "/settings/", {});
    expect(read.status).toBe(200);
    expect(read.json.settings_file).toBe(file);
    expect(read.json.file_changed_on_disk).toBe(false);
    const r = await post(svc, "/settings/update/", { expect_version: read.json.settings_version, changes: { logRetentionDays: 45 } });
    expect(r.status).toBe(200);
    const saved = readFile(file);
    expect(saved).toMatchObject({ logRetentionDays: 45, futureKey: 1, httpServerToken: OWNER });
    if (posixModes()) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await post(svc, "/settings/", {})).json.file_changed_on_disk).toBe(false);
  });

  it("names the start option that wins over a setting", async () => {
    const { root } = vault();
    const svc = await start(root, 0);
    const read = await post(svc, "/settings/", {});
    const port = (read.json.settings as SettingView[]).find((v) => v.name === "httpServerPort")!;
    expect(port.overridden_by).toMatch(/--port/);
  });

  it("refuses changes once the file was edited by hand", async () => {
    const { root, file } = vault();
    const svc = await start(root);
    fs.writeFileSync(file, JSON.stringify({ ...readFile(file), logRetentionDays: 60 }, null, 2));
    const read = await post(svc, "/settings/", {});
    expect(read.json.file_changed_on_disk).toBe(true);
    const r = await post(svc, "/settings/update/", { expect_version: read.json.settings_version, changes: { logRetentionDays: 45 } });
    expect(r).toMatchObject({ status: 409, json: guided(`the settings file changed on disk since the engine read it: ${file}`) });
    expect(readFile(file).logRetentionDays).toBe(60);
  });

  it("applies the restart settings at the next start", async () => {
    const { root } = vault();
    const svc = await start(root);
    const read = await post(svc, "/settings/", {});
    const r = await post(svc, "/settings/update/", { expect_version: read.json.settings_version, changes: { vaultIndexEnabled: false, httpServerToken: TOKEN48 } });
    expect(r.status).toBe(200);
    expect(r.json.restart_pending).toEqual(["vaultIndexEnabled", "httpServerToken"]);
    await svc.stop();
    running.splice(running.indexOf(svc), 1);

    const next = await start(root);
    const again = await post(next, "/settings/", {}, TOKEN48);
    expect(again.status).toBe(200);
    expect(again.json.restart_pending).toEqual([]);
    expect((again.json.settings as SettingView[]).find((v) => v.name === "vaultIndexEnabled")!.value).toBe(false);
    expect(next.settings.vaultIndexEnabled).toBe(false);
    expect((await post(next, "/settings/", {}, OWNER)).status).toBe(401);
  });
});
