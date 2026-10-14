/**
 * The names links are looked up by, as the vault resolves them (Obsidian's rules: a path relative
 * to the note's folder, a path from the root, then a file name): a file can only resolve a link
 * that looks up one of its names. The indexes that follow link resolution (the headless host's
 * links, the link graph) re-resolve only the links that look up the name of a file created,
 * deleted or renamed. The names are interned: every note that links to a file shares them.
 */

import { intern } from "./intern";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Normalize `a/./b/../c` and leading slashes. `null` when it climbs above the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * The lower-case names a file is looked up by: its file name, and without `.md`. A link whose
 * lookups ({@link linkLookupNames}) share none of them can never resolve to it.
 */
export function fileLookupNames(path: string): string[] {
  const name = basename(path).toLowerCase();
  const bare = name.replace(/\.md$/i, "");
  return bare === name ? [intern(name)] : [intern(name), intern(bare)];
}

/**
 * The lower-case last segments of the paths a link path is looked up by from `sourcePath` (from
 * the note's folder, from the root, by name): the file a link resolves to always has one of
 * {@link fileLookupNames} among them.
 */
export function linkLookupNames(linkpath: string, sourcePath: string): string[] {
  const out = new Set<string>();
  addLinkLookupNames(out, linkpath, sourcePath);
  return [...out].map(intern);
}

/**
 * {@link linkLookupNames} added to `out`, not interned: a caller that gathers the names of many
 * links interns once each name it keeps.
 */
export function addLinkLookupNames(out: Set<string>, linkpath: string, sourcePath: string): void {
  const raw = linkpath.trim();
  if (raw === "") return;
  const sourceDir = dirname(sourcePath);
  const add = (p: string | null) => {
    if (p) out.add(basename(p).toLowerCase());
  };
  add(normalizePath(raw));
  if (!raw.startsWith("/")) add(normalizePath(sourceDir ? `${sourceDir}/${raw}` : raw));
}
