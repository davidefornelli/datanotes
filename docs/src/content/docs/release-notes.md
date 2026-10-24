---
title: Release notes
description: "What each version of Datanotes brings, newest first, starting with 3.0.0."
---

This page lists each version of Datanotes, newest first. Datanotes follows [semantic versioning](https://semver.org): a major version can break what you rely on, and its notes list those changes first. The package is on [npm](https://www.npmjs.com/package/datanotes), and each version has a [GitHub release](https://github.com/davidefornelli/datanotes/releases).

## 3.4.0

Datanotes 3.4.0 brings three additions:

- search the notes by words and meaning in one call
- limit what a named token reads
- count and total the items of a `json` list

It only adds to 3.3: no operation, argument or setting goes away, and a token without `read` reads every table as before.

### Search by words and meaning

[Search notes by words and meaning](/guides/search/hybrid/) explains how it ranks.

- **`search`**: a new operation. It ranks the notes by their words, with BM25. With semantic search on, it fuses that ranking with the meaning, with Reciprocal Rank Fusion.
- **Always on**: with semantic search off, or when the embedding provider fails, it ranks by words alone. `meaning` says which.
- **`matched_by`**: each hit says whether its words, its meaning or both found it.
- **Query syntax**: `"a phrase"`, `+word` and `-word`, as in `search_docs`. Filters: `tables`, `folder` and `min_score`.
- **Any language**: case and accents are ignored, and words aren't stemmed.
- **Read permissions**: a token searches only the notes it may read.

### Named tokens: `read` patterns

[Limit what a token can read](/guides/security/tokens/#limit-what-a-token-can-read) explains the rules.

- **`read`**: a new field of `tokens/create/` and `tokens/update/`. It takes table patterns, like `write`: `catalog.schema.table`, `catalog.schema.*`, `catalog.*` or `*`. `tokens/update/` takes `null` to read every table again.
- **Refused reads**: a query, a view or a note that names a table outside `read` answers 403. The message names the table, with a hint and a docs link.
- **Filtered sets**: listings, bases, search, the graph, history and the change feed leave out the tables the token may not read.
- **Free notes**: a token with a limited `read` never reads the notes outside tables.
- **Write implies read**: every `write` pattern must fall inside `read`. A token with `ddl` or `maintain` keeps reading every table.
- **Answers of writes**: a write still checks every table. Its answer leaves out the rows the token may not read.
- **Where it shows**: `tokens/`, `tokens/me/` and `datanotes status` list `read`. A token without it lists `["*"]`.

### Count and total the items of a json list

A `generated` column can now aggregate a `json` column that holds a list of objects. For example, a day keeps its feedings in `feeds`. The engine then keeps `feeds_count` and `left_min` up to date. [Count and total the items of a json list](/guides/database-objects/columns/#count-and-total-the-items-of-a-json-list) shows it.

- **Five functions**: `count(feeds)`, `count(feeds.min)` for the items with a value, `sum(feeds.min)`, `avg(…)`, `min(…)` and `max(…)`.
- **A filter**: `count(feeds, side = "left")` keeps the items whose field matches. It compares one field with text, a number, `true` or `false`, using `=`, `!=`, `<`, `<=`, `>` or `>=`.
- **On every write**: the engine recomputes the value when it writes the row. After a hand edit, `check_table` reports the stale value and `recompute_columns` fixes it.
- **Checked when you define it**: the engine refuses an aggregate of a column that isn't `json`, or a column type that doesn't fit the result. Each refusal has its own hint and docs.
- **No wrong numbers**: with no items, `count` and `sum` are 0, and `avg`, `min` and `max` are empty. A field that isn't a number leaves the value empty.

## 3.3.1

Datanotes 3.3.1 fixes `alter_table` when it renames or moves a table. It only adds to 3.3: no operation, argument or setting goes away.

### Fixes

- **References follow a moved table**: `alter_table` with `name`, `catalog` or `schema` rewrites every name of the table in the other definitions. Before, the links of other tables kept the old name, and `check_table` then reported a `ref` violation on every row. The engine now rewrites:
  - the `ref` of link columns and lists of links, in tables and in bases
  - the `vocabulary` of string columns
  - the tables a view reads, in `table`, `union` and `join`
- **`schema_references`**: a new field of the answer lists each name rewritten, also on a dry run. `undo_migration` puts the old names back. [Rename or move a table](/guides/database-objects/tables/#rename-or-move-a-table) shows it.
- **CHECKs and link filters**: a CHECK that follows links, or a `ref_where` / `ref_by`, that reads the table through a link no longer refuses the move. These rules name columns, not tables, so they follow the rewritten `ref`. `drop_table` still refuses while they read the table.

## 3.3.0

Datanotes 3.3.0 installs extensions: tables, views, bases and MCP tools from a git repository, pinned to a version. It only adds to 3.2: no operation, argument or setting goes away.

### Extensions

An extension is one git repository with a manifest, `datanotes-extension.json`. The manifest declares tables, CHECKs with hints, table instructions, views, bases, tools and the permissions the tools need. [Install extensions](/administration/extensions/) and [Write an extension](/develop/write-an-extension/) cover both sides.

- **`datanotes extension install`**: fetches a version tag or a commit, prints a plan and asks you to confirm. Branches are refused. A plan lists the tables it creates, adopts or matches, the tools and the token. `--map`, `--create`, `--add`, `--catalog` and `--schema` carry your choices. `--dry-run` writes nothing.
- **One batch**: the installer writes everything in one batch, so one `undo_migration` undoes it.
- **Five more commands**:
  - `update` moves an extension to a newer version.
  - `rollback` undoes the last install or update.
  - `remove` removes an extension and keeps its tables.
  - `list` shows what is installed.
  - `check` checks an extension's repository, for its authors.
- **A token for each extension**: `ext-<name>` writes only the extension's tables and never changes the schema. The journal records it as `auth`.
- **The registry**: the engine keeps the installation records in its store. Three routes serve them: `POST /datanotes/extensions/`, `/datanotes/extensions/record/` and `/datanotes/extensions/delete/`. The last two are for the owner.
- **Exit codes**: 0 done, 1 error, 2 the plan has problems, 3 confirmation needed.

### For MCP servers

- **`datanotes mcp` loads extensions**: stdio and HTTP add the tools of every installed extension after the engine's tools. A tool that writes is refused to a client token that may not write its tables. A restart loads a new install.
- **`--no-extensions`**: leaves the extensions out. `DATANOTES_MCP_EXTENSIONS=0` does the same. `--profile read` keeps only their read-only tools.
- **Docs**: `list_docs`, `read_docs` and `search_docs` serve each extension's docs under `extensions/<name>/`.
- **`datanotes/extensions`**: a new package subpath. It exports the manifest and module types, `defineExtension`, `ExtensionToolError` and the loader for MCP hosts. [Write an extension](/develop/write-an-extension/#write-the-tools) shows it.

## 3.2.0

Datanotes 3.2.0 keeps the links between rows of one table free of cycles. It also lets a table tell agents how to fill its rows. It only adds to 3.1: no operation, argument or setting goes away.

### Links without cycles

A link column, or a list of links, to its own table takes `acyclic: true`. The engine then refuses a write that makes a row depend on itself through that column. An example is a task blocked by a task it blocks. [Keep dependencies free of cycles with `acyclic`](/guides/database-objects/relations/#keep-dependencies-free-of-cycles-with-acyclic) shows it.

- **Both sides**: with `inverse`, a write to either column is checked. The links the engine adds on the other side count too.
- **Existing rows**: `add_column` and `alter_column` refuse `acyclic: true` while rows already form a cycle, and list them.
- **Hand edits**: `check_table` and the change feed report a cycle made outside the engine.
- **The refusal**: it shows the cycle, such as `would close a cycle in "blocked_by" (A → B → A)`. It has its own hint and docs.
- **`system.information_schema.columns`**: a new column, `is_acyclic`.

### Tell agents how to fill a table

- **`instructions`**: `create_table` and `alter_table` take Markdown text that says how to fill a row. It can list which columns come first and what to ask the user. `describe_table` returns it, and `instructions: ""` removes it. [Tell agents how to fill a row with `instructions`](/guides/database-objects/tables/#tell-agents-how-to-fill-a-row-with-instructions) shows it.
- **A hint for each CHECK**: `add_constraint` takes `hint`, what to do when a row breaks the rule. A refused write puts it first in its `hint`, and each violation of that CHECK carries it as `hint`. `describe_table` lists the hints in `constraint_hints`, next to `constraints`.
- **`system.information_schema`**: `tables` has a new column, `instructions`, and `check_constraints` a new column, `hint`.

### Fixes

- `alter_column` with `ref: "self"` no longer refuses the links a column already holds.

## 3.1.0

Datanotes 3.1.0 makes the engine fast at scale and adds OpenTelemetry traces. It only adds to 3.0: no operation, argument or setting goes away. One default changes: the transaction log now writes segments. Read [Before you downgrade to 3.0](#before-you-downgrade-to-30) if you may go back.

### Speed

Measured with `bench/scale/` on a synthetic 50,000-note vault on Windows, median times. "Before" is the engine at the start of this work, with the same benchmark:

| Operation | Before | 3.1.0 |
|---|---|---|
| `insert_row` | 662 ms | 37 ms |
| `update_row` | 124 ms | 47 ms |
| `select_rows` on a small table | 23 ms | 2.8 ms |
| `describe_database` | 1,019 ms | 24 ms |
| `graph_neighbors` right after a write | 1,472 ms | 2.5 ms |
| Archive 100 rows | 71.6 s | 1.3 s |
| `move_rows`, 20 rows | 13.9 s | 0.5 s |
| `select_rows` by 5 paths | 36.5 ms | 0.3 ms |

The gains come from these changes:

- **An index of the vault in memory**: the engine keeps each table's rows, unique values, links and backlinks up to date as notes change. A read no longer walks every note of the vault.
- **Links resolved one note at a time**: creating, deleting or renaming a note no longer resolves every link of the vault again.
- **Each note parsed once per version**: the engine keeps the parse until the file changes.
- **Faster queries**:
  - `where` filters are compiled once;
  - sorts read each key once;
  - pages keep only the rows they need;
  - time-zone formatting is cached, so sorting 10,000 rows by `file_modified` takes about 50 ms, not 4 s.
- **Writes before reads**: a write waits for no new read. A write under four concurrent readers takes about 35 ms, not 147 ms. Settings `writePriority` and `writePriorityMaxWaitMs` tune it.
- **Search through the index on disk**: `search_notes` looks the words up in the index on disk, then reads only the notes that can match. On 50,000 notes, two words found in 1,213 notes take about 14 ms, not 70 to 83 ms. A name takes 7 ms, not 100 ms. A word found in 15,905 notes still takes about 140 ms. A query of one- or two-letter words reads every note. After a start, the engine reads the search's row ids in the background. The first search no longer waits for them.
- **Repeated reads from memory**: a read the engine answered before, on data that has not changed since, comes from a cache. Setting `readCacheMaxBytes` sizes it, and `0` turns it off.
- **Faster undo**: `undo_migration` takes tens of milliseconds, not seconds.
- **Faster history**:
  - `table_changes` replays each version once;
  - `describe_history` reads only commit headers;
  - repeated time-travel reads come from memory.
- **Less memory**:
  - note texts stay within a budget;
  - repeated values, names and paths are kept once;
  - row bodies are read only when asked for;
  - the transaction log keeps hashes, not texts.
- **A faster start**:
  - the engine walks the vault once, without blocking;
  - it reads many notes at a time;
  - the change feed starts after the server listens.
- **An index on disk**: the engine keeps `<store>/index/vault.sqlite` through Node.js's built-in SQLite. A start then reads only the notes that changed since the last stop: at 50,000 notes a restart takes about 2 s, not 40 s. The index is a cache: the notes stay the source of truth, and the engine rebuilds the index when it is missing or damaged. It holds each note's text, compressed, and takes about twice the vault's size on disk. Setting `vaultIndexEnabled` turns it off. Without `node:sqlite`, the engine reads every note as before.
- **More reads at once**: the `datanotes` command gives Node.js 16 threads for file reads, unless `UV_THREADPOOL_SIZE` sets another number.

### The whole graph in one call

`graph_neighbors`, `graph_traverse` and `graph_path` take `from_nodes.tables`: table names or patterns, with `"*"` for every table. One call returns the graph of the whole vault.

### Traces

The engine and `datanotes mcp` send OpenTelemetry traces next to the logs, to any OTLP backend:

- one span per request, continuing an incoming `traceparent`;
- one span per operation, with the database span attributes;
- spans for the phases: lock wait and hold, query plan and scan, validation, journal and transaction log;
- one trace per agent call, across the MCP server and the engine.

Log records carry their trace and span ids. New settings: `telemetryTraces`, `telemetryTraceSampleRatio`, `telemetryMaxSpansPerTrace`, `telemetrySlowSpanMs` and `telemetryEnvironment`. The `OTEL_*` variables work as well. `datanotes/client` takes `trace` and `tracer` to continue a trace into the engine. See [Send logs to your observability backend](/develop/telemetry/).

### The store

- **The transaction log in segments, by default**: a table's versions go to append-only segment files instead of one file per version. The store keeps far fewer files, which matters to antivirus scans and to the store backup. Setting `transactionLogFormat` chooses `segments` or `files`. A 3.0 store needs no conversion: new versions go to segments next to the old files.
- **Smaller checkpoints**: a checkpoint is a manifest and compressed parts, written after the write that made it due.
- **Durable store writes**: the files an operation wrote are synced at its end. Setting `storeSync` sets the policy. A version cut short by a crash no longer makes a table's history unreadable. `vacuum_table` and `datanotes store convert-log` sync the files they write before they delete the old ones.
- **A lighter backup**: a backup tick with no change runs no git command.
- **The store left out of indexing**: on Windows the engine marks the store folder as not content indexed, and on macOS it adds a Spotlight marker.
- **The vault index out of Time Machine**: on macOS the engine excludes `<store>/index/` from Time Machine. The engine rebuilds the index when it is missing, so a restore loses nothing. Time Machine still backs up the journal and the history.
- **The vault index checked**: after each start, the engine checks the index file in the background, one table at a time. The engine turns a damaged index off for the run and rebuilds it at the next start.

### Before you downgrade to 3.0

Datanotes 3.0 reads only one file per version. Before you go back to 3.0, convert the logs:

1. Stop the engine. The conversion runs only while no engine serves the database.
2. Convert the logs of the database:

   ```bash
   datanotes store convert-log --to files --database <folder>
   ```

3. Start Datanotes 3.0.

A table vacuumed with more than 32 MB of text keeps a checkpoint 3.0 cannot read, so 3.0 starts its history again from empty. To keep one file per version from the start, set `transactionLogFormat` to `files`.

### Other changes

- **`dnotes`**: the package also installs the command under a short name. `dnotes status` is the same as `datanotes status`, and `datanotes` stays.
- **`search_notes`**: match contexts now fall on the right text in notes with decomposed accents, Hangul or emoji.
- **Compressed answers**: setting `httpCompression` sends gzip to remote clients. It is on by default, and clients on the same machine get plain answers.
- **Semantic search**: vectors take a quarter of the memory, and a repeated query skips the embedding service.
- **`select_rows` by path**: a filter on `path` reads only the notes it names. A row elsewhere in the table that can't be read no longer fails it.
- **Index checks**: `DATANOTES_INDEX_CHECK=1` compares the engine's indexes with a full read after every operation.
- **`/tool-calls/record/`**: takes an optional `summary`, so `datanotes mcp` no longer sends whole tool results back to the engine.
- **Benchmarks**: `bench/http-latency.mjs` and `bench/scale/` measure any vault.
- **`datanotes store path --json`**: the answer adds `database_path`, the database folder on disk.
- **`datanotes store new-id`, `backup` and `restore`**: each holds the store while it runs, as `convert-log` does. An engine you start meanwhile refuses to start. A live engine whose heartbeat stopped now makes them refuse too. `restore` leaves the store in place untouched until the clone is checked. When the clone cannot take its place, `restore` removes the clone. It puts the old store back, or names the folder the old store is in.
- **Traces of background work**: `job auto_recompute` recomputes columns after a hand edit, and `job inverse_links` mirrors inverse links. Both are traces of their own, never part of the request that saw the edit.
- **Writes**: a write runs again only when another write overtook it. Before, a write whose values held the text of that conflict ran up to five times.

## 3.0.0

Datanotes 3.0.0 is the first stable release. Versions 1.x and 2.x, published on 7 and 8 October 2026, were previews. Datanotes runs a folder of Markdown notes as typed database tables. You reach it through an HTTP API, a command line and an MCP server for agents.

### Tables and the metastore

- **One metastore per vault**: `metastore.yaml` defines the tables, views and bases. Only operations change it, and each change is validated and journaled. The engine refuses a vault with more than one `metastore.yaml`.
- **The database folder**: a new database goes to `datanotes/`. The engine finds the folder by its `metastore.yaml`, whatever its name. See [Move the vault or the database folder](/start/how-it-works/#move-the-vault-or-the-database-folder).
- **Descriptions**: `create_table`, `add_column`, `clone_table` and `define_base` require a description for each table, base and column. A refusal lists every missing one. See [Describe every table and column](/guides/database-objects/tables/#describe-every-table-and-column).
- **CHECK constraints that follow links**: a CHECK such as `{"parent.kind": "project"}` tests the linked row.
- **Filtered link targets**: `ref_where` and `ref_by` limit what a link may point to, and `list_link_targets` lists those rows.
- **Hand edits are checked**: the engine checks notes edited outside it against the tables’ rules. The change feed, the transaction log and the log report what they break.
- **Schema operations for hand-written metastores**: table `tags`, `alter_table` with `archive` and `fields`, and `comment_on` for catalogs and schemas.
- **`select_rows` with `this_note`**: fills a view’s `{this.*}` tokens from a note, so one view serves every daily note.

### The store and its backup

- **The store is outside the vault**: settings, tokens, journal, transaction logs, change feed, semantic index, logs and lock live in `<data home>/<database id>/`. See [Where the engine keeps its store](/administration/run-the-service/#where-the-engine-keeps-its-store).
- **A database id**: the engine writes an `id` line at the top of `metastore.yaml` and finds the store by it.
- **`datanotes store`**: `datanotes store path` shows where a vault’s store is. `datanotes store new-id` gives a copied database its own id and store.
- **Store backup**: the engine keeps its store in a git repository of its own and pushes it to a private remote. Each commit is a consistent snapshot, and the secrets stay out. `datanotes store restore` brings the store back on a new machine. See [Back up the history](/guides/history/back-up/).
- **`--store` and `DATANOTES_DATA_HOME`**: place the store and move the data home. The Docker image keeps the store in `/data`.

### History and undo

- **The journal**: every write is journaled, and `undo_migration` reverts it. An undo of an undo is a redo, and a `batch` is one entry.
- **History on in a new database**: a database the engine creates gets `history: true` in its `metastore.yaml`, so every table keeps its versions. A database without the setting keeps history off. See [The transaction log keeps every version](/start/how-it-works/#the-transaction-log-keeps-every-version).
- **History for the whole database**: `restore_database` brings every table back to a time, or to the moment before an operation.
- **Time travel**: `describe_history` without `table` lists the commits of every table. `select_rows` with `timestamp` reads views, joins and bases as they were.
- **Moves of the database folder**: a move by hand or with `configure_database` is one operation. Undo and time travel read what came before it with the new paths.

### Notes and links

- **Automatic links**: a write links the notes its text mentions by name, at their first mention. `links_added` lists them, and `ambiguous_mentions` returns the doubtful ones for the agent to decide. See [Automatic links](/guides/read-and-write/automatic-links/).
- **Safe on a large vault**: a one-word name links only when capitalized and not at the start of a sentence. Names inside paths, domains and snake_case words stay as they are.
- **`autolink_target`**: a table option that says whether automatic links may point to its rows. See [Choose the tables a link may point to](/guides/read-and-write/automatic-links/#choose-the-tables-a-link-may-point-to).
- **Links follow a note renamed by hand**: the engine rewrites every link to its old path, in one `repair_links` operation that undo takes back. See [The engine repairs links after a hand move](/start/how-it-works/#the-engine-repairs-links-after-a-hand-move).
- **A note moved by hand is a rename**: a note gone and a new one with its text, seen at once, are one rename.

### Agents

- **`datanotes mcp`**: the MCP server ships in the `datanotes` package. [Connect your agents](/start/connect-agents/) shows how to configure it.
- **`datanotes/mcp`**: the engine’s operations as MCP tool definitions for an MCP server of your own. See [Build on Datanotes](/develop/build-on-datanotes/).
- **Docs offline**: the package ships these docs as Markdown. Agents read them with `list_docs`, `read_docs` and `search_docs`. The `Docs:` line of an error names the `read_docs` call, so the agent reads the section without internet access. Your own MCP server does the same with `offlineDocs`. See [Read the docs offline](/guides/agents/docs-offline/).
- **Hybrid search of the docs**: `search_docs` merges a ranking by words with one by meaning. See [Search by words and by meaning](/guides/agents/docs-offline/#search-by-words-and-by-meaning).
- **Errors that teach**: every error says what is wrong, how to fix it in `hint`, and where to read more in `docs`. See [Errors](/reference/errors/).

### Security

- **Named tokens**: each program gets a token of its own, with the tables it may read and write. A token’s `autolink` sets the default of its writes. See [Turn automatic links off for a sync program](/guides/security/tokens/#turn-automatic-links-off-for-a-sync-program).
- **The actor**: every write records who made it, with `auth` set to `owner` or the token’s name.
- **No secret in the change feed**: a recorded tool call loses webhook secrets and values under keys such as `token` or `password`.

### Running the engine

- **Node.js 22 or newer**: the engine and the command line need Node.js 22 or later.
- **`datanotes serve --port`**: the port for one run, also as `DATANOTES_PORT`. With `--port 0`, the system picks a free port. See [Choose the port](/administration/run-the-service/#choose-the-port).
- **`datanotes status`**: the engine’s health at a glance. See [Check the engine’s status](/administration/status/).
- **`datanotes stop`**: a graceful stop. The engine finishes its requests, makes its last git sync and backup push, and releases its lock. See [Stop the engine](/administration/run-the-service/#stop-the-engine).
- **One engine per database**: the engine holds a lock in its store and checks the lock’s process on the same machine.
- **Git never waits for a person**: git sync and the store backup run git without prompts, and with time limits. See [Git never waits for a person](/administration/git-sync/#git-never-waits-for-a-person).
