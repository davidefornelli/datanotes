/**
 * What an error tells the agent that made the mistake, besides what is wrong: how to fix it (the
 * `hint`: the allowed values, the right shape, the closest real name, the operation that lists the
 * answer) and where to read more (`docs`: a page of datanotes.dev in Markdown, the format agents
 * read best, with its anchor). Every error of the engine follows this standard; the HTTP API sends
 * `hint` and `docs` next to `error` (src/server/rest.ts), and the text an agent reads (the MCP
 * tool result, `DatanotesError.message`) ends with them (src/api/results.ts).
 *
 * The docs pages and anchors here are checked against the docs site by tests/error-docs.test.ts.
 */

import type { ViolationCode } from "./types-table";

/** The docs site; the pages are read in Markdown: `<route>.md`. Same value as src/api/guidance.ts. */
export const DOCS_BASE = "https://datanotes.dev";

/** Docs pages (Markdown twin and anchor) the hints point to, by topic. */
export const DOCS = {
  errors: "/guides/agents/reading-errors.md",
  findTable: "/guides/database-objects/tables.md#find-the-table-that-matches-a-request",
  describeTable: "/guides/database-objects/tables.md#describe-a-table-before-writing-to-it",
  createTable: "/guides/database-objects/tables.md#create-a-table-with-typed-columns",
  descriptions: "/guides/database-objects/tables.md#describe-every-table-and-column",
  badValues: "/guides/data-quality/validation.md#see-how-the-engine-refuses-bad-values",
  enumValues: "/guides/database-objects/columns.md#describe-what-each-enum-value-means",
  renameValue: "/guides/database-objects/columns.md#rename-an-enum-value",
  alterColumn: "/guides/database-objects/columns.md#change-a-columns-attributes",
  renameColumn: "/guides/database-objects/columns.md#rename-a-column",
  generated: "/guides/data-quality/hand-edits.md#recompute-generated-columns-after-a-hand-edit",
  computed: "/guides/database-objects/columns.md#compute-a-column-from-other-columns",
  jsonAggregates: "/guides/database-objects/columns.md#count-and-total-the-items-of-a-json-list",
  partition: "/guides/database-objects/columns.md#partition-rows-into-folders",
  filters: "/guides/read-and-write/read-and-filter.md#compare-values-with-operators",
  logical: "/guides/read-and-write/read-and-filter.md#combine-filters-with-or-and-and-not",
  select: "/guides/read-and-write/read-and-filter.md#filter-rows-choose-columns-and-sort",
  groupBy: "/guides/read-and-write/joins-and-aggregates.md#group-rows-and-compute-totals",
  join: "/guides/read-and-write/joins-and-aggregates.md#join-rows-on-a-computed-key",
  views: "/guides/database-objects/views.md#store-a-query-as-a-view",
  union: "/guides/database-objects/views.md#combine-several-tables-in-one-view",
  thisNote: "/guides/database-objects/views.md#read-the-note-that-shows-a-view-with-this",
  links: "/guides/database-objects/relations.md#point-a-column-to-a-row-of-another-table",
  linkFilters: "/guides/read-and-write/read-and-filter.md#filter-rows-by-a-link",
  vocabulary: "/guides/database-objects/relations.md#take-allowed-values-from-another-table",
  tree: "/guides/database-objects/relations.md#build-a-tree-of-rows-with-a-parent-link",
  acyclic: "/guides/database-objects/relations.md#keep-dependencies-free-of-cycles-with-acyclic",
  instructions: "/guides/database-objects/tables.md#tell-agents-how-to-fill-a-row-with-instructions",
  checkLinks: "/guides/data-quality/check-constraints.md#write-a-check-rule-that-follows-links",
  linkTargets: "/guides/database-objects/relations.md#limit-link-targets-with-ref_by-and-ref_where",
  inverse: "/guides/database-objects/relations.md#repair-two-way-links-with-align_relations",
  referenced: "/guides/database-objects/relations.md#delete-a-row-that-other-notes-link-to",
  updateRow: "/guides/read-and-write/write-rows.md#update-one-row",
  editBody: "/guides/read-and-write/write-rows.md#edit-a-notes-text",
  expect: "/guides/read-and-write/write-rows.md#guard-a-write-against-concurrent-edits-with-expect",
  updateRows: "/guides/read-and-write/write-rows.md#update-many-rows",
  merge: "/guides/read-and-write/write-rows.md#insert-or-update-rows-with-merge_rows",
  undo: "/guides/history/journal-and-undo.md#undo-a-write",
  undoConflict: "/guides/history/journal-and-undo.md#undo-refuses-to-overwrite-later-changes",
  failedWrite: "/guides/history/journal-and-undo.md#the-engine-rolls-back-a-write-it-cannot-finish",
  rollbackFailed: "/guides/history/journal-and-undo.md#when-the-rollback-cant-finish-either",
  dropTable: "/guides/database-objects/tables.md#drop-a-table-and-archive-its-rows",
  batch: "/guides/read-and-write/batch.md#group-several-writes-with-batch",
  moveRows: "/guides/read-and-write/write-rows.md#move-rows-to-another-table",
  checkTable: "/guides/data-quality/check-table.md#find-rows-that-break-the-schema",
  unreadable: "/guides/data-quality/hand-edits.md#find-rows-whose-front-matter-cant-be-read",
  sameNameCase: "/guides/read-and-write/write-rows.md#pick-a-free-file-name-for-a-new-row",
  adopt: "/guides/read-and-write/import-notes.md#adopt-the-notes-into-the-table",
  infer: "/guides/read-and-write/import-notes.md#infer-a-table-from-notes",
  catalogs: "/guides/database-objects/catalogs-and-schemas.md#place-tables-in-catalogs-and-schemas",
  metastoreWords: "/guides/database-objects/tables.md#create-a-table-with-typed-columns",
  describe: "/guides/database-objects/catalogs-and-schemas.md#describe-tables-catalogs-and-schemas",
  bases: "/guides/database-objects/bases.md#share-columns-between-tables-with-bases",
  check: "/guides/data-quality/check-constraints.md#enforce-rules-with-check-constraints",
  renameTable: "/guides/database-objects/tables.md#rename-or-move-a-table",
  folders: "/guides/database-objects/tables.md#change-sub-folders-and-file-names",
  archive: "/guides/database-objects/tables.md#set-the-archive-folder-and-untyped-fields",
  packOption: "/guides/database-objects/packs.md#choose-the-period-of-a-pack",
  packHost: "/guides/database-objects/packs.md#packs-need-the-engine-service",
  packRows: "/guides/database-objects/packs.md#pack-and-unpack-rows",
  packPartition: "/guides/database-objects/packs.md#choose-the-partition-with-git-in-mind",
  unpackFirst: "/guides/database-objects/packs.md#unpack-before-you-change-the-tables-layout",
  databaseSettings: "/guides/database-objects/catalogs-and-schemas.md#configure-the-database-settings",
  history: "/guides/history/table-history.md#turn-history-on-for-a-table",
  autolinkTargets: "/guides/read-and-write/automatic-links.md#choose-the-tables-a-link-may-point-to",
  versions: "/guides/history/table-history.md#list-the-versions-of-a-table",
  readAsOf: "/guides/history/table-history.md#read-a-table-as-it-was",
  restore: "/guides/history/restore.md#restore-a-table-to-an-old-version",
  restoreDatabase: "/guides/history/restore.md#time-travel-and-restore-the-whole-database",
  vacuum: "/guides/history/vacuum.md#trim-old-history-with-vacuum_table",
  changeFeed: "/guides/history/change-data-feed.md#follow-every-change-with-the-change-feed",
  webhooks: "/guides/history/change-data-feed.md#push-changes-to-a-web-address-with-webhooks",
  readNote: "/guides/search/text.md#read-a-note",
  graph: "/guides/search/link-graph.md#walk-the-links-from-a-note",
  graphTables: "/guides/search/link-graph.md#read-the-whole-graph-in-one-call",
  semantic: "/guides/search/semantic.md#turn-on-semantic-search",
  search: "/guides/search/hybrid.md#search-by-words-and-meaning",
  docsSearch: "/guides/agents/docs-offline.md#search-by-words-and-by-meaning",
  tokens: "/guides/security/tokens.md#choose-what-a-token-can-do",
  manageTokens: "/guides/security/tokens.md#manage-your-tokens",
  tokenAutolink: "/guides/security/tokens.md#turn-automatic-links-off-for-a-sync-program",
  tokenRead: "/guides/security/tokens.md#limit-what-a-token-can-read",
  tokenWrite: "/guides/security/tokens.md#a-write-into-another-table-needs-write-too",
  reportAgents: "/guides/security/who-did-what.md#report-what-an-agent-does",
  sessionOwner: "/guides/security/who-did-what.md#a-session-belongs-to-one-token",
  auth: "/develop/http-api.md#authenticate-your-requests",
  routes: "/develop/http-api.md#call-the-engines-routes",
  store: "/administration/run-the-service.md#where-the-engine-keeps-its-store",
  oneDatabase: "/administration/run-the-service.md#one-database-per-vault",
  databaseOrVault: "/administration/use-with-obsidian.md#choose-between-a-database-folder-and-a-vault",
  copiedDatabase: "/administration/run-the-service.md#run-a-copy-of-a-vault",
  oneEngine: "/administration/run-the-service.md#run-one-engine-per-database",
  startEngine: "/administration/run-the-service.md#start-the-engine",
  port: "/administration/run-the-service.md#choose-the-port",
  stop: "/administration/run-the-service.md#stop-the-engine",
  moveDatabase: "/start/how-it-works.md#move-the-vault-or-the-database-folder",
  storeBackup: "/guides/history/back-up.md#turn-on-the-store-backup",
  storeBackupCadence: "/guides/history/back-up.md#choose-how-often-the-backup-commits",
  storeBackupFileSize: "/guides/history/back-up.md#keep-each-file-under-95-mb",
  storeBackupSsh: "/guides/history/back-up.md#push-over-ssh",
  restoreStore: "/guides/history/back-up.md#restore-the-store-from-its-backup",
  convertLog: "/start/how-it-works.md#convert-the-log-to-another-format",
} as const;

export type DocsTopic = keyof typeof DOCS;

/** The full address of a docs topic. */
export function docsUrl(topic: DocsTopic): string {
  return `${DOCS_BASE}${DOCS[topic]}`;
}

/** How to fix a mistake, and where to read more. */
export interface Guidance {
  hint: string;
  docs: string;
}

/** Guidance from a docs topic. */
export function guide(hint: string, topic: DocsTopic): Guidance {
  return { hint, docs: docsUrl(topic) };
}

/** The guidance a thrown value carries (errors of the engine set `hint` and `docs`), or null. */
export function guidanceOf(e: unknown): Guidance | null {
  if (e === null || typeof e !== "object") return null;
  const { hint, docs } = e as { hint?: unknown; docs?: unknown };
  return typeof hint === "string" && typeof docs === "string" ? { hint, docs } : null;
}

/** An error of the engine that says how to fix it. */
export class GuidedError extends Error {
  hint?: string;
  docs?: string;
  constructor(message: string, g?: Guidance | null) {
    super(message);
    if (g) {
      this.hint = g.hint;
      this.docs = g.docs;
    }
  }
}

// --- "did you mean" --------------------------------------------------------------------------------

/** Optimal string alignment distance (Levenshtein with transpositions), case-insensitive. */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const d: number[][] = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array<number>(t.length).fill(0)]);
  for (let j = 1; j <= t.length; j++) d[0]![j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[s.length]![t.length]!;
}

const fold = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * The real names closest to a wrong one, best first (at most `max`): the same name in another case
 * or spelling (`Film`, `film-title` for `film_title`), a name that contains it or that it
 * contains, then names a few edits away (about one edit in three letters). `aliases` maps other
 * words for a name (a table's aliases) to it.
 */
export function closestNames(input: string, candidates: Iterable<string>, opts: { max?: number; aliases?: ReadonlyMap<string, string> } = {}): string[] {
  const max = opts.max ?? 3;
  const wanted = fold(input);
  const scored = new Map<string, number>();
  const score = (name: string, s: number) => {
    if (!scored.has(name) || scored.get(name)! > s) scored.set(name, s);
  };
  for (const [alias, name] of opts.aliases ?? []) if (fold(alias) === wanted) score(name, 0);
  if (wanted === "") return [...scored.keys()].slice(0, max);
  const limit = Math.max(1, Math.floor(wanted.length / 3));
  for (const name of new Set(candidates)) {
    const f = fold(name);
    if (f === wanted) score(name, 0);
    else if (wanted.length >= 3 && (f.includes(wanted) || wanted.includes(f)) && f.length >= 3) score(name, 1 + editDistance(wanted, f) / 100); // the nearer of two that contain it
    else {
      const d = editDistance(wanted, f);
      if (d <= limit) score(name, 1 + d);
    }
  }
  // only the closest: a name one edit away hides those two edits away
  const sorted = [...scored.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return sorted
    .filter(([, s]) => s === sorted[0]![1])
    .slice(0, max)
    .map(([n]) => n);
}

const quoted = (names: readonly string[]) => names.map((n) => `"${n}"`);

/** `Did you mean "x"?` / `Did you mean "x" or "y"?`, or "" when nothing is close. */
export function didYouMean(input: string, candidates: Iterable<string>, opts: { aliases?: ReadonlyMap<string, string> } = {}): string {
  const near = quoted(closestNames(input, candidates, opts));
  if (near.length === 0) return "";
  return `Did you mean ${near.length === 1 ? near[0] : `${near.slice(0, -1).join(", ")} or ${near[near.length - 1]}`}?`;
}

/** Sentences joined with a space, the empty ones left out. */
export function sentences(...parts: string[]): string {
  return parts.filter((p) => p !== "").join(" ");
}

/** A list of names for a message, cut after `max` (`a, b, c, … (12 in all)`). */
export function nameList(names: readonly string[], max = 25): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")}, … (${names.length} in all)`;
}

/**
 * Guidance for a name that is not one of `candidates`: the closest real names, the list of them
 * when it is short, and the operation that lists them all (`lister`).
 */
export function unknownName(input: string, candidates: readonly string[], what: string, lister: string, topic: DocsTopic, aliases?: ReadonlyMap<string, string>): Guidance {
  const sorted = [...new Set(candidates)].sort();
  const near = didYouMean(input, sorted, aliases ? { aliases } : {});
  const known = sorted.length === 0 ? `There are no ${what} yet.` : `${capital(what)}: ${nameList(sorted)}.`;
  return guide(sentences(near, known, lister), topic);
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Guidance for a column a table does not have. */
export function unknownColumn(input: string, columns: readonly string[], table: string, topic: DocsTopic = "describeTable", more = ""): Guidance {
  return unknownName(input, columns, `columns of ${table}`, sentences(`describe_table("${table}") lists them with their types and allowed values.`, more), topic);
}

/** Guidance for a column a write names that the table does not have. */
export function unknownWriteColumn(input: string, columns: readonly string[], table: string): Guidance {
  return unknownColumn(input, columns, table, "describeTable", "To keep a new front matter key, add_column first.");
}

/** A name that is not lowercase letters, digits and `_`: the name it could be. */
export function identifierHint(kind: string, value: string): Guidance {
  const fixed = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "");
  return guide(`Use a name like ${JSON.stringify(fixed || `my_${kind}`)}; a description or a label can hold the name as people write it.`, "catalogs");
}

/** Writing a generated column. */
export const GENERATED_HINT = guide("Leave generated and identity columns out of the values: the engine computes them (recompute_columns computes them again).", "computed");

// --- where filters -----------------------------------------------------------------------------------

/** Words agents use for an operator, and the operator (or the way) to write it. */
const OPERATOR_SYNONYMS: Record<string, string> = {
  "=": `"eq"`,
  "==": `"eq"`,
  equals: `"eq"`,
  equal: `"eq"`,
  is: `"eq"`,
  "!=": `"ne"`,
  "<>": `"ne"`,
  neq: `"ne"`,
  not_eq: `"ne"`,
  not_equal: `"ne"`,
  ">": `"gt"`,
  ">=": `"gte"`,
  ge: `"gte"`,
  "<": `"lt"`,
  "<=": `"lte"`,
  le: `"lte"`,
  like: `"icontains" (case-insensitive substring)`,
  ilike: `"icontains" (case-insensitive substring)`,
  includes: `"contains" (an item of a list, or a substring)`,
  has: `"contains" (an item of a list, or a substring)`,
  startswith: `"icontains", or "gte" and "lt" on the prefix`,
  nin: `{"not": {"<column>": {"in": [...]}}}`,
  not_in: `{"not": {"<column>": {"in": [...]}}}`,
  notin: `{"not": {"<column>": {"in": [...]}}}`,
  between: `"gte" and "lte" together: {"gte": a, "lte": b}`,
  is_null: `{"exists": false}`,
  isnull: `{"exists": false}`,
  null: `{"exists": false}`,
  not_null: `{"exists": true}`,
  is_not_null: `{"exists": true}`,
  notnull: `{"exists": true}`,
  $eq: `"eq"`,
  $ne: `"ne"`,
  $gt: `"gt"`,
  $gte: `"gte"`,
  $lt: `"lt"`,
  $lte: `"lte"`,
  $in: `"in"`,
  $nin: `{"not": {"<column>": {"in": [...]}}}`,
  $exists: `"exists"`,
};

/** Guidance for operators a `where` does not know: the right one for each, then every operator. */
export function unknownOperator(bad: readonly string[], operators: readonly string[]): Guidance {
  const fixes = bad.map((op) => {
    const synonym = Object.prototype.hasOwnProperty.call(OPERATOR_SYNONYMS, op.toLowerCase()) ? OPERATOR_SYNONYMS[op.toLowerCase()] : undefined;
    if (synonym) return `For "${op}" use ${synonym}.`;
    const near = closestNames(op, operators, { max: 2 });
    return near.length > 0 ? `For "${op}" use ${quoted(near).join(" or ")}.` : "";
  });
  return guide(
    sentences(
      ...fixes,
      `Write a condition as {"<column>": value} (equals) or {"<column>": {"<operator>": value}}; the operators are ${operators.join(", ")}; combine conditions with "and", "or", "not".`,
    ),
    "filters",
  );
}

// --- refusals ------------------------------------------------------------------------------------------

/** What to do about each kind of violation, and the page that shows it (also in the errors reference of the docs). */
export const VIOLATION_GUIDANCE: Readonly<Record<ViolationCode, Guidance>> = {
  required: guide("Give a value to every required column; describe_table marks them (required: true) and lists an enum's values.", "describeTable"),
  type: guide("Give each value the column's type (describe_table shows it): numbers unquoted, dates as YYYY-MM-DD, links as \"[[Note]]\", lists as JSON arrays.", "createTable"),
  enum: guide("Use one of the allowed values listed in the message, written exactly; describe_table shows what each one means. To add a value, alter_column the enum.", "enumValues"),
  vocabulary: guide("Use one of the values listed in the message, or first insert the new value as a row of the vocabulary table.", "vocabulary"),
  min: guide("Give a value inside the column's range (the message names the bound); describe_table shows its min and max.", "describeTable"),
  max: guide("Give a value inside the column's range (the message names the bound); describe_table shows its min and max.", "describeTable"),
  step: guide("Give a multiple of the column's step (describe_table shows it).", "describeTable"),
  broken_link: guide("Link to a note that exists, as \"[[Note name]]\": list_link_targets(table, column) lists the rows the column may point to.", "links"),
  ref: guide("Link to a row of the table the column points to (its ref) that its ref_where / ref_by allow: list_link_targets(table, column) lists them.", "linkTargets"),
  unique: guide("Another row already has this value: choose another one, or update that row instead (select_rows finds it).", "updateRow"),
  unknown_column: guide("Write only the table's columns: describe_table lists them. To keep a new front matter key, add_column first.", "describeTable"),
  check: guide("The row breaks a CHECK constraint of the table (named in the message, with its rule): change the values so the rule holds. describe_table lists the table's constraints.", "check"),
  generated: guide("A generated column is computed by the engine: do not write it; recompute_columns sets it again.", "generated"),
  cycle: guide("A row cannot be its own ancestor in a hierarchy column, nor depend on itself through an acyclic column: the message shows the path. Point the column to a row that is not on that path.", "tree"),
  inverse: guide("Both sides of a two-way link must agree: write one side, or run align_relations to repair them.", "inverse"),
  unreadable: guide(
    "The note's front matter is not valid YAML (the message quotes the parser), so every read leaves the row out: open the note and fix the YAML, such as a quote or bracket left open or a line without `key: value`. read_note shows its text.",
    "unreadable",
  ),
};

/** Guidance for one kind of violation. */
export function violationGuidance(code: ViolationCode): Guidance {
  return VIOLATION_GUIDANCE[code];
}

/** The message of a cycle of an acyclic column (acyclic.ts), as a write or check_table words it. */
export const ACYCLIC_CYCLE = /^(would close|is on) a cycle in "/;

/** What to do about a cycle of an acyclic column (a hierarchy's cycle has `cycle`'s guidance). */
export const ACYCLIC_GUIDANCE: Guidance = guide(
  "A row cannot depend on itself through an acyclic column: the message shows the cycle. Remove one of its links, or link to a row that is not on it; check_table lists the cycles already there.",
  "acyclic",
);

/** The guidance of one violation: its kind's, or for a cycle of an acyclic column the acyclic one. */
export function guidanceOfViolation(v: { code: ViolationCode; message?: string }): Guidance {
  return v.code === "cycle" && typeof v.message === "string" && ACYCLIC_CYCLE.test(v.message) ? ACYCLIC_GUIDANCE : violationGuidance(v.code);
}

interface RefusalLike {
  op: string;
  conflicts?: readonly { message: string }[];
  violations?: readonly { violations: readonly { code: ViolationCode; message?: string; hint?: string }[] }[];
  failed?: readonly unknown[];
  rolled_back?: boolean;
}

/** Guidance for a refused or failed undo_migration. */
export function undoGuidance(r: { conflicts: readonly { message: string }[]; failed: readonly unknown[] }): Guidance {
  if (r.failed.length > 0) return guide("Some files could not be written back: undo_migration again once they are free, or repair them by hand.", "undo");
  if (r.conflicts.some((c) => /already undone/.test(c.message))) return guide("This write is undone already: to redo it, undo the undo (its migration_id is in list_migrations).", "undo");
  return guide("Later changes touched the same notes: undo those first (list_migrations lists them, newest first), or change the rows with update_row.", "undoConflict");
}

/**
 * Guidance for a refused (or failed) write: the hints of its kinds of violation (at most three, in
 * order of appearance), the docs of the first; for conflicts, what they usually mean.
 */
export function refusalGuidance(r: RefusalLike): Guidance {
  const all = (r.violations ?? []).flatMap((rv) => rv.violations);
  // the kinds in order of appearance; a cycle of an acyclic column is a kind of its own
  const kinds = new Map<string, Guidance>();
  for (const v of all) {
    const g = guidanceOfViolation(v);
    const key = g === ACYCLIC_GUIDANCE ? "cycle:acyclic" : v.code;
    if (!kinds.has(key)) kinds.set(key, g);
  }
  if (kinds.size > 0) {
    const gs = [...kinds.values()].slice(0, 3);
    // the table's own words first: the hints of the CHECKs broken (add_constraint `hint`), once each
    const own = [...new Set(all.map((v) => v.hint).filter((h): h is string => typeof h === "string" && h.trim() !== ""))].slice(0, 3);
    return { hint: `${[...own, ...new Set(gs.map((g) => g.hint))].join(" ")} Then call ${r.op} again (dry_run: true checks without writing).`, docs: gs[0]!.docs };
  }
  if ((r.failed?.length ?? 0) > 0) {
    if (r.rolled_back === true) return guide(`A file could not be written (another program may hold it): the engine put back what it had written, so nothing changed. Close that program, then call ${r.op} again.`, "failedWrite");
    if (r.rolled_back === false) return guide(`The write failed partway and its rollback failed too: the files in "failed" are left as written. Close the program that holds them, then call undo_migration with the migration_id to finish the rollback, and retry ${r.op}.`, "rollbackFailed");
    return guide("Some files could not be written (another program may hold them): undo_migration reverts what was applied; then retry.", "undo");
  }
  const conflict = r.conflicts?.[0]?.message ?? "";
  const known = CONFLICTS.find(([re]) => re.test(conflict));
  if (known) return known[1](r.op);
  return guide(`Resolve what the message names, then call ${r.op} again; dry_run: true checks without writing.`, "errors");
}

/** What the usual conflicts mean, by their message. */
export const CONFLICTS: readonly [RegExp, (op: string) => Guidance][] = [
  [/^row changed: expected/, (op) => guide(`The row changed since you read it: read it again (select_rows), then retry ${op} with "expect" set to what you read.`, "expect")],
  [/^"where" matched \d+ rows, expected \d+/, () => guide(`Check the rows with select_rows and the same "where", then narrow it or change expect_count.`, "updateRows")],
  [/^referenced by |^linked from |would be left empty/, () => guide(`Other rows link to it: pass on_referenced ("set_null" or "ignore"), or change those rows first.`, "referenced")],
  [/^violates CHECK /, () => guide("Rows that break the new rule must change first: select_rows finds them; fix them with update_row, then add the constraint again.", "check")],
  [/: drop or change it first$/, () => guide("A CHECK, a view or a link filter reads it: drop_constraint, or create_view with replace: true, first; describe_table lists the constraints.", "check")],
  [/^table has \d+ rows; pass mode/, () => guide(`Pass mode: "archive" to archive the rows with the table, or delete them first (delete_rows).`, "dropTable")],
  [
    /^note already exists/,
    (op) =>
      guide(
        `Another note has this file name, maybe in another case (Windows and macOS see one file): pass another "path", give the row values its table's filename pattern turns into a free name, or update that note with update_row. Then call ${op} again.`,
        "sameNameCase",
      ),
  ],
  [/already exists|is a table$/, () => guide("The name is taken: choose another one, or pass replace: true to replace a view.", "catalogs")],
  [/^repeats key |rows match key /, () => guide(`Each key of "on" must name one row: drop the repeated rows, or add a key column so each names one.`, "merge")],
  [/^already a row of .*: use move_rows$/, () => guide("The note already belongs to a table: move_rows moves rows between tables.", "moveRows")],
];
