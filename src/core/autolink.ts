/**
 * Automatic links: the text a write puts in a note's body links the notes it mentions by name, so
 * a mention an agent left as plain text still becomes a link. It runs on insert_row's `body`,
 * update_row's `body`, `body_sections`, `body_prepend` and `body_append`
 * (in a batch too), when the database's `autolink` setting is on (the default) or the write passes
 * `autolink: true`; `autolink: false` turns it off for one write. A write over HTTP with a named
 * token and no `autolink` of its own takes the token's `autolink` default (src/server/tokens.ts):
 * sync programs keep their tokens' default off.
 *
 * - **Names**: every Markdown note of the vault, row or plain note, is known by its file name and
 *   its `aliases` (Obsidian's property). Left out: names shorter than {@link MIN_NAME_LENGTH}
 *   characters, without a letter, that look like a date, a time or an id (the file names of
 *   time-based rows), or that are common words ({@link STOP_NAMES}); the notes in the tables'
 *   archive folders; the rows of tables that are no link targets ({@link isLinkTarget}: a table's
 *   `autolink_target` property, else every table but those whose rows are named by a date or a
 *   time); the note being written.
 * - **Mentions**: whole words, case-insensitive, on one line. A one-word mention is linked only
 *   when written with a capital (`will` never links a note `Will`, nor `house` a note `house`), and
 *   not at the start of a sentence, a line, a list item or a label (`House: clean`), where a capital
 *   says nothing: that one comes back as `sentence_start`. A mention glued to a path, a domain, an
 *   address or a snake_case word (`Documents/House/x.pdf`, `greenmart.com`, `House_new`) is none.
 *   Code, links, URLs, tags, HTML, comments, math, Dataview inline fields and Templater blocks are
 *   skipped, and so are headings: a heading's text is its anchor, which `[[note#heading]]` links
 *   and `body_sections` find it by. The front matter is never part of the text.
 * - **Read permissions**: a write by a token with restricted `read` patterns (src/core/read-scope.ts)
 *   links only the notes it may read: the others' names are plain text to it, never a link that
 *   would put their names in the row. The shared name index is filtered as it is read, never changed.
 * - **Longest match wins**: `Nora Wells` links the note of that name, not `Nora`.
 * - **First mention**: each note is linked once per body, at its first mention in the text written,
 *   and not at all when the body links it already (the usual convention of wikis).
 * - **Doubt**: a mention is not linked, and comes back in `ambiguous_mentions` with its candidates, when
 *   several notes have its name (`same_name`), when mentions of different notes stand next to each
 *   other as one phrase (`adjacent`: `Nora Wells` with the notes `Nora` and `Wells`), when
 *   the names overlap (`overlap`), or when a capitalized word next to it suggests a longer name that
 *   is no note (`part_of_name`: `Philadelphia` in `The Philadelphia Story`). The other mentions of
 *   a doubtful name in the same text stay as they are too (a `sentence_start` mention excepted: a
 *   later mention of the name in a sentence is linked).
 *
 * Links are written as the vault writes them (`linkTo`, as for link columns), with the text as it
 * was written: `[[Cary Grant]]`, or `[[Cary Grant|cary grant]]` when it differs.
 *
 * The names are indexed once per engine and kept up to date file by file: after the vault changes,
 * a write goes over the list of files and reads again the names of the files whose size or time
 * changed only.
 */

import type { App, TFile } from "./host";
import { archiveFolder, catalogLoadedTable } from "./engine";
import { vaultGeneration } from "./file-cache";
import { linkTo } from "./inverse";
import { cachedMetastore, catalogTables, loadMetastore, rowTableFull, type CatalogTableEntry, type Metastore } from "./metastore";
import type { DatanotesSettings } from "./settings";
import type { TableDefinition } from "./types-table";
import { phase } from "./tracing";
import { currentReadScope, pathReadable } from "./read-scope";
import { vaultIndex } from "./vault-index";

/** Why a mention was not linked. */
export type AmbiguityReason = "same_name" | "adjacent" | "overlap" | "part_of_name" | "sentence_start";

/** A link the write added. */
export interface LinkAdded {
  /** The note the link was written into. */
  path: string;
  /** The mention, as written. */
  text: string;
  /** The vault path of the note it links. */
  target: string;
  /** The link written in place of the mention. */
  link: string;
}

/** A mention left as text: the agent reads the candidates and links the right one, or none. */
export interface LinkAmbiguous {
  path: string;
  text: string;
  reason: AmbiguityReason;
  /** The vault paths of the notes it may name. */
  candidates: string[];
  /** The line around the mention. */
  context: string;
  hint: string;
}

export interface AutolinkReport {
  added: LinkAdded[];
  ambiguous: LinkAmbiguous[];
}

/** A name needs at least this many characters (`Ada`, not `Al`). */
export const MIN_NAME_LENGTH = 3;

/** The words a name may have at most (a longer one is still a name, never matched). */
const MAX_NAME_WORDS = 12;

/**
 * Names never linked: hub notes many vaults have (`Inbox`, `Index`, `Welcome`) and common words of
 * the prose agents write, in English and Italian. A note with one of these names is linked by hand.
 */
export const STOP_NAMES: ReadonlySet<string> = new Set([
  // hub notes and folders
  "home", "index", "inbox", "readme", "todo", "to do", "untitled", "welcome", "note", "notes", "idea", "ideas",
  "journal", "daily", "today", "task", "tasks", "project", "projects", "people", "meeting", "meetings",
  "archive", "template", "templates", "draft", "drafts", "misc", "log",
  // English
  "the", "and", "but", "for", "nor", "not", "yet", "with", "from", "into", "this", "that", "these", "those",
  "then", "than", "there", "here", "what", "when", "where", "which", "who", "why", "how", "all", "any",
  "some", "one", "two", "are", "was", "were", "has", "have", "had", "you", "your", "our", "its", "his",
  "her", "she", "him", "they", "them", "also", "just", "very", "about", "after", "before", "more", "other",
  "new", "now", "see", "next", "last", "first",
  // Italian
  "che", "chi", "con", "per", "una", "uno", "del", "dei", "della", "delle", "degli", "dal", "dalla", "nel",
  "nella", "sul", "sulla", "non", "sono", "come", "anche", "più", "tra", "fra", "questo", "questa", "quello",
  "quella", "oggi", "nota", "idee",
]);

/** A word: letters, digits and their combining marks, in any script. */
const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
/** Dates and times as notes are named after them: `2026-09-27`, `2026-09-27T0900`, `2026-W40`, `2026-Q3`. */
const DATE_LIKE = /^\d{4}(?:[-./]\d{1,2}(?:[-./]\d{1,2})?(?:[T _]\d{1,2}(?:[:.]?\d{2}){0,2}(?:Z|[+-]\d{2}:?\d{2})?)?|-?W\d{1,2}|-?Q[1-4])(?:-\d+)?$/i;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What lies between the words of one phrase: spaces, or a hyphen (`Lloyd-Webber`). */
const PHRASE_SEP = /^(?:[ \t]+|-)$/;

/** The words of a name or a mention compare on this: whitespace as one space, curly apostrophes straight. */
function normSep(s: string): string {
  return s.replace(/\s+/gu, " ").replace(/[‘’]/g, "'");
}

/** The key a name is matched by, or null when the name is never matched. */
export function nameKey(name: string): string | null {
  const n = normSep(name.normalize("NFC")).replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, "");
  if ([...n].length < MIN_NAME_LENGTH || !/\p{L}/u.test(n)) return null;
  if (DATE_LIKE.test(n) || UUID_LIKE.test(n) || /[[\]|#^\n]/.test(n)) return null;
  const key = n.toLowerCase();
  if (STOP_NAMES.has(key)) return null;
  if ([...key.matchAll(WORD_RE)].length > MAX_NAME_WORDS) return null;
  return key;
}

/** The prefixes of a key that end with one of its words (`cary`, `cary grant`). */
function prefixesOf(key: string): string[] {
  return [...key.matchAll(WORD_RE)].map((m) => key.slice(0, m.index! + m[0].length));
}

// --- the index of names ----------------------------------------------------------------------------

interface FileNames {
  /** `mtime:size`, or null when the host gives no stats (read again every time). */
  stamp: string | null;
  names: { key: string; name: string }[];
}

interface NameIndex {
  generation: number;
  scope: LinkScope;
  files: Map<string, FileNames>;
  /** key → path → the name as the note writes it. */
  byKey: Map<string, Map<string, string>>;
  /** Prefixes of the keys, counted: a mention stops growing when no key starts like it. */
  prefixes: Map<string, number>;
  /** Where the vault index's change log was at the last look (vault-index.ts), when the host has one. */
  vault?: { epoch: number; cursor: number };
}

/** Which notes may be link targets: not those in the tables' archive folders, nor the rows of the tables that are no targets. */
interface LinkScope {
  archives: readonly string[];
  /** Tables (`catalog.schema.table`) whose rows are never linked. */
  excluded: ReadonlySet<string>;
  model: Metastore | null;
}

const INDEXES = new WeakMap<object, NameIndex>();
const SCOPES = new WeakMap<object, LinkScope>();
const NO_SCOPE: LinkScope = { archives: [], excluded: new Set(), model: null };

function stampOf(f: TFile): string | null {
  const s = f.stat;
  return s && typeof s.mtime === "number" && typeof s.size === "number" ? `${s.mtime}:${s.size}` : null;
}

/** The names a note is known by: its file name and its `aliases`; none for a row of a table that is no link target. */
function namesOf(app: App, settings: DatanotesSettings, scope: LinkScope, f: TFile): FileNames["names"] {
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  if (fm && scope.model && scope.excluded.size > 0) {
    const table = rowTableFull(scope.model, (fm as Record<string, unknown>)[settings.tableKey]);
    if (table !== null && scope.excluded.has(table)) return [];
  }
  const raw = fm ? [fm.aliases, fm.alias].flatMap((v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])) : [];
  const out: FileNames["names"] = [];
  for (const name of [f.basename, ...raw.filter((x): x is string => typeof x === "string")]) {
    const key = nameKey(name);
    if (key !== null && !out.some((x) => x.key === key)) out.push({ key, name: name.trim() });
  }
  return out;
}

function addNames(ix: NameIndex, path: string, names: FileNames["names"]): void {
  for (const { key, name } of names) {
    let paths = ix.byKey.get(key);
    if (!paths) ix.byKey.set(key, (paths = new Map()));
    paths.set(path, name);
    for (const p of prefixesOf(key)) ix.prefixes.set(p, (ix.prefixes.get(p) ?? 0) + 1);
  }
}

function removeNames(ix: NameIndex, path: string, names: FileNames["names"]): void {
  for (const { key } of names) {
    const paths = ix.byKey.get(key);
    paths?.delete(path);
    if (paths?.size === 0) ix.byKey.delete(key);
    for (const p of prefixesOf(key)) {
      const n = ix.prefixes.get(p)! - 1; // counted when the name was added
      if (n <= 0) ix.prefixes.delete(p);
      else ix.prefixes.set(p, n);
    }
  }
}

/** Whether the file names of a table's rows are made of a date or date-time column: a table of events or records. */
function timeNamed(def: TableDefinition): boolean {
  const template = `${def.options.partition ?? ""}/${def.options.filename ?? ""}`;
  const used = new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)(?::[^}]+)?\}/g)].map((m) => m[1]!));
  return def.columns.some((c) => used.has(c.name) && (c.type === "date" || c.type === "datetime"));
}

/**
 * Whether the rows of a table may be link targets: its `autolink_target` property (create_table's
 * options, alter_table), else every table but those whose rows are named by a date or a time
 * (meals, readings, events: their names are moments, or titles no text means as a name).
 */
export function isLinkTarget(entry: CatalogTableEntry, def: TableDefinition): boolean {
  const own = entry.options?.autolink_target;
  return typeof own === "boolean" ? own : !timeNamed(def);
}

/** The tables' archive folders and the tables that are no link targets, once per metastore. */
async function linkScope(app: App, settings: DatanotesSettings): Promise<LinkScope> {
  const hit = SCOPES.get(app);
  const model = cachedMetastore(app, settings);
  if (hit && model && hit.model === model) return hit;
  const ms = await loadMetastore(app, settings).catch(() => null);
  if (!ms) return NO_SCOPE;
  const archives: string[] = [];
  const excluded = new Set<string>();
  for (const { ref, entry } of catalogTables(ms.model)) {
    try {
      const def = catalogLoadedTable(settings, ms, ref).def;
      archives.push(archiveFolder(def));
      if (!isLinkTarget(entry, def)) excluded.add(ref.full);
    } catch {
      // a table that does not load has no archive to leave out; its rows are targets unless it says no
      if (entry.options?.autolink_target === false) excluded.add(ref.full);
    }
  }
  const scope: LinkScope = { archives, excluded, model: ms.model };
  SCOPES.set(app, scope);
  return scope;
}

/** The index of note names, brought up to date with the vault. */
async function nameIndex(app: App, settings: DatanotesSettings): Promise<NameIndex> {
  return namesUpToDate(app, settings, await linkScope(app, settings));
}

/** The index of note names under `scope`, brought up to date with the vault. */
function namesUpToDate(app: App, settings: DatanotesSettings, scope: LinkScope): NameIndex {
  const generation = vaultGeneration(app);
  let ix = INDEXES.get(app);
  const vi = vaultIndex(app, settings);
  // the vault read again (another table key): every note is read again
  const reread = vi !== null && ix?.vault !== undefined && ix.vault.epoch !== vi.epoch;
  // up to date: nothing in the vault index's change log since the last look (else no invalidation since)
  const current = vi ? ix?.vault !== undefined && !reread && ix.vault.cursor === vi.cursor : ix?.generation === generation;
  if (ix && current && ix.scope === scope) return ix;
  // a new scope (a table's option, an archive folder): every note is read again too
  if (!ix || ix.scope !== scope || reread) INDEXES.set(app, (ix = { generation: -1, scope, files: new Map(), byKey: new Map(), prefixes: new Map() }));
  const archived = (p: string) => scope.archives.some((a) => p.startsWith(`${a}/`));
  // with a vault index, only the notes changed since the last look are read again
  const changed = vi && ix.vault?.epoch === vi.epoch ? vi.changedSince(ix.vault.cursor, vi.epoch) : null;
  if (vi && changed) {
    const notes: TFile[] = [];
    for (const p of changed) {
      const n = vi.note(p);
      if (n) notes.push(n.file);
      else forgetNames(ix, p); // gone
    }
    // in the vault's order, as a full pass adds them
    notes.sort((a, b) => vi.note(a.path)!.order - vi.note(b.path)!.order);
    for (const f of notes) {
      if (archived(f.path)) {
        forgetNames(ix, f.path);
        continue;
      }
      const cur = ix.files.get(f.path);
      const names = namesOf(app, settings, scope, f);
      if (cur) removeNames(ix, f.path, cur.names);
      addNames(ix, f.path, names);
      ix.files.set(f.path, { stamp: stampOf(f), names });
    }
    ix.vault = { epoch: vi.epoch, cursor: vi.cursor };
    ix.generation = generation;
    return ix;
  }
  const seen = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) {
    const stamp = stampOf(f);
    const cur = ix.files.get(f.path);
    // a note indexed under this scope is outside the archives: only new and changed notes are checked
    if (cur && stamp !== null && cur.stamp === stamp) {
      seen.add(f.path);
      continue;
    }
    if (archived(f.path)) continue;
    seen.add(f.path);
    const names = namesOf(app, settings, scope, f);
    if (cur) removeNames(ix, f.path, cur.names);
    addNames(ix, f.path, names);
    ix.files.set(f.path, { stamp, names });
  }
  for (const [p, cur] of ix.files) {
    if (seen.has(p)) continue;
    removeNames(ix, p, cur.names);
    ix.files.delete(p);
  }
  if (vi) ix.vault = { epoch: vi.epoch, cursor: vi.cursor };
  ix.generation = generation;
  return ix;
}

/**
 * How the name index kept up to date note by note differs from one built from every note now
 * (index-check.ts); empty when they agree, or when there is none yet.
 */
export function verifyNameIndex(app: App, settings: DatanotesSettings): string[] {
  // the scope the next use would take: with another metastore, it is built again then
  const scope = SCOPES.get(app);
  if (!INDEXES.has(app) || !scope || scope.model !== cachedMetastore(app, settings)) return [];
  const ix = namesUpToDate(app, settings, scope);
  const fresh: NameIndex = { generation: 0, scope: ix.scope, files: new Map(), byKey: new Map(), prefixes: new Map() };
  for (const f of app.vault.getMarkdownFiles()) {
    if (ix.scope.archives.some((a) => f.path.startsWith(`${a}/`))) continue;
    const names = namesOf(app, settings, ix.scope, f);
    addNames(fresh, f.path, names);
    fresh.files.set(f.path, { stamp: stampOf(f), names });
  }
  const show = (x: NameIndex) => JSON.stringify([[...x.files].map(([p, f]) => [p, f.names]), [...x.byKey].map(([k, m]) => [k, [...m]]).sort(), [...x.prefixes].sort()]);
  return show(ix) === show(fresh) ? [] : ["autolink names differ from the notes' names"];
}

/** A note no longer named in the index (gone, or archived). */
function forgetNames(ix: NameIndex, path: string): void {
  const cur = ix.files.get(path);
  if (!cur) return;
  removeNames(ix, path, cur.names);
  ix.files.delete(path);
}

// --- the text --------------------------------------------------------------------------------------

/** Spans of the text never linked: code, links, URLs, tags, HTML, comments, math, headings. */
const PROTECTED: RegExp[] = [
  /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:^ {0,3}\2[ \t]*$|(?![\s\S]))|$)/gm, // fenced code
  /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, // inline code
  /^ {0,3}#{1,6}(?:[ \t][^\n]*)?$/gm, // headings
  /!?\[\[[^\]\n]*\]\]/g, // wikilinks and embeds
  /!?\[[^\]\n]*\]\([^)\n]*\)/g, // Markdown links and images
  /!?\[[^\]\n]*\]\[[^\]\n]*\]/g, // reference links
  /^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, // link reference definitions
  /\[[!^][^\]\n]*\]/g, // callout types, footnotes
  /<!--[\s\S]*?-->/g, // HTML comments
  /%%[\s\S]*?%%/g, // Obsidian comments
  /<\/?[A-Za-z][^>\n]*>/g, // HTML tags, autolinks
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()[\]]+/gi, // URLs
  /\bwww\.[^\s<>()[\]]+/gi,
  /\b(?:mailto|obsidian|file):[^\s<>()[\]]+/gi,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // e-mail addresses
  /\$\$[\s\S]*?\$\$/g, // math
  /\$[^$\n]+\$/g,
  /(?<=^|[\s(])#[\p{L}\p{N}_/-]+/gmu, // tags
  /\s\^[A-Za-z0-9-]+[ \t]*$/gm, // block ids
  // Dataview inline fields: a `key:: value` line (in a list or a quote too), `[key:: value]`, `(key:: value)`
  /^[ \t]*(?:(?:[-+*>]|\d+[.)])[ \t]+)*(?:\[[ xX]\][ \t]+)?(?:\*\*|__)?[\p{L}\p{N}_][^\n:[\]()]*?(?:\*\*|__)?::[^\n]*$/gmu,
  /\[[^\]\n]*?::[^\]\n]*\]/g,
  /\([^)\n]*?::[^)\n]*\)/g,
  /<%[\s\S]*?(?:%>|(?![\s\S]))/g, // Templater blocks
];

/** The parts of the text that may be linked, as [start, end) ranges. */
function freeSegments(text: string): [number, number][] {
  const taken: [number, number][] = [];
  for (const re of PROTECTED) for (const m of text.matchAll(re)) if (m[0].length > 0) taken.push([m.index!, m.index! + m[0].length]);
  taken.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of taken) {
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < text.length) out.push([at, text.length]);
  return out;
}

interface Token {
  start: number;
  end: number;
  /** The word as compared: NFC, lowercase. */
  norm: string;
}

/** A run of words that is a name of the index. */
interface Match {
  ti: number;
  tj: number;
  start: number;
  end: number;
  key: string;
  /** The notes it may name, the note being written left out. */
  cands: string[];
  /** It names the note being written: it links nothing, and nothing inside it is linked. */
  self: boolean;
}

/** A mention, resolved: linked when `kind` is `clear`. */
interface Mention {
  frag: number;
  start: number;
  end: number;
  keys: string[];
  cands: string[];
  kind: "clear" | "self" | AmbiguityReason;
}

const hasUpper = (s: string) => /[\p{Lu}\p{Lt}]/u.test(s);
/** A capitalized word, `Brighton` (not `I`, not `DVD`). */
const titleCase = (s: string) => /^[\p{Lu}\p{Lt}]/u.test(s) && /\p{Ll}/u.test(s);

/** Whether the word at `at` begins a sentence, a line or a list item (its capital says nothing). */
function startsSentence(text: string, at: number): boolean {
  const before = text.slice(text.lastIndexOf("\n", at - 1) + 1, at).replace(/[\s*_~"'“”‘’«»(\[]+$/u, "");
  return before === "" || /[.!?:;…]$/u.test(before) || /^(?:\s*(?:[-+*>]|\d+[.)]|\[[ xX]\]))+$/u.test(before);
}

/** Characters that glue a word to a path, a domain, an address or a snake_case word. */
const GLUE = /[_./\\@:]/;
const GLUE_ALWAYS = /[_/\\@]/;

/**
 * Whether the words at [start, end) stand alone: not glued to what is around them by `_ . / \ @ :`
 * (`Documents/House/bill.pdf`, `greenmart.com`, `House_new`). A `.` or `:` after them ends a
 * sentence or opens a label when a space, or nothing, follows it.
 */
function standsAlone(text: string, start: number, end: number): boolean {
  if (start > 0 && GLUE.test(text[start - 1]!)) return false;
  const after = text[end];
  if (after === undefined) return true;
  if (GLUE_ALWAYS.test(after)) return false;
  if (after === "." || after === ":") return !/[\p{L}\p{N}_/\\]/u.test(text[end + 1] ?? "");
  return true;
}

/**
 * The matches of the index in one segment of the text. `visible`: the notes the write may link
 * (a restricted token's read scope); the others are no notes to it, their names plain text.
 */
function matchesIn(text: string, tokens: Token[], ix: NameIndex, self: ReadonlySet<string>, visible: (path: string) => boolean): Match[] {
  const out: Match[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let key = tokens[i]!.norm;
    for (let j = i; ; ) {
      if (!ix.prefixes.has(key)) break;
      const paths = ix.byKey.get(key);
      const start = tokens[i]!.start;
      const end = tokens[j]!.end;
      // one word in lowercase (`will`, `house`) is an ordinary word, whatever the name's own case;
      // a word glued to a path, a domain or a snake_case word is part of it
      if (paths && (i !== j || hasUpper(text.slice(start, end))) && standsAlone(text, start, end)) {
        const cands: string[] = [];
        let any = false;
        let isSelf = false;
        for (const p of paths.keys()) {
          if (self.has(p)) isSelf = true;
          else if (visible(p)) cands.push(p);
          else continue;
          any = true;
        }
        if (any) out.push({ ti: i, tj: j, start: tokens[i]!.start, end: tokens[j]!.end, key, cands: isSelf ? [] : cands.sort(), self: isSelf });
      }
      if (j + 1 >= tokens.length || j - i + 1 >= MAX_NAME_WORDS) break;
      const sep = text.slice(tokens[j]!.end, tokens[j + 1]!.start);
      if (sep.includes("\n")) break;
      key += normSep(sep) + tokens[j + 1]!.norm;
      j++;
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** The mentions of one fragment of text, resolved: longest match, overlaps, phrases, longer names. */
function mentionsIn(text: string, frag: number, ix: NameIndex, self: ReadonlySet<string>, visible: (path: string) => boolean): Mention[] {
  const out: Mention[] = [];
  for (const [a, b] of freeSegments(text)) {
    const tokens: Token[] = [...text.slice(a, b).matchAll(WORD_RE)].map((m) => ({
      start: a + m.index!,
      end: a + m.index! + m[0].length,
      norm: m[0].normalize("NFC").toLowerCase(),
    }));
    const matches = matchesIn(text, tokens, ix, self, visible);
    if (matches.length === 0) continue;
    const inMatch = new Set<number>();
    for (const m of matches) for (let t = m.ti; t <= m.tj; t++) inMatch.add(t);
    // overlapping matches: the longest wins when it covers them all; else nobody knows
    const items: (Mention & { ti: number; tj: number })[] = [];
    for (let g = 0; g < matches.length; ) {
      const group = [matches[g]!];
      let end = matches[g]!.end;
      for (g++; g < matches.length && matches[g]!.start < end; g++) {
        group.push(matches[g]!);
        end = Math.max(end, matches[g]!.end);
      }
      const start = group[0]!.start;
      const longest = group.reduce((x, y) => (y.end - y.start > x.end - x.start ? y : x));
      const ti = Math.min(...group.map((m) => m.ti));
      const tj = Math.max(...group.map((m) => m.tj));
      if (longest.start === start && longest.end === end) {
        const kind = longest.self ? "self" : longest.cands.length > 1 ? "same_name" : "clear";
        items.push({ frag, start, end, keys: [longest.key], cands: longest.cands, kind, ti, tj });
      } else {
        const cands = [...new Set(group.flatMap((m) => m.cands))].sort();
        items.push({ frag, start, end, keys: group.map((m) => m.key), cands, kind: cands.length === 0 ? "self" : "overlap", ti, tj });
      }
    }
    // mentions of different notes side by side read as one phrase: `Nora Wells`
    for (let i = 0; i < items.length; ) {
      let j = i;
      while (j + 1 < items.length && items[j]!.kind !== "self" && items[j + 1]!.kind !== "self" && PHRASE_SEP.test(text.slice(items[j]!.end, items[j + 1]!.start))) j++;
      const run = items.slice(i, j + 1);
      const cands = [...new Set(run.flatMap((m) => m.cands))].sort();
      if (run.length > 1 && cands.length > 1) {
        out.push({ frag, start: run[0]!.start, end: run.at(-1)!.end, keys: run.flatMap((m) => m.keys), cands, kind: "adjacent" });
      } else {
        for (const m of run) {
          if (m.kind === "clear" && m.ti === m.tj && startsSentence(text, m.start)) {
            // one word where every word has a capital: `House: clean`, `Work from the garden`
            m.kind = "sentence_start";
          } else if (m.kind === "clear") {
            // a capitalized word next to it, not itself a name: part of a longer name
            const prev = m.ti > 0 ? tokens[m.ti - 1]! : null;
            const next = m.tj + 1 < tokens.length ? tokens[m.tj + 1]! : null;
            const word = (t: Token) => text.slice(t.start, t.end);
            const longer =
              (prev && !inMatch.has(m.ti - 1) && PHRASE_SEP.test(text.slice(prev.end, m.start)) && titleCase(word(prev)) && !startsSentence(text, prev.start)) ||
              (next && !inMatch.has(m.tj + 1) && PHRASE_SEP.test(text.slice(m.end, next.start)) && titleCase(word(next)));
            if (longer) m.kind = "part_of_name";
          }
          const { ti: _ti, tj: _tj, ...mention } = m;
          out.push(mention);
        }
      }
      i = j + 1;
    }
  }
  return out;
}

/** The line around a mention, at most about 160 characters. */
function contextOf(text: string, start: number, end: number): string {
  const ls = text.lastIndexOf("\n", start - 1) + 1;
  const le = text.indexOf("\n", end);
  const line = text.slice(ls, le < 0 ? text.length : le);
  const s = start - ls;
  const e = end - ls;
  if (line.length <= 160) return line.trim();
  const from = Math.max(0, s - 70);
  const to = Math.min(line.length, e + 70);
  return `${from > 0 ? "…" : ""}${line.slice(from, to).trim()}${to < line.length ? "…" : ""}`;
}

function hintFor(reason: AmbiguityReason, text: string): string {
  const then = "then write the link with update_row and autolink: false, or leave the text as it is";
  switch (reason) {
    case "same_name":
      return `Several notes are named "${text}": read them with read_note and the text around it, ${then}.`;
    case "adjacent":
      return `"${text}" may name one thing, and each note names a part of it: read the notes and the text around it, ${then}.`;
    case "overlap":
      return `The names of these notes overlap in "${text}": read them and the text around it, ${then}.`;
    case "part_of_name":
      return `"${text}" may be part of a longer name: read the note and the text around it, ${then}.`;
    case "sentence_start":
      return `"${text}" starts a sentence, a line or a label, so its capital does not make it a name: read the note and the text around it, ${then}.`;
  }
}

/**
 * Whether the line at `at` may be a row of a Markdown table: it has a `|` that is not escaped,
 * nor in a link or code (a table needs no leading `|`). There the alias's `|` would end the cell.
 */
function inTableRow(text: string, at: number): boolean {
  const ls = text.lastIndexOf("\n", at - 1) + 1;
  const le = text.indexOf("\n", at);
  const line = text.slice(ls, le < 0 ? text.length : le).replace(/\[\[[^\]\n]*\]\]|(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, "");
  return /(?<!\\)\|/.test(line);
}

/** The vault paths the links of a text resolve to, from `source`. */
export function linkedTargets(app: App, text: string, source: string): Set<string> {
  const out = new Set<string>();
  const add = (linkpath: string) => {
    const p = linkpath.trim();
    if (p === "") return;
    const dest = app.metadataCache.getFirstLinkpathDest(p, source);
    if (dest) out.add(dest.path);
  };
  // a row of a pack is [[pack#row]]: its heading too, on a host with packs
  for (const m of text.matchAll(/\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) add(app.packs !== undefined && m[1]!.trim() !== "" && (m[2] ?? "").trim().length > 1 ? `${m[1]}${m[2]!.trim()}` : m[1]!);
  for (const m of text.matchAll(/\[[^\]\n]*\]\(<?([^)\s>#]+\.md)(?:#[^)\s]*)?>?\)/gi)) {
    try {
      add(decodeURI(m[1]!));
    } catch {
      add(m[1]!);
    }
  }
  return out;
}

export interface AutolinkInput {
  /** The note written: links are written as seen from it. */
  path: string;
  /** Paths of the note being written (before and after a rename): never linked. */
  self?: readonly string[];
  /** The texts the write puts in the body, in the order they appear in it. */
  fragments: readonly string[];
  /** The body as the write leaves it, the fragments as given: the notes it links already. */
  body: string;
}

/**
 * Link the notes the fragments mention. Returns the fragments with their links, the links added
 * and the mentions left as text with their candidates.
 */
async function autolinkFragmentsImpl(
  app: App,
  settings: DatanotesSettings,
  input: AutolinkInput,
): Promise<{ fragments: string[]; report: AutolinkReport }> {
  const report: AutolinkReport = { added: [], ambiguous: [] };
  if (input.fragments.every((f) => f.trim() === "")) return { fragments: [...input.fragments], report };
  const ix = await nameIndex(app, settings);
  const self = new Set([input.path, ...(input.self ?? [])]);
  // the name index is shared by every request: a read scope filters the notes here, never in it
  const scope = currentReadScope();
  const seenVisible = new Map<string, boolean>();
  const visible = (p: string): boolean => {
    if (!scope) return true;
    let v = seenVisible.get(p);
    if (v === undefined) seenVisible.set(p, (v = pathReadable(app, settings, p, scope)));
    return v;
  };
  const mentions = input.fragments.flatMap((text, i) => mentionsIn(text, i, ix, self, visible));
  // a name in doubt stays text everywhere; one at the start of a sentence only there
  const doubtful = new Set(mentions.filter((m) => m.kind !== "clear" && m.kind !== "self" && m.kind !== "sentence_start").flatMap((m) => m.keys));
  const linked = linkedTargets(app, input.body, input.path);
  const edits: { frag: number; start: number; end: number; link: string }[] = [];
  for (const m of mentions) {
    if (m.kind !== "clear" || m.keys.some((k) => doubtful.has(k))) continue;
    const target = m.cands[0]!;
    if (linked.has(target)) continue;
    linked.add(target);
    const text = input.fragments[m.frag]!;
    const written = text.slice(m.start, m.end);
    const inner = linkTo(app, target, input.path).slice(2, -2);
    const bar = inTableRow(text, m.start) ? "\\|" : "|";
    const link = `[[${inner}${inner === written ? "" : `${bar}${written}`}]]`;
    edits.push({ frag: m.frag, start: m.start, end: m.end, link });
    report.added.push({ path: input.path, text: written, target, link });
  }
  const seen = new Set<string>();
  for (const m of mentions) {
    if (m.kind === "clear" || m.kind === "self" || m.cands.some((c) => linked.has(c))) continue;
    // a name in doubt elsewhere in the text is asked about there
    if (m.kind === "sentence_start" && m.keys.some((k) => doubtful.has(k))) continue;
    const text = input.fragments[m.frag]!;
    const written = text.slice(m.start, m.end);
    const id = `${m.kind}\0${written.toLowerCase()}\0${m.cands.join("\0")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    report.ambiguous.push({ path: input.path, text: written, reason: m.kind, candidates: m.cands, context: contextOf(text, m.start, m.end), hint: hintFor(m.kind, written) });
  }
  const fragments = input.fragments.map((text, i) => {
    let out = text;
    for (const e of edits.filter((x) => x.frag === i).sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.link + out.slice(e.end);
    return out;
  });
  return { fragments, report };
}

/** Whether a write links: its own `autolink`, else the database's setting. */
export function autolinkOn(given: boolean | undefined, setting: boolean): boolean {
  return given ?? setting;
}

/** The result of a write with its report: the fields only when there is something to report. */
export function withLinkReport<R extends { ok: boolean }>(result: R, report: AutolinkReport | null): R & { links_added?: LinkAdded[]; ambiguous_mentions?: LinkAmbiguous[] } {
  if (!report || !result.ok) return result;
  return {
    ...result,
    ...(report.added.length > 0 ? { links_added: report.added } : {}),
    ...(report.ambiguous.length > 0 ? { ambiguous_mentions: report.ambiguous } : {}),
  };
}

/** {@link autolinkFragmentsImpl}, traced: link resolution of a note's text. */
export function autolinkFragments(...args: Parameters<typeof autolinkFragmentsImpl>): ReturnType<typeof autolinkFragmentsImpl> {
  return phase("engine.autolink", () => autolinkFragmentsImpl(...args));
}
