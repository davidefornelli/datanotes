/**
 * Structured logs of the MCP server, exported with OpenTelemetry (OTLP/HTTP, to any collector or
 * backend) when the standard `OTEL_EXPORTER_OTLP_*` variables (or `--otlp-endpoint`) name an
 * endpoint; without one nothing is exported. The console output stays as it is: these records go
 * only to the collector. Never put a token or an argument value in a record.
 */

import { OtlpLogExporter, OtlpTraceExporter, otlpFromEnv, otlpTracesFromEnv, samplerRatioFromEnv, type AttrValue, type Severity } from "../api/otlp";
import { Tracer, type TraceContext } from "../api/tracing";

/** A log record; `context`: the span it belongs to (its trace and span ids go with it). */
export type Log = (severity: Severity, body: string, attributes?: Record<string, AttrValue>, context?: TraceContext) => void;

export const noLog: Log = () => undefined;

/**
 * `service.name` of the records unless OTEL_SERVICE_NAME says otherwise: the name the server had
 * as its own package, so dashboards and filters keep working.
 */
export const MCP_SERVICE_NAME = "datanotes-mcp";

/** The exporter configured by the environment (`endpoint` overrides its address), or null. */
export function exporterFromEnv(env: Record<string, string | undefined>, version: string, endpoint?: string): OtlpLogExporter | null {
  const vars = endpoint ? { ...env, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: undefined } : env;
  const o = otlpFromEnv(vars, { serviceName: MCP_SERVICE_NAME, serviceVersion: version });
  return o ? new OtlpLogExporter({ ...o, resource: { ...mcpResource(env), ...o.resource } }) : null;
}

/**
 * The tracer the environment configures (the same variables, `OTEL_TRACES_EXPORTER=none` turns it
 * off, `OTEL_TRACES_SAMPLER[_ARG]` samples), or null. Its spans: one SERVER span per tool call,
 * and a CLIENT span per request to the engine, which continues the trace.
 */
export function tracerFromEnv(env: Record<string, string | undefined>, version: string, endpoint?: string): { tracer: Tracer; exporter: OtlpTraceExporter } | null {
  const vars = endpoint ? { ...env, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined } : env;
  const o = otlpTracesFromEnv(vars, { serviceName: MCP_SERVICE_NAME, serviceVersion: version });
  if (!o) return null;
  const exporter = new OtlpTraceExporter({ ...o, resource: { ...mcpResource(env), ...o.resource } });
  const ratio = samplerRatioFromEnv(env);
  return { exporter, tracer: new Tracer({ export: (spans) => exporter.export(spans), ...(ratio !== undefined ? { sampleRatio: ratio } : {}) }) };
}

/** One id per MCP server process. */
const INSTANCE = (globalThis as { crypto: { randomUUID(): string } }).crypto.randomUUID();

/** The resource of the MCP server's logs and traces, besides its name and version. */
export function mcpResource(env: Record<string, string | undefined>): Record<string, AttrValue> {
  return { "service.namespace": "datanotes", "service.instance.id": `mcp-${INSTANCE}`, "process.pid": process.pid, ...(env.HOSTNAME || env.COMPUTERNAME ? { "host.name": env.HOSTNAME || env.COMPUTERNAME } : {}) };
}

/** Send what is left, waiting at most `ms` (an unreachable collector must not hold the exit). */
export function closeExporter(exporter: OtlpLogExporter | OtlpTraceExporter | null, ms = 3000): Promise<void> {
  if (!exporter) return Promise.resolve();
  return Promise.race([exporter.close(), new Promise<void>((r) => setTimeout(r, ms).unref())]);
}
