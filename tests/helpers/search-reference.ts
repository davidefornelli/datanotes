/**
 * search_notes as it was before the search index and the two phases: the equivalence tests'
 * reference. Copied from src/core/vault-read.ts of 3.1.0 (f172eda), without any cache: every note is
 * read and folded on each search, and every match gets its passages.
 */

import type { App } from "../../src/core/host";
import type { NoteSearchResults } from "../../src/core/vault-read";

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Characters below U+0300 fold to one character each (accents decompose into marks the fold drops). */
const ONE_TO_ONE = /^[\u0000-˿]*$/;

/** How many characters each character of the Basic Multilingual Plane folds to, once known (255: not yet). */
const BMP_FOLDED = new Uint8Array(0x10000).fill(255);

function foldedLength(cp: number, ch: string): number {
  if (cp > 0xffff) return fold(ch).length;
  let n = BMP_FOLDED[cp]!;
  if (n === 255) BMP_FOLDED[cp] = n = fold(ch).length;
  return n;
}

/** Where a range of the folded text is in the text itself (null: the same positions). */
function foldedOffsets(content: string): { start(i: number): number; end(i: number): number } | null {
  if (ONE_TO_ONE.test(content)) return null;
  const starts: number[] = [];
  const ends: number[] = [];
  let aligned = true;
  for (let o = 0; o < content.length; ) {
    const cp = content.codePointAt(o)!;
    const width = cp > 0xffff ? 2 : 1;
    const n = cp < 0x300 ? 1 : foldedLength(cp, content.slice(o, o + width));
    if (n !== width) aligned = false;
    if (n === 0 && ends.length > 0) {
      // a mark the fold drops: it stays with the character before it
      for (let k = ends.length - 1; k >= 0 && ends[k] === o; k--) ends[k] = o + width;
    }
    for (let k = 0; k < n; k++) {
      starts.push(o);
      ends.push(o + width);
    }
    o += width;
  }
  if (aligned) return null;
  return {
    start: (i) => starts[i]!,
    end: (i) => ends[i - 1]!,
  };
}

/** A path with a part that starts with a dot. */
const HIDDEN = /(^|\/)\./;

/** search_notes of 3.1.0: every note read and searched, passages for every match. */
export async function referenceSearch(app: App, query: string, contextLength = 100): Promise<NoteSearchResults> {
  const words = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
  if (words.length === 0) return { query, results: [], total: 0 };
  const ctx = Number.isFinite(contextLength) && contextLength >= 0 ? Math.min(Math.floor(contextLength), 1000) : 100;
  const out: NoteSearchResults["results"] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (HIDDEN.test(f.path)) continue;
    const content = await app.vault.read(f);
    const text = fold(content);
    const name = fold(f.path);
    if (!words.every((w) => text.includes(w) || name.includes(w))) continue;
    const spans: { start: number; end: number }[] = [];
    for (const w of words) {
      for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) spans.push({ start: i, end: i + w.length });
    }
    spans.sort((x, y) => x.start - y.start || y.end - x.end);
    const merged: { start: number; end: number }[] = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && (sp.start <= last.end || !/[\p{L}\p{N}]/u.test(text.slice(last.end, sp.start)))) last.end = Math.max(last.end, sp.end);
      else merged.push({ ...sp });
    }
    const at = merged.length > 0 ? foldedOffsets(content) : null;
    const matches = merged.slice(0, 20).map((m) => {
      const start = at ? at.start(m.start) : m.start;
      const end = at ? at.end(m.end) : m.end;
      return { start, end, context: content.slice(Math.max(0, start - ctx), end + ctx) };
    });
    const nameHits = words.filter((w) => name.includes(w)).length;
    out.push({ path: f.path, score: Math.min(spans.length, 20) + nameHits * 5, matches });
  }
  out.sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
  return { query, results: out.slice(0, 200), total: out.length };
}
