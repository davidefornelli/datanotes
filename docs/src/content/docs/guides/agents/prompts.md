---
title: Prompts for your agent
description: "Copy prompts for everyday notes, schema changes, history and imports, with the tools the agent calls and the same calls from code."
sidebar:
  label: Prompts
  order: 2
---

Once your agent is [connected](/start/connect-agents/), you talk to your vault in plain words. This page gives prompts to copy, grouped by task. They all use one example: a diary of classic films with the tables `film`, `actor`, `genre` and `watch`.

For each prompt you see what happens, the [operations](/reference/operations/) the agent calls, in order, and what you get. Each one ends with the same call from code, for when you’d rather script it.

The tool sequences and answers come from runs against a real engine through `datanotes mcp`, the Model Context Protocol (MCP) server. Your agent may add a read here and there, such as a second `describe_table`, but the writes are the ones shown.

## Call the same operations from code

Every tool of the agent is an operation of the [HTTP API](/develop/http-api/), so a script makes the calls the agent makes. The snippets on this page use one client of [`datanotes/client`](/develop/client/):

```ts
import { DatanotesClient } from "datanotes/client";

const db = new DatanotesClient({
  url: "http://127.0.0.1:27150",
  token: process.env.DATANOTES_TOKEN ?? "",
  actor: { harness: "my-script" },
});
```

`db.call(name, args)` takes the agent’s tool name and arguments, and sends the request the [HTTP API reference](/api/) lists for it. With curl, you send the same JSON to the operation’s route, `POST /datanotes/operations/<operation>/`. The body holds the operation’s arguments, with the same names as the agent’s tool.

## Prompts for everyday notes

These prompts read and write rows of your diary. They need the `watch` table and the `vw_to_watch` view, which the [schema prompts](#schema-prompts) create.

### Log a viewing with where, when and who

```text
I watched Metropolis tonight at 20:30 at the film club downtown, with
Anna. Live organ accompaniment. Five stars. Log it in my film diary.
```

The agent finds the film, adds a `watch` row and marks the film watched, in one `batch`, so both writes succeed or fail together.

- **Tools**: `list_tables`, `describe_table` on `watch`, `select_rows` on `film` for `Metropolis`, then `batch` with `insert_row` and `update_row`
- **You get**: a new note, `main/public/watch/2026-10-09T2030.md`, and `Metropolis` with `status: watched`, `rating: 5` and `watched_on: 2026-10-09`; one `undo_migration` on the batch’s `migration_id` reverts both

From code, the batch is `POST /datanotes/operations/batch/`:

```ts
await db.call("batch", {
  summary: "Log the screening of Metropolis",
  operations: [
    {
      op: "insert_row",
      table: "watch",
      values: {
        film: "[[Metropolis]]",
        occurred_at: "2026-10-09T20:30:00",
        where: "cinema",
        place: "the film club downtown",
        with: "Anna",
      },
      body: "Live organ accompaniment.\n",
    },
    {
      op: "update_row",
      table: "film",
      path: "main/public/film/Metropolis.md",
      set: { status: "watched", rating: 5, watched_on: "2026-10-09" },
    },
  ],
});
```

### Mark a film to watch

```text
Put Battleship Potemkin on my watchlist: 1925, 75 minutes, directed by
Sergei Eisenstein, Soviet montage.
```

The agent matches “watchlist” against the aliases of the `film` table, checks that the film isn’t there yet, and adds it.

- **Tools**: `list_tables`, `select_rows` on `film` for the title, then `insert_row`
- **You get**: `main/public/film/Battleship Potemkin.md`, with `status: to watch` and a link to the `Soviet montage` genre

From code, `POST /datanotes/operations/insert_row/`:

```ts
await db.call("insert_row", {
  table: "film",
  values: {
    title: "Battleship Potemkin",
    year: 1925,
    minutes: 75,
    director: "Sergei Eisenstein",
    genre: "[[Soviet montage]]",
    status: "to watch",
  },
});
```

### Ask what to watch tonight

```text
What should I watch tonight? I have about an hour and a half.
```

The agent finds the view of your watchlist and narrows it to films that fit the evening.

- **Tools**: `list_tables`, which lists `vw_to_watch` under `views`, then `select_rows` on the view with a filter on `minutes`
- **You get**: Battleship Potemkin, 75 minutes; Metropolis, at 153 minutes, waits for a longer evening

From code, `POST /datanotes/operations/select_rows/`:

```ts
const tonight = await db.call("select_rows", {
  table: "vw_to_watch",
  where: { minutes: { lte: 100 } },
});
```

### Find the films you saw with someone

```text
Which films did I see with Anna this year?
```

The agent reads the `watch` table, where `with` holds who came along, and matches the name case-insensitively.

- **Tools**: `list_tables`, `describe_table` on `watch`, then `select_rows` with `icontains` on `with` and `gte` on `occurred_at`
- **You get**: Sherlock Jr. at home in February, His Girl Friday at the cinema in March, Nosferatu at an outdoor screening in June, and Metropolis tonight

From code, `POST /datanotes/operations/select_rows/`:

```ts
await db.call("select_rows", {
  table: "watch",
  where: { with: { icontains: "anna" }, occurred_at: { gte: "2026-01-01" } },
  columns: ["occurred_at", "film", "where"],
  order_by: "occurred_at",
});
```

### Write your review

```text
Add my review of Charade under a "My review" heading: Grant and Hepburn
trade lines across Paris while everyone lies about the money.
```

The agent reads the note’s body first, then writes the review under its own heading and keeps the rest of the note.

- **Tools**: `select_rows` on `film` with `include_body`, then `update_row` with `body_sections`
- **You get**: a `## My review` section at the end of `Charade.md`, below the text the note already had

From code, `POST /datanotes/operations/update_row/`:

```ts
await db.call("update_row", {
  table: "film",
  path: "main/public/film/Charade.md",
  body_sections: {
    "My review":
      "Grant and Hepburn trade lines across Paris while everyone lies " +
      "about the money.",
  },
});
```

## Schema prompts

These prompts change the tables themselves. The agent changes `metastore.yaml` only through schema operations, which check the change against the rows, journal it and make it undoable. To limit which agents may change the schema, give them a [named token](/start/connect-agents/#give-each-agent-its-own-token) without `ddl`.

### Create the watch table

```text
Create a table for each time I watch a film: when, the film, where
(cinema, home or outdoor screening), the place in my words, and who came
along.
```

The agent checks that no table records viewings yet, then creates one named by the date and time of each viewing.

- **Tools**: `list_tables`, `describe_table` on `film` to link to it, then `create_table`
- **You get**: `main.public.watch` in `metastore.yaml`, with `occurred_at` as its time column, so the engine names each note like `2026-10-09T2030.md`; its description and aliases lead an agent to it from words such as “diary”, and each column says what it holds

The engine refuses a table or a column without a description, so the agent writes one for each.

From code, `POST /datanotes/operations/create_table/`:

```ts
await db.call("create_table", {
  name: "watch",
  description: "Each time I watch a film: when, where and with whom",
  time_column: "occurred_at",
  columns: [
    {
      name: "occurred_at",
      type: "datetime",
      required: true,
      description: "When the film started",
    },
    {
      name: "film",
      type: "link",
      ref: "main.public.film",
      required: true,
      description: "The film I watched",
    },
    {
      name: "where",
      type: "enum",
      values: ["cinema", "home", "outdoor screening"],
      required: true,
      description: "The kind of place I watched it in",
    },
    { name: "place", type: "string", description: "Where, in my words" },
    { name: "with", type: "string", description: "Who came along" },
  ],
  aliases: ["viewings", "screenings", "diary"],
});
```

### Add a column

```text
Add a column to my film diary for what the ticket cost.
```

The agent reads the table first, to reuse a column that already means the same, and adds a new one only when none does.

- **Tools**: `describe_table` on `watch`, then `add_column`
- **You get**: a `price` column, a number of 0 or more with two decimals; existing rows stay as they are, because the engine writes a sparse column only on rows that have a value

From code, `POST /datanotes/operations/add_column/`:

```ts
await db.call("add_column", {
  table: "watch",
  column: {
    name: "price",
    type: "number",
    min: 0,
    step: 0.01,
    description: "What the ticket cost",
  },
});
```

### Add the CHECK rated_when_watched

```text
A film I've watched must have a rating. Make that a rule of the film table.
```

The agent writes the rule as a filter every row must pass: a film is either not watched, or has a rating.

- **Tools**: `describe_table` on `film`, then `add_constraint`
- **You get**: the CHECK `rated_when_watched`; the engine refuses it while a row breaks it, listing the rows, and from then on refuses any write that breaks it

Once the rule exists, the engine refuses to mark Battleship Potemkin as watched without a rating, and writes nothing:

```text
update_row refused — nothing was written:
invalid main/public/film/Battleship Potemkin.md: rated_when_watched violates CHECK rated_when_watched: {"or":[{"status":{"ne":"watched"}},{"rating":{"exists":true}}]}
```

The agent then asks you for a rating. From code, the CHECK is `POST /datanotes/operations/add_constraint/`:

```bash
curl -s http://127.0.0.1:27150/datanotes/operations/add_constraint/ \
  -H "Authorization: Bearer your_owner_token" \
  -H "Content-Type: application/json" \
  -d '{"table": "film",
       "name": "rated_when_watched",
       "check": {"or": [{"status": {"ne": "watched"}},
                        {"rating": {"exists": true}}]}}'
```

### Make a view of the films to watch

```text
Make a view of the films I still have to watch, shortest first.
```

The agent stores the query as a view, with a description and aliases so that later questions such as “what’s on my watchlist?” find it.

- **Tools**: `list_tables`, to reuse a view that exists, then `create_view`
- **You get**: `vw_to_watch` in `metastore.yaml`, which `list_tables` lists under `views` and `select_rows` reads like a table

From code, `POST /datanotes/operations/create_view/`:

```ts
await db.call("create_view", {
  name: "vw_to_watch",
  query: {
    table: "film",
    where: { status: "to watch" },
    columns: ["title", "year", "minutes", "director"],
    order_by: "minutes",
  },
  description: "Films on my watchlist, shortest first",
  aliases: ["watchlist", "what to watch"],
});
```

## Safety and history prompts

These prompts show what an agent changed and take it back. Every write is in the journal, so `undo_migration` works on any table. Reading a table as it was and restoring the whole database need the tables’ history. A database the engine creates has it on. A database whose `metastore.yaml` lacks the setting, such as one from a version before 3.0.0, has it off. Turn it on once:

```text
Turn history on for every table.
```

The agent calls `configure_database` with `history: true`. The journal doesn’t record database settings, so an agent changes them only when you ask. From code, it’s `POST /datanotes/operations/configure_database/` with `{"history": true}`.

### Ask what the agent changed today

```text
What did you change in my vault today?
```

The agent reads the journal, where every operation names the agent that made it.

- **Tools**: `list_migrations` with `since`, or `describe_history` without a table for the commits of every table with their full actor
- **You get**: one line per operation, each with `by: "claude-code"`, such as `batch` “Log the screening of Metropolis” or `add_constraint` on `film`; your own writes from an editor or a script name their own source

From code, `POST /datanotes/operations/list_migrations/`:

```ts
const today = await db.call("list_migrations", { since: "2026-10-09" });
```

### Undo the agent’s last change

```text
Undo your last change.
```

The agent finds its newest operation in the journal and reverts it.

- **Tools**: `list_migrations`, then `undo_migration` with its `migration_id`
- **You get**: the notes as they were before that operation, and the undo’s own `migration_id`, since the journal records the undo too; if you edited one of the notes since, the engine refuses and lists the conflicts instead of overwriting your edit

From code, `POST /datanotes/operations/undo_migration/`:

```ts
await db.call("undo_migration", {
  migration_id: "20261009T215306-batch-log-the-screening-of-metropoli",
});
```

### Put everything back as it was before the agent started

```text
Put everything back as it was before you started this evening. Show me
what would change first.
```

The agent finds its first operation of the session, previews the restore, and runs it once you agree.

- **Tools**: `describe_history` without a table, then `restore_database` with `before_migration` and `dry_run: true`, then `restore_database` again without `dry_run`
- **You get**: every table with history back to that moment, in one operation that `undo_migration` can revert; in the run behind this page, the restore removed Battleship Potemkin and tonight’s `watch` row, and gave Metropolis and Charade their old content back

The dry run lists what changes in each table before the engine writes anything. Here is its answer, trimmed:

```json
{
  "ok": true,
  "dry_run": true,
  "planned_deletes": [
    "main/public/film/Battleship Potemkin.md",
    "main/public/watch/2026-10-09T2030.md"
  ],
  "planned_texts": [
    "main/public/film/Metropolis.md",
    "main/public/film/Charade.md"
  ],
  "unchanged": ["main.public.actor", "main.public.genre"],
  "skipped": []
}
```

The restore doesn’t rewind views or database settings, and lists a table without history in `skipped`. From code, `POST /datanotes/operations/restore_database/`:

```ts
await db.call("restore_database", {
  before_migration: "20261009T215329-insert_row-insert-into-film",
  dry_run: true,
});
```

### Read a note as it was last week

```text
Show me Nosferatu as it was last week.
```

The agent reads the `film` table at a past time and picks the row.

- **Tools**: `select_rows` on `film` with `timestamp`, and `describe_history` on `film` when you ask what changed since
- **You get**: the row with the values it had then, and the table `version` the engine read; if the table didn’t exist yet at that time, the engine answers `main.public.film did not exist at 2026-10-02T09:00:00Z`

From code, `POST /datanotes/operations/select_rows/`:

```ts
await db.call("select_rows", {
  table: "film",
  where: { title: "Nosferatu" },
  timestamp: "2026-10-02T09:00:00Z",
});
```

## Import prompts

This prompt turns notes you already have into rows, without moving them.

### Turn a folder of notes into a table

```text
Turn my Films/ folder into a table. Show me the columns you propose
before you create anything.
```

The agent reads the notes’ front matter, proposes a table, and waits for your review. Review it: on five notes, `infer_table` marked `director` and `minutes` as `unique`, because no two notes shared a value. The engine would then refuse a sixth film by the same director, so ask the agent to drop `unique` there.

The notes can’t say what each key means, so the proposal leaves every `description` `null`. The agent writes them and asks you when a key isn’t clear. `create_table` refuses a table or a column without one.

- **Tools**: `list_folder` on `Films`, `infer_table` with `folder: "Films"`, then, after your review, `create_table` with the reviewed and described proposal, `adopt_rows` with `dry_run: true`, `adopt_rows`, and `check_table`
- **You get**: a `film` table whose rows are your notes, moved to the table’s folder with the links to them rewritten; each note gets `table` and an `id`, and keeps its body; `check_table` reports no violations

`infer_table` returns `proposal`, the arguments of `create_table`, and `adopt`, the arguments of `adopt_rows`. From code, the inference is `POST /datanotes/operations/infer_table/`:

```ts
const inferred = await db.call("infer_table", {
  folder: "Films",
  name: "film",
});
const { proposal, adopt } = inferred.value as {
  proposal: { columns: { name: string }[] };
  adopt: Record<string, unknown>;
};
```

After you review `proposal`, create the table. The notes keep the title in their file name, so add a `title` column with `identity: "filename"` and name the rows with `filename: "{title}"`. Write a description for every column, or `create_table` refuses the table:

```ts
const meaning: Record<string, string> = {
  year: "Year the film first came out",
  minutes: "Running time in minutes",
  director: "Who directed the film",
  // … one for each column of the proposal
};
const created = await db.call("create_table", {
  ...proposal,
  description: "Classic films I watched or want to watch",
  filename: "{title}",
  columns: [
    {
      name: "title",
      type: "string",
      identity: "filename",
      description: "The film's title, which is also its note's name",
    },
    ...proposal.columns.map((c) => ({
      ...c,
      unique: false,
      description: meaning[c.name],
    })),
  ],
});
if (!created.ok) throw new Error(String(created.value));
```

Then adopt the notes with `POST /datanotes/operations/adopt_rows/`. `relocate` moves them to the table’s folder and rewrites the links to them:

```ts
const { paths, rename } = adopt as {
  paths: string[];
  rename: Record<string, string>;
};
const adopted = await db.call("adopt_rows", {
  table: "film",
  paths,
  rename,
  relocate: true,
});
if (!adopted.ok) throw new Error(String(adopted.value));
```

## Learn more about agents and operations

These pages go deeper into what the prompts use:

- [How agents work with your vault](/guides/agents/how-agents-use-datanotes/): what the agent reads first, how it finds tables and what the journal records
- [Guides](/guides/database-objects/tables/): every operation in use, with the engine’s real answers
- [Operations](/reference/operations/): every tool and its arguments
