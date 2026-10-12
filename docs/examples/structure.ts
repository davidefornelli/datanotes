import type { Chapter } from "./types";

const chapter: Chapter = {
  slug: "structure",
  title: "Organizing the database",
  examples: [
    {
      title: "Place tables in catalogs and schemas",
      say: "`catalog` and `schema` place a table, and default to `main` and `public`. The full name, like `diary.classics.film`, works wherever an operation takes a table. A shorter name works too when only one table matches it.",
      steps: [
        {
          op: "create_table",
          args: {
            catalog: "diary",
            schema: "classics",
            name: "film",
            columns: [
              { name: "title", type: "string", required: true, unique: true, description: "The film's title, as on its poster" },
              { name: "year", type: "integer", description: "Year the film first came out" },
              { name: "minutes", type: "integer", min: 1, description: "Running time in minutes" },
              { name: "status", type: "enum", values: ["to watch", "watched"], ordered: true, description: "Where the film is on my list" },
              { name: "rating", type: "integer", min: 1, max: 5, description: "My rating, from 1 (poor) to 5 (a masterpiece)" },
            ],
            filename: "{title}", description: "One note per film", aliases: ["films I watched"],
          },
        },
        { op: "insert_row", args: { table: "classics.film", values: { title: "Nosferatu", year: 1922, minutes: 94, status: "watched", rating: 5 } } },
      ],
    },
    {
      title: "Describe tables, catalogs and schemas",
      say: "`alter_table` changes how agents find a table, through its `description` and `aliases`. Tags are key/value labels on a table: you set them with `tags` in `create_table` or `alter_table`, and they merge into the tags the table has. `comment_on` says what a catalog, or one of its schemas, holds.\n\n`metastore.yaml` keeps all of it, and you change it only through operations like these, never by hand.",
      steps: [
        { op: "alter_table", args: { table: "film", description: "One note per classic film: what I watched and what I thought", aliases: ["films I watched", "film diary"] }, quiet: true },
        { op: "alter_table", args: { table: "film", tags: { domain: "films", review: "weekly" } } },
        { op: "comment_on", args: { catalog: "diary", description: "My diaries: films, for now" } },
        { op: "comment_on", args: { catalog: "diary", schema: "classics", description: "Public-domain classic films and their actors" }, showFile: "datanotes/metastore.yaml" },
        {
          say: "`describe_database` shows the descriptions and the tags. `list_tables` and `describe_table` show the tags too. `system.information_schema` has the descriptions in the `comment` of `catalogs` and `schemata`, as databases name it, and the tags in `tables`:",
          op: "describe_database",
          show: (v) => v.catalogs.map((c: any) => ({ catalog: c.catalog, description: c.description, schemas: c.schemas.map((s: any) => ({ schema: s.schema, description: s.description, tables: s.tables.map((t: any) => ({ name: t.name, tags: t.tags })) })) })),
        },
        { say: "A `null` value removes a tag, and `comment_on` with `description: \"\"` removes a description:", op: "alter_table", args: { table: "film", tags: { review: null } } },
        { op: "comment_on", args: { catalog: "diary", schema: "classics", description: "" } },
        { say: "`clear_tags: true` removes every tag first, so with `tags` the table keeps exactly the tags you pass:", op: "alter_table", args: { table: "film", clear_tags: true, tags: { area: "films" } } },
        { op: "describe_table", args: { table: "film" }, show: (v) => ({ qualified: v.qualified, description: v.description, aliases: v.aliases, tags: v.tags }) },
      ],
    },
    {
      title: "Share columns between tables with bases",
      say: "A base is a named set of columns that tables inherit, like a parent class. Every table that extends `entry` gets `added_on` and `note` with the same meaning. `select_rows` on `base:entry` reads all those tables at once, here films and actors.",
      steps: [
        {
          op: "define_base",
          args: {
            name: "entry",
            description: "A note of the film diary",
            columns: [
              { name: "added_on", type: "date", description: "When I added it to the diary" },
              { name: "note", type: "string", description: "Free text" },
            ],
          },
        },
        { op: "set_table_bases", args: { table: "film", bases: ["entry"] } },
        {
          op: "create_table",
          args: {
            catalog: "diary",
            schema: "classics",
            name: "actors",
            description: "Actors of the films in the diary",
            columns: [{ name: "name", type: "string", required: true, description: "The actor's name, as credited" }],
            filename: "{name}",
          },
          quiet: true,
        },
        { op: "set_table_bases", args: { table: "actors", bases: ["entry"] }, quiet: true },
        { op: "insert_row", args: { table: "actors", values: { name: "Max Schreck", added_on: "2026-10-05", note: "The face of Nosferatu" } }, quiet: true },
        { op: "update_row", args: { table: "film", path: "datanotes/diary/classics/film/Nosferatu.md", set: { added_on: "2026-10-05" } }, quiet: true },
        { op: "select_rows", args: { table: "base:entry", order_by: "path" } },
      ],
    },
    {
      title: "Change a base and every table that extends it",
      say: "Replacing a base changes every table that extends it, in one operation. `rename_columns` renames a column on their rows. `define_base` refuses to drop a column unless `drop_columns` names it, and then the engine removes the column’s values from the rows too.",
      steps: [
        {
          op: "define_base",
          args: {
            name: "entry",
            columns: [
              { name: "added_on", type: "date", description: "When I added it to the diary" },
              { name: "comment", type: "string", description: "Free text" },
            ],
            rename_columns: { note: "comment" },
          },
        },
        { op: "select_rows", args: { table: "actors", columns: ["name", "comment"] } },
        { say: "`define_base` refuses a base without `comment` until the call says the values may go:", op: "define_base", args: { name: "entry", columns: [{ name: "added_on", type: "date", description: "When I added it to the diary" }] }, refused: true },
        { op: "define_base", args: { name: "entry", columns: [{ name: "added_on", type: "date", description: "When I added it to the diary" }], drop_columns: ["comment"] } },
      ],
    },
    {
      title: "Build bases on bases and link a table to itself",
      say: "`bases` builds a base on others. A table that extends `credited` gets `films`, plus `added_on` from `entry`, and `base:entry` still reads it. In a base, `ref: \"self\"` means the table that inherits it, so `tree` gives each table a `parent` link to its own rows.",
      steps: [
        { op: "define_base", args: { name: "credited", bases: ["entry"], description: "Someone in the credits of a film", columns: [{ name: "films", type: "list", items: "link", ref: "diary.classics.film", description: "The films they’re credited in" }] } },
        { op: "set_table_bases", args: { table: "actors", bases: ["credited"] } },
        { op: "define_base", args: { name: "tree", description: "Rows arranged in a tree", columns: [{ name: "parent", type: "link", ref: "self", hierarchy: true, description: "The row above this one" }] } },
        {
          op: "create_table",
          args: {
            catalog: "diary",
            schema: "classics",
            name: "genre",
            description: "Eras and genres of cinema, as a tree",
            columns: [{ name: "name", type: "string", required: true, description: "The name of the era or genre" }],
            filename: "{name}",
          },
          quiet: true,
        },
        { op: "set_table_bases", args: { table: "genre", bases: ["tree"] } },
        { op: "insert_row", args: { table: "genre", values: { name: "Cinema" } }, quiet: true },
        { op: "insert_row", args: { table: "genre", values: { name: "Silent film", parent: "[[Cinema]]" } }, quiet: true },
        {
          say: "In `genre`, `parent` links rows of `diary.classics.genre`:",
          op: "describe_table",
          args: { table: "genre" },
          show: (v) => v.columns.map((c: Record<string, unknown>) => ({ name: c.name, type: c.type, ...(c.ref ? { ref: c.ref } : {}), ...(c.hierarchy ? { hierarchy: c.hierarchy } : {}) })),
          check: (v) => v.columns.find((c: { name: string }) => c.name === "parent")?.ref !== "diary.classics.genre" && "parent should link the genre table",
        },
        { op: "select_rows", args: { table: "base:entry", columns: ["added_on"], order_by: "path" } },
        {
          say: "`bases: []` removes a table’s bases. `set_table_bases` refuses it while rows hold values of the inherited columns, like the `parent` of Silent film:",
          op: "set_table_bases",
          args: { table: "genre", bases: [] },
          refused: true,
        },
        { say: "On a table with no such values, `set_table_bases` removes the inherited columns from the definition. Here that table is an empty copy of `genre`:", op: "clone_table", args: { source: "genre", target: "genre_draft", copy_rows: false }, quiet: true },
        { op: "set_table_bases", args: { table: "genre_draft", bases: [] } },
      ],
    },
    {
      title: "Enforce rules with CHECK constraints",
      say: "`add_constraint` adds a CHECK constraint, a rule every row must satisfy, written as a `where` filter. The engine refuses it while existing rows break the rule and lists them; after that, it enforces the rule on every write. A condition on a column the row leaves empty passes, as in Structured Query Language (SQL). Inside `or`, `and` and `not`, the engine tests an empty value as it is, so a watched film without a `rating` breaks `rated_when_watched`.",
      steps: [
        { op: "add_constraint", args: { table: "film", name: "rated_when_watched", check: { or: [{ status: { ne: "watched" } }, { rating: { exists: true } }] } } },
        { op: "add_constraint", args: { table: "film", name: "at_most_three_hours", check: { minutes: { lte: 180 } } }, quiet: true },
        { op: "insert_row", args: { table: "film", values: { title: "His Girl Friday", year: 1940, minutes: 92, status: "watched" } }, refused: true },
        { op: "insert_row", args: { table: "film", values: { title: "His Girl Friday", year: 1940, minutes: 92, status: "watched", rating: 5 } } },
        { say: "`drop_constraint` removes a constraint, here the three-hour limit, which a long restoration could break:", op: "drop_constraint", args: { table: "film", name: "at_most_three_hours" } },
      ],
    },
    {
      title: "Rename or move a table",
      say: "`alter_table` renames a table with `name`, or moves it to another `catalog` or `schema`. Here `actors` becomes `actor`, singular like the other tables. The rows’ folder and their front matter key `table` follow, and the engine rewrites the links to them. `dry_run` lists the notes that would move.",
      steps: [
        { op: "alter_table", args: { table: "classics.actors", name: "actor", dry_run: true } },
        { op: "alter_table", args: { table: "classics.actors", name: "actor" } },
        { say: "Then move it to a schema of its own:", op: "alter_table", args: { table: "classics.actor", catalog: "diary", schema: "credits" } },
        { op: "list_folder", args: { folder: "datanotes/diary/credits/actor" } },
      ],
    },
    {
      title: "Change sub-folders and file names",
      say: "`alter_table` also changes `partition`, the sub-folders, and `filename`, the name pattern. The engine renames every row to fit, and refuses the change when a row can’t fill the pattern.",
      steps: [
        { op: "insert_row", args: { table: "film", values: { title: "Metropolis", year: 1927, minutes: 153, status: "to watch" } }, quiet: true },
        { op: "alter_table", args: { table: "film", partition: "{year}" } },
        { say: "Metropolis has no `rating` yet, so the engine refuses a name with `{rating}`:", op: "alter_table", args: { table: "film", filename: "{title} ({rating} stars)" }, refused: true },
        { op: "alter_table", args: { table: "film", filename: "{title} ({year})" } },
        { op: "list_folder", args: { folder: "datanotes/diary/classics/film/1940" } },
      ],
    },
    {
      title: "Set the archive folder and untyped fields",
      say: "`archive` names the folder, inside the table’s folder, that archived rows go to, and rows already archived move with it. `archive: \"\"` goes back to the database’s `archive_folder`. `fields` sets untyped fields that every new row gets, as names and values like in `create_table`, and a `null` value removes one.\n\nA change that touches only metadata, meaning fields, tags, description, history or the template, rewrites the definition alone and moves no row.",
      steps: [
        { op: "alter_table", args: { table: "film", archive: "_done" } },
        { op: "alter_table", args: { table: "film", fields: { cut: "restored", subtitles: "off" } } },
        { op: "alter_table", args: { table: "film", fields: { subtitles: null } }, check: (v) => v.planned_moves.length + v.planned_edits.length > 0 && "a change of fields should move or rewrite no row" },
        { op: "insert_row", args: { table: "film", values: { title: "Battleship Potemkin", year: 1925, minutes: 75, status: "to watch" } }, save: "f", showFile: (ctx) => ctx.saved.f.planned_creates[0] },
      ],
    },
    {
      title: "Give new notes a template",
      say: "`row_template`, in `create_table` and `alter_table`, is the text of every new row’s note, with `{column}` placeholders. Notes you create by hand in the table’s folder get it too.",
      steps: [
        { op: "alter_table", args: { table: "film", row_template: "# {title} ({year})\n\n## What I liked\n\n## Who I watched it with\n" } },
        { op: "insert_row", args: { table: "film", values: { title: "Sherlock Jr.", year: 1924, minutes: 45, status: "to watch" } }, save: "n", showFile: (ctx) => ctx.saved.n.planned_creates[0] },
        { say: "`row_template: \"\"` removes the template, and notes already written keep their text:", op: "alter_table", args: { table: "film", row_template: "" } },
      ],
    },
    {
      title: "Configure the database settings",
      say: "`configure_database` sets defaults stored in `metastore.yaml`:\n\n- **`timezone`**: the offset for date-times written without one\n- **`default_catalog`** and **`default_schema`**: where new tables go\n- **`default_filename`**: the file-name format of new time-named tables\n- **`archive_folder`**: the archive folder",
      steps: [{ op: "configure_database", args: { timezone: "Europe/Rome", default_catalog: "diary" }, show: (v) => v.config }],
    },
    {
      title: "Set defaults for new tables",
      say: "The other settings shape the tables you create next:\n\n- **`default_schema`**, with `default_catalog`: places a table given only a name\n- **`default_partition`**: the sub-folders of a table with a `time_column`, as a date format\n- **`default_filename`**: the file names of a table with a `time_column`, as a date format\n- **`archive_folder`**: the name of a new table’s archive folder\n\nExisting tables keep their settings.",
      steps: [
        { op: "configure_database", args: { default_schema: "log", default_partition: "YYYY/MM", default_filename: "YYYY-MM-DD HHmm", archive_folder: "_old" }, show: (v) => v.config },
        {
          op: "create_table",
          args: {
            name: "watch",
            description: "Each time I watch a film",
            columns: [
              { name: "film", type: "link", ref: "diary.classics.film", required: true, description: "The film I watched" },
              { name: "occurred_at", type: "datetime", required: true, description: "When the film started" },
              { name: "where", type: "enum", values: ["cinema", "home", "outdoor screening"], description: "The kind of place I watched it in" },
              { name: "place", type: "string", description: "The cinema, park or room, in my words" },
            ],
            time_column: "occurred_at",
          },
          show: (v) => ({ ok: v.ok, migration_id: v.migration_id }),
        },
        {
          say: "The new table is `diary.log.watch`, and its rows go in sub-folders by year and month. A date-time without an offset gets Rome’s offset:",
          op: "insert_row",
          args: { table: "watch", values: { film: "[[Nosferatu (1922)]]", occurred_at: "2026-10-06T21:30", where: "outdoor screening", place: "the park by the river" } },
          save: "w",
          check: (v) => !String(v.planned_creates?.[0]).startsWith("datanotes/diary/log/watch/2026/10/") && "a row in datanotes/diary/log/watch/2026/10/ expected",
          showFile: (ctx) => ctx.saved.w.planned_creates[0],
        },
      ],
    },
    {
      title: "Copy a table to try changes",
      say: "`clone_table` copies a table’s definition and rows under a new name, as independent copies. It can also copy the table as it was at an earlier version, as [Copy a table as it was](/guides/history/table-history/#copy-a-table-as-it-was) shows. With `copy_rows: false`, it copies only the definition. Use a copy to try something without touching the original.",
      steps: [
        { op: "clone_table", args: { source: "diary.classics.film", target: "sandbox.classics.film_copy" } },
        { op: "select_rows", args: { table: "sandbox.classics.film_copy", columns: ["title", "year"] } },
        { op: "clone_table", args: { source: "diary.classics.film", target: "sandbox.classics.film_empty", copy_rows: false } },
        { op: "describe_table", args: { table: "film_empty" }, show: (v) => ({ name: v.name, catalog: v.catalog, schema: v.schema, rows: v.row_count, columns: v.columns.map((c: { name: string }) => c.name) }) },
      ],
    },
    {
      title: "Move the database folder",
      say: [
        "A vault holds one database, in one folder: `datanotes/` for a new database. `root` renames or moves that folder, with `metastore.yaml` and every row in it. The folder can be anywhere in the vault, also in a subfolder.",
        "",
        "The move is one operation. In it, the engine:",
        "",
        "- rewrites every link into the folder, across the vault",
        "- recomputes the generated columns",
        "- moves a table’s `archive` or `exclude` folder inside the database folder",
        "",
        "The journal lists the move as `move_database`, which undo refuses. To move the folder back, call `configure_database` again.",
      ].join("\n"),
      steps: [
        { op: "alter_table", args: { table: "diary.classics.film", exclude: ["datanotes/diary/classics/film/Templates"] }, quiet: true },
        { op: "configure_database", args: { root: "Areas/Diary" }, show: (v) => ({ root: v.root, metastore: v.metastore }) },
        { op: "list_folder", args: { folder: "Areas" } },
        {
          say: "The `exclude` folder of `film`, set right before the move, moved with the database:",
          op: "describe_table",
          args: { table: "diary.classics.film" },
          show: (v) => ({ exclude: v.options.exclude }),
          check: (v) => v.options.exclude?.[0] !== "Areas/Diary/diary/classics/film/Templates" && "the exclude folder should have moved",
        },
        {
          say: "Editors hide folders whose name starts with a dot, so the engine refuses one. It also refuses the vault root, a folder that exists, and a folder inside the database:",
          op: "configure_database",
          args: { root: "Areas/.diary" },
          refused: true,
        },
        { say: "This call moves the folder back:", op: "configure_database", args: { root: "datanotes" }, show: (v) => ({ root: v.root, metastore: v.metastore }) },
      ],
    },
    {
      title: "See the database’s definition in `metastore.yaml`",
      say: "This is the database of this page as the engine wrote it. `metastore.yaml` holds:\n\n- the catalogs with their descriptions\n- the tables with their tags, `bases`, `constraints` and `options`\n- the bases, with `ref: self` kept as written\n- the settings under `config`",
      steps: [{ showFile: "datanotes/metastore.yaml" }],
    },
  ],
};

export default chapter;
