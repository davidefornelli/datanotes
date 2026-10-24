# Security

Datanotes is an engine that reads and writes a folder of Markdown notes, the vault. It runs on your own machine, for you and the agents you choose. This page explains:

- How to report a vulnerability
- Which versions get security fixes
- What the engine exposes on the network
- What each token can do
- How the engine guards your files and its store
- How to limit what an agent can do
- Which features send data off your machine

## Report a vulnerability

Report vulnerabilities only through GitHub Private Vulnerability Reporting. Open a [new private advisory](https://github.com/davidefornelli/datanotes/security/advisories/new) on the repository. It’s the one channel for security reports. Don’t report them in public issues or discussions. You’ll get an answer within a week.

Include these details in your report:

- The Datanotes version
- How to reproduce the problem
- What an attacker gains

## Supported versions

Security fixes go to the latest release of Datanotes 3.

| Version | Supported |
| --- | --- |
| 3.x | Yes |
| 2.x | No: it was a preview |
| 1.x | No: it was a preview |

Update to the latest 3.x release to get a fix.

## What the engine exposes on the network

The engine’s HTTP server listens on `127.0.0.1`, so only your machine can reach it, unless you start it with `--host`. It answers no Cross-Origin Resource Sharing (CORS) preflight, so web pages can’t call it.

Three routes answer without a token:

- **`GET /`**: the status and the version
- **`GET /datanotes/openapi.json`**: the API’s description
- **`/datanotes/docs`**: an interactive console over that description, with its script and stylesheet

These routes contain no data from your vault: the website publishes the same description. The console’s page loads nothing from other hosts, because its Content Security Policy (CSP) allows the same origin only. Its calls need a token, which the browser keeps in local storage until you log out.

To reach the engine from another device, such as a phone or a hosted assistant, publish it through a reverse proxy or a tunnel, over HTTPS. Give each device or agent its own named token. Publish the Model Context Protocol (MCP) server, `datanotes mcp serve`, the same way: it holds no credentials and passes each agent’s token on to the engine.

## Credentials and what they can do

The engine accepts two kinds of token, and the owner token can do everything a named token can. Prefer a named token per device, program or agent: it has only the permissions it needs, and the journal names it. MCP clients use the same tokens, because the MCP server passes them to the engine.

### Owner token

The owner token is `httpServerToken` in the settings file. It can do everything: read and write data, change the schema, manage tokens and webhooks, undo, and read the engine’s status. `datanotes status` reads it from the settings file. Keep it on the machine.

### Named token

The owner creates a named token with `POST /datanotes/tokens/create/`, and the engine stores only its hash, in `tokens.json` in its store, outside the vault. A named token has these permissions:

- **Read**: only the tables in its `read` patterns; without `read`, every table
- **Write rows**: only the tables in its `write` patterns
- **Change the schema**: only with `ddl`
- **Maintain**: with `maintain`, it may also undo, restore, vacuum, configure the database and rebuild the semantic index; use it for an agent’s own token

A named token can’t create webhooks, manage tokens or read the engine’s status, and without `maintain` it can’t undo.

With `read` patterns, a token reads only the tables they match. It never reads the notes outside tables. Listings, search, the graph and the change feed leave out the rest. A query that names another table gets 403. A token always reads what it writes, and a token with `ddl` or `maintain` reads every table. Listings hide the other tables’ names. A refusal repeats a name the caller gave, so a guessed name isn’t secret. [Limit what a token can read](https://datanotes.dev/guides/security/tokens/#limit-what-a-token-can-read) lists the rules and the known gaps.

### Extensions

An extension adds tables and Model Context Protocol (MCP) tools from a git repository. Its code is trusted code that runs inside the MCP server's process, not in a sandbox. Install only extensions you trust, and read the plan first.

- **Pinned code**: the installer takes a version tag or a full commit id, and refuses a branch. It fetches the tag itself, even when a branch has the same name. It records the commit and the SHA-256 hashes of the manifest and the entry file. The server refuses cached code that differs.
- **No install scripts**: the installer runs no script, no build and no `npm install`. The entry file may import only Node built-ins. The installer reads the imports in the file. Code that builds a module name at run time escapes this check.
- **One token for each extension**: `ext-<name>` writes only the tables the manifest lists. It cannot change the schema or undo. The installer changes the schema with the owner's token, after you confirm the plan.
- **An invoker check**: before a tool that writes runs, the server checks the calling agent's token. That token must be able to write the tool's tables. A read-only client cannot write through an extension.
- **The secret stays on one machine**: the token file sits under the data home with mode 0600. The registry in the engine's store holds no secret.

Known limits: extension code is not isolated from the MCP server's process. The installer gives its token no `read`, so it reads every table. The owner may limit it with `read` patterns that cover the tables it writes. Migrations are declarative and run no code. [Install extensions](https://datanotes.dev/administration/extensions/) has the details.

### Who made each write

The engine journals every write with its actor. The client sends the agent’s name, model and session, so they’re self-reported. The server sets the credential, `auth` (`owner`, or the named token’s name), and no client can claim another one.

## File access inside the vault

The engine resolves every path inside the vault. Both its operations and its file host refuse a path that contains `..`, a backslash, a drive letter or a NUL character.

The engine follows symbolic links inside the vault. Don’t link to folders you wouldn’t give the engine.

## A private store

The engine’s store holds its secrets: the owner token in `settings.json` and the webhooks’ secrets in `webhooks.json`. It also holds the journal and the hashes of the named tokens. On Linux and macOS, the engine keeps the store private to the user that runs it:

- **Folders**: the data home and each store are created with mode `0700`
- **Files**: `settings.json`, `webhooks.json` and the other files of the store are created with mode `0600`
- **At start**: the engine tightens a data home, a store, a settings file or a `webhooks.json` that an older version left readable by others

On Windows, the store lives in your user profile, which other users can’t read. The Docker image runs the engine with `umask 077`, so every file it creates is private too.

## Agents and prompt injection

An agent reads your notes, and a note can hold text written to manipulate it: a prompt injection. A web page you clipped or an email you saved can tell the agent to delete rows or to send your data out. The engine can’t tell such text from your own notes.

Limit what each agent can do:

- **Give it a named token**: grant only the tables it reads and writes, and leave out `ddl` and `maintain` unless it needs them
- **Give it only the tools it needs**: start the MCP server with `datanotes mcp --profile`, `--tools` or `--except`
- **Keep the webhook tools off**: they’re off by default, because a webhook sends change events to any URL

Every write is journaled with the agent’s name, so you can review it and undo it.

## Data that leaves your machine

Nothing leaves your machine unless you turn it on. These features send data out:

- **Semantic search**: sends note text to the embedding provider you configure. It’s off by default (`semanticEnabled`), and you choose the provider with `semanticProvider` and `semanticBaseUrl`. A local provider, such as Ollama or LM Studio, keeps the text on your machine.
- **Telemetry**: sends logs to the OpenTelemetry Protocol (OTLP) endpoint you configure. It’s off by default (`telemetryEnabled`). The logs contain operations, routes, note paths, actors, tool names and error messages, which may quote a value, but not note bodies. The settings file stores `telemetryHeaders`, which may hold an API key; set `OTEL_EXPORTER_OTLP_HEADERS` instead to keep the key out of it.
- **Webhooks**: the owner creates them, and the engine posts change events to the URLs they name.
- **Git sync**: with `--git-sync`, the engine pushes the vault to its git remote.
- **Store backup**: it’s off by default (`storeBackupEnabled`). When on, the engine pushes its store to the git remote you configure. The backup holds the journal, the transaction logs, the blobs, the change feed and the named tokens’ hashes. The journal, the logs and the feed quote your notes’ values. The backup leaves out `settings.json` and `webhooks.json`, which hold the secrets. Use a private repository.
