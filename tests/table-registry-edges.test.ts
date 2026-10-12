import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { loadMetastore } from "../src/core/metastore";
import { deleteRows, insertRow } from "../src/core/rows";
import { listTables, validationContextFor } from "../src/core/table-registry";
import { createDbVault, logVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

describe("vocabulary columns", () => {
  it("allow the names of the vocabulary's rows, not of its archived rows; notes without properties are not rows", async () => {
    const v = createDbVault({ "Inbox/idea.md": "An idea, no properties yet.\n" });
    const feeling = await createTable(v.app, v.settings, described({ name: "feeling", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true, unique: true }] }));
    expect(feeling.ok).toBe(true);
    for (const name of ["calm", "tired", "angry"]) expect((await insertRow(v.app, v.settings, { table: "feeling", values: { name } })).ok).toBe(true);
    const archived = await deleteRows(v.app, v.settings, { table: "feeling", where: { name: "angry" } });
    expect(archived.ok).toBe(true);
    expect(v.exists("Datanotes/main/public/feeling/_archive/angry.md")).toBe(true);
    await createTable(v.app, v.settings, described({
      name: "mood",
      options: { filename: "{day}" },
      columns: [{ name: "day", type: "string", required: true }, { name: "feeling", type: "string", vocabulary: "main.public.feeling" }],
    }));
    const refused = await insertRow(v.app, v.settings, { table: "mood", values: { day: "monday", feeling: "angry" } });
    expect(refused.ok).toBe(false);
    expect(refused.violations[0]!.violations).toEqual([
      expect.objectContaining({ column: "feeling", code: "vocabulary", message: '"angry" is not in main.public.feeling (add it there, or use one of: calm, tired)' }),
    ]);
    expect((await insertRow(v.app, v.settings, { table: "mood", values: { day: "monday", feeling: "calm" } })).ok).toBe(true);
  });
});

describe("listTables", () => {
  it("orders tables with the same schema and name by path (their catalog)", async () => {
    const v = logVault();
    const r = await createTable(v.app, v.settings, described({ catalog: "home", schema: "public", name: "log", options: { filename: "{note}" }, columns: [{ name: "note", type: "string" }] }));
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(listTables(v.app, v.settings.databaseFolder).map((t) => t.qualified)).toEqual(["home.public.log", "main.public.log"]);
  });
});

describe("validationContextFor", () => {
  it("knows no table before the metastore is loaded", () => {
    const v = logVault();
    const ctx = validationContextFor(v.app, v.settings, "Daily/b.md");
    expect(ctx.vocabulary!("main.public.log")).toBeNull();
    expect(ctx.tableOfPath!("Daily/a.md")).toBeNull();
    expect(ctx.resolveLink!("a")).toBe("Daily/a.md");
  });

  it("names the table of a row, and null for anything that is not a row", async () => {
    const v = logVault({
      "Files/scan.pdf": "%PDF-1.4\n",
      "Notes/plain.md": "No properties.\n",
      "Notes/elsewhere.md": "---\ntable: main.public.nowhere\n---\n",
    });
    await loadMetastore(v.app, v.settings);
    const ctx = validationContextFor(v.app, v.settings, "Daily/b.md");
    expect(ctx.tableOfPath!("Daily/a.md")).toBe("main.public.log");
    expect(ctx.tableOfPath!("Files/scan.pdf")).toBeNull(); // an attachment
    expect(ctx.tableOfPath!("Daily")).toBeNull(); // a folder
    expect(ctx.tableOfPath!("Notes/missing.md")).toBeNull();
    expect(ctx.tableOfPath!("Notes/plain.md")).toBeNull();
    expect(ctx.tableOfPath!("Notes/elsewhere.md")).toBeNull(); // a table that does not exist
    expect(ctx.resolveLink!("nothing here")).toBeNull();
  });
});
