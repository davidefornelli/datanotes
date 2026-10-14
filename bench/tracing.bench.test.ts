/**
 * `npm run bench`: what traces cost a request. An engine on a table of TRACING_BENCH_ROWS rows
 * (2000 by default) answers select_rows and insert_row over HTTP, with traces off, then on (every
 * trace kept and encoded, sent to a collector that drops them). Prints the median of SAMPLES calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeWithDefaults } from "../src/core/settings";
import { openNodeVault } from "../src/node/node-app";
import { EngineRuntime } from "../src/server/runtime";
import { DatanotesClient } from "../src/api/client";
import { tracingOn } from "../src/core/tracing";
import { LOG_YAML, METASTORE, TEST_DATABASE_FOLDER } from "../tests/helpers/db-vault";

const ROWS = Number(process.env.TRACING_BENCH_ROWS ?? 2000);
const SAMPLES = Number(process.env.SAMPLES ?? 40);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe(`traces on a table of ${ROWS} rows`, () => {
  it("cost a request little", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracing-bench-"));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "tracing-bench-store-"));
    fs.mkdirSync(path.dirname(path.join(root, METASTORE)), { recursive: true });
    fs.writeFileSync(path.join(root, METASTORE), LOG_YAML);
    const dir = path.join(root, TEST_DATABASE_FOLDER, "main", "public", "log");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < ROWS; i++) {
      const id = `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`;
      fs.writeFileSync(path.join(dir, `row ${i}.md`), `---\ntable: main.public.log\nid: ${id}\nkind: ${["walk", "mood", "alcohol"][i % 3]}\noccurred_at: 2026-10-01T08:00:00Z\n---\n`);
    }
    const host = openNodeVault(root, undefined, { store });
    const s = mergeWithDefaults({ fileLogEnabled: false, autoRecompute: false, databaseFolder: TEST_DATABASE_FOLDER, httpServerToken: "t", telemetryEnabled: false });
    s.httpServerPort = 0;
    let spans = 0;
    const runtime = new EngineRuntime({
      app: host.app,
      getSettings: () => s,
      saveSettings: async () => {},
      transport: async () => ({ status: 500, text: "" }),
      embeddingKey: () => undefined,
      version: "bench",
      hostName: "bench",
      canServeHttp: true,
      httpHost: "127.0.0.1",
      env: {},
      otlpSend: async (url, body) => {
        if (url.endsWith("/v1/traces")) spans += body.length;
      },
    });
    runtime.startTelemetry();
    await runtime.start();
    const client = new DatanotesClient({ url: `http://127.0.0.1:${runtime.httpPort}`, token: "t" });
    const refresh = () => (runtime as unknown as { refreshTracing(): void; traces: { readAt: number } });
    let n = 0;
    const measure = async (label: string) => {
      const select: number[] = [];
      const insert: number[] = [];
      for (let i = 0; i < 5; i++) await client.call("select_rows", { table: "log", where: { kind: "walk" }, limit: 50 });
      for (let i = 0; i < SAMPLES; i++) {
        let t0 = performance.now();
        const r = await client.call("select_rows", { table: "log", where: { kind: "walk" }, order_by: "occurred_at", limit: 50 });
        select.push(performance.now() - t0);
        expect(r.ok).toBe(true);
        t0 = performance.now();
        const day = new Date(Date.UTC(2027, 0, 1) + n++ * 86_400_000).toISOString();
        const w = await client.call("insert_row", { table: "log", values: { kind: "walk", occurred_at: day } });
        insert.push(performance.now() - t0);
        expect(w.ok).toBe(true);
      }
      console.log(`${label.padEnd(12)} select_rows median ${median(select).toFixed(2)} ms, insert_row median ${median(insert).toFixed(2)} ms`);
      return { select: median(select), insert: median(insert) };
    };
    try {
      expect(tracingOn()).toBe(false);
      const off1 = await measure("traces off");
      s.telemetryEnabled = true;
      s.telemetryEndpoint = "http://127.0.0.1:9";
      refresh().traces.readAt = -Infinity;
      refresh().refreshTracing();
      expect(tracingOn()).toBe(true);
      const on = await measure("traces on");
      s.telemetryEnabled = false;
      refresh().traces.readAt = -Infinity;
      refresh().refreshTracing();
      const off2 = await measure("traces off");
      await (runtime as unknown as { traces: { flush(): Promise<void> } }).traces.flush();
      console.log(`overhead: select_rows ${(on.select - Math.min(off1.select, off2.select)).toFixed(2)} ms, insert_row ${(on.insert - Math.min(off1.insert, off2.insert)).toFixed(2)} ms; ${spans} bytes of spans encoded`);
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});
