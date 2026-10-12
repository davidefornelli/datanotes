/**
 * Edits made outside the engine (an editor, git, a sync tool): the rows they create, change,
 * rename or remove, checked against the tables' rules as check_table checks them
 * (checkExternalEdits), and the tables a hand edit of metastore.yaml changes (checkChangedTables).
 */

import { readParsed } from "./file-cache";
import type { App, TFile } from "./host";
import { emptyChangeSet } from "./changeset";
import { linkReads, linkTargetOf, modelColumns } from "./link-paths";
import { catalogTables, loadMetastore, rowTableFull } from "./metastore";
import { archiveFolder, loadTable, OperationInputError, uniqueViolations, type LoadedRow, type LoadedTable } from "./engine";
import { buildMarkdownWithFrontmatter, fmGet, readOrderedFromMarkdown } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import type { Violation, ViolationCode } from "./types-table";
import type { OrderedFrontmatter } from "./types";
import { isEmptyValue, validateRow, validateValue } from "./validate";
import { basenameOf } from "./path-templates";
import { computedColumnNames } from "./computed-columns";
import { compileCheck, LOGICAL_KEYS, type Where } from "./where";
import { CheckLinks, followsLinks } from "./check-links";
import { byName, filteredLinkColumns, linkTargetCheck } from "./link-targets";
import { checkOne, constraintViolations, hierarchyViolations } from "./row-checks";
import { messageOf } from "./message";

/** Codes the checks of hand edits report: the engine fills generated values and inverse links by itself, so those are left out. */
export type ExternalViolationCode = Exclude<ViolationCode, "inverse" | "generated">;

/** A rule a row breaks, as reported for an edit made outside the engine (an editor, git, sync). */
export interface ExternalViolation {
  /** The row that breaks it: the edited row, or a row that links to it. */
  path: string;
  code: ExternalViolationCode;
  /** The column (every code but `check`). */
  column?: string;
  /** The CHECK's name (code `check`). */
  constraint?: string;
  /** The item of a list column, from 0. */
  index?: number;
  message: string;
}

/** A hand edit of a row, as the change feed or the transaction log saw it. */
export interface ExternalEdit {
  /** The row's path now; for a row gone (deleted, moved out of its table, its `table` removed), the path it had last. */
  path: string;
  /** Its path before a rename. */
  oldPath?: string;
  /**
   * Its frontmatter before the edit (`table` included); null when it was no row. Undefined: not
   * known; when an edit does not say, every rule the rows break is reported, not only those the
   * edits break.
   */
  before?: OrderedFrontmatter | null;
  /** It is no row any more. */
  gone?: boolean;
  /**
   * A rename whose links follow (the links to `oldPath` are repaired shortly, hand-moves.ts): the
   * rows linking to it are not reported for a link to no row, as after an engine rename.
   */
  linksFollow?: boolean;
}

export interface ExternalCheck {
  /** By edit (its `path`): what its row breaks, then what the rows linking to it break since. */
  byPath: Map<string, ExternalViolation[]>;
  /** Tables whose rows were read for it (besides the edited rows): the cost of the check. */
  loaded: string[];
  /** The table of each row a violation names. */
  tableOf: Map<string, string>;
}

function externalViolation(path: string, v: Violation, suffix = ""): ExternalViolation | null {
  if (v.code === "inverse" || v.code === "generated") return null;
  if (v.code === "check") {
    // the CHECK itself is in metastore.yaml (describe_table): not repeated in every message
    const head = `violates CHECK ${v.constraint}: `;
    return { path, code: v.code, constraint: v.constraint, message: `${v.message.startsWith(head) ? `violates CHECK ${v.constraint}` : v.message}${suffix}` };
  }
  return { path, code: v.code, column: v.column, ...(v.index !== undefined ? { index: v.index } : {}), message: `${v.message}${suffix}` };
}

/** What a violation is about, whatever its message says: the same rule broken before and after an edit is not new. */
function violationKey(v: Violation): string {
  return `${v.code}|${v.column ?? v.constraint}|${v.index ?? ""}`;
}

/** The link columns each dotted key of a `where` follows, in order (`parent.parent.kind` → [parent, parent]). */
function linkChains(where: unknown, out: string[][] = []): string[][] {
  if (where == null || typeof where !== "object" || Array.isArray(where)) return out;
  for (const [k, v] of Object.entries(where)) {
    if (LOGICAL_KEYS.has(k)) for (const w of Array.isArray(v) ? v : [v]) linkChains(w, out);
    else if (k.indexOf(".") > 0) out.push(k.split(".").slice(0, -1));
  }
  return out;
}

/** The edited rows (`edited`, by path) that `row` of `t` reaches through the link chains. */
async function reachedEdits(links: CheckLinks, t: LoadedTable, chains: readonly string[][], row: LoadedRow, edited: ReadonlySet<string>): Promise<string[]> {
  const out = new Set<string>();
  for (const chain of chains) {
    let cur: { table: LoadedTable; rows: LoadedRow[] } = { table: t, rows: [row] };
    for (const col of chain) {
      let next: { table: LoadedTable; rows: ReadonlyMap<string, LoadedRow> };
      try {
        next = await links.linked(cur.table, col);
      } catch (e) {
        /* v8 ignore next -- defensive: a column that is not a link to a table raises OperationInputError; anything else goes up */
        if (!(e instanceof OperationInputError)) throw e;
        break; // not a link column to a table
      }
      const rows: LoadedRow[] = [];
      for (const r of cur.rows) {
        const v = fmGet(r.ordered, col);
        for (const x of Array.isArray(v) ? v : [v]) {
          const p = links.resolve(x, r.file.path);
          if (p === null) continue;
          if (edited.has(p)) out.add(p);
          const hit = next.rows.get(p);
          if (hit) rows.push(hit);
        }
      }
      if (rows.length === 0) break;
      cur = { table: next.table, rows };
    }
  }
  return [...out].sort(byName);
}

/**
 * What rows of `t` break of their own table's rules in the state `links` holds (the vault, or the
 * vault before the hand edits): required, types, ranges, enums, links, unique values and hierarchy
 * cycles (these two on the table as `links` has it, the edited rows merged in by path even before
 * the host indexes them), CHECKs and filtered link targets. Generated and identity columns are
 * left out.
 */
async function ownViolations(app: App, settings: DatanotesSettings, t: LoadedTable, rows: readonly LoadedRow[], links: CheckLinks): Promise<Map<string, Violation[]>> {
  for (const where of Object.values(t.catalog.entry.constraints ?? {})) if (followsLinks(where)) await links.prepare(t, where);
  const targetChecks: ((row: LoadedRow) => Violation[])[] = [];
  for (const c of filteredLinkColumns(t)) targetChecks.push(await linkTargetCheck(t, settings, links, c));
  const computed = computedColumnNames(t);
  const whole = t.def.columns.some((c) => (c.unique && !computed.has(c.name)) || c.hierarchy);
  if (whole) await links.prepare(t, null);
  const all = whole ? links.rowsOf(t) : [];
  const own = new Set(rows.map((r) => r.file.path));
  const unique = new Map(
    uniqueViolations(t.def.columns, all.map((r) => ({ path: r.file.path, ordered: r.ordered })))
      .filter((u) => own.has(u.path))
      .map((u) => [u.path, u.violations]),
  );
  const cycles = whole ? await hierarchyViolations(app, settings, t, rows.map((r) => ({ path: r.file.path, ordered: r.ordered })), all) : [];
  const out = new Map<string, Violation[]>();
  for (const r of rows) {
    const path = r.file.path;
    const v = [
      ...validateRow(t.def, r.ordered, { tableKey: settings.tableKey }, links.context(path)),
      ...(unique.get(path) ?? []),
      ...constraintViolations(t, settings, path, r.ordered, links),
      ...targetChecks.flatMap((check) => check(r)),
      ...cycles.filter((c) => c.path === path).flatMap((c) => c.violations),
    ];
    out.set(path, v.filter((x) => x.code === "check" || !computed.has(x.column!)));
  }
  return out;
}

/**
 * Rows created, changed, renamed or removed outside the engine (an editor, git, a sync tool),
 * checked as check_table checks them: the edited rows against their table's rules
 * ({@link ownViolations}: generated and identity columns, the row id included, and missing
 * inverse links are left out, the engine fills and fixes them by itself shortly after); then the
 * rows that link to an edited row, for the link-following CHECKs and filtered link columns that
 * read its table, and, for a row removed, renamed or moved to another table, for their links to
 * it (a link to no row is `broken_link`, to a row of another table `ref`): those are reported under
 * the edit, their message naming it. When every edit gives its `before`, the check compares with
 * the vault before the edits and reports only what they break: a rule a row already broke is not
 * blamed on them (as an engine write is refused only for what it breaks). A table with no such
 * rules (nor non-identity unique or hierarchy columns) costs reading the edited rows only. Notes
 * that are not rows (any more, and none in the table's archive or `exclude` folders) are skipped.
 */
export async function checkExternalEdits(app: App, settings: DatanotesSettings, input: readonly (string | ExternalEdit)[]): Promise<ExternalCheck> {
  const byPath = new Map<string, ExternalViolation[]>();
  const tableOf = new Map<string, string>();
  const model = input.length > 0 ? (await loadMetastore(app, settings))?.model : undefined;
  if (!model) return { byPath, loaded: [], tableOf };
  const tp = settings.tableKey;
  const edits = new Map<string, ExternalEdit>();
  for (const e of input) {
    const x = typeof e === "string" ? { path: e } : e;
    edits.set(x.path, x);
  }
  const tables = new Map<string, LoadedTable>();
  const table = async (full: string): Promise<LoadedTable> => {
    let t = tables.get(full);
    if (!t) tables.set(full, (t = await loadTable(app, settings, full)));
    return t;
  };
  const rowPath = (t: LoadedTable, p: string) => !p.startsWith(`${archiveFolder(t.def)}/`) && !(t.def.options.exclude ?? []).some((dir) => p.startsWith(`${dir}/`));
  const tableOfOrdered = (o: OrderedFrontmatter | null | undefined) => (o ? rowTableFull(model, fmGet(o, tp)) : null);
  // The edited rows as they are now.
  const now = new Map<string, { row: LoadedRow; full: string }>();
  const key = `row|${tp}`;
  const keep = new Set([tp]);
  for (const e of edits.values()) {
    if (e.gone || !e.path.endsWith(".md")) continue;
    const f = app.vault.getAbstractFileByPath(e.path);
    if (f == null || !("extension" in f)) continue;
    let row: LoadedRow;
    try {
      const { ordered, body } = await readParsed(app, f as TFile, key, (text) => readOrderedFromMarkdown(text, keep));
      row = { file: f as TFile, ordered, body };
    } catch {
      continue; // malformed frontmatter: not a row until fixed
    }
    const full = tableOfOrdered(row.ordered);
    if (full !== null && rowPath(await table(full), e.path)) now.set(e.path, { row, full });
  }
  // Compared with the vault before the edits when every edit says what its row was.
  const diffing = [...edits.values()].every((e) => e.before !== undefined);
  /** A row's path before the edits → the edit reporting it. */
  const beforePaths = new Map<string, string>();
  /** Rows removed, renamed or moved to another table, by their path before the edits: links to them are checked. */
  const gone = new Map<string, ExternalEdit>();
  const kindOf = new Map<string, string>();
  for (const e of edits.values()) {
    const was = tableOfOrdered(e.before);
    if (was === null) continue;
    const wasPath = e.oldPath ?? e.path;
    beforePaths.set(wasPath, e.path);
    const cur = now.get(e.path);
    const kind = !cur ? "removal" : wasPath !== e.path ? "rename" : cur.full !== was ? "edit" : null;
    if (kind && !(kind === "rename" && e.linksFollow)) gone.set(wasPath, e);
    kindOf.set(e.path, kind ?? "edit");
  }
  // The vault after the edits, with the edited rows as read (the host's index may lag) ...
  const afterCs = emptyChangeSet("external", "after the hand edits");
  for (const [path, { row }] of now) afterCs.edits.push({ path, before: row.ordered, after: row.ordered });
  for (const p of new Set([...[...edits.keys()].filter((p) => !now.has(p)), ...[...gone.keys()].filter((p) => !now.has(p))])) afterCs.deletes.push(p);
  const after = new CheckLinks(app, settings, afterCs, undefined, true);
  // ... and before them.
  let before: CheckLinks | null = null;
  if (diffing) {
    const cs = emptyChangeSet("external", "before the hand edits");
    for (const e of edits.values()) {
      const cur = now.get(e.path);
      if (tableOfOrdered(e.before) === null) {
        if (cur) cs.deletes.push(e.path);
        continue;
      }
      const wasPath = e.oldPath ?? e.path;
      if (cur) {
        cs.edits.push({ path: e.path, before: cur.row.ordered, after: e.before! });
        if (wasPath !== e.path) cs.moves.push({ from: e.path, to: wasPath });
      } else if (app.vault.getAbstractFileByPath(wasPath)) cs.edits.push({ path: wasPath, before: [], after: e.before! });
      else cs.creates.push({ path: wasPath, content: buildMarkdownWithFrontmatter(e.before!, "") });
    }
    before = new CheckLinks(app, settings, cs, undefined, true);
  }
  const add = (at: string, v: ExternalViolation | null, full: string) => {
    if (!v) return;
    byPath.set(at, [...(byPath.get(at) ?? []), v]);
    tableOf.set(v.path, full);
  };
  // The edited rows, against their table's rules.
  const byTable = new Map<string, LoadedRow[]>();
  for (const [path, { row, full }] of now) {
    byTable.set(full, [...(byTable.get(full) ?? []), row]);
    byPath.set(path, []);
  }
  for (const e of edits.values()) if (!now.has(e.path) && gone.has(e.oldPath ?? e.path)) byPath.set(e.path, []);
  for (const [full, rows] of byTable) {
    const t = await table(full);
    const found = await ownViolations(app, settings, t, rows, after);
    // what the rows already broke before the edit (same table) is not reported
    const old = new Map<string, Set<string>>();
    if (before) {
      const was: LoadedRow[] = [];
      for (const r of rows) {
        const e = edits.get(r.file.path)!;
        if ((found.get(r.file.path) ?? []).length > 0 && tableOfOrdered(e.before) === full) {
          was.push({ file: { path: e.oldPath ?? r.file.path } as TFile, ordered: e.before!, body: "" });
        }
      }
      if (was.length > 0) {
        const prior = await ownViolations(app, settings, t, was, before);
        for (const r of rows) {
          const e = edits.get(r.file.path)!;
          const list = prior.get(e.oldPath ?? r.file.path);
          if (list) old.set(r.file.path, new Set(list.map(violationKey)));
        }
      }
    }
    for (const r of rows) {
      const skip = old.get(r.file.path);
      for (const v of found.get(r.file.path) ?? []) if (!skip?.has(violationKey(v))) add(r.file.path, externalViolation(r.file.path, v), full);
    }
  }
  // The rows that link to an edited row, for the rules that read its table through the link.
  const changedNow = new Set(now.keys());
  const editedTables = new Set([...now.values()].map((x) => x.full));
  for (const e of edits.values()) {
    const was = tableOfOrdered(e.before);
    if (was !== null) editedTables.add(was);
  }
  const readsEdited = (from: string, where: unknown, start?: Set<string>) => [...linkReads(model, from, where, start)].some((x) => editedTables.has(x));
  const beforeKeys = new Set(beforePaths.keys());
  const reach = async (s: LoadedTable, chains: readonly string[][], r: LoadedRow): Promise<string[]> => {
    const out = new Set(await reachedEdits(after, s, chains, r, changedNow));
    if (before) for (const p of await reachedEdits(before, s, chains, r, beforeKeys)) out.add(beforePaths.get(p)!);
    return [...out].sort(byName);
  };
  const nameOf = (k: string) => basenameOf(edits.get(k)?.oldPath ?? k);
  const suffix = (reached: readonly string[]) =>
    ` (after ${reached.map((k) => `the ${kindOf.get(k) ?? "edit"} of [[${nameOf(k)}]]`).join(", ")}, ${reached.length > 1 ? "rows" : "a row"} it links to)`;
  const report = async (s: LoadedTable, chains: readonly string[][], r: LoadedRow, broken: () => Violation[], prior?: () => Promise<Violation[]>) => {
    if (changedNow.has(r.file.path)) return; // checked in full above
    const reached = await reach(s, chains, r);
    if (reached.length === 0) return;
    let vs = broken();
    if (vs.length > 0 && prior) {
      const old = new Set((await prior()).map(violationKey));
      vs = vs.filter((v) => !old.has(violationKey(v)));
    }
    for (const v of vs) for (const k of reached) add(k, externalViolation(r.file.path, v, suffix(reached)), s.catalog.ref.full);
  };
  for (const { ref, entry } of catalogTables(model)) {
    const checks = Object.entries(entry.constraints ?? {}).filter(([, w]) => followsLinks(w) && readsEdited(ref.full, w));
    const filtered = new Set(
      modelColumns(model, ref.full)! // a table of the model
        .filter((c) => {
          const target = (c.ref_where ?? c.ref_by) != null ? linkTargetOf(c, ref.full) : null;
          return target !== null && readsEdited(target, c.ref_where, new Set([target]));
        })
        .map((c) => String(c.name)),
    );
    if (checks.length === 0 && filtered.size === 0) continue;
    const s = await table(ref.full);
    for (const [name, where] of checks) {
      await after.prepare(s, where);
      let passes: (row: LoadedRow) => boolean;
      try {
        passes = compileCheck(where as Where, s, settings, after);
      } catch {
        continue; // an invalid CHECK: check_table and the writes report it
      }
      let passed: ((row: LoadedRow) => boolean) | undefined;
      const failure = (ok: boolean): Violation[] => (ok ? [] : [{ constraint: name, code: "check", message: `violates CHECK ${name}` }]);
      const prior = (r: LoadedRow) => async () => {
        if (!passed) {
          await before!.prepare(s, where);
          try {
            passed = compileCheck(where as Where, s, settings, before!);
          } catch {
            passed = () => false;
          }
        }
        return failure(passed(r));
      };
      const chains = linkChains(where);
      for (const r of after.rowsOf(s)) await report(s, chains, r, () => failure(passes(r)), before ? prior(r) : undefined);
    }
    for (const c of filteredLinkColumns(s).filter((x) => filtered.has(x.name))) {
      const check = await linkTargetCheck(s, settings, after, c);
      let was: ((row: LoadedRow) => Violation[]) | undefined;
      const chains = [[c.name], ...linkChains(c.ref_where).map((k) => [c.name, ...k])];
      for (const r of after.rowsOf(s)) {
        await report(s, chains, r, () => check(r), before ? async () => (was ??= await linkTargetCheck(s, settings, before!, c))(r) : undefined);
      }
    }
  }
  // Links to a row removed, renamed or moved to another table: the rows holding them break their link columns.
  if (before && gone.size > 0) {
    const goneTables = new Set([...gone.values()].map((e) => tableOfOrdered(e.before)!));
    for (const { ref } of catalogTables(model)) {
      const names = new Set(
        modelColumns(model, ref.full)! // a table of the model
          .filter((c) => (c.type === "link" || (c.type === "list" && c.items === "link")) && c.generated === undefined)
          .filter((c) => c.ref == null || goneTables.has(linkTargetOf(c, ref.full)!))
          // filtered link columns report a link to no row themselves (above)
          .filter((c) => c.ref_where == null && c.ref_by == null)
          .map((c) => String(c.name)),
      );
      if (names.size === 0) continue;
      const s = await table(ref.full);
      await after.prepare(s, null);
      const specs = s.def.columns.filter((c) => names.has(c.name));
      for (const r of after.rowsOf(s)) {
        if (changedNow.has(r.file.path)) continue;
        for (const spec of specs) {
          const v = fmGet(r.ordered, spec.name);
          if (isEmptyValue(v)) continue;
          const reached = [
            ...new Set(
              (Array.isArray(v) ? v : [v])
                .map((x) => before!.resolve(x, r.file.path))
                .filter((p): p is string => p !== null && gone.has(p))
                .map((p) => gone.get(p)!.path),
            ),
          ].sort(byName);
          if (reached.length === 0) continue;
          const old = new Set(validateValue(spec, v, before.context(r.file.path)).map(violationKey));
          for (const x of validateValue(spec, v, after.context(r.file.path))) {
            if (!old.has(violationKey(x))) for (const k of reached) add(k, externalViolation(r.file.path, x, suffix(reached)), ref.full);
          }
        }
      }
    }
  }
  const loaded = new Set([...after.loadedTables(), ...(before?.loadedTables() ?? [])]);
  return { byPath, loaded: [...loaded].sort(), tableOf };
}

/**
 * Every row of these tables checked as check_table checks them, for a hand edit of
 * metastore.yaml that changed their entries: by table, the rules their rows break (missing
 * inverse links and stale generated values left out, as for hand edits of rows), or why the table
 * could not be checked.
 */
export async function checkChangedTables(
  app: App,
  settings: DatanotesSettings,
  tables: readonly string[],
): Promise<{ byTable: Map<string, ExternalViolation[]>; errors: Map<string, string> }> {
  const byTable = new Map<string, ExternalViolation[]>();
  const errors = new Map<string, string>();
  for (const full of tables) {
    try {
      const r = await checkOne(app, settings, full);
      byTable.set(
        full,
        r.violations.flatMap((x) => x.violations.map((v) => externalViolation(x.path, v)).filter((v): v is ExternalViolation => v !== null)),
      );
    } catch (e) {
      errors.set(full, messageOf(e));
    }
  }
  return { byTable, errors };
}
