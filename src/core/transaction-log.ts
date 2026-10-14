/**
 * Transaction log for metastore tables (`store:transaction_log/<catalog.schema.table>/`).
 *
 * Every change to a table is a numbered version (a commit: one JSON action per line):
 * `commitInfo` (operation, time, parameters), `metaData` when the table definition changed, `add`
 * for each row file written (path, hash and full content) and `remove` for each row file gone. The
 * versions are files of their own (`00000000000000000007.json`, the format every Datanotes 3
 * reads) or appended to segments (the setting `transactionLogFormat`); log-files.ts reads both. A
 * checkpoint holds the whole state; one is written when the commits since the last checkpoint
 * outweigh it (see {@link CHECKPOINT_POLICY}), after the write that made it due, so the log grows
 * with what is written, not with the table size, and a replay reads at most ~3x the table.
 *
 * Commits are derived by diffing the table's current state (its row files and `metastore.yaml`
 * entry) with the state the log describes, so the log sees every change: operations of the plugin
 * (named after the operation) and edits made by hand in Obsidian (`EXTERNAL_EDIT`). The engine
 * keeps each table's last logged state in memory as hashes (not texts): a text is read from the
 * note when its hash still matches, else from the log, only when a check or a checkpoint needs it.
 * History is kept until `vacuum` removes it.
 */

import type { App, TFile } from "./host";
import { contentHash, readFrontmatterValue, readHashed } from "./file-cache";

export { contentHash };
import { fmGet } from "./frontmatter";
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
import { storeFlush, storeList, storePath, storeRead, storeRemove, storeSyncNext, storeWrite } from "./store";
import { catalogLayout, parseTableOptions } from "./table-loader";
import { TABLE_KEY } from "./types-table";
import { databaseMoves, moveEntryPaths, moveLinks, movePath, type DatabaseMove } from "./database-move";
import { normalizeDatabaseFolder } from "./db-paths";
import { frontmatterError } from "./unreadable";
import { phase, startSpan } from "./tracing";
import { vaultIndex } from "./vault-index";
import { telemetry } from "./telemetry";
import { messageOf } from "./message";
import {
  appendVersion,
  checkpointPath,
  HistoryError,
  holdsVersions,
  latestOf,
  logToc,
  manifestFiles,
  framed,
  pad,
  readManifest,
  readPart,
  versionText,
  versionTexts,
  wholeVersions,
  writeManifestCheckpoint,
  writeSealedSegments,
  type CheckpointRef,
  type LogToc,
} from "./log-files";

export { HistoryError };

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
 * `max(bytesFactor × table size, minBytes)`; with versions in files of their own, also after
 * `max(maxVersions, table size / versionBytes)` commits (a replay reads every file: a large table
 * waits for more of them before it is copied again). Segments replay in a few reads: the byte rule only.
 */
export const CHECKPOINT_POLICY = { bytesFactor: 2, minBytes: 256 * 1024, maxVersions: 1000, versionBytes: 16 * 1024 };
/**
 * Single-document checkpoints (what Datanotes 3.0 reads, written by a vacuum while the log is in
 * files) are written only up to this many characters; a larger table gets a manifest and parts,
 * so no file of the store grows past what the store backup pushes.
 */
export const LEGACY_CHECKPOINT = { maxChars: 32 * 1024 * 1024 };
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
  /** In a replay: the version whose commit (or checkpoint, `cp`) holds this text. */
  at?: number;
  cp?: true;
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

/** A row file of a logged state: its hash, its text's length, and where its text is in the log. */
export interface LoggedFile {
  hash: string;
  size: number;
  /** The version whose commit holds its text; with `cp`, the checkpoint at that version. */
  at: number;
  cp?: true;
}

/** A table's last state as the engine keeps it between syncs: hashes, not texts. */
export interface LoggedState {
  full: string;
  version: number;
  timestamp: string;
  entry: CatalogTableEntry | null;
  files: Map<string, LoggedFile>;
  sinceCheckpoint: { versions: number; bytes: number };
  movesApplied?: number;
  /** The total length of its files' texts. */
  bytes: number;
}

interface Checkpoint {
  version: number;
  timestamp: string;
  entry: CatalogTableEntry | null;
  files: { path: string; hash: string; content: string }[];
  /** How many moves of the database folder its paths reflect (absent: those recorded before `timestamp`). */
  moves?: number;
}

type LogSettings = Pick<DatanotesSettings, "databaseFolder" | "tableKey"> & Partial<Pick<DatanotesSettings, "transactionLogFormat">>;
/** The log's place does not depend on the settings (it is in the store); kept for the callers' shape. */
type RootSettings = object;

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

/** entryHash by entry: an entry of a parsed metastore, or of a logged state, never changes. */
const ENTRY_HASHES = new WeakMap<CatalogTableEntry, string>();

function entryHash(entry: CatalogTableEntry | null): string {
  if (entry == null) return "";
  let h = ENTRY_HASHES.get(entry);
  if (h === undefined) ENTRY_HASHES.set(entry, (h = contentHash(JSON.stringify(entry))));
  return h;
}

// --- Reading the log ---

/**
 * Tables that have a log (including dropped ones), by full name. `among` limits the folders
 * looked into (a log sync asks only about the tables the metastore no longer defines).
 */
export async function loggedTables(app: App, settings: RootSettings, among?: (full: string) => boolean): Promise<string[]> {
  const base = `${transactionLogRoot(settings)}/`;
  const out: string[] = [];
  for (const dir of (await storeList(app, transactionLogRoot(settings))).folders) {
    const full = dir.slice(base.length);
    if (among && !among(full)) continue;
    if ((await storeList(app, dir)).files.some(holdsVersions)) out.push(full);
  }
  return out.sort();
}

/** A table's log as its files say (kept between calls while they do not change). */
function tocOf(app: App, settings: RootSettings, full: string): Promise<LogToc> {
  return logToc(app, transactionLogDir(settings, full));
}

export async function listVersions(app: App, settings: RootSettings, full: string): Promise<number[]> {
  return [...(await tocOf(app, settings, full)).versions];
}

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
  const toc = await tocOf(app, settings, full);
  if (!toc.versions.includes(version)) throw new HistoryError(`${full} has no version ${version}`);
  return movedCommit(parseCommit(await versionText(app, toc, version)), await databaseMoves(app));
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
    files.set(movePath(path, m.from, m.to, m.entries), content === f.content ? f : { ...f, hash: contentHash(content), content });
  }
  state.files = files;
  state.entry = moveEntryPaths(state.entry, m.from, m.to, m.entries);
}

function emptyState(full: string): TableState {
  return { full, version: -1, timestamp: "", entry: null, files: new Map() };
}

/**
 * The state after commit `c`, made from `state` in place: its file map is reused (a replay's own
 * state, which nothing else holds).
 */
export function applyCommit(state: TableState, c: Commit): TableState {
  const files = state.files;
  const at = c.commitInfo.version;
  for (const r of c.remove) files.delete(r.path);
  for (const a of c.add) files.set(a.path, { hash: a.hash, content: a.content, at });
  return {
    full: state.full,
    version: c.commitInfo.version,
    timestamp: c.commitInfo.timestamp,
    entry: c.metaData !== undefined ? c.metaData.entry : state.entry,
    files,
  };
}

/** {@link applyCommit} on a logged state (hashes only), in place: the engine's own, which nothing else holds. */
function applyLogged(state: LoggedState, c: Commit): void {
  const at = c.commitInfo.version;
  for (const r of c.remove) {
    const old = state.files.get(r.path);
    if (old) state.bytes -= old.size;
    state.files.delete(r.path);
  }
  for (const a of c.add) {
    const old = state.files.get(a.path);
    if (old) state.bytes -= old.size;
    const size = a.content.length;
    state.files.set(a.path, { hash: a.hash, size, at });
    state.bytes += size;
  }
  state.version = at;
  state.timestamp = c.commitInfo.timestamp;
  if (c.metaData !== undefined) state.entry = c.metaData.entry;
}

export interface AsOf {
  version?: number;
  /** RFC 3339 / ISO timestamp: the last version committed at or before it. */
  timestamp?: string;
}

/** A single-document checkpoint's text parsed; null when a crash tore it, or it is no checkpoint. */
function parseCheckpoint(text: string): Checkpoint | null {
  try {
    const c = JSON.parse(text) as Partial<Checkpoint> | null;
    return c !== null && typeof c === "object" && Number.isInteger(c.version) && Array.isArray(c.files) ? (c as Checkpoint) : null;
  } catch {
    return null;
  }
}

/** A checkpoint with its rows' texts; null when it (or a file of it) is missing, unreadable or torn. */
async function readCheckpoint(app: App, dir: string, cp: CheckpointRef): Promise<{ version: number; timestamp: string; entry: CatalogTableEntry | null; moves?: number; files: Map<string, FileState> } | null> {
  if (cp.kind === 1) {
    const text = await storeRead(app, cp.path);
    if (text == null) return null;
    const c = parseCheckpoint(text);
    if (!c) return null;
    return { version: c.version, timestamp: c.timestamp, entry: c.entry, ...(c.moves !== undefined ? { moves: c.moves } : {}), files: new Map(c.files.map((f) => [f.path, { hash: f.hash, content: f.content, at: c.version, cp: true as const }])) };
  }
  const m = await readManifest(app, dir, cp.path);
  if (!m) return null;
  const texts = new Map<string, string>();
  for (const name of m.head.parts) {
    const part = await readPart(app, dir, name);
    if (!part) return null;
    for (const [p, t] of part) texts.set(p, t);
  }
  const files = new Map<string, FileState>();
  for (const [path, hash] of m.rows) {
    const content = texts.get(path);
    if (content === undefined) return null;
    files.set(path, { hash, content, at: m.head.version, cp: true });
  }
  return { version: m.head.version, timestamp: m.head.timestamp, entry: m.head.entry as CatalogTableEntry | null, ...(m.head.moves !== undefined ? { moves: m.head.moves } : {}), files };
}

/**
 * Replay the log up to `asOf` (default: latest). Returns the empty state (version -1) for a table
 * without a log. Throws when the requested version or time is outside the history. The latest
 * version the engine keeps is built from the notes' texts (those whose hash still matches), not
 * replayed.
 */
export async function tableStateAt(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder">,
  full: string,
  asOf: AsOf = {},
): Promise<TableState> {
  const known = LAST.get(app)?.get(full);
  if (known && known.version >= 0 && isLatest(known, asOf) && (await stillLatest(app, settings, known))) {
    const fromNotes = await stateFromLogged(app, settings, known);
    if (fromNotes) return fromNotes;
  }
  return replayState(app, settings, full, asOf);
}

/** Whether `asOf` asks for the version `known` is at, the latest. */
function isLatest(known: LoggedState, asOf: AsOf): boolean {
  if (asOf.version !== undefined) return asOf.version === known.version && asOf.timestamp === undefined;
  if (asOf.timestamp === undefined) return true;
  const at = Date.parse(asOf.timestamp);
  return !Number.isNaN(at) && at >= Date.parse(known.timestamp);
}

/** {@link tableStateAt}, always from the log's files. */
async function replayState(app: App, settings: Pick<DatanotesSettings, "databaseFolder">, full: string, asOf: AsOf = {}): Promise<TableState> {
  const dir = transactionLogDir(settings, full);
  const toc = await logToc(app, dir);
  const versions = toc.versions;
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
  for (const cp of [...toc.checkpoints].reverse()) {
    if (cp.version > target) continue;
    const c = await readCheckpoint(app, dir, cp);
    if (!c) continue;
    if (limitMs !== undefined && Date.parse(c.timestamp) > limitMs) continue;
    state = { full, version: c.version, timestamp: c.timestamp, entry: c.entry, files: c.files };
    applied = Math.min(c.moves ?? moves.filter((m) => m.at <= c.timestamp).length, moves.length);
    break;
  }
  const since = { versions: 0, bytes: 0 };
  // the commits to replay: files read a few at a time, a segment once for all its versions
  const replay = versions.filter((v) => v > state.version && v <= target);
  const texts = await versionTexts(app, toc, replay);
  for (const text of texts) {
    const c = parseCommit(text);
    if (limitMs !== undefined && Date.parse(c.commitInfo.timestamp) > limitMs) break;
    moveUpTo(c.commitInfo.timestamp);
    state = applyCommit(state, c);
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
 * The last state of a table's log as hashes (where each text is in the log, not the texts): from
 * a manifest checkpoint's manifest only, or a replay that keeps no text. A move of the database
 * folder after the checkpoint (its links rewritten in the texts) replays the texts instead.
 */
async function replayLogged(app: App, settings: LogSettings, full: string): Promise<LoggedState> {
  const dir = transactionLogDir(settings, full);
  const toc = await logToc(app, dir);
  const empty: LoggedState = { full, version: -1, timestamp: "", entry: null, files: new Map(), sinceCheckpoint: { versions: 0, bytes: 0 }, bytes: 0 };
  if (toc.versions.length === 0) return empty;
  const moves = await databaseMoves(app);
  let state = empty;
  let applied = 0;
  for (const cp of [...toc.checkpoints].reverse()) {
    if (cp.kind === 2) {
      const m = await readManifest(app, dir, cp.path);
      if (!m || !(await partsThere(app, dir, m.head.parts))) continue;
      const files = new Map<string, LoggedFile>();
      let bytes = 0;
      for (const [path, hash, size] of m.rows) {
        files.set(path, { hash, size, at: m.head.version, cp: true });
        bytes += size;
      }
      state = { full, version: m.head.version, timestamp: m.head.timestamp, entry: m.head.entry as CatalogTableEntry | null, files, sinceCheckpoint: { versions: 0, bytes: 0 }, bytes };
      applied = Math.min(m.head.moves ?? moves.filter((x) => x.at <= m.head.timestamp).length, moves.length);
    } else {
      const c = await readCheckpoint(app, dir, cp);
      if (!c) continue;
      const files = new Map<string, LoggedFile>();
      let bytes = 0;
      for (const [path, f] of c.files) {
        files.set(path, { hash: f.hash, size: f.content.length, at: c.version, cp: true });
        bytes += f.content.length;
      }
      state = { full, version: c.version, timestamp: c.timestamp, entry: c.entry, files, sinceCheckpoint: { versions: 0, bytes: 0 }, bytes };
      applied = Math.min(c.moves ?? moves.filter((x) => x.at <= c.timestamp).length, moves.length);
    }
    break;
  }
  // links rewritten by a move after the checkpoint change the texts (and their hashes): replayed whole
  if (applied < moves.length) return loggedOf(await replayState(app, settings, full));
  const replay = toc.versions.filter((v) => v > state.version);
  for (const text of await versionTexts(app, toc, replay)) {
    applyLogged(state, parseCommit(text));
    state.sinceCheckpoint.versions++;
    state.sinceCheckpoint.bytes += text.length;
  }
  if (moves.length > 0) state.movesApplied = applied;
  return state;
}

/** Whether every part a manifest names is there. */
async function partsThere(app: App, dir: string, parts: readonly string[]): Promise<boolean> {
  const { files } = await storeList(app, dir);
  const there = new Set(files);
  return parts.every((n) => there.has(`${dir}/${n}`));
}

/** A state {@link replayState} gave (with moves) as the engine keeps it: hashes and where the texts are. */
function loggedOf(state: TableState): LoggedState {
  const files = new Map<string, LoggedFile>();
  let bytes = 0;
  for (const [path, f] of state.files) {
    // a replay names where each text came from: the commit, or the checkpoint
    files.set(path, { hash: f.hash, size: f.content.length, at: f.at!, cp: f.cp });
    bytes += f.content.length;
  }
  return {
    full: state.full,
    version: state.version,
    timestamp: state.timestamp,
    entry: state.entry,
    files,
    sinceCheckpoint: state.sinceCheckpoint!,
    movesApplied: state.movesApplied,
    bytes,
  };
}

/**
 * The texts of a logged state's files at `paths`: each from its note while the note's hash is
 * the logged one (the file cache: usually no read), else from the commit or checkpoint holding
 * it, else from a replay of the log. Paths it cannot find are missing from the result.
 */
export async function loggedTexts(app: App, settings: Pick<DatanotesSettings, "databaseFolder">, state: LoggedState, paths: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const fromCommit = new Map<number, string[]>();
  const fromCheckpoint = new Map<number, string[]>();
  for (const path of paths) {
    const f = state.files.get(path)!; // every path asked for is a row of the state
    const note = app.vault.getAbstractFileByPath(path);
    if (note && "extension" in note) {
      try {
        const h = await readHashed(app, note as TFile);
        if (h.hash === f.hash) {
          out.set(path, h.content);
          continue;
        }
      } catch {
        // a note that cannot be read now: from the log
      }
    }
    const by = f.cp ? fromCheckpoint : fromCommit;
    const list = by.get(f.at);
    if (list) list.push(path);
    else by.set(f.at, [path]);
  }
  for (const [v, list] of fromCommit) {
    let c: Commit;
    try {
      c = await readCommit(app, settings, state.full, v);
    } catch {
      continue; // replayed below
    }
    const want = new Set(list);
    for (const a of c.add) if (want.has(a.path) && contentHash(a.content) === state.files.get(a.path)!.hash) out.set(a.path, a.content);
  }
  // a checkpoint's paths are those of its time: after a move of the database folder they name
  // no row of the state, and its rows are replayed below
  for (const [v, list] of fromCheckpoint) await textsFromCheckpoint(app, settings, state, v, list, out);
  const missing = [...fromCommit.values(), ...fromCheckpoint.values()].flat().filter((p) => !out.has(p));
  if (missing.length > 0) {
    try {
      const whole = await replayState(app, settings, state.full, { version: state.version });
      for (const p of missing) {
        const x = whole.files.get(p);
        if (x && x.hash === state.files.get(p)!.hash) out.set(p, x.content);
      }
    } catch {
      // not in the log any more (a vacuum meanwhile): left out
    }
  }
  return out;
}

/** Texts of a checkpoint's rows (only the parts that hold them, for a manifest). */
async function textsFromCheckpoint(app: App, settings: Pick<DatanotesSettings, "databaseFolder">, state: LoggedState, version: number, paths: readonly string[], out: Map<string, string>): Promise<void> {
  const dir = transactionLogDir(settings, state.full);
  const toc = await logToc(app, dir);
  const cp = [...toc.checkpoints].reverse().find((c) => c.version === version);
  if (!cp) return;
  const want = new Set(paths);
  const keep = (path: string, content: string) => {
    if (want.has(path) && contentHash(content) === state.files.get(path)!.hash) out.set(path, content);
  };
  if (cp.kind === 1) {
    const c = await readCheckpoint(app, dir, cp).catch(() => null);
    for (const [path, f] of c?.files ?? []) keep(path, f.content);
    return;
  }
  const m = await readManifest(app, dir, cp.path);
  if (!m) return;
  const partOf = new Map(m.rows.map(([path, , , part]) => [path, part]));
  const parts = new Set(paths.map((p) => partOf.get(p)).filter((x): x is number => x !== undefined));
  for (const i of parts) {
    const part = await readPart(app, dir, m.head.parts[i]!);
    for (const [path, content] of part ?? []) keep(path, content);
  }
}

/** A logged state with its texts, as a replay would give it (null when a text cannot be found). */
async function stateFromLogged(app: App, settings: Pick<DatanotesSettings, "databaseFolder">, state: LoggedState): Promise<TableState | null> {
  const texts = await loggedTexts(app, settings, state, state.files.keys());
  if (texts.size !== state.files.size) return null;
  const files = new Map<string, FileState>();
  for (const [path, f] of state.files) files.set(path, { hash: f.hash, content: texts.get(path)!, at: f.at, cp: f.cp });
  return {
    full: state.full,
    version: state.version,
    timestamp: state.timestamp,
    entry: state.entry,
    files,
    sinceCheckpoint: { ...state.sinceCheckpoint },
    movesApplied: state.movesApplied,
  };
}

/** The first line of a version's text: its commitInfo, as {@link serializeCommit} writes it. */
function infoOf(text: string): CommitInfo {
  return (JSON.parse(text.slice(0, text.indexOf("\n"))) as { commitInfo: CommitInfo }).commitInfo;
}

/**
 * The commit infos of a table's log, oldest first. Only the first line of each commit is parsed:
 * `commitInfo`, as {@link serializeCommit} writes it.
 */
export async function commitInfos(app: App, settings: RootSettings, full: string): Promise<CommitInfo[]> {
  const toc = await tocOf(app, settings, full);
  return (await versionTexts(app, toc, toc.versions)).map(infoOf);
}

/**
 * The newest commit infos of a table's log, newest first: at most `limit`, and none committed
 * before `from` (ms). Reads only those commits (a table's commit times do not go back).
 */
export async function newestCommitInfos(app: App, settings: RootSettings, full: string, limit: number, from?: number): Promise<CommitInfo[]> {
  const toc = await tocOf(app, settings, full);
  const out: CommitInfo[] = [];
  for (const v of [...toc.versions].reverse()) {
    if (out.length >= limit) break;
    const info = infoOf(await versionText(app, toc, v));
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
  // the notes of the index that look like rows, by path; touched paths the index may not know yet
  const candidates = new Map<string, TFile | null>();
  for (const p of touched) if (p.endsWith(".md")) candidates.set(p, null);
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    if (fm && fm[settings.tableKey] != null) candidates.set(f.path, f);
  }
  const reader = rowStateReader(app, settings, model, out, excludes);
  for (const path of [...candidates.keys()].sort()) {
    const r = await reader(path, candidates.get(path) ?? null);
    if (r) out.get(r.table)!.files.set(path, r.state);
  }
  return out;
}

/**
 * The reading of one note as a row for the log: its table (read from its content, tolerant like
 * Obsidian: only `table` is read) among `tables`, outside the table's archive and exclude
 * folders, with its content and hash; null when it is no such row. Contents, hashes and parsed
 * front matter come from the file cache: unchanged files cost nothing.
 */
/** Read tolerant like Obsidian: no key holds a wikilink read back from a nested list. */
const NO_KEYS: ReadonlySet<string> = new Set();

function rowStateReader(
  app: App,
  settings: LogSettings,
  model: Metastore,
  tables: ReadonlyMap<string, unknown>,
  excludes: ReadonlyMap<string, string[]>,
): (path: string, file: TFile | null) => Promise<{ table: string; state: FileState } | null> {
  const resolved = new Map<string, string | null>();
  return async (path, given) => {
    const file = given ?? app.vault.getAbstractFileByPath(path);
    if (file == null || !("extension" in file)) return null;
    let raw: unknown;
    try {
      // Tolerant like Obsidian (lists of mappings, e.g. TaskNotes' reminders): only `table` is read here.
      raw = await readFrontmatterValue(app, file as TFile, NO_KEYS, (ordered) => fmGet(ordered, settings.tableKey));
    } catch {
      return null; // malformed frontmatter: not a row until fixed
    }
    const rawKey = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
    if (!resolved.has(rawKey)) resolved.set(rawKey, rowTableFull(model, raw));
    const full = resolved.get(rawKey)!;
    if (full == null || !tables.has(full)) return null;
    if (excludes.get(full)!.some((dir) => path.startsWith(`${dir}/`))) return null;
    return { table: full, state: await readHashed(app, file as TFile) };
  };
}

/**
 * The current state of every table's rows ({@link readCurrentStates}), kept from one log sync to
 * the next on a host with a vault index: a sync reads again only the notes changed since the
 * last one (the index's change log), the paths the operation names, and those held only because
 * an operation named them. Anything else (another metastore, table key or database folder, a
 * log the index no longer reaches back to) reads every row again.
 */
interface LiveStates {
  epoch: number;
  cursor: number;
  model: Metastore;
  /** The tables kept (those with history), in a stable form. */
  only: string;
  tableKey: string;
  databaseFolder: string;
  tables: Map<string, { entry: CatalogTableEntry; files: Map<string, FileState> }>;
  excludes: Map<string, string[]>;
  /** The table each held row is in. */
  tableOf: Map<string, string>;
  /** Rows held only because an operation named them (the host's index had no table for them yet). */
  touchedOnly: Set<string>;
}

const LIVE = new WeakMap<object, LiveStates>();

/** Forget the current states kept between syncs: the next sync reads every row (the idle check, tests). */
export function forgetCurrentStates(app: App): void {
  LIVE.delete(app);
}

/** {@link readCurrentStates} for a log sync: from the states kept since the last one when the host has a vault index. */
export async function currentStates(
  app: App,
  settings: LogSettings,
  model: Metastore,
  touched: readonly string[],
  only: ReadonlySet<string>,
): Promise<Map<string, { entry: CatalogTableEntry; files: Map<string, FileState> }>> {
  const idx = vaultIndex(app, settings);
  if (!idx || idx.hasFailures) return readCurrentStates(app, settings, model, touched, only);
  let live = LIVE.get(app);
  // the tables kept: those asked for (the ones with history), else every table
  const kept = JSON.stringify([...only].sort());
  const changed =
    live && live.model === model && live.only === kept && live.epoch === idx.epoch && live.tableKey === settings.tableKey && live.databaseFolder === settings.databaseFolder
      ? idx.changedSince(live.cursor, idx.epoch)
      : null;
  // where the change log is now: what changes while the rows are read is read again next time
  const cursor = idx.cursor;
  if (!live || !changed) {
    const tables = await readCurrentStates(app, settings, model, touched, only);
    const excludes = new Map<string, string[]>();
    const tableOf = new Map<string, string>();
    for (const [full, t] of tables) {
      excludes.set(full, catalogEntryOptions(full, t.entry, settings));
      for (const p of t.files.keys()) tableOf.set(p, full);
    }
    const touchedOnly = new Set([...tableOf.keys()].filter((p) => !(idx.note(p)?.tableValue != null)));
    live = { epoch: idx.epoch, cursor, model, only: kept, tableKey: settings.tableKey, databaseFolder: settings.databaseFolder, tables, excludes, tableOf, touchedOnly };
    LIVE.set(app, live);
  } else {
    const named = new Set(touched.filter((p) => p.endsWith(".md")));
    const reader = rowStateReader(app, settings, model, live.tables, live.excludes);
    for (const path of new Set([...changed, ...named, ...live.touchedOnly])) {
      const was = live.tableOf.get(path);
      if (was !== undefined) live.tables.get(was)!.files.delete(path);
      live.tableOf.delete(path);
      live.touchedOnly.delete(path);
      const n = idx.note(path);
      const listed = n !== undefined && n.tableValue != null;
      if (!listed && !named.has(path)) continue;
      const r = await reader(path, n?.file ?? null);
      if (!r) continue;
      live.tables.get(r.table)!.files.set(path, r.state);
      live.tableOf.set(path, r.table);
      if (!listed) live.touchedOnly.add(path);
    }
    live.cursor = cursor;
  }
  return live.tables;
}

/**
 * How the current states kept between syncs differ from reading every row now: the rows that
 * differ (empty when they agree). With `repair`, a difference forgets them, so the next sync
 * reads every row (and logs what the kept states missed).
 */
export async function verifyCurrentStates(app: App, settings: LogSettings, repair = false): Promise<string[]> {
  const ms = await loadMetastore(app, settings);
  const live = LIVE.get(app);
  if (!ms || !live) return [];
  // the tables the kept states were built for
  const only = new Set(JSON.parse(live.only) as string[]);
  const kept = await currentStates(app, settings, ms.model, [], only);
  const now = await readCurrentStates(app, settings, ms.model, [], only);
  const out: string[] = [];
  // the same tables on both sides: those of the same metastore with history
  for (const [full, t] of now) {
    const a = kept.get(full)!.files;
    const b = t.files;
    for (const p of new Set([...a.keys(), ...b.keys()])) if (a.get(p)?.hash !== b.get(p)?.hash) out.push(`${full}: ${p}`);
  }
  if (out.length > 0 && repair) forgetCurrentStates(app);
  return out.sort();
}

// --- Writing ---

/** Whether a logged state is due for a checkpoint ({@link CHECKPOINT_POLICY}). */
function checkpointDue(state: LoggedState, format: "files" | "segments"): boolean {
  const since = state.sinceCheckpoint;
  if (since.bytes >= Math.max(CHECKPOINT_POLICY.bytesFactor * state.bytes, CHECKPOINT_POLICY.minBytes)) return true;
  if (format === "segments") return false;
  return since.versions >= Math.max(CHECKPOINT_POLICY.maxVersions, Math.ceil(state.bytes / CHECKPOINT_POLICY.versionBytes));
}

/** Rows sorted by path, with their texts, for a checkpoint (null when a text cannot be found). */
async function checkpointRows(app: App, settings: LogSettings, state: LoggedState): Promise<{ path: string; hash: string; content: string }[] | null> {
  const texts = await loggedTexts(app, settings, state, state.files.keys());
  if (texts.size !== state.files.size) return null;
  // paths are unique: never equal
  return [...state.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, f]) => ({ path, hash: f.hash, content: texts.get(path)! }));
}

/**
 * Write the checkpoint of a table's last logged state, if it is still due and still the log's
 * latest (call it holding the write lock). The rows' texts come from the notes (those unchanged
 * since), else from the log. Returns whether it wrote one.
 */
async function writeDueCheckpoint(app: App, settings: LogSettings, full: string): Promise<boolean> {
  const state = LAST.get(app)?.get(full);
  if (!state || !checkpointDue(state, formatOf(settings))) return false;
  if (!(await stillLatest(app, settings, state))) return false;
  const rows = await checkpointRows(app, settings, state);
  if (!rows) return false;
  await writeManifestCheckpoint(app, transactionLogDir(settings, full), { version: state.version, timestamp: state.timestamp, entry: state.entry, ...(state.movesApplied ? { moves: state.movesApplied } : {}) }, rows);
  state.sinceCheckpoint = { versions: 0, bytes: 0 };
  return true;
}

/** The format new versions are written in (`transactionLogFormat`; segments, the default, when a caller's settings have none). */
function formatOf(settings: LogSettings): "files" | "segments" {
  return settings.transactionLogFormat === "files" ? "files" : "segments";
}

/** Tables due for a checkpoint, by app: written after the write that made them due. */
const DUE = new WeakMap<object, Map<string, LogSettings>>();
/** Who writes them, by app (the runtime: a background job); none: the write itself, at its end. */
const CHECKPOINT_RUNNERS = new WeakMap<object, () => void>();

/**
 * Hand the checkpoints that writes make due to `run` (called once per write that makes one due):
 * it calls {@link writeDueCheckpoints} after the write returned, as work of its own. Null: each
 * write writes them itself, before it returns.
 */
export function setCheckpointRunner(app: App, run: (() => void) | null): void {
  if (run) CHECKPOINT_RUNNERS.set(app, run);
  else CHECKPOINT_RUNNERS.delete(app);
}

/** The tables waiting for a checkpoint. */
export function dueCheckpoints(app: App): string[] {
  return [...(DUE.get(app)?.keys() ?? [])].sort();
}

/**
 * Write the checkpoints writes made due, one table per hold of the write lock (each a full copy
 * of a table: writes wait for one table at most). `stopped` ends it early (the rest stay due).
 * Returns how many it wrote.
 */
export async function writeDueCheckpoints(app: App, stopped: () => boolean = () => false): Promise<number> {
  let n = 0;
  for (;;) {
    const due = DUE.get(app);
    const next = due ? [...due][0] : undefined;
    if (!next || stopped()) break;
    const [full, settings] = next;
    due!.delete(full);
    if (await withLogLock(app, () => writeDueCheckpoint(app, settings, full))) n++;
  }
  return n;
}

/** Whether the single-document checkpoint at version `v` is there whole (one a crash tore is not). */
async function wholeCheckpoint(app: App, dir: string, v: number): Promise<boolean> {
  return parseCheckpoint((await storeRead(app, checkpointPath(dir, v))) ?? "")?.version === v;
}

async function writeCheckpoint(app: App, dir: string, state: TableState, format: "files" | "segments"): Promise<void> {
  const files = [...state.files.entries()].sort(([a], [b]) => a.localeCompare(b));
  // the single document Datanotes 3.0 reads while the log is in files, unless it would be too large
  if (format === "files") {
    const cp: Checkpoint = {
      version: state.version,
      timestamp: state.timestamp,
      entry: state.entry,
      files: files.map(([path, f]) => ({ path, hash: f.hash, content: f.content })),
      ...(state.movesApplied ? { moves: state.movesApplied } : {}),
    };
    const text = JSON.stringify(cp);
    if (text.length <= LEGACY_CHECKPOINT.maxChars) {
      const path = checkpointPath(dir, state.version);
      // one there already is kept, unless a crash tore it: written again
      if (!(await wholeCheckpoint(app, dir, state.version))) await storeWrite(app, path, text);
      return;
    }
  }
  await writeManifestCheckpoint(app, dir, { version: state.version, timestamp: state.timestamp, entry: state.entry, ...(state.movesApplied ? { moves: state.movesApplied } : {}) }, files.map(([path, f]) => ({ path, hash: f.hash, content: f.content })));
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
  /**
   * The table's row files as the log had them (the content before the edits): those the edits of
   * every table add or remove.
   */
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
const LAST = new WeakMap<object, Map<string, LoggedState>>();

export function forgetLoggedStates(app: App): void {
  LAST.delete(app);
}

/**
 * The log's last state of a table as this engine last wrote or read it, without reading the log.
 * The log moves on only through syncTransactionLogs, which keeps this state, and the writes that
 * forget it (vacuum, moved logs): a sync compares every table with it, and checks it against the
 * log ({@link stillLatest}) only for the tables it commits to.
 */
async function knownState(app: App, settings: LogSettings, full: string): Promise<LoggedState> {
  return LAST.get(app)?.get(full) ?? readLastState(app, settings, full);
}

/** The log's last state of a table, replayed from the log (and kept). */
async function readLastState(app: App, settings: LogSettings, full: string): Promise<LoggedState> {
  let byTable = LAST.get(app);
  if (!byTable) LAST.set(app, (byTable = new Map()));
  const state = await replayLogged(app, settings, full);
  byTable.set(full, state);
  return state;
}

/**
 * Whether a known state is still the log's latest: its version is the newest in the log's files
 * (a table without a log: still none). Another writer, or a log removed by hand, fails it.
 */
async function stillLatest(app: App, settings: RootSettings, state: { full: string; version: number }): Promise<boolean> {
  return latestOf(await tocOf(app, settings, state.full)) === state.version;
}

/**
 * The latest version of a table's log, null without one: from the state this engine knows when
 * it is still the latest, else from the log's files.
 */
export async function latestVersion(app: App, settings: LogSettings, full: string): Promise<number | null> {
  const latest = latestOf(await tocOf(app, settings, full));
  return latest >= 0 ? latest : null;
}

/**
 * Replay the log of every table this engine does not know yet, one table per hold of the write
 * lock: after a start, the first sync would otherwise replay them all in one hold (seconds on a
 * large vault, while every write waits). A table with a manifest checkpoint reads only its
 * manifest and the versions after it (no row's text). Returns how many tables it replayed;
 * `stopped` ends it early.
 */
export async function warmLoggedStates(app: App, settings: LogSettings, stopped: () => boolean = () => false): Promise<number> {
  let n = 0;
  for (const full of await loggedTables(app, settings)) {
    if (stopped()) break;
    await withLogLock(app, async () => {
      if (LAST.get(app)?.has(full)) return;
      await readLastState(app, settings, full);
      n++;
    });
  }
  return n;
}

/** What a table's commit would hold: its files now against a logged state. */
async function changesSince(app: App, prev: LoggedState, cur: { entry: CatalogTableEntry; files: Map<string, FileState> } | undefined) {
  const entry = cur?.entry ?? null;
  let files: Map<string, { hash: string; content?: string }> = cur?.files ?? new Map<string, FileState>();
  const remove: RemoveAction[] = [];
  const add: AddAction[] = [];
  // a row whose front matter a hand edit broke is no removal: the log keeps its last readable
  // state until the note is fixed (check_table and the change feed report it as unreadable)
  if (cur) {
    for (const [path, f] of prev.files) {
      if (files.has(path) || !(await unreadableNow(app, path))) continue;
      if (files === cur.files) files = new Map(files); // the current state is shared: kept as read
      files.set(path, f);
    }
  }
  for (const [path, f] of prev.files) {
    const now = files.get(path);
    if (!now || now.hash !== f.hash) remove.push({ path, hash: f.hash });
  }
  for (const [path, f] of files) {
    const was = prev.files.get(path);
    // a file kept from the log (no content) has the log's hash: never added
    if (!was || was.hash !== f.hash) add.push({ path, hash: f.hash, size: f.content!.length, content: f.content! });
  }
  // in the order of the paths (the states kept between syncs hold them in the order they came)
  add.sort((a, b) => (a.path < b.path ? -1 : 1));
  const metadataChanged = prev.version < 0 || entryHash(prev.entry) !== entryHash(entry);
  return { entry, add, remove, metadataChanged };
}

/** Whether a table keeps a transaction log: its `properties.history`, else `config.history` (absent: off; a new database writes it on). */
export function historyEnabled(model: Metastore, entry: CatalogTableEntry): boolean {
  const own = entry.options?.history;
  return typeof own === "boolean" ? own : model.config.history === true;
}

/**
 * Record a commit for every table whose rows or definition differ from its log. No-op without
 * `metastore.yaml`. Returns the commits written.
 */
export async function syncTransactionLogs(app: App, settings: LogSettings, options: SyncOptions): Promise<SyncedCommit[]> {
  const ms = await loadMetastore(app, settings);
  if (!ms) return [];
  const tables = catalogTables(ms.model);
  const enabled = new Set(tables.filter(({ entry }) => historyEnabled(ms.model, entry)).map(({ ref }) => ref.full));
  // A dropped table that had a log gets its final (drop) commit.
  const defined = new Set(tables.map(({ ref }) => ref.full));
  const orphans = await loggedTables(app, settings, (full) => !defined.has(full));
  if (enabled.size === 0 && orphans.length === 0) return []; // time travel off: nothing to read or write
  const current = await currentStates(app, settings, ms.model, options.touched ?? [], enabled);
  const names = new Set<string>([...enabled, ...orphans]);
  const out: SyncedCommit[] = [];
  const now = options.now ?? new Date();
  const format = formatOf(settings);
  const planned: (Omit<ExternalLogChange, "before"> & { prev: LoggedState; operation: string })[] = [];
  for (const full of [...names].sort()) {
    if (options.tables && !options.tables.includes(full)) continue;
    let prev = await knownState(app, settings, full);
    const cur = current.get(full);
    /* v8 ignore next -- impossible: an enabled table is always in `current`, a logged one replays to a version */
    if (prev.version < 0 && !cur) continue;
    const due = (c: { add: unknown[]; remove: unknown[]; metadataChanged: boolean }) => c.metadataChanged || c.add.length > 0 || c.remove.length > 0 || (options.always === true && cur !== undefined);
    let changes = await changesSince(app, prev, cur);
    if (!due(changes)) continue;
    // a commit is written on the known state: check it is still the log's latest, else replay the log
    if (!(await stillLatest(app, settings, prev))) {
      prev = await readLastState(app, settings, full);
      changes = await changesSince(app, prev, cur);
      if (!due(changes)) continue;
    }
    const { entry, add, remove, metadataChanged } = changes;
    const operation = prev.version < 0 && options.operation === EXTERNAL_EDIT ? "CREATE TABLE" : options.operation;
    planned.push({ table: full, add, remove, metadataChanged, entry, prev, operation });
  }
  // Hand edits of every table are checked once, together (a git pull touching many tables), against
  // the texts the log had: those of the rows the edits add or remove, read from the notes or the log.
  const external = planned.filter((p) => p.operation === EXTERNAL_EDIT);
  let counts: ReadonlyMap<string, number> | undefined;
  if (options.check && external.length > 0) {
    const added = new Set(external.flatMap((p) => p.add.map((a) => a.path)));
    const changes: ExternalLogChange[] = [];
    for (const p of external) {
      const wanted = new Set([...p.remove.map((r) => r.path), ...[...added].filter((x) => p.prev.files.has(x))]);
      const texts = await loggedTexts(app, settings, p.prev, wanted);
      const before = new Map<string, FileState>();
      for (const x of wanted) if (texts.has(x)) before.set(x, { hash: p.prev.files.get(x)!.hash, content: texts.get(x)! });
      const { prev: _prev, operation: _op, ...change } = p;
      changes.push({ ...change, before });
    }
    counts = await options.check(changes);
  }
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
    const text = serializeCommit(commit);
    // Optimistic concurrency: the log must still be at the previous version (another writer got there first).
    const repaired = await appendVersion(app, transactionLogDir(settings, full), version, text, format);
    for (const r of repaired) telemetry().log("WARN", "datanotes transaction log repaired a version torn by a crash", { table: full, repair: r });
    // the last state is the engine's own: the commit is applied to it in place (no copy of the table)
    applyLogged(prev, commit);
    prev.sinceCheckpoint = { versions: prev.sinceCheckpoint.versions + 1, bytes: prev.sinceCheckpoint.bytes + text.length };
    if (version > 0 && checkpointDue(prev, format)) {
      let due = DUE.get(app);
      if (!due) DUE.set(app, (due = new Map()));
      due.set(full, settings);
    }
    out.push({ table: full, version, operation: commit.commitInfo.operation });
  }
  // Checkpoints made due: after the write (a background job), or here when nobody runs them.
  if (DUE.get(app)?.size) {
    const runner = CHECKPOINT_RUNNERS.get(app);
    if (runner) runner();
    else {
      const due = DUE.get(app)!;
      for (const [full, s] of [...due]) {
        due.delete(full);
        await writeDueCheckpoint(app, s, full);
      }
    }
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
 * runs under it (operations, undo, hand edits logged, database moves, vacuum, compaction). The
 * store files a hold wrote are synced at its end ({@link storeFlush}, the setting `storeSync`).
 */
export function withLogLock<T>(app: App, fn: () => Promise<T>): Promise<T> {
  let activity = ACTIVITY.get(app);
  if (!activity) ACTIVITY.set(app, (activity = { pending: 0, lastEnd: 0 }));
  const a = activity;
  a.pending++;
  const prev = LOCKS.get(app) ?? Promise.resolve();
  // traced: the wait for the lock and the time it is held are two spans (contention vs work)
  const wait = startSpan("engine.lock.acquire", { attributes: { "datanotes.lock.queued": a.pending - 1 } });
  const held = (): Promise<T> => {
    wait.end();
    return phase("engine.lock.hold", async () => {
      try {
        return await fn();
      } finally {
        await storeFlush(app).catch((e: unknown) => telemetry().log("WARN", "datanotes could not sync the store's files", { error: messageOf(e) }));
      }
    });
  };
  const run = prev.then(held, held);
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

/** The checkpoint files of a log, by version: a single document, or a manifest with its parts. */
async function checkpointFiles(app: App, dir: string, toc: LogToc): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const cp of toc.checkpoints) {
    const files = cp.kind === 1 ? [cp.path] : manifestFiles(dir, cp.path, (await readManifest(app, dir, cp.path))?.head ?? null);
    out.set(cp.version, [...(out.get(cp.version) ?? []), ...files]);
  }
  return out;
}

/**
 * Drop history older than `retainFrom` (default: keep only the latest version): a checkpoint is
 * written at `retainFrom`, then older versions (their files, the segments holding only older
 * ones) and checkpoints are deleted. A segment holding versions on both sides is written again
 * with the kept ones (a new file) and deleted.
 */
export async function vacuum(
  app: App,
  settings: LogSettings,
  full: string,
  retainFrom: number | undefined,
  dryRun: boolean,
): Promise<VacuumResult> {
  const dir = transactionLogDir(settings, full);
  const toc = await logToc(app, dir);
  const versions = toc.versions;
  if (versions.length === 0) throw new HistoryError(`${full} has no history`);
  const latest = versions[versions.length - 1]!;
  const keep = retainFrom ?? latest;
  if (!versions.includes(keep)) throw new HistoryError(`${full} has no version ${keep} (available: ${versions[0]}..${latest})`);
  const doomed: string[] = [...toc.files].filter(([v]) => v < keep).map(([, p]) => p);
  const straddling = toc.segments.filter((s) => s.first < keep && s.last >= keep);
  for (const s of toc.segments) if (s.last < keep || straddling.includes(s)) doomed.push(s.path);
  for (const [v, files] of await checkpointFiles(app, dir, toc)) if (v < keep) doomed.push(...files);
  doomed.sort();
  if (!dryRun) {
    await writeCheckpoint(app, dir, await tableStateAt(app, settings, full, { version: keep }), formatOf(settings));
    // the kept versions of a segment that also held older ones: in a segment of their own first
    for (const s of straddling) {
      const kept: { version: number; text: string }[] = [];
      for (let v = keep; v <= s.last; v++) kept.push({ version: v, text: await versionText(app, toc, v) });
      await writeSealedSegments(app, dir, kept);
    }
    // what replaces the old files is durable before they go: a crash leaves both, never neither
    await storeFlush(app);
    for (const p of doomed) await storeRemove(app, p);
    forgetLoggedStates(app);
  }
  return { table: full, retained_from: keep, deleted: doomed, dry_run: dryRun };
}

// --- Converting between the formats ---

/** What {@link convertLog} did to one table's log. */
export interface ConvertedLog {
  table: string;
  versions: number;
  written: number;
  removed: number;
}

/**
 * Write every version of a table's log in the other format, then remove the files of the old
 * one: `segments` packs versions held in files of their own into sealed segments; `files` writes
 * every version a segment holds as a file of its own (what Datanotes 3.0 reads), and a checkpoint
 * Datanotes 3.0 reads at the oldest version when the history before it was vacuumed. A crash
 * meanwhile leaves both (the segments' copy is read): the new files, and the ones kept that hold
 * the same versions, are synced before the old ones are removed. Run again, it writes again what a
 * crash tore (a sealed segment, a checkpoint), and syncs what a killed run wrote whole.
 * Run it holding the write lock, or with no
 * engine running on the store.
 */
export async function convertLog(app: App, settings: RootSettings, full: string, to: "files" | "segments"): Promise<ConvertedLog> {
  const dir = transactionLogDir(settings, full);
  const toc = await logToc(app, dir);
  const result: ConvertedLog = { table: full, versions: toc.versions.length, written: 0, removed: 0 };
  if (to === "segments") {
    // a sealed segment a crash tore (written, not synced) is written again whole, from its
    // versions' files: its name alone does not make its versions packed. One kept is synced
    // with the new ones: a killed run may have left it whole but not synced
    for (const s of toc.segments) {
      if (!s.sealed || (await wholeVersions(app, s)).size === s.last - s.first + 1) {
        storeSyncNext(app, s.path);
        continue;
      }
      const range = Array.from({ length: s.last - s.first + 1 }, (_, i) => s.first + i);
      const texts = await versionTexts(app, toc, range);
      await storeWrite(app, s.path, range.map((v, i) => framed(v, texts[i]!)).join(""));
      result.written++;
    }
    const loose = toc.versions.filter((v) => toc.files.has(v) && !toc.segments.some((s) => v >= s.first && v <= s.last));
    const texts = await versionTexts(app, toc, loose);
    const written = await writeSealedSegments(app, dir, loose.map((version, i) => ({ version, text: texts[i]! })));
    result.written += written.length;
    // what replaces the old files is durable before they go: a crash leaves both, never neither
    await storeFlush(app);
    for (const v of toc.files.keys()) {
      await storeRemove(app, toc.files.get(v)!);
      result.removed++;
    }
  } else {
    for (const seg of toc.segments) {
      for (let v = seg.first; v <= seg.last; v++) {
        const path = `${dir}/${pad(v)}.json`;
        const file = toc.files.get(v);
        if (file === undefined) {
          await storeWrite(app, path, await versionText(app, toc, v));
          result.written++;
        } else storeSyncNext(app, file); // kept: perhaps a killed run's, not synced
      }
    }
    // history vacuumed before the oldest version: a checkpoint there that Datanotes 3.0 reads
    const oldest = toc.versions[0];
    // by its content, not its name: one a crash tore (written, not synced) is written again
    if (oldest !== undefined && oldest > 0) {
      if (await wholeCheckpoint(app, dir, oldest)) storeSyncNext(app, checkpointPath(dir, oldest));
      else {
        await writeCheckpoint(app, dir, await replayState(app, settings as Pick<DatanotesSettings, "databaseFolder">, full, { version: oldest }), "files");
        result.written++;
      }
    }
    // what replaces the old files is durable before they go: a crash leaves both, never neither
    await storeFlush(app);
    for (const seg of toc.segments) {
      await storeRemove(app, seg.path);
      result.removed++;
    }
  }
  forgetLoggedStates(app);
  return result;
}

