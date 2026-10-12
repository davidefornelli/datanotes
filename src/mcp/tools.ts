/**
 * The tools of the MCP server: every operation of the Datanotes API, as `datanotes/mcp` defines
 * them from the catalogue (src/api/mcp.ts), so they always match the engine's routes. A call
 * becomes one request to the engine, made with the agent's own token and naming the agent; the
 * engine records it in its change feed. Next to them, the docs tools (list_docs, read_docs,
 * search_docs) read the documentation shipped with the package; search_docs also asks the engine
 * for its ranking by meaning when it has semantic search on. Tools of other programs belong to
 * their own MCP servers.
 */

import { DatanotesClient, DatanotesError, type ActorInfo } from "../api/client";
import { openDocs, type DocsLibrary } from "../api/docs";
import { callDocsTool, callProblem, docsTools, ENGINE_INSTRUCTIONS, engineTools, isDocsTool, offlineDocs, toolContent, type EngineTool, type EngineToolFilter, type ToolContent } from "../api/mcp";
import { redactToolCall } from "../api/redact";
import { estimateTokens } from "../api/tokens";
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
  ) {
    this.filter = only ? { only } : {};
    this.tools = [...engineTools(), ...docsTools()].filter((t) => !only || only.includes(t.name));
  }

  client(token: string): DatanotesClient {
    return new DatanotesClient({ url: this.engineUrl, token });
  }

  /** What the server tells agents at `initialize`. */
  instructions(): string {
    return ENGINE_INSTRUCTIONS;
  }

  list(): EngineTool[] {
    return this.tools;
  }

  /** Run a tool for an agent, report the call to the engine and log it (argument names only). */
  async call(token: string, name: string, args: Record<string, unknown>, actor: ActorInfo): Promise<ToolContent> {
    if (isDocsTool(name, this.filter)) return this.readDocs(token, name, args, actor);
    const client = this.client(token);
    const started = Date.now();
    let ok: boolean;
    let value: unknown;
    let unexpected = false;
    // a tool that does not exist, or arguments it does not take, never reach the engine
    const problem = callProblem(name, args, this.filter);
    try {
      ({ ok, value } = problem ? { ok: false, value: problem } : await client.call(name, args, { ...actor, tool: name }));
    } catch (e) {
      ok = false;
      value = e instanceof Error ? e.message : String(e);
      unexpected = !(e instanceof DatanotesError);
    }
    const durationMs = Date.now() - started;
    const content = offlineDocs(toolContent(ok, value));
    const returned = content.content.map((c) => c.text).join("\n");
    const resultTokens = estimateTokens(returned);
    // secrets (a webhook's) never leave for the change feed, which the store backup commits
    const recorded = redactToolCall(name, args, value);
    void client
      .recordToolCall({ tool: name, args: recorded.args, ok, duration_ms: durationMs, value: recorded.value, served_by: "engine", ...(actor.session ? { session: actor.session } : {}), result_chars: returned.length, result_tokens: resultTokens }, { ...actor, tool: name })
      .catch(() => undefined);
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
    });
    return content;
  }

  /**
   * A docs tool: answered here, from the docs of the package (nothing journaled), and logged.
   * search_docs also asks the engine for its ranking by meaning (hybrid search); without one, it
   * ranks by words alone.
   */
  private async readDocs(token: string, name: string, args: Record<string, unknown>, actor: ActorInfo): Promise<ToolContent> {
    const started = Date.now();
    const content = offlineDocs(await callDocsTool(name, args, { docs: this.docs, client: this.client(token), actor: { ...actor, tool: name } }));
    const ok = !content.isError;
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
    });
    return content;
  }
}
