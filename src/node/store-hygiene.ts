/**
 * Keeps desktop search indexers out of the engine's store, which holds thousands of small files
 * (the transaction log, the change feed) and the vault index: on Windows the store and what it
 * holds are marked "not content indexed" (`attrib +I`, no administrator rights needed; new files
 * and folders inherit the mark, so what it holds is marked once, recorded by {@link MARKED}), on
 * macOS an empty `.metadata_never_index` asks Spotlight to skip it. On macOS also `tmutil
 * addexclusion` of the vault index (`<store>/index/`) while it is on, once (recorded by {@link
 * TIME_MACHINE_MARKER}): Time Machine skips the cache, not the journal and the history. Best
 * effort, in the background: a failure changes nothing. The engine never changes security
 * settings: an antivirus exclusion needs administrator rights, and the docs explain it
 * (administration/limits.md, "Run a large database on Windows").
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makePrivateDir } from "./private-files";

/** The marker Spotlight honors (macOS). */
export const SPOTLIGHT_MARKER = ".metadata_never_index";

/** Windows: written once what the store held was marked; the store's new files inherit the mark. */
export const MARKED = ".not-content-indexed";

/** macOS: written in `<store>/index/` once Time Machine excludes that folder (`tmutil addexclusion`). */
export const TIME_MACHINE_MARKER = ".time-machine-excluded";

type Spawn = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: boolean },
) => { on(event: "error", cb: () => void): unknown; on(event: "exit", cb: (code: number | null) => void): unknown; unref(): void };

/** Mark a store so that search indexers skip it (see the module's comment). */
export function keepIndexersOut(store: string, o: { platform?: NodeJS.Platform; spawn?: Spawn; index?: boolean } = {}): void {
  const platform = o.platform ?? process.platform;
  try {
    if (platform === "win32") {
      const run = o.spawn ?? (spawn as unknown as Spawn);
      const marked = path.join(store, MARKED);
      // the store itself (what it gets later inherits the mark), then, once, what it holds now
      const all = fs.existsSync(marked) ? [] : [["+I", path.join(store, "*"), "/S", "/D"]];
      for (const args of [["+I", store], ...all]) {
        const child = run("attrib", args, { stdio: "ignore", windowsHide: true });
        child.on("error", () => undefined);
        if (args.length > 2) child.on("exit", (code) => code === 0 && writeMarker(marked));
        child.unref();
      }
    } else if (platform === "darwin") {
      const marker = path.join(store, SPOTLIGHT_MARKER);
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, "");
      // the vault index (index-db.ts: a cache the engine rebuilds, rewritten often) stays out of
      // Time Machine; the journal and the history stay in the backups. Once: tmutil's exclusion
      // sticks to the folder.
      const index = path.join(store, "index");
      const excluded = path.join(index, TIME_MACHINE_MARKER);
      // index: false (the setting vaultIndexEnabled off): no index folder to exclude
      if (o.index !== false && !fs.existsSync(excluded)) {
        makePrivateDir(index);
        const run = o.spawn ?? (spawn as unknown as Spawn);
        const child = run("tmutil", ["addexclusion", index], { stdio: "ignore", windowsHide: true });
        child.on("error", () => undefined);
        child.on("exit", (code) => code === 0 && writeMarker(excluded));
        child.unref();
      }
    }
  } catch {
    // best effort: an indexer reading the store slows it down, nothing more
  }
}

function writeMarker(file: string): void {
  try {
    fs.writeFileSync(file, "");
  } catch {
    // marked again at the next start
  }
}
