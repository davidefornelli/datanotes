import type { Chapter } from "./types";

const FILM = "datanotes/main/public/film";

const chapter: Chapter = {
  slug: "linking",
  title: "Automatic links",
  files: {
    "People/Stanley Donen.md": "Directed Charade and Singin’ in the Rain.\n",
    "Friends/Ingrid.md": "My friend from the film club. She picks the Swedish films.\n",
    "Directors/Bergman.md": "---\naliases: [Ingmar Bergman]\n---\nThe Swedish director of Persona and Wild Strawberries.\n",
  },
  setup: [
    {
      op: "create_table",
      args: {
        name: "actor",
        columns: [{ name: "name", type: "string", required: true, description: "The actor's name, as in the credits" }],
        filename: "{name}", description: "Actors of the classic films I watch",
      },
    },
    { op: "insert_row", args: { table: "actor", values: { name: "Cary Grant" } } },
    { op: "insert_row", args: { table: "actor", values: { name: "Audrey Hepburn" } } },
    {
      op: "create_table",
      args: {
        name: "film",
        columns: [
          { name: "title", type: "string", required: true, description: "The film's title, as on its poster" },
          { name: "year", type: "integer", description: "Year the film first came out" },
        ],
        filename: "{title}", description: "Classic films I watched, with my reviews",
      },
    },
    { op: "insert_row", args: { table: "film", values: { title: "Notorious", year: 1946 } } },
  ],
  examples: [
    {
      title: "Link the notes a text mentions",
      say: "Write a note’s text as plain prose. The engine links each note the text mentions by name, at its first mention. `links_added` lists the links. This review of Charade names two actors, each a row, and the director, a plain note.",
      steps: [
        {
          op: "insert_row",
          args: {
            table: "film",
            values: { title: "Charade", year: 1963 },
            body: "Cary Grant and Audrey Hepburn in Paris, directed by Stanley Donen.\n\nCary Grant has never been more charming.\n",
          },
          check: (v) => v.links_added?.length !== 3 && "three links expected",
          showFile: `${FILM}/Charade.md`,
        },
      ],
      after: "The second mention of Cary Grant stays as text: one link per note is enough. Paris has no note, so it stays as text too.",
    },
    {
      title: "Link only the text you add",
      say: "`update_row` links the text it writes, and leaves the rest of the note alone. A note the body links already doesn’t get a second link.",
      steps: [
        {
          op: "update_row",
          args: { table: "film", path: `${FILM}/Charade.md`, body_append: "Audrey Hepburn wears Givenchy. Watch it with Notorious, the other Cary Grant thriller.\n" },
          check: (v) => (v.links_added ?? []).map((l: { text: string }) => l.text).join() !== "Notorious" && "only Notorious expected",
          showFile: `${FILM}/Charade.md`,
        },
      ],
    },
    {
      title: "Resolve a doubtful mention",
      say: "When the engine can’t tell which note a name means, it leaves the text alone and asks. This review of Notorious names Ingrid Bergman. The vault has your friend `Ingrid` and the director `Bergman`, but no note for the actress. The engine links neither.",
      steps: [
        {
          op: "update_row",
          args: { table: "film", path: `${FILM}/Notorious.md`, body: "Ingrid Bergman and Cary Grant, directed by Alfred Hitchcock.\n" },
          check: (v) => v.ambiguous_mentions?.[0]?.reason !== "adjacent" && "an adjacent mention expected",
        },
        {
          say: "The agent reads both candidates and the line around the mention. Neither note is the actress, so it adds her as an actor:",
          op: "insert_row",
          args: { table: "actor", values: { name: "Ingrid Bergman" } },
          quiet: true,
        },
        {
          say: "Now the longest name wins. The same text links the actress, and nobody is asked:",
          op: "update_row",
          args: { table: "film", path: `${FILM}/Notorious.md`, body: "Ingrid Bergman and Cary Grant, directed by Alfred Hitchcock.\n" },
          check: (v) => (v.links_added ?? []).length !== 2 && "two links expected",
          showFile: `${FILM}/Notorious.md`,
        },
      ],
      after: "To link a candidate yourself, write the link in the text and pass `autolink: false`. The engine then writes the text as you give it. If no candidate fits and the name deserves no note, leave the text as it is.",
    },
    {
      title: "Choose the tables a link may point to",
      say: "A table’s rows are link targets by default. A table whose rows are named by a date or a time is the exception, such as a table of meals or screenings. The table option `autolink_target` decides for one table. These tasks say no, so the task `Call Ingrid` never takes a mention of Ingrid:",
      steps: [
        {
          op: "create_table",
          args: {
            name: "task",
            columns: [{ name: "title", type: "string", required: true, description: "What to do, in a few words" }],
            filename: "{title}", description: "Things I have to do", autolink_target: false,
          },
          show: (v) => ({ ok: v.ok }),
        },
        { op: "insert_row", args: { table: "task", values: { title: "Call Ingrid" } }, quiet: true },
        {
          op: "insert_row",
          args: { table: "film", values: { title: "Persona", year: 1966 }, body: "After the film, call Ingrid to talk about it.\n" },
          check: (v) => (v.links_added ?? []).map((l: { target: string }) => l.target).join() !== "Friends/Ingrid.md" && "a link to Friends/Ingrid.md expected",
          showFile: `${FILM}/Persona.md`,
        },
        {
          say: "Screenings are named by the time they start, so they are no targets. This one has an alias you mention in your notes:",
          op: "create_table",
          args: {
            name: "screening",
            time_column: "starts_at",
            columns: [
              { name: "starts_at", type: "datetime", required: true, description: "When the screening starts" },
              { name: "aliases", type: "list", items: "string", description: "Other names of the screening" },
            ],
            description: "Film club screenings",
          },
          quiet: true,
        },
        { op: "insert_row", args: { table: "screening", values: { starts_at: "2026-10-09T21:00", aliases: ["Swedish night"] } }, quiet: true },
        {
          say: "`autolink_target: true` makes the screenings link targets:",
          op: "alter_table",
          args: { table: "screening", autolink_target: true },
          show: (v) => ({ ok: v.ok }),
        },
        {
          op: "update_row",
          args: { table: "film", path: `${FILM}/Persona.md`, body_append: "We watched it at Swedish night.\n" },
          check: (v) => (v.links_added ?? []).length !== 1 && "a link to the screening expected",
          showFile: `${FILM}/Persona.md`,
        },
        { say: "`metastore.yaml` keeps the option in the table’s `options`:", showFile: "datanotes/metastore.yaml" },
      ],
      after: "Pass `autolink_target: \"default\"` to `alter_table` to follow the default again. Archived rows are never link targets, whatever the option says.",
    },
    {
      title: "Turn automatic links off",
      say: "`autolink: false` writes one text as you give it. To turn the links off for every write, call `configure_database` with `autolink: false`. A write can still ask for them with `autolink: true`.",
      steps: [
        {
          op: "insert_row",
          args: { table: "film", values: { title: "His Girl Friday", year: 1940 }, body: "Cary Grant and Rosalind Russell, the fastest talkers in film.\n", autolink: false },
          check: (v) => v.links_added !== undefined && "no links expected",
          showFile: `${FILM}/His Girl Friday.md`,
        },
        { op: "configure_database", args: { autolink: false }, show: (v) => v.config },
        { say: "`metastore.yaml` keeps the setting under `config:`:", showFile: "datanotes/metastore.yaml" },
        { say: "This call turns them on again:", op: "configure_database", args: { autolink: true }, show: (v) => ({ autolink: v.config.autolink }) },
      ],
    },
  ],
};

export default chapter;
