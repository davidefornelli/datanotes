/**
 * The in-process API (`createPublicApi`) driven end to end on a small reading list: every method
 * must reach its engine operation with the current settings (and `{ dryRun }` where it takes one).
 */

import { describe, expect, it } from "vitest";
import type { Transport } from "../src/core/embeddings";
import { INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { BATCH_OPS, createPublicApi, type DatanotesPublicApi } from "../src/core/public-api";
import { SemanticIndex } from "../src/core/semantic";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

/** Each scenario runs many operations: room for a loaded machine. */
const SLOW = 20_000;

const BOOK = "Datanotes/main/public/book";
const PERSON = "Datanotes/main/public/person";

/** Fresh vault and API (default `saveSettings`, no semantic index, no change feed). */
function library(files: Record<string, string> = {}): { v: DbVault; api: DatanotesPublicApi } {
  // one file per version: the history scenario names them
  const v = createDbVault(files, { transactionLogFormat: "files" });
  return { v, api: createPublicApi(v.app, () => v.settings) };
}

/** person, book (title, pages, status, author → person, `more` columns) with Frank Herbert, Dune and Emma. */
async function books(api: DatanotesPublicApi, more: Record<string, unknown>[] = []): Promise<void> {
  const person = { name: "person", description: "Authors of my books", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true, dense: true, description: "The author's name" }] };
  expect((await api.createTable(person)).ok).toBe(true);
  const created = await api.createTable(described({
    name: "book",
    description: "Books on my shelves",
    options: { filename: "{title}" },
    columns: [
      { name: "title", type: "string", required: true, dense: true, description: "The book's title" },
      { name: "pages", type: "integer", min: 1, description: "How many pages it has" },
      { name: "status", type: "enum", values: ["to_read", "reading", "done"], description: "Where I am with it" },
      { name: "author", type: "link", ref: "main.public.person", description: "Who wrote it" },
      ...more,
    ],
  }));
  expect(created.ok).toBe(true);
  expect((await api.insertRow({ table: "person", values: { name: "Frank Herbert" } })).ok).toBe(true);
  expect((await api.insertRow({ table: "book", values: { title: "Dune", pages: 412, status: "to_read", author: "[[Frank Herbert]]" } })).ok).toBe(true);
  expect((await api.insertRow({ table: "book", values: { title: "Emma", pages: 300, status: "reading" } })).ok).toBe(true);
}

/** The columns of a table as information_schema shows them: name and type. */
async function columns(api: DatanotesPublicApi, table: string): Promise<[unknown, unknown][]> {
  const r = await api.select({ table: "information_schema.columns", where: { table_name: table }, columns: ["column_name", "data_type"], orderBy: "ordinal_position" });
  return r.rows.map((c) => [c.column_name, c.data_type]);
}

const rowsOf = async (api: DatanotesPublicApi, table: string, cols: string[]) => (await api.select({ table, columns: cols })).rows;

describe("in-process API: the schema of a reading list", () => {
  it("columns are added, altered, renamed and dropped; enum values renamed; dry runs write nothing", async () => {
    const { api } = library();
    await books(api);

    const add = await api.addColumn(described({ table: "book", column: { name: "rating", type: "integer", min: 1, max: 5 } }));
    expect([add.ok, add.op]).toEqual([true, "add_column"]);
    expect(await columns(api, "book")).toEqual([
      ["id", "string"],
      ["title", "string"],
      ["pages", "integer"],
      ["status", "enum(to_read,reading,done)"],
      ["author", "link"],
      ["rating", "integer"],
    ]);

    expect((await api.alterColumn({ table: "book", name: "rating", changes: { max: 10 } })).op).toBe("alter_column");
    const rating = (await api.describeTable("book")).columns as { name: string; min?: number; max?: number }[];
    expect(rating.find((c) => c.name === "rating")).toMatchObject({ min: 1, max: 10 });

    const rename = await api.renameColumn({ table: "book", from: "pages", to: "page_count" });
    expect([rename.op, rename.notes_changed]).toEqual(["rename_column", 2]);
    const value = await api.renameValue({ table: "book", column: "status", from: "to_read", to: "queued" });
    expect([value.op, value.notes_changed]).toEqual(["rename_value", 1]);
    expect(await rowsOf(api, "book", ["title", "page_count", "status"])).toEqual([
      { path: `${BOOK}/Dune.md`, title: "Dune", page_count: 412, status: "queued" },
      { path: `${BOOK}/Emma.md`, title: "Emma", page_count: 300, status: "reading" },
    ]);

    const dry = await api.dropColumn({ table: "book", name: "rating" }, { dryRun: true });
    expect([dry.ok, dry.op, dry.dry_run]).toEqual([true, "drop_column", true]);
    expect((await columns(api, "book")).map(([n]) => n)).toContain("rating");
    expect((await api.dropColumn({ table: "book", name: "rating" })).ok).toBe(true);
    expect(await columns(api, "book")).toEqual([
      ["id", "string"],
      ["title", "string"],
      ["page_count", "integer"],
      ["status", "enum(queued,reading,done)"],
      ["author", "link"],
    ]);
    const again = api.dropColumn({ table: "book", name: "rating" });
    await expect(again).rejects.toThrow(OperationInputError);
    await expect(again).rejects.toThrow(`column "rating" not found in table "book"`);
  }, SLOW);

  it("a CHECK constraint refuses rows that break it, and existing rows that break it refuse the constraint", async () => {
    const { api } = library();
    await books(api);
    const check = { table: "information_schema.check_constraints", columns: ["table_name", "constraint_name", "check_clause"] };

    expect((await api.addConstraint({ table: "book", name: "long_enough", check: { pages: { gte: 100 } } })).op).toBe("add_constraint");
    expect((await api.select(check)).rows.map(({ path: _p, ...r }) => r)).toEqual([{ table_name: "book", constraint_name: "long_enough", check_clause: '{"pages":{"gte":100}}' }]);
    const leaflet = await api.insertRow({ table: "book", values: { title: "Leaflet", pages: 20 } });
    expect([leaflet.ok, leaflet.violations]).toEqual([
      false,
      [{ path: `${BOOK}/Leaflet.md`, violations: [{ constraint: "long_enough", code: "check", message: 'violates CHECK long_enough: {"pages":{"gte":100}}' }] }],
    ]);

    const tooLong = await api.addConstraint({ table: "book", name: "too_long", check: { pages: { gte: 350 } } });
    expect([tooLong.ok, tooLong.conflicts]).toEqual([false, [{ path: `${BOOK}/Emma.md`, message: "violates CHECK too_long" }]]);

    expect((await api.dropConstraint({ table: "book", name: "long_enough" })).op).toBe("drop_constraint");
    expect((await api.select(check)).rows).toEqual([]);
    expect((await api.insertRow({ table: "book", values: { title: "Leaflet", pages: 20 } })).ok).toBe(true);
    const gone = api.dropConstraint({ table: "book", name: "long_enough" });
    await expect(gone).rejects.toThrow(OperationInputError);
    await expect(gone).rejects.toThrow(`main.public.book has no constraint "long_enough"`);
  }, SLOW);

  it("table options, views, clones and drops", async () => {
    const { api } = library();
    await books(api);

    expect((await api.alterTable({ table: "book", description: "Books I own", aliases: ["books"] })).op).toBe("alter_table");
    const view = await api.createView({ name: "vw_reading", description: "Books being read", query: { table: "book", where: { status: "reading" }, columns: ["title"] } });
    expect(view.op).toBe("create_view");
    expect((await api.createView({ name: "vw_titles", aliases: ["titles"], query: { table: "book", columns: ["title"], order_by: "-title" } })).ok).toBe(true);
    expect(await api.listTablesAndViews()).toEqual({
      tables: [
        { name: "book", catalog: "main", schema: "public", qualified: "main.public.book", description: "Books I own", aliases: ["books"] },
        { name: "person", catalog: "main", schema: "public", qualified: "main.public.person", description: "Authors of my books" },
      ],
      views: [
        { name: "vw_reading", catalog: "main", schema: "public", qualified: "main.public.vw_reading", description: "Books being read" },
        { name: "vw_titles", catalog: "main", schema: "public", qualified: "main.public.vw_titles", aliases: ["titles"] },
      ],
    });
    expect(await api.select({ table: "vw_reading" })).toEqual({ table: "main.public.book", total: 1, rows: [{ path: `${BOOK}/Emma.md`, title: "Emma" }], view: "main.public.vw_reading" });
    expect((await api.select({ table: "vw_titles" })).rows.map((r) => r.title)).toEqual(["Emma", "Dune"]);
    expect((await api.dropView({ view: "vw_reading" })).op).toBe("drop_view");
    expect((await api.listTablesAndViews()).views.map((x) => x.name)).toEqual(["vw_titles"]);

    const clone = await api.cloneTable({ source: "book", target: "book_copy" });
    expect([clone.op, clone.planned_creates]).toEqual(["clone_table", ["Datanotes/main/public/book_copy/Dune.md", "Datanotes/main/public/book_copy/Emma.md"]]);
    expect(await rowsOf(api, "book_copy", ["title", "pages"])).toEqual([
      { path: "Datanotes/main/public/book_copy/Dune.md", title: "Dune", pages: 412 },
      { path: "Datanotes/main/public/book_copy/Emma.md", title: "Emma", pages: 300 },
    ]);
    const refused = await api.dropTable({ table: "book_copy" });
    expect([refused.ok, refused.conflicts]).toEqual([false, [{ path: "Datanotes/metastore.yaml", message: 'table has 2 rows; pass mode: "archive" to archive them with the table' }]]);
    const dropped = await api.dropTable({ table: "book_copy", mode: "archive" });
    expect([dropped.ok, dropped.op, dropped.planned_moves.map((m) => m.to)]).toEqual([
      true,
      "drop_table",
      ["Datanotes/main/public/book_copy/_archive/Dune.md", "Datanotes/main/public/book_copy/_archive/Emma.md"],
    ]);
    expect(api.listTables().map((t) => t.qualified)).toEqual(["main.public.book", "main.public.person"]);
  }, SLOW);

  it("bases and comments show in the description of the database", async () => {
    const { api } = library();
    await books(api);
    expect((await api.defineBase(describedBase({ name: "named", description: "Things with a nickname", columns: [{ name: "nickname", type: "string" }] }))).op).toBe("define_base");
    expect((await api.setTableBases({ table: "person", bases: ["named"] })).op).toBe("set_table_bases");
    expect(await columns(api, "person")).toEqual([
      ["id", "string"],
      ["nickname", "string"],
      ["name", "string"],
    ]);
    expect((await api.commentOn({ catalog: "main", description: "My library" })).op).toBe("comment_on");
    expect((await api.commentOn({ catalog: "main", schema: "public", description: "Shelves" })).ok).toBe(true);

    expect(await api.describeDatabase()).toEqual({
      root: "Datanotes",
      metastore: "Datanotes/metastore.yaml",
      journal: "store:journal",
      config: { default_catalog: "main", default_schema: "public", default_partition: "", default_filename: "YYYY-MM-DD[T]HHmm", archive_folder: "_archive", timezone: "", history: true, autolink: true },
      catalogs: [
        {
          catalog: "main",
          description: "My library",
          default: true,
          schemas: [
            {
              schema: "public",
              description: "Shelves",
              tables: [
                { name: "person", qualified: "main.public.person", row_count: 1, description: "Authors of my books" },
                { name: "book", qualified: "main.public.book", row_count: 2, description: "Books on my shelves" },
              ],
              views: [],
            },
          ],
        },
      ],
      bases: [{ name: "named", description: "Things with a nickname", columns: ["nickname"], tables: ["main.public.person"] }],
    });
  }, SLOW);
});

describe("in-process API: rows of a reading list", () => {
  it("are updated, merged, aligned with their inverse links, moved, adopted, recomputed and deleted", async () => {
    const { v, api } = library({ "Inbox/Neuromancer.md": "---\ntitle: Neuromancer\npages: 271\n---\nCyberspace.\n" });
    await books(api, [{ name: "label", type: "string", generated: "{title} ({pages}p)" }]);
    expect((await api.createTable(described({ name: "wishlist", options: { filename: "{title}" }, columns: [{ name: "title", type: "string", required: true, dense: true }, { name: "pages", type: "integer" }] }))).ok).toBe(true);
    expect((await api.insertRow({ table: "person", values: { name: "Jane Austen" } })).ok).toBe(true);

    // update_rows: refused unless the filter matches the expected number of rows
    const two = await api.updateRows({ table: "book", where: { pages: { gte: 1 } }, set: { status: "reading" }, expectCount: 1 });
    expect([two.ok, two.migration_id, two.conflicts]).toEqual([false, undefined, [{ path: "Datanotes/main/public/book", message: `"where" matched 2 rows, expected 1: nothing was written` }]]);
    const upd = await api.updateRows({ table: "book", where: { title: "Emma" }, set: { author: "[[Jane Austen]]" }, expectCount: 1 });
    expect([upd.ok, upd.op, upd.planned_edits]).toEqual([true, "update_rows", [{ path: `${BOOK}/Emma.md`, set: { author: "[[Jane Austen]]" }, remove: [] }]]);
    expect(await rowsOf(api, "book", ["title", "author", "label"])).toEqual([
      { path: `${BOOK}/Dune.md`, title: "Dune", author: "[[Frank Herbert]]", label: "Dune (412p)" },
      { path: `${BOOK}/Emma.md`, title: "Emma", author: "[[Jane Austen]]", label: "Emma (300p)" },
    ]);

    // the reciprocal column, declared on existing data, then aligned
    expect((await api.addColumn(described({ table: "person", column: { name: "books", type: "list", items: "link", ref: "main.public.book", inverse: "author" } }))).ok).toBe(true);
    const check = await api.checkTable();
    expect([check.table, check.tables_checked, check.violations.map((x) => [x.path, x.violations.map((y) => y.code)])]).toEqual([
      null,
      3,
      [
        [`${BOOK}/Dune.md`, ["inverse"]],
        [`${BOOK}/Emma.md`, ["inverse"]],
      ],
    ]);
    const align = await api.alignRelations({ table: "book" });
    expect([align.op, align.notes_changed]).toEqual(["align_relations", 2]);
    expect(await rowsOf(api, "person", ["name", "books"])).toEqual([
      { path: `${PERSON}/Frank Herbert.md`, name: "Frank Herbert", books: ["[[Dune]]"] },
      { path: `${PERSON}/Jane Austen.md`, name: "Jane Austen", books: ["[[Emma]]"] },
    ]);

    // merge_rows: Dune is updated, Persuasion inserted
    const merge = await api.mergeRows({ table: "book", on: ["title"], rows: [{ title: "Dune", pages: 500 }, { title: "Persuasion", pages: 250, status: "to_read" }] });
    expect([merge.op, merge.planned_creates]).toEqual(["merge_rows", [`${BOOK}/Persuasion.md`]]);
    expect(await rowsOf(api, "book", ["title", "pages", "status", "label"])).toEqual([
      { path: `${BOOK}/Dune.md`, title: "Dune", pages: 500, status: "to_read", label: "Dune (500p)" },
      { path: `${BOOK}/Emma.md`, title: "Emma", pages: 300, status: "reading", label: "Emma (300p)" },
      { path: `${BOOK}/Persuasion.md`, title: "Persuasion", pages: 250, status: "to_read", label: "Persuasion (250p)" },
    ]);

    // move_rows: the books not started go to the wish list
    const move = await api.moveRows({ table: "book", toTable: "wishlist", where: { status: "to_read", title: { ne: "Dune" } }, drop: ["status", "label"], relocate: true });
    expect([move.op, move.planned_moves]).toEqual(["move_rows", [{ from: `${BOOK}/Persuasion.md`, to: "Datanotes/main/public/wishlist/Persuasion.md" }]]);
    expect(await rowsOf(api, "wishlist", ["title", "pages"])).toEqual([{ path: "Datanotes/main/public/wishlist/Persuasion.md", title: "Persuasion", pages: 250 }]);

    // adopt_rows: a note of the inbox becomes a book
    const adopt = await api.adoptRows({ table: "book", paths: ["Inbox/Neuromancer"], set: { status: "to_read" } });
    expect([adopt.op, adopt.planned_moves]).toEqual(["adopt_rows", [{ from: "Inbox/Neuromancer.md", to: `${BOOK}/Neuromancer.md` }]]);
    expect(v.read(`${BOOK}/Neuromancer.md`)).toContain("Cyberspace.");

    // recompute_columns: a hand edit left the generated label stale
    v.write(`${BOOK}/Dune.md`, v.read(`${BOOK}/Dune.md`).replace("pages: 500", "pages: 520"));
    const recompute = await api.recomputeColumns({ table: "book" });
    expect([recompute.op, recompute.planned_edits]).toEqual(["recompute_columns", [{ path: `${BOOK}/Dune.md`, set: { label: "Dune (520p)" }, remove: [] }]]);

    // delete_rows: a book its author links to is kept, unless the links are cleared
    const restrict = await api.deleteRows({ table: "book", where: { title: "Emma" } });
    expect([restrict.ok, restrict.conflicts]).toEqual([false, [{ path: `${BOOK}/Emma.md`, message: `referenced by ${PERSON}/Jane Austen.md` }]]);
    const del = await api.deleteRows({ table: "book", where: { title: "Emma" }, mode: "delete", onReferenced: "set_null" });
    expect([del.ok, del.op, del.planned_deletes]).toEqual([true, "delete_rows", [`${BOOK}/Emma.md`]]);
    expect(await rowsOf(api, "book", ["title", "pages", "label"])).toEqual([
      { path: `${BOOK}/Dune.md`, title: "Dune", pages: 520, label: "Dune (520p)" },
      { path: `${BOOK}/Neuromancer.md`, title: "Neuromancer", pages: 271, label: "Neuromancer (271p)" },
    ]);
    expect(await rowsOf(api, "person", ["name", "books"])).toEqual([
      { path: `${PERSON}/Frank Herbert.md`, name: "Frank Herbert", books: ["[[Dune]]"] },
      { path: `${PERSON}/Jane Austen.md`, name: "Jane Austen", books: [] },
    ]);
    expect((await api.checkTable()).violations).toEqual([]);
  }, SLOW);
});

describe("in-process API: history", () => {
  it("describes the log, reads its changes, travels in time, restores and vacuums", async () => {
    const { api } = library();
    const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 9, 1, 9, minute)) });
    expect((await api.configureDatabase({ history: true })).config.history).toBe(true);
    await api.createTable(described({ name: "book", options: { filename: "{title}" }, columns: [{ name: "title", type: "string", required: true, dense: true }, { name: "pages", type: "integer" }] }), at(0));
    await api.insertRow({ table: "book", values: { title: "Dune", pages: 412 } }, at(1));
    await api.updateRows({ table: "book", where: { title: "Dune" }, set: { pages: 500 } }, at(2));
    await api.insertRow({ table: "book", values: { title: "Emma", pages: 300 } }, at(3));

    const h = await api.describeHistory({ table: "book" });
    expect([h.table, h.history.map((c) => [c.version, c.operation, c.timestamp])]).toEqual([
      "main.public.book",
      [
        [3, "WRITE", "2026-10-01T09:03:00.000Z"],
        [2, "UPDATE", "2026-10-01T09:02:00.000Z"],
        [1, "WRITE", "2026-10-01T09:01:00.000Z"],
        [0, "CREATE TABLE", "2026-10-01T09:00:00.000Z"],
      ],
    ]);
    const feed = await api.tableChanges({ table: "book", startVersion: 2 });
    expect(feed.changes.map((c) => [c._commit_version, c._change_type, c.title, c.pages])).toEqual([
      [2, "update_preimage", "Dune", 412],
      [2, "update_postimage", "Dune", 500],
      [3, "insert", "Emma", 300],
    ]);

    const restore = await api.restoreTable({ table: "book", version: 1 });
    expect([restore.ok, restore.op, restore.planned_deletes, restore.commits]).toEqual([
      true,
      "restore_table",
      [`${BOOK}/Emma.md`],
      [{ table: "main.public.book", version: 4, operation: "RESTORE" }],
    ]);
    expect(await rowsOf(api, "book", ["title", "pages"])).toEqual([{ path: `${BOOK}/Dune.md`, title: "Dune", pages: 412 }]);
    // the whole database: its history, and every table back to just before the restore (a dry run)
    expect((await api.describeDatabaseHistory()).history[0]).toMatchObject({ table: "main.public.book", version: 4, operation: "RESTORE" });
    const back = await api.restoreDatabase({ beforeMigration: restore.migration_id! }, { dryRun: true });
    expect([back.ok, back.dry_run, back.tables.map((t) => [t.table, t.version, t.creates])]).toEqual([true, true, [["main.public.book", 3, [`${BOOK}/Emma.md`]]]]);
    expect((await api.select({ table: "book", columns: ["title", "pages"], version: 3 })).rows).toEqual([
      { path: `${BOOK}/Dune.md`, title: "Dune", pages: 500 },
      { path: `${BOOK}/Emma.md`, title: "Emma", pages: 300 },
    ]);

    const old = [0, 1, 2, 3].map((n) => `store:transaction_log/main.public.book/${String(n).padStart(20, "0")}.json`);
    expect(await api.vacuumTable({ table: "book", retainFrom: 4 }, { dryRun: true })).toEqual({ table: "main.public.book", retained_from: 4, deleted: old, dry_run: true });
    expect((await api.describeHistory({ table: "book" })).history).toHaveLength(5);
    expect(await api.vacuumTable({ table: "book", retainFrom: 4 })).toEqual({ table: "main.public.book", retained_from: 4, deleted: old, dry_run: false });
    expect((await api.describeHistory({ table: "book" })).history.map((c) => [c.version, c.operation])).toEqual([[4, "RESTORE"]]);
    await expect(api.select({ table: "book", version: 3 })).rejects.toThrow("no version 3");
  }, SLOW);
});

describe("in-process API: notes into a table, then explored", () => {
  /** Bag-of-words embeddings: no model, no network. */
  const VOCAB = ["desert", "spice", "ball", "marriage", "club"];
  const embeddings: Transport = async (req) => {
    const { input } = JSON.parse(req.body) as { input: string[] };
    const data = input.map((t, index) => ({ index, embedding: VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1 : 0) + 0.01) }));
    return { status: 200, text: JSON.stringify({ data }) };
  };

  it("infers a table, adopts the notes, walks their links and searches them by meaning", async () => {
    const v = createDbVault({
      "Inbox/Dune.md": "---\ntitle: Dune\npages: 412\nread_on: 2026-09-01\n---\nA desert planet and its spice.\n",
      "Inbox/Emma.md": "---\ntitle: Emma\npages: 300\nread_on: 2026-09-15\n---\nA ball and a marriage.\n",
      "Notes/Club.md": "Book club: [[Dune]] then [[Emma]].\n",
    });
    Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "bag-of-words" });
    const api = createPublicApi(v.app, () => v.settings, undefined, new SemanticIndex(v.app, () => v.settings, embeddings));

    const inferred = await api.inferTable({ folder: "Inbox", name: "book" });
    expect([inferred.files, inferred.proposal, inferred.adopt]).toEqual([
      2,
      {
        name: "book",
        description: null,
        options: { filename: "{title}" },
        columns: [
          { name: "pages", type: "integer", description: null, required: true, dense: true },
          { name: "read_on", type: "date", description: null, required: true, dense: true },
          { name: "title", type: "string", description: null, required: true, dense: true },
        ],
      },
      { paths: ["Inbox/Dune.md", "Inbox/Emma.md"], relocate: false },
    ]);
    // the descriptions the notes cannot give, written before the table is created
    const meaning: Record<string, string> = { pages: "How many pages it has", read_on: "The day I finished it", title: "The book's title" };
    const proposal = { ...inferred.proposal!, description: "Books I read", columns: inferred.proposal!.columns.map((c) => ({ ...c, description: meaning[String(c.name)] })) };
    expect((await api.createTable(proposal)).ok).toBe(true);
    expect((await api.adoptRows({ table: "book", ...inferred.adopt! })).notes_changed).toBe(2);
    expect(await api.select({ table: "book", columns: ["title", "read_on"], orderBy: "-read_on" })).toEqual({
      table: "main.public.book",
      total: 2,
      rows: [
        { path: "Inbox/Emma.md", title: "Emma", read_on: "2026-09-15" },
        { path: "Inbox/Dune.md", title: "Dune", read_on: "2026-09-01" },
      ],
    });
    expect((await api.inferTable({ table: "book" })).columns).toEqual([]); // nothing undeclared left

    expect(await api.graphNeighbors({ from: { table: "book", where: { title: "Dune" } } })).toEqual({
      nodes: [{ path: "Inbox/Dune.md", table: "main.public.book", counts: { "in:link": 1 }, edges: [{ path: "Notes/Club.md", label: "link", direction: "in" }] }],
    });
    const walk = await api.graphTraverse({ from: { paths: ["Notes/Club"] }, maxDepth: 1, tables: ["book"] });
    expect(walk.nodes.map((n) => [n.path, n.table, n.depth])).toEqual([
      ["Inbox/Dune.md", "main.public.book", 1],
      ["Inbox/Emma.md", "main.public.book", 1],
    ]);
    const path = await api.graphPath({ from: { table: "book", where: { title: "Dune" } }, to: { table: "book", where: { title: "Emma" } } });
    expect(path.via.map((s) => [s.from, s.direction, s.to])).toEqual([
      ["Inbox/Dune.md", "in", "Notes/Club.md"],
      ["Notes/Club.md", "out", "Inbox/Emma.md"],
    ]);

    expect(api.semanticStatus()).toEqual({ enabled: true, provider: "custom", model: "bag-of-words", files: 0, passages: 0, pending: 0, running: false });
    expect(await api.semanticSync()).toMatchObject({ embedded: 3, removed: 0, unchanged: 0, failed: [] });
    expect(await api.semanticSearch({ query: "spice in the desert", limit: 1 })).toEqual({
      query: "spice in the desert",
      results: [{ path: "Inbox/Dune.md", score: 1, heading: "", snippet: "A desert planet and its spice.", table: "main.public.book" }],
    });
    expect(api.semanticStatus()).toMatchObject({ files: 3, passages: 3, pending: 0, running: false });
    expect(await api.semanticSync()).toMatchObject({ embedded: 0, unchanged: 3 });
    expect(await api.semanticSync({ rebuild: true })).toMatchObject({ embedded: 3, unchanged: 0 });
  }, SLOW);
});

describe("in-process API: settings", () => {
  it("moving the database folder saves the settings, and later calls follow them", async () => {
    const { v, api } = library();
    await books(api);
    const moved = await api.configureDatabase({ root: "Library" }); // the default saveSettings: nothing to persist
    expect([moved.root, moved.metastore, v.settings.databaseFolder]).toEqual(["Library", "Library/metastore.yaml", "Library"]);
    expect(await rowsOf(api, "book", ["title"])).toEqual([
      { path: "Library/main/public/book/Dune.md", title: "Dune" },
      { path: "Library/main/public/book/Emma.md", title: "Emma" },
    ]);
    expect((await api.describeTable("book")).layout).toMatchObject({ folder: "Library/main/public/book" });
    expect(api.listTables().map((t) => t.qualified)).toEqual(["main.public.book", "main.public.person"]);
    expect((await api.insertRow({ table: "book", values: { title: "Emma" } })).planned_creates).toEqual(["Library/main/public/book/Emma-2.md"]);
    expect(v.exists("Datanotes/metastore.yaml")).toBe(false);
  }, SLOW);
});

describe("in-process API: refusals", () => {
  it("a batch needs a list of operations, each naming a write", async () => {
    const { api } = library();
    const names = Object.keys(BATCH_OPS).join(", ");
    await expect(api.batch(undefined as never)).rejects.toThrow(`"operations" must be a list`);
    await expect(api.batch({ operations: "insert_row" as never })).rejects.toThrow(`"operations" must be a list`);
    await expect(api.batch({ operations: [null as never] })).rejects.toThrow(`operation 0: "op" must be one of ${names}`);
    await expect(api.batch({ operations: [{ op: "select" }] })).rejects.toThrow(`operation 0: "op" must be one of ${names}`);
    await expect(api.batch({ operations: [described({ op: "create_table", name: "a", columns: [] }), { op: 3 } as never] })).rejects.toThrow(`operation 1: "op" must be one of ${names}`);
    expect(api.listTables()).toEqual([]); // refused before anything ran
  }, SLOW);

  it("semantic search needs an index", async () => {
    const { api } = library();
    expect(() => api.semanticStatus()).toThrow("semantic search is not available");
    await expect(async () => api.semanticSearch({ query: "spice" })).rejects.toThrow("semantic search is not available");
    await expect(async () => api.semanticSync()).rejects.toThrow("semantic search is not available");
  }, SLOW);
});
