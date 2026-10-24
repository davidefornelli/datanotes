/**
 * Hybrid search on the notes (`search`): the notes ranked by their words (BM25) and, when the
 * semantic index is on, by their meaning too, the two rankings fused with Reciprocal Rank Fusion.
 * It is the notes' counterpart of search_docs (src/api/docs.ts, `DocsLibrary.hybrid`), with the
 * same query syntax: `"a phrase"` and `+term` must appear in a note, `-term` must not, the other
 * words only rank.
 *
 * Words, in any language: a text is folded as search_notes folds it (accents and case dropped) and
 * cut into runs of letters and digits; single letters are dropped, single digits kept ("6 mesi").
 * There is no stemming and no list of common words: the notes are in Italian and other languages,
 * BM25's inverse document frequency (IDF) already counts a common word for little, and the
 * embeddings of semantic search find the other forms of a word.
 *
 * A note scores by BM25 over its body, plus its IDF for each term in its name (times NAME) and in a
 * value of its front matter (times FRONT_MATTER), plus a bonus for terms next to each other as in
 * the query; a note with every term ranks above one with some. The IDF and the length
 * normalization are of the notes the caller may search (its read scope, `folder` and `tables`).
 * With the host's index of words, only the notes it names for some term of the query are read:
 * every note that holds the term is among them, so the IDF stays exact; the average length is then
 * that of the notes read.
 */

import type { App, TFile } from "./host";
import type { DatanotesSettings } from "./settings";
import { readHash, readHashed } from "./file-cache";
import { guide } from "./hints";
import { OperationInputError } from "./engine";
import { cachedMetastore, loadMetastore, rowTableFull } from "./metastore";
import { assertTableReadable, currentReadScope, pathReadable, ReadDeniedError, tableOfPath } from "./read-scope";
import type { SemanticIndex } from "./semantic";
import { indexableWord, searchCandidates, searchFold } from "./vault-read";
import { messageOf } from "./message";

/** How a note matched: by its words (BM25), by its meaning (the semantic index). */
export type MatchedBy = "words" | "meaning";

export interface NoteSearchInput {
  query: string;
  /** Only rows of these tables (qualified or short names, as semantic_search takes them). */
  tables?: string[];
  /** Only notes under this folder. */
  folder?: string;
  /** Default 10, from 1 to 100. */
  limit?: number;
  /** The meaning ranking keeps only passages at least this similar (cosine, 0-1). */
  minScore?: number;
}

export interface NoteSearchHit {
  path: string;
  table?: string;
  score: number;
  heading: string;
  snippet: string;
  matched_by: MatchedBy[];
}

export interface NoteSearchResult {
  query: string;
  results: NoteSearchHit[];
  /** `on`: the words and the meaning fused; `off`: the semantic index is off, words only; `failed`: the embedding provider failed, words only. */
  meaning: "on" | "off" | "failed";
  /** Why the meaning ranking failed (with `meaning: "failed"`). */
  meaning_error?: string;
}

/** BM25's saturation of repeated words and its normalization by length (the usual values). */
const K1 = 1.2;
const B = 0.75;
/** A term in the note's name, in a value of its front matter: times its IDF. */
const NAME = 3;
const FRONT_MATTER = 1;
/** Two neighbouring terms of the query next to each other in the note: times the smaller IDF of the two. */
const PAIR = 0.75;
/** The constant of Reciprocal Rank Fusion, and how many notes of each ranking it fuses (as search_docs). */
export const RRF_K = 60;
export const FUSION_DEPTH = 50;
/** How many notes the meaning ranking is asked for (semantic_search's most). */
const MEANING_DEPTH = 100;
/** About this many characters of a note around its first match. */
const SNIPPET = 200;

/** The docs of this search, for its errors. */
const SEARCH_GUIDE = (hint: string) => guide(hint, "search");

/** The search terms of a text: folded as search_notes folds it, runs of letters and digits, no single letters. */
export function searchTerms(text: string): string[] {
  return (searchFold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 || /\p{N}/u.test(w));
}

/** A query as written: the words to rank by, and the words a note must hold or must not. */
export interface ParsedQuery {
  /** The words to rank by, the syntax taken out (`"6 mesi" +uovo -latte` ranks by `6 mesi uovo`). */
  text: string;
  /** Quoted phrases and +terms, as terms: each must appear in a note (its words in a row). */
  required: string[][];
  /** -terms and -"phrases": a note that holds one is left out. */
  excluded: string[][];
}

/**
 * Read the syntax of a query, as search_docs reads it (parseQuery in src/api/docs.ts, which the
 * layers keep apart): `"a phrase"` and `+term` must appear, `-term` (or `-"a phrase"`) must not,
 * every other word ranks only. Curly and angle quotes count as straight ones, a quote left open
 * runs to the end, and a word that starts with two dashes (`--vault`) is a word.
 */
export function parseSearchQuery(query: string): ParsedQuery {
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
    const terms = searchTerms(content);
    if (sign === "-") {
      if (terms.length > 0) excluded.push(terms);
      continue;
    }
    words.push(content);
    if (terms.length > 0) required.push(terms);
  }
  return { text: words.join(" "), required, excluded };
}

/** A text as search terms: in order, and counted. */
interface Field {
  terms: string[];
  counts: Map<string, number>;
}

function field(text: string): Field {
  const terms = searchTerms(text);
  const counts = new Map<string, number>();
  for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  return { terms, counts };
}

/** How many times a term or a phrase occurs in a field. */
function occurrences(f: Field, terms: readonly string[]): number {
  if (terms.length === 1) return f.counts.get(terms[0]!) ?? 0;
  let n = 0;
  for (let i = 0; i + terms.length <= f.terms.length; i++) if (terms.every((s, j) => f.terms[i + j] === s)) n++;
  return n;
}

/** Whether term `a` is followed by term `b` somewhere in a field. */
function adjacent(f: Field, a: string, b: string): boolean {
  for (let i = 0; i + 1 < f.terms.length; i++) if (f.terms[i] === a && f.terms[i + 1] === b) return true;
  return false;
}

/** A note's text as the search reads it: its name, the values of its front matter, its body. */
interface NoteFields {
  hash: string;
  name: Field;
  frontMatter: Field;
  body: Field;
  /** The front matter's value lines and the body, as written (for the snippet). */
  frontMatterLines: string[];
  bodyText: string;
}

/** A wiki link as the text it shows: its alias, else its target's name. */
function linkText(text: string): string {
  return text.replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target: string, alias: string | undefined) => alias ?? target.split("/").pop()!);
}

/** The front matter (between `---` lines at the start) and the body of a note. */
function splitNote(content: string): { frontMatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return m ? { frontMatter: m[1]!, body: content.slice(m[0].length) } : { frontMatter: null, body: content };
}

/** The values of a front matter, one per line: keys, `id` and the table key left out. */
function frontMatterValues(yaml: string, tableKey: string): string[] {
  const skip = new Set(["id", tableKey]);
  const out: string[] = [];
  let key: string | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    const entry = /^([^\s:#-][^:]*):\s*(.*)$/.exec(line);
    if (entry) {
      key = entry[1]!.trim().replace(/^["']|["']$/g, "");
      if (!skip.has(key) && entry[2]!.trim() !== "") out.push(linkText(entry[2]!.trim()));
      continue;
    }
    // a list item or a continued value belongs to the last key
    if (key !== null && !skip.has(key) && line.trim() !== "") out.push(linkText(line.trim().replace(/^-\s*/, "")));
  }
  return out;
}

function fieldsOf(path: string, hash: string, content: string, tableKey: string): NoteFields {
  const { frontMatter, body } = splitNote(content);
  const lines = frontMatter === null ? [] : frontMatterValues(frontMatter, tableKey);
  const name = path.split("/").pop()!.replace(/\.md$/i, "");
  return { hash, name: field(name), frontMatter: field(lines.join("\n")), body: field(linkText(body)), frontMatterLines: lines, bodyText: body };
}

/** At most `maxTerms` terms of notes are kept between searches: past it, the notes not kept yet are read on each search. */
export const SEARCH_TERMS_CACHE = { maxTerms: 8_000_000 };

const KEPT = new WeakMap<object, { notes: Map<string, NoteFields>; terms: number }>();

const sizeOf = (n: NoteFields) => n.name.terms.length + n.frontMatter.terms.length + n.body.terms.length;

function keptNotes(app: App): { notes: Map<string, NoteFields>; terms: number } {
  let kept = KEPT.get(app);
  if (!kept) KEPT.set(app, (kept = { notes: new Map(), terms: 0 }));
  return kept;
}

/** A note's fields, kept per version (its hash) within the budget. */
async function noteFields(app: App, f: TFile, tableKey: string): Promise<NoteFields> {
  const kept = keptNotes(app);
  const old = kept.notes.get(f.path);
  if (old && old.hash === (await readHash(app, f))) return old;
  const { content, hash } = await readHashed(app, f);
  const n = fieldsOf(f.path, hash, content, tableKey);
  if (old) {
    kept.terms += sizeOf(n) - sizeOf(old);
    kept.notes.set(f.path, n);
  } else if (kept.terms + sizeOf(n) <= SEARCH_TERMS_CACHE.maxTerms) {
    kept.terms += sizeOf(n);
    kept.notes.set(f.path, n);
  }
  return n;
}

/** Forget the notes kept that are no longer in the vault. */
function forgetGone(app: App, present: ReadonlySet<string>): void {
  const kept = keptNotes(app);
  for (const [path, n] of kept.notes) {
    if (present.has(path)) continue;
    kept.notes.delete(path);
    kept.terms -= sizeOf(n);
  }
}

/** How many notes and terms the search keeps for an app (tests). */
export function searchTermsStats(app: App): { notes: number; terms: number } {
  const kept = KEPT.get(app);
  return { notes: kept?.notes.size ?? 0, terms: kept?.terms ?? 0 };
}

/** Whether a note holds every required term or phrase and none of the excluded ones (name, front matter or body). */
function allows(n: NoteFields, q: ParsedQuery): boolean {
  const holds = (terms: readonly string[]) => occurrences(n.name, terms) + occurrences(n.frontMatter, terms) + occurrences(n.body, terms) > 0;
  return q.required.every(holds) && !q.excluded.some(holds);
}

/** A table name of `tables` as semantic_search matches it: the qualified name, or its end after a dot. */
const wantTable = (tables: readonly string[] | undefined, table: string | null) =>
  !tables || tables.length === 0 || (table !== null && tables.some((x) => table === x || table.endsWith(`.${x}`)));

/** The heading above a place of a body (`""` before the first one). */
function headingAt(body: string, at: number): string {
  let heading = "";
  for (const m of body.slice(0, at).matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) heading = m[1]!;
  return heading;
}

/** About SNIPPET characters of a text around `at`, on one line. */
function around(text: string, at: number): string {
  const start = Math.max(0, at - 60);
  const cut = text.slice(start, start + SNIPPET).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${cut}${start + SNIPPET < text.length ? "…" : ""}`;
}

/** Where the first word of `terms` is in a text (as written), or -1. */
function firstMatch(text: string, terms: ReadonlySet<string>): number {
  for (const m of text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) if (searchTerms(m[0]).some((t) => terms.has(t))) return m.index;
  return -1;
}

/** The heading and snippet of a note found by its words: around its first match in the body, else in the front matter, else its beginning. */
function excerptOf(n: NoteFields, terms: ReadonlySet<string>): { heading: string; snippet: string } {
  // the snippet is of the prose: headings (the `heading` says which) and code fences left out
  const prose = n.bodyText
    .split("\n")
    .filter((l) => !/^(#{1,6}\s|\s*```|\s*~~~)/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const at = firstMatch(n.bodyText, terms);
  if (at >= 0) return { heading: headingAt(n.bodyText, at), snippet: around(prose, Math.max(0, firstMatch(prose, terms))) };
  const line = n.frontMatterLines.find((l) => firstMatch(l, terms) >= 0);
  if (line !== undefined) return { heading: "", snippet: around(line, 0) };
  return { heading: "", snippet: around(prose, 0) };
}

/** A note the search may read, with what it takes to rank it. */
interface Candidate {
  file: TFile;
  table: string | null;
}

interface Ranked {
  path: string;
  score: number;
  fields: NoteFields;
}

/** The notes ranked by BM25 for the query's terms, best first, without those the required and excluded words leave out. */
function rankByWords(notes: readonly { path: string; fields: NoteFields }[], corpus: number, q: ParsedQuery, terms: readonly string[]): Ranked[] {
  const df = terms.map((t) => notes.filter((n) => occurrences(n.fields.name, [t]) + occurrences(n.fields.frontMatter, [t]) + occurrences(n.fields.body, [t]) > 0).length);
  const idf = df.map((d) => Math.log(1 + (corpus - d + 0.5) / (d + 0.5)));
  const avg = notes.length === 0 ? 1 : Math.max(1, notes.reduce((s, n) => s + n.fields.body.terms.length, 0) / notes.length);
  const out: Ranked[] = [];
  for (const n of notes) {
    if (!allows(n.fields, q)) continue;
    const { name, frontMatter, body } = n.fields;
    let score = 0;
    let matched = 0;
    terms.forEach((t, i) => {
      const w = idf[i]!;
      const count = body.counts.get(t) ?? 0;
      const s = (count > 0 ? (w * count * (K1 + 1)) / (count + K1 * (1 - B + (B * body.terms.length) / avg)) : 0) + (name.counts.has(t) ? NAME * w : 0) + (frontMatter.counts.has(t) ? FRONT_MATTER * w : 0);
      if (s > 0) matched++;
      score += s;
    });
    if (matched === 0) continue;
    for (let i = 0; i + 1 < terms.length; i++) {
      const [a, b] = [terms[i]!, terms[i + 1]!];
      if (adjacent(name, a, b) || adjacent(frontMatter, a, b) || adjacent(body, a, b)) score += PAIR * Math.min(idf[i]!, idf[i + 1]!);
    }
    score *= (matched / terms.length) ** 2;
    out.push({ path: n.path, score, fields: n.fields });
  }
  return out.sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
}

/** A path with a part that starts with a dot. */
const HIDDEN = /(^|\/)\./;

/**
 * Search the notes by their words and, when the semantic index is on, by their meaning (`search`).
 * Under a read scope, a table named exactly in `tables` must be readable (403), and only the notes
 * the scope may read are searched, before the best are kept. The meaning ranking runs only with a
 * semantic index that is on; when its provider fails, the answer is the words' ranking, with the
 * reason (`meaning: "failed"`).
 */
export async function searchVault(app: App, settings: DatanotesSettings, input: NoteSearchInput, semantic?: SemanticIndex): Promise<NoteSearchResult> {
  if (typeof input.query !== "string" || input.query.trim() === "") throw new OperationInputError(`"query" is required`, SEARCH_GUIDE(`Give a few words, for example search({query: "pasta al pomodoro"}).`));
  // the metastore, which tells each note's table (cached once loaded)
  await loadMetastore(app, settings);
  const q = parseSearchQuery(input.query);
  const terms = [...new Set(searchTerms(q.text))];
  if (terms.length === 0) {
    throw new OperationInputError(
      "search: the query has no words to look for",
      SEARCH_GUIDE(`Give at least one word to rank by: "-word" only leaves notes out, and single letters are not searched. Example: search({query: "uovo -latte"}).`),
    );
  }
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 10)), 100);
  const folder = input.folder?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const scope = currentReadScope();
  if (scope) {
    const model = cachedMetastore(app, settings);
    for (const name of input.tables ?? []) {
      // a name that is no table (a pattern, an unknown or ambiguous name): narrowed by the notes it may read
      const full = model ? rowTableFull(model, name) : null;
      if (full !== null) assertTableReadable(full);
    }
  }

  // the notes the caller may search: every Markdown note (no dot-path) of the folder and tables it may read
  const files = app.vault.getMarkdownFiles();
  const corpus = new Map<string, Candidate>();
  for (const f of files) {
    if (HIDDEN.test(f.path)) continue;
    if (folder && !f.path.startsWith(`${folder}/`)) continue;
    if (scope && !pathReadable(app, settings, f.path, scope)) continue;
    const table = input.tables && input.tables.length > 0 ? tableOfPath(app, settings, f.path) : null;
    if (!wantTable(input.tables, table)) continue;
    corpus.set(f.path, { file: f, table });
  }

  // with the host's index of words: only the notes it names for some term (every note with the term is among them)
  let read: Iterable<Candidate> = corpus.values();
  if (terms.every(indexableWord)) {
    const named = new Set<string>();
    let all = false;
    for (const t of terms) {
      const c = searchCandidates(app, [t]);
      if (c === null) {
        all = true;
        break;
      }
      for (const list of [c.hits, c.unsure]) for (const p of list) named.add(p);
    }
    if (!all) read = [...named].map((p) => corpus.get(p)).filter((c): c is Candidate => c !== undefined);
  }
  const notes: { path: string; fields: NoteFields }[] = [];
  for (const c of read) notes.push({ path: c.file.path, fields: await noteFields(app, c.file, settings.tableKey) });
  forgetGone(app, new Set(files.map((f) => f.path)));
  const byWords = rankByWords(notes, corpus.size, q, terms);
  const termSet = new Set(terms);
  const tableOf = (path: string) => corpus.get(path)?.table ?? tableOfPath(app, settings, path);
  const words = (r: Ranked, score: number, matchedBy: MatchedBy[]): NoteSearchHit => {
    const table = tableOf(r.path);
    return { path: r.path, ...(table ? { table } : {}), score, ...excerptOf(r.fields, termSet), matched_by: matchedBy };
  };

  // the meaning ranking: only with a semantic index that is on
  if (!semantic || !settings.semanticEnabled) {
    return { query: input.query, results: byWords.slice(0, limit).map((r) => words(r, Math.round(r.score * 100) / 100, ["words"])), meaning: "off" };
  }
  let meaningHits: { path: string; heading: string; snippet: string; table?: string }[];
  try {
    const r = await semantic.search({
      query: q.text,
      limit: MEANING_DEPTH,
      ...(input.tables && input.tables.length > 0 ? { tables: input.tables } : {}),
      ...(folder ? { folder } : {}),
      ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
    });
    meaningHits = r.results;
  } catch (e) {
    if (e instanceof ReadDeniedError || e instanceof OperationInputError) throw e;
    return { query: input.query, results: byWords.slice(0, limit).map((r) => words(r, Math.round(r.score * 100) / 100, ["words"])), meaning: "failed", meaning_error: messageOf(e) };
  }

  // the meaning hits the words' filters allow, among the notes the caller may search
  const meaning: { path: string; heading: string; snippet: string; fields: NoteFields }[] = [];
  for (const h of meaningHits) {
    const c = corpus.get(h.path);
    if (!c) continue;
    const fields = await noteFields(app, c.file, settings.tableKey);
    if (!allows(fields, q)) continue;
    meaning.push({ path: h.path, heading: h.heading, snippet: h.snippet, fields });
    if (meaning.length === FUSION_DEPTH) break;
  }
  const fused = new Map<string, { score: number; wordsRank: number; ranked?: Ranked; meaning?: (typeof meaning)[number] }>();
  byWords.slice(0, FUSION_DEPTH).forEach((r, i) => fused.set(r.path, { score: 1 / (RRF_K + i + 1), wordsRank: i + 1, ranked: r }));
  meaning.forEach((m, i) => {
    const f = fused.get(m.path) ?? { score: 0, wordsRank: Infinity };
    f.score += 1 / (RRF_K + i + 1);
    f.meaning = m;
    fused.set(m.path, f);
  });
  const results = [...fused.entries()]
    // two notes never tie on both: each rank of a ranking is a different score
    .sort(([pa, a], [pb, b]) => b.score - a.score || a.wordsRank - b.wordsRank || pa.localeCompare(pb))
    .slice(0, limit)
    .map(([path, f]): NoteSearchHit => {
      const score = Math.round(f.score * 10_000) / 10_000;
      if (f.ranked) return words(f.ranked, score, f.meaning ? ["words", "meaning"] : ["words"]);
      const table = tableOf(path);
      return { path, ...(table ? { table } : {}), score, heading: f.meaning!.heading, snippet: f.meaning!.snippet, matched_by: ["meaning"] };
    });
  return { query: input.query, results, meaning: "on" };
}
