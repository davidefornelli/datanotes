import { describe, expect, it } from "vitest";
import { OtlpLogExporter, OtlpTraceExporter, otlpTracesFromEnv, samplerRatioFromEnv, unixNano } from "../src/api/otlp";
import { formatTraceparent, newSpanId, newTraceId, parseTraceparent, traceHeaders, Tracer, type SpanRecord } from "../src/api/tracing";
import { DatanotesClient, type HttpRequest } from "../src/api/client";
import { mcpResource, tracerFromEnv, closeExporter } from "../src/mcp/log";

const SPAN: SpanRecord = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "b7ad6b7169203331",
  traceState: "k=v",
  name: "engine.op insert_row",
  kind: "server",
  startMs: 1_700_000_000_123.5,
  endMs: 1_700_000_000_125,
  attributes: { "db.operation.name": "insert_row", rows: 3, ms: 1.5, ok: false, none: undefined },
  events: [{ name: "exception", timeMs: 1_700_000_000_124, attributes: { "exception.type": "TypeError" } }],
  status: { code: "error", message: "boom" },
  droppedAttributes: 2,
  droppedEvents: 1,
};

describe("W3C Trace Context", () => {
  it("reads and writes traceparent and tracestate, and refuses what the spec refuses", () => {
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", " k=v ")).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true, traceState: "k=v" });
    expect(parseTraceparent(" 00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-00 ")).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: false });
    // a later version may add fields; version 00 may not
    expect(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03-extra")?.sampled).toBe(true);
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", 5 as never)?.traceState).toBeUndefined();
    for (const bad of [undefined, null, 7 as never, "", "garbage", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-x", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", `00-${"0".repeat(32)}-00f067aa0ba902b7-01`, `00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`]) {
      expect(parseTraceparent(bad)).toBeNull();
    }
    const ctx = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
    expect(formatTraceparent(ctx)).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(formatTraceparent({ ...ctx, sampled: false }).endsWith("-00")).toBe(true);
    expect(traceHeaders(ctx)).toEqual({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
    expect(traceHeaders({ ...ctx, traceState: "a=b" }).tracestate).toBe("a=b");
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newSpanId()).not.toBe(newSpanId());
  });
});

describe("the published tracer", () => {
  it("makes spans with explicit parents, samples new traces, follows a parent's choice, never throws", () => {
    const out: SpanRecord[] = [];
    let t = 0;
    const tracer = new Tracer({ export: (s) => out.push(...s), now: () => (t += 10) });
    const root = tracer.startSpan("tools/call x", { kind: "server", attributes: { a: 1, b: undefined } });
    const child = tracer.startSpan("POST /x", { kind: "client", parent: root.context });
    child.setAttribute("n", null).addEvent("retry", { attempt: 2 }).recordException(new TypeError("down")).setStatus("ok");
    child.end();
    child.end();
    root.recordException("plain").end();
    expect(out.map((s) => s.name)).toEqual(["POST /x", "tools/call x"]);
    expect(out[0]).toMatchObject({ kind: "client", parentSpanId: root.context.spanId, traceId: root.context.traceId, status: { code: "error", message: "down" }, attributes: { "error.type": "TypeError" } });
    expect(out[0]!.events.map((e) => e.name)).toEqual(["retry", "exception"]);
    expect(out[1]).toMatchObject({ attributes: { a: 1, "error.type": "string" }, status: { code: "error", message: "plain" } });
    expect(out[1]!.parentSpanId).toBeUndefined();
    expect(out[1]!.startMs).toBe(10);
    // a traceparent string as the parent; its state is passed on
    const fromHeader = tracer.startSpan("x", { parent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
    expect(fromHeader.context.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    const stated = tracer.startSpan("y", { parent: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true, traceState: "k=v" } });
    expect(stated.context.traceState).toBe("k=v");
    stated.setStatus("error").end();
    expect(out.at(-1)).toMatchObject({ name: "y", traceState: "k=v", status: { code: "error" } });
    out.pop();
    // a parent that does not record: nothing sent, its trace passed on as not sampled
    const quiet = tracer.startSpan("z", { parent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00" });
    expect([quiet.recording, quiet.context.sampled, quiet.context.traceId]).toEqual([false, false, "4bf92f3577b34da6a3ce929d0e0e4736"]);
    quiet.end();
    const none = new Tracer({ export: () => out.push({} as SpanRecord), sampleRatio: 0 }).startSpan("never");
    expect(none.recording).toBe(false);
    none.end();
    const half = new Tracer({ export: () => undefined, sampleRatio: 0.5 });
    const kept = Array.from({ length: 200 }, () => half.startSpan("s").recording).filter(Boolean).length;
    expect(kept).toBeGreaterThan(50);
    expect(kept).toBeLessThan(150);
    const broken = new Tracer({
      export: () => {
        throw new Error("collector bug");
      },
    });
    expect(() => broken.startSpan("s").end()).not.toThrow();
    expect(out).toHaveLength(2);
  });
});

describe("OTLP trace export", () => {
  it("encodes http/json as ExportTraceServiceRequest: hex ids, nanosecond strings, kinds and status", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const x = new OtlpTraceExporter({ endpoint: "http://c:4318/", serviceName: "datanotes", serviceVersion: "3.1.0", protocol: "http/json", resource: { "service.namespace": "datanotes" }, flushMs: 0, send: async (url, body, headers) => void calls.push({ url, body: body as string, headers }) });
    x.export(SPAN);
    x.export([{ ...SPAN, parentSpanId: undefined, traceState: undefined, status: { code: "ok" }, droppedAttributes: 0, droppedEvents: undefined, events: [] }]);
    await x.close();
    expect(calls[0]!.url).toBe("http://c:4318/v1/traces");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    const doc = JSON.parse(calls[0]!.body);
    const rs = doc.resourceSpans[0];
    expect(rs.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "datanotes" } },
      { key: "service.version", value: { stringValue: "3.1.0" } },
      { key: "service.namespace", value: { stringValue: "datanotes" } },
    ]);
    expect(rs.scopeSpans[0].scope).toEqual({ name: "datanotes", version: "3.1.0" });
    const [a, b] = rs.scopeSpans[0].spans;
    expect(a).toEqual({
      traceId: SPAN.traceId,
      spanId: SPAN.spanId,
      parentSpanId: SPAN.parentSpanId,
      traceState: "k=v",
      flags: 1,
      name: "engine.op insert_row",
      kind: 2,
      startTimeUnixNano: "1700000000123500000",
      endTimeUnixNano: "1700000000125000000",
      attributes: [
        { key: "db.operation.name", value: { stringValue: "insert_row" } },
        { key: "rows", value: { intValue: "3" } },
        { key: "ms", value: { doubleValue: 1.5 } },
        { key: "ok", value: { boolValue: false } },
      ],
      droppedAttributesCount: 2,
      events: [{ timeUnixNano: "1700000000124000000", name: "exception", attributes: [{ key: "exception.type", value: { stringValue: "TypeError" } }] }],
      droppedEventsCount: 1,
      status: { code: 2, message: "boom" },
    });
    expect(b.parentSpanId).toBeUndefined();
    expect(b.status).toEqual({ code: 1 });
    expect(b.droppedAttributesCount).toBeUndefined();
    expect(x.sent).toBe(2);
  });

  it("encodes http/protobuf (the default) as ExportTraceServiceRequest", async () => {
    let body: Uint8Array | null = null;
    const x = new OtlpTraceExporter({ endpoint: "http://c:4318", serviceName: "svc", flushMs: 0, send: async (_u, b, headers) => {
      expect(headers["Content-Type"]).toBe("application/x-protobuf");
      body = b as Uint8Array;
    } });
    x.export([SPAN, { ...SPAN, kind: "internal", parentSpanId: undefined, traceState: undefined, status: { code: "unset" }, droppedAttributes: 0, droppedEvents: 0, events: [] }]);
    await x.flush();
    const req = decode(body!);
    const rs = msg(req[1]![0]);
    expect(msg(rs[1]![0])[1]!.map(kv)).toEqual([["service.name", "svc"]]);
    const scope = msg(rs[2]![0]);
    expect(Object.keys(msg(scope[1]![0]))).toEqual(["1"]); // no version
    const [a, b] = scope[2]!.map((s) => msg(s));
    expect(hex(a![1]![0])).toBe(SPAN.traceId);
    expect(hex(a![2]![0])).toBe(SPAN.spanId);
    expect(str(a![3]![0])).toBe("k=v");
    expect(hex(a![4]![0])).toBe(SPAN.parentSpanId);
    expect(str(a![5]![0])).toBe("engine.op insert_row");
    expect(a![6]![0]).toBe(BigInt(2));
    expect(a![7]![0]).toBe(BigInt("1700000000123500000"));
    expect(a![8]![0]).toBe(BigInt("1700000000125000000"));
    expect(a![9]!.map(kv)).toEqual([["db.operation.name", "insert_row"], ["rows", BigInt(3)], ["ms", 1.5], ["ok", false]]);
    expect(a![10]![0]).toBe(BigInt(2));
    const ev = msg(a![11]![0]);
    expect([ev[1]![0], str(ev[2]![0]), ev[3]!.map(kv)]).toEqual([BigInt("1700000000124000000"), "exception", [["exception.type", "TypeError"]]]);
    expect(a![12]![0]).toBe(BigInt(1));
    const status = msg(a![15]![0]);
    expect([str(status[2]![0]), status[3]![0]]).toEqual(["boom", BigInt(2)]);
    expect(a![16]![0]).toBe(BigInt(1)); // flags: sampled
    expect([b![4], b![3], b![10], b![12]]).toEqual([undefined, undefined, undefined, undefined]);
    expect(Object.keys(msg(b![15]![0]))).toEqual([]); // status unset: empty
    expect(b![6]![0]).toBe(BigInt(1));
    // the scope carries the version when there is one
    const versioned = new OtlpTraceExporter({ endpoint: "http://c:4318", serviceName: "svc", serviceVersion: "3.1.0", flushMs: 0, send: async (_u, b) => void (body = b as Uint8Array) });
    versioned.export(SPAN);
    await versioned.flush();
    const scopeInfo = msg(msg(msg(decode(body!)[1]![0])[2]![0])[1]![0]);
    expect([str(scopeInfo[1]![0]), str(scopeInfo[2]![0])]).toEqual(["svc", "3.1.0"]);
  });

  it("keeps a bounded buffer, drops a batch it cannot encode, and counts what the collector refuses", async () => {
    const x = new OtlpTraceExporter({ endpoint: "http://c", serviceName: "s", maxBatch: 2, flushMs: 0, send: async () => {
      throw new Error("down");
    } });
    // a full batch is sent at once; past 8 batches waiting, spans are dropped
    x.export(Array.from({ length: 20 }, () => SPAN));
    await x.flush();
    expect(x.dropped).toBe(20);
    const y = new OtlpTraceExporter({ endpoint: "http://c", serviceName: "s", protocol: "http/json", flushMs: 0, maxBatch: 1000, send: async () => undefined });
    y.export(Array.from({ length: 8001 }, () => SPAN));
    expect(y.dropped).toBe(1);
    const z = new OtlpTraceExporter({ endpoint: "http://c", serviceName: "s", flushMs: 0, send: async () => undefined });
    z.export({ ...SPAN, attributes: { big: BigInt(1) as never } });
    await z.flush();
    expect([z.sent, z.dropped]).toEqual([0, 1]);
    expect(unixNano(1.0000004)).toBe("1000000");
  });

  it("reads the trace variables of OpenTelemetry", () => {
    expect(otlpTracesFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }, { serviceName: "a" })?.endpoint).toBe("http://c:4318");
    expect(otlpTracesFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://x/v1/traces/", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "k=v" }, { serviceName: "a" })).toMatchObject({ endpoint: "https://x", headers: { k: "v" } });
    expect(otlpTracesFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c", OTEL_TRACES_EXPORTER: "none" }, { serviceName: "a" })).toBeNull();
    expect(otlpTracesFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c", OTEL_LOGS_EXPORTER: "none" }, { serviceName: "a" })).not.toBeNull();
    expect(samplerRatioFromEnv({})).toBeUndefined();
    expect(samplerRatioFromEnv({ OTEL_TRACES_SAMPLER: "always_on" })).toBe(1);
    expect(samplerRatioFromEnv({ OTEL_TRACES_SAMPLER: "parentbased_always_off" })).toBe(0);
    expect(samplerRatioFromEnv({ OTEL_TRACES_SAMPLER: "traceidratio", OTEL_TRACES_SAMPLER_ARG: "0.1" })).toBe(0.1);
    expect(samplerRatioFromEnv({ OTEL_TRACES_SAMPLER: "traceidratio" })).toBe(1);
    expect(samplerRatioFromEnv({ OTEL_TRACES_SAMPLER: "traceidratio", OTEL_TRACES_SAMPLER_ARG: "7" })).toBe(1);
    expect(samplerRatioFromEnv({ OTEL_TRACES_SAMPLER: "jaeger_remote" })).toBeUndefined();
  });
});

describe("OTLP log records inside a span", () => {
  it("carry the trace and span ids (JSON: hex strings; protobuf: bytes 9 and 10, flags 8)", async () => {
    const bodies: (string | Uint8Array)[] = [];
    const ctx = { traceId: SPAN.traceId, spanId: SPAN.spanId, sampled: true };
    const json = new OtlpLogExporter({ endpoint: "http://c", serviceName: "s", protocol: "http/json", flushMs: 0, now: () => 5, send: async (_u, b) => void bodies.push(b) });
    json.log("INFO", "in a span", {}, ctx);
    json.log("INFO", "unsampled", {}, { ...ctx, sampled: false });
    await json.flush();
    const recs = JSON.parse(bodies[0] as string).resourceLogs[0].scopeLogs[0].logRecords;
    expect(recs[0]).toMatchObject({ traceId: SPAN.traceId, spanId: SPAN.spanId, flags: 1 });
    expect(recs[1].flags).toBe(0);
    const pb = new OtlpLogExporter({ endpoint: "http://c", serviceName: "s", flushMs: 0, now: () => 5, send: async (_u, b) => void bodies.push(b) });
    pb.log("WARN", "in a span", { a: 1 }, ctx);
    pb.log("WARN", "unsampled", {}, { ...ctx, sampled: false });
    await pb.flush();
    const recs2 = msg(msg(decode(bodies[1] as Uint8Array)[1]![0])[2]![0])[2]!.map((r) => msg(r));
    expect(recs2[1]![8]![0]).toBe(BigInt(0));
    const rec = recs2[0]!;
    expect(rec[8]![0]).toBe(BigInt(1));
    expect(hex(rec[9]![0])).toBe(SPAN.traceId);
    expect(hex(rec[10]![0])).toBe(SPAN.spanId);
  });
});

describe("the client continues a caller's trace", () => {
  const capture = () => {
    const sent: HttpRequest[] = [];
    return { sent, transport: async (r: HttpRequest) => (sent.push(r), { status: 200, text: '{"ok":true}' }) };
  };

  it("sends traceparent from its trace option (a header, a context or a function), the call's own first", async () => {
    const c = capture();
    let current: string | undefined = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const client = new DatanotesClient({ url: "http://e", token: "t", transport: c.transport, trace: () => current });
    await client.call("list_tables", {});
    expect(c.sent[0]!.headers.traceparent).toBe(current);
    await client.call("list_tables", {}, undefined, { trace: { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", sampled: false, traceState: "x=1" } });
    expect(c.sent[1]!.headers).toMatchObject({ traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00", tracestate: "x=1" });
    current = undefined;
    await client.call("list_tables", {});
    expect(c.sent[2]!.headers.traceparent).toBeUndefined();
    await new DatanotesClient({ url: "http://e", token: "t", transport: c.transport, trace: "not a traceparent" }).call("list_tables", {});
    expect(c.sent[3]!.headers.traceparent).toBeUndefined();
  });

  it("with a tracer, makes a CLIENT span per request and sends it as the parent", async () => {
    const c = capture();
    const out: SpanRecord[] = [];
    const tracer = new Tracer({ export: (s) => out.push(...s) });
    const parent = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
    const client = new DatanotesClient({ url: "https://engine.example.com", token: "t", transport: c.transport, tracer, trace: parent });
    await client.call("list_tables", {});
    expect(out[0]).toMatchObject({
      name: "POST /datanotes/operations/list_tables/",
      kind: "client",
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      attributes: { "http.request.method": "POST", "url.full": "https://engine.example.com/datanotes/operations/list_tables/", "server.address": "engine.example.com", "server.port": 443, "http.response.status_code": 200 },
    });
    expect(c.sent[0]!.headers.traceparent).toBe(`00-${parent.traceId}-${out[0]!.spanId}-01`);
    // an engine error, an engine unreachable, an address that is no URL
    const failing = new DatanotesClient({ url: "http://e:8080", token: "t", tracer, transport: async () => ({ status: 500, text: '{"error":"x"}' }) });
    await failing.call("list_tables", {});
    expect(out[1]).toMatchObject({ status: { code: "error" }, attributes: { "error.type": "500", "server.port": 8080 } });
    const down = new DatanotesClient({ url: "not a url", token: "t", tracer, transport: async () => {
      throw new Error("ECONNREFUSED");
    } });
    await expect(down.call("list_tables", {})).rejects.toThrow("engine unreachable");
    expect(out[2]).toMatchObject({ name: "POST", status: { code: "error", message: "ECONNREFUSED" } });
    const refused = new DatanotesClient({ url: "http://e", token: "t", tracer, transport: async () => ({ status: 422, text: '{"ok":false}' }) });
    await refused.call("list_tables", {});
    expect(out[3]!.status.code).toBe("unset");
    expect(out[3]!.attributes["error.type"]).toBe("422");
  });
});

describe("the MCP server's traces", () => {
  it("come from the environment, with the server's resource, and close with the process", async () => {
    expect(tracerFromEnv({}, "1")).toBeNull();
    const t = tracerFromEnv({ OTEL_TRACES_SAMPLER: "always_off", HOSTNAME: "box" }, "1", "http://127.0.0.1:1");
    expect(t).not.toBeNull();
    expect(t!.tracer.startSpan("x").recording).toBe(false);
    expect(tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" }, "1")!.tracer.startSpan("x").recording).toBe(true);
    expect(mcpResource({ COMPUTERNAME: "pc" })).toMatchObject({ "service.namespace": "datanotes", "host.name": "pc", "process.pid": process.pid });
    expect(String(mcpResource({})["service.instance.id"])).toMatch(/^mcp-[0-9a-f-]{36}$/);
    await closeExporter(t!.exporter, 10);
  });
});

// A minimal protobuf reader: field number -> values (varint / fixed64 / fixed32 as bigint, bytes).
type Fields = Record<number, (bigint | Uint8Array)[]>;
function decode(buf: Uint8Array): Fields {
  const out: Fields = {};
  let i = 0;
  const varint = () => {
    let r = BigInt(0);
    let shift = BigInt(0);
    for (;;) {
      const b = buf[i++]!;
      r |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return r;
      shift += BigInt(7);
    }
  };
  const fixed = (n: number) => {
    let r = BigInt(0);
    for (let k = n - 1; k >= 0; k--) r = (r << BigInt(8)) | BigInt(buf[i + k]!);
    i += n;
    return r;
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    const wire = tag & 7;
    let v: bigint | Uint8Array;
    if (wire === 0) v = varint();
    else if (wire === 1) v = fixed(8);
    else if (wire === 5) v = fixed(4);
    else {
      const n = Number(varint());
      v = buf.slice(i, i + n);
      i += n;
    }
    (out[field] ??= []).push(v);
  }
  return out;
}
const msg = (v: bigint | Uint8Array | undefined) => decode(v as Uint8Array);
const str = (v: bigint | Uint8Array | undefined) => new TextDecoder().decode(v as Uint8Array);
const hex = (v: bigint | Uint8Array | undefined) => Buffer.from(v as Uint8Array).toString("hex");
function kv(v: bigint | Uint8Array): [string, unknown] {
  const f = msg(v);
  const val = msg(f[2]![0]);
  if (val[1]) return [str(f[1]![0]), str(val[1][0])];
  if (val[2]) return [str(f[1]![0]), val[2][0] === BigInt(1)];
  if (val[3]) return [str(f[1]![0]), BigInt.asIntN(64, val[3][0] as bigint)];
  const bits = val[4]![0] as bigint;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, bits, true);
  return [str(f[1]![0]), dv.getFloat64(0, true)];
}
