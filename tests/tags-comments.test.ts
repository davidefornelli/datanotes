import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { operationRequest } from "../src/api/requests";
import { cloneTable, commentOn } from "../src/core/catalog-ops";
import { ChangeFeed } from "../src/core/change-feed";
import { describeDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { listMigrations } from "../src/core/journal";
import { setCatalogComment } from "../src/core/metastore";
import { describeTable, listTablesAndViews } from "../src/core/public-api";
import { alterTable, select } from "../src/core/rows";
import { createHandlers, dispatch } from "../src/server/rest";
import { createDbVault, type DbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

/** `personal.health.sleep` (tagged when `tags` is given) and an untagged `personal.health.weight`. */
async function vault(tags?: Record<string, string>): Promise<DbVault> {
  const v = createDbVault({});
  const sleep = await createTable(v.app, v.settings, described({
    catalog: "personal",
    schema: "health",
    name: "sleep",
    timeColumn: "night_of",
    options: { description: "One row per night", aliases: ["how I slept"] },
    columns: [{ name: "night_of", type: "date", required: true }],
    ...(tags ? { tags } : {}),
  }));
  expect(sleep.ok).toBe(true);
  const weight = await createTable(v.app, v.settings, described({ catalog: "personal", schema: "health", name: "weight", timeColumn: "measured_on", columns: [{ name: "measured_on", type: "date" }] }));
  expect(weight.ok).toBe(true);
  return v;
}

const metastore = (v: DbVault) => parse(v.read(METASTORE)) as { catalogs: Record<string, { description?: string; schemas: Record<string, Record<string, any>> }> };
const sleepEntry = (v: DbVault) => metastore(v).catalogs.personal!.schemas.health!.tables.sleep as Record<string, unknown>;
const tagsOf = async (v: DbVault) => (await describeTable(v.app, v.settings, "sleep")).tags;

describe("table tags", () => {
  it("create_table writes them after comment and aliases; every table listing returns them", async () => {
    const tags = { domain: "health", owner: "me" };
    const v = await vault(tags);
    expect(Object.keys(sleepEntry(v)).slice(0, 3)).toEqual(["description", "aliases", "tags"]);
    expect(sleepEntry(v).tags).toEqual(tags);

    expect(await tagsOf(v)).toEqual(tags);
    expect((await describeTable(v.app, v.settings, "weight")).tags).toBeUndefined();
    const listed = (await listTablesAndViews(v.app, v.settings)).tables;
    expect(listed.map((t) => [t.qualified, t.tags])).toEqual([
      ["personal.health.sleep", tags],
      ["personal.health.weight", undefined],
    ]);
    expect("tags" in listed[1]!).toBe(false);
    const db = await describeDatabase(v.app, v.settings);
    expect(db.catalogs[0]!.schemas[0]!.tables).toEqual([
      { name: "sleep", qualified: "personal.health.sleep", row_count: 0, description: "One row per night", tags },
      { name: "weight", qualified: "personal.health.weight", row_count: 0, description: "Test table weight" },
    ]);
    const info = await select(v.app, v.settings, { table: "system.information_schema.tables", columns: ["full_name", "tags"] });
    expect(info.rows.map((r) => [r.full_name, r.tags ?? null])).toEqual([
      ["personal.health.sleep", tags],
      ["personal.health.weight", null],
    ]);
  });

  it("are strings: other values are refused with a clear message and nothing is written", async () => {
    const v = createDbVault({});
    const t = { name: "t", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }] };
    await expect(createTable(v.app, v.settings, described({ ...t, tags: ["health"] as never }))).rejects.toThrow(`"tags" must be an object of strings, e.g. {"domain": "health"}`);
    await expect(createTable(v.app, v.settings, described({ ...t, tags: { year: 2026 } as never }))).rejects.toThrow(`"tags.year" must be a string, not number`);
    await expect(createTable(v.app, v.settings, described({ ...t, tags: { domain: null } as never }))).rejects.toThrow(`"tags.domain" must be a string, not null`);
    await expect(createTable(v.app, v.settings, described({ ...t, tags: { " ": "x" } }))).rejects.toThrow(/tag name must be a non-empty string/);
    expect(v.exists(METASTORE)).toBe(false);

    const w = await vault({ domain: "health" });
    const before = w.read(METASTORE);
    await expect(alterTable(w.app, w.settings, { table: "sleep", tags: { domain: 1 } as never })).rejects.toThrow(`"tags.domain" must be a string (or null to remove the tag), not number`);
    await expect(alterTable(w.app, w.settings, { table: "sleep", tags: { domain: ["a"] } as never })).rejects.toThrow(/not a list/);
    await expect(alterTable(w.app, w.settings, { table: "sleep", tags: "health" as never })).rejects.toThrow(/"tags" must be an object of strings/);
    expect(w.read(METASTORE)).toBe(before);
  });

  it("alter_table merges them (null removes one, clear_tags all) and undo_migration restores them", async () => {
    const v = await vault({ domain: "health", owner: "me" });
    const merged = await alterTable(v.app, v.settings, { table: "sleep", tags: { owner: null, level: "daily", domain: "body", absent: null } });
    expect(merged.ok).toBe(true);
    expect(await tagsOf(v)).toEqual({ domain: "body", level: "daily" });
    // other changes keep them
    expect((await alterTable(v.app, v.settings, { table: "sleep", description: "Nights" })).ok).toBe(true);
    expect(await tagsOf(v)).toEqual({ domain: "body", level: "daily" });

    const dry = await alterTable(v.app, v.settings, { table: "sleep", clearTags: true }, { dryRun: true });
    expect([dry.ok, dry.planned_texts]).toEqual([true, [METASTORE]]);
    expect(await tagsOf(v)).toEqual({ domain: "body", level: "daily" });

    const replaced = await alterTable(v.app, v.settings, { table: "sleep", clearTags: true, tags: { area: "sleep" } });
    expect(await tagsOf(v)).toEqual({ area: "sleep" });
    const cleared = await alterTable(v.app, v.settings, { table: "sleep", clearTags: true });
    expect(await tagsOf(v)).toBeUndefined();
    expect("tags" in sleepEntry(v)).toBe(false);

    expect((await undoOperation(v.app, v.settings, cleared.migration_id!)).ok).toBe(true);
    expect(await tagsOf(v)).toEqual({ area: "sleep" });
    expect((await undoOperation(v.app, v.settings, replaced.migration_id!)).ok).toBe(true);
    expect(await tagsOf(v)).toEqual({ domain: "body", level: "daily" });

    // a clone has the source's tags
    expect((await cloneTable(v.app, v.settings, { source: "sleep", target: "sleep_copy", shallow: true })).ok).toBe(true);
    expect((await describeTable(v.app, v.settings, "sleep_copy")).tags).toEqual({ domain: "body", level: "daily" });
  });

  it("tags written by hand with other values are read as strings", async () => {
    const v = await vault({ domain: "health" });
    v.write(METASTORE, v.read(METASTORE).replace(/^( *)domain: health$/m, "$1domain: health\n$1year: 2026\n$1done: true"));
    expect(await tagsOf(v)).toEqual({ domain: "health", year: "2026", done: "true" });
    expect((await alterTable(v.app, v.settings, { table: "sleep", tags: { done: null } })).ok).toBe(true);
    expect(sleepEntry(v).tags).toEqual({ domain: "health", year: "2026" });
  });

  it("tags written by hand as a list are tags with no value: listed, and kept by the next change", async () => {
    const v = await vault();
    v.write(METASTORE, v.read(METASTORE).replace(/^( *)description: One row per night$/m, "$1description: One row per night\n$1tags: [health, nightly]"));
    expect(await tagsOf(v)).toEqual({ health: "", nightly: "" });
    expect((await listTablesAndViews(v.app, v.settings)).tables[0]!.tags).toEqual({ health: "", nightly: "" });
    const info = await select(v.app, v.settings, { table: "system.information_schema.tables", columns: ["tags"], where: { table_name: "sleep" } });
    expect(info.rows[0]!.tags).toEqual({ health: "", nightly: "" });
    expect((await alterTable(v.app, v.settings, { table: "sleep", tags: { owner: "me", nightly: null } })).ok).toBe(true);
    expect(sleepEntry(v).tags).toEqual({ health: "", owner: "me" });
  });

  it("a change that leaves them as they are writes and journals nothing", async () => {
    const v = await vault({ domain: "health" });
    v.write(METASTORE, v.read(METASTORE).replace(/^( *)domain: health$/m, "$1domain: health # the area\n$1year: 2026"));
    const before = v.read(METASTORE);
    const journaled = (await listMigrations(v.app, v.settings, {})).migrations.length;
    const changes: Record<string, string | null>[] = [{}, { domain: "health" }, { absent: null }];
    for (const tags of changes) {
      const r = await alterTable(v.app, v.settings, { table: "sleep", tags });
      expect([r.ok, r.migration_id, r.planned_texts]).toEqual([true, undefined, []]);
    }
    expect(v.read(METASTORE)).toBe(before);
    expect((await listMigrations(v.app, v.settings, {})).migrations.length).toBe(journaled);
    // with another change the tags are not rewritten either (`year` stays a number)
    expect((await alterTable(v.app, v.settings, { table: "sleep", description: "Nights", tags: {} })).ok).toBe(true);
    expect(sleepEntry(v)).toMatchObject({ description: "Nights", tags: { domain: "health", year: 2026 } });
  });

  it("refuses the tag name __proto__ (it would be dropped)", async () => {
    const v = await vault({ domain: "health" });
    const before = v.read(METASTORE);
    const proto = JSON.parse(`{"__proto__": "p"}`) as Record<string, string>;
    await expect(alterTable(v.app, v.settings, { table: "sleep", tags: proto })).rejects.toThrow(`"tags": "__proto__" cannot be a tag name`);
    await expect(createTable(v.app, v.settings, described({ name: "t", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }], tags: proto }))).rejects.toThrow(/__proto__/);
    expect(v.read(METASTORE)).toBe(before);
    expect((await alterTable(v.app, v.settings, { table: "sleep", tags: { constructor: "c", toString: "s" } })).ok).toBe(true);
    expect(await tagsOf(v)).toEqual({ domain: "health", constructor: "c", toString: "s" });
  });

  it("a change is journaled as alter_table", async () => {
    const v = await vault({ domain: "health" });
    const tagged = await alterTable(v.app, v.settings, { table: "sleep", tags: { owner: "me" } });
    const renamed = await alterTable(v.app, v.settings, { table: "sleep", name: "nights" });
    expect([tagged.op, renamed.op]).toEqual(["alter_table", "alter_table"]);
    expect((await listMigrations(v.app, v.settings, { op: "alter_table" })).migrations.map((m) => [m.summary, m.table])).toEqual([
      ["move table personal.health.sleep to personal.health.nights", "personal.health.nights"],
      ["alter table personal.health.sleep", "personal.health.sleep"],
    ]);
  });
});

describe("comment_on", () => {
  it("sets, replaces and removes the comment of a catalog or schema; comments in the file are kept", async () => {
    const v = await vault();
    v.write(METASTORE, `# my notes on the metastore\n${v.read(METASTORE)}`);
    const cat = await commentOn(v.app, v.settings, { catalog: "personal", description: "My life" });
    expect([cat.ok, cat.op, cat.planned_texts]).toEqual([true, "comment_on", [METASTORE]]);
    expect((await commentOn(v.app, v.settings, { catalog: "personal", schema: "health", description: "Body and sleep" })).ok).toBe(true);
    expect(v.read(METASTORE).startsWith("# my notes on the metastore\n")).toBe(true);
    const doc = metastore(v);
    expect(Object.keys(doc.catalogs.personal!)).toEqual(["description", "schemas"]);
    expect(Object.keys(doc.catalogs.personal!.schemas.health!)).toEqual(["description", "tables"]);

    const db = await describeDatabase(v.app, v.settings);
    expect(db.catalogs[0]).toMatchObject({ catalog: "personal", description: "My life", schemas: [{ schema: "health", description: "Body and sleep" }] });
    const cats = await select(v.app, v.settings, { table: "system.information_schema.catalogs", columns: ["catalog_name", "comment"] });
    expect(cats.rows.map((r) => [r.catalog_name, r.comment])).toEqual([["personal", "My life"]]);
    const schemata = await select(v.app, v.settings, { table: "information_schema.schemata", columns: ["schema_name", "comment"] });
    expect(schemata.rows.map((r) => [r.schema_name, r.comment])).toEqual([["health", "Body and sleep"]]);

    expect((await commentOn(v.app, v.settings, { catalog: "personal", description: "Everything about me" })).ok).toBe(true);
    expect(metastore(v).catalogs.personal!.description).toBe("Everything about me");
    expect((await commentOn(v.app, v.settings, { catalog: "personal", description: "" })).ok).toBe(true);
    expect((await commentOn(v.app, v.settings, { catalog: "personal", schema: "health", description: null })).ok).toBe(true);
    const after = await describeDatabase(v.app, v.settings);
    expect(after.catalogs[0]!.description).toBeUndefined();
    expect(after.catalogs[0]!.schemas[0]!.description).toBeUndefined();
    expect(Object.keys(metastore(v).catalogs.personal!)).toEqual(["schemas"]);
    expect(v.read(METASTORE).startsWith("# my notes on the metastore\n")).toBe(true);
  });

  it("refuses an unknown catalog or schema with the existing ones", async () => {
    const v = await vault();
    const before = v.read(METASTORE);
    await expect(commentOn(v.app, v.settings, { catalog: "work", description: "x" })).rejects.toThrow(`unknown catalog "work" (catalogs: personal)`);
    await expect(commentOn(v.app, v.settings, { catalog: "system", description: "x" })).rejects.toThrow(`unknown catalog "system"`);
    await expect(commentOn(v.app, v.settings, { catalog: "personal", schema: "money", description: "x" })).rejects.toThrow(
      `unknown schema "money" in catalog personal (schemas: health)`,
    );
    await expect(commentOn(v.app, v.settings, { catalog: "personal", description: 3 as never })).rejects.toThrow(`"description" must be a string ("" removes it)`);
    expect(v.read(METASTORE)).toBe(before);
    await expect(commentOn(createDbVault({}).app, v.settings, { catalog: "main", description: "x" })).rejects.toThrow(`unknown catalog "main" (catalogs: none yet)`);
  });

  it("refuses the names of built-in object keys: they are not catalogs or schemas of the file", async () => {
    const v = await vault();
    const before = v.read(METASTORE);
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await expect(commentOn(v.app, v.settings, { catalog: name, description: "x" })).rejects.toThrow(`unknown catalog "${name}" (catalogs: personal)`);
      await expect(commentOn(v.app, v.settings, { catalog: name, description: null })).rejects.toThrow(`unknown catalog "${name}"`);
      await expect(commentOn(v.app, v.settings, { catalog: "personal", schema: name, description: "x" })).rejects.toThrow(
        `unknown schema "${name}" in catalog personal (schemas: health)`,
      );
    }
    await expect(commentOn(v.app, v.settings, { catalog: "constructor", schema: "x", description: "x" })).rejects.toThrow(`unknown catalog "constructor"`);
    expect(v.read(METASTORE)).toBe(before);
    expect((await describeDatabase(v.app, v.settings)).catalogs.map((c) => [c.catalog, c.schemas.map((s) => s.schema)])).toEqual([["personal", ["health"]]]);
  });

  it("the comment it already has, or removing none, writes and journals nothing", async () => {
    const v = await vault();
    expect((await commentOn(v.app, v.settings, { catalog: "personal", description: "My life" })).ok).toBe(true);
    const before = v.read(METASTORE);
    const journaled = (await listMigrations(v.app, v.settings, {})).migrations.length;
    for (const input of [{ catalog: "personal", description: "My life" }, { catalog: "personal", schema: "health", description: null }, { catalog: "personal", schema: "health", description: " " }]) {
      const r = await commentOn(v.app, v.settings, input);
      expect([r.ok, r.op, r.migration_id, r.planned_texts]).toEqual([true, "comment_on", undefined, []]);
    }
    expect(v.read(METASTORE)).toBe(before);
    expect((await listMigrations(v.app, v.settings, {})).migrations.length).toBe(journaled);
  });

  it("works on a catalog or schema written with nothing under it", async () => {
    const v = await vault();
    v.write(METASTORE, v.read(METASTORE).replace(/^catalogs:$/m, "catalogs:\n  work:"));
    expect((await commentOn(v.app, v.settings, { catalog: "work", description: null })).ok).toBe(true);
    expect((await commentOn(v.app, v.settings, { catalog: "work", description: "Job" })).ok).toBe(true);
    expect(metastore(v).catalogs.work).toEqual({ description: "Job" });
    expect((await commentOn(v.app, v.settings, { catalog: "work", description: null })).ok).toBe(true);
    expect(metastore(v).catalogs.work).toEqual({});
    // removing from an empty node changes nothing
    expect(parse(setCatalogComment("catalogs:\n  work:\n", "work", undefined, null))).toEqual({ catalogs: { work: null } });
    expect(parse(setCatalogComment("catalogs:\n  work:\n    schemas:\n      x:\n", "work", "x", null))).toEqual({ catalogs: { work: { schemas: { x: null } } } });
  });

  it("is journaled: a dry run writes nothing, undo_migration restores the previous text", async () => {
    const v = await vault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const before = v.read(METASTORE);
    const dry = await commentOn(v.app, v.settings, { catalog: "personal", description: "My life" }, { dryRun: true });
    expect([dry.ok, dry.dry_run, dry.planned_texts, dry.migration_id]).toEqual([true, true, [METASTORE], undefined]);
    expect(v.read(METASTORE)).toBe(before);
    const set = await commentOn(v.app, v.settings, { catalog: "personal", description: "My life" });
    const changed = await commentOn(v.app, v.settings, { catalog: "personal", schema: "health", description: "Body" });
    const journal = (await listMigrations(v.app, v.settings, { op: "comment_on" })).migrations;
    expect(journal.map((m) => [m.summary, m.table])).toEqual([
      ["comment on schema personal.health", "personal.health"],
      ["comment on catalog personal", "personal"],
    ]);
    await feed.flush();
    expect((await feed.read()).events.map((e) => [e.op, e.path, e.source])).toEqual([
      ["schema", METASTORE, "engine"],
      ["schema", METASTORE, "engine"],
    ]);
    feed.stop();
    expect((await undoOperation(v.app, v.settings, changed.migration_id!)).ok).toBe(true);
    expect(metastore(v).catalogs.personal!.schemas.health!.description).toBeUndefined();
    expect(metastore(v).catalogs.personal!.description).toBe("My life");
    expect((await undoOperation(v.app, v.settings, set.migration_id!)).ok).toBe(true);
    expect(v.read(METASTORE)).toBe(before);
  });
});

describe("over HTTP", () => {
  it("sends the arguments as agents give them; the operation validates them", async () => {
    expect(operationRequest("comment_on", { catalog: "personal", schema: null, description: "" }).body).toEqual({ catalog: "personal", description: "" });
    expect(operationRequest("alter_table", { table: "t", tags: { a: null }, clear_tags: true }).body).toEqual({ table: "t", tags: { a: null }, clear_tags: true });
    expect(operationRequest("create_table", described({ name: "t", columns: [], tags: { a: "b" } })).body).toMatchObject(described({ name: "t", tags: { a: "b" } }));

    const v = await vault({ domain: "health" });
    const h = createHandlers(v.app, () => v.settings);
    const ddl = ({ op, ...body }: Record<string, unknown>) => dispatch(`/operations/${String(op)}/`, h[`/operations/${String(op)}/`]!, body);
    expect((await ddl({ op: "comment_on", catalog: "personal", description: "My life" })).status).toBe(200);
    expect((await ddl({ op: "comment_on", catalog: "personal" })).status).toBe(400);
    expect((await ddl({ op: "comment_on", catalog: "personal", description: 1 })).status).toBe(400);
    expect(await ddl({ op: "comment_on", catalog: "work", description: "x" })).toMatchObject({ status: 400, json: { error: `unknown catalog "work" (catalogs: personal)` } });
    expect((await ddl({ op: "comment_on", catalog: "constructor", schema: "x", description: "x" })).status).toBe(400);
    expect((await ddl({ op: "comment_on", catalog: "personal", schema: "toString", description: "x" })).status).toBe(400);
    expect((await ddl({ op: "comment_on", catalog: "personal", description: "" })).status).toBe(200);
    expect(metastore(v).catalogs.personal!.description).toBeUndefined();

    expect((await ddl({ op: "alter_table", table: "sleep", clear_tags: "yes" })).status).toBe(400);
    expect((await ddl({ op: "alter_table", table: "sleep", tags: "health" })).status).toBe(400);
    expect((await ddl({ op: "alter_table", table: "sleep", tags: { domain: 2 } })).status).toBe(400);
    expect((await ddl(described({ op: "create_table", name: "x", filename: "{name}", columns: [{ name: "name", type: "string" }], tags: { a: 1 } }))).status).toBe(400);
    expect((await ddl({ op: "alter_table", table: "sleep", tags: { owner: "me" } })).status).toBe(200);
    expect((await dispatch("/operations/list_tables/", h["/operations/list_tables/"]!, {})).json).toMatchObject({ tables: [{ name: "sleep", tags: { domain: "health", owner: "me" } }, { name: "weight" }] });

    const batch = await dispatch("/operations/batch/", h["/operations/batch/"]!, {
      operations: [
        { op: "comment_on", catalog: "personal", schema: "health", description: "Body" },
        { op: "alter_table", table: "sleep", clear_tags: true },
      ],
    });
    expect(batch.status).toBe(200);
    expect(metastore(v).catalogs.personal!.schemas.health!.description).toBe("Body");
    expect(await tagsOf(v)).toBeUndefined();
  });
});
