/**
 * search_notes answers exactly as it did before the search index and the two phases (scores for
 * every match, passages for the 200 returned): without a search source, and with sources that are
 * exact, supersets, or name paths that are no notes. The reference is a copy of the 3.1.0 code
 * (tests/helpers/search-reference.ts), not the new code. It also checks which words a source is
 * asked for, that a source is trusted (a note it does not name is not read), and that folded texts
 * are kept only when every note is searched.
 */

import { describe, expect, it } from "vitest";
import { indexableWord, type NoteSearchResults, searchCacheStats, searchFold, searchNotes, setSearchSource, type SearchCandidates, type SearchSource } from "../src/core/vault-read";
import { TEXT_CACHE } from "../src/core/file-cache";
import type { App, TFile } from "../src/core/host";
import { logVault } from "./helpers/db-vault";
import { referenceSearch } from "./helpers/search-reference";

/** A small deterministic random source (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCABULARY = [
  "Paris", "paris", "Café", "café", "CAFÉ", "latte", "spring", "Αθήνα", "한국어", "Seoul", "😀",
  "report", "budget", "roadmap", "naïve", "straße", "İstanbul", "x", "ab", "the", "\u{1D15E}",
  "\u{2F800}", "Ǆ", "common",
];
const FOLDERS = ["Notes", "Trips/Café de Flore", "Archive/2026", "Projects/Paris"];
const SEPARATORS = [" ", ", ", ". ", "\n", " — "];

/** 320 notes of mixed scripts, accents written whole and decomposed, a dot-folder; two in three have `common`. */
function syntheticNotes(): Record<string, string> {
  const rnd = random(11);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const notes: Record<string, string> = {};
  for (let i = 0; i < 320; i++) {
    // 5% in a dot-folder: never in an answer
    const folder = i % 20 === 19 ? ".hidden" : pick(FOLDERS);
    let text = "";
    if (rnd() < 0.5) text += `---\ntitle: ${pick(VOCABULARY)} ${pick(VOCABULARY)} ${pick(VOCABULARY)}\ntags: [a, b]\n---\n`;
    const n = 5 + Math.floor(rnd() * 36);
    const words: string[] = [];
    for (let k = 0; k < n; k++) words.push(pick(VOCABULARY));
    if (i % 3 !== 2) words.splice(Math.floor(rnd() * words.length), 0, "common");
    text += words.map((w, k) => (k === 0 ? w : pick(SEPARATORS) + w)).join("") + "\n";
    notes[`${folder}/Note ${i} ${pick(VOCABULARY)}.md`] = text;
  }
  return notes;
}

/** Every Markdown note of the vault (the log vault's own included) and its text. */
async function vaultTexts(app: App): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const f of app.vault.getMarkdownFiles()) texts.set(f.path, await app.vault.read(f));
  return texts;
}

/** A source that names exactly the notes with every word, in their path or text; it records the words asked. */
function exactSource(texts: Map<string, string>): SearchSource & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    candidates(words) {
      calls.push([...words]);
      const hits: string[] = [];
      for (const [path, text] of texts) {
        const t = searchFold(text);
        const p = searchFold(path);
        if (words.every((w) => t.includes(w) || p.includes(w))) hits.push(path);
      }
      return { hits, unsure: [] };
    },
  };
}

/** The reference's answers to every query, by query and context length (computed once: it reads every note). */
async function references(app: App, contexts: readonly number[]): Promise<Map<string, NoteSearchResults>> {
  const out = new Map<string, NoteSearchResults>();
  for (const q of QUERIES) for (const ctx of contexts) out.set(`${ctx}:${q}`, await referenceSearch(app, q, ctx));
  return out;
}

const QUERIES = [
  "common", "paris", "cafe", "café latte", "ab", "x", "αθηνα", "한국", "seoul report", "😀", "nothing-here",
  "paris common", "istanbul", "strasse", "note 1", "trips", "ab cafe", "the common report",
];

describe("search_notes with and without a search source", () => {
  it("with no search source, answers as search_notes did", async () => {
    const v = logVault(syntheticNotes());
    const refs = await references(v.app, [0, 7, 100]);
    expect(refs.get("100:common")!.total).toBeGreaterThan(200);
    for (const q of QUERIES) {
      for (const ctx of [0, 7, 100]) {
        const want = refs.get(`${ctx}:${q}`);
        // twice: the second search uses the folded texts kept by the first
        expect(await searchNotes(v.app, q, ctx)).toEqual(want);
        expect(await searchNotes(v.app, q, ctx)).toEqual(want);
      }
    }
  }, 120_000); // thousands of note reads on a disk vault: slow under a full parallel run

  it("with an exact source, a superset source, or one naming paths that are no notes, answers the same", async () => {
    const v = logVault(syntheticNotes());
    v.write("Projects/img.png", "paris");
    const texts = await vaultTexts(v.app);
    const keys = [...texts.keys()];
    // the context length does not meet the source (the first test varies it): one is enough here
    const refs = await references(v.app, [100]);
    const sources: [string, SearchSource][] = [
      ["exact", exactSource(texts)],
      ["superset", { candidates: () => ({ hits: [...keys, "Missing/none.md", "Notes", "Projects/img.png"], unsure: keys.slice(0, 10) }) }],
      ["unsure only", { candidates: () => ({ hits: [], unsure: keys }) }],
      ["null", { candidates: () => null }],
    ];
    try {
      for (const [label, source] of sources) {
        setSearchSource(v.app, source);
        for (const q of QUERIES) {
          expect(await searchNotes(v.app, q), `${label}: ${q}`).toEqual(refs.get(`100:${q}`));
        }
      }
    } finally {
      setSearchSource(v.app, null);
    }
  }, 120_000);

  it("asks the source only for the words an index can look up, and not at all without one", async () => {
    const v = logVault(syntheticNotes());
    const calls: string[][] = [];
    setSearchSource(v.app, { candidates: (words) => (calls.push([...words]), null) });
    try {
      await searchNotes(v.app, "ab cafe 😀😀 x\u0000yz ab\uD800c");
      expect(calls).toEqual([["cafe"]]);
      await searchNotes(v.app, "ab x");
      expect(calls).toEqual([["cafe"]]);
    } finally {
      setSearchSource(v.app, null);
    }
  });

  it("trusts the source: a note it names neither as hit nor unsure is not searched, and not read", async () => {
    const texts = { ...TEXT_CACHE };
    TEXT_CACHE.maxChars = 0; // no text kept: each one read when needed
    const v = logVault({ "Notes/a.md": "paris\n", "Notes/b.md": "paris\n" });
    const source: SearchCandidates = { hits: ["Notes/a.md"], unsure: [] };
    setSearchSource(v.app, { candidates: () => source });
    try {
      const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
      const real = vault.read.bind(vault);
      const reads: string[] = [];
      vault.read = async (f) => (reads.push(f.path), real(f));
      const r = await searchNotes(v.app, "paris");
      expect(r.results.map((x) => x.path)).toEqual(["Notes/a.md"]);
      expect(r.total).toBe(1);
      expect(reads).toContain("Notes/a.md");
      expect(reads).not.toContain("Notes/b.md");
    } finally {
      setSearchSource(v.app, null);
      Object.assign(TEXT_CACHE, texts);
    }
  });

  it("keeps folded texts only when every note is searched", async () => {
    const v = logVault(syntheticNotes());
    setSearchSource(v.app, exactSource(await vaultTexts(v.app)));
    try {
      expect((await searchNotes(v.app, "common")).total).toBeGreaterThan(200);
      expect(searchCacheStats(v.app).notes).toBe(0);
    } finally {
      setSearchSource(v.app, null);
    }
    await searchNotes(v.app, "common");
    const visible = v.app.vault.getMarkdownFiles().filter((f) => !/(^|\/)\./.test(f.path)).length;
    expect(searchCacheStats(v.app).notes).toBe(visible);
    expect(searchCacheStats(v.app).chars).toBeGreaterThan(0);
  });

  it("indexableWord: three code points or more, no NUL, no lone surrogate", () => {
    const cases: [string, boolean][] = [
      ["abc", true], ["ab", false], ["😀😀😀", true], ["😀a", false],
      ["a\u0000bc", false], ["ab\uD800", false], ["\uDC00abc", false], ["😀ab", true],
    ];
    for (const [w, want] of cases) expect(indexableWord(w), JSON.stringify(w)).toBe(want);
  });
});
