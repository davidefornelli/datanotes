/**
 * The engine's store: its own files, outside the vault's notes. The headless host keeps it in the
 * operating system's per-user data folder (`<data home>/<database id>/`, see src/api/local.ts);
 * a host without a store of its own (`App.store`) keeps it in the vault's `.datanotes/` folder.
 *
 * The engine names store files with the `store:` prefix, so they never mix with vault paths:
 *
 *   store:journal/2026-10.jsonl            one operation per line (undo data)
 *   store:blobs/<hash>.txt                 large texts of journal entries, stored once
 *   store:transaction_log/<table>/…        transaction log (history), see transaction-log.ts
 *   store:logs/2026-10-01.service.jsonl    log records
 *   store:changes/2026-10-01.jsonl         the change feed
 *
 * Durability: the files the engine writes are remembered until {@link storeFlush}, which hands
 * them to the host's `sync` (an fsync of each) at the end of every hold of the write lock and
 * after each append to the change feed. The log records (`logs/`) are not synced.
 */

import type { App, VaultAdapter } from "./host";

/** The prefix of store paths. */
export const STORE_PREFIX = "store:";

/** Where a host without a store of its own keeps it: the vault's dot-folder. */
export const VAULT_STORE_FOLDER = ".datanotes";

/** A store path: `storePath("journal", "2026-10.jsonl")` is `store:journal/2026-10.jsonl`. */
export function storePath(...parts: string[]): string {
  return `${STORE_PREFIX}${parts.join("/")}`;
}

/** Whether a path names a store file: `store:…`. */
export function isStorePath(path: string): boolean {
  return path.startsWith(STORE_PREFIX);
}

/** The path inside the store: `store:journal/x` is `journal/x`. */
export function storeKey(path: string): string {
  return (path.startsWith(STORE_PREFIX) ? path.slice(STORE_PREFIX.length) : path).replace(/^\/+|\/+$/g, "");
}

const GENERATIONS = new WeakMap<object, Map<string, number>>();

/**
 * How many times the engine changed anything in a store folder (or file): a write, an append, a
 * removal or a rename below it. What is computed from a folder's files (a table's replayed log)
 * stays valid while its number does not move. Counted per app, from its start.
 */
export function storeGeneration(app: App, path = ""): number {
  return GENERATIONS.get(app)?.get(storeKey(path)) ?? 0;
}

/** What this engine knows of the store's files without asking the host, by app. */
interface Known {
  /** Folders that exist (made or seen by this engine): no probe before a write into them. */
  folders: Set<string>;
  /** Files this engine wrote or appended to: an append needs no probe first. */
  files: Set<string>;
  /** Files written since the last {@link storeFlush}, as the adapter names them. */
  unsynced: Set<string>;
}

const KNOWN = new WeakMap<object, Known>();

function knownOf(app: App): Known {
  let k = KNOWN.get(app);
  if (!k) KNOWN.set(app, (k = { folders: new Set(), files: new Set(), unsynced: new Set() }));
  return k;
}

/** Listeners of the store's changes, by app (the store backup stages only what changed). */
const LISTENERS = new WeakMap<object, Set<(path: string) => void>>();

/** Be told of every store file the engine writes, appends to, removes or renames (store paths). Returns the unsubscribe. */
export function onStoreChange(app: App, fn: (path: string) => void): () => void {
  let set = LISTENERS.get(app);
  if (!set) LISTENERS.set(app, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

/** A change to the store file `path`: it and every folder above it move on. */
function changed(app: App, path: string): void {
  let gens = GENERATIONS.get(app);
  if (!gens) GENERATIONS.set(app, (gens = new Map()));
  const parts = storeKey(path).split("/");
  for (let i = 0; i <= parts.length; i++) {
    const key = parts.slice(0, i).join("/");
    gens.set(key, (gens.get(key) ?? 0) + 1);
  }
  for (const fn of LISTENERS.get(app) ?? []) fn(storePath(storeKey(path)));
}

/** The adapter holding the store, and a store path as that adapter names it. */
function located(app: App, path: string): { adapter: VaultAdapter; rel: string; back: (p: string) => string } {
  const key = storeKey(path);
  if (app.store) return { adapter: app.store, rel: key, back: (p) => storePath(p.replace(/\\/g, "/")) };
  const rel = key === "" ? VAULT_STORE_FOLDER : `${VAULT_STORE_FOLDER}/${key}`;
  return { adapter: app.vault.adapter, rel, back: (p) => storePath(p.replace(/\\/g, "/").slice(VAULT_STORE_FOLDER.length + 1)) };
}

function parent(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The folder made if missing; one this engine made or saw before is not probed again. */
async function mkdirp(app: App, adapter: VaultAdapter, dir: string): Promise<void> {
  const known = knownOf(app).folders;
  if (dir === "" || known.has(dir)) return;
  if (!(await adapter.exists(dir))) {
    await mkdirp(app, adapter, parent(dir));
    await adapter.mkdir(dir);
  }
  known.add(dir);
}

/** A write that failed because a folder this engine knew went away (removed by hand): made again, once. */
async function inFolder<T>(app: App, adapter: VaultAdapter, rel: string, write: () => Promise<T>): Promise<T> {
  await mkdirp(app, adapter, parent(rel));
  try {
    return await write();
  } catch (e) {
    const known = knownOf(app).folders;
    const dir = parent(rel);
    if (dir === "" || (await adapter.exists(dir))) throw e;
    for (const f of [...known]) if (f === dir || f.startsWith(`${dir}/`) || dir.startsWith(`${f}/`)) known.delete(f);
    await mkdirp(app, adapter, dir);
    return write();
  }
}

/** A file written: remembered for the next {@link storeFlush} (log records are not synced). */
function written(app: App, rel: string, key: string): void {
  const k = knownOf(app);
  k.files.add(rel);
  if (!key.startsWith("logs/")) k.unsynced.add(rel);
}

/**
 * A file this engine did not write but is about to rely on (it removes the other copy of what the
 * file holds): synced at the next {@link storeFlush}, since a run a kill cut short may have left
 * it written whole but not synced.
 */
export function storeSyncNext(app: App, path: string): void {
  knownOf(app).unsynced.add(located(app, path).rel);
}

export async function storeExists(app: App, path: string): Promise<boolean> {
  const { adapter, rel } = located(app, path);
  return adapter.exists(rel);
}

/**
 * Size and modification time of a store file: null when it does not exist, undefined when the
 * host cannot tell (its adapter has no `stat`).
 */
export async function storeStat(app: App, path: string): Promise<{ size: number; mtime: number } | null | undefined> {
  const { adapter, rel } = located(app, path);
  if (!adapter.stat) return undefined;
  const s = await adapter.stat(rel);
  return s ? { size: s.size, mtime: s.mtime } : null;
}

export async function storeRead(app: App, path: string): Promise<string | null> {
  const { adapter, rel } = located(app, path);
  return (await adapter.exists(rel)) ? adapter.read(rel) : null;
}

/** A store file's text; throws when it does not exist (for files just listed). */
export async function storeReadFile(app: App, path: string): Promise<string> {
  const { adapter, rel } = located(app, path);
  return adapter.read(rel);
}

export async function storeWrite(app: App, path: string, text: string): Promise<void> {
  const { adapter, rel } = located(app, path);
  try {
    await inFolder(app, adapter, rel, () => adapter.write(rel, text));
    written(app, rel, storeKey(path));
  } finally {
    changed(app, path);
  }
}

/** Whether the store can hold binary files (the host's adapter reads and writes them). */
export function storeHoldsBinary(app: App): boolean {
  const { adapter } = located(app, "");
  return typeof adapter.writeBinary === "function" && typeof adapter.readBinary === "function";
}

/** Write a binary file (only where {@link storeHoldsBinary}). */
export async function storeWriteBinary(app: App, path: string, data: ArrayBuffer): Promise<void> {
  const { adapter, rel } = located(app, path);
  /* v8 ignore next -- defensive: callers ask storeHoldsBinary first */
  if (!adapter.writeBinary) throw new Error(`the store cannot hold binary files: ${path}`);
  const write = adapter.writeBinary.bind(adapter);
  try {
    await inFolder(app, adapter, rel, () => write(rel, data));
    written(app, rel, storeKey(path));
  } finally {
    changed(app, path);
  }
}

/** A binary file's bytes; null when it does not exist (or the store holds no binary files). */
export async function storeReadBinary(app: App, path: string): Promise<ArrayBuffer | null> {
  const { adapter, rel } = located(app, path);
  if (!adapter.readBinary || !(await adapter.exists(rel))) return null;
  return adapter.readBinary(rel);
}

export async function storeAppend(app: App, path: string, text: string): Promise<void> {
  const { adapter, rel } = located(app, path);
  const k = knownOf(app);
  try {
    // a file this engine wrote is still there (else: probed, as one it never saw)
    if (k.files.has(rel)) {
      try {
        await adapter.append(rel, text);
        written(app, rel, storeKey(path));
        return;
      } catch (e) {
        k.files.delete(rel);
        if (await adapter.exists(rel)) throw e;
      }
    }
    await inFolder(app, adapter, rel, async () => {
      if (await adapter.exists(rel)) await adapter.append(rel, text);
      else await adapter.write(rel, text);
    });
    written(app, rel, storeKey(path));
  } finally {
    changed(app, path);
  }
}

/** Direct children of a store folder, as store paths (empty when it does not exist). */
export async function storeList(app: App, dir: string): Promise<{ files: string[]; folders: string[] }> {
  const { adapter, rel, back } = located(app, dir);
  if (!(await adapter.exists(rel))) return { files: [], folders: [] };
  const r = await adapter.list(rel);
  return { files: r.files.map(back).sort(), folders: r.folders.map(back).sort() };
}

export async function storeRemove(app: App, path: string): Promise<void> {
  const { adapter, rel } = located(app, path);
  if (await adapter.exists(rel)) {
    const k = knownOf(app);
    k.files.delete(rel);
    k.unsynced.delete(rel);
    try {
      await adapter.remove(rel);
    } finally {
      changed(app, path);
    }
  }
}

export async function storeRename(app: App, from: string, to: string): Promise<void> {
  const a = located(app, from);
  const b = located(app, to);
  if (!(await a.adapter.exists(a.rel))) throw new Error(`file not found: ${from}`);
  if (await b.adapter.exists(b.rel)) throw new Error(`target exists: ${to}`);
  const k = knownOf(app);
  k.files.delete(a.rel);
  k.unsynced.delete(a.rel);
  try {
    await inFolder(app, b.adapter, b.rel, () => b.adapter.rename(a.rel, b.rel));
    written(app, b.rel, storeKey(to));
  } finally {
    changed(app, from);
    changed(app, to);
  }
}

/**
 * Make the files written since the last call durable: the host's `sync` (an fsync of each, as its
 * settings say), nothing on a host without one. A failure is reported to the caller; the files
 * stay to sync next time.
 */
export async function storeFlush(app: App): Promise<void> {
  const k = KNOWN.get(app);
  if (!k || k.unsynced.size === 0) return;
  const { adapter } = located(app, "");
  const paths = [...k.unsynced];
  k.unsynced.clear();
  if (!adapter.sync) return;
  try {
    await adapter.sync(paths);
  } catch (e) {
    for (const p of paths) k.unsynced.add(p);
    throw e;
  }
}
