---
title: Call the engine over HTTP
description: "Authenticate, call the engine’s routes, check its health and read its errors."
sidebar:
  label: HTTP API
  order: 1
---

`datanotes serve` starts the engine’s HTTP server on `http://127.0.0.1:27150`. Every operation of the engine is a route, so any language that sends HTTP requests can read and write your notes. This page covers tokens, the routes, the engine’s health report and errors; the [HTTP API reference](/api/) documents each route.

## Authenticate your requests

Every request needs an `Authorization: Bearer your_token` header, with one of two tokens:

- **Owner token**: `httpServerToken` in the settings file, which the engine generates when it first starts; it can do everything
- **Named token**: the engine creates it when you [create a token](/guides/security/tokens/#create-a-token) for a program or an agent, with only the permissions you give it

Three routes answer without a token: `GET /`, `GET /datanotes/openapi.json` and the `/datanotes/docs` console. They hold no data from your notes.

To use another port, set `httpServerPort` in the settings, or start the engine with `--port`. To listen on another address, start the engine with `--host`. [Choose the port](/administration/run-the-service/#choose-the-port) explains both.

## Call the engine’s routes

The engine serves its operations and a description of itself:

- **`POST /datanotes/operations/<operation>/`**: one route per operation, with the operation’s arguments as the JSON body, for example `POST /datanotes/operations/insert_row/` with `{"table": "film", "values": {…}}`
- **`GET /`**: whether the engine runs, and its version
- **`GET /datanotes/openapi.json`**: the OpenAPI 3.1 description of every route, generated from the catalog of operations, to generate clients in any language
- **`GET /datanotes/docs`**: the same description in an interactive console

The console is Swagger UI, which the engine serves itself, with nothing from other hosts. Click **Authorize**, paste the owner token or a named token, then click **Execute** on any route to call this engine. The browser keeps the token in its local storage until you log out in the **Authorize** dialog.

An operation’s body takes the same arguments as the agent’s tool of the same name. You read notes, rows or not, with three operations:

- **[`read_note`](/reference/operations/queries/#read_note)**: one note, by its `path`
- **[`list_folder`](/reference/operations/queries/#list_folder)**: the notes and folders in a `folder`
- **[`search_notes`](/reference/operations/queries/#search_notes)**: the notes that contain a `query`

Every route and field keeps working in every 3.x version: see [Compatibility](/reference/compatibility/).

## Record who makes each write

The `X-Datanotes-Actor` header tells the engine on whose behalf you write. Its value is JSON, with any of `session`, `harness`, `model` and `tool`:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/operations/insert_row/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -H 'X-Datanotes-Actor: {"harness": "my-script"}' \
  -d '{"table": "film", "values": {"title": "His Girl Friday", "year": 1940}}'
```

The engine stores the actor with the write in the journal, and in the table’s history when the table keeps one. It adds the credential as `auth`: `owner`, or the named token’s name, which the header can’t claim.

## Check the engine’s health

`POST /datanotes/status/` reports the engine’s health, and `datanotes status` prints the same report from a shell. [Check the engine’s status](/administration/status/) shows both.

## Read errors

Errors come back as JSON `{"error": "…", "hint": "…", "docs": "…"}`: what is wrong, how to fix it, and the page of this site, in Markdown, that shows the fix ([read the engine’s errors](/guides/agents/reading-errors/)). The status is one of these:

- **400**: bad input
- **401**: missing or wrong token
- **403**: a named token beyond its permissions
- **404**: unknown table, view, migration or note
- **409**: ambiguous table name
- **500**: an unexpected error, or a write that failed partway and couldn’t be [rolled back](/guides/history/journal-and-undo/#the-engine-rolls-back-a-write-it-cannot-finish)
- **503**: a write that failed partway, which the engine rolled back, so nothing changed: send it again later

The engine answers a refused write, from validation or a conflict, with 422 (409 for an undo). The body is the operation’s result, with `ok: false`, the reasons, `hint` and `docs`, and the engine writes nothing. An unexpected error (500) has no hint: it isn’t a mistake in the request.

Several clients can write at the same time. [Concurrent writes](/develop/concurrency/) explains what the engine does then, and when to retry a refused write.

## Keep the engine local

The engine binds to `127.0.0.1` unless you start it with `--host`. It answers no Cross-Origin Resource Sharing (CORS) preflight, so web pages can’t call it. To reach it from another device, follow the [security model](/guides/security/security-model/).

## Generate a client or explore the routes

The [HTTP API reference](/api/) documents every route, generated from the same OpenAPI description, [openapi.json](/openapi.json). From JavaScript, use the [JavaScript client](/develop/client/). Agents use the [Model Context Protocol (MCP) server](/start/connect-agents/).

To see the routes at work in one program, follow [Build an app on Datanotes](/develop/build-an-app/).
