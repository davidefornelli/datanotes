import { describe, expect, it } from "vitest";
import { appendBody, prependBody, setSection } from "../src/core/body";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { insertRow, updateRow, updateRows } from "../src/core/rows";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const P = "Datanotes/main/public/person";
const read = (v: DbVault, p: string) => readOrderedFromMarkdown(v.read(p));

async function people(): Promise<DbVault> {
  const v = createDbVault({});
  await createTable(v.app, v.settings, described({
    name: "person",
    options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true },
      { name: "city", type: "string" },
      { name: "age", type: "integer", min: 0 },
    ],
  }));
  await insertRow(v.app, v.settings, { table: "person", values: { name: "Grace", city: "Paris" }, body: "# Grace\n\n## Note\n\nColleague.\n\n## History\n\n- 2020 met\n" });
  await insertRow(v.app, v.settings, { table: "person", values: { name: "Paul", city: "Paris" } });
  return v;
}

const idOf = (v: DbVault, name: string) => Object.fromEntries(read(v, `${P}/${name}.md`).ordered).id as string;

describe("body edits", () => {
  it("replace a section up to the next heading of the same level, or add it", () => {
    const body = "# P\n\n## Note\n\nold\n\n### Details\n\nx\n\n## History\n\n- a\n";
    expect(setSection(body, "note", "new")).toBe("# P\n\n## Note\n\nnew\n\n## History\n\n- a\n");
    expect(setSection(body, "Contacts", "tel")).toBe("# P\n\n## Note\n\nold\n\n### Details\n\nx\n\n## History\n\n- a\n\n## Contacts\n\ntel\n");
    expect(setSection("```\n## Note\n```\n", "Note", "t")).toBe("```\n## Note\n```\n\n## Note\n\nt\n");
    expect(prependBody("\nrest\n", "first")).toBe("first\n\nrest\n");
    expect(appendBody("text\n\n", "after")).toBe("text\n\nafter\n");
    expect(appendBody("", "only")).toBe("only\n");
  });
});

describe("update_row", () => {
  it("updates exactly the row named by id or path, keeping the rest of the body", async () => {
    const v = await people();
    const id = idOf(v, "Grace");
    const r = await updateRow(v.app, v.settings, {
      table: "person",
      id,
      set: { city: "Milan" },
      bodySections: { History: "- 2020 met\n- 2026 moved to Milan" },
      bodyAppend: "Updated by the agent.",
    });
    expect(r.ok).toBe(true);
    expect(r.planned_edits.map((p) => p.path)).toEqual([`${P}/Grace.md`]);
    const grace = read(v, `${P}/Grace.md`);
    expect(Object.fromEntries(grace.ordered)).toMatchObject({ id, city: "Milan" });
    expect(grace.body).toBe("# Grace\n\n## Note\n\nColleague.\n\n## History\n\n- 2020 met\n- 2026 moved to Milan\n\nUpdated by the agent.\n");
    expect(Object.fromEntries(read(v, `${P}/Paul.md`).ordered).city).toBe("Paris");
    const byPath = await updateRow(v.app, v.settings, { table: "person", path: `${P}/Paul`, set: { age: 40 } });
    expect(byPath.ok).toBe(true);
    expect(Object.fromEntries(read(v, `${P}/Paul.md`).ordered).age).toBe(40);
  });

  it("refuses unknown rows, mismatched id/path, bad values and mixed body modes", async () => {
    const v = await people();
    await expect(updateRow(v.app, v.settings, { table: "person", set: { city: "X" } })).rejects.toThrow(/"id" or "path"/);
    await expect(updateRow(v.app, v.settings, { table: "person", id: "0190a000-0000-7000-8000-000000000000", set: { city: "X" } })).rejects.toThrow(/no row with id/);
    await expect(updateRow(v.app, v.settings, { table: "person", id: idOf(v, "Grace"), path: `${P}/Paul.md`, set: { city: "X" } })).rejects.toThrow(/not .*Paul/);
    await expect(updateRow(v.app, v.settings, { table: "person", id: idOf(v, "Grace"), body: "x", bodyAppend: "y" })).rejects.toThrow(/whole body/);
    const bad = await updateRow(v.app, v.settings, { table: "person", id: idOf(v, "Grace"), set: { age: -1 } });
    expect(bad.ok).toBe(false);
    expect(Object.fromEntries(read(v, `${P}/Grace.md`).ordered).age).toBeUndefined();
  });
});

describe("update_rows expect_count", () => {
  it("writes nothing when the match count differs: a conflict, as update_row's expect", async () => {
    const v = await people();
    const r = await updateRows(v.app, v.settings, { table: "person", where: { city: "Paris" }, set: { city: "Naples" }, expectCount: 1 });
    expect(r).toMatchObject({ ok: false, conflicts: [{ message: '"where" matched 2 rows, expected 1: nothing was written' }] });
    expect(Object.fromEntries(read(v, `${P}/Grace.md`).ordered).city).toBe("Paris");
    expect((await updateRows(v.app, v.settings, { table: "person", where: { city: "Paris" }, set: { city: "Naples" }, expectCount: 2 })).ok).toBe(true);
  });
});

describe("unset of stray keys", () => {
  it("removes keys that are not columns (reported by check_table as unknown_column)", async () => {
    const v = await people();
    v.write(`${P}/Paul.md`, v.read(`${P}/Paul.md`).replace("name: Paul", "name: Paul\nmodified: 2026-09-29"));
    const r = await updateRow(v.app, v.settings, { table: "person", path: `${P}/Paul.md`, unset: ["modified"] });
    expect(r.ok).toBe(true);
    expect(v.read(`${P}/Paul.md`)).not.toContain("modified:");
    await expect(updateRow(v.app, v.settings, { table: "person", path: `${P}/Paul.md`, unset: ["table"] })).rejects.toThrow(/cannot unset/);
  });
});

describe("renaming by update", () => {
  it("moves the note when a column of the filename changes, and only then", async () => {
    const v = await people();
    const r = await updateRow(v.app, v.settings, { table: "person", path: `${P}/Grace.md`, set: { name: "Grace Smith" } });
    expect(r.ok).toBe(true);
    expect(v.exists(`${P}/Grace.md`)).toBe(false);
    expect(Object.fromEntries(read(v, `${P}/Grace Smith.md`).ordered).name).toBe("Grace Smith");
    await updateRow(v.app, v.settings, { table: "person", path: `${P}/Grace Smith.md`, set: { city: "Milan" } });
    expect(v.exists(`${P}/Grace Smith.md`)).toBe(true);
    // the name of another row: the moved note gets -2
    await updateRow(v.app, v.settings, { table: "person", path: `${P}/Paul.md`, set: { name: "Grace Smith" } });
    expect(v.exists(`${P}/Grace Smith-2.md`)).toBe(true);
  });
});

describe("row templates", () => {
  it("fill the row's values and leave other placeholders alone", async () => {
    const { renderRowTemplate } = await import("../src/core/rows");
    const values = new Map<string, unknown>([["date", "2026-04-12"], ["name", "Grace"]]);
    expect(renderRowTemplate('where: {"occurred_at": {"gte": "{date}T00:00"}}\n# {name} {date:YYYY} {today} {missing}', values))
      .toBe('where: {"occurred_at": {"gte": "2026-04-12T00:00"}}\n# Grace 2026 {today} {missing}');
  });
});
