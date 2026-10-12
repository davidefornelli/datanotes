## Run one engine per synced folder

The engine keeps its lock, `engine.lock`, in its store, outside the vault. The sync tool carries the vault but not the store. So an engine on another device doesn’t see the lock, and it starts. Two engines on one folder then lose each other’s writes.

Follow these rules on a synced vault:

- **One engine**: run the engine on one device only, such as a desktop or a server that stays on.
- **No second engine on the same machine**: never run the engine on the host and the engine in Docker on the same folder. Each keeps a store of its own, so neither refuses the other.
- **Other devices edit by hand**: on a laptop or a phone, edit notes in Obsidian or another editor. Programs and agents on those devices call the one engine over HTTP, with a [named token](/guides/security/tokens/) each.

To move the engine to another device, stop it with `datanotes stop` first. Then let the sync finish before you start the engine on the new device.

The sync tool writes the other devices’ edits into the folder. The engine reads them as [hand edits](/guides/data-quality/hand-edits/): it checks each one, but can’t refuse it.

## Pick a sync tool

Each tool handles a note changed on two devices at once in its own way:

| Tool | What it does with a conflict |
| --- | --- |
| Dropbox | keeps both: the second one gets `conflicted copy` and a date in its name |
| iCloud Drive | keeps both: the second one gets a number, such as `Metropolis 2.md` |
| Syncthing | keeps both: the second one gets `.sync-conflict-` and a date in its name |
| Obsidian Sync | merges the two versions into one note |

A conflict copy in a table’s folder has the same front matter, so it becomes a second row of the same table. A merge can leave front matter that no longer parses.

## Find conflict copies and unreadable notes

Run `check_table` without `table` after a sync, or whenever a device was offline for a while. It checks every table and reports what a sync left behind:

- **Conflict copies**: a copy breaks each `unique` column, and an identity column that must match the file name. Its row lists the violations.
- **Unreadable notes**: a table whose notes can’t be read is listed in `errors`, with the error that names the problem.

To see the copies themselves, call `list_folder` on the table’s folder and look for the names in the table above.

For each copy, keep one version:

1. Compare the copy with the original with `read_note`.
2. Move what you want to keep into the original with `update_row`.
3. Delete the copy with `delete_rows`, or delete the file by hand.

Run `check_table` again: the copies no longer show up.
