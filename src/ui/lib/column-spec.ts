// Column specs as the structure screens edit them: from a describe_table column to the spec of
// add_column, and from two specs to the `changes` of alter_column. The engine judges every spec
// (dry_run); these helpers only shape what the forms send. Pure.

/** The engine's column types (SCALAR_COLUMN_TYPES of src/core/types-table.ts) plus `list`. */
export const COLUMN_TYPES = ["string", "number", "integer", "boolean", "date", "datetime", "enum", "link", "json", "list"] as const;

/** The attributes of a column spec: the engine's COLUMN_ATTRS (src/core/table-loader.ts) plus `dense`. */
export const SPEC_ATTRS: readonly string[] = [
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
  "acyclic",
  "vocabulary",
  "inverse",
  "ref_where",
  "ref_by",
  "dense",
];

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The flags whose `false` is the same as leaving them out. */
const FALSE_IS_ABSENT = new Set(["required", "dense"]);

function isEmpty(key: string, v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return v === false && FALSE_IS_ABSENT.has(key);
}

/** JSON with object keys sorted: two specs that differ only in key order are equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** A describe_table column as a spec: only SPEC_ATTRS keys; empty aliases dropped. */
export function specFromColumn(c: Record<string, unknown>): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const k of SPEC_ATTRS) {
    const v = c[k];
    if (v === undefined) continue;
    if (k === "aliases" && Array.isArray(v) && v.length === 0) continue;
    spec[k] = v;
  }
  return spec;
}

/** A spec without its empty parts: undefined, null, "", [], {}, required false, dense false. */
export function cleanSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) if (!isEmpty(k, v)) out[k] = v;
  return out;
}

/**
 * What alter_column must change to turn `before` into `after`: the changed keys with their new
 * value; a removed attribute is `null` (`false` for required and dense). Never the name (rename_column
 * renames), never a null description (the engine refuses it: a description changes, never goes).
 */
export function alterChanges(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const a = cleanSpec(before);
  const b = cleanSpec(after);
  const changes: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === "name") continue;
    if (!(k in b)) {
      if (k === "description") continue;
      changes[k] = FALSE_IS_ABSENT.has(k) ? false : null;
    } else if (stable(a[k]) !== stable(b[k])) {
      changes[k] = b[k];
    }
  }
  return changes;
}

/** The type a column's values have: a list's items, else its own type. */
function effective(type: string, items?: string): string {
  return type === "list" ? items || "string" : type;
}

/** The attributes the column editor shows for a type, in the order it shows them. */
export function attrsForType(type: string, items?: string): string[] {
  const list = type === "list";
  const t = effective(type, items);
  const attrs = ["name", "type"];
  if (list) attrs.push("items");
  attrs.push("description", "required");
  if (!list) attrs.push("unique");
  attrs.push("default");
  if (t === "number" || t === "integer") attrs.push("min", "max", "step");
  if (t === "enum") attrs.push("values", "value_descriptions", "ordered");
  if (t === "link") {
    attrs.push("ref", "inverse");
    if (!list) attrs.push("hierarchy");
    attrs.push("acyclic", "ref_where", "ref_by");
  }
  if (t === "string") attrs.push("vocabulary");
  if (!list && (t === "string" || t === "date" || t === "datetime")) attrs.push("identity");
  attrs.push("generated", "aliases", "label", "note", "dense");
  return attrs;
}

/** What keeps a spec from being sent: the checks a form can make before the engine's. */
export function specProblems(spec: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const name = spec.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    problems.push('The name starts with a letter and holds only letters, digits, "_" or "-".');
  }
  if (typeof spec.description !== "string" || spec.description.trim() === "") {
    problems.push("Write a description: what the column holds.");
  }
  const type = typeof spec.type === "string" ? spec.type : "";
  const items = typeof spec.items === "string" ? spec.items : "";
  if (type === "list" && !items) problems.push("A list column needs the type of its items.");
  const t = effective(type, items);
  if (t === "enum" && !(Array.isArray(spec.values) && spec.values.length > 0)) {
    problems.push("An enum column needs its values.");
  }
  if (t === "link" && !(typeof spec.ref === "string" && spec.ref !== "")) {
    problems.push("A link column needs the table it links to (ref).");
  }
  return problems;
}
