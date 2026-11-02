// The Maintenance screen's gate for vacuum_table and restore_database (src/ui/lib/maintenance.ts), plan
// P8-fix (R2w3-1): Apply only after a dry run that passed with the same arguments and found something,
// the argument builders, the answer parsers and the texts of the previews and confirmations.

import { describe, expect, it } from "vitest";
import {
  argsKey,
  asRestorePreview,
  asVacuumAnswer,
  canApply,
  MIGRATION_ERROR,
  PICK_TABLE,
  restoreArgs,
  restoreConfirmText,
  restoreHasWork,
  restorePreviewText,
  restoreRowChanges,
  restoreTableLine,
  TIMESTAMP_ERROR,
  vacuumApplyArgs,
  vacuumArgs,
  vacuumConfirmText,
  vacuumDoneText,
  vacuumHasWork,
  vacuumPreviewText,
  VERSION_ERROR,
  type Built,
  type Previewed,
  type RestoreArgs,
  type RestoreBy,
  type RestorePreview,
  type RestoreTable,
  type VacuumAnswer,
  type VacuumArgs,
} from "../src/ui/lib/maintenance";

const TASK = "work.planning.task";
const SEG = "store:transaction_log/work.planning.task/00000000000000000000.segment.jsonl";
const ONE: VacuumAnswer = { table: TASK, retained_from: 2, deleted: [SEG] };
const NONE: VacuumAnswer = { table: TASK, retained_from: 0, deleted: [] };
const AT = "2026-11-02T08:21:46.918Z";
const ROW = "datanotes/work/planning/task/Build the button component.md";
const T1: RestoreTable = { table: TASK, action: "restore", creates: [], texts: [ROW], deletes: [], archived: [] };
const PREVIEW: RestorePreview = { restored_to: AT, tables: [T1], unchanged: ["work.planning.person"], skipped: [] };
const EMPTY: RestorePreview = { restored_to: AT, tables: [], unchanged: [TASK], skipped: [] };

describe("argsKey", () => {
  it("ignores the order of the keys and dry_run", () => {
    expect(argsKey({ table: "t", retain_from_version: 2 })).toBe(argsKey({ retain_from_version: 2, table: "t", dry_run: true }));
  });

  it("differs when a name or a value differs", () => {
    expect(argsKey({ table: "t" })).not.toBe(argsKey({ table: "u" }));
    expect(argsKey({ timestamp: "x" })).not.toBe(argsKey({ before_migration: "x" }));
    expect(argsKey({ table: "t" })).not.toBe(argsKey({ table: "t", retain_from_version: 0 }));
  });
});

describe("canApply: Apply only after a preview of the same arguments (R2w3-1)", () => {
  it("is false before any preview", () => {
    expect(canApply(vacuumArgs(TASK, ""), null, vacuumHasWork)).toBe(false);
    expect(canApply(restoreArgs("timestamp", AT), null, restoreHasWork)).toBe(false);
  });

  it("is true after a preview of the same arguments that found something", () => {
    const built = vacuumArgs(TASK, "");
    const seen: Previewed<VacuumAnswer> = { key: argsKey(built.args!), preview: ONE };
    expect(canApply(built, seen, vacuumHasWork)).toBe(true);
    expect(canApply(vacuumArgs(TASK, "  "), seen, vacuumHasWork)).toBe(true);
  });

  it("is false again when the table or the version changes", () => {
    const built = vacuumArgs(TASK, "");
    const seen: Previewed<VacuumAnswer> = { key: argsKey(built.args!), preview: ONE };
    expect(canApply(vacuumArgs("work.planning.person", ""), seen, vacuumHasWork)).toBe(false);
    expect(canApply(vacuumArgs(TASK, "2"), seen, vacuumHasWork)).toBe(false);
    expect(canApply(vacuumArgs(TASK, "x"), seen, vacuumHasWork)).toBe(false);
  });

  it("is false when the preview found nothing", () => {
    expect(canApply(vacuumArgs(TASK, ""), { key: argsKey({ table: TASK }), preview: NONE }, vacuumHasWork)).toBe(false);
  });

  it("restore: is true for the previewed moment, false again when the mode or the moment changes", () => {
    const built = restoreArgs("timestamp", AT);
    const seen: Previewed<RestorePreview> = { key: argsKey(built.args!), preview: PREVIEW };
    expect(canApply(built, seen, restoreHasWork)).toBe(true);
    expect(canApply(restoreArgs("timestamp", ` ${AT} `), seen, restoreHasWork)).toBe(true);
    expect(canApply(restoreArgs("before_migration", AT), seen, restoreHasWork)).toBe(false);
    expect(canApply(restoreArgs("timestamp", "2026-11-01"), seen, restoreHasWork)).toBe(false);
    expect(canApply(restoreArgs("timestamp", ""), seen, restoreHasWork)).toBe(false);
    expect(canApply(built, { key: seen.key, preview: EMPTY }, restoreHasWork)).toBe(false);
  });
});

describe("vacuumArgs", () => {
  it("builds the table and the optional version", () => {
    expect(vacuumArgs(TASK, "")).toEqual({ args: { table: TASK }, error: null });
    expect(vacuumArgs(TASK, " 7 ")).toEqual({ args: { table: TASK, retain_from_version: 7 }, error: null });
    expect(vacuumArgs(TASK, "0")).toEqual({ args: { table: TASK, retain_from_version: 0 }, error: null });
  });

  it("asks for a table", () => {
    expect(vacuumArgs("", "3")).toEqual({ args: null, error: PICK_TABLE });
  });

  it("refuses a version that is not a whole number, 0 or more", () => {
    for (const text of ["-1", "1.5", "1e3", "x", "99999999999999999999"]) {
      const built: Built<VacuumArgs> = vacuumArgs(TASK, text);
      expect(built, text).toEqual({ args: null, error: VERSION_ERROR });
    }
  });
});

describe("asVacuumAnswer", () => {
  it("reads an answer with the expected dry_run", () => {
    expect(asVacuumAnswer({ ...ONE, dry_run: true }, true)).toEqual(ONE);
    expect(asVacuumAnswer({ ...ONE, dry_run: false }, false)).toEqual(ONE);
  });

  it("is null for anything else", () => {
    expect(asVacuumAnswer({ ...ONE, dry_run: true }, false)).toBeNull();
    expect(asVacuumAnswer(null, true)).toBeNull();
    expect(asVacuumAnswer("x", true)).toBeNull();
    expect(asVacuumAnswer([], true)).toBeNull();
    expect(asVacuumAnswer({ ...ONE, retained_from: "2", dry_run: true }, true)).toBeNull();
    expect(asVacuumAnswer({ ...ONE, deleted: [1], dry_run: true }, true)).toBeNull();
    expect(asVacuumAnswer({ retained_from: 2, deleted: [], dry_run: true }, true)).toBeNull();
    expect(asVacuumAnswer({ error: "Table not found: nope" }, true)).toBeNull();
  });
});

describe("vacuum texts", () => {
  it("says what the dry run found", () => {
    expect(vacuumPreviewText(NONE)).toBe("Nothing to delete: work.planning.task has no log file older than version 0.");
    expect(vacuumPreviewText(ONE)).toBe("Apply deletes 1 log file of work.planning.task. Time travel then starts at version 2.");
    expect(vacuumPreviewText({ ...ONE, deleted: [SEG, "b"] })).toContain("Apply deletes 2 log files of");
  });

  it("names the real version and the number of files (R2w3-1)", () => {
    const text = vacuumConfirmText(ONE);
    expect(text).toBe("1 log file of work.planning.task will be deleted. Time travel before version 2 becomes impossible. This cannot be undone.");
    expect(text).not.toContain("version N");
  });

  it("applies with the version the preview kept", () => {
    expect(vacuumApplyArgs({ table: "task" }, ONE)).toEqual({ table: "task", retain_from_version: 2, dry_run: false });
    expect(vacuumApplyArgs({ table: TASK, retain_from_version: 2 }, ONE)).toEqual({ table: TASK, retain_from_version: 2, dry_run: false });
  });

  it("says what the vacuum did, and whether a preview found work", () => {
    expect(vacuumDoneText(ONE)).toBe("Deleted 1 log file of work.planning.task. Time travel now starts at version 2.");
    expect(vacuumHasWork(ONE)).toBe(true);
    expect(vacuumHasWork(NONE)).toBe(false);
  });
});

describe("restoreArgs", () => {
  it("builds one moment, by time or by operation", () => {
    const by: RestoreBy = "timestamp";
    const built: Built<RestoreArgs> = restoreArgs(by, ` ${AT} `);
    expect(built).toEqual({ args: { timestamp: AT }, error: null });
    expect(restoreArgs("before_migration", "m1")).toEqual({ args: { before_migration: "m1" }, error: null });
  });

  it("asks for the moment when it is empty", () => {
    expect(restoreArgs("timestamp", " ")).toEqual({ args: null, error: TIMESTAMP_ERROR });
    expect(restoreArgs("before_migration", "")).toEqual({ args: null, error: MIGRATION_ERROR });
  });
});

describe("asRestorePreview", () => {
  const json = {
    ok: true,
    op: "restore_database",
    dry_run: true,
    conflicts: [],
    violations: [],
    restored_to: AT,
    tables: [{ ...T1, version: 2, definition_changed: false }],
    unchanged: ["work.planning.person"],
    skipped: [{ table: "main.x.y", reason: "no transaction log" }],
  };

  it("reads a dry run that passed", () => {
    expect(asRestorePreview(json)).toEqual({ restored_to: json.restored_to, tables: json.tables, unchanged: json.unchanged, skipped: json.skipped });
  });

  it("is null for a refusal, an error, a real run or a malformed answer", () => {
    for (const bad of [
      null,
      "x",
      { ...json, ok: false },
      { ...json, dry_run: false },
      { ...json, restored_to: 5 },
      { ...json, tables: "x" },
      { ...json, tables: [{ ...T1, texts: [3] }] },
      { ...json, unchanged: [1] },
      { ...json, skipped: "x" },
      { ...json, skipped: [{ table: "t", reason: 1 }] },
      { error: "Migration not found: nope" },
    ]) {
      expect(asRestorePreview(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("restore texts", () => {
  it("counts the row changes", () => {
    expect(restoreRowChanges([])).toBe("no row changes");
    expect(restoreRowChanges([T1])).toBe("1 row gets its old text");
    expect(
      restoreRowChanges([
        {
          ...T1,
          creates: ["a"],
          texts: ["b", "c"],
          deletes: ["d"],
          archived: [
            { from: "e", to: "f" },
            { from: "g", to: "h" },
          ],
        },
      ]),
    ).toBe("1 row re-created, 2 rows get their old text, 1 row deleted, 2 rows archived");
    expect(restoreRowChanges([{ ...T1, texts: [], creates: ["a", "b"], deletes: ["x", "y"], archived: [{ from: "e", to: "f" }] }])).toBe(
      "2 rows re-created, 2 rows deleted, 1 row archived",
    );
    expect(restoreRowChanges([T1, { ...T1, table: "work.planning.project" }])).toBe("2 rows get their old text");
  });

  it("says what the dry run found", () => {
    expect(restorePreviewText(EMPTY)).toBe("Nothing to restore: every table with a log is already as it was at 2026-11-02T08:21:46.918Z.");
    expect(restorePreviewText(PREVIEW)).toBe("Apply restores 1 table to 2026-11-02T08:21:46.918Z: 1 row gets its old text.");
    expect(restorePreviewText({ ...PREVIEW, tables: [T1, { ...T1, table: "work.planning.project" }] })).toContain("Apply restores 2 tables to");
  });

  it("describes one table", () => {
    expect(restoreTableLine(T1)).toBe("work.planning.task: restore (1 row gets its old text)");
    expect(restoreTableLine({ ...T1, action: "recreate", texts: [] })).toBe("work.planning.task: recreate (no row changes)");
  });

  it("confirms with the moment, the tables, the rows and the tables skipped", () => {
    expect(restoreConfirmText(PREVIEW)).toBe(
      "1 table goes back to 2026-11-02T08:21:46.918Z: 1 row gets its old text. Changes made since then are undone. You can undo the restore from the journal.",
    );
    expect(restoreConfirmText({ ...PREVIEW, skipped: [{ table: "main.x.y", reason: "no transaction log" }] })).toBe(
      "1 table goes back to 2026-11-02T08:21:46.918Z: 1 row gets its old text. 1 table has no history that far back and stays as it is. Changes made since then are undone. You can undo the restore from the journal.",
    );
    expect(
      restoreConfirmText({
        ...PREVIEW,
        tables: [T1, { ...T1, table: "work.planning.project" }],
        skipped: [
          { table: "main.x.y", reason: "no transaction log" },
          { table: "main.x.z", reason: "no transaction log" },
        ],
      }),
    ).toBe(
      "2 tables go back to 2026-11-02T08:21:46.918Z: 2 rows get their old text. 2 tables have no history that far back and stay as they are. Changes made since then are undone. You can undo the restore from the journal.",
    );
  });

  it("knows whether a preview found work", () => {
    expect(restoreHasWork(PREVIEW)).toBe(true);
    expect(restoreHasWork(EMPTY)).toBe(false);
  });
});
