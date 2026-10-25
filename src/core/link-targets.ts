/**
 * Filtered link columns (`ref_where` / `ref_by`): the rule that checks a row's links against the
 * filter, on the vault or on the state a change set leaves, and list_link_targets, the valid targets of
 * a link column for a row.
 */

import type { App } from "./host";
import type { CatalogRef } from "./metastore";
import { loadRows, loadTable, OperationInputError, type LoadedRow, type LoadedTable, type RowViolations } from "./engine";
import { fmGet, fmSet } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { traced } from "./telemetry";
import type { ColumnSpec, TableColumn, Violation } from "./types-table";
import type { OrderedFrontmatter } from "./types";
import { isEmptyValue, linkNoteName, parseWikilink } from "./validate";
import { basenameOf } from "./path-templates";
import { compileWhere, rowGetter, type Where } from "./where";
import { CheckLinks, refLinkColumn, tableIn, type MetastoreState } from "./check-links";
import { guide, guidanceOf } from "./hints";
import { assertTableReadable, currentReadScope, tableReadable } from "./read-scope";

// --- Filtered link targets (ref_where / ref_by) ---

/** How many valid targets a refusal names. */
const VALID_TARGETS_SHOWN = 20;

/** Link columns of `t` whose targets are filtered (`ref_where` / `ref_by`). */
export function filteredLinkColumns(t: LoadedTable): TableColumn[] {
  return t.def.columns.filter((c) => (c.ref_where !== undefined || c.ref_by !== undefined) && refLinkColumn(t, c.name) !== undefined);
}

/** What a row's `ref_by` value asks of its link: nothing (no ref_by, or no value), an empty link, or targets with these values. */
type LevelDemand = { kind: "any" } | { kind: "unknown"; value: string } | { kind: "empty"; value: string } | { kind: "targets"; value: string; allowed: readonly string[] };

function levelDemand(c: ColumnSpec, ordered: OrderedFrontmatter): LevelDemand {
  const by = c.ref_by;
  const v = by ? fmGet(ordered, by.column) : undefined;
  if (!by || isEmptyValue(v)) return { kind: "any" };
  const value = String(v);
  if (!Object.prototype.hasOwnProperty.call(by.map, value)) return { kind: "unknown", value };
  const allowed = by.map[value];
  return allowed === null || allowed === undefined ? { kind: "empty", value } : { kind: "targets", value, allowed };
}

/** Paths sorted by row name, then path (rows of the same name in different folders stay apart). */
export function byName(a: string, b: string): number {
  return basenameOf(a).localeCompare(basenameOf(b)) || a.localeCompare(b);
}

/**
 * The rule of one filtered link column, on the rows `links` holds (by path): `valid(demand)` tests
 * a target row, `targets(demand)` gives the paths of the valid ones (sorted by name), `check(row)`
 * gives the row's violations: `required` when its `ref_by` level needs a link it lacks, `ref` for
 * a link to a row the filter refuses (the message lists the valid targets, at most
 * {@link VALID_TARGETS_SHOWN}), for a link to the row itself (list_link_targets never offers it), for a
 * link on a top level, or for a `ref_by` value with no entry in the map; `broken_link` for a link to no
 * row of the linked table (as in a CHECK that follows links, a missing row fails: deleting a target
 * with on_referenced `ignore`, or undoing its insert, is refused). Links are resolved as the host
 * resolves them (see {@link CheckLinks.resolve}). Throws when `ref_where` is not a valid filter or
 * the column's `ref` is not a table.
 */
async function linkTargetRule(t: LoadedTable, settings: DatanotesSettings, links: CheckLinks, c: TableColumn, loadSource = true) {
  const { table: target, rows } = await links.linked(t, c.name, loadSource);
  if (c.ref_where) await links.prepare(target, c.ref_where);
  const matches = c.ref_where ? compileWhere(c.ref_where as Where, target, settings, rowGetter(null, target, settings), links) : () => true;
  const by = c.ref_by;
  const tcol = by ? by.target_column ?? by.column : "";
  const valid = (d: LevelDemand) => (r: LoadedRow) =>
    matches(r) && (d.kind !== "targets" || d.allowed.includes(String(fmGet(r.ordered, tcol) ?? "")));
  const cache = new Map<string, string[]>();
  const targets = (d: LevelDemand): string[] => {
    const key = d.kind === "targets" ? d.value : "";
    if (!cache.has(key)) cache.set(key, [...rows].filter(([, r]) => valid(d)(r)).map(([p]) => p).sort(byName));
    return cache.get(key)!;
  };
  const needs = (d: LevelDemand): string => {
    const parts = [
      ...(d.kind === "targets" ? [`${tcol} ${d.allowed.join(" or ")}`] : []),
      ...(c.ref_where ? [`ref_where ${JSON.stringify(c.ref_where)}`] : []),
    ];
    return parts.join(" and ");
  };
  const list = c.type === "list";
  /** "a parent", or "a target in projects" for a list of links. */
  const aTarget = list ? `a target in ${c.name}` : `a ${c.name}`;
  const check = (row: LoadedRow): Violation[] => {
    const v = fmGet(row.ordered, c.name);
    const given = (Array.isArray(v) ? v : [v]).filter((x) => !isEmptyValue(x));
    const paths = given.map((x) => links.resolve(x, row.file.path));
    const d = levelDemand(c, row.ordered);
    const of = d.kind === "any" ? "" : ` for ${by!.column} "${d.value}"`;
    if (d.kind === "unknown") {
      return [{ column: c.name, code: "ref", message: `${by!.column} "${d.value}" has no entry in ref_by of ${c.name} (it has: ${Object.keys(by!.map).join(", ")})`, value: d.value }];
    }
    if (d.kind === "empty") {
      return paths.length === 0 ? [] : [{ column: c.name, code: "ref", message: `must be empty${of}: it is a top level (no ${c.name})`, value: v }];
    }
    if (d.kind === "targets" && paths.length === 0) {
      return [{ column: c.name, code: "required", message: `is required${of}: it needs ${aTarget} with ${needs(d)}` }];
    }
    const out: Violation[] = [];
    const shown = () => {
      // under a read scope that may not read the linked table (or a table its filter reads), the
      // valid targets are not named: they are rows the token may not read (Postgres CVE-2014-8161)
      const scope = currentReadScope();
      if (scope && [target.catalog.ref.full, ...links.reads(target, c.ref_where)].some((full) => !tableReadable(full, scope))) {
        return `the link must name a row of ${c.name}'s target table`;
      }
      const ok = targets(d).filter((p) => p !== row.file.path).map(basenameOf);
      return `valid: ${ok.length === 0 ? "none" : `${ok.slice(0, VALID_TARGETS_SHOWN).join(", ")}${ok.length > VALID_TARGETS_SHOWN ? ` (+${ok.length - VALID_TARGETS_SHOWN} more)` : ""}`}`;
    };
    const missing = given.filter((_, i) => paths[i] == null || !rows.has(paths[i]!)).map((x) => `[[${linkNoteName(x) ?? basenameOf(String(x))}]]`);
    if (missing.length > 0) {
      out.push({ column: c.name, code: "broken_link", message: `${missing.join(", ")} ${missing.length > 1 ? "are not rows" : "is not a row"} of ${target.catalog.ref.full}; ${shown()}`, value: v });
    }
    if (paths.includes(row.file.path)) {
      out.push({ column: c.name, code: "ref", message: `${list ? `${c.name} cannot hold` : `a ${c.name} cannot be`} the row itself`, value: v });
    }
    const bad = paths.filter((p): p is string => {
      const r = p == null || p === row.file.path ? undefined : rows.get(p);
      return r !== undefined && !valid(d)(r);
    });
    if (bad.length > 0) {
      const what = list ? `${bad.length > 1 ? "are not valid targets" : "is not a valid target"} in ${c.name}` : `is not a valid ${c.name}`;
      out.push({ column: c.name, code: "ref", message: `${bad.map((p) => `[[${basenameOf(p)}]]`).join(", ")} ${what}${of} (needs ${needs(d)}); ${shown()}`, value: v });
    }
    return out;
  };
  return { target, rows, valid, targets, check };
}

/**
 * The rule of a filtered link column, or a function giving one `ref` violation when it cannot be
 * checked (its `ref_where` is invalid, or its `ref` is not a table).
 */
export async function linkTargetCheck(t: LoadedTable, settings: DatanotesSettings, links: CheckLinks, c: TableColumn): Promise<(row: LoadedRow) => Violation[]> {
  try {
    await links.linked(t, c.name);
  } catch (e) {
    /* v8 ignore next -- defensive: a link that cannot be followed raises OperationInputError; anything else goes up */
    if (!(e instanceof OperationInputError)) throw e;
    const message = `${c.name} cannot be checked: ${e.message}`;
    return () => [{ column: c.name, code: "ref", message }];
  }
  let message: string;
  try {
    return (await linkTargetRule(t, settings, links, c)).check;
  } catch (e) {
    /* v8 ignore next -- defensive: a bad ref_where raises OperationInputError; anything else goes up */
    if (!(e instanceof OperationInputError)) throw e;
    message = `ref_where of ${c.name} is invalid: ${e.message}`;
  }
  return () => [{ column: c.name, code: "ref", message }];
}

/**
 * Filtered link columns on the state a change set leaves, like {@link linkedCheckViolations}: rows
 * the change set writes are checked in full; the other rows of a table whose link column reads a
 * table the change set changes are checked again, and refused only when the change breaks them
 * (changing a project's kind re-checks the workstreams under it).
 */
export async function linkTargetViolations(
  app: App,
  settings: DatanotesSettings,
  tables: readonly { ref: CatalogRef }[],
  written: ReadonlyMap<string, string>,
  consequential: ReadonlySet<string>,
  after: CheckLinks,
  before: CheckLinks,
  add: (path: string, v: Violation) => void,
  suffix: (r: LoadedRow, columns: readonly string[], own?: string) => string,
  renewed: ReadonlySet<string> = new Set(),
  metastore?: MetastoreState,
  validated = true,
): Promise<void> {
  for (const { ref } of tables) {
    const s = await tableIn(app, settings, metastore, ref.full);
    for (const c of filteredLinkColumns(s)) {
      // a filter the change puts back holds every row, like alter_column
      const restored = renewed.has(`${ref.full}|${c.name}`);
      let affected = restored;
      try {
        const { table: target } = await after.linked(s, c.name);
        if (c.ref_where) await after.prepare(target, c.ref_where);
        affected ||= [target.catalog.ref.full, ...after.reads(target, c.ref_where)].some((full) => after.changes(full));
      } catch (e) {
        // the ref is not a table: only rows written are told
        /* v8 ignore next -- defensive: a ref that is not a table raises OperationInputError; anything else goes up */
        if (!(e instanceof OperationInputError)) throw e;
      }
      const rows = after.rowsOf(s);
      if (!affected && !rows.some((r) => written.has(r.file.path))) continue;
      const check = await linkTargetCheck(s, settings, after, c);
      let passed: ((row: LoadedRow) => Violation[]) | undefined;
      for (const r of rows) {
        const own = written.get(r.file.path);
        if (own === undefined && !affected) continue;
        const vs = check(r);
        if (vs.length === 0) continue;
        if (own !== undefined) {
          const tail = consequential.has(own) ? suffix(r, [c.name], own) : "";
          // a row the operation validated had its links to no row reported there
          for (const v of vs) if (!validated || consequential.has(own) || v.code !== "broken_link") add(own, { ...v, message: `${v.message}${tail}` });
          continue;
        }
        if (restored) {
          for (const v of vs) add(r.file.path, { ...v, message: `${v.message} (the ref_where / ref_by of ${c.name} comes back with this change)` });
          continue;
        }
        // not written by this change: refused only when the change breaks it
        passed ??= await linkTargetCheck(s, settings, before, c);
        if (passed(r).length === 0) {
          const tail = suffix(r, [c.name]);
          for (const v of vs) add(r.file.path, { ...v, message: `${v.message}${tail}` });
        }
      }
    }
  }
}

/**
 * add_column / alter_column: the rows of `t` that a filtered link column `name` refuses, with the
 * table's columns as `columns` define them (the new or changed one included).
 */
export async function columnTargetViolations(app: App, settings: DatanotesSettings, t: LoadedTable, columns: readonly ColumnSpec[], name: string): Promise<RowViolations[]> {
  const full = t.catalog.ref.full;
  const def = { ...t.def, columns: columns.map((c) => ({ dense: false, ...c, ...(c.ref === "self" ? { ref: full } : {}) })) };
  const tt: LoadedTable = { ...t, def };
  const c = def.columns.find((x) => x.name === name);
  if (!c || (c.ref_where === undefined && c.ref_by === undefined)) return [];
  let rule: Awaited<ReturnType<typeof linkTargetRule>>;
  try {
    rule = await linkTargetRule(tt, settings, new CheckLinks(app, settings), c);
  } catch (e) {
    /* v8 ignore next -- defensive: a bad ref_where raises OperationInputError; anything else goes up unchanged */
    if (!(e instanceof OperationInputError)) throw e;
    throw new OperationInputError(`ref_where of ${name}: ${e.message}`, guidanceOf(e));
  }
  return (await loadRows(app, settings, tt))
    .map((r) => ({ path: r.file.path, violations: rule.check(r) }))
    .filter((x) => x.violations.length > 0);
}

// --- list_link_targets ---

export interface LinkOptionsInput {
  table: string;
  /** A link column (or list of links) with `ref`. */
  column: string;
  /** The row the link is for: its path, a link to it, or its file name. Its values are read first. */
  row?: string;
  /** Values of the row (a new one, or changes to `row`): e.g. `{kind: "workstream"}`. */
  values?: Record<string, unknown>;
  /** At most this many targets (default 50, at most 500). */
  limit?: number;
}

export interface LinkOptionsResult {
  table: string;
  column: string;
  /** The table the column links to. */
  ref: string;
  /** True when the row must have a link (`ref_by` level with targets, or a required column). */
  required: boolean;
  /** True when the link must stay empty (`ref_by` top level). */
  empty: boolean;
  /** Why the targets are what they are (the filter and the level), for agents. */
  reason: string;
  /** The valid targets, by name (the row itself left out). */
  rows: Record<string, unknown>[];
  /** How many targets are valid in all. */
  total: number;
}

/**
 * The row `ref` names: its path, a link to it (by path or name) or its file name. A name that
 * rows in different folders share is refused, listing them (give the path).
 */
function findRow(rows: readonly LoadedRow[], ref: string, table: string): LoadedRow | undefined {
  const given = ref.trim();
  // a link into a pack of rows ([[pack#row]]) names the row
  const path = parseWikilink(given);
  const named = linkNoteName(given);
  const want = (path !== null && named !== null && named !== basenameOf(path) ? named : path ?? given).replace(/^\/+/, "").replace(/\.md$/i, "");
  const stem = (r: LoadedRow) => r.file.path.replace(/\.md$/i, "");
  const byPath = rows.find((r) => r.file.path === given || stem(r) === want);
  if (byPath) return byPath;
  const hits = want.includes("/") ? rows.filter((r) => stem(r).endsWith(`/${want}`)) : rows.filter((r) => basenameOf(r.file.path) === want);
  if (hits.length > 1) {
    throw new OperationInputError(
      `${JSON.stringify(ref)} names ${hits.length} rows of ${table}: give the path of one (${hits.map((r) => r.file.path).join(", ")})`,
      guide(`Give "row" as the vault path of one of them, e.g. "${hits[0]!.file.path}".`, "linkTargets"),
    );
  }
  return hits[0];
}

async function linkOptionsImpl(app: App, settings: DatanotesSettings, input: LinkOptionsInput): Promise<LinkOptionsResult> {
  const t = await loadTable(app, settings, input.table);
  assertTableReadable(t.catalog.ref.full);
  const c = refLinkColumn(t, input.column);
  if (!c) {
    const links = t.def.columns.filter((x) => refLinkColumn(t, x.name)).map((x) => x.name);
    throw new OperationInputError(
      `"${input.column}" is not a link column with ref in ${t.catalog.ref.full}`,
      guide(
        `list_link_targets lists the targets of a link column with a ref; ${links.length > 0 ? `those of ${t.catalog.ref.full} are: ${links.join(", ")}` : `${t.catalog.ref.full} has none`}. describe_table shows each column's type and ref.`,
        "linkTargets",
      ),
    );
  }
  if (input.limit !== undefined && input.limit !== null && !(Number.isInteger(input.limit) && input.limit >= 1)) {
    throw new OperationInputError(`"limit" must be a positive integer (at most 500), not ${JSON.stringify(input.limit)}`, guide(`Pass "limit" between 1 and 500, or leave it out (50).`, "linkTargets"));
  }
  const limit = Math.min(input.limit ?? 50, 500);
  const links = new CheckLinks(app, settings);
  const given = input.row !== undefined && input.row !== null && String(input.row).trim() !== "";
  // the table's own rows are read only for the row asked about (or when the column links to the table itself)
  const rule = await linkTargetRule(t, settings, links, c, given);
  // the targets are rows of the linked table, picked by a filter that may read other tables: the
  // token must read them all
  if (currentReadScope()) {
    for (const full of [rule.target.catalog.ref.full, ...links.reads(rule.target, c.ref_where)]) assertTableReadable(full);
  }
  let ordered: OrderedFrontmatter = [];
  let self: string | undefined;
  if (given) {
    const row = findRow(links.rowsOf(t), String(input.row), t.catalog.ref.full);
    if (!row) throw new OperationInputError(`no row of ${t.catalog.ref.full} is ${JSON.stringify(input.row)}`, guide(`Give "row" as the vault path or the note name of a row of ${t.catalog.ref.full} (select_rows lists them with their path), or leave it out.`, "linkTargets"));
    ordered = row.ordered;
    self = row.file.path;
  }
  for (const [k, v] of Object.entries(input.values ?? {})) ordered = fmSet(ordered, k, v);
  const d = levelDemand(c, ordered);
  const by = c.ref_by;
  const tcol = by ? by.target_column ?? by.column : undefined;
  const base = { table: t.catalog.ref.full, column: c.name, ref: rule.target.catalog.ref.full };
  if (d.kind === "unknown") {
    const reason = `${by!.column} "${d.value}" has no entry in ref_by of ${c.name} (it has: ${Object.keys(by!.map).join(", ")}): no target is valid`;
    return { ...base, required: false, empty: false, reason, rows: [], total: 0 };
  }
  if (d.kind === "empty") {
    return { ...base, required: false, empty: true, reason: `${by!.column} "${d.value}" is a top level: ${c.name} must be empty`, rows: [], total: 0 };
  }
  const paths = rule.targets(d).filter((p) => p !== self);
  const reason = [
    ...(by && d.kind === "any" ? [`no ${by.column} given: every level's targets (ref_by on ${by.column} picks them)`] : []),
    ...(d.kind === "targets" ? [`${by!.column} "${d.value}" needs ${tcol} ${d.allowed.join(" or ")}`] : []),
    ...(c.ref_where ? [`ref_where ${JSON.stringify(c.ref_where)}`] : []),
  ].join("; ");
  const rows = paths.slice(0, limit).map((p) => {
    const r = rule.rows.get(p)!;
    const n = basenameOf(p);
    return {
      name: n,
      link: `[[${p.replace(/\.md$/i, "")}|${n}]]`,
      path: p,
      ...(tcol !== undefined ? { [tcol]: fmGet(r.ordered, tcol) ?? null } : {}),
    };
  });
  return { ...base, required: d.kind === "targets" || c.required, empty: false, reason: reason || "every row of the linked table", rows, total: paths.length };
}

/** The valid targets of a link column for a row (ref_where / ref_by applied): for agents and pickers. Read-only. */
export function linkOptions(app: App, settings: DatanotesSettings, input: LinkOptionsInput): Promise<LinkOptionsResult> {
  return traced(
    "datanotes list_link_targets",
    { "datanotes.op": "list_link_targets", table: input.table, column: input.column },
    () => linkOptionsImpl(app, settings, input),
    (r) => ({ severity: "INFO", attributes: { total: r.total } }),
  );
}
