/**
 * History of the whole database, on top of the tables' transaction logs (`transaction-log.ts`): the
 * commits of every logged table read together (`describe_history` without a table) and
 * `restore_database`, which brings every logged table back to one moment as one operation.
 *
 * An agent often changes several tables together (a batch, a cascade, inverse links): the
 * database's history groups the commits of one operation (or one batch) across its tables, and a
 * restore rewinds them all at once, with one migrationId that undo_migration reverts.
 */

import type { App, TFile } from "./host";
import { emptyChangeSet } from "./changeset";
import { commitInfos, historyEnabled, loggedTables, newestCommitInfos, readCurrentStates, tableStateAt, type CommitInfo, type FileState } from "./transaction-log";
import {
  archiveFolder,
  emptyResult,
  finish,
  instrumented,
  loadTable,
  OperationInputError,
  type OpConflict,
  type OpResult,
  type RunOptions,
} from "./engine";
import { restoreViolations, sinceMs } from "./history";
import { guide } from "./hints";
import { batchMembership, readJournal } from "./journal";
import { loadMetastore, metastorePath, parseMetastore, refOf, setTableEntry, type CatalogTableEntry } from "./metastore";
import type { DatanotesSettings } from "./settings";
import { currentReadScope, tableReadable } from "./read-scope";

// --- describe_history without a table ---

export interface DatabaseHistoryInput {
  limit?: number;
  /** ISO date or date-time: only the commits at or after it. */
  since?: string;
}

/** A commit of one table's log, in the database's history. */
export interface DatabaseCommit extends CommitInfo {
  /** The table (`catalog.schema.table`) the commit belongs to. */
  table: string;
  /** The batch the operation ran in (undo_migration on it reverts the whole batch). */
  batch?: string;
  /**
   * Every table the same operation committed to (the same `migrationId`, or the same `batch`),
   * this one included, when there are several: the commits of one change across tables.
   */
  tables?: string[];
}

export interface DatabaseHistory {
  /** Every table with a transaction log (dropped ones included), by full name. */
  tables: string[];
  /** Newest first, across the tables (`limit` commits, default 50). */
  history: DatabaseCommit[];
}

/**
 * The commits of every logged table, newest first; the commits of one operation are grouped by
 * `tables`. Under a read scope (a named token with `read` patterns), only the tables it may read
 * are listed, and only the commits whose every table (the operation's, or its batch's) it may read.
 */
export async function describeDatabaseHistory(app: App, settings: DatanotesSettings, input: DatabaseHistoryInput = {}): Promise<DatabaseHistory> {
  const from = input.since === undefined ? undefined : sinceMs(input.since);
  const tables = await loggedTables(app, settings);
  const limit = Math.max(input.limit ?? 50, 0);
  const batchOf = await batchMembership(app, settings);
  const scope = currentReadScope();
  if (!scope) return databaseCommits(tables, await newestOf(app, settings, tables, limit, from), batchOf, limit);
  const readable = tables.filter((t) => tableReadable(t, scope));
  if (!(limit > 0)) return { tables: readable, history: [] };
  // The newest `depth` commits of each readable table, and every commit of the other tables from
  // the oldest of those on (a minute before: the other commits of the same operation), so an
  // operation that also wrote an unreadable table is known as one. Commits hidden that way leave
  // fewer than `limit`: read deeper until `limit` are shown or the readable logs are read in full.
  for (let depth = limit; ; depth *= 2) {
    const mine = await newestOf(app, settings, readable, depth, from);
    const oldest = mine.reduce((m, c) => Math.min(m, Date.parse(c.timestamp)), Infinity);
    const others = oldest === Infinity ? [] : await newestOf(app, settings, tables.filter((t) => !readable.includes(t)), Infinity, Math.max(from ?? -Infinity, oldest - 60_000));
    const all = databaseCommits(tables, [...mine, ...others], batchOf, Infinity);
    const shown = all.history.filter((c) => tableReadable(c.table, scope) && (c.tables ?? []).every((t) => tableReadable(t, scope)));
    // final when no table read only in part can hold a newer commit than the last one shown
    const last = shown.length >= limit ? shown[limit - 1]!.timestamp : null;
    const complete = readable.every((t) => {
      const read = mine.filter((c) => c.table === t);
      // newest first: the last one read is the oldest, and every one not read is older still
      return read.length < depth || (last !== null && read[read.length - 1]!.timestamp < last);
    });
    if (complete) return { tables: readable, history: shown.slice(0, limit) };
  }
}

/** The newest `limit` commits of each of these tables, at or after `from`. */
async function newestOf(app: App, settings: DatanotesSettings, tables: readonly string[], limit: number, from: number | undefined): Promise<DatabaseCommit[]> {
  const all: DatabaseCommit[] = [];
  for (const table of tables) for (const c of await newestCommitInfos(app, settings, table, limit, from)) all.push({ table, ...c });
  return all;
}

/** The newest `limit` of these commits, newest first, each with its batch and the tables of its operation. */
function databaseCommits(tables: string[], all: DatabaseCommit[], batchOf: Map<string, string>, limit: number): DatabaseHistory {
  const groupOf = (c: DatabaseCommit) => (c.migrationId === undefined ? undefined : (batchOf.get(c.migrationId) ?? c.migrationId));
  const groups = new Map<string, Set<string>>();
  for (const c of all) {
    const g = groupOf(c);
    if (g === undefined) continue;
    if (!groups.has(g)) groups.set(g, new Set());
    groups.get(g)!.add(c.table);
  }
  all.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.table.localeCompare(b.table) || b.version - a.version);
  const history = all.slice(0, limit).map((c) => {
    const batch = c.migrationId === undefined ? undefined : batchOf.get(c.migrationId);
    const together = groups.get(groupOf(c) ?? "");
    return { ...c, ...(batch ? { batch } : {}), ...(together && together.size > 1 ? { tables: [...together].sort() } : {}) };
  });
  return { tables, history };
}

// --- restore_database ---

export interface RestoreDatabaseInput {
  /** RFC 3339 / ISO date-time: every table as it was then (its last version at or before it). */
  timestamp?: string;
  /** A migrationId: every table as it was just before that operation (or batch) ran. */
  beforeMigration?: string;
}

/** What restore_database changes (or would change) in one table. */
export interface TableRestorePlan {
  table: string;
  /**
   * `restore`: rows and/or definition go back; `drop`: the table did not exist then (created since,
   * or dropped at that time): its definition is removed and its rows archived, as drop_table with
   * mode "archive"; `recreate`: dropped since, it comes back with its rows.
   */
  action: "restore" | "drop" | "recreate";
  /** The version of its log restored; null when the table did not exist then. */
  version: number | null;
  /** Its entry in metastore.yaml changes. */
  definition_changed: boolean;
  creates: string[];
  /** Rows that get their old text back. */
  texts: string[];
  /** Rows created since, deleted (to the trash; undo_migration puts them back). */
  deletes: string[];
  /** Rows of a dropped table moved to its archive folder. */
  archived: { from: string; to: string }[];
}

export interface SkippedTable {
  table: string;
  reason: string;
}

export interface RestoreDatabaseResult extends OpResult {
  /** The moment restored: `timestamp`, or the last millisecond before `before_migration` (a timestamp naming the same state). */
  restored_to: string;
  /** The tables that change, by name. */
  tables: TableRestorePlan[];
  /** Logged tables already as they were then (no new version). */
  unchanged: string[];
  /** Tables that cannot be rewound, with the reason: they keep no transaction log, or not that far back. */
  skipped: SkippedTable[];
}

interface Point {
  /** ISO time restored. */
  at: string;
  ms: number;
  /** Commits at `ms` itself are after the point (before_migration). */
  strict: boolean;
  /** The operations of before_migration (the batch and its members). */
  ids?: Set<string>;
}

async function pointOf(app: App, settings: DatanotesSettings, input: RestoreDatabaseInput, logs: Map<string, CommitInfo[]>): Promise<Point> {
  if ((input.timestamp === undefined) === (input.beforeMigration === undefined)) {
    throw new OperationInputError(`pass "timestamp" or "before_migration" (one of them)`);
  }
  if (input.timestamp !== undefined) {
    const ms = Date.parse(input.timestamp);
    if (Number.isNaN(ms)) throw new OperationInputError(`"timestamp" is not a date-time: ${input.timestamp}`);
    return { at: new Date(ms).toISOString(), ms, strict: false };
  }
  const id = input.beforeMigration!;
  const { entry } = await readJournal(app, settings, id);
  const ids = new Set([entry.migration_id, ...(entry.members ?? [])]);
  let ms = Infinity;
  for (const log of logs.values()) {
    for (const c of log) if (c.migrationId !== undefined && ids.has(c.migrationId)) ms = Math.min(ms, Date.parse(c.timestamp));
  }
  if (ms === Infinity) {
    // a timestamp would restore nothing either (those tables keep no log): the journal reverts it
    throw new OperationInputError(
      `${id} changed no table that keeps a transaction log: restore_database has no state before it to go back to`,
      guide(`Undo it with undo_migration (migration_id "${id}"): the journal reverts any write, with or without history. restore_database goes back only through tables with history on (alter_table history="on").`, "undo"),
    );
  }
  // the last moment before the operation: given back as a timestamp, it names the same state
  return { at: new Date(ms - 1).toISOString(), ms, strict: true, ids };
}

/** The version of a log at the point: -1 when the table did not exist yet. */
function versionAt(log: CommitInfo[], p: Point): number {
  // a table the operation changed: the version before its first commit of it
  const first = p.ids ? log.find((c) => c.migrationId !== undefined && p.ids!.has(c.migrationId)) : undefined;
  if (first) return first.version - 1;
  let v = -1;
  for (const c of log) {
    const t = Date.parse(c.timestamp);
    if (p.strict ? t >= p.ms : t > p.ms) break;
    v = c.version;
  }
  return v;
}

interface Target {
  version: number;
  entry: CatalogTableEntry | null;
  files: Map<string, FileState>;
}

/**
 * RESTORE every logged table to one moment, as one operation: what restore_table does to one
 * table, to all of them, plus the tables created since (dropped, rows archived) and the ones
 * dropped since (brought back). CHECKs that follow links are checked on the state it leaves.
 */
async function restoreDatabaseImpl(app: App, settings: DatanotesSettings, input: RestoreDatabaseInput, opts: RunOptions = {}): Promise<RestoreDatabaseResult> {
  const logged = await loggedTables(app, settings);
  const logs = new Map<string, CommitInfo[]>();
  for (const full of logged) logs.set(full, await commitInfos(app, settings, full));
  const point = await pointOf(app, settings, input, logs);
  const ms = await loadMetastore(app, settings);
  const model = ms?.model ?? parseMetastore("");
  const current = await readCurrentStates(app, settings, model, []);

  const skipped: SkippedTable[] = [];
  const targets = new Map<string, Target>();
  for (const full of [...new Set([...logged, ...current.keys()])].sort()) {
    const cur = current.get(full);
    const log = logs.get(full);
    if (cur && !historyEnabled(model, cur.entry)) {
      skipped.push({ table: full, reason: `history is off for it: it keeps no transaction log to go back with (alter_table history=true, or configure_database history=true, keeps one from then on)` });
      continue;
    }
    if (!log) {
      skipped.push({ table: full, reason: "nothing is logged for it yet (its log starts with the next write)" });
      continue;
    }
    const version = versionAt(log, point);
    const oldest = log[0]!.version;
    if (oldest > 0 && version < oldest) {
      skipped.push({ table: full, reason: `its history before version ${oldest} (${log[0]!.timestamp}) was removed by vacuum_table` });
      continue;
    }
    const state = version < 0 ? null : await tableStateAt(app, settings, full, { version });
    targets.set(full, { version, entry: state?.entry ?? null, files: state?.files ?? new Map() });
  }

  // every row file the restored tables have then: no table's deletes or archiving touch them
  const desired = new Set<string>();
  for (const t of targets.values()) if (t.entry) for (const path of t.files.keys()) desired.add(path);

  const summary = input.timestamp !== undefined ? `restore database to ${point.at}` : `restore database to before ${input.beforeMigration}`;
  const cs = emptyChangeSet("restore_database", summary, metastorePath(settings));
  const conflicts: OpConflict[] = [];
  const archiveTargets = new Set<string>();
  const textBefore = ms?.text ?? "";
  let text = textBefore;
  const tables: TableRestorePlan[] = [];
  const unchanged: string[] = [];
  for (const [full, t] of targets) {
    const cur = current.get(full);
    const files = cur?.files ?? new Map<string, FileState>();
    const entryNow = cur?.entry ?? null;
    const plan: TableRestorePlan = {
      table: full,
      action: t.entry === null ? "drop" : entryNow === null ? "recreate" : "restore",
      version: t.version < 0 ? null : t.version,
      definition_changed: JSON.stringify(entryNow) !== JSON.stringify(t.entry),
      creates: [],
      texts: [],
      deletes: [],
      archived: [],
    };
    if (plan.definition_changed) {
      const [c, s, n] = full.split(".") as [string, string, string];
      text = setTableEntry(text, refOf(c, s, n), t.entry);
    }
    if (t.entry) {
      for (const [path, f] of t.files) {
        const now = files.get(path);
        const file = now ? null : app.vault.getAbstractFileByPath(path);
        // a note that is no row of the table now (moved to another table, or its table was dropped)
        const before = now ? now.content : file ? await app.vault.read(file as TFile) : undefined;
        if (before === undefined) {
          cs.creates.push({ path, content: f.content });
          plan.creates.push(path);
        } else if (before !== f.content) {
          cs.texts.push({ path, before, after: f.content });
          plan.texts.push(path);
        }
      }
      for (const path of files.keys()) {
        if (desired.has(path)) continue;
        cs.deletes.push(path);
        plan.deletes.push(path);
      }
    } else if (cur) {
      const folder = archiveFolder((await loadTable(app, settings, full)).def);
      for (const path of files.keys()) {
        if (desired.has(path)) continue;
        const to = `${folder}/${path.slice(path.lastIndexOf("/") + 1)}`;
        if (archiveTargets.has(to) || app.vault.getAbstractFileByPath(to) != null) conflicts.push({ path, message: `archive target exists: ${to}` });
        archiveTargets.add(to);
        cs.moves.push({ from: path, to });
        plan.archived.push({ from: path, to });
      }
    }
    if (!plan.definition_changed && plan.creates.length + plan.texts.length + plan.deletes.length + plan.archived.length === 0) unchanged.push(full);
    else tables.push(plan);
  }
  if (text !== textBefore) cs.texts.unshift({ path: metastorePath(settings), before: textBefore, after: text });

  const extra = { restored_to: point.at, tables, unchanged, skipped };
  if (tables.length === 0) return { ...emptyResult(cs.op, opts.dryRun === true), ok: true, ...extra };

  return { ...(await finish(app, settings, cs, conflicts, await restoreViolations(app, settings, cs), opts)), ...extra };
}

export const restoreDatabase = instrumented("restore_database", restoreDatabaseImpl, (i) => ({
  timestamp: i.timestamp,
  before_migration: i.beforeMigration,
}));
