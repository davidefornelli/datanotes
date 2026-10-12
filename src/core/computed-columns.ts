/**
 * Values the engine computes or completes on a row: generated columns, identity columns (`uuid`,
 * `filename`, `created`), the system row id, and date-times completed with the database time zone.
 */

import type { App } from "./host";
import { evalGenerated } from "./generated";
import { isUuid, uuidv7 } from "./uuid";
import { resolveCatalogRef } from "./metastore";
import { catalogLoadedTable, type LoadedRow, type LoadedTable } from "./engine";
import { fmDelete, fmGet, fmSet } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { normalizeDatetime, resolveDefault } from "./datetime";
import { DEFAULT_NOW, DEFAULT_TODAY, SYSTEM_ID_COLUMN, type ColumnSpec, type Violation } from "./types-table";
import { readDatabaseConfig } from "./database";
import type { OrderedFrontmatter } from "./types";
import { isEmptyValue } from "./validate";
import { basenameOf } from "./path-templates";

/** Columns whose value the engine computes (never set by callers). */
export function computedColumnNames(t: LoadedTable): Set<string> {
  return new Set(t.def.columns.filter((c) => c.generated !== undefined || c.identity !== undefined).map((c) => c.name));
}

/**
 * Folder of the rows of table `ref` (for generated `link(…)` columns), read from the schema the
 * table was loaded with; null when the table is unknown or its rows are partitioned in sub-folders
 * (the link then has no folder: Obsidian resolves it by note name).
 */
function linkTargetFolder(t: LoadedTable, settings: DatanotesSettings, ref: string): string | null {
  try {
    const target = resolveCatalogRef(t.catalog.model, ref);
    if (!target) return null;
    const def = catalogLoadedTable(settings, { file: t.file, text: t.catalog.text, model: t.catalog.model }, target).def;
    return def.options.partition ? "" : def.layout.folder;
    /* v8 ignore start -- defensive: the ref names a table of the metastore this table loaded from */
  } catch {
    return null;
  }
  /* v8 ignore stop */
}

/** Recompute generated columns from the row's other values. */
export function withGenerated(t: LoadedTable, settings: DatanotesSettings, ordered: OrderedFrontmatter, path: string): OrderedFrontmatter {
  const generated = t.def.columns.filter((c) => c.generated !== undefined);
  if (generated.length === 0) return ordered;
  let out = ordered;
  for (const c of generated) {
    // the loader requires a ref for a link(…) column, the only kind that asks for the folder
    const v = evalGenerated(c.generated!, (k) => fmGet(out, k), path, () => linkTargetFolder(t, settings, c.ref!));
    out = isEmptyValue(v) ? (c.dense ? fmSet(out, c.name, null) : fmDelete(out, c.name)) : fmSet(out, c.name, v);
  }
  return out;
}

/**
 * Identity columns: `filename` takes the row's file name; `uuid` keeps a valid UUID and assigns a
 * new UUIDv7 when missing or invalid (or when `reassign`, e.g. for a duplicated note).
 */
export function withIdentity(t: LoadedTable, ordered: OrderedFrontmatter, path: string, reassign = false, env?: IdentityEnv): OrderedFrontmatter {
  let out = ordered;
  for (const c of t.def.columns) {
    if (c.identity === "filename") out = fmSet(out, c.name, basenameOf(path));
    else if (c.identity === "uuid" && (reassign || !isUuid(fmGet(out, c.name)))) out = fmSet(out, c.name, uuidv7());
    else if (c.identity === "created" && env && isEmptyValue(fmGet(out, c.name))) {
      const when = new Date(env.created ?? env.now.getTime());
      out = fmSet(out, c.name, resolveDefault(c.type === "date" ? DEFAULT_TODAY : DEFAULT_NOW, when, env.tz));
    }
  }
  return out;
}

/**
 * Fill identity columns of a row being written by a metastore operation (uuid id, created time
 * from the file's creation, file name) — for callers outside this module.
 */
export async function fillIdentities(app: App, settings: DatanotesSettings, t: LoadedTable, ordered: OrderedFrontmatter, path: string): Promise<OrderedFrontmatter> {
  const tz = (await readDatabaseConfig(app, settings)).timezone;
  const created = fileCreated(app, path);
  return withIdentity(t, ordered, path, false, { now: new Date(), tz, ...(created !== undefined ? { created } : {}) });
}

/** What `identity: created` needs: the time zone, now, and (for existing notes) the file's creation time. */
interface IdentityEnv {
  now: Date;
  tz: string;
  created?: number;
}

export function fileCreated(app: App, path: string): number | undefined {
  const f = app.vault.getAbstractFileByPath(path) as { stat?: { ctime?: number } } | null;
  const c = f?.stat?.ctime;
  return typeof c === "number" && c > 0 ? c : undefined;
}

/** A row entering a metastore table keeps a valid UUID `id`, else gets one right after `table`. */
export function withRowId(ordered: OrderedFrontmatter): OrderedFrontmatter {
  if (isUuid(fmGet(ordered, SYSTEM_ID_COLUMN))) return ordered;
  const rest = ordered.filter(([k]) => k !== SYSTEM_ID_COLUMN);
  return [rest[0]!, [SYSTEM_ID_COLUMN, uuidv7()], ...rest.slice(1)] as OrderedFrontmatter;
}

/** Generated / identity columns whose stored value differs from the computed one. */
export function generatedMismatches(t: LoadedTable, settings: DatanotesSettings, r: LoadedRow): Violation[] {
  const expected = withIdentity(t, withGenerated(t, settings, r.ordered, r.file.path), r.file.path);
  const created = new Set(t.def.columns.filter((c) => c.identity === "created").map((c) => c.name));
  return [...computedColumnNames(t)].flatMap((name) => {
    if (created.has(name)) {
      // set once: only a missing value is a problem
      return isEmptyValue(fmGet(r.ordered, name)) ? [{ column: name, code: "generated" as const, message: "is missing (recompute_columns sets it)" }] : [];
    }
    const want = fmGet(expected, name);
    const have = fmGet(r.ordered, name);
    if (JSON.stringify(want ?? null) === JSON.stringify(have ?? null)) return [];
    return [{ column: name, code: "generated" as const, message: `should be ${JSON.stringify(want ?? null)} (computed)`, value: have }];
  });
}

/** Complete date-time values of datetime columns (and lists of them) with the database time zone. */
export function normalizeDatetimes(columns: readonly ColumnSpec[], ordered: OrderedFrontmatter, tz: string): OrderedFrontmatter {
  if (tz === "") return ordered;
  let out = ordered;
  for (const c of columns) {
    const isList = c.type === "list";
    if ((isList ? c.items : c.type) !== "datetime") continue;
    const v = fmGet(out, c.name);
    if (isEmptyValue(v)) continue;
    const next = isList && Array.isArray(v) ? v.map((x) => normalizeDatetime(x, tz)) : normalizeDatetime(v, tz);
    if (JSON.stringify(next) !== JSON.stringify(v)) out = fmSet(out, c.name, next);
  }
  return out;
}
