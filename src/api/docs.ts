/**
 * The documentation of this version of Datanotes, read offline: every page of datanotes.dev as
 * Markdown, shipped in the npm package as `dist/docs/` (scripts/copy-docs.mjs copies them there
 * after the docs build). The MCP server `datanotes mcp` serves it to agents as three tools
 * (`list_docs`, `read_docs`, `search_docs`: src/api/mcp.ts), the engine to programs as
 * `GET /datanotes/manual/<page>.md` (src/server/http-server.ts). They are not engine operations:
 * nothing is journaled and no engine is needed.
 *
 * A page is named by its path on the site without `.md` (`guides/read-and-write/read-and-filter`), a section by the
 * anchor of its heading (`guides/read-and-write/read-and-filter#compare-values-with-operators`), as on the site; the
 * site's own addresses (`https://datanotes.dev/guides/read-and-write/read-and-filter/#…`) are read too. Every mistake
 * says what is wrong, the closest real page or section, and how to list them (the hint standard
 * of src/api/guidance.ts).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closestNames, DOCS_BASE, type Guidance } from "./guidance.js";

/** An environment variable that names the folder of the docs instead of the package's own. */
export const DOCS_DIR_ENV = "DATANOTES_DOCS_DIR";

/** The most characters read_docs returns at once: about 5 000 tokens. */
export const READ_DOCS_MAX = 20_000;

/** The page for agents on reading the docs offline. */
export const OFFLINE_DOCS = `${DOCS_BASE}/guides/agents/docs-offline.md#the-agent-reads-the-docs-of-its-version`;

/** A mistake in reading the docs: what is wrong, how to fix it, where to read more. */
export class DocsError extends Error {
  readonly hint: string;
  readonly docs: string;
  /** `missing`: the docs are not in this installation; `not_found`: no such page or section; `bad_input`: wrong arguments. */
  readonly code: "missing" | "not_found" | "bad_input";
  constructor(message: string, g: Guidance, code: DocsError["code"]) {
    super(message);
    this.hint = g.hint;
    this.docs = g.docs;
    this.code = code;
  }
}

/** A page of the docs. */
export interface DocsPage {
  /** Its path on the site, without `.md`: `guides/read-and-write/read-and-filter` (the home page is `index`). */
  path: string;
  title: string;
  description: string;
}

/** How a section matched a search: by its words (BM25), or by its meaning (the engine's vector index of the docs). */
export type DocsSignal = "keyword" | "semantic";

/** A section of a page that matches a search. */
export interface DocsHit {
  /** What read_docs reads: `guides/read-and-write/read-and-filter#compare-values-with-operators` (the page alone for its introduction). */
  path: string;
  page: string;
  section: string;
  excerpt: string;
  /** BM25 for a keyword search; the Reciprocal Rank Fusion score for a hybrid one. */
  score: number;
  /** The rankings the section is in: `keyword` alone without semantic search. */
  signals: DocsSignal[];
}

/** A section as search_docs ranks it, with the text the engine embeds for semantic search. */
export interface DocsSection {
  /** What read_docs reads, as in {@link DocsHit}. */
  path: string;
  page: string;
  section: string;
  /** The page's title and the heading, then the section's own prose, then its code. */
  text: string;
}

interface Section {
  anchor: string;
  title: string;
  level: number;
  /** Where its heading starts, where it ends with its subsections, and where its own text ends. */
  start: number;
  end: number;
  ownEnd: number;
}

interface Page extends DocsPage {
  text: string;
  sections: Section[];
}

/** The folder of this module: CommonJS bundles have `__dirname`, ES modules `import.meta.url`. */
function moduleDir(): string {
  /* v8 ignore next -- the ES module build only: vitest and the CommonJS bundles define __dirname */
  return typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
}

const isDocsDir = (dir: string) => fs.existsSync(path.join(dir, "index.md")) && fs.existsSync(path.join(dir, "llms.txt"));

/**
 * The folder of the docs: `DATANOTES_DOCS_DIR` when set, else the package's `dist/docs` (next to
 * `dist/datanotes.cjs`, above `dist/api/`, or in a checkout where the docs were built). Null when
 * there is none.
 */
export function findDocsDir(env: Record<string, string | undefined> = process.env, from: string = moduleDir()): string | null {
  const given = env[DOCS_DIR_ENV];
  const candidates = given ? [path.resolve(given)] : [path.join(from, "docs"), path.join(from, "..", "docs"), path.join(from, "..", "..", "dist", "docs")];
  return candidates.find(isDocsDir) ?? null;
}

/** A heading's anchor as the site makes it (github-slugger): lowercase, punctuation dropped, spaces as dashes. */
export function slug(heading: string): string {
  return heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The headings of a Markdown page (`##` to `######`, code blocks left out), with their anchors and extent. */
function sectionsOf(text: string): Section[] {
  const found: Omit<Section, "end" | "ownEnd">[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) fence = marker;
    else if (fence !== null && marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    else if (fence === null) {
      const m = /^(#{2,6}) (.+?)\s*$/.exec(line);
      if (m) {
        const base = slug(m[2]!);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        found.push({ anchor: n === 0 ? base : `${base}-${n}`, title: m[2]!.replace(/`/g, ""), level: m[1]!.length, start: offset });
      }
    }
    offset += line.length + 1;
  }
  return found.map((s, i) => {
    const next = found.slice(i + 1).find((o) => o.level <= s.level);
    return { ...s, end: next ? next.start : text.length, ownEnd: i + 1 < found.length ? found[i + 1]!.start : text.length };
  });
}

function pageOf(key: string, text: string): Page {
  const lines = text.split("\n");
  const title = /^# (.+)$/.exec(lines[0]!)?.[1]?.trim() ?? key;
  const quote = lines.slice(1, 6).find((l) => l.startsWith("> "));
  return { path: key, title, description: quote ? quote.slice(2).trim() : "", text, sections: sectionsOf(text) };
}

/** A page or section as given (`guides/read-and-write/read-and-filter.md`, `/guides/read-and-write/read-and-filter/#x`, a datanotes.dev address): the page's path and the anchor. */
export function docsRef(input: string): { page: string; anchor: string | null } {
  let s = input.trim().replace(/^https?:\/\/(www\.)?datanotes\.dev/i, "");
  const hash = s.indexOf("#");
  const anchor = hash >= 0 ? s.slice(hash + 1) : "";
  if (hash >= 0) s = s.slice(0, hash);
  s = s.replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "");
  return { page: s === "" ? "index" : s, anchor: anchor === "" ? null : anchor };
}

const quoted = (names: readonly string[]) => names.map((n) => `"${n}"`).join(" or ");
const shortList = (names: readonly string[], max = 25) => (names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")}, … (${names.length} in all)`);
const read = (ref: string, extra = "") => `read_docs("${ref}"${extra})`;

/*
 * search_docs ranks sections offline, with no dependency. The words of the query and of the docs
 * go through the same tokenizer (accents folded, possessives, one-letter words and common words
 * dropped) and the same light stemmer, so "rows" finds "row" and "renaming" finds "rename". A
 * section scores by BM25 over its own text, plus a boost for each word in its heading (more when
 * its heading holds every word) and in its page's title, plus a bonus for words next to each other
 * as in the query. A word of the query also matches its synonyms (SEARCH_SYNONYMS), a little less
 * than itself.
 *
 * The query can require and exclude words (parseQuery): a quoted phrase ("time travel") or a
 * +term must appear in a section, a -term must not; the other words only rank. When the engine has
 * semantic search on, search_docs also ranks the sections by meaning (the engine's vector index of
 * these same sections, `POST /datanotes/manual/search/`) and fuses the two rankings with
 * Reciprocal Rank Fusion (DocsLibrary.hybrid); the required and excluded words filter both.
 */

/** Common English words left out of queries and texts: they say nothing of the topic. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an the of to what how do does did done is are was were be been being am i my me mine we our us you your it its this that these those " +
    "for in on at by with from into as and or but if so than then there their them they he she his her can could would should will shall " +
    "may might must just about want why which some any also see"
  ).split(" "),
);

/** Words the stemmer leaves alone: their stem would differ from that of their other forms. */
const UNSTEMMED: ReadonlySet<string> = new Set(["embed"]);

/** Lowercase, accents and other marks dropped, curly apostrophes made straight, possessive "'s" dropped. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/'s\b/g, "")
    .replace(/'/g, "");
}

/**
 * The stem of a lowercase word: plurals and verb endings stripped, so that the forms of a word meet
 * (`tables`/`table`, `queries`/`query`, `renamed`/`renaming`/`rename`, `dropped`/`drop`,
 * `rated`/`rate`, `using`/`use`). Not a dictionary form (`create` is `creat`), only the same for
 * every form. Words of three letters or less, and words with digits, stay as they are.
 */
export function stem(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word) || UNSTEMMED.has(word)) return word;
  let w = word;
  // plurals and the third person: -sses, -xes, -ches, -shes, -zes, -ies, -s (not -ss, -us, -is)
  if (/(ss|x|ch|sh|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  // the past and the -ing form
  if (w.endsWith("ied") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else {
    const ending = /(ed|ing)$/.exec(w)?.[1];
    const rest = ending ? w.slice(0, -ending.length) : "";
    if (rest.length >= 2 && /[aeiouy]/.test(rest)) {
      // dropped: drop; rated: rate, using: use (a short stem that lost its e); else the stem
      if (rest.length >= 4 && rest.at(-1) === rest.at(-2) && /[^aeiouylsz]/.test(rest.at(-1)!)) w = rest.slice(0, -1);
      else if (/^[aeiou][^aeiouwxy]$|^[^aeiou][aeiouy][^aeiouwxy]$/.test(rest)) w = `${rest}e`;
      else w = rest;
    }
  }
  // a final e: create and creating meet as creat
  if (w.length >= 5 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** The search terms of a text: folded words, without one-letter and common words, stemmed. */
export function tokenize(text: string): string[] {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP_WORDS.has(w)).map(stem);
}

/**
 * Words that mean the same thing in these docs, for queries: a word of the query also matches the
 * others of its group, with SYNONYM_WEIGHT. An entry can be a phrase ("roll back"), which matches
 * where its words follow each other, in the query and in the docs.
 */
export const SEARCH_SYNONYMS: readonly (readonly string[])[] = [
  ["undo", "revert", "rollback", "roll back", "restore"],
  ["rule", "check", "constraint"],
  ["delete", "remove", "drop", "erase"],
  ["filter", "where", "query"],
  ["history", "version", "time travel"],
  ["change", "edit", "update", "modify"],
  ["create", "add", "insert"],
  ["agent", "assistant", "model", "llm"],
  ["token", "key", "credential"],
  ["refuse", "reject", "error", "fail"],
  ["column", "field", "property"],
  ["row", "record", "entry"],
  ["link", "relation", "reference"],
  ["copy", "clone", "duplicate"],
  ["store", "save"],
  ["import", "adopt"],
  ["enum", "allowed value"],
  ["sum", "total", "aggregate"],
  ["folder", "directory"],
  ["docs", "documentation", "manual"],
];

/** How much a synonym counts against the word itself. */
export const SYNONYM_WEIGHT = 0.7;

/** A term of a query: the word (or synonym phrase) as stems, and every way it matches, itself first. */
export interface QueryTerm {
  term: string;
  alternatives: { stems: string[]; weight: number }[];
}

type Alternative = QueryTerm["alternatives"][number];

const key = (stems: readonly string[]) => stems.join(" ");

/** The synonym groups as stems. */
const SYNONYM_GROUPS: string[][][] = SEARCH_SYNONYMS.map((group) => group.map(tokenize));

/**
 * The terms of a query, each with its synonyms. A synonym phrase written in the query ("roll
 * back", "time travel") is one term; a term repeated in the query counts once.
 */
export function queryTerms(query: string): QueryTerm[] {
  const stems = tokenize(query);
  const terms: QueryTerm[] = [];
  for (let i = 0; i < stems.length; ) {
    // the longest synonym phrase that starts here, else the word alone
    let words = [stems[i]!];
    for (const entry of SYNONYM_GROUPS.flat()) if (entry.length > words.length && entry.every((s, j) => stems[i + j] === s)) words = entry;
    i += words.length;
    const term = key(words);
    if (terms.some((t) => t.term === term)) continue;
    const alternatives: Alternative[] = [{ stems: words, weight: 1 }];
    for (const group of SYNONYM_GROUPS.filter((g) => g.some((e) => key(e) === term))) {
      for (const e of group) if (!alternatives.some((a) => key(a.stems) === key(e))) alternatives.push({ stems: e, weight: SYNONYM_WEIGHT });
    }
    terms.push({ term, alternatives });
  }
  return terms;
}

/** A query of search_docs as written: the words to rank by, and the words a section must hold or must not. */
export interface DocsQuery {
  /** The words to rank by, the syntax taken out: `"time travel" +view -sql` ranks by `time travel view`. */
  text: string;
  /** Quoted phrases and +terms, as stems: each must appear in a section (its words in a row, in any form). */
  required: string[][];
  /** -terms and -"phrases", as stems: a section that holds one is left out. */
  excluded: string[][];
}

/**
 * Read the syntax of a search_docs query: `"a phrase"` and `+term` must appear in a section,
 * `-term` (or `-"a phrase"`) must not, every other word ranks only. Curly quotes count as straight
 * ones, a quote left open runs to the end, and a word that starts with two dashes (`--vault`) is a
 * word. Words that say nothing (`+the`) require nothing.
 */
export function parseQuery(query: string): DocsQuery {
  const words: string[] = [];
  const required: string[][] = [];
  const excluded: string[][] = [];
  const quoted = query.replace(/[“”„«»]/g, '"');
  for (const m of quoted.matchAll(/([+-]?)(?:"([^"]*)"?|([^\s"]+))/g)) {
    const [, sign, phrase, word] = m;
    if (word !== undefined && (sign === "" || word.startsWith("-"))) {
      words.push(`${sign}${word}`);
      continue;
    }
    const content = phrase ?? word!;
    const stems = tokenize(content);
    if (sign === "-") {
      if (stems.length > 0) excluded.push(stems);
      continue;
    }
    words.push(content);
    if (stems.length > 0) required.push(stems);
  }
  return { text: words.join(" "), required, excluded };
}

/** BM25's saturation of repeated words and its normalization by length (the usual values). */
const K1 = 1.2;
const B = 0.75;
/** A term in a section's heading, in a long heading (the HTTP reference's sentence titles), in its page's title: times its IDF. */
const HEADING = 3;
const LONG_HEADING = 1;
const PAGE_TITLE = 1;
/** A heading that holds every term of the query: the score grows by this share. */
const WHOLE_HEADING = 0.5;
/** Two neighbouring terms of the query next to each other, in the heading or in the text: times the smaller IDF of the two. */
const PAIR_HEADING = 1.5;
const PAIR_BODY = 0.75;
/** A term in a code block (JSON requests and answers, metastore.yaml) against one in the prose. */
const CODE = 0.3;
/** The HTTP API reference (api/) repeats the operations' reference with the routes: it comes after the other pages. */
const API_PAGES = 0.6;

/** A text as search terms: in order, and counted. */
interface Field {
  terms: string[];
  counts: Map<string, number>;
}

function field(text: string): Field {
  const terms = tokenize(text);
  const counts = new Map<string, number>();
  for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  return { terms, counts };
}

/** How many times a word or a phrase occurs in a field. */
function occurrences(f: Field, stems: readonly string[]): number {
  if (stems.length === 1) return f.counts.get(stems[0]!) ?? 0;
  let n = 0;
  for (let i = 0; i + stems.length <= f.terms.length; i++) if (stems.every((s, j) => f.terms[i + j] === s)) n++;
  return n;
}

/** Whether a word of term `a` is followed by a word of term `b` in a field (single words; phrases are matched whole). */
function adjacent(f: Field, a: readonly Alternative[], b: readonly Alternative[]): boolean {
  const words = (alts: readonly Alternative[]) => new Set(alts.filter((x) => x.stems.length === 1).map((x) => x.stems[0]!));
  const first = words(a);
  const second = words(b);
  for (let i = 0; i + 1 < f.terms.length; i++) if (first.has(f.terms[i]!) && second.has(f.terms[i + 1]!)) return true;
  return false;
}

/** A Markdown text split into its prose and the content of its code blocks (the fences left out). */
function splitCode(body: string): { prose: string; code: string } {
  const prose: string[] = [];
  const code: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) fence = marker;
    else if (fence !== null && marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    else (fence === null ? prose : code).push(line);
  }
  return { prose: prose.join("\n"), code: code.join("\n") };
}

/** One section's own text (or a page's introduction), indexed for search. */
interface Unit {
  page: Page;
  section: Section | null;
  ref: string;
  body: string;
  heading: Field;
  /** Its page's title, for a section (a page's introduction has the title as its heading). */
  pageTitle: Field | null;
  /** Its prose, and the content of its code blocks (which counts less: CODE). */
  text: Field;
  code: Field;
  /** Its length for BM25: the terms of its prose, and those of its code at CODE. */
  length: number;
  headingWeight: number;
}

/** The search index of a library, built once: every unit's terms, and how many units hold each term. */
class SearchIndex {
  readonly units: Unit[] = [];
  readonly byRef = new Map<string, Unit>();
  readonly avgLength: number;
  private readonly unitsWith = new Map<string, number>();

  constructor(pages: Iterable<Page>) {
    for (const page of pages) {
      const first = page.sections[0]?.start ?? page.text.length;
      // the text without its heading line, which counts as the heading
      this.add(page, null, page.title, page.text.slice(0, first).replace(/^# .*\n?/, ""));
      for (const s of page.sections) this.add(page, s, s.title, page.text.slice(s.start, s.ownEnd).replace(/^.*\n?/, ""));
    }
    for (const u of this.units) this.byRef.set(u.ref, u);
    for (const u of this.units) for (const t of new Set([...u.heading.terms, ...u.text.terms, ...u.code.terms])) this.unitsWith.set(t, (this.unitsWith.get(t) ?? 0) + 1);
    this.avgLength = this.units.reduce((n, u) => n + u.length, 0) / this.units.length;
  }

  private add(page: Page, section: Section | null, title: string, body: string): void {
    const { prose, code } = splitCode(body);
    const text = field(prose);
    const codeField = field(code);
    this.units.push({
      page,
      section,
      ref: section ? `${page.path}#${section.anchor}` : page.path,
      body,
      heading: field(title),
      pageTitle: section ? field(page.title) : null,
      text,
      code: codeField,
      length: text.terms.length + CODE * codeField.terms.length,
      // a heading counts in full when it is short (the HTTP reference's titles are whole sentences)
      headingWeight: title.length <= 80 ? HEADING : LONG_HEADING,
    });
  }

  /** BM25's inverse document frequency of a word or phrase (phrases counted on first use): rare ones count more. */
  idf(stems: readonly string[]): number {
    const k = key(stems);
    let n = this.unitsWith.get(k);
    if (n === undefined) {
      n = this.units.filter((u) => occurrences(u.heading, stems) + occurrences(u.text, stems) + occurrences(u.code, stems) > 0).length;
      this.unitsWith.set(k, n);
    }
    return Math.log(1 + (this.units.length - n + 0.5) / (n + 0.5));
  }

  /** BM25 of `count` occurrences in a text of `length` terms. */
  bm25(count: number, length: number): number {
    return (count * (K1 + 1)) / (count + K1 * (1 - B + (B * length) / this.avgLength));
  }
}

/** The docs in a folder (null: there are none, and every call says how to get them). */
export class DocsLibrary {
  private loaded: Map<string, Page> | null = null;
  private index: SearchIndex | null = null;
  private hash: string | null = null;
  private sectionList: DocsSection[] | null = null;

  constructor(readonly dir: string | null) {}

  private missing(): DocsError {
    const where = this.dir === null ? "" : ` (${this.dir})`;
    return new DocsError(
      `the Datanotes docs are not in this installation${where}`,
      {
        hint: `The npm package ships them in dist/docs. In a checkout of the repository, build them: cd docs && npm ci && npm run build (it copies the pages to dist/docs); ${DOCS_DIR_ENV} names another folder. Online, https://datanotes.dev/llms.txt lists every page.`,
        docs: OFFLINE_DOCS,
      },
      "missing",
    );
  }

  private all(): Map<string, Page> {
    if (this.loaded) return this.loaded;
    if (this.dir === null || !isDocsDir(this.dir)) throw this.missing();
    const pages = new Map<string, Page>();
    const walk = (dir: string, prefix: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (ent.isDirectory()) walk(path.join(dir, ent.name), `${prefix}${ent.name}/`);
        else if (ent.name.endsWith(".md")) {
          const key = `${prefix}${ent.name.slice(0, -3)}`;
          pages.set(key, pageOf(key, fs.readFileSync(path.join(dir, ent.name), "utf8").replace(/\r\n/g, "\n")));
        }
      }
    };
    walk(this.dir, "");
    this.loaded = pages;
    return pages;
  }

  /** The pages, sorted by path; only those under `prefix` (`guides/`) when it is given. */
  list(prefix = ""): DocsPage[] {
    const pages = [...this.all().values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    const want = docsRef(prefix).page;
    // "examples/": the pages in the folder; "examples": the folder's own page too
    const folderOnly = /\/\s*$/.test(prefix);
    const under = prefix.trim() === "" ? pages : pages.filter((p) => (p.path === want && !folderOnly) || p.path.startsWith(`${want}/`));
    if (under.length === 0) {
      const folders = [...new Set(pages.filter((p) => p.path.includes("/")).map((p) => `${p.path.split("/")[0]}/`))];
      const near = closestNames(want, [...folders.map((f) => f.slice(0, -1)), ...pages.map((p) => p.path)]);
      throw new DocsError(
        `no docs page under "${prefix}"`,
        { hint: `${near.length > 0 ? `Did you mean ${quoted(near)}? ` : ""}The folders are ${folders.join(", ")}; list_docs without a prefix lists every page.`, docs: OFFLINE_DOCS },
        "not_found",
      );
    }
    return under.map(({ path: p, title, description }) => ({ path: p, title, description }));
  }

  private page(name: string): Page {
    const pages = this.all();
    const found = pages.get(name);
    if (found) return found;
    const paths = [...pages.keys()];
    const slash = name.lastIndexOf("/");
    const folder = name.slice(0, slash + 1);
    const last = name.slice(slash + 1);
    const lastOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    // a page of the same folder first, by spelling or by its first letters ("examples/query":
    // "examples/queries"), then the whole path, then the last part alone in any folder
    // ("guides/queries": "examples/queries"), and last the folder's own page ("examples")
    const overview = folder.slice(0, -1);
    const inFolder = paths.filter((p) => p.startsWith(folder) && !p.slice(folder.length).includes("/")).map(lastOf);
    const common = (a: string) => [...a].findIndex((c, i) => c !== last[i]);
    let near = slash > 0 ? closestNames(last, inFolder) : [];
    if (near.length === 0 && slash > 0) near = inFolder.filter((n) => common(n) === -1 || common(n) >= 4);
    near = near.map((n) => `${folder}${n}`);
    if (near.length === 0) near = closestNames(name, paths.filter((p) => p !== overview));
    if (near.length === 0) near = closestNames(last, paths.map(lastOf)).flatMap((n) => paths.filter((p) => lastOf(p) === n));
    if (near.length === 0 && pages.has(overview)) near = [overview];
    throw new DocsError(
      `no docs page "${name}"`,
      { hint: `${near.length > 0 ? `Did you mean ${quoted(near.slice(0, 3))}? ` : ""}list_docs lists the pages (list_docs("guides/") those of a folder); search_docs finds the sections on a topic.`, docs: OFFLINE_DOCS },
      "not_found",
    );
  }

  private section(page: Page, anchor: string): Section {
    const found = page.sections.find((s) => s.anchor === anchor);
    if (found) return found;
    const anchors = page.sections.map((s) => s.anchor);
    let close = closestNames(anchor, anchors);
    if (close.length === 0) {
      // some of the heading's words: "store-a-view" for "store-a-query-as-a-view"
      const want = anchor.toLowerCase().split(/[-_\s]+/);
      close = anchors.filter((a) => want.every((w) => a.split("-").includes(w))).slice(0, 3);
    }
    const near = close.map((a) => `${page.path}#${a}`);
    const listed = anchors.length > 0 ? `Its sections: ${shortList(anchors)}.` : "It has no sections.";
    throw new DocsError(
      `${page.path} has no section "#${anchor}"`,
      { hint: `${near.length > 0 ? `Did you mean ${quoted(near)}? ` : ""}${listed} ${read(page.path)} reads the whole page.`, docs: OFFLINE_DOCS },
      "not_found",
    );
  }

  /**
   * The Markdown of a page (`guides/read-and-write/read-and-filter`) or of one section (`guides/read-and-write/read-and-filter#anchor`, or
   * `section`), with its subsections. Without a cap, the whole text.
   */
  text(ref: string, section?: string | null): { ref: string; text: string; page: Page; from: number } {
    const r = docsRef(ref);
    const page = this.page(r.page);
    const anchor = section ? section.replace(/^#/, "") : r.anchor;
    if (!anchor) return { ref: page.path, text: page.text, page, from: 0 };
    const s = this.section(page, anchor);
    return { ref: `${page.path}#${s.anchor}`, text: page.text.slice(s.start, s.end).trimEnd() + "\n", page, from: s.start };
  }

  /**
   * What read_docs returns: the page or section from `offset`, at most `max` characters, cut at the
   * end of a line, then a note on how to read the rest (the sections that follow, or the offset).
   */
  read(ref: string, opts: { section?: string | null; offset?: number; max?: number } = {}): string {
    const { ref: name, text, page, from } = this.text(ref, opts.section);
    const max = Math.max(1000, opts.max ?? READ_DOCS_MAX);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    if (offset > 0 && offset >= text.length) {
      throw new DocsError(`offset ${offset} is past the end of ${name} (${text.length} characters)`, { hint: `Read it from the start: ${read(name)}.`, docs: OFFLINE_DOCS }, "bad_input");
    }
    if (text.length - offset <= max) return text.slice(offset);
    // cut before the last heading that fits, else at the end of a line
    const heading = page.sections.filter((s) => s.start - from > offset + max / 2 && s.start - from <= offset + max).pop();
    const lastLine = text.lastIndexOf("\n", offset + max);
    const end = heading ? heading.start - from : lastLine > offset + max / 2 ? lastLine + 1 : offset + max;
    // the sections that start after the cut, which read_docs reads one at a time
    const later = page.sections.filter((s) => s.start >= from + end && s.start < from + text.length && s.level <= 3).map((s) => s.anchor);
    const sections = later.length > 0 ? ` One section at a time: ${read(`${page.path}#${later[0]}`)}; the sections after this point: ${shortList(later)}.` : "";
    return `${text.slice(offset, end)}\n[Cut at character ${end} of ${text.length}. Read on with ${read(name, `, offset: ${end}`)}.${sections}]\n`;
  }

  private searchIndex(): SearchIndex {
    return (this.index ??= new SearchIndex(this.all().values()));
  }

  /** The terms of a query to rank by; a query with none is refused. */
  private termsOf(q: DocsQuery): QueryTerm[] {
    const terms = queryTerms(q.text);
    if (terms.length === 0) {
      throw new DocsError(
        "search_docs: the query has no words to look for",
        { hint: `Give a few words of the topic, for example search_docs("filter rows by date"); common words such as "the" or "how" are left out. list_docs lists the pages.`, docs: OFFLINE_DOCS },
        "bad_input",
      );
    }
    return terms;
  }

  /**
   * The units ranked by BM25 for the query's words, best first, without those the required and
   * excluded words leave out. Each term of the query (a word in any form, or one of its synonyms)
   * scores by BM25 in a section's text, and more in its heading and its page's title; rare terms
   * count more than common ones; a heading with every term, and terms next to each other as in
   * the query, add to it; a section with every term ranks above one with some.
   */
  private ranked(q: DocsQuery, terms: QueryTerm[]): DocsHit[] {
    const index = this.searchIndex();
    const idf = terms.map((t) => t.alternatives.map((a) => index.idf(a.stems)));
    const hits: DocsHit[] = [];
    for (const u of index.units) {
      if (!allows(u, q)) continue;
      let score = 0;
      let matched = 0;
      let inHeading = 0;
      terms.forEach((t, i) => {
        let best = 0;
        let heading = false;
        t.alternatives.forEach((a, j) => {
          const w = idf[i]![j]!;
          const count = occurrences(u.text, a.stems) + CODE * occurrences(u.code, a.stems);
          const head = occurrences(u.heading, a.stems) > 0;
          const s = a.weight * (w * index.bm25(count, u.length) + (head ? u.headingWeight * w : 0) + (u.pageTitle && occurrences(u.pageTitle, a.stems) > 0 ? PAGE_TITLE * w : 0));
          if (s > best) best = s;
          heading ||= head;
        });
        if (best > 0) matched++;
        if (heading) inHeading++;
        score += best;
      });
      if (matched === 0) continue;
      // neighbouring terms of the query next to each other
      for (let i = 0; i + 1 < terms.length; i++) {
        const a = terms[i]!.alternatives;
        const b = terms[i + 1]!.alternatives;
        const w = Math.min(idf[i]![0]!, idf[i + 1]![0]!);
        if (adjacent(u.heading, a, b)) score += PAIR_HEADING * w;
        else if (adjacent(u.text, a, b) || adjacent(u.code, a, b)) score += PAIR_BODY * w;
      }
      if (inHeading === terms.length) score *= 1 + WHOLE_HEADING;
      score *= (matched / terms.length) ** 2;
      if (u.page.path.startsWith("api/")) score *= API_PAGES;
      hits.push(hitOf(u, terms, Math.round(score * 100) / 100, ["keyword"]));
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }

  /**
   * The sections that best match `query`, best first, by their words (BM25: {@link ranked}). A
   * quoted phrase or a +term must appear in a section, a -term must not (parseQuery).
   */
  search(query: string, limit = 8): DocsHit[] {
    const q = parseQuery(query);
    return this.ranked(q, this.termsOf(q)).slice(0, cap(limit));
  }

  /**
   * Hybrid search: the ranking of {@link search} by words, and `semantic`, the sections ranked by
   * meaning (the engine's vector index of these docs, best first), fused by Reciprocal Rank
   * Fusion: a section scores the sum of 1 / (RRF_K + its rank) over the rankings it is in, among
   * the first FUSION_DEPTH of each. The required and excluded words filter both rankings, and a
   * section these docs do not have is left out. Each hit says which rankings it is in (`signals`).
   */
  hybrid(query: string, semantic: readonly { path: string }[], limit = 8): DocsHit[] {
    const q = parseQuery(query);
    const terms = this.termsOf(q);
    const index = this.searchIndex();
    const keyword = this.ranked(q, terms).slice(0, FUSION_DEPTH);
    const meaning: Unit[] = [];
    for (const s of semantic) {
      const u = index.byRef.get(s.path);
      if (!u || !allows(u, q) || meaning.includes(u)) continue;
      meaning.push(u);
      if (meaning.length === FUSION_DEPTH) break;
    }
    const fused = new Map<string, { unit: Unit; score: number; keywordRank: number; signals: DocsSignal[] }>();
    const add = (u: Unit, rank: number, signal: DocsSignal) => {
      const f = fused.get(u.ref) ?? { unit: u, score: 0, keywordRank: Infinity, signals: [] };
      f.score += 1 / (RRF_K + rank);
      f.signals.push(signal);
      if (signal === "keyword") f.keywordRank = rank;
      fused.set(u.ref, f);
    };
    keyword.forEach((h, i) => add(index.byRef.get(h.path)!, i + 1, "keyword"));
    meaning.forEach((u, i) => add(u, i + 1, "semantic"));
    // two sections never tie on both: each rank of a ranking is a different score
    return [...fused.values()]
      .sort((a, b) => b.score - a.score || a.keywordRank - b.keywordRank)
      .slice(0, cap(limit))
      .map((f) => hitOf(f.unit, terms, Math.round(f.score * 10_000) / 10_000, f.signals));
  }

  /**
   * Every section as search_docs ranks them (a page's introduction too), with the text to embed
   * for semantic search: the page's title and the heading, the prose, then the code.
   */
  sections(): readonly DocsSection[] {
    return (this.sectionList ??= this.searchIndex().units.map((u) => {
      const { prose, code } = splitCode(u.body);
      const heading = u.section ? `${u.page.title} › ${u.section.title}` : u.page.title;
      const text = [heading, prose.trim(), code.trim()].filter((t) => t !== "").join("\n\n");
      return { path: u.ref, page: u.page.title, section: u.section ? u.section.title : "", text };
    }));
  }

  /**
   * The version of these docs: a hash of their sections (paths and texts). The engine's vector
   * index of the docs is rebuilt when it changes, and search_docs fuses its ranking only when the
   * engine's docs have the same version as its own.
   */
  version(): string {
    if (this.hash === null) {
      const h = createHash("sha256");
      for (const s of this.sections()) h.update(`${s.path}\u0000${s.text}\u0000`);
      this.hash = h.digest("hex").slice(0, 16);
    }
    return this.hash;
  }
}

/** The constant of Reciprocal Rank Fusion: 60, the value of its paper (Cormack et al., 2009) and of most search engines; it keeps the first ranks from outweighing agreement between the rankings. */
export const RRF_K = 60;

/** How many sections of each ranking hybrid search fuses. */
export const FUSION_DEPTH = 50;

/** The most hits a search returns, from 1 to 50. */
const cap = (limit: number) => Math.max(1, Math.min(50, Math.floor(limit)));

/** Whether a unit holds every required word or phrase (heading, text or code) and none of the excluded ones. */
function allows(u: Unit, q: DocsQuery): boolean {
  const holds = (stems: readonly string[]) => occurrences(u.heading, stems) + occurrences(u.text, stems) + occurrences(u.code, stems) > 0;
  return q.required.every(holds) && !q.excluded.some(holds);
}

/** A unit as a hit: its excerpt around the first word of the query its text holds. */
function hitOf(u: Unit, terms: readonly QueryTerm[], score: number, signals: DocsSignal[]): DocsHit {
  const found = new Set<string>();
  for (const t of terms) for (const a of t.alternatives) if (occurrences(u.text, a.stems) + occurrences(u.code, a.stems) > 0) found.add(a.stems[0]!);
  return { path: u.ref, page: u.page.title, section: u.section ? u.section.title : "", excerpt: excerpt(u.body, found), score, signals };
}

/** About 200 characters of `body` around the first word with one of the `terms` (headings and code fences left out). */
function excerpt(body: string, terms: ReadonlySet<string>): string {
  const prose = body
    .split("\n")
    .filter((l) => !/^(#|\s*```|\s*~~~)/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  let at = -1;
  for (const m of prose.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    if (terms.has(tokenize(m[0])[0] ?? "")) {
      at = m.index;
      break;
    }
  }
  const start = at > 60 ? at - 60 : 0;
  const cut = prose.slice(start, start + 200);
  return `${start > 0 ? "…" : ""}${cut}${start + 200 < prose.length ? "…" : ""}`;
}

const libraries = new Map<string | null, DocsLibrary>();

/** The docs of a folder (default: `findDocsDir()`), loaded once per folder. */
export function openDocs(dir: string | null = findDocsDir()): DocsLibrary {
  let lib = libraries.get(dir);
  if (!lib) libraries.set(dir, (lib = new DocsLibrary(dir)));
  return lib;
}
