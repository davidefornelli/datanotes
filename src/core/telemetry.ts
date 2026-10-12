/**
 * The engine's log records: one global sink (`telemetry()`), fed by every operation and request.
 * Sinks: the log files (`FileLogger`), and an OpenTelemetry collector (`server/otlp-sink.ts`).
 * Telemetry must never break a vault operation: sinks never throw.
 */

import { messageOf } from "./message";

export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";


export type AttrValue = string | number | boolean | null | undefined;


export interface TelemetrySettings {
  telemetryEnabled: boolean;
  telemetryEndpoint: string;
  telemetryServiceName: string;
  telemetryHeaders?: Record<string, string>;
  telemetryProtocol?: "http/protobuf" | "http/json";
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

/**
 * Run `fn`, then log one record with its duration and the attributes returned by `summarize`.
 * Thrown errors are logged at ERROR and rethrown.
 */
export async function traced<T>(
  event: string,
  attributes: Record<string, AttrValue>,
  fn: () => Promise<T>,
  summarize: (result: T) => { severity?: Severity; attributes?: Record<string, AttrValue> } = () => ({}),
  now: () => number = Date.now,
): Promise<T> {
  const start = now();
  try {
    const result = await fn();
    const s = summarize(result);
    telemetry().log(s.severity ?? "INFO", event, {
      ...attributes,
      ...(s.attributes ?? {}),
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
    this.buffer.push({ day, line: JSON.stringify({ time: d.toISOString(), level: severity, msg: body, ...attrs }) });
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
