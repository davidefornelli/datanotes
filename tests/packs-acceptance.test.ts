/**
 * Packs of rows at scale, and what the engine's readers must not notice: 1,000 rows of three closed
 * months in three files, the same rows as notes of their own, the table's history unchanged,
 * concurrent writes on one pack, the link graph row by row.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY, logExternalEdits } from "../src/core/engine";
import { graphNeighbors } from "../src/core/graph";
import { describeHistory } from "../src/core/history";
import { packRows, unpackRows } from "../src/core/pack-rows";
import { insertRow, select, updateRow } from "../src/core/rows";
import type { NodeVault } from "../src/node/node-app";
import { createDbVault, TEST_DATABASE_FOLDER, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const TABLE = "main.public.reading";
const FOLDER = `${TEST_DATABASE_FOLDER}/main/public/reading`;
const NOW = new Date("2026-11-20T12:00:00Z");

/** A `reading` table packed by month (partitioned by year and month), with `rows` rows of July to September 2026 written as files. */
async function readings(rows: number): Promise<DbVault> {
  const v = createDbVault({}, {}, { host: "node" });
  expect((await createTable(v.app, v.settings, described({
    name: "reading",
    timeColumn: "at",
    options: { partition: "{at:YYYY/MM}", pack: "{at:YYYY-MM}" },
    columns: [{ name: "at", type: "datetime", required: true }, { name: "minutes", type: "integer" }, { name: "book", type: "link" }],
  }))).ok).toBe(true);
  const old = new Date("2026-10-01T00:00:00Z");
  // spread over July to September 2026
  const step = Math.floor((90 * 24 * 60) / rows) * 60_000;
  let t = Date.UTC(2026, 6, 1, 0, 0);
  for (let i = 0; i < rows; i++) {
    t += step;
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    const at = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    const rel = `${FOLDER}/${at.slice(0, 4)}/${at.slice(5, 7)}/${at.replace(":", "")}.md`;
    const id = `01a0f000-0000-7000-8000-${String(i).padStart(12, "0")}`;
    v.write(rel, `---\ntable: ${TABLE}\nid: ${id}\nat: ${at}\nminutes: ${i % 60}\n---\n${i % 10 === 0 ? `Session ${i}.\n` : ""}`);
    fs.utimesSync(v.abs(rel), old, old);
  }
  (v.app.vault as unknown as NodeVault).rescan();
  return v;
}

const all = async (v: DbVault) => (await select(v.app, v.settings, { table: TABLE, includeBody: true, columns: ["id", "at", "minutes", "file_modified"], orderBy: "at", limit: 1000 })).rows.map((r) => ({ ...r, path: r.path as string }) as Record<string, unknown> & { path: string });
const notesIn = (v: DbVault) => v.list().filter((p) => p.startsWith(`${FOLDER}/`)).length;

describe("packs at scale", () => {
  it("1,000 rows of three closed months: three files instead of 1,000, the same rows, the same history; unpack gives the same files", async () => {
    const v = await readings(1000);
    const months = new Set((await all(v)).map((r) => String(r.at).slice(0, 7)));
    expect(months.size).toBe(3);
    const before = await all(v);
    const texts = Object.fromEntries(v.list().filter((p) => p.startsWith(`${FOLDER}/`)).map((p) => [p, v.read(p)]));
    // the hand-written notes logged first, as the next write would log them
    await logExternalEdits(v.app, v.settings);
    const history = await describeHistory(v.app, v.settings, { table: TABLE });
    expect(notesIn(v)).toBe(1000);
    const r = await packRows(v.app, v.settings, { table: TABLE }, { now: NOW });
    expect(r.ok, JSON.stringify(r).slice(0, 500)).toBe(true);
    expect(r.packs).toHaveLength(3);
    expect(notesIn(v)).toBe(3);
    expect(await all(v)).toEqual(before);
    expect(await describeHistory(v.app, v.settings, { table: TABLE })).toEqual(history);
    // a new start on the same store reads the same rows
    const { openNodeVault } = await import("../src/node/node-app");
    const again = openNodeVault(v.root, undefined, { store: v.storeRoot });
    expect(await all({ ...v, app: again.app })).toEqual(before);
    again.metadataCache.dispose();
    const out = await unpackRows(v.app, v.settings, { table: TABLE });
    expect(out.ok).toBe(true);
    expect(notesIn(v)).toBe(1000);
    for (const [p, text] of Object.entries(texts)) expect(v.read(p)).toBe(text);
    expect(await all(v)).toEqual(before);
  }, 60_000);

  it("100 concurrent writes on rows of one pack: none is lost", async () => {
    const v = await readings(150);
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const rows = (await all(v)).slice(0, 100);
    const results = await Promise.all(rows.map((r, i) => updateRow(v.app, v.settings, { table: TABLE, path: r.path, set: { minutes: 1000 + i } })));
    expect(results.filter((x) => !x.ok).map((x) => JSON.stringify(x).slice(0, 300))).toEqual([]);
    const after = new Map((await all(v)).map((r) => [r.path, r.minutes]));
    rows.forEach((r, i) => expect(after.get(r.path)).toBe(1000 + i));
    // still in their packs
    expect(rows.every((r) => v.app.packs!.locate(r.path) !== null)).toBe(true);
    const packs = v.list().filter((p) => p.startsWith(`${FOLDER}/`) && path.posix.basename(p).startsWith("reading "));
    const text = packs.map((p) => v.read(p)).join("\n");
    rows.forEach((_, i) => expect(text).toContain(`minutes:: ${1000 + i}\n`));
  }, 60_000);

  it("the link graph of a packed row: its own links in and out, not those of the other rows of its pack", async () => {
    const v = await readings(20);
    v.write("Books/Moby-Dick.md", "---\ntitle: Moby-Dick\n---\nA book.\n");
    v.write("Books/Persuasion.md", "---\ntitle: Persuasion\n---\nA book.\n");
    const vault = v.app.vault as unknown as NodeVault;
    vault.syncPaths(["Books", "Books/Moby-Dick.md", "Books/Persuasion.md"]);
    const [a, b] = (await all(v)).map((r) => r.path);
    expect((await updateRow(v.app, v.settings, { table: TABLE, path: a!, set: { book: "[[Moby-Dick]]" } })).ok).toBe(true);
    expect((await updateRow(v.app, v.settings, { table: TABLE, path: b!, set: { book: "[[Persuasion]]" } })).ok).toBe(true);
    v.write("Journal/Day.md", `---\ntitle: day\n---\nRead [[${path.posix.basename(a!, ".md")}]].\n`);
    vault.syncPaths(["Journal", "Journal/Day.md"]);
    for (const p of v.list().filter((x) => x.startsWith(`${FOLDER}/`))) fs.utimesSync(v.abs(p), new Date("2026-10-01"), new Date("2026-10-01"));
    vault.rescan();
    const before = await graphNeighbors(v.app, v.settings, { from: { paths: [a!, b!] } });
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    expect(v.app.packs!.locate(a!)).not.toBeNull();
    const after = await graphNeighbors(v.app, v.settings, { from: { paths: [a!, b!] } });
    expect(after).toEqual(before);
    const edges = (i: number) => after.nodes[i]!.edges.map((e) => [e.direction, e.label, e.path]);
    expect(edges(0)).toEqual(expect.arrayContaining([["out", "book", "Books/Moby-Dick.md"], ["in", "link", "Journal/Day.md"]]));
    expect(edges(0)).not.toContainEqual(["out", "book", "Books/Persuasion.md"]);
    expect(edges(1)).toEqual([["out", "book", "Books/Persuasion.md"]]);
  });

  it("three packs of 500 rows read as the same rows as 1,500 notes of their own", async () => {
    const packed = await readings(1500);
    const singles = await readings(1500);
    expect((await packRows(packed.app, packed.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const strip = (rows: Awaited<ReturnType<typeof all>>) => rows.map(({ file_modified: _m, ...r }) => r);
    expect(strip(await all(packed))).toEqual(strip(await all(singles)));
    expect(notesIn(packed)).toBe(3);
  }, 60_000);
});
