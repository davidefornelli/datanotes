import { describe, expect, it } from "vitest";
import type { App, TFile } from "../src/core/host";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { bumpVaultGeneration, contentHash, invalidateFiles, primeFiles, readFrontmatter, readFrontmatterValue, readHashed, readParsed, vaultGeneration } from "../src/core/file-cache";

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

/** A file as the host lists it: with Obsidian's in-memory `stat`, or without one. */
const file = (path: string, stat?: Record<string, unknown>) => ({ path, ...(stat ? { stat } : {}) }) as unknown as TFile;

const NOTE = "---\ntable: main.public.log\nkind: walk\n---\nWalked 5 km.\n";

describe("contentHash", () => {
  it("is cyrb53 written as 14 hex digits", () => {
    expect(contentHash("")).toBe("0bdcb81aee8d83");
    expect(parseInt(contentHash(""), 16)).toBe(3338908027751811);
    expect(parseInt(contentHash("a"), 16)).toBe(7929297801672961);
    expect(parseInt(contentHash("revenge"), 16)).toBe(4051478007546757);
    expect(parseInt(contentHash("revenue"), 16)).toBe(8309097637345594);
  });

  it("tells apart versions of a note that differ by one character", () => {
    expect(contentHash(NOTE)).not.toBe(contentHash(NOTE.replace("5 km", "6 km")));
    expect(contentHash(NOTE)).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe("files with a stat", () => {
  it("are read once while mtime and size do not change, and again when they do", async () => {
    const h = host({ "Daily/a.md": NOTE });
    const stamped = file("Daily/a.md", { mtime: 1_780_000_000_000, size: NOTE.length });
    const first = await readHashed(h.app, stamped);
    expect(await readHashed(h.app, stamped)).toEqual(first);
    expect(h.reads).toEqual(["Daily/a.md"]);
    h.edit("Daily/a.md", `${NOTE}More.\n`);
    const later = file("Daily/a.md", { mtime: 1_780_000_005_000, size: NOTE.length + 6 });
    expect(await readHashed(h.app, later)).toEqual({ content: `${NOTE}More.\n`, hash: contentHash(`${NOTE}More.\n`) });
    expect(h.reads).toEqual(["Daily/a.md", "Daily/a.md"]);
  });
});

describe("files without a stat", () => {
  it.each([
    ["no stat at all", undefined],
    ["a stat without mtime", { size: NOTE.length }],
    ["a stat without size", { mtime: 1_780_000_000_000 }],
    ["a stat with a text mtime", { mtime: "2026-10-08", size: NOTE.length }],
  ])("are read every time: %s", async (_title, stat) => {
    const h = host({ "Daily/a.md": NOTE });
    const f = file("Daily/a.md", stat);
    expect(await readHashed(h.app, f)).toEqual({ content: NOTE, hash: contentHash(NOTE) });
    h.edit("Daily/a.md", "edited\n");
    expect(await readHashed(h.app, f)).toEqual({ content: "edited\n", hash: contentHash("edited\n") });
    expect(h.reads).toEqual(["Daily/a.md", "Daily/a.md"]);
  });

  it("drop what was cached for the same path", async () => {
    const h = host({ "Daily/a.md": NOTE });
    const stamp = { mtime: 1_780_000_000_000, size: NOTE.length };
    expect((await readHashed(h.app, file("Daily/a.md", stamp))).content).toBe(NOTE);
    // rewritten within the same millisecond with the same size: the stat cannot tell
    const same = NOTE.replace("walk", "wa1k");
    h.edit("Daily/a.md", same);
    expect((await readHashed(h.app, file("Daily/a.md", stamp))).content).toBe(NOTE);
    // a read without stat sees the new text and forgets the cached one
    expect((await readHashed(h.app, file("Daily/a.md"))).content).toBe(same);
    expect((await readHashed(h.app, file("Daily/a.md", stamp))).content).toBe(same);
    expect(h.reads).toEqual(["Daily/a.md", "Daily/a.md", "Daily/a.md"]);
  });
});

describe("readParsed", () => {
  it("parses once per parser key and hands out a fresh entry list", async () => {
    const h = host({ "Daily/a.md": NOTE });
    const f = file("Daily/a.md", { mtime: 1, size: NOTE.length });
    const parsed: string[] = [];
    const parser = (key: string) => (content: string) => {
      parsed.push(key);
      return readOrderedFromMarkdown(content, key === "links" ? new Set(["table"]) : new Set());
    };
    const a = await readParsed(h.app, f, "plain", parser("plain"));
    expect(a).toEqual({ ordered: [["table", "main.public.log"], ["kind", "walk"]], body: "Walked 5 km.\n" });
    // a caller that edits its copy does not change what the next caller gets
    const mine = a.ordered as [string, unknown][];
    mine.push(["extra", 1]);
    mine[0]![1] = "changed";
    expect(await readParsed(h.app, f, "plain", parser("plain"))).toEqual({ ordered: [["table", "main.public.log"], ["kind", "walk"]], body: "Walked 5 km.\n" });
    await readParsed(h.app, f, "links", parser("links"));
    expect(parsed).toEqual(["plain", "links"]);
    expect(h.reads).toEqual(["Daily/a.md"]);
  });

  it("parses every time a file without stat", async () => {
    const h = host({ "Daily/a.md": NOTE });
    let parses = 0;
    const parse = (content: string) => (parses++, readOrderedFromMarkdown(content));
    await readParsed(h.app, file("Daily/a.md"), "plain", parse);
    await readParsed(h.app, file("Daily/a.md"), "plain", parse);
    expect(parses).toBe(2);
  });
});

describe("invalidation and the vault generation", () => {
  it("invalidating forgets the paths and moves the generation, even before anything was cached", async () => {
    const h = host({ "Daily/a.md": NOTE, "Daily/b.md": "B\n" });
    expect(vaultGeneration(h.app)).toBe(0);
    invalidateFiles(h.app, ["Daily/a.md"]);
    expect(vaultGeneration(h.app)).toBe(1);
    const a = file("Daily/a.md", { mtime: 1, size: 1 });
    const b = file("Daily/b.md", { mtime: 1, size: 1 });
    await readHashed(h.app, a);
    await readHashed(h.app, b);
    invalidateFiles(h.app, new Set(["Daily/a.md"]));
    await readHashed(h.app, a);
    await readHashed(h.app, b);
    expect(h.reads).toEqual(["Daily/a.md", "Daily/b.md", "Daily/a.md"]);
    bumpVaultGeneration(h.app);
    expect(vaultGeneration(h.app)).toBe(3);
  });

  it("each app has its own cache and generation", async () => {
    const one = host({ "Daily/a.md": "one\n" });
    const two = host({ "Daily/a.md": "two\n" });
    const f = file("Daily/a.md", { mtime: 1, size: 4 });
    expect((await readHashed(one.app, f)).content).toBe("one\n");
    expect((await readHashed(two.app, f)).content).toBe("two\n");
    bumpVaultGeneration(one.app);
    expect([vaultGeneration(one.app), vaultGeneration(two.app)]).toEqual([1, 0]);
  });
});

describe("readFrontmatter: one parse per version of a note", () => {
  // a wikilink written without quotes is YAML for a list in a list
  const MISPARSED = "---\ntable: [[main.public.log]]\nfriend: [[Ada]]\nkind: walk\n---\nBody\n";

  it("gives what readOrderedFromMarkdown gives with each set of wikilink keys, from one parse", async () => {
    const { app, reads } = host({ "a.md": MISPARSED, "b.md": NOTE });
    const f = file("a.md", { mtime: 1, size: MISPARSED.length });
    for (const keep of [new Set<string>(), new Set(["table"]), new Set(["table", "friend"]), new Set(["kind"])]) {
      expect(await readFrontmatter(app, f, keep)).toEqual(readOrderedFromMarkdown(MISPARSED, keep));
      expect(await readFrontmatterValue(app, f, keep, (o) => o.map(([k]) => k))).toEqual(["table", "friend", "kind"]);
    }
    expect(reads).toEqual(["a.md"]);
    // a copy of the entry list each time: a caller that changes it changes no one else's
    const one = await readFrontmatter(app, f, new Set(["table"]));
    (one.ordered as [string, unknown][]).pop();
    expect((await readFrontmatter(app, f, new Set(["table"]))).ordered).toHaveLength(3);
    // a note without a misparsed key shares the parse of the text
    const b = file("b.md", { mtime: 1, size: NOTE.length });
    expect(await readFrontmatter(app, b, new Set(["table"]))).toEqual(readOrderedFromMarkdown(NOTE, new Set(["table"])));
  });

  it("takes the parse and hash a host primed at start: the text is not parsed or hashed again", async () => {
    const { app, reads } = host({});
    const f = file("a.md", { mtime: 2, size: NOTE.length });
    const parsed = readOrderedFromMarkdown(NOTE);
    primeFiles(app, [{ file: f, content: NOTE, hash: "primed-hash", frontmatter: parsed }]);
    expect((await readHashed(app, f)).hash).toBe("primed-hash");
    expect(await readFrontmatterValue(app, f, new Set(), (o) => o)).toBe(parsed.ordered);
    expect(reads).toEqual([]);
  });

  it("a front matter that cannot be read throws on every read, as the parser does", async () => {
    const { app } = host({ "x.md": "---\ntable: [broken\n---\n" });
    const f = file("x.md", { mtime: 1, size: 20 });
    await expect(readFrontmatter(app, f, new Set())).rejects.toThrow();
    await expect(readFrontmatter(app, f, new Set(["table"]))).rejects.toThrow();
  });
});
