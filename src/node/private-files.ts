/**
 * The engine's private files. The data home and each store hold the owner token (`settings.json`),
 * the webhooks' secrets (`webhooks.json`), named tokens' hashes and the journal: on POSIX systems
 * their folders are created 0700 and their files 0600, so other users of the machine read none of
 * them. A start tightens what an older version created with the default modes (0755, 0644).
 * Windows has no such modes: a user's data folder is private to that user already.
 */

import fs from "node:fs";
import path from "node:path";

/** The mode of the data home, a store and the folders inside it. */
export const PRIVATE_DIR_MODE = 0o700;
/** The mode of the files of a store and of the settings file. */
export const PRIVATE_FILE_MODE = 0o600;

/** Whether this platform has POSIX file modes (all but Windows). */
export function posixModes(platform: string = process.platform): boolean {
  return platform !== "win32";
}

/**
 * Create a private folder (0700). Only the folder itself is private: missing parents are created
 * with the default mode, since they may be shared folders such as `~/.local/share`.
 */
export function makePrivateDir(dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Tighten existing folders to 0700 and files to 0600 (POSIX only). A path that does not exist is
 * left alone; one this user may not change (another user's file) is returned, for a warning.
 */
export function tightenPrivate(paths: string[], platform: string = process.platform): string[] {
  if (!posixModes(platform)) return [];
  const failed: string[] = [];
  for (const p of paths) {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    const mode = st.isDirectory() ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE;
    if ((st.mode & 0o777) === mode) continue;
    try {
      fs.chmodSync(p, mode);
      /* v8 ignore start -- only a path owned by another user refuses the change */
    } catch {
      failed.push(p);
    }
    /* v8 ignore stop */
  }
  return failed;
}
