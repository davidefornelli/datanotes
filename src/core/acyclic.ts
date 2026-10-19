/**
 * Acyclic link columns (`acyclic: true`): a link column, or list of links, to its own table whose
 * links never form a cycle (tasks blocked by tasks). The graph of such a column has an edge A → B
 * for each B that A's column names and, when the table has the column's inverse (the column that
 * links the other way, `blocks` for `blocked_by`, declared on either side), an edge B → A for each
 * B that A's inverse names: the rule holds whichever side a write sets, and before both sides
 * agree. Rows are named by file name and links compare by note name, as for hierarchy columns.
 *
 * A write is checked on the state its change set leaves, the inverse-link edits included
 * ({@link changeSetCycles}, called by `finish`): it is refused when it puts a row it writes on a
 * cycle that row was not on before (a cycle made by hand does not block other writes; check_table
 * reports it). add_column / alter_column refuse the rule while rows already form a cycle
 * (`wording: "check"`), and check_table and the checks of hand edits report the rows on one.
 * undo_migration and restore_table put rows back as they were, without this check, and
 * define_base / set_table_bases do not check the rows of the tables that inherit an acyclic column.
 */

import type { App } from "./host";
import type { ChangeSet } from "./changeset";
import { loadRows, loadTable, type RowViolations } from "./engine";
import { fmGet, readOrderedFromMarkdown } from "./frontmatter";
import { baseChain, cachedMetastore, catalogTables, loadMetastore, metastorePath, rowTableFull, type Metastore } from "./metastore";
import { basenameOf } from "./path-templates";
import type { DatanotesSettings } from "./settings";
import { phase } from "./tracing";
import type { ColumnSpec, Violation } from "./types-table";
import type { OrderedFrontmatter } from "./types";
import { linkName } from "./where";

/** A row as the checks read it: its path and front matter. */
export interface AcyclicRow {
  path: string;
  ordered: OrderedFrontmatter;
}

/** An acyclic column and the column of the same table that links the other way (null: none). */
export interface AcyclicPair {
  column: string;
  inverse: string | null;
}

/** The acyclic columns of a table (`table`: its full name, for `ref: self`), each with its inverse. */
export function acyclicPairs(columns: readonly ColumnSpec[], table: string): AcyclicPair[] {
  const target = (c: ColumnSpec) => (c.ref === "self" ? table : c.ref);
  return columns
    .filter((c) => c.acyclic === true)
    .map((c) => {
      const declared = c.inverse !== undefined && c.inverse !== c.name ? c.inverse : undefined;
      const back = declared ?? columns.find((x) => x.name !== c.name && x.inverse === c.name && target(x) === target(c))?.name;
      return { column: c.name, inverse: back !== undefined && columns.some((x) => x.name === back) ? back : null };
    });
}

type Graph = Map<string, Set<string>>;

const items = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The graph of one acyclic column over `rows`: names → the names they wait for (rows of `rows` only). */
function graphOf(pair: AcyclicPair, rows: readonly AcyclicRow[]): Graph {
  const names = new Set(rows.map((r) => basenameOf(r.path)));
  const out: Graph = new Map();
  const add = (from: string, to: string) => {
    if (!names.has(from) || !names.has(to)) return;
    let s = out.get(from);
    if (!s) out.set(from, (s = new Set()));
    s.add(to);
  };
  for (const r of rows) {
    const self = basenameOf(r.path);
    for (const v of items(fmGet(r.ordered, pair.column))) {
      const to = linkName(v);
      if (to !== null) add(self, to);
    }
    if (pair.inverse !== null) {
      for (const v of items(fmGet(r.ordered, pair.inverse))) {
        const from = linkName(v);
        if (from !== null) add(from, self);
      }
    }
  }
  return out;
}

/** The shortest cycle from `start` back to itself (`[start, …, start]`), neighbours in name order; null when none. */
export function cycleThrough(graph: ReadonlyMap<string, ReadonlySet<string>>, start: string): string[] | null {
  const prev = new Map<string, string>();
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of [...(graph.get(u) ?? [])].sort()) {
      if (v === start) {
        const chain = [u];
        while (chain[chain.length - 1] !== start) chain.push(prev.get(chain[chain.length - 1]!)!);
        return [...chain.reverse(), start];
      }
      if (!seen.has(v)) {
        seen.add(v);
        prev.set(v, u);
        queue.push(v);
      }
    }
  }
  return null;
}

export interface CycleOptions {
  /** Report only these rows (paths); omitted: every row on a cycle. */
  only?: ReadonlySet<string>;
  /** The table's rows before the change: a row already on a cycle of the same column then is left out. */
  before?: readonly AcyclicRow[];
  /** Only the pairs this column is part of (the acyclic column, or its inverse). */
  involving?: string;
  /** `write`: "would close a cycle in"; `check`: "is on a cycle in". */
  wording: "write" | "check";
}

/** The rows on a cycle of an acyclic column of the table whose rows are `rows`, code `cycle`, by path. */
export function acyclicViolations(columns: readonly ColumnSpec[], table: string, rows: readonly AcyclicRow[], opts: CycleOptions): RowViolations[] {
  const pairs = acyclicPairs(columns, table).filter((p) => opts.involving === undefined || p.column === opts.involving || p.inverse === opts.involving);
  const out = new Map<string, Violation[]>();
  const head = opts.wording === "write" ? "would close a cycle in" : "is on a cycle in";
  for (const pair of pairs) {
    const after = graphOf(pair, rows);
    const before = opts.before ? graphOf(pair, opts.before) : null;
    for (const r of [...rows].sort(byPath)) {
      if (opts.only && !opts.only.has(r.path)) continue;
      const name = basenameOf(r.path);
      const cycle = cycleThrough(after, name);
      if (cycle === null || (before !== null && cycleThrough(before, name) !== null)) continue;
      const v: Violation = { column: pair.column, code: "cycle", message: `${head} "${pair.column}" (${cycle.join(" → ")})` };
      out.set(r.path, [...(out.get(r.path) ?? []), v]);
    }
  }
  return [...out].map(([path, violations]) => ({ path, violations })).sort(byPath);
}

/** Tables with an acyclic column, own or inherited, per parsed model (a model never changes). */
const ACYCLIC_TABLES = new WeakMap<Metastore, ReadonlySet<string>>();

function acyclicTables(model: Metastore): ReadonlySet<string> {
  let out = ACYCLIC_TABLES.get(model);
  if (!out) {
    const set = new Set<string>();
    const has = (cols: readonly Record<string, unknown>[]) => cols.some((c) => c.acyclic === true);
    for (const { ref, entry } of catalogTables(model)) {
      // a parsed metastore names known bases, without cycles: the chain is always there
      const bases = baseChain(model.bases, (entry.bases as string[] | undefined) ?? []);
      if (has(entry.columns) || bases.some((b) => has(model.bases[b]!.columns))) set.add(ref.full);
    }
    ACYCLIC_TABLES.set(model, (out = set));
  }
  return out;
}

interface Touched {
  /** Its path in the change set (the path violations are reported under). */
  path: string;
  /** Its path once the change set's moves are applied. */
  final: string;
  before: OrderedFrontmatter | null;
  after: OrderedFrontmatter;
}

/**
 * The cycles a row change set (its inverse-link edits included) closes through the acyclic columns
 * of the tables it writes rows of, reported under the path each written row has in the change set.
 * Schema changes (the change set rewrites metastore.yaml) check their rows themselves.
 */
export async function changeSetCycles(app: App, settings: DatanotesSettings, cs: ChangeSet): Promise<RowViolations[]> {
  if (cs.texts.some((t) => t.path === metastorePath(settings))) return [];
  // a row write loaded its table first: the metastore exists
  const model = cachedMetastore(app, settings) ?? (await loadMetastore(app, settings))!.model;
  const tables = acyclicTables(model);
  if (tables.size === 0) return [];
  const keep = new Set([settings.tableKey]);
  const tableOf = (o: OrderedFrontmatter) => rowTableFull(model, fmGet(o, settings.tableKey));
  const moved = new Map(cs.moves.map((m) => [m.from, m.to]));
  const created = cs.creates.map((c) => ({ path: c.path, ordered: readOrderedFromMarkdown(c.content, keep).ordered }));
  const touched = new Map<string, Touched[]>();
  const note = (full: string | null, x: Touched) => {
    if (full === null || !tables.has(full)) return;
    touched.set(full, [...(touched.get(full) ?? []), x]);
  };
  for (const e of cs.edits) note(tableOf(e.after), { path: e.path, final: moved.get(e.path) ?? e.path, before: e.before, after: e.after });
  for (const c of created) note(tableOf(c.ordered), { path: c.path, final: c.path, before: null, after: c.ordered });
  if (touched.size === 0) return [];
  return phase("engine.checks", async () => {
    const out: RowViolations[] = [];
    for (const [full, list] of [...touched].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const t = await loadTable(app, settings, full);
      const pairs = acyclicPairs(t.def.columns, full);
      const cols = pairs.flatMap((p) => (p.inverse === null ? [p.column] : [p.column, p.inverse]));
      const value = (o: OrderedFrontmatter | null, c: string) => JSON.stringify(o === null ? null : (fmGet(o, c) ?? null));
      if (!list.some((x) => cols.some((c) => value(x.before, c) !== value(x.after, c)))) continue;
      const before: AcyclicRow[] = (await loadRows(app, settings, t)).map((r) => ({ path: r.file.path, ordered: r.ordered }));
      const after = new Map(before.map((r) => [r.path, r.ordered]));
      for (const e of cs.edits) {
        if (tableOf(e.after) === full) after.set(e.path, e.after);
        else after.delete(e.path); // moved to another table (move_rows), or not a row of it
      }
      const archive = `${t.def.layout.archive}/`;
      for (const m of cs.moves) {
        const o = after.get(m.from);
        if (o === undefined) continue;
        after.delete(m.from);
        if (!m.to.startsWith(archive)) after.set(m.to, o);
      }
      for (const p of cs.deletes) after.delete(p);
      for (const c of created) if (tableOf(c.ordered) === full) after.set(c.path, c.ordered);
      const reportAs = new Map(list.filter((x) => after.has(x.final)).map((x) => [x.final, x.path]));
      const found = acyclicViolations(t.def.columns, full, [...after].map(([path, ordered]) => ({ path, ordered })), {
        only: new Set(reportAs.keys()),
        before,
        wording: "write",
      });
      for (const v of found) out.push({ path: reportAs.get(v.path)!, violations: v.violations });
    }
    return out;
  }, { "datanotes.checks.kind": "acyclic" });
}
