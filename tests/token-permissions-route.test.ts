/**
 * The permission matrix (`POST /datanotes/tokens/permissions/`, src/server/tokens.ts): every table
 * and view, and what each named token may read and write in it, as the engine applies it. Its
 * answer must agree with what the engine lists to each token.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createDbVault, METASTORE } from "./helpers/db-vault";
import { guided } from "./helpers/guidance";
import { MEALS, PANTRY, READ_TOKEN_NAMES, setupReadTokens, VW_HEAVY, VW_MIXED, WEIGHT, type ReadSetup } from "./helpers/read-tokens";
import { TokenRegistry, type PermissionAccess, type TokenPermissions } from "../src/server/tokens";
import { DOCS, DOCS_BASE } from "../src/core/hints";

interface Matrix {
  objects: { name: string; kind: string; reads?: string[]; reads_complete?: boolean }[];
  tokens: TokenPermissions[];
}

let s: ReadSetup;
let matrix: Matrix;

const tokenOf = (name: string): TokenPermissions => matrix.tokens.find((t) => t.name === name)!;
const accessOf = (token: string, object: string): PermissionAccess => tokenOf(token).access.find((a) => a.object === object)!;

beforeAll(async () => {
  s = await setupReadTokens();
  const r = await s.owner("/tokens/permissions/", {});
  expect(r.status).toBe(200);
  matrix = r.json as Matrix;
});

describe("tokens/permissions/", () => {
  it("lists the tables, sorted, then the views, sorted, with the tables each view reads", () => {
    expect(matrix.objects.map((o) => [o.name, o.kind])).toEqual([
      [MEALS, "table"],
      [PANTRY, "table"],
      [WEIGHT, "table"],
      [VW_MIXED, "view"],
      [VW_HEAVY, "view"],
    ]);
    expect(matrix.objects.find((o) => o.name === VW_HEAVY)).toEqual({ name: VW_HEAVY, kind: "view", reads: [WEIGHT], reads_complete: true });
    expect(matrix.objects.find((o) => o.name === MEALS)).toEqual({ name: MEALS, kind: "table" });
    expect(matrix.tokens.map((t) => t.name)).toEqual(READ_TOKEN_NAMES);
  });

  it("gives cook's reads and writes with the patterns that grant them, and why a view is hidden", () => {
    expect(tokenOf("cook")).toMatchObject({ name: "cook", read: ["personal.food.*"], write: [PANTRY], ddl: false, maintain: false });
    expect(accessOf("cook", PANTRY)).toEqual({ object: PANTRY, read: true, write: true, read_pattern: "personal.food.*", write_pattern: PANTRY });
    expect(accessOf("cook", MEALS)).toEqual({ object: MEALS, read: true, write: false, read_pattern: "personal.food.*" });
    expect(accessOf("cook", WEIGHT)).toEqual({ object: WEIGHT, read: false, write: false });
    expect(accessOf("cook", VW_HEAVY)).toEqual({ object: VW_HEAVY, read: false, write: false, reason: "its name matches no read pattern of cook" });
    expect(accessOf("cook", VW_MIXED)).toEqual({ object: VW_MIXED, read: false, write: false, reason: "it reads personal.health.weight, which cook may not read" });
  });

  it("gives nurse the health view only, and legacy and star everything through *", () => {
    expect(accessOf("nurse", VW_HEAVY)).toEqual({ object: VW_HEAVY, read: true, write: false, read_pattern: "personal.health.*" });
    expect(accessOf("nurse", VW_MIXED)).toEqual({ object: VW_MIXED, read: false, write: false, reason: "its name matches no read pattern of nurse" });
    for (const name of ["legacy", "star"]) {
      for (const a of tokenOf(name).access) expect(a).toMatchObject({ read: true, read_pattern: "*" });
    }
    expect(accessOf("legacy", MEALS)).toMatchObject({ write: true, write_pattern: "personal.food.*" });
    expect(tokenOf("blind").access.every((a) => !a.read && !a.write)).toBe(true);
  });

  it("agrees with what list_tables lists to each token", async () => {
    for (const name of READ_TOKEN_NAMES) {
      const r = await s.op(name, "list_tables");
      expect(r.status).toBe(200);
      const json = r.json as { tables: { qualified: string }[]; views: ({ qualified: string } | string)[] };
      const listed = [...json.tables.map((t) => t.qualified), ...json.views.map((v) => (typeof v === "string" ? v : v.qualified))].sort();
      const readable = tokenOf(name)
        .access.filter((a) => a.read)
        .map((a) => a.object)
        .sort();
      expect(readable, name).toEqual(listed);
    }
  });

  it("answers for one token, and refuses an unknown name and a named token", async () => {
    const one = await s.owner("/tokens/permissions/", { name: "cook" });
    expect(one.status).toBe(200);
    expect((one.json as Matrix).tokens.map((t) => t.name)).toEqual(["cook"]);
    expect((one.json as Matrix).objects).toEqual(matrix.objects);

    const unknown = await s.owner("/tokens/permissions/", { name: "nobody" });
    expect(unknown).toEqual({ status: 400, json: guided("no token nobody") });
    expect((unknown.json as { docs: string }).docs).toBe(`${DOCS_BASE}${DOCS.tokenPermissions}`);
    expect((unknown.json as { hint: string }).hint).toBe(`tokens/ lists the named tokens; leave "name" out for all of them.`);

    expect(await s.as("cook", "/tokens/permissions/", {})).toEqual({ status: 403, json: guided("token cook may not call /tokens/permissions/ (reserved to the owner)") });
    expect(await s.owner("/tokens/permissions/", { name: 5 })).toEqual({ status: 400, json: expect.objectContaining({ error: `"name" must be a string` }) });
  });

  it("says when the tables a view reads are known only when it runs", async () => {
    const view = "personal.food.vw_noted";
    const c = await s.owner("/operations/create_view/", { name: view, description: "Every row with a note", query: { table: "base:noted" } });
    expect(c.status).toBe(200);
    const r = (await s.owner("/tokens/permissions/", { name: "cook" })).json as Matrix;
    expect(r.objects.find((o) => o.name === view)).toMatchObject({ kind: "view", reads_complete: false });
    expect(r.tokens[0]!.access.find((a) => a.object === view)).toEqual({
      object: view,
      read: false,
      write: false,
      reason: "the tables it reads are known only when it runs: listings hide it from cook",
    });
  });
});

describe("tokens/permissions/ without a metastore", () => {
  const registryOf = (files: Record<string, string>) => {
    const v = createDbVault(files);
    return new TokenRegistry({ app: v.app, getSettings: () => v.settings });
  };

  it("lists no objects, and each token with no access, when there is no metastore", async () => {
    const reg = registryOf({});
    await reg.create({ name: "cook", read: ["personal.food.*"] });
    expect(await reg.permissions()).toEqual({ objects: [], tokens: [{ name: "cook", read: ["personal.food.*"], write: [], ddl: false, maintain: false, access: [] }] });
  });

  it("does the same when the metastore cannot be read", async () => {
    const reg = registryOf({ [METASTORE]: "catalogs: [unclosed" });
    await reg.create({ name: "agent", maintain: true });
    expect(await reg.permissions("agent")).toEqual({ objects: [], tokens: [{ name: "agent", read: ["*"], write: [], ddl: false, maintain: true, access: [] }] });
  });
});
