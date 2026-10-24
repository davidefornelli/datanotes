/**
 * Read permissions of named tokens, lane E: the answers of writes (src/server/rest.ts
 * `redactWriteAnswer`, src/core/changeset-checks.ts, row-ops.ts, autolink.ts, move-rows.ts).
 *
 * A restricted token writes as any other (D10: link targets, CHECKs and uniqueness are checked
 * against every table), but its answer loses what it would tell about the tables it may not read:
 * the inverse-link and set_null edits of their rows, the links to their notes, the rows of theirs
 * a linked CHECK or a delete's `restrict` names. Tokens that read everything get the answer whole.
 */

import { describe, expect, it } from "vitest";
import { runWithReadScope, type ReadScope } from "../src/core/read-scope";
import { adoptRows, deleteRows, insertRow, mergeRows, updateRows } from "../src/core/rows";
import type { OpResult } from "../src/core/engine";
import { redactWriteAnswer, type HandlerResponse } from "../src/server/rest";
import { expectNoLeak, MEALS, PANTRY, rowsOf, setupReadTokens, WEIGHT, type ReadSetup } from "./helpers/read-tokens";

const COOK: ReadScope = { token: "cook", patterns: ["personal.food.*"] };
const MILK = "Datanotes/personal/food/pantry/milk.md";
const SALT = "Datanotes/personal/food/pantry/salt.md";

type Answer = Record<string, unknown> & { planned_edits: { path: string }[]; conflicts: { path: string; message: string }[]; violations: { path: string; violations: Record<string, unknown>[] }[] };
const json = (r: HandlerResponse) => r.json as Answer;

/** A write in the engine, in cook's read scope (no write scope: the guard's refusal left out), its answer as cook gets it. */
async function asCook(s: ReadSetup, write: () => Promise<OpResult>): Promise<Answer> {
  return runWithReadScope(COOK, async () => redactWriteAnswer(await write(), s.v.app, s.v.settings) as unknown as Answer);
}

/** Must have worked. */
async function owner(s: ReadSetup, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await s.op("owner", op, args);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as Record<string, unknown>;
}

/** The answer without what differs from one run to the next. */
function stable(r: HandlerResponse): Record<string, unknown> {
  const { migration_id: _m, ...rest } = r.json as Record<string, unknown>;
  return rest;
}

/**
 * No path of a health row, no health value, no diary: the answer of a write by cook. (A link the
 * caller wrote, `[[Morning weigh-in]]`, is its own value: D9.)
 */
function expectNothingOfHealth(r: HandlerResponse): void {
  expectNoLeak(r.json);
  expect(JSON.stringify(r.json)).not.toContain("personal/health");
  expect(JSON.stringify(r.json)).not.toContain("81.5");
}

/** An inverse pair between pantry (`weighed`) and weight (`bought`): a pantry write edits a weight row. */
async function withInverse(s: ReadSetup): Promise<void> {
  await owner(s, "add_column", { table: WEIGHT, column: { name: "bought", type: "list", items: "link", ref: PANTRY, description: "What was bought for this weigh-in" } });
  await owner(s, "add_column", { table: PANTRY, column: { name: "weighed", type: "link", ref: WEIGHT, inverse: "bought", description: "The weigh-in it was bought for" } });
}

/** A weight link into the pantry (`staple`), heavy -> eggs, light -> salt (a pantry row only light links to). */
async function withStaple(s: ReadSetup): Promise<void> {
  await owner(s, "add_column", { table: WEIGHT, column: { name: "staple", type: "link", ref: PANTRY, description: "The staple eaten before" } });
  await owner(s, "insert_row", { table: PANTRY, values: { item: "salt", qty: 1 } });
  await owner(s, "update_row", { table: WEIGHT, path: s.paths.heavy, set: { staple: "[[eggs]]" } });
  await owner(s, "update_row", { table: WEIGHT, path: s.paths.light, set: { staple: "[[salt]]" } });
}

describe("write answers of a restricted token: inverse-link edits", () => {
  it("a pantry row linked to a weight row: written, and the answer names nothing of health", async () => {
    const s = await setupReadTokens();
    const r = await s.op("cook", "insert_row", { table: PANTRY, values: { item: "milk", for_weight: "[[Morning weigh-in]]" } });
    expect(r.status).toBe(200);
    expect(json(r)).toMatchObject({ ok: true, op: "insert_row", planned_edits: [], planned_creates: [MILK], conflicts: [], violations: [] });
    expectNoLeak(r.json);
    expect(rowsOf(await s.op("owner", "select_rows", { table: PANTRY, where: { item: "milk" } }))[0]).toMatchObject({ for_weight: "[[Morning weigh-in]]" });
  });

  // a write by cook that edits a weight row is refused now (tests/token-write-scope.test.ts); the
  // answer of such a write, made in cook's read scope, still leaves out what it may not read
  it("drops the inverse-link edit of the weight row from the answer, dry run or not; the owner reads it written", async () => {
    const s = await setupReadTokens();
    await withInverse(s);
    const args = { table: PANTRY, values: { item: "milk", weighed: "[[Morning weigh-in]]" } };
    // the owner's dry run shows the edit
    const full = await s.op("owner", "insert_row", { ...args, dry_run: true });
    expect(json(full).planned_edits).toEqual([{ path: s.paths.heavy, set: { bought: ["[[milk]]"] }, remove: [] }]);
    // cook may not write the weight row: refused, dry run or not
    for (const dry_run of [true, false]) expect((await s.op("cook", "insert_row", { ...args, dry_run })).status).toBe(403);

    const dry = await asCook(s, () => insertRow(s.v.app, s.v.settings, args, { dryRun: true }));
    expect(dry).toMatchObject({ ok: true, dry_run: true, notes_changed: 0, planned_edits: [], planned_creates: [MILK] });
    expectNothingOfHealth({ status: 200, json: dry });
    const r = await asCook(s, () => insertRow(s.v.app, s.v.settings, args));
    expect(r).toMatchObject({ ok: true, dry_run: false, files_created: 1, planned_edits: [], planned_creates: [MILK] });
    expectNothingOfHealth({ status: 200, json: r });
    // D10: the write is the same, the weight row got its inverse link
    expect(rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { label: "Morning weigh-in" } }))[0]).toMatchObject({ bought: ["[[milk]]"] });
  });

  it("update_rows and merge_rows: the inverse edits of weight rows are dropped, the pantry edits stay", async () => {
    const s = await setupReadTokens();
    await withInverse(s);
    const u = await asCook(s, () => updateRows(s.v.app, s.v.settings, { table: PANTRY, where: { item: "flour" }, set: { weighed: "[[Morning weigh-in]]" } }));
    expect(u.planned_edits.map((e) => e.path)).toEqual([s.paths.flour]);
    expectNothingOfHealth({ status: 200, json: u });
    const m = await asCook(s, () => mergeRows(s.v.app, s.v.settings, { table: PANTRY, on: ["item"], rows: [{ item: "eggs", weighed: "[[Morning weigh-in]]" }] }));
    expect(m.planned_edits.map((e) => e.path)).toEqual([s.paths.eggs]);
    expectNothingOfHealth({ status: 200, json: m });
    expect(rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { label: "Morning weigh-in" } }))[0]!.bought).toEqual(["[[flour]]", "[[eggs]]"]);
  });
});

describe("write answers of a restricted token: automatic links", () => {
  const body = "Bought before the Morning weigh-in, the ZZSECRETHEALTH evening and ZZSECRETDIARY, for the Pasta.";

  it("never links a note the token may not read; the owner's write links them", async () => {
    const s = await setupReadTokens();
    const r = await s.op("cook", "insert_row", { table: PANTRY, values: { item: "milk" }, body, autolink: true });
    expect(r.status).toBe(200);
    expect(json(r).links_added).toEqual([{ path: MILK, text: "Pasta", target: s.paths.pasta, link: "[[Pasta]]" }]);
    expect(json(r).ambiguous_mentions).toBeUndefined();
    expectNothingOfHealth(r);
    // the written text: the health and diary names stay plain text
    expect(s.v.read(MILK)).toContain("Bought before the Morning weigh-in, the ZZSECRETHEALTH evening and ZZSECRETDIARY, for the [[Pasta]].");

    const o = await s.op("owner", "insert_row", { table: PANTRY, values: { item: "salt" }, body, autolink: true });
    expect((json(o).links_added as { target: string }[]).map((l) => l.target)).toEqual([s.paths.heavy, s.paths.light, s.paths.diary, s.paths.pasta]);
  });

  it("a name a hidden note shares is no doubt to the token: it links the note it may read", async () => {
    const s = await setupReadTokens();
    await owner(s, "insert_row", { table: PANTRY, values: { item: "Morning weigh-in" } });
    const shared = "Datanotes/personal/food/pantry/Morning weigh-in.md";
    const text = "Kept for the Morning weigh-in.";
    const o = await s.op("owner", "insert_row", { table: MEALS, values: { dish: "Toast" }, body: text, autolink: true, dry_run: true });
    expect(json(o).ambiguous_mentions).toEqual([expect.objectContaining({ text: "Morning weigh-in", reason: "same_name", candidates: [shared, s.paths.heavy] })]);
    const r = await s.op("cook", "insert_row", { table: PANTRY, values: { item: "milk" }, body: text, autolink: true });
    expect(r.status).toBe(200);
    expect(json(r).links_added).toEqual([{ path: MILK, text: "Morning weigh-in", target: shared, link: "[[Datanotes/personal/food/pantry/Morning weigh-in|Morning weigh-in]]" }]);
    expect(json(r).ambiguous_mentions).toBeUndefined();
    expectNoLeak(r.json);
    expect(JSON.stringify(r.json)).not.toContain("personal/health");
  });
});

describe("write answers of a restricted token: CHECKs that follow links", () => {
  it("reports a broken CHECK of a weight row on the written row, without the other row", async () => {
    const s = await setupReadTokens();
    await withStaple(s);
    await owner(s, "add_constraint", { table: WEIGHT, name: "staple_stocked", check: { "staple.qty": { gt: 0 } }, hint: "Restock before ZZSECRETHEALTH" });
    const args = { table: PANTRY, path: s.paths.eggs, set: { qty: 0 } };
    const expected = {
      ok: false,
      conflicts: [],
      violations: [{ path: s.paths.eggs, violations: [{ column: "staple", code: "check", message: "a linked row of a table this token may not read breaks one of its CHECKs" }] }],
    };
    for (const dry_run of [true, false]) {
      const r = await s.op("cook", "update_row", { ...args, dry_run });
      expect(r.status).toBe(422);
      expect(json(r)).toMatchObject(expected);
      expect(json(r).violations).toEqual(expected.violations);
      expectNothingOfHealth(r);
    }
    // not written
    expect(rowsOf(await s.op("owner", "select_rows", { table: PANTRY, where: { item: "eggs" } }))[0]!.qty).toBe(6);
    // the owner sees the weight row and its CHECK
    const o = await s.op("owner", "update_row", { ...args, dry_run: true });
    expect(json(o).violations).toEqual([
      { path: s.paths.heavy, violations: [expect.objectContaining({ constraint: "staple_stocked", code: "check", message: expect.stringContaining("violates CHECK staple_stocked") })] },
    ]);
  });
});

describe("write answers of a restricted token: deleting rows others link to", () => {
  it("restrict names only the referencing rows the token may read, and counts the others", async () => {
    const s = await setupReadTokens();
    await withStaple(s);
    for (const dry_run of [true, false]) {
      const r = await s.op("cook", "delete_rows", { table: PANTRY, where: { item: "eggs" }, dry_run });
      expect(r.status).toBe(422);
      expect(json(r).conflicts).toEqual([{ path: s.paths.eggs, message: `referenced by ${s.paths.pasta} and 1 row this token may not read` }]);
      expectNothingOfHealth(r);
      const only = await s.op("cook", "delete_rows", { table: PANTRY, where: { item: "salt" }, dry_run });
      expect(only.status).toBe(422);
      expect(json(only).conflicts).toEqual([{ path: SALT, message: "referenced by 1 row this token may not read" }]);
      expect((only.json as { hint: string }).hint).toBe(`Other rows link to it: pass on_referenced ("set_null" or "ignore"), or change those rows first.`);
      expectNothingOfHealth(only);
    }
    const o = await s.op("owner", "delete_rows", { table: PANTRY, where: { item: "eggs" }, dry_run: true });
    expect(json(o).conflicts).toEqual([{ path: s.paths.eggs, message: `referenced by ${s.paths.pasta}, ${s.paths.heavy}` }]);
    expect(rowsOf(await s.op("owner", "select_rows", { table: PANTRY })).map((r) => r.item).sort()).toEqual(["eggs", "flour", "salt"]);
  });

  it("set_null clears the weight row's link and leaves it out of the answer", async () => {
    const s = await setupReadTokens();
    await withStaple(s);
    const args = { table: PANTRY, where: { item: "salt" }, on_referenced: "set_null" };
    const input = { table: PANTRY, where: { item: "salt" }, onReferenced: "set_null" as const };
    // cook may not write the weight row: refused over HTTP (tests/token-write-scope.test.ts)
    expect((await s.op("cook", "delete_rows", args)).status).toBe(403);
    const dry = await asCook(s, () => deleteRows(s.v.app, s.v.settings, input, { dryRun: true }));
    expect(dry).toMatchObject({ ok: true, planned_edits: [], planned_moves: [{ from: SALT, to: "Datanotes/personal/food/pantry/_archive/salt.md" }] });
    expectNothingOfHealth({ status: 200, json: dry });
    expect(json(await s.op("owner", "delete_rows", { ...args, dry_run: true })).planned_edits.map((e) => e.path)).toEqual([s.paths.light]);
    const r = await asCook(s, () => deleteRows(s.v.app, s.v.settings, input));
    expect(r).toMatchObject({ ok: true, files_moved: 1, planned_edits: [] });
    expectNothingOfHealth({ status: 200, json: r });
    expect(rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { label: "Morning weigh-in" } }))[0]!.staple).toBe("[[eggs]]");
    expect(rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { kg: 79 } }))[0]!.staple ?? null).toBeNull();
  });
});

describe("write answers of a restricted token: adopt_rows of a row of another table", () => {
  it("over HTTP: the conflicts and violations about the weight row are left out, one conflict says why", async () => {
    const s = await setupReadTokens();
    for (const dry_run of [true, false]) {
      const r = await s.op("cook", "adopt_rows", { table: PANTRY, paths: [s.paths.light], dry_run });
      expect(r.status).toBe(422);
      expect(json(r)).toMatchObject({ ok: false, violations: [], planned_edits: [], planned_moves: [], conflicts: [{ path: "", message: "1 row this token may not read blocks this write" }] });
      expectNoLeak(r.json);
    }
    const o = await s.op("owner", "adopt_rows", { table: PANTRY, paths: [s.paths.light], dry_run: true });
    expect(json(o).conflicts[0]).toEqual({ path: s.paths.light, message: `already a row of ${WEIGHT}: use move_rows` });
  });

  it("in the engine: \"already a row of another table\" under a scope that may not read it", async () => {
    const s = await setupReadTokens();
    const r = await runWithReadScope(COOK, () => adoptRows(s.v.app, s.v.settings, { table: PANTRY, paths: [s.paths.heavy, s.paths.pasta] }, { dryRun: true }));
    expect(r.conflicts.filter((c) => c.message.startsWith("already a row of"))).toEqual([
      { path: s.paths.pasta, message: `already a row of ${MEALS}: use move_rows` },
      { path: s.paths.heavy, message: "already a row of another table: use move_rows" },
    ]);
    const plain = await adoptRows(s.v.app, s.v.settings, { table: PANTRY, paths: [s.paths.heavy] }, { dryRun: true });
    expect(plain.conflicts[0]).toEqual({ path: s.paths.heavy, message: `already a row of ${WEIGHT}: use move_rows` });
  });
});

describe("write answers of a restricted token: unique values", () => {
  it("names the pantry row that holds the value: the written table is readable (D3)", async () => {
    const s = await setupReadTokens();
    await owner(s, "add_column", { table: PANTRY, column: { name: "code", type: "string", unique: true, description: "The shelf code" } });
    await owner(s, "update_row", { table: PANTRY, path: s.paths.eggs, set: { code: "E1" } });
    const r = await s.op("cook", "insert_row", { table: PANTRY, values: { item: "milk", code: "E1" } });
    expect(r.status).toBe(422);
    expect(json(r).violations).toEqual([{ path: MILK, violations: [{ column: "code", code: "unique", message: `must be unique (also used by ${s.paths.eggs})`, value: "E1" }] }]);
    expectNoLeak(r.json);
  });
});

describe("write answers of a restricted token: batch", () => {
  it("redacts every step's result, in a dry run and in a batch that is refused", async () => {
    const s = await setupReadTokens();
    await withInverse(s);
    await withStaple(s);
    await owner(s, "add_constraint", { table: WEIGHT, name: "staple_stocked", check: { "staple.qty": { gt: 0 } } });
    // cook may not write weight rows (an inverse link would): milk links to a weigh-in with no inverse
    const operations = [
      { op: "insert_row", table: PANTRY, values: { item: "milk", for_weight: "[[Morning weigh-in]]" } },
      { op: "update_row", table: PANTRY, path: s.paths.eggs, set: { qty: 0 } },
    ];
    for (const dry_run of [true, false]) {
      const r = await s.op("cook", "batch", { operations, dry_run });
      expect(r.status).toBe(422);
      const steps = (r.json as { steps: { ok: boolean; result: Answer }[] }).steps;
      expect(steps[0]!.result).toMatchObject({ ok: true, planned_edits: [], planned_creates: [MILK] });
      expect(steps[1]!.result).toMatchObject({ ok: false, violations: [{ path: s.paths.eggs, violations: [{ column: "staple", code: "check", message: "a linked row of a table this token may not read breaks one of its CHECKs" }] }] });
      expectNothingOfHealth(r);
    }
    // nothing left written
    expect(rowsOf(await s.op("owner", "select_rows", { table: PANTRY, where: { item: "milk" } }))).toEqual([]);
    const ok = await s.op("cook", "batch", { operations: [operations[0]] });
    expect(ok.status).toBe(200);
    expect((ok.json as { steps: { result: Answer }[] }).steps[0]!.result.planned_edits).toEqual([]);
    expectNothingOfHealth(ok);
    const o = await s.op("owner", "batch", { operations: [{ ...operations[0], values: { item: "oats", weighed: "[[Morning weigh-in]]" } }], dry_run: true });
    expect((o.json as { steps: { result: Answer }[] }).steps[0]!.result.planned_edits.map((e) => e.path)).toEqual([s.paths.heavy]);
  });
});

describe("redactWriteAnswer", () => {
  const base = (over: Partial<OpResult> & Record<string, unknown> = {}): OpResult =>
    ({
      ok: false,
      op: "update_rows",
      dry_run: true,
      notes_changed: 0,
      files_created: 0,
      files_moved: 0,
      files_deleted: 0,
      references_updated: 0,
      conflicts: [],
      violations: [],
      failed: [],
      planned_edits: [],
      planned_creates: [],
      planned_moves: [],
      planned_deletes: [],
      planned_texts: [],
      ...over,
    }) as OpResult;

  it("returns the answer as it is without a scope", async () => {
    const s = await setupReadTokens();
    const r = base({ conflicts: [{ path: s.paths.light, message: "x" }] });
    expect(redactWriteAnswer(r, s.v.app, s.v.settings)).toBe(r);
  });

  it("drops every entry about a note the scope may not read, keeps the rest and the paths of no note", async () => {
    const s = await setupReadTokens();
    const NEW = "Datanotes/personal/food/pantry/new.md";
    const r = base({
      migration_id: "m1",
      rolled_back: true,
      conflicts: [
        { path: "", message: "the database changed while this write was being checked: send it again" },
        { path: s.paths.light, message: "secret" },
        { path: s.paths.eggs, message: "kept" },
      ],
      violations: [
        { path: s.paths.heavy, violations: [{ code: "check", message: "no" }] },
        { path: NEW, violations: [{ code: "required", column: "item", message: "is required" }] },
      ],
      failed: [
        { path: s.paths.diary, error: "busy" },
        { path: s.paths.flour, error: "busy" },
      ],
      planned_edits: [
        { path: s.paths.light, set: { bought: ["[[x]]"] }, remove: [] },
        { path: s.paths.eggs, set: { qty: 1 }, remove: [], body: true },
      ],
      planned_creates: [NEW, s.paths.diary],
      planned_moves: [
        { from: s.paths.light, to: "Datanotes/personal/health/weight/_archive/x.md" },
        { from: s.paths.flour, to: "Datanotes/personal/food/pantry/_archive/flour.md" },
      ],
      planned_deletes: [s.paths.heavy, NEW],
      planned_texts: ["Datanotes/metastore.yaml"],
      commits: [
        { table: WEIGHT, version: 3, operation: "UPDATE" },
        { table: PANTRY, version: 4, operation: "UPDATE" },
      ],
      links_added: [
        { path: NEW, text: "Pasta", target: s.paths.pasta, link: "[[Pasta]]" },
        { path: NEW, text: "Morning weigh-in", target: s.paths.heavy, link: "[[Morning weigh-in]]" },
      ],
      ambiguous_mentions: [
        { path: NEW, text: "Eggs", reason: "same_name", candidates: [s.paths.eggs, s.paths.heavy], context: "c", hint: "h" },
        { path: NEW, text: "Weigh", reason: "same_name", candidates: [s.paths.heavy, s.paths.light], context: "c", hint: "h" },
      ],
      unknown_field: "dropped",
    });
    const out = runWithReadScope(COOK, () => redactWriteAnswer(r, s.v.app, s.v.settings));
    expect(out).toEqual({
      ok: false,
      op: "update_rows",
      dry_run: true,
      migration_id: "m1",
      notes_changed: 0,
      files_created: 0,
      files_moved: 0,
      files_deleted: 0,
      references_updated: 0,
      conflicts: [
        { path: "", message: "the database changed while this write was being checked: send it again" },
        { path: s.paths.eggs, message: "kept" },
        { path: "", message: "3 rows this token may not read block this write" },
      ],
      violations: [{ path: NEW, violations: [{ code: "required", column: "item", message: "is required" }] }],
      failed: [{ path: s.paths.flour, error: "busy" }],
      rolled_back: true,
      planned_edits: [{ path: s.paths.eggs, set: { qty: 1 }, remove: [], body: true }],
      planned_creates: [NEW],
      planned_moves: [{ from: s.paths.flour, to: "Datanotes/personal/food/pantry/_archive/flour.md" }],
      planned_deletes: [NEW],
      planned_texts: ["Datanotes/metastore.yaml"],
      commits: [{ table: PANTRY, version: 4, operation: "UPDATE" }],
      links_added: [{ path: NEW, text: "Pasta", target: s.paths.pasta, link: "[[Pasta]]" }],
      ambiguous_mentions: [{ path: NEW, text: "Eggs", reason: "same_name", candidates: [s.paths.eggs], context: "c", hint: "h" }],
    });
    expectNoLeak(out);
  });

  it("keeps a move whose new path the scope may read, and leaves out empty link reports", async () => {
    const s = await setupReadTokens();
    const r = base({
      ok: true,
      planned_moves: [{ from: "Inbox/gone.md", to: s.paths.eggs }],
      links_added: [{ path: s.paths.eggs, text: "Weigh", target: s.paths.heavy, link: "[[Weigh]]" }],
      ambiguous_mentions: [{ path: s.paths.eggs, text: "W", reason: "same_name", candidates: [s.paths.light], context: "c", hint: "h" }],
    });
    const out = runWithReadScope(COOK, () => redactWriteAnswer(r, s.v.app, s.v.settings));
    expect(out.planned_moves).toEqual([{ from: "Inbox/gone.md", to: s.paths.eggs }]);
    expect(out.conflicts).toEqual([]);
    expect("links_added" in out).toBe(false);
    expect("ambiguous_mentions" in out).toBe(false);
  });
});
