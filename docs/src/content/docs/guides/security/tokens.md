---
title: Give each program its own token
description: "Create named tokens with their own permissions, so the engine limits what each program or agent can do and the journal says who wrote what."
sidebar:
  label: Tokens and Permissions
  order: 1
---

A named token lets a program, a device or an agent call the engine with only the permissions it needs. The owner token can do everything; a named token reads everything and writes only what you allow. The journal records the token’s name with every write it makes, so you can tell who changed what.

To see a token at work in a complete program, follow [Build an app on Datanotes](/develop/build-an-app/). For the ways to build on the engine, read [Build on Datanotes](/develop/build-on-datanotes/). [Who did what](/guides/security/who-did-what/) shows how the journal names each token.

## Create a token

You create a token with the owner token, and the engine answers with the new token. The engine shows it once and keeps only its Secure Hash Algorithm (SHA-256) hash, in `tokens.json` in its store:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/tokens/create/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{"name": "film-diary", "write": ["main.public.*"]}'
```

This request creates a token named `film-diary` that may write rows of every table in the `main.public` schema, such as `film` and `actor`. The answer holds the token in `token` and the registry’s entry in `entry`. The name is kebab-case, and `owner` is reserved.

## Manage your tokens

The owner manages tokens with these routes under `/datanotes/`:

- **`tokens/`**: lists the tokens, with their permissions and when each one was last used
- **`tokens/update/`**: changes a token’s description, permissions or `autolink` default
- **`tokens/rotate/`**: gives a token a new value; the old one stops working at once
- **`tokens/delete/`**: revokes a token

`datanotes status` lists every token with its permissions, never its value.

## Choose what a token can do

A named token can always read. Every other permission comes from its entry:

- **Row writes**: only on tables that match a pattern in `write`: `catalog.schema.table`, `catalog.schema.*`, `catalog.*` or `*`
- **Schema changes**: only with `"ddl": true`
- **Maintenance**: only with `"maintain": true`, meant for an agent’s own token; it covers configuration, undo, restore, vacuum and rebuilding the semantic index

Whatever its permissions, a named token can’t create or delete tokens and webhooks, list tokens, rotate them or read the engine’s status: those stay the owner’s. A token may list webhooks and read its own entry with `tokens/me/`. With `tokens/update/`, it may change its own `description` and `autolink`.

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
