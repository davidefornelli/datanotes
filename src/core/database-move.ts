/**
 * Moves of the database folder (`configure_database root`, or a folder moved by hand and found
 * again by its id): each is recorded in the store (`store:database_moves.jsonl`), so what the
 * journal and the transaction log wrote before a move reads with today's paths. Undo of an
 * operation made before the move finds its rows where they are now, time travel and restore put
 * old versions back in today's folders, and links written to the old folder read as links to the
 * new one.
 */

import type { App } from "./host";
import type { JournalEntry } from "./changeset";
import { withMetastoreId } from "./database-id";
import { METASTORE_FILE, rebaseTablePaths, type CatalogTableEntry } from "./metastore";
import { isStorePath, storeAppend, storePath, storeRead } from "./store";
import { movePath } from "./db-paths";

export interface DatabaseMove {
  from: string;
  to: string;
  /** When the move was recorded (ISO date-time). */
  at: string;
  /** `configure_database`, or `hand` (the folder was moved outside the engine). */
  by: "configure_database" | "hand";
  /**
   * When `from` or `to` is the root of the vault (""): the names at the root that are the
   * database's (metastore.yaml and the catalog folders). The notes beside them did not move.
   */
  entries?: string[];
}

export const MOVES_FILE = storePath("database_moves.jsonl");

const CACHE = new WeakMap<object, DatabaseMove[]>();

/** The moves of the database folder, oldest first (cached per app; a write refreshes it). */
export async function databaseMoves(app: App): Promise<DatabaseMove[]> {
  const hit = CACHE.get(app);
  if (hit) return hit;
  const out: DatabaseMove[] = [];
  for (const line of ((await storeRead(app, MOVES_FILE)) ?? "").split("\n")) {
    try {
      const m = JSON.parse(line) as DatabaseMove;
      if (typeof m.from === "string" && typeof m.to === "string" && typeof m.at === "string") out.push(m);
    } catch {
      // an empty or torn line
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  CACHE.set(app, out);
  return out;
}

export async function appendDatabaseMove(app: App, move: DatabaseMove): Promise<void> {
  const text = await storeRead(app, MOVES_FILE);
  await storeAppend(app, MOVES_FILE, `${text && !text.endsWith("\n") ? "\n" : ""}${JSON.stringify(move)}\n`);
  CACHE.delete(app);
}

/**
 * Run `fn` on every item, at most `limit` at a time (a move writes thousands of notes: one after
 * the other, each waits for the disk; together, the disk is kept busy).
 */
export async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** How many notes a move of the database folder writes at a time. */
export const MOVE_WRITES = 16;

export { movePath } from "./db-paths";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A note's text (or a value) with its links into `from` pointing into `to`: wikilinks
 * (`[[Datanotes/x]]`, embeds too) and Markdown links (`[x](Datanotes/x.md)`, spaces as `%20` too).
 * From the root of the vault (""), the links into its database `entries` move; to the root, the
 * folder's name goes from the links.
 */
export function moveLinks(text: string, from: string, to: string, entries: readonly string[] = []): string {
  const prefix = (t: string) => (t === "" ? "" : `${t}/`);
  if (from === "") {
    const names = entries.filter((e) => text.includes(e) || text.includes(e.replace(/ /g, "%20")));
    if (names.length === 0) return text;
    let out = text;
    for (const e of names) {
      out = out.replace(new RegExp(`(\\[\\[\\/?)(${escape(e)})(?=[/\\]|#])`, "g"), `$1${prefix(to)}$2`);
      for (const n of [e, e.replace(/ /g, "%20")]) {
        out = out.replace(new RegExp(`(\\]\\(<?\\/?)(${escape(n)})(?=[/)>#])`, "g"), `$1${prefix(to.replace(/ /g, "%20"))}$2`);
      }
    }
    return out;
  }
  if (!text.includes(from) && !text.includes(from.replace(/ /g, "%20"))) return text;
  const wiki = new RegExp(`(\\[\\[\\/?)${escape(from)}\\/`, "g");
  let out = text.replace(wiki, `$1${prefix(to)}`);
  for (const [f, t] of [
    [from, to],
    [from.replace(/ /g, "%20"), to.replace(/ /g, "%20")],
  ] as const) {
    out = out.replace(new RegExp(`(\\]\\(<?\\/?)${escape(f)}\\/`, "g"), `$1${prefix(t)}`);
  }
  return out;
}

/** A frontmatter value (strings, lists, mappings) with its links moved. */
export function moveValue(value: unknown, from: string, to: string, entries: readonly string[] = []): unknown {
  if (typeof value === "string") return moveLinks(value, from, to, entries);
  if (Array.isArray(value)) return value.map((v) => moveValue(v, from, to, entries));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, moveValue(v, from, to, entries)]));
  return value;
}

/** A table's entry with its archive and exclude folders inside `from` moved (like {@link rebaseTablePaths}). */
export function moveEntryPaths(entry: CatalogTableEntry | null, from: string, to: string, entries: readonly string[] = []): CatalogTableEntry | null {
  const props = entry?.options;
  if (!entry || !props) return entry;
  const one = (p: unknown) => (typeof p === "string" ? movePath(p.trim().replace(/^\/+|\/+$/g, ""), from, to, entries) : p);
  const next = { ...props };
  // an archive without "/" is a folder name inside the table's folder, not a vault path
  if (typeof props.archive === "string" && props.archive.includes("/")) next.archive = one(props.archive) as string;
  if (props.exclude !== undefined) next.exclude = (Array.isArray(props.exclude) ? props.exclude.map(one) : one(props.exclude)) as string | string[];
  return JSON.stringify(next) === JSON.stringify(props) ? entry : { ...entry, options: next };
}

const isMetastore = (path: string) => path === METASTORE_FILE || path.endsWith(`/${METASTORE_FILE}`);

/** A metastore text with its table paths moved (unchanged when it cannot be read). */
function moveMetastoreText(text: string, from: string, to: string, entries: readonly string[]): string {
  if (text === "") return text;
  try {
    return rebaseTablePaths(text, from, to, entries);
  } catch {
    return text;
  }
}

/**
 * A journal entry as it reads today:
 *
 * - for every move of the database folder recorded after it, its paths, the links in its values,
 *   bodies and texts, and the table paths in its metastore texts, moved;
 * - its metastore texts with the database's `id` (`databaseId`), when they have none: the id the
 *   engine added at the first start is not a change an undo takes back.
 */
export function translateJournalEntry(entry: JournalEntry, moves: readonly DatabaseMove[], databaseId?: string | null): JournalEntry {
  let e: JournalEntry = entry;
  for (const mv of moves) {
    if (mv.at <= entry.executed_at) continue;
    const { from, to } = mv;
    const entries = mv.entries ?? [];
    const p = (path: string) => (isStorePath(path) ? path : movePath(path, from, to, entries));
    const text = (path: string, t: string) => (isMetastore(path) ? moveMetastoreText(t, from, to, entries) : /\.md$/i.test(path) ? moveLinks(t, from, to, entries) : t);
    const values = (v: Record<string, unknown>) => moveValue(v, from, to, entries) as Record<string, unknown>;
    const links = (t: string) => moveLinks(t, from, to, entries);
    // the move rewrote the links of the notes the entry created: their hashes no longer tell
    const { created_hashes: _stale, ...kept } = e;
    e = {
      ...kept,
      ...(e.schema !== undefined ? { schema: movePath(e.schema, from, to, entries) } : {}),
      rows: e.rows.map((r) => ({
        ...r,
        path: p(r.path),
        before: values(r.before),
        after: values(r.after),
        ...(r.body_before !== undefined ? { body_before: links(r.body_before) } : {}),
        ...(r.body_after !== undefined ? { body_after: links(r.body_after) } : {}),
      })),
      creates: e.creates.map(p),
      moves: e.moves.map((m) => ({ from: p(m.from), to: p(m.to) })),
      references: e.references.map((r) => ({ path: p(r.path), before_text: text(r.path, r.before_text), after_text: text(r.path, r.after_text) })),
      ...(e.deleted ? { deleted: e.deleted.map((d) => ({ path: p(d.path), content: links(d.content) })) } : {}),
      failed: e.failed.map((f) => ({ ...f, path: p(f.path) })),
    };
  }
  if (databaseId) {
    // an empty text too: undoing the operation that created the metastore keeps the id
    const withId = (t: string) => withMetastoreId(t, databaseId);
    e = { ...e, references: e.references.map((r) => (isMetastore(r.path) ? { ...r, before_text: withId(r.before_text), after_text: withId(r.after_text) } : r)) };
  }
  return e;
}
