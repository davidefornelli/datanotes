/**
 * Write answers as the database browser shows them (src/ui/lib/write-result.ts), with answers
 * captured from the engine (insert_row on the test vault's task table).
 */

import { describe, expect, it } from "vitest";
import { isWriteAnswer, summarize, violationsFor, type WriteAnswer } from "../src/ui/lib/write-result";

const BASE = {
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
};

/** insert_row {status: "bogus", priority: "zzz"}, dry run. */
const ENUMS: WriteAnswer = {
  ...BASE,
  ok: false,
  op: "insert_row",
  dry_run: true,
  violations: [
    {
      path: "datanotes/work/planning/task/X1.md",
      violations: [
        { column: "status", code: "enum", message: "must be one of: todo; doing; done", value: "bogus" },
        { column: "priority", code: "enum", message: "must be one of: low; medium; high", value: "zzz" },
      ],
    },
  ],
  planned_creates: ["datanotes/work/planning/task/X1.md"],
  hint: "Use one of the allowed values listed in the message, written exactly.",
  docs: "https://datanotes.dev/guides/database-objects/columns.md#describe-what-each-enum-value-means",
};

/** insert_row {status: "done"} without done_on: the CHECK done_has_date. */
const CHECK: WriteAnswer = {
  ...BASE,
  ok: false,
  op: "insert_row",
  dry_run: true,
  violations: [
    {
      path: "datanotes/work/planning/task/X3.md",
      violations: [{ constraint: "done_has_date", code: "check", message: 'violates CHECK done_has_date: {"or":[]}' }],
    },
  ],
};

/** insert_row, applied. */
const DONE: WriteAnswer = {
  ...BASE,
  ok: true,
  op: "insert_row",
  dry_run: false,
  files_created: 1,
  planned_creates: ["datanotes/work/planning/task/X4.md"],
  migration_id: "20261102T064102-insert_row-insert-into-task",
};

describe("write answers", () => {
  it("recognizes a write answer", () => {
    expect(isWriteAnswer(ENUMS)).toBe(true);
    expect(isWriteAnswer(null)).toBe(false);
    expect(isWriteAnswer("x")).toBe(false);
    expect(isWriteAnswer({ ok: true, conflicts: [] })).toBe(false);
    expect(isWriteAnswer({ ok: "yes", conflicts: [], violations: [] })).toBe(false);
    expect(isWriteAnswer({ ok: true, conflicts: {}, violations: [] })).toBe(false);
  });

  it("groups violations by column, merging entries of one path; checks apart", () => {
    const merged: WriteAnswer = {
      ...ENUMS,
      violations: [
        ...ENUMS.violations,
        { path: "datanotes/work/planning/task/X1.md", violations: [{ column: "status", code: "required", message: "is required" }] },
        { path: "other.md", violations: [{ code: "unique", message: "duplicate" }, ...CHECK.violations[0]!.violations] },
        { path: "empty.md" } as never,
      ],
    };
    const one = violationsFor(merged, "datanotes/work/planning/task/X1.md");
    expect(one.byColumn.status!.map((v) => v.code)).toEqual(["enum", "required"]);
    expect(one.byColumn.priority).toHaveLength(1);
    expect(one.checks).toEqual([]);
    expect(one.other).toEqual([]);
    const all = violationsFor(merged);
    expect(all.checks).toEqual([CHECK.violations[0]!.violations[0]]);
    expect(all.other).toEqual([{ code: "unique", message: "duplicate" }]);
    expect(violationsFor(CHECK).checks[0]!.constraint).toBe("done_has_date");
  });

  it("summarizes a refusal", () => {
    expect(summarize(ENUMS)).toBe("Refused: 2 violations");
    expect(summarize(CHECK)).toBe("Refused: 1 violation");
    expect(
      summarize({ ...CHECK, conflicts: [{ path: "a", message: "m" }], failed: [{ path: "a", error: "e" }, { path: "b", error: "e" }] }),
    ).toBe("Refused: 1 violation, 1 conflict, 2 failures");
    expect(summarize({ ...BASE, ok: false, op: "x", dry_run: false, violations: [{ path: "a" } as never], conflicts: [{ path: "a", message: "m" }, { path: "b", message: "m" }], failed: [{ path: "a", error: "e" }] })).toBe(
      "Refused: 2 conflicts, 1 failure",
    );
    expect(summarize({ ...BASE, ok: false, op: "x", dry_run: false })).toBe("Refused");
    expect(summarize({ ...BASE, ok: false, op: "x", dry_run: false, failed: undefined as never })).toBe("Refused");
  });

  it("summarizes a dry run", () => {
    expect(summarize({ ...ENUMS, ok: true, violations: [] })).toBe("Dry run: 1 file to create");
    expect(
      summarize({
        ...BASE,
        ok: true,
        op: "x",
        dry_run: true,
        planned_edits: [{ path: "a" }, { path: "b" }],
        planned_creates: ["a", "b"],
        planned_moves: [{ from: "a", to: "b" }],
        planned_deletes: ["c", "d"],
      }),
    ).toBe("Dry run: 2 edits, 2 files to create, 1 file to move, 2 files to delete");
    expect(summarize({ ...BASE, ok: true, op: "x", dry_run: true })).toBe("Dry run: nothing to change");
    expect(summarize({ ok: true, op: "x", dry_run: true, conflicts: [], violations: [] } as never)).toBe("Dry run: nothing to change");
  });

  it("summarizes an applied write", () => {
    expect(summarize(DONE)).toBe("1 file created");
    expect(
      summarize({ ...DONE, notes_changed: 2, files_created: 2, files_moved: 1, files_deleted: 3, references_updated: 1 }),
    ).toBe("2 notes changed, 2 files created, 1 file moved, 3 files deleted, 1 reference updated");
    expect(summarize({ ...DONE, notes_changed: 1, files_created: 0, references_updated: 2 })).toBe("1 note changed, 2 references updated");
    expect(summarize({ ...DONE, files_created: 0 })).toBe("Nothing to change");
  });
});
