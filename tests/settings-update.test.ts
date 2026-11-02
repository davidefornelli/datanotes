/**
 * Changing the engine's settings over HTTP (`POST /datanotes/settings/update/`,
 * src/server/settings-route.ts): checked with the loader's rules, all or nothing, guarded by
 * `expect_version`, one at a time, journaled as `set_engine_settings`, logged, secrets write-only.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guided } from "./helpers/guidance";
import { PANTRY, READ_OWNER_TOKEN, startReadEngine, type ReadEngine } from "./helpers/read-tokens";
import { runWithActor } from "../src/core/actor";
import type { JournalSettingChange } from "../src/core/changeset";
import { DOCS, DOCS_BASE } from "../src/core/hints";
import { mergeWithDefaults, SETTING_RULES, type DatanotesSettings } from "../src/core/settings";
import { SettingsRoutes, type SettingsDeps, type SettingView } from "../src/server/settings-route";

const TOKEN48 = "0123456789abcdef0123456789abcdef0123456789abcdef";
const AGENT = { harness: "datanotes-ui", harness_version: "3.7.0", session: "ui-0123456789abcdef" };
const CHANGE_DOCS = `${DOCS_BASE}${DOCS.changeSettings}`;

let e: ReadEngine;

interface UpdateAnswer {
  ok: true;
  dry_run: boolean;
  settings_version: string;
  changed: string[];
  applied_now: string[];
  after_restart: string[];
  restart_pending: string[];
  follow_ups: { setting: string; description: string }[];
  migration_id?: string;
  settings: SettingView[];
}

/** A request as the owner over HTTP, with the browser's actor header. */
async function post(route: string, body: unknown, bearer = READ_OWNER_TOKEN): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${e.url}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", "X-Datanotes-Actor": JSON.stringify(AGENT) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
}

async function version(): Promise<string> {
  const r = await post("/settings/", {});
  expect(r.status).toBe(200);
  return r.json.settings_version as string;
}

async function update(changes: unknown, extra: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  return post("/settings/update/", { expect_version: await version(), changes, ...extra });
}

async function journal(): Promise<{ total: number; migrations: Record<string, unknown>[]; text: string }> {
  const r = await post("/operations/list_migrations/", { op: "set_engine_settings", limit: 100 });
  expect(r.status).toBe(200);
  return { ...(r.json as { total: number; migrations: Record<string, unknown>[] }), text: r.text };
}

beforeAll(async () => {
  e = await startReadEngine({ storeBackupRemote: "https://u:SECRETY@example.com/r.git" });
});

afterAll(async () => {
  await e?.dispose();
});

describe("POST /datanotes/settings/update/ over HTTP", () => {
  it("applies a live change at once, journaled", async () => {
    const before = await version();
    const r = await post("/settings/update/", { expect_version: before, changes: { httpCompression: "off", logRetentionDays: 45 } });
    expect(r.status).toBe(200);
    const a = r.json as unknown as UpdateAnswer;
    expect(Object.keys(a)).toEqual(["ok", "dry_run", "settings_version", "changed", "applied_now", "after_restart", "restart_pending", "follow_ups", "migration_id", "settings"]);
    expect(a).toMatchObject({ ok: true, dry_run: false, changed: ["logRetentionDays", "httpCompression"], applied_now: ["logRetentionDays", "httpCompression"], after_restart: [], follow_ups: [] });
    expect(a.migration_id).toEqual(expect.any(String));
    expect(a.settings_version).not.toBe(before);
    expect(a.settings_version).toBe(await version());
    expect(e.settings.logRetentionDays).toBe(45);
    expect(e.settings.httpCompression).toBe("off");
    expect(a.settings.find((v) => v.name === "logRetentionDays")).toMatchObject({ value: 45, changed: true });
  });

  it("saves a restart setting, which waits for a restart", async () => {
    let r = await update({ vaultIndexEnabled: false });
    expect(r.status).toBe(200);
    let a = r.json as unknown as UpdateAnswer;
    expect([a.applied_now, a.after_restart, a.restart_pending]).toEqual([[], ["vaultIndexEnabled"], ["vaultIndexEnabled"]]);
    expect(a.settings.find((v) => v.name === "vaultIndexEnabled")!.restart_pending).toBe(true);
    expect((await post("/settings/", {})).json.restart_pending).toEqual(["vaultIndexEnabled"]);
    r = await update({ vaultIndexEnabled: true });
    a = r.json as unknown as UpdateAnswer;
    expect([a.after_restart, a.restart_pending]).toEqual([["vaultIndexEnabled"], []]);
  });

  it("puts a default back with null, and changes nothing when the value is the same", async () => {
    let r = await update({ logRetentionDays: null });
    expect(r.status).toBe(200);
    expect(e.settings.logRetentionDays).toBe(30);
    const count = (await journal()).total;
    const v = await version();
    r = await post("/settings/update/", { expect_version: v, changes: { logRetentionDays: 30 } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: [], settings_version: v });
    expect("migration_id" in r.json).toBe(false);
    expect((await journal()).total).toBe(count);
  });

  it("checks without saving on a dry run", async () => {
    const v = await version();
    const count = (await journal()).total;
    const r = await post("/settings/update/", { expect_version: v, changes: { journalRetentionDays: 60, semanticModel: "m2", semanticProvider: "openai" }, dry_run: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      dry_run: true,
      changed: ["journalRetentionDays", "semanticProvider", "semanticModel"],
      settings_version: v,
      // one entry per text: the first setting that has it
      follow_ups: [{ setting: "semanticProvider", description: SETTING_RULES.semanticProvider.followUp }],
    });
    expect("migration_id" in r.json).toBe(false);
    expect(e.settings.journalRetentionDays).toBe(90);
    expect(await version()).toBe(v);
    expect((await journal()).total).toBe(count);
  });

  it("refuses a change made on settings read before another change", async () => {
    const v = await version();
    expect((await post("/settings/update/", { expect_version: v, changes: { logRetentionDays: 31 } })).status).toBe(200);
    const stale = await post("/settings/update/", { expect_version: v, changes: { logRetentionDays: 32 } });
    expect(stale).toMatchObject({ status: 409, json: { ...guided(`the settings changed since you read them: settings_version is now "${await version()}"`), docs: CHANGE_DOCS } });
    expect(e.settings.logRetentionDays).toBe(31);
    // two at once with the same version: exactly one applies
    const w = await version();
    const both = await Promise.all([33, 34].map((n) => post("/settings/update/", { expect_version: w, changes: { logRetentionDays: n } })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect([33, 34]).toContain(e.settings.logRetentionDays);
  });

  it("refuses unknown, engine-set, file-only and bad values, naming each, and applies none", async () => {
    const refusedOne = async (changes: Record<string, unknown>, error: string, hint?: string | RegExp) => {
      const r = await update(changes);
      expect(r.status, JSON.stringify(changes)).toBe(400);
      expect(r.json).toMatchObject({ ...guided(error), docs: CHANGE_DOCS });
      if (typeof hint === "string") expect(r.json.hint).toBe(hint);
      else if (hint) expect(r.json.hint).toMatch(hint);
      return r;
    };
    await refusedOne({ telemtryEnabled: true }, 'no setting "telemtryEnabled"', /Did you mean "telemetryEnabled"\?/);
    await refusedOne({ databaseFolder: "x" }, "setting databaseFolder is set by the engine, not by the settings file", "configure_database (root) moves the database folder; the database's id never changes.");
    await refusedOne({ tableKey: "kind" }, "setting tableKey cannot change over HTTP", SETTING_RULES.tableKey.fileOnly);
    await refusedOne({ transactionLogFormat: "files" }, "setting transactionLogFormat cannot change over HTTP", SETTING_RULES.transactionLogFormat.fileOnly);
    await refusedOne({ journalRetentionDays: 0 }, "setting journalRetentionDays: 0 is not allowed", "journalRetentionDays takes an integer of at least 1 (days).");
    await refusedOne({ httpServerPort: 80 }, "setting httpServerPort: 80 is not allowed", "httpServerPort takes an integer from 1024 to 65535, or 0 for any free port.");
    await refusedOne({ telemetryTraceSampleRatio: 2 }, "setting telemetryTraceSampleRatio: 2 is not allowed", "telemetryTraceSampleRatio takes a number from 0 to 1.");
    await refusedOne({ semanticProvider: "nope" }, 'setting semanticProvider: "nope" is not allowed', `semanticProvider takes ${SETTING_RULES.semanticProvider.expected}.`);
    await refusedOne({ httpServerToken: null }, "setting httpServerToken cannot go back to a default: the engine always has an owner token", `Send a new token instead: ${SETTING_RULES.httpServerToken.writeCheck!.expected}.`);
    await refusedOne({ telemetryHeaders: ["x"] }, "setting telemetryHeaders: the value must be an object of header names and values");
    await refusedOne({ telemetryHeaders: { "X-Key": 5 } }, 'setting telemetryHeaders: the value of "X-Key" must be a string, or null to remove the header');
    await refusedOne({ telemetryHeaders: { "Bad Name": "x" } }, 'setting telemetryHeaders: "Bad Name" is not an HTTP header name');

    const r = await refusedOne({ zzz: 1, journalRetentionDays: 0, httpServerPort: 80, logRetentionDays: 40, aaa: 2 }, "setting journalRetentionDays: 0 is not allowed");
    const refused = r.json.refused as { setting: string; error: string; hint: string }[];
    expect(refused.map((x) => x.setting)).toEqual(["journalRetentionDays", "httpServerPort", "zzz", "aaa"]);
    expect(refused[0]).toEqual({ setting: "journalRetentionDays", error: "setting journalRetentionDays: 0 is not allowed", hint: "journalRetentionDays takes an integer of at least 1 (days)." });
    expect(e.settings.logRetentionDays).not.toBe(40);
  });

  it("refuses a bad body", async () => {
    const v = await version();
    const bad = async (body: unknown, error: string) => {
      const r = await post("/settings/update/", body);
      expect(r).toMatchObject({ status: 400, json: { ...guided(error), docs: CHANGE_DOCS } });
    };
    const EXPECT = `"expect_version" is required: the settings_version that POST /datanotes/settings/ answers`;
    const CHANGES = `"changes" must be an object of setting names and new values, such as {"logRetentionDays": 60}`;
    await bad({ changes: { logRetentionDays: 40 } }, EXPECT);
    await bad({ expect_version: "", changes: { logRetentionDays: 40 } }, EXPECT);
    for (const changes of [[], {}, "x", null, undefined]) await bad({ expect_version: v, changes }, CHANGES);
    await bad({ expect_version: v, changes: { logRetentionDays: 40 }, dry_run: "yes" }, `"dry_run" must be true or false`);
    expect(e.settings.logRetentionDays).not.toBe(40);
  });

  it("keeps secrets write-only", async () => {
    let r = await update({ telemetryHeaders: { Accept: "x/y" } });
    expect(r.status).toBe(200);
    r = await update({ telemetryHeaders: { "X-Api-Key": "SENTINEL-H1" } });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("SENTINEL");
    const view = (r.json as unknown as UpdateAnswer).settings.find((v) => v.name === "telemetryHeaders")!;
    expect(view.value).toEqual({ Accept: "<redacted>", "X-Api-Key": "<redacted>" });
    expect(e.settings.telemetryHeaders).toEqual({ Accept: "x/y", "X-Api-Key": "SENTINEL-H1" });
    r = await update({ telemetryHeaders: { "X-Api-Key": null } });
    expect(e.settings.telemetryHeaders).toEqual({ Accept: "x/y" });
    r = await update({ telemetryHeaders: null });
    expect(e.settings.telemetryHeaders).toEqual({});

    r = await update({ httpServerToken: "short-SENTINEL" });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("SENTINEL");
    expect(r.json).toMatchObject({ error: "setting httpServerToken: the value is not allowed" });
    r = await update({ telemetryEndpoint: "ftp://u:SENTINEL@h" });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("SENTINEL");

    r = await update({ httpServerToken: TOKEN48 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ after_restart: ["httpServerToken"], restart_pending: ["httpServerToken"] });
    expect(r.text).not.toContain(TOKEN48);
    // the running engine still takes the old token
    const after = await post("/settings/", {});
    expect(after.status).toBe(200);
    expect(after.text).not.toContain(TOKEN48);
    expect(after.json.restart_pending).toEqual(["httpServerToken"]);

    // an address sent back as shown keeps its credentials
    r = await update({ storeBackupRemote: "https://example.com/r.git" });
    expect(r.json).toMatchObject({ changed: [] });
    expect(e.settings.storeBackupRemote).toBe("https://u:SECRETY@example.com/r.git");
    r = await update({ storeBackupRemote: "https://example.com/other.git" });
    expect(r.json).toMatchObject({ changed: ["storeBackupRemote"] });
    expect(e.settings.storeBackupRemote).toBe("https://example.com/other.git");
  });

  it("journals each change with who made it, never a secret, and refuses its undo", async () => {
    const j = await journal();
    for (const s of ["SENTINEL", "SECRETY", TOKEN48]) expect(j.text).not.toContain(s);
    const first = j.migrations[j.migrations.length - 1]!;
    expect(first).toMatchObject({ op: "set_engine_settings", summary: "set logRetentionDays, httpCompression", actor: { auth: "owner", session: AGENT.session, harness: AGENT.harness } });
    expect(first.settings).toEqual([
      { name: "logRetentionDays", before: 30, after: 45 },
      { name: "httpCompression", before: "remote", after: "off" },
    ]);
    const settingsOf = (name: string) => j.migrations.flatMap((m) => (m.settings as JournalSettingChange[]).filter((c) => c.name === name));
    expect(settingsOf("telemetryHeaders")[0]).toEqual({ name: "telemetryHeaders", redacted: true });
    expect(settingsOf("httpServerToken")).toEqual([{ name: "httpServerToken", redacted: true }]);
    expect(settingsOf("storeBackupRemote")).toEqual([{ name: "storeBackupRemote", before: "https://example.com/r.git", after: "https://example.com/other.git", redacted: true }]);

    const undo = await post("/operations/undo_migration/", { migration_id: first.migration_id });
    expect(undo.status).toBe(409);
    expect(JSON.stringify(undo.json)).toContain("a change of the engine's settings cannot be undone: send the values you want back to POST /datanotes/settings/update/ (list_migrations shows the values before)");
    expect(undo.json).toMatchObject({ docs: CHANGE_DOCS, hint: expect.stringContaining("list_migrations with op set_engine_settings") });
  });

  it("clears the read cache after a change", async () => {
    expect((await e.op("owner", "select_rows", { table: PANTRY })).status).toBe(200);
    expect((await e.op("owner", "select_rows", { table: PANTRY })).status).toBe(200);
    expect(e.runtime.readCache!.stats().entries).toBeGreaterThan(0);
    expect((await update({ readCacheMaxBytes: 1048576 })).status).toBe(200);
    expect(e.runtime.readCache!.stats().entries).toBe(0);
  });

  it("starts the semantic index again after a change of its settings while it is on", async () => {
    expect((await update({ semanticEnabled: true })).status).toBe(200);
    const r = await update({ semanticModel: "other-model" });
    expect(r.json).toMatchObject({ follow_ups: [{ setting: "semanticModel", description: SETTING_RULES.semanticModel.followUp }] });
    expect((await update({ semanticEnabled: false })).status).toBe(200);
    // an address without credentials: journaled as it is
    const base = await update({ semanticBaseUrl: "http://127.0.0.1:11434/" });
    expect(base.json).toMatchObject({ changed: ["semanticBaseUrl"] });
    const j = await journal();
    expect(j.migrations[0]!.settings).toEqual([{ name: "semanticBaseUrl", before: "", after: "http://127.0.0.1:11434" }]);
  });
});

// ---- the class, with fake deps ------------------------------------------------------------------

interface Fake {
  routes: SettingsRoutes;
  s: DatanotesSettings;
  logs: { level: string; message: string; attrs: Record<string, string> }[];
  journals: { summary: string; settings: JournalSettingChange[] }[];
  saves: number;
  after: string[][];
}

function fake(over: Partial<SettingsDeps> = {}, running: Partial<DatanotesSettings> = {}): Fake {
  const s = mergeWithDefaults({ httpServerToken: "t".repeat(40), telemetryEndpoint: "https://u:SENTINEL@otel.example.com" });
  const f: Fake = { s, logs: [], journals: [], saves: 0, after: [], routes: null as unknown as SettingsRoutes };
  f.routes = new SettingsRoutes({
    getSettings: () => s,
    saveSettings: async () => {
      f.saves++;
    },
    running: () => running,
    settingsFile: () => "/x/settings.json",
    fileChanged: () => false,
    overrides: () => ({}),
    journal: async (summary, settings) => {
      f.journals.push({ summary, settings });
      return `m-${f.journals.length}`;
    },
    log: (level, message, attrs) => f.logs.push({ level, message, attrs }),
    afterChange: (changed) => f.after.push(changed),
    ...over,
  });
  return f;
}

const call = (f: Fake, route: string, body: Record<string, unknown>) => f.routes.handlers()[route]!(body);

describe("SettingsRoutes", () => {
  it("does not apply a change it could not save", async () => {
    const f = fake({ saveSettings: async () => Promise.reject(new Error("disk full")) });
    const v = f.routes.version;
    const r = await call(f, "/settings/update/", { expect_version: v, changes: { logRetentionDays: 45 } });
    expect(r).toMatchObject({ status: 503, json: { ...guided("the settings could not be saved: disk full"), docs: CHANGE_DOCS } });
    expect(f.s.logRetentionDays).toBe(30);
    expect(f.routes.version).toBe(v);
    expect(f.journals).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  it("puts the values back when the journal cannot be written", async () => {
    let saves = 0;
    const f = fake({
      saveSettings: async () => {
        saves++;
      },
      journal: async () => Promise.reject(new Error("store gone")),
    });
    const v = f.routes.version;
    const r = await call(f, "/settings/update/", { expect_version: v, changes: { logRetentionDays: 45 } });
    expect(r).toMatchObject({ status: 503, json: guided("the settings change could not be journaled: store gone") });
    expect(f.s.logRetentionDays).toBe(30);
    expect(saves).toBe(2);
    expect(f.routes.version).toBe(v);
    // the queue goes on after a failure
    const g = fake({ saveSettings: async () => Promise.reject(new Error("x")) });
    await Promise.all([
      call(g, "/settings/update/", { expect_version: g.routes.version, changes: { logRetentionDays: 45 } }),
      call(g, "/settings/update/", { expect_version: g.routes.version, changes: { logRetentionDays: 46 } }),
    ]).then((rs) => expect(rs.map((x) => x.status)).toEqual([503, 503]));
  });

  it("logs names, never values: INFO, or WARN for a setting with a warning", async () => {
    const f = fake();
    await runWithActor({ auth: "owner", session: "s1", harness: "h1" }, () => call(f, "/settings/update/", { expect_version: f.routes.version, changes: { logRetentionDays: 45 } }));
    await call(f, "/settings/update/", { expect_version: f.routes.version, changes: { telemetryEndpoint: "https://v:SENTINEL2@otel2.example.com" } });
    expect(f.logs.map((l) => [l.level, l.message])).toEqual([
      ["INFO", "datanotes engine settings changed"],
      ["WARN", "datanotes engine settings changed"],
    ]);
    expect(f.logs[0]!.attrs).toEqual({ settings: "logRetentionDays", applied_now: "logRetentionDays", after_restart: "", auth: "owner", session: "s1", harness: "h1", migration_id: "m-1" });
    expect(f.logs[1]!.attrs).toMatchObject({ settings: "telemetryEndpoint", auth: "owner", session: "", harness: "", migration_id: "m-2" });
    expect(JSON.stringify([f.logs, f.journals])).not.toContain("SENTINEL");
    expect(f.journals[1]!.settings).toEqual([{ name: "telemetryEndpoint", before: "https://otel.example.com/", after: "https://otel2.example.com/", redacted: true }]);
    expect(f.after).toEqual([["logRetentionDays"], ["telemetryEndpoint"]]);
    expect(f.routes.version).toMatch(/\.3$/);
  });

  it("says which restart settings wait, and which start options win", async () => {
    const f = fake({ overrides: () => ({ httpServerPort: "--port" }) }, { vaultIndexEnabled: true });
    const r = await call(f, "/settings/update/", { expect_version: f.routes.version, changes: { vaultIndexEnabled: false } });
    expect(r.json).toMatchObject({ restart_pending: ["vaultIndexEnabled"] });
    const read = await call(f, "/settings/", {});
    const views = (read.json as { settings: SettingView[]; settings_file: string }).settings;
    expect(views.find((v) => v.name === "httpServerPort")!.overridden_by).toBe("--port");
    expect(views.find((v) => v.name === "vaultIndexEnabled")!.restart_pending).toBe(true);
    expect((read.json as { settings_file: string }).settings_file).toBe("/x/settings.json");
  });

  it("refuses a change while the settings file was edited by hand", async () => {
    const f = fake({ fileChanged: () => true });
    const r = await call(f, "/settings/update/", { expect_version: f.routes.version, changes: { logRetentionDays: 45 }, dry_run: true });
    expect(r).toMatchObject({ status: 409, json: { ...guided("the settings file changed on disk since the engine read it: /x/settings.json"), docs: CHANGE_DOCS } });
  });

  it("refuses a named token in the handler too", async () => {
    const f = fake();
    for (const route of ["/settings/", "/settings/update/"]) {
      const r = await runWithActor({ auth: "cook" }, () => call(f, route, { expect_version: f.routes.version, changes: { logRetentionDays: 45 } }));
      expect(r).toMatchObject({ status: 403, json: guided(`token cook may not call ${route} (reserved to the owner)`) });
    }
    expect(f.s.logRetentionDays).toBe(30);
  });
});
