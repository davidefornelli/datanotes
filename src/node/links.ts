/**
 * Links in Markdown notes, the way Obsidian reads, resolves and writes them:
 *
 * - kinds: wikilinks `[[target#sub|alias]]`, embeds `![[…]]`, Markdown links `[text](target.md#sub)`
 *   (also embeds `![](…)`), and wikilinks written as frontmatter values (`"[[target]]"`);
 * - resolution of a link path from a note: path relative to the note's folder, path from the
 *   vault root, then by file name (case-insensitive), preferring the note's folder, then the
 *   shortest path;
 * - the link text for a file in the vault's format (`shortest` / `relative` / `absolute`);
 * - rewriting every link that points to renamed files.
 *
 * Code blocks and inline code are skipped, like Obsidian does.
 */

export type LinkFormat = "shortest" | "relative" | "absolute";

export interface LinkRef {
  kind: "wiki" | "embed" | "md" | "mdembed" | "frontmatter";
  /** Offsets of the whole link in the note's text. */
  start: number;
  end: number;
  /** Target as written (URL-decoded for Markdown links), without `#subpath`. */
  linkpath: string;
  /** `#heading`, `#^block` or "" */
  subpath: string;
  /** Display text (`|alias` or `[text]`), if any. */
  alias?: string;
  /** Frontmatter key holding the link. */
  key?: string;
}

/** Minimal view of the vault the resolver needs. */
export interface FileIndex {
  /** Every file path (vault-relative, forward slashes). */
  paths(): Iterable<string>;
}

/**
 * A `---` line, the YAML, a `---` line. The first alternative is the empty block (`---` right after
 * `---`), as in `splitFrontmatter`: without it, the YAML would run on to a later `---` line of the body.
 */
const FRONTMATTER_RE = /^---\r?\n(?:---|([\s\S]*?)\r?\n---)[ \t]*(?:\r?\n|$)/;

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stripMd(path: string): string {
  return path.replace(/\.md$/i, "");
}

/** Normalize `a/./b/../c` and leading slashes. `null` when it climbs above the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** Ranges of fenced code blocks and inline code spans (links inside are not links). */
function codeRanges(text: string, from: number): [number, number][] {
  const out: [number, number][] = [];
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1\2[ \t]*$|(?![\s\S]))/gm;
  fence.lastIndex = from;
  for (let m = fence.exec(text); m; m = fence.exec(text)) out.push([m.index, m.index + m[0].length]);
  const inline = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
  inline.lastIndex = from;
  for (let m = inline.exec(text); m; m = inline.exec(text)) {
    if (!out.some(([a, b]) => m!.index >= a && m!.index < b)) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function splitSubpath(target: string): { linkpath: string; subpath: string } {
  const i = target.indexOf("#");
  return i < 0 ? { linkpath: target, subpath: "" } : { linkpath: target.slice(0, i), subpath: target.slice(i) };
}

function decode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/**
 * Obsidian counts a frontmatter link only when it is a whole value: `key: "[[x]]"`, a list item
 * `- "[[x]]"` or an element of a flow list `["[[x]]", "[[y]]"]` — not a link inside a sentence.
 */
function wholeValue(line: string, start: number, end: number): boolean {
  let i = start - 1;
  while (i >= 0 && /["'\s]/.test(line[i]!)) i--;
  let j = end;
  while (j < line.length && /["'\s]/.test(line[j]!)) j++;
  const before = i < 0 ? "" : line[i]!;
  const after = j >= line.length ? "" : line[j]!;
  const head = line.slice(0, i + 1);
  const opensValue = before === ":" || (before === "-" && /^\s*-$/.test(head)) || before === "[" || before === ",";
  const closesValue = after === "" || after === "]" || after === "," || after === "#";
  return opensValue && closesValue;
}

/** Every link of a note: frontmatter values first, then the body. */
export function parseLinks(text: string): LinkRef[] {
  const out: LinkRef[] = [];
  let bodyStart = 0;
  const fm = FRONTMATTER_RE.exec(text);
  if (fm) {
    bodyStart = fm[0].length;
    const block = fm[1] ?? "";
    const base = text.indexOf(block);
    let key: string | undefined;
    let offset = 0;
    for (const line of block.split("\n")) {
      const k = /^([^\s#:][^:]*):/.exec(line);
      if (k) key = k[1]!.trim();
      const re = /\[\[([^\]\n]+?)\]\]/g;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        if (!wholeValue(line, m.index, m.index + m[0].length)) continue; // a link inside text is not a property link
        const [target, alias] = m[1]!.split("|");
        const { linkpath, subpath } = splitSubpath(target!.trim());
        out.push({ kind: "frontmatter", start: base + offset + m.index, end: base + offset + m.index + m[0].length, linkpath, subpath, ...(alias !== undefined ? { alias } : {}), ...(key ? { key } : {}) });
      }
      offset += line.length + 1;
    }
  }
  const code = codeRanges(text, bodyStart);
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  const wiki = /(!?)\[\[([^\]\n]+?)\]\]/g;
  wiki.lastIndex = bodyStart;
  for (let m = wiki.exec(text); m; m = wiki.exec(text)) {
    if (inCode(m.index)) continue;
    let inner = m[2]!;
    // In a table row an unescaped "|" ends the cell, so such a link is not a link; "\|" is the alias bar.
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    if (/^\s*\|/.test(text.slice(lineStart, m.index + 1))) {
      if (/(^|[^\\])\|/.test(inner)) continue;
      inner = inner.replace(/\\\|/g, "|");
    }
    const bar = inner.indexOf("|");
    const target = bar < 0 ? inner : inner.slice(0, bar);
    const { linkpath, subpath } = splitSubpath(target.trim());
    out.push({ kind: m[1] ? "embed" : "wiki", start: m.index, end: m.index + m[0].length, linkpath, subpath, ...(bar >= 0 ? { alias: inner.slice(bar + 1) } : {}) });
  }
  const md = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  md.lastIndex = bodyStart;
  for (let m = md.exec(text); m; m = md.exec(text)) {
    if (inCode(m.index)) continue;
    let target = m[3]!;
    if (target.startsWith("<")) target = target.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, obsidian:, …
    const { linkpath, subpath } = splitSubpath(decode(target));
    out.push({ kind: m[1] ? "mdembed" : "md", start: m.index, end: m.index + m[0].length, linkpath, subpath, alias: m[2]! });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Lookup structures over the vault's file list, rebuilt when files are added or removed. */
export class LinkResolver {
  private byLowerPath = new Map<string, string>();
  private byLowerName = new Map<string, string[]>();

  constructor(index: FileIndex) {
    this.rebuild(index);
  }

  rebuild(index: FileIndex): void {
    this.byLowerPath.clear();
    this.byLowerName.clear();
    for (const p of index.paths()) {
      this.byLowerPath.set(p.toLowerCase(), p);
      const name = basename(p).toLowerCase();
      for (const key of new Set([name, stripMd(name)])) this.byLowerName.set(key, [...(this.byLowerName.get(key) ?? []), p]);
    }
  }

  private exact(path: string | null): string | null {
    if (path === null || path === "") return null;
    const lower = path.toLowerCase();
    return this.byLowerPath.get(lower) ?? this.byLowerPath.get(`${lower}.md`) ?? null;
  }

  /** The file a link path points to from `sourcePath`, or null. */
  resolve(linkpath: string, sourcePath: string): string | null {
    const raw = linkpath.trim();
    if (raw === "") return null;
    const sourceDir = dirname(sourcePath);
    if (raw.startsWith("/")) return this.exact(normalizePath(raw));
    const relative = this.exact(normalizePath(sourceDir ? `${sourceDir}/${raw}` : raw));
    if (relative) return relative;
    const fromRoot = this.exact(normalizePath(raw));
    if (fromRoot) return fromRoot;
    // By name: files whose path ends with the link path (case-insensitive).
    const norm = normalizePath(raw);
    if (!norm) return null;
    const lower = norm.toLowerCase();
    const name = basename(lower);
    const candidates = (this.byLowerName.get(name) ?? []).filter((p) => {
      const lp = p.toLowerCase();
      return lp === lower || lp === `${lower}.md` || lp.endsWith(`/${lower}`) || lp.endsWith(`/${lower}.md`);
    });
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;
    const same = candidates.filter((p) => dirname(p) === sourceDir);
    if (same.length > 0) return same.sort()[0]!;
    return [...candidates].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0]!;
  }

  /** How many files share this file's name (for the `shortest` format). */
  sameName(path: string): number {
    return (this.byLowerName.get(basename(path).toLowerCase()) ?? []).length;
  }
}

/** Relative path from folder `fromDir` to `to`. */
function relativePath(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** The link text for `path` written from `sourcePath` (no brackets, `.md` omitted on notes). */
export function linkText(resolver: LinkResolver, path: string, sourcePath: string, format: LinkFormat, omitMd = true): string {
  const target = omitMd && /\.md$/i.test(path) ? stripMd(path) : path;
  if (format === "absolute") return target;
  if (format === "relative") return relativePath(dirname(sourcePath), target);
  // shortest: the file name when no other file has it, else the full path.
  return resolver.sameName(path) <= 1 ? basename(target) : target;
}

/** A complete link to `path` from `sourcePath`, as Obsidian's `generateMarkdownLink` writes it. */
export function generateLink(
  resolver: LinkResolver,
  path: string,
  sourcePath: string,
  format: LinkFormat,
  opts: { subpath?: string; alias?: string; markdown?: boolean } = {},
): string {
  const sub = opts.subpath ?? "";
  if (opts.markdown) {
    const target = linkText(resolver, path, sourcePath, format, false);
    return `[${opts.alias || basename(path).replace(/\.md$/i, "")}](${encodeMd(target)}${sub})`;
  }
  // A link to a section of the same note is just the section.
  const text = path === sourcePath && sub ? "" : linkText(resolver, path, sourcePath, format, true);
  return `[[${text}${sub}${opts.alias ? `|${opts.alias}` : ""}]]`;
}

function encodeMd(path: string): string {
  return encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * Rewrite the links of `text` (a note at `sourcePath`) that resolve to a renamed file.
 * `resolveOld` resolves a link path as the vault was before the rename; `moved` maps old paths to
 * new ones; `textFor` gives the new link text for a new path from this note.
 */
export function rewriteLinks(
  text: string,
  sourcePath: string,
  resolveOld: (linkpath: string, source: string) => string | null,
  moved: ReadonlyMap<string, string>,
  textFor: (newPath: string, source: string, kind: LinkRef["kind"]) => string,
  oldSourcePath: string = sourcePath,
  /** Resolves a link path as the vault is after the rename (to keep links of a moved note that still work). */
  resolveNew: (linkpath: string, source: string) => string | null = resolveOld,
): { text: string; changed: number } {
  let out = "";
  let last = 0;
  let changed = 0;
  for (const l of parseLinks(text)) {
    if (l.linkpath === "") continue; // [[#heading]]: same note
    const target = resolveOld(l.linkpath, oldSourcePath);
    if (!target) continue;
    const to = moved.get(target);
    // A link of a moved note to a file that stays is rewritten only if it no longer resolves to it
    // from the new place (relative paths); links that still work are left as written.
    if (!to && (oldSourcePath === sourcePath || resolveNew(l.linkpath, sourcePath) === target)) continue;
    const dest = to ?? target;
    const linkTxt = dest === sourcePath && l.subpath && l.kind !== "md" && l.kind !== "mdembed" ? "" : textFor(dest, sourcePath, l.kind);
    let replacement: string;
    if (l.kind === "md" || l.kind === "mdembed") {
      const md = /\.md$/i.test(dest) && !/\.md$/i.test(linkTxt) ? `${linkTxt}.md` : linkTxt;
      replacement = `${l.kind === "mdembed" ? "!" : ""}[${l.alias!}](${encodeMd(md)}${l.subpath})`; // a Markdown link always has its text
    } else {
      const bang = l.kind === "embed" ? "!" : "";
      replacement = `${bang}[[${linkTxt}${l.subpath}${l.alias !== undefined ? `|${l.alias}` : ""}]]`;
    }
    const original = text.slice(l.start, l.end);
    if (replacement === original) continue;
    out += text.slice(last, l.start) + replacement;
    last = l.end;
    changed++;
  }
  return { text: out + text.slice(last), changed };
}
