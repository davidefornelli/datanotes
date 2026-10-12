/**
 * The `op` of an operation's answer: the results of the writes (and their refusals) name the
 * operation by its catalog name (src/api/catalog.ts), so an agent reading "insert_row refused" knows
 * which call it was. tests/operation-op.test.ts checks the rule; the test-vault harness
 * (tests/helpers/test-vault.ts) checks it on every call the scenarios make.
 */

import { OPERATION_KIND, OPERATIONS } from "../../src/api/catalog";

/** The operations whose answer names them: those whose response schema declares `op`. */
export const OP_NAMED: ReadonlySet<string> = new Set(OPERATIONS.filter((o) => "op" in ((o.responseSchema?.properties ?? {}) as Record<string, unknown>)).map((o) => o.name));

/** The writes the journal records (and undo_migration reverts): every one must name itself. */
export const JOURNALED_WRITES: readonly string[] = [
  ...OPERATIONS.map((o) => o.name).filter((n) => OPERATION_KIND[n] === "schema" || OPERATION_KIND[n] === "rows"),
  "undo_migration",
  "restore_table",
  "restore_database",
];

/**
 * What is wrong with the `op` of an answer to `name`, or null. A result (2xx) or a refusal (a
 * result with `ok: false`: conflicts, violations, failures, the steps of a batch) of an operation
 * that names itself must carry `op` equal to `name`; any answer that carries `op` at its top must
 * carry that one. An error that is no result (`{error, hint, docs}`: bad arguments, an unknown
 * table) names nothing.
 */
export function opProblem(name: string, status: number, json: unknown): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const body = json as Record<string, unknown>;
  if ("op" in body && body.op !== name) return `${name} answered op ${JSON.stringify(body.op)} (HTTP ${status})`;
  const result = (status >= 200 && status < 300) || "conflicts" in body || "violations" in body || "failed" in body || "steps" in body;
  if (OP_NAMED.has(name) && result && !("op" in body)) return `${name} answered without "op" (HTTP ${status})`;
  return null;
}
