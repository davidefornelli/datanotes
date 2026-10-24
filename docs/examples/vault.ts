import type { Chapter } from "./types";

const chapter: Chapter = {
  slug: "vault",
  title: "Notes, search and links",
  files: {
    "Notes/Film night.md": "---\ntags: [films]\n---\n# Film night\n\nEvery other Friday. Next up: [[Charade]]. October’s theme is [[Cary Grant]].\n",
    "Notes/Rewatch ideas.md": "A Cary Grant weekend: every film with him, in release order.\n",
  },
  setup: [
    {
      op: "create_table",
      args: { name: "actor", description: "Actors of the films I watch", columns: [{ name: "name", type: "string", required: true, description: "The actor's name, as credited" }], filename: "{name}" },
    },
    { op: "insert_row", args: { table: "actor", values: { name: "Cary Grant" } } },
    { op: "insert_row", args: { table: "actor", values: { name: "Rosalind Russell" } } },
    { op: "insert_row", args: { table: "actor", values: { name: "Audrey Hepburn" } } },
    {
      op: "create_table",
      args: {
        name: "film",
        description: "Classic films I watched or want to watch",
        columns: [
          { name: "title", type: "string", required: true, description: "The film's title, as on its poster" },
          { name: "cast", type: "list", items: "link", ref: "main.public.actor", description: "The actors in the film" },
        ],
        filename: "{title}",
      },
    },
    { op: "insert_row", args: { table: "film", values: { title: "His Girl Friday", cast: ["[[Cary Grant]]", "[[Rosalind Russell]]"] } } },
    { op: "insert_row", args: { table: "film", values: { title: "Charade", cast: ["[[Cary Grant]]", "[[Audrey Hepburn]]"] }, body: "Cary Grant again, 23 years after [[His Girl Friday]]. Watch them back to back.\n" } },
    {
      op: "create_table",
      args: {
        name: "watch",
        description: "Each time I watch a film",
        columns: [
          { name: "occurred_at", type: "datetime", required: true, description: "When the film started" },
          { name: "film", type: "link", ref: "main.public.film", description: "The film I watched" },
          { name: "where", type: "enum", values: ["cinema", "home", "outdoor screening"], description: "The kind of place I watched it in" },
        ],
        time_column: "occurred_at",
      },
    },
    { op: "insert_row", args: { table: "watch", values: { occurred_at: "2026-09-25T21:00", film: "[[Charade]]", where: "home" }, body: "Part of [[Film night]]. Four of us on the sofa, and nobody guessed the ending.\n" }, save: "viewing" },
  ],
  examples: [
    {
      title: "Read a note",
      say: "`read_note` returns a note’s Markdown in `content`, with its front matter, tags, file dates and size, parsed.",
      steps: [{ op: "read_note", args: { path: "Notes/Film night.md" }, show: (v) => ({ ...v, modified_at: "<date-time>", created_at: "<date-time>" }) }],
    },
    {
      title: "List a folder",
      say: "`list_folder` lists a folder’s sub-folders and files, as vault paths, and `\"\"` is the vault root. The listing hides the files and folders whose names start with a dot, such as `.obsidian`.",
      steps: [
        { op: "list_folder", args: { folder: "" } },
        { op: "list_folder", args: { folder: "datanotes/main/public" } },
      ],
    },
    {
      title: "Search text",
      say: "`search_notes` finds notes whose path or text contains every word of the query, ignoring case and accents. It returns the matching passages.",
      steps: [{ op: "search_notes", args: { query: "grant", context_length: 30 } }],
    },
    {
      title: "Search by words and meaning",
      say: "`search` ranks every note that has a word of the query. A rare word counts more than a common one. A word in the note’s name or properties counts more than one in its text. Here semantic search is off, so `meaning` is `off` and every hit has `matched_by: [\"words\"]`.",
      steps: [
        { op: "search", args: { query: "cary grant film" }, check: (v) => v.results[0]?.matched_by?.[0] !== "words" && "a words hit expected" },
        {
          say: "Quotes keep words together, and a minus sign leaves notes out. This query wants the two words in a row, and no note that names Charade:",
          op: "search",
          args: { query: '"cary grant" -charade' },
          check: (v) => v.results.some((h: { path: string }) => h.path.includes("Charade")) && "Charade should be left out",
        },
      ],
    },
    {
      title: "See what a note links to and what links to it",
      say: "`graph_neighbors` returns a note’s links in both directions. Each link has a label: the link column it comes from (`cast`), or `link` for a link in the text.",
      steps: [{ op: "graph_neighbors", args: { from_nodes: { table: "actor", where: { name: "Cary Grant" } } } }],
    },
    {
      title: "Read the whole graph in one call",
      say: "`tables` starts from the rows of several tables at once. Name the tables, or use a pattern: `*` is every table, `main.*` every table of the `main` catalog. With `direction: \"out\"`, one call returns every link of every row: the whole graph, for an app that draws it. The start set holds at most 5,000 notes.",
      steps: [
        {
          op: "graph_neighbors",
          args: { from_nodes: { tables: ["*"] }, direction: "out" },
          check: (v) => !JSON.stringify(v).includes("film/Charade.md") && "Charade expected",
        },
      ],
    },
    {
      title: "Walk the links from a note",
      say: "`graph_traverse` follows links breadth-first, in the `direction` you choose: `out`, `in` or `both`. Here it starts from Audrey Hepburn, goes up to two steps in both directions and keeps only films. It finds Charade, the film she’s in, and His Girl Friday, which the Charade note links to. `via` shows the route to each one.",
      steps: [
        {
          op: "graph_traverse",
          args: { from_nodes: { paths: ["datanotes/main/public/actor/Audrey Hepburn.md"] }, direction: "both", tables: ["film"], max_depth: 2 },
          check: (v) => !JSON.stringify(v).includes("film/His Girl Friday.md") && "His Girl Friday expected",
        },
      ],
      after: "To read or total those rows, pass the paths to `select_rows` with `where: {\"path\": {\"in\": [...]}}`.",
    },
    {
      title: "Find how two notes are connected",
      say: "`graph_path` finds the shortest chain of links between two notes, or between two sets of notes.",
      steps: [
        { op: "graph_path", args: { from_nodes: { paths: ["Notes/Rewatch ideas.md", "datanotes/main/public/actor/Audrey Hepburn.md"] }, to_nodes: { paths: ["Notes/Film night.md"] } } },
      ],
    },
    {
      title: "Search notes by meaning",
      say: "`semantic_search` finds notes by meaning rather than by words. It’s off by default, because it sends note text to an embedding provider. Until you turn it on in the engine’s settings, the call answers that it’s off; [Turn on semantic search](/guides/search/semantic/#turn-on-semantic-search) explains how. `describe_semantic_index` reports the state of the index, and `sync_semantic_index` brings it up to date once it’s on.",
      steps: [
        { op: "semantic_search", args: { query: "the Friday we watched the Cary Grant film" }, refused: true },
        { op: "describe_semantic_index", args: {} },
        { op: "sync_semantic_index", args: {}, refused: true },
      ],
    },
    {
      // last: the examples above read the note under its first name
      title: "Rename a note by hand",
      say: "You can rename or move a note outside the engine: in a file manager, with git or with a sync tool. The engine then rewrites every link to the note’s old path, across the vault. It rewrites rows and plain notes alike, as it does when it renames a note itself. Here you rename the plain note `Notes/Film night.md`. A viewing of Charade, a row of the `watch` table, links to it in its text.",
      steps: [
        { move: { from: "Notes/Film night.md", to: "Notes/Friday film night.md" } },
        {
          say: "The engine waits until the vault has been quiet for 4 seconds, so an editor or a sync tool finishes first. The journal then lists the repair as one operation:",
          op: "list_migrations",
          args: { limit: 1 },
          until: (v) => v.migrations[0]?.op === "repair_links",
          show: (v) => v.migrations.map(({ op, summary, notes_changed, files }: Record<string, unknown>) => ({ op, summary, notes_changed, files })),
        },
        {
          say: "The viewing now links to the new name:",
          op: "read_note",
          args: (ctx) => ({ path: ctx.saved.viewing.planned_creates[0] }),
          check: (v) => !v.content.includes("Part of [[Friday film night]].") && "the link to the renamed note was not rewritten",
        },
      ],
      after:
        "`undo_migration` takes the repair back. The change feed lists its changes after the move, each with the move in `cause`. Links that an editor such as Obsidian already rewrote stay as they are: the engine doesn’t write them twice. To leave links as they are after a hand move, set `repairLinksOnHandMove` to `false` in the [engine’s settings](/reference/settings/).",
    },
  ],
};

export default chapter;
