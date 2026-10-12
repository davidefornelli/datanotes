/**
 * move_rows and adopt_rows at their edges: generated columns set, tables without a filename
 * pattern, relocated notes whose names are taken, refusals of `paths` and `per_row`, and notes
 * adopted into a hierarchy that would make a cycle.
 */

import { describe, expect, it } from "vitest";
import { INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { adoptRows, moveRows } from "../src/core/rows";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/** `walk` named by `name` (`label` = "{name}!"), `memo` without a filename pattern, `topic` a hierarchy. */
const TABLES = `walk:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string }
    - { name: label, type: string, generated: "{name}!" }
memo:
  columns:
    - ${ID}
    - { name: name, type: string }
topic:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string }
    - { name: parent, type: link, ref: self, hierarchy: true }
`;
const W = "Datanotes/main/public/walk";

function vault(extra: Record<string, string> = {}): DbVault {
  return createDbVault({
    [METASTORE]: withTables(TABLES),
    "Daily/a.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: walk\noccurred_at: 2026-09-25T22:30\n---\nA\n",
    ...extra,
  });
}

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);

async function refused(p: Promise<unknown>, message: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(OperationInputError);
  await expect(p).rejects.toThrow(message);
}

describe("refusals", () => {
  it("a generated column cannot be set while moving or adopting", async () => {
    const v = vault({ "Inbox/Park.md": "A walk.\n" });
    const message = `"label" is a generated column: its value is computed`;
    await refused(moveRows(v.app, v.settings, { table: "log", toTable: "walk", drop: ["kind", "occurred_at"], set: { label: "x" } }), message);
    await refused(adoptRows(v.app, v.settings, { table: "walk", paths: ["Inbox/Park.md"], perRow: { "Inbox/Park.md": { label: "x" } } }), message);
  });

  it("a rename cannot target a generated or identity column (its value would be discarded)", async () => {
    const v = vault({ "Inbox/Park.md": "---\nlabel_old: Mine\nuid: x\n---\nA walk.\n" });
    await refused(
      moveRows(v.app, v.settings, { table: "log", toTable: "walk", drop: ["occurred_at"], rename: { kind: "label" } }),
      `rename target "label" is a generated column: its value is computed`,
    );
    await refused(
      adoptRows(v.app, v.settings, { table: "walk", paths: ["Inbox/Park.md"], rename: { label_old: "label" }, set: { name: "Park" } }),
      `rename target "label" is a generated column: its value is computed`,
    );
    await refused(
      adoptRows(v.app, v.settings, { table: "walk", paths: ["Inbox/Park.md"], rename: { uid: "id" }, drop: ["label_old"], set: { name: "Park" } }),
      `rename target "id" is a generated column: its value is computed`,
    );
  });

  it("adopt_rows needs paths, and per_row only for them", async () => {
    const v = vault({ "Inbox/Park.md": "A walk.\n" });
    await refused(adoptRows(v.app, v.settings, { table: "walk", paths: [] }), `"paths" needs at least one note`);
    await refused(adoptRows(v.app, v.settings, { table: "walk", paths: "Inbox/Park.md" as never }), `"paths" needs at least one note`);
    await refused(adoptRows(v.app, v.settings, { table: "walk", paths: ["Inbox/Park"], perRow: { "Inbox/Lake": { name: "Lake" } } }), `per_row: Inbox/Lake.md is not in "paths"`);
  });

  it("a table without a filename pattern cannot take relocated notes; in place it can", async () => {
    const v = vault({ "Inbox/Idea.md": "An idea.\n" });
    await refused(adoptRows(v.app, v.settings, { table: "memo", paths: ["Inbox/Idea.md"], set: { name: "Idea" } }), `table "memo" has no filename pattern: cannot relocate rows`);
    const r = await adoptRows(v.app, v.settings, { table: "memo", paths: ["Inbox/Idea.md"], set: { name: "Idea" }, relocate: false });
    expect([r.ok, r.planned_moves]).toEqual([true, []]);
    expect(fm(v, "Inbox/Idea.md")).toMatchObject({ table: "main.public.memo", name: "Idea" });
  });
});

describe("links left behind", () => {
  it("only the tables that link to the source are read: a broken table that does not is no obstacle", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(`${TABLES}broken:\n  columns:\n    - ${ID}\n    - { name: x, type: nope }\n`),
      "Daily/a.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: walk\noccurred_at: 2026-09-25T22:30\n---\nA\n",
    });
    const r = await moveRows(v.app, v.settings, { table: "log", toTable: "memo", drop: ["kind", "occurred_at"], set: { name: "a" } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(fm(v, "Daily/a.md")).toMatchObject({ table: "main.public.memo", name: "a" });
  });
});

describe("relocated notes", () => {
  it("take -2, -3 when their name is taken by a row there or by another note of the same operation", async () => {
    const v = vault({
      [`${W}/Park.md`]: "---\ntable: main.public.walk\nid: 01a0f000-0000-7000-8000-0000000000c1\nname: Park\nlabel: Park!\n---\n",
      "Inbox/Park.md": "Morning.\n",
      "Old/Park.md": "Evening.\n",
    });
    const r = await adoptRows(v.app, v.settings, { table: "walk", paths: ["Inbox/Park.md", "Old/Park.md"], set: { name: "Park" } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.planned_moves).toEqual([
      { from: "Inbox/Park.md", to: `${W}/Park-2.md` },
      { from: "Old/Park.md", to: `${W}/Park-3.md` },
    ]);
    expect(readOrderedFromMarkdown(v.read(`${W}/Park-3.md`)).body).toBe("Evening.\n");
    expect(fm(v, `${W}/Park-2.md`)).toMatchObject({ table: "main.public.walk", name: "Park", label: "Park!" });
  });
});

describe("hierarchy", () => {
  it("a note adopted under a row whose parent it is: refused, a cycle", async () => {
    const v = vault({
      "T/Pets.md": '---\ntable: main.public.topic\nid: 01a0f000-0000-7000-8000-0000000000c2\nname: Pets\nparent: "[[Cats]]"\n---\n',
      "Notes/Cats.md": '---\nparent: "[[Pets]]"\n---\n',
    });
    const r = await adoptRows(v.app, v.settings, { table: "topic", paths: ["Notes/Cats.md"], set: { name: "Cats" }, relocate: false });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ path: "Notes/Cats.md", violations: [{ column: "parent", code: "cycle", message: `would make "Cats" its own ancestor (Cats → Pets → Cats)` }] }]);
  });
});
