## The engine rolls back a write it cannot finish

A write can touch many notes, and the engine changes them one at a time. Sometimes it can’t change one of them halfway through:

- Another program holds the file, such as an editor, an antivirus or a sync tool
- Someone edits the note between the check and the change
- Someone deletes or moves the note meanwhile

The engine then puts back what it had already changed. It undoes the journal entry of the interrupted operation, as `undo_migration` would, so the database stays as it was. You don’t need to undo anything yourself.

The answer has `ok: false`, the files it couldn’t change in `failed` and `rolled_back: true`. The HTTP API answers with status 503, which means nothing changed and you can retry. Its `hint` tells you to free the file and send the operation again:

```json
{
  "ok": false,
  "op": "update_rows",
  "migration_id": "20261011T101500-update_rows-update-film",
  "failed": [
    {
      "path": "datanotes/main/public/film/Nosferatu.md",
      "error": "EBUSY: resource busy or locked"
    }
  ],
  "rolled_back": true,
  "notes_changed": 0
}
```

Through the MCP server, the agent reads the same answer as text, which says that nothing is left changed.

The journal keeps both steps. `list_migrations` shows the interrupted operation as undone, and a `rollback` entry that undid it. You can’t undo a rollback: send the operation again instead. The table history gets no version of the interrupted operation.

Inside a [batch](/guides/read-and-write/batch/), the engine rolls back the interrupted step first. The batch then undoes the steps before it, so the whole batch leaves nothing behind.

On Windows, a file another program has open can’t be renamed for a moment. The engine retries a move for about three seconds before it gives up.

### When the rollback can’t finish either

The rollback can stop too, for example when the same program still holds a file. The answer then has `rolled_back: false`. `failed` lists the file that stopped the operation and each file the rollback left, with the error `not rolled back: …`.

To finish the rollback:

1. Close the program that holds the files.
2. Call `undo_migration` with the operation’s `migration_id`.
3. Send the operation again.

`undo_migration` skips the files the rollback already put back, so you can call it again until it succeeds.

## What undo can't take back

`undo_migration` reverts the writes the journal holds. Some changes never reach the journal, so no undo brings them back:

- **`vacuum_table`**: it deletes old versions of a table’s history for good. Its `dry_run` is on by default.
- **`configure_database`**: the database settings aren’t journaled. Set the old value again with `configure_database`.
- **Webhooks**: `create_webhook` and `delete_webhook` aren’t journaled. Delete or create the webhook again.
- **`sync_semantic_index`**: it rebuilds the semantic index, which the engine can build again at any time.
- **Hand edits**: the journal doesn’t record a note you edit outside the engine. With history on, the table’s log records it, and `restore_table` brings back the version before it. Without history, nothing can.
- **Old entries**: when the engine starts, it drops journal entries older than `journalRetentionDays`, 90 days by default. `list_migrations` no longer lists them, and they can’t be undone.
- **A crash or `kill -9`**: a write cut short this way may leave some notes written and no journal entry. Find the rows it left with `check_table`, and repair them with a new write.

`restore_database` doesn’t fill these gaps either: it goes back only through tables with history on. To revert one operation, use `undo_migration`.
