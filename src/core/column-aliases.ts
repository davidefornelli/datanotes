/**
 * A column's `aliases` stand for the column wherever a read or a write names a column: `name` on a
 * task whose `title` declares the alias `name` reads and writes `title`. Matching is exact, as for
 * column names. A real name always wins: an alias equal to a name the table knows (a column, an
 * untyped field, `path`, a file column) never redirects. An alias two columns declare is ambiguous
 * and maps to neither: naming it is refused, with the columns that declare it. Answers keep the
 * real names.
 */

import { OperationInputError, type LoadedTable } from "./engine";
import { guide } from "./hints";
import type { ColumnSpec } from "./types-table";

export interface ColumnAliases {
  /**
   * The column a name means: the name itself when the table knows it, the column that declares it
   * as an alias, or else the name unchanged (the caller's own check refuses an unknown one).
   * Throws an OperationInputError for an alias several columns declare.
   */
  resolve(name: string): string;
  /** Other words for the columns (aliases and labels), word → column, for "did you mean". */
  words: readonly (readonly [string, string])[];
}

/** The aliases of a table's columns; `known` are the names that always mean themselves. */
export function columnAliases(columns: readonly ColumnSpec[], known: ReadonlySet<string>, table: string): ColumnAliases {
  const owners = new Map<string, string[]>();
  const words: [string, string][] = [];
  for (const c of columns) {
    for (const a of c.aliases) {
      words.push([a, c.name]);
      if (known.has(a)) continue;
      const list = owners.get(a);
      if (!list) owners.set(a, [c.name]);
      else if (!list.includes(c.name)) list.push(c.name);
    }
    if (c.label) words.push([c.label, c.name]);
  }
  return {
    words,
    resolve(name) {
      if (known.has(name)) return name;
      const list = owners.get(name);
      if (!list) return name;
      if (list.length === 1) return list[0]!;
      const names = list.map((n) => `"${n}"`);
      throw new OperationInputError(
        `"${name}" is an alias of several columns of ${table}: ${names.join(", ")}`,
        guide(`Name the column itself: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}. alter_column changes a column's aliases; describe_table("${table}") lists them.`, "columnAliases"),
      );
    },
  };
}

/** {@link columnAliases} of a loaded table. */
export function tableAliases(t: LoadedTable, known: ReadonlySet<string>): ColumnAliases {
  return columnAliases(t.def.columns, known, t.catalog.ref.full);
}

/**
 * `values` with every alias replaced by its column; refused when two keys name the same column
 * (`{title, name}` where `name` is an alias of `title`): which value to keep is not the engine's
 * guess. `what` names the argument in the message (`values`, `set`).
 */
export function resolveValueKeys(values: Record<string, unknown>, aliases: ColumnAliases, what: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const given = new Map<string, string>();
  for (const [k, v] of Object.entries(values)) {
    const col = aliases.resolve(k);
    const before = given.get(col);
    if (before !== undefined) {
      throw new OperationInputError(
        `${what} names column "${col}" twice: as "${before}" and as "${k}"`,
        guide(`"${before}" and "${k}" both mean the column "${col}" (an alias stands for its column): keep one of the two keys.`, "columnAliases"),
      );
    }
    given.set(col, k);
    out[col] = v;
  }
  return out;
}

/** Column names with every alias replaced by its column, each once. */
export function resolveNameList(names: readonly string[], aliases: ColumnAliases): string[] {
  return [...new Set(names.map((n) => aliases.resolve(n)))];
}
