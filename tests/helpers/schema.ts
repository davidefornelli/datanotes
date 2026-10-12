/** A small JSON Schema validator for the response-schema tests (strict about undeclared properties). */

export type Schema = Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, got: string): boolean {
  return want === got || (want === "number" && got === "integer");
}

/** Errors of `value` against `schema` (type, enum, required, properties, additionalProperties, items, anyOf). */
export function validate(schema: Schema, value: unknown, at = "$"): string[] {
  const errors: string[] = [];
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as Schema[]).map((s) => validate(s, value, at));
    if (!branches.some((b) => b.length === 0)) errors.push(`${at}: matches no anyOf branch (${branches.map((b) => b[0]).join(" | ")})`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const got = typeOf(value);
    if (!types.some((t) => typeMatches(t, got))) return [...errors, `${at}: expected ${types.join("|")}, got ${got}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in obj)) errors.push(`${at}: missing required "${k}"`);
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validate(props[k]!, v, `${at}.${k}`));
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties as Schema, v, `${at}.${k}`));
      else if (schema.additionalProperties === undefined && schema.properties !== undefined) errors.push(`${at}: undeclared property "${k}"`);
      else if (schema.additionalProperties === false) errors.push(`${at}: property "${k}" not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((x, i) => errors.push(...validate(schema.items as Schema, x, `${at}[${i}]`)));
  return errors;
}

