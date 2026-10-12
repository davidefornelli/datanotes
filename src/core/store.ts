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

async function mkdirp(adapter: VaultAdapter, dir: string): Promise<void> {
  if (dir === "" || (await adapter.exists(dir))) return;
  await mkdirp(adapter, parent(dir));
  await adapter.mkdir(dir);
}

export async function storeExists(app: App, path: string): Promise<boolean> {
  const { adapter, rel } = located(app, path);
  return adapter.exists(rel);
}

export async function storeRead(app: App, path: string): Promise<string | null> {
  const { adapter, rel } = located(app, path);
  return (await adapter.exists(rel)) ? adapter.read(rel) : null;
}

export async function storeWrite(app: App, path: string, text: string): Promise<void> {
  const { adapter, rel } = located(app, path);
  await mkdirp(adapter, parent(rel));
  await adapter.write(rel, text);
}

export async function storeAppend(app: App, path: string, text: string): Promise<void> {
  const { adapter, rel } = located(app, path);
  await mkdirp(adapter, parent(rel));
  if (await adapter.exists(rel)) await adapter.append(rel, text);
  else await adapter.write(rel, text);
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
  if (await adapter.exists(rel)) await adapter.remove(rel);
}

export async function storeRename(app: App, from: string, to: string): Promise<void> {
  const a = located(app, from);
  const b = located(app, to);
  if (!(await a.adapter.exists(a.rel))) throw new Error(`file not found: ${from}`);
  if (await b.adapter.exists(b.rel)) throw new Error(`target exists: ${to}`);
  await mkdirp(b.adapter, parent(b.rel));
  await a.adapter.rename(a.rel, b.rel);
}
