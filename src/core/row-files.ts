/** Which notes are the rows of a table. */

import type { App, TFile } from "./host";
import { cachedMetastore, rowTableFull } from "./metastore";
import type { DatanotesSettings } from "./settings";
import type { TableDefinition } from "./types-table";
import { vaultIndex } from "./vault-index";

/**
 * Rows of a metastore table: notes whose `table` property (setting `tableKey`) names it,
 * wherever they live — minus its archive and `exclude` folders.
 */
export function catalogRowFiles(
  app: App,
  settings: DatanotesSettings,
  full: string,
  def: Pick<TableDefinition, "options" | "layout">,
): TFile[] {
  return catalogRowFilesOf(app, settings, [{ full, def }]).get(full)!; // every table asked for has a list
}

/**
 * The rows of several tables (as {@link catalogRowFiles}), by full name, in the vault's order of
 * its notes: from the vault index where the host has one (vault-index.ts), else one pass over the
 * vault's notes.
 */
export function catalogRowFilesOf(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">,
  tables: readonly { full: string; def: Pick<TableDefinition, "options" | "layout"> }[],
): Map<string, TFile[]> {
  const idx = vaultIndex(app, settings);
  if (!idx || idx.hasFailures) return scanRowFilesOf(app, settings, tables);
  const out = new Map<string, TFile[]>();
  for (const { full, def } of tables) {
    const excluded = excludedFolders(def);
    out.set(full, idx.rowsOf(full).filter((f) => !excluded.some((dir) => f.path.startsWith(`${dir}/`))));
  }
  return out;
}

/** The order of `loadRows`: by path, as `localeCompare` orders them. */
const byPath = (a: TFile, b: TFile) => a.path.localeCompare(b.path);

/** Each table's rows sorted by path, while its rows do not come or go (vault index). */
const SORTED = new WeakMap<object, Map<string, { gen: number; epoch: number; excluded: string; def: Pick<TableDefinition, "options" | "layout">; files: readonly TFile[] }>>();

/**
 * The rows of a table (as {@link catalogRowFiles}) sorted by path with `localeCompare`, the order
 * `loadRows` gives: kept while the table's rows do not come or go, where the host has a vault
 * index (a sort of thousands of paths per read otherwise).
 */
export function sortedRowFiles(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">,
  full: string,
  def: Pick<TableDefinition, "options" | "layout">,
): TFile[] {
  const idx = vaultIndex(app, settings);
  if (!idx || idx.hasFailures) return catalogRowFilesOf(app, settings, [{ full, def }]).get(full)!.sort(byPath);
  const excluded = excludedFolders(def).join("\0");
  const gen = idx.membershipGeneration(full);
  let byTable = SORTED.get(app);
  if (!byTable) SORTED.set(app, (byTable = new Map()));
  const hit = byTable.get(full);
  if (hit && hit.gen === gen && hit.epoch === idx.epoch && hit.excluded === excluded) return [...hit.files];
  const files = catalogRowFilesOf(app, settings, [{ full, def }]).get(full)!.sort(byPath);
  byTable.set(full, { gen, epoch: idx.epoch, excluded, def, files });
  return [...files];
}

/** How the sorted rows kept per table differ from the rows sorted now (index-check.ts); empty when they agree. */
export function verifySortedRows(app: App, settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">): string[] {
  const idx = vaultIndex(app, settings);
  const out: string[] = [];
  for (const [full, hit] of SORTED.get(app) ?? []) {
    // sorted again on its next use (not used while the host's index throws)
    if (!idx || idx.hasFailures || hit.gen !== idx.membershipGeneration(full) || hit.epoch !== idx.epoch) continue;
    const now = scanRowFilesOf(app, settings, [{ full, def: hit.def }]).get(full)!.sort(byPath).map((f) => f.path);
    if (now.join("\n") !== hit.files.map((f) => f.path).join("\n")) out.push(`sorted rows of ${full} differ from the rows now`);
  }
  return out;
}

function excludedFolders(def: Pick<TableDefinition, "options" | "layout">): string[] {
  return [...(def.options.exclude ?? []), def.layout.archive];
}

/** {@link catalogRowFilesOf} by a pass over every note of the vault (a host without an index, and the index's check). */
export function scanRowFilesOf(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">,
  tables: readonly { full: string; def: Pick<TableDefinition, "options" | "layout"> }[],
): Map<string, TFile[]> {
  const out = new Map<string, TFile[]>(tables.map((t) => [t.full, []]));
  const model = cachedMetastore(app, settings);
  if (!model) return out;
  const excluded = new Map(tables.map((t) => [t.full, excludedFolders(t.def)]));
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    const v = fm?.[settings.tableKey];
    if (v === undefined || v === null) continue;
    const full = rowTableFull(model, v);
    const rows = full === null ? undefined : out.get(full);
    if (!rows) continue;
    if (excluded.get(full!)!.some((dir) => f.path.startsWith(`${dir}/`))) continue;
    rows.push(f);
  }
  return out;
}
