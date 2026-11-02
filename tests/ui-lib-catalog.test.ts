/**
 * The database browser's catalog cache (src/ui/lib/catalog.ts): describe_database merged with
 * list_tables, describe_table and the views' definitions, each cached until refresh().
 */

import { describe, expect, it, vi } from "vitest";
import type { ApiAnswer } from "../src/ui/lib/api";
import { AnswerError, CatalogCache } from "../src/ui/lib/catalog";

const DB = {
  root: "datanotes",
  config: { default_catalog: "work" },
  catalogs: [
    {
      catalog: "work",
      description: "Work",
      default: true,
      schemas: [
        {
          schema: "planning",
          tables: [
            { name: "person", qualified: "work.planning.person", row_count: 4, tags: { domain: "people" } },
            { name: "task", qualified: "work.planning.task", row_count: 8 },
          ],
          views: [{ name: "vw_open", qualified: "work.planning.vw_open" }],
        },
        { schema: "empty" },
      ],
    },
    { catalog: "bare" },
  ],
  bases: [{ name: "dated", columns: ["started_on"], tables: ["work.planning.task"] }],
};

const LIST = {
  tables: [
    { qualified: "work.planning.person", aliases: ["people"], tags: { domain: "ignored" } },
    { qualified: "work.planning.task", tags: { domain: "work" } },
  ],
  views: [{ qualified: "work.planning.vw_open", aliases: ["open tasks"] }],
};

const VIEWS = {
  rows: [
    {
      table_catalog: "work",
      table_schema: "planning",
      table_name: "vw_open",
      view_definition: '{"table":"work.planning.task"}',
      labels: '{"title":"Task"}',
      comment: "Open tasks",
      aliases: ["open tasks"],
    },
    { table_catalog: "w", table_schema: "s", table_name: "bad", view_definition: "{nope", labels: "[1]", comment: "" },
    { table_catalog: "w", table_schema: "s", table_name: "raw", view_definition: 5 },
  ],
};

function fakeOp(answers: Record<string, ApiAnswer | (() => ApiAnswer | Promise<ApiAnswer>)>) {
  return vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    const a = answers[name];
    if (!a) throw new Error(`unexpected ${name}`);
    return typeof a === "function" ? a() : a;
  });
}

const ok = (json: unknown): ApiAnswer => ({ status: 200, ok: true, json: json as Record<string, unknown> });

describe("CatalogCache", () => {
  it("merges describe_database with list_tables by qualified name, and caches it", async () => {
    const op = fakeOp({ describe_database: ok(DB), list_tables: ok(LIST) });
    const cache = new CatalogCache(op);
    expect(cache.kindOf("work.planning.task")).toBeNull();
    const tree = await cache.load();
    expect(tree.root).toBe("datanotes");
    expect(tree.config).toEqual({ default_catalog: "work" });
    const s = tree.catalogs[0]!.schemas[0]!;
    expect(s.tables[0]).toEqual({ name: "person", qualified: "work.planning.person", row_count: 4, tags: { domain: "people" }, aliases: ["people"] });
    expect(s.tables[1]).toEqual({ name: "task", qualified: "work.planning.task", row_count: 8, tags: { domain: "work" } });
    expect(s.views[0]).toEqual({ name: "vw_open", qualified: "work.planning.vw_open", aliases: ["open tasks"] });
    expect(tree.catalogs[0]!.schemas[1]).toEqual({ schema: "empty", tables: [], views: [] });
    expect(tree.catalogs[1]).toEqual({ catalog: "bare", schemas: [] });
    await cache.load();
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("knows what a name is once loaded", async () => {
    const cache = new CatalogCache(fakeOp({ describe_database: ok(DB), list_tables: ok(LIST) }));
    await cache.load();
    expect(cache.kindOf("work.planning.task")).toBe("table");
    expect(cache.kindOf("work.planning.vw_open")).toBe("view");
    expect(cache.kindOf("base:dated")).toBe("base");
    expect(cache.kindOf("base:nope")).toBeNull();
    expect(cache.kindOf("nope")).toBeNull();
  });

  it("works without list_tables, and with an empty describe_database", async () => {
    const cache = new CatalogCache(fakeOp({ describe_database: ok({}), list_tables: { status: 403, ok: false, json: {} } }));
    expect(await cache.load()).toEqual({ catalogs: [], bases: [], config: {}, root: "" });
    const c2 = new CatalogCache(fakeOp({ describe_database: ok(DB), list_tables: ok({}) }));
    expect((await c2.load()).catalogs[0]!.schemas[0]!.tables[1]!.tags).toBeUndefined();
  });

  it("throws the error answer with its body, and does not cache the failure", async () => {
    let fail = true;
    const op = fakeOp({
      describe_database: () =>
        fail ? { status: 403, ok: false, json: { error: "no", hint: "h", docs: "https://datanotes.dev/x.md#y" } } : ok(DB),
      list_tables: ok(LIST),
    });
    const cache = new CatalogCache(op);
    const err = await cache.load().catch((e) => e);
    expect(err).toBeInstanceOf(AnswerError);
    expect(err.body).toEqual({ error: "no", hint: "h", docs: "https://datanotes.dev/x.md#y" });
    expect(err.status).toBe(403);
    fail = false;
    expect((await cache.load()).root).toBe("datanotes");
    const bare = new CatalogCache(fakeOp({ describe_database: { status: 500, ok: false, json: {} }, list_tables: ok({}) }));
    expect((await bare.load().catch((e) => e)).body).toEqual({ error: "HTTP 500" });
  });

  it("refresh() drops every cache and tells the subscribers", async () => {
    const op = fakeOp({ describe_database: ok(DB), list_tables: ok(LIST), describe_table: ok({ name: "task" }), select_rows: ok(VIEWS) });
    const cache = new CatalogCache(op);
    const heard = vi.fn();
    const off = cache.subscribe(heard);
    cache.subscribe(() => {
      throw new Error("broken subscriber");
    });
    await cache.load();
    await cache.describe("work.planning.task");
    await cache.describe("work.planning.task");
    await cache.views();
    await cache.views();
    expect(op).toHaveBeenCalledTimes(4);
    await cache.refresh();
    expect(heard).toHaveBeenCalledOnce();
    await cache.describe("work.planning.task");
    await cache.views();
    expect(op).toHaveBeenCalledTimes(8);
    off();
    await cache.refresh();
    expect(heard).toHaveBeenCalledOnce();
  });

  it("does not let a load started before refresh() replace the new tree", async () => {
    let release: (a: ApiAnswer) => void = () => {};
    let n = 0;
    const op = fakeOp({
      describe_database: () => (++n === 1 ? new Promise<ApiAnswer>((r) => (release = r)) : ok(DB)),
      list_tables: ok(LIST),
    });
    const cache = new CatalogCache(op);
    const first = cache.load();
    await cache.refresh();
    release({ status: 500, ok: false, json: {} });
    await first.catch(() => {});
    expect(cache.kindOf("work.planning.task")).toBe("table");
    await cache.load();
    expect(n).toBe(2);
  });

  it("does not cache a describe_table refusal or failure", async () => {
    let answer: ApiAnswer | Error = { status: 404, ok: false, json: { error: "is a view" } };
    const op = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const cache = new CatalogCache(op);
    expect((await cache.describe("v")).status).toBe(404);
    answer = new Error("down");
    await expect(cache.describe("v")).rejects.toThrow("down");
    answer = ok({ name: "v" });
    expect((await cache.describe("v")).status).toBe(200);
    expect(await cache.describe("v")).toEqual(ok({ name: "v" }));
    expect(op).toHaveBeenCalledTimes(3);
    expect(op).toHaveBeenCalledWith("describe_table", { table: "v" });
  });

  it("keeps a describe made after refresh() when an older one fails", async () => {
    let release: (a: ApiAnswer) => void = () => {};
    let n = 0;
    const op = vi.fn(async () => (++n === 1 ? new Promise<ApiAnswer>((r) => (release = r)) : ok({ n })));
    const cache = new CatalogCache(op as never);
    const old = cache.describe("t");
    cache.refresh().catch(() => {});
    const fresh = cache.describe("t");
    release({ status: 500, ok: false, json: {} });
    await old;
    await fresh;
    expect(await cache.describe("t")).toBe(await fresh);
  });

  it("reads the views' definitions, with bad JSON strings as null and {}", async () => {
    const op = fakeOp({ select_rows: ok(VIEWS) });
    const views = await new CatalogCache(op).views();
    expect(op).toHaveBeenCalledWith("select_rows", { table: "system.information_schema.views", limit: 1000 });
    expect(views).toEqual([
      { qualified: "work.planning.vw_open", query: { table: "work.planning.task" }, description: "Open tasks", aliases: ["open tasks"], labels: { title: "Task" } },
      { qualified: "w.s.bad", query: null, aliases: [], labels: {} },
      { qualified: "w.s.raw", query: null, aliases: [], labels: {} },
    ]);
    expect(await new CatalogCache(fakeOp({ select_rows: ok({}) })).views()).toEqual([]);
  });

  it("throws a views refusal with its body and does not cache it", async () => {
    let fail = true;
    const cache = new CatalogCache(fakeOp({ select_rows: () => (fail ? { status: 403, ok: false, json: { error: "no" } } : ok(VIEWS)) }));
    expect((await cache.views().catch((e) => e)).body).toEqual({ error: "no" });
    fail = false;
    expect(await cache.views()).toHaveLength(3);
  });

  it("does not drop a views list made after refresh() when an older one fails", async () => {
    let release: (a: ApiAnswer) => void = () => {};
    let n = 0;
    const op = fakeOp({
      select_rows: () => (++n === 1 ? new Promise<ApiAnswer>((r) => (release = r)) : ok(VIEWS)),
      describe_database: ok(DB),
      list_tables: ok(LIST),
    });
    const cache = new CatalogCache(op);
    const old = cache.views();
    await cache.refresh();
    const fresh = cache.views();
    release({ status: 500, ok: false, json: {} });
    await old.catch(() => {});
    expect(await cache.views()).toBe(await fresh);
    expect(n).toBe(2);
  });
});
