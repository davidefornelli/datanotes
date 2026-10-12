---
title: Read the engine’s errors
description: "Every error of the engine says what is wrong, how to fix it and where to read more: the shape of an error, the mistakes agents make most, and the operations that look up the right answer."
sidebar:
  label: Reading Errors
  order: 3
---

Every error the engine returns answers three questions, so an agent can correct its call without guessing:

1. **What is wrong**: the column, value, rule or argument the engine refused
2. **How to fix it**: the allowed values, the closest real name, the right shape, or the operation that looks up the answer
3. **Where to read more**: a page of this site in Markdown, with an anchor on the section that shows the fix

This page shows how an error looks, how the engine finds the fix in your data, and the mistakes agents make most often.

## Every error has a message, a hint and a docs link

Through the Model Context Protocol (MCP) server, `datanotes mcp`, a failed call comes back as a tool error. Its text ends with two lines, `Hint:` and `Docs:`. An agent that writes a film with the status `seen` reads:

```text
insert_row refused — nothing was written:
invalid datanotes/main/public/film/Nosferatu.md: status must be one of: to watch (on the list, not seen yet); watched (seen at least once)
Hint: Use one of the allowed values listed in the message, written exactly; describe_table shows what each one means. To add a value, alter_column the enum. Then call insert_row again (dry_run: true checks without writing).
Docs: read_docs("guides/database-objects/columns#describe-what-each-enum-value-means")
```

Over HTTP, the same error is JSON, with `hint` and `docs` next to `error`:

```json
{
  "error": "Table not found: flim",
  "hint": "Did you mean \"film\"? Tables: film. list_tables lists them …",
  "docs": "https://datanotes.dev/guides/database-objects/tables.md#find-the-table-that-matches-a-request"
}
```

A refused write, with status 422, keeps its usual body: the operation’s result with `ok: false` and the reasons. The engine adds `hint` and `docs` to it. In code, `DatanotesClient` appends both lines to two texts:

- **`call`**: the `value` of a failed call
- **`post`**: the message of the `DatanotesError` it throws, which also has `hint` and `docs` as fields

The `docs` link always points to a `.md` page, the Markdown version of a page of this site. Agents read Markdown best. The reference of an operation is the page of its kind, followed by an anchor with the operation’s name, such as `https://datanotes.dev/reference/operations/rows.md#insert_row`.

The `Docs:` line of the text names the page in two ways:

- **`datanotes mcp`**: only the `read_docs` call, which reads the page from the docs of the installed version. Its agents always have the docs tools, so they need no internet access and no web address.
- **`DatanotesClient` and `datanotes/mcp`**: the address, then the same `read_docs` call in parentheses. Your own MCP server may not serve the docs tools, so its agents keep the address. A server that serves them passes each result to `offlineDocs`, which keeps only the call. See [Build on Datanotes](/develop/build-on-datanotes/).

[Read the docs offline](/guides/agents/docs-offline/) describes the docs tools.

## The engine finds the fix in your data

When the answer is data, the hint reads it from your database:

- **A table or view that doesn’t exist**: the closest names, by spelling, by case and by the table’s `aliases`. `movies` leads to `film`, and a short database lists every table and view.
- **A column that doesn’t exist**: the closest column and the table’s columns. This works wherever a call names a column: `values`, `where`, `columns`, `order_by`, `join`, `group_by` and `aggregates`.
- **A value outside an enum**: the allowed values, each with its meaning from `value_descriptions`.
- **A wrong operator in a filter**: the operator you meant, from a typo (`gtee`) or another language’s word (`>=`, `like`, `not_in`, `is_null`). Then every operator.
- **A link to a row that doesn’t exist**: `list_link_targets`, which lists the rows the link column accepts.
- **A row that doesn’t exist**: the row with the closest note name, and how to find a row’s `path` or `id`.
- **A write to a view**: the view’s own table, since you can only read a view.

## The MCP server checks a call before the engine runs it

`datanotes mcp` checks a call against the tool’s input schema before it sends anything. It catches four mistakes:

- A tool that doesn’t exist
- An argument the tool doesn’t take
- A required argument that is missing
- A value of the wrong type

Each comes back as a tool error that lists the tool’s arguments with their types and links the tool’s reference:

```text
select_rows: unknown argument "wehre"
Hint: For "wehre" use "where". select_rows takes: table (string, required), columns (list of strings), where (object), …
Docs: read_docs("reference/operations/queries#select_rows")
```

Your own MCP server gets the same checks from `callEngineTool` in `datanotes/mcp`. A program checks arguments with `checkArguments` from `datanotes/client`.

## Fix the mistakes agents make most

| Mistake | What the agent reads | The fix |
| --- | --- | --- |
| A misspelled table, `flim` | `Table not found: flim` and `Did you mean "film"?` | Use the name given, or call `list_tables` |
| A misspelled column, `titel` | `unknown column "titel"` and `Did you mean "title"?` | Use the name given; `describe_table` lists the columns |
| A value outside an enum, `seen` | The allowed values and their meanings | Pick one, or ask the user which one they meant |
| A wrong operator, `">="` | `For ">=" use "gte"` and every operator | Write `{"rating": {"gte": 4}}` |
| A value of the wrong type | `minutes expected a number` | Send numbers unquoted and dates as `YYYY-MM-DD` |
| A row the table’s CHECK refuses | `violates CHECK rated_when_watched` and the rule | Change the values so the rule holds |
| A row path that doesn’t exist | `film has no row at …` and the closest row | Use the path given, or find it with `select_rows` |
| An argument the tool doesn’t take, `wehre` | `For "wehre" use "where"` and the tool’s arguments | Rename the argument |
| A write to a view | The view’s table | Write to the table, and read the view |
| An undo blocked by later changes | Which notes changed since | Undo the later writes first, newest first |

## Look up the answer before you write

The hints name these operations because each one answers a whole class of mistakes:

- **`list_tables`**: every table and view, with descriptions and aliases
- **`describe_table`**: a table’s columns, types, limits, enum values with their meanings, and CHECK constraints
- **`describe_database`**: catalogs, schemas, bases and the database’s settings
- **`list_link_targets`**: the rows a link column may point to, filtered by its `ref_where` and `ref_by`
- **`check_table`**: the rows that break the schema, such as notes edited by hand
- **`list_migrations`** and **`describe_history`**: the writes to undo, and a table’s versions

A refused write changes nothing, so the agent can fix the call and send it again. To check a write without making it, pass `dry_run: true`. To make several writes succeed or fail together, send them in one `batch`.

## Learn more about operations and refusals

- [How agents work with your vault](/guides/agents/how-agents-use-datanotes/): what an agent reads first, and how the journal records its writes
- [Operations and MCP tools](/reference/operations/): every operation with its arguments
- [See how the engine refuses bad values](/guides/data-quality/validation/#see-how-the-engine-refuses-bad-values): refusals on a real engine
- [Read errors over HTTP](/develop/http-api/#read-errors): the status codes of the HTTP API
