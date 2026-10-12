import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { adoptRows, insertRow, moveRows, select } from "../src/core/rows";
import { createDbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const NOTE = `---
description: Cleanup bathroom tiny
type: note
tags:
  - cleaning
when: 2026-09-05
spot: Bathroom tiny
chore: Cleanup
---

# Cleanup — Bathroom tiny

Text of the note.
`;

async function vault() {
  const v = createDbVault({
    "Household/Cleanups/2026-09-05 - Bathroom tiny.md": NOTE,
    "Household/Maintenance.md": "See [[Household/Cleanups/2026-09-05 - Bathroom tiny]].\n",
  });
  await createTable(v.app, v.settings, described({ schema: "home", name: "zone", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true, unique: true }] }));
  await insertRow(v.app, v.settings, { table: "zone", values: { name: "Bathroom tiny" } });
  await createTable(v.app, v.settings, described({
    schema: "home",
    name: "cleaning",
    timeColumn: "occurred_at",
    columns: [
      { name: "occurred_at", type: "datetime", required: true, dense: true },
      { name: "zone", type: "link", ref: "main.home.zone", required: true },
      { name: "activity", type: "string" },
      { name: "description", type: "string" },
    ],
  }));
  return v;
}

describe("adopt_rows", () => {
  it("turns an existing note into a row, keeping its body, and moves it through Obsidian", async () => {
    const v = await vault();
    const p = "Household/Cleanups/2026-09-05 - Bathroom tiny.md";
    const refused = await adoptRows(v.app, v.settings, { table: "cleaning", paths: [p], rename: { when: "occurred_at", chore: "activity" } });
    expect(refused.ok).toBe(false);
    // unknown keys are listed (never dropped silently); a date is not a date-time; zone is required
    expect(refused.violations[0]!.violations.map((x) => x.column).sort()).toEqual(["occurred_at", "spot", "tags", "type", "zone"]);
    const r = await adoptRows(v.app, v.settings, {
      table: "cleaning",
      paths: [p],
      rename: { when: "occurred_at", chore: "activity" },
      drop: ["type", "tags", "spot"],
      perRow: { [p]: { zone: "[[Bathroom tiny]]", occurred_at: "2026-09-05T09:00" } },
    });
    expect(r.ok).toBe(true);
    expect(r.planned_moves).toEqual([{ from: p, to: "Datanotes/main/home/cleaning/2026-09-05T0900.md" }]);
    const row = readOrderedFromMarkdown(v.read("Datanotes/main/home/cleaning/2026-09-05T0900.md"));
    expect(row.ordered[0]).toEqual(["table", "main.home.cleaning"]);
    expect(Object.fromEntries(row.ordered)).toMatchObject({ zone: "[[Bathroom tiny]]", activity: "Cleanup", description: "Cleanup bathroom tiny" });
    expect(Object.fromEntries(row.ordered).id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.body).toContain("Text of the note.");
    expect((await select(v.app, v.settings, { table: "cleaning" })).total).toBe(1);
    await expect(adoptRows(v.app, v.settings, { table: "cleaning", paths: ["Household/nope"] })).rejects.toThrow(/not found/);
    const again = await adoptRows(v.app, v.settings, { table: "zone", paths: ["Datanotes/main/home/cleaning/2026-09-05T0900"] });
    expect(again.conflicts[0]!.message).toMatch(/already a row of main.home.cleaning/);
  });

  it("move_rows can relocate rows to the destination folder", async () => {
    const v = await vault();
    await createTable(v.app, v.settings, described({ name: "log", timeColumn: "occurred_at", columns: [{ name: "occurred_at", type: "datetime", required: true, dense: true }, { name: "description", type: "string" }] }));
    await insertRow(v.app, v.settings, { table: "log", values: { occurred_at: "2026-05-16T14:46", description: "Cleanup kitchen" } });
    await insertRow(v.app, v.settings, { table: "zone", values: { name: "Kitchen" } });
    const r = await moveRows(v.app, v.settings, { table: "log", toTable: "cleaning", set: { zone: "[[Kitchen]]", activity: "Cleanup" }, relocate: true });
    expect(r.ok).toBe(true);
    expect(r.planned_moves).toEqual([{ from: "Datanotes/main/public/log/2026-05-16T1446.md", to: "Datanotes/main/home/cleaning/2026-05-16T1446.md" }]);
  });

  it("relocates into a table named by a file-name identity column, keeping each note's name", async () => {
    const v = createDbVault({ "Reading/Dune.md": "---\nauthor: Frank Herbert\n---\nRead it twice.\n" });
    await createTable(v.app, v.settings, described({ name: "book", options: { filename: "{title}" }, columns: [{ name: "title", type: "string", identity: "filename" }, { name: "author", type: "string" }] }));
    const r = await adoptRows(v.app, v.settings, { table: "book", paths: ["Reading/Dune.md"], relocate: true });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(r.planned_moves).toEqual([{ from: "Reading/Dune.md", to: "Datanotes/main/public/book/Dune.md" }]);
    expect(Object.fromEntries(readOrderedFromMarkdown(v.read("Datanotes/main/public/book/Dune.md")).ordered)).toMatchObject({ title: "Dune", author: "Frank Herbert" });

    // insert_row may give the file-name identity: it names the note, which then holds the name it got.
    const ins = await insertRow(v.app, v.settings, { table: "book", values: { title: "Dune", author: "again" } });
    expect(ins.ok, JSON.stringify(ins.violations)).toBe(true);
    expect(ins.planned_creates).toEqual(["Datanotes/main/public/book/Dune-2.md"]);
    expect(Object.fromEntries(readOrderedFromMarkdown(v.read("Datanotes/main/public/book/Dune-2.md")).ordered).title).toBe("Dune-2");
  });
});
