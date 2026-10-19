import type { Chapter } from "./types";

const FILM = "datanotes/main/public/film";
const GENRE = "datanotes/main/public/genre";
const SILENT = `${GENRE}/Silent film.md`;

interface FeedEvent {
  seq: number;
  kind: string;
  path: string;
  source: string;
  changes?: unknown;
  violations?: { path: string; violations: { constraint?: string }[] }[];
}

/** The change feed's events of the hand edit of Silent film (other changes may arrive meanwhile). */
const handEdits = (v: { events: FeedEvent[] }) => v.events.filter((e) => e.source === "external" && e.path === SILENT);

const chapter: Chapter = {
  slug: "relations",
  title: "Relations between tables",
  setup: [
    {
      op: "create_table",
      args: {
        name: "actor",
        description: "Actors of the films I watch",
        columns: [
          { name: "name", type: "string", required: true, unique: true, description: "The actor's name, as credited" },
          { name: "born", type: "date", description: "The actor's date of birth" },
        ],
        filename: "{name}",
      },
    },
    { op: "insert_row", args: { table: "actor", values: { name: "Cary Grant", born: "1904-01-18" } } },
    { op: "insert_row", args: { table: "actor", values: { name: "Rosalind Russell", born: "1907-06-04" } } },
    { op: "insert_row", args: { table: "actor", values: { name: "Audrey Hepburn", born: "1929-05-04" } } },
    {
      op: "create_table",
      args: {
        name: "film",
        description: "Classic films I watched or want to watch",
        columns: [
          { name: "title", type: "string", required: true, unique: true, description: "The film's title, as on its poster" },
          { name: "year", type: "integer", description: "Year the film first came out" },
          { name: "minutes", type: "integer", min: 1, description: "Running time in minutes" },
        ],
        filename: "{title}",
      },
    },
    { op: "insert_row", args: { table: "film", values: { title: "His Girl Friday", year: 1940, minutes: 92 } } },
    { op: "insert_row", args: { table: "film", values: { title: "Charade", year: 1963, minutes: 113 } } },
    { op: "insert_row", args: { table: "film", values: { title: "Night of the Living Dead", year: 1968, minutes: 96 } } },
  ],
  examples: [
    {
      title: "Point a column to a row of another table",
      say: "A viewing is of one film, so its `film` column is a `link` whose `ref` is the film table. The value must link to a note that is a row of `film`.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "watch",
            description: "Each time I watch a film",
            columns: [
              { name: "film", type: "link", ref: "main.public.film", required: true, description: "The film I watched" },
              { name: "where", type: "enum", values: ["cinema", "home", "outdoor screening"], required: true, description: "The kind of place I watched it in" },
              { name: "place", type: "string", description: "The cinema, park or room, in my words" },
              { name: "with", type: "string", description: "Who watched it with me" },
              { name: "occurred_at", type: "datetime", required: true, description: "When the film started" },
            ],
            time_column: "occurred_at",
          },
        },
        { op: "insert_row", args: { table: "watch", values: { film: "[[His Girl Friday]]", where: "cinema", place: "the film club downtown", with: "my sister", occurred_at: "2026-03-14T20:30" }, body: "A full hall, and everyone laughed at the same lines.\n" }, save: "w", showFile: (ctx) => ctx.saved.w.planned_creates[0] },
        { op: "insert_row", args: { table: "watch", values: { film: "[[Charade]]", where: "home", place: "my living room", occurred_at: "2026-09-26T21:30" } }, quiet: true },
        { say: "The engine refuses a link to a note that doesn’t exist (`broken_link`):", op: "insert_row", args: { table: "watch", values: { film: "[[Charde]]", where: "home", occurred_at: "2026-09-27T21:00" } }, refused: true },
        { say: "It also refuses a link to a note of another table (`ref`), here an actor:", op: "insert_row", args: { table: "watch", values: { film: "[[Cary Grant]]", where: "home", occurred_at: "2026-09-27T21:00" } }, refused: true },
      ],
    },
    {
      title: "Link to several rows with a list of links",
      say: "A film has several actors, so `cast` is a `list` of `link` items, and the engine checks each one against `ref`. `inverse: films` names the actor column that links back, and from then on the engine keeps both sides in step. Both columns must exist, and you declare `inverse` on one side only.",
      steps: [
        { op: "add_column", args: { table: "actor", column: { name: "films", type: "list", items: "link", ref: "main.public.film", description: "The films the actor plays in" } } },
        { op: "add_column", args: { table: "film", column: { name: "cast", type: "list", items: "link", ref: "main.public.actor", inverse: "films", description: "The actors in the film" } } },
        { op: "update_row", args: { table: "film", path: `${FILM}/Charade.md`, set: { cast: ["[[Cary Grant]]", "[[Audrey Hepburn]]"] } }, showFile: `${FILM}/Charade.md` },
        { say: "The same write added the film to both actors, in one operation with one undo:", op: "read_note", args: { path: "datanotes/main/public/actor/Cary Grant.md" } },
        { say: "One wrong item makes the engine refuse the whole list:", op: "update_row", args: { table: "film", path: `${FILM}/His Girl Friday.md`, set: { cast: ["[[Cary Grant]]", "[[Charade]]"] } }, refused: true },
        { op: "update_row", args: { table: "film", path: `${FILM}/His Girl Friday.md`, set: { cast: ["[[Cary Grant]]", "[[Rosalind Russell]]"] } }, quiet: true },
      ],
    },
    {
      title: "Read linked rows in the same call",
      say: "`expand` replaces each link with the linked row’s columns, so one call returns the films with their actors.",
      steps: [
        { op: "select_rows", args: { table: "film", columns: ["title", "cast"], expand: ["cast"], where: { title: "Charade" } } },
      ],
    },
    {
      title: "Filter rows by a link",
      say: "`contains` matches a list that holds the link, which you write with the note’s name.",
      steps: [
        { op: "select_rows", args: { table: "film", columns: ["title"], where: { cast: { contains: "[[Cary Grant]]" } } }, check: (v) => v.total !== 2 && "two films expected" },
        {
          say: "A dotted key follows the link and filters on a column of the linked row. Here it finds the actors of a film released after 1950:",
          op: "select_rows",
          args: { table: "actor", columns: ["name"], where: { "films.year": { gt: 1950 } } },
          check: (v) => v.total !== 2 && "two actors expected",
        },
        { say: "`film.minutes` finds the viewings of films longer than 100 minutes:", op: "select_rows", args: { table: "watch", columns: ["film", "where"], where: { "film.minutes": { gt: 100 } } }, check: (v) => v.total !== 1 && "one viewing expected" },
      ],
    },
    {
      title: "Count rows across a list of links",
      say: "`group_by` on a list column counts each item once, so a film with two actors counts for both, and Cary Grant’s group holds two films. Night of the Living Dead has no cast here, so it falls in the `null` group.",
      steps: [
        { op: "select_rows", args: { table: "film", group_by: "cast", aggregates: { films: "count", minutes: "sum:minutes" } } },
      ],
    },
    {
      title: "Join two tables on matching values",
      say: "`join` attaches the rows of another table whose columns match. Here each film gets its viewings: the viewing’s `film` link matches the film’s own link, `file_link`.",
      steps: [
        {
          op: "select_rows",
          args: { table: "film", columns: ["title"], join: { table: "watch", on: { file_link: "film" }, as: "viewings", type: "left", columns: ["where", "occurred_at"] } },
        },
      ],
    },
    {
      title: "Repair two-way links with `align_relations`",
      say: "Writes through the engine keep both sides of an `inverse` link in step, and the engine mirrors links you edit by hand about 2s later. When you declare `inverse` on data that already exists, `align_relations` adds the missing reciprocal links. `check_table` reports the missing ones first, with code `inverse`.",
      steps: [
        { op: "add_column", args: { table: "film", column: { name: "see_also", type: "list", items: "link", ref: "self", description: "Films to watch next if I liked this one" } }, quiet: true },
        { op: "update_row", args: { table: "film", path: `${FILM}/Charade.md`, set: { see_also: ["[[His Girl Friday]]"] } }, quiet: true },
        { say: "Charade points to His Girl Friday, but His Girl Friday doesn’t point back. Declare `see_also` symmetric:", op: "alter_column", args: { table: "film", column: "see_also", changes: { inverse: "see_also" } } },
        { op: "check_table", args: { table: "film" } },
        { op: "align_relations", args: { table: "film" } },
        { op: "select_rows", args: { table: "film", columns: ["title", "see_also"] } },
      ],
    },
    {
      title: "Take allowed values from another table",
      say: "`vocabulary` limits a text column, or a list of text, to the names of another table’s rows, without links. Each value must be the `name` of a row of that table, so adding a row to the vocabulary table adds an allowed value.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "tag",
            description: "Words I tag films with",
            columns: [{ name: "name", type: "string", required: true, unique: true, description: "The tag, as I write it" }],
            filename: "{name}",
          },
          quiet: true,
        },
        { op: "insert_row", args: { table: "tag", values: { name: "funny" } }, quiet: true },
        { op: "insert_row", args: { table: "tag", values: { name: "rewatch" } }, quiet: true },
        { op: "add_column", args: { table: "film", column: { name: "tags", type: "list", items: "string", vocabulary: "main.public.tag", description: "My tags for the film, from the tag table" } } },
        { op: "update_row", args: { table: "film", path: `${FILM}/His Girl Friday.md`, set: { tags: ["funny", "fast talk"] } }, refused: true },
        { op: "insert_row", args: { table: "tag", values: { name: "fast talk" } }, quiet: true },
        { say: "Once you add `fast talk` to the tag table, the same write goes through:", op: "update_row", args: { table: "film", path: `${FILM}/His Girl Friday.md`, set: { tags: ["funny", "fast talk"] } } },
      ],
    },
    {
      title: "Build a tree of rows with a parent link",
      say: "`hierarchy: true` makes a link column a parent link to the same table (`ref: self`). A row can never be its own ancestor. The `within` filter on the parent column returns every row below a given one, at any depth. Here the genres form a tree: Cinema holds the sound era, which holds screwball comedy.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "genre",
            description: "Eras and genres of cinema, as a tree",
            columns: [
              { name: "name", type: "string", required: true, description: "The name of the era or genre" },
              { name: "kind", type: "enum", values: ["cinema", "era", "genre"], required: true, description: "The level in the tree: cinema, an era or a genre" },
              { name: "parent", type: "link", ref: "self", hierarchy: true, description: "The era or cinema one level up" },
            ],
            filename: "{name}",
          },
        },
        { op: "insert_row", args: { table: "genre", values: { name: "Cinema", kind: "cinema" } }, quiet: true },
        { op: "insert_row", args: { table: "genre", values: { name: "Sound film", kind: "era", parent: "[[Cinema]]" } }, quiet: true },
        { op: "insert_row", args: { table: "genre", values: { name: "Screwball comedy", kind: "genre", parent: "[[Sound film]]" } }, quiet: true },
        { op: "select_rows", args: { table: "genre", columns: ["name", "parent"], where: { parent: { within: "[[Cinema]]" } } }, check: (v) => v.total !== 2 && "two genres expected" },
        { say: "The engine refuses a loop:", op: "update_row", args: { table: "genre", path: `${GENRE}/Cinema.md`, set: { parent: "[[Screwball comedy]]" } }, refused: true },
      ],
    },
    {
      title: "Keep dependencies free of cycles with `acyclic`",
      say: [
        "`acyclic: true` keeps the links of a column free of cycles. It works on a link, or a list of links, to the same table (`ref: self`). Here `watch_after` lists the films to watch first, and `watch_before` is its inverse.",
        "",
        "The engine refuses a write that closes a cycle:",
        "",
        "- **Through the column**: a film can’t wait for a film that already waits for it",
        "- **Through the inverse**: `watch_before` adds the matching `watch_after` link, and the engine checks that link too",
        "- **On existing rows**: `alter_column` refuses `acyclic: true` while rows already form a cycle, and lists them",
        "",
        "`hierarchy` refuses cycles too, but takes one parent per row. `acyclic` takes any number of links.",
      ].join("\n"),
      steps: [
        { op: "add_column", args: { table: "film", column: { name: "watch_after", type: "list", items: "link", ref: "self", acyclic: true, description: "Films to watch before this one" } } },
        { op: "add_column", args: { table: "film", column: { name: "watch_before", type: "list", items: "link", ref: "self", inverse: "watch_after", description: "Films to watch after this one" } }, quiet: true },
        { op: "update_row", args: { table: "film", path: `${FILM}/Night of the Living Dead.md`, set: { watch_after: ["[[Charade]]"] } }, quiet: true },
        { op: "update_row", args: { table: "film", path: `${FILM}/Charade.md`, set: { watch_after: ["[[His Girl Friday]]"] } }, quiet: true },
        { say: "His Girl Friday can’t wait for Night of the Living Dead, which waits for it through Charade:", op: "update_row", args: { table: "film", path: `${FILM}/His Girl Friday.md`, set: { watch_after: ["[[Night of the Living Dead]]"] } }, refused: true },
        { say: "Setting the inverse closes the same cycle, so the engine refuses it too:", op: "update_row", args: { table: "film", path: `${FILM}/Night of the Living Dead.md`, set: { watch_before: ["[[His Girl Friday]]"] } }, refused: true },
      ],
    },
    {
      title: "Write a CHECK rule that follows links",
      say: [
        "A CHECK constraint is a rule every row must satisfy, and you add one with `add_constraint`. It can follow a link the way a query does: `parent.kind` is the `kind` of the row that `parent` names. Here a genre’s parent must be an era, an era’s parent must be Cinema, and Cinema has no parent.",
        "",
        "A rule treats links as follows:",
        "",
        "- **Empty link**: passes at the top level of a rule and fails inside `or`, `and` and `not`; on a longer path such as `parent.parent.kind`, the rule skips only an empty first link",
        "- **Link to a row that doesn’t exist**: fails, so it passes inside `not`",
        "- **List of links**: every linked row must match",
        "- **Resolution**: links resolve as in the vault, by path from the row’s note",
      ].join("\n"),
      steps: [
        {
          op: "add_constraint",
          args: {
            table: "genre",
            name: "parent_by_level",
            check: {
              or: [
                { kind: "cinema", parent: { exists: false } },
                { kind: "era", "parent.kind": "cinema" },
                { kind: "genre", "parent.kind": "era" },
              ],
            },
          },
        },
        { say: "The engine refuses a genre straight under Cinema:", op: "insert_row", args: { table: "genre", values: { name: "Horror", kind: "genre", parent: "[[Cinema]]" } }, refused: true },
        {
          say: "When a write changes a linked row, the engine checks the rows that link to it again. Sound film can’t become a top level like Cinema while a genre hangs from it, and the refusal lists Screwball comedy, naming Sound film.",
          op: "update_row",
          args: { table: "genre", path: `${GENRE}/Sound film.md`, set: { kind: "cinema" }, unset: ["parent"] },
          refused: true,
        },
        {
          say: "In a `batch`, add the era first and then its genre. The engine checks each step against the vault as the earlier steps left it, so Slapstick comedy finds its parent.",
          op: "batch",
          args: {
            summary: "add the silent era and slapstick comedy",
            operations: [
              { op: "insert_row", table: "genre", values: { name: "Silent cinema", kind: "era", parent: "[[Cinema]]" } },
              { op: "insert_row", table: "genre", values: { name: "Slapstick comedy", kind: "genre", parent: "[[Silent cinema]]" } },
            ],
          },
        },
        { op: "select_rows", args: { table: "genre", columns: ["name", "kind", "parent"], order_by: "name" } },
        {
          say: "Renaming a row that other rows link to keeps the rule valid, because the links follow the row. Here Slapstick comedy follows the era to its new name, Silent film.",
          op: "update_row",
          args: { table: "genre", path: `${GENRE}/Silent cinema.md`, set: { name: "Silent film" } },
        },
        { op: "select_rows", args: { table: "genre", columns: ["name", "parent"], where: { "parent.kind": "era" }, order_by: "name" } },
      ],
    },
    {
      title: "Catch hand edits that break a rule",
      say: [
        "The engine can’t refuse an edit made outside it, in an editor, through git or by a sync tool. Instead, it checks the edit as soon as it sees it, as `check_table` would:",
        "",
        "- **The row’s own rules**: types, enums, required columns, links, CHECKs and filtered link targets",
        "- **Rows that link to it**: when a rule follows links to the edited row",
        "- **Dangling links**: when you delete or rename a row by hand, the engine reports the links it leaves dangling",
        "",
        "The engine reports what the edit breaks in three places:",
        "",
        "- **Change feed**: the event lists the problems in `violations`, where `constraint` names a CHECK; the event leaves out rules the row already broke",
        "- **Log**: a WARN line",
        "- **History**: when history is on, the `EXTERNAL_EDIT` version counts them in `operation_metrics.violations`",
        "",
        "Here you turn Silent film into a top level by hand, with `kind: cinema`. It keeps a parent, and Slapstick comedy now hangs from a top level.",
      ].join("\n"),
      steps: [
        {
          say: "First, wait until the change feed includes the rename’s rewrite of Slapstick comedy’s link, and keep the feed’s position:",
          op: "list_changes",
          args: { tables: ["genre"], wait_ms: 10000 },
          until: (v) => v.events.some((e: { path: string; row?: { parent?: string } }) => e.path.endsWith("/Slapstick comedy.md") && e.row?.parent === "[[Silent film]]"),
          save: "feed",
          quiet: true,
        },
        { edit: { path: SILENT, text: (t) => t.replace("kind: era", "kind: cinema") }, wait: 0 },
        {
          say: "Read the hand edit’s event. `list_changes` long-polls with `wait_ms` until the event arrives:",
          op: "list_changes",
          args: (ctx) => ({ since: ctx.saved.feed.head, tables: ["genre"], wait_ms: 10000 }),
          until: (v) => handEdits(v).some((e) => e.violations !== undefined),
          check: (v) =>
            !(handEdits(v).length === 1 && handEdits(v)[0]!.violations?.flatMap((r) => r.violations).filter((x) => x.constraint === "parent_by_level").length === 2) &&
            "one event with two parent_by_level violations expected",
          show: (v) => handEdits(v).map((e) => ({ seq: e.seq, kind: e.kind, path: e.path, source: e.source, changes: e.changes, violations: e.violations })),
        },
        {
          say: "The rows stay as they are until you fix them. `check_table` lists the rows that are invalid now, and without `table` it checks every table:",
          op: "check_table",
          args: {},
          check: (v) => !JSON.stringify(v).includes("parent_by_level") && "the CHECK's violations expected",
        },
        { say: "Fix the row through the engine:", op: "update_row", args: { table: "genre", path: SILENT, set: { kind: "era" } } },
      ],
    },
    {
      title: "Limit link targets with `ref_by` and `ref_where`",
      say: [
        "A link column can limit which rows it points to, without a CHECK. `ref_by` reads a column of the row itself. With `levels: [cinema, era, genre]`, Cinema has no parent, an era’s parent must be Cinema, and a genre’s parent must be an era.",
        "",
        "These are the levels of the CHECK above, which stays. Each refusal below names both rules, and the `ref_by` one also lists the valid parents.",
        "",
        "`describe_table` shows the expanded `map`. You can also write `map` directly, with `null` for a top level.",
        "",
        "`ref_where` is a `where` filter that every linked row must match. The engine checks writes as it does for CHECKs that follow links, including the rows that link to a changed row.",
      ].join("\n"),
      steps: [
        {
          op: "alter_column",
          args: { table: "genre", column: "parent", changes: { ref_by: { column: "kind", levels: ["cinema", "era", "genre"] } } },
        },
        { op: "describe_table", args: { table: "genre" }, show: (v) => v.columns.find((c: { name: string }) => c.name === "parent") },
        { say: "A genre needs a parent, and the refusal (`required`) says why:", op: "update_row", args: { table: "genre", path: `${GENRE}/Slapstick comedy.md`, unset: ["parent"] }, refused: true },
        { say: "The engine refuses a parent of the wrong level and lists the valid ones:", op: "update_row", args: { table: "genre", path: `${GENRE}/Slapstick comedy.md`, set: { parent: "[[Cinema]]" } }, refused: true },
        {
          say: "`list_link_targets` returns the valid targets for a row before you write it, so an agent or a picker offers only those:",
          op: "list_link_targets",
          args: { table: "genre", column: "parent", values: { kind: "genre" } },
          check: (v) => v.total !== 2 && "two eras expected",
        },
        { say: "Silent film can’t become a top level while a genre hangs from it:", op: "update_row", args: { table: "genre", path: SILENT, set: { kind: "cinema" }, unset: ["parent"] }, refused: true },
        {
          say: "A new `genre` column on `film` uses `ref_where`, so a film links to a genre, never to an era or to Cinema:",
          op: "add_column",
          args: { table: "film", column: { name: "genre", type: "link", ref: "main.public.genre", ref_where: { kind: "genre" }, description: "The film's genre" } },
        },
        { op: "list_link_targets", args: { table: "film", column: "genre" }, check: (v) => v.total !== 2 && "two genres expected" },
      ],
    },
    {
      title: "Compute a link from other columns",
      say: "A generated link column builds its link from a template. `link({occurred_at:YYYY-MM-DD})`, with `ref` set to a table of days, links each viewing to its day’s note. That note may not exist yet; the link resolves once it does.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "day",
            description: "One note per day of my diary",
            columns: [{ name: "date", type: "date", required: true, description: "The day the note is about" }],
            time_column: "date",
            filename: "{date:YYYY-MM-DD}",
          },
          quiet: true,
        },
        { op: "add_column", args: { table: "watch", column: { name: "on_day", type: "link", ref: "main.public.day", generated: "link({occurred_at:YYYY-MM-DD})", description: "The diary note of the day I watched the film" } } },
        { op: "insert_row", args: { table: "watch", values: { film: "[[Night of the Living Dead]]", where: "cinema", place: "the film club downtown", with: "my sister", occurred_at: "2026-10-31T23:00" }, body: "A late show. Half the hall jumped at the same moment.\n" }, save: "w2", showFile: (ctx) => ctx.saved.w2.planned_creates[0] },
      ],
    },
    {
      title: "Delete a row that other notes link to",
      say: [
        "`on_referenced` tells `delete_rows` what to do with links to the rows it deletes:",
        "",
        "- **`\"restrict\"`**: the default; refuses rows that other notes link to",
        "- **`\"set_null\"`**: clears those links, but refuses a required one, like `ON DELETE SET NULL` on a `NOT NULL` column in Structured Query Language (SQL)",
        "- **`\"ignore\"`**: leaves the links dangling",
      ].join("\n"),
      steps: [
        { op: "delete_rows", args: { table: "film", where: { title: "Charade" } }, refused: true },
        { say: "Charade’s viewing needs its `film`, so the engine also refuses to clear the link:", op: "delete_rows", args: { table: "film", where: { title: "Charade" }, on_referenced: "set_null" }, refused: true },
        {
          say: "Delete the viewing and the film together with `batch`. The viewing goes first, then `set_null` clears Charade from Cary Grant’s `films`. If the engine refused any step, it would apply none of them.",
          op: "batch",
          args: {
            summary: "remove Charade and its viewing",
            operations: [
              { op: "delete_rows", table: "watch", where: { film: "[[Charade]]" } },
              { op: "delete_rows", table: "film", where: { title: "Charade" }, on_referenced: "set_null" },
            ],
          },
        },
        { op: "read_note", args: { path: "datanotes/main/public/actor/Cary Grant.md" } },
      ],
    },
    {
      title: "See the relations in `metastore.yaml`",
      say: [
        "The engine wrote this file with the relations from this page:",
        "",
        "- **Link columns**: each with its `ref`, and `self` kept as written",
        "- **`inverse`**: on one side only",
        "- **`vocabulary`, `hierarchy`, `acyclic` and `ref_where`**: as declared",
        "- **`ref_by`**: with the `levels` shortcut kept as written",
        "- **Generated link**: the `on_day` column with its template",
      ].join("\n"),
      steps: [{ showFile: "datanotes/metastore.yaml" }],
    },
  ],
};

export default chapter;
