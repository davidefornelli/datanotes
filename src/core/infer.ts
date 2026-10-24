/**
 * Schema inference: look at the frontmatter of existing notes and propose a table for them
 * (`create_table` input plus the `adopt_rows` call that brings the notes in), or, for an existing
 * table, the columns its rows use but the table does not declare. Read-only: nothing is written.
 *
 * Meant for agents maintaining `metastore.yaml`: infer, review the proposal, then create / alter.
 */

import type { App, TFile } from "./host";
import { loadTable, loadRows, OperationInputError } from "./engine";
import { cachedMetastore, loadMetastore, rowTableFull } from "./metastore";
import type { DatanotesSettings } from "./settings";
import { validationContextFor } from "./table-registry";
import { assertPathReadable, assertTableReadable, currentReadScope, pathReadable, tableReadable } from "./read-scope";

export interface InferInput {
  /** Notes in this folder (recursive) … */
  folder?: string;
  /** … and/or these paths. */
  paths?: string[];
  /** Or: the rows of this table, to find keys it does not declare. */
  table?: string;
  /** Proposed table name (default: from the folder). */
  name?: string;
  /** A string column becomes an enum when it has at most this many distinct values (default 12). */
  maxEnumValues?: number;
}

type Kind = "boolean" | "integer" | "number" | "date" | "datetime" | "link" | "string" | "list";

export interface InferredColumn {
  name: string;
  /** Original property name when it is not a valid column name (`rename` it on adoption). */
  from?: string;
  type: Exclude<Kind, "list"> | "list" | "enum";
  /** What the column holds: the notes cannot say, so it is null for the agent to write (create_table and add_column refuse it empty). */
  description: null;
  items?: string;
  values?: string[];
  ref?: string;
  required?: boolean;
  unique?: boolean;
  dense?: boolean;
  stats: { present: number; filled: number; distinct: number; types: Record<string, number>; examples: unknown[] };
}

export interface InferResult {
  files: number;
  paths: string[];
  skipped: { path: string; reason: string }[];
  columns: InferredColumn[];
  /**
   * Ready for `createTable` (folder/paths mode). The HTTP API names `timeColumn` as create_table
   * does, `time_column` (rest.ts), so its callers pass the proposal as it is.
   */
  proposal?: {
    name: string;
    /** What a row records: null for the agent to write, like each column's (create_table refuses them empty). */
    description: null;
    timeColumn?: string;
    /** The file name pattern of the rows, when a column names them (else `timeColumn`). */
    options: { filename?: string };
    columns: Record<string, unknown>[];
  };
  /** Ready for `adopt_rows` once the table exists (folder/paths mode). */
  adopt?: { paths: string[]; rename?: Record<string, string>; relocate: boolean };
  hints: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const LINK_RE = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/;
/** Obsidian keys that are not data. */
const SKIP_KEYS = new Set(["position", "cssclasses", "cssclass"]);

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

function kindOf(v: unknown): Kind {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") {
    const s = v.trim();
    if (DATE_RE.test(s)) return "date";
    if (DATETIME_RE.test(s)) return "datetime";
    if (LINK_RE.test(s)) return "link";
  }
  return "string";
}

/** One kind for a set of observed kinds; `null` when they cannot be reconciled (→ string). */
function mergeKinds(kinds: Set<Kind>): Kind | null {
  if (kinds.size === 0) return "string";
  if (kinds.size === 1) return [...kinds][0]!;
  if ([...kinds].every((k) => k === "integer" || k === "number")) return "number";
  return null;
}

/** A valid column name for a property (`Start date` → `start_date`, `modelKey` → `model_key`). */
export function columnNameFor(key: string): string {
  let n = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!/^[a-z]/.test(n)) n = `c_${n}`;
  return n;
}

function tableNameFor(folder: string | undefined): string {
  const base = folder ? folder.replace(/\/+$/, "").split("/").pop()! : ""; // split() returns at least one element
  const n = columnNameFor(base || "notes");
  return n === "c_" ? "notes" : n;
}

function filesOf(app: App, settings: DatanotesSettings, input: InferInput): TFile[] {
  const out = new Map<string, TFile>();
  // under a read scope: a folder's notes the token may not read are left out, a path it names is refused
  const scope = currentReadScope();
  if (input.folder !== undefined) {
    const prefix = input.folder.replace(/^\/+|\/+$/g, "");
    for (const f of app.vault.getMarkdownFiles()) {
      if ((prefix === "" || f.path.startsWith(`${prefix}/`)) && pathReadable(app, settings, f.path, scope)) out.set(f.path, f);
    }
  }
  for (const p of input.paths ?? []) {
    const path = p.endsWith(".md") ? p : `${p}.md`;
    assertPathReadable(app, settings, path);
    const f = app.vault.getAbstractFileByPath(path);
    if (f && "extension" in f) out.set(path, f as TFile);
  }
  return [...out.values()].filter((f) => !f.path.includes("/_archive/")).sort((a, b) => a.path.localeCompare(b.path));
}

interface Observed {
  present: number;
  values: { path: string; value: unknown }[];
}

function inferColumns(
  app: App,
  settings: DatanotesSettings,
  observed: Map<string, Observed>,
  files: number,
  maxEnum: number,
): InferredColumn[] {
  const out: InferredColumn[] = [];
  for (const [key, o] of observed) {
    const filled = o.values.filter((x) => !isEmpty(x.value));
    const kinds = new Set(filled.map((x) => kindOf(x.value)));
    const types: Record<string, number> = {};
    for (const x of filled) types[kindOf(x.value)] = (types[kindOf(x.value)] ?? 0) + 1;
    const scalarKey = (v: unknown) => (typeof v === "string" ? v.trim() : JSON.stringify(v));
    const distinct = new Set(filled.map((x) => scalarKey(x.value))).size;
    const name = columnNameFor(key);
    const col: InferredColumn = {
      name,
      ...(name !== key ? { from: key } : {}),
      type: "string",
      description: null,
      stats:{ present: o.present, filled: filled.length, distinct, types, examples: filled.slice(0, 3).map((x) => x.value) },
    };
    let kind = mergeKinds(kinds);
    // A list column whose notes sometimes hold a single value.
    if (kind === null && kinds.has("list")) kind = "list";
    if (kind === null) kind = "string";

    if (kind === "list") {
      const items = filled.flatMap((x) => (Array.isArray(x.value) ? x.value : [x.value])).filter((v) => !isEmpty(v));
      const itemKind = mergeKinds(new Set(items.map(kindOf))) ?? "string";
      col.type = "list";
      const itemDistinct = [...new Set(items.map((v) => String(v).trim()))];
      if (itemKind === "string" && itemDistinct.length > 0 && itemDistinct.length <= maxEnum && items.length >= 3 && itemDistinct.length * 2 <= items.length) {
        col.items = "enum";
        col.values = frequencyOrder(items.map((v) => String(v).trim()));
      } else {
        col.items = itemKind === "list" ? "string" : itemKind;
      }
      if (col.items === "link") {
        const ref = refOf(app, settings, filled.flatMap((x) => (Array.isArray(x.value) ? x.value.map((v) => ({ path: x.path, value: v })) : [x])));
        if (ref) col.ref = ref;
      }
    } else if (kind === "string") {
      const strings = filled.map((x) => String(x.value).trim());
      const avg = strings.reduce((n, s) => n + s.length, 0) / Math.max(1, strings.length);
      if (filled.length >= 3 && distinct <= maxEnum && distinct * 2 <= filled.length && avg <= 40) {
        col.type = "enum";
        col.values = frequencyOrder(strings);
      } else {
        col.type = "string";
      }
    } else {
      col.type = kind;
      if (kind === "link") {
        const ref = refOf(app, settings, filled);
        if (ref) col.ref = ref;
      }
    }

    if (filled.length === files && files > 0) col.required = true;
    if ((col.type === "string" || col.type === "integer") && files >= 5 && filled.length === files && distinct === files) col.unique = true;
    if (o.present >= Math.ceil(files * 0.9)) col.dense = true;
    out.push(col);
  }
  return out.sort((a, b) => b.stats.filled - a.stats.filled || a.name.localeCompare(b.name));
}

function frequencyOrder(values: string[]): string[] {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

/** The table most link targets belong to (≥ 80% of the resolved ones). */
function refOf(app: App, settings: DatanotesSettings, links: { path: string; value: unknown }[]): string | undefined {
  const counts = new Map<string, number>();
  let resolved = 0;
  for (const { path, value } of links) {
    const m = typeof value === "string" ? LINK_RE.exec(value.trim()) : null;
    if (!m) continue;
    const ctx = validationContextFor(app, settings, path);
    const dest = ctx.resolveLink?.(m[1]!.trim()) ?? null;
    if (!dest) continue;
    resolved++;
    const owner = ctx.tableOfPath?.(dest);
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  // a table the token may not read is not proposed (list_tables hides it)
  return best && resolved > 0 && best[1] >= resolved * 0.8 && tableReadable(best[0]) ? best[0] : undefined;
}

function frontmatter(app: App, f: TFile): Record<string, unknown> {
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  return fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {};
}

export async function inferTable(app: App, settings: DatanotesSettings, input: InferInput): Promise<InferResult> {
  const maxEnum = input.maxEnumValues ?? 12;
  const skip = new Set([settings.tableKey, "id", ...SKIP_KEYS]);
  const notes: string[] = [];

  if (input.table !== undefined) {
    // Existing table: keys its rows use that it does not declare.
    const t = await loadTable(app, settings, input.table);
    assertTableReadable(t.catalog.ref.full);
    const rows = await loadRows(app, settings, t);
    const declared = new Set([...t.def.columns.map((c) => c.name), ...t.def.untypedFields]);
    const observed = new Map<string, Observed>();
    for (const r of rows) {
      for (const [k, v] of r.ordered) {
        if (skip.has(k) || declared.has(k) || k.startsWith("_")) continue;
        const o = observed.get(k) ?? { present: 0, values: [] };
        o.present++;
        o.values.push({ path: r.file.path, value: v });
        observed.set(k, o);
      }
    }
    const columns = inferColumns(app, settings, observed, rows.length, maxEnum);
    for (const c of columns) delete c.required; // only some rows carry an undeclared key
    if (columns.length === 0) notes.push("every front matter key the rows use is declared");
    else notes.push("add these with add_column, each with a description of what it holds (null here; dense: false unless every row should carry the front matter key), or drop those front matter keys from the rows");
    return { files: rows.length, paths: rows.map((r) => r.file.path), skipped: [], columns, hints: notes };
  }

  if (input.folder === undefined && (input.paths ?? []).length === 0) {
    throw new OperationInputError(`pass "folder", "paths" or "table"`);
  }
  await loadMetastore(app, settings);
  const ms = cachedMetastore(app, settings);
  const skipped: { path: string; reason: string }[] = [];
  const included: TFile[] = [];
  for (const f of filesOf(app, settings, input)) {
    const fm = frontmatter(app, f);
    const owner = ms ? rowTableFull(ms, fm[settings.tableKey]) : null;
    if (owner) skipped.push({ path: f.path, reason: `already a row of ${owner}` });
    else included.push(f);
  }
  const observed = new Map<string, Observed>();
  for (const f of included) {
    for (const [k, v] of Object.entries(frontmatter(app, f))) {
      if (skip.has(k) || k.startsWith("_")) continue;
      const o = observed.get(k) ?? { present: 0, values: [] };
      o.present++;
      o.values.push({ path: f.path, value: v });
      observed.set(k, o);
    }
  }
  const columns = inferColumns(app, settings, observed, included.length, maxEnum);
  const names = new Map<string, string>();
  for (const c of columns) {
    const clash = names.get(c.name);
    if (clash) notes.push(`"${c.from ?? c.name}" and "${clash}" map to the same column name "${c.name}": rename one`);
    names.set(c.name, c.from ?? c.name);
  }

  // How rows get file names: a column equal to every file name, else a date/datetime column.
  const options: { filename?: string } = {};
  let timeColumn: string | undefined;
  const byName = columns.find(
    (c) =>
      c.required &&
      (c.type === "string" || c.type === "enum") &&
      included.length > 0 &&
      // a required column is filled in every note
      included.every((f) => String(frontmatter(app, f)[c.from ?? c.name]).trim() === f.basename),
  );
  if (byName) options.filename = `{${byName.name}}`;
  else {
    const time = columns.find((c) => c.required && (c.type === "datetime" || c.type === "date"));
    if (time) timeColumn = time.name;
    else notes.push('no column matches the file names: set filename (e.g. "{title}") and adopt with relocate: false to keep the current names');
  }

  const rename = Object.fromEntries(columns.filter((c) => c.from).map((c) => [c.from!, c.name]));
  if (included.length === 0) notes.push("no notes to infer from");
  notes.push("write the description of the table and of each column (null in the proposal) before create_table: it refuses them empty");
  const proposal: InferResult["proposal"] = {
    name: input.name ?? tableNameFor(input.folder),
    description: null,
    ...(timeColumn ? { timeColumn } : {}),
    options,
    columns: columns.map(({ stats: _s, from: _f, ...spec }) => spec),
  };
  return {
    files: included.length,
    paths: included.map((f) => f.path),
    skipped,
    columns,
    proposal,
    adopt: { paths: included.map((f) => f.path), ...(Object.keys(rename).length > 0 ? { rename } : {}), relocate: false },
    hints: notes,
  };
}
