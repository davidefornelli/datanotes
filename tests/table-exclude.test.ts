import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { checkTable, select } from "../src/core/rows";
import { parseTableOptions } from "../src/core/table-loader";
import { createDbVault, METASTORE } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const YAML = (exclude: string) => `catalogs:
  main:
    schemas:
      public:
        tables:
          log:
            options:
              filename: "{kind}"
              archive: _archive${exclude}
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: kind, type: enum, values: [mood, note], required: true }
`;
const row = (id: string, kind: string) => `---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000${id}\nkind: ${kind}\n---\n`;

function vault(exclude: string) {
  return createDbVault({
    [METASTORE]: YAML(exclude),
    "T/variant.md": row("1", '"<% tp.system.prompt(\\"kind\\") %>"'),
    "Daily/a.md": row("2", "mood"),
    "Datanotes/main/public/log/_archive/older.md": row("3", "mood"),
  });
}

describe("exclude and archive", () => {
  it("parses a folder or a list of folders", () => {
    expect(parseTableOptions([{ exclude: "Templates/" }]).exclude).toEqual(["Templates"]);
    expect(parseTableOptions([{ exclude: ["A", "/B/"] }]).exclude).toEqual(["A", "B"]);
    expect(() => parseTableOptions([{ exclude: [""] }])).toThrow(/folder or a list of folders/);
    expect(() => parseTableOptions([{ exclude: 3 }])).toThrow(/folder or a list of folders/);
  });

  it("notes in excluded folders are not rows", async () => {
    const without = vault("");
    expect((await checkTable(without.app, without.settings, { table: "log" })).violations.map((v) => v.path)).toEqual(["T/variant.md"]);
    const v = vault("\n              exclude: [T]");
    expect((await select(v.app, v.settings, { table: "log" })).rows.map((r) => r.path)).toEqual(["Daily/a.md"]);
    expect((await checkTable(v.app, v.settings, { table: "log" })).violations).toEqual([]);
  });

  it("archived rows (in the table's archive folder) are not rows", async () => {
    const v = vault("\n              exclude: [T]");
    expect((await select(v.app, v.settings, { table: "log" })).total).toBe(1);
  });
});
