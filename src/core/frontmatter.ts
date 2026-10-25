/**
 * Frontmatter I/O for row notes.
 *
 * Reading uses `yaml` parseDocument; writing goes through `processFrontMatter` (Obsidian, or the
 * headless host).
 *
 * **Preserves**
 * - Key order end to end (`YAMLMap#items` when reading, `sortMapEntries: false` when writing).
 * - Scalars (string, number, boolean, null), lists and nested mappings (e.g. TaskNotes
 *   `reminders`) as plain JavaScript values.
 *
 * **May normalise on write** (treat as equivalent values, not byte-identical text)
 * - Quoting style and flow vs block collection styles can change.
 * - Inline comments inside the YAML block are typically **dropped** after a write cycle.
 * - Blank lines inside YAML may collapse.
 *
 * @module frontmatter
 */

import type { App, TFile } from "./host";
import {
  isScalar,
  parseDocument,
  stringify,
  YAMLMap,
  YAMLSeq,
  type Node,
} from "yaml";
import type { OrderedFrontmatter, OrderedFrontmatterEntry } from "./types";
import { messageOf } from "./message";
import { intern } from "./intern";

/**
 * A `---` line, the YAML, a `---` line. The first alternative is the empty block (`---` right after
 * `---`), which is what writing the last property away leaves, as in Obsidian.
 */
const FRONTMATTER_BLOCK =
  /^---\r?\n(?:---|([\s\S]*?)\r?\n---)(?:\r?\n([\s\S]*))?$/;

/**
 * Split a note into YAML frontmatter text (without delimiters) and body markdown.
 * Returns `null` if the file does not start with a `---` frontmatter block.
 *
 * An empty block (`---` followed at once by `---`) is empty frontmatter, as Obsidian reads it:
 * removing the last property writes one, and it must not be read back as part of the body (each
 * later write would add another block above it).
 */
export function splitFrontmatter(
  markdown: string,
): { yamlText: string; body: string } | null {
  const m = markdown.match(FRONTMATTER_BLOCK);
  if (!m) return null;
  return { yamlText: m[1] ?? "", body: m[2] ?? "" };
}

/**
 * Unquoted `[[...]]` in YAML is parsed as **nested flow sequences**, not a string, e.g.
 * `table: [[Folder/x|y]]` → `["x|y"]` wrapped in two array levels. Obsidian wikilinks
 * must be written as a **string** (often double-quoted in YAML). For the keys a caller names,
 * detect that pattern and recover the wikilink string so a write does not turn it into
 * `table:\n  - - ...`.
 */
export function coerceMisparsedYamlWikilinkToString(value: unknown): unknown {
  let cur: unknown = value;
  const steps: unknown[] = [];
  while (Array.isArray(cur) && cur.length === 1) {
    steps.push(cur);
    cur = cur[0] as unknown;
  }
  if (typeof cur !== "string") {
    return value;
  }
  if (steps.length < 2) {
    return value;
  }
  return `[[${cur}]]`;
}

/**
 * A string that holds its own characters. V8 keeps a piece of 13 characters or more cut from a
 * text as a view of the whole text: a front matter value, a tag or a link path kept for long would
 * keep its note's whole text in memory, long after the engine stopped needing the text. And, up to
 * INTERN.maxLength, the one copy V8 keeps of that text (intern.ts): the same key or value in many
 * notes is one string.
 */
export function detached(s: string): string {
  return intern(s.length < 13 ? s : (JSON.parse(JSON.stringify(s)) as string));
}

/** A key of a YAML mapping as a string of its own (see {@link detached}). */
function keyOf(kn: unknown): string {
  return detached(isScalar(kn) ? String(kn.value) : String(kn));
}

function yamlNodeToPlain(node: Node | null, keyPath: string): unknown {
  if (node == null) return null;
  if (isScalar(node)) return typeof node.value === "string" ? detached(node.value) : node.value;
  if (node instanceof YAMLMap) {
    const out: Record<string, unknown> = {};
    for (const pair of node.items) {
      const k = keyOf(pair.key);
      out[k] = yamlNodeToPlain(pair.value as Node | null, `${keyPath}.${k}`);
    }
    return out;
  }
  if (node instanceof YAMLSeq) {
    return node.items.map((item, i) =>
      yamlNodeToPlain(item as Node | null, `${keyPath}[${i}]`),
    );
  }
  throw new Error(`unsupported YAML value at front matter key ${keyPath}`);
}

/**
 * Parse a YAML frontmatter block (content between the `---` delimiters) into ordered entries:
 * nested maps and sequences become plain JS objects and arrays.
 */
export function parseYamlBlockToOrdered(
  yamlText: string,
  /** If the YAML key name matches, {@link coerceMisparsedYamlWikilinkToString} runs on the value. */
  wikilinkStringKeys: ReadonlySet<string> = new Set<string>(),
): OrderedFrontmatter {
  if (yamlText.trim() === "") return [];

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]!.message);
  }

  const root = doc.contents;
  if (root == null) return [];

  if (!(root instanceof YAMLMap)) {
    throw new Error("the front matter must be a YAML mapping of keys and values");
  }

  const entries: OrderedFrontmatterEntry[] = [];
  for (const pair of root.items) {
    const key = keyOf(pair.key);
    let value: unknown = yamlNodeToPlain(pair.value, key);
    if (wikilinkStringKeys.has(key)) {
      value = coerceMisparsedYamlWikilinkToString(value);
    }
    entries.push([key, value]);
  }

  return entries;
}

/**
 * Read ordered frontmatter + body from full markdown.
 * If there is no `---` block, returns `{ ordered: [], body: markdown }`.
 */
export function readOrderedFromMarkdown(
  markdown: string,
  wikilinkStringKeys: ReadonlySet<string> = new Set<string>(),
): {
  ordered: OrderedFrontmatter;
  body: string;
} {
  const split = splitFrontmatter(markdown);
  if (!split) {
    return { ordered: [], body: markdown };
  }
  return {
    ordered: parseYamlBlockToOrdered(split.yamlText, wikilinkStringKeys),
    body: split.body,
  };
}

/**
 * One YAML value (the text after `key:` on one line), as the front matter reads it: the same
 * plain JavaScript values, the same strings. Throws on YAML that does not parse.
 */
export function parseYamlValue(text: string): unknown {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(doc.errors[0]!.message);
  return yamlNodeToPlain(doc.contents as Node | null, "value");
}

/**
 * A value as YAML on one line (flow style: `[a, b]`, `{k: v}`, a string quoted only when it must
 * be); JSON, which YAML reads too, when the YAML would take more than one line (a list holding
 * a text with line breaks). {@link parseYamlValue} reads it back.
 */
export function flowYamlValue(value: unknown): string {
  const text = stringify(value, { lineWidth: 0, collectionStyle: "flow", blockQuote: false, flowCollectionPadding: false }).replace(/\n$/, "");
  // a line break of another kind (U+0085, U+2028, U+2029) would end the line too: escaped in JSON
  if (!/[\n\r\u0085\u2028\u2029]/.test(text)) return text;
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function stringifyYamlOrdered(ordered: OrderedFrontmatter): string {
  const obj = Object.fromEntries(ordered) as Record<string, unknown>;
  return stringify(obj, {
    sortMapEntries: false,
    lineWidth: 0,
  });
}

/**
 * Rebuild a full markdown file from ordered frontmatter and body (used in tests and for deterministic previews).
 */
export function buildMarkdownWithFrontmatter(
  ordered: OrderedFrontmatter,
  body: string,
): string {
  const yamlPart =
    ordered.length === 0 ? "" : `${stringifyYamlOrdered(ordered).replace(/\s+$/, "")}\n`;
  return `---\n${yamlPart}---\n${body}`;
}

/**
 * Replace `fm` with the keys/values from `ordered`, preserving insertion order for Obsidian serialization.
 */
export function applyOrderedFrontmatter(
  currentFm: Record<string, unknown>,
  ordered: OrderedFrontmatter,
): void {
  for (const key of Object.keys(currentFm)) {
    delete currentFm[key];
  }
  for (const [key, value] of ordered) {
    currentFm[key] = value;
  }
}

// --- Immutable OrderedFrontmatter helpers (pure) ---

export function fmGet(
  ordered: OrderedFrontmatter,
  key: string,
): unknown {
  const found = ordered.find(([k]) => k === key);
  return found?.[1];
}

export function fmSet(
  ordered: OrderedFrontmatter,
  key: string,
  value: unknown,
): OrderedFrontmatter {
  const idx = ordered.findIndex(([k]) => k === key);
  const copy = ordered.map(
    (e) => [e[0], e[1]] as [string, unknown],
  );
  if (idx >= 0) {
    copy[idx] = [key, value];
    return copy;
  }
  copy.push([key, value]);
  return copy;
}

export function fmDelete(
  ordered: OrderedFrontmatter,
  key: string,
): OrderedFrontmatter {
  return ordered.filter(([k]) => k !== key);
}

export function fmRename(
  ordered: OrderedFrontmatter,
  from: string,
  to: string,
): OrderedFrontmatter {
  if (from === to) return ordered;
  return ordered.map(([k, v]) => (k === from ? [to, v] : [k, v])) as [
    string,
    unknown,
  ][];
}

export function fmAdd(
  ordered: OrderedFrontmatter,
  key: string,
  value: unknown,
  atIndex?: number,
): OrderedFrontmatter {
  if (ordered.some(([k]) => k === key)) {
    return fmSet(ordered, key, value);
  }
  const entry: OrderedFrontmatterEntry = [key, value];
  if (atIndex === undefined || atIndex >= ordered.length) {
    return [...ordered, entry];
  }
  const copy: [string, unknown][] = ordered.map((e) => [e[0], e[1]]);
  copy.splice(atIndex, 0, [key, value]);
  return copy;
}

export function fmReorder(
  ordered: OrderedFrontmatter,
  keysInOrder: readonly string[],
): OrderedFrontmatter {
  const map = new Map<string, unknown>(ordered.map(([k, v]) => [k, v]));
  const seen = new Set<string>();
  const out: [string, unknown][] = [];
  for (const k of keysInOrder) {
    if (!map.has(k)) continue;
    out.push([k, map.get(k) as unknown]);
    seen.add(k);
  }
  for (const [k, v] of ordered) {
    if (!seen.has(k)) out.push([k, v]);
  }
  return out;
}

/**
 * Read a note's frontmatter from the raw file content (so key order matches the file).
 * On failure, throws with the vault path so errors name the offending note.
 */
export async function readOrderedFrontmatter(
  app: App,
  file: TFile,
  wikilinkStringKeys: ReadonlySet<string> = new Set<string>(),
): Promise<OrderedFrontmatter> {
  try {
    const text = await app.vault.read(file);
    const { ordered } = readOrderedFromMarkdown(text, wikilinkStringKeys);
    return ordered;
  } catch (e) {
    const inner = messageOf(e);
    throw new Error(`cannot read the front matter of ${file.path}: ${inner}`);
  }
}

/**
 * Mutate a note's frontmatter via `processFrontMatter` (the host serializes the YAML); the
 * current values are read with {@link readOrderedFromMarkdown}, so nested values
 * round-trip.
 */
export async function writeFrontmatter(
  app: App,
  file: TFile,
  mutator: (fm: OrderedFrontmatter) => OrderedFrontmatter,
  wikilinkStringKeys: ReadonlySet<string> = new Set<string>(),
): Promise<void> {
  const text = await app.vault.read(file);
  const { ordered: before } = readOrderedFromMarkdown(text, wikilinkStringKeys);
  const after = mutator(before);
  await app.fileManager.processFrontMatter(file, (fm) => {
    applyOrderedFrontmatter(fm as Record<string, unknown>, after);
  });
}
