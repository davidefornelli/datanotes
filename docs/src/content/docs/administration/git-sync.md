---
title: Sync the vault with git
description: "Have the engine commit, pull and push the vault’s git repository, as a backup and to keep copies on other machines in step."
sidebar:
  label: Git Sync
  order: 3
---

Git sync keeps the vault’s own git repository committed and pushed while the engine runs. Use it as a backup, and to keep a copy of the vault on another machine, such as a server, in step with this one. Git only carries the files: undo and history stay in the engine’s journal and transaction log.

## Turn on git sync

The vault must be a git repository whose branch has an upstream: push it once with `git push -u`. Start the engine with `--git-sync`:

```bash
npx -y datanotes serve --database your_database_folder --git-sync
```

Git runs as the user that runs the engine, with that user’s identity and SSH keys. These options turn it on and tune it:

| Option | Variable | Meaning |
| --- | --- | --- |
| `--git-sync` | `DATANOTES_GIT_SYNC=1` | Turns git sync on |
| `--git-interval-min 10` | `DATANOTES_GIT_INTERVAL_MIN` | Minutes between two syncs; at least 1, default 10 |
| `--git-quiet-s 60` | `DATANOTES_GIT_QUIET_S` | Seconds after the engine’s last write before a sync; at least 5, default 60 |
| `--git-no-push` | None | Commits and pulls, but never pushes |

## What a sync does

A sync runs every `--git-interval-min` minutes, and `--git-quiet-s` seconds after the engine’s last write, so a burst of writes becomes one commit:

1. It commits the vault’s changes, with a message that lists the operations applied since the last commit and who made them.
2. It fetches, and when the remote has new commits, pulls them with `git pull --rebase --autostash`.
3. It pushes when the vault is ahead of the remote.

The commit leaves out `.obsidian/` and `.trash/`. The engine’s store, with the journal and the history of this machine, is outside the vault, so git never sees it. When the engine stops, it makes a last commit and push.

The commit also leaves out these engine files, whatever `.gitignore` says:

- **`.datanotes/`**: the store of a Datanotes 2 vault, with the owner token. The engine logs a warning when the vault still holds one. Add `.datanotes/` to `.gitignore`, or move the folder out of the vault. If an earlier commit holds it, run `git rm -r --cached .datanotes`, commit, and change the token.
- **`.datanotes-*.tmp`** and **`.datanotes-rename-*`**: files the engine is still writing or renaming.

Git runs from its folder on `PATH`, never from the vault folder. A `git.exe` inside the vault never runs.

## Git never waits for a person

The engine runs as a service, with nobody to answer a prompt. So git never asks:

- **No password prompt**: a missing credential fails the command at once.
- **No Git Credential Manager window**: the engine sets `GCM_INTERACTIVE=never`.
- **SSH in batch mode**: an unknown host key or a key with a passphrase fails the command. Your own `GIT_SSH_COMMAND` or `core.sshCommand` wins.

Each git command also has a time limit. A fetch, pull or push may take 10 minutes, any other command 60 seconds. Past it, the engine stops git and the processes it started. The sync then fails, `datanotes status` shows why, and the next sync tries again. Set `DATANOTES_GIT_NETWORK_TIMEOUT_S` to change the limit of a fetch, pull or push, in seconds.

Check once, as the user that runs the engine, that `git push` works without a prompt. For SSH, add the host to `known_hosts` and load the key in an SSH agent, or use a key without a passphrase.

## Back up the store too

Undo, table history and time travel read the store, not the vault. To keep them with the vault, turn on the store backup: it pushes the store to a repository of its own. It commits every 60 seconds by default, between two operations, so a restore finds both repositories at nearly the same moment. [Back up the history](/guides/history/back-up/) shows how.

## Resolve a conflict

When a pull conflicts with local changes, the engine aborts the rebase and stops pushing, so nothing is lost. `datanotes status` then reports git sync as `blocked`, with the reason, and exits with code 1. Resolve the conflict in the repository with git, as you would for any repository; the next sync commits and pushes again.

A pull can also succeed and still leave files in conflict. This happens when the engine writes a note while the pull runs: git puts that change back after the pull, and it conflicts. The engine then stops the sync before pushing, and never commits the conflict markers. The status names the files. To resolve them:

1. Edit each file named in the status, and keep the text you want.
2. Run `git add` on each file.
3. Run `git stash drop` when git says your changes are safe in the stash.

The next sync commits and pushes again.

## Keep every copy on the same version

Each copy of the vault that runs an engine reads the notes that git brings in as hand edits: the engine checks them against the tables’ rules and reports what they break on the change feed. Run the same version of Datanotes on every copy, and upgrade them together. The [release notes](/release-notes/) list what each version changes.
