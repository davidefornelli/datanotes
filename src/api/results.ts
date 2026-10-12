/**
 * What an operation returned, for its caller: the value of a success, or an agent-readable text
 * for a refusal (what was refused; nothing was written) or an error, ending with the engine's
 * `hint` (how to fix it) and `docs` (where to read more) when it sends them.
 */

import { guidanceIn, guidedText } from "./guidance.js";

const MAX_DETAIL_ROWS = 20;

/** Agent-readable summary of conflicts / violations / failures in a refused result. */
export function describeRefusal(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const c of (data.conflicts as { path?: string; message?: string }[] | undefined) ?? []) lines.push(`conflict ${c.path}: ${c.message}`);
  for (const rv of (data.violations as { path?: string; violations?: { column?: string; index?: number; constraint?: string; message?: string }[] }[] | undefined) ?? []) {
    for (const v of rv.violations ?? []) lines.push(`invalid ${rv.path}: ${v.constraint ?? `${v.column}${v.index !== undefined ? `[${v.index}]` : ""}`} ${v.message}`);
  }
  for (const f of (data.failed as { path?: string; error?: string }[] | undefined) ?? []) lines.push(`failed ${f.path}: ${f.error}`);
  const shown = lines.slice(0, MAX_DETAIL_ROWS);
  if (lines.length > shown.length) shown.push(`... and ${lines.length - shown.length} more`);
  const op = (data.op as string | undefined) ?? "operation";
  const failed = ((data.failed as unknown[] | undefined) ?? []).length > 0;
  let head = failed ? `${op} failed` : `${op} refused — nothing was written`;
  // A write that failed partway is rolled back by the engine; only a failed rollback leaves part of it.
  if (failed && data.rolled_back === true) head += " — the engine rolled back what it had written, nothing is left written";
  else if (failed && data.rolled_back === false) head += ` and could NOT be rolled back (journal ${String(data.migration_id)}; undo_migration on it retries the rollback)`;
  else if (failed && data.migration_id) head += ` (journal ${String(data.migration_id)}; use undo_migration to revert what was applied)`;
  return guidedText(head + (shown.length ? `:\n${shown.join("\n")}` : ""), guidanceIn(data));
}

/** Agent-readable summary of a refused batch: the failing operation and the rollback. */
export function describeBatch(data: Record<string, unknown>): string {
  const steps = (data.steps as { index?: number; op?: string; ok?: boolean; error?: string; result?: Record<string, unknown> }[] | undefined) ?? [];
  const lines = steps
    .filter((st) => !st.ok)
    .map((st) => `operation ${st.index} (${st.op}): ${st.error !== undefined ? guidedText(st.error, guidanceIn(st)) : st.result ? describeRefusal(st.result) : "refused"}`);
  const head = data.dry_run
    ? "batch dry run: some operations would be refused"
    : data.rolled_back === false
      ? `batch failed at operation ${String(data.failed_at)} and could NOT be fully rolled back: ${JSON.stringify(data.rollback)}`
      : `batch refused at operation ${String(data.failed_at)} — the operations before it were undone, nothing is left written`;
  return guidedText(head + (lines.length ? `:\n${lines.join("\n")}` : ""), guidanceIn(data));
}

export interface OperationResult {
  ok: boolean;
  /** The result (JSON, or the text of a note) or, when `ok` is false, the reason. */
  value: unknown;
}

/** The result of an HTTP answer: `json` when the body was JSON, else its `text`. */
export function resultOf(status: number, json: unknown, text: string): OperationResult {
  if (status >= 200 && status < 300) return { ok: true, value: json !== undefined ? json : text };
  const data = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if ("steps" in data) return { ok: false, value: describeBatch(data) };
  if ("conflicts" in data || "violations" in data || "failed" in data) return { ok: false, value: describeRefusal(data) };
  return { ok: false, value: typeof data.error === "string" ? guidedText(data.error, guidanceIn(data)) : text.trim() || `HTTP ${status}` };
}
