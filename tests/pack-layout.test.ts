/** Where the rows of a table go in packs (src/core/pack-layout.ts): templates, keys, periods, paths. */
import { describe, expect, it } from "vitest";
import {
  databaseRootOfPack,
  looseTemplate,
  namedAsPack,
  packedTablesIn,
  packFilePath,
  packPartitionWarning,
  packKeyOf,
  PackOptionError,
  periodClosed,
  periodEnd,
  readPackAfterDays,
  readPackTemplate,
  rowPathOf,
} from "../src/core/pack-layout";

const COLUMNS = [
  { name: "started_at", type: "datetime" as const },
  { name: "day", type: "date" as const },
  { name: "minutes", type: "integer" as const },
];

const refuses = (template: unknown, columns: { name: string; type: "string" | "integer" | "date" | "datetime" }[] = COLUMNS) => {
  try {
    readPackTemplate(template, columns);
  } catch (e) {
    expect(e).toBeInstanceOf(PackOptionError);
    return e as PackOptionError;
  }
  throw new Error(`${JSON.stringify(template)} was accepted`);
};

describe("readPackTemplate", () => {
  it("reads one placeholder of a date column, and the length of its periods", () => {
    expect(readPackTemplate(" {started_at:YYYY-MM} ", COLUMNS)).toEqual({ template: "{started_at:YYYY-MM}", column: "started_at", format: "YYYY-MM", period: "month" });
    expect(readPackTemplate("{day:YYYY}", COLUMNS).period).toBe("year");
    expect(readPackTemplate("{day:YYYY-MM-DD}", COLUMNS).period).toBe("day");
    expect(readPackTemplate("week {day:YYYY[W]MM}", COLUMNS).period).toBe("month");
  });

  it("refuses what is no template of one date column, naming the table's date columns", () => {
    expect(refuses(42).message).toMatch(/must be a template of a date column, such as "\{started_at:YYYY-MM\}"/);
    expect(refuses("  ").message).toMatch(/must be a template/);
    expect(refuses("{started_at:YYYY}-{day:MM}").message).toMatch(/names 2 columns/);
    expect(refuses("{strated_at:YYYY}").hint).toMatch(/Did you mean "started_at"\?/);
    expect(refuses("{minutes:YYYY}").message).toMatch(/is a integer column, not a date/);
    expect(refuses("{started_at}").message).toMatch(/"" is no date format/);
    for (const f of ["MM", "YYYY-DD", "YYYY-MM HH", "YYYY/MM", "YYYY\\MM"]) expect(refuses(`{started_at:${f}}`).message, f).toMatch(/no date format/);
    expect(refuses("a/{started_at:YYYY}").message).toMatch(/cannot hold a folder/);
    expect(refuses("started_at").message).toMatch(/names no column/);
    expect(refuses("{qqqqqqqqqq:YYYY}").hint).toMatch(/^The date columns of the table/);
  });

  it("a table without a date column: the hint says to add one", () => {
    const e = refuses("{x:YYYY}", [{ name: "x", type: "string" }]);
    expect(e.hint).toMatch(/has no date or date-time column/);
    expect(e.hint).toContain('"{occurred_at:YYYY-MM}"');
    expect(refuses("{y:YYYY}", [{ name: "x", type: "string" }]).message).toMatch(/no column "y"/);
  });
});

describe("the rest of the layout", () => {
  it("readPackAfterDays: a whole number of days, 0 or more", () => {
    expect(readPackAfterDays(0)).toBe(0);
    for (const v of [-1, 1.5, "7", null]) expect(() => readPackAfterDays(v), String(v)).toThrow(/whole number of days/);
  });

  it("packKeyOf: the period of a row; null without a date", () => {
    const t = readPackTemplate("{started_at:YYYY-MM}", COLUMNS);
    expect(packKeyOf(t, new Map([["started_at", "2026-10-23T14:22:14+02:00"]]))).toBe("2026-10");
    expect(packKeyOf(t, new Map())).toBeNull();
    expect(packKeyOf(t, new Map([["started_at", 7]]))).toBeNull();
    expect(packKeyOf(t, new Map([["started_at", "not a date"]]))).toBeNull();
  });

  it("periodEnd and periodClosed", () => {
    expect([periodEnd("2026-12-31", "year"), periodEnd("2026-12-05", "month"), periodEnd("2026-02-28", "day")]).toEqual(["2027-01-01", "2027-01-01", "2026-03-01"]);
    expect(periodClosed("2026-10-23T10:00", "month", 7, "2026-11-07")).toBe(false);
    expect(periodClosed("2026-10-23T10:00", "month", 7, "2026-11-08")).toBe(true);
    expect(periodClosed("2026-10-23", "day", 0, "2026-10-24")).toBe(true);
  });

  it("packFilePath, namedAsPack, rowPathOf, looseTemplate", () => {
    expect(packFilePath("db/a/b/feed", "feed", "2026-10")).toBe("db/a/b/feed/feed 2026-10.md");
    expect(packFilePath("db/a/b/feed", "feed", "a:b")).toBe("db/a/b/feed/feed a-b.md");
    expect([namedAsPack("db/feed/feed 2026-10.md"), namedAsPack("feed 2026-10.md"), namedAsPack("db/feed/other.md"), namedAsPack("db/feed/feed 2026.txt")]).toEqual([true, false, false, false]);
    expect(rowPathOf({ rowPath: "db/feed/{at:YYYY}", filename: "{at:YYYY-MM-DD}" }, new Map([["at", "2026-10-23"]]))).toBe("db/feed/2026/2026-10-23.md");
    expect(looseTemplate("{at:YYYY}")?.period).toBe("year");
    expect(looseTemplate("{at:YYYY-MM-DD}")?.period).toBe("day");
    expect(looseTemplate("{at:YYYY-MM}")?.period).toBe("month");
    expect(looseTemplate("{at}")).toBeNull();
  });

  it("packedTablesIn: each table's layout and template; nothing from a metastore that cannot be read", () => {
    const text = [
      "catalogs:",
      "  main:",
      "    schemas:",
      "      public:",
      "        tables:",
      "          feed:",
      "            options: { filename: '{at:YYYY-MM-DD}', partition: '{at:YYYY}', pack: '{at:YYYY-MM}' }",
      "            columns: [{ name: at, type: date }]",
      "          plain:",
      "            columns: [{ name: x, type: string }]",
      "          broken:",
      "            options: { filename: '' }",
      "            columns: [{ name: x, type: string }]",
      "",
    ].join("\n");
    const t = packedTablesIn(text, "db");
    expect(t.get("main.public.feed")).toEqual({ layout: { rowPath: "db/main/public/feed/{at:YYYY}", filename: "{at:YYYY-MM-DD}" }, template: { template: "{at:YYYY-MM}", column: "at", format: "YYYY-MM", period: "month" } });
    expect(t.get("main.public.plain")).toEqual({ layout: null, template: null });
    expect(t.get("main.public.broken")).toEqual({ layout: null, template: null });
    expect(packedTablesIn("catalogs: [1", "db").size).toBe(0);
  });

  it("databaseRootOfPack: the database folder of a pack in its table's folder", () => {
    expect(databaseRootOfPack("db/main/public/feed/feed 2026-10.md", "main.public.feed")).toBe("db");
    expect(databaseRootOfPack("main/public/feed/feed 2026-10.md", "main.public.feed")).toBe("");
    expect(databaseRootOfPack("db/elsewhere/feed 2026-10.md", "main.public.feed")).toBeNull();
    expect(databaseRootOfPack("a/b.md", "main.public.feed")).toBeNull();
    expect(databaseRootOfPack("db/x/y/z/feed 2026-10.md", "main.public.feed")).toBeNull();
    expect(databaseRootOfPack("db/main/public/feed/x.md", "feed")).toBeNull();
  });
});

describe("packPartitionWarning", () => {
  it("warns when the rows' folders are wider than the packs' periods, by the pack's column", () => {
    const w = packPartitionWarning("main.public.feed", "{at:YYYY}", "{at:YYYY-MM}")!;
    expect(w).toMatchObject({ code: "pack_partition", table: "main.public.feed" });
    expect(w.message).toMatch(/wider than the periods of its packs/);
    expect(w.hint).toContain('"partition": "{at:YYYY/MM}"');
    expect(w.docs).toMatch(/packs\.md#choose-the-partition-with-git-in-mind$/);
    expect(packPartitionWarning("t", undefined, "{at:YYYY-MM}")!.message).toContain("partition none");
    expect(packPartitionWarning("t", "{other:YYYY/MM/DD}", "{at:YYYY-MM}")).not.toBeNull();
    expect(packPartitionWarning("t", "{at:YYYY/MM}", "{at:YYYY-MM-DD}")!.hint).toContain("{at:YYYY/MM/DD}");
    expect(packPartitionWarning("t", "{kind}", "{at:YYYY}")!.hint).toContain('"{at:YYYY}"');
  });

  it("no warning with a partition as fine as the pack or finer, or without a pack", () => {
    expect(packPartitionWarning("t", "{at:YYYY/MM}", "{at:YYYY-MM}")).toBeNull();
    expect(packPartitionWarning("t", "{kind}/{at:YYYY/MM/DD}", "{at:YYYY-MM}")).toBeNull();
    expect(packPartitionWarning("t", "{at:YYYY}", "{at:YYYY}")).toBeNull();
    expect(packPartitionWarning("t", "{at:[x]}", undefined)).toBeNull();
    expect(packPartitionWarning("t", "{at:YYYY}", "no template")).toBeNull();
    expect(packPartitionWarning("t", "{at:[week]}", "{at:YYYY}")).not.toBeNull();
  });
});
