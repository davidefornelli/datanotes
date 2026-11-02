/**
 * Addresses with credentials that `new URL` refuses (a port over 65535, `^` or `|` in the host), set
 * over HTTP or loaded from the settings file: no answer, view, journal entry, log line or store
 * file but settings.json keeps their credentials, and a value sent back as shown keeps them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { METASTORE, withTables } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";
import { filesWith } from "./helpers/store-grep";
import { startService, type RunningService } from "../src/node/service";
import type { SettingView } from "../src/server/settings-route";

const OWNER = "owner-token-settings-credentials-0123456789";

const running: RunningService[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const svc of running.splice(0)) await svc.stop();
  for (const d of folders.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A vault with its settings seeded in its store (the file log on). */
function vault(extra: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-credentials-"));
  folders.push(root);
  fs.mkdirSync(path.join(root, "Datanotes"), { recursive: true });
  fs.writeFileSync(path.join(root, METASTORE), withTables("task:\n  columns:\n    - { name: title, type: string }\n"));
  seedStoreSettings(root, { httpServerPort: 0, httpServerToken: OWNER, fileLogEnabled: true, autoRecompute: false, ...extra }, METASTORE);
  return root;
}

async function start(root: string): Promise<RunningService> {
  const svc = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
  running.push(svc);
  return svc;
}

async function post(svc: RunningService, route: string, body: unknown, token = OWNER): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`http://127.0.0.1:${svc.port}/datanotes${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
}

const view = (settings: unknown, name: string) => (settings as SettingView[]).find((s) => s.name === name)!;

async function journal(svc: RunningService): Promise<{ migrations: { settings: unknown }[]; text: string }> {
  const r = await post(svc, "/operations/list_migrations/", { op: "set_engine_settings" });
  expect(r.status).toBe(200);
  return { migrations: (r.json as { migrations: { settings: unknown }[] }).migrations, text: r.text };
}

describe("URL credentials in the settings", () => {
  it("addresses new URL refuses, set over HTTP: no answer, view, journal entry, log or store file keeps their credentials; sent back as shown, they stay", { timeout: 30_000 }, async () => {
    const A = "SENTINEL-ADDR";
    const svc = await start(vault());
    const version = (await post(svc, "/settings/", {})).json.settings_version;
    const r = await post(svc, "/settings/update/", {
      expect_version: version,
      changes: {
        telemetryEndpoint: `https://u:${A}1@otel.example.com:431800`,
        semanticBaseUrl: `https://u:${A}2@emb^host.example.com/v1`,
        storeBackupRemote: `https://u:${A}3@git.example.com:80:80/r.git`,
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.changed).toEqual(["telemetryEndpoint", "semanticBaseUrl", "storeBackupRemote"]);
    expect(r.text).not.toContain(A);
    const shown = { telemetryEndpoint: "https://otel.example.com:431800", semanticBaseUrl: "https://emb^host.example.com/v1", storeBackupRemote: "https://git.example.com:80:80/r.git" };
    const read = await post(svc, "/settings/", {});
    expect(read.text).not.toContain(A);
    for (const settings of [r.json.settings, read.json.settings]) {
      for (const [name, value] of Object.entries(shown)) expect(view(settings, name)).toMatchObject({ value, redacted: true });
    }
    const j = await journal(svc);
    expect(j.text).not.toContain(A);
    expect(j.migrations[0]!.settings).toEqual([
      { name: "telemetryEndpoint", before: "http://127.0.0.1:4318", after: "https://otel.example.com:431800", redacted: true },
      { name: "semanticBaseUrl", before: "", after: "https://emb^host.example.com/v1", redacted: true },
      { name: "storeBackupRemote", before: "", after: "https://git.example.com:80:80/r.git", redacted: true },
    ]);
    const back = await post(svc, "/settings/update/", { expect_version: read.json.settings_version, changes: shown });
    expect(back.status).toBe(200);
    expect(back.json.changed).toEqual([]);
    expect(back.json.migration_id).toBeUndefined();
    expect(svc.settings.telemetryEndpoint).toContain(`${A}1`);
    expect(svc.settings.semanticBaseUrl).toContain(`${A}2`);
    expect(svc.settings.storeBackupRemote).toContain(`${A}3`);
    await svc.stop();
    expect(filesWith(svc.store.store, A)).toEqual(["settings.json"]);
  });

  it("a raw backslash in a password (the address does not parse): no answer, journal entry or store file but settings.json keeps it", { timeout: 30_000 }, async () => {
    const B = "SENTINEL-BACKSLASH";
    const raw = `http://u:${B}\\x19292@127.0.0.1:9/v1`;
    expect(() => new URL(raw)).toThrow();
    const svc = await start(vault());
    const version = (await post(svc, "/settings/", {})).json.settings_version;
    const r = await post(svc, "/settings/update/", { expect_version: version, changes: { semanticBaseUrl: raw } });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(B);
    const read = await post(svc, "/settings/", {});
    expect(read.text).not.toContain(B);
    expect(view(read.json.settings, "semanticBaseUrl")).toMatchObject({ value: "http://127.0.0.1:9/v1", redacted: true });
    const j = await journal(svc);
    expect(j.text).not.toContain(B);
    expect(j.migrations[0]!.settings).toEqual([{ name: "semanticBaseUrl", before: "", after: "http://127.0.0.1:9/v1", redacted: true }]);
    expect(svc.settings.semanticBaseUrl).toBe(raw);
    await svc.stop();
    expect(filesWith(svc.store.store, B)).toEqual(["settings.json"]);
  });

  it("addresses with credentials loaded from the settings file: the view and the journal's before keep none", { timeout: 30_000 }, async () => {
    const F = "SENTINEL-FILE";
    const svc = await start(vault({ telemetryEndpoint: `https://u:${F}1@otel.example.com:431800`, storeBackupRemote: `https://u:${F}2@ho|st/r.git` }));
    const read = await post(svc, "/settings/", {});
    expect(read.text).not.toContain(F);
    expect(view(read.json.settings, "telemetryEndpoint")).toMatchObject({ value: "https://otel.example.com:431800", redacted: true });
    expect(view(read.json.settings, "storeBackupRemote")).toMatchObject({ value: "https://ho|st/r.git", redacted: true });
    const r = await post(svc, "/settings/update/", { expect_version: read.json.settings_version, changes: { telemetryEndpoint: "http://127.0.0.1:4318" } });
    expect(r.status).toBe(200);
    const j = await journal(svc);
    expect(j.text).not.toContain(F);
    expect(j.migrations[0]!.settings).toEqual([{ name: "telemetryEndpoint", before: "https://otel.example.com:431800", after: "http://127.0.0.1:4318", redacted: true }]);
    await svc.stop();
    expect(filesWith(svc.store.store, F)).toEqual(["settings.json"]);
  });
});
