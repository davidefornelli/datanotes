/**
 * The file cache keeps each note's hash and parse while its stat is unchanged, and the texts apart,
 * within a budget of characters: a read that needs no body needs no text, a text no longer kept
 * comes from the host's quick source (checked by its hash) or is read again.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { App, TFile } from "../src/core/host";
import { detached, readOrderedFromMarkdown } from "../src/core/frontmatter";
import {
  cachedText,
  cachedVersion,
  contentHash,
  invalidateFiles,
  primeFiles,
  readBody,
  readFrontmatter,
  readFrontmatterEntries,
  readFrontmatterValue,
  readHash,
  readHashed,
  setTextSource,
  TEXT_CACHE,
  textCacheStats,
  versionFrontmatter,
} from "../src/core/file-cache";

const budget = { ...TEXT_CACHE };
afterEach(() => Object.assign(TEXT_CACHE, budget));

/** An in-memory host that counts its reads. */
function host(files: Record<string, string>) {
  const text = new Map(Object.entries(files));
  const reads: string[] = [];
  const app = {
    vault: {
      read: async (f: TFile) => {
        reads.push(f.path);
        return text.get(f.path)!;
      },
    },
  } as unknown as App;
  return { app, reads, edit: (path: string, content: string) => text.set(path, content) };
}

const file = (path: string, size: number, mtime = 1) => ({ path, stat: { mtime, size } }) as unknown as TFile;
const note = (n: number) => `---\ntable: main.public.log\nn: ${n}\n---\nBody ${n}.\n`;

describe("the texts the file cache keeps", () => {
  it("are kept within the budget, the least recently used going first", async () => {
    const texts = Object.fromEntries([1, 2, 3].map((n) => [`${n}.md`, note(n)]));
    const { app, reads } = host(texts);
    expect(textCacheStats(app)).toEqual({ texts: 0, chars: 0 });
    TEXT_CACHE.maxChars = note(1).length * 2;
    const f = (n: number) => file(`${n}.md`, note(n).length);
    await readFrontmatter(app, f(1), new Set());
    await readFrontmatter(app, f(2), new Set());
    await readHashed(app, f(1)); // 1 used last: 2 goes first
    await readHashed(app, f(3));
    expect(textCacheStats(app)).toEqual({ texts: 2, chars: note(1).length * 2 });
    expect([cachedText(app, "1.md"), cachedText(app, "2.md"), cachedText(app, "3.md")]).toEqual([note(1), undefined, note(3)]);
    expect(reads).toEqual(["1.md", "2.md", "3.md"]);
    // the parse and hash of 2 are kept: its front matter needs no text, its body does
    expect(await readFrontmatterEntries(app, f(2), new Set())).toEqual([["table", "main.public.log"], ["n", 2]]);
    expect(await readFrontmatterValue(app, f(2), new Set(), (o) => o.length)).toBe(2);
    expect(await readHash(app, f(2))).toBe(contentHash(note(2)));
    expect(reads).toEqual(["1.md", "2.md", "3.md"]);
    expect(await readBody(app, f(2))).toBe("Body 2.\n");
    expect(reads).toEqual(["1.md", "2.md", "3.md", "2.md"]);
  });

  it("a text longer than the whole budget is not kept", async () => {
    const { app, reads } = host({ "a.md": note(1) });
    TEXT_CACHE.maxChars = 5;
    const a = file("a.md", note(1).length);
    expect(await readFrontmatter(app, a, new Set())).toEqual(readOrderedFromMarkdown(note(1)));
    expect(textCacheStats(app)).toEqual({ texts: 0, chars: 0 });
    expect(await readBody(app, a)).toBe("Body 1.\n");
    expect(reads).toEqual(["a.md", "a.md"]);
  });

  it("a text no longer kept comes from the host's quick source, checked by its hash", async () => {
    const { app, reads, edit } = host({ "a.md": note(1) });
    TEXT_CACHE.maxChars = 0;
    const asked: string[] = [];
    setTextSource(app, { textOf: (p, h) => (asked.push(p), h === contentHash(note(1)) ? note(1) : undefined) });
    const a = file("a.md", note(1).length);
    expect((await readHashed(app, a)).content).toBe(note(1)); // read: nothing kept yet
    expect(textCacheStats(app).texts).toBe(0); // a budget of 0: nothing kept
    expect((await readHashed(app, a)).content).toBe(note(1));
    expect([asked, reads]).toEqual([["a.md"], ["a.md"]]);
    // the source no longer has this version: the note is read again
    setTextSource(app, { textOf: () => undefined });
    expect(await readBody(app, a)).toBe("Body 1.\n");
    expect(reads).toEqual(["a.md", "a.md"]);
    // changed on disk with its stat unchanged: the text read again is a new version
    edit("a.md", note(9));
    const again = await readHashed(app, a);
    expect(again).toEqual({ content: note(9), hash: contentHash(note(9)) });
    expect(await readFrontmatterEntries(app, a, new Set())).toEqual([["table", "main.public.log"], ["n", 9]]);
    setTextSource(app, null);
  });

  it("a host primes a note without its text: its parse and hash, the body sliced from the text when asked", async () => {
    const { app, reads } = host({ "a.md": note(4), "b.md": "B" });
    const a = file("a.md", note(4).length);
    const parsed = readOrderedFromMarkdown(note(4));
    primeFiles(app, [
      { file: a, hash: contentHash(note(4)), parse: { ordered: parsed.ordered, bodyStart: note(4).length - parsed.body.length } },
      { file: file("b.md", 1) }, // neither text nor hash: nothing to tell its version by
    ]);
    expect(await readFrontmatterValue(app, a, new Set(), (o) => o)).toBe(parsed.ordered);
    expect(await readHash(app, a)).toBe(contentHash(note(4)));
    expect(reads).toEqual([]);
    expect(await readFrontmatter(app, a, new Set(["table"]))).toEqual({ ordered: parsed.ordered, body: parsed.body });
    expect(reads).toEqual(["a.md"]);
    expect(await readHash(app, file("b.md", 1))).toBe(contentHash("B")); // read: not primed
    expect(reads).toEqual(["a.md", "b.md"]);
  });

  it("a version kept for later reads the front matter as it was, also when it holds only the text", async () => {
    const { app } = host({ "a.md": note(1), "b.md": note(2) });
    const a = file("a.md", note(1).length);
    await readFrontmatter(app, a, new Set());
    const v = cachedVersion(app, a)!;
    // b's entry has its text only (read for its hash): its parse comes from the text kept
    const b = file("b.md", note(2).length);
    await readHashed(app, b);
    const w = cachedVersion(app, b)!;
    invalidateFiles(app, ["a.md", "b.md"]);
    expect(versionFrontmatter(v, new Set(["table"]))).toEqual([["table", "main.public.log"], ["n", 1]]);
    expect(versionFrontmatter(w, new Set())).toEqual([["table", "main.public.log"], ["n", 2]]);
    expect(cachedVersion(app, a)).toBeUndefined(); // forgotten
    // an entry whose text went and whose parse was never made: no version to keep
    TEXT_CACHE.maxChars = 0;
    await readHashed(app, b);
    expect(cachedVersion(app, b)).toBeUndefined();
    expect(cachedVersion(app, { path: "c.md" } as TFile)).toBeUndefined(); // no stat
  });

  it("a note changed under the same stat gives the new front matter and body, cut at the new front matter's end", async () => {
    const before = "---\ntable: main.public.log\nn: 1\n---\nBody one.\n";
    const after = "---\ntable: main.public.log\n---\nBody one. More\n";
    expect(after.length).toBe(before.length);
    const { app, edit } = host({ "a.md": before, "b.md": before });
    TEXT_CACHE.maxChars = 0; // no text kept: the body needs a read again
    const a = file("a.md", before.length);
    const b = file("b.md", before.length);
    await readFrontmatterEntries(app, a, new Set());
    await readFrontmatterEntries(app, b, new Set());
    edit("a.md", after);
    edit("b.md", after);
    expect(await readBody(app, a)).toBe("Body one. More\n");
    expect(await readFrontmatter(app, b, new Set())).toEqual(readOrderedFromMarkdown(after));
  });
});

describe("strings that hold their own characters", () => {
  it("are equal to the piece they were cut from", () => {
    const text = `${"x".repeat(1000)}id: 01a0f000-0000-7000-8000-00000000000a\n`;
    const piece = text.slice(1004, 1040);
    expect(detached(piece)).toBe(piece);
    expect(detached("short")).toBe("short");
    expect(readOrderedFromMarkdown(`---\nid: ${piece}\nlong_key_of_the_note: "a value \\u00e9 longer than 13"\n---\n`).ordered).toEqual([
      ["id", piece],
      ["long_key_of_the_note", "a value é longer than 13"],
    ]);
  });
});
