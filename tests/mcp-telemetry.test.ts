import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DatanotesClient, DatanotesError } from "../src/api/client";
import { closeExporter, exporterFromEnv } from "../src/mcp/log";
import { docsTools, ENGINE_INSTRUCTIONS, engineTools } from "../src/api/mcp";
import { Toolbox } from "../src/mcp/tools";
import { collector } from "./helpers/mcp";

// The MCP server's logs (src/mcp/log.ts) and the Toolbox's record of every tool call, on a stub engine.

const TOKEN = "secret-token-0123456789";

/**
 * A Toolbox whose engine is a stub: `insert_row` succeeds, others are refused; `list_tables` finds
 * the engine unreachable, `describe_table` and `list_migrations` throw what no engine answers.
 */
class StubToolbox extends Toolbox {
  recorded: unknown[] = [];
  override client(_token: string): DatanotesClient {
    return {
      call: async (name: string) => {
        if (name === "describe_table") throw new Error("unexpected");
        if (name === "list_migrations") throw "not an error"; // eslint-disable-line no-throw-literal
        if (name === "list_tables") throw new DatanotesError("Datanotes engine unreachable", "unreachable");
        return name === "insert_row" ? { ok: true, value: { id: "a1", written: true } } : { ok: false, value: `refused — ${"x".repeat(400)}` };
      },
      recordToolCall: async (call: unknown) => {
        this.recorded.push(call);
        if (this.recorded.length === 2) throw new Error("the engine could not record it"); // ignored
      },
    } as unknown as DatanotesClient;
  }
}

describe("datanotes mcp: OTLP logs", () => {
  it("logs every tool call once, with names but no values and no token", async () => {
    const c = collector();
    const toolbox = new StubToolbox("http://engine.test", c.exporter.log.bind(c.exporter));
    const actor = { harness: "test-agent", harness_version: "1.2", session: "0123456789abcdef" };
    await toolbox.call(TOKEN, "insert_row", { table: "log", values: { kind: "very-private-value" } }, actor);
    await toolbox.call(TOKEN, "drop_table", { table: "log" }, actor);
    await toolbox.call(TOKEN, "list_tables", {}, actor);
    await toolbox.call(TOKEN, "describe_table", { table: "log" }, actor);
    await toolbox.call(TOKEN, "list_migrations", {}, { harness: "no-session" });
    const records = await c.records();
    expect(records.map((r) => [r.attributes.tool, r.severity])).toEqual([
      ["insert_row", "INFO"],
      ["drop_table", "WARN"],
      ["list_tables", "WARN"],
      ["describe_table", "ERROR"],
      ["list_migrations", "ERROR"],
    ]);
    const ok = records[0]!.attributes;
    expect(ok).toMatchObject({ tool: "insert_row", ok: true, harness: "test-agent", harness_version: "1.2", session: "0123456789abcdef", arg_names: "table,values" });
    expect(ok.duration_ms).toBeTypeOf("number");
    expect(ok.result_chars).toBe(JSON.stringify({ id: "a1", written: true }).length);
    expect(ok.result_tokens).toBeGreaterThan(0);
    expect(ok.error).toBeUndefined();
    const refused = records[1]!.attributes;
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/^refused — x+$/);
    expect(String(refused.error).length).toBe(300);
    expect(records[4]!.attributes.error).toBe("not an error");
    const all = c.bodies.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("very-private-value");
    // every call is reported to the engine, with the session when there is one
    expect(toolbox.recorded).toHaveLength(5);
    expect(toolbox.recorded[0]).toMatchObject({ tool: "insert_row", ok: true, session: "0123456789abcdef", served_by: "engine" });
    expect(toolbox.recorded[4]).not.toHaveProperty("session");
  });

  it("reports the whole call until the engine says it takes it cut, then the value cut with the result's summary", async () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, title: "x".repeat(20) })), total: 500 };
    for (const takes of [true, false]) {
      const recorded: Record<string, unknown>[] = [];
      class Engine extends Toolbox {
        override client(): DatanotesClient {
          return {
            call: async () => ({ ok: true, value: big }),
            recordToolCall: async (call: Record<string, unknown>) => {
              recorded.push(call);
              return takes ? { ok: true, takes_summary: true } : { ok: true };
            },
          } as unknown as DatanotesClient;
        }
      }
      const toolbox = new Engine("http://engine.test");
      for (let i = 0; i < 3; i++) {
        await toolbox.call(TOKEN, "select_rows", { table: "log" }, { harness: "test-agent" });
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(recorded.map((c) => typeof c.value)).toEqual(takes ? ["object", "string", "string"] : ["object", "object", "object"]);
      expect(recorded[0]!.value).toEqual(big);
      if (takes) expect(recorded[2]).toMatchObject({ value: `${JSON.stringify(big).slice(0, 1000)}…`, summary: { rows: 500, total: 500 }, result_chars: JSON.stringify(big).length });
    }
  });

  it("without a logger, logs nothing", async () => {
    const toolbox = new StubToolbox("http://engine.test");
    expect((await toolbox.call(TOKEN, "insert_row", { table: "log", values: {} }, {})).isError).toBeUndefined();
  });

  it("is configured only by an endpoint (environment or --otlp-endpoint), and posts to <endpoint>/v1/logs", async () => {
    expect(exporterFromEnv({}, "1.0.0")).toBeNull();
    await closeExporter(null);
    const got: { url?: string; key?: string; body: string }[] = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        got.push({ url: req.url, key: req.headers["api-key"] as string | undefined, body });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    try {
      const env = { OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:1/v1/logs", OTEL_EXPORTER_OTLP_HEADERS: "api-key=k1" };
      const exporter = exporterFromEnv(env, "1.1.0", `http://127.0.0.1:${port}`)!;
      exporter.log("INFO", "hello", { mode: "stdio" });
      await closeExporter(exporter);
      expect(exporter.sent).toBe(1);
      expect(got.map((g) => [g.url, g.key])).toEqual([["/v1/logs", "k1"]]);
      expect(got[0]!.body).toContain('"stringValue":"datanotes-mcp"');
      expect(got[0]!.body).toContain('"stringValue":"1.1.0"');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("datanotes mcp: the tools", () => {
  it("serves the engine's operations and the docs tools, as datanotes/mcp defines them, with the engine's instructions", () => {
    const toolbox = new Toolbox("http://engine.test");
    expect(toolbox.list()).toEqual([...engineTools(), ...docsTools()]);
    expect(toolbox.list().some((t) => "responseSchema" in t)).toBe(false);
    expect(toolbox.instructions()).toBe(ENGINE_INSTRUCTIONS);
  });
});
