/**
 * Table `instructions`: how to fill a row, for agents. Set by create_table and alter_table, kept in
 * metastore.yaml, returned by describe_table and system.information_schema.tables.
 */

import { describe, expect, it } from "vitest";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { cloneTable, addConstraint, createView } from "../src/core/catalog-ops";
import { alterTable } from "../src/core/alter-table";
import { addColumn, createTable, INDEX_RETRY } from "../src/core/engine";
import { docsUrl } from "../src/core/hints";
import { describeTable } from "../src/core/public-api";
import { select } from "../src/core/rows";
import { createHandlers, dispatch } from "../src/server/rest";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const TEXT = "1. Ask which film.\n2. Ask where.\n";
const FILM = {
  name: "film",
  description: "Films I watched",
  columns: [{ name: "title", type: "string", required: true, description: "The film's title" }],
  options: { filename: "{title}" },
};

async function vault(extra: Record<string, unknown> = {}): Promise<DbVault> {
  const v = createDbVault({});
  const r = await createTable(v.app, v.settings, described({ ...FILM, ...extra }) as never);
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  return v;
}

describe("table instructions", () => {
  it("create_table keeps instructions in metastore.yaml and describe_table returns them", async () => {
    const v = await vault({ instructions: TEXT });
    expect(v.read(METASTORE)).toContain("instructions:");
    const d = await describeTable(v.app, v.settings, "film");
    expect(d.instructions).toBe(TEXT);
    const blank = await vault({ instructions: "  " });
    expect(blank.read(METASTORE)).not.toContain("instructions");
    expect((await describeTable(blank.app, blank.settings, "film")).instructions).toBeUndefined();
    const none = await vault();
    expect("instructions" in (await describeTable(none.app, none.settings, "film"))).toBe(false);
  });

  it("alter_table changes instructions; \"\" and null remove them; nothing else moves", async () => {
    const v = await vault({ instructions: TEXT });
    const r = await alterTable(v.app, v.settings, { table: "film", instructions: "Ask first.", dryRun: true } as never, { dryRun: true });
    expect(r.planned_edits ?? []).toEqual([]);
    expect(r.planned_moves ?? []).toEqual([]);
    const set = await alterTable(v.app, v.settings, { table: "film", instructions: "Ask first." });
    expect(set.ok, JSON.stringify(set)).toBe(true);
    expect(set.planned_moves ?? []).toEqual([]);
    expect((await describeTable(v.app, v.settings, "film")).instructions).toBe("Ask first.");
    const gone = await alterTable(v.app, v.settings, { table: "film", instructions: null });
    expect(gone.ok).toBe(true);
    expect((await describeTable(v.app, v.settings, "film")).instructions).toBeUndefined();
    expect(v.read(METASTORE)).not.toContain("instructions");
    await alterTable(v.app, v.settings, { table: "film", instructions: TEXT });
    await alterTable(v.app, v.settings, { table: "film", instructions: "" });
    expect((await describeTable(v.app, v.settings, "film")).instructions).toBeUndefined();
    // the REST mapping of "" to null
    await alterTable(v.app, v.settings, { table: "film", instructions: TEXT });
    const handlers = createHandlers(v.app, () => v.settings);
    const req = operationRequest("alter_table", { table: "film", instructions: "" });
    const route = req.path.slice(ROUTE_PREFIX.length);
    const answer = (await dispatch(route, handlers[route]!, req.body)) as { status: number };
    expect(answer.status).toBe(200);
    expect((await describeTable(v.app, v.settings, "film")).instructions).toBeUndefined();
    const create = operationRequest("create_table", described({ name: "show", columns: FILM.columns, filename: "{title}", instructions: "Ask the title." }));
    const created = (await dispatch(create.path.slice(ROUTE_PREFIX.length), handlers[create.path.slice(ROUTE_PREFIX.length)]!, create.body)) as { status: number };
    expect(created.status).toBe(200);
    expect((await describeTable(v.app, v.settings, "show")).instructions).toBe("Ask the title.");
  });

  it("instructions survive a rename, a column change and clone_table", async () => {
    const v = await vault({ instructions: TEXT });
    const renamed = await alterTable(v.app, v.settings, { table: "film", name: "movie" });
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    expect((await describeTable(v.app, v.settings, "movie")).instructions).toBe(TEXT);
    const col = await addColumn(v.app, v.settings, described({ table: "movie", column: { name: "year", type: "integer" } }));
    expect(col.ok, JSON.stringify(col)).toBe(true);
    expect((await describeTable(v.app, v.settings, "movie")).instructions).toBe(TEXT);
    const copy = await cloneTable(v.app, v.settings, { source: "movie", target: "movie_copy" });
    expect(copy.ok, JSON.stringify(copy)).toBe(true);
    expect((await describeTable(v.app, v.settings, "movie_copy")).instructions).toBe(TEXT);
    expect((await describeTable(v.app, v.settings, "movie")).instructions).toBe(TEXT);
  });

  it("instructions and CHECK hints survive a move to another schema with a rename", async () => {
    const v = await vault({ instructions: TEXT });
    const c = await addConstraint(v.app, v.settings, { table: "film", name: "titled", check: { title: { exists: true } }, hint: "Ask for the title." });
    expect(c.ok, JSON.stringify(c)).toBe(true);
    const moved = await alterTable(v.app, v.settings, { table: "film", schema: "other", name: "movie" } as never);
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    const d = await describeTable(v.app, v.settings, "movie");
    expect(d.instructions).toBe(TEXT);
    expect(d.constraint_hints).toEqual({ titled: "Ask for the title." });
  });

  it("information_schema.tables has the instructions of tables, null for views", async () => {
    const v = await vault({ instructions: TEXT });
    await createTable(v.app, v.settings, described({ ...FILM, name: "plain" }) as never);
    const view = await createView(v.app, v.settings, { name: "films_seen", query: { table: "film", columns: ["title"] } });
    expect(view.ok, JSON.stringify(view)).toBe(true);
    const rows = await select(v.app, v.settings, {
      table: "system.information_schema.tables",
      columns: ["table_name", "table_type", "instructions"],
    } as never);
    const byName = new Map((rows.rows as Record<string, unknown>[]).map((r) => [r.table_name, r]));
    expect(byName.get("film")?.instructions).toBe(TEXT);
    expect(byName.get("plain")?.instructions).toBeNull();
    const views = (rows.rows as Record<string, unknown>[]).filter((r) => r.table_type === "VIEW");
    expect(views.map((r) => r.table_name)).toContain("films_seen");
    for (const r of views) expect(r.instructions).toBeNull();
  });

  it("instructions that are not text are refused with a hint and docs", async () => {
    const v = await vault();
    const hint = { docs: docsUrl("instructions"), hint: expect.any(String) };
    await expect(createTable(v.app, v.settings, described({ ...FILM, name: "bad", instructions: 5 as never }) as never)).rejects.toMatchObject(hint);
    await expect(createTable(v.app, v.settings, described({ ...FILM, name: "bad", instructions: 5 as never }) as never)).rejects.toThrow(/"instructions" must be text/);
    await expect(alterTable(v.app, v.settings, { table: "film", instructions: 5 as never })).rejects.toMatchObject(hint);
  });
});
