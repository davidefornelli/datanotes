/**
 * Pure value and row validation against a {@link TableDefinition} (phase 32).
 * Link resolution is injected so this module stays free of Obsidian I/O.
 */

import type {
  ColumnSpec,
  ScalarColumnType,
  TableDefinition,
  Violation,
} from "./types-table";
import type { OrderedFrontmatter } from "./types";
import { didYouMean } from "./hints";
import { tally, traceNow, tracingOn } from "./tracing";

export interface ValidationContext {
  /** Resolve a wikilink path (no brackets, alias or heading) to a vault path, or null. */
  resolveLink?: (linkpath: string) => string | null;
  /** Table owning the row at `path` (`catalog.schema.name`, `schema.name` or a bare name), or null. */
  tableOfPath?: (path: string) => string | null;
  /** Allowed values of a vocabulary table (the `name` of its rows), or null when unknown. */
  vocabulary?: (table: string) => ReadonlySet<string> | null;
  /**
   * Links are resolved with their `#heading` (see {@link wikilinkTarget}): the host keeps packs of
   * rows, where `[[pack#row]]` names a row.
   */
  linkSubpaths?: boolean;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const WIKILINK_RE = /^\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]$/;
const STEP_EPSILON = 1e-9;

export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  return Array.isArray(v) && v.length === 0;
}

/** Link path inside `[[path#heading|alias]]`, or null when `value` is not a wikilink string. */
export function parseWikilink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(WIKILINK_RE);
  return m ? m[1]!.trim() : null;
}

/**
 * The file names (lower case, no `.md`) of the packs of rows the hosts of this process keep, each
 * with how many packs have it: a link `[[pack#row]]` names the row, not the pack (pack-store.ts
 * keeps it up to date).
 */
const PACK_NAMES = new Map<string, number>();

/** A pack named `name` came (`+1`) or went (`-1`). */
export function countPackName(name: string, delta: 1 | -1): void {
  const key = name.toLowerCase();
  const n = (PACK_NAMES.get(key) ?? 0) + delta;
  if (n > 0) PACK_NAMES.set(key, n);
  else PACK_NAMES.delete(key);
}

/**
 * The name of the note a link value names (`[[People/Alice|A]]` → `Alice`): for a link into a pack
 * of rows (`[[milk_feed 2026-10#2026-10-23T142214]]`), the row's; null when it is not a link.
 */
export function linkNoteName(value: unknown): string | null {
  const lp = parseWikilink(value);
  if (lp == null) return null;
  const name = lp.split("/").pop()!.replace(/\.md$/i, "");
  if (PACK_NAMES.size === 0 || !PACK_NAMES.has(name.toLowerCase())) return name;
  const heading = ((value as string).trim().match(WIKILINK_RE)![2] ?? "").slice(1).split("#")[0]!.trim();
  return heading !== "" ? heading : name;
}

/**
 * What a host resolves for a wikilink string: its path, and with `subpath` (a host with packs of
 * rows, where `[[milk_feed 2026-10#2026-10-23T142214]]` names a row) its `#heading` too; null when
 * `value` is not a wikilink.
 */
export function wikilinkTarget(value: unknown, subpath: boolean): string | null {
  if (!subpath || typeof value !== "string") return parseWikilink(value);
  const m = value.trim().match(WIKILINK_RE);
  if (!m) return null;
  const heading = (m[2] ?? "").trim();
  return heading.length > 1 ? `${m[1]!.trim()}${heading}` : m[1]!.trim();
}

/** The link values' targets of a column value (a link or a list of links), as a host resolves them (see {@link wikilinkTarget}). */
export function wikilinkTargets(value: unknown, subpath: boolean): { path: string; lookup: string }[] {
  const list = Array.isArray(value) ? value : [value];
  const out: { path: string; lookup: string }[] = [];
  for (const v of list) {
    const path = parseWikilink(v);
    if (path != null) out.push({ path, lookup: wikilinkTarget(v, subpath)! });
  }
  return out;
}

export function isValidDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = value.match(DATE_RE);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  );
}

export function isValidDatetime(value: unknown): boolean {
  if (typeof value !== "string" || !DATETIME_RE.test(value)) return false;
  if (!isValidDate(value.slice(0, 10))) return false;
  return !Number.isNaN(Date.parse(value));
}

function violation(
  column: string,
  code: Violation["code"],
  message: string,
  value: unknown,
): Violation {
  return { column, code, message, value };
}

function validateScalar(
  column: string,
  type: ScalarColumnType,
  spec: ColumnSpec,
  value: unknown,
  ctx: ValidationContext,
): Violation[] {
  switch (type) {
    case "string": {
      if (typeof value !== "string") return [violation(column, "type", `expected a string`, value)];
      const allowed = spec.vocabulary && ctx.vocabulary ? ctx.vocabulary(spec.vocabulary) : null;
      if (allowed && !allowed.has(value)) {
        return [violation(column, "vocabulary", `"${value}" is not in ${spec.vocabulary} (add it there, or use one of: ${[...allowed].sort().slice(0, 30).join(", ")})`, value)];
      }
      return [];
    }
    case "boolean":
      return typeof value === "boolean"
        ? []
        : [violation(column, "type", `expected true or false`, value)];
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return [violation(column, "type", `expected a number`, value)];
      }
      if (type === "integer" && !Number.isInteger(value)) {
        return [violation(column, "type", `expected an integer`, value)];
      }
      const out: Violation[] = [];
      if (spec.min !== undefined && value < spec.min) {
        out.push(violation(column, "min", `must be >= ${spec.min}`, value));
      }
      if (spec.max !== undefined && value > spec.max) {
        out.push(violation(column, "max", `must be <= ${spec.max}`, value));
      }
      if (spec.step !== undefined) {
        const q = (value - (spec.min ?? 0)) / spec.step;
        if (Math.abs(q - Math.round(q)) > STEP_EPSILON) {
          out.push(violation(column, "step", `must be a multiple of ${spec.step}`, value));
        }
      }
      return out;
    }
    case "date":
      return isValidDate(value)
        ? []
        : [violation(column, "type", `expected a date YYYY-MM-DD`, value)];
    case "datetime":
      return isValidDatetime(value)
        ? []
        : [violation(column, "type", `expected an ISO datetime YYYY-MM-DDTHH:mm[:ss]`, value)];
    case "enum": {
      const allowed = spec.values ?? [];
      const ok =
        (typeof value === "string" || typeof value === "number") &&
        allowed.includes(String(value));
      return ok
        ? []
        : [violation(column, "enum", `must be one of: ${allowedValuesText(spec)}`, value)];
    }
    case "json":
      return [];
    case "link": {
      const linkpath = parseWikilink(value);
      if (linkpath == null) {
        return [violation(column, "type", `expected a wikilink "[[Note]]"`, value)];
      }
      // a generated link (link(…)) may point to a row not created yet, e.g. a day note
      if (!ctx.resolveLink || spec.generated !== undefined) return [];
      const dest = ctx.resolveLink(wikilinkTarget(value, ctx.linkSubpaths === true)!);
      if (dest == null) {
        return [violation(column, "broken_link", `link does not resolve: ${linkpath}`, value)];
      }
      if (spec.ref && ctx.tableOfPath) {
        const owner = ctx.tableOfPath(dest);
        // `ref` may be qualified (`metrics.mood`) or a bare table name (`mood`).
        // A full `catalog.schema.table` ref must match exactly; older short refs match a suffix.
        const full = spec.ref.split(".").length === 3;
        const matches = owner != null && (owner === spec.ref || (!full && owner.endsWith(`.${spec.ref}`)));
        if (!matches) {
          return [
            violation(column, "ref", `link must point to a row of table "${spec.ref}"`, value),
          ];
        }
      }
      return [];
    }
  }
}

/** Validate one non-empty value against its column. Empty values are handled by {@link validateRow}. */
export function validateValue(
  spec: ColumnSpec,
  value: unknown,
  ctx: ValidationContext = {},
): Violation[] {
  if (spec.type !== "list") {
    return validateScalar(spec.name, spec.type, spec, value, ctx);
  }
  if (!Array.isArray(value)) {
    return [violation(spec.name, "type", `expected a list`, value)];
  }
  const itemType = spec.items ?? "string";
  return value.flatMap((item, i) =>
    validateScalar(spec.name, itemType, spec, item, ctx).map((v) => ({ ...v, index: i })),
  );
}

export interface ValidateRowOptions {
  /** The row property naming its table (always allowed). */
  tableKey: string;
  /** Keys always allowed on rows besides columns and untyped fields. */
  extraAllowedKeys?: readonly string[];
  /** When false, keys unknown to the table are not reported. Default true. */
  reportUnknown?: boolean;
}

/**
 * Validate a full row (ordered frontmatter) against the table. Once per row: timed on the active
 * span (`datanotes.validate.rows`, `datanotes.validate.ms`), not a span each.
 */
export function validateRow(table: TableDefinition, row: OrderedFrontmatter, options: ValidateRowOptions, ctx: ValidationContext = {}): Violation[] {
  if (!tracingOn()) return validateRowImpl(table, row, options, ctx);
  const start = traceNow();
  try {
    return validateRowImpl(table, row, options, ctx);
  } finally {
    tally("datanotes.validate.rows", "datanotes.validate.ms", start);
  }
}

function validateRowImpl(
  table: TableDefinition,
  row: OrderedFrontmatter,
  options: ValidateRowOptions,
  ctx: ValidationContext = {},
): Violation[] {
  const values = new Map(row);
  const out: Violation[] = [];
  for (const col of table.columns) {
    const v = values.get(col.name);
    if (isEmptyValue(v)) {
      if (col.required) {
        out.push(violation(col.name, "required", requiredMessage(col), v));
      }
      continue;
    }
    out.push(...validateValue(col, v, ctx));
  }
  if (options.reportUnknown !== false) {
    const known = new Set<string>([
      ...table.columns.map((c) => c.name),
      ...table.untypedFields,
      options.tableKey,
      ...(options.extraAllowedKeys ?? []),
    ]);
    for (const [k, v] of row) {
      if (!known.has(k)) {
        out.push(violation(k, "unknown_column", `is not a column of table "${table.name}"${maybe(k, [...known])}`, v));
      }
    }
  }
  return out;
}

/** ` (did you mean "x"?)` when a known name is close to `name`, else "". */
function maybe(name: string, known: readonly string[]): string {
  const near = didYouMean(name, known);
  return near ? ` (${near.charAt(0).toLowerCase()}${near.slice(1)})` : "";
}

/**
 * An enum's allowed values for an error message: each with its meaning when the schema gives one
 * (`stated (the user said it); confirmed (…)`), so the caller can pick the right one.
 */
export function allowedValuesText(spec: Pick<ColumnSpec, "values" | "value_descriptions">): string {
  const vd = spec.value_descriptions ?? {};
  return (spec.values ?? []).map((v) => (vd[v] ? `${v} (${vd[v]})` : v)).join("; ");
}

/** "is required", plus the allowed values (and their meaning) for an enum column. */
export function requiredMessage(spec: Pick<ColumnSpec, "type" | "items" | "values" | "value_descriptions">): string {
  const isEnum = spec.type === "enum" || spec.items === "enum";
  return isEnum && spec.values?.length ? `is required: one of ${allowedValuesText(spec)}` : "is required";
}
