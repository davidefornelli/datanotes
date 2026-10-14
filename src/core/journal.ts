/**
 * The operation journal: what each operation changed, so it can be undone.
 *
 * Stored in the engine's store (see store.ts), one JSON Lines file per month:
 * `store:journal/2026-10.jsonl`. Each operation is one appended line
 * (`{"type":"migration", ...entry}`); undoing it appends `{"type":"undone", ...}` instead of
 * rewriting the line. Texts longer than {@link BLOB_MIN} (e.g. the whole `metastore.yaml` before and
 * after a schema change, or a deleted note) are stored once in `store:blobs/<hash>.txt` and
 * referenced by hash. Entries older than the retention are dropped by {@link compactJournal}.
 * An entry is read as it reads today ({@link translateJournalEntry}): after the database folder
 * moved, its paths are the new ones.
 */

import type { App } from "./host";
import type { JournalEntry } from "./changeset";
import { contentHash } from "./file-cache";
import { actorName } from "./actor";
import type { DatanotesSettings } from "./settings";
import { storeAppend, storeExists, storeList, storePath, storeRead, storeRemove, storeStat, storeWrite } from "./store";
import { databaseMoves, translateJournalEntry } from "./database-move";
import { phase } from "./tracing";

type Settings = Pick<DatanotesSettings, "journalRetentionDays"> & Partial<Pick<DatanotesSettings, "databaseId">>;

/** Texts at least this long go to a blob file. */
export const BLOB_MIN = 2048;

export class MigrationNotFoundError extends Error {
  override readonly name = "MigrationNotFoundError";
  constructor(readonly migrationId: string) {
    super(`Migration not found: ${migrationId}`);
  }
}

interface MigrationLine extends JournalEntry {
  type: "migration";
}

interface UndoneLine {
  type: "undone";
  migration_id: string;
  undone_by: string;
  at: string;
}

type Line = MigrationLine | UndoneLine;

const journalDir = (_s: Settings) => storePath("journal");
const blobDir = (_s: Settings) => storePath("blobs");
const blobPath = (s: Settings, hash: string) => `${blobDir(s)}/${hash}.txt`;
const BLOB_PREFIX = "blob:";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `20260930T224617-…` → `2026-09`. */
function monthOfId(id: string): string | null {
  const m = /^(\d{4})(\d{2})\d{2}T/.exec(id);
  return m ? `${m[1]}-${m[2]}` : null;
}

export function journalFileFor(settings: Settings, id: string): string {
  return `${journalDir(settings)}/${monthOfId(id) ?? "undated"}.jsonl`;
}

const LINE_START = '{"type":"';

function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Line);
    } catch {
      // A torn line (crash while appending): skip it. A journal written before appends started on a
      // new line may have the next entry glued to it: keep that one.
      const at = line.lastIndexOf(LINE_START);
      if (at <= 0) continue;
      try {
        out.push(JSON.parse(line.slice(at)) as Line);
      } catch {
        // nothing whole after the torn part
      }
    }
  }
  return out;
}

// --- the monthly files, kept in memory ---

/**
 * A journal file as this engine last read or appended it, with the size and time the host gave
 * for it: every write appends to a file of several MB and must find a free id in it, and every
 * undo looks one entry up in it. Read again when its size or time differ (another program
 * changed it). Its lines are kept by the ids they hold, so a lookup reads no other line.
 */
interface KeptFile {
  size: number;
  mtime: number;
  /** Whether the text ends with a line break (an append after a torn last line starts a new one). */
  endsWithNewline: boolean;
  /** The lines by the ids they name (`"migration_id":"…"`): an entry and its undo. */
  lines: Map<string, string[]>;
}

const KEPT = new WeakMap<object, Map<string, KeptFile>>();

function keptFiles(app: App): Map<string, KeptFile> {
  let m = KEPT.get(app);
  if (!m) KEPT.set(app, (m = new Map()));
  return m;
}

/** Forget the kept copies of the journal files (after they were rewritten or removed). */
export function forgetJournalFiles(app: App): void {
  KEPT.delete(app);
}

const ID_RE = /"migration_id":"([^"]+)"/g;

/** Index one line by the ids it names (a line glued to a torn one names two). */
function addLine(file: KeptFile, line: string): void {
  if (line.trim() === "") return;
  for (const id of new Set([...line.matchAll(ID_RE)].map((m) => m[1]!))) {
    const lines = file.lines.get(id);
    if (lines) lines.push(line);
    else file.lines.set(id, [line]);
  }
}

function keptOf(text: string, stamp: { size: number; mtime: number }): KeptFile {
  const file: KeptFile = { size: stamp.size, mtime: stamp.mtime, endsWithNewline: text === "" || text.endsWith("\n"), lines: new Map() };
  for (const line of text.split("\n")) addLine(file, line);
  return file;
}

/**
 * A journal file (null when there is none), from memory while the host reports it unchanged; a
 * host without `stat` has it read every time.
 */
async function journalFile(app: App, path: string): Promise<KeptFile | null> {
  const stat = await storeStat(app, path);
  const files = keptFiles(app);
  if (stat === null) {
    files.delete(path);
    return null;
  }
  const kept = stat ? files.get(path) : undefined;
  if (kept && kept.size === stat!.size && kept.mtime === stat!.mtime) return kept;
  const text = await storeRead(app, path);
  /* v8 ignore next -- a race: the file was removed between its stat and its read */
  if (text == null) return null;
  // the size and time from before the read: a change in between has the file read again next time
  const file = keptOf(text, stat ?? { size: -1, mtime: -1 });
  if (stat) files.set(path, file);
  return file;
}

/** Append one line; after a torn last line (a crash while appending) start on a new line. */
async function appendLine(app: App, path: string, line: Line): Promise<void> {
  const file = await journalFile(app, path);
  const sep = file && !file.endsWithNewline ? "\n" : "";
  const json = JSON.stringify(line);
  await storeAppend(app, path, `${sep}${json}\n`);
  const stat = await storeStat(app, path);
  const files = keptFiles(app);
  if (!stat) {
    files.delete(path); // a host without stat keeps nothing
    return;
  }
  const next = file && files.get(path) === file ? file : keptOf("", stat);
  next.size = stat.size;
  next.mtime = stat.mtime;
  next.endsWithNewline = true;
  addLine(next, json);
  files.set(path, next);
}

// --- blobs ---

async function putBlob(app: App, settings: Settings, text: string): Promise<string> {
  const hash = `${contentHash(text)}-${text.length.toString(36)}`;
  const path = blobPath(settings, hash);
  if (!(await storeExists(app, path))) await storeWrite(app, path, text);
  return `${BLOB_PREFIX}${hash}`;
}

async function getBlob(app: App, settings: Settings, ref: string): Promise<string> {
  if (!ref.startsWith(BLOB_PREFIX)) return ref;
  const text = await storeRead(app, blobPath(settings, ref.slice(BLOB_PREFIX.length)));
  if (text == null) throw new Error(`journal blob missing: ${ref}`);
  return text;
}

async function packText(app: App, settings: Settings, text: string): Promise<string> {
  return text.length >= BLOB_MIN || text.startsWith(BLOB_PREFIX) ? putBlob(app, settings, text) : text;
}

async function pack(app: App, settings: Settings, entry: JournalEntry): Promise<JournalEntry> {
  const references = [];
  for (const r of entry.references) {
    references.push({ ...r, before_text: await packText(app, settings, r.before_text), after_text: await packText(app, settings, r.after_text) });
  }
  const deleted = [];
  for (const d of entry.deleted ?? []) deleted.push({ ...d, content: await packText(app, settings, d.content) });
  return { ...entry, references, ...(entry.deleted ? { deleted } : {}) };
}

async function unpack(app: App, settings: Settings, entry: JournalEntry): Promise<JournalEntry> {
  const references = [];
  for (const r of entry.references) {
    references.push({ ...r, before_text: await getBlob(app, settings, r.before_text), after_text: await getBlob(app, settings, r.after_text) });
  }
  const deleted = [];
  for (const d of entry.deleted ?? []) deleted.push({ ...d, content: await getBlob(app, settings, d.content) });
  // an entry written before `deleted` was always recorded reads as deleting nothing
  return { ...entry, references, deleted };
}

function blobRefs(entry: JournalEntry): string[] {
  return [...entry.references.flatMap((r) => [r.before_text, r.after_text]), ...(entry.deleted ?? []).map((d) => d.content)]
    .filter((t) => t.startsWith(BLOB_PREFIX))
    .map((t) => t.slice(BLOB_PREFIX.length));
}

// --- write / read ---

export function timestampId(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** The ids a journal file holds (any kind of line). */
async function idsIn(app: App, path: string): Promise<ReadonlyMap<string, unknown>> {
  return (await journalFile(app, path))?.lines ?? new Map();
}

async function appendEntry(app: App, settings: Settings, entry: JournalEntry): Promise<string> {
  const path = journalFileFor(settings, entry.migration_id);
  await appendLine(app, path, { type: "migration", ...(await pack(app, settings, entry)) });
  return path;
}

/** Append an operation; returns its id and where it is (`<file>#<id>`). */
async function writeJournalImpl(
  app: App,
  settings: Settings,
  entry: Omit<JournalEntry, "migration_id">,
  now: Date,
): Promise<{ id: string; path: string }> {
  const baseId = `${timestampId(now)}-${slug(entry.op)}${entry.summary ? `-${slug(entry.summary).slice(0, 30)}` : ""}`;
  const taken = await idsIn(app, journalFileFor(settings, baseId));
  let id = baseId;
  for (let n = 2; taken.has(id); n++) id = `${baseId}-${n}`;
  const path = await appendEntry(app, settings, { migration_id: id, ...entry });
  return { id, path: `${path}#${id}` };
}

async function findInStore(app: App, settings: Settings, id: string): Promise<{ entry: JournalEntry; undone: boolean; path: string } | null> {
  const path = journalFileFor(settings, id);
  const file = await journalFile(app, path);
  if (!file) return null;
  let entry: JournalEntry | null = null;
  let undone = false;
  for (const l of parseLines((file.lines.get(id) ?? []).join("\n"))) {
    if (l.migration_id !== id) continue;
    if (l.type === "migration") {
      const { type: _t, ...rest } = l;
      entry = rest;
    } else if (l.type === "undone") undone = true;
  }
  if (!entry) return null;
  // as it reads today: store paths of older engines, moves of the database folder, the database's id
  const read = translateJournalEntry(await unpack(app, settings, entry), await databaseMoves(app), settings.databaseId);
  return { entry: read, undone, path: `${path}#${id}` };
}

export async function readJournal(app: App, settings: Settings, migrationId: string): Promise<{ entry: JournalEntry; undone: boolean; path: string }> {
  const hit = await findInStore(app, settings, migrationId);
  if (hit) return hit;
  throw new MigrationNotFoundError(migrationId);
}

export async function markUndone(app: App, settings: Settings, migrationId: string, undoneBy: string, now: Date): Promise<void> {
  await appendLine(app, journalFileFor(settings, migrationId), { type: "undone", migration_id: migrationId, undone_by: undoneBy, at: now.toISOString() });
}

// --- listing ---

export interface MigrationSummary {
  migration_id: string;
  op: string;
  summary: string;
  /** The table the operation was about (qualified name), when it was about one. */
  table?: string;
  executed_at: string;
  notes_changed: number;
  files_changed: number;
  undone: boolean;
  undoes?: string;
  files_failed: number;
  /** "harness / model" of the agent that ran it. */
  by?: string;
  /** For a batch: its operations; for an operation of a batch: the batch's id. */
  members?: string[];
  batch?: string;
}

export interface ListMigrationsInput {
  limit?: number;
  op?: string;
  /** Substring of the table / schema the operation was about (e.g. `personal.tasks.task`). */
  table?: string;
  /** ISO date or date-time: only operations at or after it. */
  since?: string;
}

/** Operations newest first, with what each one touched (no row data). */
export async function listMigrations(app: App, settings: Settings, input: ListMigrationsInput = {}): Promise<{ total: number; migrations: MigrationSummary[] }> {
  const files = (await storeList(app, journalDir(settings))).files.filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const limit = Math.max(1, Math.min(input.limit ?? 50, 1000));
  const since = input.since ? Date.parse(input.since) : NaN;
  const out: MigrationSummary[] = [];
  let total = 0;
  for (const f of files) {
    const lines = parseLines((await storeRead(app, f)) ?? "");
    const undone = new Set(lines.filter((l): l is UndoneLine => l.type === "undone").map((l) => l.migration_id));
    const entries = lines.filter((l): l is MigrationLine => l.type === "migration").reverse();
    const batchOf = new Map<string, string>();
    for (const e of entries) for (const m of e.members ?? []) batchOf.set(m, e.migration_id);
    for (const e of entries) {
      if (input.op && e.op !== input.op) continue;
      if (input.table && !(e.schema ?? "").includes(input.table) && !e.summary.includes(input.table)) continue;
      if (!Number.isNaN(since) && Date.parse(e.executed_at) < since) continue;
      total++;
      if (out.length >= limit) continue;
      out.push({
        migration_id: e.migration_id,
        op: e.op,
        summary: e.summary,
        ...(e.schema?.includes("#") ? { table: e.schema.slice(e.schema.indexOf("#") + 1) } : {}),
        executed_at: e.executed_at,
        notes_changed: e.rows.length,
        files_changed: e.creates.length + e.moves.length + e.references.length + (e.deleted?.length ?? 0),
        undone: undone.has(e.migration_id),
        ...(e.undoes !== undefined ? { undoes: e.undoes } : {}),
        files_failed: e.failed.length,
        ...(actorName(e.actor) ? { by: actorName(e.actor) } : {}),
        ...(e.members ? { members: e.members } : {}),
        ...(batchOf.has(e.migration_id) ? { batch: batchOf.get(e.migration_id)! } : {}),
      });
    }
  }
  out.sort((a, b) => b.executed_at.localeCompare(a.executed_at));
  return { total, migrations: out };
}

/** The batch each operation ran in, by the operation's id (every journal file read). */
export async function batchMembership(app: App, settings: Settings): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of (await storeList(app, journalDir(settings))).files.filter((x) => x.endsWith(".jsonl"))) {
    for (const l of parseLines((await storeRead(app, f))!)) { // listed just now
      if (l.type === "migration") for (const m of l.members ?? []) out.set(m, l.migration_id);
    }
  }
  return out;
}

/** Recent work, as `datanotes status` shows it. */
export interface JournalActivity {
  /** Operations journaled at or after `since`. */
  recent: number;
  /** The newest operation (whatever its age), null when the journal is empty. */
  last: { migration_id: string; op: string; summary: string; executed_at: string; by?: string } | null;
}

/**
 * How many operations ran since `since` (ms) and the newest one. Reads the monthly files newest
 * first and stops at the first that holds nothing that recent once the newest operation is known.
 */
export async function journalActivity(app: App, settings: Settings, since: number): Promise<JournalActivity> {
  // newest month first; entries without a dated id (`undated.jsonl`) last
  const order = (f: string) => (f.endsWith("/undated.jsonl") ? "" : f);
  const files = (await storeList(app, journalDir(settings))).files.filter((f) => f.endsWith(".jsonl")).sort((a, b) => order(b).localeCompare(order(a)));
  let recent = 0;
  let last: MigrationLine | null = null;
  for (const f of files) {
    let inFile = 0;
    for (const l of parseLines((await storeRead(app, f))!)) { // listed just now
      if (l.type !== "migration") continue;
      if (Date.parse(l.executed_at) >= since) inFile++;
      if (!last || l.executed_at > last.executed_at) last = l;
    }
    recent += inFile;
    if (last && inFile === 0) break;
  }
  const by = last ? actorName(last.actor) : undefined;
  return { recent, last: last ? { migration_id: last.migration_id, op: last.op, summary: last.summary, executed_at: last.executed_at, ...(by ? { by } : {}) } : null };
}

// --- maintenance ---

export interface CompactResult {
  kept: number;
  dropped: number;
  blobsRemoved: number;
}

/** How often the blobs are checked when no entry was dropped (a blob a crash left without its entry). */
export const BLOB_CHECK_DAYS = 7;

/** When this engine last checked the blobs against every entry, by app (ms). */
const BLOBS_CHECKED = new WeakMap<object, number>();

/** What a compaction read of a journal file: its stamp then, its lines, those it keeps. */
interface JournalPlan {
  stamp: string;
  lines: Line[];
  kept: Line[];
  dropped: number;
}

/** A store file's size and time as one string ("" when the host cannot tell: always read again). */
async function stampOf(app: App, path: string): Promise<string> {
  const s = await storeStat(app, path);
  return s ? `${s.size}/${s.mtime}` : "";
}

/** One journal file read and planned: the entries inside the retention kept, with their undo marks. */
async function planFile(app: App, path: string, cutoff: number): Promise<JournalPlan> {
  const stamp = await stampOf(app, path);
  const lines = parseLines((await storeRead(app, path)) ?? "");
  const keepIds = new Set(lines.filter((l): l is MigrationLine => l.type === "migration" && Date.parse(l.executed_at) >= cutoff).map((l) => l.migration_id));
  const kept = lines.filter((l) => keepIds.has(l.migration_id));
  return { stamp, lines, kept, dropped: lines.filter((l) => l.type === "migration").length - keepIds.size };
}

/** The month a file holds (`2026-09`), null for one without a dated name (`undated.jsonl`). */
function monthOfFile(path: string): string | null {
  return /\/(\d{4}-\d{2})\.jsonl$/.exec(path)?.[1] ?? null;
}

/**
 * Drop entries older than the retention and blobs no entry refers to. The files are read and the
 * work planned without the write lock (`lock`, the engine's: no write waits for the reading);
 * it is held only to apply the plan, where a file changed since it was read (an append) is read
 * again first and the blobs of the entries appended meanwhile are kept. A month after the
 * retention's first one holds only entries to keep: it is read only to check the blobs, which
 * happens when entries were dropped, at the first compaction of a run, and then every
 * {@link BLOB_CHECK_DAYS} days. `kept` counts the entries of the files read.
 */
export async function compactJournal(
  app: App,
  settings: Settings,
  now: Date = new Date(),
  lock: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<CompactResult> {
  const cutoff = now.getTime() - settings.journalRetentionDays * 86_400_000;
  const firstMonth = new Date(cutoff).toISOString().slice(0, 7);
  const files = (await storeList(app, journalDir(settings))).files.filter((x) => x.endsWith(".jsonl"));
  /** Files that may hold entries to drop. */
  const dropping = new Set(files.filter((f) => (monthOfFile(f) ?? "") <= firstMonth));
  const plans = new Map<string, JournalPlan>();
  for (const f of dropping) plans.set(f, await planFile(app, f, cutoff));
  const checked = BLOBS_CHECKED.get(app);
  const gc = [...plans.values()].some((p) => p.dropped > 0) || checked === undefined || now.getTime() - checked >= BLOB_CHECK_DAYS * 86_400_000;
  if (gc) for (const f of files) if (!plans.has(f)) plans.set(f, await planFile(app, f, cutoff));
  const blobs = gc ? (await storeList(app, blobDir(settings))).files : [];
  return lock(async () => {
    const res: CompactResult = { kept: 0, dropped: 0, blobsRemoved: 0 };
    const used = new Set<string>();
    // the files now (one created since the listing holds new entries only)
    const current = gc ? (await storeList(app, journalDir(settings))).files.filter((x) => x.endsWith(".jsonl")) : [...plans.keys()];
    for (const f of current) {
      const planned = plans.get(f);
      // appended (or rewritten) since it was read: read again, now that no write runs
      const p = planned && planned.stamp !== "" && (await stampOf(app, f)) === planned.stamp ? planned : await planFile(app, f, cutoff);
      const kept = dropping.has(f) ? p.kept : p.lines;
      res.kept += kept.filter((l) => l.type === "migration").length;
      for (const l of kept) if (l.type === "migration") blobRefs(l).forEach((h) => used.add(h));
      if (!dropping.has(f)) continue;
      res.dropped += p.dropped;
      if (p.kept.length === 0) await storeRemove(app, f);
      else if (p.kept.length !== p.lines.length) await storeWrite(app, f, p.kept.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    forgetJournalFiles(app);
    if (gc) {
      for (const b of blobs) {
        const hash = b.slice(b.lastIndexOf("/") + 1).replace(/\.txt$/, "");
        if (used.has(hash)) continue;
        await storeRemove(app, b);
        res.blobsRemoved++;
      }
      BLOBS_CHECKED.set(app, now.getTime());
    }
    return res;
  });
}

/** {@link writeJournalImpl}, traced. */
export function writeJournal(...args: Parameters<typeof writeJournalImpl>): ReturnType<typeof writeJournalImpl> {
  return phase("engine.journal.append", () => writeJournalImpl(...args), { "datanotes.journal.op": args[2].op });
}
