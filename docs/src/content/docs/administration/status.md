---
title: Check the engine’s status
description: "datanotes status and POST /datanotes/status/: the engine’s health at a glance, with exit codes for scripts and monitors."
sidebar:
  label: datanotes status
  order: 4
---

The engine reports its health in one place: its version and uptime, the database, git sync, the store backup, the change feed, webhooks, tokens and the hand edits that break the rules. You read it from a shell with `datanotes status`, or from a program with `POST /datanotes/status/`.

## Check the status from a shell

`datanotes status` prints the engine’s health report. It finds the engine through the lock file in the engine’s store, `engine.lock`, and calls the route with the owner token from the settings file. Give it the same folder and option as `datanotes serve`, `--database` or `--vault`. For a store named with `--store`, give `--store` here too:

```bash
npx datanotes status --database your_database_folder
```

The report looks like this. Add `--json` to get the whole object instead:

```text
datanotes status: needs attention
engine     3.0.0, pid 8124 on nas, up 3d 4h, http://127.0.0.1:27150, watch events
vault      /srv/vault (settings /home/me/.local/share/datanotes/01a1…/settings.json)
store      /home/me/.local/share/datanotes/01a1…, database Datanotes (id 01a1…)
database   datanotes/metastore.yaml: 14 tables (6 with history), 3 views
journal    42 operations in the last 24 h; last update_rows at 2026-10-09T08:12:03.120Z by claude-code / claude-opus-5-5
git sync   on, repo /srv/vault, last commit 2026-10-09T08:13:10.002Z, last push 2026-10-09T08:13:12.441Z, 0 pending operations
backup     on, every 60 s, remote git@github.com:me/vault-store.git, last commit 3f9c2a1 at 2026-10-09T08:13:00.120Z, last push 2026-10-09T08:13:01.020Z, 0 pending operations, 0 commits to push
changes    feed running, last seq 18342
webhooks   2 (1 failing)
  ! wh_3fa9c1d2e4b5 hooks.example.com: 4 failed attempts, retried with backoff; last error: HTTP 502
tokens     phone (write main.public.film); assistant (write *, ddl, maintain)
hand edits 3 hand edits in the last 24 h, none breaking the tables' rules
logs       files /home/me/.local/share/datanotes/01a1…/logs
problems:
  - webhook wh_3fa9c1d2e4b5 (hooks.example.com) failing: HTTP 502
```

The exit code suits scripts and monitors:

- **0**: the engine is healthy
- **1**: something needs attention, such as git sync blocked, a failing store backup push, a failing webhook, the change feed not running, hand edits breaking the rules or a refused token
- **2**: no engine runs on the folder; the command then shows what the files say: the lock, stale or held by which process, the settings file and the metastore
- **3**: an engine runs, but its status couldn’t be read: no owner token, or the engine refused or failed the request

To check an engine on another machine, pass `--url` and `--token`.

## Read the status over HTTP

`POST /datanotes/status/` returns the same report as JSON. Only the owner token can call it: a named token gets 403, even with `maintain`. The report never contains a token or a secret. It covers:

- **Engine**: version, process ID, uptime, address, watch mode and folders
- **Database**: the tables, how many keep history, the operations of the last 24 hours and the latest one
- **Git sync**: the last commit and push, the operations waiting, and `blocked` when a conflict stops it
- **Store backup**: in `store_backup`, the cadence, the remote without credentials, the last commit and push, what waits, and the last error; see [Back up the history](/guides/history/back-up/#check-the-backup)
- **Change feed**: whether it runs, or why not
- **Webhooks**: each failing one, with its URL’s host and last error
- **Tokens**: each named token with its permissions and when it was last used
- **Hand edits**: the edits of the last 24 hours that leave rows breaking the tables’ rules
- **Logs**: where the engine writes them

`healthy` is `false` when `problems` lists something.

The engine checks nothing again to answer: it judges hand edits by the checks the change feed ran when it recorded them. A row counts while its latest change is a hand edit that broke a rule. The next change of the row, by hand or through the engine, clears it. To check a whole table, use [`check_table`](/reference/operations/auxiliary/#check_table).

