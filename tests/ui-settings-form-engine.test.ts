/**
 * The engine settings screen's logic (src/ui/lib/settings-form.ts) against the real answers of
 * POST /datanotes/settings/ and /settings/update/ (contract 3.0.4), as the owner over HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startReadEngine, type ReadEngine } from "./helpers/read-tokens";
import {
  GROUPS,
  groupOf,
  headerPatch,
  inputOf,
  newOwnerToken,
  parseInput,
  rebase,
  refusedByName,
  setDraft,
  type GroupName,
  type SettingsAnswer,
  type SettingsUpdateAnswer,
} from "../src/ui/lib/settings-form";

let e: ReadEngine;

const EXPECTED_GROUPS: Record<string, GroupName> = {
  journalRetentionDays: "Journal and logs",
  fileLogEnabled: "Journal and logs",
  logRetentionDays: "Journal and logs",
  tableKey: "Vault",
  telemetryEnabled: "Telemetry",
  telemetryEndpoint: "Telemetry",
  telemetryServiceName: "Telemetry",
  telemetryHeaders: "Telemetry",
  telemetryProtocol: "Telemetry",
  telemetryTraces: "Telemetry",
  telemetryTraceSampleRatio: "Telemetry",
  telemetryMaxSpansPerTrace: "Telemetry",
  telemetrySlowSpanMs: "Telemetry",
  telemetryEnvironment: "Telemetry",
  autoRecompute: "Automatic work",
  autoPack: "Automatic work",
  repairLinksOnHandMove: "Automatic work",
  semanticEnabled: "Semantic search",
  semanticProvider: "Semantic search",
  semanticBaseUrl: "Semantic search",
  semanticModel: "Semantic search",
  semanticScope: "Semantic search",
  semanticExclude: "Semantic search",
  semanticBatchSize: "Semantic search",
  writePriority: "Performance",
  writePriorityMaxWaitMs: "Performance",
  readCacheMaxBytes: "Performance",
  vaultIndexEnabled: "Vault",
  httpServerPort: "HTTP server",
  httpServerToken: "HTTP server",
  httpCompression: "HTTP server",
  storeBackupEnabled: "Store",
  storeBackupRemote: "Store",
  storeBackupIntervalSeconds: "Store",
  storeSync: "Store",
  transactionLogFormat: "Store",
};

async function read(): Promise<SettingsAnswer> {
  const r = await e.route("owner", "/settings/", {});
  expect(r.status).toBe(200);
  return r.json as unknown as SettingsAnswer;
}

beforeAll(async () => {
  e = await startReadEngine();
});

afterAll(async () => {
  await e?.dispose();
});

describe("settings-form against the engine", () => {
  it("groups every real setting", async () => {
    const a = await read();
    const names = a.settings.map((v) => v.name);
    expect(names).toHaveLength(36);
    expect(Object.fromEntries(names.map((n) => [n, groupOf(n)]))).toEqual(EXPECTED_GROUPS);
    expect(new Set(names.map(groupOf))).toEqual(new Set(GROUPS));
  });

  it("an unchanged input is no edit, for every editable type with an input", async () => {
    const a = await read();
    const typed = a.settings.filter((v) => v.editable && !v.write_only && ["boolean", "integer", "number", "enum", "string", "string_list"].includes(v.type));
    expect(new Set(typed.map((v) => v.type))).toEqual(new Set(["boolean", "integer", "number", "enum", "string", "string_list"]));
    for (const v of typed) {
      const parsed = parseInput(v, inputOf(v));
      expect(parsed, v.name).toEqual({ value: v.value });
      expect(setDraft({}, v, parsed.value), v.name).toEqual({});
    }
  });

  it("saves a draft built by the library; the secrets never come back", async () => {
    const a = await read();
    const view = (n: string) => a.settings.find((v) => v.name === n)!;
    let draft = setDraft({}, view("logRetentionDays"), parseInput(view("logRetentionDays"), "45").value);
    const { patch, errors } = headerPatch({}, [{ name: "X-Api-Key", value: "SENTINEL-UI" }]);
    expect(errors).toEqual([]);
    draft = { ...draft, telemetryHeaders: patch };
    const token = newOwnerToken();
    draft = { ...draft, httpServerToken: token };
    const r = await e.route("owner", "/settings/update/", { expect_version: a.settings_version, changes: draft, dry_run: false });
    expect(r.status).toBe(200);
    const u = r.json as unknown as SettingsUpdateAnswer;
    expect(u.changed).toEqual(["logRetentionDays", "telemetryHeaders", "httpServerToken"]);
    const after = await e.route("owner", "/settings/", {});
    const journal = await e.op("owner", "list_migrations", { op: "set_engine_settings", limit: 10 });
    for (const text of [r.text, after.text, journal.text]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain("SENTINEL-UI");
    }
  });

  it("a conflict: rebase drops the setting the other client changed", async () => {
    const first = await read();
    const draft = {
      logRetentionDays: 60,
      autoPack: false,
    };
    const second = await e.route("owner", "/settings/update/", { expect_version: first.settings_version, changes: { logRetentionDays: 50 }, dry_run: false });
    expect(second.status).toBe(200);
    const stale = await e.route("owner", "/settings/update/", { expect_version: first.settings_version, changes: draft, dry_run: false });
    expect(stale.status).toBe(409);
    expect(String(stale.json.error)).toMatch(/^the settings changed since you read them/);
    const now = await read();
    expect(rebase(first.settings, now.settings, draft)).toEqual({ draft: { autoPack: false }, dropped: ["logRetentionDays"] });
  });

  it("refusedByName names the refused setting", async () => {
    const a = await read();
    const r = await e.route("owner", "/settings/update/", { expect_version: a.settings_version, changes: { journalRetentionDays: 0 }, dry_run: true });
    expect(r.status).toBe(400);
    expect(Object.keys(refusedByName(r.json))).toEqual(["journalRetentionDays"]);
  });
});
