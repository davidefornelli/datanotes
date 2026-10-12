import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { createPublicApi } from "../src/core/public-api";
import { SemanticIndex } from "../src/core/semantic";
import { createHandlers, dispatch } from "../src/server/rest";
import { WebhookDispatcher } from "../src/server/webhooks";
import { logVault } from "./helpers/db-vault";
import { guided } from "./helpers/guidance";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const A = "01a0f000-0000-7000-8000-00000000000a";

function setup(opts: { semantic?: boolean; webhooks?: boolean } = {}) {
  const v = logVault({
    "People/Ada.md": "---\nrole: engineer\n---\nAda\n",
    "People/Bob.md": "---\nrole: designer\n---\nBob, works with [[Ada]]\n",
  });
  const semantic = opts.semantic
    ? new SemanticIndex(v.app, () => v.settings, async (req) => {
        const { input } = JSON.parse(req.body) as { input: string[] };
        return { status: 200, text: JSON.stringify({ data: input.map((_t, index) => ({ embedding: [1, index + 1], index })) }) };
      })
    : undefined;
  if (semantic) Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "m" });
  const hooks = opts.webhooks ? new WebhookDispatcher(v.app, () => v.settings, () => null, async () => ({ status: 200 })) : null;
  const api = createPublicApi(v.app, () => v.settings, async () => {}, semantic, undefined, () => hooks);
  const h = opts.webhooks ? createHandlers(v.app, () => v.settings, async () => {}, semantic, api) : createHandlers(v.app, () => v.settings, undefined, semantic);
  const call = (route: string, body: Record<string, unknown> = {}) => dispatch(route, h[route]!, body);
  return { v, call, hooks };
}

describe("REST routes: argument refusals (400, exact messages)", () => {
  it.each([
    ["/operations/describe_history/", { table: "log", limit: -1 }, '"limit" must be a non-negative integer'],
    ["/operations/describe_history/", { table: "log", limit: 2.5 }, 'describe_history: "limit" must be an integer, not number 2.5'],
    ["/operations/check_table/", { offset: "10" }, 'check_table: "offset" must be an integer, not string "10"'],
    ["/operations/insert_row/", { table: "log" }, 'insert_row: missing required argument "values" (object)'],
    ["/operations/configure_database/", { history: "yes" }, 'configure_database: "history" must be a boolean, not string "yes"'],
    ["/operations/batch/", { operations: ["insert_row"] }, 'batch: "operations": item "insert_row" must be an object'],
    ["/operations/batch/", { operations: [{ table: "log" }] }, 'operation 0 needs "op"'],
    ["/operations/merge_rows/", { table: "log", on: ["id"], rows: [{ id: A }], when_matched: "replace" }, 'merge_rows: "when_matched" must be "update" or "ignore", not string "replace"'],
    ["/operations/merge_rows/", { table: "log", on: ["id"], rows: [{ id: A }], when_not_matched: "fail" }, 'merge_rows: "when_not_matched" must be "insert" or "ignore", not string "fail"'],
    ["/operations/merge_rows/", { table: "log", on: [], rows: [] }, '"on" needs at least one key column'],
    ["/operations/table_changes/", { table: "log" }, 'table_changes: missing required argument "start_version" (integer)'],
    ["/operations/restore_table/", { table: "log" }, 'pass "version" or "timestamp"'],
    ["/operations/restore_database/", {}, 'pass "timestamp" or "before_migration" (one of them)'],
    ["/operations/restore_database/", { timestamp: "2026-01-01", before_migration: "x" }, 'pass "timestamp" or "before_migration" (one of them)'],
    ["/operations/describe_history/", { since: "" }, '"since" must be a non-empty string'],
    ["/operations/create_webhook/", { url: "http://receiver.test/x", kinds: ["insert", "upsert"] }, 'create_webhook: "kinds": item "upsert" must be "insert", "update", "delete", "move", "metastore", "tool_call" or "unreadable"'],
    ["/operations/describe_semantic_index/", {}, "semantic search is not available"],
    ["/operations/sync_semantic_index/", {}, "semantic search is not available"],
    ["/operations/create_table/", described({ schema: "public", columns: [] }), 'create_table: missing required argument "name" (string)'],
    ["/operations/select_rows/", { table: "log", wher: { kind: "mood" } }, 'select_rows: unknown argument "wher"'],
  ])("%s %j → %s", async (route, body, error) => {
    const { call } = setup();
    expect(await call(route, body)).toEqual({ status: 400, json: guided(error) });
  });

  it("a batch refuses an operation named like an inherited property (toString, constructor)", async () => {
    const { call } = setup();
    for (const op of ["toString", "constructor", "__proto__"]) {
      const r = await call("/operations/batch/", { operations: [{ op, table: "log" }] });
      expect(r.status).toBe(400);
      expect((r.json as { error: string }).error).toMatch(/^operation 0: "op" must be one of insert_row, /);
    }
  });

  it("semantic search refuses a min_score that is not a number", async () => {
    const { call } = setup({ semantic: true });
    expect(await call("/operations/semantic_search/", { query: "x", min_score: "0.5" })).toEqual({ status: 400, json: guided('semantic_search: "min_score" must be a number, not string "0.5"') });
  });
});

describe("REST routes: options passed through", () => {
  it("a batch whose operation fails with an error (no result) rolls back and answers 422 with the error", async () => {
    const { call, v } = setup();
    const r = await call("/operations/batch/", {
      operations: [
        { op: "insert_row", table: "log", values: { kind: "walk", occurred_at: "2026-10-01T07:00" } },
        { op: "update_rows", table: "log", where: {}, set: { color: "red" } },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ ok: false, failed_at: 1, rolled_back: true, steps: [{ ok: true }, { ok: false, error: `unknown column "color" for table "log"` }] });
    expect(v.list().filter((p) => p.startsWith("Datanotes/main/public/log/"))).toEqual([]);
  });

  it("a batch whose rollback cannot undo an operation answers 500", async () => {
    const v = logVault();
    // the journal is lost as soon as the batch has written it (a sync tool removed it): nothing can be undone
    const settings = () => {
      for (const p of v.listAll()) if (p.startsWith("store:journal/")) v.remove(p);
      return v.settings;
    };
    const h = createHandlers(v.app, settings);
    const r = await dispatch("/operations/batch/", h["/operations/batch/"]!, {
      operations: [
        { op: "insert_row", table: "log", values: { kind: "walk", occurred_at: "2026-10-01T07:00" } },
        { op: "update_rows", table: "log", where: {}, set: { color: "red" } },
      ],
    });
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ ok: false, failed_at: 1, rolled_back: false, rollback: [{ ok: false }] });
    expect((r.json as { hint: string }).hint).toMatch(/^Some operations could not be undone/);
  });

  it("update_rows with unset only", async () => {
    const { call, v } = setup();
    const r = await call("/operations/update_rows/", { table: "log", where: { kind: "alcohol" }, unset: ["metric_drinks"] });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(v.read("Daily/a.md")).not.toContain("metric_drinks");
  });

  it("a batch whose operation is refused (422) rolls back and answers 422 with that operation's reason", async () => {
    const { call, v } = setup();
    const r = await call("/operations/batch/", {
      operations: [
        { op: "insert_row", table: "log", values: { kind: "walk", occurred_at: "2026-10-01T07:00" } },
        { op: "insert_row", table: "log", values: { kind: "swim", occurred_at: "2026-10-01T08:00" } },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ ok: false });
    expect(v.list().filter((p) => p.startsWith("Datanotes/main/public/log/"))).toEqual([]);
  });

  it("configure_database without a settings callback still moves the database folder", async () => {
    const { call, v } = setup();
    const r = await call("/operations/configure_database/", { root: "Library" });
    expect(r.status).toBe(200);
    expect(v.settings.databaseFolder).toBe("Library");
    expect(v.exists("Library/metastore.yaml")).toBe(true);
  });

  it("infer_table passes max_enum_values", async () => {
    const { call } = setup();
    const r = (await call("/operations/infer_table/", { folder: "People", name: "person", max_enum_values: 1 })) as { status: number; json: { proposal: { columns: { name: string; type: string }[] } } };
    expect(r.status).toBe(200);
    expect(r.json.proposal.columns.find((c) => c.name === "role")).toMatchObject({ type: "string" }); // 2 values > 1: not an enum
  });

  it("define_base and set_table_bases without columns or bases", async () => {
    const { call } = setup();
    expect((await call("/operations/define_base/", { name: "entity", description: "Every entity", columns: [] })).status).toBe(200);
    const r = await call("/operations/set_table_bases/", { table: "log", bases: [] });
    expect(r.status).toBe(200);
  });

  it("align_relations, adopt_rows and recompute take paths; delete_rows a where", async () => {
    const { call, v } = setup();
    expect((await call("/operations/align_relations/", { table: "log", paths: ["Daily/a.md"] })).json).toMatchObject({ error: expect.stringContaining("no inverse link columns") });
    expect((await call("/operations/adopt_rows/", { table: "log", paths: [] })).status).toBe(400);
    const del = await call("/operations/delete_rows/", { table: "log", where: { kind: "mood" }, dry_run: true });
    expect(del).toMatchObject({ status: 200, json: { ok: true, dry_run: true } });
    expect(v.exists("Daily/b.md")).toBe(true);
  });

  it("update-one replaces the body, or prepends to it", async () => {
    const { call, v } = setup();
    expect((await call("/operations/update_row/", { table: "log", id: A, body: "Rewritten\n" })).status).toBe(200);
    expect(v.read("Daily/a.md").endsWith("Rewritten\n")).toBe(true);
    expect((await call("/operations/update_row/", { table: "log", id: A, body_prepend: "First line" })).status).toBe(200);
    expect(v.read("Daily/a.md")).toContain("First line");
  });

  it("graph routes pass edges, through, depths and limit", async () => {
    const { call } = setup();
    const from = { paths: ["People/Bob.md"] };
    await call("/operations/list_tables/"); // the metastore loaded, as the runtime does at start
    const n = await call("/operations/graph_neighbors/", { from_nodes: from, edges: ["link"] });
    expect(n).toEqual({ status: 200, json: { nodes: [{ path: "People/Bob.md", counts: { "out:link": 1 }, edges: [{ path: "People/Ada.md", label: "link", direction: "out" }] }] } });
    const t = await call("/operations/graph_traverse/", { from_nodes: from, through: ["log"], min_depth: 1, max_depth: 2, limit: 5 });
    expect(t.status).toBe(200);
    expect(await call("/operations/graph_traverse/", { from_nodes: from, through: ["nope"] })).toEqual({ status: 400, json: guided('through: unknown table "nope"') });
    const p = await call("/operations/graph_path/", { from_nodes: from, to_nodes: { paths: ["People/Ada.md"] }, max_depth: 1 });
    expect(p).toMatchObject({ status: 200, json: { found: true, length: 1 } });
  });

  it("check_table pages its violations", async () => {
    const { call } = setup();
    expect((await call("/operations/check_table/", { table: "log", limit: 1, offset: 0 })).status).toBe(200);
  });

  it("webhooks: a webhook with every filter, then the list", async () => {
    const { call, hooks } = setup({ webhooks: true });
    await hooks!.start();
    const r = await call("/operations/create_webhook/", { url: "http://receiver.test/x", columns: ["kind"], exclude_actor: "pantry", where: { kind: "mood" }, since: 3 });
    expect(r).toMatchObject({ status: 200, json: { columns: ["kind"], exclude_actor: "pantry", where: { kind: "mood" }, cursor: 3 } });
    expect(((await call("/operations/list_webhooks/")).json as { webhooks: unknown[] }).webhooks).toHaveLength(1);
    await hooks!.stop();
  });
});
