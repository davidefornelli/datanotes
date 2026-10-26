/** The day's packing of closed periods (src/core/auto-pack.ts), on a clock of the test's own. */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AutoPack } from "../src/core/auto-pack";
import { ChangeFeed } from "../src/core/change-feed";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { insertRow, select } from "../src/core/rows";
import type { NodeVault } from "../src/node/node-app";
import { createDbVault, TEST_DATABASE_FOLDER, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const TABLE = "main.public.feed";
const FOLDER = `${TEST_DATABASE_FOLDER}/main/public/feed`;
const MINUTE = 60_000;

/** A packed `feed` table with two rows of March 2025, written long ago. */
async function vault(settings: Record<string, unknown> = {}): Promise<DbVault> {
  const v = createDbVault({}, settings, { host: "node" });
  expect((await createTable(v.app, v.settings, described({
    name: "feed",
    timeColumn: "started_at",
    options: { pack: "{started_at:YYYY-MM}" },
    columns: [{ name: "started_at", type: "datetime", required: true }, { name: "minutes", type: "integer" }],
  }))).ok).toBe(true);
  for (const at of ["2025-03-01T08:00:00+01:00", "2025-03-02T08:00:00+01:00"]) expect((await insertRow(v.app, v.settings, { table: TABLE, values: { started_at: at, minutes: 5 } })).ok).toBe(true);
  const old = new Date("2025-04-01T00:00:00Z");
  for (const p of v.list()) if (p.startsWith(`${FOLDER}/`)) fs.utimesSync(v.abs(p), old, old);
  (v.app.vault as unknown as NodeVault).rescan();
  return v;
}

const packed = (v: DbVault) => v.app.packs!.packsOf(TABLE).flatMap((p) => p.rows);

describe("auto-pack", () => {
  it("packs once the engine has been quiet for 10 minutes, once a day, silently", async () => {
    const v = await vault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const job = new AutoPack(v.app, () => v.settings);
    // writes a minute ago: it waits
    expect(await job.tick(new Date(Date.now() + MINUTE))).toEqual({ ran: false });
    expect(packed(v)).toEqual([]);
    const later = new Date(Date.now() + 11 * MINUTE);
    const r = await job.tick(later);
    expect(r).toEqual({ ran: true, tables: { [TABLE]: { packs: 1, rows: 2 } } });
    expect(packed(v)).toHaveLength(2);
    expect(v.exists(`${FOLDER}/feed 2025-03.md`)).toBe(true);
    expect((await select(v.app, v.settings, { table: TABLE })).total).toBe(2);
    await feed.flush();
    expect((await feed.read()).events).toEqual([]);
    // the same day: nothing more
    expect(await job.tick(new Date(later.getTime() + MINUTE))).toEqual({ ran: false });
    feed.stop();
  });

  it("autoPack off: it never runs", async () => {
    const v = await vault({ autoPack: false });
    expect(await new AutoPack(v.app, () => v.settings).tick(new Date(Date.now() + 11 * MINUTE))).toEqual({ ran: false });
    expect(packed(v)).toEqual([]);
  });

  it("a table whose packing fails stays as it is, and the others are packed", async () => {
    const v = await vault();
    const job = new AutoPack(v.app, () => v.settings, async () => {
      throw new Error("disk full");
    });
    expect(await job.tick(new Date(Date.now() + 11 * MINUTE))).toEqual({ ran: true, tables: {}, failed: { [TABLE]: "disk full" } });
    expect(packed(v)).toEqual([]);
  });

  it("a refused or failed packing is reported with its reason; tables without pack are left alone; no database, nothing to do", async () => {
    const v = await vault();
    expect((await createTable(v.app, v.settings, described({ name: "other", options: { filename: "{name}" }, columns: [{ name: "name", type: "string" }] }))).ok).toBe(true);
    const answer = (extra: Record<string, unknown>) => async () => ({ ok: false, conflicts: [], failed: [], packs: [], ...extra }) as never;
    const later = new Date(Date.now() + 11 * MINUTE);
    expect((await new AutoPack(v.app, () => v.settings, answer({ conflicts: [{ path: "p", message: "in the way" }] })).tick(later)).failed).toEqual({ [TABLE]: "p: in the way" });
    expect((await new AutoPack(v.app, () => v.settings, answer({ failed: [{ path: "p", error: "disk full" }] })).tick(later)).failed).toEqual({ [TABLE]: "p: disk full" });
    expect((await new AutoPack(v.app, () => v.settings, answer({})).tick(later)).failed).toEqual({ [TABLE]: "refused" });
    // a packing that packs nothing, and one whose answer has no excluded rows
    expect(await new AutoPack(v.app, () => v.settings, async () => ({ ok: true, packs: [], conflicts: [], failed: [] }) as never).tick(later)).toEqual({ ran: true, tables: {} });
    expect(await new AutoPack(v.app, () => v.settings, async () => ({ ok: true, packs: [{ pack: "x", key: "k", rows: ["a"] }], conflicts: [], failed: [] }) as never).tick(later)).toEqual({ ran: true, tables: { [TABLE]: { packs: 1, rows: 1 } } });
    const empty = createDbVault({}, {}, { host: "node" });
    expect(await new AutoPack(empty.app, () => empty.settings).tick(later)).toEqual({ ran: true, tables: {} });
  });

  it("a host without packs: it never runs", async () => {
    const v = createDbVault({}, {}, { host: "fake" });
    expect(await new AutoPack(v.app, () => v.settings).tick(new Date(Date.now() + 11 * MINUTE))).toEqual({ ran: false });
  });
});
