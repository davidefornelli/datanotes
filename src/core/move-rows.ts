/**
 * move_rows and adopt_rows: make notes rows of a table (rows of another table, or notes of none),
 * renaming, setting and dropping keys, every row validated against the destination first.
 */

import type { App, TFile } from "./host";
import { emptyChangeSet, type ChangeSet } from "./changeset";
import { cachedMetastore, catalogTables, rowTableFull } from "./metastore";
import {
  finish,
  instrumented,
  loadRows,
  loadTable,
  memberEntry,
  OperationInputError,
  type LoadedTable,
  type OpConflict,
  type OpResult,
  type RowViolations,
  type RunOptions,
  uniqueViolations,
} from "./engine";
import { fmDelete, fmGet, fmSet, readOrderedFromMarkdown } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { validationContextFor } from "./table-registry";
import { readDatabaseConfig } from "./database";
import type { OrderedFrontmatter } from "./types";
import { isEmptyValue, parseWikilink, validateRow } from "./validate";
import { CheckLinks } from "./check-links";
import { basenameOf, claimFreeName, renderPathTemplate } from "./path-templates";
import { computedColumnNames, fileCreated, normalizeDatetimes, withGenerated, withIdentity, withRowId } from "./computed-columns";
import { compileWhere, knownKeys, resolveWithin, type Where } from "./where";
import { constraintViolations, hierarchyViolations } from "./row-checks";
import { linkedCheckViolations } from "./changeset-checks";
import { messageOf } from "./message";
import { tableReadable } from "./read-scope";
import { linkTargetOf, modelColumns } from "./link-paths";

// --- move_rows / adopt_rows ---

export interface MoveRowsInput {
  table: string;
  where?: Where;
  /** Destination table (name or schema path). */
  toTable: string;
  /** Column renames applied while moving, e.g. `{ "metric_distance_km": "distance_km" }`. */
  rename?: Record<string, string>;
  /** Values to set on moved rows (after renames), e.g. `{ "type": "workout" }`. */
  set?: Record<string, unknown>;
  /** Keys to remove from moved rows (e.g. source-only columns like `kind`). */
  drop?: string[];
  /** Also move the files to the destination's folder, named by its filename pattern. */
  relocate?: boolean;
}

interface Retarget {
  rename: Record<string, string>;
  set: Record<string, unknown>;
  drop: Set<string>;
  /** Extra values per note path (applied after `set`). */
  perRow?: Record<string, Record<string, unknown>>;
  relocate: boolean;
}

function checkRetarget(dst: LoadedTable, settings: DatanotesSettings, r: Retarget): void {
  const dstKnown = knownKeys(dst, settings);
  const membership = new Set([settings.tableKey]);
  const computed = computedColumnNames(dst);
  for (const [from, to] of Object.entries(r.rename)) {
    if (typeof to !== "string" || !dstKnown.has(to)) {
      throw new OperationInputError(`rename target "${String(to)}" is not a column of table "${dst.def.name}"`);
    }
    if (membership.has(from)) throw new OperationInputError(`cannot rename "${from}": it is the front matter key that names the row's table`);
    // like `set`: the destination computes the value, so a renamed one would be dropped silently
    if (computed.has(to)) throw new OperationInputError(`rename target "${to}" is a generated column: its value is computed`);
  }
  const sets = [r.set, ...Object.values(r.perRow ?? {})];
  for (const set of sets) {
    for (const k of Object.keys(set)) {
      if (!dstKnown.has(k) || membership.has(k) || k === "path") {
        throw new OperationInputError(`set: "${k}" is not a column of table "${dst.def.name}"`);
      }
      if (computed.has(k)) throw new OperationInputError(`"${k}" is a generated column: its value is computed`);
    }
  }
}

/**
 * Make notes rows of `dst`: rename / set / drop keys, add missing dense fields, membership first,
 * computed columns, validation (all rows first) and, with `relocate`, a path from the table's
 * filename pattern. Keys unknown to the destination are violations: nothing is dropped silently.
 */
async function retargetRows(
  app: App,
  settings: DatanotesSettings,
  dst: LoadedTable,
  notes: readonly { path: string; ordered: OrderedFrontmatter }[],
  r: Retarget,
  cs: ChangeSet,
  opts: RunOptions,
): Promise<{ violations: RowViolations[]; conflicts: OpConflict[] }> {
  const dstKnown = knownKeys(dst, settings);
  const membership = new Set([settings.tableKey]);
  const tz = (await readDatabaseConfig(app, settings)).timezone;
  const violations: RowViolations[] = [];
  const conflicts: OpConflict[] = [];
  const denseDefaults = dst.ordered.filter(([k]) => !membership.has(k) && dstKnown.has(k) && !k.startsWith("_"));
  const taken = new Set<string>();
  const planned: { path: string; after: OrderedFrontmatter }[] = [];
  for (const n of notes) {
    let after: OrderedFrontmatter = n.ordered.map(([k, v]) => [k, v] as [string, unknown]);
    after = after.filter(([k]) => !r.drop.has(k));
    for (const [from, to] of Object.entries(r.rename)) {
      if (!after.some(([k]) => k === from)) continue;
      if (after.some(([k]) => k === to) && !isEmptyValue(fmGet(after, to))) {
        conflicts.push({ path: n.path, message: `both "${from}" and "${to}" have values` });
        continue;
      }
      after = fmDelete(after, to);
      after = after.map(([k, v]) => (k === from ? [to, v] : [k, v]) as [string, unknown]);
    }
    for (const [k, v] of Object.entries({ ...r.set, ...(r.perRow?.[n.path] ?? {}) })) after = fmSet(after, k, v);
    for (const [k, v] of denseDefaults) {
      if (!after.some(([key]) => key === k)) {
        const spec = dst.def.columns.find((c) => c.name === k);
        const value = spec?.default ?? v;
        after = fmSet(after, k, value ?? null);
      }
    }
    // Membership first: the destination's `table` replaces any previous one.
    after = [memberEntry(settings, dst), ...after.filter(([k]) => !membership.has(k))] as OrderedFrontmatter;
    after = withRowId(after);
    after = normalizeDatetimes(dst.def.columns, after, tz);
    after = withGenerated(dst, settings, after, n.path);
    let to = n.path;
    if (r.relocate) {
      if (!dst.def.options.filename) {
        throw new OperationInputError(`table "${dst.def.name}" has no filename pattern: cannot relocate rows`);
      }
      try {
        const values = new Map(after);
        // A file-name identity column is the note's name: the one it has now, until it moves.
        for (const c of dst.def.columns) {
          if (c.identity === "filename" && isEmptyValue(values.get(c.name))) values.set(c.name, basenameOf(n.path));
        }
        const base = `${renderPathTemplate(dst.def.layout.rowPath, values)}/${renderPathTemplate(dst.def.options.filename, values)}`;
        to = claimFreeName(base, (p) => p !== n.path && (taken.has(p) || app.vault.getAbstractFileByPath(p) != null));
      } catch (e) {
        conflicts.push({ path: n.path, message: `cannot compute the new path: ${messageOf(e)}` });
      }
      taken.add(to);
    }
    after = withIdentity(dst, after, to, false, {
      now: opts.now ?? new Date(),
      tz,
      ...(fileCreated(app, n.path) !== undefined ? { created: fileCreated(app, n.path)! } : {}),
    });
    planned.push({ path: n.path, after });
    cs.edits.push({ path: n.path, before: n.ordered, after });
    if (to !== n.path) cs.moves.push({ from: n.path, to });
  }
  // Links are read on the state the change leaves: notes of the same call that link to one
  // another are rows of `dst` by then (wherever they move).
  const state = new CheckLinks(app, settings, cs);
  for (const { path, after } of planned) {
    violations.push({
      path,
      violations: [
        ...validateRow(dst.def, after, { tableKey: settings.tableKey }, state.context(path)),
        ...constraintViolations(dst, settings, path, after),
      ],
    });
  }
  if (dst.def.columns.some((c) => c.unique)) {
    const moved = new Set(cs.edits.map((e) => e.path));
    violations.push(
      ...uniqueViolations(dst.def.columns, [
        ...(await loadRows(app, settings, dst)).filter((x) => !moved.has(x.file.path)).map((x) => ({ path: x.file.path, ordered: x.ordered })),
        ...cs.edits.map((e) => ({ path: e.path, ordered: e.after })),
      ]).filter((u) => moved.has(u.path)),
    );
  }
  violations.push(...(await hierarchyViolations(app, settings, dst, cs.edits.map((e) => ({ path: e.path, ordered: e.after })))));
  violations.push(...(await linkedCheckViolations(app, settings, cs)));
  return { violations, conflicts };
}

/**
 * Re-link rows to another table: change their membership, rename/set/drop keys, add the
 * destination's missing dense fields, and validate every row against the destination first.
 */
async function moveRowsImpl(
  app: App,
  settings: DatanotesSettings,
  input: MoveRowsInput,
  opts: RunOptions = {},
): Promise<OpResult> {
  const src = await loadTable(app, settings, input.table);
  const dst = await loadTable(app, settings, input.toTable);
  if (src.def.schemaPath === dst.def.schemaPath) throw new OperationInputError(`source and destination are the same table`);
  const r: Retarget = { rename: input.rename ?? {}, set: input.set ?? {}, drop: new Set(input.drop ?? []), relocate: input.relocate === true };
  checkRetarget(dst, settings, r);
  const pred = compileWhere(await resolveWithin(app, settings, src, input.where), src, settings);
  const rows = (await loadRows(app, settings, src)).filter(pred);
  const cs = emptyChangeSet("move_rows", `move ${rows.length} rows from ${src.def.name} to ${dst.def.name}`, dst.def.schemaPath);
  const { violations, conflicts } = await retargetRows(app, settings, dst, rows.map((x) => ({ path: x.file.path, ordered: x.ordered })), r, cs, opts);
  conflicts.push(...(await linksLeftBehind(app, settings, src, new Set(rows.map((x) => x.file.path)))));
  return finish(app, settings, cs, conflicts, violations, opts);
}

/**
 * Rows staying behind whose link columns must point to a row of `src` and point to a row the move
 * takes out of it: their links would no longer be valid (a link follows a renamed row, but not
 * to another table), so the move is refused, naming them on the row they link to.
 */
async function linksLeftBehind(app: App, settings: DatanotesSettings, src: LoadedTable, moved: ReadonlySet<string>): Promise<OpConflict[]> {
  const model = src.catalog.model;
  const full = src.catalog.ref.full;
  const from = new Map<string, Set<string>>();
  for (const { ref } of catalogTables(model)) {
    // only the tables whose columns link to `src` (read on the metastore) are loaded
    const linking = modelColumns(model, ref.full)!.some((c) => { // a table of the model
      const target = linkTargetOf(c, ref.full);
      return target !== null && rowTableFull(model, target) === full;
    });
    if (!linking) continue;
    const t = ref.full === full ? src : await loadTable(app, settings, ref.full);
    const columns = t.def.columns.filter((c) => (c.type === "link" || (c.type === "list" && c.items === "link")) && rowTableFull(model, c.ref) === full);
    for (const row of await loadRows(app, settings, t)) {
      if (moved.has(row.file.path)) continue;
      const ctx = validationContextFor(app, settings, row.file.path);
      for (const c of columns) {
        const v = fmGet(row.ordered, c.name);
        for (const x of Array.isArray(v) ? v : [v]) {
          const lp = parseWikilink(x);
          const dest = lp === null ? null : ctx.resolveLink!(lp);
          if (dest !== null && moved.has(dest)) from.set(dest, (from.get(dest) ?? new Set()).add(`${row.file.path} ("${c.name}")`));
        }
      }
    }
  }
  return [...from].sort(([a], [b]) => a.localeCompare(b)).map(([path, by]) => ({
    path,
    message: `linked from ${[...by].join(", ")}, which must link to a row of ${full}: change or clear those links first`,
  }));
}

export interface AdoptRowsInput {
  /** Destination table. */
  table: string;
  /** Existing notes (vault paths, with or without `.md`) that are not rows of another table. */
  paths: string[];
  rename?: Record<string, string>;
  set?: Record<string, unknown>;
  /** Values for single notes, by path: `{ "Home/Cleaning/x.md": { "zone": "[[Kitchen]]" } }`. */
  perRow?: Record<string, Record<string, unknown>>;
  drop?: string[];
  /** Move the notes to the table's folder, named by its filename pattern (default true). */
  relocate?: boolean;
}

/**
 * Turn existing notes into rows of a table, keeping their body and links (moves go through
 * Obsidian). One journaled, undoable operation; refused while any note does not fit.
 */
async function adoptRowsImpl(app: App, settings: DatanotesSettings, input: AdoptRowsInput, opts: RunOptions = {}): Promise<OpResult> {
  const dst = await loadTable(app, settings, input.table);
  if (!Array.isArray(input.paths) || input.paths.length === 0) throw new OperationInputError(`"paths" needs at least one note`);
  const norm = (p: string) => (p.endsWith(".md") ? p : `${p}.md`);
  const perRow = Object.fromEntries(Object.entries(input.perRow ?? {}).map(([p, v]) => [norm(p), v]));
  const r: Retarget = {
    rename: input.rename ?? {},
    set: input.set ?? {},
    drop: new Set(input.drop ?? []),
    perRow,
    relocate: input.relocate !== false,
  };
  checkRetarget(dst, settings, r);
  const paths = [...new Set(input.paths.map(norm))].sort();
  for (const p of Object.keys(perRow)) {
    if (!paths.includes(p)) throw new OperationInputError(`per_row: ${p} is not in "paths"`);
  }
  const model = cachedMetastore(app, settings);
  const conflicts: OpConflict[] = [];
  const notes: { path: string; ordered: OrderedFrontmatter }[] = [];
  for (const p of paths) {
    const f = app.vault.getAbstractFileByPath(p);
    if (f == null || !("extension" in f)) throw new OperationInputError(`note not found: ${p}`);
    const { ordered } = readOrderedFromMarkdown(
      await app.vault.read(f as TFile),
      new Set([settings.tableKey]),
    );
    const owner = model ? rowTableFull(model, fmGet(ordered, settings.tableKey)) : null;
    // under a read scope, a table it may not read is not named (src/core/read-scope.ts)
    if (owner) conflicts.push({ path: p, message: `already a row of ${tableReadable(owner) ? owner : "another table"}: use move_rows` });
    notes.push({ path: p, ordered });
  }
  const cs = emptyChangeSet("adopt_rows", `adopt ${notes.length} notes into ${dst.def.name}`, dst.def.schemaPath);
  const out = await retargetRows(app, settings, dst, notes, r, cs, opts);
  return finish(app, settings, cs, [...conflicts, ...out.conflicts], out.violations, opts);
}

export const adoptRows = instrumented("adopt_rows", adoptRowsImpl, (i) => ({ table: i.table, notes: i.paths.length }));
export const moveRows = instrumented("move_rows", moveRowsImpl, (i) => ({
  table: i.table,
  to_table: i.toTable,
  renamed: Object.keys(i.rename ?? {}).length,
}));
