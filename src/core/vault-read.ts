/**
 * Reading the vault as files: a note with its front matter (`read_note`), a folder's children
 * (`list_folder`) and plain-text search (`search_notes`). Every path is vault-relative, with
 * forward slashes; dot-files and dot-folders are left out of listings and searches.
 */

import type { App, TFile } from "./host";
import type { DatanotesSettings } from "./settings";
import { readHashed } from "./file-cache";
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

/** The most notes a search returns. */
const MAX_RESULTS = 200;

/**
 * Plain-text search (`search_notes`): every word of the query must occur (case- and
 * accent-insensitive) in the note's path or text. One entry per note, whose matches are the
 * passages where the words occur: words next to each other ("Cary Grant" for `cary grant`) make one
 * match, not one per word. The score counts the words found in the text (at most 20), plus 5 for
 * each word in the path.
 */
export async function searchNotes(app: App, query: string, contextLength = 100): Promise<NoteSearchResults> {
  const words = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
  if (words.length === 0) return { query, results: [], total: 0 };
  const ctx = Number.isFinite(contextLength) && contextLength >= 0 ? Math.min(Math.floor(contextLength), 1000) : 100;
  const out: NoteSearchResults["results"] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.split("/").some((part) => part.startsWith("."))) continue;
    const { content } = await readHashed(app, f);
    const text = fold(content);
    const name = fold(f.path);
    if (!words.every((w) => text.includes(w) || name.includes(w))) continue;
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
    const matches = merged.slice(0, 20).map((m) => ({ start: m.start, end: m.end, context: content.slice(Math.max(0, m.start - ctx), m.end + ctx) }));
    const nameHits = words.filter((w) => name.includes(w)).length;
    out.push({ path: f.path, score: Math.min(spans.length, 20) + nameHits * 5, matches });
  }
  out.sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
  return { query, results: out.slice(0, MAX_RESULTS), total: out.length };
}
