/**
 * alter_table at its edges: a name taken by a table, a view or a dropped table's log, rows whose
 * new names clash or keep their old name as an alias, tables without a filename pattern or with
 * an archive given as a vault path, history set and cleared, fields given as undefined.
 */

import { describe, expect, it } from "vitest";
import { createView } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { createTable, dropTable, INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { alterTable, insertRow } from "../src/core/rows";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const B = "Datanotes/main/lib/book";
const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const entryOf = (v: DbVault, name: string) => {
  const lines = v.read(METASTORE).split("\n");
  const i = lines.findIndex((l) => l.trim() === `${name}:`);
  const indent = lines[i]!.search(/\S/);
  const end = lines.findIndex((l, j) => j > i && l.trim() !== "" && l.search(/\S/) <= indent);
  return lines.slice(i, end === -1 ? undefined : end).join("\n");
};

/** `main.lib.book` named by its title, with `author` and `aliases`. */
async function library(history = false): Promise<DbVault> {
  const v = createDbVault({});
  if (history) await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  const r = await createTable(v.app, v.settings, described({
    schema: "lib",
    name: "book",
    options: { filename: "{title}" },
    columns: [
      { name: "title", type: "string", required: true, dense: true },
      { name: "author", type: "string" },
      { name: "aliases", type: "list", items: "string" },
    ],
  }));
  expect(r.ok).toBe(true);
  return v;
}

async function book(v: DbVault, values: Record<string, unknown>): Promise<void> {
  const r = await insertRow(v.app, v.settings, { table: "book", values });
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
}

describe("a new name already taken", () => {
  it("by a table or a view is a conflict", async () => {
    const v = await library();
    await createTable(v.app, v.settings, described({ schema: "lib", name: "film", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] }));
    expect((await createView(v.app, v.settings, { schema: "lib", name: "shelf", query: { table: "main.lib.book" } })).ok).toBe(true);
    const before = v.read(METASTORE);
    for (const name of ["film", "shelf"]) {
      const r = await alterTable(v.app, v.settings, { table: "book", name });
      // history is on in a new database: the table film has a transaction log, a conflict of its own
      const log = name === "film" ? [{ path: "store:transaction_log/main.lib.film", message: "main.lib.film already has a transaction log (a dropped table?): vacuum it or pick another name" }] : [];
      expect([r.ok, r.conflicts]).toEqual([false, [{ path: `Datanotes/metastore.yaml#main.lib.${name}`, message: `main.lib.${name} already exists` }, ...log]]);
    }
    expect(v.read(METASTORE)).toBe(before);
  });

  it("by a dropped table whose transaction log is still there is a conflict", async () => {
    const v = await library(true);
    await createTable(v.app, v.settings, described({ schema: "lib", name: "trip", options: { filename: "{place}" }, columns: [{ name: "place", type: "string" }] }));
    expect((await insertRow(v.app, v.settings, { table: "trip", values: { place: "Rome" } })).ok).toBe(true);
    expect((await dropTable(v.app, v.settings, { table: "trip", mode: "archive" })).ok).toBe(true);
    const r = await alterTable(v.app, v.settings, { table: "book", name: "trip" });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([
      { path: "store:transaction_log/main.lib.trip", message: "main.lib.trip already has a transaction log (a dropped table?): vacuum it or pick another name" },
    ]);
  });
});

describe("rows renamed by a new filename pattern", () => {
  it("clashing names get -2; the old name stays findable as an alias", async () => {
    const v = await library();
    await book(v, { title: "Emma", author: "Austen" });
    await book(v, { title: "Persuasion", author: "Austen", aliases: ["Anne Elliot"] });
    await book(v, { title: "Herbert Dune", author: "Herbert" });
    const r = await alterTable(v.app, v.settings, { table: "book", filename: "{author}" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.planned_moves).toEqual([
      { from: `${B}/Emma.md`, to: `${B}/Austen.md` },
      { from: `${B}/Herbert Dune.md`, to: `${B}/Herbert.md` },
      { from: `${B}/Persuasion.md`, to: `${B}/Austen-2.md` },
    ]);
    expect(fm(v, `${B}/Austen.md`)).toMatchObject({ title: "Emma", aliases: ["Emma"] });
    expect(fm(v, `${B}/Austen-2.md`)).toMatchObject({ title: "Persuasion", aliases: ["Anne Elliot", "Persuasion"] });
    // "Herbert Dune" starts with the new name "Herbert": no alias
    expect(fm(v, `${B}/Herbert.md`).aliases).toBeUndefined();
  });

  it("a row whose old name is already an alias, or a single alias, keeps it once", async () => {
    const v = await library();
    await book(v, { title: "Emma", author: "Austen", aliases: ["Emma"] });
    v.write(`${B}/Dune.md`, "---\ntable: main.lib.book\nid: 01a0f000-0000-7000-8000-0000000000d1\ntitle: Dune\nauthor: Herbert\naliases: Arrakis\n---\n");
    const r = await alterTable(v.app, v.settings, { table: "book", filename: "{author}" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(fm(v, `${B}/Austen.md`).aliases).toEqual(["Emma"]);
    expect(fm(v, `${B}/Herbert.md`).aliases).toEqual(["Arrakis", "Dune"]);
  });
});

describe("a table without a filename pattern", () => {
  const NOTE = `note:
  options:
    archive: Archive/notes
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: title, type: string }
`;
  const row = "---\ntable: main.public.note\nid: 01a0f000-0000-7000-8000-0000000000a1\ntitle: First\n---\nA\n";

  it("renamed: its rows stay where they are and name the new table; a vault-path archive becomes the default folder", async () => {
    const v = createDbVault({ [METASTORE]: withTables(NOTE), "Notes/a.md": row, "Archive/notes/old.md": row.replace("0a1", "0a2").replace("First", "Old") });
    const r = await alterTable(v.app, v.settings, { table: "note", name: "memo" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.planned_moves).toEqual([{ from: "Archive/notes/old.md", to: "Datanotes/main/public/memo/_archive/old.md" }]);
    expect(fm(v, "Notes/a.md")).toMatchObject({ table: "main.public.memo", title: "First" });
    expect(fm(v, "Datanotes/main/public/memo/_archive/old.md")).toMatchObject({ table: "main.public.memo", title: "Old" });
    expect(entryOf(v, "memo")).toContain("archive: _archive");
  });

  it("renamed: an archive given as a path inside the table folder keeps its folder name", async () => {
    const DIARY = `diary:
  options:
    archive: Datanotes/main/public/diary/old
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: title, type: string }
`;
    const v = createDbVault({ [METASTORE]: withTables(DIARY), "Datanotes/main/public/diary/old/x.md": row.replace("note", "diary") });
    const r = await alterTable(v.app, v.settings, { table: "diary", name: "journal" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.planned_moves).toEqual([{ from: "Datanotes/main/public/diary/old/x.md", to: "Datanotes/main/public/journal/old/x.md" }]);
    expect(entryOf(v, "journal")).toContain("archive: old");
  });

  it("history set and cleared: the properties come and go with it", async () => {
    const BARE = `bare:
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: title, type: string }
`;
    const v = createDbVault({ [METASTORE]: withTables(BARE) });
    expect(entryOf(v, "bare")).not.toContain("options");
    expect((await alterTable(v.app, v.settings, { table: "bare", history: true })).ok).toBe(true);
    expect(entryOf(v, "bare")).toContain("history: true");
    expect((await alterTable(v.app, v.settings, { table: "bare", history: null })).ok).toBe(true);
    expect(entryOf(v, "bare")).not.toContain("options");
  });
});

describe("fields", () => {
  it("a field given as undefined is left as it is", async () => {
    const v = await library();
    const r = await alterTable(v.app, v.settings, { table: "book", fields: { format: "paper", shelf: undefined } });
    expect(r.ok).toBe(true);
    expect(entryOf(v, "book")).toContain("format: paper");
    expect(entryOf(v, "book")).not.toContain("shelf");
  });
});

describe("renaming a table whose links point to itself", () => {
  it("a `parent` inherited from a base with ref: self follows the new name; so does an own self link", async () => {
    const { defineBase, setTableBases } = await import("../src/core/catalog-ops");
    const { parseMetastore } = await import("../src/core/metastore");
    const { describeTable } = await import("../src/core/public-api");
    const v = createDbVault({});
    expect((await defineBase(v.app, v.settings, describedBase({ name: "tree", columns: [{ name: "parent", type: "link", ref: "self", hierarchy: true }] }))).ok).toBe(true);
    const cols = [{ name: "name", type: "string", required: true }, { name: "see_also", type: "link", ref: "self" }];
    expect((await createTable(v.app, v.settings, described({ name: "franchise", options: { filename: "{name}" }, columns: cols }))).ok).toBe(true);
    expect((await setTableBases(v.app, v.settings, { table: "franchise", bases: ["tree"] })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "franchise", values: { name: "Marvel" } })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "franchise", values: { name: "X-Men films", parent: "[[Marvel]]", see_also: "[[Marvel]]" } })).ok).toBe(true);

    const r = await alterTable(v.app, v.settings, { table: "franchise", name: "saga" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    const entry = parseMetastore(v.read(METASTORE)).catalogs.main!.schemas.public!.tables.saga!;
    expect(entry.columns.map((c) => c.name)).not.toContain("parent"); // still inherited, not copied
    expect(entry.columns.find((c) => c.name === "see_also")!.ref).toBe("self");
    const d = await describeTable(v.app, v.settings, "saga");
    expect((d.columns as { name: string; ref?: string }[]).filter((c) => c.ref).map((c) => [c.name, c.ref])).toEqual(
      expect.arrayContaining([["parent", "main.public.saga"], ["see_also", "main.public.saga"]]),
    );
  });
});
