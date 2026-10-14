/**
 * Changes made on disk by other programs reach the engine through the host's index (vault events),
 * a little later: a quiet time after the operating system reports them, or the next poll. An
 * operation run in that gap would read the old content, and the transaction log would record the
 * hand edit after the operation instead of before it. A host that can catch up on demand registers
 * a settler (the Node service: its watcher); every request of the HTTP API waits for it first.
 */

import type { App } from "./host";

/**
 * A host's catch-up. `since`: when the request that asks arrived (`performance.now()`); a host that
 * compared the whole disk after that moment has nothing more to catch up for it.
 */
export type VaultSettler = (since?: number) => void | Promise<void>;

const SETTLERS = new WeakMap<object, VaultSettler>();

/** Register (or with null remove) the host's way to apply the changes it knows of but has not indexed yet. */
export function setVaultSettler(app: App, fn: VaultSettler | null): void {
  if (fn) SETTLERS.set(app, fn);
  else SETTLERS.delete(app);
}

/** Bring the host's index up to date with the disk, when the host can (for a request arrived at `since`). */
export async function settleVault(app: App, since?: number): Promise<void> {
  await SETTLERS.get(app)?.(since);
}

type BulkWriter = <T>(work: () => Promise<T>) => Promise<T>;
const BULK = new WeakMap<object, BulkWriter>();
const IN_BULK = new WeakMap<object, number>();

/**
 * Register (or with null remove) the host's way to run many writes at once: the Node service stops
 * watching the disk meanwhile (a recursive file watcher on Windows makes every write several times
 * slower) and compares the vault with its index after.
 */
export function setBulkWriter(app: App, fn: BulkWriter | null): void {
  if (fn) BULK.set(app, fn);
  else BULK.delete(app);
}

/** Run `work`, which writes many notes, as the host runs bulk writes (nested calls run as one). */
export async function bulkWrite<T>(app: App, work: () => Promise<T>): Promise<T> {
  const host = BULK.get(app);
  if (!host || (IN_BULK.get(app) ?? 0) > 0) return work();
  IN_BULK.set(app, 1);
  try {
    return await host(work);
  } finally {
    IN_BULK.delete(app);
  }
}
