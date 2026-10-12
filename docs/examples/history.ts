import type { Chapter, Ctx } from "./types";

const FILM = "datanotes/main/public/film";

/** The version before Metropolis was removed: the newest UPDATE in the history read earlier. */
const before = (ctx: Ctx) => ctx.saved.h.history.find((v: { operation: string }) => v.operation === "UPDATE").version;

const chapter: Chapter = {
  slug: "history",
  title: "Tracking history and changes",
  setup: [
    {
      op: "create_table",
      args: {
        name: "film",
        description: "Classic films I watched or want to watch",
        columns: [
          { name: "title", type: "string", required: true, unique: true, description: "The film's title, as on its poster" },
          { name: "status", type: "enum", values: ["to watch", "watched"], ordered: true, default: "to watch", description: "Where the film is on my list" },
          { name: "rating", type: "integer", min: 1, max: 5, description: "My rating, from 1 (poor) to 5 (a masterpiece)" },
          { name: "watched_on", type: "date", description: "The day I last watched it" },
        ],
        filename: "{title}",
      },
    },
  ],
  examples: [
    {
      title: "Turn history on for a table",
      say: "A table’s own `history` wins over the database’s setting. With `history: true`, the engine records every write to the table, even in a database with history off.",
      steps: [
        { op: "alter_table", args: { table: "film", history: true } },
        { op: "insert_row", args: { table: "film", values: { title: "Nosferatu" } }, quiet: true },
        { op: "insert_row", args: { table: "film", values: { title: "Metropolis" } }, quiet: true },
        { op: "update_row", args: { table: "film", path: `${FILM}/Nosferatu.md`, set: { status: "watched", rating: 4, watched_on: "2026-10-03" } }, quiet: true },
        { op: "update_row", args: { table: "film", path: `${FILM}/Metropolis.md`, set: { status: "watched" } }, quiet: true },
        { op: "delete_rows", args: { table: "film", where: { title: "Metropolis" } }, quiet: true },
      ],
      after: "The calls after `alter_table` add two films, rate Nosferatu, mark Metropolis watched by mistake and then remove it.",
    },
    {
      title: "List the versions of a table",
      say: "`describe_history` lists the versions, newest first, each with its operation and metrics. Each version has the `migration_id` that `undo_migration` takes.",
      steps: [{ op: "describe_history", args: { table: "film" }, save: "h" }],
    },
    {
      title: "Read a table as it was",
      say: "`select_rows` with `version` or `timestamp` reads the table as it was at that point, a technique called time travel. Metropolis, which you removed since, is still there.",
      steps: [
        {
          op: "select_rows",
          args: (ctx) => ({ table: "film", columns: ["title", "status", "rating"], version: before(ctx) }),
          check: (v) => v.total !== 2 && "two films expected then",
        },
      ],
    },
    {
      title: "Copy a table as it was",
      say: "`clone_table` with `version`, or with `timestamp` as a date-time, copies the table as it was then into a new table. The copy gets the definition and the rows as independent notes, and the source stays untouched.",
      steps: [
        { op: "clone_table", args: (ctx) => ({ source: "film", target: "film_before", version: before(ctx) }) },
        { op: "select_rows", args: { table: "film_before", columns: ["title", "status", "rating"] }, check: (v) => v.total !== 2 && "two films expected then" },
        {
          say: "This call names the same moment by its time, taken from the history read above:",
          op: "clone_table",
          args: (ctx) => ({ source: "film", target: "film_at", timestamp: ctx.saved.h.history.find((v: { version: number }) => v.version === before(ctx)).timestamp, copy_rows: false }),
          quiet: true,
        },
      ],
    },
    {
      title: "See what changed between two versions",
      say: "`table_changes` returns one entry per row change between two versions. It lists inserts, deletes, and updates, each update as a pre-image and a post-image of the row.",
      steps: [{ op: "table_changes", args: (ctx) => ({ table: "film", start_version: before(ctx) }) }],
    },
    {
      title: "Restore a table to an old version",
      say: "`restore_table` brings the rows and the definition back to a version:\n\n- it removes the rows added since\n- it gives changed rows their old values\n- it brings removed rows back\n\nThe restore doesn’t rewrite history: it’s a new version, and you can undo it. Run it with `dry_run` first.",
      steps: [
        {
          say: "The dry run names the version by its time, with a `timestamp` from the history read above:",
          op: "restore_table",
          args: (ctx) => ({ table: "film", timestamp: ctx.saved.h.history.find((v: { version: number }) => v.version === before(ctx)).timestamp, dry_run: true }),
        },
        { op: "restore_table", args: (ctx) => ({ table: "film", version: before(ctx) }) },
        { op: "select_rows", args: { table: "film", columns: ["title", "status"] }, check: (v) => v.total !== 2 && "Metropolis should be back" },
      ],
    },
    {
      title: "Find hand edits in the history",
      say: "When a note changes outside the engine, in an editor, through git or through a sync, the engine records an `EXTERNAL_EDIT` version a moment later.",
      steps: [
        { edit: { path: `${FILM}/Nosferatu.md`, text: (t) => t.replace("rating: 4", "rating: 5") }, wait: 4500 },
        { op: "describe_history", args: { table: "film", limit: 2 }, check: (v) => !JSON.stringify(v).includes("EXTERNAL_EDIT") && "an EXTERNAL_EDIT version expected" },
      ],
    },
    {
      title: "Trim old history with `vacuum_table`",
      say: "`vacuum_table` deletes log history older than a version. You can no longer time travel to an earlier version, and the rows stay untouched. It’s a dry run unless you pass `dry_run: false`, and an agent runs it only when you ask.",
      steps: [{ op: "vacuum_table", args: { table: "film" } }],
    },
    {
      title: "Follow every change with the change feed",
      say: "`list_changes` returns numbered row changes across all tables, oldest first. It includes engine writes and hand edits (`source: external`). Keep the returned `last` and pass it as `since` next time to get only what’s new. `wait_ms` waits for the next change, a technique called long polling.",
      steps: [
        { op: "list_changes", args: { tables: ["film"], limit: 3 }, save: "c" },
        { op: "insert_row", args: { table: "film", values: { title: "His Girl Friday" } }, quiet: true },
        { say: "With `since`, the answer holds only the newer changes:", op: "list_changes", args: (ctx) => ({ since: ctx.saved.c.head }) },
      ],
    },
    {
      title: "Push changes to a web address with webhooks",
      say: "`create_webhook` makes the engine send row changes in batches to a web address (URL), as `POST` requests. The engine signs each batch with a hash-based message authentication code (HMAC) of the body, in `X-Datanotes-Signature`. It retries until the receiver answers with a 2xx status. Only this answer returns the `secret`: give it to the receiver so it can check the signature.",
      steps: [
        { op: "create_webhook", args: (ctx) => ({ url: ctx.saved.hookUrl, tables: ["film"] }), save: "w", show: (v) => ({ ...v, secret: "<shown once>" }) },
        { op: "update_row", args: { table: "film", path: `${FILM}/His Girl Friday.md`, set: { status: "watched" } }, quiet: true },
        { received: true, wait: 4000 },
        { op: "list_webhooks" },
        { op: "delete_webhook", args: (ctx) => ({ id: ctx.saved.w.id }) },
      ],
    },
    {
      title: "Turn history on for every table",
      say: "`configure_database` with `history: true` turns history on for every table that doesn’t say otherwise. A database the engine creates has it on already. One whose `metastore.yaml` lacks the setting, such as one from a version before 3.0.0, has it off. A table’s own `history`, `true` or `false` with `alter_table`, wins, and `\"default\"` makes it follow the database again. The journal doesn’t record settings, so an agent changes it only when you ask.",
      steps: [
        { op: "configure_database", args: { history: true }, show: (v) => v.config },
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
          quiet: true,
        },
        { op: "insert_row", args: { table: "actor", values: { name: "Rosalind Russell", born: "1907-06-04" } }, quiet: true },
        {
          say: "The new table has versions from its creation:",
          op: "describe_history",
          args: { table: "actor" },
          show: (v) => v.history.map((h: { version: number; operation: string }) => ({ version: h.version, operation: h.operation })),
          check: (v) => v.history.length !== 2 && "two versions expected",
        },
        { say: "A table’s own setting wins: `false` keeps the copy `film_before` without history, and `\"default\"` makes `film_at` follow the database again:", op: "alter_table", args: { table: "film_before", history: false } },
        { op: "alter_table", args: { table: "film_at", history: "default" } },
      ],
    },
    {
      title: "Time travel and restore the whole database",
      say: "An agent can change several tables in one call: here one batch adds an actor and rates a film. `describe_history` without `table` lists the commits of every table, newest first, each with its `table`. In that list:\n\n- the commits of one operation share its `migration_id`\n- the commits of a batch carry the batch’s id as `batch`\n- `tables` names every table the change touched",
      steps: [
        {
          op: "batch",
          args: {
            summary: "add Cary Grant, rate His Girl Friday",
            operations: [
              { op: "insert_row", table: "actor", values: { name: "Cary Grant", born: "1904-01-18" } },
              { op: "update_row", table: "film", path: `${FILM}/His Girl Friday.md`, set: { rating: 5, watched_on: "2026-10-08" } },
            ],
          },
          save: "run",
          show: (v) => ({ ok: v.ok, migration_id: v.migration_id }),
        },
        {
          op: "describe_history",
          args: { limit: 3 },
          save: "db",
          check: (v, ctx) => v.history.filter((c: { batch?: string }) => c.batch === ctx.saved.run.migration_id).length !== 2 && "the batch's two commits expected",
        },
        {
          say: "`restore_database` brings every table that keeps a log back to a moment, as one operation. `before_migration` names the moment by an operation, here the batch, and means the state immediately before it. The dry run lists what would change in each table, and shows a table without history, like `film_before`, as `skipped` with the reason.",
          op: "restore_database",
          args: (ctx) => ({ before_migration: ctx.saved.run.migration_id, dry_run: true }),
          check: (v) => v.tables.length !== 2 && "actor and film should change",
        },
        { op: "restore_database", args: (ctx) => ({ before_migration: ctx.saved.run.migration_id }), save: "back", show: (v) => ({ ok: v.ok, migration_id: v.migration_id, restored_to: v.restored_to, tables: v.tables.map((t: { table: string; action: string }) => `${t.table}: ${t.action}`) }) },
        { op: "select_rows", args: { table: "actor", columns: ["name"] }, check: (v) => v.total !== 1 && "only Rosalind Russell expected" },
        {
          say: "The restore has one `migration_id` for every table, so `undo_migration` puts them all back as they were.\n\nA `timestamp` names the moment by its time, as it does for a table. `restored_to` is that time for the restore above: the last millisecond before the batch, so passing it as `timestamp` names the same moment. A restore to that time would drop a table created after it and archive its rows. It would also bring back a table dropped since.",
          op: "undo_migration",
          args: (ctx) => ({ migration_id: ctx.saved.back.migration_id }),
          quiet: true,
        },
        {
          op: "restore_database",
          args: (ctx) => ({ timestamp: ctx.saved.back.restored_to, dry_run: true }),
          show: (v) => ({ ok: v.ok, dry_run: v.dry_run, tables: v.tables.map((t: { table: string; action: string; version: number }) => `${t.table}: ${t.action} to version ${t.version}`), skipped: v.skipped }),
        },
        {
          say: "Time travel reads several tables the same way. `select_rows` with `timestamp` on a join, a view or `base:<name>` reads each table as of that time, and `versions` says which version of each it read.",
          op: "select_rows",
          args: (ctx) => ({ table: "actor", columns: ["name"], timestamp: ctx.saved.back.restored_to }),
        },
      ],
    },
    {
      title: "See the history settings in `metastore.yaml`",
      say: "History is a setting of the definition. `alter_table` writes `history: true` under the table’s `options`, `false` writes `false`, and `\"default\"` removes the key. For the whole database, the setting is under `config`. The copies made on this page are tables of their own.",
      steps: [{ showFile: "datanotes/metastore.yaml" }],
    },
  ],
};

export default chapter;
