/**
 * Batches at their edges: too many operations, a rollback that cannot undo an operation (its
 * journal entry is gone), and a batch whose operations change nothing.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MAX_BATCH_OPERATIONS, runBatch, type BatchStep } from "../src/core/batch";
import { INDEX_RETRY, OperationInputError, undoOperation } from "../src/core/engine";
import { insertRow, recomputeColumns, select, updateRows } from "../src/core/rows";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { logVault, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;
afterEach(() => setTelemetry(NOOP_TELEMETRY));

const undo = (v: DbVault) => (id: string) => undoOperation(v.app, v.settings, id);

describe("runBatch", () => {
  it("takes at most 200 operations", async () => {
    const v = logVault();
    let ran = 0;
    const step: BatchStep = { op: "recompute_columns", run: async (dryRun) => (ran++, recomputeColumns(v.app, v.settings, { table: "log" }, { dryRun })) };
    const p = runBatch(v.app, v.settings, Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, () => step), undo(v));
    await expect(p).rejects.toThrow(new Error("a batch takes at most 200 operations"));
    expect(ran).toBe(0);
  });

  it("a rollback that cannot undo an operation says so, logged at ERROR; the operation's write stays", async () => {
    const v = logVault();
    const logs: { severity: string; body: string; attrs: Record<string, unknown> }[] = [];
    setTelemetry({ log: (severity, body, attrs = {}) => logs.push({ severity, body, attrs }), flush: async () => {} });
    let journal = "";
    const steps: BatchStep[] = [
      {
        op: "insert_row",
        run: async (dryRun) => {
          const r = await insertRow(v.app, v.settings, { table: "log", values: { kind: "walk", occurred_at: "2026-09-28T09:00" } }, { dryRun });
          journal = r.migration_id!;
          return r;
        },
      },
      {
        op: "update_rows",
        run: async (dryRun) => {
          // the first operation's journal entry is lost (a sync tool removed it), then this one is refused
          v.remove(`store:journal/${journal.slice(0, 4)}-${journal.slice(4, 6)}.jsonl`);
          return updateRows(v.app, v.settings, { table: "log", set: { color: "red" } }, { dryRun });
        },
      },
    ];
    const r = await runBatch(v.app, v.settings, steps, undo(v));
    const first = r.steps[0]!.migration_id!;
    expect(r).toMatchObject({ ok: false, dry_run: false, failed_at: 1, rolled_back: false });
    expect(r.steps.map((s) => [s.index, s.op, s.ok, s.error ?? null])).toEqual([
      [0, "insert_row", true, null],
      [1, "update_rows", false, `unknown column "color" for table "log"`],
    ]);
    expect(r.rollback).toEqual([{ migration_id: first, ok: false, conflicts: [], failed: [{ path: "undo", error: expect.stringContaining(first) }] }]);
    expect(logs.filter((l) => l.body === "datanotes batch rolled back").map((l) => [l.severity, l.attrs])).toEqual([
      ["ERROR", { failed_at: 1, op: "update_rows", undone: 0, not_undone: 1 }],
    ]);
    expect((await select(v.app, v.settings, { table: "log", where: { kind: "walk" } })).rows).toHaveLength(1);
    await expect(updateRows(v.app, v.settings, { table: "log", set: { color: "red" } })).rejects.toBeInstanceOf(OperationInputError);
  });

  it("a batch whose operations change nothing is not journaled", async () => {
    const v = logVault();
    const step: BatchStep = { op: "recompute_columns", run: (dryRun) => recomputeColumns(v.app, v.settings, { table: "log" }, { dryRun }) };
    const r = await runBatch(v.app, v.settings, [step, step], undo(v), { summary: "tidy" });
    expect([r.ok, r.dry_run, r.migration_id, r.steps.map((s) => [s.op, s.ok, s.migration_id ?? null])]).toEqual([
      true,
      false,
      undefined,
      [
        ["recompute_columns", true, null],
        ["recompute_columns", true, null],
      ],
    ]);
    expect(v.listAll().filter((p) => p.startsWith("store:journal/"))).toEqual([]);
  });
});
