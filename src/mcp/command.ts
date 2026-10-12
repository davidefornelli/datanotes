/**
 * `datanotes mcp`: the MCP server of Datanotes, a process of its own that reaches the engine only
 * through its HTTP API (src/api), never in process: the engine does not serve MCP itself.
 *
 *   datanotes mcp --vault <folder>                  stdio, for an MCP client on this computer: uses
 *                                                   the engine running on the vault, or starts one
 *   datanotes mcp --url <engine> --token-file <f>   stdio, to an engine at an address
 *   datanotes mcp serve [--port 27151] [--host 127.0.0.1] [--url http://127.0.0.1:27150]
 *                                                   Streamable HTTP at /mcp, each agent with its own token
 *
 * Both modes offer every tool except the webhook tools, which `--owner-tools` adds; `--profile`,
 * `--tools` and `--except` choose others (selection.ts). An engine started for a stdio session is
 * stopped at its end as `datanotes stop` does (POST /datanotes/stop/), and killed only when it
 * does not stop.
 *
 * Logs go to OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT (or --otlp-endpoint) is set (log.ts).
 * Everything the process owns (streams, environment, exit, signals) comes in `McpIo`, so the
 * command also runs inside the tests.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { folderArg, readOptions, type Options } from "../api/cli-options";
import { DatanotesClient } from "../api/client";
import { findDocsDir, openDocs } from "../api/docs";
import { localEngine } from "../api/local";
import { mcpHelp } from "./help";
import { startHttp } from "./http";
import { closeExporter, exporterFromEnv, noLog, type Log } from "./log";
import { envFlag, selectTools, ToolSelectionError } from "./selection";
import { createSession } from "./server";
import { Toolbox } from "./tools";

export type Signal = "SIGINT" | "SIGTERM";

export interface McpIo {
  /** stdio mode: MCP messages in and out. stdout carries nothing else. */
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: Record<string, string | undefined>;
  /** The `datanotes` command (program and arguments): `serve --vault <folder>` is added to start an engine. */
  engineCommand: string[];
  exit(code: number): void;
  onSignal(signal: Signal, handler: () => void): void;
}

/** A running server: `stop` ends it as a signal would (and exits). */
export interface McpRun {
  mode: "stdio" | "http";
  /** stdio: the engine's address; http: the MCP endpoint. */
  url: string;
  /** stdio: the engine started for this session, if any. */
  child: ChildProcess | null;
  stop(): Promise<void>;
}

const DEFAULT_ENGINE = "http://127.0.0.1:27150";
const DEFAULT_PORT = "27151";

/** How long `datanotes mcp` waits for the engine it started to stop, before it kills it. */
export const ENGINE_STOP_TIMEOUT_MS = 35_000;

/** The options that choose the tools (selection.ts), in both modes. */
const TOOL_OPTIONS = { values: ["profile", "tools", "except"], flags: ["owner-tools"] };

/** The options of `datanotes mcp` (stdio) and `datanotes mcp serve` (Streamable HTTP). */
export const STDIO_OPTIONS = { values: ["vault", "database", "url", "token-file", "otlp-endpoint", ...TOOL_OPTIONS.values], flags: TOOL_OPTIONS.flags };
export const SERVE_OPTIONS = { values: ["url", "host", "port", "otlp-endpoint", ...TOOL_OPTIONS.values], flags: TOOL_OPTIONS.flags };

/** The tools to offer, from the options or the environment (DATANOTES_MCP_PROFILE, ...). */
function toolsOf(o: Options, env: Record<string, string | undefined>): string[] {
  const fromEnv = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v);
  return selectTools({
    profile: o.get("profile") ?? fromEnv(env.DATANOTES_MCP_PROFILE),
    tools: o.get("tools") ?? fromEnv(env.DATANOTES_MCP_TOOLS),
    except: o.get("except") ?? fromEnv(env.DATANOTES_MCP_EXCEPT),
    ownerTools: o.has("owner-tools") || envFlag(env, "DATANOTES_MCP_OWNER_TOOLS"),
  });
}

/**
 * Stop the engine this session started: ask it to stop (`POST /datanotes/stop/` with the owner's
 * token), as `datanotes stop` does, so it finishes its writes, syncs and releases the vault; kill
 * it only when it does not answer or is still running after `timeoutMs`. On Windows a kill ends the
 * process at once, with no chance to clean up.
 */
export async function stopEngine(child: ChildProcess, engine: { url: string; token: string }, timeoutMs = ENGINE_STOP_TIMEOUT_MS): Promise<"stopped" | "killed"> {
  if (child.exitCode !== null || child.signalCode !== null) return "stopped";
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let asked = false;
  try {
    await new DatanotesClient({ url: engine.url, token: engine.token }).post("/stop/", {});
    asked = true;
  } catch {
    // not answering, or refusing: only a kill stops it
  }
  if (asked) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), timeoutMs)));
    const outcome = await Promise.race([exited.then(() => "exited" as const), late]);
    clearTimeout(timer);
    if (outcome === "exited") return "stopped";
  }
  if (child.exitCode !== null || child.signalCode !== null) return "stopped";
  child.kill();
  return "killed";
}

/** How long `datanotes mcp --database` waits for the engine it starts, by default, s. */
export const ENGINE_START_TIMEOUT_S = 60;

/**
 * The wait for the engine `datanotes mcp --database` starts, ms: DATANOTES_ENGINE_START_TIMEOUT_S
 * seconds (a large database starts slowly: about 20 s for 10,000 notes on Windows), else the
 * default. A value that is not a positive number of seconds is the default.
 */
export function engineStartTimeoutMs(env: Record<string, string | undefined>): number {
  const s = Number(env.DATANOTES_ENGINE_START_TIMEOUT_S);
  return (Number.isFinite(s) && s > 0 ? s : ENGINE_START_TIMEOUT_S) * 1000;
}

/**
 * Start `datanotes serve` on the vault and wait until it holds the vault (its lock and token) and
 * its HTTP server answers: the lock is written before the server listens.
 */
export async function startEngine(vault: string, command: string[], timeoutMs = ENGINE_START_TIMEOUT_S * 1000, pollMs = 500, atRoot = false): Promise<{ engine: { url: string; token: string }; child: ChildProcess }> {
  const [program, ...args] = command;
  const child = spawn(program!, [...args, "serve", atRoot ? "--database" : "--vault", vault], { stdio: ["ignore", "ignore", "inherit"] });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = localEngine(vault);
    if (found && (await new DatanotesClient({ url: found.url, token: found.token }).ping())) return { engine: found, child };
    if (child.exitCode !== null) throw new Error(`the engine stopped (exit ${child.exitCode})`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(
        `the engine did not start within ${Math.round(timeoutMs / 1000)} s: a large database takes longer; ` +
          `wait longer with DATANOTES_ENGINE_START_TIMEOUT_S (seconds), or run datanotes serve as a service ` +
          `(https://datanotes.dev/administration/limits.md#start-the-engine-before-the-agent)`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

type Exit = (code: number) => void;

async function stdio(argv: string[], version: string, io: McpIo, log: Log, exit: Exit): Promise<McpRun> {
  const o = readOptions(argv, STDIO_OPTIONS, "datanotes mcp");
  // the tools first: a wrong name is refused before an engine is started
  const tools = toolsOf(o, io.env);
  const explicitUrl = o.get("url") !== undefined || o.get("token-file") !== undefined;
  if ((o.get("vault") !== undefined || o.get("database") !== undefined) && explicitUrl) throw new Error("pass --database (or --vault), or --url with --token-file, not both (datanotes mcp --help)");
  // an engine named on the command line wins over the environment's folder: its token is the one meant
  const folder = explicitUrl ? null : folderArg(o, io.env, "datanotes mcp", false);
  const vault = folder?.folder;
  let engine: { url: string; token: string };
  let child: ChildProcess | null = null;
  if (vault) {
    const root = path.resolve(vault);
    let found = localEngine(root);
    // an engine starting on any free port (port 0 in its lock) is waited for until it listens
    for (let i = 0; found?.lock.port === 0 && i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      found = localEngine(root);
    }
    if (found && found.lock.port !== 0) engine = found;
    else ({ engine, child } = await startEngine(root, io.engineCommand, engineStartTimeoutMs(io.env), undefined, folder!.atRoot));
    io.stderr.write(`datanotes mcp: ${child ? "started an engine on" : "using the engine on"} ${root} (${engine.url})\n`);
  } else {
    const url = o.get("url") ?? io.env.DATANOTES_URL;
    const tokenFile = o.get("token-file") ?? io.env.DATANOTES_TOKEN_FILE;
    const token = (tokenFile ? fs.readFileSync(path.resolve(tokenFile), "utf8") : (io.env.DATANOTES_TOKEN ?? "")).trim();
    if (!url || !token) throw new Error("pass --database <folder> (or --vault <folder>), or --url <engine> with --token-file <file> (datanotes mcp --help)");
    engine = { url, token };
  }
  const toolbox = new Toolbox(engine.url, log, openDocs(findDocsDir(io.env)), tools);
  const sessionId = randomUUID();
  const session = createSession({ toolbox, instructions: toolbox.instructions(), token: () => engine.token, version, session: sessionId });
  const transport = new StdioServerTransport(io.stdin, io.stdout);
  log("INFO", `datanotes mcp ${version} started (stdio) -> ${engine.url}`, { mode: "stdio", engine: engine.url, version, engine_started: Boolean(child), session: sessionId.slice(0, 16) });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const engineStop = child ? await stopEngine(child, engine) : null;
    if (engineStop === "killed") io.stderr.write(`datanotes mcp: the engine did not stop within ${ENGINE_STOP_TIMEOUT_MS / 1000} s: killed it\n`);
    log(engineStop === "killed" ? "WARN" : "INFO", "datanotes mcp stopped (stdio)", { mode: "stdio", session: sessionId.slice(0, 16), ...(engineStop ? { engine_stop: engineStop } : {}) });
    exit(0);
  };
  io.stdin.on("end", () => void stop());
  for (const sig of ["SIGINT", "SIGTERM"] as const) io.onSignal(sig, () => void stop());
  await session.connect(transport);
  return { mode: "stdio", url: engine.url, child, stop };
}

async function serve(argv: string[], version: string, io: McpIo, log: Log, exit: Exit): Promise<McpRun> {
  const o = readOptions(argv, SERVE_OPTIONS, "datanotes mcp serve");
  const engine = o.get("url") ?? io.env.DATANOTES_URL ?? DEFAULT_ENGINE;
  const host = o.get("host") ?? io.env.DATANOTES_MCP_HOST ?? "127.0.0.1";
  const port = Number(o.get("port") ?? io.env.DATANOTES_MCP_PORT ?? DEFAULT_PORT);
  const tools = toolsOf(o, io.env);
  const srv = await startHttp({ toolbox: new Toolbox(engine, log, openDocs(findDocsDir(io.env)), tools), host, port, version });
  const listen = `http://${host}:${srv.port}/mcp`;
  io.stdout.write(`datanotes mcp ${version}: ${listen} -> ${engine}\n`);
  log("INFO", `datanotes mcp ${version} started (http) at ${listen} -> ${engine}`, { mode: "http", engine, listen, version });
  let stopping = false;
  const stop = async (signal = "stop") => {
    if (stopping) return;
    stopping = true;
    await srv.close();
    log("INFO", `datanotes mcp stopped (http, ${signal})`, { mode: "http", signal });
    exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) io.onSignal(sig, () => void stop(sig));
  return { mode: "http", url: listen, child: null, stop: () => stop() };
}

/**
 * Run `datanotes mcp <argv>`. Help and version print and return; the servers return once they
 * listen (null on failure: the error is printed and logged, and the exit code is 1).
 */
export async function mcp(argv: string[], version: string, io: McpIo): Promise<McpRun | null> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    io.stdout.write(`${version}\n`);
    return null;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(`${mcpHelp(version)}\n`);
    return null;
  }
  const otlp = argv.find((a, i) => a.startsWith("--otlp-endpoint=") || argv[i - 1] === "--otlp-endpoint");
  const exporter = exporterFromEnv(io.env, version, otlp?.replace(/^--otlp-endpoint=/, ""));
  const log: Log = exporter ? exporter.log.bind(exporter) : noLog;
  // the exporter's last records are sent before every exit
  const exit: Exit = (code) => void closeExporter(exporter).then(() => io.exit(code));
  try {
    if (command === "serve") return await serve(rest, version, io, log, exit);
    if (!command || command.startsWith("--")) return await stdio(argv, version, io, log, exit);
    throw new Error(`unknown command "${command}" (datanotes mcp --help)`);
  } catch (e) {
    const message = (e as Error).message;
    const hint = (e as { hint?: unknown }).hint;
    // a wrong tool selection ends with the page that explains the options
    const docs = e instanceof ToolSelectionError ? `Docs: ${e.docs}\n` : "";
    io.stderr.write(`datanotes mcp: ${message}\n${typeof hint === "string" ? `${hint}\n` : ""}${docs}`);
    log("ERROR", `datanotes mcp failed: ${message}`, { error: message.slice(0, 300) });
    exit(1);
    return null;
  }
}
