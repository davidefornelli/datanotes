/**
 * Every table and column says what it holds (src/core/descriptions.ts): create_table, add_column,
 * clone_table and define_base refuse what has no description, listing every missing one at once;
 * alter_table and alter_column cannot remove one; the engine describes the columns it sets itself.
 * Tables and bases written before the rule stay valid, and describe_table / describe_database name
 * what they lack. The other tests wrap their calls in `described` (tests/helpers/descriptions.ts);
 * these call the operations as an agent would, without it.
 */

import { describe, expect, it } from "vitest";
import { cloneTable, defineBase } from "../src/core/catalog-ops";
import { describeDatabase } from "../src/core/database";
import {
  addColumnRefusal,
  cloneTableRefusal,
  createTableRefusal,
  CREATED_DESCRIPTION,
  defineBaseRefusal,
  descriptionOf,
  engineDescription,
  hasText,
  missingDescriptions,
  removedDescriptionRefusal,
  withEngineDescription,
} from "../src/core/descriptions";
import { addColumn, alterColumn, createTable, dropTable, INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { alterTable } from "../src/core/alter-table";
import { docsUrl } from "../src/core/hints";
import { parseMetastore } from "../src/core/metastore";
import { describeTable } from "../src/core/public-api";
import { insertRow } from "../src/core/rows";
import { MalformedColumnError } from "../src/core/table-loader";
import { SYSTEM_ID_SPEC } from "../src/core/types-table";
import { createDbVault, logVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const model = (v: DbVault) => parseMetastore(v.read(METASTORE));
const entry = (v: DbVault, name: string) => model(v).catalogs.main!.schemas.public!.tables[name]!;

async function refusal(p: Promise<unknown>): Promise<OperationInputError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(OperationInputError);
  return e as OperationInputError;
}

const FILM = {
  name: "film",
  description: "Classic films I watched or want to watch",
  columns: [
    { name: "title", type: "string", required: true, description: "The film's title" },
    { name: "year", type: "integer", description: "Year the film first came out" },
  ],
  options: { filename: "{title}" },
};

describe("the rule, as functions", () => {
  it("a description has text; the engine describes the columns it sets", () => {
    expect([hasText("x"), hasText("  "), hasText(""), hasText(null), hasText(3)]).toEqual([true, false, false, false, false]);
    expect(engineDescription({ name: "id" })).toBe(SYSTEM_ID_SPEC.description);
    expect(engineDescription({ name: "ref", identity: "uuid" })).toBe(SYSTEM_ID_SPEC.description);
    expect(engineDescription({ name: "logged", identity: "created" })).toBe(CREATED_DESCRIPTION);
    expect(engineDescription({ name: "title", identity: "filename" })).toBeUndefined();
    expect(engineDescription({ name: "year" })).toBeUndefined();
  });

  it("withEngineDescription fills only an engine column without one, and leaves anything else as it is", () => {
    const created = { name: "logged", type: "datetime", identity: "created" };
    expect(withEngineDescription(created)).toEqual({ ...created, description: CREATED_DESCRIPTION });
    expect(withEngineDescription({ ...created, description: "When I logged it" })).toEqual({ ...created, description: "When I logged it" });
    const plain = { name: "year", type: "integer" };
    expect(withEngineDescription(plain)).toBe(plain);
    expect(withEngineDescription(null)).toBeNull();
    expect(withEngineDescription("year")).toBe("year");
    const list = [created];
    expect(withEngineDescription(list)).toBe(list);
  });

  it("descriptionOf reads a description with text; missingDescriptions names what lacks one", () => {
    expect(descriptionOf({ description: "a" })).toBe("a");
    expect(descriptionOf({ description: " " })).toBeUndefined();
    // the word of databases is not the file's: it is no description
    expect(descriptionOf({ comment: "b" })).toBeUndefined();
    expect(descriptionOf({ description: "" })).toBeUndefined();
    const cols = [{ name: "id" }, { name: "logged", identity: "created" }, { name: "title", description: "The title" }, { name: "year" }, { name: "minutes", description: "" }];
    expect(missingDescriptions("Films", cols)).toEqual({ table: false, columns: ["year", "minutes"] });
    expect(missingDescriptions(" ", [{ name: "title", description: "The title" }])).toEqual({ table: true, columns: [] });
    expect(missingDescriptions("Films", [{ name: "title", description: "The title" }])).toBeNull();
  });

  it("each refusal names what is missing and gives the call's shape", () => {
    const docs = docsUrl("descriptions");
    const why = "Agents and people understand the schema through them.";
    expect(createTableRefusal("main.public.film", { table: true, columns: [] }, [], false)).toEqual({
      message: "descriptions are required: main.public.film has none for the table",
      guidance: { hint: `Say what a row records in "description" and what each column holds in its own "description": {"name": "film", "description": "<what a row of film records>"}. ${why}`, docs },
    });
    // a column the shape cannot find has no type in it; a proposal is told where the nulls come from
    expect(createTableRefusal("main.public.film", { table: false, columns: ["year"] }, [], true)).toEqual({
      message: "descriptions are required: main.public.film has none for column year",
      guidance: {
        hint: `Say what a row records in "description" and what each column holds in its own "description": {"name": "film", "description": "<what a row of film records>", "columns": [{"name": "year", "description": "<what year holds>"}]}. infer_table leaves every description null: write each one, then call create_table again.`,
        docs,
      },
    });
    expect(addColumnRefusal("main.public.film", { name: "year", type: "integer" })).toEqual({
      message: "descriptions are required: column year of main.public.film has none",
      guidance: { hint: `Say what the column holds in its "description": {"table": "main.public.film", "column": {"name": "year", "type": "integer", "description": "<what year holds>"}}. ${why}`, docs },
    });
    expect(cloneTableRefusal("main.public.film", { table: false, columns: ["year"] })).toEqual({
      message: "descriptions are required: main.public.film has none for column year, and a clone would have none either",
      guidance: { hint: `Describe them on main.public.film first (alter_column {"table": "main.public.film", "column": "year", "changes": {"description": "<what year holds>"}}), then clone it again. ${why}`, docs },
    });
    expect(cloneTableRefusal("main.public.film", { table: true, columns: [] }).guidance.hint).toBe(
      `Describe them on main.public.film first (alter_table {"table": "main.public.film", "description": "<what a row records>"}), then clone it again. ${why}`,
    );
    expect(defineBaseRefusal("dated", { table: true, columns: ["day", "note"] }, [{ name: "day", type: "date" }, { name: "note", type: "string" }])).toEqual({
      message: "descriptions are required: base dated has none for the base and columns day, note",
      guidance: {
        hint: `Say what the tables of the base share in "description" and what each column holds in its own "description": {"name": "dated", "description": "<what tables with these columns share>", "columns": [{"name": "day", "type": "date", "description": "<what day holds>"}, …]}. ${why}`,
        docs,
      },
    });
    expect(removedDescriptionRefusal("main.public.film")).toEqual({
      message: "the description of main.public.film cannot be removed (empty): every table needs one",
      guidance: { hint: `Pass the new text, as in {"table": "main.public.film", "description": "<what a row records>"}, or leave "description" out to keep the one it has.`, docs },
    });
    expect(removedDescriptionRefusal("main.public.film", "year")).toEqual({
      message: "the description of column year of main.public.film cannot be removed (null or empty): every column needs one",
      guidance: { hint: `Pass the new text, as in {"table": "main.public.film", "column": "year", "changes": {"description": "<what year holds>"}}, or leave "description" out to keep the one it has.`, docs },
    });
  });
});

describe("create_table", () => {
  it("refuses a table and columns without descriptions, naming every one, and writes nothing", async () => {
    const v = createDbVault({});
    const e = await refusal(createTable(v.app, v.settings, { name: "film", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }, { name: "year", type: "integer", description: " " }] }));
    expect(e.message).toBe("descriptions are required: main.public.film has none for the table and columns title, year");
    expect(e.hint).toMatch(/^Say what a row records in "description"/);
    expect(e.docs).toBe(docsUrl("descriptions"));
    // a dry run is refused the same way
    await refusal(createTable(v.app, v.settings, { name: "film", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] }, { dryRun: true }));
    expect(v.exists(METASTORE)).toBe(false);
  });

  it("takes the table's description as `description`: text, never empty", async () => {
    const v = createDbVault({});
    expect((await createTable(v.app, v.settings, FILM)).ok).toBe(true);
    expect(entry(v, "film")).toMatchObject({ description: "Classic films I watched or want to watch" });
    const typed = await refusal(createTable(v.app, v.settings, { ...FILM, name: "other", description: 3 as never }));
    expect(typed.message).toBe(`"description" must be a string: what a row of the table records`);
    expect(typed.docs).toBe(docsUrl("descriptions"));
    // an empty description is no description
    expect((await refusal(createTable(v.app, v.settings, { ...FILM, name: "other", description: "  " }))).message).toBe("descriptions are required: main.public.other has none for the table");
  });

  it("describes the columns the engine sets itself: id, and identity uuid or created; not a file name", async () => {
    const v = createDbVault({});
    const columns = [
      ...FILM.columns,
      { name: "logged", type: "datetime", identity: "created" },
      { name: "ref", type: "string", identity: "uuid" },
      { name: "note_name", type: "string", identity: "filename" },
    ];
    expect((await refusal(createTable(v.app, v.settings, { ...FILM, columns }))).message).toBe("descriptions are required: main.public.film has none for column note_name");
    columns[4] = { ...columns[4]!, description: "The film's note, by name" } as never;
    expect((await createTable(v.app, v.settings, { ...FILM, columns })).ok).toBe(true);
    const comments = Object.fromEntries(entry(v, "film").columns.map((c) => [c.name, c.description]));
    expect(comments).toEqual({
      id: SYSTEM_ID_SPEC.description,
      title: "The film's title",
      year: "Year the film first came out",
      logged: CREATED_DESCRIPTION,
      ref: SYSTEM_ID_SPEC.description,
      note_name: "The film's note, by name",
    });
    expect((await describeTable(v.app, v.settings, "film")).missing_descriptions).toBeUndefined();
  });

  it("an infer_table proposal as it is: every description it leaves null, and where they come from", async () => {
    const v = createDbVault({});
    const e = await refusal(createTable(v.app, v.settings, { name: "film", description: null, options: { filename: "{title}" }, columns: [{ name: "title", type: "string", description: null }] }));
    expect(e.message).toBe("descriptions are required: main.public.film has none for the table and column title");
    expect(e.hint).toMatch(/infer_table leaves every description null: write each one, then call create_table again\.$/);
  });
});

describe("add_column, alter_column and alter_table", () => {
  it("add_column refuses a column without a description, and describes one the engine sets", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, FILM);
    const e = await refusal(addColumn(v.app, v.settings, { table: "film", column: { name: "minutes", type: "integer" } }));
    expect(e.message).toBe("descriptions are required: column minutes of main.public.film has none");
    expect(e.docs).toBe(docsUrl("descriptions"));
    expect((await addColumn(v.app, v.settings, { table: "film", column: { name: "minutes", type: "integer", description: "Running time in minutes" } })).ok).toBe(true);
    expect((await addColumn(v.app, v.settings, { table: "film", column: { name: "added", type: "datetime", identity: "created" } })).ok).toBe(true);
    expect(entry(v, "film").columns.find((c) => c.name === "added")!.description).toBe(CREATED_DESCRIPTION);
  });

  it("alter_column changes a description but never removes it", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, FILM);
    for (const description of [null, "", "   "]) {
      const e = await refusal(alterColumn(v.app, v.settings, { table: "film", name: "year", changes: { description } }));
      expect(e.message).toBe("the description of column year of main.public.film cannot be removed (null or empty): every column needs one");
    }
    // another type is the column parser's to refuse
    await expect(alterColumn(v.app, v.settings, { table: "film", name: "year", changes: { description: 1927 } })).rejects.toThrow(MalformedColumnError);
    expect((await alterColumn(v.app, v.settings, { table: "film", name: "year", changes: { description: "Year of the first release" } })).ok).toBe(true);
    expect(entry(v, "film").columns.find((c) => c.name === "year")!.description).toBe("Year of the first release");
  });

  it("alter_table changes a description but never removes it", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, FILM);
    for (const description of [null, "", "  "]) {
      expect((await refusal(alterTable(v.app, v.settings, { table: "film", description }))).message).toBe(
        "the description of main.public.film cannot be removed (empty): every table needs one",
      );
    }
    expect((await alterTable(v.app, v.settings, { table: "film", description: "Films of the public domain" })).ok).toBe(true);
    expect(entry(v, "film").description).toBe("Films of the public domain");
  });

  it("a table written before the rule stays valid: its other changes go through, describe_table names what it lacks", async () => {
    const v = logVault();
    expect((await alterTable(v.app, v.settings, { table: "log", tags: { domain: "health" } })).ok).toBe(true);
    expect((await alterColumn(v.app, v.settings, { table: "log", name: "metric_drinks", changes: { max: 40 } })).ok).toBe(true);
    // the system id is the engine's: never missing
    expect((await describeTable(v.app, v.settings, "log")).missing_descriptions).toEqual({ table: true, columns: ["kind", "occurred_at", "metric_drinks", "people"] });
    await alterTable(v.app, v.settings, { table: "log", description: "Things that happened" });
    for (const [name, description] of [["kind", "What happened"], ["occurred_at", "When it happened"], ["metric_drinks", "Drinks that day"]]) {
      await alterColumn(v.app, v.settings, { table: "log", name: name!, changes: { description } });
    }
    expect((await describeTable(v.app, v.settings, "log")).missing_descriptions).toEqual({ table: false, columns: ["people"] });
    await alterColumn(v.app, v.settings, { table: "log", name: "people", changes: { description: "Who was there" } });
    expect((await describeTable(v.app, v.settings, "log")).missing_descriptions).toBeUndefined();
  });
});

describe("clone_table", () => {
  it("refuses a source without descriptions, naming what to describe first; a described one clones", async () => {
    const v = logVault();
    const e = await refusal(cloneTable(v.app, v.settings, { source: "log", target: "log_copy", shallow: true }));
    expect(e.message).toBe("descriptions are required: main.public.log has none for the table and columns kind, occurred_at, metric_drinks, people, and a clone would have none either");
    expect(e.docs).toBe(docsUrl("descriptions"));
    await createTable(v.app, v.settings, FILM);
    expect((await cloneTable(v.app, v.settings, { source: "film", target: "film_copy", shallow: true })).ok).toBe(true);
    expect(entry(v, "film_copy")).toMatchObject({ description: "Classic films I watched or want to watch" });
  });

  it("a past version without descriptions gets those the table has now; a dropped table the engine's", async () => {
    const v = logVault();
    expect((await alterTable(v.app, v.settings, { table: "log", history: true })).ok).toBe(true);
    await alterTable(v.app, v.settings, { table: "log", description: "Things that happened" });
    for (const [name, description] of [["kind", "What happened"], ["occurred_at", "When it happened"], ["metric_drinks", "Drinks that day"], ["people", "Who was there"]]) {
      await alterColumn(v.app, v.settings, { table: "log", name: name!, changes: { description } });
    }
    const then = await cloneTable(v.app, v.settings, { source: "log", target: "log_then", version: 0 });
    expect(then.ok, JSON.stringify(then.conflicts)).toBe(true);
    expect(entry(v, "log_then").description).toBe("Things that happened");
    expect(Object.fromEntries(entry(v, "log_then").columns.map((c) => [c.name, c.description]))).toEqual({
      id: SYSTEM_ID_SPEC.description,
      kind: "What happened",
      occurred_at: "When it happened",
      metric_drinks: "Drinks that day",
      people: "Who was there",
    });

    // a table dropped since: the columns the engine sets get its descriptions
    const w = createDbVault({
      [METASTORE]: withTables(
        `film:\n  description: Films\n  options: { filename: "{title}" }\n  columns:\n    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }\n    - { name: title, type: string, description: The title }\n    - { name: logged, type: datetime, identity: created }\n`,
      ),
    });
    await alterTable(w.app, w.settings, { table: "film", history: true });
    await insertRow(w.app, w.settings, { table: "film", values: { title: "Nosferatu" } });
    await dropTable(w.app, w.settings, { table: "film", mode: "archive" });
    const back = await cloneTable(w.app, w.settings, { source: "main.public.film", target: "film_back", version: 1 });
    expect(back.ok, JSON.stringify(back.conflicts)).toBe(true);
    expect(Object.fromEntries(entry(w, "film_back").columns.map((c) => [c.name, c.description]))).toEqual({ id: SYSTEM_ID_SPEC.description, title: "The title", logged: CREATED_DESCRIPTION });
  });

  it("inherited columns count as the clone has them: described by their base, or restyled by the table", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(
        `film:\n  description: Films\n  bases: [dated]\n  options: { filename: "{title}" }\n  columns:\n    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }\n    - { name: title, type: string, description: The title }\n`,
      ).replace("catalogs:", "bases:\n  dated:\n    columns:\n      - { name: day, type: date }\n      - { name: note, type: string, description: A note }\ncatalogs:"),
    });
    const e = await refusal(cloneTable(v.app, v.settings, { source: "film", target: "film_copy", shallow: true }));
    expect(e.message).toBe("descriptions are required: main.public.film has none for column day, and a clone would have none either");
    expect((await alterColumn(v.app, v.settings, { table: "film", name: "day", changes: { description: "The day I watched it" } })).ok).toBe(true);
    expect((await cloneTable(v.app, v.settings, { source: "film", target: "film_copy", shallow: true })).ok).toBe(true);
  });
});

describe("define_base", () => {
  it("refuses a new base or a new column without a description; keeps the descriptions the call leaves out", async () => {
    const v = createDbVault({});
    const none = await refusal(defineBase(v.app, v.settings, { name: "dated", columns: [{ name: "day", type: "date" }, { name: "note", type: "string", description: "A note" }] }));
    expect(none.message).toBe("descriptions are required: base dated has none for the base and column day");
    expect(none.docs).toBe(docsUrl("descriptions"));
    expect((await defineBase(v.app, v.settings, { name: "dated", description: "Work done on a day", columns: [{ name: "day", type: "date", description: "The day" }, { name: "logged", type: "datetime", identity: "created" }] })).ok).toBe(true);
    expect(model(v).bases.dated!.columns.find((c) => c.name === "logged")!.description).toBe(CREATED_DESCRIPTION);
    // a new column needs one; the columns the base has keep theirs, a renamed one its old name's, and a blank comment keeps the base's
    const fresh = await refusal(defineBase(v.app, v.settings, { name: "dated", columns: [{ name: "on", type: "date" }, { name: "logged", type: "datetime", identity: "created" }, { name: "where", type: "string" }], renameColumns: { day: "on" } }));
    expect(fresh.message).toBe("descriptions are required: base dated has none for column where");
    expect((await defineBase(v.app, v.settings, { name: "dated", description: " ", columns: [{ name: "on", type: "date" }, { name: "logged", type: "datetime", identity: "created" }], renameColumns: { day: "on" } })).ok).toBe(true);
    expect(model(v).bases.dated).toEqual({
      description: "Work done on a day",
      columns: [
        { name: "on", type: "date", description: "The day" },
        { name: "logged", type: "datetime", identity: "created", description: CREATED_DESCRIPTION },
      ],
    });
  });

  it("a base written before the rule stays as it is: describe_database names what it lacks", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(`film:\n  description: Films\n  bases: [dated]\n  options: { filename: "{title}" }\n  columns:\n    - { name: title, type: string }\n`).replace(
        "catalogs:",
        "bases:\n  dated:\n    columns:\n      - { name: day, type: date }\ncatalogs:",
      ),
    });
    expect((await defineBase(v.app, v.settings, { name: "dated", columns: [{ name: "day", type: "date" }] })).ok).toBe(true);
    const db = await describeDatabase(v.app, v.settings);
    expect(db.bases).toEqual([{ name: "dated", columns: ["day"], tables: ["main.public.film"], missing_descriptions: { base: true, columns: ["day"] } }]);
    const tables = db.catalogs[0]!.schemas[0]!.tables;
    expect(tables.find((t) => t.name === "film")!.missing_descriptions).toEqual({ table: false, columns: ["day", "title"] });
    expect(tables.find((t) => t.name === "log")!.missing_descriptions).toEqual({ table: true, columns: ["kind", "occurred_at", "metric_drinks", "people"] });
    // described, nothing is named
    await defineBase(v.app, v.settings, { name: "dated", description: "Work done on a day", columns: [{ name: "day", type: "date", description: "The day" }] });
    expect((await describeDatabase(v.app, v.settings)).bases[0]).not.toHaveProperty("missingDescriptions");
  });
});
