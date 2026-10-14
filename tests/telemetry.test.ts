import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOOP_TELEMETRY, setTelemetry, telemetry, traced, type TelemetrySettings } from "../src/core/telemetry";
import { OtlpSink, resolveOtlp } from "../src/server/otlp-sink";
import { engineResource, hostName } from "../src/server/tracing";
import { renameColumn, undoOperation } from "../src/core/engine";
import { DEFAULT_SETTINGS, mergeWithDefaults } from "../src/core/settings";
import { logVault } from "./helpers/db-vault";
import { INDEX_RETRY } from "../src/core/engine";

INDEX_RETRY.delayMs = 1;

const settings: TelemetrySettings = {
  telemetryEnabled: true,
  telemetryEndpoint: "http://127.0.0.1:4318/",
  telemetryServiceName: "datanotes",
};

afterEach(() => setTelemetry(NOOP_TELEMETRY));

describe("engine telemetry configuration", () => {
  const base = { serviceVersion: "9.9.9", resource: { "service.instance.id": "service" } };

  it("comes from the settings, and the standard OTEL_* variables override them", () => {
    expect(resolveOtlp({ ...settings, telemetryEnabled: false }, {}, base)).toBeNull();
    expect(resolveOtlp(settings, {}, base)).toEqual({
      endpoint: "http://127.0.0.1:4318/",
      serviceName: "datanotes",
      serviceVersion: "9.9.9",
      protocol: "http/protobuf",
      headers: {},
      resource: { "service.instance.id": "service" },
    });
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=k%3D1",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_SERVICE_NAME: "vault-engine",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=home",
    };
    // the variables alone turn it on, even with telemetryEnabled false
    expect(resolveOtlp({ ...settings, telemetryEnabled: false, telemetryHeaders: { a: "b" } }, env, base)).toEqual({
      endpoint: "https://otlp.example.com",
      serviceName: "vault-engine",
      serviceVersion: "9.9.9",
      protocol: "http/json",
      headers: { a: "b", "api-key": "k=1" },
      resource: { "service.instance.id": "service", "deployment.environment": "home" },
    });
    expect(resolveOtlp(settings, { OTEL_SDK_DISABLED: "true" }, base)).toBeNull();
    expect(resolveOtlp(settings, { OTEL_LOGS_EXPORTER: "none" }, base)).toBeNull();
  });

  it("builds the resource only while logs are exported (asked for every record), and names the host once per process", () => {
    let built = 0;
    const lazy = () => {
      built++;
      return base;
    };
    expect(resolveOtlp({ ...settings, telemetryEnabled: false }, {}, lazy)).toBeNull();
    expect(resolveOtlp(settings, { OTEL_SDK_DISABLED: "true" }, lazy)).toBeNull();
    expect(built).toBe(0);
    expect(resolveOtlp(settings, {}, lazy)).toEqual(resolveOtlp(settings, {}, base));
    expect(built).toBe(1);
    const name = os.hostname();
    const asked = vi.spyOn(os, "hostname");
    expect([hostName(), hostName(), engineResource({}, "service")["host.name"]]).toEqual([name, name, name]);
    // asked of the system at most once (none when an earlier test asked already), then kept
    const times = asked.mock.calls.length;
    expect(times).toBeLessThanOrEqual(1);
    expect(hostName()).toBe(name);
    expect(asked).toHaveBeenCalledTimes(times);
    asked.mockRestore();
  });

  it("sends to the configured collector with its headers, and follows settings changes", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    let s: TelemetrySettings = { ...settings, telemetryHeaders: { "x-api-key": "k1" } };
    const sink = new OtlpSink(() => resolveOtlp(s, {}, { serviceVersion: "1" }), async (url, _b, headers) => void calls.push({ url, headers }));
    sink.log("INFO", "a");
    await sink.flush();
    expect(calls[0]).toEqual({ url: "http://127.0.0.1:4318/v1/logs", headers: { "Content-Type": "application/x-protobuf", "x-api-key": "k1" } });
    s = { ...settings, telemetryProtocol: "http/json", telemetryEndpoint: "http://other:4318" };
    sink.log("INFO", "b");
    await sink.flush();
    expect(calls[1]).toEqual({ url: "http://other:4318/v1/logs", headers: { "Content-Type": "application/json" } });
    s = { ...settings, telemetryEnabled: false };
    sink.log("INFO", "ignored");
    await sink.flush();
    expect(calls).toHaveLength(2);
    expect(mergeWithDefaults({ telemetryHeaders: { "x-api-key": "k", "bad key": "x", n: 1 } as never }).telemetryHeaders).toEqual({ "x-api-key": "k" });
    expect(mergeWithDefaults({ telemetryHeaders: "nope" as never }).telemetryHeaders).toEqual({});
    expect(mergeWithDefaults({ telemetryProtocol: "grpc" as never }).telemetryProtocol).toBe("http/protobuf");
    expect(mergeWithDefaults({ telemetryProtocol: "http/json" }).telemetryProtocol).toBe("http/json");
  });
});

describe("traced and engine instrumentation", () => {
  it("logs success with summary and errors with error attributes", async () => {
    const records: { sev: string; body: string; attrs: Record<string, unknown> }[] = [];
    setTelemetry({ log: (sev, body, attrs = {}) => records.push({ sev, body, attrs }), flush: async () => {} });
    let t = 0;
    const clock = () => (t += 5);
    await traced("ok", { a: 1 }, async () => 3, (n) => ({ attributes: { n } }), clock);
    await expect(traced("bad", {}, async () => { throw new TypeError("boom"); }, undefined, clock)).rejects.toThrow("boom");
    await expect(traced("bad2", {}, async () => { throw "str"; }, undefined, clock)).rejects.toBe("str");
    expect(records[0]).toEqual({ sev: "INFO", body: "ok", attrs: { a: 1, n: 3, duration_ms: 5 } });
    expect(records[1]!.sev).toBe("ERROR");
    expect(records[1]!.attrs["error.type"]).toBe("TypeError");
    expect(records[2]!.attrs["error.message"]).toBe("str");
    await traced("default", {}, async () => 1);
    expect(records[3]!.sev).toBe("INFO");
  });

  it("every engine operation emits one record", async () => {
    const records: { sev: string; body: string; attrs: Record<string, unknown> }[] = [];
    setTelemetry({ log: (sev, body, attrs = {}) => records.push({ sev, body, attrs }), flush: async () => {} });
    const v = logVault();
    const r = await renameColumn(v.app, v.settings, { table: "log", from: "metric_drinks", to: "units" });
    await undoOperation(v.app, v.settings, r.migration_id!);
    await undoOperation(v.app, v.settings, r.migration_id!);
    await renameColumn(v.app, v.settings, { table: "log", from: "zzz", to: "y" }).catch(() => {});
    expect(records.map((x) => `${x.sev} ${x.body}`)).toEqual([
      "INFO datanotes rename_column",
      "INFO datanotes undo_migration",
      "WARN datanotes undo_migration",
      "ERROR datanotes rename_column",
    ]);
    expect(records[0]!.attrs).toMatchObject({ table: "log", from: "metric_drinks", to: "units", ok: true, notes_changed: 1 });
    expect(telemetry()).not.toBe(NOOP_TELEMETRY);
  });
});

describe("telemetry settings", () => {
  it("defaults to local SigNoz and validates merges", () => {
    expect(DEFAULT_SETTINGS.telemetryEndpoint).toBe("http://127.0.0.1:4318");
    const m = mergeWithDefaults({
      telemetryEnabled: false,
      telemetryEndpoint: "http://signoz.local:4318/",
      telemetryServiceName: " vault ",
    });
    expect(m).toMatchObject({
      telemetryEnabled: false,
      telemetryEndpoint: "http://signoz.local:4318",
      telemetryServiceName: "vault",
    });
    const bad = mergeWithDefaults({
      telemetryEndpoint: "ftp://x",
      telemetryServiceName: " ",
    });
    expect(bad.telemetryEndpoint).toBe(DEFAULT_SETTINGS.telemetryEndpoint);
    expect(bad.telemetryServiceName).toBe(DEFAULT_SETTINGS.telemetryServiceName);
  });
});
