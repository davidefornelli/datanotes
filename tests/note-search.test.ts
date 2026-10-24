/**
 * Hybrid search on the notes (`search`, src/core/note-search.ts): the notes ranked by their words
 * (BM25) when the semantic index is off, by words and meaning fused with Reciprocal Rank Fusion
 * when it is on; the query syntax of search_docs; the `tables` and `folder` filters; the host's
 * index of words; the read scope of a named token.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { runWithActor } from "../src/core/actor";
import type { HttpRequest, Transport } from "../src/core/embeddings";
import { parseSearchQuery, searchTerms, searchTermsStats, searchVault, SEARCH_TERMS_CACHE, type NoteSearchResult } from "../src/core/note-search";
import { runWithReadScope } from "../src/core/read-scope";
import { SemanticIndex } from "../src/core/semantic";
import { setSearchSource } from "../src/core/vault-read";
import { parseQuery } from "../src/api/docs";
import { createHandlers, dispatch, type Handler, type HandlerResponse } from "../src/server/rest";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { expectNoLeak, MEALS, PANTRY, readRefusal, setupReadTokens, WEIGHT, type ReadSetup } from "./helpers/read-tokens";

const KITCHEN = `catalogs:
  main:
    schemas:
      public:
        tables:
          recipe:
            options: { filename: "{title}" }
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: title, type: string, required: true }
              - { name: age, type: string }
`;

/** A cookbook: Italian recipes (rows) and two free notes, one in English. */
const NOTES: Record<string, string> = {
  [METASTORE]: KITCHEN,
  "Datanotes/main/public/recipe/Pappa di verdure.md": "---\ntable: recipe\nid: 01a0f000-0000-7000-8000-000000000001\ntitle: Pappa di verdure\nage: 6 mesi\n---\n# Pappa\n\nCarote e patate, dai 6 mesi. Niente latte.\n",
  "Datanotes/main/public/recipe/Uovo strapazzato.md": "---\ntable: recipe\nid: 01a0f000-0000-7000-8000-000000000002\ntitle: Uovo strapazzato\nage: 8 mesi\n---\n# Ingredienti\n\nUn uovo intero e un goccio di latte.\n\n## Cottura\n\nL'uovo cuoce a fuoco basso.\n",
  "Datanotes/main/public/recipe/Crema di riso.md": "---\ntable: recipe\nid: 01a0f000-0000-7000-8000-000000000003\ntitle: Crema di riso\nage: 4 mesi\n---\nRiso e acqua. Mesi dopo: aggiungere olio.\n",
  "Notes/Breakfast.md": "# Breakfast\n\nScrambled egg on toast, one egg per person.\n",
  "Notes/Spesa.md": "Comprare latte, pane e uova. Più latte la prossima volta: latte, latte.\n",
  ".hidden/Uovo.md": "uovo uovo uovo\n",
  "Notes/Zucca.md": "Solo testo, nessuna parola del titolo.\n",
};

const paths = (r: NoteSearchResult) => r.results.map((h) => h.path);
const UOVO = "Datanotes/main/public/recipe/Uovo strapazzato.md";
const PAPPA = "Datanotes/main/public/recipe/Pappa di verdure.md";
const RISO = "Datanotes/main/public/recipe/Crema di riso.md";

/** Meaning vectors: one dimension per idea, each idea in several languages (an egg is an egg in English and Italian). */
const IDEAS = [["uovo", "uova", "egg"], ["latte", "milk"], ["riso", "rice"], ["carote", "verdure", "vegetable"], ["toast", "pane", "bread"]];
const meaningOf = (text: string) => IDEAS.map((words) => (words.some((w) => text.toLowerCase().includes(w)) ? 1 : 0) + 0.01);
const embeddings: Transport = async (req: HttpRequest) => {
  const { input } = JSON.parse(req.body) as { input: string[] };
  return { status: 200, text: JSON.stringify({ data: input.map((text, index) => ({ embedding: meaningOf(text), index })) }) };
};
const SEMANTIC_ON = { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake", semanticScope: "vault" } as const;

describe("searchTerms and parseSearchQuery", () => {
  it("folds case and accents, splits at anything but letters and digits, drops single letters and keeps single digits", () => {
    expect(searchTerms("L'Uovo à la coque, dai 6 MESI!")).toEqual(["uovo", "la", "coque", "dai", "6", "mesi"]);
    expect(searchTerms("Più caffè e tè")).toEqual(["piu", "caffe", "te"]);
    expect(searchTerms("Über Straße 12")).toEqual(["uber", "straße", "12"]);
  });

  it("reads the syntax of search_docs: phrases and +words required, -words excluded", () => {
    const q = parseSearchQuery(`"6 mesi" +uovo -latte -"olio di palma" pappa`);
    expect(q).toEqual({ text: "6 mesi uovo pappa", required: [["6", "mesi"], ["uovo"]], excluded: [["latte"], ["olio", "di", "palma"]] });
    // the same split as search_docs' (whose words are stemmed English: only the shape is compared)
    const d = parseQuery(`"6 mesi" +uovo -latte -"olio di palma" pappa`);
    expect([d.text, d.required.length, d.excluded.length]).toEqual([q.text, q.required.length, q.excluded.length]);
    expect(parseSearchQuery(`“curly” «angle» --vault "open`)).toEqual({ text: "curly angle --vault open", required: [["curly"], ["angle"], ["open"]], excluded: [] });
    expect(parseSearchQuery("+e -a")).toEqual({ text: "e", required: [], excluded: [] });
  });
});

describe("search by words (semantic search off)", () => {
  let v: DbVault;
  beforeAll(() => {
    v = createDbVault(NOTES);
  });
  const search = (query: string, more: Record<string, unknown> = {}) => searchVault(v.app, v.settings, { query, ...more });

  it("ranks by BM25: a rare word counts more, in the name more than in the body; every note with a word is there", async () => {
    const r = await search("uovo");
    expect(r.meaning).toBe("off");
    expect(r).not.toHaveProperty("meaning_error");
    expect(paths(r)).toEqual([UOVO]);
    expect(r.results[0]).toEqual({
      path: UOVO,
      table: "main.public.recipe",
      score: expect.any(Number),
      heading: "Ingredienti",
      snippet: "Un uovo intero e un goccio di latte. L'uovo cuoce a fuoco basso.",
      matched_by: ["words"],
    });
    // "uova" is another word (no stemming): the shopping list is found by it, not by "uovo"
    expect(paths(await search("uova"))).toEqual(["Notes/Spesa.md"]);
    // latte: four times in the shopping list, once in two recipes; once in a shorter body counts more
    const latte = await search("latte");
    expect(paths(latte)).toEqual(["Notes/Spesa.md", PAPPA, UOVO]);
    expect(latte.results[0]!.score).toBeGreaterThan(latte.results[1]!.score);
    expect(latte.results.map((h) => h.table ?? null)).toEqual([null, "main.public.recipe", "main.public.recipe"]);
    expect(latte.results[1]!.score).toBeGreaterThan(latte.results[2]!.score);
  });

  it("ranks a note with every word above one with some, and words next to each other higher", async () => {
    expect(paths(await search("uovo latte"))[0]).toBe(UOVO);
    // "6 mesi" next to each other in the pappa (body and front matter); the riso has "mesi" only
    const mesi = await search("6 mesi");
    expect(paths(mesi)).toEqual([PAPPA, RISO, UOVO]);
  });

  it("finds a word in the front matter's values, not in its keys, its id or its table", async () => {
    const r = await search("8");
    expect(paths(r)).toEqual([UOVO]);
    expect(r.results[0]).toMatchObject({ heading: "", snippet: "8 mesi" });
    expect(paths(await search("title"))).toEqual([]);
    expect(paths(await search("recipe"))).toEqual([]);
    expect(paths(await search("01a0f000"))).toEqual([]);
  });

  it("requires phrases and +words and leaves out -words", async () => {
    expect(paths(await search(`"6 mesi"`))).toEqual([PAPPA]);
    expect(paths(await search(`mesi +riso`))).toEqual([RISO]);
    expect(paths(await search(`latte -uovo`))).toEqual(["Notes/Spesa.md", PAPPA]);
    expect(paths(await search(`latte -"goccio di latte"`))).toEqual(["Notes/Spesa.md", PAPPA]);
    expect(paths(await search(`mesi -"6 mesi" -"8 mesi"`))).toEqual([RISO]);
  });

  it("filters by tables and folder, and leaves out dot-folders", async () => {
    expect(paths(await search("latte", { tables: ["recipe"] }))).toEqual([PAPPA, UOVO]);
    expect(paths(await search("latte", { tables: ["main.public.recipe"] }))).toEqual([PAPPA, UOVO]);
    expect(paths(await search("latte", { tables: ["nope"] }))).toEqual([]);
    expect(paths(await search("latte", { folder: "/Notes/" }))).toEqual(["Notes/Spesa.md"]);
    expect(paths(await search("uovo", { folder: ".hidden" }))).toEqual([]);
    expect(paths(await search("latte", { limit: 1 }))).toEqual(["Notes/Spesa.md"]);
    expect(paths(await search("latte", { limit: 0 }))).toHaveLength(1);
  });

  it("refuses a query with nothing to rank by", async () => {
    await expect(search("  ")).rejects.toThrow(`"query" is required`);
    await expect(search("-latte")).rejects.toThrow("search: the query has no words to look for");
    await expect(search("a e")).rejects.toThrow("search: the query has no words to look for");
  });

  it("snippets the front matter's value, or the beginning of a note found by its name only", async () => {
    expect((await search("strapazzato")).results[0]).toMatchObject({ path: UOVO, heading: "", snippet: "Uovo strapazzato" });
    expect((await search("zucca")).results[0]).toMatchObject({ path: "Notes/Zucca.md", heading: "", snippet: "Solo testo, nessuna parola del titolo." });
    // a match in a heading: the heading is no snippet, and no heading is above it
    expect((await search("breakfast")).results[0]).toMatchObject({ path: "Notes/Breakfast.md", heading: "", snippet: "Scrambled egg on toast, one egg per person." });
  });
});

describe("the host's index of words", () => {
  it("reads only the notes the index names for some word, and every note when it cannot answer or a word is too short", async () => {
    const v = createDbVault(NOTES);
    // the answer is the same, but for the scores: BM25's average length is then that of the notes read
    const shape = (r: NoteSearchResult) => r.results.map((h) => [h.path, h.matched_by, h.snippet]);
    const owner = shape(await searchVault(v.app, v.settings, { query: "latte uovo" }));
    const asked: string[][] = [];
    // an index that names a superset (a note without the words, a gone path, a hidden one) and is unsure of one
    setSearchSource(v.app, {
      candidates: (words) => {
        asked.push([...words]);
        return words[0] === "latte" ? { hits: ["Notes/Spesa.md", UOVO, RISO, "Gone.md", ".hidden/Uovo.md"], unsure: [PAPPA] } : { hits: [UOVO], unsure: [] };
      },
    });
    expect(shape(await searchVault(v.app, v.settings, { query: "latte uovo" }))).toEqual(owner);
    expect(asked).toEqual([["latte"], ["uovo"]]);
    // a word of one or two letters cannot be looked up: every note is read
    asked.length = 0;
    expect(paths(await searchVault(v.app, v.settings, { query: "6 mesi" }))).toEqual([PAPPA, RISO, UOVO]);
    expect(asked).toEqual([]);
    // an index that cannot answer now: every note is read
    setSearchSource(v.app, { candidates: () => null });
    expect(shape(await searchVault(v.app, v.settings, { query: "latte uovo" }))).toEqual(owner);
    setSearchSource(v.app, null);
  });

  it("keeps each note's terms per version within the budget, and forgets the notes gone", async () => {
    const v = createDbVault(NOTES);
    await searchVault(v.app, v.settings, { query: "latte" });
    expect(searchTermsStats(v.app).notes).toBe(6);
    v.write("Notes/Spesa.md", "Comprare uova.\n");
    expect(paths(await searchVault(v.app, v.settings, { query: "latte" }))).toEqual([PAPPA, UOVO]);
    v.remove("Notes/Breakfast.md");
    await searchVault(v.app, v.settings, { query: "latte" });
    expect(searchTermsStats(v.app).notes).toBe(5);
    const before = SEARCH_TERMS_CACHE.maxTerms;
    SEARCH_TERMS_CACHE.maxTerms = 0;
    try {
      const w = createDbVault(NOTES);
      expect(paths(await searchVault(w.app, w.settings, { query: "latte" }))).toEqual(["Notes/Spesa.md", PAPPA, UOVO]);
      expect(searchTermsStats(w.app)).toEqual({ notes: 0, terms: 0 });
    } finally {
      SEARCH_TERMS_CACHE.maxTerms = before;
    }
    expect(searchTermsStats(createDbVault({}).app)).toEqual({ notes: 0, terms: 0 });
  });
});

describe("search by words and meaning (semantic search on)", () => {
  let v: DbVault;
  let sem: SemanticIndex;
  let call: (args: Record<string, unknown>) => Promise<HandlerResponse>;
  beforeAll(async () => {
    v = createDbVault(NOTES, SEMANTIC_ON);
    sem = new SemanticIndex(v.app, () => v.settings, embeddings);
    await sem.sync();
    const routes: Record<string, Handler> = createHandlers(v.app, () => v.settings, async () => {}, sem);
    call = (args) => dispatch("/operations/search/", routes["/operations/search/"]!, args);
  });

  it("fuses both rankings: a note found only by meaning is there, and matched_by says how each was found", async () => {
    const r = await searchVault(v.app, v.settings, { query: "egg" }, sem);
    expect(r.meaning).toBe("on");
    const by = Object.fromEntries(r.results.map((h) => [h.path, h.matched_by]));
    // the English note has the word; the Italian ones mean the same
    expect(by["Notes/Breakfast.md"]).toEqual(["words", "meaning"]);
    expect(by[UOVO]).toEqual(["meaning"]);
    expect(by["Notes/Spesa.md"]).toEqual(["meaning"]);
    expect(r.results[0]!.path).toBe("Notes/Breakfast.md");
    // a meaning-only hit: the semantic index's passage
    expect(r.results.find((h) => h.path === UOVO)).toMatchObject({ table: "main.public.recipe", heading: expect.any(String), snippet: expect.stringContaining("uovo") });
    // RRF scores: 1/(60+1) + 1/(60+rank by meaning)
    expect(r.results[0]!.score).toBeGreaterThan(1 / 61);
    expect(r.results[0]!.score).toBeLessThanOrEqual(Math.round((2 / 61) * 10_000) / 10_000);
  });

  it("filters the meaning ranking by the required and excluded words, the tables, the folder and min_score", async () => {
    // every note means a little of everything here (the fake vectors): the words decide which stay
    const excluded = paths(await searchVault(v.app, v.settings, { query: "egg -uovo -egg" }, sem));
    expect(excluded).toContain("Notes/Spesa.md");
    expect(excluded).not.toContain(UOVO);
    expect(excluded).not.toContain("Notes/Breakfast.md");
    expect(paths(await searchVault(v.app, v.settings, { query: "egg +latte" }, sem)).sort()).toEqual(["Notes/Spesa.md", PAPPA, UOVO].sort());
    expect(paths(await searchVault(v.app, v.settings, { query: "egg", tables: ["recipe"] }, sem)).every((p) => p.startsWith("Datanotes/main/public/recipe/"))).toBe(true);
    expect(paths(await searchVault(v.app, v.settings, { query: "egg", folder: "Notes" }, sem)).sort()).toEqual(["Notes/Breakfast.md", "Notes/Spesa.md", "Notes/Zucca.md"]);
    // no passage is this similar: the meaning ranking is empty
    const strict = await searchVault(v.app, v.settings, { query: "egg", minScore: 1.01 }, sem);
    expect(strict.results.every((h) => h.matched_by.includes("words"))).toBe(true);
    expect(paths(strict)).toEqual(["Notes/Breakfast.md"]);
  });

  it("answers over the route, as the catalogue says", async () => {
    const r = await call({ query: "latte", limit: 2, tables: ["recipe"], folder: "Datanotes", min_score: 0 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ query: "latte", meaning: "on" });
    expect(paths(r.json as NoteSearchResult)).toHaveLength(2);
    const bad = await call({ query: "-latte" });
    expect(bad).toEqual({
      status: 400,
      json: {
        error: "search: the query has no words to look for",
        hint: `Give at least one word to rank by: "-word" only leaves notes out, and single letters are not searched. Example: search({query: "uovo -latte"}).`,
        docs: "https://datanotes.dev/guides/search/hybrid.md#search-by-words-and-meaning",
      },
    });
  });

  it("falls back to the words' ranking when the embedding provider fails, and says why", async () => {
    const w = createDbVault(NOTES, SEMANTIC_ON);
    const down = new SemanticIndex(w.app, () => w.settings, async () => ({ status: 503, text: "busy" }));
    const r = await searchVault(w.app, w.settings, { query: "latte" }, down);
    expect(r.meaning).toBe("failed");
    expect(r.meaning_error).toMatch(/503/);
    expect(paths(r)).toEqual(["Notes/Spesa.md", PAPPA, UOVO]);
    expect(r.results.every((h) => h.matched_by.join() === "words")).toBe(true);
  });

  it("ranks by words alone while semantic search is off in the settings, even with an index", async () => {
    const w = createDbVault(NOTES);
    const off = new SemanticIndex(w.app, () => w.settings, embeddings);
    expect((await searchVault(w.app, w.settings, { query: "egg" }, off)).meaning).toBe("off");
  });
});

describe("search and the read scope of a named token", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setupReadTokens();
  });

  it("finds a restricted token only the notes it may read, over the API", async () => {
    const r = await s.op("cook", "search", { query: "eggs" });
    expect(r.status).toBe(200);
    expect(paths(r.json as NoteSearchResult)).toEqual([s.paths.eggs, s.paths.pasta]);
    expectNoLeak(r);
    // "weigh" finds eggs: its link to a weigh-in shows as text (a link's text stays visible)
    expect(paths((await s.op("cook", "search", { query: "weigh" })).json as NoteSearchResult)).toEqual([s.paths.eggs]);
    for (const query of ["ZZSECRETHEALTH", "ZZSECRETDIARY", "evening", "79", "today"]) {
      const hidden = await s.op("cook", "search", { query });
      expect(hidden).toEqual({ status: 200, json: { query, results: [], meaning: "off" } });
    }
    expect(paths((await s.op("owner", "search", { query: "eggs" })).json as NoteSearchResult)).toContain(s.paths.diary);
    expect(paths((await s.op("nurse", "search", { query: "ZZSECRETHEALTH" })).json as NoteSearchResult).sort()).toEqual([...s.paths.weight].sort());
    expect(await s.op("blind", "search", { query: "eggs" })).toEqual({ status: 200, json: { query: "eggs", results: [], meaning: "off" } });
  });

  it("refuses a table named exactly that the token may not read, in the guard and in the engine", async () => {
    expect(await s.op("cook", "search", { query: "eggs", tables: ["weight"] })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "search", { query: "eggs", tables: [WEIGHT] })).toEqual(readRefusal("cook", WEIGHT));
    await expect(runWithReadScope({ token: "cook", patterns: ["personal.food.*"] }, () => searchVault(s.v.app, s.v.settings, { query: "eggs", tables: ["health.weight"] }))).rejects.toThrow(
      `token cook may not read ${WEIGHT}`,
    );
    const meals = await s.op("cook", "search", { query: "eggs", tables: ["meals", "personal.*"] });
    expect(paths(meals.json as NoteSearchResult)).toEqual([s.paths.pasta]);
    expect((meals.json as NoteSearchResult).results[0]!.table).toBe(MEALS);
  });

  it("gives a token without read or with read * the owner's answer", async () => {
    for (const t of ["legacy", "star"] as const) {
      for (const query of ["eggs", "ZZSECRETHEALTH diary"]) expect(await s.op(t, "search", { query })).toEqual(await s.op("owner", "search", { query }));
    }
    expect((await s.op("owner", "search", { query: "eggs", tables: ["pantry"] })).json).toMatchObject({ results: [{ path: s.paths.eggs, table: PANTRY }] });
  });

  it("runs as the actor of the request, through the guard", async () => {
    const r = await runWithActor({ auth: "cook", harness: "cook" }, () => s.as("cook", "/operations/search/", { query: "flour" }));
    expect(paths(r.json as NoteSearchResult)).toEqual([s.paths.flour, s.paths.pasta]);
  });
});
