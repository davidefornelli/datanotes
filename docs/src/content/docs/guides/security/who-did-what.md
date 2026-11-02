---
title: See who did what
description: "Every write records who made it: the token, the program or agent, its model and session. Read it in the journal, the history and the change feed."
sidebar:
  label: Who Did What
  order: 2
---

Every write records its actor: the credential that made it. When the caller says so, it also records the program or agent behind it, its model and its session. The journal, the history and the change feed show it. You can tell who changed what and undo one agent’s work without touching the rest.

## What the actor records

The actor has these fields:

- **`auth`**: the credential, `owner` or the name of a [named token](/guides/security/tokens/). The engine sets it, and no header can claim it
- **`harness`** and **`harness_version`**: the program or MCP client, such as `claude-code`
- **`model`**: the model behind an agent
- **`session`**: the agent’s session
- **`tool`**: the tool the agent called

A program sends the other fields with the `X-Datanotes-Actor` header, or the client’s `actor` option. [Record who makes each write](/develop/http-api/#record-who-makes-each-write) shows how. `datanotes mcp` fills them from the MCP connection, as [Every write names the agent that made it](/guides/agents/how-agents-use-datanotes/#every-write-names-the-agent-that-made-it) explains.

## See which token made a change

Every write records the credential as `auth` in its actor: `owner`, or the token’s name. When a program forwards an agent’s `X-Datanotes-Actor` header, the engine records both, as “harness / model via token”. A program that writes for itself, without the header, appears under its token’s name.

`list_migrations` shows this name in the `by` field of each change, and the whole actor in `actor`. `list_changes` shows the whole actor too.

## Report what an agent does

A program that serves its own Model Context Protocol (MCP) server can report its agents to the engine. Any token can do it:

- **`POST /datanotes/sessions/identify/`**: names the model and harness behind an agent’s session. Later writes that carry the session in `X-Datanotes-Actor` record them
- **`POST /datanotes/tool-calls/record/`**: records a tool call on the change feed, with `served_by` naming who served it

Tool calls appear on the change feed as events with `kind: "tool_call"`. The engine sends them only to consumers that ask for that kind. The `call` field holds `tool`, `ok`, `served_by`, `duration_ms`, `summary` and `session`. It also holds the arguments, cut at 300 characters, and the value, cut at 1,000. The result’s size is in `result_chars` and `result_tokens`.

A large result costs less to report when the program cuts it first. The engine answers `takes_summary: true` when it accepts a cut call. Then send the value cut at 1,000 characters, and the result’s `summary` next to it. The event is the same as for the whole call. `datanotes mcp` does this after its first report.

### A session belongs to one token

The first token that reports a session owns it. Both routes count as a report. After that, only that token and the owner can report the session. Another named token gets a 403 error, and the engine stores nothing. So no token can rename another agent’s model or add tool calls to its session.

Give each agent session its own id, such as a new UUID. The engine compares the first 16 characters of the id, so make them unique. When one program serves agents with several tokens, give each token its own sessions.

The engine keeps the owners of the last 2,000 sessions in memory, and forgets them when it restarts.

## Read who did what

Three operations read the record:

- **`list_migrations`**: the journal, newest first, each write with `by`, the actor’s name, and `actor`
- **`describe_history`**: the commits of one table or of every table, with the full actor; it needs history on
- **`list_changes`**: every change with its actor, and with `kinds: ["tool_call"]` every tool call an MCP server reported

`restore_database` with `before_migration` brings every table back to the moment before an agent’s first write. [Restore a table or the database](/guides/history/restore/) shows how.

## List the agent sessions

The owner can list the agent sessions that used each credential. Call `POST /datanotes/sessions/`:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/sessions/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{"token": "cook", "limit": 20}'
```

The body takes three optional fields:

- **`token`**: only this credential, `owner` or a token's name
- **`since`**: the earliest event to look at, as an ISO date-time; 7 days ago by default
- **`limit`**: the most sessions to return, 100 by default and 1,000 at most

The engine reads the sessions from the change feed, the most recent first. Each session has these fields:

- **`token`** and **`session`**: the credential and the session id. Work without a session is one entry with `session: null`.
- **`harness`** and **`model`**: what the agent reported about itself
- **`first_at`**, **`last_at`**, **`first_seq`** and **`last_seq`**: when the session started and ended, and its place in the feed
- **`tool_call_count`** and **`failed_tool_call_count`**: its tool calls, and how many of them failed
- **`row_change_count`** and **`migration_count`**: the rows it changed, and its distinct journal operations
- **`tables`** and **`tools`**: the tables it wrote, and its tools by number of calls

Hand edits and background work have no credential, so the list leaves them out. A named token gets 403, even with `maintain`.

To see what one session did, filter the change feed and the journal:

- **`list_changes`** takes `auth`, a credential, and `session`, compared on its first 16 characters. Add `kinds: ["tool_call"]` for its tool calls.
- **`list_migrations`** answers each write's `actor`, and takes `auth` to keep one credential's writes. `before` pages back: pass the `executed_at` of the oldest entry you read.

The [database browser](/administration/database-browser/#see-users-sessions-and-tool-calls) shows these sessions on its Users and sessions screen.
