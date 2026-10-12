/**
 * Inverse link columns: `friends` ↔ `friends`, `children` ↔ `parents`, `partner` ↔ `partner`.
 * A column with `inverse: <col>` (declared on either side) keeps the other side in step:
 *
 * - every write through the engine adds the reciprocal links to the linked rows in the same
 *   operation (one journal entry, one undo);
 * - a link added or removed by hand in Obsidian is mirrored a few seconds later (`sync_relations`);
 * - `align_relations` adds the reciprocal links that are missing (existing data), and
 *   `check_table` reports rows whose links are not reciprocated.
 *
 * Single-value columns (`partner`): setting it on one row replaces the other row's previous value,
 * whose own link is removed in turn.
 */

import type { App, TFile } from "./host";
import { readParsed } from "./file-cache";
import { fmGet, fmSet, readOrderedFromMarkdown } from "./frontmatter";
import { cachedMetastore, catalogTables, effectiveColumns, loadMetastore, rowTableFull, type Metastore } from "./metastore";
import type { DatanotesSettings } from "./settings";
import type { OrderedFrontmatter } from "./types";

export interface InverseSpec {
  table: string;
  column: string;
  single: boolean;
  target: string;
  targetColumn: string;
  targetSingle: boolean;
}

/** Inverse pairs by table, both directions (a pair declared on one side only is mirrored). */
export function inverseSpecs(model: Metastore): Map<string, InverseSpec[]> {
  const cols = new Map<string, Record<string, unknown>[]>();
  for (const { ref, entry } of catalogTables(model)) {
    try {
      cols.set(ref.full, effectiveColumns(model, ref, entry));
    } catch {
      // a malformed table is reported by the loader
    }
  }
  const isSingle = (c: Record<string, unknown> | undefined) => c?.type === "link";
  const out = new Map<string, InverseSpec[]>();
  const seen = new Set<string>();
  const add = (s: InverseSpec) => {
    const key = `${s.table}.${s.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.set(s.table, [...(out.get(s.table) ?? []), s]);
  };
  for (const [table, columns] of cols) {
    for (const c of columns) {
      if (typeof c.inverse !== "string" || typeof c.ref !== "string") continue;
      const target = c.ref; // effectiveColumns names "self" in full
      const back = cols.get(target)?.find((x) => String(x.name) === c.inverse);
      if (!back) continue;
      add({ table, column: String(c.name), single: isSingle(c), target, targetColumn: String(back.name), targetSingle: isSingle(back) });
      add({ table: target, column: String(back.name), single: isSingle(back), target: table, targetColumn: String(c.name), targetSingle: isSingle(c) });
    }
  }
  return out;
}

const LINK_RE = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/;

/** Vault paths a link value (one link or a list) points to, resolved from `source`. */
export function linkTargets(app: App, value: unknown, source: string): string[] {
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const out: string[] = [];
  for (const v of items) {
    const m = typeof v === "string" ? LINK_RE.exec(v.trim()) : null;
    if (!m) continue;
    const dest = app.metadataCache.getFirstLinkpathDest(m[1]!.trim(), source)?.path;
    if (dest && !out.includes(dest)) out.push(dest);
  }
  return out;
}

/** A wikilink to `path` as Obsidian would write it from `source`. */
export function linkTo(app: App, path: string, source: string): string {
  const f = app.vault.getAbstractFileByPath(path);
  const mc = app.metadataCache as unknown as { fileToLinktext?: (f: TFile, source: string, omitMd?: boolean) => string };
  if (f && "extension" in f && typeof mc.fileToLinktext === "function") return `[[${mc.fileToLinktext(f as TFile, source, true)}]]`;
  const base = path.split("/").pop()!.replace(/\.md$/i, ""); // split() returns at least one element
  const clash = app.vault.getMarkdownFiles().filter((x) => x.basename === base).length > 1;
  return `[[${clash ? path.replace(/\.md$/i, "") : base}]]`;
}

/** A row change: the targets of each inverse column before and after. */
export interface RowChange {
  path: string;
  table: string;
  before: Map<string, string[]>;
  after: Map<string, string[]>;
  /**
   * The row's path before a rename made outside the engine: a link to it left in a row it links
   * to is the row's own, and the new link replaces it instead of being added next to it.
   */
  oldPath?: string;
}

/** Whether a link value names `path` (all of it without `.md`, or its end), ignoring case, as a link written to it would. */
function namesPath(value: unknown, path: string): boolean {
  const m = typeof value === "string" ? LINK_RE.exec(value.trim()) : null;
  if (!m) return false;
  const lp = m[1]!.trim().replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase(); // LINK_RE has the target
  const p = path.replace(/\.md$/i, "").toLowerCase();
  return lp !== "" && (p === lp || p.endsWith(`/${lp}`));
}

export interface InversePlan {
  /** New frontmatter of every row to change (before = as read). */
  edits: Map<string, { before: OrderedFrontmatter; after: OrderedFrontmatter }>;
  /** Single-value targets already linked elsewhere (only with `keepSingles`). */
  conflicts: { path: string; message: string }[];
}

export interface PlanOptions {
  /** Current frontmatter of rows the same operation already changes (their state after it). */
  known?: Map<string, OrderedFrontmatter>;
  /** Do not replace a single-value link that points elsewhere: report it instead. */
  keepSingles?: boolean;
  /** Final path of rows the operation moves (links are written to the final path). */
  finalPath?: (path: string) => string;
}

function rowKey(settings: DatanotesSettings): string {
  return `row|${settings.tableKey}`;
}

export async function readRowFrontmatter(app: App, settings: DatanotesSettings, path: string): Promise<OrderedFrontmatter | null> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!f || !("extension" in f)) return null;
  const keep = new Set([settings.tableKey]);
  const { ordered } = await readParsed(app, f as TFile, rowKey(settings), (t) => readOrderedFromMarkdown(t, keep));
  return ordered;
}

/** Targets of each inverse column of a row (from its frontmatter). */
export function inverseTargets(app: App, specs: readonly InverseSpec[], ordered: OrderedFrontmatter | Record<string, unknown>, source: string): Map<string, string[]> {
  const get = (k: string) => (Array.isArray(ordered) ? fmGet(ordered as OrderedFrontmatter, k) : (ordered as Record<string, unknown>)[k]);
  return new Map(specs.map((s) => [s.column, linkTargets(app, get(s.column), source)]));
}

export async function planInverse(
  app: App,
  settings: DatanotesSettings,
  model: Metastore,
  changes: readonly RowChange[],
  opts: PlanOptions = {},
): Promise<InversePlan> {
  const specs = inverseSpecs(model);
  const final = opts.finalPath ?? ((p: string) => p);
  const work = new Map<string, { before: OrderedFrontmatter; after: OrderedFrontmatter }>();
  const conflicts: InversePlan["conflicts"] = [];

  const load = async (path: string) => {
    let w = work.get(path);
    if (!w) {
      const known = opts.known?.get(path);
      const current = known ?? (await readRowFrontmatter(app, settings, path));
      if (!current) return null;
      w = { before: current, after: current.map(([k, v]) => [k, v] as [string, unknown]) };
      work.set(path, w);
    }
    return w;
  };
  const isRowOf = (fm: OrderedFrontmatter, table: string) => rowTableFull(model, fmGet(fm, settings.tableKey)) === table;

  /** Make `holder`'s `column` (on `table`) link to `to` (or not); `was`: `to`'s path before a rename by hand. */
  const setLink = async (holder: string, table: string, column: string, single: boolean, to: string, present: boolean, from: InverseSpec, was?: string) => {
    const w = await load(holder);
    if (!w || !isRowOf(w.after, table)) return;
    const cur = linkTargets(app, fmGet(w.after, column), holder);
    const link = linkTo(app, final(to), final(holder));
    if (single) {
      if (present) {
        if (cur[0] === to) return;
        const prev = cur[0];
        if (prev && opts.keepSingles) {
          conflicts.push({ path: holder, message: `"${column}" already links to ${prev}: not replaced by ${to}` });
          return;
        }
        w.after = fmSet(w.after, column, link);
        // The previous partner no longer links back.
        if (prev && prev !== holder) await setLink(prev, from.table, from.column, from.single, holder, false, from);
      } else if (cur[0] === to) {
        w.after = fmSet(w.after, column, null);
      }
      return;
    }
    const raw = fmGet(w.after, column);
    const list = Array.isArray(raw) ? [...raw] : raw === null || raw === undefined || raw === "" ? [] : [raw];
    if (present) {
      if (cur.includes(to)) return;
      // the link to the row's old name, broken since it was renamed by hand, is replaced: never both
      const stale = was === undefined ? -1 : list.findIndex((v) => namesPath(v, was) && linkTargets(app, v, holder).length === 0);
      w.after = fmSet(w.after, column, stale < 0 ? [...list, link] : list.map((v, i) => (i === stale ? link : v)));
    } else if (cur.includes(to)) {
      w.after = fmSet(w.after, column, list.filter((v) => !linkTargets(app, v, holder).includes(to)));
    }
  };

  for (const ch of changes) {
    for (const s of specs.get(ch.table) ?? []) {
      const before = ch.before.get(s.column) ?? [];
      const after = ch.after.get(s.column) ?? [];
      for (const t of after.filter((x) => !before.includes(x))) await setLink(t, s.target, s.targetColumn, s.targetSingle, ch.path, true, s, ch.oldPath);
      for (const t of before.filter((x) => !after.includes(x))) await setLink(t, s.target, s.targetColumn, s.targetSingle, ch.path, false, s);
    }
  }

  const edits: InversePlan["edits"] = new Map();
  for (const [path, w] of work) {
    if (JSON.stringify(w.before) !== JSON.stringify(w.after)) edits.set(path, w);
  }
  return { edits, conflicts };
}

/** Rows (paths) whose links are not reciprocated, with a message per missing back-link. */
export async function missingBackLinks(
  app: App,
  settings: DatanotesSettings,
  model: Metastore,
  table: string,
  rows: readonly { path: string; ordered: OrderedFrontmatter }[],
): Promise<Map<string, { column: string; message: string; value: string }[]>> {
  const specs = inverseSpecs(model).get(table) ?? [];
  const out = new Map<string, { column: string; message: string; value: string }[]>();
  if (specs.length === 0) return out;
  for (const r of rows) {
    for (const s of specs) {
      for (const t of linkTargets(app, fmGet(r.ordered, s.column), r.path)) {
        const fm = await readRowFrontmatter(app, settings, t);
        if (!fm || rowTableFull(model, fmGet(fm, settings.tableKey)) !== s.target) continue;
        if (linkTargets(app, fmGet(fm, s.targetColumn), t).includes(r.path)) continue;
        const list = out.get(r.path) ?? [];
        list.push({ column: s.column, value: t, message: `${t} does not link back in "${s.targetColumn}" (align_relations adds it)` });
        out.set(r.path, list);
      }
    }
  }
  return out;
}

/**
 * Inverse edits for a change set's own row edits and creates (applied in the same operation).
 * Returns the extra note edits and how to patch the change set's own entries.
 */
export async function inverseEditsFor(
  app: App,
  settings: DatanotesSettings,
  rows: { path: string; before: OrderedFrontmatter; after: OrderedFrontmatter }[],
  finalPath: (p: string) => string,
): Promise<InversePlan | null> {
  const ms = cachedMetastore(app, settings) ? { model: cachedMetastore(app, settings)! } : await loadMetastore(app, settings);
  if (!ms) return null;
  const specs = inverseSpecs(ms.model);
  if (specs.size === 0) return null;
  const changes: RowChange[] = [];
  const known = new Map<string, OrderedFrontmatter>();
  for (const r of rows) {
    known.set(r.path, r.after);
    const table = rowTableFull(ms.model, fmGet(r.after, settings.tableKey)) ?? rowTableFull(ms.model, fmGet(r.before, settings.tableKey));
    const s = table ? specs.get(table) : undefined;
    if (!table || !s) continue;
    const before = inverseTargets(app, s, r.before, r.path);
    const after = inverseTargets(app, s, r.after, r.path);
    if (JSON.stringify([...before]) === JSON.stringify([...after])) continue;
    changes.push({ path: r.path, table, before, after });
  }
  if (changes.length === 0) return null;
  return planInverse(app, settings, ms.model, changes, { known, finalPath });
}

/** A row's inverse links as the watcher last saw them. */
interface Snapshot {
  table: string;
  id?: string;
  targets: Map<string, string[]>;
}

/** How long a deleted row's links are kept, to recognize it created again under another name (a rename by hand). */
export const REMOVED_ROW_MS = 60_000;

/**
 * Mirrors links edited by hand: remembers each row's inverse links and, when a row changes,
 * reports what was added or removed (`onChange` runs the sync). A row renamed outside the engine
 * keeps its links: by the vault's `rename` event, or, when the vault saw a delete and a create, by
 * its id (the same table and id created again within {@link REMOVED_ROW_MS}). Its links are then
 * not added again to the rows it links to.
 */
export class InverseWatcher {
  private snapshot = new Map<string, Snapshot>();
  /** Rows deleted lately, by their last path. */
  private removed = new Map<string, Snapshot & { at: number }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private ready = false;

  constructor(
    private readonly app: App,
    private readonly settings: () => DatanotesSettings,
    private readonly onChange: (changes: RowChange[]) => Promise<void>,
    private readonly delayMs = 2000,
  ) {}

  private specsFor(path: string): { table: string; specs: InverseSpec[]; fm: Record<string, unknown> } | null {
    const s = this.settings();
    const model = cachedMetastore(this.app, s);
    if (!model) return null;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !("extension" in f)) return null;
    const fm = this.app.metadataCache.getFileCache(f as TFile)?.frontmatter as Record<string, unknown> | undefined;
    const table = fm ? rowTableFull(model, fm[s.tableKey]) : null;
    const specs = table ? inverseSpecs(model).get(table) : undefined;
    return table && specs ? { table, specs, fm: fm! } : null;
  }

  private current(path: string): Snapshot | null {
    const t = this.specsFor(path);
    if (!t) return null;
    const fm = t.fm;
    return { table: t.table, ...(typeof fm.id === "string" ? { id: fm.id } : {}), targets: inverseTargets(this.app, t.specs, fm, path) };
  }

  /** Remember every row's links (call once the metastore is loaded). */
  init(): void {
    this.snapshot.clear();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const c = this.current(f.path);
      if (c) this.snapshot.set(f.path, c);
    }
    this.ready = true;
  }

  onChanged(path: string): void {
    if (!this.ready || !path.endsWith(".md")) return;
    const prev = this.timers.get(path);
    if (prev !== undefined) clearTimeout(prev);
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.flush(path);
      }, this.delayMs),
    );
  }

  /** Compare a row with what was remembered and sync the difference. */
  async flush(path: string): Promise<void> {
    let before = this.snapshot.get(path);
    const now = this.current(path);
    if (now) this.snapshot.set(path, now);
    else this.snapshot.delete(path);
    if (!now) return;
    let oldPath: string | undefined;
    if (!before && now.id !== undefined) {
      // a row renamed outside, seen as deleted and created: the same table and id
      const hit = [...this.removed].find(([, s]) => s.table === now.table && s.id === now.id);
      if (hit) {
        [oldPath, before] = hit;
        this.removed.delete(oldPath);
      }
    }
    const prior = before && before.table === now.table ? before.targets : new Map<string, string[]>();
    if (JSON.stringify([...prior]) === JSON.stringify([...now.targets])) return;
    await this.onChange([{ path, table: now.table, before: prior, after: now.targets, ...(oldPath !== undefined ? { oldPath } : {}) }]);
  }

  onRenamed(oldPath: string, newPath: string): void {
    const s = this.snapshot.get(oldPath);
    this.snapshot.delete(oldPath);
    if (s) this.snapshot.set(newPath, s);
  }

  onDeleted(path: string): void {
    const s = this.snapshot.get(path);
    this.snapshot.delete(path);
    const now = Date.now();
    for (const [p, r] of this.removed) if (now - r.at > REMOVED_ROW_MS) this.removed.delete(p);
    if (s?.id !== undefined) this.removed.set(path, { ...s, at: now });
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
