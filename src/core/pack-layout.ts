/**
 * Where the rows of a table go in packs (its `pack` option): the period of a row (its key, as the
 * template `{started_at:YYYY-MM}` gives it), when a period is closed, the file of each pack, and the
 * path a row has as a note of its own (its logical path, which a packed row keeps).
 */

import { catalogTables, parseMetastore } from "./metastore";
import { catalogLayout, parseTableOptions } from "./table-loader";
import { formatDateTokensOrNull } from "./datetime";
import { renderPathTemplate, sanitizeFileName } from "./path-templates";
import { isEmptyValue } from "./validate";
import { docsUrl, guide, didYouMean } from "./hints";
import { GuidedError } from "./hints";
import type { ColumnSpec } from "./types-table";

/** Days after the end of a period before its rows go into a pack (`pack_after_days`). */
export const DEFAULT_PACK_AFTER_DAYS = 7;

/** A row changed less than this long ago stays a note of its own (ms). */
export const PACK_QUIET_MS = 24 * 60 * 60 * 1000;

/** How long a period of a pack lasts: the finest date token of its format. */
export type PackPeriod = "year" | "month" | "day";

/** A table's `pack` option, read: its column, its format and the length of its periods. */
export interface PackTemplate {
  template: string;
  column: string;
  format: string;
  period: PackPeriod;
}

/** A `pack` option that is no template of a date column (the caller adds what it knows). */
export class PackOptionError extends GuidedError {
  override readonly name = "PackOptionError";
}

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_-]*)(?::([^}]*))?\}/g;

/** An example of a `pack` option on the column `col`. */
const example = (col: string) => `"{${col}:YYYY-MM}"`;

/**
 * Read a `pack` option: exactly one `{column:FORMAT}` placeholder, its column a date or
 * date-time column of the table, its format made of YYYY, MM and DD (a month needs a year, a day
 * a month) and `-`, `_`, `.`, spaces or `[literal]` text. Throws a {@link PackOptionError} with
 * the table's date columns and an example.
 */
export function readPackTemplate(template: unknown, columns: readonly Pick<ColumnSpec, "name" | "type">[]): PackTemplate {
  const dates = columns.filter((c) => c.type === "date" || c.type === "datetime").map((c) => c.name);
  const sample = example(dates[0] ?? "occurred_at");
  const choose = dates.length > 0 ? `The date columns of the table: ${dates.join(", ")}.` : "The table has no date or date-time column: add one first (add_column).";
  if (typeof template !== "string" || template.trim() === "") {
    throw new PackOptionError(`"pack" must be a template of a date column, such as ${sample}`, guide(`Pass pack as ${sample}: one date or date-time column and a date format. ${choose}`, "packOption"));
  }
  const t = template.trim();
  const holders = [...t.matchAll(PLACEHOLDER_RE)];
  if (holders.length !== 1) {
    throw new PackOptionError(
      `"pack" names ${holders.length === 0 ? "no column" : `${holders.length} columns`}: ${JSON.stringify(t)}; a pack takes the rows of one period of one date column`,
      guide(`Pass one placeholder, such as ${sample}. ${choose}`, "packOption"),
    );
  }
  const [, column, fmt] = holders[0]!;
  const col = columns.find((c) => c.name === column);
  if (!col) {
    const near = didYouMean(column!, dates.length > 0 ? dates : columns.map((c) => c.name));
    throw new PackOptionError(`"pack": the table has no column "${column}"`, guide(`${near ? `${near} ` : ""}${choose} For example: ${sample}.`, "packOption"));
  }
  if (col.type !== "date" && col.type !== "datetime") {
    throw new PackOptionError(`"pack": "${column}" is a ${col.type} column, not a date`, guide(`A pack holds the rows of a period: name a date or date-time column. ${choose} For example: ${sample}.`, "packOption"));
  }
  const format = (fmt ?? "").trim();
  const bare = format.replace(/\[[^\]]*\]/g, "");
  const tokens = bare.replace(/YYYY|MM|DD/g, "");
  if (format === "" || !bare.includes("YYYY") || /[^\-_. ]/.test(tokens) || (bare.includes("DD") && !bare.includes("MM")) || /[/\\]/.test(format)) {
    throw new PackOptionError(
      `"pack": ${JSON.stringify(format)} is no date format of a period (YYYY, YYYY-MM or YYYY-MM-DD)`,
      guide(`Give the column a format made of YYYY, MM and DD, such as ${example(col.name)} (a pack per month) or "{${col.name}:YYYY}" (per year).`, "packOption"),
    );
  }
  if (t.replace(PLACEHOLDER_RE, "").match(/[/\\]/)) {
    throw new PackOptionError(`"pack": the template cannot hold a folder ("/")`, guide(`A pack's key names one file of the table's folder: pass ${example(col.name)}.`, "packOption"));
  }
  return { template: t, column: col.name, format, period: bare.includes("DD") ? "day" : bare.includes("MM") ? "month" : "year" };
}

/** How fine a period is: a day folder or pack is finer than a month's, a month's than a year's. */
const FINENESS: Record<PackPeriod | "none", number> = { none: 0, year: 1, month: 2, day: 3 };

/** The finest date token of a format (`YYYY/MM` → month); none without YYYY. */
function periodOfFormat(format: string): PackPeriod | "none" {
  const bare = format.replace(/\[[^\]]*\]/g, "");
  return bare.includes("DD") ? "day" : bare.includes("MM") ? "month" : bare.includes("YYYY") ? "year" : "none";
}

/** A warning of a table's layout: what it is, how to fix it, where to read more. */
export interface LayoutWarning {
  code: "pack_partition";
  table: string;
  message: string;
  hint: string;
  docs: string;
}

/**
 * The warning of a table whose rows' folders (its `partition`) are wider than the periods of its
 * packs: the folder of the open rows grows all period long and `pack_rows` empties it, so git
 * keeps a new version of that folder at every write, and its repository grows several times
 * faster. Null when the partition splits the rows by the pack's column at least as finely as the
 * pack, or the table has no pack.
 */
export function packPartitionWarning(table: string, partition: string | undefined, pack: string | undefined): LayoutWarning | null {
  if (!pack) return null;
  const t = looseTemplate(pack);
  if (!t) return null;
  let finest: PackPeriod | "none" = "none";
  for (const [, col, fmt] of (partition ?? "").matchAll(PLACEHOLDER_RE)) {
    if (col !== t.column || fmt === undefined) continue;
    const p = periodOfFormat(fmt);
    if (FINENESS[p] > FINENESS[finest]) finest = p;
  }
  if (FINENESS[finest] >= FINENESS[t.period]) return null;
  const suggested = `{${t.column}:${t.period === "day" ? "YYYY/MM/DD" : t.period === "month" ? "YYYY/MM" : "YYYY"}}`;
  return {
    code: "pack_partition",
    table,
    message: `${table}: its rows' folders (partition ${partition ? JSON.stringify(partition) : "none"}) are wider than the periods of its packs (${JSON.stringify(pack)}): pack_rows empties a folder that keeps growing, and a git repository of the vault grows several times faster`,
    hint: `Give the table a partition as fine as its packs, such as alter_table {"table": "${table}", "partition": "${suggested}"}, while no row is in a pack (unpack_rows first).`,
    docs: docsUrl("packPartition"),
  };
}

/** Read `pack_after_days`: a whole number of days, 0 or more. */
export function readPackAfterDays(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new PackOptionError(
      `"pack_after_days" must be a whole number of days, 0 or more, not ${JSON.stringify(v)}`,
      guide(`Pass how many days after the end of a period its rows go into a pack, such as 7 (the default) or 0 (as soon as it ends).`, "packOption"),
    );
  }
  return v;
}

/** The key of a row (its period, as the template writes it); null when the row has no date there. */
export function packKeyOf(t: PackTemplate, values: ReadonlyMap<string, unknown>): string | null {
  const v = values.get(t.column);
  if (isEmptyValue(v) || typeof v !== "string") return null;
  const key = t.template.replace(PLACEHOLDER_RE, () => formatDateTokensOrNull(v, t.format) ?? "\0");
  return key.includes("\0") ? null : key;
}

/** The first day after the period of the date `date` (`YYYY-MM-DD`). */
export function periodEnd(date: string, period: PackPeriod): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
  const next = period === "year" ? Date.UTC(y + 1, 0, 1) : period === "month" ? Date.UTC(y, m, 1) : Date.UTC(y, m - 1, d + 1);
  return new Date(next).toISOString().slice(0, 10);
}

/** Whether the period of a row dated `value` is closed `afterDays` days before `today` (`YYYY-MM-DD`). */
export function periodClosed(value: string, period: PackPeriod, afterDays: number, today: string): boolean {
  const end = periodEnd(value, period);
  const [y, m, d] = end.split("-").map(Number) as [number, number, number];
  const due = new Date(Date.UTC(y, m - 1, d + afterDays)).toISOString().slice(0, 10);
  return today >= due;
}

/** The file of the pack of `key`: `<table folder>/<table> <key>.md`. */
export function packFilePath(tableFolder: string, table: string, key: string): string {
  return `${tableFolder}/${sanitizeFileName(`${table} ${key}`)}.md`;
}

/** Whether a vault path is named as a pack of the table whose folder holds it (`milk_feed/milk_feed 2026-10.md`). */
export function namedAsPack(path: string): boolean {
  const parts = path.split("/");
  if (parts.length < 2 || !/\.md$/i.test(path)) return false;
  return parts[parts.length - 1]!.startsWith(`${parts[parts.length - 2]} `);
}

/** Where the rows of a table go as notes of their own: the folder pattern (with its partition) and the file-name pattern. */
export interface RowLayout {
  rowPath: string;
  filename: string;
}

/** The path of a row as a note of its own: its folder and file name from its values (`.md` added). */
export function rowPathOf(layout: RowLayout, values: ReadonlyMap<string, unknown>): string {
  return `${renderPathTemplate(layout.rowPath, values)}/${renderPathTemplate(layout.filename, values)}.md`;
}

/**
 * A `pack` template read without the table's columns (the host has no schema, and the engine
 * checked it when it was set): its one `{column:FORMAT}`; null when it has none.
 */
export function looseTemplate(template: string): PackTemplate | null {
  const m = /\{([A-Za-z][A-Za-z0-9_-]*):([^}]+)\}/.exec(template);
  if (!m) return null;
  const bare = m[2]!.replace(/\[[^\]]*\]/g, "");
  return { template, column: m[1]!, format: m[2]!, period: bare.includes("DD") ? "day" : bare.includes("MM") ? "month" : "year" };
}

/** A table as the packs of its rows need it: where its rows go, and its `pack` template. */
export interface PackedTable {
  layout: RowLayout | null;
  template: PackTemplate | null;
}

/**
 * The tables of the database whose metastore is `metastoreText` and whose folder is `root`, by
 * full name: where their rows go (null without a file-name pattern) and their `pack` template.
 * Empty when the metastore cannot be read.
 */
export function packedTablesIn(metastoreText: string, root: string): Map<string, PackedTable> {
  const out = new Map<string, PackedTable>();
  let model;
  try {
    model = parseMetastore(metastoreText);
  } catch {
    return out;
  }
  for (const { ref, entry } of catalogTables(model)) {
    const props = entry.options ?? {};
    let layout: RowLayout | null = null;
    try {
      const options = parseTableOptions([{ name: ref.table, ...(typeof props.partition === "string" ? { partition: props.partition } : {}), ...(typeof props.filename === "string" ? { filename: props.filename } : {}) }]);
      if (options.filename) layout = { rowPath: catalogLayout(root, ref, options).rowPath, filename: options.filename };
    } catch {
      layout = null;
    }
    out.set(ref.full, { layout, template: typeof props.pack === "string" ? looseTemplate(props.pack) : null });
  }
  return out;
}

/**
 * The database folder of a pack of `table` (`catalog.schema.table`) at `packPath`, when the pack is
 * in its table's folder (`<root>/<catalog>/<schema>/<table>/<file>`); null when it is elsewhere.
 */
export function databaseRootOfPack(packPath: string, table: string): string | null {
  const parts = table.split(".");
  if (parts.length !== 3) return null;
  const segs = packPath.split("/");
  if (segs.length < 4) return null;
  const folder = segs.slice(-4, -1);
  if (folder.join("/") !== parts.join("/")) return null;
  return segs.slice(0, -4).join("/");
}
