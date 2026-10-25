/**
 * Table discovery and name resolution over the live vault (phase 33).
 * Uses `metadataCache` frontmatter, so it reflects Obsidian's index.
 */

import type { App, TFile } from "./host";
import { cachedMetastore, catalogTablePath, catalogTables, catalogViews, entryToOrdered, rowTableFull, tableTags, type CatalogRef, type Metastore } from "./metastore";
import type { DatanotesSettings } from "./settings";
import { catalogLayout, DEFAULT_DATABASE_FOLDER, parseTableOptions } from "./table-loader";
import { TABLE_KEY } from "./types-table";
import type { ValidationContext } from "./validate";
import { vaultGeneration } from "./file-cache";
import { vaultIndex } from "./vault-index";
import { closestNames, guide, GuidedError, nameList, sentences, type Guidance } from "./hints";
import { normalizeDatabaseFolder } from "./db-paths";
import { currentReadScope, tableReadable, type ReadScope } from "./read-scope";
import { tablesReadByView } from "./query-tables";

export class TableNotFoundError extends GuidedError {
  override readonly name = "TableNotFoundError";
  constructor(
    readonly ref: string,
    guidance?: Guidance,
  ) {
    super(`Table not found: ${ref}`, guidance);
  }
}

/**
 * May the read scope (the current one when not given; null: none) read the view `viewFull`? Its own
 * name must be readable, and every table it reads, as told from the metastore alone: a view whose
 * reads cannot be told in full (`within`, `base:`, a union, …) is not readable under a scope.
 */
export function viewReadable(model: Metastore, viewFull: string, scope: ReadScope | null = currentReadScope()): boolean {
  if (scope === null) return true;
  if (!tableReadable(viewFull, scope)) return false;
  const reads = tablesReadByView(model, viewFull);
  return reads.complete && reads.tables.every((t) => tableReadable(t, scope));
}

/**
 * A table (or view) `ref` names none of `model`: the error, with the closest real names (by name
 * or alias), the list of them and the operation that describes them all. `kind` is what the
 * operation takes: a write needs a table, so a view's name gets the view's own explanation.
 */
export function tableNotFound(ref: string, model: Metastore | null | undefined, kind: "table" | "view" | "any" = "table"): TableNotFoundError {
  // under a read scope, only what the token may read is named (list_tables lists the same)
  const scope = currentReadScope();
  const tables = model ? catalogTables(model).filter(({ ref: r }) => tableReadable(r.full, scope)).map(({ ref: r, entry }) => ({ r, aliases: entry.aliases })) : [];
  const views = model ? catalogViews(model).filter(({ ref: r }) => viewReadable(model, r.full, scope)).map(({ ref: r, view }) => ({ r, aliases: view.aliases })) : [];
  if (model && kind === "table") {
    const view = views.find(({ r }) => r.full === ref.trim() || r.table === ref.trim() || `${r.schema}.${r.table}` === ref.trim());
    if (view) {
      const source = model.catalogs[view.r.catalog]!.schemas[view.r.schema]!.views[view.r.table]!.query.table;
      const of = typeof source === "string" ? `, ${source},` : "";
      return new TableNotFoundError(
        ref,
        guide(`${view.r.full} is a view: read it with select_rows; it cannot be written or changed like a table. Write to its table${of} instead (describe_table shows it).`, "views"),
      );
    }
  }
  const shown = [...(kind === "view" ? [] : tables), ...(kind === "table" ? [] : views)];
  const count = new Map<string, number>();
  for (const { r } of shown) count.set(r.table, (count.get(r.table) ?? 0) + 1);
  // the bare name when it is the only one, else the full name
  const display = (r: CatalogRef) => (count.get(r.table)! > 1 ? r.full : r.table);
  const aliases = new Map<string, string>();
  for (const { r, aliases: a } of shown) for (const alias of a ?? []) aliases.set(String(alias), r.table);
  const wanted = ref.trim().split(".").pop()!;
  const near = closestNames(wanted, shown.map(({ r }) => r.table), { aliases }).flatMap((name) => shown.filter(({ r }) => r.table === name).map(({ r }) => `"${display(r)}"`));
  const tableNames = tables.map(({ r }) => display(r));
  const viewNames = views.map(({ r }) => display(r));
  return new TableNotFoundError(
    ref,
    guide(
      sentences(
        near.length > 0 ? `Did you mean ${near.join(" or ")}?` : "",
        kind !== "view" ? (tableNames.length > 0 ? `Tables: ${nameList(tableNames)}.` : scope ? `Token ${scope.token} may read no table.` : "There are no tables yet (create_table makes one).") : "",
        kind !== "table" && viewNames.length > 0 ? `Views: ${nameList(viewNames)}.` : kind === "view" ? "There are no views." : "",
        "list_tables lists them with their descriptions and aliases.",
      ),
      "findTable",
    ),
  );
}

function frontmatterOf(app: App, file: TFile): Record<string, unknown> | undefined {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  return fm && typeof fm === "object" ? (fm as Record<string, unknown>) : undefined;
}

export interface TableRef {
  name: string;
  /** Catalog of the table in the metastore (`metastore.yaml`). */
  catalog: string;
  /** Schema of the table in its catalog, e.g. `metrics`. */
  schema: string;
  /** `catalog.schema.name`, unambiguous. */
  qualified: string;
  description?: string;
  aliases?: string[];
  /** Key/value labels of the table (`{ domain: "health" }`). */
  tags?: Record<string, string>;
}

/** Every table of the cached `metastore.yaml` (see `loadMetastore`), sorted by schema, name, then path. */
export function listTables(app: App, databaseFolder: string = DEFAULT_DATABASE_FOLDER): TableRef[] {
  const out: TableRef[] = [];
  const ms = cachedMetastore(app, { databaseFolder });
  for (const { ref, entry } of ms ? catalogTables(ms) : []) {
    const tags = tableTags(entry);
    out.push({
      name: ref.table,
      catalog: ref.catalog,
      schema: ref.schema,
      qualified: ref.full,
      ...(typeof entry.description === "string" && entry.description !== "" ? { description: entry.description } : {}),
      ...(Array.isArray(entry.aliases) && entry.aliases.length > 0 ? { aliases: entry.aliases.map(String) } : {}),
      ...(tags ? { tags } : {}),
    });
  }
  return out.sort(
    (a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name) || a.qualified.localeCompare(b.qualified),
  );
}

function markdownFile(app: App, path: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(path);
  if (f == null || !("extension" in f) || (f as TFile).extension !== "md") return null;
  return f as TFile;
}

const vocabularyCache = new WeakMap<App, { gen: number; sets: Map<string, ReadonlySet<string>> }>();
/** With a vault index: each table's names, kept while its rows do not change (vault-index.ts). */
const indexedVocabularies = new WeakMap<App, Map<string, { gen: number; epoch: number; model: Metastore; names: ReadonlySet<string> }>>();

/** Names of the rows of `table` (from Obsidian's frontmatter index), cached per vault generation. */
function vocabularyOf(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">,
  table: string,
): ReadonlySet<string> | null {
  const idx = vaultIndex(app, settings);
  if (idx) {
    const ms = cachedMetastore(app, { databaseFolder: settings.databaseFolder });
    if (!ms) return null;
    let byTable = indexedVocabularies.get(app);
    if (!byTable) indexedVocabularies.set(app, (byTable = new Map()));
    const gen = idx.tableGeneration(table);
    const hit = byTable.get(table);
    if (hit && hit.gen === gen && hit.epoch === idx.epoch && hit.model === ms) return hit.names;
    const names = new Set<string>();
    for (const f of idx.rowsOf(table)) {
      if (f.path.includes("/_archive/")) continue;
      const name = idx.note(f.path)!.frontmatter!.name; // a row has front matter
      if (typeof name === "string" && name.trim() !== "") names.add(name.trim());
    }
    byTable.set(table, { gen, epoch: idx.epoch, model: ms, names });
    return names;
  }
  const gen = vaultGeneration(app);
  let entry = vocabularyCache.get(app);
  if (!entry || entry.gen !== gen) {
    entry = { gen, sets: new Map() };
    vocabularyCache.set(app, entry);
  }
  const hit = entry.sets.get(table);
  if (hit) return hit;
  const ms = cachedMetastore(app, { databaseFolder: settings.databaseFolder });
  if (!ms) return null;
  const names = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = frontmatterOf(app, f);
    if (!fm || rowTableFull(ms, fm[settings.tableKey]) !== table) continue;
    if (f.path.includes("/_archive/")) continue;
    const name = fm.name;
    if (typeof name === "string" && name.trim() !== "") names.add(name.trim());
  }
  entry.sets.set(table, names);
  return names;
}

/**
 * How the names kept per table (vault index) differ from the names read from every note now
 * (index-check.ts); empty when they agree.
 */
export function verifyVocabularies(app: App, settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">): string[] {
  const idx = vaultIndex(app, settings);
  const ms = cachedMetastore(app, { databaseFolder: settings.databaseFolder });
  const out: string[] = [];
  for (const [table, hit] of indexedVocabularies.get(app) ?? []) {
    if (!idx || !ms || hit.gen !== idx.tableGeneration(table) || hit.epoch !== idx.epoch || hit.model !== ms) continue; // read again on its next use
    const names = new Set<string>();
    for (const f of app.vault.getMarkdownFiles()) {
      const fm = frontmatterOf(app, f);
      if (!fm || rowTableFull(ms, fm[settings.tableKey]) !== table || f.path.includes("/_archive/")) continue;
      if (typeof fm.name === "string" && fm.name.trim() !== "") names.add(fm.name.trim());
    }
    if (JSON.stringify([...names]) !== JSON.stringify([...hit.names])) out.push(`names of ${table}: ${JSON.stringify([...hit.names])} instead of ${JSON.stringify([...names])}`);
  }
  return out;
}

const archiveCache = new WeakMap<Metastore, { root: string; folders: readonly string[] }>();

/** The archive folder of every table of `model` (`<table folder>/_archive`, or the table's `archive`). */
function archiveFolders(model: Metastore, settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">): readonly string[] {
  const root = normalizeDatabaseFolder(settings.databaseFolder);
  const hit = archiveCache.get(model);
  if (hit && hit.root === root) return hit.folders;
  const folders: string[] = [];
  for (const { ref, entry } of catalogTables(model)) {
    try {
      const options = parseTableOptions(entryToOrdered(ref, entry, settings).find(([k]) => k === TABLE_KEY)?.[1]);
      folders.push(catalogLayout(root, ref, options).archive);
    } catch {
      // a malformed table is reported by the loader
    }
  }
  archiveCache.set(model, { root, folders });
  return folders;
}

/**
 * Whether `path` is in the archive folder of a table of `model` (the current metastore when not
 * given): an archived row, which is no link target any more, as a deleted row is not.
 */
export function isArchivedPath(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">,
  path: string,
  model: Metastore | null = cachedMetastore(app, settings),
): boolean {
  return model != null && archiveFolders(model, settings).some((dir) => path.startsWith(`${dir}/`));
}

/**
 * Validation context resolving links from `sourcePath` and table ownership of targets. A link to
 * an archived row resolves to nothing (`broken_link`), as a link to a deleted row.
 */
export function validationContextFor(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder" | "tableKey">,
  sourcePath: string,
): ValidationContext {
  return {
    resolveLink: (linkpath) => {
      const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
      return dest !== null && isArchivedPath(app, settings, dest) ? null : dest;
    },
    vocabulary: (table) => vocabularyOf(app, settings, table),
    linkSubpaths: app.packs !== undefined,
    tableOfPath: (path) => {
      const f = markdownFile(app, path);
      if (!f) return null;
      const ms = cachedMetastore(app, { databaseFolder: settings.databaseFolder });
      const full = ms ? rowTableFull(ms, frontmatterOf(app, f)?.[settings.tableKey]) : null;
      return full ?? null;
    },
  };
}
