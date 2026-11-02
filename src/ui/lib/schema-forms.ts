// Operation forms built from the public OpenAPI document (GET /datanotes/openapi.json): each
// operation's input schema becomes a list of fields, and the user's text becomes the arguments.
// The UI parses inputs into JSON types and lets the engine judge the values (dry_run). Pure.

export type FieldKind = "string" | "text" | "integer" | "number" | "boolean" | "enum" | "string-list" | "json";

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  enumValues?: string[];
  defaultValue?: unknown;
}

/** String arguments shown as a multi-line text area. */
const TEXT_NAMES = new Set(["body", "description", "instructions", "row_template", "hint", "summary"]);

const MAX_REF_DEPTH = 32;

function pointer(doc: Record<string, any>, ref: string): unknown {
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Replaces every local $ref ("#/...") with what it points at; a cycle stops at MAX_REF_DEPTH. */
function resolve(doc: Record<string, any>, node: unknown, depth: number): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(doc, n, depth));
  if (node === null || typeof node !== "object") return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (depth >= MAX_REF_DEPTH) return node;
    const target = pointer(doc, ref);
    return target === undefined ? node : resolve(doc, target, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolve(doc, v, depth);
  return out;
}

function postOf(doc: Record<string, any>, op: string): Record<string, any> | null {
  const post = doc?.paths?.[`/datanotes/operations/${op}/`]?.post;
  return post && typeof post === "object" ? post : null;
}

/** The input schema of an operation, its local $refs resolved; null when the document has none. */
export function operationSchema(doc: Record<string, any>, op: string): Record<string, any> | null {
  const schema = postOf(doc, op)?.requestBody?.content?.["application/json"]?.schema;
  if (!schema || typeof schema !== "object") return null;
  return resolve(doc, schema, 0) as Record<string, any>;
}

/** Whether an operation writes: the document lists the actor header only on writes. */
export function operationWrites(doc: Record<string, any>, op: string): boolean {
  const params = postOf(doc, op)?.parameters;
  return Array.isArray(params) && params.some((p) => typeof p?.$ref === "string" && /\/Actor$/.test(p.$ref));
}

/** Every operation of the document: name, tag and summary, in the document's order. */
export function operationsOf(doc: Record<string, any>): { op: string; tag: string; summary: string }[] {
  const out: { op: string; tag: string; summary: string }[] = [];
  for (const [path, item] of Object.entries((doc?.paths ?? {}) as Record<string, any>)) {
    const m = /^\/datanotes\/operations\/([^/]+)\/$/.exec(path);
    const post = item?.post;
    if (!m || !post) continue;
    const tag = Array.isArray(post.tags) && typeof post.tags[0] === "string" ? post.tags[0] : "Other";
    out.push({ op: m[1]!, tag, summary: typeof post.summary === "string" ? post.summary : "" });
  }
  return out;
}

function kindOf(name: string, s: Record<string, any>): { kind: FieldKind; schema: Record<string, any> } {
  let t = s;
  const alts = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (alts) {
    const rest = alts.filter((a: any) => !(a && a.type === "null"));
    if (rest.length !== 1) return { kind: "json", schema: s };
    t = rest[0] ?? {};
  }
  if (t.type === "string") return { kind: Array.isArray(t.enum) ? "enum" : TEXT_NAMES.has(name) ? "text" : "string", schema: t };
  if (t.type === "integer" || t.type === "number" || t.type === "boolean") return { kind: t.type, schema: t };
  if (t.type === "array" && t.items?.type === "string" && !Array.isArray(t.items.enum)) return { kind: "string-list", schema: t };
  return { kind: "json", schema: t };
}

/** The fields of an input schema; dry_run is left out (the form has its own buttons). */
export function fieldsOf(schema: Record<string, any>): FieldSpec[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, any>>;
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  const out: FieldSpec[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (name === "dry_run") continue;
    const s = raw && typeof raw === "object" ? raw : {};
    const { kind, schema: t } = kindOf(name, s);
    const spec: FieldSpec = { name, kind, required: required.has(name) };
    const description = s.description ?? t.description;
    if (typeof description === "string") spec.description = description;
    if (kind === "enum") spec.enumValues = (t.enum as unknown[]).map(String);
    if (s.default !== undefined && s.default !== null) spec.defaultValue = s.default;
    out.push(spec);
  }
  return out;
}

/** The user's input for one field as a JSON value; empty input is no value (or an error when required). */
export function parseField(spec: FieldSpec, raw: string | boolean | null): { value?: unknown; error?: string } {
  if (typeof raw === "boolean") {
    if (spec.kind === "boolean") return { value: raw };
    raw = String(raw);
  }
  const text = raw ?? "";
  const keepSpaces = spec.kind === "string" || spec.kind === "text";
  if ((keepSpaces ? text : text.trim()) === "") return spec.required ? { error: `"${spec.name}" is required` } : {};
  const t = text.trim();
  switch (spec.kind) {
    case "integer":
      return /^-?\d+$/.test(t) ? { value: Number(t) } : { error: `"${spec.name}" takes a whole number` };
    case "number": {
      const n = Number(t);
      return Number.isFinite(n) ? { value: n } : { error: `"${spec.name}" takes a number` };
    }
    case "boolean":
      if (t === "true" || t === "false") return { value: t === "true" };
      return { error: `"${spec.name}" takes true or false` };
    case "string-list":
      return {
        value: t
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== ""),
      };
    case "json":
      try {
        return { value: JSON.parse(t) };
      } catch (e) {
        return { error: `"${spec.name}" is not valid JSON: ${(e as Error).message}` };
      }
    default:
      return { value: text };
  }
}

/** The arguments of a form, and an error per field that does not parse. */
export function buildArgs(
  specs: FieldSpec[],
  raw: Record<string, string | boolean | null>,
): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const spec of specs) {
    const r = parseField(spec, raw[spec.name] ?? null);
    if (r.error !== undefined) errors[spec.name] = r.error;
    else if (r.value !== undefined) args[spec.name] = r.value;
  }
  return { args, errors };
}

/** The text a form shows for a value (the reverse of parseField). */
export function rawOf(spec: FieldSpec, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (spec.kind === "string-list" && Array.isArray(value)) return value.map(String).join("\n");
  if (spec.kind === "json") return JSON.stringify(value, null, 2);
  return typeof value === "string" ? value : JSON.stringify(value);
}
