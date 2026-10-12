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
import { storeAppend, storeExists, storeList, storePath, storeRead, storeRemove, storeWrite } from "./store";
import { databaseMoves, translateJournalEntry } from "./database-move";

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

/** Append one line; after a torn last line (a crash while appending) start on a new line. */
async function appendLine(app: App, path: string, line: Line): Promise<void> {
  const text = await storeRead(app, path);
  const sep = text && !text.endsWith("\n") ? "\n" : "";
  await storeAppend(app, path, `${sep}${JSON.stringify(line)}\n`);
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

async function idsIn(app: App, path: string): Promise<Set<string>> {
  const text = await storeRead(app, path);
  const out = new Set<string>();
  if (text) for (const m of text.matchAll(/"migration_id":"([^"]+)"/g)) out.add(m[1]!);
  return out;
}

async function appendEntry(app: App, settings: Settings, entry: JournalEntry): Promise<string> {
  const path = journalFileFor(settings, entry.migration_id);
  await appendLine(app, path, { type: "migration", ...(await pack(app, settings, entry)) });
  return path;
}

/** Append an operation; returns its id and where it is (`<file>#<id>`). */
export async function writeJournal(
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
  const text = await storeRead(app, path);
  if (!text) return null;
  let entry: JournalEntry | null = null;
  let undone = false;
  for (const l of parseLines(text)) {
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

/** Drop entries older than the retention and blobs no entry refers to. */
export async function compactJournal(app: App, settings: Settings, now: Date = new Date()): Promise<CompactResult> {
  const cutoff = now.getTime() - settings.journalRetentionDays * 86_400_000;
  const res: CompactResult = { kept: 0, dropped: 0, blobsRemoved: 0 };
  const used = new Set<string>();
  for (const f of (await storeList(app, journalDir(settings))).files.filter((x) => x.endsWith(".jsonl"))) {
    const text = (await storeRead(app, f)) ?? "";
    const lines = parseLines(text);
    const keepIds = new Set(
      lines.filter((l): l is MigrationLine => l.type === "migration" && Date.parse(l.executed_at) >= cutoff).map((l) => l.migration_id),
    );
    const kept = lines.filter((l) => keepIds.has(l.migration_id));
    const migrations = lines.filter((l) => l.type === "migration").length;
    res.dropped += migrations - keepIds.size;
    res.kept += keepIds.size;
    for (const l of kept) if (l.type === "migration") blobRefs(l).forEach((h) => used.add(h));
    if (kept.length === 0) await storeRemove(app, f);
    else if (kept.length !== lines.length) await storeWrite(app, f, kept.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  for (const b of (await storeList(app, blobDir(settings))).files) {
    const hash = b.slice(b.lastIndexOf("/") + 1).replace(/\.txt$/, "");
    if (!used.has(hash)) {
      await storeRemove(app, b);
      res.blobsRemoved++;
    }
  }
  return res;
}
