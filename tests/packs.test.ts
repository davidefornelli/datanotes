/**
 * Packs of rows end to end (src/core/pack-rows.ts on the headless host): the table options, the
 * operations pack_rows / unpack_rows, their journal and undo, the links that follow the rows.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY, onApplied, undoOperation, type AppliedOperation } from "../src/core/engine";
import { alterTable, insertRow, select, updateRow } from "../src/core/rows";
import { describeTable } from "../src/core/public-api";
import { graphNeighbors } from "../src/core/graph";
import { packRows, unpackRows } from "../src/core/pack-rows";
import { createDbVault, TEST_DATABASE_FOLDER, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";
/** The hint and docs an error of the engine carries. */
const guided = (e: unknown) => e as { hint: string; docs: string };

INDEX_RETRY.delayMs = 1;

const TABLE = "main.public.feed";
const FOLDER = `${TEST_DATABASE_FOLDER}/main/public/feed`;
const PACK = `${FOLDER}/feed 2026-10.md`;
/** A day well after October 2026 closed (7 days after its end). */
const NOW = new Date("2026-11-20T12:00:00Z");

/** Make the notes of a vault look written long ago (the 24-hour rule of pack_rows). */
function age(v: DbVault, prefix = FOLDER): void {
  const old = new Date("2026-11-01T00:00:00Z");
  for (const p of v.list()) if (p.startsWith(`${prefix}/`)) fs.utimesSync(v.abs(p), old, old);
  // the host learns the new stats as its watcher would
  (v.app.vault as unknown as { rescan(): void }).rescan();
}

/** A `feed` table packed by month, with rows in September, October and November 2026, and a note linking to one. */
async function feeds(options: Record<string, unknown> = { pack: "{started_at:YYYY-MM}" }): Promise<DbVault> {
  const v = createDbVault({}, {}, { host: "node" });
  const created = await createTable(v.app, v.settings, described({
    name: "feed",
    timeColumn: "started_at",
    options,
    columns: [
      { name: "started_at", type: "datetime", required: true },
      { name: "minutes", type: "integer" },
      { name: "baby", type: "link" },
    ],
  }));
  expect(created.ok, JSON.stringify(created)).toBe(true);
  for (const [started_at, minutes, body] of [
    ["2026-09-30T23:10:00+02:00", 7, ""],
    ["2026-10-01T08:00:00+02:00", 9, "Woke up hungry.\n"],
    ["2026-10-02T14:22:14+02:00", 11, ""],
    ["2026-10-03T06:05:00+02:00", 12, "\n# A big heading keeps it out\n"],
    ["2026-11-02T06:05:00+02:00", 5, ""],
  ] as const) {
    const r = await insertRow(v.app, v.settings, { table: TABLE, values: { started_at, minutes }, ...(body ? { body } : {}) });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
  v.write("Journal/Day.md", "---\ntitle: day\n---\nFed at [[2026-10-01T0800]] and [[2026-10-02T1422|later]].\n");
  (v.app.vault as unknown as { syncPath(p: string): void }).syncPath("Journal/Day.md");
  age(v);
  return v;
}

const rowsOf = async (v: DbVault) =>
  (await select(v.app, v.settings, { table: TABLE, includeBody: true, columns: ["id", "started_at", "minutes", "file_modified"], orderBy: "started_at" })).rows;

describe("the pack options", () => {
  it("create_table and alter_table keep pack and pack_after_days; describe_table shows them", async () => {
    const v = await feeds({ pack: "{started_at:YYYY-MM}", pack_after_days: 3 });
    expect((await describeTable(v.app, v.settings, TABLE)).options).toMatchObject({ pack: "{started_at:YYYY-MM}", pack_after_days: 3 });
    expect(v.read(`${TEST_DATABASE_FOLDER}/metastore.yaml`)).toMatch(/pack: "?\{started_at:YYYY-MM\}"?/);
    const a = await alterTable(v.app, v.settings, { table: TABLE, pack: "{started_at:YYYY}", packAfterDays: 0 });
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect((await describeTable(v.app, v.settings, TABLE)).options).toMatchObject({ pack: "{started_at:YYYY}", pack_after_days: 0 });
    expect((await alterTable(v.app, v.settings, { table: TABLE, pack: "", packAfterDays: null })).ok).toBe(true);
    const o = (await describeTable(v.app, v.settings, TABLE)).options;
    expect([o.pack, o.pack_after_days]).toEqual([undefined, undefined]);
  });

  it("refuses a pack option that is no template of one date column, with a hint and the docs", async () => {
    const v = await feeds();
    for (const [pack, what] of [
      ["{when:YYYY-MM}", /no column "when"/],
      ["{minutes:YYYY-MM}", /"minutes" is a integer column, not a date/],
      ["{started_at:YYYY-MM} {started_at:DD}", /names 2 columns/],
      ["{started_at:HH}", /no date format of a period/],
      ["{started_at:YYYY/MM}", /no date format/],
      ["started_at", /names no column/],
    ] as const) {
      const e = await alterTable(v.app, v.settings, { table: TABLE, pack }).catch((x: unknown) => x);
      expect(e, pack).toBeInstanceOf(Error);
      expect((e as Error).message, pack).toMatch(what);
      expect(guided(e).docs).toMatch(/packs\.md#choose-the-period-of-a-pack$/);
      expect(guided(e).hint).toContain("started_at");
    }
    const days = await alterTable(v.app, v.settings, { table: TABLE, packAfterDays: -1 }).catch((x: unknown) => x);
    expect((days as Error).message).toMatch(/whole number of days/);
  });

  it("a host without packs refuses the option", async () => {
    const v = createDbVault({}, {}, { host: "fake" });
    const e = await createTable(v.app, v.settings, described({ name: "x", timeColumn: "at", options: { pack: "{at:YYYY-MM}" }, columns: [{ name: "at", type: "date" }] })).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/need the engine service/);
    expect(guided(e).docs).toMatch(/packs\.md#packs-need-the-engine-service$/);
  });
});

describe("pack_rows and unpack_rows", () => {
  it("a dry run lists the packs and the rows left out", async () => {
    const v = await feeds();
    const r = await packRows(v.app, v.settings, { table: TABLE }, { dryRun: true, now: NOW });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.packs.map((p) => [p.pack, p.key, p.rows.map((x) => path.posix.basename(x))])).toEqual([
      [`${FOLDER}/feed 2026-09.md`, "2026-09", ["2026-09-30T2310.md"]],
      [PACK, "2026-10", ["2026-10-01T0800.md", "2026-10-02T1422.md"]],
    ]);
    expect(r.excluded).toEqual([{ path: `${FOLDER}/2026-10-03T0605.md`, reason: expect.stringMatching(/# or ## heading/) }]);
    expect(r.open_rows).toBe(1);
    expect(r.planned_texts).toEqual(["Journal/Day.md"]);
    expect(v.exists(PACK)).toBe(false);
  });

  it("packs silently: the same rows, no row in the apply hook, links follow; undo and unpack give the notes back", async () => {
    const v = await feeds();
    const before = await rowsOf(v);
    const texts = Object.fromEntries(v.list().filter((p) => p.startsWith(`${FOLDER}/2026-10-0`)).map((p) => [p, v.read(p)]));
    const neighbours = await graphNeighbors(v.app, v.settings, { from: { paths: ["Journal/Day.md"] } });
    const applied: AppliedOperation[] = [];
    const off = onApplied(v.app, (e) => applied.push(e));
    const r = await packRows(v.app, v.settings, { table: TABLE, key: "2026-10" }, { now: NOW });
    off();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(v.exists(PACK)).toBe(true);
    expect(v.exists(`${FOLDER}/2026-10-01T0800.md`)).toBe(false);
    expect(v.exists(`${FOLDER}/2026-10-03T0605.md`)).toBe(true); // its heading keeps it out
    expect(await rowsOf(v)).toEqual(before);
    // the apply hook (change feed, webhooks) hears of the note whose links changed, of no row
    expect(applied.map((e) => e.paths)).toEqual([["Journal/Day.md"]]);
    expect(v.read("Journal/Day.md")).toBe("---\ntitle: day\n---\nFed at [[feed 2026-10#2026-10-01T0800]] and [[feed 2026-10#2026-10-02T1422|later]].\n");
    expect(await graphNeighbors(v.app, v.settings, { from: { paths: ["Journal/Day.md"] } })).toEqual(neighbours);

    // a link column may name a packed row as [[pack#row]]: it validates and expands
    const linked = await insertRow(v.app, v.settings, { table: TABLE, values: { started_at: "2026-11-03T06:05:00+02:00", minutes: 1, baby: "[[feed 2026-10#2026-10-01T0800]]" } });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    const x = await select(v.app, v.settings, { table: TABLE, where: { minutes: 1 }, expand: ["baby"] });
    expect((x.rows[0]!.baby as { path: string }).path).toBe(`${FOLDER}/2026-10-01T0800.md`);
    // the graph follows it to the row; a filter on the link compares the row's name
    const from = x.rows[0]!.path as string;
    expect((await graphNeighbors(v.app, v.settings, { from: { paths: [from] } })).nodes[0]!.edges).toContainEqual({ path: `${FOLDER}/2026-10-01T0800.md`, table: TABLE, label: "baby", direction: "out" });
    expect((await select(v.app, v.settings, { table: TABLE, where: { baby: "[[2026-10-01T0800]]" } })).rows.map((r) => r.path)).toEqual([from]);
    // a text that links into a pack: automatic links see the row as linked already
    const body = await insertRow(v.app, v.settings, { table: TABLE, values: { started_at: "2026-11-05T06:05:00+02:00", minutes: 3 }, body: "After [[feed 2026-10#2026-10-01T0800]], see [[#Top]] and [[Journal/Day#]].\n" });
    expect(body.ok, JSON.stringify(body)).toBe(true);
    const wrong = await insertRow(v.app, v.settings, { table: TABLE, values: { started_at: "2026-11-04T06:05:00+02:00", minutes: 2, baby: "[[feed 2026-10#2026-10-09T0000]]" } });
    expect(wrong.ok).toBe(false);

    // undo: the notes come back as they were, the links too
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok, JSON.stringify(u)).toBe(true);
    expect(v.exists(PACK)).toBe(false);
    for (const [p, text] of Object.entries(texts)) expect(v.read(p)).toBe(text);
    expect(v.read("Journal/Day.md")).toContain("[[2026-10-01T0800]]");

    // pack again, then unpack_rows: the same notes, byte for byte, and the links back
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const out = await unpackRows(v.app, v.settings, { table: TABLE, where: { minutes: 9 } });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.packs).toEqual([{ pack: PACK, key: "2026-10", rows: [`${FOLDER}/2026-10-01T0800.md`] }]);
    expect(v.read(`${FOLDER}/2026-10-01T0800.md`)).toBe(texts[`${FOLDER}/2026-10-01T0800.md`]);
    expect(v.read("Journal/Day.md")).toContain("Fed at [[2026-10-01T0800]] and [[feed 2026-10#2026-10-02T1422|later]]");
    const all = await unpackRows(v.app, v.settings, { table: TABLE });
    expect(all.ok).toBe(true);
    expect(v.list().filter((p) => p.endsWith(".md") && path.posix.basename(p).startsWith("feed "))).toEqual([]);
    for (const [p, text] of Object.entries(texts)) expect(v.read(p)).toBe(text);
    expect((await rowsOf(v)).filter((r) => r.minutes !== 1 && r.minutes !== 3)).toEqual(before);
  });

  it("alter_table refuses to move the rows while some are packed", async () => {
    const v = await feeds();
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    for (const change of [{ partition: "{started_at:YYYY}" }, { name: "feeds" }, { pack: "" }, { pack: "{started_at:YYYY}" }]) {
      const e = await alterTable(v.app, v.settings, { table: TABLE, ...change }).catch((x: unknown) => x);
      expect((e as Error).message, JSON.stringify(change)).toMatch(/3 rows in 2 packs/);
      expect(guided(e).docs).toMatch(/packs\.md#unpack-before-you-change-the-tables-layout$/);
    }
    // a change of metadata only is fine
    expect((await alterTable(v.app, v.settings, { table: TABLE, packAfterDays: 1, description: "Feeds" })).ok).toBe(true);
  });

  it("pack_rows needs the pack option, and the engine service", async () => {
    const v = await feeds({});
    const e = await packRows(v.app, v.settings, { table: TABLE }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/has no "pack" option/);
    expect(guided(e).hint).toContain('"pack": "{started_at:YYYY-MM}"');
    const fake = createDbVault({}, {}, { host: "fake" });
    await createTable(fake.app, fake.settings, described({ name: "feed", timeColumn: "at", columns: [{ name: "at", type: "date" }] }));
    const f = await packRows(fake.app, fake.settings, { table: TABLE }).catch((x: unknown) => x);
    expect(guided(f).docs).toMatch(/packs-need-the-engine-service$/);
  });

  it("a write on a packed row is a write of the row: the change goes to its section", async () => {
    const v = await feeds();
    expect((await packRows(v.app, v.settings, { table: TABLE }, { now: NOW })).ok).toBe(true);
    const u = await updateRow(v.app, v.settings, { table: TABLE, path: `${FOLDER}/2026-10-02T1422.md`, set: { minutes: 13 } });
    expect(u.ok, JSON.stringify(u)).toBe(true);
    expect(v.read(PACK)).toContain("minutes:: 13");
    expect(v.exists(`${FOLDER}/2026-10-02T1422.md`)).toBe(false);
    const undo = await undoOperation(v.app, v.settings, u.migration_id!);
    expect(undo.ok, JSON.stringify(undo)).toBe(true);
    expect(v.read(PACK)).toContain("minutes:: 11");
  });
});

describe("pack_rows and unpack_rows: edge cases", () => {
  it("pack_after_days of the table, a key given, a key that is no key", async () => {
    const v = await feeds({ pack: "{started_at:YYYY-MM}", pack_after_days: 30 });
    // October ends 2026-11-01: closed after 30 days on 2026-12-01 only
    expect((await packRows(v.app, v.settings, { table: TABLE }, { dryRun: true, now: NOW })).packs.map((p) => p.key)).toEqual(["2026-09"]);
    expect((await packRows(v.app, v.settings, { table: TABLE, key: "2026-09" }, { dryRun: true, now: new Date("2026-12-20T00:00:00Z") })).packs.map((p) => p.key)).toEqual(["2026-09"]);
    const e = await packRows(v.app, v.settings, { table: TABLE, key: " " }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/"key" must be the period of a pack/);
    expect(guided(e).docs).toMatch(/packs\.md#pack-and-unpack-rows$/);
  });

  it("rows left out: not at their path, with no date, or with an empty column of the file name", async () => {
    const v = createDbVault({}, {}, { host: "node" });
    expect((await createTable(v.app, v.settings, described({
      name: "note",
      options: { filename: "{title}", pack: "{day:YYYY-MM}" },
      columns: [{ name: "title", type: "string" }, { name: "day", type: "date" }],
    }))).ok).toBe(true);
    const folder = `${TEST_DATABASE_FOLDER}/main/public/note`;
    v.write(`${folder}/Right.md`, "---\ntable: main.public.note\nid: 01a0f000-0000-7000-8000-000000000001\ntitle: Right\nday: 2025-01-02\n---\n");
    v.write(`${folder}/Wrong name.md`, "---\ntable: main.public.note\nid: 01a0f000-0000-7000-8000-000000000002\ntitle: Other\nday: 2025-01-03\n---\n");
    v.write(`${folder}/No title.md`, "---\ntable: main.public.note\nid: 01a0f000-0000-7000-8000-000000000003\nday: 2025-01-04\n---\n");
    v.write(`${folder}/No day.md`, "---\ntable: main.public.note\nid: 01a0f000-0000-7000-8000-000000000004\ntitle: No day\n---\n");
    age(v, folder);
    const r = await packRows(v.app, v.settings, { table: "main.public.note" }, { dryRun: true, now: NOW });
    expect(r.packs.map((p) => p.rows)).toEqual([[`${folder}/Right.md`]]);
    expect(r.excluded).toEqual([
      { path: `${folder}/No day.md`, reason: "it has no day" },
      { path: `${folder}/No title.md`, reason: expect.stringMatching(/a column of the file-name pattern is empty/) },
      { path: `${folder}/Wrong name.md`, reason: `it is not at the path its values give (${folder}/Other.md)` },
    ]);
  });

  it("a note named as the pack is a conflict; a pack renamed by hand keeps taking the rows of its key", async () => {
    const v = await feeds();
    v.write(PACK, "---\ntitle: in the way\n---\n");
    (v.app.vault as unknown as { syncPath(p: string): void }).syncPath(PACK);
    const r = await packRows(v.app, v.settings, { table: TABLE, key: "2026-10" }, { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ path: PACK, message: "a note has the name of the pack of 2026-10: rename it first" }]);
    v.remove(PACK);
    expect((await packRows(v.app, v.settings, { table: TABLE, key: "2026-10" }, { now: NOW })).ok).toBe(true);
    const renamed = `${FOLDER}/feed october.md`;
    fs.renameSync(v.abs(PACK), v.abs(renamed));
    (v.app.vault as unknown as { syncPaths(p: string[]): string[] }).syncPaths([PACK, renamed]);
    // a row of October that comes back as a note goes into the renamed pack
    expect((await unpackRows(v.app, v.settings, { table: TABLE, where: { minutes: 9 } })).ok).toBe(true);
    age(v);
    const again = await packRows(v.app, v.settings, { table: TABLE, key: "2026-10" }, { now: NOW });
    expect(again.packs).toEqual([{ pack: renamed, key: "2026-10", rows: [`${FOLDER}/2026-10-01T0800.md`] }]);
  });

  it("a table without a date column: the hint still gives an example", async () => {
    const v = createDbVault({}, {}, { host: "node" });
    expect((await createTable(v.app, v.settings, described({ name: "plain", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] }))).ok).toBe(true);
    const e = await packRows(v.app, v.settings, { table: "plain" }).catch((x: unknown) => x);
    expect(guided(e).hint).toContain('"pack": "{occurred_at:YYYY-MM}"');
  });

  it("unpack_rows with nothing to take out, and the public API's methods", async () => {
    const v = await feeds();
    const { createPublicApi } = await import("../src/core/public-api");
    const api = createPublicApi(v.app, () => v.settings);
    expect(await api.unpackRows({ table: TABLE })).toMatchObject({ ok: true, op: "unpack_rows", packs: [] });
    expect(await api.packRows({ table: TABLE }, { dryRun: true, now: NOW })).toMatchObject({ ok: true, op: "pack_rows" });
    // today's date: nothing of October 2026 is closed yet before 8 November
    expect(await api.packRows({ table: TABLE }, { dryRun: true })).toMatchObject({ ok: true });
  });

  it("a pack the host fails to write: the write fails and is rolled back", async () => {
    const v = await feeds();
    const packs = v.app.packs!;
    const real = packs.pack.bind(packs);
    let calls = 0;
    packs.pack = async (input) => {
      if (++calls === 2) throw new Error("disk full");
      return real(input);
    };
    const r = await packRows(v.app, v.settings, { table: TABLE }, { now: NOW });
    packs.pack = real;
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual([{ path: PACK, error: "disk full" }]);
    expect(r.rolled_back).toBe(true);
    expect(packs.packsOf(TABLE)).toEqual([]);
    expect(v.exists(`${FOLDER}/2026-09-30T2310.md`)).toBe(true);
  });
});

describe("undo of pack_rows and unpack_rows", () => {
  it("rows already back where they were are left alone; rows moved since refuse the undo", async () => {
    const v = await feeds();
    const packed = await packRows(v.app, v.settings, { table: TABLE }, { now: NOW });
    const out = await unpackRows(v.app, v.settings, { table: TABLE, key: "2026-09" });
    // the September rows are notes again: undoing the pack leaves them, takes October apart
    expect((await undoOperation(v.app, v.settings, packed.migration_id!)).ok).toBe(true);
    expect(v.app.packs!.packsOf(TABLE)).toEqual([]);
    // the unpack of September: undone, it packs them again (they are notes now)
    expect((await undoOperation(v.app, v.settings, out.migration_id!)).ok).toBe(true);
    expect(v.app.packs!.packsOf(TABLE).map((p) => p.key)).toEqual(["2026-09"]);

    const second = await packRows(v.app, v.settings, { table: TABLE, key: "2026-10" }, { now: NOW });
    expect(second.ok).toBe(true);
    // a row of October changes month since: undoing the pack would not find it there
    expect((await updateRow(v.app, v.settings, { table: TABLE, path: `${FOLDER}/2026-10-01T0800.md`, set: { started_at: "2026-11-01T08:00:00+02:00" } })).ok).toBe(true);
    const u = await undoOperation(v.app, v.settings, second.migration_id!);
    expect(u.ok).toBe(false);
    expect(JSON.stringify(u)).toMatch(/moved since the operation/);
  });
});
