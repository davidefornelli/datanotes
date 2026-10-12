import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { undoMigration } from "../src/core/changeset";
import { INDEX_RETRY } from "../src/core/engine";
import { listMigrations, readJournal } from "../src/core/journal";
import { insertRow } from "../src/core/rows";
import { type DbVault, logVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const SEPT = "store:journal/2026-09.jsonl";
const TORN = '{"type":"migration","migration_id":"20260926T1';

async function insertMood(v: DbVault, at: string, occurred: string): Promise<string> {
  const r = await insertRow(v.app, v.settings, { table: "log", values: { kind: "mood", occurred_at: occurred } }, { now: new Date(at) });
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  return r.migration_id!;
}

describe("a torn last journal line (crash while appending)", () => {
  it("the next operation starts on a new line: it lists, reads and undoes, and so does its undo", async () => {
    const v = logVault();
    const a = await insertMood(v, "2026-09-26T08:00:00Z", "2026-09-26T07:00");
    fs.appendFileSync(v.abs(SEPT), TORN); // no newline after it
    const b = await insertMood(v, "2026-09-26T09:00:00Z", "2026-09-26T08:30");
    expect(v.read(SEPT).split("\n")[1]).toBe(TORN);
    expect((await listMigrations(v.app, v.settings)).migrations.map((m) => m.migration_id)).toEqual([b, a]);
    const [created] = (await readJournal(v.app, v.settings, b)).entry.creates;
    fs.appendFileSync(v.abs(SEPT), TORN); // the undo's mark lands after another torn line
    expect((await undoMigration(v.app, v.settings, b, new Date("2026-09-26T10:00:00Z"))).ok).toBe(true);
    expect(v.exists(created!)).toBe(false);
    expect((await readJournal(v.app, v.settings, b)).undone).toBe(true);
  });

  it("a journal written before the fix, with an entry glued to a torn line, still reads that entry", async () => {
    const v = logVault();
    const a = await insertMood(v, "2026-09-26T08:00:00Z", "2026-09-26T07:00");
    const b = await insertMood(v, "2026-09-26T09:00:00Z", "2026-09-26T08:30");
    const [la, lb] = v.read(SEPT).trim().split("\n");
    fs.writeFileSync(v.abs(SEPT), `${la}\n${TORN}${lb}\n{"type":"migr{"type":"undone","migr\n`);
    expect((await listMigrations(v.app, v.settings)).migrations.map((m) => m.migration_id)).toEqual([b, a]);
    expect((await readJournal(v.app, v.settings, b)).undone).toBe(false);
  });
});
