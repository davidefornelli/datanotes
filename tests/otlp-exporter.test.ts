import { describe, expect, it } from "vitest";
import { OtlpLogExporter, otlpFromEnv, parseOtlpHeaders } from "../src/api/otlp";

describe("datanotes/client OTLP exporter", () => {
  it("batches records as OTLP JSON with the service and headers, and counts losses", async () => {
    const calls: { url: string; body: string | Uint8Array; headers: Record<string, string> }[] = [];
    let fail = false;
    const x = new OtlpLogExporter({
      endpoint: "http://collector:4318/",
      serviceName: "datanotes-mcp",
      serviceVersion: "1.2.3",
      protocol: "http/json",
      headers: { "api-key": "k" },
      flushMs: 0,
      maxBatch: 2,
      now: () => 7,
      send: async (url, body, headers) => {
        calls.push({ url, body, headers });
        if (fail) throw new Error("down");
      },
    });
    x.log("INFO", "tool call", { tool: "select_rows", ok: true, duration_ms: 12, score: 0.5, nothing: undefined });
    x.log("WARN", "slow");
    await x.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://collector:4318/v1/logs");
    expect(calls[0]!.headers).toEqual({ "Content-Type": "application/json", "api-key": "k" });
    const doc = JSON.parse(calls[0]!.body as string);
    const res = doc.resourceLogs[0].resource.attributes;
    expect(res).toEqual(expect.arrayContaining([{ key: "service.name", value: { stringValue: "datanotes-mcp" } }, { key: "service.version", value: { stringValue: "1.2.3" } }]));
    const rec = doc.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec).toMatchObject({ timeUnixNano: "7000000", severityText: "INFO", severityNumber: 9, body: { stringValue: "tool call" } });
    expect(rec.attributes).toEqual([
      { key: "tool", value: { stringValue: "select_rows" } },
      { key: "ok", value: { boolValue: true } },
      { key: "duration_ms", value: { intValue: "12" } },
      { key: "score", value: { doubleValue: 0.5 } },
    ]);
    expect(x.sent).toBe(2);
    fail = true;
    x.log("ERROR", "lost");
    await x.close();
    expect(x.dropped).toBe(1);
  });

  it("reads the standard OpenTelemetry variables", () => {
    expect(otlpFromEnv({}, { serviceName: "a" })).toBeNull();
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_HEADERS: "api-key=a%3Db,x=1", OTEL_SERVICE_NAME: "mine", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod" }, { serviceName: "a", serviceVersion: "1" })).toEqual({
      endpoint: "http://c:4318",
      serviceName: "mine",
      serviceVersion: "1",
      protocol: "http/json",
      resource: { "deployment.environment": "prod" },
      headers: { "api-key": "a=b", x: "1" },
    });
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" }, { serviceName: "a" })).toBeNull();
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_LOGS_EXPORTER: "none" }, { serviceName: "a" })).toBeNull();
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, { serviceName: "a" })?.protocol).toBeUndefined();
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://ingest.example.com/v1/logs" }, { serviceName: "a" })?.endpoint).toBe("https://ingest.example.com");
    expect(parseOtlpHeaders(" a = 1 ,=x, b")).toEqual({ a: "1" });
  });

  it("encodes http/protobuf (the default) as an OTLP ExportLogsServiceRequest", async () => {
    let got: { body: Uint8Array; headers: Record<string, string> } | null = null;
    const x = new OtlpLogExporter({ endpoint: "http://c:4318", serviceName: "svc", flushMs: 0, now: () => 1_700_000_000_123, send: async (_u, body, headers) => void (got = { body: body as Uint8Array, headers }) });
    x.log("WARN", "héllo", { s: "x", i: -3, d: 1.5, b: true, gone: null });
    await x.flush();
    expect(got!.headers["Content-Type"]).toBe("application/x-protobuf");
    const req = decode(got!.body);
    const rl = msg(req[1]![0]);
    const resAttrs = msg(rl[1]![0])[1]!.map(kv);
    expect(resAttrs).toEqual([["service.name", "svc"]]);
    const scope = msg(rl[2]![0]);
    expect(str(msg(scope[1]![0])[1]![0])).toBe("svc");
    const rec = msg(scope[2]![0]);
    expect(rec[1]![0]).toBe(BigInt("1700000000123000000"));
    expect(rec[2]![0]).toBe(BigInt(13));
    expect(str(rec[3]![0])).toBe("WARN");
    expect(str(msg(rec[5]![0])[1]![0])).toBe("héllo");
    expect(rec[6]!.map(kv)).toEqual([["s", "x"], ["i", BigInt(-3)], ["d", 1.5], ["b", true]]);
    expect(rec[11]![0]).toBe(BigInt("1700000000123000000"));
  });
});

// A minimal protobuf reader for the test: field number -> values (varint/fixed64 as bigint, bytes).
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
  while (i < buf.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    const wire = tag & 7;
    let v: bigint | Uint8Array;
    if (wire === 0) v = varint();
    else if (wire === 1) {
      let r = BigInt(0);
      for (let k = 7; k >= 0; k--) r = (r << BigInt(8)) | BigInt(buf[i + k]!);
      v = r;
      i += 8;
    } else if (wire === 2) {
      const n = Number(varint());
      v = buf.slice(i, i + n);
      i += n;
    } else throw new Error(`wire ${wire}`);
    (out[field] ??= []).push(v);
  }
  return out;
}
const msg = (v: bigint | Uint8Array | undefined) => decode(v as Uint8Array);
const str = (v: bigint | Uint8Array | undefined) => new TextDecoder().decode(v as Uint8Array);
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
