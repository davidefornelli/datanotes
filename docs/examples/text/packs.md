## How a pack reads

A pack is a Markdown note in the table’s folder, named `<table> <key>.md`, such as `reading 2025-03.md`. Its front matter names the table and the period. Each row is a `##` section:

```markdown
---
pack: main.public.reading
key: 2025-03
description: "Rows of main.public.reading for 2025-03. ..."
---

## 2025-03-02T2100
id:: 019a3c1e-7f3b-7c2a-9d41-6c0f1e2a3b4c
started_at:: 2025-03-02T21:00
book:: Moby-Dick
minutes:: 40

## 2025-03-16T2200
id:: 019a3c1e-8a10-7d55-b2e3-1f4a5b6c7d8e
started_at:: 2025-03-16T22:00
book:: Persuasion
minutes:: 30

Chapter 4, the walk to Winthrop.
```

- The heading is the row’s file name.
- A field is `key:: value`, its value YAML on one line, as in front matter.
- The row’s own text starts after the first empty line, with headings from `###` down.

The engine lists each row at the path it would have as a note of its own, such as `datanotes/main/public/reading/2025/03/2025-03-02T2100.md`. That path doesn’t exist on disk, but every operation finds the row there.

## Know which rows stay notes of their own

`pack_rows` leaves a row as a note of its own when:

- its period isn’t over yet, or ended less than `pack_after_days` days ago
- it changed in the last 24 hours
- its text has a `#` or `##` heading, which would end its section
- it isn’t at the path its values give, such as a name with a `-2` suffix
- its note isn’t in the form the engine writes, such as another YAML style or a comment

A dry run lists these rows in `excluded`, with the reason. A row the engine can’t pack now waits for the next run.

## Link to a packed row

A link to a packed row names the pack and the row’s heading: `[[reading 2025-03#2025-03-02T2100]]`. Obsidian follows it to the section. `pack_rows` rewrites the links other notes have to the rows in this form, and `unpack_rows` writes them back.

A link by the row’s name, such as `[[2025-03-02T2100]]`, still leads to the row for the engine. A link column takes both forms.

Links between rows of the same pack stay as they are written.

## Know who reads the files

Every reader that goes through the engine sees the rows: the HTTP API, the MCP tools, `datanotes/client` and the change feed. Programs that read the vault’s files directly see the packs instead:

- Obsidian, which shows each pack as one note
- scripts and services that count or open the files of a table folder, with `find`, `grep` or fixed paths
- agents with a shell, and git hosts such as GitHub

To count the rows of a table, call `select_rows`. On disk, count the headings of its packs with `grep -c '^## '`.

Before you set `pack` on a table, check what reads its files without the engine.

## Packs need the engine service

The engine service, `datanotes serve`, keeps the packs. Obsidian’s plugin doesn’t, so it refuses the `pack` option and `pack_rows`.

The service also packs on its own. Once a day, after 10 minutes without writes, it runs `pack_rows` on every table with a `pack` option. The setting `autoPack: false` turns this off.

## Merge packs changed on two devices

Two devices that add or change different rows of one pack shouldn’t get a git conflict. The engine has a git merge driver that merges a pack row by row, by `id`:

1. A row changed on one side only takes that side.
2. A row added on one side is added.
3. A row removed on one side, and unchanged on the other, is removed.
4. A row changed differently on both sides is a conflict in its section only.

[Git sync](/administration/git-sync/) registers the driver in the vault’s repository. To register it by hand, see that page.
