---
title: How agents work with your vault
description: "What an agent reads first, how it finds tables and views, why the engine validates its writes, and how the journal records and undoes what each agent did."
sidebar:
  label: How Agents Use Datanotes
  order: 1
---

An agent connected through `datanotes mcp`, the Model Context Protocol (MCP) server of Datanotes, works with your vault the way a careful colleague works with a shared database. It reads the descriptions before it writes, writes only through operations the engine checks, and signs every change with its name in the journal. This page follows that path, from the instructions the agent receives to undoing what it did; the [prompts](/guides/agents/prompts/) show it on concrete requests.

## The agent starts with the server’s instructions

When an MCP client connects, `datanotes mcp` sends instructions with its list of tools. The engine’s part is short:

```text
Database of Markdown notes: tables defined in metastore.yaml, a row is a note whose front matter key `table` names its table, and each front matter key is a column. Use list_tables / describe_table first, select_rows to read, insert_row / update_row / update_rows / batch to write (validated, journaled, undo with undo_migration). Change the schema only with its operations (create_table, add_column, alter_column, create_view, ...); never edit metastore.yaml. Every table and column needs a `description` of what it holds, or it is refused: descriptions are how agents and people understand the schema. Fill those describe_table lists in `missing_descriptions` with alter_table / alter_column. A body you write links the notes it mentions by name (a one-word name only with a capital, inside a sentence): when a write returns ambiguous_mentions, read the candidate notes and link the right one with update_row and autolink: false, or leave the text. Read the docs of this version with search_docs and read_docs.
```

The tools are every [operation](/reference/operations/) of the engine, plus three that [read the docs of the installed version](#the-agent-reads-the-docs-of-its-version). To give agents rules and tools of your own, serve [your own MCP server](/develop/build-on-datanotes/#build-your-own-mcp-server) next to it. Each tool’s description says when to call it: `list_tables` asks the agent to call it first, and `add_column` asks the agent to read `describe_table` before it adds a column.

## The agent finds tables by their descriptions

Before it reads or writes, the agent matches your words against what the tables say about themselves:

- **`list_tables`**: every table and view, with its `description`, `aliases` and `tags`, so “my watchlist” leads to `film`, whose aliases include `watchlist`
- **`describe_table`**: the columns, each with its type, `description`, `aliases`, limits and, for an enum, the meaning of each value, plus the table’s row count

The meanings come from `value_descriptions`, which you give when you create the column. On the film diary, `describe_table` answers this for `status`:

```json
{
  "name": "status",
  "type": "enum",
  "values": ["to watch", "watched"],
  "value_descriptions": {
    "to watch": "on my watchlist, not seen yet",
    "watched": "I saw it at least once"
  },
  "ordered": true,
  "default": "to watch"
}
```

Every table and every column has a description, because the engine refuses one without. Agents and people understand the schema through them, so write each for a reader who never saw your notes. Good aliases help too: the better both are, the less the agent guesses. You set them with `create_table`, `add_column`, `alter_table`, `alter_column` and, for catalogs and schemas, `comment_on`.

A table created before descriptions were required may lack some. `describe_table` lists them in `missing_descriptions`, and the agent fills them with `alter_table` and `alter_column`. [Describe every table and column](/guides/database-objects/tables/#describe-every-table-and-column) shows the rule in use.

## The agent reads views first

A view is a stored query with a name, a description and aliases, such as `vw_to_watch`: the films whose status is `to watch`, shortest first. `list_tables` returns views next to tables, and `select_rows` reads a view like a table and can narrow it further. When a view answers the question, the agent reads it instead of rebuilding the filter, so the answer follows your definition of “to watch” and not the agent’s. [Views](/guides/database-objects/views/) shows views with joins, groups and filters on the note they’re shown for.

## The agent writes only through checked operations

Rows change through `insert_row`, `update_row`, `update_rows`, `delete_rows` and `batch`; the schema changes through operations such as `create_table`, `add_column` and `add_constraint`. The engine checks every one against the table’s column types, limits, links and CHECK constraints, and writes nothing when a check fails. Three arguments make an agent’s writes safer:

- **`dry_run`**: reports what would change, without writing
- **`batch`**: a group of writes that succeed or fail together, and that you undo as one
- **`expect`** on `update_row`: writes only if the row still has the values the agent read, so it doesn’t overwrite an edit you made in the meantime

The agent never edits `metastore.yaml`: a hand edit skips validation and has no undo. [Concurrent writes](/develop/concurrency/) explains what happens when agents, programs and people write at the same time.

## A refusal tells the agent what to fix

A refused write names the note, the column or rule, and the values the engine accepts. It ends with a hint on how to fix it and a link to the page that shows the fix. For a film with the status `seen`, the engine answers:

```text
insert_row refused — nothing was written:
invalid datanotes/main/public/film/Sunrise.md: status must be one of: to watch (on my watchlist, not seen yet); watched (I saw it at least once)
Hint: Use one of the allowed values listed in the message, written exactly; describe_table shows what each one means. To add a value, alter_column the enum. Then call insert_row again (dry_run: true checks without writing).
Docs: read_docs("guides/database-objects/columns#describe-what-each-enum-value-means")
```

The agent can correct the value and try again, or ask you. Every other error follows the same pattern: a misspelled table or column gets the closest real name, a wrong filter operator gets the one meant, and a tool argument the tool doesn’t take gets the tool’s arguments. [Read the engine’s errors](/guides/agents/reading-errors/) shows them all. Before it writes a link, the agent can call `list_link_targets`, which returns the rows the link column accepts, such as the genres a film may link to. Over HTTP, a refused write comes back with status 422 and the reasons in the body.

## The agent reads the docs of its version

`datanotes mcp` also serves this documentation, read from the installed `datanotes` package, with three tools: `list_docs`, `read_docs` and `search_docs`. The agent looks up an operation or an example without internet access, and the pages always match the version it talks to. [Read the docs offline](/guides/agents/docs-offline/) shows the tools.

## Every write names the agent that made it

The engine records an actor with every change. Through `datanotes mcp`, the actor comes from the MCP connection:

- **`harness`** and **`harness_version`**: the client’s name and version from the MCP handshake, such as `claude-code`
- **`session`**: the MCP session, shortened to 16 characters
- **`tool`**: the tool the agent called
- **`auth`**: `owner`, or the token’s name for a [named token](/start/connect-agents/#give-each-agent-its-own-token)
- **`model`**: the model, when an MCP server reports it with `POST /datanotes/sessions/identify/`

`describe_history` shows the actor of each commit:

```json
{
  "table": "main.public.film",
  "version": 10,
  "operation": "UPDATE",
  "migration_id": "20261009T215306-update_rows-update-film",
  "actor": {
    "session": "5d8c0456-3b15-40",
    "harness": "claude-code",
    "harness_version": "2.5.0",
    "tool": "batch",
    "auth": "owner"
  },
  "batch": "20261009T215306-batch-log-the-screening-of-metropoli"
}
```

Three operations read this record:

- **`list_migrations`**: the journal, newest first, each operation with `by`, the agent’s name
- **`describe_history`**: the commits of one table or of every table, with the full actor; it needs history on
- **`list_changes`**: every row change with its actor, and with `kinds: ["tool_call"]` every tool call the MCP server reported, reads included

A script records its own actor with the `X-Datanotes-Actor` header or the client’s `actor` option, as the [HTTP API guide](/develop/http-api/#record-who-makes-each-write) shows.

## Undo what an agent did

Because the journal records every write, you can take back one operation or a whole run:

- **One operation**: `undo_migration` with its `migration_id`; for a `batch`, it reverts every write in it
- **A whole run**: `restore_database` with `before_migration` set to the agent’s first operation or batch; every table with history goes back to its state before that operation (run it with `dry_run` first)
- **One table**: `restore_table` to a version or a time

The journal records an undo too, so you can undo the undo. The engine refuses an undo that would overwrite a note you edited since, and lists the conflicts. [Restore a table or the database](/guides/history/restore/) shows each operation with the engine’s answers, and the [prompts](/guides/agents/prompts/#safety-and-history-prompts) show how to ask for them.

## Give each agent only what it needs

The owner token can do everything. A [named token](/guides/security/tokens/) limits an agent to the tables in `write`, to schema changes only with `ddl`, and to configuration, undo and restore only with `maintain`. The journal then names the token with each of its writes. [Connect agents](/start/connect-agents/) shows how to create one and pass it to an MCP client.
