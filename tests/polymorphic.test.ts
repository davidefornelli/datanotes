import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { select } from "../src/core/rows";
import { createDbVault, METASTORE } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
const YAML = `bases:
  record:
    columns:
      - { name: occurred_at, type: datetime, required: true }
      - { name: note, type: string }
  sport:
    bases: [record]
    columns:
      - { name: minutes, type: integer }
catalogs:
  main:
    schemas:
      public:
        tables:
          meal:
            bases: [record]
            options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}" }
            columns:
              - ${ID}
              - { name: kcal, type: integer }
          run:
            bases: [sport]
            options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}" }
            columns:
              - ${ID}
              - { name: km, type: number }
          person:
            options: { filename: "{name}" }
            columns:
              - ${ID}
              - { name: name, type: string }
`;

const row = (table: string, n: number, extra: string) =>
  `---\ntable: main.public.${table}\nid: 01a0f000-0000-7000-8000-${String(n).padStart(12, "0")}\n${extra}---\n`;

function vault() {
  return createDbVault({
    [METASTORE]: YAML,
    "M/1.md": row("meal", 1, "occurred_at: 2026-09-20T13:00\nnote: pasta\nkcal: 800\n"),
    "M/2.md": row("meal", 2, "occurred_at: 2026-09-22T20:00\nkcal: 600\n"),
    "R/1.md": row("run", 3, "occurred_at: 2026-09-21T07:00\nnote: park\nminutes: 40\nkm: 8\n"),
    "P/Carol.md": row("person", 4, "name: Carol\n"),
  });
}

describe("polymorphic select (base:<name>)", () => {
  it("returns the rows of every table that extends the base, on the base's columns", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "base:record", orderBy: "occurred_at" });
    expect(r.table).toBe("base:record");
    expect(r.total).toBe(3);
    expect(r.rows.map((x) => [x._source, x.occurred_at, x.note ?? null])).toEqual([
      ["main.public.meal", "2026-09-20T13:00", "pasta"],
      ["main.public.run", "2026-09-21T07:00", "park"], // through the base "sport"
      ["main.public.meal", "2026-09-22T20:00", null],
    ]);
    expect(Object.keys(r.rows[0]!)).not.toContain("kcal");
  });

  it("filters, pages and narrows to a sub-base", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "base:record", where: { occurred_at: { gte: "2026-09-21T00:00" } }, orderBy: "-occurred_at", limit: 1 });
    expect(r.total).toBe(2);
    expect(r.rows.map((x) => x.path)).toEqual(["M/2.md"]);
    const sport = await select(v.app, v.settings, { table: "base:sport", columns: ["occurred_at", "minutes"] });
    expect(sport.rows).toEqual([{ path: "R/1.md", occurred_at: "2026-09-21T07:00", minutes: 40, _source: "main.public.run" }]);
  });

  it("refuses unknown bases and columns that are not the base's", async () => {
    const v = vault();
    await expect(select(v.app, v.settings, { table: "base:nope" })).rejects.toThrow(/unknown base/);
    await expect(select(v.app, v.settings, { table: "base:record", columns: ["kcal"] })).rejects.toThrow(/not a column of base record/);
    await expect(select(v.app, v.settings, { table: "base:record", where: { km: 1 } })).rejects.toThrow(/not a column of base record/);
  });
});
