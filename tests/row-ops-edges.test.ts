/**
 * Row operations at their edges: merge_rows refusals and option combinations, insert_row with
 * values left undefined, update_rows renaming rows that keep their old name as an alias, tables
 * without a filename pattern, update_row by a duplicated id and partial body edits, recompute of
 * rows whose computed values are empty.
 */

import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { insertRow, mergeRows, recomputeColumns, select, updateRow, updateRows } from "../src/core/rows";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const B = "Datanotes/main/lib/book";

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const body = (v: DbVault, p: string) => readOrderedFromMarkdown(v.read(p)).body;

async function refused(p: Promise<unknown>, message: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(OperationInputError);
  await expect(p).rejects.toThrow(message);
}

/**
 * `main.lib.book`, named by its title: `title` (required), `shelf` (dense, no default), `author`,
 * `pages` (min 1), `isbn` (unique), `label` = "{title} ({pages})", `byline` = "{author}",
 * `aliases`; an untyped field `format` (default paper) and a row template.
 */
async function library(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  const r = await createTable(v.app, v.settings, described({
    schema: "lib",
    name: "book",
    options: { filename: "{title}" },
    fields: { format: "paper" },
    rowTemplate: "## Notes\n",
    columns: [
      { name: "title", type: "string", required: true, dense: true },
      { name: "shelf", type: "string", dense: true },
      { name: "author", type: "string" },
      { name: "pages", type: "integer", min: 1 },
      { name: "isbn", type: "string", unique: true },
      { name: "label", type: "string", generated: "{title} ({pages})" },
      { name: "byline", type: "string", generated: "{author}" },
      { name: "aliases", type: "list", items: "string" },
    ],
  }));
  expect(r.ok).toBe(true);
  return v;
}

async function book(v: DbVault, values: Record<string, unknown>): Promise<string> {
  const r = await insertRow(v.app, v.settings, { table: "book", values });
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  return r.planned_creates[0]!;
}

describe("insert_row", () => {
  it("stores a dense column given as undefined as null, like one not given", async () => {
    const v = await library();
    const p = await book(v, { title: "Dune", shelf: undefined });
    expect(fm(v, p)).toMatchObject({ table: "main.lib.book", title: "Dune", shelf: null, format: "paper", label: "Dune" });
    expect(body(v, p)).toBe("## Notes\n");
  });
});

describe("merge_rows refuses what it cannot match", () => {
  it("needs key columns and rows", async () => {
    const v = await library();
    await refused(mergeRows(v.app, v.settings, { table: "book", on: [], rows: [{ title: "Dune" }] }), `"on" needs at least one key column`);
    await refused(mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: [] }), `"rows" needs at least one row`);
    await refused(mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: {} as never }), `"rows" needs at least one row`);
  });

  it("refuses unknown key columns and the path", async () => {
    const v = await library();
    await refused(mergeRows(v.app, v.settings, { table: "book", on: ["color"], rows: [{ color: "red" }] }), `unknown key column "color"`);
    await refused(mergeRows(v.app, v.settings, { table: "book", on: ["path"], rows: [{ path: "x.md" }] }), `unknown key column "path"`);
  });

  it("refuses a source row that is not an object, or lacks a key value", async () => {
    const v = await library();
    await refused(mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: [{ title: "Dune" }, null as never] }), `rows[1] must be an object`);
    await refused(mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: [["Dune"] as never] }), `rows[0] must be an object`);
    await refused(mergeRows(v.app, v.settings, { table: "book", on: ["title", "author"], rows: [{ title: "Dune", author: "" }] }), `rows[0] has no value for key column "author"`);
    expect(v.list().filter((p) => p.startsWith(B))).toEqual([]);
  });

  it("refuses unknown, membership and generated columns on a matched row", async () => {
    const v = await library();
    await book(v, { title: "Dune", pages: 412 });
    const merge = (row: Record<string, unknown>) => mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: [row] });
    await refused(merge({ title: "Dune", color: "red" }), `unknown column "color" for table "book"`);
    await refused(merge({ title: "Dune", table: "main.lib.other" }), `unknown column "table" for table "book"`);
    await refused(merge({ title: "Dune", path: "Elsewhere/Dune.md" }), `unknown column "path" for table "book"`);
    await refused(merge({ title: "Dune", label: "Dune!" }), `"label" is a generated column: its value is computed`);
    expect(fm(v, `${B}/Dune.md`)).toMatchObject({ pages: 412, label: "Dune (412)" });
  });

  it("is a conflict when a key matches several rows: nothing is written", async () => {
    const v = await library();
    await book(v, { title: "Emma", author: "Austen" });
    await book(v, { title: "Persuasion", author: "Austen" });
    await book(v, { title: "Dune" }); // no author: its key is null
    const r = await mergeRows(v.app, v.settings, { table: "book", on: ["author"], rows: [{ author: "Austen", pages: 300 }, { author: "Herbert", title: "Dune Messiah" }] });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ path: `${B}/Emma.md`, message: `2 rows match key ["Austen"]` }]);
    expect(r.planned_creates).toEqual([`${B}/Dune Messiah.md`]);
    expect(v.exists(`${B}/Dune Messiah.md`)).toBe(false);
    expect(fm(v, `${B}/Emma.md`).pages).toBeUndefined();
  });
});

describe("merge_rows writes", () => {
  it("leaves a matched row with the same values alone", async () => {
    const v = await library();
    await book(v, { title: "Dune", pages: 412 });
    const before = v.read(`${B}/Dune.md`);
    const r = await mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: [{ title: "Dune", pages: 412 }] });
    expect([r.ok, r.notes_changed, r.planned_edits, r.planned_creates]).toEqual([true, 0, [], []]);
    expect(v.read(`${B}/Dune.md`)).toBe(before);
  });

  it("sets untyped fields and clears optional columns without violations", async () => {
    const v = await library();
    await book(v, { title: "Dune", pages: 412 });
    const r = await mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: [{ title: "Dune", format: "ebook", pages: null }] });
    expect(r.ok).toBe(true);
    expect(r.planned_edits).toEqual([{ path: `${B}/Dune.md`, set: { format: "ebook", pages: null, label: "Dune" }, remove: [] }]);
    expect(fm(v, `${B}/Dune.md`)).toMatchObject({ format: "ebook", pages: null, label: "Dune" });
  });

  it("refuses to empty a required column of a matched row", async () => {
    const v = await library();
    await book(v, { title: "Dune", isbn: "978-0441013593" });
    const r = await mergeRows(v.app, v.settings, { table: "book", on: ["isbn"], rows: [{ isbn: "978-0441013593", title: null }] });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ path: `${B}/Dune.md`, violations: [{ column: "title", code: "required", message: "is required" }] }]);
    expect(fm(v, `${B}/Dune.md`).title).toBe("Dune");
  });

  it("gives an inserted row the table's row template", async () => {
    const v = await library();
    const r = await mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: [{ title: "Emma", author: "Austen" }] });
    expect(r.ok).toBe(true);
    expect(r.planned_creates).toEqual([`${B}/Emma.md`]);
    expect(body(v, `${B}/Emma.md`)).toBe("## Notes\n");
    expect(fm(v, `${B}/Emma.md`)).toMatchObject({ title: "Emma", author: "Austen", byline: "Austen", format: "paper" });
  });
});

describe("update_rows renames a row and keeps its old name as an alias", () => {
  it("adds the old name to empty, list and single-value aliases", async () => {
    const v = await library();
    await book(v, { title: "Dune" });
    await book(v, { title: "Emma", aliases: ["Emma (novel)"] });
    v.write(`${B}/Persuasion.md`, v.read(`${B}/Emma.md`).replace("title: Emma", "title: Persuasion").replace(/aliases:\n  - Emma \(novel\)/, "aliases: Austen 1817").replace(/^id: .*$/m, "id: 01a0f000-0000-7000-8000-000000000003"));
    const rename = async (from: string, to: string) => {
      const r = await updateRows(v.app, v.settings, { table: "book", where: { title: from }, set: { title: to } });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return r;
    };
    expect((await rename("Dune", "Arrakis")).planned_moves).toEqual([{ from: `${B}/Dune.md`, to: `${B}/Arrakis.md` }]);
    expect(fm(v, `${B}/Arrakis.md`)).toMatchObject({ title: "Arrakis", aliases: ["Dune"], label: "Arrakis" });
    await rename("Emma", "Emma Woodhouse");
    expect(fm(v, `${B}/Emma Woodhouse.md`).aliases).toEqual(["Emma (novel)", "Emma"]);
    await rename("Persuasion", "Anne Elliot");
    expect(fm(v, `${B}/Anne Elliot.md`).aliases).toEqual(["Austen 1817", "Persuasion"]);
  });

  it("adds no alias already there, nor one the new name starts", async () => {
    const v = await library();
    await book(v, { title: "Dune", aliases: ["Dune"] });
    await book(v, { title: "Dune Messiah" });
    let r = await updateRows(v.app, v.settings, { table: "book", where: { title: "Dune" }, set: { title: "Arrakis" } });
    expect(r.ok).toBe(true);
    expect(fm(v, `${B}/Arrakis.md`).aliases).toEqual(["Dune"]);
    r = await updateRows(v.app, v.settings, { table: "book", where: { title: "Dune Messiah" }, set: { title: "Dune" } });
    expect(r.planned_moves).toEqual([{ from: `${B}/Dune Messiah.md`, to: `${B}/Dune.md` }]);
    expect(fm(v, `${B}/Dune.md`).aliases).toBeUndefined();
  });

  it("adds no alias when only the folder changes", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({
      schema: "lib",
      name: "book",
      options: { partition: "{shelf}", filename: "{title}" },
      columns: [
        { name: "title", type: "string", required: true, dense: true },
        { name: "shelf", type: "string", required: true, dense: true },
        { name: "aliases", type: "list", items: "string" },
      ],
    }));
    await book(v, { title: "Dune", shelf: "scifi" });
    const r = await updateRows(v.app, v.settings, { table: "book", where: { title: "Dune" }, set: { shelf: "classics" } });
    expect(r.planned_moves).toEqual([{ from: `${B}/scifi/Dune.md`, to: `${B}/classics/Dune.md` }]);
    expect(fm(v, `${B}/classics/Dune.md`).aliases).toBeUndefined();
  });
});

describe("a table without a filename pattern", () => {
  const NOTE = `note:
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: title, type: string }
`;

  it("updates rows in place, and needs a path to insert", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(NOTE),
      "Notes/a.md": "---\ntable: main.public.note\nid: 01a0f000-0000-7000-8000-0000000000a1\ntitle: First\n---\nA\n",
    });
    const r = await updateRows(v.app, v.settings, { table: "note", set: { title: "Renamed" } });
    expect([r.ok, r.planned_moves]).toEqual([true, []]);
    expect(fm(v, "Notes/a.md").title).toBe("Renamed");
    await refused(insertRow(v.app, v.settings, { table: "note", values: { title: "Second" } }), `table "note" has no filename pattern; pass "path"`);
    const ins = await insertRow(v.app, v.settings, { table: "note", values: { title: "Second" }, path: "Notes/b" });
    expect(ins.planned_creates).toEqual(["Notes/b.md"]);
  });
});

describe("update_row", () => {
  it("refuses an id two notes share (a duplicated note): recompute_columns gives one of them a new one", async () => {
    const v = await library();
    const p = await book(v, { title: "Dune" });
    const copy = `${B}/Dune copy.md`;
    const id = fm(v, p).id as string;
    v.write(copy, v.read(p).replace("title: Dune", "title: Dune copy"));
    await refused(updateRow(v.app, v.settings, { table: "book", id, set: { pages: 10 } }), `id ${id} is used by 2 rows: run recompute_columns`);
    expect((await recomputeColumns(v.app, v.settings, { table: "book" })).ok).toBe(true);
    // the older note keeps the id (by creation time, then path: the file system decides which)
    const ids = [fm(v, p).id, fm(v, copy).id];
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(id);
    expect((await updateRow(v.app, v.settings, { table: "book", id, set: { pages: 10 } })).ok).toBe(true);
    expect(fm(v, ids[0] === id ? p : copy).pages).toBe(10);
  });

  it("prepends and appends to the body without sections", async () => {
    const v = await library();
    const p = await book(v, { title: "Dune" });
    const r = await updateRow(v.app, v.settings, { table: "book", path: p, bodyPrepend: "Read in 2024.\n", bodyAppend: "- spice" });
    expect(r.ok).toBe(true);
    expect(r.planned_edits).toEqual([{ path: p, set: {}, remove: [], body: true }]);
    expect(body(v, p)).toBe("Read in 2024.\n\n## Notes\n\n- spice\n");
  });
});

describe("recompute_columns", () => {
  it("fixes a stale generated column and leaves empty computed values out of the checks", async () => {
    const v = await library();
    const p = await book(v, { title: "Dune", pages: 412 });
    v.write(p, v.read(p).replace("pages: 412", "pages: 500"));
    const r = await recomputeColumns(v.app, v.settings, { table: "book" });
    expect(r.ok).toBe(true);
    expect(r.planned_edits).toEqual([{ path: p, set: { label: "Dune (500)" }, remove: [] }]);
    expect(fm(v, p).byline).toBeUndefined();
    expect((await select(v.app, v.settings, { table: "book", columns: ["label"] })).rows).toEqual([{ path: p, label: "Dune (500)" }]);
  });
});
