/**
 * Rules a row keeps beyond its own values: CHECK constraints, one parent per row in a hierarchy
 * (no cycles), and check_table, which checks every rule on every row of a table.
 */

import type { App, TFile } from "./host";
import { catalogTables, constraintHints, loadMetastore, type CatalogTableEntry, type Metastore } from "./metastore";
import { loadRows, loadTable, uniqueViolations, type LoadedRow, type LoadedTable, type RowViolations } from "./engine";
import { fmGet } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { validationContextFor } from "./table-registry";
import { traced } from "./telemetry";
import type { Violation, ViolationCode } from "./types-table";
import { missingBackLinks } from "./inverse";
import type { OrderedFrontmatter } from "./types";
import { validateRow } from "./validate";
import { basenameOf } from "./path-templates";
import { generatedMismatches } from "./computed-columns";
import { compileCheck, linkName, type Where } from "./where";
import { CheckLinks, followsLinks } from "./check-links";
import { filteredLinkColumns, linkTargetCheck } from "./link-targets";
import { messageOf } from "./message";
import { acyclicViolations } from "./acyclic";
import { unreadableMessage, unreadableRows, type UnreadableNote } from "./unreadable";
import { phase, tally, traceNow, tracingOn } from "./tracing";
import { assertTableReadable, currentReadScope, pathReadable, tableReadable } from "./read-scope";
import { packPartitionWarning, type LayoutWarning } from "./pack-layout";

// --- CHECK constraints ---

/**
 * CHECK constraints of a metastore table (`constraints: { name: <where> }`): the row must match (see
 * compileCheck). CHECKs that follow links need `links`; without it they are left to
 * {@link linkedCheckViolations}, which checks them on the change set's final state.
 */
function constraintViolationsImpl(t: LoadedTable, settings: DatanotesSettings, path: string, ordered: OrderedFrontmatter, links?: CheckLinks): Violation[] {
  const raw = t.catalog.entry.constraints;
  if (!raw || typeof raw !== "object") return [];
  const out: Violation[] = [];
  const hints = constraintHints(t.catalog.entry);
  for (const [name, where] of Object.entries(raw)) {
    if (!where || typeof where !== "object" || Array.isArray(where)) continue;
    if (!links && followsLinks(where)) continue;
    try {
      if (!compileCheck(where as Where, t, settings, links)({ file: { path } as TFile, ordered })) {
        out.push({ constraint: name, code: "check", message: `violates CHECK ${name}: ${JSON.stringify(where)}`, ...(hints[name] ? { hint: hints[name] } : {}) });
      }
    } catch (e) {
      out.push({ constraint: name, code: "check", message: `CHECK ${name} is invalid: ${messageOf(e)}` });
    }
  }
  return out;
}

// --- hierarchy (one parent per row, no cycles) ---

/**
 * Rows of `changed` that would become their own ancestor through a `hierarchy` column, given the
 * table's other rows. Rows are named by file name (links compare by note name).
 */
async function hierarchyViolationsImpl(
  app: App,
  settings: DatanotesSettings,
  t: LoadedTable,
  changed: readonly { path: string; ordered: OrderedFrontmatter }[],
  all?: readonly LoadedRow[],
): Promise<RowViolations[]> {
  const cols = t.def.columns.filter((c) => c.hierarchy);
  if (cols.length === 0 || changed.length === 0) return [];
  const rows = all ?? (await loadRows(app, settings, t));
  const out: RowViolations[] = [];
  for (const c of cols) {
    const parentOf = new Map<string, string | null>();
    for (const r of rows) parentOf.set(basenameOf(r.file.path), linkName(fmGet(r.ordered, c.name)));
    for (const ch of changed) parentOf.set(basenameOf(ch.path), linkName(fmGet(ch.ordered, c.name)));
    for (const ch of changed) {
      const self = basenameOf(ch.path);
      const chain: string[] = [];
      let cur = parentOf.get(self) ?? null;
      while (cur != null && !chain.includes(cur)) {
        chain.push(cur);
        if (cur === self) {
          out.push({ path: ch.path, violations: [{ column: c.name, code: "cycle", message: `would make "${self}" its own ancestor (${[self, ...chain].join(" → ")})` }] });
          break;
        }
        cur = parentOf.get(cur) ?? null;
      }
    }
  }
  return out;
}

// --- check_table ---

/** A rule a row breaks, as check_table reports it: `constraint` names a CHECK (code `check`), `column` the column (every other code). */
export interface CheckViolation {
  code: ViolationCode;
  column?: string;
  /** The item of a list column, from 0. */
  index?: number;
  constraint?: string;
  /** The CHECK's own hint (code `check`), when the constraint has one. */
  hint?: string;
  message: string;
  value?: unknown;
}

/** The violations of one row, as check_table reports them. */
export interface CheckedRow {
  path: string;
  /** The row's qualified table (when every table was checked). */
  table?: string;
  violations: CheckViolation[];
}

export interface CheckInput {
  /** One table; omitted: every table. */
  table?: string;
  /** Rows with violations returned (default {@link CHECK_LIMIT}, at most {@link CHECK_MAX}). */
  limit?: number;
  /** Rows with violations skipped first (paging). */
  offset?: number;
}

export interface CheckResult {
  /** Qualified table; null when every table was checked. */
  table: string | null;
  rows_checked: number;
  /** Tables checked (when every table was checked). */
  tables_checked?: number;
  /** Rows breaking the rules, `limit` of them from `offset`; each names its `table` when every table was checked. */
  violations: CheckedRow[];
  /** Rows breaking the rules in all. */
  total: number;
  /** Tables that could not be checked (when every table was checked), with the reason; the others are. */
  errors?: { table: string; error: string }[];
  /** What is unwise in the layout of the tables checked, though allowed (a partition wider than its packs). */
  warnings?: LayoutWarning[];
}

/** The layout warnings of these tables (their entries in the metastore). */
function layoutWarnings(tables: readonly { ref: { full: string }; entry: CatalogTableEntry }[]): LayoutWarning[] {
  const out: LayoutWarning[] = [];
  for (const { ref, entry } of tables) {
    // the metastore's parser keeps `partition` and `pack` as written: text, when given
    const w = packPartitionWarning(ref.full, entry.options?.partition, entry.options?.pack);
    if (w) out.push(w);
  }
  return out;
}

export const CHECK_LIMIT = 500;
export const CHECK_MAX = 5000;

/** A violation as check_table and the checks of hand edits report it: a CHECK by its name (`constraint`). */
function checkViolation(v: Violation): CheckViolation {
  return v;
}

export async function checkOne(
  app: App,
  settings: DatanotesSettings,
  table: string,
  /** The unreadable rows of every table, read once for a check of all of them (on that metastore). */
  everyUnreadable?: { model: Metastore; rows: readonly UnreadableNote[] },
): Promise<{ table: string; rows: number; violations: RowViolations[] }> {
  const t = await loadTable(app, settings, table);
  const violations: RowViolations[] = [];
  /** The rows already reported, by path: later checks add to them (a find per row was quadratic). */
  const byPath = new Map<string, RowViolations>();
  const report = (path: string, v: RowViolations["violations"]) => {
    const existing = byPath.get(path);
    if (existing) existing.violations.push(...v);
    else {
      const row = { path, violations: v };
      violations.push(row);
      byPath.set(path, row);
    }
  };
  // the table's rows, read once: CHECKs and link filters that read the table itself share them
  const links = new CheckLinks(app, settings);
  await links.prepare(t, null);
  const rows = links.rowsOf(t);
  for (const where of Object.values(t.catalog.entry.constraints ?? {})) await links.prepare(t, where);
  const targetChecks: ((row: LoadedRow) => Violation[])[] = [];
  for (const c of filteredLinkColumns(t)) targetChecks.push(await linkTargetCheck(t, settings, links, c));
  const unique = new Map(
    uniqueViolations(t.def.columns, rows.map((r) => ({ path: r.file.path, ordered: r.ordered }))).map((u) => [u.path, u.violations]),
  );
  for (const r of rows) {
    const v = [
      ...validateRow(t.def, r.ordered, { tableKey: settings.tableKey }, validationContextFor(app, settings, r.file.path)),
      ...(unique.get(r.file.path) ?? []),
      ...constraintViolations(t, settings, r.file.path, r.ordered, links),
      ...targetChecks.flatMap((check) => check(r)),
      ...generatedMismatches(t, settings, r),
    ];
    if (v.length > 0) report(r.file.path, v);
  }
  const back = await missingBackLinks(app, settings, t.catalog.model, t.catalog.ref.full, rows.map((r) => ({ path: r.file.path, ordered: r.ordered })));
  for (const [path, list] of back) report(path, list.map((x) => ({ column: x.column, code: "inverse" as const, message: x.message, value: x.value })));
  for (const h of await hierarchyViolations(app, settings, t, rows.map((r) => ({ path: r.file.path, ordered: r.ordered })), rows)) report(h.path, h.violations);
  for (const a of acyclicViolations(t.def.columns, t.catalog.ref.full, rows.map((r) => ({ path: r.file.path, ordered: r.ordered })), { wording: "check" })) report(a.path, a.violations);
  // rows whose front matter cannot be read: every other read leaves them out
  const unreadable =
    everyUnreadable && everyUnreadable.model === t.catalog.model
      ? everyUnreadable.rows.filter((u) => u.table === t.catalog.ref.full)
      : await unreadableRows(app, settings, t.catalog.model, t.catalog.ref.full);
  for (const u of unreadable) violations.push({ path: u.path, violations: [{ code: "unreadable", message: unreadableMessage(u.error) }] });
  return { table: t.def.name, rows: rows.length + unreadable.length, violations };
}

/**
 * One table, or every table of the metastore (its rows then name their `table`; a table that
 * cannot be checked is listed in `errors`, the others are still checked). The rows with
 * violations are paged (`limit`, `offset`); `total` counts them all.
 */
async function checkImpl(app: App, settings: DatanotesSettings, input: CheckInput): Promise<CheckResult> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? CHECK_LIMIT), 1), CHECK_MAX);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  // under a read scope: only the tables the token may read, and nothing about a note it may not
  // read (checked here, at the read site: checkOne also serves the change feed's checks)
  const scope = currentReadScope();
  const rowsOf = (list: readonly RowViolations[], table?: string): CheckedRow[] =>
    list
      .filter((r) => scope === null || pathReadable(app, settings, r.path, scope) || r.violations.every((v) => v.code === "unreadable"))
      .map((r) => ({ path: r.path, ...(table ? { table } : {}), violations: r.violations.map(checkViolation) }));
  if (input.table) {
    if (scope) assertTableReadable((await loadTable(app, settings, input.table)).catalog.ref.full);
    const r = await checkOne(app, settings, input.table);
    const shown = rowsOf(r.violations);
    const { ref, entry } = (await loadTable(app, settings, input.table)).catalog;
    const warnings = layoutWarnings([{ ref, entry }]);
    return { table: r.table, rows_checked: r.rows, total: shown.length, violations: shown.slice(offset, offset + limit), ...(warnings.length > 0 ? { warnings } : {}) };
  }
  const model = (await loadMetastore(app, settings))?.model;
  const all: CheckedRow[] = [];
  const errors: { table: string; error: string }[] = [];
  let rows = 0;
  let tables = 0;
  // the notes whose front matter cannot be read, found in one pass for every table
  const everyUnreadable = model ? { model, rows: await unreadableRows(app, settings, model) } : undefined;
  for (const full of (model ? catalogTables(model).map(({ ref }) => ref.full) : []).filter((full) => tableReadable(full, scope)).sort()) {
    let r: Awaited<ReturnType<typeof checkOne>>;
    try {
      r = await checkOne(app, settings, full, everyUnreadable);
    } catch (e) {
      errors.push({ table: full, error: messageOf(e) });
      continue;
    }
    rows += r.rows;
    tables++;
    all.push(...rowsOf(r.violations, full));
  }
  const warnings = layoutWarnings(model ? catalogTables(model) : []).filter((w) => tableReadable(w.table, scope));
  return { table: null, rows_checked: rows, tables_checked: tables, total: all.length, violations: all.slice(offset, offset + limit), ...(errors.length > 0 ? { errors } : {}), ...(warnings.length > 0 ? { warnings } : {}) };
}

export function checkTable(app: App, settings: DatanotesSettings, input: CheckInput): Promise<CheckResult> {
  return traced(
    "datanotes check_table",
    { "datanotes.op": "check_table", table: input.table ?? "*" },
    () => checkImpl(app, settings, input),
    (r) => ({
      severity: r.total > 0 || (r.errors?.length ?? 0) > 0 ? "WARN" : "INFO",
      attributes: { rows: r.rows_checked, violating_rows: r.total, ...(r.errors ? { failed_tables: r.errors.length } : {}) },
    }),
  );
}

/** {@link hierarchyViolationsImpl}, traced (cycles and `ref_by` levels). */
export function hierarchyViolations(...args: Parameters<typeof hierarchyViolationsImpl>): ReturnType<typeof hierarchyViolationsImpl> {
  return phase("engine.checks", () => hierarchyViolationsImpl(...args), { "datanotes.checks.kind": "hierarchy" });
}

/** {@link constraintViolationsImpl}; once per row, so timed on the active span (`datanotes.checks.rows`, `datanotes.checks.ms`), not a span each. */
export function constraintViolations(t: LoadedTable, settings: DatanotesSettings, path: string, ordered: OrderedFrontmatter, links?: CheckLinks): Violation[] {
  if (!tracingOn()) return constraintViolationsImpl(t, settings, path, ordered, links);
  const start = traceNow();
  try {
    return constraintViolationsImpl(t, settings, path, ordered, links);
  } finally {
    tally("datanotes.checks.rows", "datanotes.checks.ms", start);
  }
}
