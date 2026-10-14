/**
 * The engine's store on a folder of the filesystem, as the service opens it: the host's own
 * adapter (`nodeStoreAdapter`: private modes, the paths it refuses) with what the store needs
 * beyond the files of a vault:
 *
 * - writes and appends that do not make their folder first: the engine makes each folder once
 *   (store.ts), and a write into a folder removed meanwhile makes it again;
 * - binary files (`readBinary`, `writeBinary`): the compressed parts of the transaction log's
 *   checkpoints;
 * - `sync`: the files an operation wrote made durable (fsync), once at its end, as the setting
 *   `storeSync` says. `operation` syncs each file the operation wrote (and, on POSIX systems,
 *   their folders, so a new file's name survives a power loss too); `off` leaves it to the
 *   operating system. Notes are never synced: like Obsidian, the engine writes them atomically
 *   (a temporary file renamed over the note).
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type { StoreAdapter } from "../core/host";
import { eachLimit } from "../core/database-move";
import { nodeStoreAdapter, resolveInVault } from "./node-app";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./private-files";

/** How the store's files are made durable (the setting `storeSync`). */
export type StoreSyncPolicy = "operation" | "off";

/** How many files one sync flushes at the same time. */
const SYNC_AT_ONCE = 8;

let tmpSeq = 0;

/** fsync one file or folder; one that went meanwhile, or a folder the system cannot open, is skipped. */
async function flush(abs: string, folder: boolean): Promise<void> {
  let h: fsp.FileHandle;
  try {
    h = await fsp.open(abs, folder ? "r" : "r+");
  } catch {
    return; // removed since it was written (a vacuum, a rename), or a folder this system does not open
  }
  try {
    // a folder whose file system refuses an fsync (some network shares) is left as it is
    if (folder) await h.sync().catch(() => undefined);
    else await h.datasync();
  } finally {
    await h.close();
  }
}

/** Whether an error says a folder on the way is missing. */
function missingFolder(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Rename on disk, retried for up to ~3 s while another program (an antivirus, a sync tool) holds
 * the file on Windows (EPERM, EBUSY, EACCES), as the host's own writes do.
 */
async function renameRetrying(from: string, to: string, attempt = 0): Promise<void> {
  try {
    await fsp.rename(from, to);
    /* v8 ignore start -- runs only on Windows, while a reader holds the file */
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (attempt >= 30 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw e;
    await new Promise((r) => setTimeout(r, 25 + attempt * 10));
    await renameRetrying(from, to, attempt + 1);
  }
  /* v8 ignore stop */
}

/**
 * The store's adapter on `dir`. `sync` gives the policy now (the setting can change while the
 * engine runs); without it, `operation`.
 */
export function nodeStoreFiles(dir: string, opts: { sync?: () => StoreSyncPolicy; platform?: string } = {}): StoreAdapter {
  const root = path.resolve(dir);
  const base = nodeStoreAdapter(root);
  const abs = (p: string) => resolveInVault(root, p);
  const platform = opts.platform ?? process.platform;
  /** Run a write; when its folder is missing (removed by hand), make the folder and run it again. */
  const inFolder = async <T>(file: string, write: () => Promise<T>): Promise<T> => {
    try {
      return await write();
    } catch (e) {
      if (!missingFolder(e)) throw e;
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
      return write();
    }
  };
  /** Atomic: a temporary file (ignored by the store backup) renamed over the file. */
  const atomic = async (p: string, data: string | Uint8Array): Promise<void> => {
    const target = abs(p);
    tmpSeq = (tmpSeq + 1) % Number.MAX_SAFE_INTEGER;
    const tmp = path.join(path.dirname(target), `.datanotes-${process.pid}-${Date.now()}-${tmpSeq}.tmp`);
    await inFolder(tmp, () => fsp.writeFile(tmp, data, typeof data === "string" ? { encoding: "utf8", mode: PRIVATE_FILE_MODE } : { mode: PRIVATE_FILE_MODE }));
    try {
      await renameRetrying(tmp, target);
      /* v8 ignore start -- the rename gives up only if another program holds the file for seconds */
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    /* v8 ignore stop */
  };
  return {
    exists: (p) => base.exists(p),
    read: (p) => base.read(p),
    write: (p, data) => atomic(p, data),
    async append(p, data) {
      const file = abs(p);
      await inFolder(file, () => fsp.appendFile(file, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE }));
    },
    list: (p) => base.list(p),
    mkdir: (p) => base.mkdir(p),
    remove: (p) => base.remove(p),
    rename: (a, b) => base.rename(a, b),
    rmdir: (p, recursive) => base.rmdir(p, recursive),
    stat: (p) => base.stat!(p),
    async readBinary(p) {
      const b = await fsp.readFile(abs(p));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    writeBinary: (p, data) => atomic(p, new Uint8Array(data)),
    async sync(paths) {
      if ((opts.sync?.() ?? "operation") === "off") return;
      const files = [...new Set(paths)];
      await eachLimit(files, SYNC_AT_ONCE, (p) => flush(abs(p), false));
      // a new file's name is in its folder: POSIX systems sync the folder too (Windows cannot open one)
      if (platform === "win32") return;
      const folders = [...new Set(files.map((p) => path.dirname(abs(p))))];
      await eachLimit(folders, SYNC_AT_ONCE, (f) => flush(f, true));
    },
  };
}
