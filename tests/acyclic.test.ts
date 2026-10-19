/**
 * Acyclic link columns (`acyclic: true`): the pure graph functions, the definition, the writes that
 * would close a cycle (through the column or its inverse), cycles made by hand, and the schema
 * changes that meet rows which already form one.
 */

import { describe, expect, it } from "vitest";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { acyclicPairs, acyclicViolations, changeSetCycles, cycleThrough } from "../src/core/acyclic";
import { emptyChangeSet } from "../src/core/changeset";
import { addColumn, alterColumn, createTable, INDEX_RETRY } from "../src/core/engine";
import { checkExternalEdits } from "../src/core/external-edits";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { docsUrl } from "../src/core/hints";
import { describeTable } from "../src/core/public-api";
import { checkTable, deleteRows, insertRow, moveRows, select, syncRelations, updateRow } from "../src/core/rows";
import type { ColumnSpec } from "../src/core/types-table";
import { createHandlers, dispatch } from "../src/server/rest";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const DIR = "Datanotes/main/public/task";
const TASK = {
  name: "task",
  description: "Things to do",
  columns: [
    { name: "title", type: "string", required: true, description: "What to do" },
    { name: "blocked_by", type: "list", items: "link", ref: "self", acyclic: true, description: "Tasks that must be done first" },
    { name: "blocks", type: "list", items: "link", ref: "self", inverse: "blocked_by", description: "Tasks that wait for this one" },
  ],
  options: { filename: "{title}" },
};
const p = (name: string) => `${DIR}/${name}.md`;

async function vault(): Promise<DbVault> {
  const v = createDbVault({});
  const r = await createTable(v.app, v.settings, described(TASK));
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  return v;
}

const add = async (v: DbVault, title: string, values: Record<string, unknown> = {}) => {
  const r = await insertRow(v.app, v.settings, { table: "task", values: { title, ...values } });
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
};
const set = (v: DbVault, name: string, values: Record<string, unknown>) => updateRow(v.app, v.settings, { table: "task", path: p(name), set: values });
const fm = (v: DbVault, path: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(path)).ordered);
const col = (c: Partial<ColumnSpec> & { name: string }): ColumnSpec => ({ type: "link", ...c }) as ColumnSpec;
const row = (path: string, front: Record<string, unknown>) => ({ path, ordered: Object.entries(front) });

describe("pure functions", () => {
  it("acyclicPairs finds the inverse on either side, not a column of another table", () => {
    const table = "main.public.task";
    const declared = [col({ name: "a", ref: "self", acyclic: true, inverse: "b" }), col({ name: "b", ref: "self" })];
    expect(acyclicPairs(declared, table)).toEqual([{ column: "a", inverse: "b" }]);
    const other = [col({ name: "a", ref: "self", acyclic: true }), col({ name: "b", ref: table, inverse: "a" })];
    expect(acyclicPairs(other, table)).toEqual([{ column: "a", inverse: "b" }]);
    expect(acyclicPairs([col({ name: "a", ref: "self", acyclic: true })], table)).toEqual([{ column: "a", inverse: null }]);
    const elsewhere = [col({ name: "a", ref: "self", acyclic: true }), col({ name: "b", ref: "main.public.person", inverse: "a" })];
    expect(acyclicPairs(elsewhere, table)).toEqual([{ column: "a", inverse: null }]);
    const missing = [col({ name: "a", ref: "self", acyclic: true, inverse: "gone" })];
    expect(acyclicPairs(missing, table)).toEqual([{ column: "a", inverse: null }]);
    const full = [col({ name: "a", ref: table, acyclic: true }), col({ name: "b", ref: "self", inverse: "a" })];
    expect(acyclicPairs(full, table)).toEqual([{ column: "a", inverse: "b" }]);
  });

  it("cycleThrough returns the shortest cycle, in name order, or null", () => {
    const g = new Map([
      ["A", new Set(["B"])],
      ["B", new Set(["C", "A"])],
      ["C", new Set(["A"])],
    ]);
    expect(cycleThrough(g, "A")).toEqual(["A", "B", "A"]);
    expect(cycleThrough(g, "C")).toEqual(["C", "A", "B", "C"]);
    expect(cycleThrough(new Map([["A", new Set(["A"])]]), "A")).toEqual(["A", "A"]);
    expect(cycleThrough(new Map([["A", new Set(["B"])]]), "A")).toBeNull();
    expect(cycleThrough(new Map(), "A")).toBeNull();
  });

  it("acyclicViolations: wording, only, before, involving, links with a path and an alias", () => {
    const cols = [col({ name: "blocked_by", ref: "self", acyclic: true })];
    const rows = [
      row("T/A.md", { blocked_by: ["[[x/B|Bee]]"] }),
      row("T/B.md", { blocked_by: "[[A]]" }),
      row("T/C.md", { blocked_by: ["[[Nobody]]"] }),
    ];
    const t = "main.public.task";
    const check = acyclicViolations(cols, t, rows, { wording: "check" });
    expect(check.map((r) => r.path)).toEqual(["T/A.md", "T/B.md"]);
    expect(check[0]!.violations).toEqual([{ column: "blocked_by", code: "cycle", message: 'is on a cycle in "blocked_by" (A → B → A)' }]);
    expect(check[1]!.violations[0]!.message).toBe('is on a cycle in "blocked_by" (B → A → B)');
    expect(acyclicViolations(cols, t, rows, { wording: "check", only: new Set(["T/A.md"]) }).map((r) => r.path)).toEqual(["T/A.md"]);
    expect(acyclicViolations(cols, t, [...rows].reverse(), { wording: "check" }).map((r) => r.path)).toEqual(["T/A.md", "T/B.md"]);
    // the same path twice (a row listed by two sources) sorts as equal
    expect(acyclicViolations(cols, t, [rows[0]!, rows[0]!, rows[1]!], { wording: "check" }).map((r) => r.path)).toEqual(["T/A.md", "T/B.md"]);
    expect(acyclicViolations(cols, t, rows, { wording: "check", before: rows })).toEqual([]);
    expect(acyclicViolations(cols, t, rows, { wording: "check", involving: "other" })).toEqual([]);
    expect(acyclicViolations(cols, t, rows, { wording: "write" })[0]!.violations[0]!.message).toMatch(/^would close a cycle in /);
  });

  it("a single link column can be acyclic too", () => {
    const cols = [col({ name: "duplicate_of", type: "link", ref: "self", acyclic: true })];
    const rows = [row("T/A.md", { duplicate_of: "[[B]]" }), row("T/B.md", { duplicate_of: "[[A]]" })];
    expect(acyclicViolations(cols, "main.public.task", rows, { wording: "check" }).map((r) => r.path)).toEqual(["T/A.md", "T/B.md"]);
  });
});

describe("definition", () => {
  it("create_table takes acyclic: describe_table, metastore.yaml and information_schema show it", async () => {
    const v = await vault();
    const d = await describeTable(v.app, v.settings, "task");
    expect(d.columns.find((c) => c.name === "blocked_by")).toMatchObject({ acyclic: true });
    expect(d.columns.find((c) => c.name === "blocks")?.acyclic).toBeUndefined();
    expect(v.read(METASTORE)).toContain("acyclic: true");
    const rows = await select(v.app, v.settings, {
      table: "system.information_schema.columns",
      columns: ["column_name", "is_acyclic"],
      where: { table_name: "task" },
    } as never);
    const byName = Object.fromEntries((rows.rows as Record<string, unknown>[]).map((r) => [r.column_name, r.is_acyclic]));
    expect(byName.blocked_by).toBe("YES");
    expect(byName.title).toBe("NO");
  });

  it("refuses acyclic on a column that cannot hold it", async () => {
    const v = await vault();
    const bad = (column: Record<string, unknown>) => addColumn(v.app, v.settings, described({ table: "task", column }));
    const guided = { hint: expect.any(String), docs: docsUrl("acyclic") };
    await expect(bad({ name: "s", type: "string", acyclic: true })).rejects.toThrow(/"acyclic" needs a link column/);
    await expect(bad({ name: "s", type: "string", acyclic: true })).rejects.toMatchObject(guided);
    await expect(bad({ name: "s", type: "link", ref: "self", acyclic: "yes" })).rejects.toThrow(/"acyclic" must be true or false/);
    await expect(bad({ name: "s", type: "link", ref: "self", acyclic: "yes" })).rejects.toMatchObject(guided);
    await expect(bad({ name: "s", type: "link", ref: "self", acyclic: true, inverse: "s" })).rejects.toThrow(/its own inverse/);
    await expect(bad({ name: "s", type: "link", ref: "self", acyclic: true, inverse: "s" })).rejects.toMatchObject(guided);
    const note = await createTable(v.app, v.settings, described({ name: "note", columns: [{ name: "title", type: "string", required: true }], options: { filename: "{title}" } }));
    expect(note.ok).toBe(true);
    const other = (await bad({ name: "s", type: "link", ref: "main.public.note", acyclic: true }).catch((e: unknown) => e)) as { message: string; docs?: string };
    expect(other.message).toMatch(/an acyclic column must point at its own table/);
    expect(other.docs).toBe(docsUrl("acyclic"));
  });

  it("the guidance of a column that points elsewhere names the acyclic docs", async () => {
    const v = await vault();
    const create = createTable(v.app, v.settings, described({
      name: "film",
      columns: [
        { name: "title", type: "string", required: true },
        { name: "sequel", type: "link", ref: "main.public.task", acyclic: true },
      ],
      options: { filename: "{title}" },
    }));
    const err = (await create.catch((e: unknown) => e)) as { message: string; docs?: string };
    expect(err.message).toMatch(/an acyclic column must point at its own table/);
    expect(err.docs).toBe(docsUrl("acyclic"));
  });
});

describe("writes", () => {
  it("refuses a write that closes a cycle, and names the path", async () => {
    const v = await vault();
    await add(v, "A");
    await add(v, "B");
    await add(v, "C");
    expect((await set(v, "A", { blocked_by: ["[[B]]"] })).ok).toBe(true);
    expect((await set(v, "B", { blocked_by: ["[[C]]"] })).ok).toBe(true);
    const r = await set(v, "C", { blocked_by: ["[[A]]"] });
    expect(r.ok).toBe(false);
    // C is written, and so is A: the engine adds C to A's "blocks" (the inverse), which puts A on the cycle too
    expect(r.violations).toEqual([
      { path: p("A"), violations: [{ column: "blocked_by", code: "cycle", message: 'would close a cycle in "blocked_by" (A → B → C → A)' }] },
      { path: p("C"), violations: [{ column: "blocked_by", code: "cycle", message: 'would close a cycle in "blocked_by" (C → A → B → C)' }] },
    ]);
    const self = await set(v, "A", { blocked_by: ["[[A]]"] });
    expect(self.ok).toBe(false);
    expect(self.violations[0]!.violations[0]!.message).toMatch(/\(A → A\)$/);
    expect(fm(v, p("C")).blocked_by ?? []).toEqual([]);
    expect(fm(v, p("A")).blocked_by).toEqual(["[[B]]"]);
  });

  it("refuses the same cycle set through the inverse, and an insert that closes one", async () => {
    const v = await vault();
    await add(v, "A");
    await add(v, "B");
    expect((await set(v, "A", { blocked_by: ["[[B]]"] })).ok).toBe(true);
    const r = await set(v, "A", { blocks: ["[[B]]"] });
    expect(r.ok).toBe(false);
    expect(r.violations.map((x) => x.path).sort()).toEqual([p("A"), p("B")]);
    expect(r.violations.every((x) => x.violations.some((y) => y.code === "cycle"))).toBe(true);
    const ins = await insertRow(v.app, v.settings, { table: "task", values: { title: "N", blocked_by: ["[[A]]"], blocks: ["[[A]]"] } });
    expect(ins.ok).toBe(false);
    expect(ins.violations.map((x) => x.path)).toContain(p("N"));
    expect(v.exists(p("N"))).toBe(false);
  });

  /** A blocked_by B written through the engine, then B's note edited by hand to wait for A: a cycle. */
  async function handCycle() {
    const v = await vault();
    await add(v, "A");
    await add(v, "B");
    await add(v, "C");
    expect((await set(v, "A", { blocked_by: ["[[B]]"] })).ok).toBe(true);
    const before = readOrderedFromMarkdown(v.read(p("B"))).ordered;
    v.write(p("B"), v.read(p("B")).replace(/^blocks:.*\n(  - .*\n)*/m, "").replace(/\n---\n/, '\nblocked_by:\n  - "[[A]]"\n---\n'));
    return { v, before };
  }

  it("a cycle made by hand does not block other writes, and the mirror of the hand edit goes through", async () => {
    const { v } = await handCycle();
    expect(fm(v, p("B")).blocked_by).toEqual(["[[A]]"]);
    expect((await set(v, "C", { blocked_by: ["[[A]]"] })).ok).toBe(true);
    expect((await set(v, "A", { blocks: [] })).ok).toBe(true);
    const sync = await syncRelations(v.app, v.settings, [
      { path: p("B"), table: "main.public.task", before: new Map([["blocked_by", []], ["blocks", []]]), after: new Map([["blocked_by", [p("A")]], ["blocks", []]]) },
    ] as never);
    expect(sync?.ok, JSON.stringify(sync?.violations)).toBe(true);
  });

  it("check_table and the hand-edit checks report a cycle made by hand", async () => {
    const { v, before } = await handCycle();
    const c = await checkTable(v.app, v.settings, { table: "task" });
    const bad = c.violations.filter((r) => r.violations.some((x) => /^is on a cycle in "blocked_by"/.test(x.message ?? "")));
    expect(bad.map((r) => r.path).sort()).toEqual([p("A"), p("B")]);
    const ext = await checkExternalEdits(v.app, v.settings, [{ path: p("B"), before }]);
    expect(ext.byPath.get(p("B"))?.some((x) => x.code === "cycle" && x.column === "blocked_by")).toBe(true);
  });

  it("a batch is refused at the step that closes a cycle, and leaves nothing written", async () => {
    const v = await vault();
    await add(v, "A");
    await add(v, "B");
    const handlers = createHandlers(v.app, () => v.settings);
    const req = operationRequest("batch", {
      operations: [
        { op: "update_row", table: "task", path: p("A"), set: { blocked_by: ["[[B]]"] } },
        { op: "update_row", table: "task", path: p("B"), set: { blocked_by: ["[[A]]"] } },
      ],
    });
    const route = req.path.slice(ROUTE_PREFIX.length);
    const answer = (await dispatch(route, handlers[route]!, req.body)) as { status: number; json: { failed_at?: number } };
    expect(answer.status).toBe(422);
    expect(answer.json.failed_at).toBe(1);
    expect(fm(v, p("A")).blocked_by ?? []).toEqual([]);
  });

  it("delete, archive, move and rename keep the check working", async () => {
    const v = await vault();
    for (const t of ["A", "B", "C", "D", "Z"]) await add(v, t);
    expect((await set(v, "A", { blocked_by: ["[[B]]"] })).ok).toBe(true);
    expect((await set(v, "C", { blocked_by: ["[[D]]"] })).ok).toBe(true);
    expect((await deleteRows(v.app, v.settings, { table: "task", where: { title: "B" }, mode: "delete", onReferenced: "set_null" })).ok).toBe(true);
    expect((await deleteRows(v.app, v.settings, { table: "task", where: { title: "D" }, mode: "archive", onReferenced: "set_null" })).ok).toBe(true);
    // a rename and a link change in one write
    expect((await set(v, "A", { title: "A2", blocked_by: ["[[C]]"] })).ok).toBe(true);
    // a row moved to another table leaves this one
    const other = await createTable(v.app, v.settings, described({ name: "note", columns: [{ name: "title", type: "string", required: true }], options: { filename: "{title}" } }));
    expect(other.ok).toBe(true);
    const mv = await moveRows(v.app, v.settings, { table: "task", where: { title: "Z" }, toTable: "note", drop: ["blocked_by", "blocks"] });
    expect(mv.ok, JSON.stringify([mv.violations, mv.conflicts])).toBe(true);
  });
});

describe("changeSetCycles on a change set", () => {
  const taskNote = (title: string, extra = "") => `---\ntable: main.public.task\ntitle: ${title}\n${extra}---\n`;

  it("reads the metastore itself when nothing has loaded it, and checks created rows", async () => {
    const warm = await vault();
    const v = createDbVault({ [METASTORE]: warm.read(METASTORE) });
    const cs = emptyChangeSet("insert_row", "x");
    cs.creates.push({ path: p("X"), content: taskNote("X", 'blocked_by:\n  - "[[X]]"\n') });
    const found = await changeSetCycles(v.app, v.settings, cs);
    expect(found).toEqual([{ path: p("X"), violations: [{ column: "blocked_by", code: "cycle", message: 'would close a cycle in "blocked_by" (X → X)' }] }]);
  });

  it("reads edits, creates, moves and deletes: rows of other tables and rows already gone are left out", async () => {
    const v = await vault();
    const other = await createTable(v.app, v.settings, described({ name: "note", columns: [{ name: "title", type: "string", required: true }], options: { filename: "{title}" } }));
    expect(other.ok).toBe(true);
    for (const t of ["A", "B", "C", "D", "Z"]) await add(v, t);
    expect((await insertRow(v.app, v.settings, { table: "note", values: { title: "N1" } })).ok).toBe(true);
    expect((await set(v, "A", { blocked_by: ["[[B]]"] })).ok).toBe(true);
    const ordered = (path: string) => readOrderedFromMarkdown(v.read(path)).ordered;
    const N1 = "Datanotes/main/public/note/N1.md";
    const cs = emptyChangeSet("update_row", "x");
    const c = ordered(p("C"));
    cs.edits.push({ path: p("C"), before: c, after: [...c, ["blocked_by", ["[[A]]"]]] });
    const n = ordered(N1);
    cs.edits.push({ path: N1, before: n, after: n });
    cs.moves.push({ from: N1, to: p("N1") }, { from: p("D"), to: `${DIR}/_archive/D.md` }, { from: p("B"), to: p("B2") });
    cs.deletes.push(p("Z"));
    cs.creates.push(
      { path: p("E"), content: taskNote("E", 'blocked_by:\n  - "[[C]]"\n') },
      { path: "Datanotes/main/public/note/N2.md", content: "---\ntable: main.public.note\ntitle: N2\n---\n" },
    );
    expect(await changeSetCycles(v.app, v.settings, cs)).toEqual([]);
  });

  it("a change set with no acyclic column changed reads no rows", async () => {
    const v = await vault();
    await add(v, "A");
    const o = readOrderedFromMarkdown(v.read(p("A"))).ordered;
    const cs = emptyChangeSet("update_row", "x");
    cs.edits.push({ path: p("A"), before: o, after: [...o, ["note", "x"]] });
    expect(await changeSetCycles(v.app, v.settings, cs)).toEqual([]);
  });
});

describe("schema changes", () => {
  it("alter_column refuses acyclic while rows form a cycle, and lists them", async () => {
    const v = createDbVault({});
    const r = await createTable(v.app, v.settings, described({
      name: "task",
      columns: [
        { name: "title", type: "string", required: true },
        { name: "deps", type: "list", items: "link", ref: "self" },
      ],
      options: { filename: "{title}" },
    }));
    expect(r.ok).toBe(true);
    await add(v, "A");
    await add(v, "B");
    expect((await set(v, "A", { deps: ["[[B]]"] })).ok).toBe(true);
    expect((await set(v, "B", { deps: ["[[A]]"] })).ok).toBe(true);
    const a = await alterColumn(v.app, v.settings, { table: "task", name: "deps", changes: { acyclic: true } });
    expect(a.ok).toBe(false);
    expect(a.violations.map((x) => x.path).sort()).toEqual([p("A"), p("B")]);
    expect(a.violations[0]!.violations[0]).toMatchObject({ column: "deps", code: "cycle" });
    expect(a.violations[0]!.violations[0]!.message).toMatch(/^is on a cycle in "deps" \(/);
  });

  it("add_column refuses acyclic over values notes already hold", async () => {
    const v = createDbVault({});
    const r = await createTable(v.app, v.settings, described({ name: "task", columns: [{ name: "title", type: "string", required: true }], options: { filename: "{title}" } }));
    expect(r.ok).toBe(true);
    await add(v, "A");
    await add(v, "B");
    v.write(p("A"), v.read(p("A")).replace(/\n---\n/, '\nwaits:\n  - "[[B]]"\n---\n'));
    v.write(p("B"), v.read(p("B")).replace(/\n---\n/, '\nwaits:\n  - "[[A]]"\n---\n'));
    const a = await addColumn(v.app, v.settings, described({ table: "task", column: { name: "waits", type: "list", items: "link", ref: "self", acyclic: true } }));
    expect(a.ok).toBe(false);
    expect(a.violations.map((x) => x.path).sort()).toEqual([p("A"), p("B")]);
  });

  it("alter_column refuses an inverse that reveals a cycle", async () => {
    const v = createDbVault({});
    const r = await createTable(v.app, v.settings, described({
      name: "task",
      columns: [
        { name: "title", type: "string", required: true },
        { name: "blocked_by", type: "list", items: "link", ref: "self", acyclic: true },
        { name: "blocks", type: "list", items: "link", ref: "self" },
      ],
      options: { filename: "{title}" },
    }));
    expect(r.ok).toBe(true);
    await add(v, "A");
    await add(v, "B");
    // not an inverse yet: A waits for B and A blocks B are two unrelated lists
    expect((await set(v, "A", { blocked_by: ["[[B]]"], blocks: ["[[B]]"] })).ok).toBe(true);
    const a = await alterColumn(v.app, v.settings, { table: "task", name: "blocks", changes: { inverse: "blocked_by" } });
    expect(a.ok).toBe(false);
    expect(a.violations.map((x) => x.path).sort()).toEqual([p("A"), p("B")]);
  });

  it("alter_column with ref: self keeps existing links valid (regression)", async () => {
    const v = createDbVault({});
    const r = await createTable(v.app, v.settings, described({
      name: "task",
      columns: [
        { name: "title", type: "string", required: true },
        { name: "deps", type: "json" },
      ],
      options: { filename: "{title}" },
    }));
    expect(r.ok).toBe(true);
    await add(v, "A");
    await add(v, "B");
    expect((await set(v, "A", { deps: ["[[B]]"] })).ok).toBe(true);
    const a = await alterColumn(v.app, v.settings, { table: "task", name: "deps", changes: { type: "list", items: "link", ref: "self" } });
    expect(a.ok, JSON.stringify(a.violations)).toBe(true);
    expect(v.read(METASTORE)).toMatch(/name: deps\s+type: list\s+items: link\s+ref: self\s/);
  });
});
