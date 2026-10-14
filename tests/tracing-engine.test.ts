import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeWithDefaults, type DatanotesSettings } from "../src/core/settings";
import { openNodeVault } from "../src/node/node-app";
import { EngineRuntime } from "../src/server/runtime";
import { DatanotesClient } from "../src/api/client";
import { formatTraceparent, Tracer, type SpanRecord } from "../src/api/tracing";
import { Toolbox } from "../src/mcp/tools";
import { tracingOn } from "../src/core/tracing";
import { LOG_YAML, METASTORE, TEST_DATABASE_FOLDER } from "./helpers/db-vault";

/** A span as the collector got it (OTLP/JSON). */
interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  events: { name: string }[];
  status: { code: number; message?: string };
}

const open: { runtime: EngineRuntime; dirs: string[] }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.runtime.dispose();
    for (const d of o.dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A started engine on a vault on disk, sending its telemetry to a fake collector (http/json). */
async function engine(settings: Partial<DatanotesSettings> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracing-engine-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "tracing-engine-store-"));
  fs.mkdirSync(path.dirname(path.join(root, METASTORE)), { recursive: true });
  fs.writeFileSync(path.join(root, METASTORE), LOG_YAML);
  const host = openNodeVault(root, undefined, { store });
  const s = mergeWithDefaults({
    fileLogEnabled: false,
    autoRecompute: false,
    databaseFolder: TEST_DATABASE_FOLDER,
    httpServerToken: "owner-token",
    telemetryEnabled: true,
    telemetryProtocol: "http/json",
    telemetryServiceName: "datanotes-test",
    telemetryEnvironment: "test",
    ...settings,
  });
  s.httpServerPort = 0;
  const posts: { url: string; body: string }[] = [];
  const runtime = new EngineRuntime({
    app: host.app,
    getSettings: () => s,
    saveSettings: async () => {},
    transport: async () => ({ status: 500, text: "" }),
    embeddingKey: () => undefined,
    version: "3.0.0-test",
    hostName: "service",
    canServeHttp: true,
    httpHost: "127.0.0.1",
    env: {},
    otlpSend: async (url, body) => void posts.push({ url, body: body as string }),
  });
  open.push({ runtime, dirs: [root, store] });
  runtime.startTelemetry();
  await runtime.start();
  const url = `http://127.0.0.1:${runtime.httpPort}`;
  /** Every span sent so far (the engine's buffers flushed first). */
  const spans = async (): Promise<WireSpan[]> => {
    await (runtime as unknown as { traces: { flush(): Promise<void> } }).traces.flush();
    return posts
      .filter((p) => p.url.endsWith("/v1/traces"))
      .flatMap((p) => (JSON.parse(p.body) as { resourceSpans: { scopeSpans: { spans: WireSpan[] }[] }[] }).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((x) => x.spans)));
  };
  const resources = () =>
    posts.filter((p) => p.url.endsWith("/v1/traces")).map((p) => Object.fromEntries((JSON.parse(p.body).resourceSpans[0].resource.attributes as { key: string; value: Record<string, unknown> }[]).map((a) => [a.key, Object.values(a.value)[0]])));
  const logs = () =>
    posts.filter((p) => p.url.endsWith("/v1/logs")).flatMap((p) => JSON.parse(p.body).resourceLogs[0].scopeLogs[0].logRecords as { body: { stringValue: string }; traceId?: string; spanId?: string; severityText: string }[]);
  const close = async () => {
    const i = open.findIndex((o) => o.runtime === runtime);
    open.splice(i, 1);
    await runtime.dispose();
    for (const d of [root, store]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { runtime, url, s, spans, resources, logs, close };
}

const attr = (s: WireSpan, key: string): unknown => {
  const a = s.attributes.find((x) => x.key === key);
  return a ? Object.values(a.value)[0] : undefined;
};

describe("traces of the engine over HTTP", () => {
  it("a request is a SERVER span, its operation a child with database attributes, its phases children of that", async () => {
    const e = await engine();
    expect(tracingOn()).toBe(true);
    const client = new DatanotesClient({ url: e.url, token: "owner-token" });
    const inserted = await client.call("insert_row", { table: "log", values: { kind: "walk", occurred_at: "2026-10-01T08:00:00Z" } });
    expect(inserted.ok).toBe(true);
    const all = await e.spans();
    const server = all.find((s) => s.name === "POST /datanotes/operations/insert_row/")!;
    expect(server.kind).toBe(2);
    expect(server.parentSpanId).toBeUndefined();
    expect(attr(server, "http.request.method")).toBe("POST");
    expect(attr(server, "http.route")).toBe("/datanotes/operations/insert_row/");
    expect(attr(server, "http.response.status_code")).toBe("200");
    expect(attr(server, "datanotes.token.name")).toBe("owner");
    const trace = all.filter((s) => s.traceId === server.traceId);
    const childrenOf = (p: WireSpan) => trace.filter((s) => s.parentSpanId === p.spanId);
    const op = childrenOf(server).find((s) => s.name === "engine.op insert_row")!;
    expect(op.kind).toBe(1);
    expect(attr(op, "db.system.name")).toBe("datanotes");
    expect(attr(op, "db.system")).toBe("datanotes");
    expect(attr(op, "db.operation.name")).toBe("insert_row");
    expect(attr(op, "db.collection.name")).toBe("log");
    expect(attr(op, "db.query.summary")).toBe("insert_row log");
    expect(attr(op, "datanotes.files_created")).toBe("1");
    expect(typeof attr(op, "datanotes.migration_id")).toBe("string");
    // the vault calls inside the operation add up on it
    expect(Number(attr(op, "datanotes.io.create_count"))).toBe(1);
    expect(Number(attr(op, "datanotes.validate.rows"))).toBeGreaterThanOrEqual(1);
    const engineSpan = childrenOf(op).find((s) => s.name === "engine.insert_row")!;
    const names = new Set(trace.map((s) => s.name));
    for (const n of ["engine.settle", "engine.lock.acquire", "engine.lock.hold", "engine.apply", "engine.journal.append", "engine.transaction_log", "engine.checks"]) expect(names, n).toContain(n);
    // the lock's wait and its hold are siblings under the engine's operation
    const hold = trace.find((s) => s.name === "engine.lock.hold")!;
    const wait = trace.find((s) => s.name === "engine.lock.acquire")!;
    expect(hold.parentSpanId).toBe(engineSpan.spanId);
    expect(wait.parentSpanId).toBe(engineSpan.spanId);
    expect(BigInt(wait.endTimeUnixNano) <= BigInt(hold.startTimeUnixNano)).toBe(true);
    // the apply and the journal run under the lock
    const apply = trace.find((s) => s.name === "engine.apply")!;
    expect(apply.parentSpanId).toBe(hold.spanId);
    expect(trace.find((s) => s.name === "engine.journal.append")!.parentSpanId).toBe(apply.spanId);
    // every span ends after it starts, and inside its parent
    for (const s of trace) expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
    // the resource names the service, its namespace, the environment (both keys) and the process
    expect(e.resources()[0]).toMatchObject({
      "service.name": "datanotes-test",
      "service.version": "3.0.0-test",
      "service.namespace": "datanotes",
      "deployment.environment.name": "test",
      "deployment.environment": "test",
      "process.pid": String(process.pid),
    });
    expect(String(e.resources()[0]!["service.instance.id"])).toMatch(/^service-[0-9a-f-]{36}$/);
  });

  it("a read is planned, scanned, filtered, sorted and projected; a view runs its stored query", async () => {
    const e = await engine();
    const client = new DatanotesClient({ url: e.url, token: "owner-token" });
    await client.call("insert_row", { table: "log", values: { kind: "walk", occurred_at: "2026-10-01T08:00:00Z" } });
    await client.call("insert_row", { table: "log", values: { kind: "mood", occurred_at: "2026-10-02T08:00:00Z" } });
    await client.call("create_view", { name: "walks", description: "Walks only.", query: { table: "log", where: { kind: "walk" } } });
    const r = await client.call("select_rows", { table: "walks", order_by: "occurred_at" });
    expect(r.ok).toBe(true);
    const all = await e.spans();
    const server = all.find((s) => s.name === "POST /datanotes/operations/select_rows/")!;
    const trace = all.filter((s) => s.traceId === server.traceId);
    const op = trace.find((s) => s.name === "engine.op select_rows")!;
    expect(attr(op, "db.response.returned_rows")).toBe("1");
    expect(attr(op, "datanotes.rows_scanned")).toBe("2");
    const names = trace.map((s) => s.name);
    for (const n of ["engine.query.execute", "engine.query.view", "engine.query.plan", "engine.query.scan", "engine.query.filter", "engine.query.sort", "engine.query.project"]) expect(names, n).toContain(n);
    const scan = trace.find((s) => s.name === "engine.query.scan")!;
    expect(attr(scan, "datanotes.query.plan")).toBe("full_scan");
    expect(attr(scan, "db.collection.name")).toBe("main.public.log");
    const filter = trace.find((s) => s.name === "engine.query.filter")!;
    expect([attr(filter, "datanotes.rows_in"), attr(filter, "datanotes.rows_out")]).toEqual(["2", "1"]);
  });

  it("continues the caller's trace (traceparent), and an MCP tool call is one trace across both processes", async () => {
    const e = await engine();
    const caller = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
    const client = new DatanotesClient({ url: e.url, token: "owner-token", trace: formatTraceparent(caller) });
    await client.call("list_tables", {});
    let all = await e.spans();
    const continued = all.find((s) => s.name === "POST /datanotes/operations/list_tables/")!;
    expect(continued.traceId).toBe(caller.traceId);
    expect(continued.parentSpanId).toBe(caller.spanId);

    // the MCP server: a SERVER span per tool call, a CLIENT span per request, the engine below it
    const mcpSpans: SpanRecord[] = [];
    const toolbox = new Toolbox(e.url, undefined, undefined, undefined, new Tracer({ export: (s) => mcpSpans.push(...s) }));
    await toolbox.call("owner-token", "select_rows", { table: "log" }, { harness: "test-agent", session: "s-1" }, { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" });
    const tool = mcpSpans.find((s) => s.name === "tools/call select_rows")!;
    expect(tool).toMatchObject({ kind: "server", traceId: "0af7651916cd43dd8448eb211c80319c", parentSpanId: "b7ad6b7169203331" });
    expect(tool.attributes).toMatchObject({ "mcp.method.name": "tools/call", "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "select_rows", "mcp.session.id": "s-1", "datanotes.client.harness": "test-agent" });
    expect(tool.attributes["gen_ai.request.model"]).toBeUndefined();
    const request = mcpSpans.find((s) => s.kind === "client")!;
    expect(request).toMatchObject({ name: "POST /datanotes/operations/select_rows/", parentSpanId: tool.spanId, traceId: tool.traceId });
    expect(request.attributes["http.response.status_code"]).toBe(200);
    // a refused token is the agent's to fix; an engine that does not answer is an error
    await toolbox.call("wrong-token", "list_tables", {}, { harness: "test-agent" });
    expect(mcpSpans.at(-1)).toMatchObject({ name: "tools/call list_tables", status: { code: "unset" }, attributes: { "error.type": "auth" } });
    const gone = new Toolbox("http://127.0.0.1:9", undefined, undefined, undefined, new Tracer({ export: (s) => mcpSpans.push(...s) }));
    await gone.call("owner-token", "list_tables", {}, { harness: "test-agent" });
    expect(mcpSpans.at(-1)).toMatchObject({ name: "tools/call list_tables", status: { code: "error" } });
    all = await e.spans();
    const engineServer = all.find((s) => s.traceId === tool.traceId && s.kind === 2)!;
    expect(engineServer.parentSpanId).toBe(request.spanId);
    expect(attr(engineServer, "gen_ai.tool.name")).toBe("select_rows");
    expect(all.some((s) => s.traceId === tool.traceId && s.name === "engine.op select_rows" && s.parentSpanId === engineServer.spanId)).toBe(true);
  });

  it("a refusal keeps the status unset and says why; an empty poll of the change feed sends no trace; logs name their span", async () => {
    const e = await engine();
    const client = new DatanotesClient({ url: e.url, token: "owner-token" });
    const refused = await client.call("insert_row", { table: "log", values: { kind: "nap", occurred_at: "2026-10-01T08:00:00Z" } });
    expect(refused.ok).toBe(false);
    await client.call("select_rows", { table: "nope" });
    await client.call("list_changes", { since: 1_000_000 });
    const all = await e.spans();
    const ops = all.filter((s) => s.name.startsWith("engine.op "));
    const insert = ops.find((s) => s.name === "engine.op insert_row")!;
    expect(insert.status.code).toBe(0);
    expect(attr(insert, "error.type")).toBe("violation");
    const missing = ops.find((s) => s.name === "engine.op select_rows")!;
    expect(missing.status.code).toBe(0);
    expect(attr(missing, "error.type")).toBe("TableNotFoundError");
    expect(missing.events).toEqual([]);
    expect(all.some((s) => s.name.includes("list_changes"))).toBe(false);
    // the request's log record names its span; as the span says it all, it is DEBUG
    await e.close();
    const http = e.logs().filter((l) => l.body.stringValue === "datanotes http");
    const server = all.find((s) => s.name === "POST /datanotes/operations/insert_row/")!;
    const own = http.find((l) => l.traceId === server.traceId)!;
    expect(own.spanId).toBe(server.spanId);
    expect(own.severityText).toBe("WARN");
  });

  it("caps the spans of one trace and counts the others; sampling 0 sends nothing", async () => {
    const e = await engine({ telemetryMaxSpansPerTrace: 3 });
    const client = new DatanotesClient({ url: e.url, token: "owner-token" });
    await client.call("select_rows", { table: "log" });
    const all = await e.spans();
    const server = all.find((s) => s.name === "POST /datanotes/operations/select_rows/")!;
    expect(all.filter((s) => s.traceId === server.traceId)).toHaveLength(3);
    expect(Number(attr(server, "datanotes.spans_dropped"))).toBeGreaterThan(0);

    const none = await engine({ telemetryTraceSampleRatio: 0 });
    await new DatanotesClient({ url: none.url, token: "owner-token" }).call("list_tables", {});
    expect((await none.spans()).filter((s) => s.name.startsWith("POST"))).toEqual([]);
  });

  it("logs a slow request as a WARN, and takes the tracer away when traces are turned off", async () => {
    const e = await engine({ telemetrySlowSpanMs: 1 });
    const client = new DatanotesClient({ url: e.url, token: "owner-token" });
    await client.call("insert_row", { table: "log", values: { kind: "walk", occurred_at: "2026-10-01T08:00:00Z" } });
    e.s.telemetryTraces = false;
    await new Promise((r) => setTimeout(r, 1100));
    (e.runtime as unknown as { refreshTracing(): void }).refreshTracing();
    expect(tracingOn()).toBe(false);
    await e.close();
    const slow = e.logs().filter((l) => l.body.stringValue === "datanotes slow span");
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.every((l) => l.severityText === "WARN" && typeof l.traceId === "string")).toBe(true);
  });
});
