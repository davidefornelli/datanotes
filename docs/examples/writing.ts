import type { Chapter } from "./types";

const FILM = "datanotes/main/public/film";
const SHERLOCK = `${FILM}/Sherlock Jr..md`;

const chapter: Chapter = {
  slug: "writing",
  title: "Writing rows",
  setup: [
    {
      op: "create_table",
      args: {
        name: "film",
        columns: [
          { name: "title", type: "string", required: true, unique: true, description: "The film's title, as on its poster" },
          { name: "year", type: "integer", description: "Year the film first came out" },
          { name: "status", type: "enum", values: ["to watch", "watched"], ordered: true, default: "to watch", description: "Where the film is on my list" },
          { name: "rating", type: "integer", min: 1, max: 5, description: "My rating, from 1 (poor) to 5 (a masterpiece)" },
          { name: "tags", type: "list", items: "string", description: "Words I file the film under" },
        ],
        filename: "{title}", description: "Classic films I watched or want to watch",
      },
    },
    { op: "insert_row", args: { table: "film", values: { title: "Nosferatu", year: 1922, status: "watched", rating: 5 }, body: "## Notes\n\nMax Schreck doesn’t need a single word.\n\n## Rewatch\n\nNot yet.\n" } },
    { op: "insert_row", args: { table: "film", values: { title: "His Girl Friday", year: 1940 } } },
    { op: "insert_row", args: { table: "film", values: { title: "Sherlock Jr.", year: 1924 } } },
    { op: "insert_row", args: { table: "film", values: { title: "Charade", year: 1963 } } },
    { op: "insert_row", args: { table: "film", values: { title: "Metropolis", year: 1927 } } },
  ],
  examples: [
    {
      title: "Update one row",
      say: "`update_row` changes exactly one row, which you address by `path` or by its `id`. `set` sets columns and `unset` removes them. The engine checks the whole row before it writes anything.",
      steps: [
        { op: "update_row", args: { table: "film", path: `${FILM}/His Girl Friday.md`, set: { status: "watched", rating: 5, tags: ["screwball"] } } },
        { op: "update_row", args: { table: "film", path: `${FILM}/His Girl Friday.md`, unset: ["tags"] }, quiet: true },
        { say: "The engine refuses a path that isn’t a row, and creates nothing:", op: "update_row", args: { table: "film", path: `${FILM}/Night of the Living Dead.md`, set: { rating: 4 } }, refused: true },
      ],
    },
    {
      title: "Edit a note’s text",
      say: [
        "`update_row` edits the note’s text with these arguments:",
        "",
        "- **`body_sections`**: replaces the text under one heading and leaves the rest of the note alone; the engine adds a missing heading at the end",
        "- **`body_append`** and **`body_prepend`**: add text after or before the existing text",
        "- **`body`**: replaces all of the text",
      ].join("\n"),
      steps: [
        {
          op: "update_row",
          args: {
            table: "film",
            path: `${FILM}/Nosferatu.md`,
            body_sections: { Rewatch: "Watched it again in October. The shadow on the stairs still works a century later." },
            body_append: "Next: Metropolis, for more German Expressionism.\n",
          },
          showFile: `${FILM}/Nosferatu.md`,
        },
      ],
      after: "The engine links Metropolis, the note of another film, and lists the link in `links_added`. [Automatic links](/guides/read-and-write/automatic-links/) shows which names it links.",
    },
    {
      title: "Guard a write against concurrent edits with `expect`",
      say: "A person may edit a note between an agent’s read and its write. `expect` makes the write a compare-and-set: it goes through only if the row still has those values.",
      steps: [
        { op: "update_row", args: { table: "film", path: SHERLOCK, expect: { status: "to watch" }, set: { status: "watched" } } },
        { say: "Run the same call again. `status` is no longer `to watch`, so the engine writes nothing.", op: "update_row", args: { table: "film", path: SHERLOCK, expect: { status: "to watch" }, set: { status: "watched" } }, refused: true },
      ],
    },
    {
      title: "Update many rows",
      say: "`update_rows` changes every row matching `where`. `expect_count` guards the write: the engine refuses it unless exactly that many rows match, so a filter that’s too broad changes nothing.",
      steps: [
        { op: "update_rows", args: { table: "film", where: { status: "watched" }, set: { tags: ["seen-2026"] }, expect_count: 2 }, refused: true },
        { op: "update_rows", args: { table: "film", where: { status: "watched" }, set: { tags: ["seen-2026"] }, expect_count: 3 } },
      ],
    },
    {
      title: "Insert or update rows with `merge_rows`",
      say: "`merge_rows` is an upsert: it inserts rows or updates existing ones. A row whose `on` columns match an existing row updates that row, and the engine inserts the others. The whole merge is one operation with one undo.",
      steps: [
        {
          op: "merge_rows",
          args: {
            table: "film",
            on: ["title"],
            rows: [
              { title: "Sherlock Jr.", rating: 4 },
              { title: "Battleship Potemkin", year: 1925 },
            ],
          },
        },
        { op: "select_rows", args: { table: "film", columns: ["title", "rating", "status"], where: { title: { in: ["Sherlock Jr.", "Battleship Potemkin"] } } } },
      ],
    },
    {
      title: "Pick a free file name for a new row",
      say: [
        "Without `path`, the table’s filename pattern names the new note. When another note has that name, the engine adds `-2`, `-3` and so on.",
        "",
        "A `path` you pass must be free. Windows and macOS see `Nosferatu.md` and `nosferatu.md` as one file. So on every system, the engine refuses a name that another note has in another case, and names that note:",
      ].join("\n"),
      steps: [
        {
          op: "insert_row",
          args: { table: "film", values: { title: "The Kid", year: 1921 }, path: `${FILM}/nosferatu.md` },
          refused: true,
          check: (v) => !JSON.stringify(v).includes(`${FILM}/Nosferatu.md`) && "the refusal should name Nosferatu.md",
        },
      ],
    },
    {
      title: "Delete rows into the archive",
      say: "By default, `delete_rows` moves the matching rows to the table’s archive folder, so you lose nothing. `mode: \"delete\"` moves them to the trash instead, and the journal keeps their content for undo. Always pass `where`: without it, every row matches.",
      steps: [
        { op: "delete_rows", args: { table: "film", where: { title: "Battleship Potemkin" } } },
        { op: "list_folder", args: { folder: `${FILM}/_archive` } },
      ],
    },
    {
      title: "Undo a write",
      say: "Every write returns a `migration_id`. `list_migrations` lists them, newest first, with who made each one, and `undo_migration` reverts one.",
      steps: [
        { op: "list_migrations", args: { table: "film", limit: 3 }, save: "m" },
        { op: "undo_migration", args: (ctx) => ({ migration_id: ctx.saved.m.migrations[0].migration_id }) },
        { op: "select_rows", args: { table: "film", columns: ["title"], where: { title: "Battleship Potemkin" } }, say: "Battleship Potemkin is back:", check: (v) => v.total !== 1 && "the row should be back" },
      ],
    },
    {
      title: "Undo refuses to overwrite later changes",
      say: "An undo never overwrites later work. The engine compares the values the operation wrote with the notes as they are now. If one of those values changed since, the engine refuses the undo and lists the changes. Changes to other columns don’t block the undo, and the engine keeps them.",
      steps: [
        { op: "update_row", args: { table: "film", path: SHERLOCK, set: { rating: 5 } }, save: "u" },
        { say: "Then someone changes the rating again:", op: "update_row", args: { table: "film", path: SHERLOCK, set: { rating: 4 } }, quiet: true },
        { op: "undo_migration", args: (ctx) => ({ migration_id: ctx.saved.u.migration_id }), refused: true },
        { say: "The undo of an insert trashes the new note only while it’s as the insert left it:", op: "insert_row", args: { table: "film", values: { title: "The General", year: 1926 } }, save: "ins", quiet: true },
        { op: "update_row", args: (ctx) => ({ table: "film", path: ctx.saved.ins.planned_creates[0], body: "Buster Keaton drives a locomotive.\n" }), quiet: true },
        { op: "undo_migration", args: (ctx) => ({ migration_id: ctx.saved.ins.migration_id }), refused: true },
      ],
    },
    {
      title: "Group several writes with `batch`",
      say: "`batch` runs writes in order, and each write sees the ones before it. If the engine refuses one, it undoes those already applied and leaves nothing written. The whole batch has one `migration_id`.",
      steps: [
        {
          op: "batch",
          args: {
            summary: "watch Charade, add Night of the Living Dead, rate Sherlock Jr.",
            operations: [
              { op: "update_row", table: "film", path: `${FILM}/Charade.md`, set: { status: "watched", rating: 4 } },
              { op: "insert_row", table: "film", values: { title: "Night of the Living Dead", year: 1968 } },
              { op: "update_row", table: "film", path: SHERLOCK, set: { rating: 9 } },
            ],
          },
          refused: true,
        },
        {
          say: "The engine refused the third write (`rating` is at most 5), so it undid the first two:",
          op: "select_rows",
          args: { table: "film", columns: ["title", "status"], where: { title: { in: ["Charade", "Night of the Living Dead"] } } },
          check: (v) => !(v.total === 1 && v.rows[0].status === "to watch") && "only Charade, unchanged",
        },
        { say: "`dry_run: true` checks a batch without writing it. Without the bad write, the batch goes through:", op: "batch", args: { dry_run: true, operations: [{ op: "update_row", table: "film", path: `${FILM}/Charade.md`, set: { status: "watched", rating: 4 } }, { op: "insert_row", table: "film", values: { title: "Night of the Living Dead", year: 1968 } }] } },
      ],
    },
    {
      title: "Move rows to another table",
      say: "`move_rows` moves rows to another table. During the move, it can `rename` keys, `set` values and `drop` keys, and it checks every row against the destination first. The engine reports keys the destination doesn’t know and never drops them silently. `relocate: true` also moves the notes to the destination’s folder.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "watchlist",
            description: "Films I plan to watch soon",
            columns: [
              { name: "title", type: "string", required: true, description: "The film's title" },
              { name: "released", type: "integer", description: "Year the film came out" },
            ],
            filename: "{title}",
          },
          quiet: true,
        },
        { op: "move_rows", args: { table: "film", to_table: "watchlist", where: { status: "to watch" }, relocate: true }, refused: true },
        { say: "The watchlist has no `status`, `tags` or `rating` column, so the call drops them, and `year` becomes `released`:", op: "move_rows", args: { table: "film", to_table: "watchlist", where: { status: "to watch" }, rename: { year: "released" }, drop: ["status", "tags", "rating"], relocate: true } },
      ],
    },
    {
      title: "Find rows that break the schema",
      say: [
        "The engine can’t refuse a hand edit, so a note you edit by hand can break the schema. `check_table` validates every row against these rules:",
        "",
        "- **Values**: types, ranges and enums",
        "- **Presence**: required columns and unknown keys",
        "- **Relations and rules**: links and constraints",
      ].join("\n"),
      steps: [
        { edit: { path: `${FILM}/His Girl Friday.md`, text: "---\ntable: main.public.film\nid: 01a0f000-0000-7000-8000-0000000000bb\ntitle: His Girl Friday\nyear: 1940\nstatus: finished\nrating: 6\nformat: Blu-ray\n---\n" } },
        { op: "check_table", args: { table: "film" } },
      ],
    },
    {
      title: "Find rows whose front matter can’t be read",
      say: [
        "A hand edit can break a note’s YAML, such as a title with a colon in it. The engine can’t read the row any more, so `select_rows` and every other read leave it out. The engine reports it in three places instead:",
        "",
        "- **Change feed**: an event of kind `unreadable`",
        "- **`check_table`**: a violation with code `unreadable`",
        "- **`describe_database`**: the table’s `unreadable_count`",
        "",
        "Here you give Sherlock Jr. a title with a colon by hand.",
      ].join("\n"),
      steps: [
        { op: "list_changes", args: { tables: ["film"] }, save: "feed", quiet: true },
        { edit: { path: SHERLOCK, text: (t) => t.replace(/^title: .*$/m, "title: Sherlock Jr.: the projectionist") } },
        {
          say: "The change feed reports the broken note:",
          op: "list_changes",
          args: (ctx) => ({ since: ctx.saved.feed.head, tables: ["film"], kinds: ["unreadable"], wait_ms: 10000 }),
          until: (v) => v.events.length > 0,
          show: (v) => v.events.map((e: { kind: string; path: string; violations: unknown }) => ({ kind: e.kind, path: e.path, violations: e.violations })),
        },
        {
          say: "`check_table` lists it with the rows that break the schema:",
          op: "check_table",
          args: { table: "film" },
          check: (v) => !v.violations.some((r: { path: string; violations: { code: string }[] }) => r.path === SHERLOCK && r.violations[0]!.code === "unreadable") && "Sherlock Jr. should be unreadable",
          show: (v) => v.violations.filter((r: { path: string }) => r.path === SHERLOCK),
        },
        {
          say: "`describe_database` counts it apart from `row_count`:",
          op: "describe_database",
          args: {},
          check: (v) => v.catalogs[0].schemas[0].tables.find((t: { name: string }) => t.name === "film")?.unreadable_count !== 1 && "one unreadable film expected",
          show: (v) => v.catalogs[0].schemas[0].tables.find((t: { name: string }) => t.name === "film"),
        },
        { say: "Quote the title to fix the note. The row is back:", edit: { path: SHERLOCK, text: (t) => t.replace("title: Sherlock Jr.: the projectionist", 'title: "Sherlock Jr.: the projectionist"') } },
        { op: "select_rows", args: { table: "film", columns: ["title"], where: { title: { contains: "Sherlock" } } }, check: (v) => v.total !== 1 && "the row should be back" },
      ],
    },
  ],
};

export default chapter;
