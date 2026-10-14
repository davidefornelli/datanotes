/**
 * A note created inside a table's folder becomes a row of that table (like inserting into it):
 * `table:` is set, column values are read back from the file name (the table's `filename`
 * pattern), dense / generated / identity columns are filled, and an empty body gets the table's
 * `row_template`. This is what makes Daily Notes (or "new note" in a table folder) create rows
 * without Templater templates.
 */

import type { App, TFile } from "./host";
import { valuesFromFilename } from "./filename-values";
import { readOrderedFromMarkdown } from "./frontmatter";
import { catalogTables, loadMetastore } from "./metastore";
import { adoptRows, recomputeColumns, renderRowTemplate } from "./rows";
import type { DatanotesSettings } from "./settings";
import { loadTable } from "./engine";
import { invalidateFiles } from "./file-cache";

export interface AdoptTarget {
  table: string;
  values: Record<string, string>;
  rowTemplate?: string;
}

/** The table whose folder holds `path` (not its archive nor an excluded folder), with values read from the name. */
export async function adoptTargetFor(app: App, settings: DatanotesSettings, path: string): Promise<AdoptTarget | null> {
  if (!path.endsWith(".md")) return null;
  const ms = await loadMetastore(app, settings);
  if (!ms) return null;
  const dir = path.slice(0, path.lastIndexOf("/"));
  const basename = path.slice(path.lastIndexOf("/") + 1, -3);
  for (const { ref, entry } of catalogTables(ms.model)) {
    const t = await loadTable(app, settings, ref.full);
    const folder = t.def.layout.folder;
    if (dir !== folder && !(t.def.options.partition && dir.startsWith(`${folder}/`))) continue;
    if (dir === t.def.layout.archive || dir.startsWith(`${t.def.layout.archive}/`)) return null;
    if ((t.def.options.exclude ?? []).some((x) => path.startsWith(`${x}/`))) return null;
    const pattern = t.def.options.filename;
    const values = pattern ? (valuesFromFilename(pattern, basename) ?? {}) : {};
    const tpl = typeof entry.row_template === "string" && entry.row_template.trim() !== "" ? entry.row_template : undefined;
    return { table: ref.full, values, ...(tpl ? { rowTemplate: tpl } : {}) };
  }
  return null;
}

/**
 * Whether a note is a row already, with its id: there is nothing to adopt then, in any folder.
 * False when the note cannot be read (adoption then decides as without this check).
 */
async function rowWithId(app: App, settings: DatanotesSettings, file: TFile): Promise<boolean> {
  if (!file.path.endsWith(".md")) return false;
  try {
    const { ordered } = readOrderedFromMarkdown(await app.vault.read(file), new Set([settings.tableKey]));
    return ordered.find(([k]) => k === settings.tableKey)?.[1] !== undefined && ordered.some(([k]) => k === "id");
  } catch {
    return false;
  }
}

/** Make a freshly created note a row when it sits in a table folder and is not a row yet. */
export async function adoptCreatedNote(
  app: App,
  settings: DatanotesSettings,
  file: TFile,
): Promise<{ adopted: boolean; table?: string; reason?: string }> {
  // Checked first: finding the table of a folder loads every table, and every row the engine
  // creates comes here too.
  if (await rowWithId(app, settings, file)) return { adopted: false };
  const target = await adoptTargetFor(app, settings, file.path);
  if (!target) return { adopted: false };
  const text = await app.vault.read(file);
  const { ordered, body } = readOrderedFromMarkdown(text, new Set([settings.tableKey]));
  const declared = ordered.find(([k]) => k === settings.tableKey)?.[1];
  if (declared !== undefined) {
    // Created already as a row (e.g. a tool writing `table:`): only fill id / created_at & co.
    if (declared !== target.table && !target.table.endsWith(`.${String(declared)}`)) return { adopted: false };
    if (ordered.some(([k]) => k === "id")) return { adopted: false };
    const r = await recomputeColumns(app, settings, { table: target.table, paths: [file.path] });
    return r.ok ? { adopted: true, table: target.table } : { adopted: false, table: target.table, reason: "recompute refused" };
  }
  /** Whether the row template was written (taken back when adoption is refused). */
  let templated = false;
  if (body.trim() === "" && target.rowTemplate) {
    const filled = renderRowTemplate(target.rowTemplate, new Map([...Object.entries(target.values), ...ordered]));
    await app.vault.process(file, (t) => `${t.replace(/\s+$/, "")}${t.trim() === "" ? "" : "\n"}${filled}`);
    templated = true;
    invalidateFiles(app, [file.path]); // adopt_rows must read the body just written
  }
  // Values already in the note win over those read from its name.
  const present = new Set(ordered.map(([k]) => k));
  const values: Record<string, unknown> = Object.fromEntries(Object.entries(target.values).filter(([k]) => !present.has(k)));
  // a note made by hand: columns with an external_default get it (e.g. origin: stated)
  for (const c of (await loadTable(app, settings, target.table)).def.columns) {
    // generated and identity columns are computed, also when the file name carries them
    if (c.generated !== undefined || c.identity !== undefined) {
      delete values[c.name];
      continue;
    }
    if (c.external_default !== undefined && !present.has(c.name) && values[c.name] === undefined) values[c.name] = c.external_default;
  }
  const r = await adoptRows(app, settings, { table: target.table, paths: [file.path], perRow: { [file.path]: values }, relocate: false });
  if (!r.ok) {
    if (templated) {
      // not a row: the note stays exactly as it was made
      await app.vault.process(file, () => text);
      invalidateFiles(app, [file.path]);
    }
    const why = [...r.conflicts.map((c) => c.message), ...r.violations.flatMap((v) => v.violations.map((x) => `${x.column ?? x.constraint}: ${x.message}`))].join("; ");
    return { adopted: false, table: target.table, reason: why || "refused" };
  }
  return { adopted: true, table: target.table };
}
