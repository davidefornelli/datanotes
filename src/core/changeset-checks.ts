/**
 * The rules that follow links (CHECKs on `link.column` keys, filtered link columns), checked on
 * the state a change set leaves ({@link linkedCheckViolations}): row writes and the inverse-link
 * edits added to them, align_relations, and the operations that put back or change the metastore
 * (undo_migration, restore_table, define_base, set_table_bases).
 */

import type { App, TFile } from "./host";
import type { ChangeSet } from "./changeset";
import { linkReads, linkTargetOf, modelColumns } from "./link-paths";
import { catalogTables, constraintHints, loadMetastore, metastorePath, parseMetastore, resolveCatalogRef, rowTableFull, type CatalogRef, type Metastore } from "./metastore";
import type { LoadedRow, RowViolations } from "./engine";
import { fmGet, readOrderedFromMarkdown } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import type { Violation } from "./types-table";
import { compileCheck, LOGICAL_KEYS, type Where } from "./where";
import { CheckLinks, followsLinks, tableIn, type MetastoreState } from "./check-links";
import { linkTargetViolations } from "./link-targets";
import { messageOf } from "./message";
import { phase } from "./tracing";
import { currentReadScope, pathReadable, type ReadScope } from "./read-scope";
import { wikilinkTarget } from "./validate";

/**
 * Is `path` a note the read scope may not read (src/core/read-scope.ts)? A note that exists and is
 * no row of a readable table. Without a scope nothing is hidden, nor is a path of no note: the
 * empty path of a conflict about the whole write, a row a write creates, a row it deleted (a
 * restricted token deletes only rows of a table it writes, which it reads).
 */
export function pathHidden(app: App, settings: DatanotesSettings, path: string, scope: ReadScope | null = currentReadScope()): boolean {
  if (scope === null || path === "" || app.vault.getAbstractFileByPath(path) === null) return false;
  return !pathReadable(app, settings, path, scope);
}

/** What a restricted token reads of a CHECK of a row it may not read, which the write breaks. */
export const HIDDEN_CHECK_MESSAGE = "a linked row of a table this token may not read breaks one of its CHECKs";

/**
 * The violations of rows the read scope may not read, moved to the rows the change set writes that
 * they link to (D10: the write is refused all the same; the answer names neither the other row nor
 * its CHECK): one violation per written row and link column, code kept, message
 * {@link HIDDEN_CHECK_MESSAGE}. A hidden row that links to no written row (an inverse-link edit
 * of a row not created yet, a link set_null clears) reports on the rows the write itself writes,
 * without a column; with none it reports on the empty path.
 */
function movedOffHiddenRows(
  app: App,
  settings: DatanotesSettings,
  cs: ChangeSet,
  written: ReadonlyMap<string, string>,
  consequential: ReadonlySet<string>,
  out: Map<string, Violation[]>,
  scope: ReadScope,
): Map<string, Violation[]> {
  // the paths of the vault as it is (before the write) -> the path the answer reports a written row under
  const reported = new Map<string, string>(written);
  for (const m of cs.moves) reported.set(m.from, written.get(m.to) ?? m.from);
  for (const p of cs.deletes) reported.set(p, p);
  const visible = (p: string) => !pathHidden(app, settings, p, scope);
  const moved = new Map<string, Violation[]>();
  const add = (path: string, v: Violation) => {
    const list = moved.get(path) ?? [];
    if (!list.some((x) => x.code === v.code && x.column === v.column && x.message === v.message)) list.push(v);
    moved.set(path, list);
  };
  for (const [path, violations] of out) {
    if (visible(path)) {
      for (const v of violations) add(path, v);
      continue;
    }
    const file = app.vault.getAbstractFileByPath(path) as TFile;
    const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
    const targets: [string, string][] = [];
    for (const [key, value] of Object.entries(fm)) {
      for (const x of Array.isArray(value) ? value : [value]) {
        const lp = wikilinkTarget(x, app.packs !== undefined);
        const dest = lp == null ? null : app.metadataCache.getFirstLinkpathDest(lp, path);
        const to = dest ? reported.get(dest.path) : undefined;
        if (to !== undefined && visible(to)) targets.push([to, key]);
      }
    }
    const own = [...new Set(written.values())].filter((p) => !consequential.has(p) && visible(p)).sort();
    for (const v of violations) {
      for (const [to, column] of targets) add(to, { column, code: v.code, message: HIDDEN_CHECK_MESSAGE });
      if (targets.length > 0) continue;
      for (const to of own.length > 0 ? own : [""]) add(to, { code: v.code, message: HIDDEN_CHECK_MESSAGE });
    }
  }
  return moved;
}

/** The metastore a change set leaves when it rewrites metastore.yaml (undefined: it does not). */
export async function metastoreLeftBy(app: App, settings: DatanotesSettings, cs: ChangeSet): Promise<MetastoreState | undefined> {
  const path = metastorePath(settings);
  const text = cs.texts.filter((t) => t.path === path).pop()?.after;
  if (text === undefined) return undefined;
  const file = (await loadMetastore(app, settings))?.file ?? ({ path } as TFile);
  return { file, text, model: parseMetastore(text) };
}

/** The tables a change set adds, changes or removes rows of (by the rows' `table` before and after). */
function changedTables(app: App, settings: DatanotesSettings, model: Metastore, cs: ChangeSet): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const full = rowTableFull(model, v);
    if (full !== null) out.add(full);
  };
  const keep = new Set([settings.tableKey]);
  for (const e of cs.edits) {
    add(fmGet(e.before, settings.tableKey));
    add(fmGet(e.after, settings.tableKey));
  }
  for (const c of cs.creates) add(fmGet(readOrderedFromMarkdown(c.content, keep).ordered, settings.tableKey));
  for (const p of [...cs.deletes, ...cs.moves.map((m) => m.from)]) {
    const f = app.vault.getAbstractFileByPath(p);
    if (f && "extension" in f) add(app.metadataCache.getFileCache(f as TFile)?.frontmatter?.[settings.tableKey]);
  }
  return out;
}

/** First parts of a CHECK's dotted keys: the link columns it follows from the row. */
function linkHeads(where: unknown, out = new Set<string>()): Set<string> {
  if (where == null || typeof where !== "object" || Array.isArray(where)) return out;
  for (const [k, v] of Object.entries(where)) {
    if (LOGICAL_KEYS.has(k)) for (const w of Array.isArray(v) ? v : [v]) linkHeads(w, out);
    else if (k.indexOf(".") > 0) out.add(k.slice(0, k.indexOf(".")));
  }
  return out;
}

/**
 * The link rules `next` has that `prev` lacks or has otherwise: filtered link columns (`owner|column`)
 * and CHECKs that follow links (`owner|CHECK name`). A metastore put back by undo_migration or
 * restore_table holds every row of their tables to them, as alter_column and add_constraint do.
 */
function renewedRules(prev: Metastore, next: Metastore): Set<string> {
  const out = new Set<string>();
  const rule = (c: Record<string, unknown>) => JSON.stringify([c.type, c.items, c.ref, c.ref_where, c.ref_by]);
  for (const { ref, entry } of catalogTables(next)) {
    const was = new Map((modelColumns(prev, ref.full) ?? []).map((c) => [String(c.name), rule(c)]));
    for (const c of modelColumns(next, ref.full)!) { // a table of the model
      if ((c.ref_where ?? c.ref_by) != null && was.get(String(c.name)) !== rule(c)) out.add(`${ref.full}|${String(c.name)}`);
    }
    // a full name is never ambiguous: null when it was not a table before (every CHECK is new)
    const p = resolveCatalogRef(prev, ref.full);
    const old = p ? prev.catalogs[p.catalog]?.schemas[p.schema]?.tables[p.table]?.constraints ?? {} : {};
    for (const [name, where] of Object.entries(entry.constraints ?? {})) {
      if (followsLinks(where) && JSON.stringify(old[name]) !== JSON.stringify(where)) out.add(`${ref.full}|CHECK ${name}`);
    }
  }
  return out;
}

/** The suffix of a refusal of a row the change breaks through a row it links to, naming that row when known. */
function afterChangeTo(names: readonly string[]): string {
  if (names.length === 0) return " (after this change to a row it links to)";
  return ` (after this change to ${names.map((n) => `[[${n}]]`).join(", ")}, ${names.length > 1 ? "rows" : "a row"} it links to)`;
}

/**
 * CHECKs that follow links, on the state a change set leaves (insert / update / merge / delete /
 * move / adopt, the inverse-link edits added to them, align_relations, undo_migration and
 * restore_table). Rows the change set writes are checked in full, like their other CHECKs. Other
 * rows are checked when a CHECK of their table reads a table the change set changes (through a
 * link: the rows that link to a changed row), and are refused only when the change breaks them
 * (they pass on the vault as it is): `kind: area` on a project whose workstreams require a parent
 * of kind project is refused, listing each workstream and naming the project. Renaming or moving a
 * row others link to keeps their links (they follow it, as the host rewrites them). Deleting or
 * archiving a row that others link to is refused by on_referenced (restrict) already; with set_null
 * the cleared links, and with ignore the links to a now missing row, are checked here and refuse
 * it when a CHECK needs them. A batch is checked step by step, each step on the vault the earlier
 * ones left, so a batch that re-parents the workstreams first and then changes the project's kind
 * succeeds. Filtered link columns (`ref_where` / `ref_by`) are checked the same way
 * ({@link linkTargetViolations}). Only tables whose own rows, or the rows they read through links,
 * the change set touches are looked at. `consequential`: paths the change set writes only because
 * of a change to a row they link to (links cleared by set_null, inverse-link edits): checked in
 * full, refused with the same suffix as the rows the change breaks. `metastore`: the metastore the
 * change set leaves when it rewrites it ({@link metastoreLeftBy}: undo_migration, restore_table,
 * define_base, set_table_bases): the rules are read from it, and a rule it adds or changes (see
 * renewedRules) holds every row of its table, not only the rows the change breaks.
 */
async function linkedCheckViolationsImpl(
  app: App,
  settings: DatanotesSettings,
  cs: ChangeSet,
  consequential: ReadonlySet<string> = new Set(),
  metastore?: MetastoreState,
): Promise<RowViolations[]> {
  const current = (await loadMetastore(app, settings))?.model;
  const model = metastore?.model ?? current;
  if (!model) return [];
  // rules the restored metastore puts back (or changes): every row of their table is checked
  const renewed = metastore && current ? renewedRules(current, model) : new Set<string>();
  const touched = changedTables(app, settings, model, cs);
  if (touched.size === 0 && renewed.size === 0) return [];
  const reads = (owner: string, reads: ReadonlySet<string>) => touched.has(owner) || [...reads].some((full) => touched.has(full));
  const owners = catalogTables(model).filter(({ ref, entry }) =>
    Object.entries(entry.constraints ?? {}).some(([name, w]) => followsLinks(w) && (renewed.has(`${ref.full}|CHECK ${name}`) || reads(ref.full, linkReads(model, ref.full, w)))),
  );
  const filtered = catalogTables(model).filter(({ ref }) =>
    modelColumns(model, ref.full)!.some((c) => { // a table of the model
      if ((c.ref_where ?? c.ref_by) == null) return false;
      const target = linkTargetOf(c, ref.full);
      return target !== null && (renewed.has(`${ref.full}|${String(c.name)}`) || reads(ref.full, linkReads(model, target, c.ref_where, new Set([target]))));
    }),
  );
  if (owners.length === 0 && filtered.length === 0) return [];
  // rows the change set writes, by their final path → the path it reports them under
  const written = new Map<string, string>([...cs.edits.map((e) => [e.path, e.path] as const), ...cs.creates.map((c) => [c.path, c.path] as const)]);
  for (const m of cs.moves) {
    const p = written.get(m.from);
    if (p === undefined) continue;
    written.delete(m.from);
    written.set(m.to, p);
  }
  const beforeOf = new Map(cs.edits.map((e) => [e.path, e.before]));
  const after = new CheckLinks(app, settings, cs, metastore);
  const before = new CheckLinks(app, settings, undefined, metastore);
  const out = new Map<string, Violation[]>();
  const add = (path: string, v: Violation) => out.set(path, [...(out.get(path) ?? []), v]);
  /** Suffix of a refusal of `r` (not written by the change, or written as a consequence of it). */
  const suffix = (r: LoadedRow, columns: readonly string[], own?: string) =>
    afterChangeTo(after.changedTargets(own ?? r.file.path, columns, r.ordered, own !== undefined ? beforeOf.get(own) : undefined));
  // rows undo_migration / restore_table / restore_database put back were not validated (links to no row included)
  const validated = cs.op !== "undo_migration" && cs.op !== "restore_table" && cs.op !== "restore_database";
  await linkTargetViolations(app, settings, filtered, written, consequential, after, before, add, suffix, renewed, metastore, validated);
  for (const { ref } of owners) {
    const s = await tableIn(app, settings, metastore, ref.full);
    for (const [name, where] of Object.entries(s.catalog.entry.constraints!)) { // an owner has CHECKs
      if (!followsLinks(where)) continue;
      const checkHint = constraintHints(s.catalog.entry)[name];
      const ownHint = checkHint ? { hint: checkHint } : {};
      await after.prepare(s, where);
      const rows = after.rowsOf(s);
      // a CHECK the change puts back holds every row, like add_constraint
      const restored = renewed.has(`${ref.full}|CHECK ${name}`);
      const affected = restored || [...after.reads(s, where)].some((full) => after.changes(full));
      if (!affected && !rows.some((r) => written.has(r.file.path))) continue;
      const heads = [...linkHeads(where)];
      let passes: (row: LoadedRow) => boolean;
      try {
        passes = compileCheck(where as Where, s, settings, after);
      } catch (e) {
        for (const r of rows) {
          const p = written.get(r.file.path);
          if (p !== undefined) add(p, { constraint: name, code: "check", message: `CHECK ${name} is invalid: ${messageOf(e)}` });
        }
        continue;
      }
      let passed: ((row: LoadedRow) => boolean) | undefined;
      for (const r of rows) {
        const own = written.get(r.file.path);
        if (own === undefined && !affected) continue;
        if (passes(r)) continue;
        const message = `violates CHECK ${name}: ${JSON.stringify(where)}`;
        if (own === undefined && restored) {
          add(r.file.path, { constraint: name, code: "check", message: `${message} (CHECK ${name} comes back with this change)`, ...ownHint });
          continue;
        }
        if (own === undefined) {
          // not written by this change: refused only when the change breaks it
          if (!passed) {
            await before.prepare(s, where);
            // it compiled above, on the same tables (`before` reads the metastore `after` reads)
            passed = compileCheck(where as Where, s, settings, before);
          }
          if (passed(r)) add(r.file.path, { constraint: name, code: "check", message: `${message}${suffix(r, heads)}`, ...ownHint });
          continue;
        }
        add(own, { constraint: name, code: "check", message: consequential.has(own) ? `${message}${suffix(r, heads, own)}` : message, ...ownHint });
      }
    }
  }
  const scope = currentReadScope();
  const answer = scope ? movedOffHiddenRows(app, settings, cs, written, consequential, out, scope) : out;
  return [...answer].map(([path, violations]) => ({ path, violations }));
}

/** {@link linkedCheckViolationsImpl}, traced: the CHECKs and link rules a change set must hold. */
export function linkedCheckViolations(...args: Parameters<typeof linkedCheckViolationsImpl>): Promise<RowViolations[]> {
  return phase("engine.checks", async (span) => {
    const v = await linkedCheckViolationsImpl(...args);
    span.setAttribute("datanotes.violating_rows", v.length);
    return v;
  }, { "datanotes.checks.kind": "linked" });
}
