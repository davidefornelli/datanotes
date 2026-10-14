/**
 * W3C Trace Context and a small tracer, with no dependency, for programs that call the engine:
 * the MCP server (`datanotes mcp`), apps, scripts. A program continues its own trace in the
 * engine by sending `traceparent` (and `tracestate`) with its requests: `DatanotesClient` does it
 * with its `trace` option, or makes a CLIENT span per request with its `tracer` option.
 *
 * The spans go to an exporter, usually `OtlpTraceExporter` (otlp.ts). Unlike the engine's tracer,
 * this one keeps no context across `await`: pass the parent explicitly, so it runs anywhere
 * (Node, browsers, Obsidian).
 */

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatusCode = "unset" | "ok" | "error";
type AttrValue = string | number | boolean | null | undefined;

/** A position in a trace: what `traceparent` carries. */
export interface TraceContext {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters: the caller's span. */
  spanId: string;
  /** Whether the caller records the trace (flag `01`). */
  sampled: boolean;
  /** The `tracestate` header, passed on as it came. */
  traceState?: string;
}

export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/**
 * Read a `traceparent` header (and its `tracestate`); null when it is missing or invalid (an
 * all-zero id, version `ff`, a version 00 header with extra fields), as the W3C spec says.
 */
export function parseTraceparent(traceparent: string | null | undefined, tracestate?: string | null): TraceContext | null {
  const m = TRACEPARENT.exec((typeof traceparent === "string" ? traceparent : "").trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, spanId, flags, rest] = m as unknown as [string, string, string, string, string, string | undefined];
  if (version === "ff" || (version === "00" && rest !== undefined)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  const state = (typeof tracestate === "string" ? tracestate : "").trim();
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1, ...(state ? { traceState: state.slice(0, 512) } : {}) };
}

/** The `traceparent` header of a context (version 00). */
export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

/** The headers that continue `ctx` in another process: `traceparent`, and `tracestate` when there is one. */
export function traceHeaders(ctx: TraceContext): Record<string, string> {
  return { [TRACEPARENT_HEADER]: formatTraceparent(ctx), ...(ctx.traceState ? { [TRACESTATE_HEADER]: ctx.traceState } : {}) };
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  /* v8 ignore next 2 -- a fallback for runtimes without Web Crypto: Node and browsers have it */
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < bytes; i++) b[i] = Math.floor(Math.random() * 256);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  /* v8 ignore next -- impossible in practice: an all-zero id from a random source (2^-64 at most) */
  return /^0+$/.test(hex) ? randomHex(bytes) : hex;
}

/** A new random trace id (32 hex characters). */
export const newTraceId = (): string => randomHex(16);
/** A new random span id (16 hex characters). */
export const newSpanId = (): string => randomHex(8);

/** A finished span, as `OtlpTraceExporter` sends it (times are Unix ms, with a fraction). */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue>;
  events: { name: string; timeMs: number; attributes: Record<string, AttrValue> }[];
  status: { code: SpanStatusCode; message?: string };
  droppedAttributes?: number;
  droppedEvents?: number;
}

export interface TracerOptions {
  /** Where finished spans go, e.g. `(s) => exporter.export(s)` of an `OtlpTraceExporter`. */
  export(spans: SpanRecord[]): void;
  /** Share of new traces kept, 0 to 1 (default 1); a trace continued from a parent follows the parent. */
  sampleRatio?: number;
  /** Unix time in ms (default: `performance` when there is one, else `Date.now`). */
  now?: () => number;
}

const perf = (globalThis as { performance?: { now(): number; timeOrigin: number } }).performance;
/* v8 ignore next -- performance is global in Node 16+ and browsers */
const defaultNow = perf ? () => perf.timeOrigin + perf.now() : () => Date.now();

/** One operation of a program, timed; `end()` sends it. Not sampled: `recording` is false and nothing is sent. */
export class TraceSpan {
  readonly context: TraceContext;
  private readonly startMs: number;
  private readonly attributes: Record<string, AttrValue> = {};
  private readonly events: SpanRecord["events"] = [];
  private status: SpanRecord["status"] = { code: "unset" };
  private ended = false;

  constructor(
    private readonly tracer: Tracer,
    readonly name: string,
    readonly kind: SpanKind,
    readonly parent: TraceContext | null,
    readonly recording: boolean,
    attributes: Record<string, AttrValue>,
  ) {
    this.context = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      sampled: recording,
      ...(parent?.traceState ? { traceState: parent.traceState } : {}),
    };
    this.startMs = tracer.now();
    this.setAttributes(attributes);
  }

  setAttribute(key: string, value: AttrValue): this {
    if (value !== undefined && value !== null) this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, AttrValue>): this {
    for (const k in attributes) this.setAttribute(k, attributes[k]);
    return this;
  }

  addEvent(name: string, attributes: Record<string, AttrValue> = {}): this {
    this.events.push({ name, timeMs: this.tracer.now(), attributes });
    return this;
  }

  /** An `exception` event, `error.type` and status ERROR. */
  recordException(e: unknown): this {
    const type = e instanceof Error ? e.name : typeof e;
    const message = e instanceof Error ? e.message : String(e);
    this.addEvent("exception", { "exception.type": type, "exception.message": message, ...(e instanceof Error && e.stack ? { "exception.stacktrace": e.stack.slice(0, 8192) } : {}) });
    if (!("error.type" in this.attributes)) this.attributes["error.type"] = type;
    return this.setStatus("error", message);
  }

  setStatus(code: SpanStatusCode, message?: string): this {
    if (this.status.code === "error" && code !== "error") return this;
    this.status = code === "error" && message ? { code, message } : { code };
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.recording) return;
    this.tracer.send({
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      ...(this.parent ? { parentSpanId: this.parent.spanId } : {}),
      ...(this.context.traceState ? { traceState: this.context.traceState } : {}),
      name: this.name,
      kind: this.kind,
      startMs: this.startMs,
      endMs: this.tracer.now(),
      attributes: this.attributes,
      events: this.events,
      status: this.status,
    });
  }
}

/** Makes spans with explicit parents and hands them to an exporter. Never throws. */
export class Tracer {
  readonly now: () => number;

  constructor(private readonly o: TracerOptions) {
    this.now = o.now ?? defaultNow;
  }

  /** A new span: a child of `parent` (a context or a `traceparent` header), or a new trace. */
  startSpan(name: string, opts: { kind?: SpanKind; parent?: TraceContext | string | null; attributes?: Record<string, AttrValue> } = {}): TraceSpan {
    const parent = typeof opts.parent === "string" ? parseTraceparent(opts.parent) : (opts.parent ?? null);
    const ratio = this.o.sampleRatio ?? 1;
    const span = new TraceSpan(this, name, opts.kind ?? "internal", parent, true, opts.attributes ?? {});
    const recording = parent ? parent.sampled : ratio >= 1 || (ratio > 0 && parseInt(span.context.traceId.slice(-13), 16) / 2 ** 52 < ratio);
    return recording ? span : new TraceSpan(this, name, opts.kind ?? "internal", parent ?? { ...span.context, sampled: false }, false, {});
  }

  /** @internal */
  send(span: SpanRecord): void {
    try {
      this.o.export([span]);
    } catch {
      // a failing exporter loses the span, never the program's work
    }
  }
}
