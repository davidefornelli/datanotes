import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { listFolder, readNote, SEARCH_CACHE, searchNotes, VaultPathError, VaultPathNotFoundError } from "../src/core/vault-read";
import { TEXT_CACHE } from "../src/core/file-cache";
import type { TFile } from "../src/core/host";
import { docsUrl } from "../src/core/hints";
import { logVault } from "./helpers/db-vault";

const NOTE = "---\ntags: [trip]\n---\nA dinner in Paris with Alice. #memory\n";

describe("read_note", () => {
  it("answers the text, the front matter, the tags of both and the file's times and size", async () => {
    const v = logVault({ "Notes/Café.md": NOTE });
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    const n = await readNote(v.app, v.settings, "/Notes/Café.md");
    expect(n).toMatchObject({ path: "Notes/Café.md", content: NOTE, front_matter: { tags: ["trip"] }, size: Buffer.byteLength(NOTE) });
    // the front matter's tags, and the text's where the host reads them (the Node host does)
    expect(n.tags).toContain("trip");
    expect(n.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+0[12]:00$/);
    expect(n.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a folder, an empty path and a missing file, saying what to call instead", async () => {
    const v = logVault({ "Notes/Café.md": NOTE });
    await expect(readNote(v.app, v.settings, "Notes")).rejects.toThrow(new VaultPathError("Notes is a folder: list_folder lists it"));
    await expect(readNote(v.app, v.settings, "Notes/")).rejects.toBeInstanceOf(VaultPathError);
    await expect(readNote(v.app, v.settings, "")).rejects.toThrow("path must name a file, not a folder");
    const missing = await readNote(v.app, v.settings, "Notes/Nope.md").catch((e: unknown) => e as VaultPathNotFoundError);
    expect(missing).toBeInstanceOf(VaultPathNotFoundError);
    expect(missing).toMatchObject({ message: "no file Notes/Nope.md in the vault", docs: docsUrl("readNote") });
  });

  it("a host that gives no file stats answers null times and size", async () => {
    const v = logVault({ "Notes/Trip.md": "Trip\n" });
    const real = v.app.vault.getAbstractFileByPath.bind(v.app.vault);
    // the host's own vault (its methods live on its prototype), but a file without stats
    const vault = Object.assign(Object.create(v.app.vault) as object, { getAbstractFileByPath: (p: string) => (p === "Notes/Trip.md" ? { path: p, name: "Trip.md", basename: "Trip", extension: "md" } : real(p)) });
    const app = { ...v.app, vault };
    expect(await readNote(app as never, v.settings, "Notes/Trip.md")).toEqual({ path: "Notes/Trip.md", content: "Trip\n", front_matter: {}, tags: [], modified_at: null, created_at: null, size: null });
  });
});

describe("list_folder", () => {
  it("answers the sub-folders and the files as vault paths, leaving out dot-files and dot-folders", () => {
    const v = logVault({ "Notes/Café.md": NOTE, "Notes/Trips/Rome.md": "Rome\n", "Notes/.hidden.md": "x\n", ".obsidian/app.json": "{}" });
    expect(listFolder(v.app, "Notes/")).toEqual({ folder: "Notes", folders: ["Notes/Trips"], files: ["Notes/Café.md"] });
    const root = listFolder(v.app, "");
    expect(root.folder).toBe("");
    expect(root.folders).toEqual(expect.arrayContaining(["Daily", "Notes"]));
    expect(root.folders).not.toContain(".obsidian");
  });

  it("refuses a file and a missing folder", () => {
    const v = logVault({ "Notes/Café.md": NOTE });
    expect(() => listFolder(v.app, "Notes/Café.md")).toThrow(new VaultPathError("Notes/Café.md is a file: read_note reads it"));
    expect(() => listFolder(v.app, "Nope")).toThrow(new VaultPathNotFoundError("no folder Nope in the vault"));
  });
});

describe("search_notes", () => {
  it("counts every note that matches in total, and answers at most 200, best first", async () => {
    const notes = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`Many/Note ${String(i).padStart(3, "0")}.md`, `paris${i % 2 === 0 ? " paris" : ""}\n`]));
    const v = logVault(notes);
    const r = await searchNotes(v.app, "paris", 2);
    expect(r.total).toBe(205);
    expect(r.results).toHaveLength(200);
    expect(r.results[0]).toMatchObject({ path: "Many/Note 000.md", score: 2 });
    expect(r.results.at(-1)!.score).toBe(1);
    // passages are still built for the notes returned
    expect(r.results.every((x) => x.matches.length > 0)).toBe(true);
  });

  it("leaves out notes in dot-folders, and clamps the context to 0..1000", async () => {
    const v = logVault({ "Notes/a.md": "Paris\n", ".trash/b.md": "Paris\n" });
    expect((await searchNotes(v.app, "paris")).results.map((r) => r.path)).toEqual(["Notes/a.md"]);
    expect((await searchNotes(v.app, "paris", -5)).results[0]!.matches[0]!.context).toBe("Paris\n");
    expect((await searchNotes(v.app, "paris", 5000)).results[0]!.matches[0]!.context).toBe("Paris\n");
  });

  /** The text each match names in its note, by its offsets. */
  const found = (content: string, r: Awaited<ReturnType<typeof searchNotes>>) => r.results[0]!.matches.map((m) => content.slice(m.start, m.end));

  it("gives the offsets in the note's own text when folding changes its length (regression)", async () => {
    // decomposed accents (macOS file names and some editors), Hangul, a symbol that decomposes
    // into two (four code units), a compatibility ideograph that decomposes into one shorter
    const cases: [string, string, string[]][] = [
      ["Café con leche, then café again.\n", "leche", ["leche"]],
      ["Café con leche, then café again.\n", "cafe", ["Café", "café"]],
      ["Cafȩ́ con leche.\n", "con", ["con"]],
      ["한국어 and Seoul notes\n", "seoul", ["Seoul"]],
      ["\u{1D15E} music: a half note, then the score\n", "score", ["score"]],
      ["\u{2F800} and \u{2F800} then Paris\n", "paris", ["Paris"]],
      ["́ a mark first, then Paris\n", "paris", ["Paris"]],
    ];
    for (const [content, query, words] of cases) {
      const v = logVault({ "Notes/a.md": content });
      const r = await searchNotes(v.app, query, 3);
      expect(found(content, r), `${query} in ${JSON.stringify(content)}`).toEqual(words);
      const m = r.results[0]!.matches[0]!;
      expect(m.context).toBe(content.slice(Math.max(0, m.start - 3), m.end + 3));
    }
  });

  it("offsets stay as they were where folding keeps the length: accents written whole, any script that does not decompose", async () => {
    const content = "Café “Paris” über Αθήνα 😀 report\n";
    const v = logVault({ "Notes/a.md": content });
    const r = await searchNotes(v.app, "αθηνα paris", 0);
    expect(r.results[0]!.matches.map((m) => [m.start, m.end])).toEqual([[6, 11], [18, 23]]);
    expect(found(content, r)).toEqual(["Paris", "Αθήνα"]);
    // words with only spaces and symbols between them make one match
    expect(found(content, await searchNotes(v.app, "αθηνα report", 0))).toEqual(["Αθήνα 😀 report"]);
  });

  it("folds each note once per version: a changed note is searched as it is now, a deleted one is forgotten", async () => {
    const v = logVault({ "Notes/a.md": "Paris in spring\n", "Notes/b.md": "Rome in spring\n" });
    expect((await searchNotes(v.app, "spring")).total).toBe(2);
    v.write("Notes/a.md", "Paris in autumn\n");
    expect((await searchNotes(v.app, "spring")).results.map((x) => x.path)).toEqual(["Notes/b.md"]);
    expect((await searchNotes(v.app, "autumn")).results.map((x) => x.path)).toEqual(["Notes/a.md"]);
    v.remove("Notes/b.md");
    expect((await searchNotes(v.app, "spring")).total).toBe(0);
    v.write("Notes/b.md", "Rome in spring again\n");
    expect((await searchNotes(v.app, "spring")).results.map((x) => x.path)).toEqual(["Notes/b.md"]);
  });

  it("past the folded-text budget, the notes not kept are folded on every search, with the same answers", async () => {
    const max = SEARCH_CACHE.maxChars;
    SEARCH_CACHE.maxChars = 40;
    try {
      const v = logVault({ "Notes/a.md": "Paris in spring\n", "Notes/b.md": "Rome in spring, a longer note than the budget allows\n" });
      for (let i = 0; i < 2; i++) expect((await searchNotes(v.app, "spring")).results.map((x) => x.path)).toEqual(["Notes/a.md", "Notes/b.md"]);
    } finally {
      SEARCH_CACHE.maxChars = max;
    }
    // nothing searched yet in a vault of dot-folders only
    expect((await searchNotes(logVault({ ".trash/b.md": "Paris\n" }).app, "paris")).total).toBe(0);
  });

  it("a note kept folded is read only when it matches, and searched as it is now when it changed meanwhile", async () => {
    const texts = { ...TEXT_CACHE };
    TEXT_CACHE.maxChars = 0; // no text kept: each one read when needed
    try {
      const v = logVault({ "Notes/a.md": "Paris in spring\n", "Notes/b.md": "Rome in spring\n" });
      expect((await searchNotes(v.app, "spring")).total).toBe(2);
      const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
      const real = vault.read.bind(vault);
      const reads: string[] = [];
      vault.read = async (f) => (reads.push(f.path), real(f));
      // b's folded text has no match: b is not read
      expect((await searchNotes(v.app, "paris")).results.map((x) => x.path)).toEqual(["Notes/a.md"]);
      expect(reads).toEqual(["Notes/a.md"]);
      // a changed on disk with its stat kept (a tool that restores the mtime): the text read for its
      // passages is the new one, which no longer matches
      const fs = await import("node:fs");
      const was = fs.statSync(v.abs("Notes/a.md"));
      fs.writeFileSync(v.abs("Notes/a.md"), "Milan in spring\n"); // the same size, no event
      fs.utimesSync(v.abs("Notes/a.md"), was.atime, was.mtime);
      expect((await searchNotes(v.app, "paris")).total).toBe(0);
      expect((await searchNotes(v.app, "milan")).results.map((x) => x.path)).toEqual(["Notes/a.md"]);
      // changed again the same way, still a match: its passages come from its new text
      fs.writeFileSync(v.abs("Notes/a.md"), "Milan in autumn\n");
      fs.utimesSync(v.abs("Notes/a.md"), was.atime, was.mtime);
      expect((await searchNotes(v.app, "milan")).results.map((x) => x.matches[0]!.context)).toEqual(["Milan in autumn\n"]);
    } finally {
      Object.assign(TEXT_CACHE, texts);
    }
  });

  it("a note whose path alone has the words: no match in its text, 5 for each word of the path", async () => {
    const v = logVault({ "Trips/Café de Flore.md": "A table by the window.\n" });
    expect((await searchNotes(v.app, "cafe flore")).results).toEqual([{ path: "Trips/Café de Flore.md", score: 10, matches: [] }]);
  });
});
