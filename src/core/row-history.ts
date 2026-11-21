/**
 * `row_history`: the versions of one row, read from the tables' transaction logs, like the
 * version history of a document. Who created the row, who changed it last, and every change in
 * between with the columns it changed, the old path of a rename and the table a move came from.
 *
 * Nothing new is stored: every commit of the log already carries its time, its operation, its
 * `migrationId` and the agent behind it (`actor`), and the text of every row it adds. The row is
 * followed by its system id (`id`), across renames and moves between tables (`move_rows`: the
 * commits of both tables share the migration id). A row without an id is followed by its path.
 */

import type { App } from "./host";
import type { Actor } from "./actor";
import { assertTableReadable, tableReadable } from "./read-scope";
import { HISTORY_OFF, historyTableName, sinceMs } from "./history";
import { EXTERNAL_EDIT, listVersions, loggedTables, readCommit, scanCommits, tableStateAt, type Commit, type CommitInfo } from "./transaction-log";
import { OperationInputError } from "./engine";
import { fmGet, readOrderedFromMarkdown } from "./frontmatter";
import { basenameOf } from "./path-templates";
import { closestNames, guide } from "./hints";
import type { DatanotesSettings } from "./settings";
import { SYSTEM_ID_COLUMN } from "./types-table";

export interface RowHistoryInput {
  table: string;
  /** The row's system id … */
  id?: string;
  /** … or its vault path (with or without `.md`), now or before it was deleted. */
  path?: string;
  /** Versions to return, newest first (default 50, at most 1000). */
  limit?: number;
  /** ISO date or date-time: only the versions at or after it. */
  since?: string;
  /** ISO date or date-time: only the versions before it (`next_before` of the previous page). */
  before?: string;
}

export type RowChangeKind = "insert" | "update" | "move" | "delete";

export interface RowVersion {
  /** The table the row was in after this version (before it, for a delete). */
  table: string;
  version: number;
  timestamp: string;
  operation: string;
  change: RowChangeKind;
  /** `external`: changed outside the engine (an editor, git, a sync): no agent is known. */
  source: "engine" | "external";
  path: string;
  old_path?: string;
  /** A move from another table (`move_rows`): the table it came from. */
  from_table?: string;
  actor?: Actor;
  user_name?: string;
  migration_id?: string;
  /** The columns it changed, the table key included (a renamed or moved table); an insert lists every column it set (`before: null`). */
  changes: Record<string, { before: unknown; after: unknown }>;
  body_changed: boolean;
  /** The lines of the body removed and added (at most 20 each, each cut at 200 characters). */
  body_diff?: { removed: string[]; added: string[]; truncated?: true };
}

/** Who made a version and when: `created` and `last_modified`. */
export type RowVersionSummary = Pick<RowVersion, "table" | "version" | "timestamp" | "operation" | "change" | "source" | "path" | "actor" | "user_name" | "migration_id">;

export interface RowHistory {
  /** The table the row is in now (or was in last, when deleted). */
  table: string;
  id?: string;
  /** The row's path now (or its last one). */
  path: string;
  /** Whether the row exists now. */
  exists: boolean;
  /** Its first version; null when its history starts after it was created (a vacuum dropped the older versions). */
  created: RowVersionSummary | null;
  last_modified: RowVersionSummary | null;
  /** Where the history read starts: the oldest version kept of the oldest table followed. */
  history_start: { table: string; version: number; timestamp: string; truncated: boolean };
  /** Versions matching `since` / `before`. */
  total: number;
  /** Newest first. */
  versions: RowVersion[];
  /** Pass as `before` to read the next (older) page; absent on the last page. */
  next_before?: string;
}

const LIMIT_MAX = 1000;
const DIFF_LINES = 20;
const DIFF_CHARS = 200;
const MOVE_ROWS = "MOVE ROWS";

const FIND_ROW = guide(`Name the row by its "path" (the vault path of its note, now or before it was deleted) or its "id": select_rows with columns ["path", "id"] and a "where" finds them.`, "rowHistory");

/** A version as the walk finds it: the texts before and after. */
interface Raw {
  table: string;
  info: CommitInfo;
  change: RowChangeKind;
  path: string;
  oldPath?: string;
  fromTable?: string;
  before?: string;
  after?: string;
}

/** One table's part of the row's history. */
interface Walk {
  table: string;
  entries: Raw[];
  /** The row's text and path after the last commit read (null: not in the table then). */
  last: { path: string; content: string } | null;
  start: { version: number; timestamp: string; truncated: boolean };
  /** The row was in the table when its kept history starts (a vacuumed log). */
  existedAtStart: boolean;
}

function idOf(content: string): string | undefined {
  const v = fmGet(readOrderedFromMarkdown(content).ordered, SYSTEM_ID_COLUMN);
  return typeof v === "string" ? v : undefined;
}

/** The file name as a commit's JSON text writes it: a cheap test before parsing. */
function jsonName(path: string): string {
  return JSON.stringify(basenameOf(path)).slice(1, -1);
}

function normalPath(path: string): string {
  return path.endsWith(".md") ? path : `${path}.md`;
}

/** What to follow: the id, or (a row without one) a path. */
type Ident = { id: string } | { path: string };

/**
 * The row's versions in one table's log, oldest first: from the oldest version kept (a vacuumed
 * log starts at a checkpoint) up to `until` (included; default the latest).
 */
async function walkTable(app: App, settings: DatanotesSettings, full: string, ident: Ident, until = Infinity): Promise<Walk> {
  const versions = await listVersions(app, settings, full);
  const first = versions[0]!;
  let last: Walk["last"] = null;
  const matches = (path: string, content: string) => ("id" in ident ? content.includes(ident.id) && idOf(content) === ident.id : path === ident.path);
  let after = -1;
  let start = { version: first, timestamp: (await readCommit(app, settings, full, first)).commitInfo.timestamp, truncated: false };
  if (first > 0) {
    // older versions were vacuumed: the row as the oldest kept version has it
    const base = await tableStateAt(app, settings, full, { version: first });
    start = { version: first, timestamp: base.timestamp, truncated: true };
    for (const [path, f] of base.files) {
      if (matches(path, f.content)) {
        last = { path, content: f.content };
        break;
      }
    }
    after = first;
  }
  const existedAtStart = last !== null;
  const names = new Set<string>();
  if (last) names.add(jsonName(last.path));
  if ("path" in ident) names.add(jsonName(ident.path));
  const keep = (text: string) => ("id" in ident && text.includes(ident.id)) || [...names].some((n) => text.includes(n));
  const entries: Raw[] = [];
  for await (const c of scanCommits(app, settings, full, after, keep)) {
    const info = c.commitInfo;
    if (info.version > until) break;
    const add = c.add.find((a) => matches(a.path, a.content));
    const removed = last !== null && c.remove.some((r) => r.path === last!.path);
    if (add) {
      if (last && last.path === add.path && last.content === add.content) continue;
      const change: RowChangeKind = !last ? "insert" : last.path !== add.path ? "move" : "update";
      entries.push({ table: full, info, change, path: add.path, ...(last && last.path !== add.path ? { oldPath: last.path } : {}), ...(last ? { before: last.content } : {}), after: add.content });
      last = { path: add.path, content: add.content };
      names.add(jsonName(add.path));
    } else if (removed) {
      entries.push({ table: full, info, change: "delete", path: last!.path, before: last!.content });
      last = null;
    }
  }
  return { table: full, entries, last, start, existedAtStart };
}

/** The path of the row last added at `path` in a table's log (a deleted row), and its id. */
async function lastAddAt(app: App, settings: DatanotesSettings, full: string, path: string): Promise<{ content: string } | null> {
  const name = jsonName(path);
  let found: { content: string } | null = null;
  for await (const c of scanCommits(app, settings, full, -1, (t) => t.includes(name))) {
    const a = c.add.find((x) => x.path === path);
    if (a) found = { content: a.content };
  }
  return found;
}

/** The tables (other than `skip`) whose log has a commit of migration `m`, with those commits. */
async function commitsOfMigration(app: App, settings: DatanotesSettings, m: string, skip: ReadonlySet<string>): Promise<{ table: string; commits: Commit[] }[]> {
  const out: { table: string; commits: Commit[] }[] = [];
  for (const full of await loggedTables(app, settings, (f) => !skip.has(f) && tableReadable(f))) {
    const commits: Commit[] = [];
    for await (const c of scanCommits(app, settings, full, -1, (t) => t.includes(m))) if (c.commitInfo.migrationId === m) commits.push(c);
    if (commits.length > 0) out.push({ table: full, commits });
  }
  return out;
}

/**
 * The row's versions across tables, oldest first: the table asked about, then (with an id) the
 * tables `move_rows` moved it from and to.
 */
async function walkAcross(app: App, settings: DatanotesSettings, full: string, ident: Ident): Promise<{ raws: Raw[]; walks: Walk[] }> {
  let walks: Walk[] = [await walkTable(app, settings, full, ident)];
  if (!("id" in ident)) return { raws: walks[0]!.entries, walks };
  const id = ident.id;
  const visited = new Set([full]);
  // backwards: a first version that is a move here came from another table
  for (;;) {
    const head = walks[0]!.entries[0];
    const m = head?.info.migrationId;
    if (!head || head.change !== "insert" || head.info.operation !== MOVE_ROWS || m === undefined) break;
    const from = (await commitsOfMigration(app, settings, m, visited)).find((x) => x.commits.some((c) => c.remove.length > 0));
    if (!from) break;
    visited.add(from.table);
    const w = await walkTable(app, settings, from.table, ident, from.commits[0]!.commitInfo.version);
    const tail = w.entries.at(-1);
    if (!tail || tail.change !== "delete" || tail.info.migrationId !== m) break;
    w.entries.pop();
    Object.assign(head, { change: "move" as const, fromTable: from.table, oldPath: tail.path, before: tail.before });
    walks = [w, ...walks];
  }
  // forwards: a last version that is a move away went to another table
  for (;;) {
    const end = walks.at(-1)!;
    const tail = end.entries.at(-1);
    const m = tail?.info.migrationId;
    if (!tail || tail.change !== "delete" || tail.info.operation !== MOVE_ROWS || m === undefined) break;
    const to = (await commitsOfMigration(app, settings, m, visited)).find((x) => x.commits.some((c) => c.add.some((a) => a.content.includes(id) && idOf(a.content) === id)));
    if (!to) break;
    visited.add(to.table);
    const w = await walkTable(app, settings, to.table, ident);
    const head = w.entries[0];
    if (!head || head.change !== "insert" || head.info.migrationId !== m) break;
    end.entries.pop();
    Object.assign(head, { change: "move" as const, fromTable: end.table, oldPath: tail.path, before: tail.before });
    walks = [...walks, w];
  }
  return { raws: walks.flatMap((w) => w.entries), walks };
}

function columnsOf(content: string | undefined, settings: DatanotesSettings): { values: Map<string, unknown>; body: string } {
  if (content === undefined) return { values: new Map(), body: "" };
  const { ordered, body } = readOrderedFromMarkdown(content, new Set([settings.tableKey]));
  return { values: new Map(ordered.filter(([k]) => k !== SYSTEM_ID_COLUMN)), body };
}

function cut(line: string): string {
  return line.length > DIFF_CHARS ? `${line.slice(0, DIFF_CHARS)}…` : line;
}

/** The lines only one side has (a multiset difference), at most DIFF_LINES each. */
function bodyDiff(before: string, after: string): NonNullable<RowVersion["body_diff"]> {
  const count = new Map<string, number>();
  const a = before.split("\n");
  const b = after.split("\n");
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of b) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else if (l.trim() !== "") added.push(l);
  }
  const removed: string[] = [];
  for (const l of a) {
    const n = count.get(l) ?? 0;
    if (n > 0 && l.trim() !== "") {
      removed.push(l);
      count.set(l, n - 1);
    }
  }
  const truncated = added.length > DIFF_LINES || removed.length > DIFF_LINES;
  return { removed: removed.slice(0, DIFF_LINES).map(cut), added: added.slice(0, DIFF_LINES).map(cut), ...(truncated ? { truncated: true as const } : {}) };
}

function versionOf(r: Raw, settings: DatanotesSettings): RowVersion {
  const before = columnsOf(r.before, settings);
  const after = columnsOf(r.after, settings);
  const changes: RowVersion["changes"] = {};
  if (r.change !== "delete") {
    for (const k of new Set([...before.values.keys(), ...after.values.keys()])) {
      // an insert names its table in `table`; a later change of the key (a renamed table) is a change
      if (r.change === "insert" && k === settings.tableKey) continue;
      const b = before.values.get(k);
      const a = after.values.get(k);
      if (JSON.stringify(b) !== JSON.stringify(a)) changes[k] = { before: b ?? null, after: a ?? null };
    }
  }
  const bodyChanged = r.change !== "delete" && r.change !== "insert" && before.body !== after.body;
  return {
    table: r.table,
    version: r.info.version,
    timestamp: r.info.timestamp,
    operation: r.info.operation,
    change: r.change,
    source: r.info.operation === EXTERNAL_EDIT ? "external" : "engine",
    path: r.path,
    ...(r.oldPath !== undefined ? { old_path: r.oldPath } : {}),
    ...(r.fromTable !== undefined ? { from_table: r.fromTable } : {}),
    ...(r.info.actor !== undefined ? { actor: r.info.actor } : {}),
    ...(r.info.userName !== undefined ? { user_name: r.info.userName } : {}),
    ...(r.info.migrationId !== undefined ? { migration_id: r.info.migrationId } : {}),
    changes,
    body_changed: bodyChanged,
    ...(bodyChanged ? { body_diff: bodyDiff(before.body, after.body) } : {}),
  };
}

function summaryOf(v: RowVersion): RowVersionSummary {
  const { table, version, timestamp, operation, change, source, path, actor, user_name, migration_id } = v;
  return {
    table,
    version,
    timestamp,
    operation,
    change,
    source,
    path,
    ...(actor !== undefined ? { actor } : {}),
    ...(user_name !== undefined ? { user_name } : {}),
    ...(migration_id !== undefined ? { migration_id } : {}),
  };
}

/** The ident to follow and the row's last known path, from the arguments and the table's log. */
async function identOf(app: App, settings: DatanotesSettings, full: string, input: RowHistoryInput): Promise<Ident> {
  const latest = await tableStateAt(app, settings, full);
  if (input.path === undefined) return { id: input.id! };
  const path = normalPath(input.path);
  const now = latest.files.get(path);
  const content = now?.content ?? (await lastAddAt(app, settings, full, path))?.content;
  if (content === undefined) {
    const byName = new Map([...latest.files.keys()].map((p) => [basenameOf(p), p]));
    const near = closestNames(basenameOf(path), byName.keys()).map((n) => byName.get(n)!);
    throw new OperationInputError(
      `${full} has no row at ${path}, now or in its history`,
      guide(`${near.length > 0 ? `Did you mean ${near.map((n) => `"${n}"`).join(" or ")}? ` : ""}${FIND_ROW.hint}`, "rowHistory"),
    );
  }
  const id = idOf(content);
  if (input.id !== undefined && id !== input.id) {
    throw new OperationInputError(`id ${input.id} is not the row at ${path}${id !== undefined ? ` (its id is ${id})` : ""}`, FIND_ROW);
  }
  return id !== undefined ? { id } : { path };
}

function limitOf(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
    throw new OperationInputError(`"limit" must be an integer from 1 to ${LIMIT_MAX}`, guide(`Pass a smaller "limit" and page with "before": each answer's next_before.`, "rowHistory"));
  }
  return limit;
}

export async function rowHistory(app: App, settings: DatanotesSettings, input: RowHistoryInput): Promise<RowHistory> {
  if (input.id === undefined && input.path === undefined) throw new OperationInputError(`pass the row's "id" or "path"`, FIND_ROW);
  const limit = limitOf(input.limit);
  const from = input.since !== undefined ? sinceMs(input.since) : -Infinity;
  const to = input.before !== undefined ? sinceMs(input.before) : Infinity;
  const ref = await historyTableName(app, settings, input.table);
  assertTableReadable(ref.full);
  if ((await listVersions(app, settings, ref.full)).length === 0) throw new OperationInputError(`${ref.full} has no history`, HISTORY_OFF(ref.full));
  const ident = await identOf(app, settings, ref.full, input);
  const { raws, walks } = await walkAcross(app, settings, ref.full, ident);
  const first = walks[0]!;
  const end = walks.at(-1)!;
  if (raws.length === 0 && !first.existedAtStart && end.last === null) {
    throw new OperationInputError(`${ref.full} has no row with id ${"id" in ident ? ident.id : ""} in its history`, FIND_ROW);
  }
  const all = raws.map((r) => versionOf(r, settings)).reverse();
  const created = !first.existedAtStart && all.length > 0 && all.at(-1)!.change === "insert" ? summaryOf(all.at(-1)!) : null;
  const lastPath = end.last?.path ?? all[0]?.path ?? first.last!.path;
  const matching = all.filter((v) => {
    const at = Date.parse(v.timestamp);
    return at >= from && at < to;
  });
  let page = matching.slice(0, limit);
  // a page never splits the versions of one moment: the next one starts strictly before it
  if (matching.length > limit) {
    const at = page.at(-1)!.timestamp;
    page = matching.filter((v, i) => i < limit || v.timestamp === at);
  }
  const more = matching.length > page.length;
  return {
    table: end.table,
    ...("id" in ident ? { id: ident.id } : {}),
    path: lastPath,
    exists: end.last !== null,
    created,
    last_modified: all.length > 0 ? summaryOf(all[0]!) : null,
    history_start: { table: first.table, ...first.start },
    total: matching.length,
    versions: page,
    ...(more ? { next_before: page.at(-1)!.timestamp } : {}),
  };
}
