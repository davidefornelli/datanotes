---
title: Run the engine as a service
description: "Start datanotes serve on a database folder or a vault, find its store, choose its address, its port and how it sees file changes, keep one engine per database, and stop it cleanly with datanotes stop."
sidebar:
  label: Run the Service
  order: 1
---

The engine is one process, `datanotes serve`, that runs on one folder: a database folder or a vault. It serves the [HTTP API](/develop/http-api/) that programs, the MCP server and other clients call. It watches the folder for hand edits, and it keeps its records in its store, a folder outside it. This page shows how to start it, configure it and stop it.

## Start the engine

You need [Node.js](https://nodejs.org) 22 or newer. Start the engine on your database folder:

```bash
npx -y datanotes serve --database your_database_folder
```

The folder is the database: `metastore.yaml` sits at its root, and a new database creates it there. Every path is relative to the folder, such as `main/public/film/Metropolis.md` for a row.

When an app such as Obsidian opens a whole vault, start the engine on the vault with `--vault your_vault_folder` instead. The database is then a subfolder of the vault, and paths start from the vault root. [Use Datanotes with Obsidian](/administration/use-with-obsidian/) explains this mode. Give one of the two options: the engine refuses both together.

The first start creates the engine’s store and its settings file, `settings.json`, with the port `27150` and a random owner token. The engine then serves the HTTP API on `http://127.0.0.1:27150`. To see where the store is, run:

```bash
npx -y datanotes store path --database your_database_folder
```

To run the engine in a container, follow [Run in Docker](/administration/docker/).

## Where the engine keeps its store

The store holds everything the engine writes besides your notes:

- the settings file `settings.json`, with the owner token
- the named tokens, the webhooks and the lock `engine.lock`
- the journal of operations, which [undo](/guides/history/journal-and-undo/) reads
- the transaction logs of [table history](/guides/history/table-history/)
- the change feed, the semantic index and the log files

Each database has its own store, named after its id: `<data home>/<database id>/`. The id is the `id` line at the top of the database’s `metastore.yaml`. The data home is the operating system’s folder for per-user application data:

| System | Data home |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Datanotes` |
| macOS | `~/Library/Application Support/Datanotes` |
| Linux | `$XDG_DATA_HOME/datanotes`, by default `~/.local/share/datanotes` |

Everything the engine keeps is in that one folder, so you can back it up or archive it as a whole. The [store backup](/guides/history/back-up/) does it for you: it pushes the journal and the history to a private git repository. Your folder holds only your notes and `metastore.yaml`: sync tools and git see no engine files.

You can place the store elsewhere:

- `DATANOTES_DATA_HOME` moves the data home, for every database
- `--store your_store_folder`, or `DATANOTES_STORE`, names the store of this database

A store named with `--store` isn’t recorded in the data home. Give the same `--store` to `datanotes status` and set `DATANOTES_STORE` for `datanotes mcp --database`, so they find the engine.

## Set the options of serve

Each option has an environment variable, which applies when the command line doesn’t give the option:

| Option | Variable | Meaning |
| --- | --- | --- |
| `--database your_database_folder` | `DATANOTES_DATABASE` | The database folder the engine runs on, with `metastore.yaml` at its root |
| `--vault your_vault_folder` | `DATANOTES_VAULT` | The vault the engine runs on, with the database in a subfolder; instead of `--database` |
| `--store your_store_folder` | `DATANOTES_STORE` | The engine’s store; default `<data home>/<database id>/` |
| None | `DATANOTES_DATA_HOME` | The data home, the folder of every store |
| `--settings your_settings_file` | `DATANOTES_SETTINGS` | The settings file; default `settings.json` in the store |
| `--host your_address` | `DATANOTES_HOST` | The address the HTTP API listens on; default `127.0.0.1` |
| `--port 27150` | `DATANOTES_PORT` | The port of the HTTP API for this run, over the `httpServerPort` setting; `0` for any free port |
| `--watch events` or `--watch poll` | `DATANOTES_WATCH` | How the engine sees file changes; default `events` |
| `--poll-ms 3000` | `DATANOTES_POLL_MS` | The interval of `--watch poll`, in milliseconds; at least 200 |
| `--embedding-key-file your_key_file` | `DATANOTES_EMBEDDING_KEY_FILE`, or the key itself in `DATANOTES_EMBEDDING_KEY` | The API key of the embedding provider for [semantic search](/guides/search/semantic/) |
| `--git-sync` | `DATANOTES_GIT_SYNC=1` | Commit, pull and push the folder: [Sync the vault with git](/administration/git-sync/) |
| `--store-backup` | `DATANOTES_STORE_BACKUP=1` | Back up the store to git: [Back up the history](/guides/history/back-up/#set-the-backup-for-one-run) |
| `--store-backup-remote your_url` | `DATANOTES_STORE_BACKUP_REMOTE` | The store backup’s repository |
| `--store-backup-interval-s 60` | `DATANOTES_STORE_BACKUP_INTERVAL_S` | Seconds between two looks for changes by the store backup, at least 10 |
| None | `DATANOTES_GIT_NETWORK_TIMEOUT_S` | Seconds a git fetch, pull or push of git sync and the store backup may take; default 600 |
| `--log your_log_file` | None | Appends the console output to a file |

The port and the owner token live in the settings file, with every other setting: [Configure the engine and the database](/administration/configuration/) explains them.

## Choose the port

The engine listens on the port of the `httpServerPort` setting, `27150` by default. To use another port for one run, pass `--port`:

```bash
npx -y datanotes serve --database your_database_folder --port 27180
```

With `--port 0`, the system picks a free port. The engine prints the port at start, writes it in its lock and reports it in `datanotes status`. Tools such as `datanotes mcp --database` read the port from the lock, so they find the engine on any port. `--port` doesn’t change the settings file.

When the port is in use, the engine waits up to 45 seconds for it, because an engine that restarts may still be closing. It prints a line while it waits. When the engine can’t listen, it exits with code 1 and says why and what to do:

- **The port is in use**: another program holds it, often another engine. Stop that program, or pass another `--port`.
- **The system reserves the port**: choose another port from 1024 to 65535. On Windows, `netsh interface ipv4 show excludedportrange protocol=tcp` lists the reserved ports.
- **The address isn’t this machine’s**: give `--host` an address of this machine, such as `127.0.0.1`.

## One database per vault

With `--database`, the folder is the database, and `metastore.yaml` sits at its root.

With `--vault`, a vault holds exactly one database: the folder of its one `metastore.yaml`. A new database goes to `datanotes/` at the top of the vault. The folder can be anywhere in the vault, also in a subfolder or at the vault root.

At each start with `--vault`, the engine looks for `metastore.yaml` in the whole vault. It skips folders whose names start with a dot, and `node_modules`. Then:

- **One `metastore.yaml`**: its folder is the database folder, whatever its name, such as `Datanotes/` or `notes/db/`. The engine doesn’t rename it.
- **A different folder from last time, with the same id**: you moved the database folder by hand. The engine records the move.
- **No `metastore.yaml`**: a new database, in `datanotes/`.

When the vault holds more than one `metastore.yaml`, at any depth, the engine refuses to start and lists them. Keep the database's folder, then remove the extra `metastore.yaml` and start the engine again. To keep its tables, create them in the database with `create_table` and copy the rows with `insert_row`.

To rename or move the database folder, call `configure_database` with `root`, or move the folder by hand. `root: ""` moves the database to the vault root, so you can start the engine with `--database` from then on. [Move the vault or the database folder](/start/how-it-works/#move-the-vault-or-the-database-folder) explains both.

## Run a copy of a vault

A copy of a vault holds the same database id as the original. Two databases can’t share a store, so the engine refuses to start on the copy while the original vault still exists. Give the copy its own id, with the engine stopped:

```bash
npx -y datanotes store new-id --vault your_copy_folder
```

The copy then gets a new, empty store at its next start: new settings, a new owner token, an empty journal and no history. To run both engines at once, start the copy with `--port 0`, or set its `httpServerPort`. To keep the original’s history in the copy, copy the original’s store too and start the copy with `--store`.

`new-id` changes `metastore.yaml`, and git or a sync tool carries that change to every copy of the vault. For a second clone of a synced vault on the same machine, start the clone with its own `--store` instead.

Moving a vault isn’t a copy. When the vault recorded in the store no longer exists, or no longer holds the database, the engine follows the vault to its new place.

## Choose how the engine sees file changes

The engine reads hand edits, from an editor, git or a sync tool, as soon as it sees them:

- **`events`**: the operating system reports each change, and the engine reacts within a fraction of a second; use it on a local disk
- **`poll`**: the engine scans the vault every `--poll-ms` milliseconds; use it where file events don’t arrive, such as network shares and bind mounts from Windows and macOS hosts

A scan of a large vault over a slow share takes seconds. The engine then scans less often, and doesn’t scan before each operation. [Limits](/administration/limits/#keep-a-docker-vault-on-a-linux-volume) explains this, and how to keep a large vault on a Linux volume.

In both modes, the engine reads a note you rename or move as a rename, and [repairs the links to it](/start/how-it-works/#the-engine-repairs-links-after-a-hand-move).

## Run one engine per database

While it runs, the engine holds a lock file, `engine.lock`, in its store, with its process, host and port. A second engine with the same store refuses to start while a running engine holds it. Tools such as `datanotes status` and `datanotes mcp --database` find the engine through the lock.

On the same machine, the engine checks the lock’s process:

- a lock left by a process that is gone doesn’t block the next start, even with a fresh heartbeat
- a live process holds the lock, even when it hangs: the next start refuses and changes nothing
- a lock written before the machine started is left over

If the refusal names a process that isn’t a Datanotes engine, delete the `engine.lock` it names and start again.

Two engines started at once on the same vault take turns. The first writes the database’s id. The second waits up to 60 seconds, then refuses because the first holds the database.

The lock lives in the store, not in the database folder. So it refuses only a second engine that uses the same store. An engine with a store of its own doesn’t see it and starts, and the two engines then lose each other’s writes. That happens in three cases:

- an engine started with another `--store` or `DATANOTES_STORE`
- the engine in Docker next to an engine on the host, on the same folder
- engines on two machines that sync the same vault

Run one engine per database folder. Never run the host engine and the Docker engine on the same folder. [Sync the vault between devices](/guides/data-quality/sync-between-devices/) shows how to run one engine on a synced vault.

## Keep the engine local

The engine listens on `127.0.0.1` unless you start it with `--host`, and it answers no Cross-Origin Resource Sharing (CORS) preflight, so web pages can’t call it. To reach it from another device, put a reverse proxy or a tunnel in front of it, over HTTPS, as the [security model](/guides/security/security-model/) explains, and give each device its own [named token](/guides/security/tokens/).

## Stop the engine

Stop the engine with `datanotes stop`, from any terminal of the same machine:

```bash
npx -y datanotes stop --database your_database_folder
```

The engine then stops gracefully:

1. It answers new requests with status 503, and finishes the requests under way, for up to 30 seconds.
2. It records the hand edits it has seen, and stops writing.
3. The store backup makes its last commit and push, for up to 15 seconds.
4. Git sync makes its last commit and push, for up to 10 seconds.
5. It releases the lock and exits.

The engine holds its lock until git is done, so no other engine starts on the store meanwhile. A git step that runs out of time is stopped, and the next start makes it. The whole stop fits in the 60 seconds that `datanotes stop` waits.

`datanotes stop` waits for the engine to exit, for up to 60 seconds; `--timeout-s` changes the wait. It finds the engine as [`datanotes status`](/administration/status/) does, and calls it with the owner token. With `--url` and `--token`, it stops the engine at that address. `--json` prints the report as JSON.

The exit code says what happened:

| Code | Meaning |
| --- | --- |
| `0` | The engine stopped |
| `1` | The engine didn’t stop: it didn’t answer, or still runs after the timeout |
| `2` | No engine runs on the folder |
| `3` | The engine runs but `datanotes stop` couldn’t ask it: it runs on another machine, is still starting, or refused the request |

Ctrl+C and the `SIGINT`, `SIGTERM` and `SIGBREAK` signals stop the engine the same way. A program can call the route itself, `POST /datanotes/stop/`, with the owner token. The route takes POST only: a `GET` gets status 405 and stops nothing. A named token can’t stop the engine.

A forced stop, such as `kill -9` or `Stop-Process -Force`, has two costs:

- **Git**: it skips the last commit and push. The engine makes them at its next start.
- **Writes**: a write it interrupts may stay half applied. The engine writes the notes first and records the write in the journal last, so `undo_migration` can’t revert that part. Run `check_table` after the next start to find the rows it left.

So use `datanotes stop` first, with a longer `--timeout-s` when the engine is busy. Outside Windows, `kill <pid>` sends `SIGTERM`, which stops the engine gracefully too. Force the stop only as a last resort.

## Stop the engine as a Windows service

Many service wrappers on Windows stop a service by ending its process, so the engine never makes its last push. Give the service a stop script instead. The script calls `datanotes stop`, and ends the process only when the engine doesn’t exit in time. Save it as `stop-datanotes.ps1`:

```powershell
# Stop the engine gracefully; end its process after the timeout.
param(
  [string]$Database = "C:\Notes",
  [int]$Timeout = 60
)
$out = npx -y datanotes stop --database $Database `
  --timeout-s $Timeout --json
$report = $out | Out-String | ConvertFrom-Json
if ($report.exit_code -eq 1 -and $report.pid) {
  Stop-Process -Id $report.pid -Force
}
exit 0
```

Set the script as the stop command of your service wrapper, and give the wrapper a stop timeout longer than `$Timeout`. Exit code 2 needs nothing more: no engine runs.
