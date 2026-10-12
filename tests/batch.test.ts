import { describe, expect, it } from "vitest";
import { INDEX_RETRY, loadTable } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { listMigrations } from "../src/core/journal";
import { createPublicApi } from "../src/core/public-api";
import { createHandlers, dispatch } from "../src/server/rest";
import { logVault, LOG_DIR, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: { read(p: string): string }, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);

describe("batch", () => {
  it("applies every operation, journals one batch, and one undo reverts them all", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const r = await api.batch({
      summary: "evening",
      operations: [
        { op: "insertRow", table: "log", values: { kind: "alcohol", occurred_at: "2026-09-27T21:00", metric_drinks: 2 } },
        { op: "update_row", table: "log", path: "Daily/b.md", set: { metric_drinks: 1 } },
        described({ op: "addColumn", table: "log", column: { name: "place", type: "string" } }),
      ],
    });
    expect(r.ok, JSON.stringify(r.steps.map((s) => s.error ?? s.result?.violations))).toBe(true);
    expect(r.steps.map((s) => [s.op, s.ok])).toEqual([["insertRow", true], ["updateRow", true], ["addColumn", true]]);
    const created = `${LOG_DIR}/2026/09/27/2026-09-27 alcohol.md`;
    expect(v.exists(created)).toBe(true);
    expect(fm(v, "Daily/b.md").metric_drinks).toBe(1);

    const ops = await listMigrations(v.app, v.settings);
    const batch = ops.migrations.find((m) => m.op === "batch")!;
    expect(batch).toMatchObject({ migration_id: r.migration_id, summary: "evening" });
    expect(batch.members).toEqual(r.steps.map((s) => s.migration_id));
    expect(ops.migrations.filter((m) => m.batch === r.migration_id)).toHaveLength(3);

    const u = await api.undo(r.migration_id!);
    expect(u.ok).toBe(true);
    expect(v.exists(created)).toBe(false);
    expect(fm(v, "Daily/b.md")).not.toHaveProperty("metric_drinks");
    expect((await loadTable(v.app, v.settings, "log")).def.columns.map((c) => c.name)).not.toContain("place");
    expect((await api.undo(r.migration_id!)).conflicts[0]!.message).toMatch(/already undone/);
  });

  it("an undo refused part way leaves the operations after the refused one reverted (touched)", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const r = await api.batch({
      operations: [
        described({ op: "addColumn", table: "log", column: { name: "place", type: "string" } }),
        { op: "insertRow", table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } },
      ],
    });
    expect(r.ok).toBe(true);
    const created = `${LOG_DIR}/2026/09/28/2026-09-28 mood.md`;
    v.write(METASTORE, `${v.read(METASTORE)}# edited by hand\n`);
    const u = await api.undo(r.migration_id!);
    expect(u.ok).toBe(false);
    expect(u.conflicts.map((c) => c.path)).toEqual([METASTORE]);
    expect(v.exists(created)).toBe(false);
    expect(u.touched).toContain(created);
  });

  it("a refused operation rolls back the ones before it", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const r = await api.batch({
      operations: [
        { op: "insertRow", table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } },
        { op: "updateRow", table: "log", path: "Daily/a.md", set: { metric_drinks: 99 } }, // max 30
      ],
    });
    expect(r).toMatchObject({ ok: false, failed_at: 1, rolled_back: true });
    expect(r.steps[1]!.result!.violations[0]!.violations[0]!.code).toBe("max");
    expect(v.exists(`${LOG_DIR}/2026/09/28/2026-09-28 mood.md`)).toBe(false);
    expect(fm(v, "Daily/a.md").metric_drinks).toBe(7);
    expect((await listMigrations(v.app, v.settings, { op: "batch" })).total).toBe(0);
  });

  it("an operation that throws rolls back too; bad ops are refused before running", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const r = await api.batch({
      operations: [
        { op: "updateRow", table: "log", path: "Daily/b.md", set: { metric_drinks: 1 } },
        { op: "insertRow", table: "nope", values: {} },
      ],
    });
    expect(r).toMatchObject({ ok: false, failed_at: 1, rolled_back: true });
    expect(r.steps[1]!.error).toMatch(/Table not found/);
    expect(fm(v, "Daily/b.md")).not.toHaveProperty("metric_drinks");
    await expect(api.batch({ operations: [{ op: "explode" }] })).rejects.toThrow(/"op" must be one of/);
    await expect(api.batch({ operations: [] })).rejects.toThrow(/must not be empty/);
  });

  it("dry run checks each operation without writing", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const before = v.list();
    const r = await api.batch(
      { operations: [{ op: "updateRow", table: "log", path: "Daily/b.md", set: { metric_drinks: 1 } }, { op: "updateRow", table: "log", path: "Daily/a.md", set: { metric_drinks: 99 } }] },
      { dryRun: true },
    );
    expect(r).toMatchObject({ ok: false, dry_run: true });
    expect(r.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(v.list()).toEqual(before);
  });

  it("REST /batch/ takes snake_case operations, row routes and DDL", async () => {
    const v = logVault();
    const h = createHandlers(v.app, () => v.settings);
    const call = (body: unknown) => dispatch("/operations/batch/", h["/operations/batch/"]!, body);
    const ok = await call({
      operations: [
        { op: "insert_row", table: "log", values: { kind: "walk", occurred_at: "2026-09-29T18:00" } },
        described({ op: "add_column", table: "log", column: { name: "steps", type: "integer" } }),
      ],
    });
    expect(ok.status).toBe(200);
    expect((ok.json as { migration_id: string }).migration_id).toMatch(/batch/);
    const refused = await call({ operations: [{ op: "update_row", table: "log", path: "Daily/a.md", set: { metric_drinks: 99 } }] });
    expect(refused.status).toBe(422);
    expect((await call({ operations: [{ op: "nope" }] })).status).toBe(400);
    expect((await call({ operations: [] })).status).toBe(400);
  });

  it("an operation in a batch takes its arguments as the operation alone does (alter_table's history and row_template)", async () => {
    const v = logVault();
    const h = createHandlers(v.app, () => v.settings);
    const call = (body: unknown) => dispatch("/operations/batch/", h["/operations/batch/"]!, body);
    const entry = () => v.read(METASTORE);
    expect((await call({ operations: [{ op: "alter_table", table: "log", history: true, row_template: "## Notes\n" }] })).status).toBe(200);
    expect(entry()).toMatch(/history: true/);
    expect(entry()).toMatch(/row_template: \|?\s*## Notes/);
    expect((await call({ operations: [{ op: "alter_table", table: "log", history: "default", row_template: "" }] })).status).toBe(200);
    expect(entry()).not.toMatch(/history:/);
    expect(entry()).not.toMatch(/row_template/);
    // an argument the operation does not take refuses the batch, never ignored
    const old = await call({ operations: [{ op: "alter_table", table: "log", clear_row_template: true }] });
    expect(old).toMatchObject({ status: 400, json: { error: expect.stringMatching(/^operation 0: alter_table: unknown argument "clear_row_template"/) } });
  });
});
