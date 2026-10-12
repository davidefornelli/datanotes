---
title: Release notes
description: "What each version of Datanotes brings, newest first, starting with 3.0.0."
---

This page lists each version of Datanotes, newest first. Datanotes follows [semantic versioning](https://semver.org): a major version can break what you rely on, and its notes list those changes first. The package is on [npm](https://www.npmjs.com/package/datanotes), and each version has a [GitHub release](https://github.com/davidefornelli/datanotes/releases).

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
