import type { Chapter } from "./types";

const FILM = "datanotes/main/public/film";

const chapter: Chapter = {
  slug: "columns",
  title: "Defining columns",
  setup: [
    {
      op: "create_table",
      args: {
        name: "film",
        description: "Classic films I watched or want to watch",
        columns: [
          { name: "title", type: "string", required: true, description: "The film's title, as on its poster" },
          { name: "year", type: "integer", description: "Year the film first came out" },
        ],
        filename: "{title}",
      },
    },
    { op: "insert_row", args: { table: "film", values: { title: "Nosferatu", year: 1922 } } },
    { op: "insert_row", args: { table: "film", values: { title: "Metropolis", year: 1927 } } },
  ],
  examples: [
    {
      title: "Add a sparse column",
      say: "A new column is sparse by default: the table knows it, but only the rows that get a value store it. Use sparse columns for things you record sometimes. Every column needs a `description`, and `label` and `aliases` add other words for it. They tell an agent what the column means, so it reuses the column instead of adding a second one. `note` links to a note that documents the column.",
      steps: [
        {
          op: "add_column",
          args: {
            table: "film",
            column: { name: "minutes", type: "integer", min: 1, label: "Runtime", aliases: ["runtime", "length"], description: "Running time in minutes", note: "[[How I count minutes]]" },
          },
        },
        { op: "update_row", args: { table: "film", path: `${FILM}/Metropolis.md`, set: { minutes: 153 } }, quiet: true },
        { op: "select_rows", args: { table: "film", columns: ["title", "minutes"] }, say: "Only Metropolis has a value. The Nosferatu note has no `minutes` key, so it reads as `null`:" },
      ],
    },
    {
      title: "Add a dense column to every row",
      say: "`dense: true` writes the column on every row, existing rows included, with its `default`.",
      steps: [
        { op: "add_column", args: { table: "film", column: { name: "favourite", type: "boolean", default: false, description: "True for the films I would watch again and again", dense: true } } },
        { op: "select_rows", args: { table: "film", columns: ["title", "favourite"] } },
      ],
    },
    {
      title: "Turn an enum into an ordered scale",
      say: "An `enum` accepts only its `values`. With `ordered: true`, the values form a scale: filters, sorting and averages use each value’s position (1, 2…), while the notes keep the words. Here the last value is `seen`; the next example renames it.",
      steps: [
        { op: "add_column", args: { table: "film", column: { name: "status", type: "enum", values: ["to watch", "seen"], ordered: true, description: "Where the film is on my list" } } },
        { op: "update_row", args: { table: "film", path: `${FILM}/Nosferatu.md`, set: { status: "seen" } }, quiet: true },
        { op: "update_row", args: { table: "film", path: `${FILM}/Metropolis.md`, set: { status: "to watch" } }, quiet: true },
        {
          say: "Sorting follows the scale, furthest along first:",
          op: "select_rows",
          args: { table: "film", columns: ["title", "status"], order_by: "-status" },
          check: (v) => v.rows[0]?.title !== "Nosferatu" && "Nosferatu first expected",
        },
        {
          say: "So does a filter. `gt: \"to watch\"` means further along than `to watch`:",
          op: "select_rows",
          args: { table: "film", columns: ["title", "status"], where: { status: { gt: "to watch" } } },
          check: (v) => v.total !== 1 && "one row expected",
        },
      ],
    },
    {
      title: "Rename an enum value",
      say: "`rename_value` renames one value in the definition and on every row. The value keeps its position on the scale. Here `seen` becomes `watched`.",
      steps: [
        { op: "rename_value", args: { table: "film", column: "status", from_value: "seen", to_value: "watched" } },
        { op: "select_rows", args: { table: "film", columns: ["title", "status"], where: { title: "Nosferatu" } }, check: (v) => v.rows[0]?.status !== "watched" && "watched expected" },
      ],
    },
    {
      title: "Describe what each enum value means",
      say: "`value_descriptions` says when to use each value of an enum. `describe_table` shows the descriptions, and so does the refusal of a wrong value, so an agent picks the right one.",
      steps: [
        {
          op: "alter_column",
          args: {
            table: "film",
            column: "status",
            changes: { value_descriptions: { "to watch": "on my list, not seen yet", watched: "seen to the end" } },
          },
        },
        { op: "update_row", args: { table: "film", path: `${FILM}/Nosferatu.md`, set: { status: "finished" } }, refused: true },
      ],
    },
    {
      title: "Change a column’s attributes",
      say: "`alter_column` changes a column’s attributes. If rows would break the new definition, the engine refuses the change, lists those rows and changes nothing.",
      steps: [
        { op: "alter_column", args: { table: "film", column: "minutes", changes: { max: 120 } }, refused: true },
        { say: "A change that every row satisfies goes through:", op: "alter_column", args: { table: "film", column: "minutes", changes: { max: 300, description: "Running time of the commonly cited version" } } },
        { say: "`null` removes an attribute. Without `max`, any runtime is valid again.", op: "alter_column", args: { table: "film", column: "minutes", changes: { max: null } } },
        {
          say: "`dense: true` makes the column dense, so the engine writes it on every row, including Nosferatu, which has no value.",
          op: "alter_column",
          args: { table: "film", column: "minutes", changes: { dense: true } },
          showFile: `${FILM}/Nosferatu.md`,
        },
        { say: "`dense: false` makes the column sparse again. Rows written from now on store it only when it has a value, and the empty `minutes` already in Nosferatu stays:", op: "alter_column", args: { table: "film", column: "minutes", changes: { dense: false } }, showFile: `${FILM}/Nosferatu.md` },
      ],
    },
    {
      title: "Rename a column",
      say: "`rename_column` renames the key in `metastore.yaml` and on every row.",
      steps: [
        { op: "rename_column", args: { table: "film", from_column: "favourite", to_column: "loved_it" } },
        { op: "select_rows", args: { table: "film", columns: ["title", "loved_it"] } },
      ],
    },
    {
      title: "Drop a column and undo the drop",
      say: "`drop_column` removes the column and its values from every row. The journal keeps the values, so `undo_migration` brings them back.",
      steps: [
        { op: "drop_column", args: { table: "film", column: "loved_it" }, save: "drop" },
        { op: "undo_migration", args: (ctx) => ({ migration_id: ctx.saved.drop.migration_id }) },
        { op: "select_rows", args: { table: "film", columns: ["title", "loved_it"] }, say: "The values are back:" },
      ],
    },
    {
      title: "Default to today’s date or the current time",
      say: "As a default, `\"{today}\"` gives a date and `\"{now}\"` gives a date-time. The engine evaluates them when it writes the row.",
      steps: [
        { op: "add_column", args: { table: "film", column: { name: "added", type: "date", default: "{today}", description: "The day I put the film on my list" } } },
        { op: "add_column", args: { table: "film", column: { name: "added_at", type: "datetime", default: "{now}", description: "When I put the film on my list" } }, quiet: true },
        { op: "insert_row", args: { table: "film", values: { title: "Sherlock Jr.", year: 1924 } }, save: "sj", showFile: (ctx) => ctx.saved.sj.planned_creates[0] },
      ],
    },
    {
      title: "Store lists and structured values",
      say: "A `list` column holds several values of its `items` type, and the engine checks each one. A `json` column stores any YAML Ain’t Markup Language (YAML) value as is, without checks, such as objects or lists of objects. Its name comes from JavaScript Object Notation (JSON).",
      steps: [
        { op: "add_column", args: { table: "film", column: { name: "seen_at", type: "list", items: "enum", values: ["cinema", "home", "outdoor screening"], description: "Every kind of place I saw the film in" } } },
        { op: "add_column", args: { table: "film", column: { name: "viewings", type: "json", description: "Each viewing: when, where, and a note on it" } } },
        {
          op: "update_row",
          args: {
            table: "film",
            path: `${FILM}/Nosferatu.md`,
            set: {
              seen_at: ["outdoor screening", "home"],
              viewings: [{ on: "2026-07-18", where: "outdoor screening", note: "live piano" }, { on: "2026-10-02", where: "home", note: "the shadow on the stairs still works" }],
            },
          },
          showFile: `${FILM}/Nosferatu.md`,
        },
        { say: "One wrong item makes the engine refuse the whole write:", op: "update_row", args: { table: "film", path: `${FILM}/Metropolis.md`, set: { seen_at: ["home", "festival"] } }, refused: true },
      ],
    },
    {
      title: "Compute a column from other columns",
      say: [
        "The engine computes a `generated` column from other columns on every write, and you can’t set it yourself. The expression takes one of four forms:",
        "",
        "- **A column name**: the value of that column",
        "- **`date(col)`**: the date of `col`, with an optional day shift",
        "- **A template**: text with `{col}` and `{col:FORMAT}` placeholders",
        "- **An aggregate**: a count or a total of the items of a `json` list, shown in the next section",
        "",
        "In a template, `min(…)`, `max(…)` and `coalesce(…)` pick among several columns.",
      ].join("\n"),
      steps: [
        {
          op: "create_table",
          args: {
            name: "watch",
            columns: [
              { name: "film", type: "string", required: true, description: "The film I watched" },
              { name: "occurred_at", type: "datetime", required: true, description: "When the film started" },
              { name: "where", type: "enum", values: ["cinema", "home", "outdoor screening"], description: "The kind of place I watched it in" },
              { name: "day", type: "date", generated: "date(occurred_at)", description: "The day of the viewing, for daily notes" },
              { name: "label", type: "string", generated: "{film} ({occurred_at:DD/MM HH:mm}, {where})", description: "A one-line summary of the viewing, for lists" },
            ],
            time_column: "occurred_at",
            description: "Each time I watch a film",
          },
        },
        { op: "insert_row", args: { table: "watch", values: { film: "His Girl Friday", occurred_at: "2026-10-03T21:30", where: "home" } }, save: "w", showFile: (ctx) => ctx.saved.w.planned_creates[0] },
        { say: "The engine refuses a value for a generated column:", op: "insert_row", args: { table: "watch", values: { film: "His Girl Friday", occurred_at: "2026-10-04T21:30", day: "2026-10-01" } }, refused: true },
      ],
      after: "`time_column` names each row’s file after that date-time: here, the time the viewing started. The name follows the database’s `filename` format, `YYYY-MM-DD[T]HHmm` by default.",
    },
    {
      title: "Count and total the items of a json list",
      say: [
        "A `generated` column can count the items of a `json` list of objects. It can also total one field of them. The engine recomputes it on every write of the row, so a total never falls behind its list. These functions read the list:",
        "",
        "- **`count(films)`**: the number of items",
        "- **`count(films.minutes)`**: the items that have a `minutes` value",
        "- **`sum(films.minutes)`**: the total of the field",
        "- **`avg(…)`, `min(…)`, `max(…)`**: the average, the smallest and the largest value",
        "",
        "A filter after a comma keeps only some items: `count(films, rewatch = true)`. It compares one field with `\"text\"`, a number, `true` or `false`. It uses `=`, `!=`, `<`, `<=`, `>` or `>=`, and the four orderings compare numbers. `!=` keeps every item that `=` leaves out, items without the field included.",
      ].join("\n"),
      steps: [
        {
          op: "create_table",
          args: {
            name: "marathon",
            description: "Nights when I watch several films in a row",
            columns: [
              { name: "night", type: "date", required: true, description: "The night of the marathon" },
              { name: "films", type: "json", description: "The films of the night: title, minutes and rewatch" },
              { name: "film_count", type: "integer", generated: "count(films)", description: "How many films I watched" },
              { name: "rewatches", type: "integer", generated: "count(films, rewatch = true)", description: "Films I had seen before" },
              { name: "total_min", type: "integer", generated: "sum(films.minutes)", description: "Minutes of film in the night" },
              { name: "longest_min", type: "integer", generated: "max(films.minutes)", description: "Running time of the longest film" },
              { name: "avg_min", type: "number", generated: "avg(films.minutes, rewatch != true)", description: "Average running time of the new films" },
            ],
            filename: "{night}",
          },
        },
        {
          op: "insert_row",
          args: {
            table: "marathon",
            values: {
              night: "2026-10-31",
              films: [
                { title: "Nosferatu", minutes: 94, rewatch: true },
                { title: "Vampyr", minutes: 73 },
                { title: "Frankenstein", minutes: 70 },
              ],
            },
          },
          showFile: "datanotes/main/public/marathon/2026-10-31.md",
          check: (v) => !v.ok && "the marathon row expected",
        },
        {
          say: "The type of the column must fit the result. `count` makes a whole number, and `avg` needs a `number` column. An aggregate of a column that isn’t `json` is refused too:",
          op: "add_column",
          args: { table: "marathon", column: { name: "nights", type: "integer", generated: "count(night)", description: "Not a list" } },
          refused: true,
        },
      ],
      after: [
        "Values the engine can’t total leave the column empty instead of storing a wrong number:",
        "",
        "- **No list, or an empty one**: `count` and `sum` are 0, and `avg`, `min` and `max` are empty",
        "- **An item without the field**: the engine leaves it out",
        "- **A field that isn’t a number**: the total is empty, as when the column isn’t a list",
        "",
        "An `integer` column refuses a write whose total isn’t whole. After a hand edit of the list, `check_table` reports the stale totals and `recompute_columns` fixes them.",
      ].join("\n"),
    },
    {
      title: "Let the engine fill identity columns",
      say: "The engine fills an `identity` column on its own. `filename` keeps the note’s file name, and `created` records when the engine created the row and never changes. Every table also has `id`, the identity column that holds the row’s universally unique identifier (UUID). The meaning of `id` and `created` never changes, so the engine writes their descriptions too.",
      steps: [
        { op: "add_column", args: { table: "film", column: { name: "note_name", type: "string", identity: "filename", description: "The name of the film's note, kept as the file is renamed" } } },
        { op: "add_column", args: { table: "film", column: { name: "created", type: "datetime", identity: "created" } } },
        { op: "insert_row", args: { table: "film", values: { title: "Charade", year: 1963 } }, showFile: `${FILM}/Charade.md` },
      ],
    },
    {
      title: "Recompute generated columns after a hand edit",
      say: [
        "An edit made outside the engine, in an editor, through git or by a sync tool, can leave generated columns stale. `check_table` reports them with code `generated`, and `recompute_columns` brings them up to date.",
        "",
        "The engine also recomputes them on its own about 3s after a hand edit, unless the `autoRecompute` setting is off. The examples on this page turn it off so you can see each step. Here you correct `where` by hand, because you saw His Girl Friday at the cinema, and `label` still says `home`.",
      ].join("\n"),
      steps: [
        { edit: { path: "datanotes/main/public/watch/2026-10-03T2130.md", text: (t) => t.replace("where: home", "where: cinema") } },
        { op: "check_table", args: { table: "watch" }, check: (v) => !JSON.stringify(v).includes("generated") && "a stale generated value expected" },
        { op: "recompute_columns", args: { table: "watch" } },
        { op: "select_rows", args: { table: "watch", columns: ["where", "label"] }, check: (v) => !String(v.rows[0]?.label).includes("cinema") && "label recomputed expected" },
      ],
    },
    {
      title: "Partition rows into folders",
      say: "`options.partition` puts rows in subfolders named from their values. A `{column:FORMAT}` placeholder formats a date, so here each actor goes in the folder of their birth year. A table of events could use one folder per year and month, with `{occurred_at:YYYY/MM}`.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "actor",
            description: "Actors of the films I watch",
            columns: [
              { name: "name", type: "string", required: true, description: "The actor's name, as credited" },
              { name: "born", type: "date", required: true, description: "The actor's date of birth" },
            ],
            filename: "{name}", partition: "{born:YYYY}",
          },
        },
        { op: "insert_row", args: { table: "actor", values: { name: "Cary Grant", born: "1904-01-18" } } },
        { op: "insert_row", args: { table: "actor", values: { name: "Audrey Hepburn", born: "1929-05-04" } }, quiet: true },
        { op: "list_folder", args: { folder: "datanotes/main/public/actor" } },
      ],
    },
    {
      title: "See the column definitions in `metastore.yaml`",
      say: [
        "The engine wrote this file with the columns from this page, in the operations’ words. Two things have a place of their own:",
        "",
        "- **`time_column`**: the table’s `filename` pattern under `options`",
        "- **`partition`**: under `options`, next to `filename`",
      ].join("\n"),
      steps: [{ showFile: "datanotes/metastore.yaml" }],
    },
  ],
  settings: { autoRecompute: false },
};

export default chapter;
