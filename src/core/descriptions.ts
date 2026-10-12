/**
 * Every table and every column says what it holds: descriptions are how agents and people
 * understand the schema (an agent matches a request against them to pick the table and the
 * column). What an operation creates must have them: create_table, add_column, clone_table and
 * define_base refuse a table, a base or a column without one, listing every missing one at once,
 * and alter_table / alter_column cannot remove one. The engine writes the description of the
 * columns whose values and meaning it sets itself: the system `id`, and `identity: uuid` or
 * `identity: created` columns.
 *
 * Tables and columns written before the rule stay valid: describe_table and describe_database list
 * what they lack (`missing_descriptions`), for an agent to fill with alter_table and alter_column.
 */

import { guide, type Guidance } from "./hints";
import { SYSTEM_ID_COLUMN, SYSTEM_ID_SPEC } from "./types-table";

/** A description worth the name: a string with some text. */
export function hasText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** What the engine writes for an `identity: created` column. */
export const CREATED_DESCRIPTION = "When the row was created: set by the engine, never changes";

/** The description the engine writes for a column whose values and meaning it sets itself, or undefined. */
export function engineDescription(c: Record<string, unknown>): string | undefined {
  if (c.name === SYSTEM_ID_COLUMN || c.identity === "uuid") return SYSTEM_ID_SPEC.description;
  if (c.identity === "created") return CREATED_DESCRIPTION;
  return undefined;
}

/**
 * A column spec as given, with the engine's description when the engine sets the column and it has
 * none. Anything but an object is returned as it is (the column's parser refuses it).
 */
export function withEngineDescription<T>(c: T): T {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return c;
  const col = c as Record<string, unknown>;
  const d = hasText(col.description) ? undefined : engineDescription(col);
  return d === undefined ? c : ({ ...col, description: d } as T);
}

/** What lacks a description: the table (or base) itself, and the columns by name. */
export interface MissingDescriptions {
  table: boolean;
  columns: string[];
}

/** A column's description, in the operations' words (`description`) or the file's (`comment`), or undefined. */
export function descriptionOf(column: object): string | undefined {
  const c = column as Record<string, unknown>;
  return hasText(c.description) ? c.description : undefined;
}

/**
 * What a table or a base lacks: its own description (`own`) and its columns'; null when nothing. A
 * column the engine sets itself never lacks one: the engine's description says what it holds.
 */
export function missingDescriptions(own: unknown, columns: readonly object[]): MissingDescriptions | null {
  const cols = columns
    .filter((c) => descriptionOf(c) === undefined && engineDescription(c as Record<string, unknown>) === undefined)
    .map((c) => String((c as Record<string, unknown>).name));
  return hasText(own) && cols.length === 0 ? null : { table: !hasText(own), columns: cols };
}

/** `the table and columns year, rating` (`self`: how the table or base is named). */
function missingList(m: MissingDescriptions, self: string): string {
  const cols = m.columns.length === 0 ? [] : [`${m.columns.length === 1 ? "column" : "columns"} ${m.columns.join(", ")}`];
  return [...(m.table ? [self] : []), ...cols].join(" and ");
}

const WHY = "Agents and people understand the schema through them.";

/** A column in the shape of a call (its type from `columns`, as given), its description left to write. */
function columnShape(columns: readonly object[], name: string): string {
  const type = (columns as readonly Record<string, unknown>[]).find((c) => c.name === name)?.type;
  return `{"name": ${JSON.stringify(name)}${typeof type === "string" ? `, "type": ${JSON.stringify(type)}` : ""}, "description": "<what ${name} holds>"}`;
}

/** `, "columns": [<the first missing column>, …]`, or "" when only the table lacks one. */
function columnsShape(m: MissingDescriptions, columns: readonly object[]): string {
  const first = m.columns[0];
  return first === undefined ? "" : `, "columns": [${columnShape(columns, first)}${m.columns.length > 1 ? ", …" : ""}]`;
}

/** A refusal: the message and its guidance. */
export interface Refusal {
  message: string;
  guidance: Guidance;
}

/**
 * create_table without descriptions: `columns` as given (for the shape), `proposal` when a
 * description was passed as null, as infer_table leaves them.
 */
export function createTableRefusal(full: string, m: MissingDescriptions, columns: readonly object[], proposal: boolean): Refusal {
  const name = full.split(".").pop()!; // split() returns at least one element
  return {
    message: `descriptions are required: ${full} has none for ${missingList(m, "the table")}`,
    guidance: guide(
      [
        `Say what a row records in "description" and what each column holds in its own "description": {"name": ${JSON.stringify(name)}, "description": "<what a row of ${name} records>"${columnsShape(m, columns)}}.`,
        proposal ? "infer_table leaves every description null: write each one, then call create_table again." : WHY,
      ].join(" "),
      "descriptions",
    ),
  };
}

/** add_column without a description. */
export function addColumnRefusal(full: string, column: object): Refusal {
  const name = String((column as Record<string, unknown>).name);
  return {
    message: `descriptions are required: column ${name} of ${full} has none`,
    guidance: guide(`Say what the column holds in its "description": {"table": ${JSON.stringify(full)}, "column": ${columnShape([column], name)}}. ${WHY}`, "descriptions"),
  };
}

/** clone_table of a source whose definition lacks descriptions: they are filled on the source first. */
export function cloneTableRefusal(source: string, m: MissingDescriptions): Refusal {
  const calls = [
    ...(m.table ? [`alter_table {"table": ${JSON.stringify(source)}, "description": "<what a row records>"}`] : []),
    ...m.columns.slice(0, 1).map((c) => `alter_column {"table": ${JSON.stringify(source)}, "column": ${JSON.stringify(c)}, "changes": {"description": "<what ${c} holds>"}}`),
  ];
  return {
    message: `descriptions are required: ${source} has none for ${missingList(m, "the table")}, and a clone would have none either`,
    guidance: guide(`Describe them on ${source} first (${calls.join(", then ")}${m.columns.length > 1 ? " for each column" : ""}), then clone it again. ${WHY}`, "descriptions"),
  };
}

/** define_base without descriptions: `columns` as given (for the shape). */
export function defineBaseRefusal(base: string, m: MissingDescriptions, columns: readonly object[]): Refusal {
  return {
    message: `descriptions are required: base ${base} has none for ${missingList(m, "the base")}`,
    guidance: guide(
      `Say what the tables of the base share in "description" and what each column holds in its own "description": {"name": ${JSON.stringify(base)}, "description": "<what tables with these columns share>"${columnsShape(m, columns)}}. ${WHY}`,
      "descriptions",
    ),
  };
}

/** alter_table or alter_column that would remove a description (`column` undefined: the table's). */
export function removedDescriptionRefusal(full: string, column?: string): Refusal {
  if (column === undefined) {
    return {
      message: `the description of ${full} cannot be removed (empty): every table needs one`,
      guidance: guide(`Pass the new text, as in {"table": ${JSON.stringify(full)}, "description": "<what a row records>"}, or leave "description" out to keep the one it has.`, "descriptions"),
    };
  }
  return {
    message: `the description of column ${column} of ${full} cannot be removed (null or empty): every column needs one`,
    guidance: guide(
      `Pass the new text, as in {"table": ${JSON.stringify(full)}, "column": ${JSON.stringify(column)}, "changes": {"description": "<what ${column} holds>"}}, or leave "description" out to keep the one it has.`,
      "descriptions",
    ),
  };
}
