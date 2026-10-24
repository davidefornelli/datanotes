---
title: Give each program its own token
description: "Create named tokens with their own permissions, so the engine limits what each program or agent can read and write, and the journal says who wrote what."
sidebar:
  label: Tokens and Permissions
  order: 1
---

A named token lets a program, a device or an agent call the engine with only the permissions it needs. The owner token can do everything. A named token reads what you allow and writes only what you allow. Without `read`, it reads every table. The journal records the token’s name with every write it makes, so you can tell who changed what.

To see a token at work in a complete program, follow [Build an app on Datanotes](/develop/build-an-app/). For the ways to build on the engine, read [Build on Datanotes](/develop/build-on-datanotes/). [Who did what](/guides/security/who-did-what/) shows how the journal names each token.

## Create a token

You create a token with the owner token, and the engine answers with the new token. The engine shows it once and keeps only its Secure Hash Algorithm (SHA-256) hash, in `tokens.json` in its store:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/tokens/create/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{"name": "film-diary", "write": ["main.public.*"]}'
```

This request creates a token named `film-diary`. It may write rows of every table in the `main.public` schema, such as `film` and `actor`. It passes no `read`, so the token reads every table. The answer holds the token in `token` and the registry’s entry in `entry`. The name is kebab-case, and `owner` is reserved.

## Manage your tokens

The owner manages tokens with these routes under `/datanotes/`:

- **`tokens/`**: lists the tokens, with their permissions and when each one was last used
- **`tokens/update/`**: changes a token’s description, permissions or `autolink` default
- **`tokens/rotate/`**: gives a token a new value; the old one stops working at once
- **`tokens/delete/`**: revokes a token

`datanotes status` lists every token with its permissions, never its value.

## Choose what a token can do

Each permission of a named token comes from its entry:

- **Row reads**: only of tables that match a pattern in `read`. Without `read`, the token reads every table.
- **Row writes**: only on tables that match a pattern in `write`.
- **Schema changes**: only with `"ddl": true`.
- **Maintenance**: only with `"maintain": true`, meant for an agent’s own token. It covers configuration, undo, restore, vacuum and rebuilding the semantic index.

A pattern of `read` or `write` takes one of these forms:

- **`catalog.schema.table`**: one table, such as `personal.food.pantry`
- **`catalog.schema.*`**: every table of a schema
- **`catalog.*`**: every table of a catalog
- **`*`**: every table

Some routes stay the owner’s, whatever a named token’s permissions. A named token can’t create or delete tokens and webhooks, list tokens, rotate them or read the engine’s status. A token may list webhooks and read its own entry with `tokens/me/`. With `tokens/update/`, it may change its own `description` and `autolink`, never its permissions.

## Limit what a token can read

By default, a named token reads every table. Give it `read` patterns, and it reads only the tables they match. Use them for an agent that works on one part of your notes, so it never sees the rest.

This request creates a `cook` token for a cooking agent:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/tokens/create/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cook",
    "read": ["personal.food.*"],
    "write": ["personal.food.pantry"]
  }'
```

The `cook` token has these permissions:

- **It reads** `personal.food.pantry`, `personal.food.meals` and every other table of `personal.food`.
- **It writes** only `personal.food.pantry`.
- **It never sees** `personal.health.*`: its rows, notes in search, nodes in the graph, changes in the feed, or names in `list_tables`.

A new table in `personal.food` becomes readable at once, because the pattern matches it.

`tokens/` and `tokens/me/` show `read` next to `write`. A token without `read` shows `["*"]`. `datanotes status` prints the limits in its text, such as `cook (read personal.food.*, write personal.food.pantry)`. A token with `"read": []` shows `read nothing`. The status in JavaScript Object Notation (JSON) carries `read` only when it is limited.

### The rules of `read`

The engine follows these rules:

- **No `read` means every table.** A token made before read patterns existed keeps reading everything. `["*"]` means the same.
- **A token reads what it writes.** Every `write` pattern must fall inside a `read` pattern. A write answers with the rows it touches and takes `where` filters, so a write-only token would still read. `tokens/create/` and `tokens/update/` refuse such a token with 400, and the hint names the missing pattern.
- **`ddl` and `maintain` need every table.** A token with either one can’t have a limited `read`. Cloning a table, adding a constraint, undo and restore read rows of any table. The engine refuses the combination with 400.
- **A view needs its tables too.** To read a view, a token must read the view’s name and every table the view reads. That includes nested views, joins, unions and the links its filters follow. `list_tables` lists a view only when the engine can tell its tables from the view’s query alone. It hides a view over a union, even when every table of the union is readable.
- **Free notes stay hidden.** Only a token that reads every table reads a note outside tables, or any other file of the vault. A token with a limited `read` never reads free notes.
- **A link stays visible as text.** A readable row may link to a row the token can’t read. The link text, such as `[[Pasta]]`, stays in the answer. `expand` doesn’t expand it, so the linked note’s properties stay hidden. `file_backlink_count` stays a plain count.

### What the engine filters and what it refuses

The engine refuses a name you write yourself and filters a set you did not list.

A name you write is refused with 403 when the token can’t read it:

- The `table` of a query, a join or a union branch
- A link a `where` filter follows, such as `for_weight.kg`, and the target of `within`
- `this_note`, and the `path` of `read_note`
- An exact table name in `tables`, as `search`, `semantic_search` and the graph operations take it
- The `table` of `describe_table`, `check_table`, `infer_table`, `list_link_targets`, `table_changes` and `describe_history`

The refusal names the token and the table, such as `token cook may not read personal.health.weight`. It also carries a hint and a link to this section.

A set you did not list is filtered to what the token may read, with no error:

- **Listings**: `list_tables`, `describe_database`, `list_folder` and `system.information_schema`
- **Bases**: `base:<name>` keeps only the readable tables that extend it
- **Wildcards**: a pattern in `tables`, or every table when you leave `table` out
- **Search and the graph**: `search`, `search_notes`, `semantic_search`, and the neighbours and paths of the graph
- **History and changes**: `list_changes`, `list_migrations`, `describe_history` and the change feed’s stream

The engine filters before it applies `limit`, so a search still returns up to `limit` results. A token sees its own tool calls on the change feed, never another token’s. `list_webhooks` shows only the webhooks whose tables the token may all read.

A few more rules apply to a token with a limited `read`:

- **Schema changes stay hidden.** The change feed never shows it a change to `metastore.yaml`, whatever the table.
- **A short name means the readable table.** In the graph’s `tables`, `through` and `from_nodes.tables`, a short name may match several tables. The engine then picks the one the token may read.
- **A refused write keeps its short message.** A link the engine refuses lists no rows of a table the token can’t read. The tool-call event of that refusal on the change feed holds the same short message.

A write by a limited token still checks every table: links, uniqueness and CHECKs. Only its answer changes. It leaves out the rows of tables the token can’t read, even when the write touched them.

### Names are hidden, not secret

Listings hide the tables a token can’t read. A refusal, though, repeats the name the caller gave. So a caller who guesses `personal.health.weight` learns that the table exists. It never learns the table’s rows. The contents are protected; the names are only hidden from listings. Don’t put a secret in a table’s name.

### Change what a token reads

The owner changes `read` with `tokens/update/`. This request lets `cook` read the health tables too:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/tokens/update/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cook",
    "read": ["personal.food.*", "personal.health.*"]
  }'
```

To let a token read every table again, pass `"read": null`. A token can’t change its own `read`: the engine answers 403.

The token of an [extension](/administration/extensions/), `ext-<name>`, gets no `read` from the installer, so it reads every table. You may limit it with `tokens/update/`, as long as `read` covers the tables it writes. A tool that then reads another table gets a 403. An install or update may write a table outside `read`. The engine then refuses the token’s new `write` with 400. Widen `read` first, then run the command again.

### Known gaps

Read patterns limit tables, not columns or rows. These gaps remain:

- **No write-only tokens.** A token always reads what it writes.
- **No column or row limits.** A token reads every column and every row of a readable table.
- **Writes into other tables.** A write can change rows of other tables: `on_referenced: "set_null"`, inverse links and `align_relations`. The engine doesn’t check those changes against `write` yet. The answer still hides the rows the token can’t read.
- **Counts.** `describe_semantic_index` and `file_backlink_count` count every note, readable or not. They may tell how many notes exist.
- **Tool calls.** Any token may record a tool call with `tool-calls/record/`, in the name of any agent.
- **Guessed names.** As [Names are hidden, not secret](#names-are-hidden-not-secret) explains, a refusal confirms that a table exists.

## Turn automatic links off for a sync program

By default, the text a write puts in a note links the notes it mentions. The engine calls this [automatic links](/guides/read-and-write/automatic-links/). A sync program copies text from elsewhere, such as tasks, calendar events or receipts. That text should stay as it came, so give its token `"autolink": false`:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/tokens/create/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{"name": "tasks-sync", "write": ["main.public.task"], "autolink": false}'
```

A token’s `autolink` is the default of its writes:

- **`insert_row`, `update_row` and `update_rows`** take it, inside a `batch` too.
- **A write’s own `autolink`** still wins over it.
- **Without it**, the token’s writes follow the database’s `autolink` setting.

Turn it off for the tokens of sync programs and of modules that write text for you. Keep it unset for an agent’s token. To change it later, call `tokens/update/` with `autolink`. Pass `null` to follow the database setting again. `tokens/` and `tokens/me/` list it with the other fields of the entry.

With a limited `read`, automatic links point only to notes the token may read.
