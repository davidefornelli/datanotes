---
title: Call the engine from JavaScript
description: "Use datanotes/client to run operations from Node, browsers and other applications."
sidebar:
  label: JavaScript Client
  order: 2
---

The `datanotes` package exports `datanotes/client`, a client for the [HTTP API](/develop/http-api/) with no dependencies. It runs in Node, in browsers and inside other applications that bring their own transport. The Model Context Protocol (MCP) server for agents uses it too.

## Install the client

The client ships in the `datanotes` package:

```bash
npm install datanotes
```

## Connect and run operations

Create one client per engine, with its address and a token. The token is the owner token or a [named token](/guides/security/tokens/):

```ts
import { DatanotesClient } from "datanotes/client";

const db = new DatanotesClient({
  url: "http://127.0.0.1:27150",
  token: process.env.DATANOTES_TOKEN ?? "",
  actor: { harness: "my-script" },
});
```

The engine records `actor` with every write the client makes, unless a call names another actor.

Run an [operation](/reference/operations/) by name, with the same arguments agents use. Each call answers `{ ok, value }`:

```ts
const films = await db.call("select_rows", {
  table: "film",
  order_by: "-minutes",
});
if (films.ok) console.log((films.value as { rows: unknown[] }).rows);

const r = await db.call("insert_row", {
  table: "film",
  values: { title: "Metropolis", year: 1927, minutes: 153 },
});
if (!r.ok) console.log(r.value);
```

The first call lists films, longest first. The second adds a film. When the engine refuses a write, `ok` is `false`, `value` gives a readable reason, and the engine writes nothing. To write only when a row didn’t change since you read it, and to retry safely, see [Concurrent writes](/develop/concurrency/).

For a complete program built on the client, see [Build an app on Datanotes](/develop/build-an-app/).

## Call operations and routes

The client has three methods for the engine. Each one that takes `actor` uses it instead of the client’s default:

- **`call(name, args, actor?)`**: runs an engine operation and answers `{ ok, value }`; a name that isn’t an operation answers `ok: false` without a request
- **`post(route, body, actor?)`**: sends `POST /datanotes` followed by `route`, for example `post("/tokens/me/")`, and throws on an error status
- **`ping()`**: tells whether the engine answers

The package also exports the catalog of operations:

- **`OPERATIONS`**: each operation’s name, description and input schema
- **`operationRequest(name, args)`**: the HTTP request behind an operation

To offer the operations as tools of your own Model Context Protocol (MCP) server, use `datanotes/mcp`, as [Build on Datanotes](/develop/build-on-datanotes/#build-your-own-mcp-server) shows.

## Handle errors

Failures that aren’t answers from an operation throw a `DatanotesError`. Its `kind` tells you what went wrong:

- **`unreachable`**: the engine didn’t answer
- **`auth`**: the engine refused the token
- **`http`**: `post` got an error status, given in `status`

Its `message` ends with a `Hint:` line, how to fix the call, and a `Docs:` line, the page that shows the fix; the error also has them as `hint` and `docs`. A failed `call` returns the same text as its `value`. To check an agent’s arguments before you send them, `checkArguments(name, args)` names the unknown, missing and wrongly typed ones. [Read the engine’s errors](/guides/agents/reading-errors/) shows the shape of every error.

## Find the local engine

`datanotes/local` finds the engine that runs on a vault of this machine. It works in Node only:

```ts
import { localEngine } from "datanotes/local";

const engine = localEngine("your_vault_folder");
```

`localEngine` returns `{ url, token, lock }` while an engine runs on the vault, and `null` when none does. It throws when the engine that holds the vault runs on another machine.

It finds the engine as the engine finds its store: by the database’s id, in the data home. It honors the same variables, `DATANOTES_DATA_HOME` and `DATANOTES_STORE`, and takes them as options too:

```ts
const engine = localEngine("your_vault_folder", {
  store: "your_store_folder",
});
```

`storeLocation("your_vault_folder")` returns the store’s folder, the database id and the database folder, without an engine running.

## Use your own transport

An application with its own way to make HTTP requests passes it as the transport. An Obsidian plugin, for example, passes `requestUrl`, so its requests aren’t subject to Cross-Origin Resource Sharing (CORS) rules:

```ts
const db = new DatanotesClient({
  url,
  token,
  transport: async (req) => {
    const r = await requestUrl({ ...req, throw: false });
    return { status: r.status, text: r.text };
  },
});
```

The transport receives each request and returns its status and body text.
