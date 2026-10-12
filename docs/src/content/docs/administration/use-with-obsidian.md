---
title: Use Datanotes with Obsidian
description: "Run the engine with --vault when an app such as Obsidian opens the whole vault: how paths and wikilinks work, and how to move between a vault and a database folder."
sidebar:
  label: Use with Obsidian
  order: 6
---

Datanotes runs on a database folder by default, with `--database`. Apps such as Obsidian work on a vault instead: a folder of all your notes, where the database is one folder among others. This page shows:

- When to start the engine with `--vault`
- How paths and wikilinks work in a vault
- How to move between a vault and a database folder

## Choose between a database folder and a vault

You have two ways to use Obsidian with Datanotes:

- **Open the database folder in Obsidian**: start the engine with `--database`, and open that same folder as an Obsidian vault. The folder's root is then the vault root, so links resolve as they are. Use it when the database is all you keep in the vault.
- **Run the engine on the vault**: start the engine with `--vault` on the folder Obsidian opens. The database is a subfolder of the vault. Use it when the vault already holds other notes, or other apps that expect a vault.

Start the engine on a vault with `--vault`, or the `DATANOTES_VAULT` variable:

```bash
npx -y datanotes serve --vault your_vault_folder
```

Give `--vault` or `--database`, never both: the engine refuses to start with both.

## Find the database in the vault

The database is the folder of the vault's one `metastore.yaml`. A new database goes to `datanotes/`, at the top of the vault. The folder can have any name and sit anywhere in the vault, also in a subfolder. [One database per vault](/administration/run-the-service/#one-database-per-vault) explains how the engine finds it at each start.

Rows and plain notes live side by side. A plain note links to a row, and a row links to a plain note, with backlinks on both sides. The engine serves every note of the vault, not only the rows: [`read_note`](/reference/operations/queries/#read_note), [`list_folder`](/reference/operations/queries/#list_folder) and [`search_notes`](/reference/operations/queries/#search_notes) reach them all.

## Read paths and wikilinks from the vault root

With `--vault`, every path is relative to the vault. A row of the table `film`, in catalog `main` and schema `public`, has this path:

```text
datanotes/main/public/film/Metropolis.md
```

A note at the vault's root is `intro.md`. Operations take and return paths in this form, and the wikilinks the engine writes start from the vault root too. Obsidian resolves links from the same root, so it follows every link the engine writes.

With `--database`, paths start from the database folder instead: the same row is `main/public/film/Metropolis.md`. When you open that folder in Obsidian, its root is the vault root, so links resolve there too.

## Move between a vault and a database folder

[`configure_database`](/reference/operations/auxiliary/#configure_database) with `root` moves the database within the folder the engine serves. The move rewrites every link in one operation, as for any [move of the database folder](/start/how-it-works/#move-the-vault-or-the-database-folder).

To turn a vault into a database folder, move the database to the vault root with `root: ""`:

```ts
await db.call("configure_database", { root: "" });
```

The catalog folders and `metastore.yaml` then sit at the root, and paths lose their `datanotes/` prefix. From the next start, run the engine with `--database` on that folder. The engine refuses the move when a catalog folder or a `metastore.yaml` already exists at the root.

To move the database back into a subfolder, give the folder's name:

```ts
await db.call("configure_database", { root: "datanotes" });
```

From the next start, run the engine with `--vault` on the same folder.

## Pass the same option to every command

The other commands find the engine by the same folder and option you gave `datanotes serve`:

```bash
npx -y datanotes status --vault your_vault_folder
npx -y datanotes stop --vault your_vault_folder
npx -y datanotes store path --vault your_vault_folder
npx -y datanotes mcp --vault your_vault_folder
```

With a database folder, pass `--database your_database_folder` to each instead.
