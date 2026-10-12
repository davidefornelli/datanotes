/**
 * The docs of this version, read offline (src/api/docs.ts) and their MCP tools in `datanotes/mcp`
 * (list_docs, read_docs, search_docs: src/api/mcp.ts), on a small folder of docs
 * (helpers/docs-fixture.ts). tests/mcp-docs.test.ts calls the tools over the stdio MCP server,
 * tests/mcp-bundle.test.ts on the built command, tests/http-server.test.ts over GET /datanotes/manual/.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { docsRef, DocsError, DocsLibrary, findDocsDir, OFFLINE_DOCS, openDocs, queryTerms, READ_DOCS_MAX, SEARCH_SYNONYMS, slug, stem, STOP_WORDS, SYNONYM_WEIGHT, tokenize } from "../src/api/docs";
import { callDocsTool, DOCS_TOOL_NAMES, docsTools, isDocsTool } from "../src/api/mcp";
import { docsFixture } from "./helpers/docs-fixture";
import { guidedTextOf, hintOfText } from "./helpers/guidance";

const temp: string[] = [];
const fixture = () => {
  const d = docsFixture();
  temp.push(d);
  return d;
};
afterAll(() => {
  for (const d of temp) fs.rmSync(d, { recursive: true, force: true });
});

const dir = fixture();
const docs = new DocsLibrary(dir);

/** The error a call throws. */
function errorOf(fn: () => unknown): DocsError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DocsError);
    return e as DocsError;
  }
  throw new Error("no error");
}

const textOf = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("where the docs are", () => {
  it("DATANOTES_DOCS_DIR, else dist/docs of the package: next to the bundle, above dist/api, or in a checkout", () => {
    expect(findDocsDir({ DATANOTES_DOCS_DIR: dir })).toBe(path.resolve(dir));
    expect(findDocsDir({ DATANOTES_DOCS_DIR: os.tmpdir() })).toBeNull();
    const root = fixture();
    const nested = path.join(root, "dist", "docs");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.cpSync(dir, nested, { recursive: true });
    expect(findDocsDir({}, path.join(root, "src", "api"))).toBe(nested); // a checkout: src/api -> dist/docs
    expect(findDocsDir({}, path.join(root, "dist"))).toBe(nested); // dist/datanotes.cjs -> dist/docs
    expect(findDocsDir({}, path.join(root, "dist", "api"))).toBe(nested); // dist/api/mcp.js -> dist/docs
    expect(findDocsDir({}, os.tmpdir())).toBeNull();
    // the package's own (built or not in this checkout)
    const own = findDocsDir();
    expect(own === null || fs.existsSync(path.join(own, "index.md"))).toBe(true);
  });

  it("opens each folder once", () => {
    expect(openDocs(dir)).toBe(openDocs(dir));
    expect(openDocs()).toBe(openDocs(findDocsDir()));
  });

  it("says how to get them when they are not there", () => {
    for (const lib of [new DocsLibrary(null), new DocsLibrary(path.join(os.tmpdir(), "no-docs-here"))]) {
      const e = errorOf(() => lib.list());
      expect(e.code).toBe("missing");
      expect(e.message).toMatch(/^the Datanotes docs are not in this installation/);
      expect(e.hint).toContain("cd docs && npm ci && npm run build");
      expect(e.hint).toContain("DATANOTES_DOCS_DIR");
      expect(e.docs).toBe(OFFLINE_DOCS);
    }
    expect(errorOf(() => new DocsLibrary(path.join(os.tmpdir(), "no-docs-here")).read("index")).message).toContain("no-docs-here");
  });
});

describe("pages and sections", () => {
  it("names a page by its path on the site, from any form of its address", () => {
    expect(docsRef("examples/queries")).toEqual({ page: "examples/queries", anchor: null });
    expect(docsRef(" /examples/queries.md#compare-values-with-operators ")).toEqual({ page: "examples/queries", anchor: "compare-values-with-operators" });
    expect(docsRef("https://datanotes.dev/examples/queries/#x")).toEqual({ page: "examples/queries", anchor: "x" });
    expect(docsRef("https://www.datanotes.dev/")).toEqual({ page: "index", anchor: null });
    expect(docsRef("#")).toEqual({ page: "index", anchor: null });
    expect(slug("Limit link targets with `ref_by` and `ref_where`")).toBe("limit-link-targets-with-ref_by-and-ref_where");
    expect(slug("Change a column’s attributes")).toBe("change-a-columns-attributes");
  });

  it("lists the pages with their titles and descriptions, under a prefix when given", () => {
    expect(docs.list().map((p) => p.path)).toEqual([
      "api/operations/create_webhook",
      "examples",
      "examples/queries",
      "guides/tokens",
      "index",
      "misc/untitled",
      "reference/tools",
      "start/quick-start",
    ]);
    expect(docs.list("examples/")).toEqual([{ path: "examples/queries", title: "Querying rows", description: "Read rows with select_rows: filters, operators and views." }]);
    expect(docs.list("examples").map((p) => p.path)).toEqual(["examples", "examples/queries"]);
    expect(docs.list("guides/tokens")).toEqual([{ path: "guides/tokens", title: "Give each program its own token", description: "" }]);
    // a page without a title line is named by its path
    expect(docs.list("misc/")[0]!.title).toBe("misc/untitled");
  });

  it("an unknown prefix: the closest folder, and every folder", () => {
    const e = errorOf(() => docs.list("exampels/"));
    expect([e.message, e.code]).toEqual(['no docs page under "exampels/"', "not_found"]);
    expect(e.hint).toBe('Did you mean "examples"? The folders are api/, examples/, guides/, misc/, reference/, start/; list_docs without a prefix lists every page.');
    expect(errorOf(() => docs.list("zzzzzzzzz")).hint).toMatch(/^The folders are /);
  });

  it("reads a page whole, or one section with its subsections (code blocks hold no headings)", () => {
    expect(docs.read("examples/queries.md")).toBe(fs.readFileSync(path.join(dir, "examples", "queries.md"), "utf8"));
    const section = docs.read("examples/queries#compare-values-with-operators");
    expect(section).toMatch(/^## Compare values with operators\n/);
    expect(section).toContain("### Compare dates");
    expect(section).toContain("## Not a heading, inside code");
    expect(section).not.toContain("second section");
    // the second heading of the same name gets -1, as on the site
    expect(docs.read("examples/queries", { section: "#compare-values-with-operators-1" })).toMatch(/^## Compare values with operators\n\nA second section/);
    expect(docs.read("examples/queries", { section: "compare-dates" })).toMatch(/^### Compare dates\n/);
    // Windows line endings are read as \n
    expect(docs.read("guides/tokens#choose-what-a-token-can-do")).toBe("## Choose what a token can do\n\nThe permissions of a named token: read, write, ddl.\n");
    expect(docs.text("https://datanotes.dev/examples/queries/#store-a-query-as-a-view").ref).toBe("examples/queries#store-a-query-as-a-view");
  });

  it("an unknown page: the closest pages (by path, else by the last part), list_docs and search_docs", () => {
    const e = errorOf(() => docs.read("examples/querys"));
    expect([e.message, e.code, e.docs]).toEqual(['no docs page "examples/querys"', "not_found", OFFLINE_DOCS]);
    expect(e.hint).toBe('Did you mean "examples/queries"? list_docs lists the pages (list_docs("guides/") those of a folder); search_docs finds the sections on a topic.');
    expect(errorOf(() => docs.read("guides/queries")).hint).toMatch(/^Did you mean "examples\/queries"\?/);
    // the same folder first, by its first letters too; a page in a sub-folder; the folder's own page last
    expect(errorOf(() => docs.read("examples/query")).hint).toMatch(/^Did you mean "examples\/queries"\?/);
    expect(errorOf(() => docs.read("api/create_webhok")).hint).toMatch(/^Did you mean "api\/operations\/create_webhook"\?/);
    expect(errorOf(() => docs.read("examples/zzzzzzzzzzzz")).hint).toMatch(/^Did you mean "examples"\?/);
    expect(errorOf(() => docs.read("zzzzzzzzzzzz")).hint).toMatch(/^list_docs lists the pages/);
  });

  it("an unknown section: the closest ones, the page's sections, and how to read the whole page", () => {
    const e = errorOf(() => docs.read("examples/queries#compare-values"));
    expect(e.message).toBe('examples/queries has no section "#compare-values"');
    expect(e.hint).toBe(
      'Did you mean "examples/queries#compare-values-with-operators"? Its sections: compare-values-with-operators, compare-dates, compare-values-with-operators-1, store-a-query-as-a-view. read_docs("examples/queries") reads the whole page.',
    );
    expect(errorOf(() => docs.read("examples/queries#zzzzzzzzzzzz")).hint).toMatch(/^Its sections: /);
    expect(errorOf(() => docs.read("start/quick-start#install")).hint).toBe('It has no sections. read_docs("start/quick-start") reads the whole page.');
    // more than 25 sections: the list is cut
    expect(errorOf(() => docs.read("reference/tools#nope")).hint).toContain("… (60 in all)");
  });
});

describe("the size cap", () => {
  const tools = fs.readFileSync(path.join(dir, "reference", "tools.md"), "utf8");

  it("cuts a long page before a heading, and says how to read on: the offset, or the sections that follow", () => {
    expect(tools.length).toBeGreaterThan(READ_DOCS_MAX);
    const first = docs.read("reference/tools");
    const cut = Number(/\[Cut at character (\d+) of (\d+)\./.exec(first)![1]);
    expect(cut).toBeLessThanOrEqual(READ_DOCS_MAX);
    expect(tools.slice(cut)).toMatch(/^## `op_\d+`/);
    const next = /^## `(op_\d+)`/.exec(tools.slice(cut))![1];
    expect(first).toContain(`Read on with read_docs("reference/tools", offset: ${cut}). One section at a time: read_docs("reference/tools#${next}"); the sections after this point: ${next}, `);
    expect(first.slice(0, first.indexOf("\n[Cut at"))).toBe(tools.slice(0, cut));
    // read on, to the end
    let offset = cut;
    let all = tools.slice(0, cut);
    for (;;) {
      const part = docs.read("reference/tools", { offset });
      const m = /\n\[Cut at character (\d+) of \d+\./.exec(part);
      if (!m) {
        all += part;
        break;
      }
      all += part.slice(0, m.index);
      offset = Number(m[1]);
    }
    expect(all).toBe(tools);
  });

  it("cuts at the end of a line when no heading fits, mid-line when no line ends; a smaller cap is 1000 at least", () => {
    const long = new DocsLibrary(fixture());
    fs.writeFileSync(path.join(long.dir!, "misc", "long.md"), `# Long\n\n${"x".repeat(99)}\n`.repeat(30) + "y".repeat(3000));
    const lines = long.read("misc/long", { max: 1500 });
    const cut = Number(/\[Cut at character (\d+) of/.exec(lines)![1]);
    expect(lines.slice(0, cut).endsWith("\n")).toBe(true);
    expect(lines).not.toContain("One section at a time");
    const start = long.text("misc/long").text.indexOf("y");
    const mid = long.read("misc/long", { offset: start, max: 10 });
    expect(mid).toMatch(new RegExp(`^y{1000}\\n\\[Cut at character ${start + 1000} of`));
  });

  it("an offset past the end is an error", () => {
    const e = errorOf(() => docs.read("index", { offset: 10_000 }));
    expect([e.message, e.code, e.hint]).toEqual([`offset 10000 is past the end of index (${fs.readFileSync(path.join(dir, "index.md"), "utf8").length} characters)`, "bad_input", 'Read it from the start: read_docs("index").']);
    expect(docs.read("index", { offset: -5 })).toMatch(/^# Datanotes/);
  });
});

describe("search", () => {
  it("finds the sections on a topic, best first: headings count most, then the page's title, then the text", () => {
    const hits = docs.search("compare values operators");
    expect(hits[0]).toMatchObject({ path: "examples/queries#compare-values-with-operators", page: "Querying rows", section: "Compare values with operators" });
    expect(hits[0]!.excerpt).toContain("operators");
    expect(hits.every((h, i) => i === 0 || h.score <= hits[i - 1]!.score)).toBe(true);
    // a page's introduction is the page itself
    expect(docs.search("engine second brain")[0]).toMatchObject({ path: "index", section: "" });
  });

  it("the HTTP reference and sentence-long titles rank after the guides", () => {
    const hits = docs.search("webhook");
    expect(hits.map((h) => h.path)).toEqual(["api/operations/create_webhook"]);
    expect(docs.search("named token permissions")[0]!.path).toBe("guides/tokens#choose-what-a-token-can-do");
  });

  it("an excerpt around the words, cut with …; none when only the title matches", () => {
    const op = docs.search("op_30")[0]!;
    expect(op.path).toBe("reference/tools#op_30");
    expect(op.excerpt).toMatch(/^Operation 30 reads.+…$/);
    const later = docs.search("mark5")[0]!;
    expect(later).toMatchObject({ path: "reference/tools#op_5", excerpt: expect.stringMatching(/^….+Its marker is mark5.$/) });
    expect(docs.search("misc/untitled")[0]).toMatchObject({ path: "misc/untitled", excerpt: "A page without a title line." });
    expect(docs.search("untitled")[0]).toMatchObject({ path: "misc/untitled", excerpt: "A page without a title line." });
    expect(docs.search("untitled")[0]).toMatchObject({ path: "misc/untitled", excerpt: "A page without a title line." });
  });

  it("limits the hits (1 to 50); no hit is an empty list; a query without words is an error", () => {
    expect(docs.search("operation", 0)).toHaveLength(1);
    expect(docs.search("operation", 500)).toHaveLength(50);
    expect(docs.search("operation")).toHaveLength(8);
    expect(docs.search("zebra")).toEqual([]);
    const e = errorOf(() => docs.search(" ?! "));
    expect([e.message, e.code]).toEqual(["search_docs: the query has no words to look for", "bad_input"]);
  });
});

describe("search terms: tokenizer, stemmer, synonyms", () => {
  it("tokenize: lowercase words, accents folded, possessives, one-letter and common words dropped, stemmed", () => {
    expect(tokenize("The agent’s Café, don't CAFÉ: a I x merge_rows mark5 2024. How do I undo?")).toEqual(["agent", "cafe", "dont", "cafe", "merg", "row", "mark5", "2024", "undo"]);
    expect(tokenize("the agent's agents' agents")).toEqual(["agent", "agent", "agent"]);
    expect(tokenize("What is it, and how do I do this?")).toEqual([]);
    expect(STOP_WORDS.has("the") && !STOP_WORDS.has("where") && !STOP_WORDS.has("not")).toBe(true);
  });

  it("stem: the forms of a word meet; short words, words with digits and the exceptions stay", () => {
    const same = (forms: string) => new Set(forms.split(" ").map(stem)).size;
    for (const forms of [
      "table tables",
      "query queries queried",
      "copy copies copied",
      "rename renamed renaming renames",
      "create created creating creates",
      "drop dropped dropping drops",
      "rate rated rates",
      "use used using uses",
      "type typed types",
      "note notes noted",
      "box boxes",
      "match matches",
      "class classes",
      "filter filtered filtering filters",
      "call called calling",
      "embed embedding embedded",
      "set setting settings",
    ]) {
      expect(same(forms), forms).toBe(1);
    }
    expect(["go", "red", "ding", "string", "status", "analysis", "mark5", "v2", "add", "added", "ending", "hoped", "keyed", "fixed", "tied", "ties"].map(stem)).toEqual([
      "go",
      "red",
      "ding",
      "string",
      "status",
      "analysis",
      "mark5",
      "v2",
      "add",
      "add",
      "end",
      "hope",
      "key",
      "fix",
      "ti",
      "tie",
    ]);
  });

  it("queryTerms: each term with its synonyms (a little lighter); a synonym phrase is one term; a repeated term counts once", () => {
    const terms = queryTerms("roll back the rows, row and time travel; zebra");
    expect(terms.map((t) => t.term)).toEqual(["roll back", "row", "time travel", "zebra"]);
    expect(terms[0]!.alternatives).toEqual([
      { stems: ["roll", "back"], weight: 1 },
      { stems: ["undo"], weight: SYNONYM_WEIGHT },
      { stems: ["revert"], weight: SYNONYM_WEIGHT },
      { stems: ["rollback"], weight: SYNONYM_WEIGHT },
      { stems: ["restor"], weight: SYNONYM_WEIGHT },
    ]);
    expect(terms[1]!.alternatives.map((a) => a.stems.join(" "))).toEqual(["row", "record", "entry"]);
    expect(terms[2]!.alternatives.map((a) => a.stems.join(" "))).toEqual(["time travel", "history", "version"]);
    expect(terms[3]!.alternatives).toEqual([{ stems: ["zebra"], weight: 1 }]);
    expect(queryTerms("undo")[0]!.alternatives.map((a) => a.stems.join(" "))).toEqual(["undo", "revert", "rollback", "roll back", "restor"]);
    expect(queryTerms("roll")[0]!.alternatives).toEqual([{ stems: ["roll"], weight: 1 }]);
    expect(queryTerms("the of a")).toEqual([]);
    // every synonym is a word or phrase the tokenizer keeps
    for (const group of SEARCH_SYNONYMS) for (const entry of group) expect(tokenize(entry).length, entry).toBeGreaterThan(0);
  });
});

describe("search: ranking", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `filler${i}`).join(" ");
  const rankDir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-docs-rank-"));
  temp.push(rankDir);
  fs.writeFileSync(path.join(rankDir, "index.md"), "# Home\n\n> The home page.\n\nNothing to rank here.\n");
  fs.mkdirSync(path.join(rankDir, "zoo"));
  fs.writeFileSync(
    path.join(rankDir, "zoo", "animals.md"),
    [
      "# Animals",
      "",
      "## Short quokka",
      "",
      "A quokka lives here.",
      "",
      "## Long quokka",
      "",
      `A quokka lives here too, ${filler(200)}.`,
      "",
      "## Many quokkas",
      "",
      `${"quokka ".repeat(20)}${filler(10)}.`,
      "",
      "## Prose wombat",
      "",
      `The wombat sleeps. ${filler(6)}`,
      "",
      "## Code wombat",
      "",
      "Something else sleeps.",
      "",
      "```json",
      '{ "animal": "wombat" }',
      "~~~",
      "```text",
      "```",
      "",
      "````md",
      "```",
      "````",
      "",
      "## Blue whale",
      "",
      "Seen once at sea.",
      "",
      "## Whales",
      "",
      `A blue whale ${filler(8)}.`,
      "",
      "## Ocean",
      "",
      `The whale was blue, ${filler(8)}.`,
      "",
      "## Undo a write",
      "",
      "Takes it back.",
      "",
      "## Revert a write",
      "",
      "Takes it back.",
      "",
      "## Mistakes",
      "",
      `${filler(70)} you can roll back the last one.`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(rankDir, "llms.txt"), "# Zoo\n");
  const zoo = new DocsLibrary(rankDir);
  const order = (q: string) => zoo.search(q, 50).map((h) => h.path.replace("zoo/animals#", ""));

  it("BM25: a repeated word counts more, but saturates; a short text ranks above a long one", () => {
    const hits = zoo.search("quokka");
    expect(hits.map((h) => h.path.replace("zoo/animals#", ""))).toEqual(["many-quokkas", "short-quokka", "long-quokka"]);
    // twenty times the word, not twenty times the score: at most k1 + 1 = 2.2 times
    expect(hits[0]!.score).toBeLessThan(hits[1]!.score * 2.2);
  });

  it("a word in the prose counts more than one in a code block", () => {
    expect(order("wombat")).toEqual(["prose-wombat", "code-wombat"]);
  });

  it("the whole query in a heading ranks first, then words next to each other, then apart", () => {
    expect(order("blue whale")).toEqual(["blue-whale", "whales", "ocean"]);
  });

  it("a synonym matches a little less than the word itself, a phrase synonym where its words follow each other", () => {
    expect(order("undo a write")).toEqual(["undo-a-write", "revert-a-write", "mistakes"]);
    const phrase = zoo.search("undo").find((h) => h.path.endsWith("#mistakes"))!;
    expect(phrase.excerpt).toBe("…ller64 filler65 filler66 filler67 filler68 filler69 you can roll back the last one.");
  });

  it("whole words only: a part of a word, one letter or common words alone find nothing", () => {
    expect(docs.search("operat")).toEqual([]);
    expect(docs.search("operations")[0]!.path).toBe("reference/tools");
    for (const q of ["s", "how do I do it"]) {
      const e = errorOf(() => docs.search(q));
      expect([e.message, e.code, e.hint]).toEqual([
        "search_docs: the query has no words to look for",
        "bad_input",
        'Give a few words of the topic, for example search_docs("filter rows by date"); common words such as "the" or "how" are left out. list_docs lists the pages.',
      ]);
    }
  });
});

describe("datanotes/mcp: the docs tools", () => {
  const lib = openDocs(dir);

  it("defines list_docs, read_docs and search_docs, read-only, with the same filter as engineTools", () => {
    expect(docsTools().map((t) => t.name)).toEqual([...DOCS_TOOL_NAMES]);
    expect(docsTools().every((t) => t.annotations.readOnlyHint === true && t.annotations.openWorldHint === false)).toBe(true);
    expect(docsTools({ only: ["read_docs", "search_docs"], except: ["search_docs"] }).map((t) => t.name)).toEqual(["read_docs"]);
    const copy = docsTools()[0]!;
    copy.description = "changed";
    expect(docsTools()[0]!.description).not.toBe("changed");
    expect(() => docsTools({ only: ["select_rows"] })).toThrow('only: "select_rows" is not a docs tool');
    expect(() => docsTools({ except: ["read_doc"] })).toThrow('except: "read_doc" is not a docs tool');
    expect(isDocsTool("read_docs")).toBe(true);
    expect(isDocsTool("read_docs", { except: ["read_docs"] })).toBe(false);
    expect(isDocsTool("select_rows")).toBe(false);
  });

  it("list_docs: one page per line, under a prefix", async () => {
    expect(textOf(await callDocsTool("list_docs", {}, { docs: lib }))).toMatch(/^8 pages\. Read one with read_docs\("<path>"\)\.\napi\/operations\/create_webhook: /);
    expect(textOf(await callDocsTool("list_docs", { prefix: "guides/" }, { docs: lib }))).toBe('1 pages. Read one with read_docs("<path>").\nguides/tokens: Give each program its own token');
    expect(textOf(await callDocsTool("list_docs", { prefix: "examples/" }, { docs: lib }))).toContain("examples/queries: Querying rows — Read rows with select_rows");
  });

  it("read_docs: a page, a section by anchor or by `section`, from an offset", async () => {
    expect(textOf(await callDocsTool("read_docs", { path: "start/quick-start" }, { docs: lib }))).toBe(fs.readFileSync(path.join(dir, "start", "quick-start.md"), "utf8"));
    expect(textOf(await callDocsTool("read_docs", { path: "examples/queries#store-a-query-as-a-view" }, { docs: lib }))).toMatch(/^## Store a query as a view\n/);
    expect(textOf(await callDocsTool("read_docs", { path: "examples/queries", section: "compare-dates" }, { docs: lib }))).toMatch(/^### Compare dates\n/);
    expect(textOf(await callDocsTool("read_docs", { path: "index", offset: 2 }, { docs: lib }))).toMatch(/^Datanotes\n/);
  });

  it("search_docs: the sections with the path for read_docs and an excerpt; no hit says what to try", async () => {
    const found = textOf(await callDocsTool("search_docs", { query: "store a view", limit: 2 }, { docs: lib }));
    expect(found.split("\n")[0]).toBe("examples/queries#store-a-query-as-a-view — Querying rows › Store a query as a view");
    expect(found.split("\n").pop()).toBe('Read one with read_docs("<path>").');
    expect(textOf(await callDocsTool("search_docs", { query: "engine second brain" }, { docs: lib })).split("\n")[0]).toBe("index — Datanotes");
    expect(textOf(await callDocsTool("search_docs", { query: "zebra" }, { docs: lib }))).toBe('No section matches "zebra". Try other words, or list_docs to see the pages.');
  });

  it("mistakes are error results that say how to fix them: unknown page or section, bad arguments, unknown tool", async () => {
    const page = await callDocsTool("read_docs", { path: "examples/querys" }, { docs: lib });
    expect(page.isError).toBe(true);
    expect(textOf(page)).toEqual(guidedTextOf('no docs page "examples/querys"'));
    expect(hintOfText(textOf(page))).toMatch(/^Did you mean "examples\/queries"\?/);
    expect(textOf(page)).toContain('(offline: read_docs("guides/agents/docs-offline#the-agent-reads-the-docs-of-its-version"))');
    const args = await callDocsTool("read_docs", { page: "index" }, { docs: lib });
    expect(textOf(args)).toEqual(guidedTextOf('read_docs: unknown argument "page"; missing required argument "path" (string)'));
    expect(hintOfText(textOf(args))).toBe("read_docs takes: path (string, required), section (string), offset (integer).");
    expect(textOf(await callDocsTool("search_docs", { query: 3 }, { docs: lib }))).toMatch(/^search_docs: "query" must be a string, not number 3\n/);
    const tool = await callDocsTool("read_doc", {}, { docs: lib });
    expect(textOf(tool)).toMatch(/^unknown tool: read_doc\nHint: Did you mean "read_docs"\?/);
    expect(textOf(await callDocsTool("read_docs", { path: "index" }, { docs: lib, except: ["read_docs"] }))).toMatch(/^unknown tool: read_docs\n/);
    expect(textOf(await callDocsTool("list_docs", {}, { docs: new DocsLibrary(null) }))).toMatch(/^the Datanotes docs are not in this installation\nHint: /);
  });

  it("an unexpected failure is thrown, not answered; the package's own docs by default", async () => {
    const broken = { list: () => { throw new Error("disk gone"); } } as unknown as DocsLibrary;
    await expect(callDocsTool("list_docs", {}, { docs: broken })).rejects.toThrow("disk gone");
    const own = await callDocsTool("list_docs");
    expect(own.content[0]!.text).toMatch(/^(\d+ pages\.|the Datanotes docs are not in this installation)/);
  });
});
