---
title: Build on Datanotes
description: "Datanotes is a foundation: reach the database through the default MCP server, through a program with its own token, or through an MCP server of your own that reuses the engine’s tools."
sidebar:
  label: Build on Datanotes
  order: 5
---

Datanotes is a foundation for your own tools: the engine holds your notes as typed tables, checks every write and journals it. You build on it in three ways, and you can mix them:

- **The default MCP server**: `datanotes mcp` gives an agent direct access to the database
- **A program with its own token**: a script, a service or an app calls the HTTP API, with only the permissions you give it
- **Your own MCP server**: your tools and your instructions, next to the engine’s tools you choose

Each way reaches the engine through its [HTTP API](/develop/http-api/), so the same checks, permissions and journal apply to all three.

## Give an agent direct access

`datanotes mcp` is the Model Context Protocol (MCP) server of Datanotes. It offers every [operation](/reference/operations/) of the engine as a tool, with instructions that tell the agent how to find tables and write rows. Use it when the agent should work with the database itself: create tables, query them, write rows.

[Connect your agents](/start/connect-agents/) shows how to add it to Claude, Cursor, Codex and other MCP clients. Give each agent its [own token](/guides/security/tokens/) to limit what it may change.

## Write a program with its own token

A program reads and writes through the HTTP API, from any language. In JavaScript and TypeScript, [`datanotes/client`](/develop/client/) runs the same operations agents call. The program can also follow the change feed to react when a note changes.

Give the program its [own token](/guides/security/tokens/). The engine then refuses what the program may not do, and the journal records the token’s name with every write. [Build an app on Datanotes](/develop/build-an-app/) writes such a program step by step.

## Build your own MCP server

An MCP server of your own decides what an agent sees: the engine’s tools it needs, tools of your own that know your data, and instructions in your words. Use it when agents should work through your rules, for example a film diary where the agent picks tonight’s film with one call instead of querying three tables.

`datanotes/mcp` gives your server the engine’s side, with no dependencies:

- **`engineTools(filter?)`**: the engine’s operations as MCP tool definitions, all of them or those you name in `only`, minus those in `except`
- **`callEngineTool(client, name, args, options?)`**: runs one through a `DatanotesClient` and answers its MCP result; a refusal comes back as an error result the agent can read, with a hint on how to fix it. A tool name or arguments that don’t match the tool’s schema are refused before the call reaches the engine, with the closest name and the tool’s arguments
- **`isEngineTool(name, filter?)`**: tells your server which calls go to the engine
- **`docsTools(filter?)`**, **`callDocsTool(name, args, options?)`** and **`isDocsTool(name, filter?)`**: the same for `list_docs`, `read_docs` and `search_docs`, which read the docs of the installed version from the package. With a `client` in the options, `search_docs` also ranks by meaning when the engine has semantic search on: see [hybrid search](/guides/agents/docs-offline/#search-by-words-and-by-meaning)
- **`ENGINE_INSTRUCTIONS`**: the instructions of `datanotes mcp`, to start your own with; they point agents to `search_docs` and `read_docs`
- **`toolContent(ok, value)`**: turns a result of your own tools into MCP content
- **`offlineDocs(content)`**: drops the web address from the `Docs:` lines of an error result and keeps the `read_docs` call. Use it when your server serves the docs tools, so agents read the docs offline as with `datanotes mcp`

Your server brings its own MCP software development kit (SDK), and runs with its own token. This film night server offers three read tools of the engine, the docs tools and a tool of its own. It starts with the client and the tool:

```ts
import { DatanotesClient } from "datanotes/client";
import { toolContent } from "datanotes/mcp";

const db = new DatanotesClient({
  url: "http://127.0.0.1:27150",
  token: process.env.FILM_NIGHT_TOKEN ?? "",
  actor: { harness: "film-night" },
});

const pickFilm = {
  name: "pick_film_for_tonight",
  description: "Pick the longest film to watch that fits in max_minutes.",
  inputSchema: {
    type: "object" as const,
    properties: { max_minutes: { type: "integer", minimum: 1 } },
  },
};
```

`pickFilm` is an MCP tool definition like the engine’s. The function behind it reads the films to watch with the client, and answers with `toolContent`:

```ts
async function pick(args: Record<string, unknown>) {
  const r = await db.call("select_rows", {
    table: "film",
    where: { status: "to watch" },
    order_by: "minutes",
  });
  if (!r.ok) return toolContent(false, r.value);
  const max = Number(args.max_minutes ?? Infinity);
  const rows = (r.value as { rows: { title: string; minutes: number }[] }).rows;
  const film = rows.filter((f) => f.minutes <= max).at(-1);
  return toolContent(true, { film: film?.title ?? null });
}
```

The server lists the engine’s tools it keeps next to its own, and sends each call to the engine or to `pick`. Its instructions start with the engine’s and add its own rule:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  callDocsTool, callEngineTool, docsTools, engineTools,
  isDocsTool, isEngineTool, offlineDocs, ENGINE_INSTRUCTIONS,
} from "datanotes/mcp";

const reads = { only: ["list_tables", "describe_table", "select_rows"] };
const instructions = `${ENGINE_INSTRUCTIONS}\n\nTo suggest a film for ` +
  "tonight, call pick_film_for_tonight.";
const server = new Server(
  { name: "film-night", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions },
);
```

The two handlers answer the agent’s `tools/list` and `tools/call` requests. A name outside the list answers an error, even when the engine has that operation. The server serves the docs tools, so `offlineDocs` points its errors to `read_docs` instead of a web address:

```ts
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [...engineTools(reads), ...docsTools(), pickFilm],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (isEngineTool(name, reads)) {
    return offlineDocs(await callEngineTool(db, name, args, reads));
  }
  if (isDocsTool(name)) {
    return offlineDocs(await callDocsTool(name, args, { client: db }));
  }
  if (name === pickFilm.name) return pick(args);
  return toolContent(false, `unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
```

An agent connected to this server sees seven tools: `list_tables`, `describe_table`, `select_rows`, `list_docs`, `read_docs`, `search_docs` and `pick_film_for_tonight`. With a [token](/guides/security/tokens/) that only reads, the server can’t change your notes even if its code asks to. To log its tool calls on the engine’s change feed, the server reports them with [`tool-calls/record/`](/guides/security/who-did-what/#report-what-an-agent-does).

## Choose a way

Pick by who acts and what they need:

- **An agent that manages the database**: `datanotes mcp`, with the agent’s own token
- **A program that runs on its own**: the HTTP API or `datanotes/client`, with the program’s own token
- **Agents that work through your rules**: your own MCP server, with `datanotes/mcp`

The engine itself serves no tools of other programs: a program that offers tools to agents serves them from its own MCP server. An agent can connect to that server and to `datanotes mcp` at once.
