/**
 * Splits a note into passages for semantic search: the title and the frontmatter go with the
 * first passage, then one passage per heading section, long sections cut at paragraph boundaries.
 */

export interface Chunk {
  /** Heading path of the section ("" before the first heading). */
  heading: string;
  /** Text sent to the embedding model. */
  text: string;
  /** Short excerpt shown in results. */
  snippet: string;
}

/**
 * A `---` line, the YAML, a `---` line. The first alternative is the empty block (`---` right after
 * `---`), as in `splitFrontmatter`: without it, the YAML would run on to a later `---` line of the body.
 */
const FRONTMATTER_RE = /^---\r?\n(?:---|([\s\S]*?)\r?\n---)[ \t]*(?:\r?\n|$)/;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

export interface ChunkOptions {
  maxChars?: number;
  /** Frontmatter keys left out of the embedded text (ids, membership keys). */
  skipKeys?: string[];
  maxChunks?: number;
}

function snippetOf(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > 240 ? `${s.slice(0, 237)}…` : s;
}

/** Cut `text` into pieces of at most `max` characters, at blank lines, then lines, then words. */
function split(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const para of text.split(/\n\s*\n/)) {
    if (para.length > max) {
      push();
      for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max).trim());
      continue;
    }
    if (cur.length + para.length + 2 > max) push();
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  push();
  return out.filter(Boolean);
}

export function chunkNote(path: string, content: string, opts: ChunkOptions = {}): Chunk[] {
  const max = opts.maxChars ?? 1500;
  const skip = new Set(opts.skipKeys ?? []);
  const title = path.split("/").pop()!.replace(/\.md$/i, ""); // split() returns at least one element
  let body = content;
  let fm = "";
  const m = FRONTMATTER_RE.exec(content);
  if (m) {
    body = content.slice(m[0].length);
    fm = (m[1] ?? "")
      .split(/\r?\n/)
      .filter((line) => {
        const key = /^([^\s:#][^:]*):/.exec(line)?.[1]?.trim();
        return !(key && skip.has(key));
      })
      .join("\n")
      .slice(0, 800);
  }

  // Sections by heading.
  const sections: { heading: string; text: string }[] = [];
  const stack: string[] = [];
  let cur: string[] = [];
  let heading = "";
  const flush = () => {
    const text = cur.join("\n").trim();
    if (text) sections.push({ heading, text });
    cur = [];
  };
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    const h = inFence ? null : HEADING_RE.exec(line);
    if (h) {
      flush();
      stack.length = Math.min(stack.length, h[1]!.length - 1);
      stack[h[1]!.length - 1] = h[2]!.trim();
      heading = stack.filter(Boolean).join(" › ");
      continue;
    }
    cur.push(line);
  }
  flush();

  const chunks: Chunk[] = [];
  const head = fm ? `${title}\n${fm}` : title;
  if (sections.length === 0) return [{ heading: "", text: head, snippet: snippetOf(fm || title) }];
  sections.forEach((s, i) => {
    for (const piece of split(s.text, max)) {
      const label = s.heading ? `${title} › ${s.heading}` : title;
      const text = i === 0 && chunks.length === 0 ? `${head}\n\n${s.heading ? `${s.heading}\n` : ""}${piece}` : `${label}\n\n${piece}`;
      chunks.push({ heading: s.heading, text, snippet: snippetOf(piece) });
    }
  });
  return chunks.slice(0, opts.maxChunks ?? 40);
}
