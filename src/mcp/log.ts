/**
 * Structured logs of the MCP server, exported with OpenTelemetry (OTLP/HTTP, to any collector or
 * backend) when the standard `OTEL_EXPORTER_OTLP_*` variables (or `--otlp-endpoint`) name an
 * endpoint; without one nothing is exported. The console output stays as it is: these records go
 * only to the collector. Never put a token or an argument value in a record.
 */

import { OtlpLogExporter, otlpFromEnv, type AttrValue, type Severity } from "../api/otlp";

export type Log = (severity: Severity, body: string, attributes?: Record<string, AttrValue>) => void;

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
  return o ? new OtlpLogExporter(o) : null;
}

/** Send what is left, waiting at most `ms` (an unreachable collector must not hold the exit). */
export function closeExporter(exporter: OtlpLogExporter | null, ms = 3000): Promise<void> {
  if (!exporter) return Promise.resolve();
  return Promise.race([exporter.close(), new Promise<void>((r) => setTimeout(r, ms).unref())]);
}
