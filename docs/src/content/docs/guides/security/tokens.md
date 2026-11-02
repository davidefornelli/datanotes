---
title: Give each program its own token
description: "Create named tokens with their own permissions. The engine limits what each program or agent can read and write, and the journal says who wrote what."
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

## See what each token can reach

The owner can ask the engine what each named token may read and write. Call `POST /datanotes/tokens/permissions/` with no body for every token, or with a `name` for one:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/tokens/permissions/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{"name": "cook"}'
```

The answer has two lists:

- **`objects`**: every table, then every view. A view also lists the tables it `reads`.
- **`tokens`**: each token's patterns, `ddl`, `maintain` and `access`, one entry per object.

Each entry of `access` says whether the token can `read` or `write` the object. It also names the pattern that grants it, in `read_pattern` and `write_pattern`. Only the owner may call the route; a named token gets 403, even with `maintain`.

A view is readable only when its name and every table it reads match a `read` pattern. When a token can't read a view, the entry gives the `reason`. Some views read tables known only when they run, such as a view over a base or with `{this.link}`. Such a view has `reads_complete: false`. For a token with `read` patterns, the permissions answer gives such a view no `read`, and listings hide it. A query that names the view still runs, within the tables the token reads.

The [database browser](/administration/database-browser/#manage-tokens-and-permissions) shows the same answer as the Permission matrix screen.

## Browse as another token

The owner can see the database as a named token sees it, without the token's secret. Send the header `X-Datanotes-View-As` with the token's name on a read:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/operations/list_tables/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "X-Datanotes-View-As: cook" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The engine answers with that token's permissions and read scope. A read is an operation that only reads, `tokens/me/`, `extensions/` or the change stream. The engine refuses the rest:

- **Writes and other routes**: 400, such as `view as cook only reads: POST /datanotes/operations/insert_row/ is not a read`.
- **A named token sending the header**: 403. Only the owner may view as another token.

The token's `last_seen` doesn't change, so its listing still shows when the token itself last called. The [database browser](/administration/database-browser/#browse-as-another-token) sends this header from its **View as** menu.

## A write into another table needs write too

A row write can change rows of tables it doesn't name. The engine checks those rows against `write` too. These writes change other tables:

- **`delete_rows` with `on_referenced: "set_null"`**: it clears the links to the deleted rows in the rows that link to them.
- **Inverse links**: a link to a row with an [inverse column](/guides/database-objects/relations/) adds the link back on that row.
- **`align_relations`**: it writes the missing links on the other side.

Sometimes one of those rows belongs to a table outside the token's `write`. The engine then refuses the whole write with 403. Nothing is written, and a dry run gives the same answer. The refusal names the table, such as `token legacy may not write personal.health.weight: this write changes rows of it`. When the token may not read that table, the refusal leaves the name out, so the token never learns it. In a batch, the whole batch is refused with 403 and nothing stays written.

To allow the write, add that table to the token's `write` with `tokens/update/`. The engine also checks its `read`: a token must read every table it writes.

The owner token and a token with `"write": ["*"]` write every table, so these checks never refuse them. Schema changes with `ddl`, and undo and restore with `maintain`, aren't row writes and keep their own rules.

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
- **It never sees** `personal.health.*`: rows, notes in search, nodes in the graph, changes in the feed, or names in `list_tables`.

A new table in `personal.food` becomes readable at once, because the pattern matches it.

`tokens/` and `tokens/me/` show `read` next to `write`. A token without `read` shows `["*"]`. `datanotes status` prints the limits in its text, such as `cook (read personal.food.*, write personal.food.pantry)`. A token with `"read": []` shows `read nothing`. The status in JavaScript Object Notation (JSON) carries `read` only when it is limited.

### The rules of `read`

The engine follows these rules:

- **No `read` means every table.** A token made before read patterns existed keeps reading everything. `["*"]` means the same.
- **A token reads what it writes.** Every `write` pattern must fall inside a `read` pattern. A write answers with the rows it touches and takes `where` filters, so a write-only token would still read. `tokens/create/` and `tokens/update/` refuse such a token with 400, and the hint names the missing pattern.
- **`ddl` and `maintain` need every table.** A token with either one can’t have a limited `read`. Cloning a table, adding a constraint, undo and restore read rows of any table. The engine refuses the combination with 400.
- **A view needs its tables too.** A token must read the view’s name and every table it reads. That includes nested views, joins, unions and the links its filters follow. `list_tables` lists a view only when the engine can tell its tables from the view’s query alone. It hides a view over a union, even when every table of the union is readable.
- **Free notes stay hidden.** Only a token that reads every table reads a note outside tables. The same holds for any other file of the vault. A token with a limited `read` never reads free notes.
- **A link stays visible as text.** A readable row may link to a row the token can’t read. The link text, such as `[[Pasta]]`, stays in the answer. `expand` doesn’t expand it, so the linked note’s properties stay hidden.

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
- **Counts**: `file_backlink_count` counts only the links from readable rows, in `columns`, `where` and `order_by`. The files, passages and pending notes of `describe_semantic_index` count only readable notes.

The engine filters before it applies `limit`, so a search still returns up to `limit` results. A token sees its own tool calls on the change feed, never another token’s. `list_webhooks` shows only the webhooks whose tables the token may all read.

A few more rules apply to a token with a limited `read`:

- **Schema changes stay hidden.** The change feed never shows it a change to `metastore.yaml`, whatever the table.
- **A short name means the readable table.** In the graph’s `tables`, `through` and `from_nodes.tables`, a name may match several tables. The engine then picks the one the token may read.
- **A refused write keeps its short message.** A refused link lists no rows of a table the token can’t read. The tool-call event of that refusal on the change feed holds the same short message.

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
- **Tool calls.** A token reports what its agents say about themselves, such as the harness and the tool. The engine doesn't check it. A token can't report in another token's session, as [A session belongs to one token](/guides/security/who-did-what/#a-session-belongs-to-one-token) explains.
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
