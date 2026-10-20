/**
 * What an MCP server needs to offer the extensions installed in a database: read the registry,
 * verify and load each extension's code, build the context its tool handlers get (the extension's
 * own token, never the agent's), check arguments and the client's write permission, and answer
 * refusals with offline docs lines (3.0.9 of the extensions plan). `datanotes mcp` and DatanotesOS
 * both use it through `datanotes/extensions`. The engine never runs extension code.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatanotesClient, DatanotesError, type ActorInfo, type Transport } from "./client.js";
import { findDocsDir, openDocs, type DocsLibrary, type DocsMount } from "./docs.js";
import { checkToolArguments, guidedText, type InputSchema } from "./guidance.js";
import { codeDir, extensionsHome, fileSha256, readTokenFile, tokenPath } from "./extension-files.js";
import { DATA_OPERATIONS, EXT_DOCS, MANIFEST_FILE, parseManifest, satisfiesEngine, type ExtensionManifest, type ManifestTool } from "./extension-manifest.js";
import { DATABASE_ID, RECORD_COMMIT, RECORD_NAME, type ExtensionList, type InstalledExtension } from "./extension-record.js";
import { EXTENSION_API_VERSION, type ExtensionActor, type ExtensionCallResult, type ExtensionContext, type ExtensionHandler } from "./extension-sdk.js";

/** The log of the MCP server: a constant body, the variable parts as attributes. */
export type HostLog = (level: "DEBUG" | "INFO" | "WARN" | "ERROR", body: string, attributes?: Record<string, string | number | boolean>) => void;

export interface LoadOptions {
  engineUrl: string;
  /** Any token the engine accepts: reads the registry, the engine's version and time zone. */
  token: string;
  env?: Record<string, string | undefined>;
  transport?: Transport;
  /** Tool names the server already offers. */
  reserved?: readonly string[];
  /** Only the read-only tools (datanotes mcp --profile read). */
  readOnlyOnly?: boolean;
  log?: HostLog;
}

/** A tool as MCP lists it. */
export interface ExtensionToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  _meta: { "datanotes/extension": string; "datanotes/tables": string[] };
}

/** Who calls a tool: the agent as the MCP server knows it, and the token its client connected with. */
export interface ExtensionCaller {
  actor: ExtensionActor;
  clientToken: string;
}

export interface LoadedExtension {
  readonly name: string;
  readonly version: string;
  /** "ext-<name>": the token's name, and the `served_by` of its tool calls. */
  readonly servedBy: string;
  readonly tools: ExtensionToolDefinition[];
  readonly instructions: string;
  /** Whether this server offers the tool: with readOnlyOnly, only the read-only ones. */
  has(tool: string): boolean;
  call(tool: string, args: Record<string, unknown>, caller: ExtensionCaller): Promise<{ ok: boolean; value: unknown }>;
}

export type SkipCode = "api" | "code_missing" | "code_changed" | "engine" | "token_missing" | "tool_taken" | "entry" | "handler";

export interface SkippedExtension {
  name: string;
  version: string;
  code: SkipCode;
  reason: string;
}

export interface ExtensionLoad {
  databaseId: string | null;
  loaded: LoadedExtension[];
  skipped: SkippedExtension[];
  docsMounts: DocsMount[];
}

type Attributes = Record<string, string | number | boolean>;
type Answer = { ok: boolean; value: unknown };

const noLog: HostLog = () => {};

// --- small pure helpers -----------------------------------------------------------------------------

/** Does a qualified table name match a write pattern? (The rule of the engine's named tokens.) */
export function tableAllowed(full: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith(".*")) return full.startsWith(p.slice(0, -1));
    return p === full;
  });
}

/**
 * The actor recorded for an engine call of an extension: the agent's, the tool it called, and the
 * client's token name in the harness ("claude-code via phone").
 */
export function engineActor(actor: ExtensionActor, tool: string, clientName: string | null): ExtensionActor & { tool: string } {
  const harness = actor.harness === undefined ? (clientName ?? undefined) : clientName === null || clientName === actor.harness ? actor.harness : `${actor.harness} via ${clientName}`;
  return { ...actor, tool, ...(harness !== undefined ? { harness } : {}) };
}

/** Where an extension was installed from, as the commands print it: the git URL with its ref, or the folder. */
export function sourceLabel(r: InstalledExtension): string {
  return r.source.kind === "git" ? `${r.source.url ?? ""}${r.source.ref ? `#${r.source.ref}` : ""}` : (r.source.path ?? "");
}

/** The problems of an entry file's default export against the manifest (empty: it fits). */
export function validateModule(mod: unknown, manifest: ExtensionManifest): string[] {
  if (typeof mod !== "object" || mod === null) return ["the default export is not an object"];
  const m = mod as { api?: unknown; handlers?: unknown };
  const problems: string[] = [];
  if (m.api !== EXTENSION_API_VERSION) problems.push(`api must be ${EXTENSION_API_VERSION}, not ${String(m.api)}`);
  if (typeof m.handlers !== "object" || m.handlers === null) {
    problems.push("handlers must be an object");
    return problems;
  }
  const handlers = m.handlers as Record<string, unknown>;
  for (const t of manifest.tools) {
    if (!Object.prototype.hasOwnProperty.call(handlers, t.name)) problems.push(`no handler for tool ${t.name}`);
    else if (typeof handlers[t.name] !== "function") problems.push(`handlers.${t.name} is not a function`);
  }
  return problems;
}

/** The docs library of the package with the extensions' pages mounted under `extensions/<name>/`. */
export function extensionDocs(mounts: readonly DocsMount[], dir?: string | null): DocsLibrary {
  return openDocs(dir === undefined ? findDocsDir() : dir, mounts);
}

// --- the client's token ----------------------------------------------------------------------------

/** What the engine knows of a client's token: its name and the tables it may write ("all": the owner). */
export interface ClientToken {
  name: string;
  write: readonly string[] | "all";
}

/** Asks the engine who a client's token is, and remembers the answer for a while. */
export class ClientTokens {
  private readonly cache = new Map<string, { at: number; value: ClientToken | null }>();

  constructor(
    private readonly engineUrl: string,
    private readonly transport?: Transport,
    private readonly ttlMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The token's name and write patterns; null when the engine refuses the token. */
  async describe(token: string): Promise<ClientToken | null> {
    const hit = this.cache.get(token);
    if (hit && this.clock() - hit.at < this.ttlMs) return hit.value;
    const client = new DatanotesClient({ url: this.engineUrl, token, ...(this.transport ? { transport: this.transport } : {}) });
    let value: ClientToken | null;
    try {
      const r = await client.request("POST", "/datanotes/tokens/me/", {});
      if (r.status === 400) value = { name: "owner", write: "all" };
      else if (r.status === 200) {
        const entry = (r.json as { entry?: { name?: unknown; write?: unknown } | null } | undefined)?.entry;
        value = entry ? { name: String(entry.name), write: Array.isArray(entry.write) ? (entry.write as string[]) : [] } : null;
      } else throw new DatanotesError(`the engine answered ${r.status} to /datanotes/tokens/me/`, "http", r.status);
    } catch (e) {
      if (e instanceof DatanotesError && e.kind === "auth") return null;
      throw e;
    }
    this.cache.set(token, { at: this.clock(), value });
    return value;
  }
}

// --- loading ---------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A string that matches a rule. A record comes from the engine, and a remote engine answers what it likes. */
const matches = (v: unknown, rule: RegExp): boolean => typeof v === "string" && rule.test(v);

/** The page `ref` of a docs address ("tools#start_task") as read_docs names it for an extension. */
function docsRef(name: string, docs: string | undefined): string {
  if (docs === undefined) return `extensions/${name}`;
  const hash = docs.indexOf("#");
  const page = hash < 0 ? docs : docs.slice(0, hash);
  const anchor = hash < 0 ? "" : docs.slice(hash);
  return `${page === "" || page === "index" ? `extensions/${name}` : `extensions/${name}/${page}`}${anchor}`;
}

/** The text of a refusal the extension's code raised (an error named "ToolError"). */
function refusalText(name: string, e: { message?: unknown; hint?: unknown; docs?: unknown }): string {
  const message = String(e.message);
  if (message.includes("\nHint: ")) return message;
  const hint = typeof e.hint === "string" && e.hint !== "" ? e.hint : undefined;
  const docs = typeof e.docs === "string" ? e.docs : undefined;
  return [message, hint !== undefined ? `Hint: ${hint}` : null, hint !== undefined || docs !== undefined ? `Docs: read_docs(${JSON.stringify(docsRef(name, docs))})` : null].filter((l) => l !== null).join("\n");
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Load the extensions installed in the database the engine serves; one that cannot be loaded is skipped with its reason. */
export async function loadExtensions(o: LoadOptions): Promise<ExtensionLoad> {
  const log = o.log ?? noLog;
  const client = new DatanotesClient({ url: o.engineUrl, token: o.token, ...(o.transport ? { transport: o.transport } : {}) });
  let list: ExtensionList;
  try {
    list = await client.post<ExtensionList>("/extensions/", {});
  } catch (e) {
    if (!(e instanceof DatanotesError) || e.status !== 404) throw e;
    log("DEBUG", "extensions not loaded", { "datanotes.extension.reason": "no_registry" });
    return { databaseId: null, loaded: [], skipped: [], docsMounts: [] };
  }
  // the token files sit under tokens/<database id>/: an id that is not a UUID counts as none
  const databaseId = matches(list.database_id, DATABASE_ID) ? list.database_id : null;
  const out: ExtensionLoad = { databaseId, loaded: [], skipped: [], docsMounts: [] };
  const records = [...list.extensions].sort((a, b) => a.name.localeCompare(b.name));
  if (records.length === 0) return out;

  const engineVersion = await engineVersionOf(client);
  const timezone = await timezoneOf(client, log);
  const clientTokens = new ClientTokens(o.engineUrl, o.transport);
  const home = extensionsHome(o.env);
  const taken = new Map<string, string>();
  for (const t of o.reserved ?? []) taken.set(t, "");

  for (const r of records) {
    const skip = (code: SkipCode, reason: string): void => {
      out.skipped.push({ name: r.name, version: r.version, code, reason });
      log("WARN", "extension skipped", { "datanotes.extension.name": r.name, "datanotes.extension.version": r.version, "datanotes.extension.reason": code });
    };
    const label = sourceLabel(r);
    if (r.api !== EXTENSION_API_VERSION) {
      skip("api", `extension ${r.name} uses extension API ${r.api}; this server supports ${EXTENSION_API_VERSION}: update Datanotes`);
      continue;
    }
    // the code folder and the token file are named after the record's name and commit: each must be one plain segment
    if (!matches(r.name, RECORD_NAME) || !matches(r.commit, RECORD_COMMIT)) {
      skip("code_missing", `the record of ${r.name} ${r.version} has an invalid name or commit: run datanotes extension install ${label} again, which repairs the installation`);
      continue;
    }
    const dir = codeDir(home, r.name, r.commit);
    const manifestFile = path.join(dir, MANIFEST_FILE);
    if (!fs.existsSync(manifestFile)) {
      skip("code_missing", `the code of ${r.name} ${r.version} is not on this machine (${dir}): run datanotes extension install ${label} again, which repairs the installation`);
      continue;
    }
    const changed = `the cached code of ${r.name} differs from what was installed: run datanotes extension install ${label} again`;
    if (fileSha256(manifestFile) !== r.manifest_sha256) {
      skip("code_changed", changed);
      continue;
    }
    let manifest: ExtensionManifest;
    try {
      manifest = parseManifest(fs.readFileSync(manifestFile, "utf8"));
      const odd = manifest.tools.findIndex((t) => !isObject(t.annotations));
      if (odd >= 0) throw new Error(`tools[${odd}].annotations: must be an object`);
    } catch (e) {
      skip("entry", `the code of ${r.name} did not load: ${(e as Error).message}`);
      continue;
    }
    const entryFile = path.join(dir, ...manifest.entry.split("/"));
    let entryHash: string | null;
    try {
      entryHash = fileSha256(entryFile);
    } catch {
      entryHash = null;
    }
    if (entryHash !== r.entry_sha256) {
      skip("code_changed", changed);
      continue;
    }
    if (!satisfiesEngine(manifest.datanotes, engineVersion)) {
      skip("engine", `${r.name} ${r.version} needs Datanotes ${manifest.datanotes}; the engine is ${engineVersion}`);
      continue;
    }
    const secret = databaseId === null ? null : readTokenFile(tokenPath(home, databaseId, r.name));
    if (secret === null) {
      skip("token_missing", `the token of ${r.name} is not on this machine: run datanotes extension install ${label} again (it gives the extension a new token)`);
      continue;
    }
    const clash = manifest.tools.find((t) => taken.has(t.name));
    if (clash) {
      const other = taken.get(clash.name)!;
      skip("tool_taken", other === "" ? `tool ${clash.name} of ${r.name} is also a tool of this server` : `tool ${clash.name} of ${r.name} is also a tool of extension ${other}`);
      continue;
    }
    let mod: unknown;
    try {
      mod = ((await import(/* @vite-ignore */ pathToFileURL(entryFile).href)) as { default?: unknown }).default;
    } catch (e) {
      skip("entry", `the code of ${r.name} did not load: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const problems = validateModule(mod, manifest);
    if (problems.length > 0) {
      skip("handler", `the code of ${r.name} does not fit its manifest: ${problems.join("; ")}`);
      continue;
    }
    for (const t of manifest.tools) taken.set(t.name, r.name);
    const loaded = build({ record: r, manifest, handlers: (mod as { handlers: Record<string, ExtensionHandler> }).handlers, secret, engineUrl: o.engineUrl, transport: o.transport, clientTokens, timezone, readOnlyOnly: o.readOnlyOnly === true, log });
    out.loaded.push(loaded);
    out.docsMounts.push({ prefix: `extensions/${r.name}`, dir: path.join(dir, "docs") });
    log("INFO", "extension loaded", { "datanotes.extension.name": r.name, "datanotes.extension.version": r.version });
  }
  return out;
}

/** The engine's version from `GET /`; "" when it does not say. */
async function engineVersionOf(client: DatanotesClient): Promise<string> {
  const version = (((await client.request("GET", "/")).json ?? {}) as { version?: unknown }).version;
  return typeof version === "string" ? version : "";
}

/** The database's time zone (`describe_database`'s config.timezone); "" when it has none. */
async function timezoneOf(client: DatanotesClient, log: HostLog): Promise<string> {
  const r = await client.call("describe_database", {});
  if (!r.ok) {
    log("WARN", "extension time zone unknown", { "datanotes.extension.reason": "describe_database_refused" });
    return "";
  }
  const tz = (r.value as { config?: { timezone?: unknown } } | null)?.config?.timezone;
  return typeof tz === "string" ? tz : "";
}

// --- one loaded extension --------------------------------------------------------------------------

interface BuildInput {
  record: InstalledExtension;
  manifest: ExtensionManifest;
  handlers: Record<string, ExtensionHandler>;
  secret: string;
  engineUrl: string;
  transport: Transport | undefined;
  clientTokens: ClientTokens;
  timezone: string;
  readOnlyOnly: boolean;
  log: HostLog;
}

function build(b: BuildInput): LoadedExtension {
  const { record: r, manifest, handlers, log } = b;
  const name = r.name;
  const servedBy = `ext-${name}`;
  const boundTable = (role: string): string | undefined => (Object.prototype.hasOwnProperty.call(r.tables, role) ? r.tables[role]!.table : undefined);
  const tableOf = (role: string): string => {
    const t = boundTable(role);
    if (t === undefined) throw new Error(`no table for role ${role}`);
    return t;
  };
  // the tools this server offers (with readOnlyOnly, only the read-only ones): has() and call() know no other
  const offered = manifest.tools.filter((t) => !b.readOnlyOnly || t.annotations.readOnlyHint === true);
  const defs = new Map<string, ManifestTool>(offered.map((t) => [t.name, t]));
  const tools: ExtensionToolDefinition[] = offered.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
    _meta: { "datanotes/extension": name, "datanotes/tables": t.tables.map(boundTable).filter((x): x is string => x !== undefined) },
  }));
  const instructions = `Extension ${name} ${r.version} (${manifest.tools.map((t) => t.name).join(", ")}): ${manifest.instructions ?? manifest.description} Docs: read_docs("extensions/${name}").`;
  const own = new DatanotesClient({ url: b.engineUrl, token: b.secret, ...(b.transport ? { transport: b.transport } : {}) });

  const context = (def: ManifestTool, caller: ExtensionCaller, clientName: string): ExtensionContext => {
    const actor: ActorInfo = engineActor(caller.actor, def.name, clientName);
    // an extension tool that declares no writes may not write rows, whatever the extension's token can do
    const writesNothing = def.writes.length === 0;
    return {
      async callTool(operation, args): Promise<ExtensionCallResult> {
        if (writesNothing && (operation === "batch" || operation === "restore_table" || DATA_OPERATIONS.includes(operation))) {
          return { ok: false, value: guidedText(`tool ${def.name} of extension ${name} declares no writes: it may not call ${operation}`, { hint: `Declare the roles the tool writes in the manifest (tools[].writes, with readOnlyHint false), or call a read operation.`, docs: EXT_DOCS.tools }) };
        }
        try {
          return await own.call(operation, args, actor);
        } catch (e) {
          return { ok: false, value: (e as Error).message };
        }
      },
      actor: () => ({ ...caller.actor }),
      ...(caller.actor.session !== undefined ? { session: caller.actor.session } : {}),
      table: tableOf,
      column(role, column) {
        tableOf(role);
        const mapped = r.tables[role]!.columns;
        return mapped && Object.prototype.hasOwnProperty.call(mapped, column) ? mapped[column]! : column;
      },
      hasColumn(role, column) {
        tableOf(role);
        return !(r.tables[role]!.absent ?? []).includes(column);
      },
      timezone: b.timezone,
      log(level, message, attributes) {
        log(level, message, { ...attributes, "datanotes.extension.name": name, "datanotes.extension.version": r.version });
      },
      extension: { name, version: r.version },
    };
  };

  async function call(tool: string, args: Record<string, unknown>, caller: ExtensionCaller): Promise<Answer> {
    const def = defs.get(tool);
    if (!def) return { ok: false, value: `extension ${name} has no tool ${tool}` };
    const started = Date.now();
    const attrs = (ok: boolean): Attributes => ({ "datanotes.extension.name": name, "datanotes.extension.version": r.version, "gen_ai.tool.name": tool, "datanotes.ok": ok, duration_ms: Date.now() - started });
    const refuse = (value: string): Answer => {
      log("INFO", "extension tool refused", attrs(false));
      return { ok: false, value };
    };
    try {
      const problem = checkToolArguments(tool, def.inputSchema as InputSchema, args, EXT_DOCS.tools);
      if (problem) return refuse(`${problem.message}\nHint: ${problem.hint}\nDocs: read_docs(${JSON.stringify(`extensions/${name}`)})`);
      const client = await b.clientTokens.describe(caller.clientToken);
      if (client === null) return refuse(guidedText("the engine refused the client's token", { hint: "Connect with a token the engine knows (the owner's, or a named one).", docs: EXT_DOCS.permissions }));
      for (const role of def.writes) {
        const full = tableOf(role);
        if (client.write !== "all" && !tableAllowed(full, client.write)) {
          return refuse(
            guidedText(`token ${client.name} may not write ${full}: tool ${tool} of extension ${name} writes it`, {
              hint: `Ask the owner to add ${full} (or ${full.slice(0, full.lastIndexOf("."))}.*) to the token's write patterns (POST /datanotes/tokens/update/), or call the tool with a token that may write it.`,
              docs: EXT_DOCS.permissions,
            }),
          );
        }
      }
      const value = await handlers[tool]!(args, context(def, caller, client.name));
      log("INFO", "extension tool call", attrs(true));
      return { ok: true, value };
    } catch (e) {
      if (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "ToolError") return refuse(refusalText(name, e as { message?: unknown; hint?: unknown; docs?: unknown }));
      const message = e instanceof Error ? e.message : String(e);
      log("ERROR", "extension tool failed", { ...attrs(false), error: cut(message, 300) });
      return { ok: false, value: `extension ${name} failed in ${tool}: ${message}` };
    }
  }

  return { name, version: r.version, servedBy, tools, instructions, has: (tool) => defs.has(tool), call };
}
