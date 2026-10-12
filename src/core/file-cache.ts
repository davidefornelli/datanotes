/**
 * Per-app cache of row files: content, content hash and parsed frontmatter, reused while the
 * file's `stat` (mtime + size, kept in memory by Obsidian) is unchanged. Writes by the engine and
 * vault events invalidate paths explicitly, so a same-millisecond rewrite cannot be missed.
 * Files without `stat` are always read (never cached).
 */

import type { App, TFile } from "./host";
import type { OrderedFrontmatter } from "./types";

interface Parsed {
  ordered: OrderedFrontmatter;
  body: string;
}

interface Entry {
  mtime: number;
  size: number;
  content: string;
  hash?: string;
  /** Parse results by parser key (callers parse with different options). */
  parsed?: Map<string, Parsed>;
}

const CACHES = new WeakMap<object, Map<string, Entry>>();
/** Bumped on every invalidation: derived indexes (e.g. the link graph) rebuild when it moves. */
const GENERATIONS = new WeakMap<object, number>();

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
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

async function entryFor(app: App, f: TFile): Promise<Entry> {
  const cache = cacheOf(app);
  const stamp = stampOf(f);
  const hit = cache.get(f.path);
  if (hit && stamp && hit.mtime === stamp.mtime && hit.size === stamp.size) return hit;
  const content = await app.vault.read(f);
  const entry: Entry = { mtime: stamp?.mtime ?? -1, size: stamp?.size ?? -1, content };
  if (stamp) cache.set(f.path, entry);
  else cache.delete(f.path);
  return entry;
}

/** File content and its hash (both cached while unchanged). */
export async function readHashed(app: App, f: TFile): Promise<{ content: string; hash: string }> {
  const e = await entryFor(app, f);
  e.hash ??= contentHash(e.content);
  return { content: e.content, hash: e.hash };
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
  const e = await entryFor(app, f);
  e.parsed ??= new Map();
  let p = e.parsed.get(key);
  if (!p) e.parsed.set(key, (p = parse(e.content)));
  return { ordered: p.ordered.map(([k, v]) => [k, v] as [string, unknown]), body: p.body };
}

/** Forget cached files (after a write, or a vault event). */
export function invalidateFiles(app: App, paths: Iterable<string>): void {
  bumpVaultGeneration(app);
  const cache = CACHES.get(app);
  if (!cache) return;
  for (const p of paths) cache.delete(p);
}
