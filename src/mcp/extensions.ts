/**
 * The extensions installed in the database, as `datanotes mcp` offers them (both modes): loaded
 * once through `loadExtensions` of src/api/extension-host.ts, with the first token that reaches the
 * engine; their tools come after the engine's and the docs tools, their docs are mounted under
 * `extensions/<name>`, and their instructions follow the engine's. `--no-extensions` (or
 * DATANOTES_MCP_EXTENSIONS=0) leaves them out; `--profile read` keeps only their read-only tools.
 */

import { loadExtensions, type ExtensionLoad, type ExtensionToolDefinition, type LoadedExtension } from "../api/extension-host";
import type { DocsMount } from "../api/docs";
import type { Options } from "../api/cli-options";
import { ToolSelectionError } from "./selection";
import type { Log } from "./log";

export const EXTENSIONS_ENV = "DATANOTES_MCP_EXTENSIONS";

/** Extension tools are on unless --no-extensions or DATANOTES_MCP_EXTENSIONS=0/false; another value is refused. */
export function extensionsEnabled(o: Options, env: Record<string, string | undefined>): boolean {
  if (o.has("no-extensions")) return false;
  const raw = env[EXTENSIONS_ENV];
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  throw new ToolSelectionError(`${EXTENSIONS_ENV} must be 1 or 0: "${raw}"`, `Set ${EXTENSIONS_ENV}=0 to leave the extensions' tools out, or leave it unset.`);
}

/** --profile read (or DATANOTES_MCP_PROFILE=read): only the extensions' read-only tools. */
export function readOnlyProfile(o: Options, env: Record<string, string | undefined>): boolean {
  return (o.get("profile") ?? env.DATANOTES_MCP_PROFILE) === "read";
}

export interface ExtensionSetOptions {
  engineUrl: string;
  log: Log;
  readOnlyOnly: boolean;
  /** The tools the server offers already (engine and docs tools): an extension with one of them is skipped. */
  reserved: readonly string[];
  env: Record<string, string | undefined>;
  /** Where the operator reads which extensions were loaded or skipped (null: nowhere). */
  stderr?: { write(s: string): unknown } | null;
  load?: typeof loadExtensions;
}

/** The extensions of one MCP server process. */
export class ExtensionSet {
  private loaded: ExtensionLoad | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly o: ExtensionSetOptions) {}

  /** Load once, with the first token that reaches the engine; a failure is logged and tried again on the next call. Never throws. */
  async prepare(token: string): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = this.loadWith(token).finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  private async loadWith(token: string): Promise<void> {
    const { engineUrl, env, reserved, readOnlyOnly, log } = this.o;
    try {
      const load = await (this.o.load ?? loadExtensions)({ engineUrl, token, env, reserved, readOnlyOnly, log });
      this.loaded = load;
      const out = this.o.stderr;
      if (out) {
        for (const e of load.loaded) out.write(`datanotes mcp: extension ${e.name} ${e.version}: ${e.tools.length} tools\n`);
        for (const s of load.skipped) out.write(`datanotes mcp: extension ${s.name} skipped: ${s.reason}\n`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("WARN", "datanotes mcp could not load the extensions", { error: message.slice(0, 300) });
    }
  }

  tools(): ExtensionToolDefinition[] {
    return (this.loaded?.loaded ?? []).flatMap((e) => e.tools);
  }

  owner(tool: string): LoadedExtension | undefined {
    return (this.loaded?.loaded ?? []).find((e) => e.has(tool));
  }

  /** "" without extensions; else "\n\nExtensions:\n- <line>\n- <line>" (each LoadedExtension.instructions). */
  instructions(): string {
    const loaded = this.loaded?.loaded ?? [];
    return loaded.length === 0 ? "" : `\n\nExtensions:\n${loaded.map((e) => `- ${e.instructions}`).join("\n")}`;
  }

  mounts(): DocsMount[] {
    return this.loaded?.docsMounts ?? [];
  }
}
