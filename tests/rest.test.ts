import { afterEach, describe, expect, it } from "vitest";
import {
  createHandlers,
  dispatch,
  errorResponse,
  type Handler,
} from "../src/server/rest";
import { OperationInputError } from "../src/core/engine";
import { MalformedColumnError } from "../src/core/table-loader";
import { AmbiguousCatalogRefError } from "../src/core/metastore";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { logVault, LOG_DIR, METASTORE } from "./helpers/db-vault";
import { INDEX_RETRY } from "../src/core/engine";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

afterEach(() => setTelemetry(NOOP_TELEMETRY));

function setup(extra: Record<string, string> = {}) {
  const v = logVault(extra);
  // A second table for /rows/move/.
  v.write(METASTORE, `${v.read(METASTORE)}          log2:\n            options: { filename: "{kind}" }\n            columns:\n              - { name: kind, type: string }\n`);
  const h = createHandlers(v.app, () => v.settings);
  const call = (route: string, body?: unknown) => dispatch(route, h[route]!, body);
  return { v, h, call };
}

describe("handlers", () => {
  it("describes and configures the database; an empty default_partition means flat", async () => {
    const { call } = setup();
    const d = await call("/operations/describe_database/");
    expect(d.status).toBe(200);
    expect((d.json as { root: string }).root).toBe("Datanotes");
    const c = await call("/operations/configure_database/", { default_partition: "", default_filename: "YYYY-MM-DD[T]HHmm" });
    expect(c.status).toBe(200);
    expect((c.json as { config: Record<string, string> }).config.default_partition).toBe("");
    expect((await call("/operations/configure_database/", { default_partition: 3 })).status).toBe(400);
    expect((await call("/operations/configure_database/", { default_partition: "{x}" })).status).toBe(400);
  });

  it("lists and describes tables", async () => {
    const { call } = setup();
    const d = await call("/operations/describe_table/", { table: "log" });
    expect(d.status).toBe(200);
    expect((d.json as { row_count: number }).row_count).toBe(2);
    expect((await call("/operations/describe_table/", { table: "nope" })).status).toBe(404);
    expect((await call("/operations/describe_table/", {})).status).toBe(400);
    const listed = await call("/operations/list_tables/");
    expect(listed.status).toBe(200);
    const json = listed.json as { tables: Record<string, unknown>[]; views: unknown[] };
    expect(json.tables[0]).toEqual({ name: "log", catalog: "main", schema: "public", qualified: "main.public.log" });
    expect(json.tables.map((t) => t.name)).toEqual(["log", "log2"]);
    expect(json.views).toEqual([]);
  });

  it("runs every DDL op", async () => {
    const { call, v } = setup();
    const ok = async (op: string, body: Record<string, unknown>) => {
      const r = await call(`/operations/${op}/`, body);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json as { migration_id?: string };
    };
    await ok("add_column", described({ table: "log", column: { name: "metric_mood", type: "integer", min: 1, max: 5 } }));
    await ok("add_column", described({ table: "log", column: { name: "src", type: "string", dense: true }, dry_run: true }));
    await ok("alter_column", { table: "log", column: "metric_mood", changes: { label: "Feeling" } });
    await ok("rename_column", { table: "log", from_column: "metric_mood", to_column: "mood" });
    await ok("drop_column", { table: "log", column: "mood" });
    const created = await ok(
      "create_table",
      described({
        name: "person",
        filename: "{name}",
        columns: [{ name: "name", type: "string", required: true, dense: true }],
        row_template: "# person\n",
      }),
    );
    expect(created.migration_id).toBeDefined();
    await ok("alter_table", { table: "person", name: "people" });
    await ok("drop_table", { table: "people", mode: "archive" });
    expect(v.read(METASTORE)).not.toContain("people:");
  });

  it("maps DDL errors", async () => {
    const { call, h } = setup();
    // an operation that does not exist has no route (the HTTP server answers 404, naming the closest)
    expect(h["/operations/explode/"]).toBeUndefined();
    expect((await call("/operations/drop_table/", { table: "log", mode: "delete" })).status).toBe(400);
    expect((await call("/operations/add_column/", described({ table: "log", column: { name: "a", type: "string", dense: "yes" } }))).status).toBe(400);
    expect((await call("/operations/rename_column/", { table: "log", from_column: "kind", to_column: "x", dry_run: "no" })).status).toBe(400);
    expect((await call("/operations/add_column/", described({ table: "log", column: "x" }))).status).toBe(400);
    expect((await call("/operations/add_column/", described({ table: "log", column: { name: "a", type: "decimal" } }))).status).toBe(400);
    const refused = await call("/operations/drop_table/", { table: "log" });
    expect(refused.status).toBe(422);
    expect((await call("/operations/drop_column/", { table: "log", column: "" })).status).toBe(400);
  });

  it("row routes: insert, update, delete, select, check, undo", async () => {
    const { call, v } = setup();
    const ins = await call("/operations/insert_row/", {
      table: "log",
      values: { kind: "alcohol", occurred_at: "2026-09-24T23:10", metric_drinks: 6 },
      body: "Drank too much\n",
    });
    expect(ins.status).toBe(200);
    const bad = await call("/operations/insert_row/", { table: "log", values: { kind: "x", occurred_at: "2026-09-24T23:10" }, path: "Daily/q" });
    expect(bad.status).toBe(422);
    expect((await call("/operations/update_rows/", { table: "log", where: { kind: "mood" }, set: { metric_drinks: 1 }, unset: ["people"] })).status).toBe(200);
    expect((await call("/operations/update_rows/", { table: "log", where: {}, unset: [3] })).status).toBe(400);
    expect((await call("/operations/update_rows/", { table: "log", where: {}, unset: "people" })).status).toBe(400);
    // update_rows changes no text, and changes every row only when "where" says so ({})
    expect((await call("/operations/update_rows/", { table: "log", set: { metric_drinks: 1 } })).status).toBe(400);
    const sel = await call("/operations/select_rows/", {
      table: "log",
      columns: ["kind"],
      where: { metric_drinks: { gt: 0 } },
      order_by: ["-metric_drinks"],
      limit: 10,
      offset: 0,
      expand: [],
    });
    expect(sel.status).toBe(200);
    expect((sel.json as { total: number }).total).toBe(3);
    expect((await call("/operations/select_rows/", { table: "log", limit: "10" })).status).toBe(400);
    expect((await call("/operations/select_rows/", { table: "log", offset: "1" })).status).toBe(400);
    expect((await call("/operations/select_rows/", { table: "log", order_by: 3 })).status).toBe(400);
    expect((await call("/operations/select_rows/", { table: "log", order_by: "kind" })).status).toBe(200);
    expect((await call("/operations/move_rows/", { table: "log", to_table: "log", where: {} })).status).toBe(400);
    const withBody = await call("/operations/select_rows/", { table: "log", where: { path: "Daily/a.md" }, include_body: true });
    expect((withBody.json as { rows: { body: string }[] }).rows[0]!.body).toBeDefined();
    expect((await call("/operations/select_rows/", { table: "log", include_body: "yes" })).status).toBe(400);
    expect((await call("/operations/update_row/", { table: "log", path: "Daily/a.md", body: "new body\n" })).status).toBe(200);
    const mv = await call("/operations/move_rows/", { table: "log", to_table: "log2", where: { path: "Daily/zzz.md" }, rename: {}, set: {}, drop: [], dry_run: true });
    expect(mv.status).toBe(200);
    const grouped = await call("/operations/select_rows/", { table: "log", group_by: "kind", aggregates: { n: "count" }, join: { table: "log", on: { kind: "kind" } } });
    expect(grouped.status).toBe(200);
    expect((await call("/operations/select_rows/", { table: "log", group_by: 3 })).status).toBe(400);
    expect((await call("/operations/select_rows/", { table: "log", aggregates: { n: "median:x" } })).status).toBe(400);
    expect((await call("/operations/select_rows/", { table: "log", where: [] })).status).toBe(400);
    expect((await call("/operations/check_table/", { table: "log" })).status).toBe(200);
    const del = await call("/operations/delete_rows/", { table: "log", where: { kind: "mood" }, mode: "archive", on_referenced: "ignore" });
    expect(del.status).toBe(200);
    expect(v.exists(`${LOG_DIR}/_archive/b.md`)).toBe(true);
    expect((await call("/operations/delete_rows/", { table: "log", where: {}, mode: "burn" })).status).toBe(400);
    expect((await call("/operations/delete_rows/", { table: "log", where: {}, on_referenced: "cascade" })).status).toBe(400);
    expect((await call("/operations/delete_rows/", { table: "log", where: { kind: "walk" } })).status).toBe(200);
    const undo = await call("/operations/undo_migration/", { migration_id: (del.json as { migration_id: string }).migration_id });
    expect(undo.status).toBe(200);
    expect(v.exists("Daily/b.md")).toBe(true);
    expect((await call("/operations/undo_migration/", { migration_id: (del.json as { migration_id: string }).migration_id })).status).toBe(409);
    expect((await call("/operations/undo_migration/", { migration_id: "nope" })).status).toBe(404);
    const listed = await call("/operations/list_migrations/", { limit: 2 });
    const body = listed.json as { total: number; migrations: { op: string; undone: boolean; undoes?: string }[] };
    expect(listed.status).toBe(200);
    expect(body.migrations).toHaveLength(2);
    expect(body.migrations[0]!.op).toBe("undo_migration");
    expect((await call("/operations/list_migrations/", { op: "delete_rows" })).json).toMatchObject({ migrations: [{ undone: false }, { undone: true }] });
  });

  it("infers tables and reports semantic search as unavailable without an index", async () => {
    const { call } = setup({ "Books/a.md": "---\ntitle: a\nyear: 1999\n---\n" });
    const inf = await call("/operations/infer_table/", { folder: "Books" });
    expect(inf.status).toBe(200);
    expect((inf.json as { proposal: { columns: { name: string }[] } }).proposal.columns.map((c) => c.name)).toEqual(["title", "year"]);
    expect((await call("/operations/infer_table/", { table: "log" })).status).toBe(200);
    expect((await call("/operations/infer_table/", {})).status).toBe(400);
    // folder "" is the whole vault
    const all = await call("/operations/infer_table/", { folder: "" });
    expect(all.status).toBe(200);
    expect((all.json as { paths: string[] }).paths).toContain("Books/a.md");
    expect(await call("/operations/infer_table/", { folder: 3 })).toMatchObject({ status: 400, json: { error: `infer_table: "folder" must be a string, not number 3` } });
  });

  it("an inferred proposal goes to create_table once its descriptions are written, its time column included", async () => {
    const visit = (day: string, extra: string) => `---\nvisited_on: 2026-09-0${day}\nplace: Rome\ncost: ${day}\nrating: ${day}.5\npaid: true\n${extra}---\n`;
    const { call, v } = setup({
      "Visits/one.md": visit("1", "tags: [food, art]\n"),
      "Visits/two.md": visit("2", "tags: [food]\n"),
      "Visits/three.md": visit("3", "tags: [art, food]\nWith whom: Ada\n"),
    });
    const inf = await call("/operations/infer_table/", { folder: "Visits", name: "visit" });
    const proposal = (inf.json as { proposal: Record<string, unknown> }).proposal;
    expect(proposal).toMatchObject({ name: "visit", time_column: "visited_on" });
    expect(proposal).not.toHaveProperty("timeColumn");
    expect(Object.keys(proposal)).toEqual(["name", "description", "time_column", "columns"]);
    expect(proposal.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "place", type: "enum", values: ["Rome"], description: null }),
        expect.objectContaining({ name: "tags", type: "list", items: "enum", values: ["food", "art"] }),
        expect.objectContaining({ name: "with_whom", type: "string" }),
      ]),
    );
    // as it is, the proposal leaves every description to write: refused, naming them all
    const asIs = await call("/operations/create_table/", { ...proposal });
    expect(asIs).toMatchObject({ status: 400, json: { error: `descriptions are required: main.public.visit has none for the table and columns ${(proposal.columns as { name: string }[]).map((c) => c.name).join(", ")}` } });
    expect((asIs.json as { hint: string }).hint).toMatch(/infer_table leaves every description null: write each one, then call create_table again\.$/);
    const created = await call("/operations/create_table/", described({ ...proposal }));
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(v.read(METASTORE)).toContain("visit:");
    const adopt = (inf.json as { adopt: Record<string, unknown> }).adopt;
    expect((await call("/operations/adopt_rows/", { table: "visit", ...adopt })).status).toBe(200);
    expect((await call("/operations/check_table/", { table: "visit" })).json).toMatchObject({ violations: [] });
    expect((await call("/operations/semantic_search/", { query: "x" })).status).toBe(400);
    expect((await call("/operations/describe_semantic_index/")).status).toBe(400);
  });

  it("undo failure maps to 500", async () => {
    const { call, v } = setup();
    const ins = await call("/operations/insert_row/", { table: "log", path: "Daily/new", values: { kind: "mood", occurred_at: "2026-09-24T23:10" } });
    (v.app.fileManager as unknown as { trashFile: () => Promise<void> }).trashFile = async () => {
      throw new Error("locked");
    };
    const u = await call("/operations/undo_migration/", { migration_id: (ins.json as { migration_id: string }).migration_id });
    expect(u.status).toBe(500);
  });
});

describe("dispatch / errors / registration", () => {
  it("rejects non-object bodies and logs one record per request", async () => {
    const records: { sev: string; attrs: Record<string, unknown> }[] = [];
    setTelemetry({ log: (sev, _b, attrs = {}) => records.push({ sev, attrs }), flush: async () => {} });
    const h: Handler = async () => ({ status: 200, json: {} });
    let t = 0;
    expect((await dispatch("/x/", h, [1], () => (t += 3))).status).toBe(400);
    expect((await dispatch("/x/", h, "s")).status).toBe(400);
    expect((await dispatch("/x/", h, undefined)).status).toBe(200);
    expect((await dispatch("/x/", async () => { throw new Error("boom"); }, {})).status).toBe(500);
    expect(records.map((r) => r.sev)).toEqual(["WARN", "WARN", "INFO", "ERROR"]);
    expect(records[0]!.attrs).toEqual({ "http.route": "/datanotes/x/", "http.response.status_code": 400, duration_ms: 3 });
  });

  it("errorResponse maps error classes", () => {
    expect(errorResponse(new AmbiguousCatalogRefError("t", ["a.s.t", "b.s.t"]))).toEqual({
      status: 409,
      json: {
        error: '"t" matches a.s.t, b.s.t; use catalog.schema.table',
        hint: "Name the table in full (catalog.schema.table): a.s.t or b.s.t.",
        docs: "https://datanotes.dev/guides/database-objects/catalogs-and-schemas.md#place-tables-in-catalogs-and-schemas",
        tables: ["a.s.t", "b.s.t"],
      },
    });
    expect(errorResponse(new OperationInputError("x")).status).toBe(400);
    expect(errorResponse(new MalformedColumnError(0, "x")).status).toBe(400);
    expect(errorResponse("weird")).toEqual({ status: 500, json: { error: "weird" } });
  });
});
