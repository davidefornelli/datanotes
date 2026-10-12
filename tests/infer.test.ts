import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { columnNameFor, inferTable } from "../src/core/infer";
import { adoptRows, checkTable } from "../src/core/rows";
import { createDbVault, logVault, METASTORE, withTables } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const book = (title: string, extra: string) => `---\ntitle: ${title}\n${extra}---\nNotes on ${title}.\n`;

function booksVault() {
  return createDbVault({
    [METASTORE]: withTables(
      "person:\n  options: { filename: \"{name}\" }\n  columns:\n    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }\n    - { name: name, type: string }\n",
    ),
    "People/Herbert.md": "---\ntable: main.public.person\nid: 01a0f000-0000-7000-8000-000000000001\nname: Herbert\n---\n",
    "People/Le Guin.md": "---\ntable: main.public.person\nid: 01a0f000-0000-7000-8000-000000000002\nname: Le Guin\n---\n",
    "Books/Dune.md": book("Dune", 'author: "[[Herbert]]"\nyear: 1965\ngenre: scifi\nrating: 4.5\nRead on: 2026-01-10\ntags: [classic, desert]\n'),
    "Books/Earthsea.md": book("Earthsea", 'author: "[[Le Guin]]"\nyear: 1968\ngenre: fantasy\nrating: 5\nRead on: 2026-02-01\ntags: [classic]\n'),
    "Books/Dispossessed.md": book("Dispossessed", 'author: "[[Le Guin]]"\nyear: 1974\ngenre: scifi\nrating: 4\ntags: [classic, politics]\n'),
    "Books/Children of Dune.md": book("Children of Dune", 'author: "[[Herbert]]"\nyear: 1976\ngenre: scifi\nrating: 3\n'),
    "Books/Lathe.md": book("Lathe", 'author: "[[Le Guin]]"\nyear: 1971\ngenre: scifi\nrating: 4\n'),
    "Books/Done.md": "---\ntable: main.public.log\nkind: mood\n---\n",
  });
}

describe("inferTable", () => {
  it("proposes a table from a folder: types, enums, links with ref, required, file names", async () => {
    const v = booksVault();
    const r = await inferTable(v.app, v.settings, { folder: "Books" });
    expect(r.files).toBe(5);
    expect(r.skipped).toEqual([{ path: "Books/Done.md", reason: "already a row of main.public.log" }]);
    const col = (n: string) => r.columns.find((c) => c.name === n)!;
    expect(col("title")).toMatchObject({ type: "string", required: true, unique: true, dense: true });
    expect(col("author")).toMatchObject({ type: "link", ref: "main.public.person", required: true });
    expect(col("year")).toMatchObject({ type: "integer", required: true });
    expect(col("rating")).toMatchObject({ type: "number" });
    expect(col("genre")).toMatchObject({ type: "enum", values: ["scifi", "fantasy"] });
    expect(col("read_on")).toMatchObject({ from: "Read on", type: "date" });
    expect(col("read_on").required).toBeUndefined();
    expect(col("tags")).toMatchObject({ type: "list", items: "string" }); // too few repeats for an enum
    expect(r.proposal).toMatchObject({ name: "books", options: { filename: "{title}" } });
    expect(r.adopt).toMatchObject({ rename: { "Read on": "read_on" }, relocate: false });
  });

  it("the proposal can be created and the notes adopted as valid rows", async () => {
    const v = booksVault();
    const r = await inferTable(v.app, v.settings, { folder: "Books", name: "book" });
    const created = await createTable(v.app, v.settings, described(r.proposal as never));
    expect(created.ok).toBe(true);
    const adopted = await adoptRows(v.app, v.settings, { table: "book", ...r.adopt! });
    expect(adopted.ok, JSON.stringify(adopted.violations)).toBe(true);
    expect((await checkTable(v.app, v.settings, { table: "book" })).violations).toEqual([]);
  });

  it("lists the keys a table's rows use without declaring them", async () => {
    const v = logVault({
      "Daily/c.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000c\nkind: walk\noccurred_at: 2026-09-20T10:00\nsteps: 8000\n---\n",
    });
    const r = await inferTable(v.app, v.settings, { table: "log" });
    expect(r.columns.map((c) => [c.name, c.type, c.stats.present])).toEqual([["steps", "integer", 1]]);
    expect(r.columns[0]!.required).toBeUndefined();
    expect(r.proposal).toBeUndefined();
  });

  it("needs a source and makes valid column names", async () => {
    const v = createDbVault({});
    await expect(inferTable(v.app, v.settings, {})).rejects.toThrow(/folder/);
    expect(columnNameFor("Café name")).toBe("cafe_name");
    expect(columnNameFor("2nd")).toBe("c_2nd");
    expect(columnNameFor("modelKey")).toBe("model_key");
  });
});
