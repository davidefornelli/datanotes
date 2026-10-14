---
title: Concurrent writes
description: "What happens when several agents, programs and devices write to one engine at once, and how to write safely with expect, batch and retries."
sidebar:
  label: Concurrency
  order: 3
---

Several clients often write to one database at once. Think of an agent, a script and the app on your phone. This page explains what the engine does with those writes, and how your program keeps its own writes correct.

## One engine per database

Run exactly one engine per database folder. While it runs, the engine holds a lock file, `engine.lock`, in its store. A second engine with the same store refuses to start.

The lock lives in the store, not in the database folder. So an engine with a store of its own isn’t refused, and two engines on one folder lose each other’s writes. Never run these on the same folder:

- the engine on the host and the engine in Docker
- engines on two devices that sync the vault
- two engines started with different `--store` folders

[Run the engine as a service](/administration/run-the-service/#run-one-engine-per-database) shows the lock and what to do when it’s stale. [Sync the vault between devices](/guides/data-quality/sync-between-devices/) shows how to run one engine on a synced vault.

Every client goes through that engine:

- **Programs**: call its [HTTP API](/develop/http-api/), directly or with the [JavaScript client](/develop/client/)
- **Agents**: call the Model Context Protocol (MCP) servers, which call the same HTTP API
- **People**: edit notes by hand, in Obsidian or another editor, which the engine records but doesn’t check first

## Writes run one at a time

The engine runs writes one at a time, in the order they arrive, under the lock of its transaction log. Reads run in parallel with each other.

A write that still runs after a minute lets the next write start, so one stuck write can’t hold up the rest. The engine logs a warning that names the operation.

## Reads wait for writes

The engine runs on one thread. Under a stream of reads, a write would share that thread with every read that arrives while it runs, and take several times longer. So writes go first:

- **A write runs or waits**: a read that arrives waits until no write is left.
- **A read already under way**: it finishes normally. The write doesn’t wait for it.
- **A read waits at most `writePriorityMaxWaitMs`**: 100 ms by default. It also starts once 8 writes started after it came. A burst of writes never starves the reads.
- **A long poll of the change feed**: `list_changes` with `wait_ms` never waits, and never holds a write.

What each operation does is unchanged: a read sees every write that ended before it started. Set `writePriority` to `false` in the [settings](/reference/settings/) to let reads and writes start in the order they arrive. The span `engine.schedule.wait` shows the wait in [traces](/develop/telemetry/#the-spans-the-engine-sends).

## Repeated reads come from memory

A read you send again with the same arguments, with the same token, often has the same answer. The engine keeps the answers of recent reads in memory, and sends the kept answer while nothing it read has changed:

- **A write**: a read of the tables it changed is computed again. Reads of other tables keep their answers.
- **Undo, a hand edit on disk, a sync tool**: they count as writes. The engine sees them before it answers.
- **A schema change**: every answer is computed again.
- **A view**: it depends on the tables its query reads.

Some reads depend on less than a table, or on more:

- **`read_note`**: it depends on its note. Deleting or renaming a folder also counts.
- **`list_folder`**: it depends on the notes and folders created, deleted or renamed in its folder. Deleting or renaming any folder also counts.
- **`list_tables`**: it depends on the schema only. A write to a table keeps its answer.
- **`describe_database`**: it depends on every table, and on the notes whose properties can't be read.
- **A filter through a link column**: a key such as `project.status` follows the link column `project`. The read also depends on the tables the link leads to.
- **Reads that follow links or search the text**: `expand`, `within`, the graph operations and `search_notes` depend on the whole vault.

Reads that compare with the current time (`{now}`) are never kept. A read with `{today}` is kept 15 minutes at most. Reads of history, of the change feed and of `system.information_schema` are never kept either.

`readCacheMaxBytes` sets the memory for the answers: 33554432 bytes (32 MiB) by default. The least recently used answers go first. Set it to `0` to turn the cache off.

The engine checks each write against the database as the writes before it left it. A write is checked first, then applied. If another write is applied while the engine checks yours, the engine checks yours again on the new state. It tries up to 5 times before it gives up.

So the rules of your tables hold even when clients race:

- **Unique columns**: two clients insert the same value of a `unique` column at once. One write succeeds; the other is refused with a violation of the unique column.
- **CHECK constraints that follow links**: a client adds a task to a project while another client closes that project. If the CHECK refuses tasks of closed projects, the task is refused.
- **A database that keeps changing**: when the state changes on every try, the engine refuses the write with a conflict.

That last conflict reads “the database changed while this write was being checked: send it again”. The answer has status 422 and `ok: false`, and the engine writes nothing. Send the write again.

## Two writes to the same row

Each edit sets only the columns it names. So two writes to one row behave this way:

- **Different columns**: both writes apply, and the row keeps both changes.
- **The same column, without `expect`**: both writes apply, and the last one stays. The last writer wins.
- **The same column, with `expect`**: the second write is refused, because the row no longer has the value it expects.

## Write only if the row didn’t change

`expect` on `update_row` makes the write a compare-and-set. You pass the values you read, and the engine writes only if the row still has them. Otherwise it refuses the write with a conflict and writes nothing.

```ts
import { DatanotesClient } from "datanotes/client";

const db = new DatanotesClient({
  url: "http://127.0.0.1:27150",
  token: process.env.DATANOTES_TOKEN ?? "",
  actor: { harness: "film-night" },
});

const r = await db.call("update_row", {
  table: "film",
  path: "main/public/film/Metropolis.md",
  expect: { status: "to watch" },
  set: { status: "watched" },
});
if (!r.ok) console.log(r.value);
```

If someone marked the film `watched` after your read, the engine refuses the write. `r.value` names the column, the value you expected and the value it found.

`update_rows` has a guard of its own. `expect_count` refuses the write unless exactly that many rows match `where`. A filter that matches more rows than you meant then changes nothing.

## Retry after you read again

A refused write is safe to retry only after you read the current state. The row changed for a reason: compute your write again from what it holds now.

This loop adds one to a film’s `times_seen`. It reads the row, writes with `expect`, and reads again when the write is refused:

```ts
const path = "main/public/film/Metropolis.md";

async function addViewing(attempts = 5): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const read = await db.call("select_rows", {
      table: "film",
      where: { path },
      columns: ["times_seen"],
    });
    if (!read.ok) throw new Error(String(read.value));
    const [film] = (read.value as {
      rows: { times_seen: number }[];
    }).rows;

    const write = await db.call("update_row", {
      table: "film",
      path,
      expect: { times_seen: film.times_seen },
      set: { times_seen: film.times_seen + 1 },
    });
    if (write.ok) return true;
  }
  return false;
}
```

The loop stops after a few attempts. A write that keeps failing usually breaks a rule, and no retry fixes that. Show its reason to a person instead.

Decide on a refusal by its status, never by the text of its message:

- **422**: the engine refused the write, for validation or a conflict, and wrote nothing
- **409**: the engine refused an undo, or a table name is ambiguous
- **503**: a file failed mid-write, and the engine put back what it wrote (`rolled_back: true`). Nothing changed: send the write again later
- **500**: a file failed mid-write, and so did the rollback. `failed` lists what stayed: run `undo_migration` first

`call` answers `ok: false` for any of these. To read the status, use `post`: it throws a `DatanotesError` whose `status` holds it. Over plain HTTP, read the status of the response. [Call the engine over HTTP](/develop/http-api/#read-errors) lists every status.

## Group writes that belong together

A `batch` is all or nothing while the engine keeps running. Its operations run in order, each one seeing the ones before it. If the engine refuses one, it undoes the ones already applied, and the answer has `rolled_back: true`.

A crash or `kill -9` in the middle of a batch is different. It may leave part of the batch applied:

- **Steps already done**: each keeps a journal entry of its own, which `undo_migration` reverts
- **The step under way**: its notes are written before its journal entry, so part of it may stay outside the journal
- **The batch entry**: the engine writes it last, so it’s missing

Run `check_table` after the next start to find the rows such a stop left. Stop the engine with `datanotes stop` instead, which lets the batch finish.

Use a batch when several writes must agree, such as a screening and the film it marks as watched. [Batch writes](/guides/read-and-write/batch/) shows a batch with its answer.

A batch isn’t isolated from other clients, though. The engine applies its operations one by one, like separate writes. So other clients can act between two of them:

- **Reads**: a client may see the first operations of a refused batch before the engine undoes them.
- **Writes**: another client’s write can land between two operations of the batch. The engine then undoes the batch and runs it again on the new state.
- **Undo**: if another client changed a row the batch wrote, the undo may fail. The answer then has `rolled_back: false` and status 500, and `rollback` lists what stayed.

When `rolled_back` is `false`, undo the listed writes with `undo_migration`, or repair the rows, before you retry.

## Hand edits skip the checks

A person who edits a note in Obsidian writes straight to the file. The engine doesn’t validate that edit, because it can’t refuse it.

The engine records the edit instead, so you find what it broke:

- **Transaction log**: a table with history records the edit as `EXTERNAL_EDIT`
- **Change feed**: the edit’s event has `source: "external"`, and its last event lists the rules it breaks in `violations`
- **`check_table`**: lists every row of a table that breaks the table’s rules

A program that follows the [change feed](/develop/change-feed-and-webhooks/) sees hand edits as they happen. [Hand edits](/guides/data-quality/hand-edits/) shows how to find and repair the rows they break.
