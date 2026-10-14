/**
 * Reading the vault as files: a note with its front matter (`read_note`), a folder's children
 * (`list_folder`) and plain-text search (`search_notes`), through the host's index of words when it
 * has one. Every path is vault-relative, with forward slashes; dot-files and dot-folders are left
 * out of listings and searches.
 */

import type { App, TFile } from "./host";
import type { DatanotesSettings } from "./settings";
import { readHash, readHashed } from "./file-cache";
import { readDatabaseConfig } from "./database";
import { isoAt } from "./datetime";
import { guide, GuidedError } from "./hints";

/** A note, folder or file the request names is not in the vault (HTTP 404). */
export class VaultPathNotFoundError extends GuidedError {
  override readonly name = "VaultPathNotFoundError";
}

/** A request that names a folder where a file is needed, or the reverse (HTTP 400). */
export class VaultPathError extends GuidedError {
  override readonly name = "VaultPathError";
}

const FIND_NOTE = guide("Give the vault path of the note, with .md: list_folder lists a folder, search_notes finds notes by their words.", "readNote");

/** Vault-relative: no leading or trailing slashes. */
function clean(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export interface NoteRead {
  path: string;
  /** The whole text, front matter included. */
  content: string;
  /** The parsed front matter (empty when the note has none). */
  front_matter: Record<string, unknown>;
  /** Without `#`, from the text and the front matter's `tags`. */
  tags: string[];
  /** Last change, in the database's time zone. */
  modified_at: string | null;
  created_at: string | null;
  /** In bytes. */
  size: number | null;
}

/** A file of the vault with its front matter and tags (`read_note`). */
export async function readNote(app: App, settings: DatanotesSettings, path: string): Promise<NoteRead> {
  const rel = clean(path);
  if (rel === "" || /\/$/.test(path.trim())) {
    throw new VaultPathError("path must name a file, not a folder", guide("Pass the vault path of a note, e.g. \"Films/Metropolis.md\"; list_folder lists a folder.", "readNote"));
  }
  const f = app.vault.getAbstractFileByPath(rel);
  if (!f || !("extension" in f)) {
    if (f) throw new VaultPathError(`${rel} is a folder: list_folder lists it`, FIND_NOTE);
    throw new VaultPathNotFoundError(`no file ${rel} in the vault`, FIND_NOTE);
  }
  const file = f as TFile;
  const { content } = await readHashed(app, file);
  const cache = app.metadataCache.getFileCache(file) as { frontmatter?: Record<string, unknown>; tags?: { tag: string }[] } | null;
  const { position: _position, ...frontMatter } = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  const fmTags = frontMatter.tags;
  const tags = [
    ...(cache?.tags ?? []).map((t) => t.tag.replace(/^#/, "")),
    ...(Array.isArray(fmTags) ? fmTags.map(String) : typeof fmTags === "string" ? [fmTags] : []),
  ];
  const stat = (file as unknown as { stat?: { ctime?: number; mtime?: number; size?: number } }).stat;
  const tz = (await readDatabaseConfig(app, settings)).timezone;
  const at = (ms: number | undefined) => (typeof ms === "number" && ms > 0 ? isoAt(ms, tz) : null);
  return {
    path: file.path,
    content,
    front_matter: frontMatter,
    tags: [...new Set(tags)],
    modified_at: at(stat?.mtime),
    created_at: at(stat?.ctime),
    size: typeof stat?.size === "number" ? stat.size : null,
  };
}

export interface FolderListing {
  /** The folder listed: "" is the vault root. */
  folder: string;
  /** Its sub-folders, as vault paths, sorted. */
  folders: string[];
  /** Its files, as vault paths, sorted. */
  files: string[];
}

/** The direct children of a vault folder (`list_folder`); dot-files and dot-folders are left out. */
export function listFolder(app: App, folder: string): FolderListing {
  const rel = clean(folder);
  const node = rel === "" ? (app.vault.getRoot?.() ?? app.vault.getAbstractFileByPath("/")) : app.vault.getAbstractFileByPath(rel);
  if (!node || !("children" in node)) {
    if (node) throw new VaultPathError(`${rel} is a file: read_note reads it`, guide("Pass a folder of the vault (\"\" is the vault root); read_note reads a file.", "readNote"));
    throw new VaultPathNotFoundError(`no folder ${rel} in the vault`, guide("list_folder with folder \"\" lists the vault root; pass one of its folders.", "readNote"));
  }
  const folders: string[] = [];
  const files: string[] = [];
  for (const child of (node as unknown as { children: { path: string; name?: string; children?: unknown }[] }).children) {
    const name = child.name ?? child.path.split("/").pop()!;
    if (name.startsWith(".")) continue;
    const path = rel === "" ? name : `${rel}/${name}`;
    ("children" in child ? folders : files).push(path);
  }
  return { folder: rel, folders: folders.sort(), files: files.sort() };
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** search_notes' folding (NFD, combining marks dropped, lower case): a host's search index stores texts folded so. */
export const searchFold: (s: string) => string = fold;

/** Characters below U+0300 fold to one character each (accents decompose into marks the fold drops). */
const ONE_TO_ONE = /^[\u0000-˿]*$/;

/** How many characters each character of the Basic Multilingual Plane folds to, once known (255: not yet). */
const BMP_FOLDED = new Uint8Array(0x10000).fill(255);

function foldedLength(cp: number, ch: string): number {
  if (cp > 0xffff) return fold(ch).length;
  let n = BMP_FOLDED[cp]!;
  if (n === 255) BMP_FOLDED[cp] = n = fold(ch).length;
  return n;
}

/**
 * Where a range of the folded text is in the text itself. Folding can change the length: a text
 * already decomposed (`e` and a combining accent) loses the accent, a Hangul syllable becomes two
 * or three letters. Each character folds on its own to as many characters as it takes in the
 * folded text, so the folded positions map back character by character; a range ends after the
 * accents that follow its last character. Null when every character folds to one of the same
 * length (the folded positions are the text's).
 */
function foldedOffsets(content: string): { start(i: number): number; end(i: number): number } | null {
  if (ONE_TO_ONE.test(content)) return null;
  const starts: number[] = [];
  const ends: number[] = [];
  let aligned = true;
  for (let o = 0; o < content.length; ) {
    const cp = content.codePointAt(o)!;
    const width = cp > 0xffff ? 2 : 1;
    const n = cp < 0x300 ? 1 : foldedLength(cp, content.slice(o, o + width));
    if (n !== width) aligned = false;
    if (n === 0 && ends.length > 0) {
      // a mark the fold drops: it stays with the character before it
      for (let k = ends.length - 1; k >= 0 && ends[k] === o; k--) ends[k] = o + width;
    }
    for (let k = 0; k < n; k++) {
      starts.push(o);
      ends.push(o + width);
    }
    o += width;
  }
  if (aligned) return null;
  return {
    // a match covers at least one folded character: its start and its last character are in the text
    start: (i) => starts[i]!,
    end: (i) => ends[i - 1]!,
  };
}

/** The folded text of each note searched, by path, while the note's text is the same (its hash). */
interface FoldedNote {
  hash: string;
  text: string;
  name: string;
}

/** At most `maxChars` characters of folded text are kept: past it, notes not kept yet are folded on each search. */
export const SEARCH_CACHE = { maxChars: 64 * 1024 * 1024 };

const FOLDED = new WeakMap<object, { notes: Map<string, FoldedNote>; chars: number }>();

function foldedCache(app: App): { notes: Map<string, FoldedNote>; chars: number } {
  let cache = FOLDED.get(app);
  if (!cache) FOLDED.set(app, (cache = { notes: new Map(), chars: 0 }));
  return cache;
}

/** The folded text kept for a note when it is of this version (no text needed). */
function keptFolded(app: App, path: string, hash: string): FoldedNote | undefined {
  const kept = foldedCache(app).notes.get(path);
  return kept && kept.hash === hash ? kept : undefined;
}

/** A note's folded text for a version not kept yet ({@link keptFolded} first); `keep`: kept within the budget. */
function foldedNote(app: App, path: string, hash: string, content: string, keep: boolean): FoldedNote {
  const note = { hash, text: fold(content), name: fold(path) };
  if (!keep) return note;
  const cache = foldedCache(app);
  const kept = cache.notes.get(path);
  const size = note.text.length + note.name.length;
  if (kept) {
    cache.chars += size - kept.text.length - kept.name.length;
    cache.notes.set(path, note);
  } else if (cache.chars + size <= SEARCH_CACHE.maxChars) {
    cache.chars += size;
    cache.notes.set(path, note);
  }
  return note;
}

/** Forget the folded texts of notes that are no longer in the vault. */
function forgetFolded(app: App, present: ReadonlySet<string>): void {
  const cache = foldedCache(app);
  for (const [path, note] of cache.notes) {
    if (present.has(path)) continue;
    cache.notes.delete(path);
    cache.chars -= note.text.length + note.name.length;
  }
}

/** What a host's search index answers: the notes that can have every word of a search. */
export interface SearchCandidates {
  /** The notes the index names: their indexed path or text has every trigram of the words. */
  hits: Iterable<string>;
  /** The notes the index may not hold as they are now (read or moved, not written yet): searched whatever it says. */
  unsure: Iterable<string>;
}

/** A host's index of the notes' words (the headless host's index on disk). */
export interface SearchSource {
  /**
   * The notes that can have every one of `words` (folded with {@link searchFold}, each
   * {@link indexableWord}): a note that has them all is in `hits` or `unsure`; both may name notes
   * that match nothing, or paths that are no note any more. Null when the index cannot answer now:
   * every note is searched.
   */
  candidates(words: readonly string[]): SearchCandidates | null;
}

const SEARCH_SOURCES = new WeakMap<object, SearchSource>();

/** Register (or with null remove) the host's search index: searches then read only the notes it names. */
export function setSearchSource(app: App, source: SearchSource | null): void {
  if (source) SEARCH_SOURCES.set(app, source);
  else SEARCH_SOURCES.delete(app);
}

/** A surrogate code unit outside a pair: the UTF-8 an index holds has no such character. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether an index of trigrams (three code points) can look a folded word up: three code points or
 * more, no NUL (the index holds it as a space), no lone surrogate (UTF-8 holds U+FFFD instead).
 */
export function indexableWord(w: string): boolean {
  if (w.indexOf("\0") >= 0 || LONE_SURROGATE.test(w)) return false;
  let n = 0;
  for (const _ of w) if (++n >= 3) return true;
  return false;
}

/** How many notes and characters of folded text the search keeps for an app (tests). */
export function searchCacheStats(app: App): { notes: number; chars: number } {
  const c = FOLDED.get(app);
  return { notes: c?.notes.size ?? 0, chars: c?.chars ?? 0 };
}

export interface NoteMatch {
  /** Where the words occur in the note's text (character offsets). */
  start: number;
  end: number;
  /** The text around them: `context_length` characters on each side. */
  context: string;
}

export interface NoteSearchResults {
  query: string;
  /** Best first: at most 200 notes, at most 20 matches each. */
  results: { path: string; score: number; matches: NoteMatch[] }[];
  /** Notes that match, all of them (more than `results` when the 200 are cut). */
  total: number;
}

/** A path with a part that starts with a dot. */
const HIDDEN = /(^|\/)\./;

/** The most notes a search returns. */
const MAX_RESULTS = 200;

/** A note that has every word: its score, its folded text and its text (its passages are cut from them). */
interface Found {
  path: string;
  score: number;
  folded: FoldedNote;
  content: string;
}

/**
 * The score of a note that has every word: the words' occurrences in its text, at most 20, plus 5
 * for each word in its path. Counts the occurrences as the passages find them, stopping at 20.
 */
function scoreOf(n: FoldedNote, words: readonly string[]): number {
  let hits = 0;
  for (const w of words) {
    for (let i = n.text.indexOf(w); i >= 0 && hits < 20; i = n.text.indexOf(w, i + w.length)) hits++;
    if (hits >= 20) break;
  }
  return hits + words.filter((w) => n.name.includes(w)).length * 5;
}

/** The passages of a note that has every word (at most 20), with their offsets in its own text. */
function matchesOf(text: string, content: string, words: readonly string[], ctx: number): NoteMatch[] {
  const spans: { start: number; end: number }[] = [];
  for (const w of words) {
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) spans.push({ start: i, end: i + w.length });
  }
  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  // one match per passage: spans that overlap, or have only spaces and punctuation between them, merge
  const merged: { start: number; end: number }[] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && (sp.start <= last.end || !/[\p{L}\p{N}]/u.test(text.slice(last.end, sp.start)))) last.end = Math.max(last.end, sp.end);
    else merged.push({ ...sp });
  }
  // the words are found in the folded text: their places in the note's own text
  const at = merged.length > 0 ? foldedOffsets(content) : null;
  return merged.slice(0, 20).map((m) => {
    const start = at ? at.start(m.start) : m.start;
    const end = at ? at.end(m.end) : m.end;
    return { start, end, context: content.slice(Math.max(0, start - ctx), end + ctx) };
  });
}

/** The notes a source names, once each, that are Markdown notes of the vault now (as getMarkdownFiles lists them). */
function candidateFiles(app: App, c: SearchCandidates): TFile[] {
  const out: TFile[] = [];
  const seen = new Set<string>();
  for (const list of [c.hits, c.unsure]) {
    for (const p of list) {
      if (seen.has(p)) continue;
      seen.add(p);
      const f = app.vault.getAbstractFileByPath(p);
      // a path gone since, a folder, another kind of file: not searched
      if (f && "extension" in f && (f as TFile).extension === "md") out.push(f as TFile);
    }
  }
  return out;
}

/**
 * Plain-text search (`search_notes`): every word of the query must occur (case- and
 * accent-insensitive) in the note's path or text. One entry per note, whose matches are the
 * passages where the words occur: words next to each other ("Cary Grant" for `cary grant`) make one
 * match, not one per word. The score counts the words found in the text (at most 20), plus 5 for
 * each word in the path. Passages are built only for the notes returned. With a host's search
 * index ({@link setSearchSource}), only the notes it names are searched; the answer is the same.
 */
export async function searchNotes(app: App, query: string, contextLength = 100): Promise<NoteSearchResults> {
  const words = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
  if (words.length === 0) return { query, results: [], total: 0 };
  const ctx = Number.isFinite(contextLength) && contextLength >= 0 ? Math.min(Math.floor(contextLength), 1000) : 100;
  // the host's index of the notes' words, for the words it can look up: only the notes it names are searched
  const indexable = words.filter(indexableWord);
  const narrowed = indexable.length > 0 ? (SEARCH_SOURCES.get(app)?.candidates(indexable) ?? null) : null;
  const files = narrowed ? candidateFiles(app, narrowed) : app.vault.getMarkdownFiles();
  // folded texts are kept only while every note is searched: with an index they would only cost memory
  const keep = narrowed === null;
  const present = keep ? new Set<string>() : null;
  const has = (n: FoldedNote) => words.every((w) => n.text.includes(w) || n.name.includes(w));
  const found: Found[] = [];
  for (const f of files) {
    // a dot-file, or a file in a dot-folder
    if (HIDDEN.test(f.path)) continue;
    present?.add(f.path);
    // folded once per version of the note, not once per search: a note kept folded needs no text
    // unless it matches (its passages are cut from the text)
    let content: string | undefined;
    let folded = keptFolded(app, f.path, await readHash(app, f));
    if (!folded) {
      const r = await readHashed(app, f);
      content = r.content;
      folded = foldedNote(app, f.path, r.hash, content, keep);
    }
    if (!has(folded)) continue;
    if (content === undefined) {
      const r = await readHashed(app, f);
      content = r.content;
      // the note changed since its hash was read: its new text is what counts
      if (r.hash !== folded.hash && !has((folded = foldedNote(app, f.path, r.hash, content, keep)))) continue;
    }
    found.push({ path: f.path, score: scoreOf(folded, words), folded, content });
  }
  if (present) forgetFolded(app, present);
  found.sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
  // passages only for the notes returned
  const results = found.slice(0, MAX_RESULTS).map((r) => ({ path: r.path, score: r.score, matches: matchesOf(r.folded.text, r.content, words, ctx) }));
  return { query, results, total: found.length };
}
