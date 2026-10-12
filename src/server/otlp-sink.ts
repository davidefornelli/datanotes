/**
 * The engine's logs to an OpenTelemetry collector, through the vendor-neutral exporter of
 * `src/api/otlp.ts`. Configuration: the settings (`telemetry*`), overridden by the standard
 * OpenTelemetry variables (`OTEL_EXPORTER_OTLP_*`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`;
 * `OTEL_SDK_DISABLED=true` turns it off). Read again on every record, so a settings change applies
 * without a restart.
 */

import { OtlpLogExporter, otlpFromEnv, otlpProtocol, parseResourceAttributes, type OtlpOptions } from "../api/otlp";
import type { AttrValue, Severity, Telemetry, TelemetrySettings } from "../core/telemetry";

type Env = Record<string, string | undefined>;

/** The exporter options for these settings and variables, or null when export is off. */
export function resolveOtlp(s: TelemetrySettings, env: Env, base: { serviceVersion: string; resource?: Record<string, AttrValue> }): OtlpOptions | null {
  const fromEnv = otlpFromEnv(env, { serviceName: s.telemetryServiceName, serviceVersion: base.serviceVersion });
  const disabled = (env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true" || (env.OTEL_LOGS_EXPORTER ?? "").trim().toLowerCase() === "none";
  if (disabled || (!fromEnv && !s.telemetryEnabled)) return null;
  const resource = { ...base.resource, ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES) };
  const envProtocol = otlpProtocol(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL);
  return {
    endpoint: fromEnv?.endpoint ?? s.telemetryEndpoint,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || s.telemetryServiceName,
    serviceVersion: base.serviceVersion,
    protocol: envProtocol ?? s.telemetryProtocol ?? "http/protobuf",
    headers: { ...(s.telemetryHeaders ?? {}), ...(fromEnv?.headers ?? {}) },
    resource,
  };
}

export class OtlpSink implements Telemetry {
  private exporter: OtlpLogExporter | null = null;
  private key = "";

  constructor(
    private readonly options: () => OtlpOptions | null,
    private readonly send?: OtlpOptions["send"],
  ) {}

  /** The exporter for the current options (a new one when they changed), or null. */
  private current(): OtlpLogExporter | null {
    const o = this.options();
    const key = o ? JSON.stringify(o) : "";
    if (key !== this.key) {
      const old = this.exporter;
      void old?.close();
      this.exporter = o ? new OtlpLogExporter({ ...o, flushMs: 0, ...(this.send ? { send: this.send } : {}) }) : null;
      this.key = key;
    }
    return this.exporter;
  }

  log(severity: Severity, body: string, attributes?: Record<string, AttrValue>): void {
    this.current()?.log(severity, body, attributes);
  }

  async flush(): Promise<void> {
    await this.current()?.flush();
  }

  get sent(): number {
    return this.exporter?.sent ?? 0;
  }

  get dropped(): number {
    return this.exporter?.dropped ?? 0;
  }
}
