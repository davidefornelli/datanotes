/**
 * Notes that are rows but whose front matter cannot be read (YAML broken by a hand edit, a merge
 * conflict, a sync tool): the vault's index has no properties for them, so every read of a table
 * leaves them out. They are found here instead, and reported as `unreadable`: by check_table, by the
 * change feed (an `unreadable` event) and by describe_database (`unreadable` of each table).
 *
 * The table of such a note is read from the `table:` line of its front matter alone (the rest of
 * the YAML cannot be parsed); a note without one that names a table is no row and is skipped, as
 * are the notes in a table's archive or `exclude` folders.
 */

import { readHashed } from "./file-cache";
import type { App, TFile } from "./host";
import { parse } from "yaml";
import { readOrderedFromMarkdown, splitFrontmatter } from "./frontmatter";
import { catalogTables, entryToOrdered, rowTableFull, type Metastore } from "./metastore";
import { catalogLayout, parseTableOptions } from "./table-loader";
import { TABLE_KEY } from "./types-table";
import type { DatanotesSettings } from "./settings";
import { messageOf } from "./message";
import { normalizeDatabaseFolder } from "./db-paths";
import { vaultIndex } from "./vault-index";

/** A row whose front matter cannot be read. */
export interface UnreadableNote {
  path: string;
  /** The qualified table its `table:` line names. */
  table: string;
  /** Why the front matter cannot be read (the YAML parser's message). */
  error: string;
}

/** Why a note's front matter cannot be read; null when it can (or the note has none). */
export function frontmatterError(text: string): string | null {
  try {
    readOrderedFromMarkdown(text);
    return null;
  } catch (e) {
    return messageOf(e);
  }
}

/**
 * The value of the top-level `key:` line of a front matter block that cannot be parsed as a whole
 * (undefined when there is no such line).
 */
export function rawFrontmatterValue(text: string, key: string): unknown {
  const split = splitFrontmatter(text);
  if (!split) return undefined;
  for (const line of split.yamlText.split(/\r?\n/)) {
    const head = [`${key}:`, `"${key}":`, `'${key}':`].find((h) => line.startsWith(h));
    if (!head) continue;
    const rest = line.slice(head.length).trim();
    try {
      return parse(rest) as unknown;
    } catch {
      return rest;
    }
  }
  return undefined;
}

/** The message of an `unreadable` violation. */
export function unreadableMessage(error: string): string {
  return `the front matter cannot be read, so the row is left out of every read: ${error.split("\n")[0]!.trim()}`;
}

/** The archive and `exclude` folders of each table: a note there is not a row. */
function excludedFolders(model: Metastore, settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { ref, entry } of catalogTables(model)) {
    try {
      const options = parseTableOptions(entryToOrdered(ref, entry, settings).find(([k]) => k === TABLE_KEY)?.[1]);
      out.set(ref.full, [...(options.exclude ?? []), catalogLayout(normalizeDatabaseFolder(settings.databaseFolder), ref, options).archive]);
    } catch {
      // a table whose definition cannot be read: no folders left out (check_table reports the table)
    }
  }
  return out;
}

/**
 * The table a note belongs to although its front matter cannot be read, with the reason; null when
 * the note is readable, names no table of the metastore, or lies in the table's archive or
 * `exclude` folders.
 */
export function unreadableRowOf(
  model: Metastore,
  settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">,
  path: string,
  text: string,
  excluded?: ReadonlyMap<string, string[]>,
): UnreadableNote | null {
  if (!text.startsWith("---")) return null;
  const error = frontmatterError(text);
  if (error === null) return null;
  const table = rowTableFull(model, rawFrontmatterValue(text, settings.tableKey));
  if (!table) return null;
  const folders = (excluded ?? excludedFolders(model, settings)).get(table) ?? [];
  if (folders.some((dir) => path.startsWith(`${dir}/`))) return null;
  return { path, table, error };
}

/**
 * The rows of every table (or of `table`, qualified) whose front matter cannot be read, by path.
 * Only the notes the vault's index has no properties for are read (from the file cache).
 */
export async function unreadableRows(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">,
  model: Metastore,
  table?: string,
): Promise<UnreadableNote[]> {
  const excluded = excludedFolders(model, settings);
  const out: UnreadableNote[] = [];
  // with a vault index, only the notes the host has no front matter for (vault-index.ts)
  const idx = vaultIndex(app, settings);
  const notes = idx ? [...idx.allNotes()].filter((n) => n.bare).map((n) => n.file) : app.vault.getMarkdownFiles();
  for (const f of notes) {
    let cached: unknown;
    try {
      cached = idx ? undefined : app.metadataCache.getFileCache(f)?.frontmatter;
    } catch {
      cached = undefined; // a host whose index throws on broken YAML: read below
    }
    if (cached) continue;
    let text: string;
    try {
      text = (await readHashed(app, f as TFile)).content;
    } catch {
      continue; // a file that cannot be read now (held by another program): not a front matter problem
    }
    const u = unreadableRowOf(model, settings, f.path, text, excluded);
    if (u && (table === undefined || u.table === table)) out.push(u);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
