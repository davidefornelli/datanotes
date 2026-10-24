/**
 * The catalogue's `responseSchema`s against what the handlers really return: each operation is
 * mapped to its request (`operationRequest`), run on its handler (`createHandlers`), and its JSON
 * body validated. The validator is
 * strict about undeclared properties (unless `additionalProperties` is given), so a field the code
 * returns but the schema does not describe fails the test.
 */

import { afterEach, describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { ChangeFeed } from "../src/core/change-feed";
import { INDEX_RETRY } from "../src/core/engine";
import { createPublicApi } from "../src/core/public-api";
import { SemanticIndex } from "../src/core/semantic";
import type { DatanotesSettings } from "../src/core/settings";
import type { Transport } from "../src/core/embeddings";
import { createHandlers, dispatch } from "../src/server/rest";
import { WebhookDispatcher } from "../src/server/webhooks";
import { logVault } from "./helpers/db-vault";
import { validate } from "./helpers/schema";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

type Schema = Record<string, unknown>;

const SCHEMAS = new Map(OPERATIONS.map((o) => [o.name, o.responseSchema as Schema | undefined]));

/** Bag-of-words embeddings, as in semantic.test.ts. */
const VOCAB = ["dinner", "pizza", "alice", "mood", "walk", "drinks"];
const transport: Transport = async (req) => {
  const { input } = JSON.parse(req.body) as { input: string[] };
  const data = input.map((t, index) => ({ index, embedding: VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1 : 0) + 0.01) }));
  return { status: 200, text: JSON.stringify({ data }) };
};

const MOOD_COLUMNS = [
  { name: "occurred_at", type: "datetime", required: true, dense: true },
  { name: "value", type: "integer", min: 1, max: 5, dense: true },
];

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function engine() {
  const v = logVault({
    "Notes/Dinner.md": "Dinner with [[Alice]] and pizza.\n",
    "Alice.md": "---\nrole: friend\n---\n# Alice\nLikes pizza.\n",
    "Inbox/feeling.md": "---\noccurred_at: 2026-09-27T09:00\nvalue: 3\n---\nfine\n",
  });
  Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake" } satisfies Partial<DatanotesSettings>);
  const feed = new ChangeFeed(v.app, () => v.settings);
  await feed.start();
  const hooks = new WebhookDispatcher(v.app, () => v.settings, () => feed, async () => ({ status: 204 }), 10);
  const semantic = new SemanticIndex(v.app, () => v.settings, transport);
  const api = createPublicApi(v.app, () => v.settings, async () => {}, semantic, () => feed, () => hooks);
  const handlers = createHandlers(v.app, () => v.settings, async () => {}, semantic, api);
  cleanup = async () => {
    feed.stop();
    await hooks.stop();
  };

  /** Run an operation as a caller would and return its 2xx JSON body (as serialized on the wire). */
  async function run(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const req = operationRequest(name, args);
    const route = req.path.slice(ROUTE_PREFIX.length);
    const handler = handlers[route];
    if (!handler) throw new Error(`${name}: no handler for ${route}`);
    const res = await dispatch(route, handler, req.body);
    if (res.status < 200 || res.status >= 300) throw new Error(`${name} answered ${res.status}: ${JSON.stringify(res.json).slice(0, 600)}`);
    return JSON.parse(JSON.stringify(res.json));
  }

  const validated: string[] = [];
  /** Run and validate against the operation's responseSchema; returns the body. */
  async function check<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const body = await run(name, args);
    const schema = SCHEMAS.get(name);
    expect(schema, `${name} has a responseSchema`).toBeDefined();
    const errors = validate(schema!, body);
    expect(errors, `${name}: ${JSON.stringify(body).slice(0, 800)}`).toEqual([]);
    if (!validated.includes(name)) validated.push(name);
    return body as T;
  }
  return { v, feed, check, validated };
}

describe("validator", () => {
  it("catches wrong types, missing and undeclared properties, enums and anyOf", () => {
    const s: Schema = {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "array", items: { type: "string", enum: ["x"] } }, c: { type: ["integer", "null"] } },
      required: ["a"],
    };
    expect(validate(s, { a: 1, b: ["x"], c: null })).toEqual([]);
    expect(validate(s, { a: 1.5 })).toHaveLength(1);
    expect(validate(s, { b: ["y"] })).toHaveLength(2);
    expect(validate(s, { a: 1, z: 1 })).toEqual([`$: undeclared property "z"`]);
    expect(validate({ ...s, additionalProperties: true }, { a: 1, z: 1 })).toEqual([]);
    expect(validate({ anyOf: [{ type: "string" }, { type: "integer" }] }, true)).toHaveLength(1);
  });
});

describe("responseSchema", () => {
  it("is set on every operation; write operations share one OpResult", () => {
    expect(OPERATIONS.filter((o) => !o.responseSchema).map((o) => o.name)).toEqual([]);
    const opResults = OPERATIONS.map((o) => o.responseSchema as Schema).filter((s) => s.title === "OpResult");
    expect(opResults.length).toBeGreaterThan(20);
    for (const s of opResults) expect(s).toEqual(opResults[0]);
  });

  it("matches what the operations return", async () => {
    const { v, feed, check, validated } = await engine();

    // vault routes
    expect(validate(SCHEMAS.get("read_note")!, await check("read_note", { path: "Notes/Dinner.md" }))).toEqual([]);
    await check("list_folder", { folder: "Notes" });
    await check("list_folder", {});
    expect((await check<{ results: unknown[] }>("search_notes", { query: "pizza" })).results.length).toBe(2);

    // reads on the log table
    await check("list_tables");
    await check("describe_table", { table: "log" });
    await check("describe_database");
    await check("select_rows", { table: "log", columns: ["kind"] });
    await check("select_rows", { table: "log", include_body: true, order_by: "-occurred_at", limit: 1 });
    await check("select_rows", { table: "log", group_by: "kind", aggregates: { n: "count" } });
    await check("check_table", { table: "log" });
    expect(await check("check_table", {})).toMatchObject({ table: null, tables_checked: 1 });
    await check("infer_table", { paths: ["Inbox/feeling.md"] });
    await check("infer_table", { table: "log" });
    await check("graph_neighbors", { from_nodes: { paths: ["Notes/Dinner.md"] }, direction: "both" });
    await check("graph_traverse", { from_nodes: { paths: ["Notes/Dinner.md"] }, max_depth: 2 });
    expect(await check("graph_path", { from_nodes: { paths: ["Notes/Dinner.md"] }, to_nodes: { paths: ["Alice.md"] } })).toMatchObject({ found: true, length: 1 });
    expect(await check("graph_path", { from_nodes: { paths: ["Alice.md"] }, to_nodes: { paths: ["Daily/a.md"] }, direction: "out" })).toMatchObject({ found: false, length: null });

    // semantic search
    await check("describe_semantic_index", {});
    await check("sync_semantic_index", {});
    await check("semantic_search", { query: "pizza dinner" });

    // database and DDL (history on, so the new table has a transaction log)
    await check("configure_database", { history: true });
    await check("create_table", described({ schema: "metrics", name: "draft", time_column: "occurred_at", columns: MOOD_COLUMNS, dry_run: true }));
    await check("create_table", described({ schema: "metrics", name: "mood", time_column: "occurred_at", columns: MOOD_COLUMNS, tags: { domain: "health" } }));
    await check("add_column", described({ table: "mood", column: { name: "note", type: "string" }, dry_run: true }));
    await check("rename_column", { table: "log", from_column: "metric_drinks", to_column: "drinks", dry_run: true });
    await check("drop_column", { table: "log", column: "metric_drinks", dry_run: true });
    await check("alter_column", { table: "log", column: "metric_drinks", changes: { max: 40 }, dry_run: true });
    await check("alter_table", { table: "log", description: "What I did", dry_run: true });
    await check("alter_table", { table: "mood", tags: { owner: "me", domain: null }, dry_run: true });
    await check("comment_on", { catalog: "main", description: "Everything" });
    await check("comment_on", { catalog: "main", schema: "metrics", description: "", dry_run: true });
    // the tags and descriptions read back
    await check("list_tables");
    await check("describe_table", { table: "mood" });
    await check("describe_database");
    await check("select_rows", { table: "system.information_schema.tables", columns: ["full_name", "tags"] });
    await check("rename_value", { table: "log", column: "kind", from_value: "walk", to_value: "hike", dry_run: true });
    await check("add_constraint", { table: "mood", name: "positive", check: { value: { gte: 1 } } });
    await check("drop_constraint", { table: "mood", name: "positive", dry_run: true });
    await check("define_base", describedBase({ name: "event", columns: [{ name: "occurred_at", type: "datetime", required: true }] }));
    await check("set_table_bases", { table: "mood", bases: ["event"], dry_run: true });
    await check("create_view", { name: "moods", query: { table: "log", where: { kind: "mood" } } });
    await check("drop_view", { view: "moods", dry_run: true });
    // a rename rewrites the view's table: schema_references lists it
    const moved = await check<{ schema_references: unknown[] }>("alter_table", { table: "log", name: "diary", dry_run: true });
    expect(moved.schema_references).toEqual([{ view: "main.public.moods", key: "table", from: "log", to: "main.public.diary" }]);
    // a clone needs the descriptions the log table (written before they were required) lacks
    await check("clone_table", { source: "mood", target: "mood_copy", dry_run: true });
    await check("drop_table", { table: "log", mode: "archive", dry_run: true });

    // rows
    const ins = await check<{ migration_id: string }>("insert_row", { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    await check("insert_row", { table: "mood", values: { occurred_at: "2026-09-26T10:00", value: 4 } });
    await check("update_row", { table: "log", path: "Daily/a.md", set: { metric_drinks: 3 } });
    const changed = await check<{ migration_id: string }>("update_rows", { table: "mood", where: { value: 2 }, set: { value: 3 } });
    await check("delete_rows", { table: "log", where: { kind: "mood" }, dry_run: true });
    await check("merge_rows", { table: "mood", on: ["occurred_at"], rows: [{ occurred_at: "2026-09-26T09:00", value: 5 }, { occurred_at: "2026-09-27T09:00", value: 1 }], dry_run: true });
    await check("adopt_rows", { table: "mood", paths: ["Inbox/feeling.md"], dry_run: true });
    await check("move_rows", { table: "log", to_table: "mood", where: { kind: "mood" }, drop: ["kind", "metric_drinks", "people"], set: { value: 3 }, dry_run: true });
    await check("recompute_columns", { table: "log", dry_run: true });
    await check("create_table", described({
      name: "person",
      filename: "{name}",
      columns: [
        { name: "name", type: "string", required: true },
        { name: "friends", type: "list", items: "link", ref: "self", inverse: "friends" },
      ],
    }));
    await check("insert_row", { table: "person", values: { name: "Bob" } });
    await check("align_relations", { table: "person", dry_run: true });
    await check("add_column", described({ table: "person", column: { name: "leader", type: "link", ref: "self", ref_where: { name: "Bob" } } }));
    await check("describe_table", { table: "person" });
    expect(await check("list_link_targets", { table: "person", column: "leader", values: { name: "Ann" } })).toMatchObject({ total: 1, rows: [{ name: "Bob" }] });
    await check("batch", { operations: [{ op: "update_row", table: "log", path: "Daily/a.md", set: { metric_drinks: 4 } }, described({ op: "add_column", table: "mood", column: { name: "tag", type: "string" } })], dry_run: true });
    await check("batch", { operations: [{ op: "update_row", table: "log", path: "Daily/b.md", set: { metric_drinks: 1 } }], summary: "one" });

    // journal and history
    await check("list_migrations", { limit: 5 });
    await check("describe_history", { table: "mood" });
    await check("table_changes", { table: "mood", start_version: 0 });
    await check("restore_table", { table: "mood", version: 0, dry_run: true });
    // the whole database: before its first commit every table is dropped (a plan per table)
    expect(await check<{ tables: unknown[] }>("restore_database", { timestamp: "2000-01-01T00:00:00Z", dry_run: true })).toMatchObject({ tables: [{ action: "drop" }, { action: "drop" }, { action: "drop" }] });
    expect((await check<{ history: { table: string }[] }>("describe_history", { limit: 3 })).history[0]!.table).toMatch(/^main./);
    await check("vacuum_table", { table: "mood" });
    // the inserted row changed since: that change is undone first
    await check("undo_migration", { migration_id: changed.migration_id });
    await check("undo_migration", { migration_id: ins.migration_id });

    // change feed and webhooks (a hand edit breaking a rule carries its violations)
    await feed.flush();
    v.write("Daily/b.md", "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: mood\noccurred_at: 2026-09-26T08:00\nmetric_drinks: 99\n---\nB\n");
    feed.touch("Daily/b.md");
    await feed.flush();
    const edited = await check<{ events: { violations?: unknown[] }[] }>("list_changes", { since: feed.lastSeq - 1, limit: 5 });
    expect(edited.events.at(-1)!.violations).toEqual([{ path: "Daily/b.md", violations: [expect.objectContaining({ code: "max", column: "metric_drinks" })] }]);
    expect((await check<{ events: unknown[] }>("list_changes", { since: 0, limit: 50 })).events.length).toBeGreaterThan(0);
    const hook = await check<{ id: string }>("create_webhook", { url: "http://receiver.test/hook", tables: ["log"], kinds: ["update"] });
    await check("list_webhooks");
    await check("delete_webhook", { id: hook.id });

    expect(v.exists("Notes/Dinner.md")).toBe(true);
    expect(validated.length).toBeGreaterThanOrEqual(25);
    expect(OPERATIONS.map((o) => o.name).filter((n) => !validated.includes(n))).toEqual([]);
  });
});
