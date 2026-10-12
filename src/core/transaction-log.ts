/**
 * Transaction log for metastore tables (`store:transaction_log/<catalog.schema.table>/`).
 *
 * Every change to a table is a numbered commit (`00000000000000000007.json`, one JSON action per
 * line): `commitInfo` (operation, time, parameters), `metaData` when the table
 * definition changed, `add` for each row file written (path, hash and full content) and `remove`
 * for each row file gone. A checkpoint holds the whole state; one is written when the commits since
 * the last checkpoint outweigh it (see {@link CHECKPOINT_POLICY}), so the log grows with what is
 * written, not with the table size, and replay reads at most ~3x the table.
 *
 * Commits are derived by diffing the table's current state (its row files and `metastore.yaml`
 * entry) with the state the log describes, so the log sees every change: operations of the plugin
 * (named after the operation) and edits made by hand in Obsidian (`EXTERNAL_EDIT`).
 * History is kept until `vacuum` removes it.
 */

import type { App, TFile } from "./host";
import { contentHash, readHashed, readParsed } from "./file-cache";

export { contentHash };
import { fmGet, readOrderedFromMarkdown } from "./frontmatter";
import {
  catalogTables,
  entryToOrdered,
  loadMetastore,
  refOf,
  rowTableFull,
  type CatalogTableEntry,
  type Metastore,
} from "./metastore";
import { actorName, type Actor } from "./actor";
import type { DatanotesSettings } from "./settings";
import { storeExists, storeList, storePath, storeRead, storeRemove, storeRename, storeWrite } from "./store";
import { catalogLayout, parseTableOptions } from "./table-loader";
import { TABLE_KEY } from "./types-table";
import { databaseMoves, moveEntryPaths, moveLinks, movePath, type DatabaseMove } from "./database-move";
import { normalizeDatabaseFolder } from "./db-paths";
import { frontmatterError } from "./unreadable";

/** Whether the note at `path` is there but its front matter cannot be read (a hand edit broke its YAML). */
async function unreadableNow(app: App, path: string): Promise<boolean> {
  const f = app.vault.getAbstractFileByPath(path);
  if (f == null || !("extension" in f)) return false;
  try {
    return frontmatterError((await readHashed(app, f as TFile)).content) !== null;
  } catch {
    return false;
  }
}

export const TRANSACTION_LOG_FOLDER = "transaction_log";
/**
 * When to write a checkpoint: once the commits since the last one total at least
 * `max(bytesFactor × table size, minBytes)`, or after `maxVersions` commits.
 */
export const CHECKPOINT_POLICY = { bytesFactor: 2, minBytes: 256 * 1024, maxVersions: 1000 };
export const EXTERNAL_EDIT = "EXTERNAL_EDIT";

export interface CommitInfo {
  version: number;
  timestamp: string;
  operation: string;
  operationParameters?: Record<string, unknown>;
  /** Journal entry of the operation (`undo_migration` reverts it). */
  migrationId?: string;
  operationMetrics: {
    numAddedFiles: number;
    numRemovedFiles: number;
    metadataChanged: boolean;
    /**
     * EXTERNAL_EDIT: the rules this table's rows break because of the commit (see SyncOptions.check);
     * absent when nothing was checked (only bodies changed, or the check could not run).
     */
    violations?: number;
  };
  engineInfo: string;
  /** Who made the change: "harness / model" of the agent (absent for hand edits). */
  userName?: string;
  /** The agent behind the change: MCP session, harness, model, tool. */
  actor?: Actor;
}

export interface AddAction {
  path: string;
  hash: string;
  size: number;
  content: string;
}

export interface RemoveAction {
  path: string;
  hash: string;
}

export interface Commit {
  commitInfo: CommitInfo;
  /** Table definition after this commit; `null` when the table was dropped. Absent = unchanged. */
  metaData?: { entry: CatalogTableEntry | null };
  add: AddAction[];
  remove: RemoveAction[];
}

export interface FileState {
  hash: string;
  content: string;
}

/** A table as of a version: its definition and row files. */
export interface TableState {
  full: string;
  version: number;
  timestamp: string;
  entry: CatalogTableEntry | null;
  files: Map<string, FileState>;
  /** Commits (count and bytes) since the last checkpoint, for the checkpoint policy. */
  sinceCheckpoint?: { versions: number; bytes: number };
  /** How many moves of the database folder its paths reflect (see database-move.ts). */
  movesApplied?: number;
}

interface Checkpoint {
  version: number;
  timestamp: string;
  entry: CatalogTableEntry | null;
  files: { path: string; hash: string; content: string }[];
  /** How many moves of the database folder its paths reflect (absent: those recorded before `timestamp`). */
  moves?: number;
}

type LogSettings = Pick<DatanotesSettings, "databaseFolder" | "tableKey">;
/** The log's place does not depend on the settings (it is in the store); kept for the callers' shape. */
type RootSettings = object;

export class HistoryError extends Error {
  override readonly name = "HistoryError";
}

/** The table did not exist at the time asked for (before its first version). */
export class AbsentTableError extends HistoryError {}

// --- Paths ---

/** The log lives in the engine's store (`store:transaction_log/<catalog.schema.table>/`). */
export function transactionLogRoot(_settings: RootSettings): string {
  return storePath(TRANSACTION_LOG_FOLDER);
}

export function transactionLogDir(settings: RootSettings, full: string): string {
  return `${transactionLogRoot(settings)}/${full}`;
}

const pad = (v: number) => String(v).padStart(20, "0");
const commitPath = (dir: string, v: number) => `${dir}/${pad(v)}.json`;
const checkpointPath = (dir: string, v: number) => `${dir}/${pad(v)}.checkpoint.json`;
const COMMIT_RE = /\/(\d{20})\.json$/;
const CHECKPOINT_RE = /\/(\d{20})\.checkpoint\.json$/;

const entryHash = (entry: CatalogTableEntry | null) => (entry == null ? "" : contentHash(JSON.stringify(entry)));

// --- Reading the log ---

/** Tables that have a log (including dropped ones), by full name. */
export async function loggedTables(app: App, settings: RootSettings): Promise<string[]> {
  const base = `${transactionLogRoot(settings)}/`;
  const out: string[] = [];
  for (const dir of (await storeList(app, transactionLogRoot(settings))).folders) {
    if ((await storeList(app, dir)).files.some((f) => COMMIT_RE.test(f))) out.push(dir.slice(base.length));
  }
  return out.sort();
}

export async function listVersions(app: App, settings: RootSettings, full: string): Promise<number[]> {
  return (await storeList(app, transactionLogDir(settings, full))).files
    .map((f) => COMMIT_RE.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

async function listCheckpoints(app: App, dir: string): Promise<number[]> {
  return (await storeList(app, dir)).files
    .map((f) => CHECKPOINT_RE.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

const readText = storeRead;

export function parseCommit(text: string): Commit {
  const commit: Commit = { commitInfo: undefined as unknown as CommitInfo, add: [], remove: [] };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const action = JSON.parse(line) as Record<string, unknown>;
    if (action.commitInfo) commit.commitInfo = action.commitInfo as CommitInfo;
    else if ("metaData" in action) commit.metaData = action.metaData as Commit["metaData"];
    else if (action.add) commit.add.push(action.add as AddAction);
    else if (action.remove) commit.remove.push(action.remove as RemoveAction);
  }
  if (!commit.commitInfo) throw new HistoryError("log commit without commitInfo");
  return commit;
}

export function serializeCommit(c: Commit): string {
  const lines = [JSON.stringify({ commitInfo: c.commitInfo })];
  if (c.metaData !== undefined) lines.push(JSON.stringify({ metaData: c.metaData }));
  for (const r of c.remove) lines.push(JSON.stringify({ remove: r }));
  for (const a of c.add) lines.push(JSON.stringify({ add: a }));
  return `${lines.join("\n")}\n`;
}

export async function readCommit(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder">,
  full: string,
  version: number,
): Promise<Commit> {
  const text = await readText(app, commitPath(transactionLogDir(settings, full), version));
  if (text == null) throw new HistoryError(`${full} has no version ${version}`);
  return movedCommit(parseCommit(text), await databaseMoves(app));
}

/** A commit with today's paths: the moves of the database folder recorded after it applied. */
function movedCommit(c: Commit, moves: readonly DatabaseMove[]): Commit {
  let out = c;
  for (const m of moves) {
    if (m.at <= c.commitInfo.timestamp) continue;
    out = {
      ...out,
      ...(out.metaData !== undefined ? { metaData: { entry: moveEntryPaths(out.metaData.entry, m.from, m.to, m.entries) } } : {}),
      add: out.add.map((a) => ({ ...a, path: movePath(a.path, m.from, m.to, m.entries), content: moveLinks(a.content, m.from, m.to, m.entries) })),
      remove: out.remove.map((r) => ({ ...r, path: movePath(r.path, m.from, m.to, m.entries) })),
    };
  }
  return out;
}

/** A state's paths, links and table paths after one move of the database folder (in place). */
function moveState(state: TableState, m: DatabaseMove): void {
  const files = new Map<string, FileState>();
  for (const [path, f] of state.files) {
    const content = moveLinks(f.content, m.from, m.to, m.entries);
    files.set(movePath(path, m.from, m.to, m.entries), content === f.content ? f : { hash: contentHash(content), content });
  }
  state.files = files;
  state.entry = moveEntryPaths(state.entry, m.from, m.to, m.entries);
}

function emptyState(full: string): TableState {
  return { full, version: -1, timestamp: "", entry: null, files: new Map() };
}

/** The state after commit `c`; `inPlace` reuses the file map (replay of a private state). */
export function applyCommit(state: TableState, c: Commit, inPlace = false): TableState {
  const files = inPlace ? state.files : new Map(state.files);
  for (const r of c.remove) files.delete(r.path);
  for (const a of c.add) files.set(a.path, { hash: a.hash, content: a.content });
  return {
    full: state.full,
    version: c.commitInfo.version,
    timestamp: c.commitInfo.timestamp,
    entry: c.metaData !== undefined ? c.metaData.entry : state.entry,
    files,
  };
}

export interface AsOf {
  version?: number;
  /** RFC 3339 / ISO timestamp: the last version committed at or before it. */
  timestamp?: string;
}

/**
 * Replay the log up to `asOf` (default: latest). Returns the empty state (version -1) for a table
 * without a log. Throws when the requested version or time is outside the history.
 */
export async function tableStateAt(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder">,
  full: string,
  asOf: AsOf = {},
): Promise<TableState> {
  const dir = transactionLogDir(settings, full);
  const versions = (await listVersions(app, settings, full));
  if (versions.length === 0) {
    if (asOf.version !== undefined || asOf.timestamp !== undefined) {
      throw new HistoryError(
        `${full} has no history: time travel is off for it (turn it on with configure_database(history=true) or alter_table(history=true))`,
      );
    }
    return emptyState(full);
  }
  let target = versions[versions.length - 1]!;
  if (asOf.version !== undefined) {
    if (!versions.includes(asOf.version)) {
      throw new HistoryError(`${full} has no version ${asOf.version} (available: ${versions[0]}..${target})`);
    }
    target = asOf.version;
  }
  const limitMs = asOf.timestamp !== undefined ? Date.parse(asOf.timestamp) : undefined;
  if (limitMs !== undefined && Number.isNaN(limitMs)) throw new HistoryError(`"timestamp" is not a date-time: ${asOf.timestamp}`);

  // Paths are today's: each move of the database folder is applied where it happened in the
  // replay (a commit names the files as they were when it was written), the rest at the end.
  const moves = await databaseMoves(app);
  let applied = 0;
  const moveUpTo = (timestamp: string | null) => {
    while (applied < moves.length && (timestamp === null || moves[applied]!.at <= timestamp)) moveState(state, moves[applied++]!);
  };
  // Start from the newest usable checkpoint.
  let state = emptyState(full);
  for (const cp of (await listCheckpoints(app, dir)).reverse()) {
    if (cp > target) continue;
    const text = await readText(app, checkpointPath(dir, cp));
    if (text == null) continue;
    const c = JSON.parse(text) as Checkpoint;
    if (limitMs !== undefined && Date.parse(c.timestamp) > limitMs) continue;
    state = {
      full,
      version: c.version,
      timestamp: c.timestamp,
      entry: c.entry,
      files: new Map(c.files.map((f) => [f.path, { hash: f.hash, content: f.content }])),
    };
    applied = Math.min(c.moves ?? moves.filter((m) => m.at <= c.timestamp).length, moves.length);
    break;
  }
  const since = { versions: 0, bytes: 0 };
  for (const v of versions) {
    if (v <= state.version || v > target) continue;
    const text = (await readText(app, commitPath(dir, v)))!;
    const c = parseCommit(text);
    if (limitMs !== undefined && Date.parse(c.commitInfo.timestamp) > limitMs) break;
    moveUpTo(c.commitInfo.timestamp);
    state = applyCommit(state, c, true);
    since.versions++;
    since.bytes += text.length;
  }
  moveUpTo(null);
  state.sinceCheckpoint = since;
  state.movesApplied = applied;
  // Only a time before the first commit leaves nothing: a version in the log replays to itself.
  if (state.version < 0) throw new AbsentTableError(`${full} did not exist at ${asOf.timestamp}`);
  return state;
}

/**
 * The commit infos of a table's log, oldest first. Only the first line of each commit is parsed:
 * `commitInfo`, as {@link serializeCommit} writes it.
 */
export async function commitInfos(app: App, settings: RootSettings, full: string): Promise<CommitInfo[]> {
  const dir = transactionLogDir(settings, full);
  const out: CommitInfo[] = [];
  for (const v of await listVersions(app, settings, full)) {
    const text = (await readText(app, commitPath(dir, v)))!; // listed just now
    out.push((JSON.parse(text.slice(0, text.indexOf("\n"))) as { commitInfo: CommitInfo }).commitInfo);
  }
  return out;
}

/**
 * The newest commit infos of a table's log, newest first: at most `limit`, and none committed
 * before `from` (ms). Reads only those commits (a table's commit times do not go back).
 */
export async function newestCommitInfos(app: App, settings: RootSettings, full: string, limit: number, from?: number): Promise<CommitInfo[]> {
  const dir = transactionLogDir(settings, full);
  const out: CommitInfo[] = [];
  for (const v of (await listVersions(app, settings, full)).reverse()) {
    if (out.length >= limit) break;
    const text = (await readText(app, commitPath(dir, v)))!; // listed just now
    const info = (JSON.parse(text.slice(0, text.indexOf("\n"))) as { commitInfo: CommitInfo }).commitInfo;
    if (from !== undefined && Date.parse(info.timestamp) < from) break;
    out.push(info);
  }
  return out;
}

/** Commit infos, newest first. */
export async function history(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder">,
  full: string,
  limit = 50,
): Promise<CommitInfo[]> {
  const versions = (await listVersions(app, settings, full)).reverse().slice(0, Math.max(limit, 0));
  const out: CommitInfo[] = [];
  for (const v of versions) out.push((await readCommit(app, settings, full, v)).commitInfo);
  return out;
}

// --- Current state ---

function catalogEntryOptions(full: string, entry: CatalogTableEntry, settings: LogSettings) {
  const [c, s, t] = full.split(".") as [string, string, string];
  const ref = refOf(c, s, t);
  const options = parseTableOptions(entryToOrdered(ref, entry, settings).find(([k]) => k === TABLE_KEY)?.[1]);
  const layout = catalogLayout(normalizeDatabaseFolder(settings.databaseFolder), ref, options);
  return [...(options.exclude ?? []), layout.archive, transactionLogRoot(settings)];
}

/**
 * Row files of every metastore table, read from disk. Membership is checked on the file content
 * (not only Obsidian's index, which lags right after a write); `touched` adds paths the index may
 * not know yet.
 */
export async function readCurrentStates(
  app: App,
  settings: LogSettings,
  model: Metastore,
  touched: readonly string[],
  only?: ReadonlySet<string>,
): Promise<Map<string, { entry: CatalogTableEntry; files: Map<string, FileState> }>> {
  const out = new Map<string, { entry: CatalogTableEntry; files: Map<string, FileState> }>();
  const excludes = new Map<string, string[]>();
  for (const { ref, entry } of catalogTables(model)) {
    if (only && !only.has(ref.full)) continue;
    out.set(ref.full, { entry, files: new Map() });
    excludes.set(ref.full, catalogEntryOptions(ref.full, entry, settings));
  }
  if (out.size === 0) return out;
  const candidates = new Set<string>(touched.filter((p) => p.endsWith(".md")));
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    if (fm && fm[settings.tableKey] != null) candidates.add(f.path);
  }
  // Contents, hashes and parsed frontmatter come from the file cache: unchanged files cost nothing.
  const key = "member-tolerant";
  const resolved = new Map<string, string | null>();
  for (const path of [...candidates].sort()) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file == null || !("extension" in file)) continue;
    let raw: unknown;
    try {
      // Tolerant like Obsidian (lists of mappings, e.g. TaskNotes' reminders): only `table` is read here.
      const { ordered } = await readParsed(app, file as TFile, key, (c) => readOrderedFromMarkdown(c));
      raw = fmGet(ordered, settings.tableKey);
    } catch {
      continue; // malformed frontmatter: not a row until fixed
    }
    const rawKey = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
    if (!resolved.has(rawKey)) resolved.set(rawKey, rowTableFull(model, raw));
    const full = resolved.get(rawKey)!;
    if (full == null || !out.has(full)) continue;
    if (excludes.get(full)!.some((dir) => path.startsWith(`${dir}/`))) continue;
    out.get(full)!.files.set(path, await readHashed(app, file as TFile));
  }
  return out;
}

// --- Writing ---

async function writeNew(app: App, path: string, text: string): Promise<void> {
  if (await storeExists(app, path)) throw new HistoryError(`log file exists: ${path}`);
  await storeWrite(app, path, text);
}

async function writeCheckpoint(app: App, dir: string, state: TableState): Promise<void> {
  const cp: Checkpoint = {
    version: state.version,
    timestamp: state.timestamp,
    entry: state.entry,
    files: [...state.files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, f]) => ({ path, ...f })),
    ...(state.movesApplied ? { moves: state.movesApplied } : {}),
  };
  const path = checkpointPath(dir, state.version);
  if (!(await storeExists(app, path))) await writeNew(app, path, JSON.stringify(cp));
}

function checkpointDue(state: TableState, since: { versions: number; bytes: number }): boolean {
  if (since.versions >= CHECKPOINT_POLICY.maxVersions) return true;
  let size = 0;
  for (const f of state.files.values()) size += f.content.length;
  return since.bytes >= Math.max(CHECKPOINT_POLICY.bytesFactor * size, CHECKPOINT_POLICY.minBytes);
}

export interface SyncOptions {
  operation: string;
  parameters?: Record<string, unknown>;
  migrationId?: string;
  /** Paths the operation wrote (their index entries may lag). */
  touched?: readonly string[];
  now?: Date;
  /** Only these tables (full names); default every table with a definition or a log. */
  tables?: readonly string[];
  /** The agent that made the change (see actor.ts). */
  actor?: Actor;
  /**
   * EXTERNAL_EDIT: the hand edits of every table to commit, checked once together; returns, by
   * table, how many rules its rows break because of them (`operationMetrics.violations`). A table
   * missing from the result (nothing of it checked), or an undefined result, gets no count.
   */
  check?: (changes: readonly ExternalLogChange[]) => Promise<ReadonlyMap<string, number> | undefined>;
  /** Write a commit for every table with history, also one with nothing changed (a move of the database folder). */
  always?: boolean;
}

/** What an EXTERNAL_EDIT commit of a table holds, for {@link SyncOptions.check}. */
export interface ExternalLogChange {
  table: string;
  add: readonly AddAction[];
  remove: readonly RemoveAction[];
  /** The table's row files as the log had them (the content before the edits). */
  before: ReadonlyMap<string, FileState>;
  /** The table's entry in metastore.yaml changed (its entry now; null when it was dropped). */
  metadataChanged: boolean;
  entry: CatalogTableEntry | null;
}

export interface SyncedCommit {
  table: string;
  version: number;
  operation: string;
}

/** Last logged state per table, keyed by app (the log itself stays the source of truth). */
const LAST = new WeakMap<object, Map<string, TableState>>();

export function forgetLoggedStates(app: App): void {
  LAST.delete(app);
}

async function lastState(app: App, settings: LogSettings, full: string): Promise<TableState> {
  let byTable = LAST.get(app);
  if (!byTable) LAST.set(app, (byTable = new Map()));
  const known = byTable.get(full);
  const versions = (await listVersions(app, settings, full));
  const latest = versions.length > 0 ? versions[versions.length - 1]! : -1;
  if (known && known.version === latest) return known;
  const state = await tableStateAt(app, settings, full);
  byTable.set(full, state);
  return state;
}

/**
 * Record a commit for every table whose rows or definition differ from its log. No-op without
 * `metastore.yaml`. Returns the commits written.
 */
/** Whether a table keeps a transaction log: its `properties.history`, else `config.history` (absent: off; a new database writes it on). */
export function historyEnabled(model: Metastore, entry: CatalogTableEntry): boolean {
  const own = entry.options?.history;
  return typeof own === "boolean" ? own : model.config.history === true;
}

export async function syncTransactionLogs(app: App, settings: LogSettings, options: SyncOptions): Promise<SyncedCommit[]> {
  const ms = await loadMetastore(app, settings);
  if (!ms) return [];
  const tables = catalogTables(ms.model);
  const enabled = new Set(tables.filter(({ entry }) => historyEnabled(ms.model, entry)).map(({ ref }) => ref.full));
  // A dropped table that had a log gets its final (drop) commit.
  const defined = new Set(tables.map(({ ref }) => ref.full));
  const orphans = (await loggedTables(app, settings)).filter((full) => !defined.has(full));
  if (enabled.size === 0 && orphans.length === 0) return []; // time travel off: nothing to read or write
  const current = await readCurrentStates(app, settings, ms.model, options.touched ?? [], enabled);
  const names = new Set<string>([...enabled, ...orphans]);
  const out: SyncedCommit[] = [];
  const now = options.now ?? new Date();
  const planned: (ExternalLogChange & { prev: TableState; operation: string })[] = [];
  for (const full of [...names].sort()) {
    if (options.tables && !options.tables.includes(full)) continue;
    const prev = await lastState(app, settings, full);
    const cur = current.get(full);
    const entry = cur?.entry ?? null;
    const files = cur?.files ?? new Map<string, FileState>();
    /* v8 ignore next -- impossible: an enabled table is always in `current`, a logged one replays to a version */
    if (prev.version < 0 && !cur) continue;
    const remove: RemoveAction[] = [];
    const add: AddAction[] = [];
    // a row whose front matter a hand edit broke is no removal: the log keeps its last readable
    // state until the note is fixed (check_table and the change feed report it as unreadable)
    if (cur) for (const [path, f] of prev.files) if (!files.has(path) && (await unreadableNow(app, path))) files.set(path, f);
    for (const [path, f] of prev.files) {
      const now = files.get(path);
      if (!now || now.hash !== f.hash) remove.push({ path, hash: f.hash });
    }
    for (const [path, f] of files) {
      const was = prev.files.get(path);
      if (!was || was.hash !== f.hash) add.push({ path, hash: f.hash, size: f.content.length, content: f.content });
    }
    const metadataChanged = prev.version < 0 || entryHash(prev.entry) !== entryHash(entry);
    if (!metadataChanged && add.length === 0 && remove.length === 0 && !(options.always && cur)) continue;
    const operation = prev.version < 0 && options.operation === EXTERNAL_EDIT ? "CREATE TABLE" : options.operation;
    planned.push({ table: full, add, remove, before: prev.files, metadataChanged, entry, prev, operation });
  }
  // Hand edits of every table are checked once, together (a git pull touching many tables).
  const external = planned.filter((p) => p.operation === EXTERNAL_EDIT);
  const counts = options.check && external.length > 0 ? await options.check(external) : undefined;
  for (const { table: full, add, remove, metadataChanged, entry, prev, operation } of planned) {
    const version = prev.version + 1;
    const violations = operation === EXTERNAL_EDIT ? counts?.get(full) : undefined;
    const commit: Commit = {
      commitInfo: {
        version,
        timestamp: now.toISOString(),
        operation,
        ...(options.parameters && Object.keys(options.parameters).length > 0 ? { operationParameters: options.parameters } : {}),
        ...(options.migrationId ? { migrationId: options.migrationId } : {}),
        operationMetrics: { numAddedFiles: add.length, numRemovedFiles: remove.length, metadataChanged, ...(violations !== undefined ? { violations } : {}) },
        engineInfo: "datanotes",
        ...(options.actor ? { userName: actorName(options.actor), actor: options.actor } : {}),
      },
      ...(metadataChanged ? { metaData: { entry } } : {}),
      add: [...add].sort((a, b) => a.path.localeCompare(b.path)),
      remove: [...remove].sort((a, b) => a.path.localeCompare(b.path)),
    };
    const dir = transactionLogDir(settings, full);
    const text = serializeCommit(commit);
    // Optimistic concurrency: the version file must not exist yet (another writer got there first).
    await writeNew(app, commitPath(dir, version), text);
    const next = applyCommit(prev, commit);
    next.movesApplied = prev.movesApplied;
    const since = prev.sinceCheckpoint ?? { versions: 0, bytes: 0 };
    next.sinceCheckpoint = { versions: since.versions + 1, bytes: since.bytes + text.length };
    LAST.get(app)?.set(full, next);
    if (version > 0 && checkpointDue(next, next.sinceCheckpoint)) {
      await writeCheckpoint(app, dir, next);
      next.sinceCheckpoint = { versions: 0, bytes: 0 };
    }
    out.push({ table: full, version, operation: commit.commitInfo.operation });
  }
  return out;
}

// --- Serialising log access ---

const LOCKS = new WeakMap<object, Promise<unknown>>();

/** The lock's use, by app: calls running or waiting, and when the last one ended (ms since the epoch). */
const ACTIVITY = new WeakMap<object, { pending: number; lastEnd: number }>();

/**
 * Run `fn` after every earlier locked call for this app: operations and log syncs never interleave.
 * It is the engine's write lock: every write to the store's journal, transaction logs and blobs
 * runs under it (operations, undo, hand edits logged, database moves, vacuum, compaction).
 */
export function withLogLock<T>(app: App, fn: () => Promise<T>): Promise<T> {
  let activity = ACTIVITY.get(app);
  if (!activity) ACTIVITY.set(app, (activity = { pending: 0, lastEnd: 0 }));
  const a = activity;
  a.pending++;
  const prev = LOCKS.get(app) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  LOCKS.set(app, settled);
  void settled.then(() => {
    a.pending--;
    a.lastEnd = Date.now();
  });
  return run;
}

/**
 * Whether the engine's write lock is in use (a call running or waiting) and when it was last
 * released: the store backup commits only once the engine has been idle for a while.
 */
export function logLockActivity(app: App): { busy: boolean; lastEnd: number } {
  const a = ACTIVITY.get(app);
  return { busy: (a?.pending ?? 0) > 0, lastEnd: a?.lastEnd ?? 0 };
}

// --- Vacuum ---

export interface VacuumResult {
  table: string;
  /** Oldest version still available for time travel. */
  retained_from: number;
  deleted: string[];
  dry_run: boolean;
}

/**
 * Drop history older than `retainFrom` (default: keep only the latest version): a checkpoint is
 * written at `retainFrom`, then older commits and checkpoints are deleted.
 */
export async function vacuum(
  app: App,
  settings: LogSettings,
  full: string,
  retainFrom: number | undefined,
  dryRun: boolean,
): Promise<VacuumResult> {
  const versions = (await listVersions(app, settings, full));
  if (versions.length === 0) throw new HistoryError(`${full} has no history`);
  const latest = versions[versions.length - 1]!;
  const keep = retainFrom ?? latest;
  if (!versions.includes(keep)) throw new HistoryError(`${full} has no version ${keep} (available: ${versions[0]}..${latest})`);
  const dir = transactionLogDir(settings, full);
  const doomed = [
    ...versions.filter((v) => v < keep).map((v) => commitPath(dir, v)),
    ...(await listCheckpoints(app, dir)).filter((v) => v < keep).map((v) => checkpointPath(dir, v)),
  ].sort();
  if (!dryRun) {
    await writeCheckpoint(app, dir, await tableStateAt(app, settings, full, { version: keep }));
    for (const p of doomed) await storeRemove(app, p);
    forgetLoggedStates(app);
  }
  return { table: full, retained_from: keep, deleted: doomed, dry_run: dryRun };
}
