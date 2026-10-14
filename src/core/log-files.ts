/**
 * The files of a table's transaction log (`store:transaction_log/<catalog.schema.table>/`), in
 * either format the engine writes, and its checkpoints (see transaction-log.ts for what a version
 * holds):
 *
 *   00000000000000000007.json                  one version per file (format `files`, read by every 3.x)
 *   00000000000000001000.segment.jsonl         versions 1000.. appended to one file (format `segments`)
 *   00000000000000001000-00000000000000001999.segment.jsonl
 *                                              versions 1000 to 1999, sealed: never written again
 *   00000000000000000999.checkpoint.json       a checkpoint as one JSON document, the rows' texts inline
 *   00000000000000004000.manifest.jsonl        a checkpoint: a header line, then [path, hash, size, part]
 *                                              per row (`.manifest-1.jsonl`, … hold the next rows of a
 *                                              large table)
 *   00000000000000004000.part-0.jsonl.gz       its rows' texts, [path, text] per line, gzip (`.jsonl`
 *                                              on a host that cannot write binary files)
 *
 * A version in a segment is a header line, `{"commit":{"version":7,"lines":4,"hash":"…"}}` (`hash`:
 * cyrb53 of the version's lines), then its lines as a file of its own holds them. A segment is
 * sealed (renamed with its last version) once it holds {@link SEGMENT_POLICY} versions or bytes,
 * so the versions of the sealed ones are known from their names, without reading them.
 *
 * What a reader tolerates: an empty or torn newest version file and a torn tail of a segment (a
 * power loss while it was written) are left out, as if never written; the next write sets the file
 * aside (`<name>.torn-<time>`) or writes the segment again without its tail. A checkpoint whose
 * files are not all there is skipped (the versions before it replay instead), and so is a
 * single-document checkpoint torn by a crash. The next writer writes a torn sealed segment or
 * checkpoint again, and a version a torn segment lacks is read from another copy (a cut-short
 * vacuum or conversion leaves two).
 *
 * Each table's list of files (its {@link LogToc}) is kept between calls while the store's count of
 * the engine's own changes to the folder and the folder's modification time say nothing changed:
 * the engine's own writes update it in place.
 */

import { guide, GuidedError } from "./hints";
import type { App } from "./host";
import { contentHash } from "./file-cache";
import {
  storeAppend,
  storeExists,
  storeGeneration,
  storeHoldsBinary,
  storeList,
  storeRead,
  storeReadBinary,
  storeReadFile,
  storeRemove,
  storeRename,
  storeStat,
  storeSyncNext,
  storeWrite,
  storeWriteBinary,
} from "./store";

/** An error of a table's transaction log; one a caller can act on carries its guidance. */
export class HistoryError extends GuidedError {
  override readonly name = "HistoryError";
}

/** When an open segment is sealed (and the next version starts a new one). */
export const SEGMENT_POLICY = { maxBytes: 8 * 1024 * 1024, maxVersions: 1000 };

/**
 * How large one file of a checkpoint may get, in characters: rows' texts are split into parts of
 * at most this much (one row larger than it is a part of its own), and so is the manifest. Far
 * below the 95 MB a file the store backup pushes, whatever the characters' encoding.
 */
export const CHECKPOINT_PART = { maxChars: 4 * 1024 * 1024 };

export const pad = (v: number) => String(v).padStart(20, "0");
export const commitPath = (dir: string, v: number) => `${dir}/${pad(v)}.json`;
export const checkpointPath = (dir: string, v: number) => `${dir}/${pad(v)}.checkpoint.json`;
export const manifestPath = (dir: string, v: number) => `${dir}/${pad(v)}.manifest.jsonl`;
const segmentPath = (dir: string, first: number, last?: number) => `${dir}/${pad(first)}${last === undefined ? "" : `-${pad(last)}`}.segment.jsonl`;

export const COMMIT_RE = /\/(\d{20})\.json$/;
export const CHECKPOINT_RE = /\/(\d{20})\.checkpoint\.json$/;
export const MANIFEST_RE = /\/(\d{20})\.manifest\.jsonl$/;
export const SEGMENT_RE = /\/(\d{20})(?:-(\d{20}))?\.segment\.jsonl$/;

/** Whether a file of a log folder holds versions (a version file or a segment). */
export function holdsVersions(path: string): boolean {
  return COMMIT_RE.test(path) || SEGMENT_RE.test(path);
}

/** A segment of a table's log. */
interface Segment {
  path: string;
  first: number;
  /** Its last whole version (first - 1 when it holds none). */
  last: number;
  sealed: boolean;
  /** Open segments: its size in bytes as the host gave it (undefined: the host cannot tell). */
  bytes?: number;
  /** Open segments: its length in characters, and whether it ends with a torn version. */
  chars?: number;
  tornAt?: number;
}

export interface CheckpointRef {
  version: number;
  /** 1: one JSON document (`.checkpoint.json`); 2: a manifest and parts. */
  kind: 1 | 2;
  path: string;
}

/** A table's log as its files say. */
export interface LogToc {
  dir: string;
  /** Every version, oldest first. */
  versions: number[];
  /** Versions in a file of their own. */
  files: Map<number, string>;
  segments: Segment[];
  /** Oldest first. */
  checkpoints: CheckpointRef[];
  /** The newest version file, left out: empty or torn (set aside by the next write). */
  torn: string | null;
  gen: number;
  mtime: number | null;
}

const TOCS = new WeakMap<object, Map<string, LogToc>>();

function tocsOf(app: App): Map<string, LogToc> {
  let m = TOCS.get(app);
  if (!m) TOCS.set(app, (m = new Map()));
  return m;
}

/** The newest version of a log (-1: none). */
export function latestOf(toc: LogToc): number {
  return toc.versions.length > 0 ? toc.versions[toc.versions.length - 1]! : -1;
}

/**
 * Parse a segment's text: its whole versions (where each one's lines are), and where a torn tail
 * starts (the text's length when there is none).
 */
export function parseSegment(text: string): { commits: { version: number; start: number; end: number }[]; validEnd: number } {
  const commits: { version: number; start: number; end: number }[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break;
    let head: { version?: unknown; lines?: unknown; hash?: unknown } | undefined;
    try {
      head = (JSON.parse(text.slice(pos, nl)) as { commit?: typeof head }).commit;
    } catch {
      break;
    }
    if (!head || !Number.isInteger(head.version) || !Number.isInteger(head.lines) || (head.lines as number) < 1) break;
    let end = nl + 1;
    let whole = true;
    for (let i = 0; i < (head.lines as number); i++) {
      const e = text.indexOf("\n", end);
      if (e < 0) {
        whole = false;
        break;
      }
      end = e + 1;
    }
    if (!whole) break;
    if (typeof head.hash === "string" && contentHash(text.slice(nl + 1, end)) !== head.hash) break;
    const prev = commits[commits.length - 1];
    if (prev && head.version !== prev.version + 1) break;
    commits.push({ version: head.version as number, start: nl + 1, end });
    pos = end;
  }
  return { commits, validEnd: pos };
}

/** A version as a segment holds it: its header line, then its lines. */
export function framed(version: number, text: string): string {
  const lines = text.split("\n").length - 1;
  return `${JSON.stringify({ commit: { version, lines, hash: contentHash(text) } })}\n${text}`;
}

// --- segments read lately (a replay reads one segment for many versions) ---

const SEGMENT_TEXTS = new WeakMap<object, Map<string, { text: string; index: Map<number, [number, number]> }>>();
const SEGMENT_TEXTS_KEPT = 3;

async function segmentText(app: App, seg: Segment): Promise<{ text: string; index: Map<number, [number, number]> }> {
  let cache = SEGMENT_TEXTS.get(app);
  if (!cache) SEGMENT_TEXTS.set(app, (cache = new Map()));
  const key = `${seg.path}\0${seg.sealed ? "" : `${seg.chars!}/${seg.last}`}\0${storeGeneration(app, seg.path)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const text = await storeReadFile(app, seg.path);
  const index = new Map<number, [number, number]>();
  for (const c of parseSegment(text).commits) index.set(c.version, [c.start, c.end]);
  const out = { text, index };
  cache.set(key, out);
  for (const k of cache.keys()) {
    if (cache.size <= SEGMENT_TEXTS_KEPT) break;
    cache.delete(k);
  }
  return out;
}

// --- the list of a log's files ---

async function buildToc(app: App, dir: string): Promise<LogToc> {
  const gen = storeGeneration(app, dir);
  const stat = await storeStat(app, dir);
  const toc: LogToc = { dir, versions: [], files: new Map(), segments: [], checkpoints: [], torn: null, gen, mtime: stat ? stat.mtime : null };
  for (const f of (await storeList(app, dir)).files) {
    let m: RegExpExecArray | null;
    if ((m = COMMIT_RE.exec(f))) toc.files.set(Number(m[1]), f);
    else if ((m = CHECKPOINT_RE.exec(f))) toc.checkpoints.push({ version: Number(m[1]), kind: 1, path: f });
    else if ((m = MANIFEST_RE.exec(f))) toc.checkpoints.push({ version: Number(m[1]), kind: 2, path: f });
    else if ((m = SEGMENT_RE.exec(f))) toc.segments.push({ path: f, first: Number(m[1]), last: m[2] !== undefined ? Number(m[2]) : Number(m[1]) - 1, sealed: m[2] !== undefined });
  }
  toc.segments.sort((a, b) => a.first - b.first);
  // a manifest and a single-document checkpoint at the same version: either serves (manifest first)
  toc.checkpoints.sort((a, b) => a.version - b.version || b.kind - a.kind);
  for (const seg of toc.segments) {
    if (seg.sealed) continue;
    const text = await storeReadFile(app, seg.path);
    const { commits, validEnd } = parseSegment(text);
    seg.last = commits.length > 0 ? commits[commits.length - 1]!.version : seg.first - 1;
    seg.chars = text.length;
    if (validEnd < text.length) seg.tornAt = validEnd;
    const st = await storeStat(app, seg.path);
    if (st) seg.bytes = st.size;
  }
  const versions = new Set<number>(toc.files.keys());
  for (const seg of toc.segments) for (let v = seg.first; v <= seg.last; v++) versions.add(v);
  toc.versions = [...versions].sort((a, b) => a - b);
  // the newest version, in a file of its own, empty or torn by a power loss: left out
  const newest = latestOf(toc);
  const file = toc.files.get(newest);
  if (file !== undefined && !inSegment(toc, newest)) {
    const text = await storeRead(app, file);
    if (text === null || text.trim() === "" || !wholeVersion(text)) {
      toc.torn = file;
      toc.files.delete(newest);
      toc.versions.pop();
    }
  }
  return toc;
}

/** Whether a version's text is whole: every line JSON, the first its commitInfo. */
function wholeVersion(text: string): boolean {
  try {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0 || !(JSON.parse(lines[0]!) as { commitInfo?: unknown }).commitInfo) return false;
    for (const l of lines.slice(1)) JSON.parse(l);
    return true;
  } catch {
    return false;
  }
}

function inSegment(toc: LogToc, v: number): Segment | undefined {
  for (let i = toc.segments.length - 1; i >= 0; i--) {
    const s = toc.segments[i]!;
    if (v >= s.first && v <= s.last) return s;
  }
  return undefined;
}

/**
 * The files of a table's log (`dir`), kept from one call to the next while nothing changed them:
 * one `stat` of the folder per call (a host that cannot tell a folder's time: its newest version
 * is still there and the next is not), the folder read again only when it changed.
 */
export async function logToc(app: App, dir: string): Promise<LogToc> {
  const tocs = tocsOf(app);
  const kept = tocs.get(dir);
  if (kept && kept.gen === storeGeneration(app, dir)) {
    const stat = await storeStat(app, dir);
    if (stat !== undefined ? (stat ? stat.mtime : null) === kept.mtime : await stillNewest(app, kept)) return kept;
  }
  const toc = await buildToc(app, dir);
  tocs.set(dir, toc);
  return toc;
}

/** Whether a log's newest version is still where it was, and no version came after it. */
async function stillNewest(app: App, toc: LogToc): Promise<boolean> {
  const latest = latestOf(toc);
  const where = latest < 0 ? null : (inSegment(toc, latest)?.path ?? toc.files.get(latest)!);
  if (where !== null && !(await storeExists(app, where))) return false;
  const next = commitPath(toc.dir, latest + 1);
  if (next !== toc.torn && (await storeExists(app, next))) return false;
  return !(await storeExists(app, segmentPath(toc.dir, latest + 1)));
}

/** Forget the files known of every log (after the engine moved or removed log folders). */
export function forgetLogTocs(app: App): void {
  TOCS.delete(app);
}

/** After a write of the engine's own into `toc`'s folder: what it knows is current again. */
async function settled(app: App, toc: LogToc): Promise<void> {
  toc.gen = storeGeneration(app, toc.dir);
  const stat = await storeStat(app, toc.dir);
  toc.mtime = stat ? stat.mtime : null;
}

// --- reading versions ---

/** How many version files a replay reads at the same time. */
const READ_AHEAD = 16;

/** The text of version `v` (as a file of its own holds it). */
export async function versionText(app: App, toc: LogToc, v: number): Promise<string> {
  // a vacuum or a conversion a crash cut short leaves a version in more than one file: the
  // newest segment first, then the older ones, then its own file
  const segments = segmentsWith(toc, v);
  for (const seg of segments) {
    const s = await segmentText(app, seg);
    const at = s.index.get(v);
    if (at) return s.text.slice(at[0], at[1]);
  }
  const file = toc.files.get(v);
  if (file !== undefined) return storeReadFile(app, file);
  /* v8 ignore next -- impossible: every caller asks for a version of the log's list */
  if (segments.length === 0) throw new HistoryError(`${toc.dir} has no version ${v}`);
  // a crash tore the segment, and the version's own file is gone: only a backup holds it
  throw new HistoryError(
    `${segments[0]!.path} does not hold version ${v} whole`,
    guide(`A crash lost version ${v}: no file of the log holds it whole. Restore the store from its backup (datanotes store restore --from <backup url> --database <folder> --force), then run the command again.`, "restoreStore"),
  );
}

/** The versions a segment holds whole (a sealed one a crash tore holds fewer than its name says). */
export async function wholeVersions(app: App, seg: Segment): Promise<Set<number>> {
  return new Set((await segmentText(app, seg)).index.keys());
}

/** The segments whose versions (by name) include `v`, newest first. */
function segmentsWith(toc: LogToc, v: number): Segment[] {
  return toc.segments.filter((s) => v >= s.first && v <= s.last).reverse();
}

/** The texts of versions (in the order given): files read a few at a time, a segment once for all its versions. */
export async function versionTexts(app: App, toc: LogToc, versions: readonly number[]): Promise<string[]> {
  const out = new Array<string>(versions.length);
  const files: number[] = [];
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]!;
    if (inSegment(toc, v)) out[i] = await versionText(app, toc, v);
    else files.push(i);
  }
  for (let i = 0; i < files.length; i += READ_AHEAD) {
    const chunk = files.slice(i, i + READ_AHEAD);
    const texts = await Promise.all(chunk.map((j) => versionText(app, toc, versions[j]!)));
    texts.forEach((t, k) => (out[chunk[k]!] = t));
  }
  return out;
}

// --- writing versions ---

/** A version file left torn by a power loss: set aside (kept for a person to look at), never read. */
async function setAside(app: App, path: string): Promise<string> {
  const to = `${path}.torn-${Date.now()}`;
  await storeRename(app, path, to);
  return to;
}

/**
 * Write version `v` of a log (its text as a file of its own holds it), in the format asked for.
 * The log must be at version `v - 1` (else: another writer, a {@link HistoryError}). Returns what
 * it set aside or cut (a torn newest version or segment tail), for a warning.
 */
export async function appendVersion(app: App, dir: string, v: number, text: string, format: "files" | "segments"): Promise<string[]> {
  const toc = await logToc(app, dir);
  if (latestOf(toc) !== v - 1) {
    // another writer got there first
    const file = toc.files.get(v);
    throw new HistoryError(file !== undefined ? `log file exists: ${file}` : `log moved on: ${dir} is at version ${latestOf(toc)}, not ${v - 1}`);
  }
  const repaired: string[] = [];
  if (toc.torn) {
    repaired.push(`${toc.torn} set aside as ${await setAside(app, toc.torn)}`);
    toc.torn = null;
  }
  // an open segment ending torn: written again without its tail (it then holds what it reads as);
  // one holding no whole version (empty, or torn in its first) is removed
  for (const seg of toc.segments) {
    if (seg.sealed || (seg.tornAt === undefined && seg.chars! > 0)) continue;
    const whole = (await storeReadFile(app, seg.path)).slice(0, seg.tornAt ?? 0);
    repaired.push(`${seg.path}: ${seg.chars! - whole.length} characters of a torn version cut${whole === "" ? ", the file removed" : ""}`);
    if (whole === "") await storeRemove(app, seg.path);
    else await storeWrite(app, seg.path, whole);
    seg.chars = whole.length;
    delete seg.tornAt;
    const st = await storeStat(app, seg.path);
    if (st) seg.bytes = st.size;
  }
  toc.segments = toc.segments.filter((s) => s.sealed || s.chars! > 0);
  if (format === "files") {
    const path = commitPath(dir, v);
    if (await storeExists(app, path)) throw new HistoryError(`log file exists: ${path}`);
    await storeWrite(app, path, text);
    toc.files.set(v, path);
  } else await appendToSegment(app, toc, v, text);
  toc.versions.push(v);
  await settled(app, toc);
  return repaired;
}

async function appendToSegment(app: App, toc: LogToc, v: number, text: string): Promise<void> {
  const chunk = framed(v, text);
  const open = toc.segments.filter((s) => !s.sealed);
  const active = open[open.length - 1];
  const fits = active && active.last === v - 1 && active.chars! < SEGMENT_POLICY.maxBytes && active.last - active.first + 1 < SEGMENT_POLICY.maxVersions;
  // every other open segment is sealed: the versions after it are elsewhere (files written meanwhile)
  for (const seg of open) if (!(fits && seg === active)) await seal(app, toc, seg);
  if (fits) {
    // another writer appended meanwhile: refused, as a version file that exists already
    const st = await storeStat(app, active.path);
    if (st && active.bytes !== undefined && st.size !== active.bytes) throw new HistoryError(`log moved on: ${active.path} changed`);
    await storeAppend(app, active.path, chunk);
    active.last = v;
    active.chars! += chunk.length;
    const after = await storeStat(app, active.path);
    if (after) active.bytes = after.size;
    return;
  }
  const path = segmentPath(toc.dir, v);
  if (await storeExists(app, path)) throw new HistoryError(`log file exists: ${path}`);
  await storeWrite(app, path, chunk);
  const st = await storeStat(app, path);
  toc.segments.push({ path, first: v, last: v, sealed: false, chars: chunk.length, ...(st ? { bytes: st.size } : {}) });
}

/** Seal an open segment (it holds a version: one without any was removed with its torn tail): renamed with its last version. */
async function seal(app: App, toc: LogToc, seg: Segment): Promise<void> {
  const to = segmentPath(toc.dir, seg.first, seg.last);
  await storeRename(app, seg.path, to);
  seg.path = to;
  seg.sealed = true;
  delete seg.bytes;
  delete seg.chars;
}

/**
 * Write versions as sealed segments (a conversion, or what a vacuum keeps of a segment): each run
 * of consecutive versions, at most {@link SEGMENT_POLICY} per segment. A segment there already is
 * kept when it holds its versions whole, else written again. Returns the paths written.
 */
export async function writeSealedSegments(app: App, dir: string, versions: readonly { version: number; text: string }[]): Promise<string[]> {
  const out: string[] = [];
  let run: { version: number; text: string }[] = [];
  let chars = 0;
  const flush = async () => {
    if (run.length === 0) return;
    const path = segmentPath(dir, run[0]!.version, run[run.length - 1]!.version);
    // one kept may be what a killed run wrote and never synced: synced with the ones written
    if (await holdsWhole(app, path, run.map((r) => r.version))) storeSyncNext(app, path);
    else await storeWrite(app, path, run.map((r) => framed(r.version, r.text)).join(""));
    out.push(path);
    run = [];
    chars = 0;
  };
  for (const r of versions) {
    const last = run[run.length - 1];
    if (last && (r.version !== last.version + 1 || chars >= SEGMENT_POLICY.maxBytes || run.length >= SEGMENT_POLICY.maxVersions)) await flush();
    run.push(r);
    chars += r.text.length;
  }
  await flush();
  return out;
}

/** Whether a sealed segment is there holding exactly these versions, whole (one a crash tore is written again). */
async function holdsWhole(app: App, path: string, versions: readonly number[]): Promise<boolean> {
  const text = await storeRead(app, path);
  if (text === null) return false;
  const { commits, validEnd } = parseSegment(text);
  return validEnd === text.length && commits.length === versions.length && commits.every((c, i) => c.version === versions[i]);
}

// --- checkpoints of format 2: a manifest and parts ---

/** The header of a manifest (its first line). */
export interface ManifestHead {
  format: 2;
  version: number;
  timestamp: string;
  entry: unknown;
  /** How many moves of the database folder its paths reflect. */
  moves?: number;
  rows: number;
  /** The parts holding the rows' texts, by file name (in the table's log folder). */
  parts: string[];
  /** The manifest's next files (rows that did not fit in this one), by file name. */
  more?: string[];
}

/** One row of a manifest: path, content hash, length of its text, and the part holding it. */
export type ManifestRow = [path: string, hash: string, size: number, part: number];

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function gunzip(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Lines in files of at most {@link CHECKPOINT_PART} characters (one longer line alone in its file). */
function chunked(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const l of lines) {
    if (cur.length > 0 && chars + l.length + 1 > CHECKPOINT_PART.maxChars) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(l);
    chars += l.length + 1;
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

/**
 * Write a checkpoint as a manifest and parts (the rows sorted by path). The parts first, the
 * manifest last: a checkpoint whose manifest is there has every file. Returns the paths written
 * (none when a whole one is there already).
 */
export async function writeManifestCheckpoint(
  app: App,
  dir: string,
  head: { version: number; timestamp: string; entry: unknown; moves?: number },
  rows: readonly { path: string; hash: string; content: string }[],
): Promise<string[]> {
  const main = manifestPath(dir, head.version);
  if (await wholeManifest(app, dir, main)) return [];
  const binary = storeHoldsBinary(app);
  const written: string[] = [];
  const textLines = rows.map((r) => JSON.stringify([r.path, r.content]));
  const partOf: number[] = [];
  const parts = chunked(textLines);
  let row = 0;
  const partNames: string[] = [];
  for (const [i, lines] of parts.entries()) {
    const name = `${pad(head.version)}.part-${i}.jsonl${binary ? ".gz" : ""}`;
    const text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    if (binary) await storeWriteBinary(app, `${dir}/${name}`, await gzip(text));
    else await storeWrite(app, `${dir}/${name}`, text);
    written.push(`${dir}/${name}`);
    partNames.push(name);
    for (let k = 0; k < lines.length; k++) partOf[row++] = i;
  }
  const entries = rows.map((r, i) => JSON.stringify([r.path, r.hash, r.content.length, partOf[i]!] satisfies ManifestRow));
  const pieces = chunked(entries);
  const more = pieces.slice(1).map((_, i) => `${pad(head.version)}.manifest-${i + 1}.jsonl`);
  for (const [i, lines] of pieces.slice(1).entries()) {
    await storeWrite(app, `${dir}/${more[i]!}`, `${lines.join("\n")}\n`);
    written.push(`${dir}/${more[i]!}`);
  }
  const header: ManifestHead = { format: 2, version: head.version, timestamp: head.timestamp, entry: head.entry, ...(head.moves ? { moves: head.moves } : {}), rows: rows.length, parts: partNames, ...(more.length > 0 ? { more } : {}) };
  await storeWrite(app, main, `${JSON.stringify({ checkpoint: header })}\n${pieces[0]!.length > 0 ? `${pieces[0]!.join("\n")}\n` : ""}`);
  written.push(main);
  return written;
}

/** A manifest's header and rows; null when it, or a file it names, is missing or unreadable. */
export async function readManifest(app: App, dir: string, path: string): Promise<{ head: ManifestHead; rows: ManifestRow[] } | null> {
  try {
    const text = await storeRead(app, path);
    if (text == null) return null;
    const lines = text.split("\n").filter((l) => l !== "");
    const head = (JSON.parse(lines[0] ?? "null") as { checkpoint?: ManifestHead } | null)?.checkpoint;
    if (!head || head.format !== 2) return null;
    const rows = lines.slice(1).map((l) => JSON.parse(l) as ManifestRow);
    for (const name of head.more ?? []) {
      const more = await storeRead(app, `${dir}/${name}`);
      if (more == null) return null;
      for (const l of more.split("\n")) if (l !== "") rows.push(JSON.parse(l) as ManifestRow);
    }
    if (rows.length !== head.rows) return null;
    return { head, rows };
  } catch {
    return null;
  }
}

/** Whether a manifest checkpoint is there, readable, with every part it names (one a crash tore is written again). */
async function wholeManifest(app: App, dir: string, path: string): Promise<boolean> {
  const m = await readManifest(app, dir, path);
  if (!m) return false;
  for (const name of m.head.parts) if (!(await readPart(app, dir, name))) return false;
  return true;
}

/** The texts of one part of a manifest checkpoint, by path; null when it is missing or unreadable. */
export async function readPart(app: App, dir: string, name: string): Promise<Map<string, string> | null> {
  try {
    let text: string | null;
    if (name.endsWith(".gz")) {
      const data = await storeReadBinary(app, `${dir}/${name}`);
      text = data ? await gunzip(data) : null;
    } else text = await storeRead(app, `${dir}/${name}`);
    if (text == null) return null;
    const out = new Map<string, string>();
    for (const l of text.split("\n")) {
      if (l === "") continue;
      const [path, content] = JSON.parse(l) as [string, string];
      out.set(path, content);
    }
    return out;
  } catch {
    return null;
  }
}

/** The files of a manifest checkpoint (the manifest, its next files, its parts), by store path. */
export function manifestFiles(dir: string, path: string, head: ManifestHead | null): string[] {
  return [path, ...(head?.more ?? []).map((n) => `${dir}/${n}`), ...(head?.parts ?? []).map((n) => `${dir}/${n}`)];
}
