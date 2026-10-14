/**
 * Per-app cache of the notes the engine reads: each note's content hash and front matter parse,
 * reused while the file's `stat` (mtime + size, kept in memory by Obsidian) is unchanged. The
 * texts themselves are kept apart, up to a number of characters ({@link TEXT_CACHE}), the least
 * recently used going first: a parse does not keep its note's text alive, and a read that needs
 * no body (most reads of rows) needs no text. A text no longer kept is asked of the host's quick
 * source when it has one ({@link setTextSource}: the headless host's index on disk), checked by
 * its hash, else read again. Writes by the engine and vault events invalidate paths explicitly, so
 * a same-millisecond rewrite cannot be missed. Files without `stat` are always read (never cached).
 */

import type { App, TFile } from "./host";
import type { OrderedFrontmatter } from "./types";
import { count } from "./tracing";
import { coerceMisparsedYamlWikilinkToString, readOrderedFromMarkdown } from "./frontmatter";
import { touchIndex } from "./vault-index";
import { intern } from "./intern";

interface Parsed {
  ordered: OrderedFrontmatter;
  body: string;
}

/** A front matter parse and where the note's body starts in its text (the body is sliced from the text when asked for). */
interface Parse {
  ordered: OrderedFrontmatter;
  bodyStart: number;
}

interface Entry {
  mtime: number;
  size: number;
  hash: string;
  /**
   * The front matter as `readOrderedFromMarkdown(content)` parses it, once per version of the
   * text: the variants with misparsed wikilinks read back ({@link readFrontmatter}) derive from it.
   */
  raw?: Parse;
  /** The variants of `raw` by the keys whose wikilinks are read back. */
  variants?: Map<string, Parse>;
  /** Parse results by parser key ({@link readParsed}: callers parse with their own options). */
  parsed?: Map<string, Parsed>;
}

/**
 * How many characters of note texts each app keeps (a two-byte character, outside Latin-1, costs
 * two bytes: the memory is at most twice this). Texts are read only when a call needs them, so a
 * start with the host's index on disk keeps none; a search of every note keeps them all, up to it.
 */
export const TEXT_CACHE = { maxChars: 64 * 1024 * 1024 };

/** A host's quick source of the texts of its notes (the headless host's index on disk): the text a note had with this hash. */
export interface TextSource {
  textOf(path: string, hash: string): string | undefined;
}

const CACHES = new WeakMap<object, Map<string, Entry>>();
const TEXTS = new WeakMap<object, Texts>();
const SOURCES = new WeakMap<object, TextSource>();
/** Bumped on every invalidation: derived indexes (e.g. the link graph) rebuild when it moves. */
const GENERATIONS = new WeakMap<object, number>();

/** The texts an app keeps, by path, least recently used first. */
class Texts {
  private readonly map = new Map<string, { text: string; hash: string }>();
  chars = 0;

  get(path: string, hash: string): string | undefined {
    const t = this.map.get(path);
    if (!t || t.hash !== hash) return undefined;
    this.map.delete(path); // the most recently used goes last
    this.map.set(path, t);
    return t.text;
  }

  /** The text kept for a path, whatever its version (no use recorded). */
  peek(path: string): string | undefined {
    return this.map.get(path)?.text;
  }

  set(path: string, hash: string, text: string, max: number): void {
    this.delete(path);
    if (text.length > max) return;
    this.map.set(path, { text, hash });
    this.chars += text.length;
    for (const [p, t] of this.map) {
      if (this.chars <= max) break;
      this.map.delete(p);
      this.chars -= t.text.length;
    }
  }

  delete(path: string): void {
    const t = this.map.get(path);
    if (!t) return;
    this.map.delete(path);
    this.chars -= t.text.length;
  }

  get size(): number {
    return this.map.size;
  }
}

export function vaultGeneration(app: App): number {
  return GENERATIONS.get(app) ?? 0;
}

/** Signal a vault change that is not a file write (e.g. Obsidian finished resolving links). */
export function bumpVaultGeneration(app: App): void {
  GENERATIONS.set(app, vaultGeneration(app) + 1);
}

function cacheOf(app: App): Map<string, Entry> {
  let c = CACHES.get(app);
  if (!c) CACHES.set(app, (c = new Map()));
  return c;
}

function textsOf(app: App): Texts {
  let t = TEXTS.get(app);
  if (!t) TEXTS.set(app, (t = new Texts()));
  return t;
}

/** Keep a note's text, within the app's budget. */
function keepText(app: App, path: string, hash: string, text: string): void {
  textsOf(app).set(path, hash, text, TEXT_CACHE.maxChars);
}

/**
 * Register (or with null remove) the host's quick source of note texts: a text the cache no
 * longer keeps is asked of it (checked by the hash) before the note is read again.
 */
export function setTextSource(app: App, source: TextSource | null): void {
  if (source) SOURCES.set(app, source);
  else SOURCES.delete(app);
}

/** How many texts and characters the cache keeps for an app (tests, the status). */
export function textCacheStats(app: App): { texts: number; chars: number } {
  const t = TEXTS.get(app);
  return { texts: t?.size ?? 0, chars: t?.chars ?? 0 };
}

function stampOf(f: TFile): { mtime: number; size: number } | null {
  const s = (f as { stat?: { mtime?: number; size?: number } }).stat;
  return s && typeof s.mtime === "number" && typeof s.size === "number" ? { mtime: s.mtime, size: s.size } : null;
}

/** cyrb53: a fast 53-bit string hash, enough to tell file versions apart. */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  // interned: the file cache, the metadata cache and the transaction log hold one copy
  return intern((4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0"));
}

/**
 * A note's entry for its stat now, and its text when the cache had to read it. A note without a
 * stat is read every time (its entry is not kept).
 */
async function entryFor(app: App, f: TFile): Promise<{ e: Entry; text?: string }> {
  const cache = cacheOf(app);
  const stamp = stampOf(f);
  const hit = cache.get(f.path);
  if (hit && stamp && hit.mtime === stamp.mtime && hit.size === stamp.size) {
    count("datanotes.cache.hits");
    return { e: hit };
  }
  count("datanotes.cache.misses");
  return read(app, f);
}

/** Read a note now: a new entry (kept when the note has a stat), and its text. */
async function read(app: App, f: TFile): Promise<{ e: Entry; text: string }> {
  const cache = cacheOf(app);
  const stamp = stampOf(f);
  const text = await app.vault.read(f);
  const e: Entry = { mtime: stamp?.mtime ?? -1, size: stamp?.size ?? -1, hash: contentHash(text) };
  if (stamp) {
    cache.set(f.path, e);
    keepText(app, f.path, e.hash, text);
  } else {
    cache.delete(f.path);
    textsOf(app).delete(f.path);
  }
  return { e, text };
}

/**
 * A note's text and entry: the text kept, else the host's quick source's, else read again. A
 * text read again whose hash is not the entry's (the note changed with its stat unchanged) makes
 * a new entry.
 */
async function withText(app: App, f: TFile): Promise<{ e: Entry; text: string }> {
  const got = await entryFor(app, f);
  if (got.text !== undefined) return { e: got.e, text: got.text };
  const e = got.e;
  const kept = textsOf(app).get(f.path, e.hash);
  if (kept !== undefined) return { e, text: kept };
  const quick = SOURCES.get(app)?.textOf(f.path, e.hash);
  if (quick !== undefined) {
    count("datanotes.cache.text_source");
    keepText(app, f.path, e.hash, quick);
    return { e, text: quick };
  }
  count("datanotes.cache.text_reads");
  const again = await read(app, f);
  return again.e.hash === e.hash ? { e, text: again.text } : again;
}

/** The text the cache keeps for a path, whatever its stat now (no read); undefined when it keeps none. */
export function cachedText(app: App, path: string): string | undefined {
  return TEXTS.get(app)?.peek(path);
}

/** File content and its hash (both cached while unchanged). */
export async function readHashed(app: App, f: TFile): Promise<{ content: string; hash: string }> {
  const { e, text } = await withText(app, f);
  return { content: text, hash: e.hash };
}

/** A note's content hash (cached while unchanged): no text is needed when the cache knows it. */
export async function readHash(app: App, f: TFile): Promise<string> {
  return (await entryFor(app, f)).e.hash;
}

/**
 * Parsed frontmatter + body, cached per parser `key` (the parse options). Returns a fresh copy of
 * the entry list; values are shared and must be treated as immutable (the engine copies on write).
 */
export async function readParsed(
  app: App,
  f: TFile,
  key: string,
  parse: (content: string) => { ordered: OrderedFrontmatter; body: string },
): Promise<{ ordered: OrderedFrontmatter; body: string }> {
  const p = await parsedEntry(app, f, key, parse);
  return { ordered: p.ordered.map(([k, v]) => [k, v] as [string, unknown]), body: p.body };
}

async function parsedEntry(app: App, f: TFile, key: string, parse: (content: string) => Parsed): Promise<Parsed> {
  const got = await entryFor(app, f);
  let p = got.e.parsed?.get(key);
  if (p) return p;
  const { e, text } = got.text !== undefined ? { e: got.e, text: got.text } : await withText(app, f);
  e.parsed ??= new Map();
  e.parsed.set(key, (p = parse(text)));
  return p;
}

/** A note's raw parse (`readOrderedFromMarkdown(content)`), from its text the first time. */
async function rawEntry(app: App, f: TFile): Promise<{ e: Entry; text?: string }> {
  const got = await entryFor(app, f);
  if (got.e.raw) return got;
  const { e, text } = got.text !== undefined ? { e: got.e, text: got.text } : await withText(app, f);
  if (!e.raw) e.raw = parseOf(text);
  return { e, text };
}

function parseOf(text: string): Parse {
  const r = readOrderedFromMarkdown(text);
  return { ordered: r.ordered, bodyStart: text.length - r.body.length };
}

/** The front matter of a note as `readOrderedFromMarkdown(content, keep)` parses it: derived from one parse per version. */
async function frontmatterEntry(app: App, f: TFile, keep: ReadonlySet<string>): Promise<{ e: Entry; p: Parse; text?: string }> {
  const { e, text } = await rawEntry(app, f);
  return { e, p: derived(e, keep), ...(text !== undefined ? { text } : {}) };
}

/** A version of a note's text the cache holds ({@link cachedVersion}): read later as it was then. */
export interface CachedVersion {
  readonly path: string;
}

/**
 * The version of a note the cache holds for its stat now, without a read; undefined when it holds
 * none (or neither its parse nor its text). Its front matter can be read later as it is now
 * ({@link versionFrontmatter}), whatever changes meanwhile: a snapshot of many notes at the cost
 * of one lookup each.
 */
export function cachedVersion(app: App, f: TFile): CachedVersion | undefined {
  const e = CACHES.get(app)?.get(f.path);
  const stamp = stampOf(f);
  if (!e || !stamp || e.mtime !== stamp.mtime || e.size !== stamp.size) return undefined;
  if (e.raw) return { path: f.path, entry: e } as CachedVersion;
  const text = TEXTS.get(app)?.get(f.path, e.hash);
  return text === undefined ? undefined : ({ path: f.path, entry: e, text } as CachedVersion);
}

/** The front matter of a version ({@link cachedVersion}) as {@link readFrontmatter} reads it (a fresh copy of the entry list). */
export function versionFrontmatter(v: CachedVersion, keep: ReadonlySet<string>): OrderedFrontmatter {
  const { entry: e, text } = v as CachedVersion & { entry: Entry; text?: string };
  if (!e.raw) e.raw = parseOf(text!); // a version without its parse keeps its text
  return derived(e, keep).ordered.map(([k, v]) => [k, v] as [string, unknown]);
}

function derived(e: Entry, keep: ReadonlySet<string>): Parse {
  const raw = e.raw!; // parsed by the caller
  if (keep.size === 0) return raw;
  const key = [...keep].sort().join("\0");
  e.variants ??= new Map();
  let p = e.variants.get(key);
  if (!p) {
    // the keys of `keep` with a wikilink YAML read as a nested list are read back as the link
    const changed = raw.ordered.some(([k, v]) => keep.has(k) && coerceMisparsedYamlWikilinkToString(v) !== v);
    p = changed ? { ordered: raw.ordered.map(([k, v]) => [k, keep.has(k) ? coerceMisparsedYamlWikilinkToString(v) : v] as [string, unknown]), bodyStart: raw.bodyStart } : raw;
    e.variants.set(key, p);
  }
  return p;
}

/**
 * The front matter and body of a note, as `readOrderedFromMarkdown(content, keep)` gives them
 * (the keys in `keep` hold wikilinks): one parse per version of the text, whatever the keys.
 * Returns a fresh copy of the entry list; values are shared and must be treated as immutable.
 * The body needs the note's text: {@link readFrontmatterEntries} does without.
 */
export async function readFrontmatter(app: App, f: TFile, keep: ReadonlySet<string>): Promise<{ ordered: OrderedFrontmatter; body: string }> {
  const got = await frontmatterEntry(app, f, keep);
  let { p, text } = got;
  if (text === undefined) {
    const again = await withText(app, f);
    text = again.text;
    // the note changed under an unchanged stat: front matter and body both come from the new text
    if (again.e !== got.e) {
      if (!again.e.raw) again.e.raw = parseOf(text);
      p = derived(again.e, keep);
    }
  }
  return { ordered: p.ordered.map(([k, v]) => [k, v] as [string, unknown]), body: text.slice(p.bodyStart) };
}

/** {@link readFrontmatter} without the body: no text is needed while the cache holds the note's parse. */
export async function readFrontmatterEntries(app: App, f: TFile, keep: ReadonlySet<string>): Promise<OrderedFrontmatter> {
  return (await frontmatterEntry(app, f, keep)).p.ordered.map(([k, v]) => [k, v] as [string, unknown]);
}

/** A note's body (the Markdown after its front matter), as {@link readFrontmatter} gives it. */
export async function readBody(app: App, f: TFile): Promise<string> {
  const got = await rawEntry(app, f);
  if (got.text !== undefined) return got.text.slice(got.e.raw!.bodyStart);
  const again = await withText(app, f);
  // the note changed under an unchanged stat: the body starts where the new text's front matter ends
  if (!again.e.raw) again.e.raw = parseOf(again.text);
  return again.text.slice(again.e.raw.bodyStart);
}

/** One value of the front matter as {@link readFrontmatter} reads it, without copying the entry list (`pick` must not change it). */
export async function readFrontmatterValue<T>(app: App, f: TFile, keep: ReadonlySet<string>, pick: (ordered: OrderedFrontmatter) => T): Promise<T> {
  return pick((await frontmatterEntry(app, f, keep)).p.ordered);
}

/**
 * One value of the parsed frontmatter (as {@link readParsed} parses it, cached per `key`), without
 * copying the entry list: `pick` reads it and must not change it. For scans that need one key of
 * every note (the transaction log's `table` of each row).
 */
export async function readParsedValue<T>(
  app: App,
  f: TFile,
  key: string,
  parse: (content: string) => { ordered: OrderedFrontmatter; body: string },
  pick: (ordered: OrderedFrontmatter) => T,
): Promise<T> {
  return pick((await parsedEntry(app, f, key, parse)).ordered);
}

/**
 * Seed the cache with notes a host knows at start: kept under the stat the host has for each, so a
 * note changed since is read again. Files without a stat are not kept. A host that read the text
 * hands it (`content`; `hash` from {@link contentHash} and `frontmatter`, the result of
 * `readOrderedFromMarkdown(content)`, when it has them: they are not computed again). A host that
 * knows a note without its text (its index on disk) hands the hash and the parse: `parse`, the
 * entries and where the body starts.
 */
export function primeFiles(
  app: App,
  files: Iterable<{ file: TFile; content?: string; hash?: string; frontmatter?: Parsed; parse?: Parse }>,
): void {
  const cache = cacheOf(app);
  for (const { file, content, hash, frontmatter, parse } of files) {
    const stamp = stampOf(file);
    if (!stamp) continue;
    const h = hash ?? (content !== undefined ? contentHash(content) : undefined);
    if (h === undefined) continue; // nothing to tell this version by
    const raw = parse ?? (frontmatter && content !== undefined ? { ordered: frontmatter.ordered, bodyStart: content.length - frontmatter.body.length } : undefined);
    cache.set(file.path, { mtime: stamp.mtime, size: stamp.size, hash: h, ...(raw ? { raw } : {}) });
    if (content !== undefined) keepText(app, file.path, h, content);
    else textsOf(app).delete(file.path);
  }
}

/** Forget cached files (after a write, or a vault event); the vault index reads them again too. */
export function invalidateFiles(app: App, paths: Iterable<string>): void {
  bumpVaultGeneration(app);
  const list = [...paths];
  touchIndex(app, list);
  const cache = CACHES.get(app);
  if (!cache) return;
  const texts = TEXTS.get(app);
  for (const p of list) {
    cache.delete(p);
    texts?.delete(p);
  }
}
