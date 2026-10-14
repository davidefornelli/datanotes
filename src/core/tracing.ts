/**
 * Distributed tracing of the engine: spans with parent/child relations and durations, the
 * OpenTelemetry model without its SDK. The host installs two things (src/server/tracing.ts):
 *
 * - a {@link ContextStore}, which keeps the active span across `await` (AsyncLocalStorage in Node);
 * - a {@link TracerOptions}, which receives the finished spans (an OTLP exporter) and says whether
 *   to trace, how much to sample and how many spans one trace may hold.
 *
 * Without both, tracing is off: every helper here runs its work directly, and the cost is one
 * check of a module variable. Tracing must never break or slow a vault operation: nothing here
 * throws, and an exporter that fails is ignored.
 *
 * Spans of one trace started in this process (its "local trace") are exported together when the
 * local root ends, so a request can still be dropped at its end (an empty poll of the change
 * feed). A span that ends after its root is exported on its own.
 */

import type { AttrValue } from "./telemetry";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatusCode = "unset" | "ok" | "error";

/** What another span or process needs to continue a trace (W3C Trace Context). */
export interface SpanContext {
  /** 32 lowercase hex characters (16 bytes). */
  traceId: string;
  /** 16 lowercase hex characters (8 bytes). */
  spanId: string;
  sampled: boolean;
  traceState?: string;
}

export interface SpanEventData {
  name: string;
  /** Unix time in ms (with a fraction). */
  timeMs: number;
  attributes: Record<string, AttrValue>;
}

/** A finished span, as exporters read it. */
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: SpanKind;
  /** Unix time in ms (with a fraction). */
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue>;
  events: SpanEventData[];
  status: { code: SpanStatusCode; message?: string };
  droppedAttributes: number;
  droppedEvents: number;
}

export interface Span {
  /** False for spans that are not exported (tracing off, not sampled, over the trace's cap). */
  readonly recording: boolean;
  /** Its trace context (undefined when tracing is off). */
  readonly context: SpanContext | undefined;
  setAttribute(key: string, value: AttrValue): Span;
  setAttributes(attributes: Record<string, AttrValue>): Span;
  /** Add `n` to a numeric attribute (a count, a total of ms or bytes). */
  add(key: string, n: number): Span;
  addEvent(name: string, attributes?: Record<string, AttrValue>): Span;
  /** An `exception` event (type, message, stack), status ERROR and `error.type`. */
  recordException(e: unknown): Span;
  setStatus(code: SpanStatusCode, message?: string): Span;
  end(endMs?: number): void;
}

/** Keeps the active span across asynchronous calls. */
export interface ContextStore {
  run<R>(span: Span, fn: () => R): R;
  active(): Span | undefined;
}

export interface TracerOptions {
  /** The spans of a local trace, when its root ends (or a span that ends after its root). Never throws back. */
  export(spans: SpanData[]): void;
  /** Whether to start new traces (read when a trace starts). */
  enabled(): boolean;
  /** Share of new traces kept, 0 to 1 (a trace continued from a caller follows the caller's choice). */
  sampleRatio(): number;
  /** Most spans one local trace may hold; the others are dropped and counted (`datanotes.spans_dropped` on the root). */
  maxSpansPerTrace(): number;
  /** Roots and operation spans lasting at least this long go to `onSlow` (0: never). */
  slowSpanMs?(): number;
  /** Called with the span active, so a log record names it. */
  onSlow?(span: SpanData): void;
  /** A vault call at least this slow gets a span of its own (default 20 ms); faster ones are only counted. */
  ioDetailMs?: number;
  /** Unix time in ms (default `performance.timeOrigin + performance.now()`). */
  now?: () => number;
}

const MAX_ATTRIBUTES = 128;
const MAX_EVENTS = 128;
const MAX_VALUE = 4096;
const MAX_STACK = 8192;

let store: ContextStore | null = null;
let tracer: TracerOptions | null = null;
/** The one check every helper makes: a store and a tracer are installed. */
let on = false;

const perf = (globalThis as { performance?: { now(): number; timeOrigin: number } }).performance;
/* v8 ignore next -- impossible on Node 16+ and browsers: performance is global there */
const defaultNow = perf ? () => perf.timeOrigin + perf.now() : () => Date.now();
let clock: () => number = defaultNow;

/** Install (or remove, with null) the context store. */
export function setContextStore(s: ContextStore | null): void {
  store = s;
  on = store !== null && tracer !== null;
}

/** Install (or remove, with null) the tracer. */
export function configureTracer(t: TracerOptions | null): void {
  tracer = t;
  clock = t?.now ?? defaultNow;
  on = store !== null && tracer !== null;
}

/** Whether spans can be made at all (a store and a tracer installed). */
export function tracingOn(): boolean {
  return on;
}

/** The tracer's clock: Unix time in ms with a fraction. */
export function traceNow(): number {
  return clock();
}

// --- ids ----------------------------------------------------------------------------------------

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const POOL = new Uint8Array(4096);
let poolAt = POOL.length;

function randomHex(bytes: number): string {
  if (poolAt + bytes > POOL.length) {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    /* v8 ignore next -- a fallback for runtimes without Web Crypto: Node and browsers have it */
    if (c?.getRandomValues) c.getRandomValues(POOL);
    /* v8 ignore next */ else for (let i = 0; i < POOL.length; i++) POOL[i] = Math.floor(Math.random() * 256);
    poolAt = 0;
  }
  let out = "";
  for (let i = 0; i < bytes; i++) out += HEX[POOL[poolAt++]!];
  // an all-zero id is invalid: astronomically rare, but then take the next one
  /* v8 ignore next -- impossible in practice: an all-zero id from a random source (2^-64 at most) */
  return /^0+$/.test(out) ? randomHex(bytes) : out;
}

export const newTraceId = (): string => randomHex(16);
export const newSpanId = (): string => randomHex(8);

/** Whether a new trace is kept: by its id, so every process that sees it decides the same. */
export function sampledByRatio(traceId: string, ratio: number): boolean {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  return parseInt(traceId.slice(-13), 16) / 2 ** 52 < ratio;
}

// --- spans --------------------------------------------------------------------------------------

function clip(v: AttrValue): AttrValue {
  return typeof v === "string" && v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}…` : v;
}

function errorFields(e: unknown): { type: string; message: string; stack?: string } {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    // an error class that keeps the name "Error" is named by its constructor
    const name = e.name === "Error" && e.constructor.name ? e.constructor.name : e.name;
    return { type: typeof code === "string" && code ? code : name, message: e.message, ...(e.stack ? { stack: e.stack.slice(0, MAX_STACK) } : {}) };
  }
  return { type: typeof e, message: String(e) };
}

/** The span of tracing off: does nothing. */
class NoopSpan implements Span {
  get recording(): boolean {
    return false;
  }
  get context(): SpanContext | undefined {
    return undefined;
  }
  setAttribute(): Span {
    return this;
  }
  setAttributes(): Span {
    return this;
  }
  add(): Span {
    return this;
  }
  addEvent(): Span {
    return this;
  }
  recordException(): Span {
    return this;
  }
  setStatus(): Span {
    return this;
  }
  end(): void {}
}

export const NOOP_SPAN: Span = new NoopSpan();

/** A span that is not exported but carries its context: a trace not sampled, or over its cap. */
class QuietSpan extends NoopSpan {
  constructor(
    readonly ctx: SpanContext,
    /** Set when over the cap: its would-be children are counted as dropped. */
    readonly trace?: LocalTrace,
  ) {
    super();
  }
  override get context(): SpanContext {
    return this.ctx;
  }
}

/** The spans of one trace in this process: the cap, and those waiting for the root to end. */
class LocalTrace {
  count = 1;
  dropped = 0;
  rootEnded = false;
  discarded = false;
  pending: SpanData[] = [];
  constructor(
    readonly traceId: string,
    readonly max: number,
  ) {}

  finish(data: SpanData, root: boolean): void {
    if (root) {
      this.rootEnded = true;
      if (this.dropped > 0) data.attributes["datanotes.spans_dropped"] = this.dropped;
      const all = this.pending;
      this.pending = [];
      all.push(data);
      if (!this.discarded) send(all);
    } else if (this.rootEnded) {
      if (!this.discarded) send([data]);
    } else this.pending.push(data);
  }
}

function send(spans: SpanData[]): void {
  try {
    tracer?.export(spans);
  } catch {
    // an exporter that fails loses its spans, never the operation
  }
}

class RecordingSpan implements Span {
  readonly recording = true;
  readonly context: SpanContext;
  /** The nearest operation span (itself when it is one, else its parent's; the root otherwise): counts add up there too. */
  readonly op: RecordingSpan;
  private readonly attributes: Record<string, AttrValue> = {};
  private attributeCount = 0;
  private droppedAttributes = 0;
  private events: SpanEventData[] = [];
  private droppedEvents = 0;
  private status: { code: SpanStatusCode; message?: string } = { code: "unset" };
  private ended = false;

  constructor(
    readonly trace: LocalTrace,
    readonly name: string,
    readonly kind: SpanKind,
    readonly parentSpanId: string | undefined,
    traceState: string | undefined,
    readonly isRoot: boolean,
    parentOp: RecordingSpan | undefined,
    operation: boolean,
    readonly startMs: number,
  ) {
    this.context = { traceId: trace.traceId, spanId: newSpanId(), sampled: true, ...(traceState ? { traceState } : {}) };
    this.op = operation || !parentOp ? this : parentOp;
  }

  setAttribute(key: string, value: AttrValue): Span {
    if (value === undefined || value === null) return this;
    if (!(key in this.attributes)) {
      if (this.attributeCount >= MAX_ATTRIBUTES) {
        this.droppedAttributes++;
        return this;
      }
      this.attributeCount++;
    }
    this.attributes[key] = clip(value);
    return this;
  }

  setAttributes(attributes: Record<string, AttrValue>): Span {
    for (const k in attributes) this.setAttribute(k, attributes[k]);
    return this;
  }

  /** It already says what went wrong (`error.type`): an error passing through is not recorded again. */
  get classified(): boolean {
    return "error.type" in this.attributes;
  }

  add(key: string, n: number): Span {
    const v = this.attributes[key];
    return this.setAttribute(key, (typeof v === "number" ? v : 0) + n);
  }

  addEvent(name: string, attributes: Record<string, AttrValue> = {}): Span {
    if (this.events.length >= MAX_EVENTS) this.droppedEvents++;
    else this.events.push({ name, timeMs: clock(), attributes });
    return this;
  }

  recordException(e: unknown): Span {
    const f = errorFields(e);
    this.addEvent("exception", { "exception.type": f.type, "exception.message": clip(f.message), ...(f.stack ? { "exception.stacktrace": f.stack } : {}) });
    if (!("error.type" in this.attributes)) this.setAttribute("error.type", f.type);
    return this.setStatus("error", f.message);
  }

  setStatus(code: SpanStatusCode, message?: string): Span {
    // ERROR stays: a later OK does not hide a failure
    if (this.status.code === "error" && code !== "error") return this;
    this.status = code === "error" && message ? { code, message: String(clip(message)) } : { code };
    return this;
  }

  end(endMs?: number): void {
    if (this.ended) return;
    this.ended = true;
    const end = endMs ?? clock();
    const data: SpanData = {
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      ...(this.context.traceState ? { traceState: this.context.traceState } : {}),
      name: this.name,
      kind: this.kind,
      startMs: this.startMs,
      endMs: end,
      attributes: this.attributes,
      events: this.events,
      status: this.status,
      droppedAttributes: this.droppedAttributes,
      droppedEvents: this.droppedEvents,
    };
    const slow = (this.isRoot || this.op === this) && tracer?.onSlow ? (tracer.slowSpanMs?.() ?? 0) : 0;
    if (slow > 0 && end - this.startMs >= slow) {
      try {
        store!.run(this, () => tracer!.onSlow!(data));
      } catch {
        // a log that fails is not the operation's problem
      }
    }
    this.trace.finish(data, this.isRoot);
  }

  child(name: string, o: StartOptions): Span {
    const t = this.trace;
    if (t.count >= t.max) {
      t.dropped++;
      return new QuietSpan(this.context, t);
    }
    t.count++;
    return new RecordingSpan(t, name, o.kind ?? "internal", this.context.spanId, this.context.traceState, false, this.op, o.operation === true, o.startMs ?? clock()).setAttributes(o.attributes ?? {});
  }
}

export interface StartOptions {
  kind?: SpanKind;
  attributes?: Record<string, AttrValue>;
  /** Start a trace when no span is active (a request, a background job). Without it, a span is only a child of the active one. */
  root?: boolean;
  /** A trace of its own even inside another span (a loop that outlives the request that started it). */
  newTrace?: boolean;
  /** Continue a caller's trace (`traceparent`): a local root whose parent is the caller's span. */
  remote?: SpanContext;
  /** The span of one operation: vault calls and counts inside it add up on it too. */
  operation?: boolean;
  /** When it started (Unix ms), for a span recorded after the fact. */
  startMs?: number;
}

/**
 * A new span: a child of the active span, or a local root (`root`, `remote`). Not active: run code
 * in it with {@link withSpan}. Without tracing, or for a child with no recording parent, a span
 * that does nothing.
 */
export function startSpan(name: string, o: StartOptions = {}): Span {
  if (!on) return NOOP_SPAN;
  const parent = o.remote || o.newTrace ? undefined : store!.active();
  if (parent instanceof RecordingSpan) return parent.child(name, o);
  if (parent instanceof QuietSpan) {
    if (parent.trace) parent.trace.dropped++;
    return parent;
  }
  if (!o.root && !o.remote && !o.newTrace) return NOOP_SPAN;
  try {
    if (!tracer!.enabled()) return NOOP_SPAN;
    const traceId = o.remote?.traceId ?? newTraceId();
    const traceState = o.remote?.traceState;
    const sampled = o.remote ? o.remote.sampled : sampledByRatio(traceId, tracer!.sampleRatio());
    if (!sampled) return new QuietSpan({ traceId, spanId: o.remote?.spanId ?? newSpanId(), sampled: false, ...(traceState ? { traceState } : {}) });
    const max = Math.max(1, Math.floor(tracer!.maxSpansPerTrace()));
    return new RecordingSpan(new LocalTrace(traceId, max), name, o.kind ?? "internal", o.remote?.spanId, traceState, true, undefined, o.operation === true, o.startMs ?? clock()).setAttributes(o.attributes ?? {});
  } catch {
    return NOOP_SPAN;
  }
}

/**
 * Record a thrown error on a span. A failure (a bug, a disk error) gets an `exception` event and
 * status ERROR; a refusal the caller can fix (an error with a `hint`: bad input, a violation) only
 * sets `error.type` and leaves the status unset, as does an error the span already classified
 * (it set `error.type` itself).
 */
export function failed(span: Span, e: unknown): void {
  if (span instanceof RecordingSpan && span.classified) return;
  const hint = e !== null && typeof e === "object" && typeof (e as { hint?: unknown }).hint === "string";
  if (hint) span.setAttribute("error.type", errorFields(e).type);
  else span.recordException(e);
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";
}

/**
 * Run `fn` in a new span (see {@link startSpan}), active for everything `fn` calls, and end it
 * when `fn` returns or its promise settles. A throw or a rejection is recorded on the span (see
 * {@link failed}) and passed on unchanged.
 */
export function withSpan<T>(name: string, o: StartOptions | undefined, fn: (span: Span) => T): T {
  if (!on) return fn(NOOP_SPAN);
  const span = startSpan(name, o);
  if (span === NOOP_SPAN) return fn(span);
  let result: T;
  try {
    result = store!.run(span, () => fn(span));
  } catch (e) {
    failed(span, e);
    span.end();
    throw e;
  }
  if (!isThenable(result)) {
    span.end();
    return result;
  }
  return result.then(
    (v) => {
      span.end();
      return v;
    },
    (e: unknown) => {
      failed(span, e);
      span.end();
      throw e;
    },
  ) as T;
}

/** A phase of an operation (a child span of the active one): nothing when no span is active. */
export function phase<T>(name: string, fn: (span: Span) => T, attributes?: Record<string, AttrValue>): T {
  if (!on) return fn(NOOP_SPAN);
  return withSpan(name, attributes ? { attributes } : undefined, fn);
}

/**
 * Background work (a timer, a vault event): always a trace of its own. A timer set during a
 * request keeps the request's context; its work is not part of the request.
 */
export function job<T>(name: string, fn: (span: Span) => T, attributes?: Record<string, AttrValue>): T {
  if (!on) return fn(NOOP_SPAN);
  return withSpan(name, { newTrace: true, ...(attributes ? { attributes } : {}) }, fn);
}

/** Work that is part of the active trace, or a trace of its own when nothing is traced (an engine operation). */
export function rootOrChild<T>(name: string, fn: (span: Span) => T, attributes?: Record<string, AttrValue>): T {
  if (!on) return fn(NOOP_SPAN);
  return withSpan(name, { root: true, ...(attributes ? { attributes } : {}) }, fn);
}

/**
 * A child of `parent` without making either active: for spans recorded after the fact, such as
 * the phases of the engine's start, whose work must not run inside a span (everything it starts,
 * timers and the HTTP server included, would inherit it).
 */
export function startChild(parent: Span, name: string, o: StartOptions = {}): Span {
  return parent instanceof RecordingSpan ? parent.child(name, o) : NOOP_SPAN;
}

/** The active span (NOOP_SPAN when there is none). */
export function activeSpan(): Span {
  if (!on) return NOOP_SPAN;
  return store!.active() ?? NOOP_SPAN;
}

/** The trace context of the active span, for a log record or an outgoing request. */
export function activeSpanContext(): SpanContext | undefined {
  if (!on) return undefined;
  return store!.active()?.context;
}

/** Drop the active local trace: none of its spans is exported (an empty poll, a health check). */
export function discardTrace(): void {
  if (!on) return;
  const s = store!.active();
  if (s instanceof RecordingSpan) s.trace.discarded = true;
}

/** Add `n` to the attribute `key` of the active span and of its operation span. */
export function count(key: string, n = 1): void {
  if (!on) return;
  const s = store!.active();
  if (!(s instanceof RecordingSpan)) return;
  s.add(key, n);
  if (s.op !== s) s.op.add(key, n);
}

/**
 * Time spent in many small calls (one per row) without a span each: adds 1 to `countKey` and the
 * ms since `startMs` to `msKey`, on the active span and its operation span. `startMs` comes from
 * {@link traceNow}, read only when {@link tracingOn}.
 */
export function tally(countKey: string, msKey: string, startMs: number): void {
  if (!on) return;
  const s = store!.active();
  if (!(s instanceof RecordingSpan)) return;
  const ms = clock() - startMs;
  s.add(countKey, 1).add(msKey, ms);
  if (s.op !== s) s.op.add(countKey, 1).add(msKey, ms);
}

/** The vault and store calls the engine makes, as counted on spans. */
export type IoKind = "read" | "write" | "append" | "list" | "exists" | "mkdir" | "remove" | "rename" | "create" | "delete" | "trash" | "process";

const IO_KEYS = {} as Record<IoKind, { count: string; chars: string; ms: string }>;
for (const k of ["read", "write", "append", "list", "exists", "mkdir", "remove", "rename", "create", "delete", "trash", "process"] as IoKind[]) {
  IO_KEYS[k] = { count: `datanotes.io.${k}_count`, chars: `datanotes.io.${k}_chars`, ms: `datanotes.io.${k}_ms` };
}

/**
 * One vault or store call that started at `startMs` (from {@link traceNow}) and moved `chars`
 * characters (a string's length, UTF-16 code units, not bytes; a listing's entries):
 * counted on the active span and its operation span (calls, characters, ms), never a span per call. A
 * call slower than `ioDetailMs` gets a span of its own too (`vault.<kind>`), with its path.
 */
export function ioDone(kind: IoKind, path: string, startMs: number, chars: number): void {
  if (!on) return;
  const s = store!.active();
  if (!(s instanceof RecordingSpan)) return;
  const end = clock();
  const ms = end - startMs;
  const k = IO_KEYS[kind];
  s.add(k.count, 1).add(k.chars, chars).add(k.ms, ms);
  if (s.op !== s) s.op.add(k.count, 1).add(k.chars, chars).add(k.ms, ms);
  if (ms >= (tracer!.ioDetailMs ?? 20)) {
    s.child(`vault.${kind}`, { startMs, attributes: { "file.path": path, "datanotes.io.chars": chars } }).end(end);
  }
}
