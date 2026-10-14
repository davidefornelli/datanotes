/**
 * The engine's log records: one global sink (`telemetry()`), fed by every operation and request.
 * Sinks: the log files (`FileLogger`), and an OpenTelemetry collector (`server/otlp-sink.ts`).
 * Telemetry must never break a vault operation: sinks never throw. A record made inside a span
 * (tracing.ts) names it: `trace_id` and `span_id` in the files, the OTLP record's own fields.
 */

import { messageOf } from "./message";
import { activeSpanContext, rootOrChild, type Span } from "./tracing";

export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";


export type AttrValue = string | number | boolean | null | undefined;


export interface TelemetrySettings {
  telemetryEnabled: boolean;
  telemetryEndpoint: string;
  telemetryServiceName: string;
  telemetryHeaders?: Record<string, string>;
  telemetryProtocol?: "http/protobuf" | "http/json";
  /** Send traces too (default true). */
  telemetryTraces?: boolean;
  /** Share of new traces kept, 0 to 1 (default 1). */
  telemetryTraceSampleRatio?: number;
  /** Most spans one trace may hold (default 1000). */
  telemetryMaxSpansPerTrace?: number;
  /** Operations and requests lasting at least this many ms are logged as WARN (0: never; default 0). */
  telemetrySlowSpanMs?: number;
  /** `deployment.environment.name` of the logs and traces (empty: none). */
  telemetryEnvironment?: string;
}

export interface Telemetry {
  log(severity: Severity, body: string, attributes?: Record<string, AttrValue>): void;
  flush(): Promise<void>;
}

export const NOOP_TELEMETRY: Telemetry = {
  log: () => {},
  flush: async () => {},
};

let current: Telemetry = NOOP_TELEMETRY;

export function setTelemetry(t: Telemetry): void {
  current = t;
}

export function telemetry(): Telemetry {
  return current;
}

/** A log attribute as a span attribute: plain names get the `datanotes.` namespace. */
function spanAttributes(span: Span, attributes: Record<string, AttrValue>): void {
  for (const k in attributes) span.setAttribute(k.includes(".") ? k : `datanotes.${k}`, attributes[k]);
}

/**
 * Run `fn` in a span named after `event` (`datanotes insert_row` → `engine.insert_row`, and
 * `datanotes select` → `engine.query.execute`: a child of the
 * active span, or a trace of its own for work no request started), then log one record with its
 * duration and the attributes returned by `summarize`. The span gets the same attributes;
 * `error.type` when the result says `ok: false` (`refused`) or the write failed (`failed`, with
 * status ERROR). While the span is exported, an INFO record is logged as DEBUG: the span says it
 * all. Thrown errors are logged at ERROR and rethrown.
 */
export function traced<T>(
  event: string,
  attributes: Record<string, AttrValue>,
  fn: () => Promise<T>,
  summarize: (result: T) => { severity?: Severity; attributes?: Record<string, AttrValue> } = () => ({}),
  now: () => number = Date.now,
): Promise<T> {
  return rootOrChild(event === "datanotes select" ? "engine.query.execute" : event.replace(/^datanotes /, "engine."), async (span) => {
    spanAttributes(span, attributes);
    const start = now();
    try {
      const result = await fn();
      const s = summarize(result);
      const summary = s.attributes ?? {};
      spanAttributes(span, summary);
      // a failed write is an error; a refused one (violations, conflicts) is the caller's to fix
      if (s.severity === "ERROR") span.setStatus("error", "failed").setAttribute("error.type", "failed");
      else if (summary.ok === false) span.setAttribute("error.type", "refused");
      // the span carries what the INFO record said: the record stays, as DEBUG
      telemetry().log(s.severity === undefined || s.severity === "INFO" ? (span.recording ? "DEBUG" : "INFO") : s.severity, event, {
        ...attributes,
        ...summary,
        duration_ms: now() - start,
      });
      return result;
    } catch (e) {
      telemetry().log("ERROR", event, {
        ...attributes,
        duration_ms: now() - start,
        "error.type": e instanceof Error ? e.name : "Error",
        "error.message": messageOf(e),
      });
      throw e;
    }
  });
}

export interface FileLoggerOptions {
  enabled: () => boolean;
  /** Append JSON Lines to the file of `day` (`YYYY-MM-DD`). */
  write: (day: string, lines: string) => Promise<void>;
  now?: () => number;
}

/** Log records as JSON Lines, one file per day (`{"time","level","msg",...attributes}`). Never throws. */
export class FileLogger implements Telemetry {
  private buffer: { day: string; line: string }[] = [];
  private inflight: Promise<void> = Promise.resolve();
  dropped = 0;

  constructor(private readonly opts: FileLoggerOptions) {}

  log(severity: Severity, body: string, attributes: Record<string, AttrValue> = {}): void {
    if (!this.opts.enabled()) return;
    const d = new Date((this.opts.now ?? Date.now)());
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const attrs = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined));
    const ctx = activeSpanContext();
    const trace = ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
    this.buffer.push({ day, line: JSON.stringify({ time: d.toISOString(), level: severity, msg: body, ...trace, ...attrs }) });
  }

  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.inflight;
    const batch = this.buffer;
    this.buffer = [];
    const byDay = new Map<string, string[]>();
    for (const r of batch) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r.line]);
    this.inflight = this.inflight.then(async () => {
      for (const [day, lines] of byDay) {
        try {
          await this.opts.write(day, `${lines.join("\n")}\n`);
        } catch {
          this.dropped += lines.length;
        }
      }
    });
    return this.inflight;
  }
}

/** Send every record to several sinks (e.g. the OTLP collector and the log files). */
export class TeeTelemetry implements Telemetry {
  constructor(private readonly sinks: Telemetry[]) {}

  log(severity: Severity, body: string, attributes?: Record<string, AttrValue>): void {
    for (const s of this.sinks) s.log(severity, body, attributes);
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush()));
  }
}
