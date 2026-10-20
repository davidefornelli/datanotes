/**
 * The tools of the MCP server: every operation of the Datanotes API, as `datanotes/mcp` defines
 * them from the catalogue (src/api/mcp.ts), so they always match the engine's routes. A call
 * becomes one request to the engine, made with the agent's own token and naming the agent; the
 * engine records it in its change feed. Next to them, the docs tools (list_docs, read_docs,
 * search_docs) read the documentation shipped with the package; search_docs also asks the engine
 * for its ranking by meaning when it has semantic search on. Tools of other programs belong to
 * their own MCP servers.
 */

import { DatanotesClient, DatanotesError, type ActorInfo, type RecordedToolCall, type ToolCallRecord } from "../api/client";
import { openDocs, type DocsLibrary } from "../api/docs";
import type { ExtensionToolDefinition, LoadedExtension } from "../api/extension-host";
import { callDocsTool, callProblem, docsTools, ENGINE_INSTRUCTIONS, engineTools, isDocsTool, offlineDocs, toolContent, type EngineTool, type EngineToolFilter, type ToolContent } from "../api/mcp";
import { cutToolCall, redactToolCall } from "../api/redact";
import { estimateTokens } from "../api/tokens";
import { parseTraceparent, type TraceContext, type Tracer, type TraceSpan } from "../api/tracing";
import type { ExtensionSet } from "./extensions";
import { noLog, type Log } from "./log";

/** The engine's operations, for one engine, and the docs tools. */
export class Toolbox {
  private readonly tools: EngineTool[];
  /** The tools offered (`--profile`, `--tools`, `--except`, `--owner-tools`: selection.ts). */
  private readonly filter: EngineToolFilter;

  constructor(
    private readonly engineUrl: string,
    readonly log: Log = noLog,
    /** The docs the docs tools read (default: the package's own). */
    readonly docs: DocsLibrary = openDocs(),
    /** The names of the tools to offer (default: every one); a call to another is refused as an unknown tool. */
    only?: readonly string[],
    /** Traces (log.ts tracerFromEnv): a SERVER span per tool call, a CLIENT span per request to the engine. */
    readonly tracer: Tracer | null = null,
    /** The extensions installed in the database (extensions.ts): their tools come after these; null: none. */
    readonly extensions: ExtensionSet | null = null,
  ) {
    this.filter = only ? { only } : {};
    this.tools = [...engineTools(), ...docsTools()].filter((t) => !only || only.includes(t.name));
  }

  /** A client for the agent's token; `trace`: the tool call's span, which its requests continue. */
  client(token: string, trace?: TraceContext): DatanotesClient {
    return new DatanotesClient({ url: this.engineUrl, token, ...(this.tracer && trace ? { tracer: this.tracer, trace } : {}) });
  }

  /** The SERVER span of a tool call (OpenTelemetry MCP and GenAI conventions); continues the client's `traceparent` when it sent one. */
  private toolSpan(name: string, actor: ActorInfo, trace: CallTrace = {}): ToolSpan {
    if (!this.tracer) return NO_SPAN;
    return this.tracer.startSpan(`tools/call ${name}`, {
      kind: "server",
      parent: parseTraceparent(trace.traceparent as string, trace.tracestate as string),
      attributes: {
        "mcp.method.name": "tools/call",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "mcp.session.id": actor.session,
        "datanotes.client.harness": actor.harness,
        "datanotes.client.harness_version": actor.harness_version,
        "datanotes.client.model": actor.model,
      },
    });
  }

  /** What the server tells agents at `initialize`. */
  instructions(): string {
    return ENGINE_INSTRUCTIONS + (this.extensions?.instructions() ?? "");
  }

  /** Load the extensions, once, with a token the engine accepts (before a session's `initialize` is answered). Never throws. */
  async prepare(token: string): Promise<void> {
    await this.extensions?.prepare(token);
  }

  list(): (EngineTool | ExtensionToolDefinition)[] {
    return [...this.tools, ...(this.extensions?.tools() ?? [])];
  }

  /** Run a tool for an agent, report the call to the engine and log it (argument names only). */
  async call(token: string, name: string, args: Record<string, unknown>, actor: ActorInfo, trace?: CallTrace): Promise<ToolContent> {
    const span = this.toolSpan(name, actor, trace);
    try {
      const ext = this.extensions?.owner(name);
      if (ext) return await this.extensionCall(ext, token, name, args, actor, span);
      return await (isDocsTool(name, this.filter) ? this.readDocs(token, name, args, actor, span) : this.engineCall(token, name, args, actor, span));
    } finally {
      span.end();
    }
  }

  private async engineCall(token: string, name: string, args: Record<string, unknown>, actor: ActorInfo, span: ToolSpan): Promise<ToolContent> {
    const client = this.client(token, span.context);
    const started = Date.now();
    let ok: boolean;
    let value: unknown;
    let unexpected = false;
    let thrown: unknown = undefined;
    // a tool that does not exist, or arguments it does not take, never reach the engine
    const problem = callProblem(name, args, this.filter);
    try {
      ({ ok, value } = problem ? { ok: false, value: problem } : await client.call(name, args, { ...actor, tool: name }));
    } catch (e) {
      ok = false;
      value = e instanceof Error ? e.message : String(e);
      unexpected = !(e instanceof DatanotesError);
      thrown = e;
    }
    const durationMs = Date.now() - started;
    const content = offlineDocs(toolContent(ok, value));
    const returned = content.content.map((c) => c.text).join("\n");
    const resultTokens = estimateTokens(returned);
    // a refusal is the agent's to fix (status unset); an engine that does not answer, or an unexpected failure, is an error
    if (thrown !== undefined && (unexpected || (thrown as DatanotesError).kind === "unreachable")) span.recordException(thrown);
    else if (!ok) span.setAttribute("error.type", problem ? "invalid_arguments" : thrown !== undefined ? (thrown as DatanotesError).kind : "refused");
    span.setAttributes({ "datanotes.result_chars": returned.length, "datanotes.result_tokens": resultTokens });
    // secrets (a webhook's) never leave for the change feed, which the store backup commits
    const recorded = redactToolCall(name, args, value);
    // the report is not part of the call's trace
    void this.report(token, { tool: name, args: recorded.args, ok, duration_ms: durationMs, value: recorded.value, served_by: "engine", ...(actor.session ? { session: actor.session } : {}), result_chars: returned.length, result_tokens: resultTokens }, { ...actor, tool: name });
    this.log(ok ? "INFO" : unexpected ? "ERROR" : "WARN", `tool ${name}: ${ok ? "ok" : "failed"} (${durationMs} ms)`, {
      tool: name,
      ok,
      duration_ms: durationMs,
      result_chars: returned.length,
      result_tokens: resultTokens,
      harness: actor.harness,
      harness_version: actor.harness_version,
      session: actor.session,
      arg_names: Object.keys(args).join(","),
      error: ok ? undefined : returned.slice(0, 300),
    }, span.context);
    return content;
  }

  /**
   * A tool of an extension: run by the extension's host (extension-host.ts), which checks the
   * arguments and the client's write permission and calls the engine with the extension's own
   * token. Reported and logged as an engine call, with the client's token and `served_by` the
   * extension's.
   */
  private async extensionCall(ext: LoadedExtension, token: string, name: string, args: Record<string, unknown>, actor: ActorInfo, span: ToolSpan): Promise<ToolContent> {
    const started = Date.now();
    let ok: boolean;
    let value: unknown;
    let thrown: unknown = undefined;
    try {
      ({ ok, value } = await ext.call(name, args, { actor, clientToken: token }));
    } catch (e) {
      // the host answers refusals and failures; a throw is a bug of the host
      ok = false;
      value = e instanceof Error ? e.message : String(e);
      thrown = e;
    }
    const unexpected = thrown !== undefined;
    const durationMs = Date.now() - started;
    const content = offlineDocs(toolContent(ok, value));
    const returned = content.content.map((c) => c.text).join("\n");
    const resultTokens = estimateTokens(returned);
    if (unexpected) span.recordException(thrown);
    else if (!ok) span.setAttribute("error.type", "refused");
    span.setAttributes({ "datanotes.result_chars": returned.length, "datanotes.result_tokens": resultTokens });
    const recorded = redactToolCall(name, args, value);
    void this.report(token, { tool: name, args: recorded.args, ok, duration_ms: durationMs, value: recorded.value, served_by: ext.servedBy, ...(actor.session ? { session: actor.session } : {}), result_chars: returned.length, result_tokens: resultTokens }, { ...actor, tool: name });
    this.log(ok ? "INFO" : unexpected ? "ERROR" : "WARN", `tool ${name}: ${ok ? "ok" : "failed"} (${durationMs} ms)`, {
      tool: name,
      ok,
      duration_ms: durationMs,
      result_chars: returned.length,
      result_tokens: resultTokens,
      harness: actor.harness,
      harness_version: actor.harness_version,
      session: actor.session,
      arg_names: Object.keys(args).join(","),
      served_by: ext.servedBy,
      error: ok ? undefined : returned.slice(0, 300),
    }, span.context);
    return content;
  }

  /** The engine takes a call's value cut, with its summary: it said so when it recorded a call. */
  private takesSummary = false;

  /**
   * Report a call to the engine's change feed. Once the engine has said it takes them, the
   * arguments and the value go cut, with the result's summary: a large result is not sent back
   * whole. A report that fails is lost; the call's answer is not affected.
   */
  private async report(token: string, call: ToolCallRecord, actor: ActorInfo): Promise<void> {
    try {
      const answer: Partial<RecordedToolCall> | undefined = await this.client(token).recordToolCall(this.takesSummary ? { ...call, ...cutToolCall(call) } : call, actor);
      if (answer?.takes_summary === true) this.takesSummary = true;
    } catch {
      // lost
    }
  }

  /**
   * A docs tool: answered here, from the docs of the package (nothing journaled), and logged.
   * search_docs also asks the engine for its ranking by meaning (hybrid search); without one, it
   * ranks by words alone.
   */
  private async readDocs(token: string, name: string, args: Record<string, unknown>, actor: ActorInfo, span: ToolSpan): Promise<ToolContent> {
    const started = Date.now();
    const content = offlineDocs(await callDocsTool(name, args, { docs: this.docsLibrary(), client: this.client(token, span.context), actor: { ...actor, tool: name } }));
    const ok = !content.isError;
    if (!ok) span.setAttribute("error.type", "refused");
    const returned = content.content.map((c) => c.text).join("\n");
    const durationMs = Date.now() - started;
    this.log(ok ? "INFO" : "WARN", `tool ${name}: ${ok ? "ok" : "failed"} (${durationMs} ms)`, {
      tool: name,
      ok,
      duration_ms: durationMs,
      result_chars: returned.length,
      result_tokens: estimateTokens(returned),
      harness: actor.harness,
      harness_version: actor.harness_version,
      session: actor.session,
      arg_names: Object.keys(args).join(","),
      error: ok ? undefined : returned.slice(0, 300),
    }, span.context);
    return content;
  }

  /** The package's docs, with the loaded extensions' pages under extensions/<name>. */
  private docsLibrary(): DocsLibrary {
    return this.extensions && this.extensions.mounts().length > 0 ? openDocs(this.docs.dir, this.extensions.mounts()) : this.docs;
  }
}

/** The `_meta` of a call: a client that traces sends its W3C `traceparent` (and `tracestate`) there. */
export type CallTrace = Record<string, unknown>;

/** What a tool call does with its span. */
type ToolSpan = Pick<TraceSpan, "setAttribute" | "setAttributes" | "recordException" | "end"> & { readonly context: TraceContext | undefined };

/** The span of a call while the server sends no traces. */
const NO_SPAN: ToolSpan = {
  context: undefined,
  setAttribute: () => NO_SPAN as never,
  setAttributes: () => NO_SPAN as never,
  recordException: () => NO_SPAN as never,
  end: () => undefined,
};
