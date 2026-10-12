---
title: Configure the engine and the database
description: "The engine’s settings file in its store, the database’s own settings in metastore.yaml, and the environment variables of the datanotes commands."
sidebar:
  label: Configuration
  order: 5
---

Datanotes keeps its configuration in two places, for two different things:

- **The engine’s settings**: `settings.json` in the engine’s store, read when the engine starts; the port, the owner token, logs, telemetry, semantic search and the store backup
- **The database’s settings**: the `config` of `metastore.yaml`, in the database folder, changed while the engine runs with `configure_database`; the default catalog and schema, the time zone, the archive folder, history and automatic links

## Change the engine’s settings

The engine reads its settings file when it starts, and writes it at the first start with the port `27150` and a random owner token. Missing keys take their default. The file is in the engine’s store, outside your notes. Find it with `datanotes store path`:

```bash
npx -y datanotes store path --database your_database_folder
```

To change a setting, stop the engine, edit `settings.json` in that folder and start the engine again:

```json
{
  "httpServerPort": 27150,
  "httpServerToken": "your_owner_token",
  "journalRetentionDays": 90,
  "fileLogEnabled": true
}
```

`datanotes store backup` writes the store backup’s settings for you: [Back up the history](/guides/history/back-up/) shows how. The settings file itself is never backed up.

`--settings` (or `DATANOTES_SETTINGS`) names another file. The [settings reference](/reference/settings/) lists every key and its default. The file holds the owner token, so keep it private.

The settings file doesn’t name the database folder or the store. The engine finds the database folder at start, and the store by the database’s id: [Run the engine as a service](/administration/run-the-service/#where-the-engine-keeps-its-store) explains both, with the `--store` and `DATANOTES_DATA_HOME` options.

## Change the database’s settings

The database’s settings live in `metastore.yaml`, which changes only through operations. [`configure_database`](/reference/operations/auxiliary/#configure_database) sets them, and returns the database as `describe_database` describes it:

- **`default_catalog`** and **`default_schema`**: where short table names, such as `film`, resolve
- **`root`**: the database folder in a vault; renaming it moves the folder and rewrites the links to its notes, and `""` moves the database to the vault root
- **`default_partition`** and **`filename`**: the sub-folders and file names of new time-based tables
- **`archive_folder`**: where deleted rows go
- **`timezone`**: the IANA time zone that completes date-times written without an offset
- **`history`**: the transaction log for every table; `true` in a database the engine creates, and off when `config` lacks it. See [The transaction log keeps every version](/start/how-it-works/#the-transaction-log-keeps-every-version) for its disk cost
- **`autolink`**: [automatic links](/guides/read-and-write/automatic-links/) in the text writes put in notes, on by default

To revert a change, call `configure_database` again with the previous values. A move of the database folder with `root` is recorded in the journal and in the history of every table, so undo and time travel find the rows in their new folder. [Configure the database settings](/guides/database-objects/catalogs-and-schemas/#configure-the-database-settings) shows it on a real engine.

`metastore.yaml` also holds the database’s `id`, at the top. The engine writes it and finds the database’s store by it, so leave it as it is.

## Set options with environment variables

Every option of the `datanotes` commands also has an environment variable, which applies when the command line doesn’t give the option. They suit containers and services:

- **`datanotes serve`**: [Run the engine as a service](/administration/run-the-service/#set-the-options-of-serve), [Sync the vault with git](/administration/git-sync/) and [Back up the history](/guides/history/back-up/#set-the-backup-for-one-run)
- **`datanotes mcp`**: [Connect your agents](/start/connect-agents/#set-options-with-flags-or-environment-variables)
- **Telemetry**: the `OTEL_EXPORTER_OTLP_*` variables, in [Send logs to your observability backend](/develop/telemetry/)

The [command line reference](/reference/cli/) shows every command and option.
