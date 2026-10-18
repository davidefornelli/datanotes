import type { Chapter } from "./types";

const chapter: Chapter = {
  slug: "tables",
  title: "Tables and rows",
  examples: [
    {
      title: "Create a table with typed columns",
      say: "`create_table` takes the table’s columns and their types. The table and each column need a `description`: what a row records, and what each column holds. An agent matches your words against the descriptions and the `aliases` to find the table. `filename` names each row’s note after one of its columns.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "film",
            description: "Classic films I watched or want to watch",
            columns: [
              { name: "title", type: "string", required: true, unique: true, description: "The film's title, as on its poster" },
              { name: "year", type: "integer", description: "Year the film first came out" },
              { name: "minutes", type: "integer", min: 1, description: "Running time in minutes" },
              { name: "status", type: "enum", values: ["to watch", "watched"], ordered: true, default: "to watch", description: "Where the film is on my list" },
              { name: "rating", type: "integer", min: 1, max: 5, description: "My rating, from 1 (poor) to 5 (a masterpiece)" },
              { name: "watched_on", type: "date", description: "The day I last watched it" },
            ],
            filename: "{title}", aliases: ["films", "movies", "watchlist"],
          },
          show: (v) => ({ ok: true, migration_id: v.migration_id, summary: v.summary }),
          showFile: "datanotes/metastore.yaml",
        },
      ],
      after: [
        "The engine writes the definition in YAML Ain’t Markup Language (YAML), and you can read the file like any other note. Change it only through the operations (`add_column`, `alter_table`, …): they validate the change against the rows, journal it and make it undoable. A hand edit does none of that.",
        "",
        "The file uses the operations’ words: a column is `required`, a table or a column has a `description`, and `fields` keeps the fixed front matter keys. The table’s `partition`, `filename`, `archive` and `exclude` go under `options`.",
        "",
        "The file also holds two things the engine adds on its own. One is the `id` column every table has, with its description. The other is `archive`, the folder for archived rows. `archive` is `_archive` unless `configure_database` sets another folder.",
      ].join("\n"),
    },
    {
      title: "Describe every table and column",
      say: "Agents and people understand the schema through its descriptions. The engine refuses a table or a column without one. The refusal lists every missing description at once, with the shape that fixes it. Write each one for a reader who never saw your notes.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "screening",
            description: "Films shown in my town",
            columns: [
              { name: "film", type: "string", required: true },
              { name: "venue", type: "string" },
              { name: "starts_at", type: "datetime", description: "When the screening begins" },
            ],
            filename: "{starts_at:YYYY-MM-DD} {film}",
          },
          refused: true,
        },
        {
          say: "A description can change, but it never goes. `alter_column` and `alter_table` refuse `null` or an empty text:",
          op: "alter_column",
          args: { table: "film", column: "year", changes: { description: null } },
          refused: true,
        },
      ],
      after: [
        "You don’t write every description yourself. The engine writes those of the columns it sets itself: `id`, and `identity` columns of kind `uuid` or `created`.",
        "",
        "A table created before descriptions were required may lack some, and it stays valid. `describe_table` and `describe_database` name what it lacks in `missing_descriptions`, such as `{\"table\": false, \"columns\": [\"year\"]}`. Fill each one with `alter_table` or `alter_column`. An `infer_table` proposal leaves its descriptions `null` for you to write, as [Infer a table from notes](/guides/read-and-write/import-notes/#infer-a-table-from-notes) shows.",
      ].join("\n"),
    },
    {
      title: "Find the table that matches a request",
      say: "`list_tables` returns every table with its description and aliases. An agent matches your words against them, so “add this to my watchlist” leads to the `film` table.",
      steps: [{ op: "list_tables", check: (v) => v.tables.length !== 1 && "one table expected" }],
    },
    {
      title: "Describe a table before writing to it",
      say: "`describe_table` lists the columns with their types and constraints, and the table’s row count. Read it before you write: it tells you which values the table accepts.",
      steps: [{ op: "describe_table", args: { table: "film" } }],
    },
    {
      title: "Insert a row",
      say: "`insert_row` writes a new note. The engine fills in the default (`status`) and an `id`, and names the note from `filename`. `body` sets the note’s text.",
      steps: [
        {
          op: "insert_row",
          args: { table: "film", values: { title: "Metropolis", year: 1927, minutes: 153 }, body: "Next on my list. Two and a half hours of silent film need a quiet evening.\n" },
          save: "metropolis",
          check: (v) => !v.planned_creates?.length && "a created path expected",
          showFile: (ctx) => ctx.saved.metropolis.planned_creates[0],
        },
      ],
    },
    {
      title: "Add fixed front matter keys, a note template and tags",
      say: [
        "`create_table` takes four more arguments:",
        "",
        "- **`fields`**: front matter keys every new row gets with a fixed value and no checks, such as `cssclasses`, which styles the notes in Obsidian",
        "- **`row_template`**: the text of every new row’s note, with `{column}` placeholders",
        "- **`instructions`**: how an agent fills a row, such as which columns come first and what to ask you",
        "- **`tags`**: key/value labels for the table, which `list_tables` and `describe_table` return",
      ].join("\n"),
      steps: [
        {
          op: "create_table",
          args: {
            name: "watch",
            description: "Each time I watch a film",
            columns: [
              { name: "film", type: "string", required: true, description: "The film I watched" },
              { name: "where", type: "enum", values: ["cinema", "home", "outdoor screening"], required: true, description: "The kind of place I watched it in" },
              { name: "place", type: "string", description: "The cinema, park or room, in my words" },
              { name: "occurred_at", type: "datetime", default: "{now}", description: "When the film started" },
              { name: "price", type: "number", min: 0, step: 0.01, description: "What the ticket cost, if anything" },
            ],
            filename: "{occurred_at:YYYY-MM-DD} {film}",
            fields: { cssclasses: ["watch"] },
            row_template: "Watched {film} ({where}).\n\n## Thoughts\n",
            instructions: "1. Ask me which film I watched and where.\n2. Fill `occurred_at` only when I give a time: it defaults to now.\n",
            tags: { area: "films" },
          },
          quiet: true,
        },
        { op: "insert_row", args: { table: "watch", values: { film: "Nosferatu", where: "outdoor screening", place: "the park by the river" } }, save: "watch", showFile: (ctx) => ctx.saved.watch.planned_creates[0] },
      ],
    },
    {
      title: "Tell agents how to fill a row with `instructions`",
      say: "`describe_table` returns a table’s `instructions`, so an agent reads them before it writes a row. `alter_table` changes them, and `instructions: \"\"` removes them.",
      steps: [
        { op: "describe_table", args: { table: "watch" }, show: (v) => ({ qualified: v.qualified, instructions: v.instructions }), check: (v) => typeof v.instructions !== "string" && "instructions expected" },
        { op: "alter_table", args: { table: "watch", instructions: "1. Ask me which film I watched, where and with whom.\n2. Fill `occurred_at` only when I give a time: it defaults to now.\n" } },
      ],
    },
    {
      title: "Set a table’s options when you create it",
      say: [
        "`create_table` also takes the options that `alter_table` changes later. Two of them:",
        "",
        "- **`exclude`**: folders whose notes never become rows, such as an editor’s templates",
        "- **`history`**: `true` keeps every version of the table, whatever the database’s setting",
      ].join("\n"),
      steps: [
        {
          op: "create_table",
          args: {
            name: "review",
            description: "What I wrote about a film after watching it",
            columns: [
              { name: "film", type: "string", required: true, unique: true, description: "The film the review is about" },
              { name: "verdict", type: "string", description: "The review in one sentence" },
            ],
            filename: "{film}",
            exclude: ["datanotes/main/public/review/Templates"],
            history: true,
          },
          show: (v) => ({ ok: v.ok, summary: v.summary }),
        },
      ],
      after: "[Keep a folder’s notes out of the table](/guides/read-and-write/import-notes/#keep-a-folders-notes-out-of-the-table-with-exclude) and [Table history and time travel](/guides/history/table-history/) show both at work.",
    },
    {
      title: "See how the engine refuses bad values",
      say: "The engine checks every write against the columns. If one value is wrong, it writes nothing, and the answer names the column and the reason. For an enum, the answer also lists the allowed values.",
      steps: [
        {
          op: "insert_row",
          args: { table: "film", values: { title: "Battleship Potemkin", minutes: 0, status: "finished" } },
          refused: true,
        },
        {
          say: "A unique column refuses a second row with the same value:",
          op: "insert_row",
          args: { table: "film", values: { title: "Metropolis" } },
          refused: true,
        },
      ],
    },
    {
      title: "Try a write first with `dry_run`",
      say: "Every write accepts `dry_run: true`. The engine checks the write and reports what it would do, but writes nothing.",
      steps: [
        {
          op: "insert_row",
          args: { table: "film", values: { title: "Battleship Potemkin", year: 1925, minutes: 75 }, dry_run: true },
          check: (v) => v.dry_run !== true && "dry_run expected",
        },
        { op: "select_rows", args: { table: "film", columns: ["title"] }, say: "The table still has one film:", check: (v) => v.total !== 1 && "one row expected" },
      ],
    },
    {
      title: "Describe the whole database",
      say: "`describe_database` shows the configuration and every catalog, schema and table, with row counts. A table you create as plain `film` goes to the default catalog `main` and schema `public`.",
      steps: [{ op: "describe_database" }],
    },
    {
      title: "Drop a table and archive its rows",
      say: [
        "`drop_table` refuses a table that still has rows. With `mode: \"archive\"`, it removes the definition and moves the rows to the table’s archive folder. The engine deletes nothing, and you can undo the operation.",
        "",
        "You choose that folder with `archive` when you create the table. It’s a vault path, as here, or a folder name inside the table’s folder (`_archive` by default).",
      ].join("\n"),
      steps: [
        {
          op: "create_table",
          args: {
            name: "scratch",
            description: "Throwaway notes for trying things out",
            columns: [{ name: "note", type: "string", description: "The note's text" }],
            filename: "{note}", archive: "Archive/scratch",
          },
          quiet: true,
        },
        { op: "insert_row", args: { table: "scratch", values: { note: "temporary" } }, quiet: true },
        { op: "drop_table", args: { table: "scratch" }, refused: true },
        { op: "drop_table", args: { table: "scratch", mode: "archive" } },
        { op: "list_folder", args: { folder: "Archive/scratch" } },
      ],
    },
    {
      title: "See the tables in `metastore.yaml`",
      say: "The engine wrote this file in its own words. It holds `film`, `watch` and `review`, and `scratch` is gone because you dropped it.",
      steps: [{ showFile: "datanotes/metastore.yaml" }],
    },
  ],
};

export default chapter;
