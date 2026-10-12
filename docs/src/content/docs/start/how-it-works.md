---
title: How Datanotes turns notes into a database
description: "Tables, rows, the journal, the transaction log, the link graph and what the engine checks."
sidebar:
  label: How It Works
  order: 3
---

Datanotes puts artificial intelligence (AI) agents first, and serves people and programs too. An agent reads and writes your notes through the Model Context Protocol (MCP) server, `datanotes mcp`. A program uses the [HTTP API](/develop/http-api/), and you use your editor; all three go through the same engine and the same checks. [How agents work with your vault](/guides/agents/how-agents-use-datanotes/) follows an agent through it.

To make that safe, Datanotes runs your vault as a database. Catalogs hold schemas, schemas hold tables, and you name a table `catalog.schema.table`. The engine checks every write against its table, records it in a journal, and lets you undo it.

These docs use the same few words for notes and for the database:

- **Vault**: the folder of notes the engine serves, the one you pass with `--database` or `--vault`
- **Note**: a Markdown file in the vault
- **Front matter**: the YAML block at the top of a note, between two `---` lines
- **Wikilink**: a link written `[[Note]]`, or `[[Note|alias]]` with an alias as its display text
- **Backlinks**: the notes that link to a given note

A row is a note, and a column is a key of its front matter. A note is a row when its front matter key `table` names a table, wherever the note lives.

This page explains the parts that make that work:

- **Folders**: the database folder, and the vault around it when you use one
- **Metastore**: the file that defines every table and view
- **Rows**: the notes, and the `id` each one keeps
- **Transaction log**: every version of each table
- **Link graph**: the links between notes, read as a graph
- **Private store**: the folder outside the vault where the engine keeps its records

## The engine runs on a database folder or on a vault

You start the engine on one folder, in one of two ways:

| Start | The folder is | `metastore.yaml` | A row of `film` | A note at the root |
| --- | --- | --- | --- | --- |
| `--database your_database_folder` | The database | At its root | `main/public/film/Metropolis.md` | `intro.md` |
| `--vault your_vault_folder` | A vault that holds the database | In a subfolder, `datanotes/` for a new database | `datanotes/main/public/film/Metropolis.md` | `intro.md` |

The engine names every note by its path relative to that folder. In both modes, it serves every note of the folder, not only the rows. [`read_note`](/reference/operations/queries/#read_note), [`list_folder`](/reference/operations/queries/#list_folder), [`search_notes`](/reference/operations/queries/#search_notes) and [git sync](/administration/git-sync/) reach plain notes too.

Use `--database` unless another app opens the same notes. It's the normal way to run Datanotes: the folder holds your database and any notes you add next to it.

Use `--vault` when an app such as Obsidian opens a whole vault, and the database is one folder in it. Paths then start from the vault root, as the app's do, so the app resolves the wikilinks the engine writes. You can also open a `--database` folder itself as an Obsidian vault: its root is then the vault root. [Use Datanotes with Obsidian](/administration/use-with-obsidian/) compares the two setups.

Give one of the two options, not both: the engine refuses to start with both.

The folder gives the engine a fixed frame:

- **Stable paths**: every path is relative to the folder, wherever the folder lives
- **No writes outside**: the engine never writes outside the folder
- **One folder to follow**: the file watcher and the link index cover the folder and nothing else

## The metastore defines every table

The metastore is one YAML file, `metastore.yaml`, that defines every table and view. Its folder is the database folder. Tables sit in a three-level hierarchy, `catalogs → schemas → tables`, and you name them `catalog.schema.table`. Shorter names resolve through `config.default_catalog`.

The file holds these parts:

- **`id`**: the database’s id, a UUID the engine writes when it creates the database; the engine finds its [private store](#the-engine-keeps-its-records-in-a-private-store) by it
- **`config`**: settings for the whole database, such as `default_catalog`
- **Columns**: each with `description`, `required`, `generated`, `identity` and `default`, which accepts `{now}` and `{today}`; the operations require a `description` on every table and column
- **`constraints`**: CHECK constraints, filters that every row of the table must pass
- **`options`**: partitioning, the file name rule, archiving, excluded folders and history
- **`row_template`** and **`tags`**: the text of every new row’s note, and key/value labels on the table
- **`views`**: saved queries over one or more tables
- **Descriptions**: catalogs and schemas carry a `description`, set with [`comment_on`](/reference/operations/schema/#comment_on)

You can read the file freely, but only operations change it. The table, view and base operations, such as [`create_table`](/reference/operations/schema/#create_table) and [`add_column`](/reference/operations/schema/#add_column), validate each change, journal it and can undo it. [`configure_database`](/reference/operations/auxiliary/#configure_database) validates `config` but doesn’t journal it: to revert, call it again with the previous values.

## Rows are notes

A row is any note whose front matter key `table` names a table. The engine writes new rows to `your_catalog/your_schema/your_table/` in the database folder, and names each note with the table’s `filename` pattern.

Every metastore table starts with the system column `id` (`identity: uuid`). It holds a universally unique identifier (UUID) of version 7, which the engine assigns when it creates the row and never changes: renames, moves and [`alter_table`](/reference/operations/schema/#alter_table) keep it. You can’t set, drop or alter the column, except for its label, description and aliases. A row you create by hand without an `id` gets one, and a duplicated note gets a new one through [`recompute_columns`](/reference/operations/rows/#recompute_columns).

## The transaction log keeps every version

The transaction log records each version of a table, so you can read or restore the data as it was at an earlier time. Whether a table keeps one depends on two settings:

- **The database’s `history`**: a database the engine creates gets `history: true` in the `config` of its `metastore.yaml`, so every table keeps a log. A `metastore.yaml` without the key, such as one written by hand or by a version before 3.0.0, means `false`.
- **The table’s own `history`**: set with [`alter_table`](/reference/operations/schema/#alter_table) to `true` or `false`, it wins over the database’s. `"default"` removes it, so the table follows the database again.

Change the database’s setting with [`configure_database`](/reference/operations/auxiliary/#configure_database) and `history`. [Table history and time travel](/guides/history/table-history/) shows it at work.

Each table’s log lives in the engine’s store, in `transaction_log/your_catalog.your_schema.your_table/`, with one numbered JSON file per change. A commit holds these entries:

- **`commitInfo`**: the operation, its time and, when known, its actor
- **`metaData`**: the table’s definition, when the commit changes it
- **`add`**: the path, the hash and the full content of each row written
- **`remove`**: the path and the hash of each row removed

The engine writes a checkpoint, a full copy of the table, once the commits since the last checkpoint outweigh it. That means twice the table’s size and at least 256 KB, or 1,000 versions. The log therefore grows with what you write, not with the table’s size. Hand edits appear as `EXTERNAL_EDIT` commits.

History costs disk space in the store. Each version keeps the full text of every note it writes, so a note saved ten times is stored about ten times, plus the checkpoints. A table you rewrite often grows its log fastest. [`vacuum_table`](/reference/operations/history/#vacuum_table) deletes the old versions, and `history: false` stops the log of a table that doesn’t need it.

The logs of all tables also work as one log for the whole database:

- An operation that changes more than one table commits to each with the same `migration_id`, and a batch’s operations carry the batch’s ID
- [`describe_history`](/reference/operations/history/#describe_history) without a table lists the commits of every table together
- [`select_rows`](/reference/operations/queries/#select_rows) with `timestamp` reads every table of a join, view or base as of that time
- [`restore_database`](/reference/operations/history/#restore_database) brings every logged table back to a time, or to the moment before an operation, as one undoable operation

## The journal records who changed what

The `X-Datanotes-Actor` header, or the client’s `actor` option, tells the engine on whose behalf you write. Its fields are `harness`, `model`, `session` and `tool`. The engine stores it as `actor` on the journal entry, and as `actor` and `userName` (“harness / model”) on the commit. The history and the migrations list (`by`) then show who changed what.

## Links between notes form a graph

The engine reads your notes and their links as a labelled graph. Edges from link columns have the column’s name as their label, such as `cast` or `genre`. Other resolved links have the label `link`, and each row has its table as its label.

Three operations walk the graph:

- **[`graph_neighbors`](/reference/operations/queries/#graph_neighbors)**: the notes one link away
- **[`graph_traverse`](/reference/operations/queries/#graph_traverse)**: a breadth-first walk, filtered by direction, edge labels, result and pass-through tables, and depth
- **[`graph_path`](/reference/operations/queries/#graph_path)**: the shortest path between two notes

## Operations for tables, rows, queries and history

The operations are the [HTTP API](/develop/http-api/), and the same calls through the [JavaScript client](/develop/client/). The [operations reference](/reference/operations/) lists each one, by kind. Together they cover:

- Table and column definitions, constraints, views and [`clone_table`](/reference/operations/schema/#clone_table)
- Inserting, updating, merging, deleting and moving rows
- Queries with [`select_rows`](/reference/operations/queries/#select_rows): joins, group by, views, `system.information_schema.*` and time travel by `version` or `timestamp`
- History of a table or of the whole database, the change data feed, and restoring a table or the whole database
- Vacuum, the migrations list and undo

A view can be a `UNION ALL` over more than one table; each row it returns has its table in `_source`. The engine journals every write to rows and to the schema, so you can undo it.

## The engine keeps its records in a private store

The private store is a folder outside the vault, in the operating system’s folder for per-user application data. Each database has its own: `<data home>/<database id>/`, named after the `id` in `metastore.yaml`. [Run the engine as a service](/administration/run-the-service/#where-the-engine-keeps-its-store) lists the data home of each system and the options that move it.

The store holds these files:

- **`settings.json`** and **`tokens.json`**: the engine’s settings, with the owner token, and the named tokens
- **`journal/YYYY-MM.jsonl`**: one line per operation, with the data to undo it; undoing appends an `undone` line
- **`blobs/your_hash.txt`**: texts of 2 KB or more, such as `metastore.yaml` before and after a change, stored once
- **`transaction_log/`**, **`changes/`** and **`semantic/`**: the history of tables, the change feed and the semantic index
- **`logs/YYYY-MM-DD.your_source.jsonl`**: the engine’s log records, when `fileLogEnabled` is on
- **`store.json`**: the vault and the database folder the store belongs to

When the engine starts, it drops journal entries older than `journalRetentionDays` (90) and deletes log files older than `logRetentionDays` (30).

Your vault holds only your notes: sync tools, git and Obsidian never see the store. The store belongs to the machine the engine runs on, so the journal and the history do too. Results name store files with a `store:` prefix, such as `store:journal/2026-10.jsonl`.

### How the engine finds the database

With `--database`, the database is the folder itself, and `metastore.yaml` sits at its root. A new database creates it there.

With `--vault`, the database is the folder of the vault’s one `metastore.yaml`, `datanotes/` for a new database. When the vault holds more than one `metastore.yaml`, the engine refuses to start. [One database per vault](/administration/run-the-service/#one-database-per-vault) gives the details.

## Move the vault or the database folder

You can move or rename the vault folder. The store records the vault’s path, and the engine follows the vault to its new place at the next start. A copy is different: while the original vault still holds the database, the engine refuses to share its store with the copy. [Run a copy of a vault](/administration/run-the-service/#run-a-copy-of-a-vault) shows how to give the copy its own id.

A vault holds one database folder. To rename or move it, use [`configure_database`](/reference/operations/auxiliary/#configure_database) with `root`. The folder can go anywhere in the vault, also in a subfolder. With `root: ""`, the database moves to the root of the folder the engine serves, so a vault becomes a database folder. The engine refuses:

- `root: ""` when a catalog folder or a `metastore.yaml` already exists at the root
- a path with a folder whose name starts with a dot: editors hide such folders, so the rows would vanish from view
- a path that already exists, ignoring case
- a path inside the database folder

A rename that only changes case, such as `Datanotes` to `datanotes`, works on file systems that ignore case too.

You can also move or rename the folder by hand, with the engine running or stopped. The engine finds the database again by its id.

Either way, the move is one operation. The engine applies it before it answers any other request, so no client reads a half-moved vault:

- It rewrites every link into the old folder, across the vault, and recomputes the generated columns
- It records the move in the journal, as one `move_database` entry, and in the history of every table, as `MOVE DATABASE`
- It moves archive and exclude folders given as vault paths
- The change feed reports one `move` event per row, with the row as it is after the move
- [Git sync](/administration/git-sync/) commits the move once
- A move by hand shows as a hand edit, in `datanotes status`, the change feed and the log

Undo and time travel read what was written before the move with the new paths. Undo of an operation made before the move finds its rows in the new folder, and a restored version comes back in the new folder. The move itself can’t be undone: move the folder back with `configure_database`.

## What the operations do beyond reading and writing

These features do more than read or write one row:

- **[Whole writes](#every-write-applies-whole-or-not-at-all)**: a write that applies completely or not at all, even with many clients, while the engine runs
- **[Batches](#batches-succeed-or-fail-together)**: writes that succeed or fail together
- **[Bases](#one-query-reads-every-table-of-a-base)**: one query over every table that shares a set of columns
- **[Inverse links](#inverse-links-keep-both-sides-in-step)**: links the engine keeps on both sides
- **[Checks of hand edits](#the-engine-checks-hand-edits-but-never-refuses-them)**: what happens when you edit a note outside the engine
- **[Link repair](#the-engine-repairs-links-after-a-hand-move)**: links that follow a note you rename or move outside the engine
- **[Schema inference](#schema-inference-proposes-a-table-for-existing-notes)**: a table proposed from notes you already have
- **[Attribution](#attribution-names-who-made-each-write)**: who made each write

### Every write applies whole or not at all

While the engine runs, a write changes notes only when all of it can apply. The engine makes sure of it in three ways:

- **Checked first**: the engine checks a write before it touches a file. A refused write changes nothing.
- **Checked on the latest data**: the engine applies writes one at a time. If another client's write lands while yours is checked, the engine checks yours again on the new state.
- **Undone when a file fails**: a file can fail mid-write, for example when another program holds it. The engine then puts back the files it already wrote, and the answer lists what failed.

So two clients can't both insert the same unique value, and a rule that follows a link holds when they race. [Concurrent writes](/develop/concurrency/) shows how a program writes safely with `expect` and retries.

A crash is different. The engine writes each note atomically, so no note is ever left half written. But a write that touches many notes writes them one by one, and records itself in the journal last. A crash, a power cut or `kill -9` in the middle can leave part of that write applied and outside the journal. Run [`check_table`](/guides/data-quality/check-table/) after such a stop to find the rows it left. Stop the engine with [`datanotes stop`](/administration/run-the-service/#stop-the-engine), which lets the write finish.

### Batches succeed or fail together

[`batch`](/reference/operations/rows/#batch) runs a list of writes in order, each one seeing the previous ones. If the engine refuses one, it undoes the ones already applied. The batch is one journal entry, so [`undo_migration`](/reference/operations/history/#undo_migration) reverts all of it. A dry run checks each operation against the current data.

A batch is all or nothing while the engine keeps running. A crash in the middle may leave part of it applied: the steps already done each keep a journal entry of their own, so `list_migrations` shows them and `undo_migration` reverts them one by one.

### One query reads every table of a base

A base is a named set of columns that tables inherit, like a parent class; you define one with [`define_base`](/reference/operations/schema/#define_base). [`select_rows`](/reference/operations/queries/#select_rows) with `table: "base:record"` returns the rows of every table that extends the base `record`, directly or through other bases. It reads them on the base’s columns and tags each with `_source`. A new table that extends the base appears in the results without changes to any view.

### Inverse links keep both sides in step

A link column with `inverse` keeps the other side of the link up to date. You declare it on one side only:

```yaml
{ name: cast, type: list, items: link, ref: main.public.actor, inverse: films }
```

This column of `film` links back through the `films` column of `actor`: when `Charade` lists Cary Grant in its cast, Cary Grant lists `Charade` in `films`. Other pairs work the same way:

- **`friends` and `friends`**: one column of a table that links back to itself, so the link is symmetric
- **`children` and `parents`**: two columns of the same table
- **`partner` and `partner`**: a single value, so setting it replaces the other row’s previous partner

Writes add or remove the reciprocal links in the same operation, with one undo. The engine mirrors links you edit by hand about 2s later. [`check_table`](/reference/operations/auxiliary/#check_table) reports links that aren’t reciprocated, and [`align_relations`](/reference/operations/rows/#align_relations) adds the missing ones. [Relations and hierarchies](/guides/database-objects/relations/) shows each kind.

### The engine checks hand edits but never refuses them

You can create, change, rename or remove a row outside the engine: in an editor, with git or through a sync tool. The engine checks the edit a moment later, in a batch with the other edits of that moment, renames included and in order. It applies the same rules as [`check_table`](/reference/operations/auxiliary/#check_table):

- Required values, types, ranges and enums
- Links and unique values
- CHECK constraints, including those that follow links
- Filtered link targets, `ref_where` and `ref_by`

The engine fixes generated columns, identity columns and inverse links by itself, so the check leaves them out.

An edit can also break rows that point to the edited one. When a link-following CHECK or a filtered link column of any table reads the edited row’s table, the engine checks the rows that link to the edited row again. For example, with the CHECK `{"genre.kind": "genre"}` on `film`, a genre that becomes an era re-checks the films in it. A row deleted, renamed or moved to another table re-checks the rows whose links pointed to it, and a link left with no row is a `broken_link`. After a rename, the engine first rewrites those links, as [the next section](#the-engine-repairs-links-after-a-hand-move) explains.

The check reports only what the edit breaks: the engine doesn’t blame the edit for a rule the row already broke. The result appears in three places:

- **Change feed**: the event’s `violations`, each with `path`, `code`, `column` (or `constraint` for a CHECK) and `message`; empty when nothing breaks, absent when the engine checked nothing
- **Transaction log**: the `EXTERNAL_EDIT` version’s `operationMetrics.violations`, the rules the table’s own rows break, when history is on
- **Log**: a WARN line

A hand edit of `metastore.yaml` that changes a table’s entry checks every row of that table, on the `schema` event. The rows always stay as you wrote them. [`check_table`](/reference/operations/auxiliary/#check_table) lists the rows that are invalid now; without `table`, it checks every table, page by page. For a table without such rules, a check costs only reading the edited rows.

### The engine repairs links after a hand move

When you rename or move a note outside the engine, links to it still name its old path. The engine rewrites them, as it does when it renames a note itself. This works for rows and plain notes alike, and covers the whole vault:

- Wikilinks and embeds, in the text and in the front matter
- Markdown links
- The moved note’s own relative links that would no longer lead where they did

The engine recognizes a move in three ways:

- **A row**: by its `id`, also when you edit the note in the same moment
- **Any note**: by its text, when the old note goes and a new one with the same text appears at once. The text has 32 characters or more, and the note keeps its name or its folder. Otherwise the two are likely different notes, such as two copies of a template.
- **A rename in case only**: by its name, such as `Plan.md` to `plan.md`

The engine also recognizes a move it sees while it writes, such as during a long operation or a bulk repair.

The repair is one operation, tied to the move:

- The journal lists it as `repair_links`, and [`undo_migration`](/reference/operations/history/#undo_migration) takes it back
- The history of each table it writes gets a `REPAIR LINKS` commit, after the move’s `EXTERNAL_EDIT`
- The change feed reports its changes after the move’s event, each with the move in `cause`

Links that an editor already rewrote stay as they are. A row renamed by hand also keeps its [inverse links](#inverse-links-keep-both-sides-in-step): the engine doesn’t add them again to the rows it links to. The repair only rewrites links to the old path. It adds no [automatic links](/guides/read-and-write/automatic-links/): a name in the text stays text until a write puts it there.

The move’s event doesn’t report the links to the old path as `broken_link`, since the repair fixes them. To leave links as they are after a hand move, set `repairLinksOnHandMove` to `false` in the [engine’s settings](/reference/settings/). The move then reports each link it breaks as a `broken_link`.

#### When the repair runs

The engine waits until the vault is quiet: 4 seconds with no change to any file. It then plans the repair and writes it at once. If a file changes while it plans, it drops the plan and waits again. So the repair never mixes with an editor or a sync tool at work:

- **Obsidian** rewrites links on its own renames when **Automatically update internal links** is on (`alwaysUpdateLinks` in `.obsidian/app.json`). It writes them within the quiet time, so the engine finds them rewritten and only fixes the links Obsidian left. With the setting off, Obsidian asks first. The engine repairs the links after the quiet time anyway, and Obsidian then finds nothing to update. To keep Obsidian’s answer, set `repairLinksOnHandMove` to `false`.
- **Git**: the engine doesn’t repair while git sync pulls, or while the vault’s repository has a rebase, a merge or a git command under way (`rebase-merge`, `rebase-apply`, `MERGE_HEAD` or `index.lock` in its git folder). The repair waits and runs once git is done. The change feed reports the moves at once.

The engine repairs every move it saw meanwhile in one operation. Say `a.md` moves to `b.md`, then `c.md` takes the name `a.md`. A link to `a` written before the first move follows the note to `b`. A link to `a` in a note you edited after the first move stays: it may mean the new `a`.

#### Moves while the engine is stopped

The engine saves where each row is, by `id`, in its store. At the next start, a row it finds at another path was moved meanwhile: the engine repairs the links to its old path, as for a move it saw. Plain notes have no `id`, so the engine doesn’t repair the links to a plain note moved while it was stopped. Neither does it repair a row whose old path holds another note by then.

#### Renames in case only

A rename that only changes case also works on file systems that ignore case. The engine renames through a temporary name next to the file, `.datanotes-rename-<pid>-<n>--<new name>`, so the file takes its new name. If the engine stops between the two steps, it gives the file its new name at the next start. Git sync never commits such a temporary file. The engine reads a rename in case only made by hand as a rename too, so the vault keeps one row.

### Schema inference proposes a table for existing notes

[`infer_table`](/reference/operations/auxiliary/#infer_table) with a `folder` (or `paths`) reads the notes’ front matter and returns a [`create_table`](/reference/operations/schema/#create_table) proposal. The proposal includes types, enums with their values, links with the table they point to (`ref`), required and unique columns, and a file name rule. Its descriptions are `null`, because the notes can’t say what each key means. You or the agent write them before `create_table`, which refuses a table or a column without one. It also returns the [`adopt_rows`](/reference/operations/rows/#adopt_rows) call that brings the notes into the table.

With a `table` instead, it lists the keys the table’s rows use without declaring them. It never writes anything.

### Attribution names who made each write

The `X-Datanotes-Actor` header, with `harness`, `model`, `session` and `tool`, names who made a write. The engine keeps it in the journal and in the history, as [the journal records who changed what](#the-journal-records-who-changed-what) explains.

## How fast the engine is

The engine caches row notes by `stat`, modification time and size, together with their hash and parsed front matter, so operations read only the notes that changed. You can measure it on your machine with the benchmark:

```bash
SIZES=1000,5000,20000 npm run bench
```

The benchmark uses one table of rows of about 600 bytes, with history on and an in-memory file index. On a laptop running Windows Subsystem for Linux (WSL2), at 20,000 rows, it measured these times; treat them as indicative:

- **[`insert_row`](/reference/operations/rows/#insert_row)**: about 130 ms, with a 95th percentile of about 160 ms
- **Updating one row**: about 130 ms
- **A filtered [`select_rows`](/reference/operations/queries/#select_rows)**: about 45 ms, and about 1s for the first one after the engine starts
- **[`check_table`](/reference/operations/auxiliary/#check_table)**: about 200 ms
- **Transaction log**: grows by about 0.8 KB per single-row write

At 1,000 rows, a write takes under 10 ms.
