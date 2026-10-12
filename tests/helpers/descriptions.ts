/**
 * Every table and column an operation creates needs a description (src/core/descriptions.ts). Tests
 * about something else wrap their create_table / add_column input in `described` (define_base's in
 * `describedBase`): what has no description gets a plain one, what has one keeps it. The tests of the
 * rule itself (tests/descriptions.test.ts) call the operations without them.
 */

type Input = Record<string, unknown>;

const isRecord = (v: unknown): v is Input => v !== null && typeof v === "object" && !Array.isArray(v);

const has = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** A column spec with a description (anything else as it is; the engine describes `id` and `uuid` / `created` identities). */
function column<T>(c: T): T {
  if (!isRecord(c) || has(c.description) || has(c.description) || c.name === "id" || c.identity === "uuid" || c.identity === "created") return c;
  return { ...c, description: `Test column ${String(c.name)}` } as T;
}

const columns = (v: unknown) => (Array.isArray(v) ? v.map(column) : v);

/**
 * create_table or add_column input (as the engine, the public API, a batch step or a route body
 * takes it) with the descriptions it lacks: the table's (`description`, unless `options.description`
 * has one) and each column's.
 */
export function described<T>(input: T): T {
  if (!isRecord(input)) return input;
  const out: Input = { ...input };
  if ("column" in out) out.column = column(out.column);
  if ("columns" in out) {
    out.columns = columns(out.columns);
    const options = isRecord(out.options) ? out.options : {};
    if (!has(out.description) && !has(options.description)) out.description = `Test table ${String(out.name)}`;
  }
  return out as T;
}

/** define_base input with the descriptions it lacks: the base's and each column's. */
export function describedBase<T>(input: T): T {
  if (!isRecord(input)) return input;
  return { ...input, ...(has(input.description) ? {} : { description: `Test base ${String(input.name)}` }), columns: columns(input.columns) } as T;
}
