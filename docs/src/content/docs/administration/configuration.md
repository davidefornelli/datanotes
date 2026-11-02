---
title: Configure the engine and the database
description: "The engine’s settings file in its store, the database’s own settings in metastore.yaml, and the environment variables of the datanotes commands."
sidebar:
  label: Configuration
  order: 5
---

Datanotes keeps its configuration in two places, for two different things:

- **The engine’s settings**: `settings.json` in the engine’s store. They cover the port, the owner token, logs, telemetry, semantic search and the store backup.
- **The database’s settings**: the `config` of `metastore.yaml`, in the database folder. `configure_database` changes them while the engine runs. They cover the default catalog and schema, the time zone, the archive folder, history and automatic links.

## Change the engine’s settings

The engine reads its settings file when it starts. At the first start it writes the file, with the port `27150` and a random owner token. Missing keys take their default. The file is in the engine’s store, outside your notes. Find it with `datanotes store path`:

```bash
npx -y datanotes store path --database your_database_folder
```

You can change a setting in three ways:

- **The browser**: the Engine settings page of the [database browser](/administration/database-browser/#change-the-engines-settings), with the owner token
- **Over HTTP**: `POST /datanotes/settings/update/`, as [Change the settings over HTTP](#change-the-settings-over-http) shows
- **The file**: stop the engine, edit `settings.json` in that folder, then start the engine again

The file is one JSON object of settings:

```json
{
  "httpServerPort": 27150,
  "httpServerToken": "your_owner_token",
  "journalRetentionDays": 90,
  "fileLogEnabled": true
}
```

Edit the file only while the engine is stopped. The engine notices a hand edit made while it runs, and refuses changes over HTTP until its next start.

`datanotes store backup` writes the store backup’s settings for you: [Back up the history](/guides/history/back-up/) shows how. The settings file itself is never backed up.

`--settings` (or `DATANOTES_SETTINGS`) names another file. The [settings reference](/reference/settings/) lists every key and its default. The file holds the owner token, so keep it private.

The settings file doesn’t name the database folder or the store. The engine finds the database folder at start, and the store by the database’s id. [Run the engine as a service](/administration/run-the-service/#where-the-engine-keeps-its-store) explains both, with the `--store` and `DATANOTES_DATA_HOME` options.

## Read the settings over HTTP

The owner token reads every setting of a running engine with `POST /datanotes/settings/`:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/settings/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Only the owner token may call it. A named token gets 403, even with `maintain`. The answer has these fields:

- **`settings_file`**: the path of the settings file
- **`settings_version`**: a version to send back with a change; it changes with every change and every start
- **`restart_pending`**: the settings saved but waiting for a restart
- **`file_changed_on_disk`**: `true` when someone edited the file by hand while the engine runs
- **`settings`**: every setting, in the order of the settings reference

Each setting has these fields:

- **`name`**, **`type`**, **`value`** and **`default_value`**: the setting, its kind of value, the value in use and the default
- **`expected`**: the values it takes, in words, such as `an integer of at least 1 (days)`
- **`applies`**: `live` when a change applies from the next request or job; `restart` when it waits for the next start
- **`editable`**: `false` for a setting you change in the file only; `change_with` then says how
- **`overridden_by`**: a start option of `datanotes serve` that wins over the setting
- **`warning`**: what to know before you change it

This is `journalRetentionDays` on a fresh engine:

```json
{
  "name": "journalRetentionDays",
  "type": "integer",
  "value": 90,
  "default_value": 90,
  "changed": false,
  "expected": "an integer of at least 1 (days)",
  "minimum": 1,
  "applies": "live",
  "editable": true,
  "restart_pending": false,
  "warning": "Journal entries older than this are dropped at the ..."
}
```

The example cuts the text of `warning`.

The answer hides every secret, and marks a setting with a hidden part as `redacted`:

- **The owner token**: `httpServerToken` has no `value`, and is `write_only`.
- **Telemetry headers**: `telemetryHeaders` shows each header’s name, with the value `<redacted>`.
- **Credentials inside an address**: `telemetryEndpoint`, `semanticBaseUrl` and `storeBackupRemote` show the address without them.

## Change the settings over HTTP

`POST /datanotes/settings/update/` changes settings while the engine runs. Only the owner token may call it. Named tokens can’t, even with `maintain`. The body has these fields:

- **`expect_version`**: the `settings_version` you read
- **`changes`**: the settings to change, by name. `null` puts a setting’s default back, except for the owner token.
- **`dry_run`**: `true` checks the change and saves nothing

`telemetryHeaders` takes a patch: `{"X-Key": "value"}` sets a header and `{"X-Key": null}` removes it. The other headers stay.

This request keeps the journal for 120 days and backs up the store every 10 minutes:

```bash
curl -X POST http://127.0.0.1:27150/datanotes/settings/update/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{
    "expect_version": "mvz0eyqcfvne.1",
    "changes": {
      "journalRetentionDays": 120,
      "storeBackupIntervalSeconds": 600
    }
  }'
```

The engine answers as below. The example leaves out the `settings` list and cuts the `migration_id`.

```json
{
  "ok": true,
  "dry_run": false,
  "settings_version": "mvz0eyqcfvne.2",
  "changed": ["journalRetentionDays", "storeBackupIntervalSeconds"],
  "applied_now": ["journalRetentionDays"],
  "after_restart": ["storeBackupIntervalSeconds"],
  "restart_pending": ["storeBackupIntervalSeconds"],
  "follow_ups": [],
  "migration_id": "20261102T094125-set_engine_settings-set-journal..."
}
```

The answer has these fields:

- **`changed`**: the settings whose value changes
- **`applied_now`** and **`after_restart`**: the changed settings that apply at once, and those that wait for a restart
- **`restart_pending`**: every setting that waits for a restart after this change
- **`follow_ups`**: what to do next, such as rebuilding the semantic index after a new model
- **`migration_id`**: the journal entry of the change
- **`settings`**: every setting after the change

The engine checks each value with the rules it uses to load the settings file. Then it saves the file and journals the change. A change is all or nothing: one refused value saves none.

### When the engine refuses a change

The engine refuses a change with one of these statuses:

- **400**: a value the settings file can’t take. `refused` lists each setting with its error and hint. A new owner token needs at least 32 characters.
- **409, `the settings changed since you read them`**: another change came first. Read the settings again, check your change against them, and send it with the new `settings_version`.
- **409, `the settings file changed on disk`**: someone edited the file by hand while the engine runs. Restart the engine to read the edits, or undo them in the file.
- **503**: the engine couldn’t save the file or journal the change. Nothing changed: try again.

This is the refusal of `"journalRetentionDays": 0`, without its `docs` link:

```json
{
  "error": "setting journalRetentionDays: 0 is not allowed",
  "hint": "journalRetentionDays takes an integer of at least 1 (days).",
  "refused": [
    {
      "setting": "journalRetentionDays",
      "error": "setting journalRetentionDays: 0 is not allowed",
      "hint": "journalRetentionDays takes an integer of at least 1 (days)."
    }
  ]
}
```

### Where a change is recorded

Every change is a journal entry with the operation `set_engine_settings`. The entry names who made it in `actor`, and lists each setting’s value before and after in `settings`. A secret has no values, only `redacted: true`. Read the entries with `list_migrations`:

```bash
curl -X POST \
  http://127.0.0.1:27150/datanotes/operations/list_migrations/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{"op": "set_engine_settings", "limit": 10}'
```

`undo_migration` can’t undo such an entry. To change a value back, send the old value to `settings/update/`. The engine also writes a log line, `datanotes engine settings changed`. The line is a warning when a changed setting has a `warning`.

### Addresses with credentials

An address may hold credentials, such as `https://user:password@host`. The engine never shows them. Answers, the journal and the logs show the address without them. That holds even when the address isn’t a valid URL. Percent-encode a `/`, `?` or `#` in a password, such as `%2F`. Otherwise the engine shows the password. Send an address back as the engine shows it, and the engine keeps the stored credentials.

Only `storeBackupRemote` can use them: git sends them to the remote. Node’s `fetch` refuses an address with credentials, so `telemetryEndpoint` and `semanticBaseUrl` can’t use them. Put credentials elsewhere for those two:

- **Telemetry**: put the key in a header of `telemetryHeaders`.
- **Embeddings**: put the key in `DATANOTES_EMBEDDING_KEY`, or in the file of `--embedding-key-file`.

## Settings that need a restart

Most settings apply at once. These six apply at the next start:

- **`vaultIndexEnabled`**: the index of the vault the engine reads at start
- **`httpServerPort`**: the port of the HTTP server
- **`httpServerToken`**: the owner token
- **`storeBackupEnabled`**, **`storeBackupRemote`** and **`storeBackupIntervalSeconds`**: the store backup

Two settings change in the file only, with the engine stopped:

- **`tableKey`**: every row names its table with this property. Rename the property in every note, then change `tableKey` in the file.
- **`transactionLogFormat`**: run `datanotes store convert-log --to files` (or `segments`). It converts the versions already written and sets the setting.

Some options of `datanotes serve` win over a setting. The answer of `settings/` names the option in `overridden_by`:

- **`httpServerPort`**: `--port`, or `DATANOTES_PORT`
- **`storeBackupEnabled`**: `--store-backup`, `--no-store-backup` or `--store-backup-remote`, or `DATANOTES_STORE_BACKUP`
- **`storeBackupRemote`**: `--store-backup-remote`, or `DATANOTES_STORE_BACKUP_REMOTE`
- **`storeBackupIntervalSeconds`**: `--store-backup-interval-s`, or `DATANOTES_STORE_BACKUP_INTERVAL_S`

Restart the engine in one of three ways:

- **The browser**: the Restart panel of the Engine settings page
- **Over HTTP**: `POST /datanotes/restart/` with the owner token
- **By hand**: `datanotes stop`, then start the engine again

[Restart the engine](/administration/run-the-service/#restart-the-engine) explains what a restart does.

## Change the database’s settings

The database’s settings live in `metastore.yaml`, which changes only through operations. [`configure_database`](/reference/operations/auxiliary/#configure_database) sets them, and returns the database as `describe_database` describes it:

- **`default_catalog`** and **`default_schema`**: where short table names, such as `film`, resolve
- **`root`**: the database folder in a vault. Renaming it moves the folder and rewrites the links to its notes. `""` moves the database to the vault root.
- **`default_partition`** and **`filename`**: the sub-folders and file names of new time-based tables
- **`archive_folder`**: where deleted rows go
- **`timezone`**: the IANA time zone that completes date-times written without an offset
- **`history`**: the transaction log for every table; `true` in a database the engine creates, and off when `config` lacks it. See [The transaction log keeps every version](/start/how-it-works/#the-transaction-log-keeps-every-version) for its disk cost
- **`autolink`**: [automatic links](/guides/read-and-write/automatic-links/) in the text writes put in notes, on by default

To revert a change, call `configure_database` again with the previous values. The journal and the history of every table record a move of the database folder with `root`. So undo and time travel find the rows in their new folder. [Configure the database settings](/guides/database-objects/catalogs-and-schemas/#configure-the-database-settings) shows it on a real engine.

`metastore.yaml` also holds the database’s `id`, at the top. The engine writes it and finds the database’s store by it, so leave it as it is.

## Set options with environment variables

Every option of the `datanotes` commands also has an environment variable. It applies when the command line doesn’t give the option. They suit containers and services:

- **`datanotes serve`**: [Run the engine as a service](/administration/run-the-service/#set-the-options-of-serve), [Sync the vault with git](/administration/git-sync/) and [Back up the history](/guides/history/back-up/#set-the-backup-for-one-run)
- **`datanotes mcp`**: [Connect your agents](/start/connect-agents/#set-options-with-flags-or-environment-variables)
- **Telemetry**: the `OTEL_EXPORTER_OTLP_*` variables, in [Send logs to your observability backend](/develop/telemetry/)

The [command line reference](/reference/cli/) shows every command and option.
