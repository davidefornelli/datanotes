/**
 * move_rows and adopt_rows: a move that would leave other rows' links pointing out of their `ref`
 * table is refused, naming them; notes that link to one another are adopted together; adopt_rows
 * without `paths` gets its refusal, not a TypeError.
 */

import { describe, expect, it } from "vitest";
import { INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { adoptRows, moveRows } from "../src/core/rows";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/** `area` rows linked from `task` (and from their sub-areas); `place` takes moved areas; `topic` links to itself. */
const TABLES = `area:
  options: { filename: "{title}" }
  columns:
    - ${ID}
    - { name: title, type: string }
    - { name: within, type: link, ref: self }
place:
  options: { filename: "{title}" }
  columns:
    - ${ID}
    - { name: title, type: string }
    - { name: within, type: link, ref: main.public.area }
task:
  options: { filename: "{title}" }
  columns:
    - ${ID}
    - { name: title, type: string }
    - { name: area, type: link, ref: main.public.area }
    - { name: see, type: list, items: link, ref: main.public.area }
topic:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string }
    - { name: related, type: list, items: link, ref: self }
`;

const area = (n: number, title: string, within?: string) =>
  `---\ntable: main.public.area\nid: 01a0f000-0000-7000-8000-0000000000a${n}\ntitle: ${title}\n${within ? `within: "[[${within}]]"\n` : ""}---\n`;
const task = (n: number, title: string, a: string, see: string[] = []) =>
  `---\ntable: main.public.task\nid: 01a0f000-0000-7000-8000-0000000000b${n}\ntitle: ${title}\narea: "[[${a}]]"\n${see.length ? `see: [${see.map((s) => `"[[${s}]]"`).join(", ")}]\n` : ""}---\n`;

function vault(): DbVault {
  return createDbVault({
    [METASTORE]: withTables(TABLES),
    "Areas/House.md": area(1, "House"),
    "Areas/Garden.md": area(2, "Garden"),
    "Areas/Kitchen.md": area(3, "Kitchen", "House"),
    "Tasks/Dishes.md": task(1, "Dishes", "Kitchen", ["House", "House"]),
    "Tasks/Roof.md": task(2, "Roof", "House"),
  });
}

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);

describe("move_rows and the links to the moved rows", () => {
  it("is refused while rows staying behind link to a moved row through a column of the source table", async () => {
    const v = vault();
    const before = v.read("Areas/House.md");
    const r = await moveRows(v.app, v.settings, { table: "area", toTable: "place", where: { title: "House" } });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([
      {
        path: "Areas/House.md",
        message: 'linked from Areas/Kitchen.md ("within"), Tasks/Dishes.md ("see"), Tasks/Roof.md ("area"), which must link to a row of main.public.area: change or clear those links first',
      },
    ]);
    expect(v.read("Areas/House.md")).toBe(before);
  });

  it("moves rows nothing links to, and rows moved together with the rows linking to them", async () => {
    const v = vault();
    const r = await moveRows(v.app, v.settings, { table: "area", toTable: "place", where: { title: "Garden" } });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    expect(fm(v, "Areas/Garden.md").table).toBe("main.public.place");
    // Kitchen is linked from Dishes (a task): refused, as House is
    const both = await moveRows(v.app, v.settings, { table: "area", toTable: "place", where: { title: { in: ["House", "Kitchen"] } } });
    expect(both.conflicts.map((c) => c.path)).toEqual(["Areas/House.md", "Areas/Kitchen.md"]);
    expect(both.conflicts[0]!.message).not.toContain("Areas/Kitchen.md");
  });
});

describe("adopt_rows", () => {
  it("adopts notes that link to one another, relocated or in place", async () => {
    for (const relocate of [true, false]) {
      const v = createDbVault({
        [METASTORE]: withTables(TABLES),
        "Inbox/Alpha.md": '---\nname: Alpha\nrelated: ["[[Beta]]"]\n---\nA\n',
        "Inbox/Beta.md": '---\nname: Beta\nrelated: ["[[Alpha]]", "[[Gamma]]"]\n---\nB\n',
        "Inbox/Gamma.md": "---\nname: Gamma\n---\nG\n",
      });
      const r = await adoptRows(v.app, v.settings, { table: "topic", paths: ["Inbox/Alpha.md", "Inbox/Beta.md", "Inbox/Gamma.md"], relocate });
      expect(r.ok, JSON.stringify([r.conflicts, r.violations])).toBe(true);
      const dir = relocate ? "Datanotes/main/public/topic" : "Inbox";
      expect(fm(v, `${dir}/Beta.md`)).toMatchObject({ table: "main.public.topic", related: ["[[Alpha]]", "[[Gamma]]"] });
    }
  });

  it("still refuses a link to a note that is not adopted with them", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(TABLES),
      "Inbox/Alpha.md": '---\nname: Alpha\nrelated: ["[[Beta]]"]\n---\nA\n',
      "Inbox/Beta.md": "---\nname: Beta\n---\nB\n",
    });
    const r = await adoptRows(v.app, v.settings, { table: "topic", paths: ["Inbox/Alpha.md"] });
    expect(r.ok).toBe(false);
    expect(r.violations.flatMap((x) => x.violations.map((y) => y.code))).toEqual(["ref"]);
  });

  it("without paths is refused with its message (not a TypeError)", async () => {
    const v = vault();
    const p = adoptRows(v.app, v.settings, { table: "topic" } as never);
    await expect(p).rejects.toBeInstanceOf(OperationInputError);
    await expect(p).rejects.toThrow(`"paths" needs at least one note`);
  });
});
