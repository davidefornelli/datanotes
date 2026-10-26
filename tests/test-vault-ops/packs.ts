/**
 * Packs of rows on the test vault (the engine service keeps them): the tasks done in a month go
 * into one note, the rows and the links to them stay the same for the engine, undo and unpack give
 * the notes back byte for byte.
 */

import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { until, withoutGuidance } from "../helpers/test-vault";
import { expectFiles, MEETINGS, TABLE_DIR, task, type Rows, type Scenario, type WriteResult } from "./harness";

type PackResult = WriteResult & { packs: { pack: string; key: string; rows: string[] }[]; excluded: { path: string; reason: string }[]; open_rows: number };

const PACK = `${TABLE_DIR.task}/task 2026-09.md`;
const DONE = [task("Choose the colour palette"), task("Load the sales events")];

export const scenarios: Scenario[] = [
  {
    name: "pack_rows / unpack_rows: the tasks done in September packed by month; the same rows, links follow; layout changes refused; undo; unpack",
    ops: ["alter_table", "describe_table", "pack_rows", "unpack_rows", "select_rows", "undo_migration"],
    hosts: ["service"],
    async run(t) {
      const before = t.files();
      const rows = async () => (await t.ok<Rows>("select_rows", { table: "task", columns: ["id", "title", "status", "done_on", "file_modified"], order_by: "title", include_body: true })).rows;
      // a meeting links to a task done in September
      const meeting = MEETINGS[3]!;
      t.handEdit(meeting, `${before[meeting]!}\nFollow-up of [[Load the sales events]].\n`);
      const alter = await t.ok<WriteResult>("alter_table", { table: "task", pack: "{done_on:YYYY-MM}" });
      expect((await t.ok<{ options: Record<string, unknown> }>("describe_table", { table: "task" })).options).toMatchObject({ pack: "{done_on:YYYY-MM}" });
      // the notes have not changed for a while (a row changed in the last 24 hours waits)
      const old = new Date("2026-10-01T00:00:00Z");
      for (const rel of Object.keys(t.files())) if (rel.startsWith(`${TABLE_DIR.task}/`)) fs.utimesSync(path.join(t.root, rel), old, old);
      const dry = await until(async () => {
        const r = await t.ok<PackResult>("pack_rows", { table: "task", dry_run: true });
        return r.packs.length === 1 ? r : null;
      }, 10_000, "the old notes are seen");
      expect(dry.packs).toEqual([{ pack: PACK, key: "2026-09", rows: DONE }]);
      expect(dry.excluded.map((e) => e.reason)).toEqual(Array(dry.excluded.length).fill("it has no done_on"));
      expect(dry.planned_texts).toEqual([meeting]);
      const want = await rows();

      const packed = await t.ok<PackResult>("pack_rows", { table: "task" });
      expect(t.exists(PACK)).toBe(true);
      for (const p of DONE) expect(t.exists(p)).toBe(false);
      expect(await rows()).toEqual(want);
      expect(t.read(meeting)).toContain("[[task 2026-09#Load the sales events]]");

      // while rows are packed, the layout stays
      expect(await t.refused("alter_table", { table: "task", filename: "{title} (task)" })).toMatch(/2 rows in 1 pack/);
      expect(await t.refused("alter_table", { table: "task", pack: "" })).toMatch(/the pack option goes only while every row is a note of its own/);

      // undo takes the pack apart; unpack_rows does the same
      await t.ok("undo_migration", { migration_id: packed.migration_id });
      for (const p of DONE) expect(t.read(p)).toBe(before[p]);
      expect(t.read(meeting)).toContain("[[Load the sales events]]");
      await t.ok<PackResult>("pack_rows", { table: "task" });
      const out = await t.ok<PackResult>("unpack_rows", { table: "task", key: "2026-09" });
      expect(out.packs).toEqual([{ pack: PACK, key: "2026-09", rows: DONE }]);
      expect(t.exists(PACK)).toBe(false);
      expect(await rows()).toEqual(want);

      await t.ok("undo_migration", { migration_id: alter.migration_id });
      t.handEdit(meeting, before[meeting]!);
      expectFiles(t, before);
    },
  },
  {
    name: "packs on the in-process host: refused where the host keeps no packs (the fake App), a dry run where it does (the Node host)",
    ops: ["alter_table", "pack_rows"],
    hosts: ["in-process"],
    async run(t) {
      const before = t.files();
      const r = await t.call("alter_table", { table: "task", pack: "{done_on:YYYY-MM}" });
      if (!r.ok) {
        expect(withoutGuidance(String(r.value), "alter_table")).toMatch(/need the engine service/);
        expect(await t.refused("pack_rows", { table: "task" })).toMatch(/need the engine service/);
        return;
      }
      const dry = await t.ok<PackResult>("pack_rows", { table: "task", dry_run: true });
      expect(dry.ok).toBe(true);
      await t.ok("undo_migration", { migration_id: (r.value as WriteResult).migration_id });
      expectFiles(t, before);
    },
  },
];
