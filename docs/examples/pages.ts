/**
 * The guide pages made from the examples: each page shows examples of one or more chapters, by
 * area (database objects, data quality, reading and writing, search, history). A chapter runs on its
 * own vault (run.ts), and its examples go to the pages of their area, so a page can show examples
 * of several chapters: each example keeps the state its chapter's earlier steps left. Every example
 * of every chapter is on exactly one page (tests/examples.test.ts, and the docs build).
 */

/** An example of a chapter: the chapter's slug and the example's title. */
export type ExampleRef = readonly [chapter: string, title: string];

export interface GuidePage {
  /** The page's path under the docs (without `.md`): `guides/database-objects/tables`. */
  path: string;
  title: string;
  description: string;
  /** The sidebar label, when it differs from the title. */
  label?: string;
  /** The position in its sidebar group. */
  order: number;
  /** The opening paragraphs. */
  intro: string;
  /**
   * A hand-written Markdown file (path from the repository root, no front matter) shown after the
   * intro and before the examples: the prose of a guide whose examples are generated.
   */
  include?: string;
  /** The examples, in the order the page shows them. */
  examples: ExampleRef[];
}

const DB = "guides/database-objects";
const DQ = "guides/data-quality";
const RW = "guides/read-and-write";
const SEARCH = "guides/search";
const HISTORY = "guides/history";

export const PAGES: GuidePage[] = [
  // --- Database objects -------------------------------------------------------------------------
  {
    path: `${DB}/catalogs-and-schemas`,
    title: "Catalogs, schemas and the database",
    label: "Catalogs and schemas",
    description: "Group tables in catalogs and schemas, describe the database, query its own schema, set its settings and move its folder.",
    order: 1,
    intro: [
      "Tables live in catalogs and schemas, and you name a table `catalog.schema.table`. Each catalog and schema is a folder under `datanotes/`, and `datanotes/metastore.yaml` defines all of them. A short name such as `film` resolves through the database’s default catalog and schema.",
      "The examples on this page keep a diary of classic films in its own catalog, `diary`. You group the tables, describe them, read the database’s own schema and change the settings of the whole database.",
    ].join("\n\n"),
    examples: [
      ["structure", "Place tables in catalogs and schemas"],
      ["structure", "Describe tables, catalogs and schemas"],
      ["tables", "Describe the whole database"],
      ["queries", "Query the database’s own schema"],
      ["structure", "Configure the database settings"],
      ["structure", "Move the database folder"],
      ["structure", "See the database’s definition in `metastore.yaml`"],
    ],
  },
  {
    path: `${DB}/tables`,
    title: "Tables",
    description: "Create a table, find and describe it, set its folders, file names, template and tags, rename, copy and drop it.",
    order: 2,
    intro: [
      "A table lives in `datanotes/metastore.yaml`, and each of its rows is a Markdown note whose front matter key `table` names the table. Each column is a key of that front matter. You create and change tables only through operations, which validate each change, journal it and can undo it.",
      "The examples start from an empty vault and build a small diary of classic films in the public domain. Later examples organize the tables of a second diary, kept in the catalog `diary`.",
    ].join("\n\n"),
    examples: [
      ["tables", "Create a table with typed columns"],
      ["tables", "Describe every table and column"],
      ["tables", "Find the table that matches a request"],
      ["tables", "Describe a table before writing to it"],
      ["tables", "Add fixed front matter keys, a note template and tags"],
      ["tables", "Set a table’s options when you create it"],
      ["structure", "Rename or move a table"],
      ["structure", "Change sub-folders and file names"],
      ["structure", "Set the archive folder and untyped fields"],
      ["structure", "Give new notes a template"],
      ["structure", "Set defaults for new tables"],
      ["structure", "Copy a table to try changes"],
      ["tables", "Drop a table and archive its rows"],
      ["tables", "See the tables in `metastore.yaml`"],
    ],
  },
  {
    path: `${DB}/columns`,
    title: "Columns and types",
    description: "Choose column types and attributes, compute generated columns, name rows after a time, and change the columns of a table that already has rows.",
    order: 3,
    intro: [
      "You declare columns once, in `metastore.yaml`, and the engine checks every write against them. Changing a column changes every row that has it, in one undoable operation.",
      "The examples on this page share one fresh vault, which starts with a `film` table holding Nosferatu and Metropolis.",
    ].join("\n\n"),
    examples: [
      ["columns", "Add a sparse column"],
      ["columns", "Add a dense column to every row"],
      ["columns", "Turn an enum into an ordered scale"],
      ["columns", "Rename an enum value"],
      ["columns", "Describe what each enum value means"],
      ["columns", "Change a column’s attributes"],
      ["columns", "Rename a column"],
      ["columns", "Drop a column and undo the drop"],
      ["columns", "Default to today’s date or the current time"],
      ["columns", "Store lists and structured values"],
      ["columns", "Compute a column from other columns"],
      ["columns", "Let the engine fill identity columns"],
      ["columns", "Partition rows into folders"],
      ["columns", "See the column definitions in `metastore.yaml`"],
    ],
  },
  {
    path: `${DB}/views`,
    title: "Views",
    description: "Store a query as a view, change it, join and combine tables in it, put it in a schema, and read the note that shows it.",
    order: 4,
    intro: [
      "A view is a `select_rows` query stored under a name in `metastore.yaml`. You read it like a table, narrow it with more filters, and agents read it instead of rebuilding the filter, so the answer follows your definition.",
      "The examples query a diary of classic films with three tables: `film`, `actor` for the cast, and `watch` with one row per viewing from the last few weeks.",
    ].join("\n\n"),
    examples: [
      ["queries", "Store a query as a view"],
      ["queries", "Change an existing view"],
      ["queries", "Join and expand rows in a view"],
      ["queries", "Combine several tables in one view"],
      ["queries", "Put a view in a schema of its own"],
      ["queries", "Read the note that shows a view with `{this.*}`"],
      ["queries", "See the views in `metastore.yaml`"],
    ],
  },
  {
    path: `${DB}/bases`,
    title: "Bases",
    description: "Share columns between tables with bases, change a base and every table that extends it, and build bases on bases.",
    order: 5,
    intro: [
      "A base is a named set of columns that tables inherit, like a parent class. One query reads every table that extends a base, on the base’s columns, and a new table that extends it appears in the results without changes to any view.",
      "The examples on this page keep a diary of classic films in its own catalog, `diary`.",
    ].join("\n\n"),
    examples: [
      ["structure", "Share columns between tables with bases"],
      ["structure", "Change a base and every table that extends it"],
      ["structure", "Build bases on bases and link a table to itself"],
    ],
  },
  {
    path: `${DB}/relations`,
    title: "Relations and hierarchies",
    label: "Relations and hierarchies",
    description: "Link rows to rows of other tables, keep two-way links in step, take allowed values from a table, build trees and limit link targets.",
    order: 6,
    intro: [
      "A link column holds a wikilink to a note, such as `[[Charade]]`, and `ref` names the table that note must be a row of. The link points to a row of the other table, and you reach that row’s columns through the link.",
      "The examples on this page share one diary of classic films, with actors, films, viewings, tags and genres.",
    ].join("\n\n"),
    examples: [
      ["relations", "Point a column to a row of another table"],
      ["relations", "Link to several rows with a list of links"],
      ["relations", "Read linked rows in the same call"],
      ["relations", "Repair two-way links with `align_relations`"],
      ["relations", "Take allowed values from another table"],
      ["relations", "Build a tree of rows with a parent link"],
      ["relations", "Limit link targets with `ref_by` and `ref_where`"],
      ["relations", "Compute a link from other columns"],
      ["relations", "Delete a row that other notes link to"],
      ["relations", "See the relations in `metastore.yaml`"],
    ],
  },

  // --- Data quality ------------------------------------------------------------------------------
  {
    path: `${DQ}/validation`,
    title: "Validation",
    description: "What the engine checks on every write, how it refuses a bad value, and how to try a write first.",
    order: 1,
    intro: [
      "The engine checks every write against its table before it changes anything: required values, types, ranges, enums, links, unique values and CHECK constraints. When one check fails, it refuses the whole write and writes nothing. The refusal names the note, the column or rule, the values the engine accepts, and how to fix the call.",
      "People, programs and agents go through the same checks. Hand edits are checked too, but never refused: [Hand edits](/guides/data-quality/hand-edits/) shows what happens to them.",
    ].join("\n\n"),
    examples: [
      ["tables", "See how the engine refuses bad values"],
      ["tables", "Try a write first with `dry_run`"],
    ],
  },
  {
    path: `${DQ}/check-constraints`,
    title: "CHECK constraints",
    description: "Write rules that every row of a table must follow, including rules that follow links into other tables.",
    order: 2,
    intro:
      "A CHECK constraint is a rule written as a `where` filter, such as “a watched film has a rating”. Every row of the table must pass it: the engine refuses a write that breaks it, and refuses to add a constraint that rows already break. A rule can follow links into other tables.",
    examples: [
      ["structure", "Enforce rules with CHECK constraints"],
      ["relations", "Write a CHECK rule that follows links"],
    ],
  },
  {
    path: `${DQ}/hand-edits`,
    title: "Hand edits",
    description: "Edit notes in an editor or with git: the engine checks the edit, reports what it breaks, recomputes what it owns and repairs the links to notes you rename.",
    order: 3,
    intro: [
      "You can create, change, rename or remove a row outside the engine: in an editor, with git or through a sync tool. The engine checks the edit a moment later against the same rules as a write, but never refuses it: the note stays as you wrote it.",
      "The change feed reports what the edit breaks, and `check_table` lists the rows that are invalid now. The engine fixes what it owns: generated columns, two-way links, and the links to a note you rename or move.",
    ].join("\n\n"),
    examples: [
      ["relations", "Catch hand edits that break a rule"],
      ["columns", "Recompute generated columns after a hand edit"],
      ["vault", "Rename a note by hand"],
      ["importing", "Find front matter keys the table doesn’t declare"],
      ["writing", "Find rows whose front matter can’t be read"],
    ],
  },
  {
    path: `${DQ}/check-table`,
    title: "Find rows that break the schema",
    label: "check_table",
    description: "List the rows that break their table's rules now, with check_table, for one table or the whole database.",
    order: 4,
    intro:
      "`check_table` checks the rows a table holds now against its columns and CHECK constraints, and lists the ones that break a rule. Use it after hand edits, after a sync, or before you tighten a rule. Without `table`, it checks every table, page by page. It writes nothing.",
    examples: [["writing", "Find rows that break the schema"]],
  },
  {
    path: `${DQ}/sync-between-devices`,
    title: "Sync the vault between devices",
    label: "Sync between devices",
    description: "Keep a vault in Dropbox, iCloud Drive, Syncthing or Obsidian Sync: run one engine per synced folder, and find conflict copies and unreadable notes with check_table.",
    order: 5,
    intro: [
      "You can keep the vault in a sync tool, such as Dropbox, iCloud Drive, Syncthing or Obsidian Sync, so your notes reach every device. The engine works on a synced vault when you follow one rule: one engine per synced folder.",
      "A sync tool can also leave conflict copies and notes it merged badly. `check_table` finds them.",
    ].join("\n\n"),
    include: "docs/examples/text/sync-between-devices.md",
    examples: [],
  },

  // --- Read and write data -----------------------------------------------------------------------
  {
    path: `${RW}/read-and-filter`,
    title: "Read and filter rows",
    label: "Read and filter",
    description: "Read rows with select_rows: filters and operators, relative dates, sorting and paging, links, and the note behind each row.",
    order: 1,
    intro: [
      "`select_rows` is the one operation that reads rows: you filter, sort, page, group and join with it, and you store its queries as views.",
      "The examples query a diary of classic films with three tables: `film`, `actor` for the cast, and `watch` with one row per viewing from the last few weeks. The viewing dates count back from the day of the site’s build.",
    ].join("\n\n"),
    examples: [
      ["queries", "Filter rows, choose columns and sort"],
      ["queries", "Compare values with operators"],
      ["queries", "Combine filters with `or`, `and` and `not`"],
      ["queries", "Filter by relative dates"],
      ["relations", "Filter rows by a link"],
      ["queries", "Page through the results"],
      ["queries", "Read the note behind a row"],
    ],
  },
  {
    path: `${RW}/joins-and-aggregates`,
    title: "Joins and aggregates",
    description: "Group rows and compute totals, join tables on links or on computed keys, and count rows across links.",
    order: 2,
    intro:
      "`select_rows` groups rows and computes totals with `group_by` and aggregates, and joins tables on links or on matching values. The examples query a diary of classic films with its cast and viewings.",
    examples: [
      ["queries", "Group rows and compute totals"],
      ["queries", "Join rows on a computed key"],
      ["relations", "Join two tables on matching values"],
      ["relations", "Count rows across a list of links"],
    ],
  },
  {
    path: `${RW}/write-rows`,
    title: "Write and move rows",
    label: "Write and move rows",
    description: "Insert a row, update one row or many, edit a note’s text, upsert, guard against concurrent edits, delete and move rows.",
    order: 3,
    intro: [
      "The engine checks every write before it changes anything, records it in the journal, and lets you undo it with `undo_migration`. A write answers with the notes it created, changed, moved or deleted.",
      "The first example adds a row to the film diary of [Tables](/guides/database-objects/tables/); the others work on a small diary of five classic films.",
      "When several clients write at once, the engine checks each write on the latest data. [Concurrent writes](/develop/concurrency/) explains the rules and when to retry.",
    ].join("\n\n"),
    examples: [
      ["tables", "Insert a row"],
      ["writing", "Pick a free file name for a new row"],
      ["writing", "Update one row"],
      ["writing", "Edit a note’s text"],
      ["writing", "Guard a write against concurrent edits with `expect`"],
      ["writing", "Update many rows"],
      ["writing", "Insert or update rows with `merge_rows`"],
      ["writing", "Delete rows into the archive"],
      ["writing", "Move rows to another table"],
    ],
  },
  {
    path: `${RW}/automatic-links`,
    title: "Automatic links",
    description: "The text you write links the notes it mentions by name. See what the engine links, how it asks about a doubtful name, and how to turn it off.",
    order: 4,
    intro: [
      "When you or an agent write a note’s text, the engine links the notes it mentions by name. A review that says Cary Grant links the note `Cary Grant`, even when the agent wrote plain text.",
      "The engine links what it’s sure of and asks about the rest. The write’s answer lists the links in `links_added`. It lists the doubtful mentions in `ambiguous_mentions`, each with the notes it may name.",
    ].join("\n\n"),
    include: "docs/examples/text/automatic-links.md",
    examples: [
      ["linking", "Link the notes a text mentions"],
      ["linking", "Link only the text you add"],
      ["linking", "Resolve a doubtful mention"],
      ["linking", "Choose the tables a link may point to"],
      ["linking", "Turn automatic links off"],
    ],
  },
  {
    path: `${RW}/batch`,
    title: "Batch writes",
    label: "Batch",
    description: "Group several writes with batch: they succeed or fail together, and one undo reverts all of them.",
    order: 5,
    intro:
      "`batch` runs a list of writes in order, each one seeing the previous ones. If the engine refuses one, it undoes the ones already applied, so the batch succeeds or fails as a whole. The batch is one journal entry: `undo_migration` reverts all of it, and a dry run checks each operation against the current data. [Concurrent writes](/develop/concurrency/#group-writes-that-belong-together) explains how a batch meets the writes of other clients.",
    examples: [["writing", "Group several writes with `batch`"]],
  },
  {
    path: `${RW}/import-notes`,
    title: "Import existing notes",
    description: "Turn a folder of notes you already have into a table: infer its columns, create it and adopt the notes. Then choose which new notes become rows on their own.",
    order: 6,
    intro:
      "Your vault may already have notes with front matter, like a film diary, a reading list or meeting notes. The examples start from a `Films/` folder of classic films written by hand, each with its year, runtime and `Director`. You turn it into a table without retyping anything: you infer the columns, create the table and adopt the notes. Then you decide which new notes become rows on their own.",
    examples: [
      ["importing", "Infer a table from notes"],
      ["importing", "Create the table from the proposal"],
      ["importing", "Preview the adoption with a dry run"],
      ["importing", "Adopt the notes into the table"],
      ["importing", "Insert new rows through the engine"],
      ["importing", "Set a value for notes made by hand with `external_default`"],
      ["importing", "A new note in a table’s folder becomes a row"],
      ["importing", "Keep a folder’s notes out of the table with `exclude`"],
      ["importing", "See the table’s definition in `metastore.yaml`"],
    ],
  },

  // --- Search ------------------------------------------------------------------------------------
  {
    path: `${SEARCH}/text`,
    title: "Read and search notes",
    label: "Text search",
    description: "Read any note in the vault, list folders and search their text.",
    order: 1,
    intro:
      "Not every note is a row, so the operations on this page work on the whole vault: plain notes and rows alike. The vault has three actors, two classic films, a viewing and two plain notes.",
    examples: [
      ["vault", "Read a note"],
      ["vault", "List a folder"],
      ["vault", "Search text"],
    ],
  },
  {
    path: `${SEARCH}/semantic`,
    title: "Find notes by meaning",
    label: "Semantic search",
    description: "Turn on semantic search with a local or hosted embedding model, and search your notes by what they say.",
    order: 2,
    intro:
      "Semantic search finds notes by meaning instead of exact words. The engine splits each note into passages, sends them to an embedding model you choose and stores the resulting vectors in the vault. Agents and programs then search with the [`semantic_search`](/reference/operations/queries/#semantic_search) operation. It’s off by default, because note text goes to the model’s provider.",
    include: "docs/examples/text/semantic-search.md",
    examples: [["vault", "Search notes by meaning"]],
  },
  {
    path: `${SEARCH}/link-graph`,
    title: "Walk the link graph",
    label: "Link graph",
    description: "Read the links between notes as a graph: neighbors, walks filtered by label and table, and the shortest path between two notes.",
    order: 3,
    intro: [
      "The engine reads your notes and their links as a labelled graph. Edges from link columns have the column’s name as their label, such as `cast` or `genre`; other resolved links have the label `link`, and each row has its table as its label.",
      "The vault of the examples has three actors, two classic films, a viewing and two plain notes.",
    ].join("\n\n"),
    examples: [
      ["vault", "See what a note links to and what links to it"],
      ["vault", "Read the whole graph in one call"],
      ["vault", "Walk the links from a note"],
      ["vault", "Find how two notes are connected"],
    ],
  },

  // --- History and recovery ----------------------------------------------------------------------
  {
    path: `${HISTORY}/journal-and-undo`,
    title: "Journal and undo",
    description: "Every write through the engine is journaled with who made it: list the writes, undo them, and see what undo can't take back.",
    order: 1,
    intro: [
      "The journal records every write to rows and to the schema, with the data to undo it and who made it. `list_migrations` lists the writes, newest first, and `undo_migration` reverts one, batches included. An undo is itself a write, so you can undo it too.",
      "The journal works on every table, whatever its history setting. Reading a table as it was and restoring it need its transaction log too. A database the engine creates keeps one for every table: see [Table history and time travel](/guides/history/table-history/).",
      "The examples work on a small diary of five classic films.",
    ].join("\n\n"),
    include: "docs/examples/text/journal-and-undo.md",
    examples: [
      ["writing", "Undo a write"],
      ["writing", "Undo refuses to overwrite later changes"],
    ],
  },
  {
    path: `${HISTORY}/table-history`,
    title: "Table history and time travel",
    label: "Table history and time travel",
    description: "Turn history on, list a table’s versions, read a table as it was, compare two versions and find hand edits.",
    order: 2,
    intro: [
      "With history on, every write to a table becomes a numbered version in a transaction log, including edits made by hand. The engine keeps the log in its store, outside the vault.",
      "History is on in a database the engine creates: its `metastore.yaml` says `history: true` under `config`. A database whose `metastore.yaml` lacks the key, such as one from a version before 3.0.0, has it off. Turn it on for the whole database with `configure_database`, or per table with `alter_table` or `create_table` (`history: true`).",
      "History costs disk space. Each version keeps the full text of every note it writes, so a note saved ten times is stored about ten times. Trim old versions with [`vacuum_table`](/guides/history/vacuum/), and turn history off with `history: false` for a table that doesn’t need it.",
    ].join("\n\n"),
    examples: [
      ["history", "Turn history on for a table"],
      ["history", "List the versions of a table"],
      ["history", "Read a table as it was"],
      ["history", "Copy a table as it was"],
      ["history", "See what changed between two versions"],
      ["history", "Find hand edits in the history"],
      ["history", "Turn history on for every table"],
      ["history", "See the history settings in `metastore.yaml`"],
    ],
  },
  {
    path: `${HISTORY}/change-data-feed`,
    title: "Change data feed",
    description: "Follow every change to rows, the schema and notes as it happens: poll the change feed, or have the engine push it to a webhook.",
    order: 3,
    intro: [
      "The change feed, `list_changes`, lists every change as an event: writes through the engine, hand edits with the rules they break, schema changes and, when asked for, tool calls. It works without history. Poll it from a position, or wait for the next event with `wait_ms`; a webhook has the engine post each event to a web address instead.",
      "[Change feed and webhooks](/develop/change-feed-and-webhooks/) shows how a program follows the feed.",
    ].join("\n\n"),
    examples: [
      ["history", "Follow every change with the change feed"],
      ["history", "Push changes to a web address with webhooks"],
    ],
  },
  {
    path: `${HISTORY}/restore`,
    title: "Restore a table or the database",
    label: "Restore",
    description: "Bring a table back to an old version, or every table back to a time or to the moment before an operation.",
    order: 4,
    intro:
      "`restore_table` brings a table back to an old version, and `restore_database` brings every table that keeps a transaction log back to a time, or to the moment before an operation. Each restore is one write: it’s journaled, and `undo_migration` reverts it.\n\nThe same history lets you time travel before you restore: `select_rows` with `timestamp` reads a table, a view, a join or a base as it was at that time.",
    examples: [
      ["history", "Restore a table to an old version"],
      ["history", "Time travel and restore the whole database"],
    ],
  },
  {
    path: `${HISTORY}/vacuum`,
    title: "Vacuum old history",
    label: "Vacuum",
    description: "Trim a table’s old versions with vacuum_table to keep its transaction log small.",
    order: 5,
    intro:
      "A table’s transaction log grows with what you write. `vacuum_table` deletes the history older than `retain_from_version`, by default every version but the latest, so time travel and restores reach back only that far. The rows stay as they are. It isn’t journaled and can’t be undone, so its `dry_run` is on by default: it lists the log files that would go.",
    examples: [["history", "Trim old history with `vacuum_table`"]],
  },
  {
    path: `${HISTORY}/back-up`,
    title: "Back up the history",
    description: "Keep the engine’s journal and transaction logs in a private git repository, and restore them on a new machine.",
    order: 6,
    intro: [
      "Undo, table history and time travel read the engine’s store, a folder outside the vault. Git sync of the vault doesn’t carry it, so a lost disk would lose them.",
      "The store backup keeps the store in a git repository of its own and pushes it to a private remote, such as a GitHub repository. With the vault’s own git sync, a restore on a new machine brings back undo, history and time travel.",
    ].join("\n\n"),
    include: "docs/examples/text/back-up.md",
    examples: [],
  },
];

/** The page that shows an example, by chapter slug and title. */
export function pageOfExample(chapter: string, title: string): GuidePage | undefined {
  return PAGES.find((p) => p.examples.some(([c, t]) => c === chapter && t === title));
}
