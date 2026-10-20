/**
 * OpenTelemetry export over OTLP/HTTP, vendor-neutral: log records (`OtlpLogExporter`, to
 * `<endpoint>/v1/logs`) and spans (`OtlpTraceExporter`, to `<endpoint>/v1/traces`) are buffered
 * and POSTed as `http/protobuf` (the OTLP default) or `http/json`, which every OpenTelemetry
 * collector and OTLP backend reads. No dependency, no SDK. Export failures are counted, never
 * thrown: telemetry must not break the program. (OTLP over gRPC is not supported: use the
 * collector's HTTP port, 4318 by default.)
 *
 * A log record made inside a span names it (`log`'s `context`), so the backend links the two.
 * Configure the exporters in code, or from the standard OpenTelemetry variables with
 * `otlpFromEnv` and `otlpTracesFromEnv`.
 */

import { trimTrailingSlashes } from "./client.js";
import type { SpanKind, SpanRecord, SpanStatusCode, TraceContext } from "./tracing.js";

export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type AttrValue = string | number | boolean | null | undefined;

const SEVERITY_NUMBER: Record<Severity, number> = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 };
const SPAN_KIND: Record<SpanKind, number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
const STATUS_CODE: Record<SpanStatusCode, number> = { unset: 0, ok: 1, error: 2 };

export type OtlpProtocol = "http/protobuf" | "http/json";

export interface OtlpOptions {
  /** Collector base URL, e.g. `http://127.0.0.1:4318` (`/v1/logs` or `/v1/traces` is added). */
  endpoint: string;
  /** `service.name` of the records. */
  serviceName: string;
  serviceVersion?: string;
  /** `http/protobuf` (default) or `http/json`. */
  protocol?: OtlpProtocol;
  /** Extra headers, e.g. an API key or `Authorization`, as the backend asks. */
  headers?: Record<string, string>;
  /** More resource attributes (e.g. `host.name`). */
  resource?: Record<string, AttrValue>;
  /** Send at most this many records (or spans) per request (default 50 records, 512 spans); a full buffer is sent at once. */
  maxBatch?: number;
  /** Send the buffer every this many ms (default 5000; 0: only on `flush`). */
  flushMs?: number;
  /** POST a body; resolves on 2xx (default: fetch). `headers` include the Content-Type. */
  send?: (url: string, body: string | Uint8Array, headers: Record<string, string>) => Promise<void>;
  now?: () => number;
}

interface LogRecord {
  timeUnixNano: string;
  severity: Severity;
  body: string;
  attributes: Record<string, AttrValue>;
  context?: Pick<TraceContext, "traceId" | "spanId" | "sampled">;
}

function attr(key: string, v: AttrValue): Record<string, unknown> | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return { key, value: { boolValue: v } };
  if (typeof v === "number") return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  return { key, value: { stringValue: v } };
}

const attrs = (a: Record<string, AttrValue>) => Object.entries(a).map(([k, v]) => attr(k, v)).filter((x) => x !== null);

const fetchSend = async (url: string, body: string | Uint8Array, headers: Record<string, string>): Promise<void> => {
  const res = await fetch(url, { method: "POST", headers, body: body as BodyInit });
  if (!res.ok) throw new Error(`OTLP HTTP ${res.status}`);
};

/** Unix ms (with a fraction) as OTLP nanoseconds, a decimal string. */
export function unixNano(ms: number): string {
  const whole = Math.floor(ms);
  const frac = Math.round((ms - whole) * 1e6);
  return (BigInt(whole) * BigInt(1000000) + BigInt(frac)).toString();
}

// --- protobuf (opentelemetry/proto/collector/{logs,trace}/v1) -------------------------------------

class Pb {
  private parts: number[] = [];
  private varint(v: bigint | number): void {
    if (typeof v === "number" && v >= 0 && v < 2 ** 31) {
      let x = v;
      while (x >= 0x80) {
        this.parts.push((x & 0x7f) | 0x80);
        x >>>= 7;
      }
      this.parts.push(x);
      return;
    }
    let x = BigInt.asUintN(64, BigInt(v));
    const b128 = BigInt(0x80);
    const low7 = BigInt(0x7f);
    const seven = BigInt(7);
    while (x >= b128) {
      this.parts.push(Number(x & low7) | 0x80);
      x >>= seven;
    }
    this.parts.push(Number(x));
  }
  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }
  uint(field: number, v: number | bigint): this {
    this.tag(field, 0);
    this.varint(v);
    return this;
  }
  fixed32(field: number, v: number): this {
    this.tag(field, 5);
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff);
    return this;
  }
  fixed64(field: number, v: bigint): this {
    this.tag(field, 1);
    for (let i = 0; i < 8; i++) this.parts.push(Number((v >> BigInt(8 * i)) & BigInt(0xff)));
    return this;
  }
  double(field: number, v: number): this {
    this.tag(field, 1);
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.parts.push(b.getUint8(i));
    return this;
  }
  bytes(field: number, data: Uint8Array | number[]): this {
    this.tag(field, 2);
    this.varint(data.length);
    for (const x of data) this.parts.push(x);
    return this;
  }
  /** An id given in hex (trace and span ids), as bytes. */
  hex(field: number, hex: string): this {
    const out: number[] = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return this.bytes(field, out);
  }
  string(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s));
  }
  message(field: number, m: Pb): this {
    return this.bytes(field, m.finish());
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function pbValue(v: Exclude<AttrValue, null | undefined>): Pb {
  if (typeof v === "string") return new Pb().string(1, v);
  if (typeof v === "boolean") return new Pb().uint(2, v ? 1 : 0);
  return Number.isInteger(v) ? new Pb().uint(3, BigInt(v)) : new Pb().double(4, v);
}

function pbAttrs(m: Pb, field: number, a: Record<string, AttrValue>): Pb {
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null) continue;
    m.message(field, new Pb().string(1, k).message(2, pbValue(v)));
  }
  return m;
}

/** What both exporters share: the buffer, the timer, the POST, the counts. */
abstract class OtlpBatcher<T> {
  protected buffer: T[] = [];
  private inflight: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Items sent, and items lost because the collector did not take them (or the buffer was full). */
  sent = 0;
  dropped = 0;

  constructor(
    protected readonly o: OtlpOptions,
    private readonly path: string,
    private readonly maxBatch: number,
  ) {
    const every = o.flushMs ?? 5000;
    if (every > 0) {
      this.timer = setInterval(() => void this.flush(), every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  protected push(items: readonly T[]): void {
    // a collector that never answers must not make the buffer grow without end
    const room = this.maxBatch * 8 - this.buffer.length;
    if (room < items.length) this.dropped += items.length - Math.max(room, 0);
    for (let i = 0; i < Math.min(items.length, Math.max(room, 0)); i++) this.buffer.push(items[i]!);
    if (this.buffer.length >= this.maxBatch) void this.flush();
  }

  protected resource(): Record<string, AttrValue> {
    return { "service.name": this.o.serviceName, "service.version": this.o.serviceVersion, ...this.o.resource };
  }

  protected abstract encode(batch: T[], protobuf: boolean): string | Uint8Array;

  /** Send what is buffered. Never rejects. */
  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.inflight;
    const send = this.o.send ?? fetchSend;
    const url = `${trimTrailingSlashes(this.o.endpoint)}${this.path}`;
    const protobuf = (this.o.protocol ?? "http/protobuf") === "http/protobuf";
    const headers = { "Content-Type": protobuf ? "application/x-protobuf" : "application/json", ...(this.o.headers ?? {}) };
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.maxBatch);
      let body: string | Uint8Array;
      try {
        body = this.encode(batch, protobuf);
      } catch {
        this.dropped += batch.length;
        continue;
      }
      this.inflight = this.inflight.then(() =>
        send(url, body, headers).then(
          () => void (this.sent += batch.length),
          () => void (this.dropped += batch.length),
        ),
      );
    }
    return this.inflight;
  }

  /** Stop the timer and send what is left. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

export class OtlpLogExporter extends OtlpBatcher<LogRecord> {
  constructor(o: OtlpOptions) {
    super(o, "/v1/logs", o.maxBatch ?? 50);
  }

  /** Buffer a record; `context`: the span it was made in (its trace and span id go with it). */
  log(severity: Severity, body: string, attributes: Record<string, AttrValue> = {}, context?: Pick<TraceContext, "traceId" | "spanId" | "sampled">): void {
    const ms = (this.o.now ?? Date.now)();
    this.push([{ timeUnixNano: `${Math.round(ms)}000000`, severity, body, attributes, ...(context ? { context } : {}) }]);
  }

  protected encode(batch: LogRecord[], protobuf: boolean): string | Uint8Array {
    const resource = this.resource();
    if (protobuf) return this.protobuf(resource, batch);
    return JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: attrs(resource) },
          scopeLogs: [
            {
              scope: { name: this.o.serviceName },
              logRecords: batch.map((r) => ({
                timeUnixNano: r.timeUnixNano,
                observedTimeUnixNano: r.timeUnixNano,
                severityNumber: SEVERITY_NUMBER[r.severity],
                severityText: r.severity,
                body: { stringValue: r.body },
                attributes: attrs(r.attributes),
                ...(r.context ? { traceId: r.context.traceId, spanId: r.context.spanId, flags: r.context.sampled ? 1 : 0 } : {}),
              })),
            },
          ],
        },
      ],
    });
  }

  private protobuf(resource: Record<string, AttrValue>, batch: LogRecord[]): Uint8Array {
    const scope = new Pb().message(1, new Pb().string(1, this.o.serviceName));
    for (const r of batch) {
      const t = BigInt(r.timeUnixNano);
      const rec = new Pb().fixed64(1, t).uint(2, SEVERITY_NUMBER[r.severity]).string(3, r.severity).message(5, new Pb().string(1, r.body));
      pbAttrs(rec, 6, r.attributes);
      if (r.context) rec.fixed32(8, r.context.sampled ? 1 : 0).hex(9, r.context.traceId).hex(10, r.context.spanId);
      rec.fixed64(11, t);
      scope.message(2, rec);
    }
    const resourceLogs = new Pb().message(1, pbAttrs(new Pb(), 1, resource)).message(2, scope);
    return new Pb().message(1, resourceLogs).finish();
  }
}

/** Spans to `<endpoint>/v1/traces` (ExportTraceServiceRequest), in batches. */
export class OtlpTraceExporter extends OtlpBatcher<SpanRecord> {
  constructor(o: OtlpOptions) {
    super(o, "/v1/traces", o.maxBatch ?? 512);
  }

  /** Buffer finished spans (sent with the next batch). Never throws. */
  export(spans: SpanRecord | readonly SpanRecord[]): void {
    this.push(Array.isArray(spans) ? spans : [spans as SpanRecord]);
  }

  protected encode(batch: SpanRecord[], protobuf: boolean): string | Uint8Array {
    const resource = this.resource();
    if (protobuf) return this.protobuf(resource, batch);
    return JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: attrs(resource) },
          scopeSpans: [
            {
              scope: { name: this.o.serviceName, ...(this.o.serviceVersion ? { version: this.o.serviceVersion } : {}) },
              spans: batch.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                ...(s.traceState ? { traceState: s.traceState } : {}),
                flags: 1,
                name: s.name,
                kind: SPAN_KIND[s.kind],
                startTimeUnixNano: unixNano(s.startMs),
                endTimeUnixNano: unixNano(s.endMs),
                attributes: attrs(s.attributes),
                ...(s.droppedAttributes ? { droppedAttributesCount: s.droppedAttributes } : {}),
                events: s.events.map((e) => ({ timeUnixNano: unixNano(e.timeMs), name: e.name, attributes: attrs(e.attributes) })),
                ...(s.droppedEvents ? { droppedEventsCount: s.droppedEvents } : {}),
                status: { code: STATUS_CODE[s.status.code], ...(s.status.message ? { message: s.status.message } : {}) },
              })),
            },
          ],
        },
      ],
    });
  }

  private protobuf(resource: Record<string, AttrValue>, batch: SpanRecord[]): Uint8Array {
    const scopeInfo = new Pb().string(1, this.o.serviceName);
    if (this.o.serviceVersion) scopeInfo.string(2, this.o.serviceVersion);
    const scope = new Pb().message(1, scopeInfo);
    for (const s of batch) {
      const span = new Pb().hex(1, s.traceId).hex(2, s.spanId);
      if (s.traceState) span.string(3, s.traceState);
      if (s.parentSpanId) span.hex(4, s.parentSpanId);
      span.string(5, s.name).uint(6, SPAN_KIND[s.kind]).fixed64(7, BigInt(unixNano(s.startMs))).fixed64(8, BigInt(unixNano(s.endMs)));
      pbAttrs(span, 9, s.attributes);
      if (s.droppedAttributes) span.uint(10, s.droppedAttributes);
      for (const e of s.events) span.message(11, pbAttrs(new Pb().fixed64(1, BigInt(unixNano(e.timeMs))).string(2, e.name), 3, e.attributes));
      if (s.droppedEvents) span.uint(12, s.droppedEvents);
      const status = new Pb();
      if (s.status.message) status.string(2, s.status.message);
      if (s.status.code !== "unset") status.uint(3, STATUS_CODE[s.status.code]);
      span.message(15, status).fixed32(16, 1);
      scope.message(2, span);
    }
    const resourceSpans = new Pb().message(1, pbAttrs(new Pb(), 1, resource)).message(2, scope);
    return new Pb().message(1, resourceSpans).finish();
  }
}

/** `k1=v1,k2=v2` (values URL-encoded), the format of `OTEL_EXPORTER_OTLP_HEADERS`. */
export function parseOtlpHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** `k1=v1,k2=v2` resource attributes, the format of `OTEL_RESOURCE_ATTRIBUTES`. */
export const parseResourceAttributes = parseOtlpHeaders;

const truthy = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";

/**
 * Exporter options from the standard OpenTelemetry variables, or null when export is off (no
 * endpoint, `OTEL_SDK_DISABLED=true` or `OTEL_LOGS_EXPORTER=none`):
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (full URL of /v1/logs) or `OTEL_EXPORTER_OTLP_ENDPOINT`;
 * `OTEL_EXPORTER_OTLP_[LOGS_]HEADERS`; `OTEL_EXPORTER_OTLP_[LOGS_]PROTOCOL` (`http/protobuf`,
 * `http/json`); `OTEL_SERVICE_NAME`; `OTEL_RESOURCE_ATTRIBUTES`.
 */
export function otlpFromEnv(env: Record<string, string | undefined>, defaults: { serviceName: string; serviceVersion?: string }): OtlpOptions | null {
  return fromEnv(env, defaults, "LOGS", "logs");
}

/**
 * The same for traces: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (full URL of /v1/traces) or
 * `OTEL_EXPORTER_OTLP_ENDPOINT`; the `…_TRACES_…` headers and protocol; null also when
 * `OTEL_TRACES_EXPORTER=none`.
 */
export function otlpTracesFromEnv(env: Record<string, string | undefined>, defaults: { serviceName: string; serviceVersion?: string }): OtlpOptions | null {
  return fromEnv(env, defaults, "TRACES", "traces");
}

function fromEnv(env: Record<string, string | undefined>, defaults: { serviceName: string; serviceVersion?: string }, signal: "LOGS" | "TRACES", path: string): OtlpOptions | null {
  if (truthy(env.OTEL_SDK_DISABLED) || (env[`OTEL_${signal}_EXPORTER`] ?? "").trim().toLowerCase() === "none") return null;
  const own = env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const endpoint = own ? own.replace(new RegExp(`/v1/${path}/?$`), "") : base;
  if (!endpoint) return null;
  const protocol = otlpProtocol(env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL);
  const resource = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  return {
    endpoint,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || resource["service.name"] || defaults.serviceName,
    ...(defaults.serviceVersion ? { serviceVersion: defaults.serviceVersion } : {}),
    ...(protocol ? { protocol } : {}),
    ...(Object.keys(resource).length ? { resource } : {}),
    headers: { ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseOtlpHeaders(env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`]) },
  };
}

/**
 * The share of new traces to keep, from `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`
 * (`always_on`, `always_off`, `traceidratio`, and their `parentbased_` forms: a trace continued
 * from a caller always follows the caller); undefined when they say nothing usable.
 */
export function samplerRatioFromEnv(env: Record<string, string | undefined>): number | undefined {
  const sampler = (env.OTEL_TRACES_SAMPLER ?? "").trim().toLowerCase().replace(/^parentbased_/, "");
  if (sampler === "always_on") return 1;
  if (sampler === "always_off") return 0;
  if (sampler !== "traceidratio") return undefined;
  const arg = Number((env.OTEL_TRACES_SAMPLER_ARG ?? "").trim() || "1");
  return Number.isFinite(arg) && arg >= 0 && arg <= 1 ? arg : 1;
}

/** `http/protobuf` or `http/json` from a setting or variable; undefined for anything else. */
export function otlpProtocol(v: string | undefined): OtlpProtocol | undefined {
  const p = (v ?? "").trim().toLowerCase();
  return p === "http/protobuf" || p === "http/json" ? p : undefined;
}
