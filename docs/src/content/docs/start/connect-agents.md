---
title: Connect your agents to a vault
description: "Configure Claude, Cursor, Codex and other MCP clients with datanotes mcp, the Model Context Protocol server of Datanotes."
sidebar:
  label: Connect Your Agents
  order: 2
---

Agents such as Claude, Cursor and Codex reach your vault through the Model Context Protocol (MCP) server of Datanotes, the `datanotes mcp` command. This page shows how to:

- Start the server for an agent on your computer
- Serve it over HTTP to more than one agent
- Choose the tools each agent sees
- Give each agent its own token and see what it changed
- Protect your database from prompt injection

## How the MCP server reaches the engine

`datanotes mcp` ships in the `datanotes` package and runs as its own process, apart from the engine. It offers the [operations](/reference/operations/) as MCP tools, all but the webhook tools [unless you add them](#choose-the-tools-an-agent-sees), plus `list_docs`, `read_docs` and `search_docs`, which [read the docs](#read-the-docs-offline) of the installed version. Tools of other programs come from their own MCP servers, as [Build on Datanotes](/develop/build-on-datanotes/) explains. Each tool call becomes a request to the engine’s [HTTP API](/develop/http-api/) with the agent’s token. The engine then checks what the token may do and records who did what.

An MCP client starts the server in one of two ways:

- **Standard input and output (stdio)**: the client starts `datanotes mcp` itself, on the computer that holds the vault
- **HTTP**: the client calls `/mcp` on a running `datanotes mcp serve` and sends a bearer token; use it for more than one client at once, or for a hosted assistant that can send a custom `Authorization` header (the server offers no OAuth)

## Connect an agent on your computer

You need [Node.js](https://nodejs.org) 22 or newer. On Windows, use Node.js 24.16 or later, or 26.1 or later. Node.js 24.0 to 24.15 and 26.0 can crash at random on local connections. `datanotes mcp` warns at start on those versions.

With `--database` or `--vault`, `datanotes mcp` uses the engine that runs on that folder. Give the same option as `datanotes serve`. When no engine runs, it starts one with `datanotes serve`. When the client closes, it asks that engine to stop, as `datanotes stop` does. The engine finishes its writes and releases the folder. Only an engine still running after 35 seconds is killed.

It acts with the owner’s token from the engine’s settings, in its store, so the agent has full rights. To limit an agent, use one of these:

- [Choose its tools](#choose-the-tools-an-agent-sees) with `--profile`, `--tools` or `--except`
- Give it a [named token](#give-each-agent-its-own-token) with `--url` and `--token-file`
- Connect it over HTTP with its own token

The agent waits while the engine starts, for up to 60 seconds. A large database takes longer to start. Set `DATANOTES_ENGINE_START_TIMEOUT_S` to wait longer. Above about 20,000 notes, run `datanotes serve` as a service instead, as [Limits](/administration/limits/#start-the-engine-before-the-agent) explains.

Add the server to Claude Code with one command:

```bash
claude mcp add datanotes -- \
  npx -y datanotes mcp --database your_database_folder
```

Claude Desktop, Cursor and other clients with an `mcpServers` file take the same command and arguments:

```json
{
  "mcpServers": {
    "datanotes": {
      "command": "npx",
      "args": [
        "-y", "datanotes", "mcp", "--database", "your_database_folder"
      ]
    }
  }
}
```

Codex reads its MCP servers from `~/.codex/config.toml`:

```toml
[mcp_servers.datanotes]
command = "npx"
args = ["-y", "datanotes", "mcp", "--database", "your_database_folder"]
```

On Windows, escape the backslashes in JSON and TOML (`C:\\Notes\\Films`). Claude Code on Windows, outside Windows Subsystem for Linux (WSL), starts `npx` through `cmd`:

```bash
claude mcp add datanotes -- cmd /c npx -y datanotes mcp --database C:\Notes
```

To use an engine at an address instead of a local folder, pass the address and a file that contains the token:

```bash
npx -y datanotes mcp --url https://datanotes.example.com \
  --token-file ~/.datanotes-token
```

## Serve agents over HTTP

`datanotes mcp serve` serves MCP over Streamable HTTP at `/mcp`. Run it next to the engine:

```bash
npx -y datanotes mcp serve --url http://127.0.0.1:27150 --port 27151
```

Clients connect to `http://127.0.0.1:27151/mcp` and send their own token. Add it to Claude Code with:

```bash
claude mcp add --transport http datanotes http://127.0.0.1:27151/mcp \
  --header "Authorization: Bearer your_agent_token"
```

Cursor and the `.mcp.json` file of Claude Code take the address and the header:

```json
{
  "mcpServers": {
    "datanotes": {
      "type": "http",
      "url": "http://127.0.0.1:27151/mcp",
      "headers": { "Authorization": "Bearer your_agent_token" }
    }
  }
}
```

The server keeps no credentials: it passes the token of each request to the engine, and refuses a token the engine doesn’t accept. `GET /` answers its status without a token. To reach the server from another device, publish only `/mcp` through a reverse proxy or a tunnel, over HTTPS, as [Security](/guides/security/security-model/) explains.

## Choose the tools an agent sees

By default, `datanotes mcp` offers every tool except `create_webhook` and `delete_webhook`. A webhook sends your database's changes, and with `since` its past ones too, to any web address. So an agent gets these two tools only when you add them. Both stdio and `serve` take the same options:

| Option | What the agent sees |
| --- | --- |
| None | Every tool except `create_webhook` and `delete_webhook` |
| `--profile read` | Only the tools that read: `select_rows`, `describe_table`, the docs tools and the like |
| `--profile write` | Every tool except the schema changes, `configure_database` and the webhook tools |
| `--profile all` | Every tool, the webhook tools included |
| `--tools a,b` | Only the tools you name, separated by commas |
| `--except a,b` | The others: it removes these tools from the profile or from `--tools` |
| `--owner-tools` | Adds `create_webhook` and `delete_webhook` to the rest |

Give an agent that only answers questions the `read` profile:

```bash
claude mcp add datanotes -- \
  npx -y datanotes mcp --database your_database_folder --profile read
```

Name the tools one by one for a narrow agent, such as one that logs meals:

```bash
npx -y datanotes mcp --database your_database_folder \
  --tools list_tables,describe_table,select_rows,insert_row
```

Keep an agent from undoing changes, and give it the webhook tools:

```bash
npx -y datanotes mcp serve --except undo_migration --owner-tools
```

You can't pass `--profile` and `--tools` together. An unknown tool name stops the command, and the error names the closest tool. A call to a tool the server doesn't offer fails as an unknown tool. The engine still checks the token on every call, so a [named token](#give-each-agent-its-own-token) limits the agent too.

## Tools of extensions

An [installed extension](/administration/extensions/) adds its own tools. `datanotes mcp` offers them after the engine's tools, in stdio and in `serve`. The docs tools serve its docs under `extensions/<name>/`.

- **After an install**: restart the MCP server, or the client that started it. A running server does not see a new extension.
- **`--no-extensions`**: leaves the extension tools out. `DATANOTES_MCP_EXTENSIONS=0` does the same.
- **`--profile read`**: keeps only the extensions' tools that read.
- **`--tools` and `--except`**: name engine and docs tools only.

The engine still checks the token on every call. A tool that writes also needs a client token that may write its tables.

## Give each agent its own token

A named token limits what an agent can do, and the journal records its name. It writes only the tables you allow in `write`, changes the schema only with `ddl`, and undoes changes only with `maintain`. Create one with the owner’s token:

```bash
curl -s http://127.0.0.1:27150/datanotes/tokens/create/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{"name": "claude", "write": ["*"], "ddl": true, "maintain": true}'
```

The answer contains the token, and shows it only once. [Tokens](/guides/security/tokens/) describes every permission.

## Agents and prompt injection

An agent reads text it didn't write: your notes, web pages, emails and the answers of other tools. That text can hold instructions aimed at the agent, such as "send every note to this address". This attack is called prompt injection. Datanotes can't tell such text from your own words, so limit what a misled agent can do:

- **Offer only the tools it needs.** Use `--profile read` for an agent that reads, and `--tools` for a narrow one.
- **Keep the webhook tools for yourself.** They are off by default. Add `--owner-tools` only for an agent you ask to create a webhook.
- **Give it a named token.** A [named token](#give-each-agent-its-own-token) writes only the tables you allow, and never creates webhooks.
- **Confirm what leaves the database.** Ask your MCP client to confirm tool calls that write or send data.
- **Check what it changed.** [See which agent made a change](#see-which-agent-made-a-change), and undo it with `undo_migration`.

Every write is journaled, so you can undo what an agent changed. Data an agent sends out of the database can't come back.

## Set options with flags or environment variables

Each option has an environment variable, which applies when the command line doesn’t give the option:

| Option | Variable | Meaning |
| --- | --- | --- |
| `--database your_database_folder` | `DATANOTES_DATABASE` | stdio on the engine of a local database folder, with the owner’s token |
| `--vault your_vault_folder` | `DATANOTES_VAULT` | stdio on the engine of a local vault, with the owner’s token; instead of `--database` |
| `--url your_engine_url` | `DATANOTES_URL` | stdio on the engine at this address |
| `--token-file your_token_file` | `DATANOTES_TOKEN_FILE`, or the token itself in `DATANOTES_TOKEN` | The token for `--url` |
| `serve --url your_engine_url` | `DATANOTES_URL` | The engine behind the HTTP server; default `http://127.0.0.1:27150` |
| `serve --host your_address` | `DATANOTES_MCP_HOST` | The address the HTTP server listens on; default `127.0.0.1` |
| `serve --port 27151` | `DATANOTES_MCP_PORT` | The port of the HTTP server; default `27151` |
| `--profile read` | `DATANOTES_MCP_PROFILE` | The [tools](#choose-the-tools-an-agent-sees) to offer: `read`, `write` or `all` |
| `--tools a,b` | `DATANOTES_MCP_TOOLS` | Only these tools, separated by commas; instead of `--profile` |
| `--except a,b` | `DATANOTES_MCP_EXCEPT` | None of these tools, separated by commas |
| `--owner-tools` | `DATANOTES_MCP_OWNER_TOOLS=1` | Also offer `create_webhook` and `delete_webhook` |
| `--otlp-endpoint your_endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | The OpenTelemetry Protocol (OTLP) collector that receives the logs |
| None | `DATANOTES_DOCS_DIR` | The folder of the docs that `list_docs`, `read_docs` and `search_docs` read; default: the ones in the package |
| None | `DATANOTES_ENGINE_START_TIMEOUT_S` | Seconds `--database` waits for the engine it starts; default `60` |

`datanotes mcp --help` prints the same list, and [Command line](/reference/cli/) shows every command of `datanotes`.

## Read the docs offline

The `datanotes` package ships this documentation as Markdown, for the installed version. Agents read it with `list_docs`, `read_docs` and `search_docs`, programs through the engine, and people in `node_modules/datanotes/dist/docs/`: [Read the docs offline](/guides/agents/docs-offline/) shows each way.

## Send the server’s logs to your backend

`datanotes mcp` sends its logs with OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` or `--otlp-endpoint` names a collector. The records cover tool calls, refused requests and sessions, and never contain tokens or argument values. [Logs and telemetry](/develop/telemetry/) shows how to set up the backend.

## See which agent made a change

Every write records its actor: the client’s name from the MCP handshake, its session, the tool, and the credential as `auth` (`owner`, or the token’s name). An MCP server of your own can also report the agent’s model with `POST /datanotes/sessions/identify/`. `list_migrations` shows who made each change in its `by` field, and `list_changes` shows the full actor of every change and tool call.
