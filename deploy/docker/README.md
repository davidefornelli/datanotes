# Run the Datanotes engine in Docker

You can run the headless engine (`src/node/service.ts`) in a container, on any machine that runs Docker, such as a virtual private server (VPS), a network-attached storage (NAS) device or a Linux server. This page shows how to:

- Start the engine and find its token
- Set up file watching and permissions
- Open network access and connect agents

## Start the engine

Build the engine first, then start the container with Docker Compose:

1. Build the service from the repository root:

   ```bash
   npm run build:service
   ```

2. Start the container on your vault folder:

   ```bash
   DATANOTES_VAULT=your_vault_folder docker compose \
     -f deploy/docker/docker-compose.yml up -d --build
   ```

The container mounts your vault folder at `/vault`, and its entrypoint starts the engine with `--vault /vault`. The database is then a folder inside the vault, `datanotes/` for a new database. A folder that holds `metastore.yaml` at its root works too: the engine then finds the database at the vault root. [Use Datanotes with Obsidian](https://datanotes.dev/administration/use-with-obsidian/) explains both setups. The first start creates the settings file, `/config/settings.json`, in the `datanotes-config` volume, with port 27150 and a random owner token. The [settings reference](https://datanotes.dev/reference/settings/) lists every key you can set there, such as semantic search and logs.

## Keep the engine’s store in a volume

The engine keeps its store outside the vault: the journal, the history of your tables, the named tokens, the change feed and the logs. In the container, the store is `/data/<database id>/`, in the `datanotes-data` volume. The image sets `DATANOTES_DATA_HOME=/data`. Keep that volume: without it, a new container starts with an empty journal and no history.

## Get the owner token

The owner token is in the settings file inside the container. Print it with:

```bash
docker compose -f deploy/docker/docker-compose.yml \
  exec datanotes cat /config/settings.json
```

The owner token gives full access. Keep it for administration, and [create a named token](https://datanotes.dev/guides/security/tokens/#create-a-token) for each agent, program or device.

## Run programs next to the engine

Programs such as a task planner or your own agent run as their own containers or processes. Each one gets its own token from `POST /datanotes/tokens/create/` and reaches the engine over HTTP. [Build on Datanotes](https://datanotes.dev/develop/build-on-datanotes/) explains the ways to build on the engine.

## Choose how the engine sees file changes

The container polls the vault for changes every 3s, because `DATANOTES_WATCH` defaults to `poll`. Bind mounts from Windows and macOS hosts deliver no file events, so polling is the only option there. On a Linux host, set `DATANOTES_WATCH=events` to react to changes as they happen.

Polling a large vault over a bind mount is slow: one scan of 10,000 notes takes seconds. The engine then scans less often, so a change you make on the host shows later. On Windows and macOS, keep a large vault on a Linux volume instead, and set `DATANOTES_WATCH=events`. [Limits](https://datanotes.dev/administration/limits/#keep-a-docker-vault-on-a-linux-volume) shows the compose file and the times we measured.

## Run one engine per vault

Run one engine per database folder. The engine holds a lock file, `engine.lock`, in its store, so it refuses only a second engine with the same store. The container keeps its store in its own volume. An engine on the host has another store, so it starts on the same folder, and the two engines lose each other’s writes.

Never run the engine on the host and the engine in Docker on the same folder. Stop the host engine with `datanotes stop` before you start the container. [Sync the vault between devices](https://datanotes.dev/guides/data-quality/sync-between-devices/) explains the same rule for a synced vault.

## Give the container write access to the vault

The container runs as the user `engine`, and the engine writes notes in the vault. On its first start it also writes the database’s id into `metastore.yaml`. Make the vault folder writable by that user in one of two ways:

- Add a `user:` entry to the compose file with the owner of the folder
- Change the folder’s owner with `chown`

## Reach the engine from other machines

The compose file publishes the port on `127.0.0.1` only. To reach the engine from outside, put a reverse proxy or a tunnel in front of it. The [security page](https://datanotes.dev/guides/security/security-model/) explains what to expose and which tokens to use.

## Connect agents to the engine in Docker

Agents reach the engine through the Model Context Protocol (MCP) server. Run it next to the engine:

```bash
npx -y datanotes mcp serve --url http://127.0.0.1:27150
```

[Connect agents](https://datanotes.dev/start/connect-agents/) explains how to point your agents at it.
