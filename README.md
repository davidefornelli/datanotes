# Datanotes

Datanotes is the open-source database engine for Markdown: it runs a folder of notes as typed, validated tables that your programs and AI agents query, write and undo over MCP or HTTP, while every row stays a plain file you own.

[![npm version](https://img.shields.io/npm/v/datanotes)](https://www.npmjs.com/package/datanotes)
[![CI](https://github.com/davidefornelli/datanotes/actions/workflows/ci.yml/badge.svg)](https://github.com/davidefornelli/datanotes/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<!-- Hero GIF goes here: an agent writes a row over MCP, the engine refuses a bad value and explains the fix, then the note opens as plain Markdown. -->

**Documentation: [datanotes.dev](https://datanotes.dev)**

## Why Datanotes

- **Agents can't write garbage.** Every write is checked against its table: types, links, unique values and CHECK constraints. A refused write changes nothing. Its answer says which value broke which rule and how to fix it.
- **Every change can be undone.** The engine journals every write it makes. It records who made it: the agent, its session and its token. `undo_migration` takes any change back.
- **It's still just Markdown.** A row is a note, and its front matter keys are the columns. Read it, edit it, grep it or commit it to Git. The engine reads your hand edits and checks them too.
- **Local first.** Datanotes is Apache-2.0 and runs on your machine. Nothing leaves it unless you turn that feature on.

## When not to use it

Datanotes keeps every row as a file, so it isn't a replacement for SQLite or Postgres. Choose a classic database for:

- Large analytical datasets
- High write throughput
- Many concurrent writers on one folder

Datanotes is comfortable at 10,000 notes. At 50,000 notes, the engine takes 22 to 115 seconds to start.

## Quick start

You need Node.js 22 or newer. On Windows, use Node.js 24.16 or newer, or 26.1 or newer.

Start the engine on a folder, which becomes your database. It can be empty, or hold notes already:

```bash
npx -y datanotes serve --database your_database_folder
```

[Run Datanotes on your notes](https://datanotes.dev/start/quick-start/) walks you through your first table.

## Connect your agents

Agents reach the engine through its Model Context Protocol (MCP) server, `datanotes mcp`. It uses the engine that runs on the folder, or starts one. Every client runs the same command:

```bash
npx -y datanotes mcp --database your_database_folder
```

<details>
<summary>Claude Code</summary>

```bash
claude mcp add datanotes -- \
  npx -y datanotes mcp --database your_database_folder
```

</details>

<details>
<summary>Claude Desktop</summary>

Add the server to `claude_desktop_config.json`:

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

</details>

<details>
<summary>Cursor</summary>

Add the server to `.cursor/mcp.json` in your project, or to `~/.cursor/mcp.json`:

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

</details>

<details>
<summary>VS Code</summary>

Add the server to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "datanotes": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y", "datanotes", "mcp", "--database", "your_database_folder"
      ]
    }
  }
}
```

</details>

<details>
<summary>Codex</summary>

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.datanotes]
command = "npx"
args = ["-y", "datanotes", "mcp", "--database", "your_database_folder"]
```

</details>

<details>
<summary>Windows</summary>

On Windows, clients start `npx` through `cmd /c`. For Claude Code, outside Windows Subsystem for Linux (WSL):

```bash
claude mcp add datanotes -- cmd /c npx -y datanotes mcp --database C:\Notes
```

In a JSON file, the command is `cmd` and the backslashes are escaped:

```json
{
  "mcpServers": {
    "datanotes": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "datanotes", "mcp", "--database", "C:\\Notes"
      ]
    }
  }
}
```

</details>

[Connect your agents](https://datanotes.dev/start/connect-agents/) covers HTTP transport and named tokens.

## Use it from TypeScript

Install the package with `npm install datanotes`. This script finds the engine on your folder, creates a table and queries it:

```ts
import { DatanotesClient } from "datanotes/client";
import { localEngine } from "datanotes/local";

const engine = localEngine("your_database_folder");
if (!engine) throw new Error("Start the engine on the folder first");
const db = new DatanotesClient({ url: engine.url, token: engine.token });

const created = await db.call("create_table", {
  name: "film",
  description: "Classic films I watched or want to watch",
  filename: "{title}",
  columns: [
    {
      name: "title",
      type: "string",
      required: true,
      unique: true,
      description: "The film's title, as on its poster",
    },
    {
      name: "minutes",
      type: "integer",
      min: 1,
      description: "Running time in minutes",
    },
  ],
});
if (!created.ok) throw new Error(String(created.value));

await db.call("insert_row", {
  table: "film",
  values: { title: "Nosferatu", minutes: 94 },
});

// Refused: nothing is written, and the answer explains why
const bad = await db.call("insert_row", {
  table: "film",
  values: { title: "Metropolis", minutes: 0 },
});
if (!bad.ok) console.log(bad.value);

const films = await db.call("select_rows", {
  table: "film",
  where: { minutes: { gt: 90 } },
});
console.log(films.value);
```

Each film is now a note, `main/public/film/Nosferatu.md`, with the values in its front matter. The [JavaScript client](https://datanotes.dev/develop/client/) page covers the rest of the client.

## Learn more

- [Documentation](https://datanotes.dev)
- [How it works](https://datanotes.dev/start/how-it-works/)
- [Operations](https://datanotes.dev/reference/operations/)
- [Use Datanotes with Obsidian](https://datanotes.dev/administration/use-with-obsidian/)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [License](LICENSE)

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 Davide Fornelli.
