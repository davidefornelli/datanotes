import { describe, expect, it } from "vitest";
import { bodyOf, replaceBody } from "../src/core/changeset";
import { addColumn, alterColumn, INDEX_RETRY, undoOperation, uniqueViolations } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { checkTable, insertRow, moveRows, select, updateRow, updateRows } from "../src/core/rows";
import { parseColumn } from "../src/core/table-loader";
import { createDbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
const YAML = `catalogs:
  main:
    schemas:
      public:
        tables:
          skill:
            options:
              filename: "skill-{name}"
            columns:
              - ${ID}
              - { name: name, type: string, required: true, unique: true, dense: true }
              - { name: description, type: string, required: true, dense: true }
              - { name: status, type: enum, values: [draft, active, deprecated], default: active, dense: true }
          draft:
            options:
              filename: "{name}"
            columns:
              - ${ID}
              - { name: name, type: string }
              - { name: description, type: string }
`;

let seq = 0;
/** A row of `table` with a fresh fixed id. */
const rowOf = (table: string, rest: string) =>
  `---\ntable: main.public.${table}\nid: 01a0f000-0000-7000-8000-${String(++seq).padStart(12, "0")}\n${rest}`;

function vault(extra: Record<string, string> = {}) {
  return createDbVault({
    [METASTORE]: YAML,
    "Skills/skill-a.md": rowOf("skill", 'name: a\ndescription: first\nstatus: active\n---\n## Goal\n\nDo A.\n'),
    "Skills/skill-b.md": rowOf("skill", 'name: b\ndescription: second\nstatus: draft\n---\nDo B.\n'),
    ...extra,
  });
}

const fm = (v: { read(p: string): string }, p: string) =>
  Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);

describe("body helpers", () => {
  it("bodyOf / replaceBody keep the frontmatter byte-for-byte", () => {
    const text = '---\na: "x"   \n---\nold body\n';
    expect(bodyOf(text)).toBe("old body\n");
    expect(replaceBody(text, "new\n")).toBe('---\na: "x"   \n---\nnew\n');
    expect(bodyOf("no frontmatter")).toBe("no frontmatter");
    expect(replaceBody("no frontmatter", "x")).toBe("x");
    expect(replaceBody("---\na: 1\n---", "b")).toBe("---\na: 1\n---b");
  });
});

describe("unique columns", () => {
  it("parses unique and rejects it on lists or non-booleans", () => {
    expect(parseColumn({ name: "n", type: "string", unique: true }, 0).unique).toBe(true);
    expect(() => parseColumn({ name: "n", type: "string", unique: "yes" }, 0)).toThrow(/"unique" must be true or false/);
    expect(() => parseColumn({ name: "n", type: "list", unique: true }, 0)).toThrow(/not valid for list/);
  });

  it("uniqueViolations compares strings case-insensitively and other values exactly", () => {
    const cols = [
      { name: "n", type: "string" as const, required: false, aliases: [], unique: true },
      { name: "k", type: "integer" as const, required: false, aliases: [], unique: true },
      { name: "free", type: "string" as const, required: false, aliases: [] },
    ];
    const out = uniqueViolations(cols, [
      { path: "a", ordered: [["n", "Foo"], ["k", 1], ["free", "x"]] },
      { path: "b", ordered: [["n", "foo "], ["k", 2], ["free", "x"]] },
      { path: "c", ordered: [["n", ""], ["k", 1]] },
      { path: "d", ordered: [["k", null]] },
    ]);
    expect(out.map((u) => [u.path, u.violations.map((v) => v.column)])).toEqual([
      ["a", ["n", "k"]],
      ["b", ["n"]],
      ["c", ["k"]],
    ]);
    expect(out[0]!.violations[0]!.message).toBe("must be unique (also used by b)");
  });

  it("insert, update, move, check, add_column and alter_column enforce uniqueness", async () => {
    const v = vault({
      "Drafts/x.md": rowOf("draft", 'name: A\ndescription: dup of a\n---\n'),
    });
    const ins = await insertRow(v.app, v.settings, { table: "skill", values: { name: "A", description: "dup" } });
    expect(ins.violations[0]!.violations.map((x) => x.code)).toEqual(["unique"]);
    const okIns = await insertRow(v.app, v.settings, { table: "skill", values: { name: "c", description: "third" }, body: "Do C.\n" });
    expect(okIns.ok).toBe(true);
    expect(v.read("Datanotes/main/public/skill/skill-c.md")).toContain("Do C.");
    const upd = await updateRows(v.app, v.settings, { table: "skill", where: { name: "b" }, set: { name: "a" } });
    expect(upd.violations.map((x) => x.path)).toEqual(["Skills/skill-b.md"]);
    const mv = await moveRows(v.app, v.settings, { table: "draft", toTable: "skill" });
    expect(mv.violations.map((x) => x.violations.map((y) => y.code))).toEqual([["unique"]]);
    v.write("Skills/skill-z.md", rowOf("skill", 'name: B\ndescription: hand-made duplicate\n---\n'));
    const chk = await checkTable(v.app, v.settings, { table: "skill" });
    expect(chk.violations.map((x) => x.path).sort()).toEqual(["Skills/skill-b.md", "Skills/skill-z.md"]);
    const add = await addColumn(v.app, v.settings, described({ table: "skill", column: { name: "status", type: "string", unique: true } })).catch((e) => e);
    expect(add).toBeInstanceOf(Error); // already exists
    const alt = await alterColumn(v.app, v.settings, { table: "skill", name: "status", changes: { unique: true } });
    expect(alt.ok).toBe(false);
    const v2 = vault();
    const added = await addColumn(v2.app, v2.settings, described({ table: "skill", column: { name: "slug", type: "string", unique: true } }));
    expect(added.ok).toBe(true);
    const v3 = vault({ "Skills/skill-q.md": rowOf("skill", 'name: q\ndescription: d\nnote_id: 1\n---\n'), "Skills/skill-r.md": rowOf("skill", 'name: r\ndescription: d\nnote_id: 1\n---\n') });
    const dupAdd = await addColumn(v3.app, v3.settings, described({ table: "skill", column: { name: "note_id", type: "integer", unique: true } }));
    expect(dupAdd.violations.map((x) => x.path).sort()).toEqual(["Skills/skill-q.md", "Skills/skill-r.md"]);
  });
});

describe("note bodies", () => {
  it("select can include bodies", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "skill", columns: ["name"], where: { name: "a" }, includeBody: true });
    expect(r.rows).toEqual([{ path: "Skills/skill-a.md", name: "a", body: "## Goal\n\nDo A.\n" }]);
  });

  it("update_row replaces a body (with or without front matter changes), undo restores it", async () => {
    const v = vault();
    const r = await updateRow(v.app, v.settings, { table: "skill", path: "Skills/skill-a.md", body: "## Goal\n\nDo A better.\n" });
    expect(r.ok).toBe(true);
    expect(r.planned_edits).toEqual([{ path: "Skills/skill-a.md", set: {}, remove: [], body: true }]);
    expect(v.read("Skills/skill-a.md")).toMatch(/^---\ntable: main.public.skill\nid: [0-9a-f-]+\nname: a\ndescription: first\nstatus: active\n---\n## Goal\n\nDo A better.\n$/);
    const both = await updateRow(v.app, v.settings, { table: "skill", path: "Skills/skill-b.md", set: { status: "active" }, body: "Do B now.\n" });
    expect(both.ok).toBe(true);
    expect(fm(v, "Skills/skill-b.md").status).toBe("active");
    expect(v.read("Skills/skill-b.md")).toContain("Do B now.");
    expect((await undoOperation(v.app, v.settings, r.migration_id!)).ok).toBe(true);
    expect(v.read("Skills/skill-a.md")).toContain("Do A.\n");
    expect((await undoOperation(v.app, v.settings, both.migration_id!)).ok).toBe(true);
    expect(v.read("Skills/skill-b.md")).toContain("Do B.\n");
    expect(fm(v, "Skills/skill-b.md").status).toBe("draft");
  });

  it("a body update refuses to undo over a concurrent edit", async () => {
    const v = vault();
    const r = await updateRow(v.app, v.settings, { table: "skill", path: "Skills/skill-a.md", body: "v2\n" });
    v.write("Skills/skill-a.md", v.read("Skills/skill-a.md").replace("v2", "edited by hand"));
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok).toBe(false);
    expect(u.conflicts[0]!.message).toBe("body changed since the operation");
    // a stale bodyBefore makes the write fail (reported, journaled)
    const { applyChangeSet, emptyChangeSet } = await import("../src/core/changeset");
    const cs = emptyChangeSet("custom", "stale body");
    cs.edits.push({ path: "Skills/skill-b.md", before: [], after: [], bodyBefore: "not the body", bodyAfter: "x" });
    const res = await applyChangeSet(v.app, v.settings, cs);
    expect(res.failed[0]!.error).toBe("note body changed since it was read");
  });
});
