import { describe, expect, it } from "vitest";
import { adoptCreatedNote } from "../src/core/auto-adopt";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { alterTable, insertRow } from "../src/core/rows";
import { parseMetastore } from "../src/core/metastore";
import { valuesFromFilename } from "../src/core/filename-values";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { createDbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

describe("valuesFromFilename", () => {
  it("reads values back from a filename pattern", () => {
    expect(valuesFromFilename("{date:YYYY-MM-DD}", "2026-09-30")).toEqual({ date: "2026-09-30" });
    expect(valuesFromFilename("{occurred_at:YYYY-MM-DD[T]HHmm}", "2026-09-30T0830")).toEqual({ occurred_at: "2026-09-30T08:30" });
    expect(valuesFromFilename("skill-{name}", "skill-metrics")).toEqual({ name: "metrics" });
    expect(valuesFromFilename("{name}", "Household & Everyday")).toEqual({ name: "Household & Everyday" });
    expect(valuesFromFilename("{date:YYYY-MM-DD}", "Untitled")).toBeNull();
    expect(valuesFromFilename("{date:YYYY-MM-DD}", "2026-09-30 1")).toBeNull();
  });
});

describe("notes created in a table folder", () => {
  it("become rows: table, values from the name, identity columns, row_template body", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    await createTable(v.app, v.settings, described({
      schema: "journal", name: "day", options: { filename: "{date:YYYY-MM-DD}" },
      columns: [{ name: "date", type: "date", required: true, unique: true }, { name: "mood", type: "string" }],
      rowTemplate: "# Day\n\n## Log\n",
    }));
    const P = "Datanotes/main/journal/day/2026-09-30.md";
    const f = v.write(P, "");
    const r = await adoptCreatedNote(v.app, v.settings, f);
    expect(r).toEqual({ adopted: true, table: "main.journal.day" });
    const { ordered, body } = readOrderedFromMarkdown(v.read(P));
    const fm = Object.fromEntries(ordered);
    expect(fm).toMatchObject({ table: "main.journal.day", date: "2026-09-30" });
    expect(String(fm.id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toContain("## Log");
    expect(v.exists(P)).toBe(true);

    // created with table: already (e.g. by TaskNotes): id and created_at are filled in
    const T = "Datanotes/main/journal/day/2026-10-01.md";
    const pre = v.write(T, "---\ntable: main.journal.day\ndate: 2026-10-01\n---\nbody\n");
    expect(await adoptCreatedNote(v.app, v.settings, pre)).toEqual({ adopted: true, table: "main.journal.day" });
    expect(v.read(T)).toMatch(/\nid: [0-9a-f-]{36}\n/);

    // already a row, outside table folders, or in the archive: left alone
    expect((await adoptCreatedNote(v.app, v.settings, f)).adopted).toBe(false);
    expect((await adoptCreatedNote(v.app, v.settings, v.write("Notes/x.md", ""))).adopted).toBe(false);
    expect((await adoptCreatedNote(v.app, v.settings, v.write("Datanotes/main/journal/day/_archive/2026-01-01.md", ""))).adopted).toBe(false);

    // a name that does not fit the pattern: refused (date is required), nothing breaks
    const bad = await adoptCreatedNote(v.app, v.settings, v.write("Datanotes/main/journal/day/Untitled.md", ""));
    expect(bad.adopted).toBe(false);
    expect(bad.reason).toMatch(/date/);
  });

  it("adopt a note named by a file-name identity column (the name is computed, not given)", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({
      name: "book", options: { filename: "{title}" },
      columns: [{ name: "title", type: "string", identity: "filename" }, { name: "author", type: "string" }],
    }));
    const P = "Datanotes/main/public/book/Snow Crash.md";
    const r = await adoptCreatedNote(v.app, v.settings, v.write(P, "---\nauthor: Neal Stephenson\n---\n"));
    expect(r).toEqual({ adopted: true, table: "main.public.book" });
    expect(Object.fromEntries(readOrderedFromMarkdown(v.read(P)).ordered)).toMatchObject({ table: "main.public.book", title: "Snow Crash", author: "Neal Stephenson" });
  });
});

describe("row_template", () => {
  it("is set by create_table(body) and alter_table(row_template), and used by insert_row", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ name: "note", options: { filename: "{t}" }, columns: [{ name: "t", type: "string" }], rowTemplate: "## A\n" }));
    const entry = () => parseMetastore(v.read(METASTORE)).catalogs.main!.schemas.public!.tables.note!;
    expect(entry().row_template).toBe("## A\n");
    expect((await alterTable(v.app, v.settings, { table: "note", rowTemplate: "## B\n" })).ok).toBe(true);
    expect(entry().row_template).toBe("## B\n");
    await insertRow(v.app, v.settings, { table: "note", values: { t: "x" } });
    expect(v.read("Datanotes/main/public/note/x.md")).toContain("## B");
    expect((await alterTable(v.app, v.settings, { table: "note", rowTemplate: null })).ok).toBe(true);
    expect(entry().row_template).toBeUndefined();
  });
});
