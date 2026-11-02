// The Maintenance screen's vacuum and restore gate (src/ui/lib/maintenance.ts, plan P8-fix) against the
// real engine, through the browser's client: Apply after a preview deletes or restores exactly what the
// preview showed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "../src/ui/lib/api";
import { argsKey, asRestorePreview, asVacuumAnswer, canApply, restoreArgs, restoreHasWork, vacuumApplyArgs, vacuumArgs, vacuumConfirmText, vacuumHasWork, type Previewed, type VacuumAnswer } from "../src/ui/lib/maintenance";
import { openTestVault, type TestVault } from "./helpers/test-vault";

const TASK = "work.planning.task";
const PERSON = "work.planning.person";
const BUTTON = "datanotes/work/planning/task/Build the button component.md";

let vault: TestVault;
let api: ApiClient;

beforeAll(async () => {
  vault = await openTestVault("in-process");
  api = new ApiClient({ token: "test-vault-token", actor: { harness: "datanotes-ui", session: "ui-0123456789abcdef" }, base: vault.client.url });
}, 60_000);

afterAll(async () => {
  await vault?.stop();
});

/** The table's versions, newest first. */
async function versions(table: string): Promise<number[]> {
  return (await vault.ok<{ history: { version: number }[] }>("describe_history", { table })).history.map((v) => v.version);
}

async function estimate(): Promise<unknown> {
  return (await vault.ok<{ rows: Record<string, unknown>[] }>("select_rows", { table: TASK, where: { path: BUTTON }, limit: 1 })).rows[0]!.estimate_h;
}

describe("the Maintenance gate against the engine", () => {
  it("vacuum: Apply only for the previewed table and version; it keeps the version the confirmation named, even after a write in between", async () => {
    await vault.ok("update_row", { table: TASK, path: BUTTON, set: { estimate_h: 11 } });
    await vault.ok("update_row", { table: TASK, path: BUTTON, set: { estimate_h: 13 } });
    const built = vacuumArgs(TASK, "");
    expect(canApply(built, null, vacuumHasWork)).toBe(false);

    const dry = await api.op("vacuum_table", { ...built.args!, dry_run: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    const preview = asVacuumAnswer(dry.json, true)!;
    expect(preview).not.toBeNull();
    const latest = (await versions(TASK))[0]!;
    expect(preview.retained_from).toBe(latest);
    expect(preview.deleted.length).toBeGreaterThan(0);

    const seen: Previewed<VacuumAnswer> = { key: argsKey(built.args!), preview };
    expect(canApply(built, seen, vacuumHasWork)).toBe(true);
    expect(canApply(vacuumArgs(PERSON, ""), seen, vacuumHasWork)).toBe(false);
    expect(canApply(vacuumArgs(TASK, String(latest)), seen, vacuumHasWork)).toBe(false);
    expect(vacuumConfirmText(preview)).toContain(`Time travel before version ${latest} becomes impossible.`);
    expect(vacuumConfirmText(preview)).toContain(`${preview.deleted.length} log file`);

    // A write in between moves the latest version; Apply still keeps the one the confirmation named.
    await vault.ok("update_row", { table: TASK, path: BUTTON, set: { estimate_h: 14 } });
    const a = await api.op("vacuum_table", vacuumApplyArgs(built.args!, preview));
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const done = asVacuumAnswer(a.json, false)!;
    expect(done).not.toBeNull();
    expect(done.retained_from).toBe(latest);
    expect(done.deleted).toEqual(preview.deleted);
    expect(await versions(TASK)).toEqual([latest + 1, latest]);

    // Nothing is older than the kept version now.
    const again = vacuumArgs(TASK, String(latest));
    const d2 = await api.op("vacuum_table", { ...again.args!, dry_run: true });
    expect(d2.status, JSON.stringify(d2.json)).toBe(200);
    const p2 = asVacuumAnswer(d2.json, true)!;
    expect(p2.deleted).toEqual([]);
    expect(canApply(again, { key: argsKey(again.args!), preview: p2 }, vacuumHasWork)).toBe(false);
  });

  it("vacuum: a refused preview is no preview", async () => {
    const gone = await api.op("vacuum_table", { ...vacuumArgs(TASK, "0").args!, dry_run: true });
    expect(gone.status, JSON.stringify(gone.json)).toBe(400);
    expect(asVacuumAnswer(gone.json, true)).toBeNull();
    const unknown = await api.op("vacuum_table", { table: "nope", dry_run: true });
    expect(unknown.status, JSON.stringify(unknown.json)).toBe(404);
    expect(asVacuumAnswer(unknown.json, true)).toBeNull();
  });

  it("restore: Apply only for the previewed moment; it restores what the preview listed", async () => {
    const before = await estimate();
    const w = await vault.ok<{ migration_id: string }>("update_row", { table: TASK, path: BUTTON, set: { estimate_h: 20 } });
    const built = restoreArgs("before_migration", w.migration_id);
    const dry = await api.op("restore_database", { ...built.args!, dry_run: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    const preview = asRestorePreview(dry.json)!;
    expect(preview).not.toBeNull();
    expect(preview.tables.map((t) => [t.table, t.action, t.texts])).toEqual([[TASK, "restore", [BUTTON]]]);

    const seen = { key: argsKey(built.args!), preview };
    expect(canApply(built, seen, restoreHasWork)).toBe(true);
    expect(canApply(restoreArgs("timestamp", w.migration_id), seen, restoreHasWork)).toBe(false);
    expect(canApply(restoreArgs("timestamp", preview.restored_to), seen, restoreHasWork)).toBe(false);

    const a = await api.op<{ ok?: unknown; migration_id?: unknown }>("restore_database", { ...built.args!, dry_run: false });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.ok).toBe(true);
    expect(typeof a.json.migration_id).toBe("string");
    expect(await estimate()).toEqual(before);
  });

  it("restore: a moment with nothing to change, or a refused one, leaves Apply off", async () => {
    const now = restoreArgs("timestamp", new Date().toISOString());
    const dry = await api.op("restore_database", { ...now.args!, dry_run: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    const preview = asRestorePreview(dry.json)!;
    expect(preview.tables).toEqual([]);
    expect(canApply(now, { key: argsKey(now.args!), preview }, restoreHasWork)).toBe(false);

    const refused = await api.op("restore_database", { before_migration: "nope", dry_run: true });
    expect(refused.status, JSON.stringify(refused.json)).toBe(404);
    expect(asRestorePreview(refused.json)).toBeNull();
  });
});
