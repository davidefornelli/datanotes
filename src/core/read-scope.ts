/**
 * What the current request may read: the read patterns of the named token behind it
 * (docs: guides/security/tokens#limit-what-a-token-can-read).
 *
 * The HTTP API's permission guard (src/server/tokens.ts) sets the scope for the duration of a
 * request with AsyncLocalStorage, the same way src/core/actor.ts carries the actor; the engine's
 * read sites ask it here, since src/core never imports src/server. The patterns stay off the actor
 * on purpose: the actor is written into the journal and the transaction log.
 *
 * No scope means everything is readable: the owner, a token without `read`, a token whose `read`
 * holds `*`, hand edits and commands. A restricted scope reads only the tables its patterns name,
 * and of the notes only the rows of those tables (free notes and other files: never).
 */

import type { App, TFile } from "./host";
import { guide, GuidedError, type Guidance } from "./hints";
import { cachedMetastore, rowTableFull } from "./metastore";
import type { DatanotesSettings } from "./settings";
import { vaultIndex } from "./vault-index";

/** What a restricted token may read. null (no scope) = everything: the owner, or a token without `read`. */
export interface ReadScope {
  /** The token's name, for messages. */
  readonly token: string;
  /** Its read patterns, never containing "*" (a token with "*" gets no scope). */
  readonly patterns: readonly string[];
}

interface Box {
  scope: ReadScope | null;
}

interface Storage {
  run<R>(store: Box, fn: () => R): R;
  getStore(): Box | undefined;
}

let storage: Storage | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require("node:async_hooks") as { AsyncLocalStorage: new () => Storage };
  storage = new AsyncLocalStorage();
  /* v8 ignore start -- impossible on Node: a runtime without node:async_hooks (a mobile Obsidian) */
} catch {
  storage = null;
}
/* v8 ignore stop */

/** True when this runtime can carry a scope (AsyncLocalStorage exists). */
export const READ_SCOPE_SUPPORTED: boolean = storage !== null;

/**
 * Run `fn` with this read scope (null: everything readable, also inside a restricted one). A
 * restricted scope where no scope can be carried throws: never an unfiltered answer (fail closed).
 */
export function runWithReadScope<R>(scope: ReadScope | null, fn: () => R): R {
  /* v8 ignore start -- a runtime without AsyncLocalStorage (a mobile Obsidian); the guard answers 503 before a scope gets here */
  if (!storage) {
    if (scope) throw new Error("read permissions need Node's AsyncLocalStorage");
    return fn();
  }
  /* v8 ignore stop */
  if (!scope && !storage.getStore()) return fn();
  return storage.run({ scope }, fn);
}

/** The read scope of the current request, or null (everything readable). */
export function currentReadScope(): ReadScope | null {
  return storage?.getStore()?.scope ?? null;
}

/** Does a qualified table name match a pattern list (`catalog.schema.table`, `catalog.schema.*`, `catalog.*`, `*`)? */
export function matchesTablePattern(full: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith(".*")) return full.startsWith(p.slice(0, -1));
    return p === full;
  });
}

/** May the current scope (or the one given; null: none) read this table (full name)? Always true without a scope. */
export function tableReadable(full: string, scope: ReadScope | null = currentReadScope()): boolean {
  return scope === null || matchesTablePattern(full, scope.patterns);
}

/** How a token gets a read it was refused. */
export const READ_DENIED_GUIDANCE: Guidance = guide(
  `The owner grants reads with tokens/update/ and "read" patterns (catalog.schema.table, catalog.schema.*, catalog.* or *). list_tables lists the tables this token may read.`,
  "tokenRead",
);

/** 403 refusal of a read. A GuidedError with the tokenRead guidance. */
export class ReadDeniedError extends GuidedError {
  override readonly name = "ReadDeniedError";
  constructor(message: string) {
    super(message, READ_DENIED_GUIDANCE);
  }
}

/** The refusal of a table to a token: `token <name> may not read <full>`. */
export function tableReadDenied(token: string, full: string): ReadDeniedError {
  return new ReadDeniedError(`token ${token} may not read ${full}`);
}

/** The refusal of a note to a token: `token <name> may not read the note <path>`. */
export function pathReadDenied(token: string, path: string): ReadDeniedError {
  return new ReadDeniedError(`token ${token} may not read the note ${path}`);
}

/** Throw ReadDeniedError when the current scope may not read this table. No-op without a scope. */
export function assertTableReadable(full: string): void {
  const scope = currentReadScope();
  if (scope && !matchesTablePattern(full, scope.patterns)) throw tableReadDenied(scope.token, full);
}

/**
 * The table (full name) a note is a row of, or null (a free note, another file, no such path). From
 * the vault index; without one (or while the host's index throws for a note), from the note's front
 * matter and the metastore the engine has cached.
 */
export function tableOfPath(app: App, settings: DatanotesSettings, path: string): string | null {
  const idx = vaultIndex(app, settings);
  if (idx && !idx.hasFailures) return idx.note(path)?.table ?? null;
  const model = cachedMetastore(app, settings);
  const file = app.vault.getAbstractFileByPath(path);
  if (!model || !file || !("extension" in file)) return null;
  let value: unknown;
  try {
    value = app.metadataCache.getFileCache(file as TFile)?.frontmatter?.[settings.tableKey];
  } catch {
    return null; // a host whose index throws on broken YAML: no table can be told, so none
  }
  return rowTableFull(model, value);
}

/**
 * May the current scope (or the one given; null: none) read the note at `path`? Without a scope:
 * true. With a scope: true only when the note is a row of a readable table (free notes and other
 * files are false).
 */
export function pathReadable(app: App, settings: DatanotesSettings, path: string, scope: ReadScope | null = currentReadScope()): boolean {
  if (scope === null) return true;
  const table = tableOfPath(app, settings, path);
  return table !== null && matchesTablePattern(table, scope.patterns);
}

/** Throw ReadDeniedError("... may not read the note <path>") when pathReadable is false. */
export function assertPathReadable(app: App, settings: DatanotesSettings, path: string): void {
  const scope = currentReadScope();
  if (scope && !pathReadable(app, settings, path, scope)) throw pathReadDenied(scope.token, path);
}
