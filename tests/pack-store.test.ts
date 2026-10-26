/**
 * The headless host's packs (src/node/pack-store.ts) case by case: what it refuses, packs it cannot
 * read, rows it cannot place, folders that move or go, its store file.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import type { TFile } from "../src/core/host";
import { deleteRows, insertRow, select } from "../src/core/rows";
import { packRows } from "../src/core/pack-rows";
import { writePack } from "../src/core/pack-format";
import { openNodeVault, type NodeVault } from "../src/node/node-app";
import { PACK_STATE_FILE } from "../src/node/pack-store";
import { createDbVault, TEST_DATABASE_FOLDER, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const TABLE = "main.public.feed";
const FOLDER = `${TEST_DATABASE_FOLDER}/main/public/feed`;
const PACK = `${FOLDER}/feed 2026-10.md`;
const NOW = new Date("2026-11-20T12:00:00Z");

const vaultOf = (v: DbVault) => v.app.vault as unknown as NodeVault;

/** A `feed` table (partitioned by year and month, packed by month) with three October rows, written long ago. */
async function feeds(settings: Record<string, unknown> = {}): Promise<DbVault> {
  const v = createDbVault({}, settings, { host: "node" });
  expect((await createTable(v.app, v.settings, described({
    name: "feed",
    timeColumn: "started_at",
    options: { partition: "{started_at:YYYY/MM}", pack: "{started_at:YYYY-MM}" },
    columns: [{ name: "started_at", type: "datetime", required: true }, { name: "minutes", type: "integer" }],
  }))).ok).toBe(true);
  for (const [at, m] of [["2026-10-01T08:00:00+02:00", 9], ["2026-10-02T14:22:00+02:00", 11], ["2026-10-03T06:05:00+02:00", 12]] as const) {
    expect((await insertRow(v.app, v.settings, { table: TABLE, values: { started_at: at, minutes: m } })).ok).toBe(true);
  }
  age(v);
  return v;
}

function age(v: DbVault): void {
  const old = new Date("2026-11-01T00:00:00Z");
  for (const p of v.list()) if (p.startsWith(`${FOLDER}/`)) fs.utimesSync(v.abs(p), old, old);
  vaultOf(v).rescan();
}

const row = (day: string) => `${FOLDER}/2026/10/2026-10-${day}.md`;
const minutes = async (v: DbVault) => (await select(v.app, v.settings, { table: TABLE, orderBy: "started_at" })).rows.map((r) => [r.path, r.minutes]);

describe("the pack store's own checks", () => {
  it("pack and unpack refuse what they cannot do", async () => {
    const v = await feeds();
    const packs = v.app.packs!;
    const rows = [row("01T0800"), row("02T1422")];
    v.write(`${FOLDER}/taken.md`, "---\ntitle: x\n---\n");
    await expect(packs.pack({ table: TABLE, key: "2026-10", path: `${FOLDER}/taken.md`, rows, tableKey: "table" })).rejects.toThrow(/exists and is not a pack/);
    await expect(packs.pack({ table: TABLE, key: "2026-10", path: PACK, rows: ["nope.md"], tableKey: "table" })).rejects.toThrow(/is not a note of its own/);
    // a row whose text has a ## heading
    const third = row("03T0605");
    fs.writeFileSync(v.abs(third), `${v.read(third)}\n## Part\n`);
    vaultOf(v).syncPaths([third]);
    await expect(packs.pack({ table: TABLE, key: "2026-10", path: PACK, rows: [third], tableKey: "table" })).rejects.toThrow(/cannot go into a pack: its text has a # or ## heading/);
    await expect(packs.pack({ table: TABLE, key: "2026-10", path: PACK, rows: [rows[0]!, rows[0]!], tableKey: "table" })).rejects.toThrow(/is not a note of its own|has a row named/);
    expect(await packs.pack({ table: TABLE, key: "2026-10", path: PACK, rows: [rows[0]!], tableKey: "table" })).toBe(PACK);
    await expect(packs.pack({ table: TABLE, key: "2026-11", path: PACK, rows: [rows[1]!], tableKey: "table" })).rejects.toThrow(/is the pack of main.public.feed for 2026-10/);
    // a second call adds to the pack
    await packs.pack({ table: TABLE, key: "2026-10", path: PACK, rows: [rows[1]!], tableKey: "table" });
    expect(packs.packsOf(TABLE)[0]!.rows).toEqual(rows);
    await expect(packs.unpack(`${FOLDER}/none.md`)).rejects.toThrow(/is not a pack/);
    await expect(packs.unpack(PACK, [third])).rejects.toThrow(/is not a row of/);
    expect(await packs.unpack(PACK, [rows[1]!])).toEqual([rows[1]]);
    expect(packs.packsOf(TABLE)[0]!.rows).toEqual([rows[0]]);
  });

  it("rows of a table named by another property than table: the pack says so", async () => {
    const v = createDbVault({}, { tableKey: "type" }, { host: "node" });
    expect((await createTable(v.app, v.settings, described({ name: "feed", timeColumn: "at", options: { pack: "{at:YYYY-MM}" }, columns: [{ name: "at", type: "datetime", required: true }] }))).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: TABLE, values: { at: "2026-10-01T08:00:00+02:00" } })).ok).toBe(true);
    age(v);
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const text = v.read(PACK);
    expect(text).toContain('table_key: "type"');
    expect(text).not.toContain("type::"); // the first property, naming the pack's table: from the pack
    const again = openNodeVault(v.root, undefined, { store: v.storeRoot });
    expect((await select(again.app, v.settings, { table: TABLE })).total).toBe(1);
    again.metadataCache.dispose();
  });

  it("files named as packs that are none stay notes; a pack the host cannot read keeps its rows out", async () => {
    const v = await feeds();
    for (const [name, text] of <[string, string][]>[
      ["feed plain.md", "just text\n"],
      ["feed open.md", "---\npack: x\n"],
      ["feed broken.md", "---\npack: [x\n---\n"],
      ["feed other.md", "---\ntitle: x\n---\n"],
    ]) v.write(`${FOLDER}/${name}`, text);
    v.write(`${FOLDER}/feed bad.md`, "---\npack: main.public.feed\nkey: 2026-01\n---\n\n## a\nn:: 1\n");
    const host = openNodeVault(v.root, undefined, { store: v.storeRoot });
    for (const name of ["feed plain.md", "feed open.md", "feed broken.md", "feed other.md", "feed bad.md"]) expect(host.vault.getAbstractFileByPath(`${FOLDER}/${name}`), name).not.toBeNull();
    expect(host.app.packs!.packsOf(TABLE)).toEqual([]);
    host.metadataCache.dispose();
  });

  it("a packs.json of another version, or that cannot be read, is set aside; one that cannot be written is a warning", async () => {
    const v = await feeds();
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const file = path.join(v.storeRoot, PACK_STATE_FILE);
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: {} }));
    let host = openNodeVault(v.root, undefined, { store: v.storeRoot });
    expect((await select(host.app, v.settings, { table: TABLE })).total).toBe(3);
    host.metadataCache.dispose();
    fs.writeFileSync(file, "{");
    host = openNodeVault(v.root, undefined, { store: v.storeRoot });
    expect((await select(host.app, v.settings, { table: TABLE })).total).toBe(3);
    host.metadataCache.dispose();
    // a store where packs.json cannot be written: a folder in its way
    const blocked = fs.mkdtempSync(path.join(path.dirname(v.storeRoot), "blocked-"));
    fs.mkdirSync(path.join(blocked, PACK_STATE_FILE, "x"), { recursive: true });
    host = openNodeVault(v.root, undefined, { store: blocked });
    expect((await select(host.app, v.settings, { table: TABLE })).total).toBe(3);
    host.metadataCache.dispose();
  });
});

describe("rows the host places", () => {
  it("a section whose values give no path, or another name, keeps its heading; a pack outside its table's folder, or without a metastore, names rows by heading", async () => {
    const v = await feeds();
    const extra = writePack({ table: TABLE, key: "2026-10" }, [
      { heading: "odd name", ordered: [["table", TABLE], ["id", "01a0f000-0000-7000-8000-0000000000a1"], ["started_at", "2026-10-09T10:00:00+02:00"]], body: "" },
      { heading: "no date", ordered: [["table", TABLE], ["id", "01a0f000-0000-7000-8000-0000000000a2"]], body: "" },
    ]);
    v.write(PACK, extra);
    vaultOf(v).syncPaths([PACK]);
    expect(v.app.packs!.packsOf(TABLE)[0]!.rows).toEqual([`${FOLDER}/2026/10/odd name.md`, `${FOLDER}/no date.md`]);
    // the same pack in a folder that is not its table's
    const away = `Archive/feed/feed 2026-10.md`;
    v.write(away, extra.replace(/0000000000a/g, "0000000000b"));
    vaultOf(v).syncPaths(["Archive", "Archive/feed", away]);
    expect(v.app.packs!.packsOf(TABLE).find((p) => p.path === away)!.rows).toEqual(["Archive/feed/no date.md", "Archive/feed/odd name.md"]);
    // a database whose metastore is gone: rows by heading next to the pack
    const host = openNodeVault(v.root, undefined, { store: v.storeRoot });
    fs.renameSync(v.abs(`${TEST_DATABASE_FOLDER}/metastore.yaml`), v.abs(`${TEST_DATABASE_FOLDER}/metastore.old`));
    const lone = `${FOLDER}/feed 2026-12.md`;
    v.write(lone, writePack({ table: TABLE, key: "2026-12" }, [{ heading: "h", ordered: [["table", TABLE], ["id", "01a0f000-0000-7000-8000-0000000000c1"], ["started_at", "2026-12-01T10:00:00+02:00"]], body: "" }]));
    host.vault.syncPaths([lone]);
    expect(host.app.packs!.packsOf(TABLE).find((p) => p.path === lone)!.rows).toEqual([`${FOLDER}/h.md`]);
    host.metadataCache.dispose();
  });

  it("a section renamed by hand is a rename; a row in two packs stays with the first; a note at a section's path wins", async () => {
    const v = await feeds();
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const events: string[] = [];
    vaultOf(v).events.on("rename", (f: TFile, old: string) => events.push(`rename ${old} -> ${f.path}`));
    const text = v.read(PACK);
    fs.writeFileSync(v.abs(PACK), text.replace("## 2026-10-01T0800\n", "## renamed\n"));
    fs.utimesSync(v.abs(PACK), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    vaultOf(v).syncPaths([PACK]);
    expect(events).toEqual([`rename ${row("01T0800")} -> ${FOLDER}/2026/10/renamed.md`]);
    // another pack holding a row of the first: the first keeps it
    const twin = `${FOLDER}/feed 2026-10 copy.md`;
    v.write(twin, text);
    vaultOf(v).syncPaths([twin]);
    expect(v.app.packs!.packsOf(TABLE).find((p) => p.path === twin)!.rows).toEqual([`${FOLDER}/2026/10/2026-10-01T0800.md`]);
    // a pack brought in while a note of its own holds one of its rows' paths: the note wins
    v.write(row("05T0000"), "---\ntable: main.public.feed\nid: 01a0f000-0000-7000-8000-0000000000d1\nstarted_at: 2026-10-05T00:00:00+02:00\n---\n");
    vaultOf(v).syncPaths([`${FOLDER}/2026/10`, row("05T0000")]);
    const mine = `${FOLDER}/feed 2026-10 more.md`;
    v.write(mine, writePack({ table: TABLE, key: "2026-10" }, [{ heading: "2026-10-05T0000", ordered: [["table", TABLE], ["id", "01a0f000-0000-7000-8000-0000000000d2"], ["started_at", "2026-10-05T00:00:00+02:00"]], body: "" }]));
    vaultOf(v).syncPaths([mine]);
    expect(v.app.packs!.packsOf(TABLE).find((p) => p.path === mine)!.rows).toEqual([]);
  });

  it("a write whose row changed id or path comes out; a write on a row a hand edit took away fails", async () => {
    const v = await feeds();
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const vault = vaultOf(v);
    const file = vault.getAbstractFileByPath(row("01T0800")) as TFile;
    await vault.process(file, (t) => t.replace(/^id: .*$/m, "id: 01a0f000-0000-7000-8000-0000000000e1"));
    expect(v.exists(row("01T0800"))).toBe(true); // out of the pack
    const second = vault.getAbstractFileByPath(row("02T1422")) as TFile;
    // the hand edit takes the row out of the pack, unseen by the watcher yet
    const text = v.read(PACK);
    fs.writeFileSync(v.abs(PACK), text.slice(0, text.indexOf("## 2026-10-02T1422")) + text.slice(text.indexOf("## 2026-10-03T0605")));
    fs.utimesSync(v.abs(PACK), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await expect(vault.process(second, (t) => t)).rejects.toThrow(/is not a row of a pack|changed on disk/);
  });
});

describe("folders that move or go", () => {
  it("the database folder moves: packs and rows follow; a folder of rows only stays without the disk", async () => {
    const v = await feeds();
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    // the partition folder 2026/10 was emptied and removed; the rows are still listed there
    expect(fs.existsSync(v.abs(`${FOLDER}/2026/10`))).toBe(false);
    expect(vaultOf(v).getAbstractFileByPath(`${FOLDER}/2026/10`)).not.toBeNull();
    expect(vaultOf(v).rescan()).toEqual([]);
    expect(await vaultOf(v).changedSinceWalk()).toEqual([]);
    expect(vaultOf(v).syncPaths([`${FOLDER}/2026/10`, `${FOLDER}/2026`])).toEqual([]);
    const before = await minutes(v);
    await configureDatabase(v.app, v.settings, { root: "Moved" }, async () => {});
    const moved = before.map(([p, m]) => [String(p).replace(`${TEST_DATABASE_FOLDER}/`, "Moved/"), m]);
    expect(await minutes(v)).toEqual(moved);
    expect(v.app.packs!.packsOf(TABLE).map((p) => p.path)).toEqual(["Moved/main/public/feed/feed 2026-10.md"]);
  });

  it("a folder of packs deleted or trashed: its rows go", async () => {
    const v = await feeds();
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const vault = vaultOf(v);
    // the year folder, all of whose rows are packed (it is not on disk): its rows go to the trash as notes
    await vault.trash(vault.getAbstractFileByPath(`${FOLDER}/2026`)!, true);
    expect(v.app.packs!.packsOf(TABLE)).toEqual([]);
    expect(v.exists(PACK)).toBe(false);
    expect(fs.readdirSync(v.abs(".trash/2026/10")).sort()).toEqual(["2026-10-01T0800.md", "2026-10-02T1422.md", "2026-10-03T0605.md"]);
    expect((await select(v.app, v.settings, { table: TABLE })).total).toBe(0);
    // packed again, the table's folder deleted with its pack
    for (const [at, m] of [["2026-10-04T08:00:00+02:00", 1], ["2026-10-05T08:00:00+02:00", 2]] as const) await insertRow(v.app, v.settings, { table: TABLE, values: { started_at: at, minutes: m } });
    age(v);
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).packs).toHaveLength(1);
    await vault.delete(vault.getAbstractFileByPath(FOLDER)!, true);
    expect(v.app.packs!.packsOf(TABLE)).toEqual([]);
    expect((await select(v.app, v.settings, { table: TABLE })).total).toBe(0);
  });

  it("delete_rows on packed rows, archived or deleted: they leave their pack", async () => {
    const v = await feeds();
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    expect((await deleteRows(v.app, v.settings, { table: TABLE, where: { minutes: 9 }, mode: "delete" } as never)).ok).toBe(true);
    expect((await deleteRows(v.app, v.settings, { table: TABLE, where: { minutes: 11 } } as never)).ok).toBe(true);
    expect(v.app.packs!.packsOf(TABLE)[0]!.rows).toEqual([row("03T0605")]);
    expect(v.list().some((p) => p.includes("_archive/2026-10-02T1422"))).toBe(true);
    // a trash of a packed row puts its note in .trash
    await vaultOf(v).trash(vaultOf(v).getAbstractFileByPath(row("03T0605"))!, true);
    expect(fs.readdirSync(v.abs(".trash")).some((n) => n.startsWith("2026-10-03T0605"))).toBe(true);
    expect(v.exists(PACK)).toBe(false);
  });
});

describe("notes named like packs", () => {
  it("a note named `<folder> <name>.md` that is no pack is still paired when moved by hand", async () => {
    const v = createDbVault({ "Tasks/Tasks one.md": "---\ntitle: one\n---\nA note long enough to be paired by its text.\n" }, {}, { host: "node" });
    const vault = vaultOf(v);
    const renames: string[] = [];
    vault.events.on("rename", (f: TFile, old: string) => renames.push(`${old} -> ${f.path}`));
    fs.mkdirSync(v.abs("Tasks/Done"));
    fs.renameSync(v.abs("Tasks/Tasks one.md"), v.abs("Tasks/Done/Tasks one.md"));
    vault.syncPaths(["Tasks/Tasks one.md", "Tasks/Done", "Tasks/Done/Tasks one.md"]);
    expect(renames).toEqual(["Tasks/Tasks one.md -> Tasks/Done/Tasks one.md"]);
    fs.renameSync(v.abs("Tasks/Done/Tasks one.md"), v.abs("Tasks/Tasks one.md"));
    expect(vault.rescan()).toContain("Tasks/Tasks one.md");
    expect(renames).toHaveLength(2);
  });
});

describe("a note turned into a pack by hand", () => {
  it("its rows take its place once the host reads it again", async () => {
    const v = await feeds();
    const note = `${FOLDER}/feed 2026-12.md`;
    v.write(note, "---\ntitle: soon a pack\n---\n");
    vaultOf(v).syncPaths([note]);
    expect(vaultOf(v).getAbstractFileByPath(note)).not.toBeNull();
    fs.writeFileSync(v.abs(note), writePack({ table: TABLE, key: "2026-12" }, [{ heading: "2026-12-01T1000", ordered: [["table", TABLE], ["id", "01a0f000-0000-7000-8000-0000000000f1"], ["started_at", "2026-12-01T10:00:00+02:00"]], body: "" }]));
    fs.utimesSync(v.abs(note), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    vaultOf(v).syncPaths([note]);
    await new Promise((r) => setTimeout(r, 10));
    expect(vaultOf(v).getAbstractFileByPath(note)).toBeNull();
    expect(v.app.packs!.packsOf(TABLE).map((p) => p.rows)).toEqual([[`${FOLDER}/2026/12/2026-12-01T1000.md`]]);
  });
});
