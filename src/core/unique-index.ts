/**
 * The rows of a table by the values of its `unique` columns (the system `id` is one), kept up to
 * date from the vault index's change log (vault-index.ts): an insert checks its values against
 * them instead of reading every row of the table.
 *
 * Values are compared as the unique check compares them (`uniqueKey`: strings trimmed, in lower
 * case; other values as JSON). A table whose rows cannot all be read has no index: the caller
 * reads the table, and reports what it reports.
 *
 * Shape (plain data): per table, path → the key of each unique column, and per column key →
 * paths; the vault index's epoch and cursor it is up to date with.
 */

import { readFrontmatterEntries } from "./file-cache";
import { fmGet } from "./frontmatter";
import type { App } from "./host";
import type { DatanotesSettings } from "./settings";
import type { Violation } from "./types-table";
import type { OrderedFrontmatter } from "./types";
import type { RowViolations, LoadedTable } from "./engine";
import { loadRows, loadTable, uniqueKey } from "./engine";
import { catalogRowFiles } from "./row-files";
import type { Metastore } from "./metastore";
import { vaultIndex } from "./vault-index";

interface UniqueValues {
  epoch: number;
  cursor: number;
  model: Metastore;
  /** The unique columns and the folders left out, as the index was built for them. */
  signature: string;
  columns: readonly string[];
  byPath: Map<string, (string | null)[]>;
  byKey: Map<string, Set<string>>[];
}

const VALUES = new WeakMap<object, Map<string, UniqueValues>>();

/** The unique values of a table's rows, up to date. */
export interface UniqueLookup {
  /** Whether a row of the table is at `path`. */
  has(path: string): boolean;
  /**
   * The unique violations of a row inserted at a path no row has, with the values `ordered`, as
   * `uniqueViolations` over the table and the new row reports them for it.
   */
  violationsOfNew(path: string, ordered: OrderedFrontmatter): RowViolations[];
}

function signatureOf(t: LoadedTable, columns: readonly string[]): string {
  return JSON.stringify([columns, t.def.options.exclude ?? [], t.def.layout.archive]);
}

/** The unique values of `t`'s rows, from the vault index; null when the host has none, or a row cannot be read. */
export async function uniqueValues(app: App, settings: DatanotesSettings, t: LoadedTable): Promise<UniqueLookup | null> {
  const idx = vaultIndex(app, settings);
  if (!idx || idx.hasFailures) return null;
  const full = t.catalog.ref.full;
  const columns = t.def.columns.filter((c) => c.unique).map((c) => c.name);
  const signature = signatureOf(t, columns);
  let byTable = VALUES.get(app);
  if (!byTable) VALUES.set(app, (byTable = new Map()));
  let v = byTable.get(full);
  const changed = v && v.signature === signature && v.epoch === idx.epoch && v.model === t.catalog.model ? idx.changedSince(v.cursor, idx.epoch) : null;
  const cursor = idx.cursor;
  const keep = new Set([settings.tableKey]);
  const read = async (path: string): Promise<(string | null)[] | null> => {
    const f = app.vault.getAbstractFileByPath(path)!; // a row of the index is a file of the vault
    try {
      const ordered = await readFrontmatterEntries(app, f as never, keep);
      return columns.map((c) => uniqueKey(fmGet(ordered, c)));
    } catch {
      return null;
    }
  };
  const add = (u: UniqueValues, path: string, keys: (string | null)[]) => {
    u.byPath.set(path, keys);
    keys.forEach((k, i) => {
      if (k === null) return;
      let paths = u.byKey[i]!.get(k);
      if (!paths) u.byKey[i]!.set(k, (paths = new Set()));
      paths.add(path);
    });
  };
  const drop = (u: UniqueValues, path: string) => {
    const keys = u.byPath.get(path);
    if (!keys) return;
    u.byPath.delete(path);
    keys.forEach((k, i) => {
      if (k === null) return;
      const paths = u.byKey[i]!.get(k)!; // added with the row
      paths.delete(path);
      if (paths.size === 0) u.byKey[i]!.delete(k);
    });
  };
  if (!v || !changed) {
    v = { epoch: idx.epoch, cursor, model: t.catalog.model, signature, columns, byPath: new Map(), byKey: columns.map(() => new Map()) };
    byTable.delete(full);
    for (const f of catalogRowFiles(app, settings, full, t.def)) {
      const keys = await read(f.path);
      if (!keys) return null;
      add(v, f.path, keys);
    }
    byTable.set(full, v);
  } else {
    const rows = new Set(catalogRowFiles(app, settings, full, t.def).map((f) => f.path));
    for (const path of changed) {
      drop(v, path);
      if (!rows.has(path)) continue;
      const keys = await read(path);
      if (!keys) {
        byTable.delete(full);
        return null;
      }
      add(v, path, keys);
    }
    // a row leaves the table without a change of its own when the metastore moves it (a new
    // exclude folder rebuilds: the signature); a row gone from the table is in the change log
    v.cursor = cursor;
  }
  const u = v;
  return {
    has: (path) => u.byPath.has(path),
    violationsOfNew(path, ordered) {
      const out: Violation[] = [];
      u.columns.forEach((c, i) => {
        const value = fmGet(ordered, c);
        const k = uniqueKey(value);
        if (k === null) return;
        const others = [...(u.byKey[i]!.get(k) ?? [])].sort((a, b) => a.localeCompare(b));
        if (others.length === 0) return;
        out.push({ column: c, code: "unique", message: `must be unique (also used by ${others.join(", ")})`, value });
      });
      return out.length > 0 ? [{ path, violations: out }] : [];
    },
  };
}

/**
 * How the unique values kept per table differ from the table's rows read now (index-check.ts);
 * empty when they agree.
 */
export async function verifyUniqueValues(app: App, settings: DatanotesSettings): Promise<string[]> {
  const out: string[] = [];
  for (const full of [...(VALUES.get(app)?.keys() ?? [])]) {
    let t: LoadedTable;
    try {
      t = await loadTable(app, settings, full);
    } catch {
      continue; // a table gone: its values are dropped on the next build
    }
    // brought up to date, as the next insert would, then compared with every row read now
    if (!(await uniqueValues(app, settings, t))) continue;
    const v = VALUES.get(app)!.get(full)!;
    const rows = await loadRows(app, settings, t);
    const want = new Map(rows.map((r) => [r.file.path, v.columns.map((c) => uniqueKey(fmGet(r.ordered, c)))]));
    const show = (byPath: ReadonlyMap<string, (string | null)[]>) => JSON.stringify([...byPath].sort(([a], [b]) => (a < b ? -1 : 1)));
    if (show(v.byPath) !== show(want)) out.push(`unique values of ${full} differ from its rows`);
    const byKey = v.columns.map((_, i) => {
      const m = new Map<string, string[]>();
      for (const [p, keys] of want) if (keys[i] !== null) m.set(keys[i]!, [...(m.get(keys[i]!) ?? []), p]);
      return m;
    });
    const keys = (ms: readonly ReadonlyMap<string, Iterable<string>>[]) => JSON.stringify(ms.map((m) => [...m].map(([k, ps]) => [k, [...ps].sort()]).sort()));
    if (keys(v.byKey) !== keys(byKey)) out.push(`unique values of ${full}: the paths by value differ from its rows`);
  }
  return out;
}
