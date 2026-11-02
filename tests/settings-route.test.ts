/**
 * Reading the engine's settings over HTTP (`POST /datanotes/settings/`, src/server/settings-route.ts):
 * every setting with its rule, secrets hidden, owner only.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guided } from "./helpers/guidance";
import { READ_OWNER_TOKEN, startReadEngine, type ReadEngine } from "./helpers/read-tokens";
import { PROVIDER_PRESETS } from "../src/core/embeddings";
import { DEFAULT_SETTINGS, mergeWithDefaults, RUNTIME_KEYS, SETTING_RULES } from "../src/core/settings";
import { settingsView, withoutCredentials, type SettingView } from "../src/server/settings-route";

let e: ReadEngine;

interface Answer {
  settings_file: string | null;
  settings_version: string;
  file_changed_on_disk: boolean;
  restart_pending: string[];
  settings: SettingView[];
}

let answer: Answer;
let text: string;
const viewOf = (name: string): SettingView => answer.settings.find((v) => v.name === name)!;

beforeAll(async () => {
  e = await startReadEngine({
    telemetryHeaders: { Authorization: "Bearer SECRETX" },
    storeBackupRemote: "https://u:SECRETY@example.com/r.git",
    semanticBaseUrl: "https://k:SECRETZ@api.example.com/v1",
  });
  const r = await e.route("owner", "/settings/", {});
  expect(r.status).toBe(200);
  answer = r.json as unknown as Answer;
  text = r.text;
});

afterAll(async () => {
  await e?.dispose();
});

describe("POST /datanotes/settings/", () => {
  it("lists every setting of the settings file, in its order", () => {
    expect(answer.settings.map((v) => v.name)).toEqual(Object.keys(DEFAULT_SETTINGS).filter((k) => !(RUNTIME_KEYS as readonly string[]).includes(k)));
    expect(Object.keys(answer)).toEqual(["settings_file", "settings_version", "file_changed_on_disk", "restart_pending", "settings"]);
    expect(answer.settings_file).toBeNull();
    expect(answer.restart_pending).toEqual([]);
    expect(answer.file_changed_on_disk).toBe(false);
    expect(typeof answer.settings_version).toBe("string");
    expect(answer.settings_version).not.toBe("");
  });

  it("never sends a secret", () => {
    for (const secret of ["SECRETX", "SECRETY", "SECRETZ", READ_OWNER_TOKEN]) expect(text).not.toContain(secret);
    const token = viewOf("httpServerToken");
    expect(token).toMatchObject({ write_only: true, redacted: true, changed: true, type: "string", applies: "restart" });
    expect("value" in token).toBe(false);
    expect("default_value" in token).toBe(false);
    expect(token.expected).toBe(SETTING_RULES.httpServerToken.writeCheck!.expected);
    expect(viewOf("telemetryHeaders")).toMatchObject({ value: { Authorization: "<redacted>" }, default_value: {}, changed: true, redacted: true });
    expect(viewOf("storeBackupRemote")).toMatchObject({ value: "https://example.com/r.git", redacted: true, changed: true, sends_data: true });
    expect(viewOf("semanticBaseUrl")).toMatchObject({ value: "https://api.example.com/v1", redacted: true });
    // an address without credentials is not redacted
    expect(viewOf("telemetryEndpoint")).toMatchObject({ value: "http://127.0.0.1:4318", changed: false, sends_data: true });
    expect("redacted" in viewOf("telemetryEndpoint")).toBe(false);
  });

  it("describes each setting's rule", () => {
    expect(viewOf("journalRetentionDays")).toMatchObject({ type: "integer", minimum: 1, applies: "live", value: 90, default_value: 90, changed: false, editable: true, restart_pending: false });
    expect("maximum" in viewOf("journalRetentionDays")).toBe(false);
    expect(viewOf("telemetryTraceSampleRatio")).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(viewOf("semanticProvider").values).toEqual(Object.keys(PROVIDER_PRESETS));
    expect(viewOf("vaultIndexEnabled").applies).toBe("restart");
    expect(viewOf("tableKey")).toMatchObject({ editable: false, change_with: SETTING_RULES.tableKey.fileOnly });
    expect(viewOf("telemetryEndpoint").sends_data).toBe(true);
    expect(viewOf("httpServerPort").warning).toBe(
      "After the restart the engine, and this page, answer on this port. If another program holds it, the engine does not start. In a container, publish the new port too.",
    );
    // the readEngine's own values: changed from the defaults
    expect(viewOf("fileLogEnabled")).toMatchObject({ value: false, default_value: true, changed: true });
    expect(viewOf("semanticExclude")).toMatchObject({ type: "string_list", value: [] });
  });

  it("strips the credentials of an address, and leaves any other text as it is", () => {
    expect(withoutCredentials("https://user:pw@host/x")).toBe("https://host/x");
    expect(withoutCredentials("https://user@host")).toBe("https://host/");
    expect(withoutCredentials("git@host:repo.git")).toBe("git@host:repo.git");
    expect(withoutCredentials("")).toBe("");
    expect(withoutCredentials("https://host/x")).toBe("https://host/x");
  });

  it("shows no header as redacted, and the start options that win over a setting", () => {
    const s = mergeWithDefaults({ httpServerToken: "" });
    const view = settingsView(s, { httpServerPort: 27150 }, { httpServerPort: "--port" });
    const of = (n: string) => view.find((v) => v.name === n)!;
    expect(of("telemetryHeaders")).toMatchObject({ value: {}, changed: false });
    expect("redacted" in of("telemetryHeaders")).toBe(false);
    expect(of("httpServerToken").changed).toBe(false);
    expect(of("httpServerPort")).toMatchObject({ overridden_by: "--port", restart_pending: false });
    s.httpServerPort = 0;
    expect(settingsView(s, { httpServerPort: 27150 }, {}).find((v) => v.name === "httpServerPort")).toMatchObject({ restart_pending: true });
    // not in what the run started with: nothing to compare
    expect(settingsView(s, {}, {}).find((v) => v.name === "httpServerPort")!.restart_pending).toBe(false);
  });

  it("refuses named tokens, also with maintain", async () => {
    for (const route of ["/settings/", "/settings/update/"]) {
      const r = await e.route("cook", route, { expect_version: answer.settings_version, changes: { logRetentionDays: 45 } });
      expect(r).toMatchObject({ status: 403, json: guided(`token cook may not call ${route} (reserved to the owner)`) });
    }
    const created = await e.route("owner", "/tokens/create/", { name: "keeper", maintain: true });
    expect(created.status).toBe(200);
    const secret = (created.json as { token: string }).token;
    for (const route of ["/settings/", "/settings/update/"]) {
      const res = await fetch(`${e.url}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expect_version: answer.settings_version, changes: { logRetentionDays: 45 } }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject(guided(`token keeper may not call ${route} (reserved to the owner)`));
    }
    expect(e.settings.logRetentionDays).toBe(30);
  });
});
