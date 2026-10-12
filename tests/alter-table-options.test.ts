import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { operationRequest } from "../src/api/requests";
import { commentOn } from "../src/core/catalog-ops";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { listMigrations } from "../src/core/journal";
import { parseMetastore, resolveCatalogRef } from "../src/core/metastore";
import { describeTable } from "../src/core/public-api";
import { alterTable, deleteRows, insertRow, select } from "../src/core/rows";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { createHandlers, dispatch } from "../src/server/rest";
import { createDbVault, type DbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

afterEach(() => setTelemetry(NOOP_TELEMETRY));

const FOLDER = "Datanotes/main/public/people";

/** `main.public.people` (rows named `{name}`): Ann, and a note added by hand without `name` or `id`. */
async function people(): Promise<DbVault> {
  const v = createDbVault({});
  const created = await createTable(v.app, v.settings, described({
    name: "people",
    options: { filename: "{name}" },
    columns: [{ name: "name", type: "string" }, { name: "city", type: "string" }],
  }));
  expect(created.ok).toBe(true);
  expect((await insertRow(v.app, v.settings, { table: "people", values: { name: "Ann", city: "Rome" } })).ok).toBe(true);
  v.write(`${FOLDER}/someone.md`, "---\ntable: main.public.people\ncity: Milan\n---\nMet at the station.\n");
  return v;
}

const entry = (v: DbVault) =>
  (parse(v.read(METASTORE)) as { catalogs: Record<string, { schemas: Record<string, { tables: Record<string, Record<string, any>> }> }> }).catalogs.main!.schemas.public!.tables.people!;

/** Every note of the table folder with its text. */
const notes = (v: DbVault) => Object.fromEntries(v.list().filter((p) => p.startsWith(`${FOLDER}/`)).map((p) => [p, v.read(p)]));

describe("alter_table: a change of metadata only", () => {
  it("rewrites the table entry alone, even when a row cannot fill the file-name pattern", async () => {
    const v = await people();
    const before = notes(v);
    const changes = [
      { tags: { a: "b" } },
      { description: "People I know", aliases: ["friends"] },
      { history: true },
      { rowTemplate: "# {name}\n" },
      { rowTemplate: null },
      { clearTags: true },
      { fields: { kind: "person" } },
    ];
    for (const change of changes) {
      const r = await alterTable(v.app, v.settings, { table: "people", ...change });
      expect([r.ok, r.conflicts, r.planned_moves, r.planned_edits, r.planned_texts], JSON.stringify(change)).toEqual([true, [], [], [], [METASTORE]]);
      expect(r.op).toBe("alter_table");
    }
    expect(notes(v)).toEqual(before);
    expect(entry(v)).toMatchObject({ description: "People I know", aliases: ["friends"], options: { filename: "{name}", history: true }, fields: { kind: "person" } });
    expect(entry(v).tags).toBeUndefined();

    // journaled as alter_table and undoable
    const tagged = await alterTable(v.app, v.settings, { table: "people", tags: { owner: "me" } });
    expect((await listMigrations(v.app, v.settings, { op: "alter_table" })).migrations[0]!.summary).toBe("alter table main.public.people");
    expect((await undoOperation(v.app, v.settings, tagged.migration_id!)).ok).toBe(true);
    expect(entry(v).tags).toBeUndefined();
    expect(notes(v)).toEqual(before);

    // a change of layout still goes through every row, and is refused for the row without a name
    const renamed = await alterTable(v.app, v.settings, { table: "people", filename: "{city}" }, { dryRun: true });
    expect(renamed.ok).toBe(true);
    const moved = await alterTable(v.app, v.settings, { table: "people", filename: "{name} {city}" });
    expect(moved.ok).toBe(false);
    expect(moved.conflicts.map((c) => c.path)).toEqual([`${FOLDER}/someone.md`]);
    expect(moved.conflicts[0]!.message).toMatch(/cannot compute the new path/);
  });
});

describe("alter_table archive", () => {
  it("renames the archive folder inside the table folder; archived rows follow; \"\" is the database default", async () => {
    const v = await people();
    expect((await deleteRows(v.app, v.settings, { table: "people", where: { name: "Ann" }, mode: "archive" })).ok).toBe(true);
    expect(v.exists(`${FOLDER}/_archive/Ann.md`)).toBe(true);
    const before = v.read(`${FOLDER}/someone.md`);

    const r = await alterTable(v.app, v.settings, { table: "people", archive: "_done" });
    expect([r.ok, r.planned_moves]).toEqual([true, [{ from: `${FOLDER}/_archive/Ann.md`, to: `${FOLDER}/_done/Ann.md` }]]);
    expect(v.exists(`${FOLDER}/_done/Ann.md`)).toBe(true);
    expect(entry(v).options!.archive).toBe("_done");
    expect((await describeTable(v.app, v.settings, "people")).layout).toMatchObject({ archive: `${FOLDER}/_done` });
    // the rows stay where they are, untouched
    expect(v.read(`${FOLDER}/someone.md`)).toBe(before);

    expect((await alterTable(v.app, v.settings, { table: "people", archive: "" })).ok).toBe(true);
    expect(entry(v).options!.archive).toBe("_archive");
    expect(v.exists(`${FOLDER}/_archive/Ann.md`)).toBe(true);

    const text = v.read(METASTORE);
    for (const bad of ["a/b", "..", "Datanotes/old", 3]) {
      await expect(alterTable(v.app, v.settings, { table: "people", archive: bad as never })).rejects.toThrow(/"archive" must be a/);
    }
    expect(v.read(METASTORE)).toBe(text);
  });
});

describe("alter_table fields", () => {
  it("merges untyped fields (null removes one); new rows carry them; a column name is refused", async () => {
    const v = await people();
    const set = await alterTable(v.app, v.settings, { table: "people", fields: { kind: "person", source: "phone" } });
    expect(set.ok).toBe(true);
    expect(entry(v).fields).toEqual({ kind: "person", source: "phone" });
    expect((await describeTable(v.app, v.settings, "people")).untyped_fields).toEqual(expect.arrayContaining(["kind", "source"]));
    const removed = await alterTable(v.app, v.settings, { table: "people", fields: { source: null, absent: null, kind: "friend" } });
    expect(removed.ok).toBe(true);
    expect(entry(v).fields).toEqual({ kind: "friend" });

    const ins = await insertRow(v.app, v.settings, { table: "people", values: { name: "Bob" } });
    expect(v.read(ins.planned_creates[0]!)).toMatch(/^kind: friend$/m);
    expect((await select(v.app, v.settings, { table: "people", columns: ["name", "kind"], where: { name: "Bob" } })).rows[0]).toMatchObject({ name: "Bob", kind: "friend" });

    expect((await undoOperation(v.app, v.settings, removed.migration_id!)).ok).toBe(true);
    expect(entry(v).fields).toEqual({ kind: "person", source: "phone" });

    const text = v.read(METASTORE);
    await expect(alterTable(v.app, v.settings, { table: "people", fields: { city: "Rome" } })).rejects.toThrow(`"city" is a column of main.public.people: change it with alter_column, not "fields"`);
    await expect(alterTable(v.app, v.settings, { table: "people", fields: { id: null } })).rejects.toThrow(/is a column/);
    await expect(alterTable(v.app, v.settings, { table: "people", fields: { table: "x" } })).rejects.toThrow(`"table" is a reserved front matter key`);
    await expect(alterTable(v.app, v.settings, { table: "people", fields: { _columns: [] } })).rejects.toThrow(/reserved front matter key/);
    await expect(alterTable(v.app, v.settings, { table: "people", fields: JSON.parse(`{"__proto__": "x"}`) })).rejects.toThrow(/reserved front matter key/);
    await expect(alterTable(v.app, v.settings, { table: "people", fields: { " kind": "x" } })).rejects.toThrow(`"fields": " kind" is not a front matter key`);
    await expect(alterTable(v.app, v.settings, { table: "people", fields: ["kind"] as never })).rejects.toThrow(`"fields" must be an object of front matter keys and their default values (null removes a key)`);
    expect(v.read(METASTORE)).toBe(text);
  });

  it("over HTTP: archive and fields are passed as they are, and validated", async () => {
    expect(operationRequest("alter_table", { table: "t", archive: "_done", fields: { a: 1, b: null } }).body).toEqual({ table: "t", archive: "_done", fields: { a: 1, b: null } });
    expect(operationRequest("alter_table", { table: "t", archive: "" }).body).toEqual({ table: "t", archive: "" });
    const v = await people();
    const h = createHandlers(v.app, () => v.settings);
    const alter = (body: Record<string, unknown>) => dispatch("/operations/alter_table/", h["/operations/alter_table/"]!, body);
    expect((await alter({ table: "people", archive: 3 })).status).toBe(400);
    expect((await alter({ table: "people", archive: "a/b" })).status).toBe(400);
    expect((await alter({ table: "people", fields: "x" })).status).toBe(400);
    expect((await alter({ table: "people", fields: { city: "x" } })).status).toBe(400);
    expect((await alter({ table: "people", archive: "_old", fields: { kind: "person" } })).status).toBe(200);
    expect(entry(v)).toMatchObject({ options: { archive: "_old" }, fields: { kind: "person" } });
  });
});

describe("tag names", () => {
  it("with spaces around them are refused by create_table and alter_table", async () => {
    const v = await people();
    const text = v.read(METASTORE);
    await expect(alterTable(v.app, v.settings, { table: "people", tags: { " domain ": "x" } })).rejects.toThrow(`"tags": the tag name " domain " has spaces around it: write "domain"`);
    await expect(alterTable(v.app, v.settings, { table: "people", tags: { "domain ": null } })).rejects.toThrow(/has spaces around it/);
    await expect(
      createTable(v.app, v.settings, described({ name: "t", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }], tags: { "\tdomain": "x" } })),
    ).rejects.toThrow(/has spaces around it/);
    expect(v.read(METASTORE)).toBe(text);
    expect((await alterTable(v.app, v.settings, { table: "people", tags: { "my domain": "x" } })).ok).toBe(true);
  });
});

describe("names of Object.prototype members", () => {
  it("create_table: a schema or table named constructor is an ordinary name; toString and __proto__ are refused", async () => {
    const v = createDbVault({});
    const t = { options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }] };
    for (const [catalog, schema, name] of [["personal", "constructor", "x"], ["personal", "public", "constructor"], ["constructor", "constructor", "constructor"]] as const) {
      const r = await createTable(v.app, v.settings, described({ ...t, catalog, schema, name }));
      expect(r.ok, `${catalog}.${schema}.${name}`).toBe(true);
    }
    expect((await createTable(v.app, v.settings, described({ ...t, catalog: "personal", schema: "public", name: "constructor" }))).conflicts[0]!.message).toBe("personal.public.constructor already exists");
    for (const bad of ["toString", "__proto__", "hasOwnProperty"]) {
      await expect(createTable(v.app, v.settings, described({ ...t, catalog: "personal", schema: bad, name: "x" }))).rejects.toThrow(`schema name "${bad}" must be lowercase letters`);
      await expect(createTable(v.app, v.settings, described({ ...t, catalog: bad, name: "x" }))).rejects.toThrow(`catalog name "${bad}"`);
      await expect(createTable(v.app, v.settings, described({ ...t, name: bad }))).rejects.toThrow(`table name "${bad}"`);
    }
    expect((await describeTable(v.app, v.settings, "personal.constructor.x")).qualified).toBe("personal.constructor.x");
    expect((await insertRow(v.app, v.settings, { table: "constructor.constructor.constructor", values: { name: "a" } })).ok).toBe(true);

    const h = createHandlers(v.app, () => v.settings);
    const res = await dispatch("/operations/create_table/", h["/operations/create_table/"]!, described({ catalog: "personal", schema: "toString", name: "x", filename: "{name}", columns: t.columns }));
    expect(res.status).toBe(400);
  });

  it("resolveCatalogRef and the parsed metastore find only what the file defines", () => {
    const model = parseMetastore("catalogs:\n  personal:\n    schemas:\n      health:\n        tables:\n          sleep:\n            columns: []\n");
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(resolveCatalogRef(model, name)).toBeNull();
      expect(resolveCatalogRef(model, `${name}.sleep`)).toBeNull();
      expect(resolveCatalogRef(model, `health.${name}`)).toBeNull();
      expect(resolveCatalogRef(model, `personal.${name}.sleep`)).toBeNull();
      expect(resolveCatalogRef(model, `${name}.${name}.${name}`)).toBeNull();
      expect(resolveCatalogRef(model, name, "view")).toBeNull();
      expect(model.catalogs[name]).toBeUndefined();
      expect(model.catalogs.personal!.schemas[name]).toBeUndefined();
      expect(model.catalogs.personal!.schemas.health!.tables[name]).toBeUndefined();
      expect(model.catalogs.personal!.schemas.health!.views[name]).toBeUndefined();
      expect(model.bases[name]).toBeUndefined();
    }
    expect(resolveCatalogRef(model, "sleep")?.full).toBe("personal.health.sleep");
    expect(() => parseMetastore("catalogs:\n  personal:\n    schemas:\n      health:\n        tables:\n          t:\n            bases: [constructor]\n")).toThrow(`unknown base "constructor"`);
  });
});

describe("comment_on telemetry", () => {
  it("reports remove: true for every comment it treats as a removal", async () => {
    const records: { body: string; attrs: Record<string, unknown> }[] = [];
    setTelemetry({ log: (_sev, body, attrs = {}) => records.push({ body, attrs }), flush: async () => {} });
    const v = await people();
    for (const description of ["Mine", "  ", "", null]) await commentOn(v.app, v.settings, { catalog: "main", description });
    const removes = records.filter((r) => r.body === "datanotes comment_on").map((r) => r.attrs.remove);
    expect(removes).toEqual([false, true, true, true]);
  });
});
