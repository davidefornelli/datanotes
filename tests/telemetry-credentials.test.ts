/**
 * URL credentials in logs and telemetry: the file log and the OTLP log records leave without them,
 * and a telemetryEndpoint with credentials (Node's fetch refuses it) fails its export with nothing
 * kept. Never exports to the default http://127.0.0.1:4318: a real collector may listen there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileLogger } from "../src/core/telemetry";
import { OtlpSink } from "../src/server/otlp-sink";
import { startService, type RunningService } from "../src/node/service";
import type { SettingView } from "../src/server/settings-route";
import { METASTORE, withTables } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";
import { filesWith } from "./helpers/store-grep";

const S1 = "SENTINEL-TEL1";
const S2 = "SENTINEL-TEL2";
const S3 = "SENTINEL-TEL3";
const OWNER = "owner-token-telemetry-credentials-0123456789";

describe("the log sinks", () => {
  it("the file log removes URL credentials from the message and the string attributes", async () => {
    const written: string[] = [];
    const logger = new FileLogger({
      enabled: () => true,
      write: async (_day, lines) => {
        written.push(lines);
      },
    });
    logger.log("WARN", `failed: https://u:${S3}@h/x`, { error: `Failed to parse URL from https://u:${S3}@h:431800/v1/logs`, count: 2, ok: false, none: null });
    await logger.flush();
    expect(written).toHaveLength(1);
    const lines = written[0]!.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "failed: https://h/x", error: "Failed to parse URL from https://h:431800/v1/logs", count: 2, ok: false, none: null });
    expect(written[0]).not.toContain(S3);
  });

  it("OTLP log records leave without URL credentials", async () => {
    const bodies: string[] = [];
    const sink = new OtlpSink(
      () => ({ endpoint: "http://collector.test:4318", serviceName: "t", protocol: "http/json" }),
      async (_url, body) => {
        bodies.push(typeof body === "string" ? body : Buffer.from(body).toString("latin1"));
      },
    );
    sink.log("WARN", "export failed", { error: `Failed to parse URL from https://u:${S3}@h:431800/v1/logs` });
    sink.log("ERROR", `request to https://u:${S3}@h/x failed`);
    await sink.flush();
    const all = bodies.join("");
    expect(all).not.toContain(S3);
    expect(all).toContain("https://h");
  });
});

const running: RunningService[] = [];
const folders: string[] = [];
let exports: { url: string; error?: string }[] = [];

beforeEach(() => {
  exports = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/v1/logs") && !url.includes("/v1/traces")) return realFetch(input, init);
    const record: { url: string; error?: string } = { url };
    exports.push(record);
    try {
      return await realFetch(input, init);
    } catch (e) {
      record.error = String((e as Error).message);
      throw e;
    }
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const svc of running.splice(0)) await svc.stop();
  for (const d of folders.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function vault(extra: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-credentials-"));
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

describe("the telemetry export on the service", () => {
  it("a seeded endpoint with credentials: the export fails, its batch is dropped, nothing keeps the credentials", { timeout: 30_000 }, async () => {
    const svc = await start(vault({ telemetryEnabled: true, telemetryEndpoint: `https://u:${S1}@127.0.0.1:9` }));
    expect((await post(svc, "/operations/list_tables/", {})).status).toBe(200);
    expect((await post(svc, "/status/", {})).text).not.toContain(S1);
    await svc.stop();
    expect(exports.some((x) => x.url.includes("/v1/logs"))).toBe(true);
    expect(exports.every((x) => typeof x.error === "string")).toBe(true);
    expect(filesWith(svc.store.store, S1)).toEqual(["settings.json"]);
  });

  it("an endpoint new URL refuses, set over HTTP: no answer, view, journal entry, log or store file keeps it", { timeout: 30_000 }, async () => {
    const svc = await start(vault());
    const version = (await post(svc, "/settings/", {})).json.settings_version;
    const r = await post(svc, "/settings/update/", { expect_version: version, changes: { telemetryEnabled: true, telemetryEndpoint: `https://u:${S2}@otel.example.com:431800` } });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(S2);
    const read = await post(svc, "/settings/", {});
    expect((read.json.settings as SettingView[]).find((s) => s.name === "telemetryEndpoint")).toMatchObject({ value: "https://otel.example.com:431800", redacted: true });
    expect((await post(svc, "/operations/list_migrations/", { op: "set_engine_settings" })).text).not.toContain(S2);
    expect((await post(svc, "/operations/list_tables/", {})).status).toBe(200);
    await svc.stop();
    expect(exports.some((x) => x.url.includes("otel.example.com:431800") && (x.error ?? "").includes("Failed to parse URL"))).toBe(true);
    expect(filesWith(svc.store.store, S2)).toEqual(["settings.json"]);
  });
});
