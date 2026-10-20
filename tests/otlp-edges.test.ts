import { afterEach, describe, expect, it, vi } from "vitest";
import { OtlpLogExporter, parseOtlpHeaders } from "../src/api/otlp";
import { OtlpSink } from "../src/server/otlp-sink";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** The global fetch as a collector that answers `status`, recording what it gets. */
function collector(status: number): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string; headers: Record<string, string>; body: unknown }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { ok: status >= 200 && status < 300, status };
  });
  return calls;
}

describe("OTLP exporter: the default transport (fetch)", () => {
  it("POSTs each batch to <endpoint>/v1/logs with the content type and the configured headers", async () => {
    const calls = collector(200);
    const x = new OtlpLogExporter({ endpoint: "https://otel.example.com/", serviceName: "datanotes", protocol: "http/json", headers: { "api-key": "k" }, flushMs: 0 });
    x.log("INFO", "engine started");
    await x.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://otel.example.com/v1/logs", method: "POST", headers: { "Content-Type": "application/json", "api-key": "k" } });
    expect(JSON.parse(calls[0]!.body as string).resourceLogs[0].scopeLogs[0].logRecords[0].body).toEqual({ stringValue: "engine started" });
    expect([x.sent, x.dropped]).toEqual([1, 0]);
  });

  it("strips every trailing slash of the endpoint", async () => {
    const urls: string[] = [];
    const x = new OtlpLogExporter({ endpoint: "http://c:4318///", serviceName: "svc", flushMs: 0, send: async (u) => void urls.push(u) });
    x.log("INFO", "hi");
    await x.flush();
    expect(urls).toEqual(["http://c:4318/v1/logs"]);
  });

  it("counts a batch the collector refuses (HTTP 5xx) as dropped, without throwing", async () => {
    collector(503);
    const x = new OtlpLogExporter({ endpoint: "https://otel.example.com", serviceName: "datanotes", flushMs: 0 });
    x.log("ERROR", "a");
    x.log("ERROR", "b");
    await x.flush();
    expect([x.sent, x.dropped]).toEqual([0, 2]);
  });
});

describe("OTLP exporter: batching in time", () => {
  it("sends what is buffered every flushMs (5 s by default), and close() stops the timer after a last send", async () => {
    vi.useFakeTimers();
    const batches: number[] = [];
    const send = async (_u: string, body: string | Uint8Array) => void batches.push(JSON.parse(body as string).resourceLogs[0].scopeLogs[0].logRecords.length);
    const x = new OtlpLogExporter({ endpoint: "http://c:4318", serviceName: "svc", protocol: "http/json", send });
    x.log("INFO", "one");
    x.log("INFO", "two");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toEqual([2]);
    x.log("INFO", "three");
    await x.close();
    expect(batches).toEqual([2, 1]);
    x.log("INFO", "after close");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(batches).toEqual([2, 1]); // no timer any more
    await x.close(); // closing twice is harmless
    expect(batches).toEqual([2, 1, 1]);
  });
});

describe("OTLP exporter: http/protobuf attributes", () => {
  it("encodes a false boolean as boolValue 0 instead of dropping it", async () => {
    let body: Uint8Array | null = null;
    const x = new OtlpLogExporter({ endpoint: "http://c:4318", serviceName: "svc", flushMs: 0, send: async (_u, b) => void (body = b as Uint8Array) });
    x.log("INFO", "write", { dry_run: false });
    await x.flush();
    // KeyValue { key: "dry_run" (field 1), value: AnyValue { bool_value (field 2, varint) = 0 } }
    const key = [...new TextEncoder().encode("dry_run")];
    const kv = [0x0a, key.length, ...key, 0x12, 0x02, 0x10, 0x00];
    expect(Buffer.from(body!).includes(Buffer.from(kv))).toBe(true);
  });
});

describe("parseOtlpHeaders", () => {
  it("keeps a value that is not valid URL encoding as written, and skips a key made of spaces", () => {
    expect(parseOtlpHeaders("authorization=Basic%20dXNlcg==,x-bad=100%,  =v")).toEqual({ authorization: "Basic dXNlcg==", "x-bad": "100%" });
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });
});

describe("OtlpSink: the engine's telemetry over the exporter", () => {
  it("uses fetch when no transport is given, and reports what was sent and dropped", async () => {
    const calls = collector(200);
    const sink = new OtlpSink(() => ({ endpoint: "http://collector:4318", serviceName: "datanotes", serviceVersion: "3.0.0", protocol: "http/json" }));
    expect([sink.sent, sink.dropped]).toEqual([0, 0]); // no exporter yet
    sink.log("INFO", "insert_row", { table: "personal.metrics.mood" });
    await sink.flush();
    expect(calls.map((c) => c.url)).toEqual(["http://collector:4318/v1/logs"]);
    expect([sink.sent, sink.dropped]).toEqual([1, 0]);
  });

  it("drops nothing and sends nothing while export is off", async () => {
    const calls = collector(200);
    const sink = new OtlpSink(() => null);
    sink.log("INFO", "ignored");
    await sink.flush();
    expect(calls).toEqual([]);
    expect([sink.sent, sink.dropped]).toEqual([0, 0]);
  });
});
