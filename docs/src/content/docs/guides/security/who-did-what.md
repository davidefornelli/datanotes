---
title: See who did what
description: "Every write records who made it: the token, the program or agent, its model and session. Read it in the journal, the history and the change feed."
sidebar:
  label: Who Did What
  order: 2
---

Every write records its actor: the credential that made it, and, when the caller says so, the program or agent behind it, its model and its session. The journal, the history and the change feed show it, so you can tell who changed what and undo one agent’s work without touching the rest.

## What the actor records

The actor has these fields:

- **`auth`**: the credential, `owner` or the name of a [named token](/guides/security/tokens/); the engine sets it, and no header can claim it
- **`harness`** and **`harness_version`**: the program or MCP client, such as `claude-code`
- **`model`**: the model behind an agent
- **`session`**: the agent’s session
- **`tool`**: the tool the agent called

A program sends the other fields with the `X-Datanotes-Actor` header, or the client’s `actor` option, as [Record who makes each write](/develop/http-api/#record-who-makes-each-write) shows. `datanotes mcp` fills them from the MCP connection, as [Every write names the agent that made it](/guides/agents/how-agents-use-datanotes/#every-write-names-the-agent-that-made-it) explains.

## See which token made a change

Every write records the credential as `auth` in its actor: `owner`, or the token’s name. When a program forwards an agent’s `X-Datanotes-Actor` header, the engine records both, as “harness / model via token”. A program that writes for itself, without the header, appears under its token’s name.

`list_migrations` shows this name in the `by` field of each change, and `list_changes` shows the whole actor.

## Report what an agent does

A program that serves its own Model Context Protocol (MCP) server can report its agents to the engine, with any token:

- **`POST /datanotes/sessions/identify/`**: names the model and harness behind an agent’s session; later writes that carry the session in `X-Datanotes-Actor` record them
- **`POST /datanotes/tool-calls/record/`**: records a tool call on the change feed, with `served_by` naming who served it

Tool calls appear on the change feed as events with `kind: "tool_call"`, sent only to consumers that ask for that kind. The `call` field holds `tool`, `ok`, `served_by`, `duration_ms`, `summary` and `session`, the arguments cut at 300 characters, the value cut at 1,000, and the result’s size in `result_chars` and `result_tokens`.

A large result costs less to report when the program cuts it first. The engine answers `takes_summary: true` when it accepts a cut call. Then send the value cut at 1,000 characters, and the result’s `summary` next to it. The event is the same as for the whole call. `datanotes mcp` does this after its first report.

### A session belongs to one token

The first token that reports a session owns it. Both routes count as a report. After that, only that token and the owner can report the session. Another named token gets a 403 error, and the engine stores nothing. So no token can rename another agent’s model or add tool calls to its session.

Give each agent session its own id, such as a new UUID. The engine compares the first 16 characters of the id, so make them unique. When one program serves agents with several tokens, give each token its own sessions.

The engine keeps the owners of the last 2,000 sessions in memory, and forgets them when it restarts.

## Read who did what

Three operations read the record:

- **`list_migrations`**: the journal, newest first, each write with `by`, the actor’s name
- **`describe_history`**: the commits of one table or of every table, with the full actor; it needs history on
- **`list_changes`**: every change with its actor, and with `kinds: ["tool_call"]` every tool call an MCP server reported

`restore_database` with `before_migration` brings every table back to the moment before an agent’s first write: [Restore a table or the database](/guides/history/restore/) shows it.
