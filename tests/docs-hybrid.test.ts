/**
 * search_docs' query syntax and hybrid search (src/api/docs.ts, src/api/mcp.ts): required phrases
 * and +terms, excluded -terms, the Reciprocal Rank Fusion of the ranking by words with the
 * engine's ranking by meaning, and the fallback to words alone when the engine has none to give
 * (semantic search off, an older engine, an index still building, other docs, no answer). The
 * engine is a fake transport here; tests/runtime-edges.test.ts runs a real one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DatanotesClient, type HttpRequest, type Transport } from "../src/api/client";
import { DocsError, DocsLibrary, FUSION_DEPTH, parseQuery, RRF_K } from "../src/api/docs";
import { callDocsTool, SEMANTIC_DOCS_RETRY_MS, SEMANTIC_DOCS_TIMEOUT_MS } from "../src/api/mcp";
import { docsFixture } from "./helpers/docs-fixture";

const temp: string[] = [];
afterAll(() => {
  for (const d of temp) fs.rmSync(d, { recursive: true, force: true });
});

/** A folder of docs made of these pages (with index.md and llms.txt). */
function library(pages: Record<string, string>): DocsLibrary {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-docs-hybrid-"));
  temp.push(dir);
  const files: Record<string, string> = { "index.md": "# Home\n\n> The home page.\n\nNothing here.\n", "llms.txt": "# Docs\n", ...pages };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return new DocsLibrary(dir);
}

const docs = library({
  "guides/travel.md": [
    "# Travel",
    "",
    "## Time travel",
    "",
    "Read a table as it was, by time travel.",
    "",
    "## Travel time",
    "",
    "Time spent on a long travel.",
    "",
    "## A view in SQL",
    "",
    "A view is a stored query, as in SQL.",
    "",
    "## A view",
    "",
    "A view keeps a query under a name.",
    "",
  ].join("\n"),
  "zoo/sea.md": "# Sea\n\n## Sea lion\n\nA sea lion swims.\n\n## Lion by the sea\n\nA lion walks by the sea.\n",
  "zoo/animals.md": [
    "# Animals",
    "",
    "## Short quokka",
    "",
    "A quokka lives here.",
    "",
    "## Long quokka",
    "",
    `A quokka lives here too, ${Array.from({ length: 200 }, (_, i) => `filler${i}`).join(" ")}.`,
    "",
    "## Many quokkas",
    "",
    `${"quokka ".repeat(20)}and more.`,
    "",
    "## Marsupial",
    "",
    "A small animal of Rottnest island.",
    "",
  ].join("\n"),
  "list/items.md": ["# Items", "", ...Array.from({ length: 60 }, (_, i) => `## Item ${i}\n\nThing number ${i}.\n`)].join("\n"),
});

const paths = (hits: { path: string }[]) => hits.map((h) => h.path.replace(/^[a-z]+\/[a-z]+#/, ""));

describe("the query syntax", () => {
  it("a quoted phrase and a +term are required, a -term excluded; the other words only rank", () => {
    expect(parseQuery('"time travel" +view -sql')).toEqual({ text: "time travel view", required: [["time", "travel"], ["view"]], excluded: [["sql"]] });
    expect(parseQuery("undo an agent's changes")).toEqual({ text: "undo an agent's changes", required: [], excluded: [] });
  });

  it("curly quotes, a quote left open, -\"phrases\", --flags, a lone dash and words that say nothing", () => {
    expect(parseQuery('“roll back” -"time travel" --vault +the - x')).toEqual({ text: "roll back --vault the - x", required: [["roll", "back"]], excluded: [["time", "travel"]] });
    expect(parseQuery('"time travel')).toEqual({ text: "time travel", required: [["time", "travel"]], excluded: [] });
    expect(parseQuery('views -"" +-x')).toEqual({ text: "views +-x", required: [], excluded: [] });
  });
});

describe("search_docs by words, with required and excluded words", () => {
  it("a phrase must appear with its words in a row; without quotes, the words anywhere", () => {
    expect(paths(docs.search('"time travel"', 50))).toEqual(["time-travel"]);
    expect(paths(docs.search("“time travel", 50))).toEqual(["time-travel"]);
    expect(paths(docs.search('"sea lion"', 50))).toEqual(["sea-lion"]);
    expect(paths(docs.search("sea lion", 50))).toEqual(["sea-lion", "lion-by-the-sea", "zoo/sea"]);
  });

  it("a +term must appear, a -term must not (a word or a phrase, in any form, in the heading or the text)", () => {
    expect(paths(docs.search("+view query", 50))).toEqual(["a-view-in-sql", "a-view"]);
    expect(paths(docs.search("views -sql", 50))).toEqual(["a-view"]);
    expect(paths(docs.search('view -"stored query"', 50))).toEqual(["a-view"]);
    expect(docs.search('"time travel" -table')).toEqual([]);
    // the words that only rank are what BM25 reads: the same scores as without the syntax
    expect(docs.search('"time travel"', 1)[0]!.score).toBe(docs.search("time travel", 1)[0]!.score);
  });

  it("excluded words alone leave nothing to look for", () => {
    let e: unknown;
    try {
      docs.search("-sql");
    } catch (err) {
      e = err;
    }
    expect(e).toBeInstanceOf(DocsError);
    expect((e as DocsError).code).toBe("bad_input");
  });

  it("every hit says it matched by words", () => {
    expect(docs.search("quokka").map((h) => h.signals)).toEqual([["keyword"], ["keyword"], ["keyword"]]);
  });
});

describe("hybrid search: Reciprocal Rank Fusion of the two rankings", () => {
  it("sums 1 / (60 + rank) over the rankings; ties go to the better rank by words", () => {
    expect(RRF_K).toBe(60);
    expect(paths(docs.search("quokka", 50))).toEqual(["many-quokkas", "short-quokka", "long-quokka"]);
    const semantic = [{ path: "zoo/animals#long-quokka" }, { path: "zoo/animals#marsupial" }, { path: "zoo/animals#many-quokkas" }];
    const hits = docs.hybrid("quokka", semantic, 10);
    expect(hits.map((h) => [h.path.replace("zoo/animals#", ""), h.score, h.signals])).toEqual([
      ["many-quokkas", Math.round((1 / 61 + 1 / 63) * 10_000) / 10_000, ["keyword", "semantic"]],
      ["long-quokka", Math.round((1 / 63 + 1 / 61) * 10_000) / 10_000, ["keyword", "semantic"]],
      ["short-quokka", Math.round((1 / 62) * 10_000) / 10_000, ["keyword"]],
      ["marsupial", Math.round((1 / 62) * 10_000) / 10_000, ["semantic"]],
    ]);
    // a section found by meaning alone gets an excerpt from its start
    expect(hits[3]).toMatchObject({ page: "Animals", section: "Marsupial", excerpt: "A small animal of Rottnest island." });
  });

  it("agreement wins: a section both rankings place second beats the first of one", () => {
    const hits = docs.hybrid("quokka", [{ path: "zoo/animals#marsupial" }, { path: "zoo/animals#short-quokka" }], 3);
    expect(paths(hits)).toEqual(["short-quokka", "many-quokkas", "marsupial"]);
  });

  it("the required and excluded words filter the ranking by meaning too; sections these docs lack are left out", () => {
    const semantic = [{ path: "guides/travel#a-view-in-sql" }, { path: "guides/gone#x" }, { path: "guides/travel#a-view" }, { path: "guides/travel#a-view" }, { path: "zoo/animals#marsupial" }];
    expect(paths(docs.hybrid("views -sql", semantic, 50))).toEqual(["a-view", "marsupial"]);
    expect(paths(docs.hybrid("+view", semantic, 50))).toEqual(["a-view-in-sql", "a-view"]);
    expect(docs.hybrid('"time travel" -table', semantic)).toEqual([]);
  });

  it("fuses the first FUSION_DEPTH sections of each ranking", () => {
    expect(FUSION_DEPTH).toBe(50);
    const semantic = Array.from({ length: 60 }, (_, i) => ({ path: `list/items#item-${i}` }));
    const hits = docs.hybrid("zebra", semantic, 50);
    expect(hits).toHaveLength(50);
    expect(hits.at(-1)!.path).toBe("list/items#item-49");
    expect(hits.every((h) => h.signals.join() === "semantic")).toBe(true);
  });
});

describe("the sections the engine embeds, and the docs' version", () => {
  it("each section with its page and heading, prose then code; the same version for the same docs", () => {
    const lib = new DocsLibrary(docsFixture());
    temp.push(lib.dir!);
    const sections = lib.sections();
    expect(sections).toBe(lib.sections());
    expect(sections.find((s) => s.path === "examples/queries#compare-dates")).toEqual({
      path: "examples/queries#compare-dates",
      page: "Querying rows",
      section: "Compare dates",
      text: "Querying rows › Compare dates\n\nDates compare as text: give them as YYYY-MM-DD.\n\n## Not a heading, inside code",
    });
    expect(sections.find((s) => s.path === "index")).toMatchObject({ section: "", text: "Datanotes\n\n> The engine of your second brain: Markdown notes as database tables.\n\nWelcome to the docs of the engine." });
    expect(lib.version()).toMatch(/^[0-9a-f]{16}$/);
    expect(new DocsLibrary(lib.dir).version()).toBe(lib.version());
    // a changed page: another version
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "dn-docs-hybrid-"));
    temp.push(copy);
    fs.cpSync(lib.dir!, copy, { recursive: true });
    fs.appendFileSync(path.join(copy, "examples", "queries.md"), "\nOne more line.\n");
    expect(new DocsLibrary(copy).version()).not.toBe(lib.version());
  });
});

describe("search_docs with an engine: hybrid when it ranks by meaning, by words alone otherwise", () => {
  let n = 0;
  /** A fake engine at an address of its own: `answer` gives the reply to the docs route. */
  function engine(answer: (req: HttpRequest) => Promise<{ status: number; text: string }> | { status: number; text: string }) {
    const requests: HttpRequest[] = [];
    const transport: Transport = async (req) => {
      requests.push(req);
      return answer(req);
    };
    return { requests, client: new DatanotesClient({ url: `http://engine-${++n}.test`, token: "t", transport }) };
  }
  const ranking = (version: string, ready = true) => ({ status: 200, text: JSON.stringify({ query: "x", version, ready, sections: 3, embedded: 3, results: [{ path: "guides/travel#a-view", score: 0.9 }, { path: "zoo/animals#marsupial", score: 0.5 }] }) });
  const textOf = (r: { content: { text: string }[] }) => r.content[0]!.text;
  const byWords = async (query: string) => textOf(await callDocsTool("search_docs", { query, limit: 3 }, { docs }));

  it("fuses the engine's ranking: each hit says what matched", async () => {
    const e = engine(() => ranking(docs.version()));
    const out = textOf(await callDocsTool("search_docs", { query: "+view -sql query", limit: 3 }, { docs, client: e.client, actor: { harness: "test", tool: "search_docs" } }));
    expect(out).toBe(
      [
        "guides/travel#a-view — Travel › A view (keyword, semantic)",
        "  A view keeps a query under a name.",
        "Ranked by words and by meaning (hybrid search). Read one with read_docs(\"<path>\").",
      ].join("\n"),
    );
    expect(e.requests).toHaveLength(1);
    expect(e.requests[0]).toMatchObject({ url: `${e.client.url}/datanotes/manual/search/`, method: "POST" });
    expect(JSON.parse(e.requests[0]!.body!)).toEqual({ query: "view query", limit: FUSION_DEPTH });
    expect(JSON.parse(e.requests[0]!.headers["X-Datanotes-Actor"]!)).toEqual({ harness: "test", tool: "search_docs" });
    const both = textOf(await callDocsTool("search_docs", { query: "view" }, { docs, client: e.client }));
    expect(both.split("\n").filter((l) => !l.startsWith(" "))).toEqual([
      "guides/travel#a-view — Travel › A view (keyword, semantic)",
      "guides/travel#a-view-in-sql — Travel › A view in SQL (keyword)",
      "zoo/animals#marsupial — Animals › Marsupial (semantic)",
      "Ranked by words and by meaning (hybrid search). Read one with read_docs(\"<path>\").",
    ]);
  });

  it("by words alone while the index builds, when the engine ships other docs, has semantic search off, is older or answers no JSON", async () => {
    const want = await byWords("view");
    expect(want).toMatch(/^guides\/travel#a-view-in-sql — Travel › A view in SQL\n/);
    const answers = [
      ranking(docs.version(), false),
      ranking("another-version"),
      { status: 400, text: JSON.stringify({ error: "semantic search is off" }) },
      { status: 404, text: JSON.stringify({ error: "unknown route" }) },
      { status: 200, text: "not json" },
    ];
    for (const answer of answers) {
      const e = engine(() => answer);
      expect(textOf(await callDocsTool("search_docs", { query: "view", limit: 3 }, { docs, client: e.client }))).toBe(want);
      // asked again at the next search: turning semantic search on takes effect at once
      await callDocsTool("search_docs", { query: "view", limit: 3 }, { docs, client: e.client });
      expect(e.requests).toHaveLength(2);
    }
  });

  it("an engine that does not answer, or not in time, is left alone for a while", async () => {
    expect([SEMANTIC_DOCS_TIMEOUT_MS, SEMANTIC_DOCS_RETRY_MS]).toEqual([10_000, 60_000]);
    const want = await byWords("view");
    const down = engine(() => Promise.reject(new Error("connect ECONNREFUSED")));
    expect(textOf(await callDocsTool("search_docs", { query: "view", limit: 3 }, { docs, client: down.client }))).toBe(want);
    expect(textOf(await callDocsTool("search_docs", { query: "view", limit: 3 }, { docs, client: down.client }))).toBe(want);
    expect(down.requests).toHaveLength(1);
    const slow = engine(() => new Promise((resolve) => setTimeout(() => resolve(ranking(docs.version())), 200)));
    expect(textOf(await callDocsTool("search_docs", { query: "view", limit: 3 }, { docs, client: slow.client, semanticTimeoutMs: 10 }))).toBe(want);
    expect(textOf(await callDocsTool("search_docs", { query: "view", limit: 3 }, { docs, client: slow.client }))).toBe(want);
    expect(slow.requests).toHaveLength(1);
  });

  it("a query with no words is refused before the engine is asked; no match says what to loosen", async () => {
    const e = engine(() => ranking(docs.version()));
    const refused = await callDocsTool("search_docs", { query: "-sql" }, { docs, client: e.client });
    expect(refused.isError).toBe(true);
    expect(e.requests).toHaveLength(0);
    expect(textOf(await callDocsTool("search_docs", { query: '"time travel" -table' }, { docs, client: e.client }))).toBe(
      'No section matches ""time travel" -table". A section must hold every quoted phrase and +term, and none of the -terms: try fewer of them, other words, or list_docs to see the pages.',
    );
    expect(await byWords("zebra")).toBe('No section matches "zebra". Try other words, or list_docs to see the pages.');
  });
});
