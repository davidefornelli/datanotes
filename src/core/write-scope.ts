/**
 * What the current request may write: the write patterns of the named token behind it
 * (docs: guides/security/tokens#a-write-into-another-table-needs-write-too).
 *
 * The HTTP API's permission guard (src/server/tokens.ts) checks the tables a row write names in
 * its arguments. A write can also change rows of other tables: `on_referenced: "set_null"` clears
 * their links, an inverse link column mirrors the link on the linked row, `align_relations`
 * writes the other side. The guard sets this scope for the request with AsyncLocalStorage (as
 * read-scope.ts carries the read scope; src/core never imports src/server), and `finish`
 * (engine.ts), where every write's change set is complete before anything is written, refuses
 * the whole write when it changes a row of a table the patterns do not match.
 *
 * No scope means every table is writable: the owner, a token whose `write` holds `*`, hand edits
 * and commands. Only row writes are checked (ROW_WRITE_OPS): schema changes need `ddl`, undo and
 * restore `maintain`, and those keep writing what they wrote. Free notes a row write changes
 * (adopt_rows makes rows of them) are no table's rows and stay as they were.
 */

import type { ChangeSet } from "./changeset";
import { editIsNoop } from "./changeset";
import { fmGet, readOrderedFromMarkdown } from "./frontmatter";
import { guide, GuidedError } from "./hints";
import type { App } from "./host";
import { loadMetastore, rowTableFull, type Metastore } from "./metastore";
import { matchesTablePattern, tableOfPath, tableReadable } from "./read-scope";
import type { DatanotesSettings } from "./settings";

/** What a restricted token may write. null (no scope) = every table: the owner, or a token with `*`. */
export interface WriteScope {
  /** The token's name, for messages. */
  readonly token: string;
  /** Its write patterns, never containing "*" (a token with "*" gets no scope). */
  readonly patterns: readonly string[];
}

interface Box {
  scope: WriteScope | null;
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

/** The change-set operations of the row writes, checked against the scope (the others are not row writes). */
export const ROW_WRITE_OPS: ReadonlySet<string> = new Set([
  "insert_row",
  "update_row",
  "update_rows",
  "delete_rows",
  "move_rows",
  "adopt_rows",
  "merge_rows",
  "recompute_columns",
  "align_relations",
]);

/**
 * Run `fn` with this write scope (null: every table writable, also inside a restricted one). A
 * restricted scope where no scope can be carried throws: never an unchecked write (fail closed).
 */
export function runWithWriteScope<R>(scope: WriteScope | null, fn: () => R): R {
  /* v8 ignore start -- a runtime without AsyncLocalStorage (a mobile Obsidian); the guard answers 503 before a scope gets here */
  if (!storage) {
    if (scope) throw new Error("write permissions need Node's AsyncLocalStorage");
    return fn();
  }
  /* v8 ignore stop */
  if (!scope && !storage.getStore()) return fn();
  return storage.run({ scope }, fn);
}

/** The write scope of the current request, or null (every table writable). */
export function currentWriteScope(): WriteScope | null {
  return storage?.getStore()?.scope ?? null;
}

/**
 * 403 refusal of a write that changes rows of a table the token may not write. A table the token
 * may not read stays unnamed (`table` null): the refusal never shows a name the listings hide.
 */
export class WriteDeniedError extends GuidedError {
  override readonly name = "WriteDeniedError";
  /** The table (full name) the token needs `write` on, or null when the token may not read it. */
  readonly table: string | null;
  constructor(token: string, table: string | null) {
    super(
      table === null
        ? `token ${token} may not write a table it may not read: this write changes rows of it`
        : `token ${token} may not write ${table}: this write changes rows of it`,
      guide(
        table === null
          ? `Nothing was written. The write changes rows of a table this token may not read (set_null, an inverse link or align_relations). The owner can add that table to the token's "read" and "write" with tokens/update/. Or change the write so it leaves that table alone.`
          : `Nothing was written. The write changes rows of ${table} (set_null, an inverse link or align_relations), so the token needs write on it too: the owner adds "${table}" (or a wider pattern) to the token's "write" with tokens/update/. Or change the write so it leaves that table alone.`,
        "tokenWrite",
      ),
    );
    this.table = table;
  }
}

/** The table (full name) of a note's frontmatter, or null (a free note, an unknown table). */
function tableOfFrontmatter(model: Metastore, settings: DatanotesSettings, fm: Parameters<typeof fmGet>[0]): string | null {
  return rowTableFull(model, fmGet(fm, settings.tableKey));
}

/**
 * The tables (full names) whose rows the change set creates, edits, moves or deletes: of an edit
 * the table before and after, of a create its content's, of a move and a delete the note's.
 */
export function changeSetTables(app: App, settings: DatanotesSettings, model: Metastore, cs: ChangeSet): Set<string> {
  const out = new Set<string>();
  const add = (full: string | null) => {
    if (full !== null) out.add(full);
  };
  const keep = new Set([settings.tableKey]);
  for (const e of cs.edits) {
    if (editIsNoop(e)) continue;
    add(tableOfFrontmatter(model, settings, e.before) ?? tableOfPath(app, settings, e.path));
    add(tableOfFrontmatter(model, settings, e.after));
  }
  for (const c of cs.creates) add(tableOfFrontmatter(model, settings, readOrderedFromMarkdown(c.content, keep).ordered));
  for (const m of cs.moves) add(tableOfPath(app, settings, m.from));
  for (const d of cs.deletes) add(tableOfPath(app, settings, d));
  return out;
}

/**
 * Throw WriteDeniedError when a row write of the current scope would change a row of a table its
 * patterns do not match. No-op without a scope, and for the change sets that are not row writes.
 */
export async function assertChangeSetWritable(app: App, settings: DatanotesSettings, cs: ChangeSet): Promise<void> {
  const scope = currentWriteScope();
  if (!scope || !ROW_WRITE_OPS.has(cs.op)) return;
  const model = (await loadMetastore(app, settings))?.model;
  if (!model) return;
  const denied = [...changeSetTables(app, settings, model, cs)].filter((t) => !matchesTablePattern(t, scope.patterns)).sort();
  if (denied.length === 0) return;
  // name a table the token may read; only when every one is hidden, name none
  const named = denied.find((t) => tableReadable(t));
  throw new WriteDeniedError(scope.token, named ?? null);
}
