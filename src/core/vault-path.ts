/**
 * Vault-relative paths given by clients: a path must name something inside the vault. A segment
 * `..`, a backslash (a Windows separator), a drive letter or a NUL could make a host resolve it to
 * a file outside the vault, so such paths are refused before any host sees them.
 *
 * And the paths a new file may not take: one spelled like an existing file but for case is the
 * same file on Windows and macOS, and two files that collide once synced to them on Linux.
 */

import type { App, TAbstractFile } from "./host";

/** Why `p` is not a safe vault-relative path, or null when it is. */
export function unsafeVaultPath(p: string): string | null {
  if (typeof p !== "string" || p.trim() === "") return "empty path";
  if (p.includes("\0")) return "NUL in path";
  if (p.includes("\\")) return "backslash in path (use /)";
  if (/^[A-Za-z]:/.test(p) || p.startsWith("//")) return "absolute path";
  if (p.split("/").some((s) => s === "..")) return '".." in path';
  return null;
}

function childrenOf(f: TAbstractFile | null | undefined): TAbstractFile[] | null {
  return f && "children" in f && Array.isArray(f.children) ? f.children : null;
}

function nameOf(f: TAbstractFile): string {
  return f.name ?? f.path.slice(f.path.lastIndexOf("/") + 1);
}

/**
 * The vault path of the file or folder that `p` names, ignoring case (the path as the vault spells
 * it), or null when there is none: `Films/metropolis.md` finds `Films/Metropolis.md`, and also
 * `films/Metropolis.md`. The folders' children are followed when the host lists them (Obsidian and
 * the headless host do); otherwise every file is compared.
 */
export function existingPathIgnoringCase(app: App, p: string): string | null {
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.length === 0) return null;
  const exact = app.vault.getAbstractFileByPath(p);
  if (exact != null) return exact.path;
  let folder: TAbstractFile | null = app.vault.getRoot?.() ?? app.vault.getAbstractFileByPath("") ?? app.vault.getAbstractFileByPath("/");
  let at = "";
  for (const part of parts) {
    const children = childrenOf(folder);
    if (!children) return scanIgnoringCase(app, p);
    const lower = part.toLowerCase();
    const hit: TAbstractFile | undefined = children.find((c) => nameOf(c).toLowerCase() === lower);
    if (!hit) return null;
    at = hit.path.replace(/^\/+/, "");
    folder = app.vault.getAbstractFileByPath(at) ?? hit;
  }
  return at;
}

/** {@link existingPathIgnoringCase} on a host without folder listings: every file compared. */
function scanIgnoringCase(app: App, p: string): string | null {
  const lower = p.toLowerCase();
  for (const f of app.vault.getFiles()) {
    if (f.path.toLowerCase() === lower) return f.path;
    // a folder on the way, spelled in another case
    if (f.path.toLowerCase().startsWith(`${lower}/`)) return f.path.slice(0, p.length);
  }
  return null;
}
