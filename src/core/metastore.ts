/**
 * The metastore: one YAML file (`<database>/metastore.yaml`) that defines every catalog, schema,
 * table, column, view and the database configuration. Tables are addressed as `catalog.schema.table`; a note is a row of a table
 * when its `table` property (setting `tableKey`) names it, wherever the note lives.
 *
 * ```yaml
 * config: { default_catalog: personal, default_schema: public, timezone: Europe/Rome }
 * catalogs:
 *   personal:
 *     comment: Life tracking
 *     schemas:
 *       metrics:
 *         tables:
 *           mood:
 *             description: Perceived mood
 *             aliases: [feeling]
 *             tags: { domain: health }
 *             options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}" }
 *             fields: { type: metric }
 *             columns:
 *               - { name: id, type: string, identity: uuid, unique: true, required: true }   # system row id
 *               - { name: occurred_at, type: datetime, required: true, dense: true }
 *             constraints: { future_free: { occurred_at: { lte: "2100-01-01" } } }
 *         views:
 *           low_mood: { description: …, query: { table: personal.metrics.mood, where: { … } } }
 * ```
 *
 * The rest of the engine works on an "ordered frontmatter" description of each table (the
 * `table` property, fields and dense columns, then `_table` options and `_columns`);
 * {@link entryToOrdered} and {@link orderedToEntry} translate.
 */

import type { App, TFile } from "./host";
import { isMap, parse, parseDocument, type YAMLMap } from "yaml";
import { fmGet } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { parseTableOptions } from "./table-loader";
import { TABLE_META_KEYS } from "./reserved-keys";
import { COLUMNS_KEY, TABLE_KEY } from "./types-table";
import type { OrderedFrontmatter } from "./types";
import { guide, GuidedError } from "./hints";
import { inDatabase, movePath, normalizeDatabaseFolder } from "./db-paths";
import { phase } from "./tracing";

export const METASTORE_FILE = "metastore.yaml";
export const SYSTEM_CATALOG = "system";

export class MetastoreError extends GuidedError {
  override readonly name = "MetastoreError";
}

/** A table's `options`: where its rows go, and whether it keeps a transaction log. */
export interface TableProperties {
  /** Row sub-folder pattern inside the table folder (`{occurred_at:YYYY/MM}`). */
  partition?: string;
  /** File-name pattern of new rows (`{title}`). */
  filename?: string;
  /** Archive folder: a name inside the table folder, or a vault path. */
  archive?: string;
  /** Folders whose notes are never rows (one folder or a list). */
  exclude?: string | string[];
  /** Transaction log on or off for this table (absent: `config.history`). */
  history?: boolean;
  /**
   * Whether automatic links may link the table's rows (absent: yes, unless the rows are named by
   * a date or a time; autolink.ts).
   */
  autolink_target?: boolean;
  [key: string]: unknown;
}

/** A table of `metastore.yaml`, in the operations' words (`description`, `required`, `options`, `fields`). */
export interface CatalogTableEntry {
  description?: string;
  aliases?: string[];
  tags?: Record<string, unknown>;
  /** Bases the table inherits columns from, in order. */
  bases?: string[];
  options?: TableProperties;
  /** Untyped fields every row carries, with their value (`fields` in create_table). */
  fields?: Record<string, unknown>;
  columns: Record<string, unknown>[];
  /** CHECK constraints: name → `where` filter every row must match. */
  constraints?: Record<string, Record<string, unknown>>;
  /** Text of every new row's note, with `{column}` placeholders (`body` in create_table). */
  row_template?: string;
  [key: string]: unknown;
}

export interface ViewEntry {
  description?: string;
  /** Other words for the view, so agents find it (like a table's `aliases`). */
  aliases?: string[];
  /** Column headings when the view is shown in a note: `{ "name": "Project" }`. */
  labels?: Record<string, string>;
  query: Record<string, unknown>;
}

export interface SchemaEntry {
  description?: string;
  tables: Record<string, CatalogTableEntry>;
  views: Record<string, ViewEntry>;
}

export interface CatalogEntry {
  description?: string;
  schemas: Record<string, SchemaEntry>;
}

/**
 * A base: columns shared by the tables that list it in `bases` (like PostgreSQL INHERITS). A base may
 * extend other bases; `ref: self` in a base column means "the table that inherits it".
 */
export interface BaseEntry {
  description?: string;
  bases?: string[];
  columns: Record<string, unknown>[];
}

export interface Metastore {
  config: Record<string, unknown>;
  bases: Record<string, BaseEntry>;
  catalogs: Record<string, CatalogEntry>;
}

export interface CatalogRef {
  catalog: string;
  schema: string;
  table: string;
  /** `catalog.schema.table` */
  full: string;
}

const IDENT = /^[a-z][a-z0-9_]*$/;

export function metastorePath(settings: Pick<DatanotesSettings, "databaseFolder">): string {
  return inDatabase(normalizeDatabaseFolder(settings.databaseFolder), METASTORE_FILE);
}

/** `Datanotes/metastore.yaml#personal.metrics.mood` — the path-like id of a catalog table. */
export function catalogTablePath(settings: Pick<DatanotesSettings, "databaseFolder">, full: string): string {
  return `${metastorePath(settings)}#${full}`;
}

export function refOf(catalog: string, schema: string, table: string): CatalogRef {
  return { catalog, schema, table, full: `${catalog}.${schema}.${table}` };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Words the file used before 3.0, and the operations' words it uses now. */
const OLD_WORDS: Readonly<Record<string, string>> = { comment: "description", properties: "options", defaults: "fields", extends: "bases" };
const OLD_COLUMN_WORDS: Readonly<Record<string, string>> = { comment: "description", nullable: "required" };

/** Refuse a key of an older metastore.yaml, naming the one to write. */
function checkWords(entry: Record<string, unknown>, where: string, words: Readonly<Record<string, string>> = OLD_WORDS): void {
  for (const [old, now] of Object.entries(words)) {
    if (!Object.prototype.hasOwnProperty.call(entry, old)) continue;
    const fix = old === "nullable" ? `write "required: true" for "nullable: false"` : `write "${now}"`;
    throw new MetastoreError(
      `${where}: "${old}" is not a key of ${METASTORE_FILE}: ${fix}`,
      guide(`${METASTORE_FILE} uses the operations' words: description, required, options, fields and bases. Rename the key, then load the database again.`, "metastoreWords"),
    );
  }
}

/** Refuse the older words in an entry and in its columns. */
function checkEntryWords(entry: Record<string, unknown>, where: string): void {
  checkWords(entry, where);
  const columns = Array.isArray(entry.columns) ? entry.columns : [];
  columns.forEach((c, i) => {
    if (isRecord(c)) checkWords(c, `${where}.columns[${i}]`, OLD_COLUMN_WORDS);
  });
}

function checkIdent(kind: string, name: string, where: string): void {
  if (!IDENT.test(name)) throw new MetastoreError(`${where}: ${kind} name "${name}" must be lowercase letters, digits and _`);
}

/**
 * A name → entry map without a prototype: looking up `constructor`, `toString` or `__proto__`
 * finds nothing instead of a built-in of Object.prototype.
 */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Parse and structurally validate the metastore YAML. An empty text is an empty metastore.
 * Catalogs, schemas, tables, views and bases are maps without a prototype (see {@link dict}).
 */
export function parseMetastore(text: string): Metastore {
  const raw = text.trim() === "" ? {} : parse(text);
  if (!isRecord(raw)) throw new MetastoreError(`${METASTORE_FILE} must be a mapping`);
  const config = raw.config === undefined || raw.config === null ? {} : raw.config;
  if (!isRecord(config)) throw new MetastoreError("config must be a mapping");
  const bases = parseBases(raw.bases);
  const catalogsRaw = raw.catalogs ?? {};
  if (!isRecord(catalogsRaw)) throw new MetastoreError("catalogs must be a mapping");
  const catalogs = dict<CatalogEntry>();
  for (const [c, cv] of Object.entries(catalogsRaw)) {
    checkIdent("catalog", c, "catalogs");
    if (c === SYSTEM_CATALOG) throw new MetastoreError(`catalog name "${SYSTEM_CATALOG}" is reserved`);
    const cat = cv ?? {};
    if (!isRecord(cat)) throw new MetastoreError(`catalogs.${c} must be a mapping`);
    checkWords(cat, `catalogs.${c}`);
    const schemasRaw = cat.schemas ?? {};
    if (!isRecord(schemasRaw)) throw new MetastoreError(`catalogs.${c}.schemas must be a mapping`);
    const schemas = dict<SchemaEntry>();
    for (const [s, sv] of Object.entries(schemasRaw)) {
      checkIdent("schema", s, `catalogs.${c}.schemas`);
      const sch = sv ?? {};
      if (!isRecord(sch)) throw new MetastoreError(`catalogs.${c}.schemas.${s} must be a mapping`);
      checkWords(sch, `catalogs.${c}.schemas.${s}`);
      const tablesRaw = sch.tables ?? {};
      const viewsRaw = sch.views ?? {};
      if (!isRecord(tablesRaw) || !isRecord(viewsRaw)) {
        throw new MetastoreError(`catalogs.${c}.schemas.${s}: tables and views must be mappings`);
      }
      const tables = dict<CatalogTableEntry>();
      for (const [t, tv] of Object.entries(tablesRaw)) {
        checkIdent("table", t, `${c}.${s}`);
        if (!isRecord(tv)) throw new MetastoreError(`${c}.${s}.${t} must be a mapping`);
        checkEntryWords(tv, `${c}.${s}.${t}`);
        const columns = tv.columns ?? [];
        if (!Array.isArray(columns) || columns.some((x) => !isRecord(x))) {
          throw new MetastoreError(`${c}.${s}.${t}.columns must be a list of mappings`);
        }
        checkBases(bases, tv.bases, `${c}.${s}.${t}`);
        tables[t] = { ...tv, columns: columns as Record<string, unknown>[] } as CatalogTableEntry;
      }
      const views = dict<ViewEntry>();
      for (const [v, vv] of Object.entries(viewsRaw)) {
        checkIdent("view", v, `${c}.${s}`);
        if (!isRecord(vv) || !isRecord(vv.query)) throw new MetastoreError(`${c}.${s}.${v}: a view needs a query mapping`);
        checkWords(vv, `${c}.${s}.${v}`);
        if (tables[v]) throw new MetastoreError(`${c}.${s}.${v} is both a table and a view`);
        views[v] = vv as unknown as ViewEntry;
      }
      schemas[s] = { ...(typeof sch.description === "string" ? { description: sch.description } : {}), tables, views };
    }
    catalogs[c] = { ...(typeof cat.description === "string" ? { description: cat.description } : {}), schemas };
  }
  return { config, bases, catalogs };
}

function checkBases(bases: Record<string, BaseEntry>, ext: unknown, where: string): void {
  if (ext === undefined) return;
  if (!Array.isArray(ext) || ext.some((e) => typeof e !== "string")) throw new MetastoreError(`${where}: bases must be a list of base names`);
  for (const e of ext as string[]) if (!bases[e]) throw new MetastoreError(`${where}: unknown base "${e}"`);
}

function parseBases(raw: unknown): Record<string, BaseEntry> {
  if (raw === undefined || raw === null) return dict<BaseEntry>();
  if (!isRecord(raw)) throw new MetastoreError("bases must be a mapping");
  const out = dict<BaseEntry>();
  for (const [b, bv] of Object.entries(raw)) {
    checkIdent("base", b, "bases");
    if (!isRecord(bv)) throw new MetastoreError(`bases.${b} must be a mapping`);
    checkEntryWords(bv, `bases.${b}`);
    const columns = bv.columns ?? [];
    if (!Array.isArray(columns) || columns.some((x) => !isRecord(x))) throw new MetastoreError(`bases.${b}.columns must be a list of mappings`);
    out[b] = { ...(bv as object), columns: columns as Record<string, unknown>[] } as BaseEntry;
  }
  for (const [b, bv] of Object.entries(out)) checkBases(out, bv.bases, `bases.${b}`);
  for (const b of Object.keys(out)) baseChain(out, [b]); // throws on cycles
  return out;
}

/** Bases in inheritance order (parents before children, each once); throws on a cycle. */
export function baseChain(bases: Record<string, BaseEntry>, names: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (n: string, stack: string[]) => {
    if (stack.includes(n)) throw new MetastoreError(`bases: inheritance cycle ${[...stack, n].join(" → ")}`);
    const b = bases[n];
    if (!b) throw new MetastoreError(`unknown base "${n}"`);
    for (const parent of b.bases ?? []) visit(parent, [...stack, n]);
    if (!out.includes(n)) out.push(n);
  };
  for (const n of names) visit(n, []);
  return out;
}

/** Column keys a table may change on an inherited column (they do not change its meaning). */
const PRESENTATION_KEYS = new Set(["name", "label", "description", "aliases", "note", "dense"]);

function withSelf(col: Record<string, unknown>, full: string): Record<string, unknown> {
  return col.ref === "self" ? { ...col, ref: full } : col;
}

function structural(col: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(col).sort()) if (!PRESENTATION_KEYS.has(k)) out[k] = col[k];
  return JSON.stringify(out);
}

/** Columns a table inherits, `ref: self` resolved to the table, with the base each comes from. */
export function inheritedColumns(model: Pick<Metastore, "bases">, ext: readonly string[] | undefined, full: string): { column: Record<string, unknown>; base: string }[] {
  const out: { column: Record<string, unknown>; base: string }[] = [];
  for (const b of baseChain(model.bases, ext ?? [])) {
    for (const c of model.bases[b]!.columns) {
      const col = withSelf(c, full);
      const i = out.findIndex((x) => x.column.name === col.name);
      if (i >= 0) {
        if (structural(out[i]!.column) !== structural(col)) {
          throw new MetastoreError(`${full}: column "${String(col.name)}" comes from bases ${out[i]!.base} and ${b} with different definitions`);
        }
        continue;
      }
      out.push({ column: col, base: b });
    }
  }
  return out;
}

/**
 * The columns a table really has: the system `id`, inherited columns (a table may only restyle
 * them: label, comment, aliases, note, dense), then its own columns. `ref: self` is resolved.
 */
export function effectiveColumns(model: Pick<Metastore, "bases">, ref: CatalogRef, entry: CatalogTableEntry): Record<string, unknown>[] {
  const inherited = inheritedColumns(model, entry.bases as string[] | undefined, ref.full);
  const own = entry.columns.map((c) => withSelf(c, ref.full));
  const byName = new Map(own.map((c) => [String(c.name), c]));
  const merged = inherited.map(({ column, base }) => {
    const mine = byName.get(String(column.name));
    if (!mine) return column;
    const redefines = Object.keys(mine).some((k) => !PRESENTATION_KEYS.has(k) && JSON.stringify(mine[k]) !== JSON.stringify(column[k]));
    if (redefines) {
      throw new MetastoreError(
        `${ref.full}: column "${String(column.name)}" is inherited from base "${base}"; change the base (a table may only change label, description, aliases, note, dense)`,
      );
    }
    return { ...column, ...mine };
  });
  const inheritedNames = new Set(inherited.map((x) => String(x.column.name)));
  const id = own.filter((c) => c.name === "id" && !inheritedNames.has("id"));
  const rest = own.filter((c) => c.name !== "id" && !inheritedNames.has(String(c.name)));
  return [...id, ...merged, ...rest];
}

/** Set (or with `null` remove) a base; comments elsewhere in the file are kept. */
export function setBaseEntry(text: string, name: string, base: BaseEntry | null): string {
  return editDocument(text, (doc) => {
    if (base === null) {
      doc.deleteIn(["bases", name]);
      return;
    }
    ensureMapIn(doc, ["bases"]);
    doc.setIn(["bases", name], doc.createNode(base));
  });
}

/**
 * A table's tags (`tags: { domain: health }`) with string values, or undefined when it has none.
 * Tags written by hand as a list (`tags: [health, nightly]`) or as one word are tags with an empty
 * value (`{ health: "", nightly: "" }`).
 */
export function tableTags(entry: Pick<CatalogTableEntry, "tags">): Record<string, string> | undefined {
  const tags: unknown = entry.tags;
  const text = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const pairs: [string, string][] = isRecord(tags)
    ? Object.entries(tags).map(([k, v]) => [k, text(v)])
    : (Array.isArray(tags) ? tags : [tags]).map((k) => [text(k).trim(), ""] as [string, string]).filter(([k]) => k !== "");
  return pairs.length === 0 ? undefined : Object.fromEntries(pairs);
}

/** The entry with `tags` replaced (after `description` and `aliases`); no `tags` key when `tags` is empty. */
export function withTableTags(entry: CatalogTableEntry, tags: Record<string, string>): CatalogTableEntry {
  const { tags: _old, ...rest } = entry;
  const out: Record<string, unknown> = {};
  let placed = Object.keys(tags).length === 0;
  for (const [k, v] of Object.entries(rest)) {
    if (!placed && k !== "description" && k !== "aliases") {
      out.tags = tags;
      placed = true;
    }
    out[k] = v;
  }
  if (!placed) out.tags = tags;
  return out as CatalogTableEntry;
}

/**
 * Set (or with `null` remove) the description of a catalog, or of one of its schemas; YAML
 * comments elsewhere in the file are kept. A new description is the first key of its mapping.
 */
export function setCatalogComment(text: string, catalog: string, schema: string | undefined, comment: string | null): string {
  return editDocument(text, (doc) => {
    const path = schema === undefined ? ["catalogs", catalog] : ["catalogs", catalog, "schemas", schema];
    if (comment === null) {
      // A catalog or schema written with nothing under it (`work:`) has no description to remove.
      const node = doc.getIn(path, true);
      if (isMap(node)) node.delete("description");
      return;
    }
    ensureMapIn(doc, path);
    const map = doc.getIn(path, true) as YAMLMap; // ensureMapIn made it a mapping
    if (map.has("description")) map.set("description", comment);
    else map.items.unshift(doc.createPair("description", comment));
  });
}

/**
 * The tables and views of a parsed metastore, and the references resolved in it, kept per model:
 * a parsed model is never changed (an operation writes the file and parses it again), and every
 * read resolves the `table` property of every row, so building the lists once per model saves
 * most of a table scan. Each call still returns its own objects.
 */
interface ModelIndex {
  tables?: readonly { ref: CatalogRef; entry: CatalogTableEntry }[];
  views?: readonly { ref: CatalogRef; view: ViewEntry }[];
  /** Per kind, reference → the reference, null (none) or the candidates of an ambiguous one. */
  refs: Record<"table" | "view", Map<string, CatalogRef | null | readonly string[]>>;
}

const MODEL_INDEX = new WeakMap<Metastore, ModelIndex>();

function modelIndex(model: Metastore): ModelIndex {
  let ix = MODEL_INDEX.get(model);
  if (!ix) MODEL_INDEX.set(model, (ix = { refs: { table: new Map(), view: new Map() } }));
  return ix;
}

/** Every table of the metastore, sorted by full name. */
export function catalogTables(model: Metastore): { ref: CatalogRef; entry: CatalogTableEntry }[] {
  const ix = modelIndex(model);
  if (!ix.tables) {
    const out: { ref: CatalogRef; entry: CatalogTableEntry }[] = [];
    for (const [c, cat] of Object.entries(model.catalogs)) {
      for (const [s, sch] of Object.entries(cat.schemas)) {
        for (const [t, entry] of Object.entries(sch.tables)) out.push({ ref: refOf(c, s, t), entry });
      }
    }
    ix.tables = out.sort((a, b) => a.ref.full.localeCompare(b.ref.full));
  }
  return ix.tables.map(({ ref, entry }) => ({ ref: { ...ref }, entry }));
}

export function catalogViews(model: Metastore): { ref: CatalogRef; view: ViewEntry }[] {
  const ix = modelIndex(model);
  if (!ix.views) {
    const out: { ref: CatalogRef; view: ViewEntry }[] = [];
    for (const [c, cat] of Object.entries(model.catalogs)) {
      for (const [s, sch] of Object.entries(cat.schemas)) {
        for (const [v, view] of Object.entries(sch.views)) out.push({ ref: refOf(c, s, v), view });
      }
    }
    ix.views = out.sort((a, b) => a.ref.full.localeCompare(b.ref.full));
  }
  return ix.views.map(({ ref, view }) => ({ ref: { ...ref }, view }));
}

export function defaultCatalog(model: Metastore): string | undefined {
  const d = model.config.default_catalog;
  if (typeof d === "string" && d !== "") return d;
  const names = Object.keys(model.catalogs);
  return names.length === 1 ? names[0] : undefined;
}

export class AmbiguousCatalogRefError extends MetastoreError {
  constructor(
    readonly ref: string,
    readonly candidates: readonly string[],
  ) {
    super(`"${ref}" matches ${candidates.join(", ")}; use catalog.schema.table`);
  }
}

/**
 * Resolve a table or view reference: `catalog.schema.table`, `schema.table` (default catalog
 * first, then any catalog if unique), `table` (unique name), or the `metastore.yaml#full` path.
 */
export function resolveCatalogRef(
  model: Metastore,
  refText: string,
  kind: "table" | "view" = "table",
): CatalogRef | null {
  const found = knownRef(model, refText, kind);
  if (found === null) return null;
  if (isCatalogRef(found)) return { ...found };
  throw new AmbiguousCatalogRefError(refText, [...found]);
}

/** {@link findCatalogRef}, once per model and reference (shared: never changed by callers). */
function knownRef(model: Metastore, refText: string, kind: "table" | "view"): CatalogRef | null | readonly string[] {
  // a map per kind: every read asks it of every note, and no key is built for that
  const refs = modelIndex(model).refs[kind];
  let found = refs.get(refText);
  if (found === undefined) refs.set(refText, (found = findCatalogRef(model, refText, kind)));
  return found;
}

function isCatalogRef(v: CatalogRef | readonly string[]): v is CatalogRef {
  return !Array.isArray(v);
}

/** {@link resolveCatalogRef} without the memo: the reference, null, or the candidates when ambiguous. */
function findCatalogRef(model: Metastore, refText: string, kind: "table" | "view"): CatalogRef | null | readonly string[] {
  let ref = refText.trim();
  const hash = ref.indexOf(`${METASTORE_FILE}#`);
  if (hash >= 0) ref = ref.slice(hash + METASTORE_FILE.length + 1);
  const all = kind === "table" ? catalogTables(model).map((x) => x.ref) : catalogViews(model).map((x) => x.ref);
  const parts = ref.split(".");
  if (parts.length === 3) return all.find((r) => r.full === ref) ?? null;
  let matches: CatalogRef[] = [];
  if (parts.length === 2) {
    const def = defaultCatalog(model);
    const inDefault = all.filter((r) => r.catalog === def && r.schema === parts[0] && r.table === parts[1]);
    matches = inDefault.length > 0 ? inDefault : all.filter((r) => r.schema === parts[0] && r.table === parts[1]);
  } else if (parts.length === 1) {
    matches = all.filter((r) => r.table === parts[0]);
  }
  if (matches.length > 1) return matches.map((m) => m.full);
  return matches[0] ?? null;
}

/** Normalise a row's `table` property value to a full name (null when it names no table). */
export function rowTableFull(model: Metastore, value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  // every read asks it of every note: no copy, and an ambiguous name is no table
  const found = knownRef(model, value, "table");
  return found !== null && isCatalogRef(found) ? found.full : null;
}

const TABLE_PROPERTY_KEYS = ["partition", "filename", "archive", "exclude"] as const;

/**
 * The ordered-frontmatter description of a catalog table (the format the engine works on):
 * the `table` property first, then `fields`, dense columns, `_table` and `_columns`.
 */
export function entryToOrdered(
  ref: CatalogRef,
  entry: CatalogTableEntry,
  settings: Pick<DatanotesSettings, "tableKey">,
  model?: Pick<Metastore, "bases">,
): OrderedFrontmatter {
  const columns = model ? effectiveColumns(model, ref, entry) : entry.columns.map((c) => withSelf(c, ref.full));
  const ordered: [string, unknown][] = [[settings.tableKey, ref.full]];
  for (const [k, v] of Object.entries(entry.fields ?? {})) {
    if (k !== settings.tableKey) ordered.push([k, v]);
  }
  for (const c of columns) {
    const name = String(c.name ?? "");
    if (c.dense === true && !ordered.some(([k]) => k === name)) ordered.push([name, c.default ?? null]);
  }
  const props = entry.options ?? {};
  const tableOpt: Record<string, unknown> = { name: ref.table };
  if (typeof entry.description === "string") tableOpt.description = entry.description;
  if (Array.isArray(entry.aliases) && entry.aliases.length > 0) tableOpt.aliases = entry.aliases;
  for (const k of TABLE_PROPERTY_KEYS) if (props[k] !== undefined && props[k] !== null) tableOpt[k] = props[k];
  ordered.push([TABLE_KEY, [tableOpt]]);
  ordered.push([
    COLUMNS_KEY,
    columns.map((c) => {
      const { dense: _dense, ...rest } = c;
      return rest;
    }),
  ]);
  return ordered;
}

/** Engine column spec → metastore column: the same words, `name` first, `dense` when set. */
export function columnToEntry(c: Record<string, unknown>, dense: boolean): Record<string, unknown> {
  const { dense: _dense, ...rest } = c;
  const out: Record<string, unknown> = { name: rest.name };
  for (const [k, v] of Object.entries(rest)) if (k !== "name" && v !== undefined && !(k === "required" && v === false)) out[k] = v;
  if (dense) out.dense = true;
  return out;
}

/** Inverse of {@link entryToOrdered}: keeps entry keys the ordered form cannot carry (tags, constraints, …). */
export function orderedToEntry(
  ordered: OrderedFrontmatter,
  previous: CatalogTableEntry | undefined,
  settings: Pick<DatanotesSettings, "tableKey">,
  /**
   * For a table that extends bases: inherited columns are written back only as restyling.
   * `previousRef`: the table's name before a rename or move (its `self` links name it).
   */
  ctx?: { model: Pick<Metastore, "bases">; ref: CatalogRef; previousRef?: CatalogRef },
): CatalogTableEntry {
  const options = parseTableOptions(fmGet(ordered, TABLE_KEY));
  const columnsRaw = (fmGet(ordered, COLUMNS_KEY) as Record<string, unknown>[] | undefined) ?? [];
  const columnNames = new Set(columnsRaw.map((c) => String(c.name)));
  const reserved = new Set([settings.tableKey, ...TABLE_META_KEYS]);
  const dense = new Set<string>();
  const fields: Record<string, unknown> = {};
  for (const [k, v] of ordered) {
    if (reserved.has(k)) continue;
    if (columnNames.has(k)) dense.add(k);
    else fields[k] = v;
  }
  const properties: Record<string, unknown> = {};
  for (const k of TABLE_PROPERTY_KEYS) {
    const v = (options as Record<string, unknown>)[k];
    if (v !== undefined) properties[k] = Array.isArray(v) && v.length === 1 && k === "exclude" ? v[0] : v;
  }
  // Properties the engine's `_table` does not carry (e.g. `history`) are kept as they were.
  for (const [k, v] of Object.entries(previous?.options ?? {})) {
    if (!(TABLE_PROPERTY_KEYS as readonly string[]).includes(k)) properties[k] = v;
  }
  const { description: _c, aliases: _a, options: _p, fields: _d, columns: _cols, ...keep } = previous ?? { columns: [] };
  return {
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.aliases && options.aliases.length > 0 ? { aliases: [...options.aliases] } : {}),
    ...keep,
    ...(Object.keys(properties).length > 0 ? { options: properties } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    columns: ownColumns(columnsRaw.map((c) => columnToEntry(c, dense.has(String(c.name)))), previous, ctx),
  };
}

/** Own columns of an entry: inherited ones kept only as restyling; `self` kept where it was. */
function ownColumns(
  cols: Record<string, unknown>[],
  previous: CatalogTableEntry | undefined,
  ctx?: { model: Pick<Metastore, "bases">; ref: CatalogRef; previousRef?: CatalogRef },
): Record<string, unknown>[] {
  // a renamed or moved table: links to itself (`self`, resolved to its old name) follow the new name
  const old = ctx?.previousRef?.full;
  if (old && old !== ctx.ref.full) cols = cols.map((c) => (c.ref === old ? { ...c, ref: ctx.ref.full } : c));
  const prevSelf = new Set((previous?.columns ?? []).filter((c) => c.ref === "self").map((c) => String(c.name)));
  const restore = (c: Record<string, unknown>) =>
    ctx && prevSelf.has(String(c.name)) && c.ref === ctx.ref.full ? { ...c, ref: "self" } : c;
  if (!ctx || !previous?.bases) return cols.map(restore);
  const inherited = new Map(inheritedColumns(ctx.model, previous.bases as string[], ctx.ref.full).map((x) => [String(x.column.name), x]));
  const out: Record<string, unknown>[] = [];
  for (const c of cols) {
    const inh = inherited.get(String(c.name));
    if (!inh) {
      out.push(restore(c));
      continue;
    }
    const override: Record<string, unknown> = { name: c.name };
    for (const k of new Set([...Object.keys(c), ...Object.keys(inh.column)])) {
      if (k === "name" || JSON.stringify(c[k]) === JSON.stringify(inh.column[k])) continue;
      if (!PRESENTATION_KEYS.has(k)) {
        throw new MetastoreError(`${ctx.ref.full}: column "${String(c.name)}" is inherited from base "${inh.base}": change the base (only label, description, aliases, note, dense can differ)`);
      }
      if (c[k] !== undefined) override[k] = c[k];
    }
    if (Object.keys(override).length > 1) out.push(override);
  }
  return out;
}

const SKELETON = "# Metastore (Datanotes): catalogs, schemas, tables, columns, views.\n";

function editDocument(text: string, mutate: (doc: ReturnType<typeof parseDocument>) => void): string {
  const doc = parseDocument(text.trim() === "" ? SKELETON : text);
  mutate(doc);
  return doc.toString({ lineWidth: 0 });
}

function ensureMapIn(doc: ReturnType<typeof parseDocument>, path: string[]): void {
  for (let i = 1; i <= path.length; i++) {
    const p = path.slice(0, i);
    const node = doc.getIn(p, true);
    if (!isMap(node)) doc.setIn(p, doc.createNode({}));
    // An emptied mapping is written `{}` and read back in flow style: what is added to it goes
    // in block style, like the rest of the file (not all on one line).
    else if (node.flow && node.items.length === 0) node.flow = false;
  }
}

/** Set (or with `null` remove) a table entry; comments elsewhere in the file are kept. */
export function setTableEntry(text: string, ref: CatalogRef, entry: CatalogTableEntry | null): string {
  return setTableEntries(text, [[ref, entry]]);
}

/**
 * {@link setTableEntry} for several tables, in order: the text is parsed and printed once (a
 * large metastore takes tens of milliseconds each way).
 */
export function setTableEntries(text: string, edits: readonly (readonly [CatalogRef, CatalogTableEntry | null])[]): string {
  if (edits.length === 0) return text;
  return editDocument(text, (doc) => {
    for (const [ref, entry] of edits) {
      const path = ["catalogs", ref.catalog, "schemas", ref.schema, "tables", ref.table];
      if (entry === null) {
        doc.deleteIn(path);
        continue;
      }
      ensureMapIn(doc, path.slice(0, -1));
      doc.setIn(path, doc.createNode(entry));
    }
  });
}

export function setViewEntry(text: string, ref: CatalogRef, view: ViewEntry | null): string {
  return editDocument(text, (doc) => {
    const path = ["catalogs", ref.catalog, "schemas", ref.schema, "views", ref.table];
    if (view === null) {
      doc.deleteIn(path);
      return;
    }
    ensureMapIn(doc, path.slice(0, -1));
    doc.setIn(path, doc.createNode(view));
  });
}

export function setConfig(text: string, config: Record<string, unknown>): string {
  return editDocument(text, (doc) => {
    ensureMapIn(doc, ["config"]);
    for (const [k, v] of Object.entries(config)) doc.setIn(["config", k], v);
  });
}

/**
 * The settings a database gets when the engine creates it, written in its metastore. A setting is
 * written because its absence keeps its older meaning in a database created before: an existing
 * database without `history` keeps it off, a new one has it on.
 */
export const NEW_DATABASE_CONFIG: Readonly<Record<string, unknown>> = { history: true };

/** The text of a metastore the engine creates: {@link NEW_DATABASE_CONFIG} for the keys it does not set. */
export function withNewDatabaseConfig(text: string): string {
  let config: Record<string, unknown>;
  try {
    config = parseMetastore(text).config;
  } catch {
    return text; // not a metastore the engine can read: the write reports it
  }
  const missing = Object.entries(NEW_DATABASE_CONFIG).filter(([k]) => config[k] === undefined);
  if (missing.length === 0) return text;
  // first in the file, after its leading comments, where a reader looks for the database's settings
  if (Object.keys(config).length === 0 && !/^config\s*:/m.test(text)) {
    const lines = (text.trim() === "{}" ? "" : text).split("\n");
    let i = 0;
    while (i < lines.length && /^#/.test(lines[i]!)) i++;
    const block = ["config:", ...missing.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)];
    return [...lines.slice(0, i), ...block, ...lines.slice(i)].join("\n");
  }
  return setConfig(text, Object.fromEntries(missing));
}

/**
 * The tables' vault paths after the database folder moves from `from` to `to`: an `archive` or
 * `exclude` folder inside the old folder is moved with it. Other paths and comments are kept;
 * the text is unchanged when no path moves.
 */
export function rebaseTablePaths(text: string, from: string, to: string, entries: readonly string[] = []): string {
  const rebase = (p: unknown): unknown => {
    if (typeof p !== "string") return p;
    const v = p.trim().replace(/^\/+|\/+$/g, "");
    const moved = movePath(v, from, to, entries);
    return moved === v ? p : moved;
  };
  let changed = false;
  const after = editDocument(text, (doc) => {
    for (const { ref, entry } of catalogTables(parseMetastore(text))) {
      const props = ["catalogs", ref.catalog, "schemas", ref.schema, "tables", ref.table, "options"];
      for (const key of ["archive", "exclude"] as const) {
        const value = entry.options?.[key];
        // an archive without "/" is a folder name inside the table's folder (catalogLayout), not a vault path
        if (key === "archive" && typeof value === "string" && !value.includes("/")) continue;
        const moved = Array.isArray(value) ? value.map(rebase) : rebase(value);
        if (JSON.stringify(moved) === JSON.stringify(value)) continue;
        changed = true;
        if (Array.isArray(moved)) moved.forEach((p, i) => doc.setIn([...props, key, i], p));
        else doc.setIn([...props, key], moved);
      }
    }
  });
  return changed ? after : text;
}

// --- In-memory cache (sync reads for listTables / row discovery) ---

interface CacheEntry {
  path: string;
  text: string;
  model: Metastore;
  /** The file's size and time when \`text\` was read (hosts with `stat`): unchanged, it is not read again. */
  stamp?: { size: number; mtime: number };
}

const CACHE = new WeakMap<object, CacheEntry>();

/** Read, parse and cache the metastore; `null` when the file does not exist. */
export async function loadMetastore(
  app: App,
  settings: Pick<DatanotesSettings, "databaseFolder">,
): Promise<{ file: TFile; text: string; model: Metastore } | null> {
  const path = metastorePath(settings);
  const file = app.vault.getAbstractFileByPath(path);
  if (file == null || !("extension" in file)) {
    CACHE.delete(app);
    return null;
  }
  const cached = CACHE.get(app);
  // Every operation loads it: a file of hundreds of KB is read again only when its size or time
  // changed (taken before the read: a change meanwhile reads it again next time).
  const stamp = app.vault.adapter.stat ? await app.vault.adapter.stat(path) : null;
  if (stamp && cached?.stamp && cached.path === path && cached.stamp.size === stamp.size && cached.stamp.mtime === stamp.mtime) {
    return { file: file as TFile, text: cached.text, model: cached.model };
  }
  const text = await app.vault.read(file as TFile);
  // parsed again only when its text changed: a span then (the parse of a large metastore costs)
  const model = cached && cached.path === path && cached.text === text ? cached.model : phase("engine.metastore.parse", () => parseMetastore(text), { "datanotes.metastore.chars": text.length });
  CACHE.set(app, { path, text, model, ...(stamp ? { stamp: { size: stamp.size, mtime: stamp.mtime } } : {}) });
  return { file: file as TFile, text, model };
}

/** The last metastore loaded for this app (no I/O); call {@link loadMetastore} to refresh. */
export function cachedMetastore(app: App, settings: Pick<DatanotesSettings, "databaseFolder">): Metastore | null {
  const c = CACHE.get(app);
  return c && c.path === metastorePath(settings) ? c.model : null;
}

/** Record a metastore text we just wrote so sync readers see it at once. */
export function primeMetastore(app: App, settings: Pick<DatanotesSettings, "databaseFolder">, text: string): void {
  try {
    CACHE.set(app, { path: metastorePath(settings), text, model: parseMetastore(text) });
  } catch {
    CACHE.delete(app);
  }
}

/** The length of a text in UTF-8 bytes, as a file holding it has. */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    // each half of a surrogate pair: the pair is one character of four bytes
    else if (c >= 0xd800 && c <= 0xdfff) n += 2;
    else n += 3;
  }
  return n;
}

/**
 * {@link primeMetastore} for a text the engine just wrote to the file: with the file's size and
 * time now (when its size is the text's), so the next load reads nothing.
 */
export async function primeWrittenMetastore(app: App, settings: Pick<DatanotesSettings, "databaseFolder">, text: string): Promise<void> {
  primeMetastore(app, settings, text);
  const c = CACHE.get(app);
  const adapter = app.vault.adapter;
  if (!c || !adapter.stat) return;
  const s = await adapter.stat(c.path).catch(() => null);
  if (s && s.size === utf8Length(text) && CACHE.get(app) === c) c.stamp = { size: s.size, mtime: s.mtime };
}
