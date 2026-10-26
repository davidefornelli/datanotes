---
title: Limits
description: "How the engine performs on large databases: start time, select and insert times, memory, and how to run it on 10,000 notes or more."
sidebar:
  label: Limits
  order: 7
---

The engine keeps every row in a Markdown note, so its speed depends on the number of notes and on the disk that holds them. This page gives the times we measured and shows how to run the engine on a large database.

## Measured times

We measured Datanotes 3.1.0 on synthetic databases of 10,000 and 50,000 notes, made with `bench/scale/`. One machine ran every test:

- Windows 11 Pro on an Intel Core i7-13700HX, with 32 GB of memory and an NVMe SSD
- Node.js 24.21
- Microsoft Defender scanning every file, with no exclusion
- Other programs running at the same time

The times are medians. The first start reads every note and builds the [vault index](#start-faster-with-the-vault-index). A restart reads only the notes that changed.

| Measure | 10,000 notes | 50,000 notes |
| --- | --- | --- |
| First start | 2.7 s | 15 s |
| Restart | 0.7 s | 2.0 to 2.3 s |
| First `select_rows` after a restart | 0.15 s | 1.1 to 2 s |
| Background work after a restart | 0.6 s | 4 to 6 s |
| Memory (resident set size) after a restart | 130 MB | 330 MB |
| Memory (resident set size) after a series of searches | 150 MB | 460 MB |
| Vault index on disk | 21 MB | 104 MB |

We measured the memory once the engine was idle, after a garbage collection, with the read cache off.

At 50,000 notes, the operations took these times:

| Operation | Median time |
| --- | --- |
| `insert_row` | 37 ms |
| `update_row` | 47 ms |
| `select_rows` on a table of 117 rows | 2.8 ms |
| `select_rows` of 5 notes by path | 0.3 ms |
| `describe_database` | 24 ms |
| `graph_neighbors` right after a write | 2.5 ms |
| `search_notes`, two words found in 1,213 notes | 14 ms |
| `search_notes`, a person's name | 7 ms |
| `search_notes`, a word found in 15,905 notes | 140 ms |

The first `select_rows` waits until the engine has compared the vault with its index. These numbers set the size the engine handles well:

- Up to about 10,000 notes, it starts within 3 seconds and answers within a few hundred milliseconds
- From 10,000 to 50,000 notes, start it before your agents and keep it running
- Above about 20,000 notes, run it as a service, and give it 2 GB of memory

## Keep fewer files with packs of rows

A table with many small rows, such as a log, can keep the rows of each closed month in one note. [Packs of rows](/guides/database-objects/packs/) explains how. We measured 50,000 rows of one table, from 2014 to 2018, as notes of their own and then in 118 monthly packs. The machine:

- Linux on an Intel Core i7-13700HX, with 32 GB of memory
- the vault on a RAM disk (`tmpfs`)
- Node.js 26.12

| Measure | 50,000 notes | 118 packs |
| --- | --- | --- |
| Files in the vault | 50,001 | 119 |
| First start | 2.9 s | 4.1 s |
| Restart | 0.9 s | 1.3 s |
| First `select_rows` after a restart | 0.72 s | 0.24 s |
| `select_rows` of one month (419 rows) | 1 ms | 12 ms |
| Memory (resident set size) when idle | 670 MB | 671 MB |
| Vault index on disk | 48 MB | 46 MB |
| `git add` and `git commit` of the whole vault | 684 ms | 47 ms |
| `git status` | 27 ms | 2.7 ms |

`pack_rows` packed the 50,000 rows in 35 seconds. A restart reads every pack, but takes the values of a section it read before from the store’s `packs.json`. The first start parses every section, so it takes longer.

To measure on your machine, build the engine and run the benchmark on a folder of its own:

```bash
npm run build:service
node bench/scale/packs.mjs --rows 50000 --out /tmp/packs-bench
```

## Start faster with the vault index

The engine keeps a vault index in its store, in `index/vault.sqlite`. It records what the engine read from each note: its properties, tags, links and text. It also indexes the words of each note, so `search_notes` reads only the notes that can match. It keeps each text compressed. At the next start, the engine reads only the notes that changed since.

- A note counts as unchanged while its size, its modification time and its change time stay the same.
- The change time moves with every write, also one that restores the old modification time, as `cp -p` and `rsync -t` do.
- A note written within 2 seconds of being recorded is read again. Some file systems keep times to the second only.
- A note you moved while the engine was stopped is found by its file id, or by its content.

The index is a cache, never the source of truth. Keep these points in mind:

- You can delete it at any time. The next start builds it again.
- The store backup leaves it out, and so does Time Machine on macOS.
- It needs Node.js 22.13 or later. On an older Node.js, every start reads every note.
- After each start, the engine checks the index in the background, one table at a time.
- When SQLite or that check finds damage, the engine stops using the index until the next start rebuilds it.
- A query with only one- or two-letter words reads every note.

To turn it off, set `vaultIndexEnabled` to `false` in the [engine’s settings](/administration/configuration/). The engine then deletes the index, and every start reads every note.

## Run a large database on Windows

Microsoft Defender scans every file the engine opens. On a large vault, these scans take most of the start. The engine marks its store as not content indexed, so Windows Search skips it. It never changes your antivirus settings.

To speed up the engine, choose one of these options:

- Exclude the store folder from real-time scanning. Run this in a PowerShell window opened as administrator:

  ```powershell
  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Datanotes"
  ```

- Exclude the vault folder too, but only when its notes come from sources you trust.
- Put the vault and the data home on a Dev Drive. Its performance mode defers the scans.

Never exclude the `node.exe` process: that exempts every Node.js program on the machine.

Keep the store out of OneDrive, Dropbox and iCloud folders. Sync clients and scanners lock files, and the engine then retries its renames. On macOS, the engine writes a `.metadata_never_index` file in its store, so Spotlight skips it. It also keeps the vault index out of Time Machine, since the engine can rebuild it. Time Machine still backs up the rest of the store.

## Start the engine before the agent

`datanotes mcp --database` starts an engine when none runs on the folder. The agent then waits for the whole start, up to 60 seconds. On a large database, the start can take longer than the agent waits.

Above about 20,000 notes, run `datanotes serve` as a service that starts with the machine. [Run the engine as a service](/administration/run-the-service/) shows how. `datanotes mcp --database` then finds the running engine and connects at once.

To let `datanotes mcp` wait longer for the engine it starts, set `DATANOTES_ENGINE_START_TIMEOUT_S` in seconds:

```bash
DATANOTES_ENGINE_START_TIMEOUT_S=300 \
  npx -y datanotes mcp --database your_database_folder
```

## Change many notes at once

A git pull, a sync tool or a find and replace can change thousands of notes outside the engine. The engine then brings their generated and identity columns up to date:

- It waits until the notes of a table stay quiet for 3 seconds.
- It recomputes them in one operation per table, with one entry in the journal.
- It skips the notes whose columns need nothing, such as notes that already hold a valid `id`.
- It pauses between rows, so the engine still answers requests meanwhile.

## Keep a Docker vault on a Linux volume

On Windows and macOS, a Docker bind mount of a host folder delivers no file events. The engine must then poll the vault: it compares the whole folder with what it knows, every few seconds. Over a bind mount, one comparison of 10,000 notes takes seconds.

The engine adapts to slow comparisons:

- It waits at least 4 times as long as the last comparison before the next one, up to a minute.
- It skips the comparison before each operation while comparisons are slow. A change you make outside then shows at the next comparison.

For a large vault, keep the notes on a Linux volume instead, and watch them with file events:

```yaml
services:
  datanotes:
    volumes:
      - vault:/vault
    environment:
      DATANOTES_WATCH: events
volumes:
  vault:
```

On a Linux host, a bind mount delivers file events: set `DATANOTES_WATCH=events` there too. [Run in Docker](/administration/docker/) explains the container.

## Check the engine's indexes

The engine keeps indexes of the vault in memory, so a read does not go through every note. It learns each change from the vault's file events: its own writes, your edits, renames and deletes. It never trusts them over the notes, which stay the source of truth.

When an answer looks wrong after many changes outside the engine, check the indexes. Start the engine with `DATANOTES_INDEX_CHECK=1`:

```bash
DATANOTES_INDEX_CHECK=1 \
  npx -y datanotes serve --database your_database_folder
```

After every operation, the engine then compares its indexes with a full read of the vault:

- A difference shows as an error in the engine's log, with the notes it concerns.
- The engine then reads the vault again, so the next operations answer right.
- Each comparison reads every note, so keep the check for debugging, never in daily use.

Every 10 minutes, once no write ran for a minute, the engine also compares the transaction log's view of the rows with the vault. A difference shows as a warning, and the engine logs the changes it missed.
