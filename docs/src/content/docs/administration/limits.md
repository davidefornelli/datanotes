---
title: Limits
description: "How the engine performs on large databases: start time, select and insert times, memory, and how to run it on 10,000 notes or more."
sidebar:
  label: Limits
  order: 7
---

The engine keeps every row in a Markdown note, so its speed depends on the number of notes and on the disk that holds them. This page gives the times we measured and shows how to run the engine on a large database.

## Measured times

We measured the engine on databases of 10,000 and 50,000 notes. On Windows 11, Microsoft Defender scanned the files. On Linux, the engine ran in a container with the notes on a Linux volume.

| Measure | 10,000 notes | 50,000 notes |
| --- | --- | --- |
| Start, Windows 11 with Defender | 15 to 18 s | 63 to 115 s |
| Start, Linux container | 4 to 5 s | 22 s |
| `select_rows` with `where` | 30 to 35 ms | 178 ms |
| `insert_row` | 91 to 128 ms | 414 ms |
| Memory (resident set size) after writes | Not measured | Up to 2 GB |

These numbers set the size the engine handles well:

- Up to about 10,000 notes, it starts within 20 seconds and answers within a few hundred milliseconds
- From 10,000 to 20,000 notes, start it before your agents and keep it running
- Above about 20,000 notes, run it as a service on Linux, and give it 2 GB of memory

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
