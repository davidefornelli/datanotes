/**
 * The paths a `where` filter reads through links (`parent.kind`: the `kind` column of the row
 * `parent` links to), worked out on the metastore alone: which tables a link-following CHECK or a
 * `ref_where` / `ref_by` reads, and the rewrites rename_column / rename_value make in them.
 */

import { catalogTables, effectiveColumns, resolveCatalogRef, type CatalogRef, type CatalogTableEntry, type Metastore } from "./metastore";

const LOGICAL = new Set(["or", "and", "not"]);

/** The columns of a table (inherited ones included, `ref: self` as the full name), or null when there is no such table. */
export function modelColumns(model: Metastore, full: string): Record<string, unknown>[] | null {
  let ref;
  try {
    ref = resolveCatalogRef(model, full);
  } catch {
    return null;
  }
  const entry = ref ? model.catalogs[ref.catalog]?.schemas[ref.schema]?.tables[ref.table] : undefined;
  if (!ref || !entry) return null;
  try {
    return effectiveColumns(model, ref, entry);
  } catch {
    return entry.columns.map((c) => (c.ref === "self" ? { ...c, ref: ref.full } : c));
  }
}

/** The table a link column (or list of links) with `ref` points to; `self` is `owner`. */
export function linkTargetOf(c: Record<string, unknown> | undefined, owner: string): string | null {
  if (!c || c.ref === undefined || c.ref === null) return null;
  if (!(c.type === "link" || (c.type === "list" && c.items === "link"))) return null;
  return c.ref === "self" ? owner : String(c.ref);
}

/** What a rewrite of a `where` does: each key part read on (table, column), each condition on its last column. */
export interface WhereRewrite {
  /** The new name of a key part (default: unchanged). */
  key?: (table: string, column: string) => string;
  /** The new condition on the key's last column (default: unchanged). */
  cond?: (table: string, column: string, cond: unknown) => unknown;
  /** Called for every link a dotted key follows: `column` of `table` to `target`. */
  hop?: (table: string, column: string, target: string) => void;
  /** The columns of a table the walk is on (default: {@link modelColumns}), for tables the model does not name. */
  columns?: (table: string) => Record<string, unknown>[] | null;
}

/**
 * Walk a `where` on table `table` (or / and / not included): dotted keys follow link columns by
 * their `ref` (a key part that is not a link column ends the walk). Returns the rewritten filter.
 */
export function mapWhere(model: Metastore, table: string, where: unknown, f: WhereRewrite): unknown {
  if (where == null || typeof where !== "object" || Array.isArray(where)) return where;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
    if (LOGICAL.has(k)) {
      out[k] = Array.isArray(v) ? v.map((w) => mapWhere(model, table, w, f)) : mapWhere(model, table, v, f);
      continue;
    }
    if (k === "path") {
      out[k] = v;
      continue;
    }
    const parts = k.split(".");
    let cur: string | null = table;
    const renamed: string[] = [];
    let last: { table: string; column: string } | null = null;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (cur === null) {
        renamed.push(part);
        continue;
      }
      renamed.push(f.key ? f.key(cur, part) : part);
      if (i === parts.length - 1) {
        last = { table: cur, column: part };
        break;
      }
      const target = linkTargetOf((f.columns ? f.columns(cur) : modelColumns(model, cur))?.find((c) => String(c.name) === part), cur);
      if (target !== null) f.hop?.(cur, part, target);
      cur = target;
    }
    out[renamed.join(".")] = last && f.cond ? f.cond(last.table, last.column, v) : v;
  }
  return out;
}

/** Full names of the tables a `where` on `table` reads through links (dotted keys). */
export function linkReads(model: Metastore, table: string, where: unknown, out = new Set<string>()): Set<string> {
  mapWhere(model, table, where, { hop: (_t, _c, target) => out.add(target) });
  return out;
}

/** True when a `where` on `table` reads column `column` of table `target` (directly or through links). */
export function readsColumn(model: Metastore, table: string, where: unknown, target: string, column: string): boolean {
  let hit = false;
  mapWhere(model, table, where, {
    key: (t, c) => {
      if (t === target && c === column) hit = true;
      return c;
    },
  });
  return hit;
}

/** Every link-following CHECK and filtered link column of the model, with the tables it reads. */
export interface LinkReader {
  /** The table that declares it. */
  owner: string;
  /** `CHECK <name>` or `<column> (ref_where / ref_by)`. */
  what: string;
  /** Tables it reads through links (the linked table of a filtered column included). */
  reads: Set<string>;
}

function followsLinks(where: unknown): boolean {
  if (where == null || typeof where !== "object" || Array.isArray(where)) return false;
  return Object.entries(where).some(([k, v]) => (LOGICAL.has(k) ? (Array.isArray(v) ? v : [v]).some(followsLinks) : k.indexOf(".") > 0));
}

export function linkReaders(model: Metastore): LinkReader[] {
  const out: LinkReader[] = [];
  for (const { ref, entry } of catalogTables(model)) {
    for (const [name, where] of Object.entries(entry.constraints ?? {})) {
      if (followsLinks(where)) out.push({ owner: ref.full, what: `CHECK ${name}`, reads: linkReads(model, ref.full, where) });
    }
    for (const c of modelColumns(model, ref.full)!) { // a table of the model
      if ((c.ref_where ?? c.ref_by) == null) continue;
      const target = linkTargetOf(c, ref.full);
      if (target === null) continue;
      out.push({ owner: ref.full, what: `${String(c.name)} (ref_where / ref_by)`, reads: linkReads(model, target, c.ref_where, new Set([target])) });
    }
  }
  return out;
}

/**
 * Refusals of a rename or drop of table `full`: the link-following CHECKs and filtered link columns
 * of other tables that read it. A link column's `ref` is not rewritten when its table is renamed
 * or dropped, so they would stop working: they are named, to be dropped or changed first.
 */
export function readersBlocking(model: Metastore, full: string, verb: "rename" | "drop"): { message: string }[] {
  return linkReaders(model)
    .filter((r) => r.owner !== full && r.reads.has(full))
    .map((r) => ({ message: `${r.what} of ${r.owner} reads ${full} through a link: drop or change it before you ${verb} the table (link targets are not rewritten)` }));
}

/**
 * The entries of `after` (the metastore text being written, parsed) whose CHECKs or link filters
 * `rewrite` changes, walked on `before` (the metastore as it is, which still has the old names).
 * Filters of base columns are left as they are.
 */
export function rewrittenEntries(
  before: Metastore,
  after: Metastore,
  f: WhereRewrite & {
    /** The new `ref_by` of a link column of `owner` pointing to `target` (default: unchanged). */
    refBy?: (owner: string, target: string, by: Record<string, unknown>) => Record<string, unknown>;
  },
): { ref: CatalogRef; entry: CatalogTableEntry }[] {
  const out: { ref: CatalogRef; entry: CatalogTableEntry }[] = [];
  for (const { ref, entry } of catalogTables(after)) {
    let changed = false;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    let constraints = entry.constraints;
    if (constraints) {
      const next: Record<string, Record<string, unknown>> = {};
      for (const [name, where] of Object.entries(constraints)) {
        next[name] = mapWhere(before, ref.full, where, f) as Record<string, unknown>;
        if (!same(next[name], where)) changed = true;
      }
      constraints = next;
    }
    const columns = entry.columns.map((c) => {
      const target = linkTargetOf(c, ref.full);
      if (target === null) return c;
      let col = c;
      if (c.ref_where != null) {
        const w = mapWhere(before, target, c.ref_where, f);
        if (!same(w, c.ref_where)) col = { ...col, ref_where: w };
      }
      if (c.ref_by != null && typeof c.ref_by === "object" && f.refBy) {
        const by = f.refBy(ref.full, target, c.ref_by as Record<string, unknown>);
        if (!same(by, c.ref_by)) col = { ...col, ref_by: by };
      }
      if (col !== c) changed = true;
      return col;
    });
    if (changed) out.push({ ref, entry: { ...entry, columns, ...(constraints ? { constraints } : {}) } });
  }
  return out;
}
