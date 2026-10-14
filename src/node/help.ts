import { MCP_OPTIONS, MCP_USAGE } from "../mcp/help";

/** The `datanotes --help` text (also the CLI reference of the docs site). */
export function help(version: string): string {
  return `datanotes ${version}: Markdown notes as database tables, for you and your agents.

Usage:
  datanotes serve --database <folder> [options]   run the engine and its HTTP API (/datanotes/*)
  datanotes status --database <folder> [--json]   the running engine's health
  datanotes stop --database <folder> [--timeout-s <s>] stop the running engine gracefully
  datanotes store path --database <folder>        where the engine keeps the database's store
  datanotes store new-id --database <folder>      a new database id (a copied folder gets its own store)
  datanotes store backup --database <folder>      show or set the store's git backup (--remote <url>, --off)
  datanotes store restore --from <url> --database <folder>   restore the store from its git backup
  datanotes store convert-log --to <files|segments> --database <folder>   rewrite the transaction log in that format
  Every command takes --vault <folder> instead of --database for a vault holding the database.
${MCP_USAGE}
  datanotes --version | --help
  dnotes is a short name for datanotes: every command works under both names.

Options of serve:
  --database <folder>         the database folder (or DATANOTES_DATABASE): metastore.yaml at its
                              root (created there for a new database); paths start with the catalog
  --vault <folder>            or a vault holding the database (or DATANOTES_VAULT), for apps such as
                              Obsidian: the database is the folder of the vault's one metastore.yaml
                              (a new database: datanotes/); paths start at the vault's root
  --store <folder>            the engine's store (or DATANOTES_STORE; default <data home>/<database id>)
  --settings <file>           settings file (or DATANOTES_SETTINGS; default settings.json in the store)
  --host <address>            listen address (or DATANOTES_HOST; default 127.0.0.1)
  --port <port>               HTTP port for this run (or DATANOTES_PORT; default: the setting
                              httpServerPort, 27150); 0 for any free port, printed at start
  --watch events|poll         how file changes are seen (or DATANOTES_WATCH; default events)
  --poll-ms <ms>              poll interval (or DATANOTES_POLL_MS; default 3000)
  --embedding-key-file <file> file with the API key of the embedding provider (or DATANOTES_EMBEDDING_KEY_FILE;
                              DATANOTES_EMBEDDING_KEY gives the key itself)
  --git-sync                  commit, pull and push the vault (or DATANOTES_GIT_SYNC=1; --git-no-push)
  --git-interval-min <min>    minutes between two syncs (or DATANOTES_GIT_INTERVAL_MIN; default 10)
  --git-quiet-s <s>           a sync also <s> seconds after the last write (or DATANOTES_GIT_QUIET_S; default 60)
                              DATANOTES_GIT_NETWORK_TIMEOUT_S: the time limit of a pull or push (default 600)
  --store-backup              back up the store to git for this run (or DATANOTES_STORE_BACKUP=1; the
                              setting storeBackupEnabled keeps it on; --no-store-backup or =0 turns it off)
  --store-backup-remote <url> the store backup's git remote; turns the backup on
                              (or DATANOTES_STORE_BACKUP_REMOTE; default: the setting storeBackupRemote)
  --store-backup-interval-s <s> every <s> seconds (at least 10), when the store changed: a commit
                              between two operations, then a push (or DATANOTES_STORE_BACKUP_INTERVAL_S;
                              default: the setting storeBackupIntervalSeconds, 60)
  --log <file>                append console output to a file
                              DATANOTES_INDEX_CHECK=1: check the engine's indexes against the vault
                              after every operation, and log any difference as an error (slow: debugging)

Options of status (the engine is found through the lock in its store, called with the owner's token):
  --database <folder>         the database folder (or DATANOTES_DATABASE; --vault <folder> for a vault)
  --store <folder>            the engine's store, when serve was given one (or DATANOTES_STORE)
  --settings <file>           settings file with the owner's token (or DATANOTES_SETTINGS;
                              default settings.json in the store)
  --url <url> --token <token> call this engine instead, e.g. on another machine (or DATANOTES_URL, DATANOTES_TOKEN)
  --json                      the report as JSON
  Exit codes: 0 healthy; 1 needs attention (git sync blocked, store backup failing, a webhook failing, change feed not
  running, hand edits breaking the tables' rules in the last 24 h); 2 no engine running on the folder (or
  not reachable); 3 an engine runs but its status could not be read (no owner token, token refused, an error).

Options of stop (the engine finishes the requests under way, makes its last git sync and store backup
commit and push, releases its lock and exits):
  --database <folder>         the database folder (or DATANOTES_DATABASE; --vault <folder> for a vault)
  --store <folder>            the engine's store, when serve was given one (or DATANOTES_STORE)
  --settings <file>           settings file with the owner's token (or DATANOTES_SETTINGS;
                              default settings.json in the store)
  --url <url> --token <token> stop this engine instead (or DATANOTES_URL, DATANOTES_TOKEN)
  --timeout-s <seconds>       how long to wait for the engine to exit (default 60)
  --json                      the report as JSON
  Exit codes: 0 stopped; 1 not stopped (not answering, or still running after the timeout: stop it by
  force); 2 no engine running on the folder; 3 the stop could not be asked (another machine, still
  starting, token refused).

Options of store:
  --database <folder>         the database folder (or DATANOTES_DATABASE; --vault <folder> for a vault)
  --json                      store path, store backup, store convert-log: the answer as JSON
  --remote <url>              store backup: turn it on, pushing to this git repository (a first push now)
  --ssh-command <cmd>         store backup, with --remote: the store repository's core.sshCommand
                              (default: the vault repository's), e.g. C:/Windows/System32/OpenSSH/ssh.exe
  --interval-s <seconds>      store backup: every <seconds> (at least 10, default 60), when the
                              store changed: a commit between two operations, then a push
  --off                       store backup: turn it off (the store's repository stays)
  --from <url>                store restore: the git repository of the store backup
  --port <port>               store restore: the HTTP port in the new settings (default 27150)
  --force                     store restore: restore over a store that exists (kept aside, renamed)
  --no-backup                 store restore: leave the store backup off in the new settings
  --to <files|segments>       store convert-log: segments (a few large files) or files (one per
                              version, what Datanotes 3.0 reads); sets transactionLogFormat
  new-id, backup, restore and convert-log run only while no engine runs on the database, and
  hold its store while they run: an engine started meanwhile refuses to start.
  The data home holds one store per database: %LOCALAPPDATA%\\Datanotes (Windows),
  ~/Library/Application Support/Datanotes (macOS), $XDG_DATA_HOME/datanotes or
  ~/.local/share/datanotes (Linux); DATANOTES_DATA_HOME moves it.

${MCP_OPTIONS}

Agents connect through the MCP server: npx -y datanotes mcp (https://datanotes.dev/start/connect-agents/).
Docs: https://datanotes.dev`;
}
