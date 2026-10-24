/**
 * Read permissions of named tokens on the notes (lane C of the read-permission plan): read_note,
 * list_folder, search_notes, semantic_search and the graph operations answer a restricted token
 * only about the rows of the tables it may read (src/core/read-scope.ts). A note the caller names
 * is refused (403); a set it did not enumerate (search results, folder children, graph neighbours)
 * is filtered, before any limit. Free notes are never readable under a restricted scope.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { runWithActor } from "../src/core/actor";
import type { HttpRequest, Transport } from "../src/core/embeddings";
import { graphIndex } from "../src/core/graph";
import { runWithReadScope, type ReadScope } from "../src/core/read-scope";
import { SemanticIndex } from "../src/core/semantic";
import { listFolder, searchNotes } from "../src/core/vault-read";
import { createDbVault } from "./helpers/db-vault";
import { createHandlers, dispatch, type Handler, type HandlerResponse } from "../src/server/rest";
import { expectNoLeak, MEALS, noteRefusal, PANTRY, readRefusal, setupReadTokens, TOKENS, WEIGHT, type ReadSetup, type ReadTokenName } from "./helpers/read-tokens";

const COOK: ReadScope = { token: "cook", patterns: TOKENS.cook.read };
const NURSE: ReadScope = { token: "nurse", patterns: TOKENS.nurse.read };

/** The paths of a search_notes or semantic_search answer. */
const pathsOf = (r: HandlerResponse | { results: { path: string }[] }) => ("json" in r ? (r.json as { results: { path: string }[] }) : r).results.map((h) => h.path);

describe("read_note", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setupReadTokens();
  });

  it("refuses a restricted token a row of a table it may not read, and every free note", async () => {
    expect(await s.op("cook", "read_note", { path: s.paths.heavy })).toEqual(noteRefusal("cook", s.paths.heavy));
    expect(await s.op("cook", "read_note", { path: s.paths.diary })).toEqual(noteRefusal("cook", s.paths.diary));
    expect(await s.op("nurse", "read_note", { path: s.paths.diary })).toEqual(noteRefusal("nurse", s.paths.diary));
    expect(await s.op("nurse", "read_note", { path: s.paths.eggs })).toEqual(noteRefusal("nurse", s.paths.eggs));
    expect(await s.op("blind", "read_note", { path: s.paths.eggs })).toEqual(noteRefusal("blind", s.paths.eggs));
    // a path written loosely is refused under its vault path
    expect(await s.op("cook", "read_note", { path: `/${s.paths.heavy}` })).toEqual(noteRefusal("cook", s.paths.heavy));
  });

  it("reads a row of a readable table, and tells a missing note as it does to the owner", async () => {
    const r = await s.op("cook", "read_note", { path: s.paths.eggs });
    expect(r.status).toBe(200);
    expect((r.json as { front_matter: Record<string, unknown> }).front_matter).toMatchObject({ table: PANTRY, item: "eggs", for_weight: "[[Morning weigh-in]]" });
    expectNoLeak(r);
    expect((await s.op("nurse", "read_note", { path: s.paths.heavy })).status).toBe(200);
    expect(await s.op("cook", "read_note", { path: "Nope.md" })).toEqual(await s.op("owner", "read_note", { path: "Nope.md" }));
  });

  it("reads everything with a token without read or with read *", async () => {
    for (const t of ["legacy", "star"] as const) {
      for (const path of [s.paths.diary, s.paths.heavy]) expect(await s.op(t, "read_note", { path })).toEqual(await s.op("owner", "read_note", { path }));
    }
  });
});

describe("list_folder", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setupReadTokens();
  });
  const list = (scope: ReadScope | null, folder: string) => runWithReadScope(scope, () => listFolder(s.v.app, folder, s.v.settings));

  it("lists only the rows a restricted token may read, and the folders holding one", () => {
    expect(list(null, "")).toEqual({ folder: "", folders: ["Datanotes", "Diary"], files: [] });
    expect(list(COOK, "")).toEqual({ folder: "", folders: ["Datanotes"], files: [] });
    expect(list(COOK, "Datanotes")).toEqual({ folder: "Datanotes", folders: ["Datanotes/personal"], files: [] });
    expect(list(COOK, "Datanotes/personal")).toEqual({ folder: "Datanotes/personal", folders: ["Datanotes/personal/food"], files: [] });
    expect(list(COOK, "Datanotes/personal/food/pantry")).toEqual({ folder: "Datanotes/personal/food/pantry", folders: [], files: [s.paths.eggs, s.paths.flour] });
    expect(list(COOK, "Datanotes/personal/health/weight")).toEqual({ folder: "Datanotes/personal/health/weight", folders: [], files: [] });
    expect(list(COOK, "Diary")).toEqual({ folder: "Diary", folders: [], files: [] });
    expect(list(NURSE, "Datanotes/personal")).toEqual({ folder: "Datanotes/personal", folders: ["Datanotes/personal/health"], files: [] });
    expect(list({ token: "blind", patterns: [] }, "")).toEqual({ folder: "", folders: [], files: [] });
    for (const folder of ["", "Datanotes", "Datanotes/personal", "Datanotes/personal/health/weight", "Diary"]) expectNoLeak(list(COOK, folder));
  });

  it("lists nothing under a restricted scope when it is not told the settings (fail closed)", () => {
    expect(runWithReadScope(COOK, () => listFolder(s.v.app, ""))).toEqual({ folder: "", folders: [], files: [] });
    expect(listFolder(s.v.app, "")).toEqual({ folder: "", folders: ["Datanotes", "Diary"], files: [] });
  });

  it("never shows a restricted token the diary or a weight file over the API", async () => {
    for (const folder of ["", "Diary", "Datanotes/personal", "Datanotes/personal/health/weight"]) {
      const r = await s.op("cook", "list_folder", { folder });
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.json)).not.toContain("Diary/");
      expect(JSON.stringify(r.json)).not.toContain("health/weight/");
      expectNoLeak(r);
    }
    for (const t of ["legacy", "star"] as const) expect(await s.op(t, "list_folder", { folder: "" })).toEqual(await s.op("owner", "list_folder", { folder: "" }));
  });

  it("shows a restricted token its own folders and rows over the API", async () => {
    expect(await s.op("cook", "list_folder", { folder: "" })).toEqual({ status: 200, json: { folder: "", folders: ["Datanotes"], files: [] } });
    expect(await s.op("cook", "list_folder", { folder: "Datanotes/personal" })).toEqual({ status: 200, json: { folder: "Datanotes/personal", folders: ["Datanotes/personal/food"], files: [] } });
    expect(await s.op("cook", "list_folder", { folder: "Datanotes/personal/food/pantry" })).toEqual({
      status: 200,
      json: { folder: "Datanotes/personal/food/pantry", folders: [], files: [s.paths.eggs, s.paths.flour] },
    });
  });
});

describe("search_notes", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setupReadTokens();
  });
  const search = (scope: ReadScope | null, q: string) => runWithReadScope(scope, () => searchNotes(s.v.app, q, 100, s.v.settings));

  it("finds only the rows a restricted token may read", async () => {
    expect(pathsOf(await search(null, "eggs"))).toEqual([s.paths.eggs, s.paths.pasta, s.paths.diary]);
    const cook = await search(COOK, "eggs");
    expect(pathsOf(cook)).toEqual([s.paths.eggs, s.paths.pasta]);
    expect(cook.total).toBe(2);
    expectNoLeak(cook);
    expect(await search(COOK, "ZZSECRETHEALTH")).toEqual({ query: "ZZSECRETHEALTH", results: [], total: 0 });
    expect(await search(COOK, "ZZSECRETDIARY")).toEqual({ query: "ZZSECRETDIARY", results: [], total: 0 });
    expect(pathsOf(await search(NURSE, "ZZSECRETHEALTH")).sort()).toEqual([...s.paths.weight].sort());
    expect(await search({ token: "blind", patterns: [] }, "eggs")).toEqual({ query: "eggs", results: [], total: 0 });
  });

  it("finds nothing under a restricted scope when it is not told the settings (fail closed)", async () => {
    expect(await runWithReadScope(COOK, () => searchNotes(s.v.app, "eggs"))).toEqual({ query: "eggs", results: [], total: 0 });
  });

  it("never answers a restricted token with the diary or a weight row over the API", async () => {
    for (const query of ["eggs", "ZZSECRETHEALTH", "ZZSECRETDIARY", "weigh"]) {
      const r = await s.op("cook", "search_notes", { query });
      expect(r.status).toBe(200);
      expect(pathsOf(r)).not.toContain(s.paths.diary);
      // the answer repeats the query: what it found must not leak
      expectNoLeak((r.json as { results: unknown }).results);
    }
    for (const t of ["legacy", "star"] as const) expect(await s.op(t, "search_notes", { query: "eggs" })).toEqual(await s.op("owner", "search_notes", { query: "eggs" }));
  });

  it("finds a restricted token exactly its readable rows over the API", async () => {
    const r = await s.op("cook", "search_notes", { query: "eggs" });
    expect(r.status).toBe(200);
    expect(pathsOf(r)).toEqual([s.paths.eggs, s.paths.pasta]);
    expect((r.json as { total: number }).total).toBe(2);
    expectNoLeak(r);
  });

  it("filters before the results are cut to 200", async () => {
    const t = await setupReadTokens();
    for (let i = 0; i < 201; i++) t.v.write(`Free/n${String(i).padStart(3, "0")}.md`, "eggs ".repeat(10));
    const owner = await searchNotes(t.v.app, "eggs", 0, t.v.settings);
    expect(owner.total).toBe(204);
    expect(owner.results).toHaveLength(200);
    expect(pathsOf(owner)).not.toContain(t.paths.eggs);
    const cook = await runWithReadScope(COOK, () => searchNotes(t.v.app, "eggs", 0, t.v.settings));
    expect(pathsOf(cook)).toEqual([t.paths.eggs, t.paths.pasta]);
    expect(cook.total).toBe(2);
  });
});

/** Bag-of-words vectors over the fixture's words. */
const VOCAB = ["eggs", "flour", "pasta", "weigh", "zzsecrethealth", "diary", "morning", "evening"];
const fakeTransport: Transport = async (req: HttpRequest) => {
  const { input } = JSON.parse(req.body) as { input: string[] };
  const data = input.map((text, index) => ({ embedding: VOCAB.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01), index }));
  return { status: 200, text: JSON.stringify({ data }) };
};

describe("semantic_search", () => {
  let s: ReadSetup;
  let sem: SemanticIndex;
  let call: (token: ReadTokenName | "owner", args: Record<string, unknown>) => Promise<HandlerResponse>;
  beforeAll(async () => {
    s = await setupReadTokens();
    Object.assign(s.v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake", semanticScope: "all" });
    sem = new SemanticIndex(s.v.app, () => s.v.settings, fakeTransport);
    await sem.sync();
    const routes: Record<string, Handler> = { ...createHandlers(s.v.app, () => s.v.settings, async () => {}, sem), ...s.registry.handlers() };
    const guarded = s.registry.guard(dispatch);
    call = (token, args) => runWithActor({ auth: token, harness: token }, () => guarded("/operations/semantic_search/", routes["/operations/semantic_search/"]!, args));
  });

  it("answers the owner with every note", async () => {
    const r = await call("owner", { query: "ZZSECRETHEALTH morning weigh", limit: 100 });
    expect(r.status).toBe(200);
    expect(pathsOf(r)).toEqual(expect.arrayContaining([...s.paths.weight, s.paths.eggs, s.paths.diary]));
  });

  it("drops the notes a restricted token may not read, before the limit", async () => {
    // the owner's best hits are the weight rows; the cook still gets its best readable one
    const owner = await call("owner", { query: "ZZSECRETHEALTH morning weigh", limit: 1 });
    expect(pathsOf(owner)).toEqual([s.paths.heavy]);
    const cook = await call("cook", { query: "ZZSECRETHEALTH morning weigh", limit: 1 });
    expect(cook.status).toBe(200);
    expect(pathsOf(cook)).toHaveLength(1);
    expect([s.paths.eggs, s.paths.flour, s.paths.pasta]).toContain(pathsOf(cook)[0]);
    // the answer repeats the query: what it found must not leak
    expectNoLeak((cook.json as { results: unknown }).results);
    const all = await call("cook", { query: "eggs diary ZZSECRETDIARY", limit: 100 });
    expect(pathsOf(all).sort()).toEqual([s.paths.eggs, s.paths.flour, s.paths.pasta].sort());
    expectNoLeak((all.json as { results: unknown }).results);
    const nurse = await call("nurse", { query: "eggs", limit: 100 });
    expect(pathsOf(nurse).sort()).toEqual([...s.paths.weight].sort());
    expect(await call("blind", { query: "eggs", limit: 100 })).toEqual({ status: 200, json: { query: "eggs", results: [] } });
  });

  it("refuses a table named exactly, in full or by a short name, and narrows a pattern", async () => {
    expect(await call("cook", { query: "eggs", tables: ["weight"] })).toEqual(readRefusal("cook", WEIGHT));
    expect(await call("cook", { query: "eggs", tables: [WEIGHT] })).toEqual(readRefusal("cook", WEIGHT));
    expect(await runWithReadScope(COOK, () => sem.search({ query: "eggs", tables: ["health.weight"] })).catch((e: Error) => e.message)).toBe(`token cook may not read ${WEIGHT}`);
    const meals = await call("cook", { query: "pasta", tables: ["meals"], limit: 100 });
    expect(pathsOf(meals)).toEqual([s.paths.pasta]);
    const pattern = await call("cook", { query: "eggs", tables: ["personal.*"], limit: 100 });
    expect(pattern.status).toBe(200);
    expectNoLeak(pattern);
  });

  it("finds nothing for a restricted scope in a vault without tables", async () => {
    const v = createDbVault({ "Notes/eggs.md": "eggs and flour" });
    Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake", semanticScope: "all" });
    const idx = new SemanticIndex(v.app, () => v.settings, fakeTransport);
    await idx.sync();
    expect(pathsOf(await idx.search({ query: "eggs", tables: ["pantry"] }))).toEqual([]);
    expect(pathsOf(await idx.search({ query: "eggs" }))).toEqual(["Notes/eggs.md"]);
    expect(await runWithReadScope(COOK, () => idx.search({ query: "eggs", tables: ["pantry"] }))).toEqual({ query: "eggs", results: [] });
    expect(await runWithReadScope(COOK, () => idx.search({ query: "eggs" }))).toEqual({ query: "eggs", results: [] });
  });

  it("gives a token without read or with read * the owner's answer", async () => {
    for (const t of ["legacy", "star"] as const) expect(await call(t, { query: "ZZSECRETHEALTH diary", limit: 100 })).toEqual(await call("owner", { query: "ZZSECRETHEALTH diary", limit: 100 }));
  });
});

describe("graph", () => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setupReadTokens();
  });
  const paths = (...p: string[]) => ({ paths: p });

  it("hides the neighbours a restricted token may not read, and their counts", async () => {
    const owner = await s.op("owner", "graph_neighbors", { from_nodes: paths(s.paths.eggs) });
    expect(owner.json).toEqual({
      nodes: [
        {
          path: s.paths.eggs,
          table: PANTRY,
          counts: { "out:for_weight": 1, "in:ingredients": 1 },
          edges: [
            { path: s.paths.heavy, table: WEIGHT, label: "for_weight", direction: "out" },
            { path: s.paths.pasta, table: MEALS, label: "ingredients", direction: "in" },
          ],
        },
      ],
    });
    const cook = await s.op("cook", "graph_neighbors", { from_nodes: paths(s.paths.eggs) });
    expect(cook).toEqual({
      status: 200,
      json: { nodes: [{ path: s.paths.eggs, table: PANTRY, counts: { "in:ingredients": 1 }, edges: [{ path: s.paths.pasta, table: MEALS, label: "ingredients", direction: "in" }] }] },
    });
    const nurse = await s.op("nurse", "graph_neighbors", { from_nodes: paths(s.paths.heavy) });
    expect(nurse).toEqual({ status: 200, json: { nodes: [{ path: s.paths.heavy, table: WEIGHT, counts: {}, edges: [] }] } });
    const tables = await s.op("cook", "graph_neighbors", { from_nodes: { tables: ["*"] } });
    expect((tables.json as { nodes: { path: string }[] }).nodes.map((n) => n.path)).toEqual([s.paths.eggs, s.paths.flour, s.paths.pasta].sort());
    expectNoLeak(tables);
  });

  it("refuses a start note, table or table name a restricted token may not read", async () => {
    expect(await s.op("cook", "graph_neighbors", { from_nodes: paths(s.paths.heavy) })).toEqual(noteRefusal("cook", s.paths.heavy));
    expect(await s.op("cook", "graph_neighbors", { from_nodes: paths(s.paths.heavy.replace(/\.md$/, "")) })).toEqual(noteRefusal("cook", s.paths.heavy));
    expect(await s.op("cook", "graph_neighbors", { from_nodes: paths(s.paths.diary) })).toEqual(noteRefusal("cook", s.paths.diary));
    expect(await s.op("cook", "graph_neighbors", { from_nodes: { table: "weight" } })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "graph_neighbors", { from_nodes: { tables: ["weight"] } })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "graph_neighbors", { from_nodes: { tables: [WEIGHT, PANTRY] } })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "graph_traverse", { from_nodes: paths(s.paths.eggs), tables: ["weight"] })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "graph_traverse", { from_nodes: paths(s.paths.eggs), through: [WEIGHT] })).toEqual(readRefusal("cook", WEIGHT));
    expect(await s.op("cook", "graph_path", { from_nodes: paths(s.paths.eggs), to_nodes: paths(s.paths.heavy) })).toEqual(noteRefusal("cook", s.paths.heavy));
  });

  it("does not suggest a table a restricted token may not read", async () => {
    const r = await s.op("cook", "graph_traverse", { from_nodes: paths(s.paths.eggs), tables: ["weigth"] });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toBe(`tables: unknown table "weigth"`);
    expect(JSON.stringify(r.json)).not.toContain("weight");
    expect(JSON.stringify((await s.op("owner", "graph_traverse", { from_nodes: paths(s.paths.eggs), tables: ["weigth"] })).json)).toContain("weight");
  });

  it("never walks through a note a restricted token may not read", async () => {
    const out = { from_nodes: paths(s.paths.eggs), to_nodes: paths(s.paths.pasta), direction: "out" };
    expect((await s.op("owner", "graph_path", out)).json).toMatchObject({ found: true, length: 2, from: s.paths.eggs, to: s.paths.pasta });
    expect(await s.op("cook", "graph_path", out)).toEqual({ status: 200, json: { found: false, length: null, via: [] } });
    const both = await s.op("cook", "graph_path", { from_nodes: paths(s.paths.eggs), to_nodes: paths(s.paths.pasta) });
    expect(both).toEqual({
      status: 200,
      json: { found: true, length: 1, via: [{ from: s.paths.eggs, label: "ingredients", direction: "in", to: s.paths.pasta }], from: s.paths.eggs, to: s.paths.pasta },
    });
  });

  it("traverses only notes a restricted token may read", async () => {
    const args = { from_nodes: paths(s.paths.eggs), direction: "out", max_depth: 3 };
    const owner = (await s.op("owner", "graph_traverse", args)).json as { nodes: { path: string }[] };
    expect(owner.nodes.map((n) => n.path)).toEqual([s.paths.heavy, s.paths.pasta, s.paths.flour]);
    expect(await s.op("cook", "graph_traverse", args)).toEqual({ status: 200, json: { start: [s.paths.eggs], nodes: [], truncated: false } });
    const all = await s.op("cook", "graph_traverse", { from_nodes: { tables: ["*"] }, direction: "both", min_depth: 0 });
    expect((all.json as { start: string[] }).start).toEqual([s.paths.eggs, s.paths.flour, s.paths.pasta].sort());
    expect((all.json as { nodes: { path: string }[] }).nodes.map((n) => n.path).sort()).toEqual([s.paths.eggs, s.paths.flour, s.paths.pasta].sort());
    expectNoLeak(all);
    const nurse = await s.op("nurse", "graph_traverse", { from_nodes: { tables: ["*"] }, direction: "both" });
    expect(nurse).toEqual({ status: 200, json: { start: [...s.paths.weight].sort(), nodes: [], truncated: false } });
  });

  it("keeps the shared graph whole when a restricted request builds it", async () => {
    const t = await setupReadTokens();
    // the first graph call of this vault is a restricted token's: the graph it builds is everyone's
    await t.op("cook", "graph_neighbors", { from_nodes: paths(t.paths.eggs) });
    const g = await graphIndex(t.v.app, t.v.settings);
    expect(g.out.get(t.paths.eggs)).toEqual([{ to: t.paths.heavy, label: "for_weight" }]);
    expect(g.tableOf.get(t.paths.heavy)).toBe(WEIGHT);
    expect((await t.op("owner", "graph_neighbors", { from_nodes: paths(t.paths.eggs) })).json).toMatchObject({ nodes: [{ counts: { "out:for_weight": 1, "in:ingredients": 1 } }] });
  });

  it("gives a token without read or with read * the owner's answers", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["graph_neighbors", { from_nodes: { tables: ["*"] } }],
      ["graph_traverse", { from_nodes: paths(s.paths.eggs), direction: "out", max_depth: 3 }],
      ["graph_path", { from_nodes: paths(s.paths.eggs), to_nodes: paths(s.paths.heavy) }],
    ];
    for (const t of ["legacy", "star"] as const) for (const [op, args] of calls) expect(await s.op(t, op, args)).toEqual(await s.op("owner", op, args));
  });
});
