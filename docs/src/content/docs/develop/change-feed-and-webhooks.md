---
title: Follow the change feed and webhooks
description: "React to every change in the vault from a program: poll or long-poll the change feed, stream it, or have the engine post it to a webhook."
sidebar:
  label: Change Feed and Webhooks
  order: 6
---

The change feed numbers every change in the vault: writes through the engine, hand edits with the rules they break, schema changes and, when asked for, the tool calls of agents. A program follows it to react when a note changes, without reading the tables again. [Change data feed](/guides/history/change-data-feed/) shows its events on a real engine.

## Choose how to follow the feed

A program learns about changes in three ways:

- **Polling**: `POST /datanotes/operations/list_changes/` returns the changes since a point in the feed
- **Streaming**: `GET /datanotes/changes/stream` sends each change as a Server-Sent Events (SSE) message
- **Webhooks**: the owner creates them, and the engine posts change events to their URL


Each event has its number, `seq`, the table, its `kind` (`insert`, `update`, `delete`, `move` or `metastore`), the operation that made it in `op`, the note’s path, the changed columns with their values before and after, and the actor. A hand edit has `source: "external"`, and its last event in a batch lists the rules it breaks in `violations`. When you rename a note by hand, the engine repairs the links to it. The events of that repair come after the move and name it in `cause`. For a row, `cause` also gives the `seq` of its `move` event.

## Long-poll the feed from code

`list_changes` returns the changes after `since`, oldest first. Pass the answer’s `last` as `since` on the next call, and `wait_ms` (at most 60,000) to wait for the next change instead of polling. `head` is the feed’s newest number, so a program that starts from `head` sees only what happens after it starts:

```ts
type Feed = {
  head: number;
  last: number;
  events: { kind: string; path: string }[];
};

const first = await db.call("list_changes", { limit: 1 });
if (!first.ok) throw new Error(String(first.value));
let since = (first.value as Feed).head;
for (;;) {
  const r = await db.call("list_changes", {
    since,
    wait_ms: 20_000,
    tables: ["film"],
  });
  if (!r.ok) throw new Error(String(r.value));
  const feed = r.value as Feed;
  for (const event of feed.events) console.log(event.kind, event.path);
  since = feed.last;
}
```

The filters narrow the feed before it reaches you:

- **`tables`**, **`kinds`** and **`columns`**: the tables, kinds of change and columns to keep
- **`where`**: rows that match a filter, as in `select_rows`, on the values after the change
- **`exclude_actor`**: leaves out the changes of one harness, such as the program’s own writes when it sends its name as `harness`

An answer with `gap: true` means the engine dropped older changes that you hadn’t read: read the tables again. To pick up where the program stopped after a restart, save `last` and start from it.

## Stream the feed

`GET /datanotes/changes/stream` sends each change as a Server-Sent Events (SSE) message, with its number as the event’s `id`. It takes the same filters as query parameters, and resumes from `Last-Event-ID` or `since`. A comment line every 25s keeps proxies from closing the connection, and an `event: gap` message tells the client that events were dropped.

## Receive changes with a webhook

A webhook has the engine post the feed to a web address, for a service that would rather be called than poll. Only the owner token creates webhooks, with [`create_webhook`](/reference/operations/history/#create_webhook), and the answer shows the webhook’s `secret` once: give it to the receiver. An agent connected with `datanotes mcp` gets `create_webhook` only with `--owner-tools` or `--profile all` ([Choose the tools an agent sees](/start/connect-agents/#choose-the-tools-an-agent-sees)).

The engine posts batches of up to 100 events, in order, as `{"webhook": "…", "events": [ … ], "last": 42}`. Two headers come with each one:

- **`X-Datanotes-Signature`**: `sha256=` and the hex HMAC-SHA256 of the body, keyed with the secret; check it before you trust the body
- **`X-Datanotes-Delivery`**: the number of the batch’s last event

A 2xx answer moves the webhook on. Any other answer is retried with backoff, from 5s up to 10 minutes, so a receiver that was down gets every event when it comes back. `datanotes status` lists a failing webhook with its last error.

## Choose the feed or a webhook

A named token can read the feed, while only the owner creates webhooks. So a program with its own token long-polls or streams the feed, as [Build an app on Datanotes](/develop/build-an-app/) does, and a service the owner sets up receives a webhook. A token with `read` patterns sees only the events of its readable tables, and only its own tool calls.
