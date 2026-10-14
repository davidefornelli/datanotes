/**
 * The vault index's consistency check: what the indexes answer, against a walk over every note
 * done from scratch. The tests run it after their scenarios; with DATANOTES_INDEX_CHECK=1 the
 * service runs it after every operation and reports a difference as an error (then reads the
 * vault again, so the next operations are right).
 */

import type { App } from "./host";
import { cachedMetastore, rowTableFull } from "./metastore";
import { telemetry } from "./telemetry";
import { verifyNameIndex } from "./autolink";
import { bumpVaultGeneration } from "./file-cache";
import { verifyGraph } from "./graph";
import type { DatanotesSettings } from "./settings";
import { verifySortedRows } from "./row-files";
import { verifyVocabularies } from "./table-registry";
import { forgetCurrentStates, verifyCurrentStates } from "./transaction-log";
import { verifyUniqueValues } from "./unique-index";
import { vaultIndex, type IndexSettings } from "./vault-index";

/** The host's own check of what it keeps up to date (the headless host's links), when it has one. */
interface SelfChecking {
  verifyLinks?(): string[];
  /** Resolve every link again from scratch (after verifyLinks found a difference). */
  relinkAll?(): void;
}

/** A short account of how two lists of paths differ: the paths one has and the other lacks, else the order. */
function listDiff(have: readonly string[], want: readonly string[]): string {
  const h = new Set(have);
  const w = new Set(want);
  const extra = have.filter((p) => !w.has(p)).slice(0, 20);
  const missing = want.filter((p) => !h.has(p)).slice(0, 20);
  return `extra ${JSON.stringify(extra)}, missing ${JSON.stringify(missing)}, order ${JSON.stringify(have.slice(0, 20))} instead of ${JSON.stringify(want.slice(0, 20))}`;
}

/**
 * How the indexes differ from the vault as a walk over every note reads it now: the notes and
 * their order, each note's front matter and table, the rows of every table, and what the host
 * keeps up to date itself. Empty when they agree.
 */
export async function verifyIndex(app: App, settings: IndexSettings): Promise<string[]> {
  const out = indexDiffs(app, settings);
  // the transaction log's current states, kept between syncs
  out.push(...(await verifyCurrentStates(app, settings)));
  // the unique values kept per table, the link graph
  out.push(...(await verifyUniqueValues(app, settings as DatanotesSettings)));
  out.push(...(await verifyGraph(app, settings as DatanotesSettings)));
  return out;
}

/** The part of {@link verifyIndex} that reads nothing (the vault index and the indexes built on it). */
function indexDiffs(app: App, settings: IndexSettings): string[] {
  const out: string[] = [];
  const idx = vaultIndex(app, settings);
  if (idx) {
    const files = app.vault.getMarkdownFiles();
    const have = [...idx.allNotes()].sort((a, b) => a.order - b.order).map((n) => n.path);
    const want = files.map((f) => f.path);
    if (have.join("\n") !== want.join("\n")) out.push(`notes: ${listDiff(have, want)}`);
    const model = cachedMetastore(app, settings);
    const rows = new Map<string, string[]>();
    for (const f of files) {
      let fm: unknown;
      try {
        fm = app.metadataCache.getFileCache(f)?.frontmatter;
      } catch {
        fm = undefined;
      }
      const n = idx.note(f.path);
      if (n && JSON.stringify(n.frontmatter ?? null) !== JSON.stringify(fm && typeof fm === "object" ? fm : null)) out.push(`${f.path}: front matter differs from the host's`);
      const v = (fm as Record<string, unknown> | undefined)?.[settings.tableKey];
      const table = v === undefined || v === null || !model ? null : rowTableFull(model, v);
      if (n && n.table !== table) out.push(`${f.path}: a row of ${JSON.stringify(n.table)} instead of ${JSON.stringify(table)}`);
      if (table === null) continue;
      const list = rows.get(table);
      if (list) list.push(f.path);
      else rows.set(table, [f.path]);
    }
    for (const table of new Set([...rows.keys(), ...idx.tables()])) {
      const a = idx.rowsOf(table).map((f) => f.path);
      const b = rows.get(table) ?? [];
      if (a.join("\n") !== b.join("\n")) out.push(`rows of ${table}: ${listDiff(a, b)}`);
    }
  }
  // the indexes built on the vault index
  out.push(...verifySortedRows(app, settings));
  out.push(...verifyVocabularies(app, settings));
  out.push(...verifyNameIndex(app, settings as DatanotesSettings));
  const host = app.metadataCache as unknown as SelfChecking;
  if (typeof host.verifyLinks === "function") out.push(...host.verifyLinks());
  return out;
}

const CHECKING = new WeakSet<object>();

/** Check the indexes after every operation on `app` (DATANOTES_INDEX_CHECK=1). */
export function enableIndexCheck(app: App): void {
  CHECKING.add(app);
}

/**
 * After an operation, when the check is on: compare the indexes with the vault; a difference is
 * reported as an error, the index reads the vault again, and the host resolves its links again.
 * Returns the differences.
 */
export async function checkIndexAfter(app: App, settings: IndexSettings, op: string): Promise<string[]> {
  if (!CHECKING.has(app)) return [];
  const diffs = await verifyIndex(app, settings);
  if (diffs.length > 0) {
    telemetry().log("ERROR", "datanotes vault index out of step with the vault", { operation: op, differences: diffs.length, first: diffs.slice(0, 5).join("; ") });
    vaultIndex(app, settings)?.invalidate();
    forgetCurrentStates(app);
    // the host's links too: resolved again, so the same difference is not told after every operation
    const host = app.metadataCache as unknown as SelfChecking;
    if (typeof host.relinkAll === "function") {
      host.relinkAll();
      bumpVaultGeneration(app); // what is built on the links (the graph, the names) is built again
    }
  }
  return diffs;
}
