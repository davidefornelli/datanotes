import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY, loadTable, renameValue, undoOperation } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { checkTable, insertRow, select } from "../src/core/rows";
import { parseColumn, parseTableOptions } from "../src/core/table-loader";
import { listTables } from "../src/core/table-registry";
import { createDbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const YAML = `catalogs:
  main:
    schemas:
      public:
        tables:
          stress:
            description: Perceived stress
            aliases: [tension, anxiety]
            options:
              partition: "{occurred_at:YYYY}"
              filename: "{occurred_at:YYYY-MM-DD[T]HHmm}"
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: occurred_at, type: datetime, required: true }
              - { name: value, type: enum, values: [minor, moderate, major], ordered: true, required: true }
              - { name: tags_level, type: list, items: enum, values: [minor, moderate, major] }
          energy:
            options:
              filename: "{occurred_at:YYYY-MM-DD[T]HHmm}"
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: occurred_at, type: datetime }
              - { name: value, type: enum, values: [minor, major] }
`;

const DIR = "Datanotes/main/public/stress";

const row = (at: string, value: string, extra = "") =>
  `---\ntable: main.public.stress\noccurred_at: ${at}\nvalue: ${value}\n${extra}---\n`;

function vault(extra: Record<string, string> = {}) {
  return createDbVault({
    [METASTORE]: YAML,
    [`${DIR}/2026/a.md`]: row("2026-09-20T08:00", "minor"),
    [`${DIR}/2026/b.md`]: row("2026-09-21T08:00", "major", "tags_level:\n  - major\n  - moderate\n"),
    [`${DIR}/2026/c.md`]: row("2026-09-22T08:00", "moderate"),
    [`${DIR}/2026/d.md`]: row("2026-09-22T20:00", "major"),
    ...extra,
  });
}

const fm = (v: { read(p: string): string }, p: string) =>
  Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);

describe("ordered enums", () => {
  it("parses ordered only on enum columns", () => {
    expect(parseColumn({ name: "v", type: "enum", values: ["a", "b"], ordered: true }, 0).ordered).toBe(true);
    expect(parseColumn({ name: "v", type: "list", items: "enum", values: ["a"], ordered: true }, 0).ordered).toBe(true);
    expect(() => parseColumn({ name: "v", type: "integer", ordered: true }, 0)).toThrow(/only valid for enum/);
    expect(() => parseColumn({ name: "v", type: "enum", values: ["a"], ordered: "yes" }, 0)).toThrow(/true or false/);
  });

  it("filters, sorts and aggregates by position", async () => {
    const v = vault();
    const high = await select(v.app, v.settings, { table: "stress", where: { value: { gte: "moderate" } }, columns: ["value"] });
    expect(high.rows.map((r) => r.path)).toEqual([`${DIR}/2026/b.md`, `${DIR}/2026/c.md`, `${DIR}/2026/d.md`]);
    const sorted = await select(v.app, v.settings, { table: "stress", columns: ["value"], orderBy: ["-value", "path"] });
    expect(sorted.rows.map((r) => r.value)).toEqual(["major", "major", "moderate", "minor"]);
    const byDay = await select(v.app, v.settings, {
      table: "stress",
      groupBy: "date(occurred_at)",
      aggregates: { n: "count", avg: "avg:value", min: "min:value", max: "max:value" },
    });
    expect(byDay.rows).toEqual([
      { "date(occurred_at)": "2026-09-20", n: 1, avg: 1, min: "minor", max: "minor" },
      { "date(occurred_at)": "2026-09-21", n: 1, avg: 3, min: "major", max: "major" },
      { "date(occurred_at)": "2026-09-22", n: 2, avg: 2.5, min: "moderate", max: "major" },
    ]);
  });
});

describe("table description and aliases", () => {
  it("are parsed, listed and written by create_table", async () => {
    expect(parseTableOptions([{ description: " d ", aliases: "x" }])).toEqual({ description: "d", aliases: ["x"] });
    expect(() => parseTableOptions([{ aliases: [""] }])).toThrow(/word or a list of words/);
    const v = vault();
    await loadTable(v.app, v.settings, "stress"); // fills the metastore cache listTables reads
    expect(listTables(v.app, v.settings.databaseFolder).find((t) => t.name === "stress")).toEqual({
      name: "stress",
      catalog: "main",
      schema: "public",
      qualified: "main.public.stress",
      description: "Perceived stress",
      aliases: ["tension", "anxiety"],
    });
    expect(listTables(v.app, v.settings.databaseFolder).find((t) => t.name === "energy")).toMatchObject({ qualified: "main.public.energy" });
    expect(listTables(v.app, v.settings.databaseFolder).find((t) => t.name === "energy")).not.toHaveProperty("description");
    const r = await createTable(v.app, v.settings, described({
      name: "mood",
      columns: [{ name: "value", type: "integer", min: 1, max: 5 }],
      options: { description: "Mood 1-5", aliases: ["feeling"], filename: "{id}" },
    }));
    expect(r.ok).toBe(true);
    const yaml = v.read(METASTORE);
    expect(yaml).toMatch(/Mood 1-5/);
    expect(yaml).toMatch(/feeling/);
  });
});

describe("insert_row name collisions", () => {
  it("adds -2, -3 when the computed filename is taken; an explicit path still conflicts", async () => {
    const v = vault();
    const values = { occurred_at: "2026-09-26T22:30", value: "major" };
    const a = await insertRow(v.app, v.settings, { table: "stress", values });
    const b = await insertRow(v.app, v.settings, { table: "stress", values });
    const c = await insertRow(v.app, v.settings, { table: "stress", values });
    expect([a.planned_creates, b.planned_creates, c.planned_creates]).toEqual([
      [`${DIR}/2026/2026-09-26T2230.md`],
      [`${DIR}/2026/2026-09-26T2230-2.md`],
      [`${DIR}/2026/2026-09-26T2230-3.md`],
    ]);
    const explicit = await insertRow(v.app, v.settings, { table: "stress", values, path: `${DIR}/2026/a.md` });
    expect(explicit.conflicts[0]!.message).toBe("note already exists");
  });
});


describe("rename_value", () => {
  const QUERIES = {
    "Views/stress.md": '# Stress\n```dataview\nTABLE value FROM "Stress"\nWHERE value = "major"\n```\n',
    "Views/energy.md": '```dataview\nTABLE value FROM "Energy"\nWHERE value = "major"\n```\n',
    "Views/unknown.md": '```dataview\nTABLE value FROM "Somewhere"\nWHERE value = "major"\n```\n',
    "Notes/prose.md": "Today stress major, value major.\n",
  };

  it("renames the value in metastore.yaml and rows, leaves note text alone; undo restores all", async () => {
    const v = vault(QUERIES);
    const dry = await renameValue(v.app, v.settings, { table: "stress", column: "value", from: "major", to: "acute" }, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(v.read("Views/stress.md")).toContain('value = "major"');

    const r = await renameValue(v.app, v.settings, { table: "stress", column: "value", from: "major", to: "acute" });
    expect(r.ok).toBe(true);
    expect(v.read(METASTORE)).toMatch(/values: \[minor, moderate, acute\]|- moderate\n\s+- acute/);
    expect(fm(v, `${DIR}/2026/b.md`).value).toBe("acute");
    expect(fm(v, `${DIR}/2026/d.md`).value).toBe("acute");
    expect(fm(v, `${DIR}/2026/c.md`).value).toBe("moderate");
    expect(fm(v, `${DIR}/2026/b.md`).tags_level).toEqual(["major", "moderate"]); // another column: untouched
    expect(v.read("Views/energy.md")).toContain('value = "major"');
    expect(v.read("Notes/prose.md")).toBe("Today stress major, value major.\n");
    // the order is unchanged: acute is still the top of the scale
    const top = await select(v.app, v.settings, { table: "stress", where: { value: { gt: "moderate" } } });
    expect(top.total).toBe(2);

    expect((await undoOperation(v.app, v.settings, r.migration_id!)).ok).toBe(true);
    expect(v.read(METASTORE)).toBe(YAML);
    expect(fm(v, `${DIR}/2026/b.md`).value).toBe("major");
  });

  it("renames inside list columns too", async () => {
    const v = vault();
    const r = await renameValue(v.app, v.settings, { table: "stress", column: "tags_level", from: "major", to: "elevated" });
    expect(r.ok).toBe(true);
    expect(fm(v, `${DIR}/2026/b.md`).tags_level).toEqual(["elevated", "moderate"]);
    expect(fm(v, `${DIR}/2026/b.md`).value).toBe("major");
  });

  it("refuses bad input without writing", async () => {
    const v = vault();
    const exists = await renameValue(v.app, v.settings, { table: "stress", column: "value", from: "major", to: "moderate" });
    expect(exists.ok).toBe(false);
    expect(exists.conflicts[0]!.message).toBe('"moderate" is already a value of value');
    expect(fm(v, `${DIR}/2026/b.md`).value).toBe("major");
    await expect(renameValue(v.app, v.settings, { table: "stress", column: "value", from: "zzz", to: "x" })).rejects.toThrow(/is not a value/);
    await expect(renameValue(v.app, v.settings, { table: "stress", column: "occurred_at", from: "a", to: "b" })).rejects.toThrow(/not an enum column/);
    await expect(renameValue(v.app, v.settings, { table: "stress", column: "value", from: "major", to: "major" })).rejects.toThrow(/same value/);
  });

});

