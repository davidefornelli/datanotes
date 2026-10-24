/**
 * Read permissions of named tokens: the counts a restricted token reads cover only the notes it may
 * read (src/core/read-scope.ts). `file_backlink_count` (src/core/where.ts) counts the links from
 * readable notes, in `columns`, `where` and `order_by`, on either host; `describe_semantic_index`
 * (src/core/semantic.ts) counts the readable notes' files, passages and pending notes; the read
 * cache (src/server/read-cache.ts) never serves one caller's count to another, nor a count made
 * before a linking note joined a readable table.
 *
 * In the fixture (tests/helpers/read-tokens.ts) the meal `Pasta` is linked from the weight row
 * `Morning weigh-in` (`after_meal`): the owner counts that backlink, `cook` (reads
 * `personal.food.*`) does not.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithActor } from "../src/core/actor";
import type { HttpRequest, Transport } from "../src/core/embeddings";
import { SemanticIndex, type SemanticStatus } from "../src/core/semantic";
import { parseMetastore } from "../src/core/metastore";
import { readDeps } from "../src/server/read-cache";
import { createHandlers, dispatch, type Handler, type HandlerResponse } from "../src/server/rest";
import { MEALS, PANTRY, READ_YAML, rowsOf, WEIGHT, setupReadTokens, startReadEngine, type ReadEngine, type ReadSetup, type ReadTokenName } from "./helpers/read-tokens";

const VOCAB = ["eggs", "flour", "pasta", "weigh", "zzsecrethealth", "diary", "morning", "evening"];
const fakeTransport: Transport = async (req: HttpRequest) => {
  const { input } = JSON.parse(req.body) as { input: string[] };
  const data = input.map((text, index) => ({ embedding: VOCAB.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01), index }));
  return { status: 200, text: JSON.stringify({ data }) };
};

/** The rows of a select_rows answer without their `path`. */
const rows = (r: HandlerResponse | { json: Record<string, unknown> }) => rowsOf(r as HandlerResponse).map(({ path: _path, ...rest }) => rest);

const COUNTS = { table: "meals", columns: ["dish", "file_backlink_count"], order_by: "dish" };

describe.each(["fake", "node"] as const)("file_backlink_count on the %s host", (host) => {
  let s: ReadSetup;
  beforeAll(async () => {
    s = await setupReadTokens({ host });
    // a meal no note links to: the order by the count tells the callers apart
    const r = await s.op("owner", "insert_row", { table: MEALS, values: { dish: "Soup" } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it("counts the weight row's link for the owner, not for cook, in columns", async () => {
    expect(rows(await s.op("owner", "select_rows", COUNTS))).toEqual([
      { dish: "Pasta", file_backlink_count: 1 },
      { dish: "Soup", file_backlink_count: 0 },
    ]);
    expect(rows(await s.op("cook", "select_rows", COUNTS))).toEqual([
      { dish: "Pasta", file_backlink_count: 0 },
      { dish: "Soup", file_backlink_count: 0 },
    ]);
    // the meal's own links into the pantry are readable: the pantry rows count them for both
    const pantry = { table: "pantry", columns: ["item", "file_backlink_count"], order_by: "item" };
    const both = [
      { item: "eggs", file_backlink_count: 1 },
      { item: "flour", file_backlink_count: 1 },
    ];
    expect(rows(await s.op("owner", "select_rows", pantry))).toEqual(both);
    expect(rows(await s.op("cook", "select_rows", pantry))).toEqual(both);
  });

  it("filters by the readable backlinks only, in where", async () => {
    const linked = { ...COUNTS, where: { file_backlink_count: { gte: 1 } } };
    expect(rows(await s.op("owner", "select_rows", linked))).toEqual([{ dish: "Pasta", file_backlink_count: 1 }]);
    expect(await s.op("cook", "select_rows", linked)).toMatchObject({ status: 200, json: { rows: [] } });
  });

  it("sorts by the readable backlinks only, in order_by", async () => {
    const sorted = { table: "meals", columns: ["dish"], order_by: ["-file_backlink_count", "-dish"] };
    expect(rows(await s.op("owner", "select_rows", sorted))).toEqual([{ dish: "Pasta" }, { dish: "Soup" }]);
    // every count is 0 for cook: the dish alone sorts
    expect(rows(await s.op("cook", "select_rows", sorted))).toEqual([{ dish: "Soup" }, { dish: "Pasta" }]);
  });

  it("gives a token without read or with read * the owner's counts", async () => {
    const owner = await s.op("owner", "select_rows", COUNTS);
    for (const t of ["legacy", "star"] as const) expect(await s.op(t, "select_rows", COUNTS)).toEqual(owner);
    expect(await s.op("nurse", "select_rows", COUNTS)).toMatchObject({ status: 403 });
  });
});

describe("describe_semantic_index", () => {
  let s: ReadSetup;
  let sem: SemanticIndex;
  let call: (token: ReadTokenName | "owner") => Promise<HandlerResponse>;
  const statusOf = async (token: ReadTokenName | "owner"): Promise<SemanticStatus> => {
    const r = await call(token);
    expect(r.status).toBe(200);
    return r.json as SemanticStatus;
  };
  beforeAll(async () => {
    s = await setupReadTokens();
    Object.assign(s.v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake", semanticScope: "all" });
    sem = new SemanticIndex(s.v.app, () => s.v.settings, fakeTransport);
    await sem.sync();
    const routes: Record<string, Handler> = { ...createHandlers(s.v.app, () => s.v.settings, async () => {}, sem), ...s.registry.handlers() };
    const guarded = s.registry.guard(dispatch);
    const route = "/operations/describe_semantic_index/";
    call = (token) => runWithActor({ auth: token, harness: token }, () => guarded(route, routes[route]!, {}));
  });

  it("counts every note for the owner, only the readable ones for a restricted token", async () => {
    const owner = await statusOf("owner");
    const cook = await statusOf("cook");
    const nurse = await statusOf("nurse");
    // the owner: 3 food rows, 2 weight rows and the diary
    expect(owner).toMatchObject({ enabled: true, files: 6, pending: 0 });
    expect(cook).toMatchObject({ enabled: true, provider: "custom", model: "fake", files: 3, pending: 0, running: false });
    expect(nurse).toMatchObject({ files: 2, pending: 0 });
    expect(cook.passages).toBeGreaterThan(0);
    expect(nurse.passages).toBeGreaterThan(0);
    // the diary's passages are the owner's only
    expect(owner.passages - cook.passages - nurse.passages).toBeGreaterThan(0);
    expect(await statusOf("blind")).toMatchObject({ files: 0, passages: 0, pending: 0 });
    // every field keeps its type
    expect(Object.keys(cook).sort()).toEqual(Object.keys(owner).sort());
  });

  it("counts the pending notes a restricted token may read", async () => {
    for (const p of [s.paths.eggs, s.paths.heavy, s.paths.diary, "Gone/note.md"]) sem.touch(p);
    expect(await statusOf("owner")).toMatchObject({ pending: 4 });
    expect(await statusOf("cook")).toMatchObject({ pending: 1 });
    expect(await statusOf("nurse")).toMatchObject({ pending: 1 });
    expect(await statusOf("blind")).toMatchObject({ pending: 0 });
    for (const t of ["legacy", "star"] as const) expect(await call(t)).toEqual(await call("owner"));
  });
});

describe("the read cache and file_backlink_count", () => {
  let e: ReadEngine;
  /** A free note that links to Pasta, written before the first read (the cache reads its links once). */
  let note: string;
  beforeAll(async () => {
    e = await startReadEngine();
    note = path.join(e.root, "Notes/link.md");
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "See [[Pasta]].\n");
  }, 60_000);
  afterAll(async () => {
    await e?.dispose();
  });
  const counts = async (token: ReadTokenName | "owner") => {
    const r = await e.op(token, "select_rows", COUNTS);
    expect(r.status, r.text).toBe(200);
    return rows(r);
  };

  it("keeps the owner's and a restricted token's counts apart", async () => {
    const before = e.runtime.readCache!.stats();
    expect(await counts("owner")).toEqual([{ dish: "Pasta", file_backlink_count: 2 }]);
    expect(await counts("cook")).toEqual([{ dish: "Pasta", file_backlink_count: 0 }]);
    // asked again: each from its own answer
    expect(await counts("owner")).toEqual([{ dish: "Pasta", file_backlink_count: 2 }]);
    expect(await counts("cook")).toEqual([{ dish: "Pasta", file_backlink_count: 0 }]);
    expect(e.runtime.readCache!.stats()).toMatchObject({ hits: before.hits + 2, misses: before.misses + 2 });
  });

  it("counts a linking note again once it becomes a row of a readable table", async () => {
    expect(await counts("owner")).toEqual([{ dish: "Pasta", file_backlink_count: 2 }]);
    // a free note: never readable
    expect(await counts("cook")).toEqual([{ dish: "Pasta", file_backlink_count: 0 }]);
    // asked again: the answer kept serves
    const { hits } = e.runtime.readCache!.stats();
    expect(await counts("cook")).toEqual([{ dish: "Pasta", file_backlink_count: 0 }]);
    expect(e.runtime.readCache!.stats().hits).toBe(hits + 1);
    // the same links, now in a pantry row: only the pantry's rows changed
    fs.writeFileSync(note, "---\ntable: personal.food.pantry\nitem: basil\n---\nSee [[Pasta]].\n");
    expect(await counts("cook")).toEqual([{ dish: "Pasta", file_backlink_count: 1 }]);
    expect(await counts("owner")).toEqual([{ dish: "Pasta", file_backlink_count: 2 }]);
  });
});

describe("readDeps of a select_rows that counts backlinks", () => {
  it("reads its own tables without a scope, every table under one", () => {
    const model = parseMetastore(READ_YAML);
    expect(readDeps("select_rows", COUNTS, model)).toEqual({ tables: [MEALS], today: false, links: true });
    expect(readDeps("select_rows", COUNTS, model, true)).toEqual({ tables: [MEALS, PANTRY, WEIGHT], today: false, links: true });
    // without backlinks a scope changes nothing
    expect(readDeps("select_rows", { table: "meals" }, model, true)).toEqual({ tables: [MEALS], today: false });
  });
});
