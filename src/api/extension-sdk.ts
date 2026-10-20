/**
 * The module API of Datanotes extensions, version 1 (`"api": 1` in datanotes-extension.json): what an
 * extension's entry file exports and what its tool handlers get. The MCP server that loads the extension
 * (`datanotes mcp`, DatanotesOS) builds the context; the extension never sees a token.
 */

/** The version of this module API: an entry file exports `api: 1`. */
export const EXTENSION_API_VERSION = 1;

/** The agent that called a tool, as its MCP server knows it. */
export interface ExtensionActor {
  /** The MCP session (16 characters). */
  session?: string;
  /** The app running the agent ("claude-code"). */
  harness?: string;
  harness_version?: string;
  /** The model id, when the agent named it (DatanotesOS start_session). */
  model?: string;
}

/** What an engine operation answered: `ok` and the answer, or the refusal's text (with its Hint and Docs lines). */
export interface ExtensionCallResult {
  ok: boolean;
  value: unknown;
}

/** What a tool handler gets. */
export interface ExtensionContext {
  /** Run an engine operation (select_rows, insert_row, batch, …) with the extension's own token, on behalf of the agent. Never throws for a refusal. */
  callTool(operation: string, args: Record<string, unknown>): Promise<ExtensionCallResult>;
  /** The agent that called the tool. */
  actor(): ExtensionActor;
  /** The MCP session of the call, when there is one. */
  readonly session?: string;
  /** The qualified name of the table bound to a role of the manifest; throws for a role the manifest does not have. */
  table(role: string): string;
  /** The name, in the bound table, of a role's column: the user's mapping, else the manifest's name. */
  column(role: string, column: string): string;
  /** Whether the bound table has the role's column (an optional column of a table the extension depends on may be missing). */
  hasColumn(role: string, column: string): boolean;
  /** The database's time zone (IANA name), "" when it has none. */
  readonly timezone: string;
  /** A log record through the MCP server's log: a constant message, the variable parts as attributes; never argument values or tokens. */
  log(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, attributes?: Record<string, string | number | boolean>): void;
  readonly extension: { readonly name: string; readonly version: string };
}

/** A tool's handler: the agent's arguments (checked against the tool's input schema first) and the context. Its answer goes to the agent as JSON. */
export type ExtensionHandler = (args: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;

/** What an entry file exports as default. */
export interface ExtensionModule {
  api: 1;
  handlers: Record<string, ExtensionHandler>;
}

/**
 * A refusal the agent can fix: what is wrong, how to fix it (`hint`), and a page of the extension's docs
 * (`docs`: "tools#start_task", read as read_docs("extensions/<name>/tools#start_task")). The host recognises
 * it by its name, so a copy of this class bundled into the extension works too.
 */
export class ExtensionToolError extends Error {
  override readonly name = "ToolError";
  constructor(
    message: string,
    readonly hint?: string,
    readonly docs?: string,
  ) {
    super(message);
  }
}

/** The entry file's default export, typed: `export default defineExtension({ api: 1, handlers: { … } })`. */
export function defineExtension(m: ExtensionModule): ExtensionModule {
  return m;
}
