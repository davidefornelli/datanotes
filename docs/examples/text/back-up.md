## Find the logs that time travel reads

Time travel, undo and restores read three folders of the engine’s store, `<data home>/<database id>/`:

- **`journal/`**: one line per operation, with the data to undo it; `undo_migration` reads it
- **`transaction_log/`**: the versions of each table with history; `describe_history`, `select_rows` with `version` or `timestamp`, and the restores read them
- **`blobs/`**: the long texts that journal entries point to, stored once

`datanotes store path` shows where the store is. The store isn’t in the vault, so the vault’s [git sync](/administration/git-sync/) never sees it. The store backup commits these folders to a repository of their own and pushes them.

## Turn on the store backup

Git runs as the user who runs the engine, with that user’s credentials and SSH keys.

1. Create an empty private repository, such as `vault-store` on GitHub.
2. Check that git can push to it from this machine, as this user.
3. Stop the engine.
4. Turn the backup on, with the repository’s address.
5. Start the engine.

```bash
npx -y datanotes store backup --vault your_vault_folder \
  --remote git@github.com:you/vault-store.git
```

The command saves the setting, makes the store a git repository and pushes it once. A wrong address or a missing credential shows at once: the command then exits with code 1, and the engine retries later.

The first commit and push can take minutes on a large store, such as 3,400 files and 150 MB. The command prints each step and waits for it. The push may take up to 10 minutes, or `DATANOTES_GIT_NETWORK_TIMEOUT_S` seconds. A step that fails leaves no git lock behind, so you can run the command again.

Run `datanotes store backup --vault your_vault_folder` to see the setting. Add `--off` to turn the backup off: the store’s repository stays as it is.

Keep the repository private. It holds what your agents wrote, and the change feed holds the values they wrote too.

## Push over SSH

Git pushes an `ssh://` or `git@` address with an SSH program. The store's repository uses the one its `core.sshCommand` setting names. Without it, git uses its default SSH, in batch mode.

On Windows, the default is the SSH program bundled with Git for Windows. It doesn't read keys from the Windows OpenSSH agent. If your key lives in that agent, the push fails with `Permission denied (publickey)`. Windows' own OpenSSH reaches the agent.

The backup picks the SSH program in this order:

1. The command you pass with `--ssh-command`. It's saved as the store repository's `core.sshCommand`.
2. The `core.sshCommand` the store's repository already has.
3. The `core.sshCommand` of the vault's own git repository, the one [git sync](/administration/git-sync/) uses. The backup copies it to the store's repository.

```bash
npx -y datanotes store backup --vault your_vault_folder \
  --remote git@github.com:you/vault-store.git \
  --ssh-command C:/Windows/System32/OpenSSH/ssh.exe
```

To check that the program reaches your key, run it as the user who runs the engine:

```bash
C:/Windows/System32/OpenSSH/ssh.exe -T git@github.com
```

## Choose how often the backup commits

The backup looks at the store on a regular schedule, every 60 seconds by default. At each look:

1. If nothing changed in the store, it does nothing.
2. If something changed, it waits until the engine is idle: no operation running, and none for 3 seconds.
3. It commits between two operations, then pushes.

An operation writes several files of the store: a journal line, new table versions, sometimes blobs. A commit in the middle of one would save half of it. So the commit holds the engine's write lock, like a short read lock, for `git add` and `git commit` only. An operation that arrives meanwhile waits for the commit, usually a fraction of a second. The push runs after the lock is released.

When the engine stays busy, the backup tries again at the next look. After 5 busy looks in a row, the next one commits at the first gap between two operations anyway.

A lost disk costs at most the last interval of history: 60 seconds by default. A restore can then miss those seconds, while the vault may already hold the notes they wrote.

Set the interval with `--interval-s`, in seconds, at least 10:

```bash
npx -y datanotes store backup --vault your_vault_folder --interval-s 30
```

A push that fails is retried with a backoff, doubled at each failure up to 30 minutes. It never fails an operation. When the engine stops, it makes a last commit and push, for up to 15 seconds. After a forced stop, such as a killed process, the next start commits and pushes what was left at once. It first removes the git lock files, such as `.git/index.lock`, that a killed git leaves behind. Only one engine at a time uses a store, so no other git can hold them.

Git never prompts, and each git command has a time limit: 10 minutes for a push, 60 seconds for the others. A push that runs out of time counts as a failed push. [Git never waits for a person](/administration/git-sync/#git-never-waits-for-a-person) explains it.

Git packs its files from time to time with `git gc`. On a large store, that takes minutes. So no `git gc` runs while the commit holds the write lock. The backup runs `git gc --auto` after the push instead, when operations no longer wait.

## Set the backup for one run

`datanotes serve` takes the same choices for one run, over the settings:

| Option | Variable | Meaning |
| --- | --- | --- |
| `--store-backup` | `DATANOTES_STORE_BACKUP=1` | Turns the backup on |
| `--no-store-backup` | `DATANOTES_STORE_BACKUP=0` | Turns the backup off |
| `--store-backup-remote your_url` | `DATANOTES_STORE_BACKUP_REMOTE` | The repository to push to; turns the backup on |
| `--store-backup-interval-s 60` | `DATANOTES_STORE_BACKUP_INTERVAL_S` | Seconds between two looks for changes, at least 10 |

The settings `storeBackupEnabled`, `storeBackupRemote` and `storeBackupIntervalSeconds` keep the choice from one run to the next. `datanotes store backup` writes them.

## See what the backup keeps

The engine writes the store’s `.gitignore`. It names the files to keep, and ignores every other file:

| Kept | Left out |
| --- | --- |
| `journal/`, `blobs/` and `transaction_log/` | `settings.json`, with the owner token and the settings |
| `changes/`, the change feed | `webhooks.json`, with the webhooks’ secrets |
| `database_moves.jsonl` | `engine.lock`, `store.json` and `migration.json` |
| `tokens.json`, the named tokens’ hashes | `semantic/` and `logs/` |

`tokens.json` holds a hash of each named token, never the token. A restore keeps every named token working.

The change feed records the tool calls of your agents, with their results. A secret never gets there: a webhook’s `secret` from `create_webhook`, and any value under a key such as `token`, `password` or `api_key`, become `[redacted]`. The agent still gets the secret in its answer. The change feed goes on from its last number, so programs that read it with `since` keep their place.

## Check the backup

`datanotes status` shows the backup on its `backup` line: the cadence, the remote, the last commit and push, and what waits. A failing push makes the status `needs attention`, and the command exits with code 1.

`POST /datanotes/status/` returns the same in `store_backup`:

```json
{
  "store_backup": {
    "enabled": true,
    "interval_s": 60,
    "remote": "git@github.com:you/vault-store.git",
    "last_commit": "3f9c2a1",
    "last_commit_at": "2026-10-10T08:12:00.000Z",
    "last_push_at": "2026-10-10T08:12:01.000Z",
    "pending_operations": 0,
    "pending_commits": 0
  }
}
```

The remote never shows a password or a token from its address.

## Restore the store from its backup

On the new machine, restore the vault first, then its store:

1. Clone the vault’s repository.
2. Restore the store, naming the backup and the vault.
3. Copy the owner token the command prints, once.
4. Start the engine.

```bash
git clone git@github.com:you/vault.git your_vault_folder
npx -y datanotes store restore --vault your_vault_folder \
  --from git@github.com:you/vault-store.git
```

The command reads the database’s id in the vault’s `metastore.yaml`. It clones the backup into `<data home>/<database id>/` and checks that the backup belongs to that database. It then writes new settings, with a new owner token and the backup turned on.

Undo, history and time travel then work as before. Two things don’t come back, and you set them again:

- the owner token, which is new: update the programs and agents that used the old one
- the webhooks, whose secrets the backup leaves out: create them again

These options change what the restore does:

- **`--force`**: restores over a store that already holds files, after renaming it `<store>.before-restore-<time>`
- **`--port`**: the port of the new settings, by default `27150`
- **`--no-backup`**: leaves the backup off in the new settings
- **`--store`**: restores into this folder, for an engine started with `--store`

Run one engine per backup repository. Two engines that push to the same repository refuse each other’s pushes.

## Keep the backup repository small

Git keeps every version of every file, so the repository only grows. `vacuum_table` deletes old history from the store, and the next commit records the deletion, but earlier commits still hold the files.

To start again with a small repository, keep the old one as an archive:

1. Stop the engine.
2. Create a new, empty private repository.
3. Rename the `.git` folder of the store, for example to `.git-old`.
4. Turn the backup on with the new repository’s address.
5. Start the engine.

The new repository starts from the store as it is now. Delete the old repository once you no longer need its history.

## Keep each file under 95 MB

GitHub refuses a push with a file over 100 MB, every time. So before each push, the backup looks for a file over 95 MB in the commits to push. When it finds one, it doesn’t push, and doesn’t try again until the file is gone. `datanotes status` shows the backup as failing, with the file and its size, and the fix in `hint`.

To fix it:

1. Make the file smaller. `vacuum_table` deletes a table’s old history.
2. Start the backup repository again, as [Keep the backup repository small](#keep-the-backup-repository-small) shows. The large file stays in the old commits until you do.
