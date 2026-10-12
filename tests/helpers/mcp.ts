/**
 * Helpers of the MCP server's tests (src/mcp, `datanotes mcp`):
 *
 * - `collector()`: an OTLP collector in memory (an exporter whose `send` keeps the bodies), with
 *   the records decoded;
 * - `fakeIo()`: the process of `datanotes mcp` (streams, environment, exit, signals) for running
 *   the command in the test's own process;
 * - `StreamClientTransport`: an MCP client transport over a pair of streams, the client end of
 *   the stdio transport of `fakeIo()`.
 */

import { PassThrough, type Readable, type Writable } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { OtlpLogExporter } from "../../src/api/otlp";
import type { McpIo, Signal } from "../../src/mcp/command";

export interface LogRecord {
  severity: string;
  body: string;
  attributes: Record<string, string | number | boolean>;
}

type OtlpValue = { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };

export function collector(): { exporter: OtlpLogExporter; bodies: string[]; records: () => Promise<LogRecord[]> } {
  const bodies: string[] = [];
  const exporter = new OtlpLogExporter({ endpoint: "http://collector.test", serviceName: "datanotes-mcp", serviceVersion: "test", protocol: "http/json", flushMs: 0, send: async (_url, body) => void bodies.push(body as string) });
  const records = async (): Promise<LogRecord[]> => {
    await exporter.flush();
    return bodies.flatMap((b) =>
      (JSON.parse(b) as { resourceLogs: { scopeLogs: { logRecords: { severityText: string; body: { stringValue: string }; attributes: { key: string; value: OtlpValue }[] }[] }[] }[] }).resourceLogs.flatMap((rl) =>
        rl.scopeLogs.flatMap((sl) =>
          sl.logRecords.map((r) => ({
            severity: r.severityText,
            body: r.body.stringValue,
            attributes: Object.fromEntries(r.attributes.map(({ key, value: v }) => [key, v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : (v.doubleValue ?? v.boolValue!))])),
          })),
        ),
      ),
    );
  };
  return { exporter, bodies, records };
}

export interface FakeIo extends McpIo {
  stdin: PassThrough;
  stdout: PassThrough;
  /** What was written to stdout (outside stdio mode) and stderr. */
  out(): string;
  err(): string;
  /** Exit codes asked for, in order. */
  exits: number[];
  /** Run the handlers registered for a signal. */
  signal(sig: Signal): void;
}

export function fakeIo(env: Record<string, string | undefined> = {}, engineCommand: string[] = [process.execPath, "-e", "process.exit(9)"]): FakeIo {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  const keepOut = (c: Buffer) => void (out += c.toString());
  stdout.on("data", keepOut);
  stderr.on("data", (c: Buffer) => void (err += c.toString()));
  const handlers: [Signal, () => void][] = [];
  const exits: number[] = [];
  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    env,
    engineCommand,
    exit: (code) => void exits.push(code),
    onSignal: (sig, h) => void handlers.push([sig, h]),
    out: () => out,
    err: () => err,
    exits,
    signal: (sig) => handlers.filter(([s]) => s === sig).forEach(([, h]) => h()),
  };
}

/** The client end of a stdio MCP server whose stdin is `toServer` and stdout `fromServer`. */
export class StreamClientTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly toServer: Writable,
    private readonly fromServer: Readable,
  ) {}

  async start(): Promise<void> {
    this.fromServer.removeAllListeners("data");
    this.fromServer.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let m = this.buffer.readMessage(); m; m = this.buffer.readMessage()) this.onmessage?.(m);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.toServer.end();
    this.onclose?.();
  }
}
