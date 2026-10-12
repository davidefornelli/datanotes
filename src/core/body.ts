/**
 * Edits of a note body (the markdown after the frontmatter) that keep the rest of it:
 * replace the text under a heading, prepend, append.
 */

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

function isFence(line: string): boolean {
  return /^(```|~~~)/.test(line.trimStart());
}

/**
 * Replace the text under heading `title` (any level) up to the next heading of the same or a
 * higher level; headings inside code blocks do not count. A missing heading is added at the end
 * as `## title`.
 */
export function setSection(body: string, title: string, text: string): string {
  const lines = body.split("\n");
  const content = text.replace(/\s+$/, "");
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i]!)) inFence = !inFence;
    if (inFence) continue;
    const m = lines[i]!.match(HEADING_RE);
    if (m && m[2]!.trim().toLowerCase() === title.trim().toLowerCase()) {
      start = i;
      level = m[1]!.length;
      break;
    }
  }
  if (start < 0) {
    const base = body.replace(/\s+$/, "");
    return `${base}${base === "" ? "" : "\n\n"}## ${title.trim()}\n\n${content}\n`;
  }
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (isFence(lines[i]!)) inFence = !inFence;
    if (inFence) continue;
    const m = lines[i]!.match(HEADING_RE);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  const after = lines.slice(end);
  const section = content === "" ? [""] : ["", content, ""];
  return [...lines.slice(0, start + 1), ...section, ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function prependBody(body: string, text: string): string {
  const t = text.replace(/\s+$/, "");
  const rest = body.replace(/^\s+/, "");
  return rest === "" ? `${t}\n` : `${t}\n\n${rest}`;
}

export function appendBody(body: string, text: string): string {
  const base = body.replace(/\s+$/, "");
  return `${base}${base === "" ? "" : "\n\n"}${text.replace(/\s+$/, "")}\n`;
}
