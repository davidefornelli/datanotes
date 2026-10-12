/**
 * Path templates of rows: `{column}` / `{column:FORMAT}` placeholders in a table's filename and
 * partition patterns and in `row_template`, and the name of a row (its file name).
 */

import { OperationInputError } from "./engine";
import { isEmptyValue, parseWikilink } from "./validate";
import { formatDateTokensOrNull } from "./datetime";

// --- Path templates ---

/** Format an ISO date/datetime string with YYYY MM DD HH mm ss and [literal] tokens, no time-zone shift. */
export function formatDateTokens(value: string, format: string): string {
  const out = formatDateTokensOrNull(value, format);
  if (out === null) throw new OperationInputError(`cannot format "${value}" as a date`);
  return out;
}

function scalarForPath(value: unknown): string {
  const link = parseWikilink(value);
  if (link != null) return link.split("/").pop()!;
  return String(value);
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Render `{column}` / `{column:FORMAT}` placeholders from row values.
 * Folder patterns keep `/` from formats; each placeholder value is sanitized.
 */
export function renderPathTemplate(template: string, values: ReadonlyMap<string, unknown>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_-]*)(?::([^}]+))?\}/g, (_m, col: string, fmt?: string) => {
    const v = values.get(col);
    if (isEmptyValue(v)) throw new OperationInputError(`path placeholder {${col}} has no value`);
    if (fmt !== undefined) {
      return formatDateTokens(String(v), fmt)
        .split("/")
        .map(sanitizeFileName)
        .join("/");
    }
    return sanitizeFileName(scalarForPath(v));
  });
}

/**
 * Fill `{column}` / `{column:FORMAT}` in a row template with the row's values (e.g. a daily note's
 * `{date}` in its body). Placeholders that are not a column with a value stay as they
 * are, so view tokens like `{today}` keep working.
 */
export function renderRowTemplate(template: string, values: ReadonlyMap<string, unknown>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_-]*)(?::([^}]+))?\}/g, (m, col: string, fmt?: string) => {
    const v = values.get(col);
    if (isEmptyValue(v)) return m;
    return fmt !== undefined ? formatDateTokens(String(v), fmt) : scalarForPath(v);
  });
}

/** Highest `-N` suffix tried when a computed row filename is taken. */
export const MAX_NAME_SUFFIX = 99;

/**
 * The path for a row named `base` (a vault path without `.md`): `base.md`, else the first of
 * `base-2.md` … `base-99.md` that `isTaken` does not claim; the last one tried when all are taken
 * (callers report that as a conflict).
 */
export function claimFreeName(base: string, isTaken: (path: string) => boolean): string {
  let path = `${base}.md`;
  for (let n = 2; isTaken(path) && n <= MAX_NAME_SUFFIX; n++) path = `${base}-${n}.md`;
  return path;
}

/** The name of the row at `path`: its file name without `.md`. */
export function basenameOf(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/i, ""); // split() returns at least one element
}
