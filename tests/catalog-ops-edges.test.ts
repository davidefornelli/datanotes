/**
 * catalog-ops.ts edges: create_view refusals and names, selecting through a view (the caller's
 * filter combined with the stored one), CHECK refusals, comment_on on an empty catalog,
 * information_schema values, and clone_table file names (no file name pattern, a value missing,
 * names already taken, empty bodies).
 */

import { describe, expect, it } from "vitest";
import { addConstraint, commentOn, cloneTable, createView } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { AmbiguousCatalogRefError, parseMetastore } from "../src/core/metastore";
import { insertRow, select } from "../src/core/rows";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const model = (v: DbVault) => parseMetastore(v.read(METASTORE));

async function refused(p: Promise<unknown>, cls: abstract new (...args: never[]) => Error, message: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(cls);
  expect((e as Error).message).toBe(message);
}

const M = "Datanotes/personal/metrics/mood";

/** `personal.metrics.mood` (default catalog `personal`) with three rows: values 1, 4, 2. */
async function moodVault(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome", default_catalog: "personal" }, async () => {});
  const r = await createTable(v.app, v.settings, described({
    schema: "metrics",
    name: "mood",
    timeColumn: "occurred_at",
    columns: [
      { name: "occurred_at", type: "datetime", required: true, dense: true },
      { name: "value", type: "integer", min: 1, max: 5, default: 3 },
      { name: "note", type: "string" },
    ],
  }));
  expect(r.ok).toBe(true);
  for (const [h, value] of [["09", 1], ["10", 4], ["11", 2]] as const) {
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: `2026-09-26T${h}:00`, value } })).ok).toBe(true);
  }
  return v;
}

const values = (rows: Record<string, unknown>[]) => rows.map((r) => r.value);

describe("create_view refusals", () => {
  it("refuses a name that is not an identifier and the reserved catalog", async () => {
    const v = await moodVault();
    const before = v.read(METASTORE);
    await refused(
      createView(v.app, v.settings, { name: "Low-Mood", query: { table: "mood" } }),
      OperationInputError,
      `table "Low-Mood" must be lowercase letters, digits and _ (starting with a letter)`,
    );
    await refused(createView(v.app, v.settings, { catalog: "system", name: "low_mood", query: { table: "mood" } }), OperationInputError, `"system" is a reserved catalog`);
    expect(v.read(METASTORE)).toBe(before);
  });

  it("refuses a query with an unknown key, a union that is not a list of branches, or no table", async () => {
    const v = await moodVault();
    const cases: [Record<string, unknown>, string][] = [
      [{ table: "mood", having: { value: 1 } }, `view query: unknown key "having" (allowed: table, union, columns, where, order_by, limit, join, group_by, aggregates, expand)`],
      [{ union: { table: "mood" } }, `view query: "union" must be a list of { table, columns?, where? }`],
      [{ union: ["mood"] }, `view query: each union branch is { table, columns?, where? }`],
      [{ union: [{ columns: ["value"] }] }, `view query: each union branch is { table, columns?, where? }`],
      [{ where: { value: 1 } }, `view query needs "table" (or "union")`],
    ];
    for (const [query, message] of cases) await refused(createView(v.app, v.settings, { schema: "metrics", name: "bad", query }), OperationInputError, message);
  });

  it("refuses a label that is not a string", async () => {
    const v = await moodVault();
    await refused(
      createView(v.app, v.settings, { schema: "metrics", name: "low_mood", labels: { value: 3 as never }, query: { table: "mood" } }),
      OperationInputError,
      `labels.value must be a string`,
    );
  });

  it("puts a schema.view name in the default catalog", async () => {
    const v = await moodVault();
    const r = await createView(v.app, v.settings, { name: "metrics.low_mood", query: { table: "mood", where: { value: { lte: 2 } } } });
    expect([r.ok, r.planned_texts]).toEqual([true, [METASTORE]]);
    expect(model(v).catalogs.personal!.schemas.metrics!.views).toEqual({ low_mood: { query: { table: "mood", where: { value: { lte: 2 } } } } });
    const rows = await select(v.app, v.settings, { table: "personal.metrics.low_mood", orderBy: "-value" });
    expect([rows.view, values(rows.rows)]).toEqual(["personal.metrics.low_mood", [2, 1]]);
  });
});

describe("selecting through a view", () => {
  it("the caller's or / and / not is the whole filter when the view has none", async () => {
    const v = await moodVault();
    expect((await createView(v.app, v.settings, { schema: "metrics", name: "all_mood", query: { table: "mood", columns: ["occurred_at", "value"] } })).ok).toBe(true);
    const r = await select(v.app, v.settings, { table: "all_mood", where: { or: [{ value: 1 }, { value: 4 }] }, orderBy: "-value" });
    expect(values(r.rows)).toEqual([4, 1]);
  });

  it("keeps the view's equality next to the caller's range on the same column: the caller only narrows", async () => {
    const v = await moodVault();
    expect((await createView(v.app, v.settings, { schema: "metrics", name: "twos", query: { table: "mood", where: { value: 2 } } })).ok).toBe(true);
    expect(values((await select(v.app, v.settings, { table: "twos", where: { value: { gte: 1 } } })).rows)).toEqual([2]);
    expect((await select(v.app, v.settings, { table: "twos", where: { value: { lte: 1 } } })).rows).toEqual([]);
  });

  it("a name two tables share is refused as ambiguous, not taken for a view", async () => {
    const v = await moodVault();
    const r = await createTable(v.app, v.settings, described({ schema: "health", name: "mood", timeColumn: "at", columns: [{ name: "at", type: "datetime" }] }));
    expect(r.ok).toBe(true);
    await refused(select(v.app, v.settings, { table: "mood" }), AmbiguousCatalogRefError, `"mood" matches personal.health.mood, personal.metrics.mood; use catalog.schema.table`);
    expect((await select(v.app, v.settings, { table: "metrics.mood" })).total).toBe(3);
  });
});

describe("CHECK constraints", () => {
  it("refuse a check that is not a non-empty where filter, and a name already used", async () => {
    const v = await moodVault();
    for (const check of [{}, [], null, "value > 1"]) {
      await refused(addConstraint(v.app, v.settings, { table: "mood", name: "value_range", check: check as never }), OperationInputError, `"check" must be a non-empty where filter`);
    }
    expect((await addConstraint(v.app, v.settings, { table: "mood", name: "value_range", check: { value: { gte: 1, lte: 5 } } })).ok).toBe(true);
    await refused(
      addConstraint(v.app, v.settings, { table: "mood", name: "value_range", check: { value: { gte: 2 } } }),
      OperationInputError,
      `constraint "value_range" already exists; drop it first`,
    );
    expect(model(v).catalogs.personal!.schemas.metrics!.tables.mood!.constraints).toEqual({ value_range: { value: { gte: 1, lte: 5 } } });
  });
});

describe("comment_on", () => {
  it("names no schema of a catalog written without any", async () => {
    const v = createDbVault({ [METASTORE]: `${withTables("")}  work:\n    description: Job\n` });
    await refused(
      commentOn(v.app, v.settings, { catalog: "work", schema: "projects", description: "Client work" }),
      OperationInputError,
      `unknown schema "projects" in catalog work (schemas: none yet)`,
    );
  });
});

describe("information_schema", () => {
  it("refuses a table it does not have", async () => {
    const v = await moodVault();
    await refused(
      select(v.app, v.settings, { table: "information_schema.indexes" }),
      OperationInputError,
      `system.information_schema has: catalogs, schemata, tables, columns, views, check_constraints`,
    );
  });

  it("shows schema and view comments (null when none) and non-text defaults as text", async () => {
    const v = await moodVault();
    await createTable(v.app, v.settings, described({ schema: "health", name: "sleep", timeColumn: "night_of", columns: [{ name: "night_of", type: "date" }] }));
    expect((await commentOn(v.app, v.settings, { catalog: "personal", schema: "metrics", description: "Body signals" })).ok).toBe(true);
    expect((await createView(v.app, v.settings, { schema: "metrics", name: "low_mood", query: { table: "mood", where: { value: { lte: 2 } } } })).ok).toBe(true);
    const schemata = await select(v.app, v.settings, { table: "information_schema.schemata", columns: ["schema_name", "comment"] });
    expect(schemata.rows.map((r) => [r.schema_name, r.comment ?? null])).toEqual([
      ["metrics", "Body signals"],
      ["health", null],
    ]);
    const views = await select(v.app, v.settings, { table: "information_schema.tables", where: { table_type: "VIEW" }, columns: ["full_name", "comment"] });
    expect(views.rows.map((r) => [r.full_name, r.comment ?? null])).toEqual([["personal.metrics.low_mood", null]]);
    const cols = await select(v.app, v.settings, { table: "information_schema.columns", where: { table_name: "mood" }, columns: ["column_name", "data_type", "column_default"] });
    expect(cols.rows.map((r) => [r.column_name, r.data_type, r.column_default ?? null])).toEqual([
      ["id", "string", null],
      ["occurred_at", "datetime", null],
      ["value", "integer", "3"],
      ["note", "string", null],
    ]);
  });

  it("types a list column written by hand without items as a list of strings", async () => {
    const v = createDbVault({ [METASTORE]: withTables("reading:\n  columns:\n    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }\n    - { name: shelves, type: list }\n") });
    const cols = await select(v.app, v.settings, { table: "information_schema.columns", where: { table_name: "reading" }, columns: ["column_name", "data_type"] });
    expect(cols.rows.map((r) => [r.column_name, r.data_type])).toEqual([
      ["id", "string"],
      ["shelves", "list<string>"],
    ]);
  });
});

describe("clone_table", () => {
  const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";

  it("copies the rows of a table with no file name pattern under their own names; a note with no body gets an empty one", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(`note:\n  description: Notes to keep\n  columns:\n    - ${ID}\n    - { name: title, type: string, description: The note title }\n`),
      "Notes/Reading list.md": "---\ntable: main.public.note\nid: 0199f000-0000-7000-8000-000000000001\ntitle: Reading list\n---\n",
      "Notes/Ideas.md": "---\ntable: main.public.note\nid: 0199f000-0000-7000-8000-000000000002\ntitle: Ideas\n---\nWrite more.\n",
    });
    const r = await cloneTable(v.app, v.settings, { source: "note", target: "note_copy" });
    expect([r.ok, r.planned_creates]).toEqual([true, ["Datanotes/main/public/note_copy/Ideas.md", "Datanotes/main/public/note_copy/Reading list.md"]]);
    const entry = model(v).catalogs.main!.schemas.public!.tables.note_copy!;
    // no row options (no folder pattern, no file name), the source's columns with the system id
    expect(entry.options ?? {}).toEqual({});
    expect(entry.columns).toEqual([
      { name: "id", type: "string", unique: true, identity: "uuid", required: true, dense: true, description: "Unique id of the row (UUIDv7): set when the row is created, never changes" },
      { name: "title", type: "string", description: "The note title" },
    ]);
    const copy = fm(v, "Datanotes/main/public/note_copy/Reading list.md");
    expect(copy).toMatchObject({ table: "main.public.note_copy", title: "Reading list" });
    expect(copy.id).not.toBe("0199f000-0000-7000-8000-000000000001");
    expect(readOrderedFromMarkdown(v.read("Datanotes/main/public/note_copy/Reading list.md")).body).toBe("\n");
    expect(readOrderedFromMarkdown(v.read("Datanotes/main/public/note_copy/Ideas.md")).body).toBe("Write more.\n");
    expect((await select(v.app, v.settings, { table: "note_copy" })).total).toBe(2);
  });

  it("puts a schema.table target in the source's catalog, not the default one", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    expect((await createTable(v.app, v.settings, described({ catalog: "home", schema: "lib", name: "book", options: { filename: "{title}" }, columns: [{ name: "title", type: "string", required: true }] }))).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "book", values: { title: "Dune" } })).ok).toBe(true);
    const r = await cloneTable(v.app, v.settings, { source: "book", target: "archive.book_2025" });
    expect([r.ok, r.planned_creates]).toEqual([true, ["Datanotes/home/archive/book_2025/Dune.md"]]);
    expect(Object.keys(model(v).catalogs)).toEqual(["home"]);
    expect(Object.keys(model(v).catalogs.home!.schemas)).toEqual(["lib", "archive"]);
    expect(fm(v, "Datanotes/home/archive/book_2025/Dune.md")).toMatchObject({ table: "home.archive.book_2025", title: "Dune" });
  });

  it("a row whose file name cannot be rendered keeps its own; a name already taken gets the next free suffix", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    expect((await createTable(v.app, v.settings, described({ schema: "lib", name: "book", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }, { name: "pages", type: "integer" }] }))).ok).toBe(true);
    for (const pages of [412, 896]) expect((await insertRow(v.app, v.settings, { table: "book", values: { title: "Dune", pages } })).ok).toBe(true);
    const B = "Datanotes/main/lib/book";
    expect(v.list().filter((p) => p.startsWith(`${B}/`))).toEqual([`${B}/Dune-2.md`, `${B}/Dune.md`]);
    // a row written by hand without a title, and a note of the user where the first copy would go
    v.write(`${B}/Untitled.md`, "---\ntable: main.lib.book\npages: 10\n---\n");
    v.write("Datanotes/main/lib/book_copy/Dune.md", "# my notes on Dune\n");
    const r = await cloneTable(v.app, v.settings, { source: "book", target: "book_copy" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    const C = "Datanotes/main/lib/book_copy";
    expect([...r.planned_creates].sort()).toEqual([`${C}/Dune-2.md`, `${C}/Dune-3.md`, `${C}/Untitled.md`]);
    expect(fm(v, `${C}/Untitled.md`)).toMatchObject({ table: "main.lib.book_copy", pages: 10 });
    expect([fm(v, `${C}/Dune-2.md`).pages, fm(v, `${C}/Dune-3.md`).pages].sort()).toEqual([412, 896]);
    expect(v.read(`${C}/Dune.md`)).toBe("# my notes on Dune\n");
  });
});
