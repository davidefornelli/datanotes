import type { Chapter } from "./types";

/** What each column of the inferred film table holds: the descriptions the proposal leaves null. */
const FILM_COLUMNS: Record<string, string> = {
  year: "Year the film first came out",
  minutes: "Running time in minutes",
  status: "Where the film is on my list",
  rating: "My rating, from 1 (poor) to 5 (a masterpiece)",
  watched_on: "The day I last watched it",
  director: "Who directed the film",
};

const chapter: Chapter = {
  slug: "importing",
  title: "Bringing existing notes in",
  files: {
    "Films/Nosferatu.md": "---\nyear: 1922\nminutes: 94\nstatus: watched\nrating: 5\nwatched_on: 2026-03-14\nDirector: F. W. Murnau\n---\nThe shadow on the stairs still works a century later.\n",
    "Films/The Gold Rush.md": "---\nyear: 1925\nminutes: 95\nstatus: watched\nrating: 5\nwatched_on: 2026-05-02\nDirector: Charlie Chaplin\n---\nThe dance of the bread rolls gets me every time.\n",
    "Films/Metropolis.md": "---\nyear: 1927\nminutes: 153\nstatus: to watch\nDirector: Fritz Lang\n---\n",
    "Films/His Girl Friday.md": "---\nyear: 1940\nminutes: 92\nstatus: watched\nrating: 5\nwatched_on: 2026-07-20\nDirector: Howard Hawks\n---\nThe fastest dialogue I’ve ever heard.\n",
    "Films/Charade.md": "---\nyear: 1963\nminutes: 113\nstatus: watched\nrating: 4\nwatched_on: 2026-09-12\nDirector: Stanley Donen\n---\nCary Grant again, twenty years after [[His Girl Friday]], and just as quick.\n",
  },
  examples: [
    {
      title: "Infer a table from notes",
      say: "`infer_table` reads the notes’ front matter and proposes a table, without writing anything. The proposal has:\n\n- **A type for each key**: an enum when a few short values repeat across enough notes\n- **Shared keys**: which front matter keys every note has\n- **Valid column names**: a key whose name isn’t a valid column name, like `Director`, gets a valid name and a `from`",
      steps: [{ op: "infer_table", args: { folder: "Films", name: "film" }, save: "inf" }],
      after: "Read the proposal and its `notes` before you use it. The notes can’t say what the table and its columns mean. So `description` is `null` on the table and on every column, for you to write. Here five columns also need a fix:\n\n- **`year`**, **`minutes`** and **`director`**: came out `unique` because no two of these films share them, which won’t stay true\n- **`status`**: an enum with its values in the order the notes gave them, `watched` first, where you want an ordered enum from `to watch` to `watched`\n- **`rating`**: an integer with no range, where you want 1 to 5\n- **`title`**: missing, because the notes keep the title in the note’s name, not in the front matter",
    },
    {
      title: "Create the table from the proposal",
      say: "`create_table` refuses the proposal as it is, because its descriptions are `null`. The refusal names every one you still have to write:",
      steps: [
        { op: "create_table", args: (ctx) => ctx.saved.inf.proposal, refused: true },
        {
          say: "This call adds a description to the table and to each column, and corrects what the inference guessed wrong:\n\n- **`year`**, **`minutes`** and **`director`**: no longer unique\n- **`status`**: an ordered enum (`to watch` < `watched`)\n- **`rating`**: from 1 to 5\n- **`title`**: a new column that holds the note’s file name (`identity: \"filename\"`)",
          op: "create_table",
          args: (ctx) => ({
            name: "film",
            description: "Classic films I watched or want to watch",
            columns: [
              { name: "title", type: "string", identity: "filename", description: "The film's title, which is also its note's name" },
              ...ctx.saved.inf.proposal.columns.map((c: Record<string, unknown>) => {
                const fixed =
                  c.name === "rating"
                    ? { name: "rating", type: "integer", min: 1, max: 5 }
                    : c.name === "status"
                      ? { ...c, type: "enum", values: ["to watch", "watched"], ordered: true }
                      : c.name === "year" || c.name === "minutes" || c.name === "director"
                        ? { ...c, unique: false }
                        : c;
                return { ...fixed, description: FILM_COLUMNS[String(c.name)] };
              }),
            ],
            filename: "{title}",
          }),
        },
      ],
    },
    {
      title: "Preview the adoption with a dry run",
      say: "`adopt_rows` makes existing notes rows of a table and keeps their text and links. It sets `table` and an `id` on each note, and applies these arguments:\n\n- **`rename`**: renames front matter keys to column names\n- **`set`**: sets the same values on every note\n- **`drop`**: removes the front matter keys the table doesn’t have\n- **`relocate`**: moves the notes to the table’s folder and rewrites the links to them\n\nWith `dry_run`, it shows what it would do and writes nothing.",
      steps: [
        {
          op: "adopt_rows",
          args: (ctx) => ({ table: "film", paths: ctx.saved.inf.adopt.paths, rename: ctx.saved.inf.adopt.rename, relocate: true, dry_run: true }),
        },
      ],
    },
    {
      title: "Adopt the notes into the table",
      say: "This is the same call without `dry_run`. The engine checks every note first: a note that doesn’t fit the table stops the whole adoption, and the answer lists why.\n\nWith thousands of notes, adopt them in calls of about 1,000 `paths` each. Each call is one journal entry, so a stop or a crash interrupts less, and `undo_migration` reverts one chunk at a time.",
      steps: [
        { op: "adopt_rows", args: (ctx) => ({ table: "film", paths: ctx.saved.inf.adopt.paths, rename: ctx.saved.inf.adopt.rename, relocate: true }) },
        { say: "The notes keep their text and names, so `[[His Girl Friday]]` in Charade still resolves:", op: "read_note", args: { path: "datanotes/main/public/film/Charade.md" } },
        { op: "select_rows", args: { table: "film", columns: ["title", "status", "rating"], order_by: "title" } },
      ],
    },
    {
      title: "Insert new rows through the engine",
      say: "`title` is the note’s file name (`identity: \"filename\"`). When you give it at insert, it names the new note, and the engine then keeps it equal to the note’s actual name.",
      steps: [
        { op: "insert_row", args: { table: "film", values: { title: "Battleship Potemkin", year: 1925, minutes: 75, director: "Sergei Eisenstein", status: "to watch" } } },
      ],
    },
    {
      title: "Find front matter keys the table doesn’t declare",
      say: "Suppose someone later adds a front matter key by hand. `infer_table` with a `table` lists the keys its rows use that the table doesn’t declare. Add them with `add_column`, or remove them from the rows.",
      steps: [
        { edit: { path: "datanotes/main/public/film/Metropolis.md", text: (t) => t.replace("status: to watch", "status: to watch\ncast:\n  - \"[[Brigitte Helm]]\"") } },
        { op: "infer_table", args: { table: "film" } },
      ],
    },
    {
      title: "Set a value for notes made by hand with `external_default`",
      say: "`default` fills a column on rows the engine writes. `external_default` fills it on notes that become rows without the engine writing them, like the note in the next example. Here `added_by` tells the two apart.",
      steps: [
        {
          op: "add_column",
          args: {
            table: "film",
            column: { name: "added_by", type: "enum", values: ["agent", "by hand"], default: "agent", external_default: "by hand", description: "Who added the film: an agent through the engine, or a person in an editor" },
          },
        },
        { op: "insert_row", args: { table: "film", values: { title: "Night of the Living Dead", year: 1968, minutes: 96, director: "George A. Romero", status: "to watch" } }, save: "p", showFile: (ctx) => ctx.saved.p.planned_creates[0] },
      ],
    },
    {
      title: "A new note in a table’s folder becomes a row",
      say: "The engine adopts a note you create by hand inside a table’s folder, for example with “new note” in a note editor such as Obsidian, or from a daily note template. The note gets:\n\n- `table` and an `id`\n- the values its name carries under the table’s `filename` pattern\n- the column defaults and the `external_default` values\n\nHere the note’s name gives `title`, and `added_by` is `by hand`. A note that misses a required column or has a bad value stays as it is, and the engine logs a warning.",
      steps: [
        { edit: { path: "datanotes/main/public/film/Sherlock Jr..md", text: "---\nyear: 1924\nminutes: 45\nstatus: to watch\ndirector: Buster Keaton\n---\n" }, wait: 2500 },
        { op: "read_note", args: { path: "datanotes/main/public/film/Sherlock Jr..md" }, check: (v) => !v.content.includes("added_by: by hand") && "added_by: by hand expected" },
      ],
    },
    {
      title: "Keep a folder’s notes out of the table with `exclude`",
      say: "A note is a row when its front matter key `table` names the table, and a new note in the table’s folder becomes one. `exclude` lists folders whose notes never become rows. Here it lists the editor’s templates folder. The template already says `table:`, so the notes you make from it are rows, but the template itself must not be one.",
      steps: [
        { op: "alter_table", args: { table: "film", exclude: ["datanotes/main/public/film/Templates"] } },
        { edit: { path: "datanotes/main/public/film/Templates/New film.md", text: "---\ntable: main.public.film\nyear:\nstatus: to watch\n---\n## Why I want to watch it\n" }, wait: 2500 },
        { say: "The engine leaves the template as it is, with no `id`, and it isn’t a row:", op: "read_note", args: { path: "datanotes/main/public/film/Templates/New film.md" }, check: (v) => v.content.includes("id:") && "the template should be left alone" },
        { op: "select_rows", args: { table: "film", columns: ["title"], where: { path: { contains: "Templates" } } }, check: (v) => v.total !== 0 && "no rows expected" },
      ],
    },
    {
      title: "See the table’s definition in `metastore.yaml`",
      say: "This is the table as you inferred, corrected and extended it on this page. Its definition holds:\n\n- `title` with `identity: filename`\n- the columns from the notes’ front matter\n- `added_by` with its `external_default`\n- the `exclude` folder under `properties`",
      steps: [{ showFile: "datanotes/metastore.yaml" }],
    },
  ],
};

export default chapter;
