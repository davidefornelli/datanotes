import { describe, expect, it } from "vitest";
import { INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { alignRelations } from "../src/core/relations";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
const YAML = `catalogs:
  main:
    schemas:
      public:
        tables:
          person:
            options: { filename: "{name}" }
            columns:
              - ${ID}
              - { name: name, type: string, required: true, dense: true }
              - { name: friends, type: list, items: link, ref: self, inverse: friends }
          tag:
            options: { filename: "{label}" }
            columns:
              - ${ID}
              - { name: label, type: string, required: true, dense: true }
              - { name: people, type: list, items: link, ref: main.public.person }
`;

let n = 0;
const person = (name: string, extra = "") => `---\ntable: main.public.person\nid: 01a0f000-0000-7000-8000-${String(++n).padStart(12, "0")}\nname: ${name}\n${extra}---\n`;

/** Alice and Dave name friends who do not name them back (links written by hand). */
function vault(): DbVault {
  return createDbVault({
    [METASTORE]: YAML,
    "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n'),
    "P/Carol.md": person("Carol"),
    "P/Dave.md": person("Dave", 'friends: ["[[Mark]]"]\n'),
    "P/Mark.md": person("Mark"),
    "T/Family.md": `---\ntable: main.public.tag\nid: 01a0f000-0000-7000-8000-000000000900\nlabel: Family\npeople: ["[[Alice]]"]\n---\n`,
  });
}

const friends = (v: DbVault, p: string) => (Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered).friends as unknown) ?? null;

describe("align_relations", () => {
  it("only the rows given in paths (with or without .md) are aligned", async () => {
    const v = vault();
    const r = await alignRelations(v.app, v.settings, { table: "person", paths: ["P/Alice"] });
    expect([r.ok, r.op, r.notes_changed]).toEqual([true, "align_relations", 1]);
    expect(r.planned_edits.map((p) => p.path)).toEqual(["P/Carol.md"]);
    expect(friends(v, "P/Carol.md")).toEqual(["[[Alice]]"]);
    expect(friends(v, "P/Mark.md")).toBeNull(); // Dave was not in paths

    const dry = await alignRelations(v.app, v.settings, { table: "person", paths: ["P/Dave.md", "P/Carol.md"] }, { dryRun: true });
    expect([dry.ok, dry.dry_run, dry.planned_edits.map((p) => p.path)]).toEqual([true, true, ["P/Mark.md"]]);
    expect(friends(v, "P/Mark.md")).toBeNull();
  });

  it("paths that are no rows of the table align nothing", async () => {
    const v = vault();
    const r = await alignRelations(v.app, v.settings, { table: "person", paths: ["T/Family.md", "P/Nobody"] });
    expect([r.ok, r.notes_changed, r.planned_edits]).toEqual([true, 0, []]);
  });

  it("is refused on a table without inverse link columns", async () => {
    const v = vault();
    const p = alignRelations(v.app, v.settings, { table: "tag" });
    await expect(p).rejects.toThrow(OperationInputError);
    await expect(alignRelations(v.app, v.settings, { table: "tag" })).rejects.toThrow("main.public.tag has no inverse link columns");
  });
});
