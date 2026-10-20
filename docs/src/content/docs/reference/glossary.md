---
title: Glossary
description: "The words of Datanotes, from row and table to journal, transaction log, token and change feed, each with the page that explains it."
sidebar:
  order: 6
---

The words these docs use, in alphabetical order. Each one links to the page that explains it.

## Actor

Who made a write: the credential as `auth` (`owner` or a token’s name), and, when the caller sends them, the harness, model, session and tool. The journal, the history and the change feed record it. See [Who did what](/guides/security/who-did-what/).

## Agent

A program driven by a language model, such as Claude, Cursor or Codex, that calls the engine’s operations as tools through the MCP server. See [How agents work with your vault](/guides/agents/how-agents-use-datanotes/).

## App

A program that calls the HTTP API with its own named token, such as a script, a service or an MCP server of your own. Each app has its own [named token](/guides/security/tokens/). See [Build on Datanotes](/develop/build-on-datanotes/).

## Automatic link

A link the engine adds where the text of a write mentions another note by name. A doubtful mention stays as text, and the write returns it in `ambiguous_mentions` with the notes it may name. The `autolink` setting turns it off. See [Automatic links](/guides/read-and-write/automatic-links/).

## Base

A named set of columns that tables inherit, like a parent class. One query reads every table that extends a base. See [Bases](/guides/database-objects/bases/).

## Backlinks

The notes that link to a given note. `file_backlink_count` counts them, and the graph operations follow them with the direction `in`. See [Read and filter rows](/guides/read-and-write/read-and-filter/).

## Batch

A list of writes that succeed or fail together, as one journal entry that one undo reverts. See [Batch writes](/guides/read-and-write/batch/).

## Catalog

The top level of the database’s hierarchy: a catalog holds schemas, and a schema holds tables. A table’s full name is `catalog.schema.table`. See [Catalogs, schemas and the database](/guides/database-objects/catalogs-and-schemas/).

## Change feed

The numbered list of every change in the vault, writes and hand edits alike, that programs poll, stream or receive by webhook. Also called the change data feed. See [Change data feed](/guides/history/change-data-feed/).

## CHECK constraint

A rule, written as a filter, that every row of a table must pass. It can follow links into other tables. See [CHECK constraints](/guides/data-quality/check-constraints/).

## Column

A typed front matter key of a table’s rows. Its type can be a string, a number, a date, an enum or a link, and it has attributes such as `required`, `unique` and `default`. See [Columns and types](/guides/database-objects/columns/).

## Data home

The folder that holds the engine’s stores, one per database: `%LOCALAPPDATA%\Datanotes` on Windows, `~/Library/Application Support/Datanotes` on macOS and `~/.local/share/datanotes` on Linux. `DATANOTES_DATA_HOME` moves it. See [Run the engine as a service](/administration/run-the-service/#where-the-engine-keeps-its-store).

## Database folder

The folder that holds `metastore.yaml`. With `--database`, it's the folder you pass, and `metastore.yaml` sits at its root. With `--vault`, it's a folder inside the vault, `datanotes/` by default: the engine finds it at each start, and `configure_database` with `root` moves it. See [One database per vault](/administration/run-the-service/#one-database-per-vault).

## Database id

A UUID at the top of `metastore.yaml`, as `id`, that names the database. The engine writes it when it creates the database, and finds the database’s store by it. A copy of a vault gets its own with `datanotes store new-id`. See [Run a copy of a vault](/administration/run-the-service/#run-a-copy-of-a-vault).

## Engine

The process that runs a vault as a database, `datanotes serve`. It checks and journals every write and serves the HTTP API. See [Run the engine as a service](/administration/run-the-service/).

## Extension

A git repository that adds tables, views, bases, MCP tools and docs to a database. `datanotes extension install` pins and installs it. See [Install extensions](/administration/extensions/).

## Front matter

The YAML block at the top of a note, between two `---` lines. Each key of a row’s front matter holds the value of one column. See [How it works](/start/how-it-works/).

## Hand edit

A change to a note made outside the engine: in an editor, with git or through a sync tool. The engine checks it against the tables’ rules but never refuses it. See [Hand edits](/guides/data-quality/hand-edits/).

## History

A table’s transaction log, when it’s turned on: every version of the table, for time travel and restores. See [Table history and time travel](/guides/history/table-history/).

## Hybrid search

A search that ranks by words and by meaning, then merges the two rankings with Reciprocal Rank Fusion. `search_docs` works this way when the engine has semantic search on. See [Search by words and by meaning](/guides/agents/docs-offline/#search-by-words-and-by-meaning).

## Journal

The record of every write to rows and to the schema, with the data to undo it and its actor, in `journal/` in the engine’s store. See [Journal and undo](/guides/history/journal-and-undo/).

## MCP

The Model Context Protocol, the way agents call tools. `datanotes mcp`, the MCP server of Datanotes, offers the operations of the engine as tools, the webhook tools only on request. See [Connect your agents](/start/connect-agents/).

## Metastore

The file that defines every catalog, schema, table, column, base and view: `metastore.yaml`, at the root of the database folder. It changes only through operations. See [How it works](/start/how-it-works/#the-metastore-defines-every-table).

## Migration

One journal entry: a write, with its `migration_id`. `list_migrations` lists them, and `undo_migration` reverts one. See [Journal and undo](/guides/history/journal-and-undo/).

## Module

A JavaScript entry point of the `datanotes` package: `datanotes/client` calls the HTTP API, `datanotes/local` finds the local engine, and `datanotes/mcp` gives the engine’s tools to an MCP server of your own. See [Call the engine from JavaScript](/develop/client/).

## Note

A Markdown file in the vault. A note with a front matter key `table` that names a table is a row; any other note is an ordinary note. See [How it works](/start/how-it-works/).

## Operation

A call the engine runs, such as `create_table`, `insert_row` or `select_rows`. Each one is an HTTP route and an MCP tool of the same name. See [Operations](/reference/operations/).

## Owner token

The token that can do everything, generated at the engine’s first start and kept in its settings file. See [Tokens and permissions](/guides/security/tokens/).

## Role (extension)

The short name an extension's manifest gives a table, such as `book`. The installer binds each role to a table of your database. See [Declare the tables](/develop/write-an-extension/#declare-the-tables).

## Row

A note whose front matter key `table` names a table, wherever it lives in the vault. Its front matter keys are the row’s columns. Each row has an `id` that never changes. See [Tables](/guides/database-objects/tables/).

## Schema

The level between catalogs and tables: a schema holds tables and views. See [Catalogs, schemas and the database](/guides/database-objects/catalogs-and-schemas/).

## Store

The engine’s folder for one database, outside the vault: `<data home>/<database id>/`. It holds the settings, the tokens, the journal, the transaction logs, the change feed and the logs. Results name its files with a `store:` prefix. See [Run the engine as a service](/administration/run-the-service/#where-the-engine-keeps-its-store).

## Store backup

The [store](#store) kept as a git repository of its own and pushed to a private remote, such as a GitHub repository. It keeps the journal, the transaction logs, the change feed and the named tokens’ hashes, never the settings or a secret. Every 60 seconds by default, when the store changed, it commits between two operations, then pushes. `datanotes store restore` brings it back on a new machine. See [Back up the history](/guides/history/back-up/).

## Table

A set of rows with the same columns, defined in the metastore. See [Tables](/guides/database-objects/tables/).

## Token

A credential for the HTTP API, sent as `Authorization: Bearer`. The owner token can do everything; a named token has only the permissions you give it. See [Tokens and permissions](/guides/security/tokens/).

## Transaction log

The numbered versions of a table with history on, in `transaction_log/` in the engine’s store. See [How it works](/start/how-it-works/#the-transaction-log-keeps-every-version).

## Vault

The folder of notes the engine serves. Note editors such as Obsidian, Foam or Zettlr work on a folder like this one too. A vault is optional: with `--database`, the database folder is the folder the engine serves. With `--vault`, the engine serves a whole vault, and the database is a folder inside it. Either way, rows and ordinary notes link to each other, and the engine serves every note. Paths are relative to the folder the engine serves, and the engine never writes outside it. Not every note is a row. See [How it works](/start/how-it-works/#the-engine-runs-on-a-database-folder-or-on-a-vault).

## Version

One numbered state of a table in its transaction log. `select_rows` reads a table at a version or a time. See [Table history and time travel](/guides/history/table-history/).

## View

A query stored under a name in the metastore, read like a table. See [Views](/guides/database-objects/views/).

## Webhook

A web address the engine posts the change feed to. See [Follow the change feed and webhooks](/develop/change-feed-and-webhooks/).

## Wikilink

A link between notes written `[[Note]]`, or `[[Note|alias]]` with an alias as the text it shows. A link column holds wikilinks to rows of its `ref` table. See [Relations and hierarchies](/guides/database-objects/relations/).
