/**
 * Row operations (phase 34): insert_row, merge_rows, recompute_columns, update_rows, update_row and
 * delete_rows (archive by default). Writes go through the same change-set / journal / undo
 * machinery as DDL.
 */

import { existingPathIgnoringCase, unsafeVaultPath } from "./vault-path";
import type { App, TFile } from "./host";
import { emptyChangeSet } from "./changeset";
import { isUuid } from "./uuid";
import { appendBody, prependBody, setSection } from "./body";
import { cachedMetastore, rowTableFull } from "./metastore";
import {
  archiveFolder,
  finish,
  instrumented,
  emptyResult,
  loadRows,
  loadRowsWhere,
  loadTable,
  memberEntry,
  OperationInputError,
  rowBody,
  type LoadedRow,
  type LoadedTable,
  type OpConflict,
  type OpResult,
  type RowViolations,
  type RunOptions,
  uniqueViolations,
} from "./engine";
import {
  buildMarkdownWithFrontmatter,
  fmDelete,
  fmGet,
  fmSet,
  readOrderedFromMarkdown,
} from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { validationContextFor } from "./table-registry";
import { closestNames, GENERATED_HINT, guide, unknownName, unknownWriteColumn } from "./hints";
import { resolveDefault } from "./datetime";
import { SYSTEM_ID_COLUMN, type TableColumn, type Violation } from "./types-table";
import { readDatabaseConfig } from "./database";
import type { OrderedFrontmatter } from "./types";
import {
  isEmptyValue,
  parseWikilink,
  validateRow,
  requiredMessage,
  validateValue,
} from "./validate";
import { basenameOf, claimFreeName, renderPathTemplate, renderRowTemplate } from "./path-templates";
import { computedColumnNames, fileCreated, normalizeDatetimes, withGenerated, withIdentity } from "./computed-columns";
import { compileWhere, knownKeys, resolveWithin, type Where } from "./where";
import { constraintViolations, hierarchyViolations } from "./row-checks";
import { linkedCheckViolations, pathHidden } from "./changeset-checks";
import { autolinkFragments, autolinkOn, withLinkReport, type AutolinkReport } from "./autolink";
import { uniqueValues } from "./unique-index";

// --- insert_row ---

export interface InsertRowInput {
  table: string;
  values: Record<string, unknown>;
  body?: string;
  /** Explicit vault path; otherwise computed from `_table.path` / `_table.filename`. */
  path?: string;
  /** Link the notes `body` mentions (autolink.ts); default: the database's `autolink` setting. */
  autolink?: boolean;
}

/** Body of a new row when none is given: the table's `row_template` (metastore.yaml), else empty. */
function rowTemplate(t: LoadedTable, values: ReadonlyMap<string, unknown>): string {
  const tpl = t.catalog.entry.row_template;
  if (typeof tpl !== "string" || tpl.trim() === "") return "\n";
  return renderRowTemplate(tpl, values);
}

interface PlannedInsert {
  path: string;
  ordered: OrderedFrontmatter;
  conflicts: OpConflict[];
  violations: Violation[];
}

/** Compute a new row: defaults, generated and identity columns, its path (`-2`, `-3` when taken) and violations. */
function planInsert(
  app: App,
  settings: DatanotesSettings,
  t: LoadedTable,
  input: { values: Record<string, unknown>; path?: string },
  env: { now: Date; tz: string; taken?: ReadonlySet<string> },
): PlannedInsert {
  const known = knownKeys(t, settings);
  known.delete("path");
  known.delete(settings.tableKey);
  for (const k of Object.keys(input.values)) {
    if (!known.has(k)) throw new OperationInputError(`unknown column "${k}" for table "${t.def.name}"`, unknownWriteColumn(k, [...known], t.catalog.ref.full));
  }
  const computed = computedColumnNames(t);
  // A file-name identity column may be given: it names the new note (then holds the name it got).
  for (const c of t.def.columns) if (c.identity === "filename") computed.delete(c.name);
  for (const k of Object.keys(input.values)) {
    if (computed.has(k)) throw new OperationInputError(`"${k}" is a generated column: its value is computed`, GENERATED_HINT);
  }
  const specByName = new Map<string, TableColumn>(t.def.columns.map((c) => [c.name, c]));
  const { now, tz } = env;
  // a name taken in another case is taken: one file on Windows and macOS, a collision once synced there
  const takenNow = new Map([...(env.taken ?? [])].map((p) => [p.toLowerCase(), p]));
  const takenBy = (p: string): string | null => existingPathIgnoringCase(app, p) ?? takenNow.get(p.toLowerCase()) ?? null;
  const isTaken = (p: string) => takenBy(p) !== null;
  let ordered: OrderedFrontmatter = [memberEntry(settings, t)];
  // Dense/untyped fields in schema order, then sparse columns in declaration order.
  const schemaKeys = t.ordered.map(([k]) => k).filter((k) => known.has(k));
  for (const k of schemaKeys) {
    const given = Object.prototype.hasOwnProperty.call(input.values, k);
    let v: unknown = given ? input.values[k] : resolveDefault(specByName.get(k)?.default ?? fmGet(t.ordered, k), now, tz);
    ordered = fmSet(ordered, k, v === undefined ? null : v);
  }
  for (const c of t.def.columns) {
    if (c.dense) continue;
    const given = Object.prototype.hasOwnProperty.call(input.values, c.name);
    const v = given ? input.values[c.name] : resolveDefault(c.default, now, tz);
    if (!isEmptyValue(v)) ordered = fmSet(ordered, c.name, v);
  }
  ordered = normalizeDatetimes(t.def.columns, ordered, tz);
  if (input.path != null) {
    const why = unsafeVaultPath(input.path);
    if (why) throw new OperationInputError(`path "${input.path}": ${why}; a row's path stays inside the vault`, guide(`Give "path" relative to the vault, e.g. "Films/Metropolis.md", or leave it out to let the table's filename pattern name the note.`, "folders"));
  }
  ordered = withGenerated(t, settings, ordered, input.path ?? "");
  const values = new Map(ordered);
  let path = input.path;
  if (path == null) {
    if (!t.def.options.filename) {
      throw new OperationInputError(`table "${t.def.name}" has no filename pattern; pass "path"`, guide(`Pass "path" (e.g. "Films/Metropolis.md"), or give the table a filename pattern: alter_table with filename "{title}".`, "folders"));
    }
    const base = `${renderPathTemplate(t.def.layout.rowPath, values)}/${renderPathTemplate(t.def.options.filename, values)}`;
    // Two rows computing the same name (e.g. two readings in the same minute) get -2, -3, …
    path = claimFreeName(base, isTaken);
  } else if (!path.endsWith(".md")) {
    path = `${path}.md`;
  }
  const conflicts: OpConflict[] = [];
  const owner = takenBy(path);
  if (owner === path) conflicts.push({ path, message: "note already exists" });
  else if (owner !== null) conflicts.push({ path, message: `note already exists in another case: "${owner}" (one file on Windows and macOS)` });
  ordered = withIdentity(t, ordered, path, false, { now, tz });
  // again, now that identity columns (creation time, file name) and the path are known
  ordered = withGenerated(t, settings, ordered, path);
  const violations = [
    ...validateRow(t.def, ordered, { tableKey: settings.tableKey }, validationContextFor(app, settings, path)),
    ...constraintViolations(t, settings, path, ordered),
  ];
  return { path, ordered, conflicts, violations };
}

async function insertRowImpl(
  app: App,
  settings: DatanotesSettings,
  input: InsertRowInput,
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const cfg = await readDatabaseConfig(app, settings);
  const plan = planInsert(app, settings, t, input, { now: opts.now ?? new Date(), tz: cfg.timezone });
  const { path, ordered } = plan;
  const violations: RowViolations[] = [{ path, violations: plan.violations }];
  if (t.def.columns.some((c) => c.unique)) {
    // the rows' unique values from the vault index (unique-index.ts), else every row read
    const index = await uniqueValues(app, settings, t);
    if (index && !index.has(path)) violations.push(...index.violationsOfNew(path, ordered));
    else {
      const existing = await loadRows(app, settings, t);
      violations.push(
        ...uniqueViolations(t.def.columns, [
          ...existing.map((r) => ({ path: r.file.path, ordered: r.ordered })),
          { path, ordered },
        ]).filter((u) => u.path === path),
      );
    }
  }
  const cs = emptyChangeSet("insert_row", `insert into ${t.def.name}`, t.def.schemaPath);
  // the text the caller writes links the notes it mentions; a table's row template is left as it is
  let body = input.body ?? rowTemplate(t, new Map(ordered));
  let links: AutolinkReport | null = null;
  if (typeof input.body === "string" && autolinkOn(input.autolink, cfg.autolink)) {
    const linked = await autolinkFragments(app, settings, { path, fragments: [input.body], body: input.body });
    body = linked.fragments[0]!;
    links = linked.report;
  }
  cs.creates.push({ path, content: buildMarkdownWithFrontmatter(ordered, body) });
  violations.push(...(await linkedCheckViolations(app, settings, cs)));
  return withLinkReport(await finish(app, settings, cs, plan.conflicts, violations, opts), links);
}

// --- merge_rows ---

export interface MergeRowsInput {
  table: string;
  /** Key columns: a source row matches the existing row with the same values in all of them. */
  on: string[];
  rows: Record<string, unknown>[];
  /** `update` (default): set the source values on the matched row. `ignore`: leave it. */
  whenMatched?: "update" | "ignore";
  /** `insert` (default): add the source row. `ignore`: skip it. */
  whenNotMatched?: "insert" | "ignore";
}

/**
 * MERGE INTO … USING rows ON key: upsert many rows in one journaled operation. A source row that
 * matches several rows, or repeats a key, is a conflict (nothing is written).
 */
const MERGE_HINT = guide(`Pass "on" (the key columns) and "rows" (objects with a value for every key column), e.g. on: ["title"], rows: [{"title": "Metropolis", "rating": 5}].`, "merge");

async function mergeRowsImpl(
  app: App,
  settings: DatanotesSettings,
  input: MergeRowsInput,
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  if (!Array.isArray(input.on) || input.on.length === 0) throw new OperationInputError(`"on" needs at least one key column`, MERGE_HINT);
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new OperationInputError(`"rows" needs at least one row`, MERGE_HINT);
  const known = knownKeys(t, settings);
  for (const c of input.on) {
    if (!known.has(c) || c === "path") throw new OperationInputError(`unknown key column "${c}"`, unknownName(c, [...known].filter((k) => k !== "path"), `columns of ${t.catalog.ref.full}`, "The key columns identify a row, e.g. on: [\"title\"].", "merge"));
  }
  const computed = computedColumnNames(t);
  const cfg = await readDatabaseConfig(app, settings);
  const env = { now: opts.now ?? new Date(), tz: cfg.timezone, taken: new Set<string>() };
  const existing = await loadRows(app, settings, t);
  const keyOf = (get: (c: string) => unknown) => JSON.stringify(input.on.map((c) => get(c) ?? null));
  const index = new Map<string, LoadedRow[]>();
  for (const r of existing) {
    const k = keyOf((c) => fmGet(r.ordered, c));
    index.set(k, [...(index.get(k) ?? []), r]);
  }
  const specByName = new Map(t.def.columns.map((c) => [c.name, c]));
  const cs = emptyChangeSet("merge_rows", `merge ${input.rows.length} rows into ${t.def.name}`, t.def.schemaPath);
  const conflicts: OpConflict[] = [];
  const violations: RowViolations[] = [];
  const seen = new Set<string>();
  for (const [i, src] of input.rows.entries()) {
    if (!src || typeof src !== "object" || Array.isArray(src)) throw new OperationInputError(`rows[${i}] must be an object`, MERGE_HINT);
    for (const c of input.on) {
      if (isEmptyValue(src[c])) throw new OperationInputError(`rows[${i}] has no value for key column "${c}"`, MERGE_HINT);
    }
    // Keys compare like stored values: date-times completed with the database time zone.
    const normalized = new Map(normalizeDatetimes(t.def.columns, Object.entries(src), cfg.timezone));
    const key = keyOf((c) => normalized.get(c));
    if (seen.has(key)) {
      conflicts.push({ path: `rows[${i}]`, message: `repeats key ${key}` });
      continue;
    }
    seen.add(key);
    const matches = index.get(key) ?? [];
    if (matches.length > 1) {
      conflicts.push({ path: matches[0]!.file.path, message: `${matches.length} rows match key ${key}` });
      continue;
    }
    if (matches.length === 1) {
      if (input.whenMatched === "ignore") continue;
      const r = matches[0]!;
      let after = r.ordered;
      for (const [k, v] of normalized) {
        if (input.on.includes(k)) continue;
        if (!known.has(k) || k === "path" || k === settings.tableKey) {
          throw new OperationInputError(`unknown column "${k}" for table "${t.def.name}"`, unknownWriteColumn(k, [...known].filter((c) => c !== "path" && c !== settings.tableKey), t.catalog.ref.full));
        }
        if (computed.has(k)) throw new OperationInputError(`"${k}" is a generated column: its value is computed`, GENERATED_HINT);
        after = fmSet(after, k, v);
      }
      after = withGenerated(t, settings, after, r.file.path);
      if (JSON.stringify(after) === JSON.stringify(r.ordered)) continue;
      const ctx = validationContextFor(app, settings, r.file.path);
      const rowViolations = [...normalized.keys()].flatMap((k) => {
        const spec = specByName.get(k);
        const v = fmGet(after, k);
        if (!spec) return [];
        if (isEmptyValue(v)) return spec.required ? [{ column: k, code: "required" as const, message: requiredMessage(spec) }] : [];
        return validateValue(spec, v, ctx);
      });
      violations.push({ path: r.file.path, violations: [...rowViolations, ...constraintViolations(t, settings, r.file.path, after)] });
      cs.edits.push({ path: r.file.path, before: r.ordered, after });
      continue;
    }
    if (input.whenNotMatched === "ignore") continue;
    const plan = planInsert(app, settings, t, { values: src }, env);
    env.taken.add(plan.path);
    conflicts.push(...plan.conflicts);
    violations.push({ path: plan.path, violations: plan.violations });
    cs.creates.push({ path: plan.path, content: buildMarkdownWithFrontmatter(plan.ordered, rowTemplate(t, new Map(plan.ordered))) });
  }
  if (t.def.columns.some((c) => c.unique)) {
    const afterByPath = new Map(cs.edits.map((e) => [e.path, e.after]));
    const created = cs.creates.map((c) => ({ path: c.path, ordered: readOrderedFromMarkdown(c.content, new Set([settings.tableKey])).ordered }));
    const touched = new Set([...afterByPath.keys(), ...created.map((c) => c.path)]);
    violations.push(
      ...uniqueViolations(t.def.columns, [
        ...existing.map((r) => ({ path: r.file.path, ordered: afterByPath.get(r.file.path) ?? r.ordered })),
        ...created,
      ]).filter((u) => touched.has(u.path)),
    );
  }
  violations.push(...(await hierarchyViolations(app, settings, t, cs.edits.map((e) => ({ path: e.path, ordered: e.after })), existing)));
  violations.push(...(await linkedCheckViolations(app, settings, cs)));
  return finish(app, settings, cs, conflicts, violations, opts);
}

// --- recompute (generated / identity columns) ---

/**
 * Rows whose uuid id also belongs to an older row (a note duplicated in Obsidian copies its id):
 * the oldest note (creation time, then path) keeps it, the others get new ids.
 */
function duplicatedIds(t: LoadedTable, rows: readonly LoadedRow[]): Set<string> {
  const out = new Set<string>();
  /* v8 ignore next -- platform: a host without file stats (both hosts here give them) */
  const created = (r: LoadedRow) => (r.file as unknown as { stat?: { ctime?: number } }).stat?.ctime ?? 0;
  for (const c of t.def.columns) {
    if (c.identity !== "uuid") continue;
    const groups = new Map<string, LoadedRow[]>();
    for (const r of rows) {
      const v = fmGet(r.ordered, c.name);
      if (isUuid(v)) groups.set(v.toLowerCase(), [...(groups.get(v.toLowerCase()) ?? []), r]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => created(a) - created(b) || a.file.path.localeCompare(b.file.path));
      for (const r of group.slice(1)) out.add(r.file.path);
    }
  }
  return out;
}

/** Rows a recompute checks between two turns of the event loop. */
export const RECOMPUTE_YIELD = { rows: 500 };

/** Let timers and I/O run (the HTTP server answers, a client is not dropped) before going on. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface RecomputeInput {
  table: string;
  /** Only these rows (vault paths); default every row. */
  paths?: string[];
  /** Assign a new UUID to every uuid identity column in scope (one-time migrations). */
  newIds?: boolean;
}

/**
 * Bring generated and identity columns up to date on rows edited outside the plugin (a hand
 * edit of `surname` leaves `title = {name} {surname}` stale). No-op when nothing is stale.
 */
async function recomputeImpl(app: App, settings: DatanotesSettings, input: RecomputeInput, opts: RunOptions = {}): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const computed = computedColumnNames(t);
  const only = input.paths ? new Set(input.paths) : null;
  const cs = emptyChangeSet("recompute_columns", `recompute ${[...computed].join(", ")} of ${t.def.name}`, t.def.schemaPath);
  const violations: RowViolations[] = [];
  const specs = t.def.columns.filter((c) => computed.has(c.name));
  if (computed.size > 0) {
    const tz = (await readDatabaseConfig(app, settings)).timezone;
    const rows = await loadRows(app, settings, t);
    const duplicates = duplicatedIds(t, rows);
    let seen = 0;
    for (const r of rows) {
      if (only && !only.has(r.file.path)) continue;
      // a recompute of thousands of rows (a bulk edit outside the engine) lets the server answer meanwhile
      if (++seen % RECOMPUTE_YIELD.rows === 0) await yieldToEventLoop();
      const reassign = input.newIds === true || duplicates.has(r.file.path);
      const after = withIdentity(t, withGenerated(t, settings, r.ordered, r.file.path), r.file.path, reassign, {
        now: opts.now ?? new Date(),
        tz,
        /* v8 ignore next -- platform: a host without file stats (both hosts here give them) */
        ...(fileCreated(app, r.file.path) !== undefined ? { created: fileCreated(app, r.file.path)! } : {}),
      });
      if (JSON.stringify(after) === JSON.stringify(r.ordered)) continue;
      const ctx = validationContextFor(app, settings, r.file.path);
      violations.push({
        path: r.file.path,
        violations: specs.flatMap((c) => {
          const v = fmGet(after, c.name);
          return isEmptyValue(v) ? [] : validateValue(c, v, ctx);
        }),
      });
      cs.edits.push({ path: r.file.path, before: r.ordered, after });
    }
  }
  if (cs.edits.length === 0) return { ...emptyResult("recompute_columns", opts.dryRun === true), ok: true };
  violations.push(...(await linkedCheckViolations(app, settings, cs)));
  return finish(app, settings, cs, [], violations, opts);
}

export const recomputeColumns = instrumented("recompute_columns", recomputeImpl, (i) => ({ table: i.table, rows: i.paths?.length }));

// --- update_rows ---

export interface UpdateRowsInput {
  table: string;
  where?: Where;
  set?: Record<string, unknown>;
  unset?: string[];
  /** Refuse (a conflict, nothing written) unless `where` matches exactly this many rows. */
  expectCount?: number;
}

/**
 * update_row's new body, linked once the row's final path is known: a write that renames the note
 * links from the new path.
 */
type BodyFor = (finalPath: string, oldPath: string) => Promise<{ body: string; report: AutolinkReport | null }>;

async function updateRowsImpl(
  app: App,
  settings: DatanotesSettings,
  input: UpdateRowsInput,
  opts: RunOptions = {},
  bodyFor?: BodyFor,
  /** The operation the journal records: update_row runs as this too. */
  op: "update_rows" | "update_row" = "update_rows",
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const known = knownKeys(t, settings);
  known.delete("path");
  known.delete(settings.tableKey);
  const set = input.set ?? {};
  const unset = input.unset ?? [];
  if (Object.keys(set).length === 0 && unset.length === 0 && !bodyFor) {
    throw new OperationInputError(
      op === "update_row" ? `nothing to update: pass "set", "unset", "body" or a part of the body` : `nothing to update: pass "set" or "unset"`,
      op === "update_row"
        ? guide(`Pass set (an object of column: value), unset (a list of columns), body, body_sections, body_prepend or body_append.`, "updateRow")
        : guide(`Pass set (an object of column: value) or unset (a list of columns); a note's text changes with update_row.`, "updateRows"),
    );
  }
  for (const k of Object.keys(set)) {
    if (!known.has(k)) throw new OperationInputError(`unknown column "${k}" for table "${t.def.name}"`, unknownWriteColumn(k, [...known], t.catalog.ref.full));
  }
  // `unset` may also remove keys that are not columns (strays check_table reports as unknown_column,
  // e.g. a timestamp another plugin added); only the table membership key is protected.
  for (const k of unset) {
    if (k === settings.tableKey || k === "path") throw new OperationInputError(`cannot unset "${k}"`, guide(`A row keeps its "${settings.tableKey}" and its path: move_rows moves it to another table, delete_rows deletes it.`, "moveRows"));
  }
  const computed = computedColumnNames(t);
  for (const k of [...Object.keys(set), ...unset]) {
    if (computed.has(k)) throw new OperationInputError(`"${k}" is a generated column: its value is computed`, GENERATED_HINT);
  }
  const specByName = new Map(t.def.columns.map((c) => [c.name, c]));
  const pred = compileWhere(await resolveWithin(app, settings, t, input.where), t, settings);
  const cfg = await readDatabaseConfig(app, settings);
  const tz = cfg.timezone;
  const cs = emptyChangeSet(op, `update ${t.def.name}`, t.def.schemaPath);
  let links: AutolinkReport | null = null;
  const violations: RowViolations[] = [];
  const all = await loadRows(app, settings, t);
  const matched = all.filter(pred);
  if (input.expectCount !== undefined && matched.length !== input.expectCount) {
    // a guard, as update_row's expect: refused as a conflict, nothing written
    const res = emptyResult(op, opts.dryRun === true);
    res.conflicts = [{ path: t.def.layout.folder, message: `"where" matched ${matched.length} rows, expected ${input.expectCount}: nothing was written` }];
    return res;
  }
  // Columns that name the file (`filename` / `path` placeholders): changing one renames the row,
  // with links following as for a rename in Obsidian, so a note's name never goes stale.
  const nameTemplate = t.def.options.filename ? `${t.def.layout.rowPath}/${t.def.options.filename}` : null;
  const nameCols = new Set([...(nameTemplate ?? "").matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)(?::[^}]+)?\}/g)].map((m) => m[1]!));
  const renames = [...Object.keys(set), ...unset].some((k) => nameCols.has(k));
  const movedTo = new Set<string>();
  for (const r of matched) {
    let finalPath = r.file.path;
    let after = r.ordered;
    for (const [k, v] of Object.entries(set)) after = fmSet(after, k, v);
    for (const k of unset) after = fmDelete(after, k);
    after = normalizeDatetimes(t.def.columns.filter((c) => c.name in set), after, tz);
    after = withGenerated(t, settings, after, r.file.path);
    if (renames && nameTemplate && !r.file.path.includes("/_archive/")) {
      let base: string | null = null;
      try {
        base = renderPathTemplate(nameTemplate, new Map(after));
      } catch {
        base = null; // a placeholder lost its value: the required-column check reports it
      }
      const current = r.file.path.replace(/\.md$/, "");
      if (base && current !== base && !current.startsWith(`${base}-`)) {
        // a name another note has in another case is taken too; this note's own, in any case, is not
        const taken = (p: string) => {
          const owner = existingPathIgnoringCase(app, p);
          return (owner !== null && owner !== r.file.path) || [...movedTo].some((m) => m.toLowerCase() === p.toLowerCase());
        };
        const to = claimFreeName(base, taken);
        if (!taken(to)) {
          after = withIdentity(t, after, to);
          // the old name stays findable, as when a table's layout changes
          const oldName = basenameOf(r.file.path);
          const newName = basenameOf(to);
          if (known.has("aliases") && oldName !== newName && !oldName.startsWith(newName)) {
            const cur = fmGet(after, "aliases");
            const list = Array.isArray(cur) ? cur : isEmptyValue(cur) ? [] : [cur];
            if (!list.includes(oldName)) after = fmSet(after, "aliases", [...list, oldName]);
          }
          cs.moves.push({ from: r.file.path, to });
          movedTo.add(to);
          finalPath = to;
        }
      }
    }
    const ctx = validationContextFor(app, settings, r.file.path);
    const rowViolations = [...Object.keys(set), ...unset].flatMap((k) => {
      const spec = specByName.get(k);
      if (!spec) return [];
      const v = fmGet(after, k);
      if (isEmptyValue(v)) return spec.required ? [{ column: k, code: "required" as const, message: requiredMessage(spec) }] : [];
      return validateValue(spec, v, ctx);
    });
    rowViolations.push(...constraintViolations(t, settings, r.file.path, after));
    violations.push({ path: r.file.path, violations: rowViolations });
    let body: { before: string; after: string } | undefined;
    if (bodyFor) {
      // linked as seen from where the note will be (a rename moves it)
      const own = await bodyFor(finalPath, r.file.path);
      body = { before: await rowBody(app, r), after: own.body };
      links = own.report; // update_row writes one row
    }
    cs.edits.push({
      path: r.file.path,
      before: r.ordered,
      after,
      ...(body ? { bodyBefore: body.before, bodyAfter: body.after } : {}),
    });
  }
  if (t.def.columns.some((c) => c.unique)) {
    const afterByPath = new Map(cs.edits.map((e) => [e.path, e.after]));
    const touched = new Set(afterByPath.keys());
    violations.push(
      ...uniqueViolations(
        t.def.columns,
        all.map((r) => ({ path: r.file.path, ordered: afterByPath.get(r.file.path) ?? r.ordered })),
      ).filter((u) => touched.has(u.path)),
    );
  }
  violations.push(...(await hierarchyViolations(app, settings, t, cs.edits.map((e) => ({ path: e.path, ordered: e.after })), all)));
  violations.push(...(await linkedCheckViolations(app, settings, cs)));
  return withLinkReport(await finish(app, settings, cs, [], violations, opts), links);
}

// --- update_row (one row, by id or path) ---

export interface UpdateRowInput {
  table: string;
  /** The row's system id … */
  id?: string;
  /** … or its vault path (with or without `.md`); when both are given they must name the same row. */
  path?: string;
  set?: Record<string, unknown>;
  unset?: string[];
  /** Replace the whole body. */
  body?: string;
  /** Replace the text under these headings (added as `## heading` when missing). */
  bodySections?: Record<string, string>;
  /** Add text before / after the current body. */
  bodyPrepend?: string;
  bodyAppend?: string;
  /**
   * Compare-and-set: the row must still have these values (same matching as `where`), or nothing
   * is written — e.g. `{ status: "open" }` when the agent read it open and a person may have closed it.
   */
  expect?: Record<string, unknown>;
  /** Link the notes the text written mentions (autolink.ts); default: the database's `autolink` setting. */
  autolink?: boolean;
}

const FIND_ROW_HINT = guide(`Name the row by its "path" (the vault path of its note, e.g. "Films/Metropolis.md") or its "id": select_rows with columns ["path", "id"] and a "where" finds them.`, "updateRow");

/** UPDATE of exactly one row: refused when the row does not exist. Same validation as update_rows. */
async function updateRowImpl(app: App, settings: DatanotesSettings, input: UpdateRowInput, opts: RunOptions = {}): Promise<OpResult> {
  if (input.id === undefined && input.path === undefined) throw new OperationInputError(`pass the row's "id" or "path"`, FIND_ROW_HINT);
  const partial = input.bodySections !== undefined || input.bodyPrepend !== undefined || input.bodyAppend !== undefined;
  if (input.body !== undefined && partial) {
    throw new OperationInputError(`"body" replaces the whole body: do not combine it with body_sections / body_prepend / body_append`, guide(`Pass either "body" (the whole text) or body_sections / body_prepend / body_append (parts of it).`, "editBody"));
  }
  const t = await loadTable(app, settings, input.table);
  const path = input.path === undefined ? undefined : input.path.endsWith(".md") ? input.path : `${input.path}.md`;
  const rows = await loadRows(app, settings, t);
  const byId = input.id === undefined ? null : rows.filter((r) => fmGet(r.ordered, SYSTEM_ID_COLUMN) === input.id);
  const row = byId ? byId[0] : rows.find((r) => r.file.path === path);
  if (byId && byId.length > 1) throw new OperationInputError(`id ${input.id} is used by ${byId.length} rows: run recompute_columns`, guide(`recompute_columns with new_ids: true gives the copies new ids; then update by "path".`, "generated"));
  if (!row) {
    // by note name, wherever the agent thinks the note is
    const byName = new Map(rows.map((r) => [basenameOf(r.file.path), r.file.path]));
    const near = path === undefined ? [] : closestNames(basenameOf(path), byName.keys()).map((n) => byName.get(n)!);
    throw new OperationInputError(
      `${t.def.name} has no row ${input.id !== undefined ? `with id ${input.id}` : `at ${path}`}`,
      guide(`${near.length > 0 ? `Did you mean ${near.map((n) => `"${n}"`).join(" or ")}? ` : ""}${FIND_ROW_HINT.hint}`, "updateRow"),
    );
  }
  if (path !== undefined && row.file.path !== path) {
    throw new OperationInputError(`id ${input.id} is the row at ${row.file.path}, not ${path}`, FIND_ROW_HINT);
  }
  if (input.expect && Object.keys(input.expect).length > 0) {
    const stale = Object.entries(input.expect).filter(([col, value]) => !compileWhere({ [col]: value } as Where, t, settings)(row));
    if (stale.length > 0) {
      const res = emptyResult("update_row", opts.dryRun === true);
      res.conflicts = stale.map(([col, value]) => ({
        path: row.file.path,
        message: `row changed: expected ${col} = ${JSON.stringify(value)}, found ${JSON.stringify(fmGet(row.ordered, col) ?? null)} — read it again`,
      }));
      return res;
    }
  }
  const linking = (input.body !== undefined || partial) && autolinkOn(input.autolink, (await readDatabaseConfig(app, settings)).autolink);
  // the body the parts are written into (the rows are read without their bodies)
  const current = partial ? await rowBody(app, row) : "";
  /** The new body, its texts linked as seen from the note's final path (a rename moves it). */
  const bodyFor: BodyFor = async (finalPath, oldPath) => {
    const self = { path: finalPath, self: [oldPath] };
    if (!partial) {
      const body = input.body!;
      if (!linking) return { body, report: null };
      const linked = await autolinkFragments(app, settings, { ...self, fragments: [body], body });
      return { body: linked.fragments[0]!, report: linked.report };
    }
    const compose = (sections: Record<string, string>, prepend: string | undefined, append: string | undefined): string => {
      let b = current;
      for (const [heading, text] of Object.entries(sections)) b = setSection(b, heading, text);
      if (prepend !== undefined) b = prependBody(b, prepend);
      if (append !== undefined) b = appendBody(b, append);
      return b;
    };
    let sections = input.bodySections ?? {};
    let prepend = input.bodyPrepend;
    let append = input.bodyAppend;
    if (!linking) return { body: compose(sections, prepend, append), report: null };
    // the texts in the order the body shows them: before it, its sections, after it
    const headings = Object.keys(sections);
    const linked = await autolinkFragments(app, settings, {
      ...self,
      fragments: [prepend ?? "", ...headings.map((h) => sections[h]!), append ?? ""],
      body: compose(sections, prepend, append),
    });
    const f = linked.fragments;
    if (prepend !== undefined) prepend = f[0]!;
    sections = Object.fromEntries(headings.map((h, i) => [h, f[i + 1]!]));
    if (append !== undefined) append = f[f.length - 1]!;
    return { body: compose(sections, prepend, append), report: linked.report };
  };
  // runs as update_rows on the one row, journaled under its own name
  return updateRowsImpl(
    app,
    settings,
    {
      table: input.table,
      where: { path: row.file.path },
      ...(input.set ? { set: input.set } : {}),
      ...(input.unset ? { unset: input.unset } : {}),
      expectCount: 1,
    },
    opts,
    input.body !== undefined || partial ? bodyFor : undefined,
    "update_row",
  );
}

// --- delete_rows ---

export interface DeleteRowsInput {
  table: string;
  where?: Where;
  mode?: "archive" | "delete";
  /** `restrict` (default): refuse referenced rows. `set_null`: clear frontmatter links to them. `ignore`: leave links. */
  onReferenced?: "restrict" | "set_null" | "ignore";
}

/**
 * For each of `targets`, the notes (other than the targets) whose resolved links point at it,
 * sorted: one pass over the vault's links for all of them.
 */
function inboundLinks(app: App, targets: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const backlinks = app.metadataCache.backlinksOf?.bind(app.metadataCache);
  if (backlinks) {
    // the host keeps backlinks: only the targets' own are read
    for (const target of targets) {
      const sources = Object.entries(backlinks(target)).filter(([src, n]) => n > 0 && !targets.has(src)).map(([src]) => src);
      if (sources.length > 0) out.set(target, sources.sort());
    }
    return out;
  }
  for (const [src, dests] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (targets.has(src)) continue;
    for (const [dest, n] of Object.entries(dests)) {
      if (!(n > 0) || !targets.has(dest)) continue;
      const list = out.get(dest);
      if (list) list.push(src);
      else out.set(dest, [src]);
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}

function clearLinksTo(
  app: App,
  sourcePath: string,
  ordered: OrderedFrontmatter,
  targets: ReadonlySet<string>,
): OrderedFrontmatter {
  const pointsAt = (v: unknown) => {
    const lp = parseWikilink(v);
    if (lp == null) return false;
    const dest = app.metadataCache.getFirstLinkpathDest(lp, sourcePath);
    return dest != null && targets.has(dest.path);
  };
  return ordered.map(([k, v]) => {
    if (Array.isArray(v)) return [k, v.filter((x) => !pointsAt(x))] as [string, unknown];
    return (pointsAt(v) ? [k, null] : [k, v]) as [string, unknown];
  });
}

/**
 * The conflict of a row others link to (`restrict`): `referenced by <paths>`. Under a read scope,
 * only the paths it may read, and how many it may not: `referenced by a.md and 2 rows this token
 * may not read`.
 */
function referencedBy(app: App, settings: DatanotesSettings, sources: readonly string[]): string {
  const shown = sources.filter((p) => !pathHidden(app, settings, p));
  const hidden = sources.length - shown.length;
  if (hidden === 0) return `referenced by ${sources.join(", ")}`;
  const rest = `${hidden} ${hidden === 1 ? "row" : "rows"} this token may not read`;
  return `referenced by ${shown.length > 0 ? `${shown.join(", ")} and ${rest}` : rest}`;
}

async function deleteRowsImpl(
  app: App,
  settings: DatanotesSettings,
  input: DeleteRowsInput,
  opts: RunOptions = {},
): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const pred = compileWhere(await resolveWithin(app, settings, t, input.where), t, settings);
  const rows = (await loadRowsWhere(app, settings, t, input.where)).filter(pred);
  const mode = input.mode ?? "archive";
  const policy = input.onReferenced ?? "restrict";
  const doomed = new Set(rows.map((r) => r.file.path));
  const conflicts: OpConflict[] = [];
  const cs = emptyChangeSet("delete_rows", `${mode} ${rows.length} rows of ${t.def.name}`, t.def.schemaPath);
  const referrers = new Set<string>();
  const inbound = inboundLinks(app, doomed);
  for (const r of rows) {
    const sources = inbound.get(r.file.path) ?? [];
    if (sources.length > 0 && policy === "restrict") {
      conflicts.push({ path: r.file.path, message: referencedBy(app, settings, sources) });
    }
    sources.forEach((s) => referrers.add(s));
  }
  if (policy === "set_null") {
    const model = cachedMetastore(app, settings)!; // loadTable above loaded it
    for (const src of [...referrers].sort()) {
      const f = app.vault.getAbstractFileByPath(src) as TFile | null;
      if (!f || !("extension" in f) || f.extension !== "md") continue;
      const text = await app.vault.read(f);
      const before = readOrderedFromMarkdown(text).ordered;
      const after = clearLinksTo(app, src, before, doomed);
      // Like ON DELETE SET NULL on a NOT NULL column: a required link left empty is refused.
      const owner = rowTableFull(model, fmGet(after, settings.tableKey));
      const ot = owner ? await loadTable(app, settings, owner) : null;
      if (ot && !src.startsWith(`${archiveFolder(ot.def)}/`)) {
        for (const c of ot.def.columns) {
          if (c.required && !isEmptyValue(fmGet(before, c.name)) && isEmptyValue(fmGet(after, c.name))) {
            conflicts.push({ path: src, message: `"${c.name}" is required and would be left empty: change or delete this row first, or use on_referenced "ignore"` });
          }
        }
      }
      cs.edits.push({ path: src, before, after });
    }
  }
  const folder = archiveFolder(t.def);
  const targets = new Set<string>();
  for (const r of rows) {
    if (mode === "delete") {
      cs.deletes.push(r.file.path);
      continue;
    }
    const to = `${folder}/${r.file.path.split("/").pop()}`;
    if (app.vault.getAbstractFileByPath(to) != null || targets.has(to)) {
      conflicts.push({ path: r.file.path, message: `archive target exists: ${to}` });
    }
    targets.add(to);
    cs.moves.push({ from: r.file.path, to });
  }
  // the rows set_null clears are written only because a row they link to goes
  return finish(app, settings, cs, conflicts, await linkedCheckViolations(app, settings, cs, new Set(cs.edits.map((e) => e.path))), opts);
}

export const insertRow = instrumented("insert_row", insertRowImpl, (i) => ({ table: i.table, path: i.path }));
export const mergeRows = instrumented("merge_rows", mergeRowsImpl, (i) => ({ table: i.table, on: i.on.join(","), rows: i.rows.length }));
export const updateRows = instrumented("update_rows", updateRowsImpl, (i) => ({
  table: i.table,
  set_columns: Object.keys(i.set ?? {}).join(","),
  unset_columns: (i.unset ?? []).join(","),
}));
export const updateRow = instrumented("update_row", updateRowImpl, (i) => ({
  table: i.table,
  by: i.id !== undefined ? "id" : "path",
  set_columns: Object.keys(i.set ?? {}).join(","),
}));
export const deleteRows = instrumented("delete_rows", deleteRowsImpl, (i) => ({
  table: i.table,
  mode: i.mode ?? "archive",
  on_referenced: i.onReferenced ?? "restrict",
}));
