import { describe, expect, it } from "vitest";
import { describeRefusal } from "../src/api/results";
import { INDEX_RETRY } from "../src/core/engine";
import { updateRow } from "../src/core/rows";
import { createHandlers } from "../src/server/rest";
import { logVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

describe("update_row expect (compare-and-set)", () => {
  it("writes when the row still has the expected values", async () => {
    const v = logVault();
    const r = await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 2 }, expect: { kind: "alcohol", metric_drinks: 7 } });
    expect(r.ok).toBe(true);
    expect(v.read("Daily/a.md")).toContain("metric_drinks: 2");
  });

  it("refuses, writing nothing, when someone changed the row since it was read", async () => {
    const v = logVault();
    const before = v.read("Daily/a.md");
    const r = await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 2 }, expect: { metric_drinks: 5, kind: "alcohol" } });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ path: "Daily/a.md", message: "row changed: expected metric_drinks = 5, found 7 — read it again" }]);
    expect(v.read("Daily/a.md")).toBe(before);
    // a column the row does not have
    const missing = await updateRow(v.app, v.settings, { table: "log", path: "Daily/b.md", set: { metric_drinks: 1 }, expect: { metric_drinks: 0 } });
    expect(missing.conflicts[0]!.message).toMatch(/found null/);
  });

  it("its result, written or refused, names update_row, not the update_rows it runs on", async () => {
    const v = logVault();
    const stale = await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 2 }, expect: { metric_drinks: 5 } });
    expect(stale.op).toBe("update_row");
    expect(describeRefusal(stale as unknown as Record<string, unknown>)).toMatch(/^update_row refused — nothing was written:\nconflict Daily\/a\.md: row changed/);
    const invalid = await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: "many" } });
    expect(invalid).toMatchObject({ ok: false, op: "update_row" });
    expect(describeRefusal(invalid as unknown as Record<string, unknown>)).toMatch(/^update_row refused — nothing was written:\ninvalid Daily\/a\.md: metric_drinks /);
    expect(await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 2 } }, { dryRun: true })).toMatchObject({ ok: true, op: "update_row" });
    expect(await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 2 } })).toMatchObject({ ok: true, op: "update_row" });
  });

  it("is accepted by the /rows/update-one/ route", async () => {
    const v = logVault();
    const h = createHandlers(v.app, () => v.settings);
    const r = await h["/operations/update_row/"]!({ table: "log", id: "01a0f000-0000-7000-8000-00000000000b", set: { kind: "walk" }, expect: { kind: "alcohol" } });
    expect((r.json as { ok: boolean; conflicts: unknown[] }).conflicts).toHaveLength(1);
  });
});
