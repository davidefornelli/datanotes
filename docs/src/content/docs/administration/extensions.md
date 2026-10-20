---
title: Install extensions
description: "datanotes extension installs, updates, undoes and removes extensions: tables and MCP tools from a git repository, pinned to a version."
sidebar:
  label: Extensions
  order: 8
---

An extension adds tables, views, bases and MCP tools to your database. It also ships docs that agents read. You install it from a git repository, pinned to a version tag or a commit. It installs on any database: the installer matches its tables to yours, or creates them.

To install an extension you need three things:

- A running engine for the database, started with `datanotes serve`.
- `git`, for a source that is a git repository.
- The owner's access: the installer changes the schema and creates a token.

The examples use an invented extension, `acme/datanotes-ext-reading`. It keeps a reading list of books and their authors.

## Install an extension

`datanotes extension install <source>` shows the plan, asks you to confirm it, then writes it. The installer fetches the code, reads the manifest, and reads your tables. It runs no script of the extension.

1. Run a dry run. It writes nothing and prints the plan.

   ```bash
   datanotes extension install acme/datanotes-ext-reading@v1.0.0 \
     --database ~/notes --dry-run
   ```

2. Read the plan. It lists the tables (created, adopted or matched), the tools, the token and the number of operations.
3. Confirm. Run the same command with `--yes`, or without `--dry-run` and type `yes` when the terminal asks.

   ```bash
   datanotes extension install acme/datanotes-ext-reading@v1.0.0 \
     --database ~/notes --yes
   ```

4. Restart the MCP server, or the client that started it. A running server does not see a new install.

The installer writes everything in one batch. One `undo_migration` takes it back, as [Undo an install or an update](#undo-an-install-or-an-update) explains.

### Connect to the database

Every command but `check` works through the engine that serves your database. Start the engine first, with `datanotes serve`. Then name it with one of these options:

- `--database <folder>`: the database folder. The command finds the running engine and reads the owner's token from its store.
- `--vault <folder>`: a vault that holds the database, as for `datanotes serve --vault`.
- `--url <url>` and `--token-file <file>`: an engine at an address, such as on another machine. The file holds the owner's token. `DATANOTES_URL` and `DATANOTES_TOKEN_FILE` work too.
- `--store <folder>` and `--settings <file>`: the store and the settings file, when you gave them to `datanotes serve`.

Without a running engine, the command stops with `no engine runs on <folder>`. Run `datanotes status` to see whether one runs.

### Name the source

The source takes one of three forms:

| Form | Example |
| --- | --- |
| A git URL with a tag | `https://example.com/acme/datanotes-ext-reading.git#v1.0.0` |
| GitHub shorthand | `acme/datanotes-ext-reading@v1.0.0` |
| A folder | `./datanotes-ext-reading` |

The ref must be a version tag (`v1.0.0` or `1.0.0`) or a full commit id. The installer refuses a branch, because a branch moves. It fetches the tag itself, even when a branch has the same name. A tag must hold the manifest version it names. Without a ref, the installer takes the newest version tag. It records the commit it resolved. A folder is for development: see [Check and publish an extension](/develop/write-an-extension/#check-and-publish-an-extension).

### Read the exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done. Also a ready dry run, nothing to do, or already up to date. |
| 1 | An error, a refusal, or you cancelled. |
| 2 | The plan has problems. Nothing is written. |
| 3 | Confirmation needed: no terminal, or `--json`, and no `--yes`. Nothing is written. |

With `--json`, the command prints one JSON object and never asks a question. An agent uses it.

## Choose the tables an extension uses

The manifest names each table by a role, such as `book` or `person`. The installer binds every role to a table of your database. An extension relates to a role in one of two ways:

- **Owned**: the extension creates the table, or adopts a table of that name that exists. An adopted table keeps its rows. The installer adds the missing columns, CHECKs, instructions and tags.
- **Dependency**: the extension uses a table you already have, such as `person`. The installer matches it by name, or creates it when you ask.

Where the installer picked a table, the plan marks it `proposed`. A proposed table is a guess. Confirm it, or choose another.

Five options carry your choices. They apply to `install` and, except the last two, to `update`.

| Option | What it does | Example |
| --- | --- | --- |
| `--map` | Binds a role to a table, or a manifest column to yours. | `--map person=work.public.people,person.name=full_name` |
| `--create` | Creates a table the extension depends on. | `--create person` |
| `--add` | Adds a missing column to a matched table. | `--add person.name` |
| `--catalog` | Sets the catalog of created tables and views. | `--catalog work` |
| `--schema` | Sets the schema of created owned tables and views. | `--schema reading` |

Each option takes a comma-separated list. `--map role=catalog.schema.table` binds a table. `--map role.column=column` maps a column. A column of the extension's own table keeps the extension's name: you cannot map it.

The plan ends with a message for the AI agent that runs the install:

> For the agent installing this extension: show this plan to the user before anything is written. Where a table says "proposed", the installer chose it: ask the user to confirm it, to pick another table (--map <role>=<catalog.schema.table>, --map <role>.<column>=<column>), or to create it (--create <role>). Add a missing column only after the user agrees (--add <role>.<column>). Solve each problem the same way. Then run the same command again with the user's choices and --yes, only once the user approved the tables it creates or changes, the tools and the token's permissions.

An agent never guesses. It shows the plan, asks the user, and runs the command again with the answers. Each problem in the plan has a code, a hint and a docs link. The common ones are:

- `table_not_found`: the table you named does not exist. List the tables with `list_tables`.
- `ambiguous_dependency`: several tables could be the role. Pass `--map` or `--create`.
- `missing_column`: the matched table lacks a column. Map another column, or add it with `--add`.
- `column_differs`: a column exists with another type or rule. Map another column or table.
- `table_exists`: a table the extension would create exists already. Use it with `--map`, or pick another catalog.
- `tool_name_taken`: a tool name is already an operation or a tool of another extension.
- `token_exists`: a token named `ext-<name>` exists already.

## What an extension can do

Each extension gets a named token, `ext-<name>`. The token has three limits:

- It writes only the tables of the roles in the manifest's `permissions.write`.
- It never changes the schema and never undoes. The installer changes the schema with the owner's token.
- It reads every table, like every named token today.

The tools of an extension run when an agent calls them. Before a tool that writes runs, the MCP server checks the agent's own token. If that token may not write the tool's tables, the call fails. A read-only client cannot write through an extension. To allow the call, add the table to the `write` patterns of the client's token. Or call the tool with a token that may write.

The journal shows `auth: ext-<name>` and the agent that called the tool. [See who did what](/guides/security/who-did-what/) explains the actor.

The code runs inside the MCP server's process. It is trusted code, not a sandbox. Install only extensions you trust, and read the plan. The installer helps in four ways:

- It pins a tag or a commit and records the commit.
- It runs no script and no build. The extension ships its built entry file.
- It stores a SHA-256 hash of the manifest and the entry file. The server refuses code that differs.
- The entry file may import only Node built-ins. The installer reads the imports in the file. Code that builds a module name at run time escapes this check.

Known limits in this version:

- **No isolation.** Extension code has the privileges of the MCP server's process.
- **No read-scoped tokens.** The token of an extension reads every table. When read patterns ship, the installer will limit it to the extension's tables.
- **No data-converting migrations.** A migration lists operations. It cannot run code to convert rows.

## Update an extension

`datanotes extension update <name>` moves an extension to a newer version. Without options, it takes the newest version tag of the source it came from.

```bash
datanotes extension update reading --database ~/notes --dry-run
datanotes extension update reading --database ~/notes --to v1.1.0 --yes
datanotes extension update reading --database ~/notes \
  --from ./datanotes-ext-reading --yes
```

- `--to` names the tag or commit to move to.
- `--from` takes a new source, such as a folder while you develop.
- `--map`, `--create` and `--add` work as for `install`.

The plan shows the migrations between the installed version and the target. A step whose effect is already there is skipped. Then the installer brings the tables in line with the new manifest:

- It adds missing columns, CHECKs, instructions, tags, bases and views.
- It replaces CHECKs that changed.
- It drops the CHECKs and views the old version owned and the new one does not.
- It never drops a column.

The whole update is one batch. A downgrade is refused. A version tag that moved to another commit is refused too, with a warning to check the repository.

## Undo an install or an update

`datanotes extension rollback <name>` undoes the last install or update. It calls `undo_migration` on the batch the installer wrote, and puts the previous record and the token's permissions back. After a first install, it removes the extension's token, token file and record.

```bash
datanotes extension rollback reading --database ~/notes --yes
```

Each rollback undoes one record. Run it again to go back one more version. The engine refuses the undo when later writes depend on the batch. In that case, undo or change those writes first.

## Remove an extension

`datanotes extension remove <name>` removes the extension and keeps its tables, because their rows are your data. It removes the tags the extension put on the tables, its token, its token file and its record.

```bash
datanotes extension remove reading --database ~/notes --yes
```

To drop the tables too, use `drop_table` yourself, after you look at their rows.

`rollback` and `remove` change only the extension's own token, `ext-<name>`. They refuse a record that names another token, because the installer never writes one.

## When the MCP server skips an extension

`datanotes mcp` loads every installed extension before it serves an agent. Over stdio it loads them at start; `serve` loads them when the first agent connects. If one cannot load, the server skips it and goes on without it. It prints the reason on stderr. Run `datanotes extension list` to see what is installed. The reasons are:

- **The extension uses an API this server does not know.** The server supports module API 1. Update Datanotes.
- **The code is not on this machine.** Run `datanotes extension install` with the same source again. It repairs the installation. The server also skips a record whose name or commit is not a valid folder name.
- **The cached code differs from what was installed.** Run the install again. The server compares hashes, and refuses edited code.
- **The engine is too old.** The manifest names a minimum Datanotes version. Update the engine, or install an older extension.
- **The token is not on this machine.** The token file lives on the machine that installed. Run the install again: it gives the extension a new token.
- **A tool name is taken.** This server or another extension has a tool of that name. Remove one of the two.
- **The entry file did not load.** The message carries the error. Ask the extension's author.
- **The code does not fit its manifest.** A tool of the manifest has no handler, or its handler is not a function. Ask the extension's author.

Start the server with `--no-extensions` to leave all extensions out. [Connect an agent](/start/connect-agents/#tools-of-extensions) explains the option.

## Where extensions live

The engine records which extensions are installed, in its store. The record holds the version, the source, the commit and the hashes. It also holds the table bindings, the tools and the token's name. It is per database, so every MCP server learns it over HTTP, and the store backup carries it.

Three routes serve the records:

- `POST /datanotes/extensions/` lists them. Any token may call it.
- `POST /datanotes/extensions/record/` writes one. Only the owner may call it.
- `POST /datanotes/extensions/delete/` deletes one. Only the owner may call it.

The code and the tokens stay on the machine that installed them, under the data home:

| Path | Content |
| --- | --- |
| `<data home>/extensions/code/<name>/<commit>/` | An immutable copy of the extension's files. |
| `<data home>/extensions/tokens/<database id>/<name>.token` | The token, readable by you only (mode 0600). |

The installer tags each table of the extension with `extension: <name>` and `extension_role: <role>`. `list_tables` and `describe_table` show them.

A second machine has no token for the extension. Run `datanotes extension install` there. It gives the extension a new token, so run it on the first machine again too.
