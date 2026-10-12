import type { Chapter } from "./types";

/** `YYYY-MM-DD` of `days` days before today, and a date-time at `hh:mm` that day (UTC). */
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const at = (days: number, hm: string) => `${ago(days)}T${hm}`;

const FILM = "datanotes/main/public/film";

const actor = (name: string, born: string) => ({ op: "insert_row", args: { table: "actor", values: { name, born } } });

const chapter: Chapter = {
  slug: "queries",
  title: "Querying rows",
  setup: [
    {
      op: "create_table",
      args: {
        name: "actor",
        description: "Actors of the films I watch",
        columns: [
          { name: "name", type: "string", required: true, description: "The actor's name, as credited" },
          { name: "born", type: "date", description: "The actor's date of birth" },
        ],
        filename: "{name}",
      },
    },
    actor("Max Schreck", "1879-09-06"),
    actor("Buster Keaton", "1895-10-04"),
    actor("Charlie Chaplin", "1889-04-16"),
    actor("Brigitte Helm", "1906-03-17"),
    actor("Cary Grant", "1904-01-18"),
    actor("Rosalind Russell", "1907-06-04"),
    actor("Audrey Hepburn", "1929-05-04"),
    actor("Duane Jones", "1937-04-02"),
    {
      op: "create_table",
      args: {
        name: "film",
        description: "Classic films I watched or want to watch",
        columns: [
          { name: "title", type: "string", required: true, unique: true, description: "The film's title, as on its poster" },
          { name: "year", type: "integer", description: "Year the film first came out" },
          { name: "minutes", type: "integer", min: 1, description: "Running time in minutes" },
          { name: "status", type: "enum", values: ["to watch", "watched"], ordered: true, description: "Where the film is on my list" },
          { name: "rating", type: "integer", min: 1, max: 5, description: "My rating, from 1 (poor) to 5 (a masterpiece)" },
          { name: "watched_on", type: "date", description: "The day I last watched it" },
          { name: "director", type: "string", description: "Who directed the film" },
          { name: "cast", type: "list", items: "link", ref: "main.public.actor", description: "The actors in the film" },
        ],
        filename: "{title}",
      },
    },
    {
      op: "insert_row",
      args: () => ({
        table: "film",
        values: { title: "Nosferatu", year: 1922, minutes: 94, status: "watched", rating: 5, watched_on: ago(24), director: "F. W. Murnau", cast: ["[[Max Schreck]]"] },
        body: "The shadow on the stairs still works a century later.\n",
      }),
    },
    { op: "insert_row", args: () => ({ table: "film", values: { title: "Sherlock Jr.", year: 1924, minutes: 45, status: "watched", rating: 4, watched_on: ago(20), director: "Buster Keaton", cast: ["[[Buster Keaton]]"] } }) },
    { op: "insert_row", args: { table: "film", values: { title: "Battleship Potemkin", year: 1925, minutes: 75, status: "to watch", director: "Sergei Eisenstein" } } },
    {
      op: "insert_row",
      args: () => ({
        table: "film",
        values: { title: "The Gold Rush", year: 1925, minutes: 95, status: "watched", rating: 5, watched_on: ago(2), director: "Charlie Chaplin", cast: ["[[Charlie Chaplin]]"] },
        body: "Watched it twice in three weeks; the dance of the bread rolls gets me every time.\n",
      }),
    },
    { op: "insert_row", args: { table: "film", values: { title: "Metropolis", year: 1927, minutes: 153, status: "to watch", director: "Fritz Lang", cast: ["[[Brigitte Helm]]"] } } },
    { op: "insert_row", args: () => ({ table: "film", values: { title: "His Girl Friday", year: 1940, minutes: 92, status: "watched", rating: 5, watched_on: ago(9), director: "Howard Hawks", cast: ["[[Cary Grant]]", "[[Rosalind Russell]]"] } }) },
    {
      op: "insert_row",
      args: () => ({
        table: "film",
        values: { title: "Charade", year: 1963, minutes: 113, status: "watched", rating: 4, watched_on: ago(5), director: "Stanley Donen", cast: ["[[Cary Grant]]", "[[Audrey Hepburn]]"] },
        body: "Cary Grant again, twenty years after [[His Girl Friday]], and just as quick.\n",
      }),
    },
    { op: "insert_row", args: () => ({ table: "film", values: { title: "Night of the Living Dead", year: 1968, minutes: 96, status: "watched", rating: 4, watched_on: ago(1), director: "George A. Romero", cast: ["[[Duane Jones]]"] } }) },
    {
      op: "create_table",
      args: {
        name: "watch",
        description: "Each time I watch a film",
        columns: [
          { name: "film", type: "link", ref: "main.public.film", required: true, description: "The film I watched" },
          { name: "occurred_at", type: "datetime", required: true, description: "When the film started" },
          { name: "where", type: "enum", values: ["cinema", "home", "outdoor screening"], description: "The kind of place I watched it in" },
          { name: "place", type: "string", description: "The cinema, park or room, in my words" },
          { name: "with", type: "string", description: "Who watched it with me" },
        ],
        time_column: "occurred_at",
      },
    },
    {
      op: "insert_row",
      args: () => ({
        table: "watch",
        values: { film: "[[Nosferatu]]", occurred_at: at(24, "21:30"), where: "outdoor screening", place: "the park by the river", with: "Julia" },
        body: "A trio played the score live; bring a blanket next time.\n",
      }),
    },
    { op: "insert_row", args: () => ({ table: "watch", values: { film: "[[Sherlock Jr.]]", occurred_at: at(20, "21:00"), where: "home", place: "my living room" } }) },
    { op: "insert_row", args: () => ({ table: "watch", values: { film: "[[The Gold Rush]]", occurred_at: at(19, "21:00"), where: "home", place: "my living room" } }) },
    { op: "insert_row", args: () => ({ table: "watch", values: { film: "[[His Girl Friday]]", occurred_at: at(9, "21:30"), where: "cinema", place: "the film club downtown", with: "Oscar" } }) },
    { op: "insert_row", args: () => ({ table: "watch", values: { film: "[[Charade]]", occurred_at: at(5, "21:15"), where: "home", place: "my living room" } }) },
    { op: "insert_row", args: () => ({ table: "watch", values: { film: "[[The Gold Rush]]", occurred_at: at(2, "20:30"), where: "home", place: "my living room", with: "my sister" } }) },
    {
      op: "insert_row",
      args: () => ({
        table: "watch",
        values: { film: "[[Night of the Living Dead]]", occurred_at: at(1, "22:00"), where: "cinema", place: "the film club downtown", with: "Oscar" },
        body: "A late show; half the hall jumped at the same moment.\n",
      }),
    },
  ],
  examples: [
    {
      title: "Filter rows, choose columns and sort",
      say: "Every key of `where` must match, and a plain value means equal. `columns` picks the columns of the answer, which always includes `path`. `order_by` sorts the rows, and a leading `-` sorts them in descending order.",
      steps: [{ op: "select_rows", args: { table: "film", columns: ["title", "minutes"], where: { status: "watched" }, order_by: "-minutes" } }],
    },
    {
      title: "Compare values with operators",
      say: "A `where` key takes an object of operators in place of a plain value. These are the operators:\n\n- **`eq`** and **`ne`**: equal and not equal\n- **`gt`**, **`gte`**, **`lt`** and **`lte`**: greater than, at least, less than and at most\n- **`in`**: equal to one of the listed values\n- **`contains`**: contains the text, or has the item in a list\n- **`icontains`**: contains the text, ignoring case and accents\n- **`exists`**: has a value (`true`) or has none (`false`)",
      steps: [
        { op: "select_rows", args: { table: "film", columns: ["title", "minutes"], where: { minutes: { gte: 90, lt: 100 } } } },
        { op: "select_rows", args: { table: "film", columns: ["title"], where: { cast: { contains: "[[Cary Grant]]" } } }, check: (v) => v.total !== 2 && "two films expected" },
        { say: "`icontains` finds Cary Grant from a part of his name in lowercase:", op: "select_rows", args: { table: "actor", columns: ["name", "born"], where: { name: { icontains: "grant" } } }, check: (v) => v.total !== 1 && "one actor expected" },
        { say: "`exists: false` finds the films with no rating:", op: "select_rows", args: { table: "film", columns: ["title"], where: { rating: { exists: false } } } },
        { op: "select_rows", args: { table: "film", columns: ["title", "year"], where: { year: { in: [1925, 1927] } } }, check: (v) => v.total !== 3 && "three films expected" },
      ],
    },
    {
      title: "Combine filters with `or`, `and` and `not`",
      say: "`or`, `and` and `not` combine filters, and you can nest them. The first query finds the films still to watch and the watched films over 100 minutes. The second leaves out every film with Cary Grant.",
      steps: [
        {
          op: "select_rows",
          args: { table: "film", columns: ["title", "status", "minutes"], where: { or: [{ status: "to watch" }, { and: [{ status: "watched" }, { minutes: { gt: 100 } }] }] } },
        },
        { op: "select_rows", args: { table: "film", columns: ["title"], where: { not: { cast: { contains: "[[Cary Grant]]" } } } } },
      ],
    },
    {
      title: "Filter by relative dates",
      say: "The engine resolves tokens like `{today}`, `{today-7d}` and `{now-24h}` when the query runs, so a stored query keeps returning current rows. On a date column, a date-time counts by its day, so `{now-7d}` matches as `{today-7d}` does. This query finds the viewings of the last seven days.",
      steps: [
        { op: "select_rows", args: { table: "watch", columns: ["film", "occurred_at", "where", "place"], where: { occurred_at: { gte: "{today-7d}" } }, order_by: "occurred_at" } },
      ],
    },
    {
      title: "Page through the results",
      say: "`limit` sets the page size (default 100, at most 1,000) and `offset` skips rows before the page. `total` counts every matching row, whatever the page.",
      steps: [{ op: "select_rows", args: { table: "watch", columns: ["occurred_at"], order_by: "-occurred_at", limit: 2, offset: 2 } }],
    },
    {
      title: "Read the note behind a row",
      say: "Every row is a note, and you can select and filter these file columns:\n\n- **`file_name`**: the note’s name\n- **`file_link`**: a link to the note\n- **`file_modified`**: when the file last changed\n- **`file_backlink_count`**: the notes that link to it\n\n`include_body` adds the note’s text to each row.",
      steps: [
        { op: "select_rows", args: { table: "film", columns: ["file_name", "file_link", "file_backlink_count"], where: { title: "His Girl Friday" } } },
        { op: "select_rows", args: { table: "film", columns: ["title"], where: { title: "Charade" }, include_body: true } },
      ],
    },
    {
      title: "Group rows and compute totals",
      say: "`group_by` groups the rows, and `aggregates` computes one value per group. These are the aggregates:\n\n- **`count`**: the rows in the group\n- **`count:col`**: the rows where the column has a value\n- **`sum:col`**, **`avg:col`**, **`min:col`** and **`max:col`**: the total, average, smallest and largest value of the column",
      steps: [
        {
          op: "select_rows",
          args: { table: "film", group_by: "status", aggregates: { films: "count", rated: "count:rating", minutes: "sum:minutes", average: "avg:minutes", longest: "max:minutes" } },
        },
        { say: "A link column makes one group per linked note. These are the viewings per film:", op: "select_rows", args: { table: "watch", group_by: "film", aggregates: { viewings: "count" } } },
        { say: "`date(col)` groups a date-time column by day. These are the viewings per day over the last week:", op: "select_rows", args: { table: "watch", group_by: "date(occurred_at)", aggregates: { viewings: "count" }, where: { occurred_at: { gte: "{today-7d}" } } } },
      ],
    },
    {
      title: "Join rows on a computed key",
      say: "`join` attaches to each row the rows of another table whose values match, and `on` maps a column of this table to a column of the other. `date(col)` matches a date-time by its day, optionally shifted by a number of days. Here each film watched in the last three days gets the viewing of its `watched_on` day. The viewing tells you where you saw the film and who came along.",
      steps: [
        {
          op: "select_rows",
          args: {
            table: "film",
            columns: ["title", "watched_on"],
            where: { watched_on: { gte: "{today-3d}" } },
            join: { table: "watch", on: { watched_on: "date(occurred_at)" }, as: "viewing", type: "inner", columns: ["where", "with"] },
          },
          check: (v) => v.total !== 2 && "two films expected",
        },
      ],
    },
    {
      title: "Store a query as a view",
      say: "`create_view` stores a query in `metastore.yaml` under a name; give it the `vw_` prefix. You select a view like a table and can narrow it further, and it writes no note.\n\nAgents find a view by its `description` and `aliases`. `labels` are the column headings a client shows when it renders the view as a table in a note; `select_rows` still answers with the column names.",
      steps: [
        {
          op: "create_view",
          args: {
            name: "vw_recent_watches",
            query: { table: "watch", columns: ["film", "occurred_at", "where", "place"], where: { occurred_at: { gte: "{today-14d}" } }, order_by: "-occurred_at" },
            description: "Films watched in the last two weeks",
            aliases: ["what I watched lately"],
            labels: { film: "Film", occurred_at: "Watched", where: "Where", place: "Place" },
          },
        },
        {
          say: "A `where` in `select_rows` narrows the view. It combines with the view’s own filter this way:\n\n- **A column the view doesn’t filter**: the engine adds the condition to the view’s filter\n- **A column the view filters**: the engine replaces an operator the view already has and adds a new one\n- **`or`, `and` or `not` on either side**: both filters apply",
          op: "select_rows",
          args: { table: "vw_recent_watches", where: { where: "home" } },
        },
        { say: "`list_tables` lists the views next to the tables:", op: "list_tables", show: (v) => ({ views: v.views }) },
      ],
    },
    {
      title: "Change an existing view",
      say: "Once a view exists, `create_view` refuses its name. `replace: true` replaces the whole view, like `CREATE OR REPLACE VIEW` in Structured Query Language (SQL), so pass its `description`, `aliases` and `labels` again.",
      steps: [
        { op: "create_view", args: { name: "vw_recent_watches", query: { table: "watch", where: { occurred_at: { gte: "{today-30d}" } } } }, refused: true },
        {
          op: "create_view",
          args: {
            name: "vw_recent_watches",
            replace: true,
            query: { table: "watch", columns: ["film", "occurred_at", "where", "place"], where: { occurred_at: { gte: "{today-30d}" } }, order_by: "-occurred_at" },
            description: "Films watched in the last month",
            aliases: ["what I watched lately"],
            labels: { film: "Film", occurred_at: "Watched", where: "Where", place: "Place" },
          },
        },
      ],
    },
    {
      title: "Join and expand rows in a view",
      say: "A view stores any query. This one keeps the last three films watched (`order_by`, `limit`) and puts the notes of each film’s cast inline (`expand`). A `left` join attaches the viewing of the `watched_on` day, so a film with no viewing logged that day gets an empty list.",
      steps: [
        {
          op: "create_view",
          args: {
            name: "vw_last_watched",
            query: {
              table: "film",
              columns: ["title", "watched_on", "cast"],
              where: { status: "watched" },
              expand: ["cast"],
              join: { table: "watch", on: { watched_on: "date(occurred_at)" }, as: "viewing", type: "left", columns: ["where"] },
              order_by: "-watched_on",
              limit: 3,
            },
          },
        },
        { op: "select_rows", args: { table: "vw_last_watched" }, check: (v) => v.rows.length !== 3 && "three films expected" },
      ],
    },
    {
      title: "Combine several tables in one view",
      say: "A view with `union` stacks the rows of several queries, like SQL’s `UNION ALL`, on one table or on several. It tags each row with `_source`, and each branch takes `table`, `columns` and `where`. Next to `union`, these keys apply to the whole view:\n\n- **`columns`**: the columns of every branch that gives none\n- **`where`**: a filter on every branch, on top of its own\n- **`expand`**: the links to expand in every branch\n- **`order_by`** and **`limit`**: the order and the number of the stacked rows\n\nThis view stacks the films made before 1960 and the actors. Its `where` keeps the notes that at least two other notes link to: the films and actors your diary mentions most.",
      steps: [
        {
          op: "create_view",
          args: {
            name: "vw_most_linked",
            query: {
              union: [{ table: "film", columns: ["title", "year"], where: { year: { lt: 1960 } } }, { table: "actor" }],
              columns: ["name"],
              where: { file_backlink_count: { gte: 2 } },
              order_by: "path",
            },
          },
        },
        { op: "select_rows", args: { table: "vw_most_linked" }, check: (v) => v.total !== 3 && "two films and an actor expected" },
        {
          say: "The branches can read the same table. This view stacks every trip to the cinema and the last week’s viewings at home. It keeps the three latest and puts each film’s note inline:",
          op: "create_view",
          args: {
            name: "vw_latest_watches",
            query: {
              union: [{ table: "watch", where: { where: "cinema" } }, { table: "watch", where: { where: "home", occurred_at: { gte: "{today-7d}" } } }],
              columns: ["film", "occurred_at", "where"],
              expand: ["film"],
              order_by: "-occurred_at",
              limit: 3,
            },
          },
        },
        { op: "select_rows", args: { table: "vw_latest_watches" }, check: (v) => v.rows.length !== 3 && "three rows expected" },
        { say: "`drop_view` removes a view, and `undo_migration` puts it back, as it does for every schema change:", op: "drop_view", args: { view: "vw_most_linked" }, save: "drop" },
        { op: "undo_migration", args: (ctx) => ({ migration_id: ctx.saved.drop.migration_id }) },
      ],
    },
    {
      title: "Put a view in a schema of its own",
      say: "`catalog` and `schema` place a view the way they place a table, and default to the database’s default catalog and schema. A schema can hold views only. The query can read the tables of any schema, named here in full.",
      steps: [
        {
          op: "create_view",
          args: {
            catalog: "main",
            schema: "reports",
            name: "vw_watches_by_place",
            query: { table: "main.public.watch", group_by: "where", aggregates: { viewings: "count" } },
            description: "Viewings at the cinema, at home and outdoors",
          },
        },
        { op: "select_rows", args: { table: "reports.vw_watches_by_place" } },
      ],
    },
    {
      title: "Read the note that shows a view with `{this.*}`",
      say: "A view can read the note that shows it, so one view serves every note of a kind. These are the tokens:\n\n- **`{this.<property>}`**: a front matter key of that note, such as `{this.watched_on}`; `{this.watched_on+1d}` is the day after and `{this.watched_on-1w}` a week before\n- **`{this.link}`**: a link to the note\n- **`{this.name}`** and **`{this.path}`**: the note’s name and vault path\n\nThe engine stores the tokens as written. It fills them in when `select_rows` names the note with `this_note`, which a client passes when it shows the view inside a note. This `batch` creates four views:\n\n- **`vw_watches_that_day`**: the viewings on a film’s `watched_on` day\n- **`vw_film_watches`**: every viewing of a film\n- **`vw_same_status`**: the other films with the film’s status\n- **`vw_films_with`**: the films of an actor’s note",
      steps: [
        {
          op: "batch",
          args: {
            summary: "views for film and actor notes",
            operations: [
              { op: "create_view", name: "vw_watches_that_day", query: { table: "watch", where: { occurred_at: { gte: "{this.watched_on}", lt: "{this.watched_on+1d}" } }, order_by: "occurred_at" } },
              { op: "create_view", name: "vw_film_watches", query: { table: "watch", columns: ["occurred_at", "where"], where: { film: "{this.link}" } } },
              { op: "create_view", name: "vw_same_status", query: { table: "film", columns: ["title"], where: { status: "{this.status}", path: { ne: "{this.path}" } } } },
              { op: "create_view", name: "vw_films_with", query: { table: "film", columns: ["title", "year"], where: { cast: { contains: "[[{this.name}]]" } } } },
            ],
          },
          show: (v) => ({ ok: v.ok, migration_id: v.migration_id, steps: v.steps.map((s: { op: string; ok: boolean }) => ({ op: s.op, ok: s.ok })) }),
        },
        {
          say: "`this_note` takes the vault path of the note the result is for, and the tokens read that note. These are the viewings of The Gold Rush, as its note shows them:",
          op: "select_rows",
          args: { table: "vw_film_watches", this_note: `${FILM}/The Gold Rush.md` },
          check: (v) => v.total !== 2 && "two viewings expected",
        },
        {
          say: "For the same note, `{this.watched_on}` is the day you last watched The Gold Rush:",
          op: "select_rows",
          args: { table: "vw_watches_that_day", columns: ["film", "occurred_at", "where"], this_note: `${FILM}/The Gold Rush.md` },
          check: (v) => v.total !== 1 && "one viewing expected",
        },
        {
          say: "For Metropolis’s note, `{this.status}` is its `status` and `{this.path}` leaves Metropolis itself out. This is the other film still to watch:",
          op: "select_rows",
          args: { table: "vw_same_status", this_note: `${FILM}/Metropolis.md` },
          check: (v) => v.total !== 1 && "one other film expected",
        },
        {
          say: "For Cary Grant’s note, `[[{this.name}]]` is a link to him:",
          op: "select_rows",
          args: { table: "vw_films_with", this_note: "datanotes/main/public/actor/Cary Grant.md" },
          check: (v) => v.total !== 2 && "two films expected",
        },
        {
          say: "Without `this_note`, a token stays as written and matches no row, whatever its operator. That holds for `film: \"{this.link}\"` here, for a `ne` like the `path` one, and for `within`.",
          op: "select_rows",
          args: { table: "vw_film_watches" },
          check: (v) => v.total !== 0 && "no rows expected",
        },
      ],
    },
    {
      title: "Query the database’s own schema",
      say: "`system.information_schema` describes the database as tables that you query with `select_rows`. It has these tables:\n\n- **`catalogs`** and **`schemata`**: the catalogs and their schemas\n- **`tables`** and **`views`**: the tables and the stored views\n- **`columns`**: the columns of every table\n- **`check_constraints`**: the CHECK constraints, the rules that every row of a table must satisfy\n\nThis query lists the columns of `watch`:",
      steps: [
        { op: "select_rows", args: { table: "system.information_schema.columns", columns: ["table_name", "column_name", "data_type", "is_nullable"], where: { table_name: "watch" } } },
      ],
    },
    {
      title: "See the views in `metastore.yaml`",
      say: "The engine wrote this page’s views under `views:` in their schema, next to the tables. It keeps each query as you gave it, with its relative dates and `{this.*}` tokens.",
      steps: [{ showFile: "datanotes/metastore.yaml" }],
    },
  ],
};

export default chapter;
