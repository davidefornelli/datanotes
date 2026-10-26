/**
 * Packs changed by hand (an editor, git) while the engine runs: the host compares the pack with
 * what it had, row by row by id, and only the rows that changed get an event (src/node/pack-store.ts).
 * Packing and unpacking themselves give the change feed nothing.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ChangeFeed } from "../src/core/change-feed";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { insertRow, select, updateRow } from "../src/core/rows";
import { packRows, unpackRows } from "../src/core/pack-rows";
import type { NodeVault } from "../src/node/node-app";
import { createDbVault, TEST_DATABASE_FOLDER, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const TABLE = "main.public.feed";
const FOLDER = `${TEST_DATABASE_FOLDER}/main/public/feed`;
const PACK = `${FOLDER}/feed 2026-10.md`;
const NOW = new Date("2026-11-20T12:00:00Z");

async function packed(): Promise<{ v: DbVault; vault: NodeVault; feed: ChangeFeed }> {
  const v = createDbVault({}, {}, { host: "node" });
  const vault = v.app.vault as unknown as NodeVault;
  expect((await createTable(v.app, v.settings, described({
    name: "feed",
    timeColumn: "started_at",
    options: { pack: "{started_at:YYYY-MM}" },
    columns: [{ name: "started_at", type: "datetime", required: true }, { name: "minutes", type: "integer" }],
  }))).ok).toBe(true);
  for (const [started_at, minutes] of [["2026-10-01T08:00:00+02:00", 9], ["2026-10-02T14:22:14+02:00", 11]] as const) {
    expect((await insertRow(v.app, v.settings, { table: TABLE, values: { started_at, minutes } })).ok).toBe(true);
  }
  const old = new Date("2026-11-01T00:00:00Z");
  for (const p of v.list()) if (p.startsWith(`${FOLDER}/`)) fs.utimesSync(v.abs(p), old, old);
  vault.rescan();
  const feed = new ChangeFeed(v.app, () => v.settings);
  await feed.start();
  const r = await packRows(v.app, v.settings, { table: TABLE }, { now: NOW });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  await feed.flush();
  return { v, vault, feed };
}

/** Write a file by hand and let the host see it, as its watcher would. */
async function byHand(v: DbVault, vault: NodeVault, feed: ChangeFeed, rel: string, text: string | null): Promise<void> {
  if (text === null) fs.rmSync(v.abs(rel));
  else fs.writeFileSync(v.abs(rel), text);
  // a later mtime than the host's own write, whatever the file system's resolution
  if (text !== null) fs.utimesSync(v.abs(rel), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  vault.syncPaths([rel]);
  await feed.flush();
}

const events = async (feed: ChangeFeed) => (await feed.read()).events.map((e) => [e.op, e.path.split("/").pop(), e.source, e.changes ?? null]);

describe("packs changed by hand", () => {
  it("pack_rows and unpack_rows give the change feed no row event", async () => {
    const { v, feed } = await packed();
    expect(await events(feed)).toEqual([]);
    expect((await unpackRows(v.app, v.settings, { table: TABLE })).ok).toBe(true);
    await feed.flush();
    expect(await events(feed)).toEqual([]);
    feed.stop();
  });

  it("a value changed in a pack is one update of that row; a section added an insert, one taken away a delete", async () => {
    const { v, vault, feed } = await packed();
    await byHand(v, vault, feed, PACK, v.read(PACK).replace("minutes:: 9", "minutes:: 10"));
    expect(await events(feed)).toEqual([["update", "2026-10-01T0800.md", "external", { minutes: { before: 9, after: 10 } }]]);
    expect((await select(v.app, v.settings, { table: TABLE, where: { minutes: 10 } })).rows.map((r) => r.path)).toEqual([`${FOLDER}/2026-10-01T0800.md`]);

    const added = `${v.read(PACK)}\n## 2026-10-05T0900\nid:: 01a0f000-0000-7000-8000-0000000000ff\nstarted_at:: 2026-10-05T09:00:00+02:00\nminutes:: 3\n`;
    await byHand(v, vault, feed, PACK, added);
    expect((await feed.read({ since: 1 })).events.map((e) => [e.op, e.path.split("/").pop(), e.source])).toEqual([["insert", "2026-10-05T0900.md", "external"]]);

    const text = v.read(PACK);
    await byHand(v, vault, feed, PACK, text.slice(0, text.indexOf("\n## 2026-10-05T0900")) + "\n");
    expect((await feed.read({ since: 2 })).events.map((e) => [e.op, e.path.split("/").pop()])).toEqual([["delete", "2026-10-05T0900.md"]]);
    feed.stop();
  });

  it("a pack renamed by hand keeps its rows; a pack deleted takes them away", async () => {
    const { v, vault, feed } = await packed();
    const other = `${FOLDER}/feed 2026-10 copy.md`;
    fs.renameSync(v.abs(PACK), v.abs(other));
    vault.syncPaths([PACK, other]);
    await feed.flush();
    expect(await events(feed)).toEqual([]);
    expect((await select(v.app, v.settings, { table: TABLE })).total).toBe(2);
    await byHand(v, vault, feed, other, null);
    expect((await feed.read()).events.map((e) => e.op)).toEqual(["delete", "delete"]);
    expect((await select(v.app, v.settings, { table: TABLE })).total).toBe(0);
    feed.stop();
  });

  it("a pack that cannot be read keeps its rows and refuses writes until it is fixed", async () => {
    const { v, vault, feed } = await packed();
    const good = v.read(PACK);
    await byHand(v, vault, feed, PACK, good.replace("minutes:: 9", "minutes:: [9"));
    expect((await select(v.app, v.settings, { table: TABLE })).total).toBe(2);
    const w = await updateRow(v.app, v.settings, { table: TABLE, path: `${FOLDER}/2026-10-01T0800.md`, set: { minutes: 1 } });
    expect(w.ok).toBe(false);
    expect(JSON.stringify(w)).toMatch(/cannot be read/);
    await byHand(v, vault, feed, PACK, good.replace("minutes:: 9", "minutes:: 8"));
    const ok = await updateRow(v.app, v.settings, { table: TABLE, path: `${FOLDER}/2026-10-01T0800.md`, set: { minutes: 1 } });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(v.read(PACK)).toContain("minutes:: 1\n");
    feed.stop();
  });

  it("a note of its own at a packed row's path wins; when it goes, the row is back", async () => {
    const { v, vault, feed } = await packed();
    const row = `${FOLDER}/2026-10-01T0800.md`;
    const text = await v.app.vault.read(v.app.vault.getAbstractFileByPath(row) as never);
    await byHand(v, vault, feed, row, text.replace("minutes: 9", "minutes: 99"));
    expect(v.app.packs!.locate(row)).toBeNull();
    expect((await select(v.app, v.settings, { table: TABLE, where: { minutes: 99 } })).total).toBe(1);
    expect(v.read(PACK)).toContain("minutes:: 9\n"); // the section stays, aside
    await byHand(v, vault, feed, row, null);
    expect(v.app.packs!.locate(row)).not.toBeNull();
    expect((await select(v.app, v.settings, { table: TABLE, where: { minutes: 9 } })).total).toBe(1);
    feed.stop();
  });
});
