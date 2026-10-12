/** Which notes are the rows of a table. */

import type { App, TFile } from "./host";
import { cachedMetastore, rowTableFull } from "./metastore";
import type { DatanotesSettings } from "./settings";
import type { TableDefinition } from "./types-table";

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
  const model = cachedMetastore(app, settings);
  if (!model) return [];
  const exclude = [...(def.options.exclude ?? []), def.layout.archive];
  const out: TFile[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    const v = fm?.[settings.tableKey];
    if (v === undefined || v === null) continue;
    if (rowTableFull(model, v) !== full) continue;
    if (exclude.some((dir) => f.path.startsWith(`${dir}/`))) continue;
    out.push(f);
  }
  return out;
}
