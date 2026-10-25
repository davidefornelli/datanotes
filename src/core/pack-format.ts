/**
 * The text of a pack: one note that holds many rows of a table, one `##` section per row (packs of
 * rows, `options.pack` of a table). Pure: no I/O, no vault.
 *
 * ```markdown
 * ---
 * pack: family.babycare.milk_feed
 * key: 2026-10
 * description: "Rows of family.babycare.milk_feed for 2026-10. …"
 * ---
 *
 * ## 2026-10-23T142214
 * id:: 01a16ab7-39ff-7f46-ba93-410137993a66
 * started_at:: 2026-10-23T14:22:14+02:00
 *
 * The row's own text, with headings from ### down.
 * ```
 *
 * - The heading is the row's file name; the sections are in the order of their headings.
 * - A field is `key:: value`, the value YAML on one line, read and written by the front matter's
 *   own code (`parseYamlValue`, `flowYamlValue`): a row's values are the same in a pack and in a
 *   note of its own.
 * - The row's `table` property comes from the pack's `pack` when it is the row's first property
 *   and names the pack's table as written; otherwise it is a field like the others.
 * - The row's text starts after the first empty line; a section ends where the next one starts
 *   (the empty line before it is the pack's, not the row's).
 *
 * A row goes into a pack only as it would come back out byte for byte ({@link packable}): a note
 * whose text is what the engine writes from its values, with no `#` or `##` heading of its own.
 */

import { buildMarkdownWithFrontmatter, flowYamlValue, parseYamlValue, readOrderedFromMarkdown } from "./frontmatter";
import type { OrderedFrontmatter } from "./types";

/** What a pack's front matter says: the table of its rows and its key (`2026-10`). */
export interface PackMeta {
  table: string;
  key: string;
  description?: string;
}

/** A row of a pack: its heading (the row's file name), its front matter and its text. */
export interface PackRow {
  heading: string;
  /** The row's front matter, `table` included, in its order. */
  ordered: OrderedFrontmatter;
  /** The row's text after its front matter (a note's body). */
  body: string;
}

/** A section of a pack as read: the row, and where it is in the pack's text. */
export interface PackSection extends PackRow {
  /** The section's text in the pack, its heading line included (the empty line before the next section left out). */
  text: string;
  /** Offsets of {@link text} in the pack's text. */
  start: number;
  end: number;
  /** The line of its heading (1-based). */
  line: number;
}

export interface ParsedPack {
  meta: PackMeta;
  sections: PackSection[];
}

/** A pack's text that cannot be read as one: the line where it goes wrong. */
export class PackFormatError extends Error {
  override readonly name = "PackFormatError";
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
  }
}

/** The front matter key of a pack: it names the table of its rows. */
export const PACK_KEY = "pack";

/** A field's line: `key:: value`. */
const FIELD_RE = /^([^\s:#][^:\r\n]*?):: ?(.*)$/;

/** A heading of a row: `## name`. */
const HEADING_RE = /^## (.*)$/;

/** Whether front matter names a pack (`pack: <table>`). */
export function isPackFrontmatter(fm: Record<string, unknown> | undefined | null): boolean {
  return typeof fm?.[PACK_KEY] === "string" && (fm[PACK_KEY] as string).trim() !== "";
}

/** What a pack's front matter `description` says. */
export function packDescription(table: string, key: string): string {
  return `Rows of ${table} for ${key}. Each ## section is a row, its fields are key:: value. Read them with select_rows.`;
}

/** The lines of a text with their offsets; a line keeps no `\n` (a `\r` before it, it does). */
function linesOf(text: string, from: number): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let at = from;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl;
    out.push({ text: text.slice(at, end), start: at, end: nl < 0 ? end : end + 1 });
    at = nl < 0 ? text.length : nl + 1;
  }
  return out;
}

/** A line without the `\r` of a CRLF ending. */
const bare = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** Tracks fenced code blocks (``` or ~~~) line by line: a heading inside one is text. */
class Fences {
  private open: { char: string; len: number } | null = null;
  /** Feed a line; true when it is inside a code block (its fences included). */
  inCode(line: string): boolean {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(bare(line));
    if (this.open) {
      if (m && m[1]![0] === this.open.char && m[1]!.length >= this.open.len && m[2]!.trim() === "") this.open = null;
      return true;
    }
    if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) {
      this.open = { char: m[1]![0]!, len: m[1]!.length };
      return true;
    }
    return false;
  }
}

/** The number of the line at `offset` (1-based). */
function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * Read a pack: its front matter and its sections, each with the row's front matter (`table`
 * from `pack` unless a field gives it) and text. Throws a {@link PackFormatError} naming the line:
 * a section without `id`, a field whose YAML does not parse, two sections with one heading or one
 * id, text before the first section.
 */
export function parsePack(text: string, tableKey = "table", known?: (sectionText: string) => OrderedFrontmatter | undefined): ParsedPack {
  let fm: OrderedFrontmatter;
  let body: string;
  try {
    ({ ordered: fm, body } = readOrderedFromMarkdown(text));
  } catch (e) {
    throw new PackFormatError(`the front matter cannot be read: ${(e as Error).message}`, 1);
  }
  const meta = new Map(fm);
  const table = meta.get(PACK_KEY);
  if (typeof table !== "string" || table.trim() === "") throw new PackFormatError(`a pack names its table in "${PACK_KEY}"`, 1);
  const rawKey = meta.get("key");
  if (rawKey === undefined || rawKey === null || String(rawKey).trim() === "") throw new PackFormatError(`a pack has a "key" (the period of its rows, such as 2026-10)`, 1);
  const description = meta.get("description");
  const bodyStart = text.length - body.length;
  const lines = linesOf(text, bodyStart);
  // the line number of lines[i]: the front matter's lines, then i
  const before = lineAt(text, bodyStart) - 1;
  const lineOf = (i: number) => before + i + 1;
  // the headings of the rows, outside code blocks
  const fences = new Fences();
  const heads: number[] = [];
  lines.forEach((l, i) => {
    if (!fences.inCode(l.text) && HEADING_RE.test(bare(l.text))) heads.push(i);
  });
  const firstHead = heads[0] ?? lines.length;
  for (let i = 0; i < firstHead; i++) {
    if (bare(lines[i]!.text).trim() !== "") throw new PackFormatError("text before the first row: every row starts with a ## heading", lineOf(i));
  }
  const sections: PackSection[] = [];
  const headings = new Map<string, number>();
  const ids = new Map<string, number>();
  heads.forEach((h, n) => {
    const head = lines[h]!;
    const line = lineOf(h);
    const heading = HEADING_RE.exec(bare(head.text))![1]!.trim();
    if (heading === "") throw new PackFormatError("a row's heading is its file name: it cannot be empty", line);
    const seen = headings.get(heading);
    if (seen !== undefined) throw new PackFormatError(`two rows named "${heading}" (the other on line ${seen})`, line);
    headings.set(heading, line);
    const last = n === heads.length - 1;
    const start = head.start;
    // up to the next heading, less the empty line before it (the pack's)
    let end = last ? text.length : lines[heads[n + 1]!]!.start;
    if (!last && text[end - 1] === "\n") end--;
    const sectionText = text.slice(start, end);
    // a section read before (`known`, by its text): its values without parsing them again
    const fieldsEnd = sectionText.indexOf("\n\n");
    const cached = known?.(sectionText);
    if (cached && !sectionText.slice(0, fieldsEnd < 0 ? sectionText.length : fieldsEnd).includes("\r")) {
      const id = String(new Map(cached).get("id"));
      const twin = ids.get(id);
      if (twin !== undefined) throw new PackFormatError(`two rows with the id ${id} (the other on line ${twin})`, line);
      ids.set(id, line);
      sections.push({ heading, ordered: cached, body: fieldsEnd < 0 ? "" : sectionText.slice(fieldsEnd + 2), text: sectionText, start, end, line });
      return;
    }
    const ordered: [string, unknown][] = [];
    let at = head.end;
    for (let i = h + 1; i < (last ? lines.length : heads[n + 1]!); i++) {
      const l = lines[i]!;
      if (l.start >= end || bare(l.text) === "") break;
      const m = FIELD_RE.exec(bare(l.text));
      if (!m) throw new PackFormatError(`a field is "key:: value", and the row's text starts after an empty line: ${JSON.stringify(bare(l.text))}`, lineOf(i));
      const key = m[1]!.trim();
      if (ordered.some(([k]) => k === key)) throw new PackFormatError(`"${key}" twice in the row "${heading}"`, lineOf(i));
      let value: unknown;
      try {
        value = parseYamlValue(m[2]!);
      } catch (e) {
        throw new PackFormatError(`the value of "${key}" is not YAML: ${(e as Error).message}`, lineOf(i));
      }
      ordered.push([key, value]);
      at = Math.min(l.end, end);
    }
    if (!ordered.some(([k]) => k === "id")) throw new PackFormatError(`the row "${heading}" has no id`, line);
    // the row's text: after the empty line that ends its fields
    const rest = text.slice(at, end);
    const rowBody = rest === "" ? "" : rest.startsWith("\r\n") ? rest.slice(2) : rest.slice(1);
    if (!ordered.some(([k]) => k === tableKey)) ordered.unshift([tableKey, table]);
    const id = String(new Map(ordered).get("id"));
    const twin = ids.get(id);
    if (twin !== undefined) throw new PackFormatError(`two rows with the id ${id} (the other on line ${twin})`, line);
    ids.set(id, line);
    sections.push({ heading, ordered, body: rowBody, text: sectionText, start, end, line });
  });
  return { meta: { table, key: String(rawKey), ...(typeof description === "string" ? { description } : {}) }, sections };
}

/** The text of a row's section (no empty line after it). */
export function sectionText(row: PackRow, table: string, tableKey = "table"): string {
  const first = row.ordered[0];
  const fields = first && first[0] === tableKey && first[1] === table ? row.ordered.slice(1) : row.ordered;
  let out = `## ${row.heading}\n`;
  for (const [k, v] of fields) out += `${k}:: ${flowYamlValue(v)}\n`;
  return row.body === "" ? out : `${out}\n${row.body}`;
}

/**
 * A pack's text: its front matter (`pack`, `key`, `description`) and its rows' sections, in the
 * order of their headings, an empty line before each.
 */
export function writePack(meta: PackMeta, rows: readonly PackRow[], tableKey = "table"): string {
  const sorted = [...rows].sort((a, b) => (a.heading < b.heading ? -1 : a.heading > b.heading ? 1 : 0));
  const fm: [string, unknown][] = [
    [PACK_KEY, meta.table],
    ["key", meta.key],
    ["description", meta.description ?? packDescription(meta.table, meta.key)],
  ];
  // one line break before each section: an empty line after a row whose text ends with one, the
  // end of the line otherwise (parsePack takes exactly that one away)
  let body = "";
  for (const r of sorted) body += `\n${sectionText(r, meta.table, tableKey)}`;
  return buildMarkdownWithFrontmatter(fm, body);
}

/** A row's note, as the engine writes it from the row's values: what the row is outside a pack. */
export function rowNoteText(row: Pick<PackRow, "ordered" | "body">): string {
  return buildMarkdownWithFrontmatter(row.ordered, row.body);
}

/** Why a note stays a note of its own. */
export type NotPackable = { ok: false; reason: string };

/** Whether two parsed values are the same (as JSON: the values front matter gives). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The first `#` or `##` heading (ATX) of a text outside code blocks, or a setext one; null when there is none. */
function bigHeading(body: string): string | null {
  const fences = new Fences();
  let prev = "";
  for (const raw of body.split("\n")) {
    const line = bare(raw);
    if (fences.inCode(raw)) {
      prev = "";
      continue;
    }
    if (/^ {0,3}#{1,2}(\s|$)/.test(line)) return line;
    if (prev.trim() !== "" && /^ {0,3}(=+|-+)\s*$/.test(line) && !/^ {0,3}([-*+]\s|>)/.test(prev)) return `${prev} / ${line}`;
    prev = line;
  }
  return null;
}

/**
 * Whether a note can go into a pack and come back out byte for byte: `text` is the note, `heading`
 * its file name, `table` the pack's table. The reasons a note stays one of its own:
 * - its text is not what the engine writes from its values (another YAML style, comments);
 * - its text has a `#` or `##` heading outside code blocks (it would end the section);
 * - its name holds `%%`, `#`, `|`, `^`, `[` or `]`, or a key a field line cannot hold;
 * - a value does not come back the same from one line of YAML.
 * Whether the note is where its values put it is the caller's to check.
 */
export function packable(text: string, heading: string, table: string, tableKey = "table"): { ok: true; row: PackRow } | NotPackable {
  if (heading.includes("%%") || /[#|^[\]\r\n]/.test(heading) || heading.trim() !== heading || heading === "") return { ok: false, reason: `its name "${heading}" cannot be a heading` };
  let ordered: OrderedFrontmatter;
  let body: string;
  try {
    ({ ordered, body } = readOrderedFromMarkdown(text));
  } catch {
    return { ok: false, reason: "its front matter cannot be read" };
  }
  if (ordered.length === 0) return { ok: false, reason: "it has no front matter" };
  if (rowNoteText({ ordered, body }) !== text) return { ok: false, reason: "its text is not what the engine writes from its values (another YAML style, a comment)" };
  for (const [k] of ordered) {
    if (!FIELD_RE.test(`${k}:: x`) || k.trim() !== k || k.includes("::")) return { ok: false, reason: `its property "${k}" cannot be a field line` };
  }
  const h = bigHeading(body);
  if (h !== null) return { ok: false, reason: `its text has a # or ## heading: ${JSON.stringify(h)}` };
  const row: PackRow = { heading, ordered, body };
  // the row read back from its section as a pack holds it
  let back: PackSection | undefined;
  try {
    back = parsePack(writePack({ table, key: "x" }, [row], tableKey), tableKey).sections[0];
  } catch (e) {
    return { ok: false, reason: `it does not read back from a pack: ${(e as Error).message}` };
  }
  if (!back || back.body !== body || !sameValue(back.ordered, ordered)) return { ok: false, reason: "a value or its text does not read back the same from a pack" };
  return { ok: true, row };
}
