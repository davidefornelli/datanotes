/**
 * The engine's traces, installed by the runtime: the context store (AsyncLocalStorage keeps the
 * active span across `await`), and the tracer of src/core/tracing.ts wired to an OTLP trace
 * exporter (src/api/otlp.ts) that follows the settings.
 *
 * Configuration: the settings (`telemetryEnabled`, `telemetryTraces`, `telemetryTraceSampleRatio`,
 * `telemetryMaxSpansPerTrace`, `telemetrySlowSpanMs`), overridden by the standard OpenTelemetry
 * variables (`OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_EXPORTER=none`, `OTEL_TRACES_SAMPLER[_ARG]`).
 * The options are read again at most once a second, so a settings change applies without a
 * restart.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import { OtlpTraceExporter, otlpTracesFromEnv, otlpProtocol, parseResourceAttributes, samplerRatioFromEnv, type OtlpOptions } from "../api/otlp";
import type { AttrValue, TelemetrySettings } from "../core/telemetry";
import { telemetry } from "../core/telemetry";
import { configureTracer, setContextStore, type ContextStore, type Span, type SpanData } from "../core/tracing";

type Env = Record<string, string | undefined>;

/** The active span, kept by AsyncLocalStorage. */
export class AsyncContextStore implements ContextStore {
  private readonly als = new AsyncLocalStorage<Span>();
  run<R>(span: Span, fn: () => R): R {
    return this.als.run(span, fn);
  }
  active(): Span | undefined {
    return this.als.getStore();
  }
}

let host: string | undefined;

/**
 * The machine's name, asked of the system once per process: asking costs a system call (about
 * 50 us on Windows), and the resource is built for every log record.
 */
export function hostName(): string {
  return (host ??= os.hostname());
}

/** One id per engine process: `service.instance.id` tells two engines (or two runs) apart. */
export const INSTANCE_ID: string = (globalThis as { crypto: { randomUUID(): string } }).crypto.randomUUID();

/**
 * The resource of the engine's logs and traces: `service.namespace`, the environment (both the
 * current key and `deployment.environment`, which older backends group by), the host, the process
 * and its instance id.
 */
export function engineResource(s: Pick<TelemetrySettings, "telemetryEnvironment">, source: string, pid: number = process.pid, host: string = hostName()): Record<string, AttrValue> {
  const env = s.telemetryEnvironment?.trim();
  return {
    "service.namespace": "datanotes",
    "service.instance.id": `${source}-${INSTANCE_ID}`,
    "host.name": host,
    "process.pid": pid,
    ...(env ? { "deployment.environment.name": env, "deployment.environment": env } : {}),
  };
}

export interface TraceConfig {
  otlp: OtlpOptions;
  sampleRatio: number;
  maxSpansPerTrace: number;
  slowSpanMs: number;
}

/** The trace export for these settings and variables, or null when traces are off. */
export function resolveTraces(s: TelemetrySettings, env: Env, base: { serviceVersion: string; resource?: Record<string, AttrValue> }): TraceConfig | null {
  const fromEnv = otlpTracesFromEnv(env, { serviceName: s.telemetryServiceName, serviceVersion: base.serviceVersion });
  const off = (env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true" || (env.OTEL_TRACES_EXPORTER ?? "").trim().toLowerCase() === "none";
  if (off || (!fromEnv && !(s.telemetryEnabled && s.telemetryTraces !== false))) return null;
  const protocol = otlpProtocol(env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL);
  return {
    otlp: {
      endpoint: fromEnv?.endpoint ?? s.telemetryEndpoint,
      serviceName: env.OTEL_SERVICE_NAME?.trim() || s.telemetryServiceName,
      serviceVersion: base.serviceVersion,
      protocol: protocol ?? s.telemetryProtocol ?? "http/protobuf",
      headers: { ...(s.telemetryHeaders ?? {}), ...(fromEnv?.headers ?? {}) },
      resource: { ...base.resource, ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES) },
    },
    sampleRatio: samplerRatioFromEnv(env) ?? s.telemetryTraceSampleRatio ?? 1,
    maxSpansPerTrace: s.telemetryMaxSpansPerTrace ?? 1000,
    slowSpanMs: s.telemetrySlowSpanMs ?? 0,
  };
}

/** Spans to the collector the configuration names; a new exporter when it changes. */
export class TraceSink {
  private exporter: OtlpTraceExporter | null = null;
  private key = "";
  private config: TraceConfig | null = null;
  private readAt = -Infinity;

  constructor(
    private readonly resolve: () => TraceConfig | null,
    private readonly send?: OtlpOptions["send"],
    private readonly now: () => number = Date.now,
  ) {}

  /** The configuration now (read again at most once a second). */
  current(): TraceConfig | null {
    const t = this.now();
    if (t - this.readAt < 1000) return this.config;
    this.readAt = t;
    const c = this.resolve();
    const key = c ? JSON.stringify(c.otlp) : "";
    if (key !== this.key) {
      void this.exporter?.close();
      this.exporter = c ? new OtlpTraceExporter({ ...c.otlp, flushMs: 0, ...(this.send ? { send: this.send } : {}) }) : null;
      this.key = key;
    }
    this.config = c;
    return c;
  }

  export(spans: SpanData[]): void {
    this.current();
    this.exporter?.export(spans);
  }

  async flush(): Promise<void> {
    this.current();
    await this.exporter?.flush();
  }

  async close(): Promise<void> {
    await this.exporter?.close();
  }

  get sent(): number {
    return this.exporter?.sent ?? 0;
  }

  get dropped(): number {
    return this.exporter?.dropped ?? 0;
  }
}

/** Install the context store and the tracer; `null` takes them away (the engine stops). */
export function installTracing(sink: TraceSink | null): void {
  if (!sink) {
    configureTracer(null);
    setContextStore(null);
    return;
  }
  setContextStore(new AsyncContextStore());
  configureTracer({
    export: (spans) => sink.export(spans),
    enabled: () => sink.current() !== null,
    // read right after enabled() said yes; were the settings to change in between, the tracer
    // catches the throw and starts no trace
    sampleRatio: () => sink.current()!.sampleRatio,
    maxSpansPerTrace: () => sink.current()!.maxSpansPerTrace,
    // read when a span ends: traces may have been turned off since it started
    slowSpanMs: () => sink.current()?.slowSpanMs ?? 0,
    onSlow: (span) =>
      telemetry().log("WARN", "datanotes slow span", {
        span: span.name,
        duration_ms: Math.round(span.endMs - span.startMs),
        "db.operation.name": span.attributes["db.operation.name"],
        "http.route": span.attributes["http.route"],
      }),
  });
}
