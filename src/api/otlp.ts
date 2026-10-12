/**
 * OpenTelemetry log export over OTLP/HTTP, vendor-neutral: records are buffered and POSTed to
 * `<endpoint>/v1/logs` as `http/protobuf` (the OTLP default) or `http/json`, which every
 * OpenTelemetry collector and OTLP backend reads. No dependency, no SDK. Export failures are
 * counted, never thrown: logging must not break the program. (OTLP over gRPC is not supported:
 * use the collector's HTTP port, 4318 by default.)
 *
 * Configure it in code, or from the standard OpenTelemetry variables with `otlpFromEnv`.
 */

export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type AttrValue = string | number | boolean | null | undefined;

const SEVERITY_NUMBER: Record<Severity, number> = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 };

export type OtlpProtocol = "http/protobuf" | "http/json";

export interface OtlpOptions {
  /** Collector base URL, e.g. `http://127.0.0.1:4318` (`/v1/logs` is added). */
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
  /** Send at most this many records per request (default 50); a full buffer is sent at once. */
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

// --- protobuf (opentelemetry/proto/collector/logs/v1 ExportLogsServiceRequest) ------------------

class Pb {
  private parts: number[] = [];
  private varint(v: bigint): void {
    let x = BigInt.asUintN(64, v);
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
    this.varint(BigInt((field << 3) | wire));
  }
  uint(field: number, v: number | bigint): this {
    this.tag(field, 0);
    this.varint(BigInt(v));
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
  bytes(field: number, data: Uint8Array): this {
    this.tag(field, 2);
    this.varint(BigInt(data.length));
    for (const x of data) this.parts.push(x);
    return this;
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

export class OtlpLogExporter {
  private buffer: LogRecord[] = [];
  private inflight: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Records sent, and records lost because the collector did not take them. */
  sent = 0;
  dropped = 0;

  constructor(private readonly o: OtlpOptions) {
    const every = o.flushMs ?? 5000;
    if (every > 0) {
      this.timer = setInterval(() => void this.flush(), every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  log(severity: Severity, body: string, attributes: Record<string, AttrValue> = {}): void {
    const ms = (this.o.now ?? Date.now)();
    this.buffer.push({ timeUnixNano: `${Math.round(ms)}000000`, severity, body, attributes });
    if (this.buffer.length >= (this.o.maxBatch ?? 50)) void this.flush();
  }

  /** Send what is buffered. Never rejects. */
  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.inflight;
    const batch = this.buffer;
    this.buffer = [];
    const resource = { "service.name": this.o.serviceName, "service.version": this.o.serviceVersion, ...this.o.resource };
    const protobuf = (this.o.protocol ?? "http/protobuf") === "http/protobuf";
    const body = protobuf ? this.protobuf(resource, batch) : JSON.stringify({
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
              })),
            },
          ],
        },
      ],
    });
    const url = `${this.o.endpoint.replace(/\/+$/, "")}/v1/logs`;
    const send = this.o.send ?? fetchSend;
    this.inflight = this.inflight.then(() =>
      send(url, body, { "Content-Type": protobuf ? "application/x-protobuf" : "application/json", ...(this.o.headers ?? {}) }).then(
        () => void (this.sent += batch.length),
        () => void (this.dropped += batch.length),
      ),
    );
    return this.inflight;
  }

  private protobuf(resource: Record<string, AttrValue>, batch: LogRecord[]): Uint8Array {
    const scope = new Pb().message(1, new Pb().string(1, this.o.serviceName));
    for (const r of batch) {
      const t = BigInt(r.timeUnixNano);
      const rec = new Pb().fixed64(1, t).uint(2, SEVERITY_NUMBER[r.severity]).string(3, r.severity).message(5, new Pb().string(1, r.body));
      pbAttrs(rec, 6, r.attributes).fixed64(11, t);
      scope.message(2, rec);
    }
    const resourceLogs = new Pb().message(1, pbAttrs(new Pb(), 1, resource)).message(2, scope);
    return new Pb().message(1, resourceLogs).finish();
  }

  /** Stop the timer and send what is left. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
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
  if (truthy(env.OTEL_SDK_DISABLED) || (env.OTEL_LOGS_EXPORTER ?? "").trim().toLowerCase() === "none") return null;
  const logs = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const endpoint = logs ? logs.replace(/\/v1\/logs\/?$/, "") : base;
  if (!endpoint) return null;
  const protocol = otlpProtocol(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL);
  const resource = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  return {
    endpoint,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || resource["service.name"] || defaults.serviceName,
    ...(defaults.serviceVersion ? { serviceVersion: defaults.serviceVersion } : {}),
    ...(protocol ? { protocol } : {}),
    ...(Object.keys(resource).length ? { resource } : {}),
    headers: { ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS) },
  };
}

/** `http/protobuf` or `http/json` from a setting or variable; undefined for anything else. */
export function otlpProtocol(v: string | undefined): OtlpProtocol | undefined {
  const p = (v ?? "").trim().toLowerCase();
  return p === "http/protobuf" || p === "http/json" ? p : undefined;
}
