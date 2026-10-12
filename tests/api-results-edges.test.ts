import { describe, expect, it } from "vitest";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { describeBatch, describeRefusal, resultOf } from "../src/api/results";
import { INDEX_RETRY } from "../src/core/engine";
import { createHandlers, dispatch } from "../src/server/rest";
import { type DbVault, logVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

/** Run an operation on the HTTP API's handlers, as the server would, and read the answer as a client does. */
async function call(v: DbVault, op: string, args: Record<string, unknown>) {
  const handlers = createHandlers(v.app, () => v.settings);
  const req = operationRequest(op, args);
  const route = req.path.slice(ROUTE_PREFIX.length);
  const res = await dispatch(route, handlers[route]!, req.body);
  return { status: res.status, json: res.json as Record<string, unknown>, result: resultOf(res.status, res.json, JSON.stringify(res.json)) };
}

const REFUSED = "refused — nothing was written";
const DOCS = "https://datanotes.dev";
const RANGE = (op: string) =>
  `Hint: Give a value inside the column's range (the message names the bound); describe_table shows its min and max. Then call ${op} again (dry_run: true checks without writing).\nDocs: ${DOCS}/guides/database-objects/tables.md#describe-a-table-before-writing-to-it (offline: read_docs("guides/database-objects/tables#describe-a-table-before-writing-to-it"))`;
const NO_TABLE = `Hint: Tables: log. list_tables lists them with their descriptions and aliases.\nDocs: ${DOCS}/guides/database-objects/tables.md#find-the-table-that-matches-a-request (offline: read_docs("guides/database-objects/tables#find-the-table-that-matches-a-request"))`;

describe("refusals of the engine, as the HTTP API answers them", () => {
  it("a refused insert names the row and each invalid value", async () => {
    const v = logVault();
    const r = await call(v, "insert_row", { table: "log", values: { kind: "nope", occurred_at: "2026-09-28T10:00" } });
    expect(r.status).toBe(422);
    expect(r.result).toEqual({
      ok: false,
      value:
        `insert_row ${REFUSED}:\ninvalid Datanotes/main/public/log/2026/09/28/2026-09-28 nope.md: kind must be one of: alcohol; mood; walk\n` +
        "Hint: Use one of the allowed values listed in the message, written exactly; describe_table shows what each one means. To add a value, alter_column the enum. Then call insert_row again (dry_run: true checks without writing).\n" +
        `Docs: ${DOCS}/guides/database-objects/columns.md#describe-what-each-enum-value-means (offline: read_docs("guides/database-objects/columns#describe-what-each-enum-value-means"))`,
    });
    // the JSON answer has them as fields of their own
    expect(r.json).toMatchObject({ hint: expect.stringMatching(/^Use one of the allowed values/), docs: `${DOCS}/guides/database-objects/columns.md#describe-what-each-enum-value-means` });
  });

  it("more than 20 problems are cut to 20 lines and a count of the rest", async () => {
    const walks: Record<string, string> = {};
    for (let i = 1; i <= 22; i++) {
      const n = String(i).padStart(2, "0");
      walks[`Daily/w${n}.md`] = `---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-0000000001${n}\nkind: walk\noccurred_at: 2026-09-${n}T07:00\n---\n`;
    }
    const v = logVault(walks);
    const r = await call(v, "update_rows", { table: "log", where: { kind: "walk" }, set: { metric_drinks: 99 } });
    expect(r.status).toBe(422);
    const lines = Array.from({ length: 20 }, (_, i) => `invalid Daily/w${String(i + 1).padStart(2, "0")}.md: metric_drinks must be <= 30`);
    expect(r.result).toEqual({ ok: false, value: `update_rows ${REFUSED}:\n${lines.join("\n")}\n... and 2 more\n${RANGE("update_rows")}` });
  });

  it("an undo refused for a conflict names the journal entry", async () => {
    const v = logVault();
    const done = await call(v, "update_row", { table: "log", path: "Daily/a.md", set: { metric_drinks: 3 } });
    const id = done.json.migration_id as string;
    expect((await call(v, "undo_migration", { migration_id: id })).status).toBe(200);
    const again = await call(v, "undo_migration", { migration_id: id });
    expect(again.status).toBe(409);
    const where = (again.json.conflicts as { path: string }[])[0]!.path;
    expect(where).toMatch(new RegExp(`^store:journal/\\d{4}-\\d{2}\\.jsonl#${id}$`));
    // an undo answer names its operation, like the other writes
    expect(again.result).toEqual({
      ok: false,
      value: `undo_migration ${REFUSED}:\nconflict ${where}: migration already undone\nHint: This write is undone already: to redo it, undo the undo (its migration_id is in list_migrations).\nDocs: ${DOCS}/guides/history/journal-and-undo.md#undo-a-write (offline: read_docs("guides/history/journal-and-undo#undo-a-write"))`,
    });
  });

  it("a refused batch names the refused operation and says the earlier ones were undone", async () => {
    const v = logVault();
    const r = await call(v, "batch", {
      operations: [
        { op: "insert_row", table: "log", values: { kind: "walk", occurred_at: "2026-09-28T11:00" } },
        { op: "update_row", table: "log", path: "Daily/b.md", set: { metric_drinks: 99 } },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.result).toEqual({
      ok: false,
      value:
        "batch refused at operation 1 — the operations before it were undone, nothing is left written:\n" +
        `operation 1 (update_row): update_row ${REFUSED}:\ninvalid Daily/b.md: metric_drinks must be <= 30\n${RANGE("update_row")}\n` +
        `Hint: Nothing is left written: fix operation 1 as its error says, then send the whole batch again.\nDocs: ${DOCS}/guides/read-and-write/batch.md#group-several-writes-with-batch (offline: read_docs("guides/read-and-write/batch#group-several-writes-with-batch"))`,
    });
    expect(v.exists("Datanotes/main/public/log/2026/09/28/2026-09-28 walk.md")).toBe(false);
  });

  it("a dry-run batch lists every operation that would be refused, errors included", async () => {
    const v = logVault();
    const r = await call(v, "batch", {
      dry_run: true,
      operations: [
        { op: "insert_row", table: "log", values: { kind: "walk", occurred_at: "2026-09-28T11:00" } },
        { op: "update_row", table: "nope", path: "Daily/b.md", set: { metric_drinks: 1 } },
        { op: "update_row", table: "log", path: "Daily/b.md", set: { metric_drinks: 99 } },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.result).toEqual({
      ok: false,
      value:
        "batch dry run: some operations would be refused:\n" +
        `operation 1 (update_row): Table not found: nope\n${NO_TABLE}\n` +
        `operation 2 (update_row): update_row ${REFUSED}:\ninvalid Daily/b.md: metric_drinks must be <= 30\n${RANGE("update_row")}\n` +
        `Hint: Fix the operations marked refused, then send the batch again (dry_run checks each one against the vault as it is now).\nDocs: ${DOCS}/guides/read-and-write/batch.md#group-several-writes-with-batch (offline: read_docs("guides/read-and-write/batch#group-several-writes-with-batch"))`,
    });
  });

  it("an error answer gives its message", async () => {
    const v = logVault();
    expect((await call(v, "select_rows", { table: "nope" })).result).toEqual({ ok: false, value: `Table not found: nope\n${NO_TABLE}` });
    expect((await call(v, "select_rows", { table: "logs" })).result).toEqual({ ok: false, value: `Table not found: logs\nHint: Did you mean "log"? Tables: log. list_tables lists them with their descriptions and aliases.\nDocs: ${DOCS}/guides/database-objects/tables.md#find-the-table-that-matches-a-request (offline: read_docs("guides/database-objects/tables#find-the-table-that-matches-a-request"))` });
    expect((await call(v, "undo_migration", { migration_id: "20260101T000000-insert_row-x" })).result).toEqual({
      ok: false,
      value: `Migration not found: 20260101T000000-insert_row-x\nHint: list_migrations lists the journal ids (migration_id) of the writes, newest first.\nDocs: ${DOCS}/guides/history/journal-and-undo.md#undo-a-write (offline: read_docs("guides/history/journal-and-undo#undo-a-write"))`,
    });
  });
});

describe("failed writes", () => {
  const failedUpdate = {
    ok: false,
    op: "update_rows",
    dryRun: false,
    migration_id: "20261008T091500-update_rows-update-log",
    notes_changed: 1,
    conflicts: [],
    violations: [],
    failed: [{ path: "Daily/b.md", error: "EBUSY: resource busy or locked, open 'Daily/b.md'" }],
  };

  it("name the journal entry that undoes what was applied", () => {
    expect(resultOf(500, failedUpdate, JSON.stringify(failedUpdate))).toEqual({
      ok: false,
      value:
        "update_rows failed (journal 20261008T091500-update_rows-update-log; use undo_migration to revert what was applied):\n" +
        "failed Daily/b.md: EBUSY: resource busy or locked, open 'Daily/b.md'",
    });
  });

  it("without a journal entry say only that they failed", () => {
    const { migration_id: _, ...unjournaled } = failedUpdate;
    expect(describeRefusal(unjournaled)).toBe("update_rows failed:\nfailed Daily/b.md: EBUSY: resource busy or locked, open 'Daily/b.md'");
  });

  it("list conflicts, then invalid values, then failures", () => {
    expect(
      describeRefusal({
        op: "move_rows",
        conflicts: [{ path: "Datanotes/main/public/task/Call Bob.md", message: "target exists" }],
        violations: [{ path: "Inbox/Call Bob.md", violations: [{ column: "due", message: "must be a date" }, { column: "status", message: "is required" }] }],
        failed: [{ path: "Inbox/Pay rent.md", error: "EPERM: operation not permitted" }],
      }),
    ).toBe(
      "move_rows failed:\n" +
        "conflict Datanotes/main/public/task/Call Bob.md: target exists\n" +
        "invalid Inbox/Call Bob.md: due must be a date\n" +
        "invalid Inbox/Call Bob.md: status is required\n" +
        "failed Inbox/Pay rent.md: EPERM: operation not permitted",
    );
  });
});

describe("describeRefusal on partial answers", () => {
  it("a refusal with nothing to list is only its head", () => {
    expect(describeRefusal({ ok: false, op: "drop_column", conflicts: [], violations: [], failed: [] })).toBe(`drop_column ${REFUSED}`);
  });

  it("missing lists count as empty", () => {
    expect(describeRefusal({ failed: [{ path: "Daily/a.md", error: "EACCES: permission denied" }] })).toBe("operation failed:\nfailed Daily/a.md: EACCES: permission denied");
    expect(describeRefusal({ op: "insert_row", violations: [{ path: "Daily/a.md" }] })).toBe(`insert_row ${REFUSED}`);
  });
});

describe("describeBatch", () => {
  it("a batch that could not be rolled back says what is left", () => {
    const answer = {
      ok: false,
      dryRun: false,
      steps: [
        { index: 0, op: "insert_row", ok: true, migration_id: "20261008T091500-insert_row-insert-into-log" },
        { index: 1, op: "move_rows", ok: false, error: "EPERM: operation not permitted, rename 'Inbox/a.md'" },
      ],
      failed_at: 1,
      rolled_back: false,
      rollback: [{ migration_id: "20261008T091500-insert_row-insert-into-log", ok: false, conflicts: [{ path: "Daily/c.md", message: "changed since the operation" }], failed: [] }],
    };
    expect(resultOf(500, answer, JSON.stringify(answer))).toEqual({
      ok: false,
      value:
        'batch failed at operation 1 and could NOT be fully rolled back: [{"migration_id":"20261008T091500-insert_row-insert-into-log","ok":false,"conflicts":[{"path":"Daily/c.md","message":"changed since the operation"}],"failed":[]}]:\n' +
        "operation 1 (move_rows): EPERM: operation not permitted, rename 'Inbox/a.md'",
    });
  });

  it("an operation that stopped with neither an error message nor a result reads 'refused'", () => {
    // what runBatch records for an operation that threw an Error with an empty message
    expect(describeBatch({ ok: false, dry_run: false, steps: [{ index: 0, op: "insert_row", ok: false }], failed_at: 0, rolled_back: true, rollback: [] })).toBe(
      "batch refused at operation 0 — the operations before it were undone, nothing is left written:\noperation 0 (insert_row): refused",
    );
  });

  it("a summary without failing steps is only its head", () => {
    expect(describeBatch({ dry_run: true })).toBe("batch dry run: some operations would be refused");
    expect(describeBatch({ dry_run: true, steps: [{ index: 0, op: "insert_row", ok: true }] })).toBe("batch dry run: some operations would be refused");
  });
});

describe("resultOf for answers that are not engine refusals", () => {
  it("a success is its JSON, or its text when the body is not JSON", () => {
    expect(resultOf(200, { tables: [] }, '{"tables":[]}')).toEqual({ ok: true, value: { tables: [] } });
    expect(resultOf(200, undefined, "# Dinner\n\nWith [[Alice]].\n")).toEqual({ ok: true, value: "# Dinner\n\nWith [[Alice]].\n" });
  });

  it("an error page that is not JSON gives its trimmed text", () => {
    expect(resultOf(502, undefined, "<html><body>502 Bad Gateway</body></html>\n")).toEqual({ ok: false, value: "<html><body>502 Bad Gateway</body></html>" });
  });

  it("an empty error body gives the HTTP status", () => {
    expect(resultOf(503, undefined, "")).toEqual({ ok: false, value: "HTTP 503" });
    expect(resultOf(504, undefined, " \n")).toEqual({ ok: false, value: "HTTP 504" });
  });

  it("JSON that is not an object, or an error that is not a string, gives the raw text", () => {
    expect(resultOf(500, "engine stopped", '"engine stopped"')).toEqual({ ok: false, value: '"engine stopped"' });
    expect(resultOf(500, { error: { code: "EBUSY" } }, '{"error":{"code":"EBUSY"}}')).toEqual({ ok: false, value: '{"error":{"code":"EBUSY"}}' });
  });
});
