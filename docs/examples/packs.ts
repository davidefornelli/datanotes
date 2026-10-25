import type { Chapter } from "./types";

const FOLDER = "datanotes/main/public/reading";
const PACK = `${FOLDER}/reading 2025-03.md`;

const chapter: Chapter = {
  slug: "packs",
  title: "Packs of rows",
  examples: [
    {
      title: "Choose the period of a pack",
      say: "A table’s `pack` option names a date or date-time column and a period, such as `{started_at:YYYY-MM}`. Once a month is over, one note holds all its rows. `pack_after_days` sets how many days after the end of a period its rows wait, 7 by default.",
      steps: [
        {
          op: "create_table",
          args: {
            name: "reading",
            description: "Reading sessions: when I read, which book and for how long",
            time_column: "started_at",
            partition: "{started_at:YYYY}",
            pack: "{started_at:YYYY-MM}",
            pack_after_days: 3,
            columns: [
              { name: "started_at", type: "datetime", required: true, description: "When the session started" },
              { name: "book", type: "string", required: true, description: "The book I read" },
              { name: "minutes", type: "integer", min: 1, description: "How long I read, in minutes" },
            ],
          },
          show: (v) => ({ ok: v.ok, migration_id: v.migration_id }),
          showFile: "datanotes/metastore.yaml",
        },
        {
          say: "`alter_table` changes them while no row is in a pack. Here the rows wait one day:",
          op: "alter_table",
          args: { table: "reading", pack: "{started_at:YYYY-MM}", pack_after_days: 1 },
          show: (v) => ({ ok: v.ok, planned_texts: v.planned_texts }),
        },
        {
          say: "The template takes one date or date-time column and a format made of `YYYY`, `MM` and `DD`. Anything else is refused, with the table’s date columns in the hint:",
          op: "alter_table",
          args: { table: "reading", pack: "{minutes:YYYY-MM}" },
          refused: true,
        },
      ],
    },
    {
      title: "Pack and unpack rows",
      say: "`pack_rows` puts the rows of every closed period into their pack. A row changed in the last 24 hours waits for the next run. A dry run shows the packs first, and the rows that stay notes of their own, with the reason.",
      steps: [
        {
          say: "Four sessions of March and April 2025. The last one has a heading of its own:",
          op: "batch",
          args: {
            operations: [
              { op: "insert_row", table: "reading", values: { started_at: "2025-03-02T21:00", book: "Moby-Dick", minutes: 40 } },
              { op: "insert_row", table: "reading", values: { started_at: "2025-03-09T21:30", book: "Moby-Dick", minutes: 25 } },
              { op: "insert_row", table: "reading", values: { started_at: "2025-03-16T22:00", book: "Persuasion", minutes: 30 }, body: "Chapter 4, the walk to Winthrop.\n" },
              { op: "insert_row", table: "reading", values: { started_at: "2025-04-06T21:00", book: "Persuasion", minutes: 35 }, body: "# Notes\n\nAnne and Wentworth meet again.\n" },
            ],
          },
          quiet: true,
        },
        { age: { folder: FOLDER, at: "2025-05-01T00:00:00Z" } },
        {
          op: "pack_rows",
          args: { table: "reading", dry_run: true },
          show: (v) => ({ ok: v.ok, dry_run: v.dry_run, packs: v.packs, excluded: v.excluded, open_rows: v.open_rows }),
          check: (v) => (v.packs?.[0]?.rows?.length === 3 && v.excluded?.length === 1 ? undefined : "three rows of March in one pack, the April row left out"),
        },
        {
          say: "The same call without `dry_run` writes the pack. The three notes of March go, and one note holds them:",
          op: "pack_rows",
          args: { table: "reading" },
          show: (v) => ({ ok: v.ok, migration_id: v.migration_id, packs: v.packs }),
          showFile: PACK,
        },
        {
          say: "Nothing changes for the engine and its readers. `select_rows` gives each row at its own path, with its values and text:",
          op: "select_rows",
          args: { table: "reading", columns: ["started_at", "book", "minutes", "file_modified"], order_by: "started_at" },
          check: (v) => (v.total === 4 && v.rows[0].path === `${FOLDER}/2025/2025-03-02T2100.md` ? undefined : "the four rows, at their paths"),
        },
        {
          say: "`unpack_rows` takes rows out again, as notes of their own with the text and modification time they had. `where` picks some rows, `key` one pack:",
          op: "unpack_rows",
          args: { table: "reading", where: { book: "Persuasion" } },
          show: (v) => ({ ok: v.ok, packs: v.packs }),
          check: (v) => (v.packs?.[0]?.rows?.length === 1 ? undefined : "one row out"),
        },
      ],
      after: "Both operations are journaled: `undo_migration` takes a pack apart, or packs the rows again. The change feed and the webhooks see no change of the rows, and no new version of the table is written.",
    },
    {
      title: "Read and write a packed row",
      say: "A packed row is still a row. A write changes its section of the pack. When the new values move it to another period or path, the row comes out as a note of its own.",
      steps: [
        {
          op: "update_row",
          args: { table: "reading", path: `${FOLDER}/2025/2025-03-09T2130.md`, set: { minutes: 45 } },
          show: (v) => ({ ok: v.ok, migration_id: v.migration_id, planned_edits: v.planned_edits }),
          showFile: PACK,
        },
      ],
    },
    {
      title: "Unpack before you change the table’s layout",
      say: "A packed row keeps the path its values give it. So the rows must be notes of their own before the table moves, before its rows change folder or name, and before its `pack` option changes:",
      steps: [
        { op: "alter_table", args: { table: "reading", partition: "{started_at:YYYY/MM}" }, refused: true },
        { op: "unpack_rows", args: { table: "reading" }, show: (v) => ({ ok: v.ok, packs: v.packs }) },
        { op: "alter_table", args: { table: "reading", partition: "{started_at:YYYY/MM}" }, show: (v) => ({ ok: v.ok, planned_moves: v.planned_moves }) },
      ],
    },
  ],
};

export default chapter;
