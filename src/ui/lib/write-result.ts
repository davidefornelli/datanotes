// The answer of every write operation (insert_row, update_row, delete_rows, alter_column, ...):
// recognize it, group its refusals by column, and say in one line what happened. Pure.

export interface Violation {
  column?: string;
  constraint?: string;
  code: string;
  message: string;
  value?: unknown;
}

export interface WriteAnswer {
  ok: boolean;
  op: string;
  dry_run: boolean;
  migration_id?: string;
  notes_changed: number;
  files_created: number;
  files_moved: number;
  files_deleted: number;
  references_updated: number;
  conflicts: { path: string; message: string }[];
  violations: { path: string; violations: Violation[] }[];
  failed: { path: string; error: string }[];
  rolled_back?: boolean;
  planned_edits: { path: string; set?: Record<string, unknown>; remove?: string[]; body?: string }[];
  planned_creates: string[];
  planned_moves: { from: string; to: string }[];
  planned_deletes: string[];
  links_added?: unknown[];
  ambiguous_mentions?: unknown[];
  warnings?: unknown[];
  hint?: string;
  docs?: string;
}

/** A write answer: a boolean `ok` and the arrays `conflicts` and `violations`. */
export function isWriteAnswer(json: unknown): json is WriteAnswer {
  if (json === null || typeof json !== "object") return false;
  const j = json as Record<string, unknown>;
  return typeof j.ok === "boolean" && Array.isArray(j.conflicts) && Array.isArray(j.violations);
}

/** The violations of one path (every path when none is given), merged over the answer's entries. */
export function violationsFor(
  a: WriteAnswer,
  path?: string,
): { byColumn: Record<string, Violation[]>; checks: Violation[]; other: Violation[] } {
  const byColumn: Record<string, Violation[]> = {};
  const checks: Violation[] = [];
  const other: Violation[] = [];
  for (const entry of a.violations) {
    if (path !== undefined && entry.path !== path) continue;
    for (const v of entry.violations ?? []) {
      if (v.code === "check") checks.push(v);
      else if (v.column !== undefined) (byColumn[v.column] ??= []).push(v);
      else other.push(v);
    }
  }
  return { byColumn, checks, other };
}

function count(n: number, one: string, many: string, tail = ""): string {
  return `${n} ${n === 1 ? one : many}${tail}`;
}

function len(list: unknown[] | undefined): number {
  return list?.length ?? 0;
}

/** One line: what the write did, would do (dry run), or why it was refused. */
export function summarize(a: WriteAnswer): string {
  if (!a.ok) {
    const nViolations = a.violations.reduce((n, e) => n + len(e.violations), 0);
    const parts = [
      nViolations ? count(nViolations, "violation", "violations") : "",
      len(a.conflicts) ? count(len(a.conflicts), "conflict", "conflicts") : "",
      len(a.failed) ? count(len(a.failed), "failure", "failures") : "",
    ].filter(Boolean);
    return parts.length ? `Refused: ${parts.join(", ")}` : "Refused";
  }
  if (a.dry_run) {
    const parts = [
      len(a.planned_edits) ? count(len(a.planned_edits), "edit", "edits") : "",
      len(a.planned_creates) ? count(len(a.planned_creates), "file", "files", " to create") : "",
      len(a.planned_moves) ? count(len(a.planned_moves), "file", "files", " to move") : "",
      len(a.planned_deletes) ? count(len(a.planned_deletes), "file", "files", " to delete") : "",
    ].filter(Boolean);
    return parts.length ? `Dry run: ${parts.join(", ")}` : "Dry run: nothing to change";
  }
  const parts = [
    a.notes_changed ? count(a.notes_changed, "note", "notes", " changed") : "",
    a.files_created ? count(a.files_created, "file", "files", " created") : "",
    a.files_moved ? count(a.files_moved, "file", "files", " moved") : "",
    a.files_deleted ? count(a.files_deleted, "file", "files", " deleted") : "",
    a.references_updated ? count(a.references_updated, "reference", "references", " updated") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing to change";
}
