import { describe, expect, it } from "vitest";
import { insertRow } from "../src/core/rows";
import { createView } from "../src/core/catalog-ops";
import { INDEX_RETRY, undoOperation } from "../src/core/engine";
import { BLOB_MIN, compactJournal, listMigrations, readJournal } from "../src/core/journal";
import { appendLog, pruneLogs } from "../src/core/file-log";
import { FileLogger } from "../src/core/telemetry";
import { createDbVault, logVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const now = (iso: string) => ({ now: new Date(iso) });

describe("journal in the hidden store", () => {
  it("appends one line per operation, outside the vault's notes, and undoes from it", async () => {
    const v = logVault();
    const r = await insertRow(v.app, v.settings, { table: "log", path: "Daily/new", values: { kind: "mood", occurred_at: "2026-09-24T23:10" } }, now("2026-09-26T12:00:00Z"));
    expect(r.ok).toBe(true);
    expect(r.migration_id).toMatch(/^20260926T\d{6}-insert_row/);
    expect(v.list().filter((p) => p.includes("migrations") || p.startsWith("_meta"))).toEqual([]);
    const lines = v.read("store:journal/2026-09.jsonl").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "migration", op: "insert_row", migration_id: r.migration_id });
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok).toBe(true);
    expect(v.exists("Daily/new.md")).toBe(false);
    expect((await readJournal(v.app, v.settings, r.migration_id!)).undone).toBe(true);
    const again = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(again.conflicts[0]!.message).toMatch(/already undone/);
    const listed = await listMigrations(v.app, v.settings);
    expect(listed.migrations.map((m) => [m.op, m.undone])).toEqual([["undo_migration", false], ["insert_row", true]]);
  });

  it("stores large texts once as blobs, and compaction drops old entries and unused blobs", async () => {
    const v = createDbVault({});
    const big = "x".repeat(BLOB_MIN);
    for (const [i, day] of [[1, "2026-06-01"], [2, "2026-09-25"]] as const) {
      await createView(v.app, v.settings, { schema: "public", name: `v${i}`, description: big, query: { table: "system.information_schema.tables" } }, now(`${day}T10:00:00Z`));
    }
    const all = v.listAll();
    const blobs = all.filter((p) => p.startsWith("store:blobs/"));
    expect(blobs).toHaveLength(2); // 3 large texts (v1 after = v2 before): stored once each
    const line = v.read("store:journal/2026-09.jsonl");
    expect(line).toContain('"before_text":"blob:');
    // read back whole
    const id = JSON.parse(line.trim().split("\n")[0]!).migration_id as string;
    expect((await readJournal(v.app, v.settings, id)).entry.references[0]!.after_text).toContain(big);
    const res = await compactJournal(v.app, { ...v.settings, journalRetentionDays: 90 }, new Date("2026-10-01T00:00:00Z"));
    expect(res).toMatchObject({ kept: 1, dropped: 1, blobsRemoved: 0 }); // both blobs still used by the kept entry
    expect(v.exists("store:journal/2026-06.jsonl")).toBe(false);
    expect((await readJournal(v.app, v.settings, id)).entry.references[0]!.after_text).toContain(big);
    const all2 = await compactJournal(v.app, { ...v.settings, journalRetentionDays: 1 }, new Date("2026-10-01T00:00:00Z"));
    expect(all2).toMatchObject({ kept: 0, dropped: 1, blobsRemoved: 2 });
    expect(v.listAll().filter((p) => p.startsWith("store:"))).toEqual([]);
  });
});

describe("plugin log files", () => {
  it("writes JSON Lines per day and prunes old days", async () => {
    const v = createDbVault({});
    let t = Date.parse("2026-10-01T08:00:00Z");
    const logger = new FileLogger({ enabled: () => true, write: (day, lines) => appendLog(v.app, v.settings, day, lines), now: () => t });
    logger.log("INFO", "hello", { table: "x", n: 2, skip: undefined });
    t = Date.parse("2026-08-01T08:00:00Z");
    logger.log("WARN", "old");
    await logger.flush();
    const files = v.listAll().filter((p) => p.startsWith("store:logs/"));
    expect(files).toHaveLength(2);
    const today = files.find((f) => f.includes("2026-10-01"))!;
    expect(JSON.parse(v.read(today).trim())).toMatchObject({ level: "INFO", msg: "hello", table: "x", n: 2 });
    const removed = await pruneLogs(v.app, { ...v.settings, logRetentionDays: 30 }, new Date("2026-10-01T09:00:00Z"));
    expect(removed).toHaveLength(1);
    expect(v.listAll().filter((p) => p.startsWith("store:logs/"))).toEqual([today]);
  });
});
