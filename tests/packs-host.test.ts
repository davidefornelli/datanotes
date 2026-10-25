/**
 * Packs of rows on the headless host (src/node/pack-store.ts): the rows of a pack are listed as
 * notes of their own at their paths; packing and unpacking change nothing the engine reads.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { deleteRows, insertRow, select, updateRow } from "../src/core/rows";
import type { App } from "../src/core/host";
import { openNodeVault, type NodeHost } from "../src/node/node-app";
import { mergeWithDefaults, DEFAULT_SETTINGS } from "../src/core/settings";
import { createDbVault, TEST_DATABASE_FOLDER, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const TABLE = "main.public.feed";
const FOLDER = `${TEST_DATABASE_FOLDER}/main/public/feed`;

/** A `feed` table (rows named and partitioned by `started_at`) with rows in September and October 2026. */
async function feeds(): Promise<DbVault> {
  const v = createDbVault({}, {}, { host: "node" });
  const created = await createTable(v.app, v.settings, described({
    name: "feed",
    timeColumn: "started_at",
    columns: [
      { name: "started_at", type: "datetime", required: true },
      { name: "minutes", type: "integer" },
      { name: "side", type: "enum", values: ["left", "right"] },
    ],
  }));
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const rows: [string, number, string, string?][] = [
    ["2026-09-30T23:10:00+02:00", 7, "left"],
    ["2026-10-01T08:00:00+02:00", 9, "right", "Woke up hungry.\n"],
    ["2026-10-02T14:22:14+02:00", 11, "left"],
    ["2026-10-03T06:05:00+02:00", 12, "right", "\nA note with [[2026-10-01T0800]] in it.\n"],
  ];
  for (const [started_at, minutes, side, body] of rows) {
    const r = await insertRow(v.app, v.settings, { table: TABLE, values: { started_at, minutes, side }, ...(body ? { body } : {}) });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
  return v;
}

/** Every row with its values, path, text and file_modified. */
async function snapshot(app: App, v: DbVault) {
  const r = await select(app, v.settings, { table: TABLE, includeBody: true, columns: ["id", "started_at", "minutes", "side", "file_modified"], orderBy: "started_at" });
  return r.rows;
}

const october = (v: DbVault) => v.list().filter((p) => p.startsWith(`${FOLDER}/2026-10`));

describe("packs on the headless host", () => {
  it("pack: the rows keep their paths, values, texts and modification times; the notes go", async () => {
    const v = await feeds();
    const before = await snapshot(v.app, v);
    const texts = Object.fromEntries(october(v).map((p) => [p, v.read(p)]));
    expect(Object.keys(texts)).toHaveLength(3);
    const pack = `${FOLDER}/feed 2026-10.md`;
    await v.app.packs!.pack({ table: TABLE, key: "2026-10", path: pack, rows: Object.keys(texts), tableKey: "table" });
    expect(october(v)).toEqual([]);
    expect(v.exists(pack)).toBe(true);
    expect(await snapshot(v.app, v)).toEqual(before);
    for (const [p, text] of Object.entries(texts)) {
      expect(await v.app.vault.read(v.app.vault.getAbstractFileByPath(p) as never)).toBe(text);
      expect(v.app.packs!.locate(p)).toEqual({ pack, heading: path.posix.basename(p, ".md") });
    }
    expect(v.app.vault.getAbstractFileByPath(pack)).toBeNull();
    expect(v.app.packs!.packsOf(TABLE)).toEqual([{ path: pack, table: TABLE, key: "2026-10", rows: Object.keys(texts).sort() }]);

    // a new start finds the same rows, with the same times (the store keeps them)
    const again = openNodeVault(v.root, undefined, { store: v.storeRoot });
    const app2 = again.app;
    expect(await snapshot(app2, v)).toEqual(before);

    // unpack: the notes come back byte for byte, with their modification times
    await v.app.packs!.unpack(pack);
    expect(v.exists(pack)).toBe(false);
    for (const [p, text] of Object.entries(texts)) expect(v.read(p)).toBe(text);
    expect(await snapshot(v.app, v)).toEqual(before);
  });

  it("writes: an update that stays in the period changes the section; one that leaves it takes the row out", async () => {
    const v = await feeds();
    const rows = october(v);
    const pack = `${FOLDER}/feed 2026-10.md`;
    await v.app.packs!.pack({ table: TABLE, key: "2026-10", path: pack, rows, tableKey: "table" });
    const [first, second, third] = rows.sort();
    const u = await updateRow(v.app, v.settings, { table: TABLE, path: first!, set: { minutes: 10 } });
    expect(u.ok, JSON.stringify(u)).toBe(true);
    expect(v.exists(first!)).toBe(false);
    expect(v.read(pack)).toContain("minutes:: 10");
    const r = await select(v.app, v.settings, { table: TABLE, where: { minutes: 10 } });
    expect(r.rows.map((x) => x.path)).toEqual([first]);

    // the date moves to November: the row comes out of the pack, to its new path
    const moved = await updateRow(v.app, v.settings, { table: TABLE, path: second!, set: { started_at: "2026-11-02T14:22:14+02:00" } });
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    expect(v.app.packs!.locate(second!)).toBeNull();
    expect(v.list().some((p) => p.startsWith(`${FOLDER}/2026-11-02`))).toBe(true);
    expect(v.read(pack)).not.toContain("## 2026-10-02T1422");

    // a delete takes the row out of the pack
    const d = await deleteRows(v.app, v.settings, { table: TABLE, where: { minutes: 12 } });
    expect(d.ok, JSON.stringify(d)).toBe(true);
    expect(v.app.packs!.locate(third!)).toBeNull();
    expect(v.read(pack)).not.toContain("minutes:: 12");
    const all = await select(v.app, v.settings, { table: TABLE, orderBy: "started_at" });
    expect(all.rows.map((x) => x.minutes)).toEqual([7, 10, 11]);
  });
});

/** The host of a vault, for hand edits. */
export type { NodeHost };
export const _settings = mergeWithDefaults({ ...DEFAULT_SETTINGS });
export const _fs = fs;
