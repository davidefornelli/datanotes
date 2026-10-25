/**
 * CHECKs that follow links (`parent.kind`), and the state they read: {@link CheckLinks} loads the
 * rows a CHECK or a filtered link column reaches through links, as the vault has them or as a
 * change set leaves them.
 */

import type { App, TFile } from "./host";
import type { ChangeSet } from "./changeset";
import { cachedMetastore, resolveCatalogRef, rowTableFull, type Metastore } from "./metastore";
import { archiveFolder, catalogLoadedTable, loadRows, loadTable, OperationInputError, type LoadedRow, type LoadedTable } from "./engine";
import { fmGet, readOrderedFromMarkdown } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { isArchivedPath, tableNotFound, validationContextFor } from "./table-registry";
import type { TableColumn } from "./types-table";
import type { OrderedFrontmatter } from "./types";
import { isEmptyValue, parseWikilink, wikilinkTarget, type ValidationContext } from "./validate";
import { basenameOf } from "./path-templates";
import { compileWhere, LOGICAL_KEYS, rowGetter, type Where } from "./where";

/** True when a CHECK has a dotted key (`link.column`), at any depth of or / and / not. */
export function followsLinks(where: unknown): boolean {
  if (where == null || typeof where !== "object" || Array.isArray(where)) return false;
  return Object.entries(where).some(([k, v]) => (LOGICAL_KEYS.has(k) ? (Array.isArray(v) ? v : [v]).some(followsLinks) : k.indexOf(".") > 0));
}

/** A link (or list-of-links) column of `t` with a `ref`. */
export function refLinkColumn(t: LoadedTable, name: string): TableColumn | undefined {
  const c = t.def.columns.find((x) => x.name === name);
  return c && c.ref && (c.type === "link" || (c.type === "list" && c.items === "link")) ? c : undefined;
}

/**
 * What a CHECK that follows links reads: the rows of the tables its dotted keys reach, loaded once
 * per validation call (not per row) and found by path. A link is resolved as the host resolves it
 * (`getFirstLinkpathDest`, from the note that holds it: same-named rows in different folders stay
 * apart). Built on a change set it is the state after it: edited rows have their new values,
 * created rows have joined their table, deleted, archived and moved-out rows are gone, and a
 * renamed or moved row goes by its new path, with the links to it following it (as the host
 * rewrites them when the change is applied); a link naming a row the change set creates or renames
 * resolves to it (case-insensitive, as in Obsidian). A link column whose `ref` is not a table (a
 * renamed or dropped table) makes the CHECKs that follow it invalid instead of failing the call.
 * {@link prepare} loads what a CHECK needs; compiling it (compileCheck) is then synchronous.
 * `metastore`: the metastore the change set leaves when it rewrites it (undo_migration and
 * restore_table putting an older one back): linked tables are read from it, not the current one.
 */
export class CheckLinks {
  private readonly tables = new Map<string, LoadedTable>();
  /** Link columns whose `ref` is not a table: why (key as in `tables`). */
  private readonly missing = new Map<string, string>();
  private readonly rows = new Map<string, Map<string, LoadedRow>>();
  private readonly touched = new Set<string>();
  /** Paths the change set writes, creates, deletes or moves (both ends). */
  private readonly changed = new Set<string>();
  private readonly movedTo = new Map<string, string>();
  private readonly movedFrom = new Map<string, string>();
  /** Paths that exist only after the change set (created rows, new paths of moved rows). */
  private readonly fresh: string[] = [];
  private readonly resolved = new Map<string, string | null>();

  /** `skipUnreadable`: rows whose frontmatter cannot be read are left out (the checks of hand edits), instead of failing. */
  constructor(
    private readonly app: App,
    private readonly settings: DatanotesSettings,
    private readonly cs?: ChangeSet,
    private readonly metastore?: MetastoreState,
    private readonly skipUnreadable = false,
  ) {
    if (!cs) return;
    for (const e of cs.edits) this.changed.add(e.path);
    for (const c of cs.creates) {
      this.changed.add(c.path);
      this.fresh.push(c.path);
    }
    for (const p of cs.deletes) this.changed.add(p);
    for (const m of cs.moves) {
      this.movedTo.set(m.from, m.to);
      this.movedFrom.set(m.to, m.from);
      this.changed.add(m.from).add(m.to);
      this.fresh.push(m.to);
    }
  }

  /** Load the tables and rows `where`'s dotted keys reach from `t` (and `t`'s own rows). */
  async prepare(t: LoadedTable, where: unknown): Promise<void> {
    await this.load(t);
    if (where == null || typeof where !== "object" || Array.isArray(where)) return;
    for (const [col, cond] of Object.entries(where)) {
      if (LOGICAL_KEYS.has(col)) {
        for (const w of Array.isArray(cond) ? cond : [cond]) await this.prepare(t, w);
        continue;
      }
      const dot = col.indexOf(".");
      const via = dot > 0 ? refLinkColumn(t, col.slice(0, dot)) : undefined;
      if (!via) continue; // compiling reports it
      const target = await this.target(t, via);
      if (target) await this.prepare(target, { [col.slice(dot + 1)]: cond });
    }
  }

  /** The table a link column of `t` points to (loaded once); undefined when its `ref` is not a table. */
  private async target(t: LoadedTable, via: TableColumn): Promise<LoadedTable | undefined> {
    const key = `${t.catalog.ref.full}|${via.ref}`;
    if (this.tables.has(key)) return this.tables.get(key);
    if (this.missing.has(key)) return undefined;
    if (via.ref === t.catalog.ref.full) {
      this.tables.set(key, t);
      return t;
    }
    if (rowTableFull(t.catalog.model, via.ref) === null) {
      this.missing.set(key, `"${via.name}" links to ${via.ref}, which is not a table (renamed or dropped?)`);
      return undefined;
    }
    const table = await tableIn(this.app, this.settings, this.metastore, via.ref!);
    this.tables.set(key, table);
    return table;
  }

  /** The table a link column of `t` points to, with its rows by path (both loaded once), and `t`'s rows (unless `source` is false). */
  async linked(t: LoadedTable, column: string, source = true): Promise<{ table: LoadedTable; rows: ReadonlyMap<string, LoadedRow> }> {
    const via = refLinkColumn(t, column);
    if (!via) throw new OperationInputError(`"${column}" is not a link column with ref`);
    if (source) await this.load(t);
    const table = await this.target(t, via);
    if (!table) throw new OperationInputError(this.missing.get(`${t.catalog.ref.full}|${via.ref}`)!);
    await this.load(table);
    return { table, rows: this.rows.get(table.catalog.ref.full)! };
  }

  /** Full names of the tables whose rows this has read. */
  loadedTables(): string[] {
    return [...this.rows.keys()];
  }

  /** The rows of a prepared table, by full name. */
  rowsOf(t: LoadedTable): LoadedRow[] {
    return [...(this.rows.get(t.catalog.ref.full)?.values() ?? [])];
  }

  /** True when the change set adds, changes or removes a row of the table. */
  changes(full: string): boolean {
    return this.touched.has(full);
  }

  /** Full names of the tables `where`'s dotted keys read from `t` (prepared). */
  reads(t: LoadedTable, where: unknown, out = new Set<string>()): Set<string> {
    if (where == null || typeof where !== "object" || Array.isArray(where)) return out;
    for (const [col, cond] of Object.entries(where)) {
      if (LOGICAL_KEYS.has(col)) {
        for (const w of Array.isArray(cond) ? cond : [cond]) this.reads(t, w, out);
        continue;
      }
      const dot = col.indexOf(".");
      const via = dot > 0 ? refLinkColumn(t, col.slice(0, dot)) : undefined;
      const target = via ? this.tables.get(`${t.catalog.ref.full}|${via.ref}`) : undefined;
      if (!target) continue;
      out.add(target.catalog.ref.full);
      this.reads(target, { [col.slice(dot + 1)]: cond }, out);
    }
    return out;
  }

  /**
   * The path a link value of the row at `source` names in this state: resolved as the host
   * resolves it on the vault as it is, then through the change set's moves; a link the vault
   * cannot resolve may name a row the change set creates or renames. A row in a table's archive
   * folder is gone, as a deleted one: a link to it names nothing. Null: not a link, or a link to
   * nothing.
   */
  resolve(value: unknown, source: string): string | null {
    const lp = parseWikilink(value);
    if (lp == null) return null;
    // with its #heading on a host with packs of rows ([[pack#row]])
    const lookup = wikilinkTarget(value, this.app.packs !== undefined)!;
    const from = this.movedFrom.get(source) ?? source;
    const key = `${lookup}\u0000${from}`;
    const known = this.resolved.get(key);
    if (known !== undefined) return known;
    const dest = this.locate(lookup, from);
    const out = dest !== null && !this.archived(dest) ? dest : this.freshTarget(lp);
    this.resolved.set(key, out);
    return out;
  }

  /** Where the host's link resolution leads in this state, archive included (null: nowhere). */
  private locate(linkpath: string, from: string): string | null {
    const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, from)?.path ?? null;
    return dest !== null ? this.movedTo.get(dest) ?? dest : null;
  }

  private archived(path: string): boolean {
    return isArchivedPath(this.app, this.settings, path, this.metastore?.model ?? cachedMetastore(this.app, this.settings));
  }

  /** A path the change set creates or moves a row to that `linkpath` names (case-insensitive, like Obsidian); not an archive. */
  private freshTarget(linkpath: string): string | null {
    if (this.fresh.length === 0) return null;
    const fold = (s: string) => s.normalize("NFC").toLowerCase();
    const want = fold(linkpath.replace(/^\/+/, "").replace(/\.md$/i, ""));
    const hits = this.fresh.filter((p) => {
      if (this.archived(p)) return false;
      const have = fold(p.replace(/\.md$/i, ""));
      return have === want || have.endsWith(`/${want}`);
    });
    return hits.find((p) => fold(p.replace(/\.md$/i, "")) === want) ?? hits.sort()[0] ?? null;
  }

  /**
   * Names of the rows the change set changes that `ordered` (a row at `source`) links to through
   * `columns` (also through `before`, its values before the change: links a change cleared).
   */
  changedTargets(source: string, columns: readonly string[], ordered: OrderedFrontmatter, before?: OrderedFrontmatter): string[] {
    const out = new Set<string>();
    for (const o of before ? [ordered, before] : [ordered]) {
      for (const c of columns) {
        const v = fmGet(o, c);
        for (const x of Array.isArray(v) ? v : [v]) {
          // a row the change set archives is changed by it too
          const lp = wikilinkTarget(x, this.app.packs !== undefined);
          const p = lp == null ? null : this.locate(lp, this.movedFrom.get(source) ?? source) ?? this.resolve(x, source);
          if (p !== null && this.changed.has(p)) out.add(basenameOf(this.movedTo.get(p) ?? p));
        }
      }
    }
    return [...out].sort();
  }

  /**
   * The test of one dotted key on rows of `t`: every row its link names must exist and match the
   * rest of the key; an empty link fails (compileCheck skips it at the top level).
   */
  test(t: LoadedTable, col: string, cond: unknown): (row: LoadedRow) => boolean {
    const dot = col.indexOf(".");
    const head = col.slice(0, dot);
    const via = refLinkColumn(t, head);
    if (!via) throw new OperationInputError(`where "${col}": "${head}" is not a link column with ref`);
    const key = `${t.catalog.ref.full}|${via.ref}`;
    const target = this.tables.get(key);
    const byPath = target ? this.rows.get(target.catalog.ref.full) : undefined;
    if (!target || !byPath) throw new OperationInputError(this.missing.get(key) ?? `CHECK links not loaded for "${col}"`);
    const pred = compileWhere({ [col.slice(dot + 1)]: cond } as Where, target, this.settings, rowGetter(null, target, this.settings), this);
    return (row) => {
      const v = fmGet(row.ordered, head);
      const paths = (Array.isArray(v) ? v : [v]).filter((x) => !isEmptyValue(x)).map((x) => this.resolve(x, row.file.path));
      return paths.length > 0 && paths.every((p) => {
        const r = p == null ? undefined : byPath.get(p);
        return r !== undefined && pred(r);
      });
    };
  }

  /** The `table` value of the paths the change set writes (null: no note there after it), read when first asked. */
  private tableValues: Map<string, unknown> | null = null;

  /**
   * The qualified table of the row at `path` in this state (null: no row there): the change set's
   * notes as it leaves them, the others as the vault has them.
   */
  tableOf(path: string): string | null {
    if (!this.tableValues) {
      const tv = new Map<string, unknown>();
      const tp = this.settings.tableKey;
      for (const e of this.cs?.edits ?? []) tv.set(e.path, fmGet(e.after, tp) ?? null);
      for (const c of this.cs?.creates ?? []) tv.set(c.path, fmGet(readOrderedFromMarkdown(c.content, new Set([tp])).ordered, tp) ?? null);
      for (const p of this.cs?.deletes ?? []) tv.set(p, null);
      for (const m of this.cs?.moves ?? []) {
        if (tv.has(m.from)) tv.set(m.to, tv.get(m.from));
        tv.set(m.from, null);
      }
      this.tableValues = tv;
    }
    const vault = (p: string) => validationContextFor(this.app, this.settings, p).tableOfPath!(p);
    if (this.tableValues.has(path)) {
      const raw = this.tableValues.get(path);
      const model = this.metastore?.model ?? cachedMetastore(this.app, this.settings);
      return raw == null || !model ? null : rowTableFull(model, raw);
    }
    const from = this.movedFrom.get(path);
    return from !== undefined ? vault(from) : vault(path);
  }

  /** How row validation reads links from the row at `source` in this state (see {@link resolve} and {@link tableOf}). */
  context(source: string): ValidationContext {
    return {
      ...validationContextFor(this.app, this.settings, source),
      resolveLink: (linkpath) => this.resolve(`[[${linkpath}]]`, source),
      linkSubpaths: this.app.packs !== undefined,
      tableOfPath: (path) => this.tableOf(path),
    };
  }

  private async load(t: LoadedTable): Promise<void> {
    const full = t.catalog.ref.full;
    if (this.rows.has(full)) return;
    const state = new Map((await loadRows(this.app, this.settings, t, this.skipUnreadable)).map((r) => [r.file.path, r]));
    const cs = this.cs;
    if (cs) {
      const archive = `${archiveFolder(t.def)}/`;
      // notes in the table's `exclude` folders are not its rows (as loadRows reads them)
      const excluded = (p: string) => p.startsWith(archive) || (t.def.options.exclude ?? []).some((dir) => p.startsWith(`${dir}/`));
      const owns = (o: OrderedFrontmatter) => rowTableFull(t.catalog.model, fmGet(o, this.settings.tableKey)) === full;
      const put = (path: string, ordered: OrderedFrontmatter) => {
        const prev = state.get(path);
        state.set(path, { file: prev?.file ?? ({ path } as TFile), ordered });
        this.touched.add(full);
      };
      const drop = (path: string) => {
        if (state.delete(path)) this.touched.add(full);
      };
      for (const e of cs.edits) {
        if (owns(e.after) && (state.has(e.path) || !excluded(e.path))) put(e.path, e.after);
        else drop(e.path);
      }
      for (const c of cs.creates) {
        const { ordered } = readOrderedFromMarkdown(c.content, new Set([this.settings.tableKey]));
        if (owns(ordered)) put(c.path, ordered);
      }
      for (const p of cs.deletes) drop(p);
      for (const m of cs.moves) {
        const r = state.get(m.from);
        if (!r) continue;
        drop(m.from);
        if (!m.to.startsWith(archive)) {
          state.set(m.to, { ...r, file: { path: m.to } as TFile });
          this.touched.add(full);
        }
      }
    }
    this.rows.set(full, state);
  }
}

/** A metastore as loaded, or as a change set leaves it (see {@link CheckLinks}). */
export interface MetastoreState {
  file: TFile;
  text: string;
  model: Metastore;
}

/** Table `full` of `metastore` (the current one when undefined). */
export async function tableIn(app: App, settings: DatanotesSettings, metastore: MetastoreState | undefined, full: string): Promise<LoadedTable> {
  if (!metastore) return loadTable(app, settings, full);
  const ref = resolveCatalogRef(metastore.model, full);
  if (!ref) throw tableNotFound(full, metastore.model);
  return catalogLoadedTable(settings, metastore, ref);
}
