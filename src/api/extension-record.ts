/**
 * The record of an installed extension: what `datanotes extension install` writes to the engine's
 * registry (`POST /datanotes/extensions/record/`) and every MCP host reads back
 * (`POST /datanotes/extensions/`). Shape only: this file imports nothing.
 */

export interface RecordTable {
  /** The qualified table bound to the role. */
  table: string;
  /** True for a role the extension owns. */
  owned: boolean;
  /** Dependency roles: manifest column → the user's column, only where they differ. */
  columns?: Record<string, string>;
  /** Dependency roles: optional manifest columns the bound table does not have. */
  absent?: string[];
}

export interface ExtensionSourceRecord {
  kind: "git" | "local";
  /** git: the URL as given (https://…, git@…, ssh://…, file://…). */
  url?: string;
  /** git: the tag or commit id given (or the newest tag chosen). */
  ref?: string;
  /** local: the absolute folder, with "/" separators. */
  path?: string;
}

export interface InstalledExtension {
  name: string;
  version: string;
  description: string;
  api: number;
  source: ExtensionSourceRecord;
  /** The git commit id (40 hex), or "local-<12 hex>" for a folder. */
  commit: string;
  manifest_sha256: string;
  entry_sha256: string;
  /** The extension's named token: "ext-<name>". */
  token: string;
  tables: Record<string, RecordTable>;
  tools: string[];
  /** The token's write patterns (qualified table names). */
  write: string[];
  /** The batch that brought the database from `previous` to this record (null: nothing was written). */
  migration_id: string | null;
  installed_at: string;
  updated_at: string;
  /** The record before the last install, repair or update (null after a first install). */
  previous: InstalledExtension | null;
}

export interface ExtensionList {
  database_id: string | null;
  extensions: InstalledExtension[];
}

/** The rule of extension names (the same as EXTENSION_NAME in extension-manifest.ts). */
export const RECORD_NAME = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * The rule of a record's commit: a git commit id (40 hex) or a folder's content id ("local-" and lowercase letters,
 * digits, "." or "-"). The registry checks only shape; the extension host and the commands check this before they
 * build a path from a record.
 */
export const RECORD_COMMIT = /^(?:[0-9a-f]{40}|local-[0-9a-z.-]+)$/;

/** The rule of a database id: a UUID, as src/api/local.ts reads it. It names a folder of the token files. */
export const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The largest record the registry keeps (JSON characters). */
export const MAX_RECORD_CHARS = 1_000_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v !== "";

/** The problems of a record (empty: valid), each a short sentence naming the field. Unknown keys are kept. */
export function recordProblems(v: unknown, prefix = ""): string[] {
  if (!isObject(v)) return [`"${prefix.replace(/\.$/, "") || "record"}" must be an object`];
  const out: string[] = [];
  const bad = (field: string, what: string) => out.push(`"${prefix}${field}" must be ${what}`);
  if (typeof v.name !== "string" || !RECORD_NAME.test(v.name)) bad("name", "2 to 40 lowercase letters, digits or -, starting with a letter");
  for (const k of ["version", "commit", "manifest_sha256", "entry_sha256", "token", "installed_at", "updated_at"]) if (!nonEmpty(v[k])) bad(k, "a non-empty string");
  if (typeof v.description !== "string") bad("description", "a string");
  if (typeof v.api !== "number" || !Number.isInteger(v.api) || v.api < 1) bad("api", "an integer of 1 or more");
  if (!isObject(v.source)) bad("source", "an object");
  else if (v.source.kind !== "git" && v.source.kind !== "local") bad("source.kind", '"git" or "local"');
  if (!isObject(v.tables) || Object.values(v.tables).some((t) => !isObject(t) || typeof t.table !== "string" || typeof t.owned !== "boolean")) bad("tables", "an object of roles");
  if (!isStrings(v.tools)) bad("tools", "a list of strings");
  if (!isStrings(v.write)) bad("write", "a list of strings");
  if (v.migration_id !== null && typeof v.migration_id !== "string") bad("migration_id", "a string or null");
  if (v.previous !== null) out.push(...recordProblems(v.previous, `${prefix}previous.`));
  return out;
}
