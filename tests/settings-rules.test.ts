/**
 * The rules of the engine's settings (`SETTING_RULES`, src/core/settings.ts): one table for the
 * loader (`mergeWithDefaults`) and the settings route. The loader must behave exactly as it did
 * before the table existed: a frozen copy of it (as of 597d400) is compared on every key with many
 * samples. A value a write over HTTP accepts must be kept by the next start (round trip).
 */

import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, type ProviderKind } from "../src/core/embeddings";
import { normalizeDatabaseFolder } from "../src/core/db-paths";
import { checkSetting, DEFAULT_SETTINGS, mergeWithDefaults, RUNTIME_KEYS, SETTING_RULES, type DatanotesSettings, type EditableSettingKey } from "../src/core/settings";

// ---- frozen copy of the loader as of 597d400 (git show 597d400:src/core/settings.ts) ----------

const KEYS_AT_597D400: (keyof DatanotesSettings)[] = [
  "journalRetentionDays",
  "fileLogEnabled",
  "logRetentionDays",
  "databaseFolder",
  "databaseId",
  "tableKey",
  "telemetryEnabled",
  "telemetryEndpoint",
  "telemetryServiceName",
  "telemetryHeaders",
  "telemetryProtocol",
  "telemetryTraces",
  "telemetryTraceSampleRatio",
  "telemetryMaxSpansPerTrace",
  "telemetrySlowSpanMs",
  "telemetryEnvironment",
  "autoRecompute",
  "autoPack",
  "repairLinksOnHandMove",
  "semanticEnabled",
  "semanticProvider",
  "semanticBaseUrl",
  "semanticModel",
  "semanticScope",
  "semanticExclude",
  "semanticBatchSize",
  "writePriority",
  "writePriorityMaxWaitMs",
  "readCacheMaxBytes",
  "vaultIndexEnabled",
  "httpServerPort",
  "httpServerToken",
  "httpCompression",
  "storeBackupEnabled",
  "storeBackupRemote",
  "storeBackupIntervalSeconds",
  "storeSync",
  "transactionLogFormat",
];

function mergeAt597d400(
  loaded: Partial<DatanotesSettings> & Record<string, unknown>,
): DatanotesSettings {
  const out: DatanotesSettings = { ...DEFAULT_SETTINGS };

  for (const key of KEYS_AT_597D400) {
    if (!(key in loaded)) continue;
    const raw = loaded[key];
    if (raw === undefined) continue;

    switch (key) {
      case "telemetryEndpoint": {
        if (typeof raw === "string" && /^https?:\/\/\S+$/.test(raw.trim())) {
          out.telemetryEndpoint = raw.trim().replace(/\/+$/, "");
        }
        break;
      }
      case "telemetryProtocol": {
        if (raw === "http/protobuf" || raw === "http/json") out.telemetryProtocol = raw;
        break;
      }
      case "telemetryHeaders": {
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          out.telemetryHeaders = Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).filter(([k, v]) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k) && typeof v === "string"),
          ) as Record<string, string>;
        }
        break;
      }
      case "telemetryServiceName": {
        if (typeof raw === "string" && raw.trim().length > 0) {
          out.telemetryServiceName = raw.trim();
        }
        break;
      }
      case "telemetryTraceSampleRatio": {
        if (typeof raw === "number" && raw >= 0 && raw <= 1) out.telemetryTraceSampleRatio = raw;
        break;
      }
      case "telemetryMaxSpansPerTrace": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 100000) out.telemetryMaxSpansPerTrace = raw;
        break;
      }
      case "telemetrySlowSpanMs": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) out.telemetrySlowSpanMs = raw;
        break;
      }
      case "telemetryEnvironment": {
        if (typeof raw === "string") out.telemetryEnvironment = raw.trim();
        break;
      }
      case "tableKey": {
        if (typeof raw === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(raw.trim())) out.tableKey = raw.trim();
        break;
      }
      case "databaseFolder": {
        // "" is the root of the vault: the database is the folder the engine serves (--database)
        if (typeof raw === "string") out.databaseFolder = normalizeDatabaseFolder(raw);
        break;
      }
      case "databaseId": {
        if (typeof raw === "string") out.databaseId = raw.trim();
        break;
      }
      case "journalRetentionDays":
      case "logRetentionDays": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) out[key] = raw;
        break;
      }
      case "semanticProvider": {
        if (typeof raw === "string" && raw in PROVIDER_PRESETS) out.semanticProvider = raw as ProviderKind;
        break;
      }
      case "semanticBaseUrl": {
        if (typeof raw === "string" && (raw.trim() === "" || /^https?:\/\/\S+$/.test(raw.trim()))) out.semanticBaseUrl = raw.trim().replace(/\/+$/, "");
        break;
      }
      case "semanticModel": {
        if (typeof raw === "string") out.semanticModel = raw.trim();
        break;
      }
      case "semanticScope": {
        if (raw === "vault" || raw === "tables") out.semanticScope = raw;
        break;
      }
      case "semanticExclude": {
        if (Array.isArray(raw)) out.semanticExclude = raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().replace(/^\/+|\/+$/g, ""));
        break;
      }
      case "semanticBatchSize": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 512) out.semanticBatchSize = raw;
        break;
      }
      case "writePriorityMaxWaitMs": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 60000) out.writePriorityMaxWaitMs = raw;
        break;
      }
      case "readCacheMaxBytes": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) out.readCacheMaxBytes = raw;
        break;
      }
      case "httpServerPort": {
        // Refused, not replaced by the default: the default is the port of the usual engine, which
        // another engine must never take by mistake. 0 is any free port.
        if (typeof raw !== "number" || !Number.isInteger(raw) || (raw !== 0 && (raw < 1024 || raw > 65535))) {
          throw new Error(`invalid setting httpServerPort: ${JSON.stringify(raw)} (an integer from 1024 to 65535, or 0 for any free port)`);
        }
        out.httpServerPort = raw;
        break;
      }
      case "httpCompression": {
        if (raw === "remote" || raw === "always" || raw === "off") out.httpCompression = raw;
        break;
      }
      case "httpServerToken": {
        if (typeof raw === "string") out.httpServerToken = raw.trim();
        break;
      }
      case "storeBackupRemote": {
        if (typeof raw === "string") out.storeBackupRemote = raw.trim();
        break;
      }
      case "storeBackupIntervalSeconds": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 10) out.storeBackupIntervalSeconds = raw;
        break;
      }
      case "storeSync": {
        if (raw === "operation" || raw === "off") out.storeSync = raw;
        break;
      }
      case "transactionLogFormat": {
        if (raw === "files" || raw === "segments") out.transactionLogFormat = raw;
        break;
      }
      case "storeBackupEnabled":
      case "telemetryEnabled":
      case "telemetryTraces":
      case "fileLogEnabled":
      case "semanticEnabled":
      case "autoRecompute":
      case "autoPack":
      case "writePriority":
      case "vaultIndexEnabled":
      case "repairLinksOnHandMove": {
        if (typeof raw === "boolean") {
          out[key] = raw;
        }
        break;
      }
    }
  }

  return out;
}

// ---- samples ----------------------------------------------------------------------------------

const GENERIC: unknown[] = [
  true, false, null, "", "  ", 0, 1, -1, 10, 80, 1023, 1024, 65535, 65536, 1.5, 0.5, 2, 100000, 100001, 512, 513, 60000, 60001,
  "text", "  padded  ", "remote", "always", "off", "operation", "files", "segments", "vault", "tables", "http/json", "http/protobuf",
  "ollama", "openai", "nope", "_name", "9bad", "a b", "with-dash_1",
  "http://127.0.0.1:4318", "http://127.0.0.1:4318/", "https://u:pw@host/x//", " https://host/v1/ ", "ftp://host", "http://", "http:// x",
  "git@github.com:you/store.git", "a".repeat(48), "0123456789abcdef0123456789abcdef0123456789abcdef",
  [], ["Archive", " Templates/ "], ["a", "", " / ", 5, "/b/"], [1, 2], {}, { Authorization: "Bearer x" }, { "Bad Name": "x", Good: "y", "X-Num": 5 },
  { "X-Key": null }, "true", "1",
];

/** Valid values of each key (besides its default): what a write may send. */
const VALID: Record<EditableSettingKey, unknown[]> = {
  journalRetentionDays: [1, 90, 400],
  fileLogEnabled: [true, false],
  logRetentionDays: [1, 30],
  tableKey: ["table", "_type", "kind-1", "  padded  "],
  telemetryEnabled: [true, false],
  telemetryEndpoint: ["http://127.0.0.1:4318", "https://otel.example.com/", "https://u:pw@otel.example.com/x//", " http://h:1 "],
  telemetryServiceName: ["datanotes", "  svc  "],
  telemetryHeaders: [{}, { Authorization: "Bearer x" }, { "X-Key": "v", "x-other": "w" }],
  telemetryProtocol: ["http/protobuf", "http/json"],
  telemetryTraces: [true, false],
  telemetryTraceSampleRatio: [0, 0.25, 1],
  telemetryMaxSpansPerTrace: [1, 1000, 100000],
  telemetrySlowSpanMs: [0, 250],
  telemetryEnvironment: ["", "home", "  dev  "],
  autoRecompute: [true, false],
  autoPack: [true, false],
  repairLinksOnHandMove: [true, false],
  semanticEnabled: [true, false],
  semanticProvider: Object.keys(PROVIDER_PRESETS),
  semanticBaseUrl: ["", "http://127.0.0.1:11434", "https://k:pw@api.example.com/v1/"],
  semanticModel: ["", "nomic-embed-text", " openai/text-embedding-3-small "],
  semanticScope: ["vault", "tables"],
  semanticExclude: [[], ["Archive", "Templates"], [" /Archive/ ", "a/b"]],
  semanticBatchSize: [1, 32, 512],
  writePriority: [true, false],
  writePriorityMaxWaitMs: [0, 100, 60000],
  readCacheMaxBytes: [0, 1048576],
  vaultIndexEnabled: [true, false],
  httpServerPort: [0, 1024, 27150, 65535],
  httpServerToken: ["0123456789abcdef0123456789abcdef0123456789abcdef", "A".repeat(32), "a._~-".repeat(10)],
  httpCompression: ["remote", "always", "off"],
  storeBackupEnabled: [true, false],
  storeBackupRemote: ["", "git@github.com:you/store.git", "https://u:pw@example.com/r.git", "  /tmp/remote  "],
  storeBackupIntervalSeconds: [10, 60, 3600],
  storeSync: ["operation", "off"],
  transactionLogFormat: ["files", "segments"],
};

const EDITABLE = Object.keys(DEFAULT_SETTINGS).filter((k) => !(RUNTIME_KEYS as readonly string[]).includes(k)) as EditableSettingKey[];

function outcome(fn: () => DatanotesSettings): { value: DatanotesSettings } | { threw: string } {
  try {
    return { value: fn() };
  } catch (e) {
    return { threw: (e as Error).message };
  }
}

describe("SETTING_RULES", () => {
  it("has a rule for every key of the settings file, and none for the keys the host sets", () => {
    expect(Object.keys(SETTING_RULES)).toEqual(EDITABLE);
    for (const k of RUNTIME_KEYS) expect(k in SETTING_RULES).toBe(false);
  });

  it("accepts every default as it is, but the empty owner token", () => {
    for (const k of EDITABLE) {
      const c = checkSetting(k, DEFAULT_SETTINGS[k]);
      if (k === "httpServerToken") expect(c).toEqual({ ok: false, problem: "the value is not allowed" });
      else expect(c, k).toEqual({ ok: true, value: DEFAULT_SETTINGS[k] });
    }
  });

  it("leaves the loader unchanged: every key and sample gives what the loader of 597d400 gave", () => {
    const keys = [...EDITABLE, ...RUNTIME_KEYS] as (keyof DatanotesSettings)[];
    let compared = 0;
    for (const k of keys) {
      const samples = [...GENERIC, ...(VALID[k as EditableSettingKey] ?? []), DEFAULT_SETTINGS[k], undefined];
      for (const sample of samples) {
        const now = outcome(() => mergeWithDefaults({ [k]: sample } as never));
        const then = outcome(() => mergeAt597d400({ [k]: sample } as never));
        expect(now, `${k}: ${JSON.stringify(sample)}`).toEqual(then);
        compared++;
      }
    }
    // several keys at once, unknown keys too
    const all = Object.fromEntries(EDITABLE.map((k) => [k, VALID[k][VALID[k].length - 1]]));
    expect(mergeWithDefaults({ ...all, futureKey: 1 } as never)).toEqual(mergeAt597d400({ ...all, futureKey: 1 } as never));
    expect(mergeWithDefaults({})).toEqual(mergeAt597d400({}));
    expect(compared).toBeGreaterThan(2500);
  });

  it("keeps what a write saved at the next start (round trip)", () => {
    for (const k of EDITABLE) {
      for (const sample of VALID[k]) {
        const c = checkSetting(k, sample);
        expect(c.ok, `${k}: ${JSON.stringify(sample)}`).toBe(true);
        if (!c.ok) continue;
        expect(mergeWithDefaults({ [k]: c.value } as never)[k]).toEqual(c.value);
      }
    }
  });

  it("refuses what the loader would replace or drop, without echoing secrets", () => {
    expect(checkSetting("journalRetentionDays", 0)).toEqual({ ok: false, problem: "0 is not allowed" });
    const long = "9".repeat(100);
    expect(checkSetting("telemetryServiceName", 5)).toEqual({ ok: false, problem: "5 is not allowed" });
    expect(checkSetting("tableKey", long)).toEqual({ ok: false, problem: `${JSON.stringify(long).slice(0, 60)}…` + " is not allowed" });
    const ftp = checkSetting("telemetryEndpoint", "ftp://u:pw@h");
    expect(ftp).toEqual({ ok: false, problem: "the value is not allowed" });
    expect(JSON.stringify(ftp)).not.toContain("pw");
    expect(checkSetting("semanticExclude", ["a", " / "])).toEqual({ ok: false, problem: "item 2 is not a folder path" });
    expect(checkSetting("semanticExclude", [5])).toEqual({ ok: false, problem: "item 1 is not a folder path" });
    expect(checkSetting("semanticExclude", "Archive")).toEqual({ ok: false, problem: '"Archive" is not allowed' });
    expect(checkSetting("telemetryHeaders", { "Bad Name": "x" })).toEqual({ ok: false, problem: '"Bad Name" is not an HTTP header name' });
    expect(checkSetting("telemetryHeaders", { "X-Key": 5 })).toEqual({ ok: false, problem: 'the value of "X-Key" must be a string' });
    expect(checkSetting("telemetryHeaders", ["x"])).toEqual({ ok: false, problem: "the value is not allowed" });
    expect(checkSetting("httpServerToken", "short")).toEqual({ ok: false, problem: "the value is not allowed" });
    expect(checkSetting("httpServerToken", "0123456789abcdef0123456789abcdef0123456789abcdef")).toEqual({ ok: true, value: "0123456789abcdef0123456789abcdef0123456789abcdef" });
    expect(checkSetting("httpServerToken", 5)).toEqual({ ok: false, problem: "the value is not allowed" });
    expect(checkSetting("httpServerPort", 80)).toEqual({ ok: false, problem: "80 is not allowed" });
    expect(checkSetting("semanticProvider", "nope")).toEqual({ ok: false, problem: '"nope" is not allowed' });
    expect(checkSetting("telemetryEndpoint", " https://h/x/ ")).toEqual({ ok: true, value: "https://h/x" });
  });

  it("describes each rule as the browser and the reference show it", () => {
    expect(SETTING_RULES.journalRetentionDays).toMatchObject({ type: "integer", minimum: 1, expected: "an integer of at least 1 (days)", applies: "live" });
    expect(SETTING_RULES.telemetryProtocol.expected).toBe('"http/protobuf" or "http/json"');
    expect(SETTING_RULES.httpCompression.expected).toBe('"remote", "always" or "off"');
    expect(SETTING_RULES.semanticProvider.values).toEqual(Object.keys(PROVIDER_PRESETS) as ProviderKind[]);
    const restart = EDITABLE.filter((k) => SETTING_RULES[k].applies === "restart" && !SETTING_RULES[k].fileOnly);
    expect(restart).toEqual(["vaultIndexEnabled", "httpServerPort", "httpServerToken", "storeBackupEnabled", "storeBackupRemote", "storeBackupIntervalSeconds"]);
    expect(EDITABLE.filter((k) => SETTING_RULES[k].fileOnly)).toEqual(["tableKey", "transactionLogFormat"]);
    expect(EDITABLE.filter((k) => SETTING_RULES[k].sendsData)).toEqual(["telemetryEndpoint", "semanticBaseUrl", "storeBackupRemote"]);
    expect(EDITABLE.filter((k) => SETTING_RULES[k].secret)).toEqual(["telemetryEndpoint", "telemetryHeaders", "semanticBaseUrl", "httpServerToken", "storeBackupRemote"]);
  });
});
