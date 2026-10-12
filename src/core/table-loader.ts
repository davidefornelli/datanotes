/**
 * Parse the `_table` options and `_columns` of a table's ordered description (see
 * `entryToOrdered` in metastore.ts) into a {@link TableDefinition}.
 */

import { fmGet } from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { TABLE_META_KEYS } from "./reserved-keys";
import type { CatalogRef } from "./metastore";
import { generatedRefs, isLinkExpression, isTemplateExpression } from "./generated";
import {
  COLUMNS_KEY,
  DEFAULT_NOW,
  DEFAULT_TODAY,
  SCALAR_COLUMN_TYPES,
  TABLE_KEY,
  type ColumnSpec,
  type ColumnType,
  type LinkLevels,
  type ScalarColumnType,
  type TableColumn,
  type TableDefinition,
  type TableLayout,
  type TableOptions,
} from "./types-table";
import type { OrderedFrontmatter } from "./types";
import { isEmptyValue, validateValue } from "./validate";
import { messageOf } from "./message";
import { inDatabase, normalizeDatabaseFolder } from "./db-paths";

export class MalformedColumnError extends Error {
  override readonly name = "MalformedColumnError";
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(`columns[${index}]: ${message}`);
  }
}

export class MalformedTableOptionsError extends Error {
  override readonly name = "MalformedTableOptionsError";
  constructor(message: string) {
    super(message);
  }
}

/** The attributes a column spec may have (the operations' words; metastore.ts writes the file's). */
export const COLUMN_ATTRS: ReadonlySet<string> = new Set([
  "name",
  "type",
  "items",
  "required",
  "default",
  "min",
  "max",
  "step",
  "values",
  "value_descriptions",
  "external_default",
  "ref",
  "label",
  "description",
  "aliases",
  "note",
  "unique",
  "ordered",
  "generated",
  "identity",
  "hierarchy",
  "vocabulary",
  "inverse",
  "ref_where",
  "ref_by",
]);

/** The options of a table (`_table`); `metastore.yaml` keeps them as `description`, `aliases` and `options`. */
export const TABLE_ATTRS: ReadonlySet<string> = new Set(["name", "partition", "filename", "archive", "exclude", "description", "aliases"]);

const COLUMN_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function isScalarType(t: unknown): t is ScalarColumnType {
  return typeof t === "string" && (SCALAR_COLUMN_TYPES as readonly string[]).includes(t);
}

function optionalString(entry: Record<string, unknown>, key: string, index: number): string | undefined {
  const v = entry[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new MalformedColumnError(index, `"${key}" must be a string`);
  return v;
}

function optionalNumber(entry: Record<string, unknown>, key: string, index: number): number | undefined {
  const v = entry[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new MalformedColumnError(index, `"${key}" must be a number`);
  }
  return v;
}

function stringList(entry: Record<string, unknown>, key: string, index: number): string[] | undefined {
  const v = entry[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new MalformedColumnError(index, `"${key}" must be a list`);
  return v.map((x) => {
    if (typeof x !== "string" && typeof x !== "number") {
      throw new MalformedColumnError(index, `"${key}" items must be strings`);
    }
    return String(x);
  });
}

const LINK_LEVELS_KEYS: ReadonlySet<string> = new Set(["column", "target_column", "levels", "map"]);

/**
 * Parse `ref_by` (see {@link LinkLevels}): `{column, levels}` or `{column, map}`, with an optional
 * `target_column`. `levels` is expanded into the map (each level's targets: the level before it).
 */
export function parseLinkLevels(raw: unknown, index: number): LinkLevels {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MalformedColumnError(index, `"ref_by" must be {column, levels} or {column, map}`);
  }
  const by = raw as Record<string, unknown>;
  for (const k of Object.keys(by)) {
    if (!LINK_LEVELS_KEYS.has(k)) throw new MalformedColumnError(index, `"ref_by": unknown key "${k}" (column, target_column, levels, map)`);
  }
  const name = (k: string): string | undefined => {
    const v = by[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || !COLUMN_NAME_RE.test(v)) throw new MalformedColumnError(index, `"ref_by.${k}" must be a column name`);
    return v;
  };
  const column = name("column");
  if (column === undefined) throw new MalformedColumnError(index, `"ref_by.column" is required: the column of the row that picks the allowed targets`);
  const target = name("target_column");
  const hasLevels = by.levels !== undefined && by.levels !== null;
  const hasMap = by.map !== undefined && by.map !== null;
  if (hasLevels === hasMap) throw new MalformedColumnError(index, `"ref_by" needs either "levels" or "map"`);
  const words = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || x === "")) {
      throw new MalformedColumnError(index, `${what} must be a non-empty list of values`);
    }
    if (new Set(v).size !== v.length) throw new MalformedColumnError(index, `${what} lists a value twice`);
    return v as string[];
  };
  const map: Record<string, string[] | null> = {};
  let levels: string[] | undefined;
  if (hasLevels) {
    levels = words(by.levels, `"ref_by.levels"`);
    levels.forEach((l, i) => (map[l] = i === 0 ? null : [levels![i - 1]!]));
  } else {
    const m = by.map;
    if (typeof m !== "object" || Array.isArray(m) || Object.keys(m as object).length === 0) {
      throw new MalformedColumnError(index, `"ref_by.map" must map each value of "${column}" to null (top level) or its allowed targets`);
    }
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) map[k] = v === null ? null : words(v, `"ref_by.map.${k}"`);
  }
  return { column, ...(target !== undefined ? { target_column: target } : {}), ...(levels ? { levels } : {}), map };
}

/** The `ref_by` column must be a scalar enum or string column of the table; an enum's map keys must be its values. */
function checkLinkLevels(specs: readonly ColumnSpec[]): void {
  specs.forEach((c, index) => {
    if (!c.ref_by) return;
    const by = specs.find((s) => s.name === c.ref_by!.column);
    if (!by) throw new MalformedColumnError(index, `"ref_by.column": no column "${c.ref_by.column}" in the table`);
    if (by.type !== "enum" && by.type !== "string") throw new MalformedColumnError(index, `"ref_by.column": "${by.name}" must be an enum or string column`);
    const unknown = by.type === "enum" ? Object.keys(c.ref_by.map).filter((k) => !by.values?.includes(k)) : [];
    if (unknown.length > 0) {
      // only an enum column has unknown keys, and an enum column has its values
      throw new MalformedColumnError(index, `"ref_by": ${unknown.map((k) => `"${k}"`).join(", ")} not a value of ${by.name} (${by.values!.join(", ")})`);
    }
  });
}

/** Parse one `_columns` entry. `reserved` names cannot be used as columns. */
export function parseColumn(
  raw: unknown,
  index: number,
  reserved: ReadonlySet<string> = new Set(),
): ColumnSpec {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MalformedColumnError(index, "expected a mapping");
  }
  const entry = raw as Record<string, unknown>;
  for (const k of Object.keys(entry)) {
    if (!COLUMN_ATTRS.has(k)) throw new MalformedColumnError(index, `unknown attribute "${k}"`);
  }
  const name = entry.name;
  if (typeof name !== "string" || !COLUMN_NAME_RE.test(name)) {
    throw new MalformedColumnError(
      index,
      `"name" must start with a letter and contain only letters, digits, "_" or "-"`,
    );
  }
  if (reserved.has(name)) {
    throw new MalformedColumnError(index, `"${name}" is a reserved front matter key`);
  }
  const type = entry.type;
  if (type !== "list" && !isScalarType(type)) {
    throw new MalformedColumnError(
      index,
      `"type" must be one of: ${[...SCALAR_COLUMN_TYPES, "list"].join(", ")}`,
    );
  }
  let items: ScalarColumnType | undefined;
  if (type === "list") {
    const it = entry.items ?? "string";
    if (!isScalarType(it)) {
      throw new MalformedColumnError(index, `"items" must be a scalar column type`);
    }
    items = it;
  } else if (entry.items !== undefined && entry.items !== null) {
    throw new MalformedColumnError(index, `"items" is only valid for list columns`);
  }
  const effective: ScalarColumnType = items ?? (type as ScalarColumnType);

  const required = entry.required ?? false;
  if (typeof required !== "boolean") {
    throw new MalformedColumnError(index, `"required" must be true or false`);
  }

  const min = optionalNumber(entry, "min", index);
  const max = optionalNumber(entry, "max", index);
  const step = optionalNumber(entry, "step", index);
  if ((min ?? max ?? step) !== undefined && effective !== "number" && effective !== "integer") {
    throw new MalformedColumnError(index, `"min"/"max"/"step" are only valid for number columns`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new MalformedColumnError(index, `"min" must be <= "max"`);
  }
  if (step !== undefined && step <= 0) {
    throw new MalformedColumnError(index, `"step" must be > 0`);
  }

  const values = stringList(entry, "values", index);
  if (effective === "enum" && (values === undefined || values.length === 0)) {
    throw new MalformedColumnError(index, `enum columns need a non-empty "values" list`);
  }
  if (values !== undefined && effective !== "enum") {
    throw new MalformedColumnError(index, `"values" is only valid for enum columns`);
  }

  let valueDescriptions: Record<string, string> | undefined;
  if (entry.value_descriptions !== undefined && entry.value_descriptions !== null) {
    const vd = entry.value_descriptions;
    if (effective !== "enum") throw new MalformedColumnError(index, `"value_descriptions" is only valid for enum columns`);
    if (typeof vd !== "object" || Array.isArray(vd)) throw new MalformedColumnError(index, `"value_descriptions" must map each value to its meaning`);
    valueDescriptions = {};
    // an enum column has its values (checked above)
    for (const [k, d] of Object.entries(vd as Record<string, unknown>)) {
      if (!values?.includes(k)) throw new MalformedColumnError(index, `"value_descriptions": "${k}" is not one of the values (${values!.join(", ")})`);
      if (typeof d !== "string" || d.trim() === "") throw new MalformedColumnError(index, `"value_descriptions.${k}" must be a non-empty string`);
      valueDescriptions[k] = d.trim();
    }
  }

  const externalDefault = entry.external_default;
  // an enum column has its values (checked above)
  if (externalDefault !== undefined && externalDefault !== null && effective === "enum" && !values?.includes(String(externalDefault))) {
    throw new MalformedColumnError(index, `"external_default" must be one of the values (${values!.join(", ")})`);
  }

  const ref = optionalString(entry, "ref", index);
  if (ref !== undefined && effective !== "link") {
    throw new MalformedColumnError(index, `"ref" is only valid for link columns`);
  }

  const spec: ColumnSpec = {
    name,
    type: type as ColumnType,
    ...(items !== undefined ? { items } : {}),
    required,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(values !== undefined ? { values } : {}),
    ...(valueDescriptions !== undefined ? { value_descriptions: valueDescriptions } : {}),
    ...(externalDefault !== undefined && externalDefault !== null ? { external_default: externalDefault } : {}),
    ...(ref !== undefined ? { ref } : {}),
    aliases: stringList(entry, "aliases", index) ?? [],
  };
  const unique = entry.unique ?? false;
  if (typeof unique !== "boolean") throw new MalformedColumnError(index, `"unique" must be true or false`);
  if (unique && type === "list") throw new MalformedColumnError(index, `"unique" is not valid for list columns`);
  if (unique) spec.unique = true;
  const ordered = entry.ordered ?? false;
  if (typeof ordered !== "boolean") throw new MalformedColumnError(index, `"ordered" must be true or false`);
  if (ordered && effective !== "enum") throw new MalformedColumnError(index, `"ordered" is only valid for enum columns`);
  if (ordered) spec.ordered = true;
  const label = optionalString(entry, "label", index);
  const description = optionalString(entry, "description", index);
  const note = optionalString(entry, "note", index);
  if (label !== undefined) spec.label = label;
  if (description !== undefined) spec.description = description;
  if (note !== undefined) spec.note = note;

  const generated = optionalString(entry, "generated", index);
  if (generated !== undefined) {
    if (generated.trim() === "") throw new MalformedColumnError(index, `"generated" must be an expression`);
    spec.generated = generated.trim();
  }
  if (entry.identity !== undefined) {
    if (entry.identity !== "filename" && entry.identity !== "uuid" && entry.identity !== "created") {
      throw new MalformedColumnError(index, `"identity" must be "uuid", "filename" or "created"`);
    }
    if (entry.identity === "created") {
      if (type !== "datetime" && type !== "date") throw new MalformedColumnError(index, `"identity: created" needs a date or datetime column`);
    } else if (type !== "string") {
      // one value per row (an id, the file name): a list of strings is not one
      throw new MalformedColumnError(index, `"identity: ${entry.identity}" is only valid for string columns${type === "list" ? ", not lists" : ""}`);
    }
    spec.identity = entry.identity;
  }
  if (entry.hierarchy !== undefined) {
    if (typeof entry.hierarchy !== "boolean") throw new MalformedColumnError(index, `"hierarchy" must be true or false`);
    if (entry.hierarchy && (type !== "link" || !ref)) {
      throw new MalformedColumnError(index, `"hierarchy" needs a single link column with "ref" (one parent per row)`);
    }
    if (entry.hierarchy) spec.hierarchy = true;
  }
  if (entry.inverse !== undefined && entry.inverse !== null) {
    if (typeof entry.inverse !== "string" || !COLUMN_NAME_RE.test(entry.inverse.trim())) {
      throw new MalformedColumnError(index, `"inverse" must be the name of a column of the linked table`);
    }
    if (effective !== "link" || !ref) throw new MalformedColumnError(index, `"inverse" needs a link column (or list of links) with "ref"`);
    spec.inverse = entry.inverse.trim();
  }
  if (entry.vocabulary !== undefined && entry.vocabulary !== null) {
    if (typeof entry.vocabulary !== "string" || entry.vocabulary.trim() === "") {
      throw new MalformedColumnError(index, `"vocabulary" must be a table name`);
    }
    if (effective !== "string") throw new MalformedColumnError(index, `"vocabulary" is only valid for string columns and lists of strings`);
    spec.vocabulary = entry.vocabulary.trim();
  }
  if (entry.ref_where !== undefined && entry.ref_where !== null) {
    const w = entry.ref_where;
    if (typeof w !== "object" || Array.isArray(w) || Object.keys(w).length === 0) {
      throw new MalformedColumnError(index, `"ref_where" must be a non-empty where filter on the linked table`);
    }
    if (effective !== "link" || !ref) throw new MalformedColumnError(index, `"ref_where" needs a link column (or list of links) with "ref"`);
    spec.ref_where = w as Record<string, unknown>;
  }
  if (entry.ref_by !== undefined && entry.ref_by !== null) {
    if (effective !== "link" || !ref) throw new MalformedColumnError(index, `"ref_by" needs a link column (or list of links) with "ref"`);
    spec.ref_by = parseLinkLevels(entry.ref_by, index);
  }
  if ((spec.generated !== undefined || spec.identity !== undefined) && entry.default !== undefined && entry.default !== null) {
    throw new MalformedColumnError(index, `a generated or identity column cannot have a "default"`);
  }
  const token = entry.default === DEFAULT_NOW || entry.default === DEFAULT_TODAY;
  if (token && effective !== "datetime" && effective !== "date") {
    throw new MalformedColumnError(index, `"${String(entry.default)}" is only valid for date and datetime columns`);
  }
  if (token) spec.default = entry.default;
  else if (!isEmptyValue(entry.default) && entry.default !== undefined) {
    const bad = validateValue(spec, entry.default);
    if (bad.length > 0) {
      throw new MalformedColumnError(index, `"default" is invalid: ${bad[0]!.message}`);
    }
    spec.default = entry.default;
  }
  return spec;
}

/** Parse the `_columns` list. Duplicate names are rejected. */
export function parseColumns(
  raw: unknown,
  reserved: ReadonlySet<string> = new Set(),
): ColumnSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new MalformedColumnError(0, "_columns must be a list");
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const col = parseColumn(entry, i, reserved);
    if (seen.has(col.name)) {
      throw new MalformedColumnError(i, `duplicate column "${col.name}"`);
    }
    seen.add(col.name);
    return col;
  });
}

/** Parse `_table` (a list with at most one mapping). */
export function parseTableOptions(raw: unknown): TableOptions {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) throw new MalformedTableOptionsError("must be a list with one mapping");
  if (raw.length === 0) return {};
  if (raw.length > 1) throw new MalformedTableOptionsError("must contain exactly one mapping");
  const entry = raw[0] as Record<string, unknown>;
  const out: TableOptions = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!TABLE_ATTRS.has(k)) throw new MalformedTableOptionsError(`unknown attribute "${k}"`);
    if (v === null || v === undefined) continue;
    if (k === "partition") {
      if (typeof v !== "string") throw new MalformedTableOptionsError(`"partition" must be a folder pattern`);
      const partition = v.trim().replace(/^\/+|\/+$/g, "");
      if (partition !== "") out.partition = partition;
      continue;
    }
    if (k === "exclude") {
      const list = Array.isArray(v) ? v : [v];
      if (list.some((x) => typeof x !== "string" || x.trim() === "")) {
        throw new MalformedTableOptionsError(`"exclude" must be a folder or a list of folders`);
      }
      const folders = list.map((x) => (x as string).trim().replace(/^\/+|\/+$/g, "")).filter((x) => x !== "");
      if (folders.length > 0) out.exclude = folders;
      continue;
    }
    if (k === "aliases") {
      const list = Array.isArray(v) ? v : [v];
      if (list.some((x) => typeof x !== "string" || x.trim() === "")) {
        throw new MalformedTableOptionsError(`"aliases" must be a word or a list of words`);
      }
      out.aliases = list.map((x) => (x as string).trim());
      continue;
    }
    if (typeof v !== "string" || v.trim() === "") {
      throw new MalformedTableOptionsError(`"${k}" must be a non-empty string`);
    }
    out[k as "name" | "filename" | "archive" | "description"] = v.trim();
  }
  return out;
}

export const DEFAULT_DATABASE_FOLDER = "datanotes";

/** Archive folder name inside a table's folder. */
export const DEFAULT_ARCHIVE_FOLDER = "_archive";

/** Where a table's rows go: `<root>/<catalog>/<schema>/<table>[/<partition>]`. */
export function catalogLayout(root: string, ref: CatalogRef, options: TableOptions): TableLayout {
  const folder = inDatabase(root, `${ref.catalog}/${ref.schema}/${ref.table}`);
  const archiveName = options.archive && !options.archive.includes("/") ? options.archive : DEFAULT_ARCHIVE_FOLDER;
  return {
    folder,
    inDatabase: true,
    rowPath: options.partition ? `${folder}/${options.partition}` : folder,
    archive: options.archive && options.archive.includes("/") ? options.archive : `${folder}/${archiveName}`,
  };
}

/** Generated expressions must parse and read existing columns (earlier generated ones only). */
function checkGeneratedColumns(specs: readonly ColumnSpec[], known: ReadonlySet<string>): void {
  specs.forEach((c, index) => {
    if (c.generated === undefined) return;
    let refs: string[];
    try {
      refs = generatedRefs(c.generated);
    } catch (e) {
      throw new MalformedColumnError(index, messageOf(e));
    }
    if (isTemplateExpression(c.generated) && c.type !== "string") {
      throw new MalformedColumnError(index, `a template expression makes text: "${c.name}" must be a string column`);
    }
    if (isLinkExpression(c.generated) && (c.type !== "link" || !c.ref)) {
      throw new MalformedColumnError(index, `link(…) makes a link: "${c.name}" must be a link column with "ref" (the table it links to)`);
    }
    for (const ref of refs) {
      if (ref === "path") continue;
      if (ref === c.name) throw new MalformedColumnError(index, `"generated" cannot read the column itself`);
      if (!known.has(ref)) throw new MalformedColumnError(index, `"generated" reads unknown column "${ref}"`);
      const at = specs.findIndex((s) => s.name === ref);
      if (at > index && specs[at]!.generated !== undefined) {
        throw new MalformedColumnError(index, `"generated" reads generated column "${ref}", declared after it`);
      }
    }
  });
}

/**
 * Build a {@link TableDefinition} from the ordered description of a metastore table (see
 * `entryToOrdered`). Dense columns are those also present as top-level fields.
 */
export function tableDefinitionFromOrdered(
  ref: CatalogRef,
  /** `<root>/metastore.yaml#catalog.schema.table` */
  schemaPath: string,
  ordered: OrderedFrontmatter,
  settings: Pick<DatanotesSettings, "databaseFolder">,
): TableDefinition {
  const reserved = new Set(TABLE_META_KEYS);
  const options = parseTableOptions(fmGet(ordered, TABLE_KEY));
  const specs = parseColumns(fmGet(ordered, COLUMNS_KEY), reserved);
  const fieldKeys = ordered
    .map(([k]) => k)
    .filter((k) => !reserved.has(k));
  const fieldSet = new Set(fieldKeys);
  const columnNames = new Set(specs.map((c) => c.name));
  const columns: TableColumn[] = specs.map((c) => ({ ...c, dense: fieldSet.has(c.name) }));
  checkGeneratedColumns(specs, new Set([...columnNames, ...fieldKeys]));
  checkLinkLevels(specs);
  return {
    schemaPath,
    name: ref.table,
    schema: ref.schema,
    catalog: ref.catalog,
    layout: catalogLayout(normalizeDatabaseFolder(settings.databaseFolder), ref, options),
    options,
    columns,
    untypedFields: fieldKeys.filter((k) => !columnNames.has(k)),
  };
}
