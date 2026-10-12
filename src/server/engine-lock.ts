/**
 * One writer per database. The process running the engine records itself in `engine.lock` in its
 * store and refreshes a heartbeat: another engine on the same database sees it, and
 * `datanotes/local` reads it to find the running engine.
 */

import type { VaultAdapter } from "../core/host";

export const LOCK_PATH_SUFFIX = "engine.lock";
/** A lock older than this is stale (its owner stopped without removing it). */
export const LOCK_STALE_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 10_000;

export interface EngineLock {
  kind: "service";
  pid: number;
  host: string;
  /** Port of its HTTP server. */
  port: number;
  startedAt: string;
  heartbeat: string;
}

/** The lock in a folder of the adapter (`""`: its root, the store itself). */
export function lockPath(storeFolder: string): string {
  const dir = storeFolder.replace(/\/+$/, "");
  return dir === "" ? LOCK_PATH_SUFFIX : `${dir}/${LOCK_PATH_SUFFIX}`;
}

export async function readLock(adapter: VaultAdapter, storeFolder: string): Promise<EngineLock | null> {
  try {
    if (!(await adapter.exists(lockPath(storeFolder)))) return null;
    return JSON.parse(await adapter.read(lockPath(storeFolder))) as EngineLock;
  } catch {
    return null;
  }
}

export function isFresh(lock: EngineLock | null, now = Date.now()): lock is EngineLock {
  return !!lock && now - Date.parse(lock.heartbeat) < LOCK_STALE_MS;
}

/** Hold the lock: write it now and refresh the heartbeat until `release`. */
export class LockHolder {
  private timer: ReturnType<typeof setInterval> | null = null;
  private info: EngineLock;
  /** The writes, one after the other: `release` waits for the last one, so no heartbeat writes the lock again after it. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly storeFolder: string,
    info: Omit<EngineLock, "startedAt" | "heartbeat">,
  ) {
    const now = new Date().toISOString();
    this.info = { ...info, startedAt: now, heartbeat: now };
  }

  async acquire(): Promise<void> {
    await this.write();
    this.timer = setInterval(() => void this.write(), LOCK_HEARTBEAT_MS);
  }

  /** Record the port the HTTP server listens on (known once it started: the setting may be 0, any free port). */
  async setPort(port: number): Promise<void> {
    this.info.port = port;
    await this.write();
  }

  private write(): Promise<void> {
    this.writes = this.writes.then(async () => {
      this.info.heartbeat = new Date().toISOString();
      try {
        await this.adapter.mkdir(this.storeFolder);
        await this.adapter.write(lockPath(this.storeFolder), JSON.stringify(this.info));
      } catch {
        // the next heartbeat retries
      }
    });
    return this.writes;
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // a heartbeat under way ends first: it would write the lock again after its removal
    await this.writes;
    try {
      const current = await readLock(this.adapter, this.storeFolder);
      if (current && current.pid === this.info.pid && current.startedAt === this.info.startedAt) await this.adapter.remove(lockPath(this.storeFolder));
    } catch {
      // already gone
    }
  }
}
