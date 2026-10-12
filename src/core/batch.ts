/**
 * Batches: several write operations that succeed or fail together.
 *
 * Obsidian has no transactions (each file is written on its own), so a batch is all-or-nothing by
 * compensation: operations run in order, each validated against the vault as the previous ones
 * left it; when one is refused or fails, the ones already applied are undone in reverse order and
 * nothing is left half-written (one that fails partway is rolled back by the engine first). A
 * batch that succeeds is journaled as one `batch` entry listing its
 * operations, and `undo` of that entry undoes them all (in reverse).
 *
 * A dry run checks every operation against the current vault, without the effects of the earlier
 * ones (an operation that depends on an earlier one, e.g. updating a row the batch inserts, can
 * only be checked for real).
 */

import type { App } from "./host";
import { currentActor } from "./actor";
import type { UndoConflict } from "./changeset";
import type { OpResult, RunOptions } from "./engine";
import { writeJournal } from "./journal";
import type { DatanotesSettings } from "./settings";
import { telemetry } from "./telemetry";
import { messageOf } from "./message";
import { guidanceOf } from "./hints";

export interface BatchStep {
  op: string;
  run: (dryRun: boolean) => Promise<OpResult>;
}

export interface BatchStepResult {
  index: number;
  op: string;
  ok: boolean;
  migration_id?: string;
  result?: OpResult;
  error?: string;
  /** How to fix the error, and where to read more (src/core/hints.ts). */
  hint?: string;
  docs?: string;
}

/** The error of a step that threw, with its guidance when it has some. */
function stepError(e: unknown): { error: string; hint?: string; docs?: string } {
  return { error: messageOf(e), ...guidanceOf(e) };
}

export interface BatchResult {
  ok: boolean;
  /** The operation, as the results of the other writes name theirs. */
  op: "batch";
  dry_run: boolean;
  /** Journal id of the batch (undo it to undo every operation). */
  migration_id?: string;
  steps: BatchStepResult[];
  /** Index of the operation that was refused or failed. */
  failed_at?: number;
  /** Operations undone after the failure; `rolledBack: false` lists what could not be undone. */
  rolled_back?: boolean;
  rollback?: { migration_id: string; ok: boolean; conflicts: UndoConflict[]; failed: { path: string; error: string }[] }[];
}

export type Undo = (migrationId: string) => Promise<{ ok: boolean; conflicts: UndoConflict[]; failed: { path: string; error: string }[] }>;

export const MAX_BATCH_OPERATIONS = 200;

export async function runBatch(
  app: App,
  settings: DatanotesSettings,
  steps: BatchStep[],
  undo: Undo,
  opts: RunOptions & { summary?: string } = {},
): Promise<BatchResult> {
  if (steps.length === 0) throw new Error(`"operations" must not be empty`);
  if (steps.length > MAX_BATCH_OPERATIONS) throw new Error(`a batch takes at most ${MAX_BATCH_OPERATIONS} operations`);
  const dryRun = opts.dryRun === true;
  const results: BatchStepResult[] = [];

  if (dryRun) {
    let ok = true;
    for (const [index, s] of steps.entries()) {
      try {
        const r = await s.run(true);
        results.push({ index, op: s.op, ok: r.ok, result: r });
        ok &&= r.ok;
      } catch (e) {
        results.push({ index, op: s.op, ok: false, ...stepError(e) });
        ok = false;
      }
    }
    return { ok, op: "batch", dry_run: dryRun, steps: results };
  }

  for (const [index, s] of steps.entries()) {
    let r: OpResult | undefined;
    let error: ReturnType<typeof stepError> | undefined;
    try {
      r = await s.run(false);
    } catch (e) {
      error = stepError(e);
    }
    results.push({ index, op: s.op, ok: r?.ok === true, ...(r?.migration_id ? { migration_id: r.migration_id } : {}), ...(r ? { result: r } : {}), ...error });
    if (r?.ok) continue;

    // Refused or failed: undo what this batch already wrote, newest first. An operation that failed
    // partway was rolled back by the engine already (`rolled_back`); when that rollback failed too,
    // it is undone again here with the others.
    const toUndo = results.filter((x) => x.migration_id && x.result?.rolled_back !== true).map((x) => x.migration_id!).reverse();
    const rollback: NonNullable<BatchResult["rollback"]> = [];
    for (const id of toUndo) {
      try {
        const u = await undo(id);
        rollback.push({ migration_id: id, ok: u.ok, conflicts: u.conflicts, failed: u.failed });
      } catch (e) {
        rollback.push({ migration_id: id, ok: false, conflicts: [], failed: [{ path: "undo", error: messageOf(e) }] });
      }
    }
    const rolledBack = rollback.every((x) => x.ok);
    telemetry().log(rolledBack ? "WARN" : "ERROR", "datanotes batch rolled back", { failed_at: index, op: s.op, undone: rollback.filter((x) => x.ok).length, not_undone: rollback.filter((x) => !x.ok).length });
    return { ok: false, op: "batch", dry_run: dryRun, steps: results, failed_at: index, rolled_back: rolledBack, rollback };
  }

  const members = results.filter((x) => x.migration_id).map((x) => x.migration_id!);
  if (members.length === 0) return { ok: true, op: "batch", dry_run: dryRun, steps: results };
  const now = opts.now ?? new Date();
  const summary = opts.summary?.trim() || `${steps.length} operations: ${[...new Set(steps.map((s) => s.op))].join(", ")}`;
  const j = await writeJournal(
    app,
    settings,
    {
      op: "batch",
      summary,
      executed_at: now.toISOString(),
      rows: [],
      creates: [],
      moves: [],
      references: [],
      failed: [],
      members,
      ...(currentActor() ? { actor: currentActor() } : {}),
    },
    now,
  );
  return { ok: true, op: "batch", dry_run: dryRun, migration_id: j.id, steps: results };
}
