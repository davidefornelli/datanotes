/**
 * The database browser's token patterns and token form draft (src/ui/lib/patterns.ts), and their
 * parity with the engine's rules (src/core/read-scope.ts, src/server/tokens.ts).
 */

import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { matchesTablePattern } from "../src/core/read-scope";
import { readCovers as engineReadCovers, TokenRegistry } from "../src/server/tokens";
import {
  PATTERN_RE,
  TOKEN_NAME_RE,
  draftFrom,
  draftProblems,
  draftToCreate,
  draftToUpdate,
  matchesPattern,
  patternSuggestions,
  readCovers,
  type TokenDraft,
} from "../src/ui/lib/patterns";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";

const YAML = `catalogs:
  work:
    schemas:
      planning:
        tables:
          task:
            description: Tasks.
            columns:
              - { name: title, type: string, description: The title. }
`;

const vaults: DbVault[] = [];
afterAll(() => {
  for (const v of vaults) {
    fs.rmSync(v.root, { recursive: true, force: true });
    fs.rmSync(v.storeRoot, { recursive: true, force: true });
  }
});

function draft(over: Partial<TokenDraft>): TokenDraft {
  return { ...draftFrom(null), name: "agent", ...over };
}

describe("patterns", () => {
  const tables = ["work.planning.task", "work.planning.person", "work.other.x", "personal.food.pantry", "personal.food-2.meals", "a.b.c"];
  const patterns: string[][] = [
    [],
    ["*"],
    ["work.*"],
    ["work.planning.*"],
    ["work.planning.task"],
    ["work.plan.*"],
    ["personal.food.*"],
    ["personal.*", "work.planning.task"],
    ["a.*"],
    ["a.b.c.*"],
    ["work"],
    ["work.planning"],
    ["personal.food-2.*"],
  ];

  it("matches tables as the engine does", () => {
    let cases = 0;
    for (const t of tables) {
      for (const p of patterns) {
        expect(matchesPattern(t, p), `${t} ~ ${JSON.stringify(p)}`).toBe(matchesTablePattern(t, p));
        cases++;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(30);
    expect(matchesPattern("work.planning.task", ["work.*"])).toBe(true);
    expect(matchesPattern("work.planning.task", ["work.plan.*"])).toBe(false);
    expect(matchesPattern("work.planning.task", [])).toBe(false);
  });

  it("covers writes with reads as the engine does", () => {
    const reads = ["*", "work.*", "work.planning.*", "work.planning.task", "work.plan.*", "personal.*", "work.planning.person"];
    const writes = ["*", "work.*", "work.planning.*", "work.planning.task", "work.planning.taskx", "personal.food.pantry", "work.planning.person"];
    let cases = 0;
    for (const r of reads) {
      for (const w of writes) {
        expect(readCovers(r, w), `${r} covers ${w}`).toBe(engineReadCovers(r, w));
        cases++;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(30);
    expect(readCovers("work.*", "*")).toBe(false);
    expect(readCovers("*", "*")).toBe(true);
  });

  it("checks names and patterns", () => {
    expect(TOKEN_NAME_RE.test("browser-test")).toBe(true);
    expect(TOKEN_NAME_RE.test("Browser")).toBe(false);
    expect(TOKEN_NAME_RE.test("-x")).toBe(false);
    expect(PATTERN_RE.test("a.b.c")).toBe(true);
    expect(PATTERN_RE.test("a.b.*")).toBe(true);
    expect(PATTERN_RE.test("a.b.c.d")).toBe(false);
    expect(PATTERN_RE.test("a.*.c")).toBe(false);
  });

  it("suggests patterns for the tables", () => {
    expect(patternSuggestions([])).toEqual(["*"]);
    expect(patternSuggestions(["work.planning.task", "work.planning.person", "personal.food.pantry", "solo", "two.parts"])).toEqual([
      "*",
      "personal.*",
      "personal.food.*",
      "personal.food.pantry",
      "solo",
      "two.*",
      "two.parts",
      "work.*",
      "work.planning.*",
      "work.planning.person",
      "work.planning.task",
    ]);
  });
});

describe("token draft", () => {
  it("starts a new token reading every table", () => {
    expect(draftFrom(null)).toEqual({ name: "", description: "", readAll: true, read: [], write: [], ddl: false, maintain: false, autolink: "default" });
  });

  it("reads an entry of /tokens/", () => {
    expect(
      draftFrom({ name: "cook", description: "Kitchen", read: ["personal.food.*"], write: ["personal.food.pantry", 3], ddl: true, maintain: true, autolink: false }),
    ).toEqual({ name: "cook", description: "Kitchen", readAll: false, read: ["personal.food.*"], write: ["personal.food.pantry"], ddl: true, maintain: true, autolink: "off" });
    expect(draftFrom({ name: "star", read: ["*"], write: ["*"], ddl: false, autolink: true })).toMatchObject({ readAll: true, read: [], autolink: "on", maintain: false });
    expect(draftFrom({ name: 5, read: "bad", write: null })).toEqual(draftFrom(null));
  });

  it("names its problems", () => {
    expect(draftProblems(draft({ name: "Bad Name" }), true)).toEqual(["the name must be kebab-case: a-z, 0-9 and -"]);
    expect(draftProblems(draft({ name: "owner" }), true)).toEqual([`"owner" is reserved`]);
    expect(draftProblems(draft({ name: "Bad Name" }), false)).toEqual([]);
    expect(draftProblems(draft({ readAll: false, read: ["a.*.b"], write: ["x y"] }), true)).toEqual([
      `read pattern "a.*.b" must be a table name, catalog.schema.*, catalog.* or *`,
      `write pattern "x y" must be a table name, catalog.schema.*, catalog.* or *`,
      "writes x y but may not read it",
    ]);
    expect(draftProblems(draft({ readAll: false, read: ["work.*"], ddl: true }), true)).toEqual(["ddl and maintain need read on every table"]);
    expect(draftProblems(draft({ readAll: false, read: ["work.*"], maintain: true }), true)).toEqual(["ddl and maintain need read on every table"]);
    expect(draftProblems(draft({ readAll: false, read: ["work.planning.*"], write: ["work.planning.task", "personal.food.pantry"] }), true)).toEqual([
      "writes personal.food.pantry but may not read it",
    ]);
    expect(draftProblems(draft({ readAll: false, read: ["*"], write: ["*"], ddl: true }), true)).toEqual([]);
    // a read list is ignored while "Every table" is chosen
    expect(draftProblems(draft({ readAll: true, read: ["bad pattern"], write: ["*"], ddl: true }), true)).toEqual([]);
  });

  it("builds the body of /tokens/create/", () => {
    expect(draftToCreate(draft({}))).toEqual({ name: "agent", write: [], ddl: false, maintain: false });
    expect(draftToCreate(draft({ description: "  An agent ", readAll: false, read: ["work.*"], write: ["work.planning.task"], autolink: "off" }))).toEqual({
      name: "agent",
      description: "An agent",
      read: ["work.*"],
      write: ["work.planning.task"],
      ddl: false,
      maintain: false,
      autolink: false,
    });
    expect(draftToCreate(draft({ autolink: "on" })).autolink).toBe(true);
  });

  it("sends only what changed to /tokens/update/", () => {
    const before = { name: "cook", description: "Kitchen", read: ["personal.food.*"], write: ["personal.food.pantry"], ddl: false, autolink: true };
    const same = draftFrom(before);
    expect(draftToUpdate(before, same)).toEqual({});
    expect(draftToUpdate(before, { ...same, readAll: true })).toEqual({ read: null });
    expect(draftToUpdate(before, { ...same, read: ["personal.*"] })).toEqual({ read: ["personal.*"] });
    expect(draftToUpdate(before, { ...same, read: ["personal.food.*", "work.*"] })).toEqual({ read: ["personal.food.*", "work.*"] });
    expect(draftToUpdate(before, { ...same, write: [] })).toEqual({ write: [] });
    expect(draftToUpdate(before, { ...same, autolink: "default" })).toEqual({ autolink: null });
    expect(draftToUpdate(before, { ...same, autolink: "off" })).toEqual({ autolink: false });
    expect(draftToUpdate(before, { ...same, description: "" })).toEqual({ description: "" });
    expect(draftToUpdate(before, { ...same, description: " Kitchen " })).toEqual({});
    const all = { name: "all", read: ["*"], write: ["*"], ddl: true, maintain: true };
    expect(draftToUpdate(all, { ...draftFrom(all), readAll: false, read: ["work.*"], ddl: false, maintain: false })).toEqual({
      read: ["work.*"],
      ddl: false,
      maintain: false,
    });
    expect(draftToUpdate(all, { ...draftFrom(all), autolink: "on" })).toEqual({ autolink: true });
  });

  it("finds a problem exactly when the engine refuses the token", async () => {
    const v = createDbVault({ [METASTORE]: YAML });
    vaults.push(v);
    const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
    const drafts: TokenDraft[] = [
      draft({ name: "plain" }),
      draft({ name: "reader-1", readAll: false, read: ["work.planning.*"], write: ["work.planning.task"] }),
      draft({ name: "star", readAll: false, read: ["*"], write: ["*"], ddl: true, maintain: true }),
      draft({ name: "everything", write: ["*"], ddl: true, maintain: true, autolink: "off" }),
      draft({ name: "Bad_Name" }),
      draft({ name: "" }),
      draft({ name: "-lead" }),
      draft({ name: "owner" }),
      draft({ name: "bad-read", readAll: false, read: ["a.*.b"] }),
      draft({ name: "bad-write", write: ["a b"] }),
      draft({ name: "deep", write: ["a.b.c.d"] }),
      draft({ name: "ddl-limited", readAll: false, read: ["work.*"], ddl: true }),
      draft({ name: "maintain-limited", readAll: false, read: ["work.*"], maintain: true }),
      draft({ name: "uncovered", readAll: false, read: ["work.planning.person"], write: ["work.planning.task"] }),
      draft({ name: "star-write", readAll: false, read: ["work.*"], write: ["*"] }),
      draft({ name: "covered-wide", readAll: false, read: ["work.*"], write: ["work.planning.*"] }),
      draft({ name: "nothing", readAll: false, read: [], write: [] }),
      draft({ name: "nothing-writes", readAll: false, read: [], write: ["work.planning.task"] }),
      draft({ name: "star-in-list", readAll: false, read: ["work.*", "*"], write: ["personal.x"], ddl: true }),
    ];
    let acceptedCount = 0;
    for (const d of drafts) {
      const body = draftToCreate(d) as Parameters<TokenRegistry["create"]>[0];
      const accepted = await registry.create(body).then(
        () => true,
        () => false,
      );
      expect(draftProblems(d, true).length === 0, `${d.name}: ${draftProblems(d, true).join("; ")}`).toBe(accepted);
      if (accepted) acceptedCount++;
    }
    // both sides of the rule are exercised: 7 valid drafts, the others refused
    expect(acceptedCount).toBe(7);
    expect(drafts.length).toBeGreaterThanOrEqual(15);
    await registry.stop();
  });
});
