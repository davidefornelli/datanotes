/**
 * Table history on top of the transaction log (`transaction-log.ts`):
 * `describe_history`, time travel (`select` with `version` / `timestamp`), `restore_table`,
 * `table_changes` (change data feed) and `vacuum`.
 */

import type { App, TFile } from "./host";
import { emptyChangeSet, type ChangeSet } from "./changeset";
import {
  AbsentTableError,
  applyCommit,
  commitInfos,
  history,
  HistoryError,
  loggedTables,
  listVersions,
  newestCommitInfos,
  readCommit,
  readCurrentStates,
  tableStateAt,
  transactionLogDir,
  vacuum,
  withLogLock,
  type AsOf,
  type CommitInfo,
  type TableState,
  type VacuumResult,
} from "./transaction-log";
import { MOVES_FILE } from "./database-move";
import { storeGeneration } from "./store";
import {
  catalogLoadedTable,
  finish,
  instrumented,
  OperationInputError,
  RESTORE_WAY_OUT,
  type LoadedRowWithBody as LoadedRow,
  type LoadedTable,
  type OpResult,
  type RowViolations,
  type RunOptions,
} from "./engine";
import { readOrderedFromMarkdown } from "./frontmatter";
import {
  loadMetastore,
  metastorePath,
  parseMetastore,
  refOf,
  resolveCatalogRef,
  setTableEntry,
  type CatalogRef,
  type Metastore,
} from "./metastore";
import type { DatanotesSettings } from "./settings";
import { tableNotFound } from "./table-registry";
import { guide, type Guidance } from "./hints";
import { phase } from "./tracing";

/** A table without a transaction log: how to turn it on. */
export const HISTORY_OFF = (full: string) => guide(`Turn history on for it with alter_table("${full}", history: true), or for every table with configure_database(history: true); versions are kept from then on.`, "history");
const ASOF_HINT = guide(`Pass "version" (an integer from describe_history) or "timestamp" (an ISO date-time), not both.`, "readAsOf");

/**
 * Full name of a metastore table, or of a dropped table that still has a log
 * (`catalog.schema.table` required then).
 */
export async function historyTableName(app: App, settings: DatanotesSettings, table: string): Promise<CatalogRef> {
  const ms = await loadMetastore(app, settings);
  const ref = ms ? resolveCatalogRef(ms.model, table) : null;
  if (ref) return ref;
  const parts = table.trim().split(".");
  if (parts.length === 3 && (await loggedTables(app, settings)).includes(table.trim())) return refOf(parts[0]!, parts[1]!, parts[2]!);
  throw tableNotFound(table, ms?.model);
}

function asOfOf(input: AsOf): AsOf {
  if (input.version !== undefined && input.timestamp !== undefined) {
    throw new OperationInputError(`pass "version" or "timestamp", not both`, ASOF_HINT);
  }
  if (input.version !== undefined && (!Number.isInteger(input.version) || input.version < 0)) {
    throw new OperationInputError(`"version" must be a non-negative integer`, ASOF_HINT);
  }
  return input;
}

/** Time travel to a moment when the table did not exist (before its first version, or dropped). */
export class TableAbsentError extends OperationInputError {}

async function stateAt(app: App, settings: DatanotesSettings, full: string, asOf: AsOf): Promise<TableState> {
  try {
    return await tableStateAt(app, settings, full, asOf);
  } catch (e) {
    if (e instanceof AbsentTableError) throw new TableAbsentError(e.message, guide(`${full} did not exist then: pick a later version or time; describe_history("${full}") shows when it was created.`, "readAsOf"));
    /* v8 ignore next -- defensive: the log raises HistoryError; anything else goes up unchanged */
    if (!(e instanceof HistoryError)) throw e;
    throw new OperationInputError(e.message, historyGuidance(full, e.message));
  }
}

/** Guidance for an error of a table's transaction log. */
function historyGuidance(full: string, message: string): Guidance {
  return /has no history/.test(message) ? HISTORY_OFF(full) : guide(`describe_history("${full}") lists the versions and their times.`, "versions");
}

function pseudoFile(path: string): TFile {
  const name = path.split("/").pop()!; // split() returns at least one element
  return { path, name, basename: name.replace(/\.md$/i, ""), extension: "md" } as unknown as TFile;
}

function modelWith(ref: CatalogRef, state: TableState, bases: Metastore["bases"]): Metastore {
  return {
    config: {},
    bases,
    catalogs: { [ref.catalog]: { schemas: { [ref.schema]: { tables: { [ref.table]: state.entry! }, views: {} } } } },
  };
}

// --- describe_history ---

export interface DescribeHistoryInput {
  table: string;
  limit?: number;
  /** ISO date or date-time: only the versions committed at or after it. */
  since?: string;
}

export interface HistoryDescription {
  table: string;
  /** Newest first. */
  history: CommitInfo[];
}

/**
 * A commit as describe_history answers it: snake_case. The log keeps the Delta protocol's own
 * names (`operationParameters`, `engineInfo`, …), which other Delta readers expect.
 */
export function wireCommit(c: CommitInfo & { table?: string; batch?: string; tables?: string[] }): Record<string, unknown> {
  const m = c.operationMetrics;
  return {
    ...(c.table !== undefined ? { table: c.table } : {}),
    version: c.version,
    timestamp: c.timestamp,
    operation: c.operation,
    ...(c.operationParameters !== undefined ? { operation_parameters: c.operationParameters } : {}),
    ...(c.migrationId !== undefined ? { migration_id: c.migrationId } : {}),
    operation_metrics: {
      num_added_files: m.numAddedFiles,
      num_removed_files: m.numRemovedFiles,
      metadata_changed: m.metadataChanged,
      ...(m.violations !== undefined ? { violations: m.violations } : {}),
    },
    engine_info: c.engineInfo,
    ...(c.userName !== undefined ? { user_name: c.userName } : {}),
    ...(c.actor !== undefined ? { actor: c.actor } : {}),
    ...(c.batch !== undefined ? { batch: c.batch } : {}),
    ...(c.tables !== undefined ? { tables: c.tables } : {}),
  };
}

/** `since` of describe_history, in milliseconds. */
export function sinceMs(since: string): number {
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new OperationInputError(`"since" is not a date or date-time: ${since}`, guide(`Write "since" as a date (2026-10-01) or an ISO date-time (2026-10-01T09:00:00Z).`, "versions"));
  return ms;
}

/**
 * The newest `limit` commit infos, newest first, each read from its commit's first line only (a
 * commit holds the text of every row it adds). A log that is not as the engine writes it (a
 * commit whose first line is no commitInfo) is read in full instead, and refused as before.
 */
async function newestHistory(app: App, settings: DatanotesSettings, full: string, limit: number): Promise<CommitInfo[]> {
  try {
    // as many as `slice(0, limit)` keeps, whatever number `limit` is
    const infos = await newestCommitInfos(app, settings, full, Number.isNaN(limit) ? 0 : Math.max(0, Math.trunc(limit)));
    if (infos.every((c) => c !== null && typeof c === "object")) return infos;
  } catch {
    // read in full below
  }
  return history(app, settings, full, limit);
}

export async function describeHistory(app: App, settings: DatanotesSettings, input: DescribeHistoryInput): Promise<HistoryDescription> {
  const ref = await historyTableName(app, settings, input.table);
  const limit = input.limit ?? 50;
  if (input.since === undefined) return { table: ref.full, history: await newestHistory(app, settings, ref.full, limit) };
  const from = sinceMs(input.since);
  const infos = (await commitInfos(app, settings, ref.full)).filter((c) => Date.parse(c.timestamp) >= from);
  return { table: ref.full, history: infos.reverse().slice(0, Math.max(limit, 0)) };
}

// --- time travel ---

export interface HistoricalTable {
  table: LoadedTable;
  rows: LoadedRow[];
  version: number;
  timestamp: string;
}

/** A table's state as of a version or time, its rows parsed: what time travel reads. */
interface Replayed {
  version: number;
  timestamp: string;
  entry: TableState["entry"];
  rows: LoadedRow[];
  /** The characters of its rows' texts, for the budget. */
  chars: number;
  /** The store's count of changes to the table's log and to the moves of the database folder, when it was replayed. */
  stamp: string;
}

/**
 * Tables replayed for time travel, kept for the reads that ask the same again (a page after a page,
 * an agent comparing versions): at most `maxEntries`, and `maxChars` characters of row text, the
 * least recently used out first. A replay stays right while the table's log and the moves of the
 * database folder are unchanged: the log only grows, a vacuum or a move changes them.
 */
export const TIME_TRAVEL_CACHE = { maxEntries: 8, maxChars: 16 * 1024 * 1024 };

const REPLAYED = new WeakMap<object, Map<string, Replayed>>();

/** What a replay of `full` depends on, as the store counts its changes. */
function replayStamp(app: App, settings: DatanotesSettings, full: string): string {
  return `${storeGeneration(app, transactionLogDir(settings, full))}/${storeGeneration(app, MOVES_FILE)}`;
}

async function replayed(app: App, settings: DatanotesSettings, full: string, asOf: AsOf): Promise<Replayed> {
  const at = asOfOf(asOf);
  let cache = REPLAYED.get(app);
  if (!cache) REPLAYED.set(app, (cache = new Map()));
  const key = [full, at.version ?? "", at.timestamp ?? "", settings.tableKey].join("\u0000");
  // taken before reading: a change while it replays leaves a stamp that no longer matches
  const stamp = replayStamp(app, settings, full);
  const kept = cache.get(key);
  if (kept && kept.stamp === stamp) {
    cache.delete(key);
    cache.set(key, kept);
    return kept;
  }
  const state = await stateAt(app, settings, full, at);
  const keep = new Set([settings.tableKey]);
  let chars = 0;
  const rows: LoadedRow[] = [...state.files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, f]) => {
      chars += f.content.length;
      const { ordered, body } = readOrderedFromMarkdown(f.content, keep);
      return { file: pseudoFile(path), ordered, body };
    });
  const r: Replayed = { version: state.version, timestamp: state.timestamp, entry: state.entry, rows, chars, stamp };
  cache.delete(key);
  if (chars <= TIME_TRAVEL_CACHE.maxChars) {
    cache.set(key, r);
    let total = 0;
    for (const x of cache.values()) total += x.chars;
    for (const [k, x] of cache) {
      if (cache.size <= TIME_TRAVEL_CACHE.maxEntries && total <= TIME_TRAVEL_CACHE.maxChars) break;
      cache.delete(k);
      total -= x.chars;
    }
  }
  return r;
}

/** A table and its rows as of a version or time (read from the log; nothing is written). */
async function loadTableAsOfImpl(
  app: App,
  settings: DatanotesSettings,
  table: string,
  asOf: AsOf,
): Promise<HistoricalTable> {
  const ref = await historyTableName(app, settings, table);
  const r = await replayed(app, settings, ref.full, asOf);
  if (r.entry == null) throw new TableAbsentError(`${ref.full} did not exist at version ${r.version} (dropped)`);
  const ms = await loadMetastore(app, settings);
  const file = ms?.file ?? pseudoFile(metastorePath(settings));
  // Bases are read from the current metastore (the log keeps table entries, not bases). The entry
  // and the rows are the caller's own: the replay may be read again.
  const state = { entry: JSON.parse(JSON.stringify(r.entry)) as TableState["entry"] } as TableState;
  const t = catalogLoadedTable(settings, { file, text: "", model: modelWith(ref, state, ms?.model.bases ?? {}) }, ref);
  const rows = r.rows.map((x) => ({ file: x.file, ordered: x.ordered.map(([k, v]) => [k, v] as [string, unknown]), body: x.body }));
  return { table: t, rows, version: r.version, timestamp: r.timestamp };
}

// --- restore_table ---

export interface RestoreTableInput extends AsOf {
  table: string;
}

/**
 * RESTORE TABLE … TO VERSION AS OF: rows and definition return to that version. Rows added since
 * are deleted, changed rows get their old content back, removed rows are re-created. One journaled
 * operation (undo_migration reverts it) and a new log version: history is never rewritten.
 */
async function restoreTableImpl(
  app: App,
  settings: DatanotesSettings,
  input: RestoreTableInput,
  opts: RunOptions = {},
): Promise<OpResult> {
  const ref = await historyTableName(app, settings, input.table);
  const target = await stateAt(app, settings, ref.full, asOfOf(input));
  const ms = await loadMetastore(app, settings);
  const model = ms?.model ?? parseMetastore("");
  const current = (await readCurrentStates(app, settings, model, [])).get(ref.full);
  const files = current?.files ?? new Map();
  const cs = emptyChangeSet("restore_table", `restore ${ref.full} to version ${target.version}`, `${metastorePath(settings)}#${ref.full}`);
  const text = ms?.text ?? "";
  const entryNow = current?.entry ?? null;
  if (JSON.stringify(entryNow) !== JSON.stringify(target.entry)) {
    cs.texts.push({ path: metastorePath(settings), before: text, after: setTableEntry(text, ref, target.entry) });
  }
  for (const [path, f] of target.files) {
    const now = files.get(path);
    if (!now) {
      const exists = app.vault.getAbstractFileByPath(path) != null;
      if (exists) {
        // The file is there but is no longer a row of this table: put the old content back.
        const before = await app.vault.read(app.vault.getAbstractFileByPath(path) as TFile);
        cs.texts.push({ path, before, after: f.content });
      } else {
        cs.creates.push({ path, content: f.content });
      }
    } else if (now.hash !== f.hash) {
      cs.texts.push({ path, before: now.content, after: f.content });
    }
  }
  for (const path of files.keys()) if (!target.files.has(path)) cs.deletes.push(path);
  return finish(app, settings, cs, [], await restoreViolations(app, settings, cs), opts);
}

/**
 * CHECKs that follow links and filtered link columns, as the restore leaves the definitions, on the
 * rows as the restore leaves them: rows it would break refuse it, as for other writes, and a rule
 * the restore puts back must hold on every row (restore_table and restore_database).
 */
export async function restoreViolations(app: App, settings: DatanotesSettings, cs: ChangeSet): Promise<RowViolations[]> {
  const check = emptyChangeSet(cs.op, cs.summary);
  check.creates = cs.creates;
  check.deletes = cs.deletes;
  check.moves = cs.moves;
  for (const x of cs.texts) {
    if (/\.md$/i.test(x.path)) check.edits.push({ path: x.path, before: readOrderedFromMarkdown(x.before).ordered, after: readOrderedFromMarkdown(x.after).ordered });
    else check.texts.push(x);
  }
  const { linkedCheckViolations, metastoreLeftBy } = await import("./changeset-checks");
  return (await linkedCheckViolations(app, settings, check, new Set(), await metastoreLeftBy(app, settings, check))).map((x) => ({
    ...x,
    violations: x.violations.map((v) => ({ ...v, message: `${v.message}; to restore, ${RESTORE_WAY_OUT}` })),
  }));
}

export const restoreTable = instrumented("restore_table", restoreTableImpl, (i) => ({
  table: i.table,
  version: i.version,
  timestamp: i.timestamp,
}));

// --- table_changes (change data feed) ---

export interface TableChangesInput {
  table: string;
  startVersion: number;
  endVersion?: number;
}

export type ChangeType = "insert" | "delete" | "update_preimage" | "update_postimage" | "metadata";

export interface TableChange {
  _change_type: ChangeType;
  _commit_version: number;
  _commit_timestamp: string;
  _operation: string;
  path?: string;
  [column: string]: unknown;
}

function rowValues(content: string, settings: DatanotesSettings): Record<string, unknown> {
  const { ordered } = readOrderedFromMarkdown(
    content,
    new Set([settings.tableKey]),
  );
  return Object.fromEntries(ordered.filter(([k]) => k !== settings.tableKey));
}

/** Row-level changes between two versions (both included), oldest first. */
export async function tableChanges(
  app: App,
  settings: DatanotesSettings,
  input: TableChangesInput,
): Promise<{ table: string; changes: TableChange[] }> {
  const ref = await historyTableName(app, settings, input.table);
  const versions = await listVersions(app, settings, ref.full);
  if (versions.length === 0) throw new OperationInputError(`${ref.full} has no history`, HISTORY_OFF(ref.full));
  const latest = versions[versions.length - 1]!;
  const start = input.startVersion;
  const end = input.endVersion ?? latest;
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < start) {
    throw new OperationInputError(`"start_version" and "end_version" must be integers with start <= end`, guide(`describe_history("${ref.full}") lists the versions; pass start_version <= end_version among them.`, "versions"));
  }
  if (end > latest) throw new OperationInputError(`${ref.full} has no version ${end} (latest: ${latest})`, guide(`describe_history("${ref.full}") lists the versions; the latest is ${latest}.`, "versions"));
  // the version before the range, replayed once; each commit of the range is then applied to it
  // (with today's paths, as the replay gives them) instead of replaying the log again per version
  let prev: TableState = start === 0 ? { full: ref.full, version: -1, timestamp: "", entry: null, files: new Map() } : await stateAt(app, settings, ref.full, { version: start - 1 });
  const changes: TableChange[] = [];
  for (const v of versions) {
    if (v < start || v > end) continue;
    const c = await readCommit(app, settings, ref.full, v);
    const meta = { _commit_version: v, _commit_timestamp: c.commitInfo.timestamp, _operation: c.commitInfo.operation };
    if (c.metaData !== undefined && v > 0) changes.push({ _change_type: "metadata", ...meta });
    const added = new Map(c.add.map((a) => [a.path, a]));
    const removed = new Set(c.remove.map((r) => r.path));
    for (const r of c.remove) {
      const before = prev.files.get(r.path)?.content;
      /* v8 ignore next -- defensive: a removed file was in the previous version */
      const values = before !== undefined ? rowValues(before, settings) : {};
      const after = added.get(r.path);
      changes.push({ ...values, path: r.path, _change_type: after ? "update_preimage" : "delete", ...meta });
      if (after) changes.push({ ...rowValues(after.content, settings), path: r.path, _change_type: "update_postimage", ...meta });
    }
    for (const a of c.add) {
      if (removed.has(a.path)) continue;
      changes.push({ ...rowValues(a.content, settings), path: a.path, _change_type: "insert", ...meta });
    }
    // a private state: changed in place
    prev = applyCommit(prev, c);
  }
  return { table: ref.full, changes };
}

// --- vacuum ---

export interface VacuumInput {
  table: string;
  /** Oldest version to keep for time travel (default: only the latest). */
  retainFrom?: number;
}

export async function vacuumTable(
  app: App,
  settings: DatanotesSettings,
  input: VacuumInput,
  opts: RunOptions = {},
): Promise<VacuumResult> {
  const ref = await historyTableName(app, settings, input.table);
  return withLogLock(app, async () => {
    try {
      return await vacuum(app, settings, ref.full, input.retainFrom, opts.dryRun === true);
    } catch (e) {
      /* v8 ignore next -- defensive: the log raises HistoryError; anything else goes up unchanged */
      if (!(e instanceof HistoryError)) throw e;
      throw new OperationInputError(e.message, historyGuidance(ref.full, e.message));
    }
  });
}

/** {@link loadTableAsOfImpl}, traced: a time-travel read rebuilds the table from its history. */
export function loadTableAsOf(...args: Parameters<typeof loadTableAsOfImpl>): ReturnType<typeof loadTableAsOfImpl> {
  return phase("engine.history.read", async (span) => {
    const t = await loadTableAsOfImpl(...args);
    span.setAttributes({ "datanotes.version": t.version, "datanotes.rows_scanned": t.rows.length });
    return t;
  }, { "db.collection.name": args[2] });
}
