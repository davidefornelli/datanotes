import { afterEach, describe, expect, it } from "vitest";
import {
  activeSpan,
  activeSpanContext,
  configureTracer,
  count,
  discardTrace,
  failed,
  ioDone,
  job,
  NOOP_SPAN,
  phase,
  rootOrChild,
  sampledByRatio,
  setContextStore,
  startChild,
  startSpan,
  tally,
  traceNow,
  tracingOn,
  withSpan,
  type SpanData,
  type TracerOptions,
} from "../src/core/tracing";
import { AsyncContextStore, engineResource, installTracing, resolveTraces, TraceSink } from "../src/server/tracing";
import { FileLogger, NOOP_TELEMETRY, setTelemetry, traced } from "../src/core/telemetry";
import { OtlpSink } from "../src/server/otlp-sink";
import { traceVaultIo } from "../src/core/vault-io-tracing";
import { GuidedError } from "../src/core/hints";
import { mergeWithDefaults, DEFAULT_SETTINGS } from "../src/core/settings";

/** Install the tracer with a fake clock; the exported spans land in the returned list. */
function install(o: Partial<TracerOptions> = {}): SpanData[] {
  const out: SpanData[] = [];
  let t = 1_700_000_000_000;
  setContextStore(new AsyncContextStore());
  configureTracer({
    export: (s) => out.push(...s),
    enabled: () => true,
    sampleRatio: () => 1,
    maxSpansPerTrace: () => 100,
    now: () => (t += 1),
    ...o,
  });
  return out;
}

afterEach(() => {
  configureTracer(null);
  setContextStore(null);
  setTelemetry(NOOP_TELEMETRY);
});

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("tracing off", () => {
  it("runs the work directly with a span that does nothing", async () => {
    expect(tracingOn()).toBe(false);
    expect(withSpan("a", { root: true }, (s) => s)).toBe(NOOP_SPAN);
    expect(await phase("b", async () => 7)).toBe(7);
    expect(job("c", () => 1)).toBe(1);
    expect(rootOrChild("d", () => 2)).toBe(2);
    expect(startSpan("e", { root: true })).toBe(NOOP_SPAN);
    expect(activeSpan()).toBe(NOOP_SPAN);
    expect(activeSpanContext()).toBeUndefined();
    // the helpers that count do nothing, and never throw
    count("x");
    tally("a", "b", 0);
    ioDone("read", "p", 0, 1);
    discardTrace();
    expect(startChild(NOOP_SPAN, "x")).toBe(NOOP_SPAN);
    const s = NOOP_SPAN.setAttribute("a", 1).setAttributes({}).add("n", 1).addEvent("e").recordException(new Error("x")).setStatus("ok");
    s.end();
    expect([s.recording, s.context]).toEqual([false, undefined]);
    // only a store, or only a tracer: still off
    setContextStore(new AsyncContextStore());
    expect(tracingOn()).toBe(false);
  });
});

describe("spans", () => {
  it("keep their parents across await, timers and parallel work, and are exported together when the root ends", async () => {
    const out = install();
    await withSpan("root", { root: true, kind: "server" }, async () => {
      await phase("a", async () => {
        await tick();
        await phase("a1", async () => tick());
      });
      await Promise.all([phase("b", () => tick()), phase("c", async () => {
        await tick();
        expect(activeSpan().recording).toBe(true);
      })]);
      expect(out).toEqual([]); // nothing sent before the root ends
    });
    const by = Object.fromEntries(out.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(["a", "a1", "b", "c", "root"]);
    expect(by.root!.parentSpanId).toBeUndefined();
    expect(by.root!.kind).toBe("server");
    expect(by.a!.parentSpanId).toBe(by.root!.spanId);
    expect(by.a1!.parentSpanId).toBe(by.a!.spanId);
    expect(by.b!.parentSpanId).toBe(by.root!.spanId);
    expect(by.c!.parentSpanId).toBe(by.root!.spanId);
    expect(new Set(out.map((s) => s.traceId)).size).toBe(1);
    expect(by.root!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(by.a!.spanId).toMatch(/^[0-9a-f]{16}$/);
    for (const s of out) expect(s.endMs).toBeGreaterThan(s.startMs);
  });

  it("a phase with no span active, or a sync body, works; a span ending after its root is sent alone", async () => {
    const out = install();
    expect(phase("orphan", () => 3)).toBe(3);
    expect(out).toEqual([]);
    let late: ReturnType<typeof startSpan> = NOOP_SPAN;
    withSpan("root", { root: true }, () => {
      late = startSpan("late");
      return 1;
    });
    expect(out.map((s) => s.name)).toEqual(["root"]);
    late.end();
    late.end(); // twice: once
    expect(out.map((s) => s.name)).toEqual(["root", "late"]);
  });

  it("records failures as errors, refusals (an error with a hint) only by their type", async () => {
    const out = install();
    await expect(withSpan("boom", { root: true }, async () => { throw new TypeError("disk on fire"); })).rejects.toThrow("disk on fire");
    expect(() => withSpan("sync", { root: true }, () => { throw "plain"; })).toThrow("plain");
    await expect(withSpan("refused", { root: true }, async () => { throw new GuidedError("bad input", { hint: "fix it", docs: "d" }); })).rejects.toThrow("bad input");
    const coded = Object.assign(new Error("gone"), { code: "ENOENT" });
    await expect(withSpan("coded", { root: true }, async () => { throw coded; })).rejects.toThrow("gone");
    // a span that said what went wrong itself is not changed by the error passing through
    await expect(withSpan("classified", { root: true }, async (s) => { s.setAttribute("error.type", "mine"); throw new Error("x"); })).rejects.toThrow("x");
    const by = Object.fromEntries(out.map((s) => [s.name, s]));
    expect(by.boom!.status).toEqual({ code: "error", message: "disk on fire" });
    expect(by.boom!.attributes["error.type"]).toBe("TypeError");
    expect(by.boom!.events[0]!.name).toBe("exception");
    expect(by.boom!.events[0]!.attributes).toMatchObject({ "exception.type": "TypeError", "exception.message": "disk on fire" });
    expect(String(by.boom!.events[0]!.attributes["exception.stacktrace"])).toContain("TypeError");
    expect(by.sync!.events[0]!.attributes).toEqual({ "exception.type": "string", "exception.message": "plain" });
    expect(by.refused!.status).toEqual({ code: "unset" });
    expect(by.refused!.attributes["error.type"]).toBe("GuidedError");
    expect(by.refused!.events).toEqual([]);
    expect(by.coded!.attributes["error.type"]).toBe("ENOENT");
    expect(by.classified!.attributes["error.type"]).toBe("mine");
    expect(by.classified!.status.code).toBe("unset");
    // failed() on a span that does nothing is harmless
    failed(NOOP_SPAN, new Error("x"));
  });

  it("keeps ERROR once set, caps attributes, events and long values", () => {
    const out = install();
    withSpan("s", { root: true }, (s) => {
      s.setStatus("error", "bad").setStatus("ok").setStatus("error");
      for (let i = 0; i < 130; i++) s.setAttribute(`k${i}`, i);
      s.setAttribute("k0", 99).setAttribute("nothing", undefined).setAttribute("null", null);
      for (let i = 0; i < 130; i++) s.addEvent(`e${i}`);
    });
    withSpan("long", { root: true }, (s) => s.setAttribute("v", "x".repeat(5000)).setStatus("ok"));
    const s = out[0]!;
    expect(s.status).toEqual({ code: "error" });
    expect(Object.keys(s.attributes)).toHaveLength(128);
    expect(s.attributes.k0).toBe(99);
    expect(s.droppedAttributes).toBe(2);
    expect(s.events).toHaveLength(128);
    expect(s.droppedEvents).toBe(2);
    expect(String(out[1]!.attributes.v)).toHaveLength(4097);
    expect(out[1]!.status).toEqual({ code: "ok" });
  });

  it("caps the spans of a trace and counts the dropped ones on the root", async () => {
    const out = install({ maxSpansPerTrace: () => 3 });
    await withSpan("root", { root: true }, async () => {
      await phase("a", async () => {
        await phase("b", async () => {
          // over the cap: this one and everything under it is dropped and counted
          await phase("c", async () => {
            await phase("d", async () => tick());
            expect(activeSpan().recording).toBe(false);
          });
        });
      });
      startSpan("e").end();
    });
    expect(out.map((s) => s.name).sort()).toEqual(["a", "b", "root"]);
    expect(out.find((s) => s.name === "root")!.attributes["datanotes.spans_dropped"]).toBe(3);
  });

  it("samples new traces by ratio and follows a caller's choice", () => {
    expect(sampledByRatio("0".repeat(19) + "fffffffffffff", 0.5)).toBe(false);
    expect(sampledByRatio("0".repeat(32), 0.5)).toBe(true);
    expect(sampledByRatio("abc", 0)).toBe(false);
    expect(sampledByRatio("abc", 1)).toBe(true);
    const out = install({ sampleRatio: () => 0 });
    withSpan("dropped", { root: true }, () => {
      // not sampled: no export, but a context to pass on (flag 00), the same for its children
      const ctx = activeSpanContext()!;
      expect(ctx.sampled).toBe(false);
      phase("child", () => expect(activeSpanContext()).toEqual(ctx));
    });
    const remote = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true, traceState: "k=v" };
    withSpan("continued", { remote }, () => phase("inner", () => undefined));
    withSpan("unsampled caller", { remote: { ...remote, sampled: false } }, () => {
      expect(activeSpanContext()).toEqual({ traceId: remote.traceId, spanId: remote.spanId, sampled: false, traceState: "k=v" });
    });
    expect(out.map((s) => s.name)).toEqual(["inner", "continued"]);
    expect(out[1]).toMatchObject({ traceId: remote.traceId, parentSpanId: remote.spanId, traceState: "k=v" });
    expect(out[0]!.traceState).toBe("k=v");
  });

  it("starts no trace while disabled, nor when the tracer fails", () => {
    install({ enabled: () => false });
    expect(startSpan("x", { root: true })).toBe(NOOP_SPAN);
    install({
      enabled: () => {
        throw new Error("settings unreadable");
      },
    });
    expect(startSpan("x", { root: true })).toBe(NOOP_SPAN);
  });

  it("job starts a trace of its own even inside a request; rootOrChild joins the active one", () => {
    const out = install();
    withSpan("request", { root: true }, () => {
      job("job later", () => undefined);
      rootOrChild("engine.op", () => undefined);
    });
    const by = Object.fromEntries(out.map((s) => [s.name, s]));
    expect(by["job later"]!.traceId).not.toBe(by.request!.traceId);
    expect(by["job later"]!.parentSpanId).toBeUndefined();
    expect(by["engine.op"]!.parentSpanId).toBe(by.request!.spanId);
  });

  it("discards a whole local trace; an exporter that throws loses spans, not the work", async () => {
    const out = install();
    await withSpan("poll", { root: true }, async () => {
      phase("inner", () => undefined);
      discardTrace();
    });
    expect(out).toEqual([]);
    let late: ReturnType<typeof startSpan> = NOOP_SPAN;
    withSpan("poll2", { root: true }, () => {
      late = startSpan("late");
      discardTrace();
    });
    late.end();
    expect(out).toEqual([]);
    install({
      export: () => {
        throw new Error("collector bug");
      },
    });
    expect(withSpan("x", { root: true }, () => 5)).toBe(5);
  });

  it("counts on the active span and its operation span, times many small calls, and details slow vault calls", () => {
    let t = 0;
    const out = install({ now: () => t, ioDetailMs: 20 });
    withSpan("server", { root: true }, () => {
      count("outside op");
      withSpan("op", { operation: true }, () => {
        phase("scan", () => {
          count("datanotes.rows_scanned", 5);
          count("datanotes.cache.hits");
          const start = traceNow();
          t += 2;
          tally("datanotes.validate.rows", "datanotes.validate.ms", start);
          ioDone("read", "a.md", t, 100);
          const slow = t;
          t += 25;
          ioDone("write", "b.md", slow, 7);
        });
      });
    });
    const by = Object.fromEntries(out.map((s) => [s.name, s]));
    expect(by.server!.attributes["outside op"]).toBe(1);
    expect(by.scan!.attributes).toMatchObject({ "datanotes.rows_scanned": 5, "datanotes.cache.hits": 1, "datanotes.validate.rows": 1, "datanotes.validate.ms": 2, "datanotes.io.read_count": 1, "datanotes.io.read_chars": 100, "datanotes.io.write_ms": 25 });
    expect(by.op!.attributes).toMatchObject({ "datanotes.rows_scanned": 5, "datanotes.validate.rows": 1, "datanotes.io.read_count": 1, "datanotes.io.write_count": 1, "datanotes.io.write_chars": 7 });
    expect(by.server!.attributes["datanotes.rows_scanned"]).toBeUndefined();
    // only the slow call got a span of its own, under the active span
    expect(by["vault.write"]).toMatchObject({ parentSpanId: by.scan!.spanId, startMs: 2, endMs: 27, attributes: { "file.path": "b.md", "datanotes.io.chars": 7 } });
    expect(by["vault.read"]).toBeUndefined();
  });

  it("records spans after the fact under a root that is not active (the engine's start)", () => {
    const out = install();
    const root = startSpan("job datanotes_start", { newTrace: true, startMs: 10 });
    startChild(root, "engine.vault.load", { startMs: 10 }).end(20);
    root.end(30);
    expect(out.map((s) => [s.name, s.startMs, s.endMs])).toEqual([
      ["engine.vault.load", 10, 20],
      ["job datanotes_start", 10, 30],
    ]);
    expect(out[0]!.parentSpanId).toBe(out[1]!.spanId);
  });

  it("calls onSlow for a root or an operation span that lasts long enough, with that span active", () => {
    let t = 0;
    const seen: { name: string; active?: string }[] = [];
    install({
      now: () => t,
      slowSpanMs: () => 10,
      onSlow: (s) => {
        seen.push({ name: s.name, active: activeSpanContext()?.spanId === s.spanId ? "itself" : "other" });
        throw new Error("a log that fails");
      },
    });
    withSpan("fast", { root: true }, () => void (t += 1));
    withSpan("slow", { root: true }, () => {
      withSpan("op", { operation: true }, () => void (t += 20));
      phase("phase", () => void (t += 20));
    });
    expect(seen).toEqual([
      { name: "op", active: "itself" },
      { name: "slow", active: "itself" },
    ]);
  });
});

describe("log records name their span", () => {
  it("in the log files (trace_id, span_id) and in the OTLP records", async () => {
    install();
    const files: string[] = [];
    const fileLog = new FileLogger({ enabled: () => true, write: async (_d, lines) => void files.push(lines), now: () => 0 });
    const otlp: string[] = [];
    const sink = new OtlpSink(() => ({ endpoint: "http://c:4318", serviceName: "s", protocol: "http/json" }), async (_u, body) => void otlp.push(body as string));
    let ids = { traceId: "", spanId: "" };
    withSpan("request", { root: true }, () => {
      ids = activeSpanContext()!;
      fileLog.log("INFO", "inside");
      sink.log("INFO", "inside");
    });
    fileLog.log("INFO", "outside");
    sink.log("INFO", "outside");
    await fileLog.flush();
    await sink.flush();
    const lines = files.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ msg: "inside", trace_id: ids.traceId, span_id: ids.spanId });
    expect(lines[1].trace_id).toBeUndefined();
    const records = JSON.parse(otlp[0]!).resourceLogs[0].scopeLogs[0].logRecords;
    expect(records[0]).toMatchObject({ traceId: ids.traceId, spanId: ids.spanId, flags: 1 });
    expect(records[1].traceId).toBeUndefined();
  });

  it("traced(): a span per engine operation, the INFO record as DEBUG while it is exported, refusals and failures told apart", async () => {
    const out = install();
    const records: { sev: string; body: string }[] = [];
    setTelemetry({ log: (sev, body) => records.push({ sev, body }), flush: async () => {} });
    await traced("datanotes insert_row", { table: "log" }, async () => ({ ok: true }), () => ({ attributes: { ok: true, notes_changed: 1, "db.x": 1 } }));
    await traced("datanotes insert_row", {}, async () => ({ ok: false }), () => ({ severity: "WARN", attributes: { ok: false } }));
    await traced("datanotes insert_row", {}, async () => ({ ok: false }), () => ({ severity: "ERROR", attributes: { ok: false } }));
    await traced("datanotes select", {}, async () => 1);
    expect(records.map((r) => r.sev)).toEqual(["DEBUG", "WARN", "ERROR", "DEBUG"]);
    expect(out.map((s) => s.name)).toEqual(["engine.insert_row", "engine.insert_row", "engine.insert_row", "engine.query.execute"]);
    expect(out[0]!.attributes).toMatchObject({ "datanotes.table": "log", "datanotes.ok": true, "datanotes.notes_changed": 1, "db.x": 1 });
    expect([out[1]!.status.code, out[1]!.attributes["error.type"]]).toEqual(["unset", "refused"]);
    expect([out[2]!.status.code, out[2]!.attributes["error.type"]]).toEqual(["error", "failed"]);
  });
});

describe("vault calls on the spans", () => {
  it("wraps the host's methods once, counts calls, characters and time, and passes results and errors through", async () => {
    install();
    type Fn = (...a: unknown[]) => Promise<unknown>;
    type Adapter = Record<"exists" | "read" | "write" | "append" | "list" | "mkdir" | "remove" | "rename" | "rmdir", Fn>;
    const adapter: Adapter = {
      exists: async () => true,
      read: async () => "abc",
      write: async () => undefined,
      append: async () => undefined,
      list: async () => ({ files: ["a", "b"], folders: ["c"] }),
      mkdir: async () => undefined,
      remove: async () => {
        throw new Error("locked");
      },
      rename: async () => undefined,
      rmdir: async () => undefined,
    };
    const store: Adapter = { ...adapter, list: async () => undefined };
    const file = { path: "n.md", name: "n.md", basename: "n", extension: "md" };
    const vault: { adapter: Adapter; notAFunction: number } & Record<"read" | "process" | "create" | "delete" | "trash", Fn> = {
      adapter,
      read: async () => "hello",
      process: async () => "xy",
      create: async () => file,
      delete: async () => undefined,
      trash: async () => undefined,
      notAFunction: 1,
    };
    const app = { vault, store } as never;
    traceVaultIo(app);
    traceVaultIo(app); // once
    traceVaultIo({ vault: { adapter: {} } } as never); // a host without some calls: those are left alone
    let attrs: Record<string, unknown> = {};
    const out = install();
    await withSpan("op", { root: true, operation: true }, async () => {
      expect(await vault.read(file)).toBe("hello");
      await vault.process(file, () => "");
      await vault.create("new.md", "four");
      await vault.delete(file);
      await vault.trash(file);
      await adapter.read("x");
      await adapter.write("x", "12");
      await adapter.append("x", "1");
      expect(await adapter.list("")).toEqual({ files: ["a", "b"], folders: ["c"] });
      await adapter.exists("x");
      await adapter.mkdir("x");
      await adapter.rename("x", "y");
      await expect(adapter.remove("x")).rejects.toThrow("locked");
      await store.list("");
      await vault.delete(undefined); // a call that names no file counts all the same
      await vault.trash({});
    });
    attrs = out[0]!.attributes;
    expect(attrs).toMatchObject({
      "datanotes.io.read_count": 2,
      "datanotes.io.read_chars": 8,
      "datanotes.io.process_chars": 2,
      "datanotes.io.create_chars": 4,
      "datanotes.io.delete_count": 2,
      "datanotes.io.trash_count": 2,
      "datanotes.io.write_chars": 2,
      "datanotes.io.append_chars": 1,
      "datanotes.io.list_count": 2,
      "datanotes.io.list_chars": 3,
      "datanotes.io.exists_count": 1,
      "datanotes.io.mkdir_count": 1,
      "datanotes.io.rename_count": 1,
    });
    expect(attrs["datanotes.io.remove_count"]).toBeUndefined(); // a failed call is not counted
    // off: the wrapped calls go straight through
    configureTracer(null);
    expect(await vault.read(file)).toBe("hello");
  });
});

describe("the engine's trace configuration", () => {
  const base = { serviceVersion: "9", resource: { "service.instance.id": "x" } };
  const s = mergeWithDefaults({ telemetryEnabled: true });

  it("comes from the settings; the OTEL_* variables override them", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ telemetryTraces: true, telemetryTraceSampleRatio: 1, telemetryMaxSpansPerTrace: 1000, telemetrySlowSpanMs: 0, telemetryEnvironment: "" });
    expect(resolveTraces(mergeWithDefaults({}), {}, base)).toBeNull();
    expect(resolveTraces({ ...s, telemetryTraces: false }, {}, base)).toBeNull();
    expect(resolveTraces(s, {}, base)).toEqual({
      otlp: { endpoint: "http://127.0.0.1:4318", serviceName: "datanotes", serviceVersion: "9", protocol: "http/protobuf", headers: {}, resource: { "service.instance.id": "x" } },
      sampleRatio: 1,
      maxSpansPerTrace: 1000,
      slowSpanMs: 0,
    });
    const env = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otlp.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_SERVICE_NAME: "vault",
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "0.25",
      OTEL_RESOURCE_ATTRIBUTES: "team=home",
    };
    expect(resolveTraces({ ...s, telemetryEnabled: false }, env, base)).toMatchObject({
      otlp: { endpoint: "https://otlp.example.com", serviceName: "vault", protocol: "http/json", resource: { "service.instance.id": "x", team: "home" } },
      sampleRatio: 0.25,
    });
    expect(resolveTraces(s, { OTEL_TRACES_EXPORTER: "none" }, base)).toBeNull();
    expect(resolveTraces(s, { OTEL_SDK_DISABLED: "true" }, base)).toBeNull();
    const m = mergeWithDefaults({ telemetryTraceSampleRatio: 0.1, telemetryMaxSpansPerTrace: 50, telemetrySlowSpanMs: 500, telemetryEnvironment: " dev ", telemetryTraces: false });
    expect(m).toMatchObject({ telemetryTraceSampleRatio: 0.1, telemetryMaxSpansPerTrace: 50, telemetrySlowSpanMs: 500, telemetryEnvironment: "dev", telemetryTraces: false });
    const bad = mergeWithDefaults({ telemetryTraceSampleRatio: 2, telemetryMaxSpansPerTrace: 0.5, telemetrySlowSpanMs: -1, telemetryEnvironment: 3 as never, telemetryTraces: "yes" as never });
    expect(bad).toMatchObject({ telemetryTraceSampleRatio: 1, telemetryMaxSpansPerTrace: 1000, telemetrySlowSpanMs: 0, telemetryEnvironment: "", telemetryTraces: true });
    expect(resolveTraces({ telemetryEnabled: true, telemetryEndpoint: "http://c", telemetryServiceName: "d" }, {}, base)).toMatchObject({ sampleRatio: 1, maxSpansPerTrace: 1000, slowSpanMs: 0, otlp: { protocol: "http/protobuf", headers: {} } });
  });

  it("names the service's namespace, environment, host and process", () => {
    expect(engineResource({ telemetryEnvironment: "dev" }, "service", 42, "box")).toEqual({
      "service.namespace": "datanotes",
      "service.instance.id": expect.stringMatching(/^service-[0-9a-f-]{36}$/),
      "host.name": "box",
      "process.pid": 42,
      "deployment.environment.name": "dev",
      "deployment.environment": "dev",
    });
    expect(engineResource({}, "service")["deployment.environment"]).toBeUndefined();
  });

  it("the sink follows the configuration, read at most once a second", async () => {
    let t = 0;
    let config: ReturnType<typeof resolveTraces> = resolveTraces({ ...s, telemetryProtocol: "http/json" }, {}, base);
    const sent: string[] = [];
    const sink = new TraceSink(() => config, async (url) => void sent.push(url), () => t);
    expect([sink.sent, sink.dropped]).toEqual([0, 0]);
    const span: SpanData = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "x", kind: "internal", startMs: 1, endMs: 2, attributes: {}, events: [], status: { code: "unset" }, droppedAttributes: 0, droppedEvents: 0 };
    sink.export([span]);
    await sink.flush();
    expect(sent).toEqual(["http://127.0.0.1:4318/v1/traces"]);
    expect(sink.sent).toBe(1);
    config = null;
    expect(sink.current()).not.toBeNull(); // not read again within the second
    t += 1000;
    expect(sink.current()).toBeNull();
    sink.export([span]);
    await sink.flush();
    await sink.close();
    expect(sent).toHaveLength(1);
    expect([sink.sent, sink.dropped]).toEqual([0, 0]);
    // without a transport of its own, the exporter posts with fetch
    expect(new TraceSink(() => resolveTraces(s, {}, base)).current()).not.toBeNull();
    const off = new TraceSink(() => null);
    await off.close();
    expect([off.sent, off.dropped]).toEqual([0, 0]);
  });

  it("installTracing wires the sink to the tracer; a span that ends after traces went off logs nothing slow", async () => {
    let t = 0;
    let config: ReturnType<typeof resolveTraces> = { ...resolveTraces({ ...s, telemetryProtocol: "http/json" }, {}, base)!, slowSpanMs: 1 };
    const bodies: string[] = [];
    const sink = new TraceSink(() => config, async (_u, b) => void bodies.push(b as string), () => t);
    const logs: string[] = [];
    setTelemetry({ log: (_sev, body) => logs.push(body), flush: async () => {} });
    installTracing(sink);
    expect(tracingOn()).toBe(true);
    await withSpan("slow", { root: true }, () => new Promise((r) => setTimeout(r, 5)));
    expect(logs).toEqual(["datanotes slow span"]);
    const late = startSpan("late", { root: true });
    config = null;
    t += 1000;
    late.end();
    expect(startSpan("none", { root: true })).toBe(NOOP_SPAN);
    await sink.flush();
    expect(bodies.join("")).toContain('"name":"slow"');
    expect(logs).toEqual(["datanotes slow span"]);
    installTracing(null);
    expect(tracingOn()).toBe(false);
  });
});
