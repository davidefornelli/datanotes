import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";
import { operationRequest } from "../src/api/requests";
import { resultOf } from "../src/api/results";
import { INDEX_RETRY } from "../src/core/engine";
import { createHandlers, dispatch } from "../src/server/rest";
import { logVault } from "./helpers/db-vault";
import { JOURNALED_WRITES, OP_NAMED, opProblem } from "./helpers/op-names";

INDEX_RETRY.delayMs = 1;

// The answer of a write, done or refused, names the operation called by its catalog name (`op`):
// "recompute_columns refused", never "recompute refused" nor "operation refused". The rule is
// checked here, and on every call of the test-vault scenarios (tests/helpers/test-vault.ts), which
// run every operation of the catalog, its refusals too.

/** The route handlers on the `log` vault, called as the HTTP API calls them; every answer is checked. */
function setup(extra: Record<string, string> = {}) {
  const v = logVault(extra);
  const h = createHandlers(v.app, () => v.settings);
  const call = async (name: string, args: Record<string, unknown>) => {
    const req = operationRequest(name, args);
    const route = req.path.replace(/^\/datanotes/, "");
    const r = await dispatch(route, h[route]!, req.body);
    expect(opProblem(name, r.status, r.json), `${name}: ${JSON.stringify(r.json).slice(0, 500)}`).toBeNull();
    return { status: r.status, json: r.json as Record<string, unknown> };
  };
  return { v, call };
}

const NEW_ROW = { kind: "walk", occurred_at: "2026-09-27T07:00" };

describe("the op of an operation's answer", () => {
  it("every write the journal records names itself, and only those (the response schemas declare op)", () => {
    expect(JOURNALED_WRITES.filter((n) => !OP_NAMED.has(n)), "journaled writes whose answer does not declare op").toEqual([]);
    expect([...OP_NAMED].filter((n) => !JOURNALED_WRITES.includes(n)), "operations declaring op that the journal does not record").toEqual([]);
    const fixed = (name: string) => (OPERATIONS.find((o) => o.name === name)!.responseSchema!.properties as Record<string, { const?: string }>).op!.const;
    expect([fixed("undo_migration"), fixed("batch")]).toEqual(["undo_migration", "batch"]);
  });

  it("finds an answer with a wrong or a missing op; errors that are no result name nothing", () => {
    expect(opProblem("insert_row", 200, { ok: true, op: "insert_row" })).toBeNull();
    expect(opProblem("recompute_columns", 200, { ok: true, op: "recompute" })).toBe('recompute_columns answered op "recompute" (HTTP 200)');
    expect(opProblem("undo_migration", 409, { ok: false, conflicts: [] })).toBe('undo_migration answered without "op" (HTTP 409)');
    expect(opProblem("batch", 422, { ok: false, steps: [] })).toBe('batch answered without "op" (HTTP 422)');
    expect(opProblem("insert_row", 400, { error: "bad", hint: "h", docs: "d" })).toBeNull();
    expect(opProblem("select_rows", 200, { table: "log", rows: [] })).toBeNull();
    expect(opProblem("search_simple", 200, [])).toBeNull();
    expect(opProblem("read_note", 200, undefined)).toBeNull();
  });

  it("recompute_columns: a recompute that writes, and one with nothing to do", async () => {
    const { call } = setup({ "Daily/c.md": "---\ntable: main.public.log\nkind: walk\noccurred_at: 2026-09-27T09:00\n---\nC\n" });
    const fill = await call("recompute_columns", { table: "log" });
    expect([fill.status, fill.json.op, fill.json.notes_changed]).toEqual([200, "recompute_columns", 1]);
    const again = await call("recompute_columns", { table: "log" });
    expect([again.status, again.json.op, again.json.notes_changed]).toEqual([200, "recompute_columns", 0]);
    const preview = await call("recompute_columns", { table: "log", dry_run: true });
    expect([preview.json.op, preview.json.dry_run]).toEqual(["recompute_columns", true]);
  });

  it("undo_migration: done, refused (its text names it), and an unknown id (an error, no result)", async () => {
    const { call } = setup();
    const ins = await call("insert_row", { table: "log", values: NEW_ROW });
    const undo = await call("undo_migration", { migration_id: ins.json.migration_id });
    expect([undo.status, undo.json.op, undo.json.ok]).toEqual([200, "undo_migration", true]);
    const again = await call("undo_migration", { migration_id: ins.json.migration_id });
    expect([again.status, again.json.op, again.json.ok]).toEqual([409, "undo_migration", false]);
    expect(resultOf(again.status, again.json, "").value).toMatch(/^undo_migration refused — nothing was written:\nconflict .*: migration already undone\nHint: /);
    const unknown = await call("undo_migration", { migration_id: "20990101-000000-nope" });
    expect(unknown.status).toBe(404);
    expect(unknown.json.op).toBeUndefined();
  });

  it("batch: done, a dry run, and a refusal rolled back; its steps name their own operations", async () => {
    const { call } = setup();
    const done = await call("batch", { operations: [{ op: "insert_row", table: "log", values: NEW_ROW }] });
    expect([done.status, done.json.op, (done.json.steps as { op: string }[])[0]!.op]).toEqual([200, "batch", "insert_row"]);
    const dry = await call("batch", { operations: [{ op: "insert_row", table: "log", values: NEW_ROW }], dry_run: true });
    expect([dry.json.op, dry.json.dry_run]).toEqual(["batch", true]);
    const refused = await call("batch", {
      operations: [
        { op: "insert_row", table: "log", values: { kind: "mood", occurred_at: "2026-09-28T07:00" } },
        { op: "insert_row", table: "log", values: { kind: "nope", occurred_at: "2026-09-28T08:00" } },
      ],
    });
    expect([refused.status, refused.json.op, refused.json.rolled_back]).toEqual([422, "batch", true]);
    expect((refused.json.steps as { result: { op: string } }[]).map((s) => s.result.op)).toEqual(["insert_row", "insert_row"]);
  });

  it("a refused write names itself too", async () => {
    const { call } = setup();
    const refused = await call("insert_row", { table: "log", values: { kind: "nope", occurred_at: "2026-09-28T08:00" } });
    expect([refused.status, refused.json.op]).toEqual([422, "insert_row"]);
    const stale = await call("update_row", { table: "log", path: "Daily/a.md", set: { kind: "mood" }, expect: { kind: "walk" } });
    expect([stale.status, stale.json.op]).toEqual([422, "update_row"]);
  });
});
