/**
 * Which tools `datanotes mcp` offers its agents: `--profile read|write|all`, or `--tools` (only
 * these), then `--except` (none of these) and `--owner-tools` (also the webhook tools). Without
 * any of them, every tool except the owner's tools: create_webhook and delete_webhook send the
 * database's changes to an address, so an agent gets them only when its owner asks for them.
 */

import { OPERATION_KIND, OPERATIONS } from "../api/catalog";
import { DOCS_BASE, didYouMean } from "../api/guidance";
import { DOCS_TOOL_NAMES } from "../api/mcp";

/** The tools an agent gets only with `--owner-tools` or `--profile all`. */
export const OWNER_TOOLS: readonly string[] = ["create_webhook", "delete_webhook"];

/** The values of `--profile`. */
export const PROFILES = ["read", "write", "all"] as const;
export type Profile = (typeof PROFILES)[number];

/** Where the options are explained. */
export const TOOLS_DOCS = `${DOCS_BASE}/start/connect-agents.md#choose-the-tools-an-agent-sees`;

/** Every tool the server can offer: the engine's operations, then the docs tools. */
export const ALL_TOOLS: readonly string[] = [...OPERATIONS.map((o) => o.name), ...DOCS_TOOL_NAMES];

/** Operations that change the database's definition: left out of the `write` profile. */
const DEFINES = new Set([...OPERATIONS.filter((o) => OPERATION_KIND[o.name] === "schema").map((o) => o.name), "configure_database"]);
const READ_ONLY = new Set([...OPERATIONS.filter((o) => o.annotations.readOnlyHint === true).map((o) => o.name), ...DOCS_TOOL_NAMES]);

/** A selection of tools the server cannot make: what is wrong, how to fix it, where to read more. */
export class ToolSelectionError extends Error {
  override readonly name = "ToolSelectionError";
  readonly docs = TOOLS_DOCS;
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export interface ToolSelection {
  /** `--profile`. */
  profile?: string;
  /** `--tools`: comma-separated names. */
  tools?: string;
  /** `--except`: comma-separated names. */
  except?: string;
  /** `--owner-tools`. */
  ownerTools?: boolean;
}

/** The tools of a profile; without one, every tool except the owner's. */
export function profileTools(profile: Profile | null): string[] {
  if (profile === "all") return [...ALL_TOOLS];
  if (profile === "read") return ALL_TOOLS.filter((n) => READ_ONLY.has(n));
  if (profile === "write") return ALL_TOOLS.filter((n) => !DEFINES.has(n) && !OWNER_TOOLS.includes(n));
  return ALL_TOOLS.filter((n) => !OWNER_TOOLS.includes(n));
}

function names(list: string, option: string): string[] {
  const out = list
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  for (const n of out) {
    if (!ALL_TOOLS.includes(n)) {
      throw new ToolSelectionError(`${option}: unknown tool "${n}"`, `${didYouMean(n, ALL_TOOLS)} ${option} takes tool names separated by commas, such as ${option} select_rows,insert_row; the reference lists every operation.`.trim());
    }
  }
  return out;
}

/** The names of the tools to offer, in the catalogue's order. Throws {@link ToolSelectionError}. */
export function selectTools(s: ToolSelection): string[] {
  let profile: Profile | null = null;
  if (s.profile !== undefined) {
    if (!(PROFILES as readonly string[]).includes(s.profile)) {
      throw new ToolSelectionError(`--profile: unknown profile "${s.profile}"`, `${didYouMean(s.profile, PROFILES)} --profile takes read, write or all.`.trim());
    }
    profile = s.profile as Profile;
  }
  if (profile && s.tools !== undefined) throw new ToolSelectionError("pass --profile or --tools, not both", "--profile picks a set of tools, --tools names them one by one; --except leaves some out of either.");
  const only = s.tools !== undefined ? new Set(names(s.tools, "--tools")) : null;
  const except = new Set(s.except !== undefined ? names(s.except, "--except") : []);
  const base = new Set(only ?? profileTools(profile));
  if (s.ownerTools) for (const n of OWNER_TOOLS) base.add(n);
  const kept = ALL_TOOLS.filter((n) => base.has(n) && !except.has(n));
  if (kept.length === 0) throw new ToolSelectionError("no tool left to offer", "--except leaves out every tool that --tools or --profile names: name fewer tools in --except.");
  return kept;
}

/** Read a yes/no environment variable: `1`/`true` or `0`/`false` (or unset). */
export function envFlag(env: Record<string, string | undefined>, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new ToolSelectionError(`${name} must be 1 or 0: "${env[name]}"`, `Set ${name}=1 to turn it on, or leave it unset.`);
}
