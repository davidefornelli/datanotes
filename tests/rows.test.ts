import { describe, expect, it } from "vitest";
import { undoOperation, loadTable } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import {
  checkTable,
  compileWhere,
  deleteRows,
  formatDateTokens,
  insertRow,
  renderPathTemplate,
  sanitizeFileName,
  select,
  updateRows,
} from "../src/core/rows";
import { claimFreeName, MAX_NAME_SUFFIX } from "../src/core/path-templates";
import { formatDateTokensOrNull } from "../src/core/datetime";
import { evalGenerated } from "../src/core/generated";
import { createDbVault, logVault, LOG_DIR, LOG_YAML, METASTORE, withTables } from "./helpers/db-vault";
import { INDEX_RETRY } from "../src/core/engine";

INDEX_RETRY.delayMs = 1;

function fm(v: { read(rel: string): string }, rel: string): Record<string, unknown> {
  return Object.fromEntries(readOrderedFromMarkdown(v.read(rel)).ordered);
}

describe("path templates", () => {
  it("formats date tokens without time-zone shifts", () => {
    expect(formatDateTokens("2026-09-25T22:30", "YYYY/MM/DD")).toBe("2026/09/25");
    expect(formatDateTokens("2026-09-25T22:30:05", "YYYY-MM-DD[T]HHmmss")).toBe("2026-09-25T223005");
    expect(formatDateTokens("2026-09-25", "HH:mm")).toBe("00:00");
    expect(() => formatDateTokens("yesterday", "YYYY")).toThrow(/cannot format/);
    // the shared formatter: null for a value that is not a date (generated columns keep it as it is)
    expect(formatDateTokensOrNull("2026-09-25T22:30", "DD/MM [at] HH:mm")).toBe("25/09 at 22:30");
    expect(formatDateTokensOrNull("yesterday", "YYYY")).toBeNull();
    expect(evalGenerated("{d:DD/MM}", (c) => (c === "d" ? "soon" : null), "x.md")).toBe("soon");
    expect(evalGenerated("{d:DD/MM}", (c) => (c === "d" ? "2026-09-25" : null), "x.md")).toBe("25/09");
  });

  it("claims base.md, else the first free -2 … -99, else the last one tried", () => {
    const taken = new Set(["a/x.md", "a/x-2.md"]);
    expect(claimFreeName("a/y", (p) => taken.has(p))).toBe("a/y.md");
    expect(claimFreeName("a/x", (p) => taken.has(p))).toBe("a/x-3.md");
    const tried: string[] = [];
    expect(claimFreeName("a/z", (p) => (tried.push(p), true))).toBe(`a/z-${MAX_NAME_SUFFIX}.md`);
    expect(tried.length).toBe(MAX_NAME_SUFFIX);
  });

  it("renders placeholders, links and sanitizes", () => {
    const vals = new Map<string, unknown>([
      ["occurred_at", "2026-09-25T22:30"],
      ["kind", "alcohol"],
      ["who", "[[People/Alice|G]]"],
      ["title", 'a/b: "c"?'],
    ]);
    expect(renderPathTemplate("Daily/{occurred_at:YYYY/MM/DD}", vals)).toBe("Daily/2026/09/25");
    expect(renderPathTemplate("{occurred_at:YYYY-MM-DD} {kind} {who}", vals)).toBe("2026-09-25 alcohol Alice");
    expect(renderPathTemplate("{title}", vals)).toBe("a-b- -c--");
    expect(() => renderPathTemplate("{missing}", vals)).toThrow(/has no value/);
    expect(sanitizeFileName("  a   b  ")).toBe("a b");
  });
});

describe("insert_row", () => {
  it("validates, computes the path from occurred_at and writes the table key", async () => {
    const v = logVault();
    const r = await insertRow(v.app, v.settings, {
      table: "log",
      values: { kind: "alcohol", occurred_at: "2026-09-24T23:10", metric_drinks: 6, people: ["[[a]]"] },
      body: "Drank too much\n",
    });
    expect(r.ok).toBe(true);
    const path = `${LOG_DIR}/2026/09/24/2026-09-24 alcohol.md`;
    expect(r.planned_creates).toEqual([path]);
    const row = fm(v, path);
    expect(Object.keys(row)).toEqual(["table", "id", "kind", "occurred_at", "metric_drinks", "people"]);
    expect(row.table).toBe("main.public.log");
    expect(v.read(path)).toContain("Drank too much");
    expect((await undoOperation(v.app, v.settings, r.migration_id!)).ok).toBe(true);
    expect(v.exists(path)).toBe(false);
  });

  it("refuses invalid values, unknown columns, existing paths and missing path rules", async () => {
    const v = logVault();
    const bad = await insertRow(v.app, v.settings, {
      table: "log",
      values: { kind: "binge", occurred_at: "2026-09-24T23:10", metric_drinks: 99, people: ["[[nobody]]"] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]!.violations.map((x) => `${x.column}${x.index !== undefined ? `[${x.index}]` : ""}:${x.code}`)).toEqual([
      "kind:enum",
      "metric_drinks:max",
      "people[0]:broken_link",
    ]);
    await expect(insertRow(v.app, v.settings, { table: "log", values: { zzz: 1 } })).rejects.toThrow(/unknown column/);
    const exists = await insertRow(v.app, v.settings, {
      table: "log",
      path: "Daily/a",
      values: { kind: "mood", occurred_at: "2026-09-24T23:10" },
    });
    expect(exists.conflicts[0]!.message).toBe("note already exists");
    const v2 = createDbVault({
      [METASTORE]: withTables("p:\n  columns:\n    - { name: name, type: string }\n"),
    });
    await expect(insertRow(v2.app, v2.settings, { table: "p", values: { name: "x" } })).rejects.toThrow(/pass "path"/);
    const ok = await insertRow(v2.app, v2.settings, { table: "p", path: "People/x", values: { name: "x" } });
    expect(ok.ok).toBe(true);
    expect(v2.exists("People/x.md")).toBe(true);
  });

  it("applies column defaults", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(
        't:\n  options:\n    filename: "{status}"\n  columns:\n    - { name: status, type: string, default: open, dense: true }\n    - { name: prio, type: integer, default: 2 }\n',
      ),
    });
    const r = await insertRow(v.app, v.settings, { table: "t", values: {} });
    expect(r.ok).toBe(true);
    expect(fm(v, "Datanotes/main/public/t/open.md")).toEqual({ table: "main.public.t", status: "open", prio: 2 });
  });
});

describe("select", () => {
  it("filters with operators, orders, pages and expands links", async () => {
    const v = logVault({
      "Daily/c.md": '---\ntable: main.public.log\nkind: walk\noccurred_at: 2026-09-20T10:00\nmetric_drinks: 0\npeople: ["[[P/Alice]]"]\n---\n',
      "P/Alice.md": "---\nrole: wife\n---\n",
    });
    const all = await select(v.app, v.settings, { table: "log", orderBy: "-occurred_at" });
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.path)).toEqual(["Daily/b.md", "Daily/a.md", "Daily/c.md"]);
    const some = await select(v.app, v.settings, {
      table: "log",
      columns: ["kind", "metric_drinks", "path"],
      where: { metric_drinks: { gte: 0, lt: 10 }, occurred_at: { gt: "2026-09-21T00:00" } },
    });
    expect(some.rows).toEqual([{ path: "Daily/a.md", kind: "alcohol", metric_drinks: 7 }]);
    const inq = await select(v.app, v.settings, { table: "log", where: { kind: { in: ["mood", "walk"] }, path: { contains: "Daily/" } } });
    expect(inq.total).toBe(2);
    const ex = await select(v.app, v.settings, { table: "log", where: { metric_drinks: { exists: false } } });
    expect(ex.rows.map((r) => r.path)).toEqual(["Daily/b.md"]);
    const ne = await select(v.app, v.settings, { table: "log", where: { kind: { ne: "walk" } }, orderBy: ["metric_drinks"], limit: 1, offset: 1 });
    expect(ne.rows.map((r) => r.path)).toEqual(["Daily/b.md"]);
    const exp = await select(v.app, v.settings, {
      table: "log",
      where: { people: { contains: "[[Alice]]" } },
      columns: ["people"],
      expand: ["people"],
    });
    expect(exp.rows).toEqual([{ path: "Daily/c.md", people: [{ path: "P/Alice.md", role: "wife" }] }]);
    const byLink = await select(v.app, v.settings, { table: "log", where: { people: { contains: "[[P/Alice|G]]" } } });
    expect(byLink.total).toBe(1);
    const lte = await select(v.app, v.settings, { table: "log", where: { metric_drinks: { lte: 0 }, kind: "walk" } });
    expect(lte.total).toBe(1);
  });

  it("rejects unknown columns and bad where shapes", async () => {
    const v = logVault();
    await expect(select(v.app, v.settings, { table: "log", where: { zzz: 1 } })).rejects.toThrow(/unknown column in where/);
    await expect(select(v.app, v.settings, { table: "log", columns: ["zzz"] })).rejects.toThrow(/unknown column/);
    await expect(select(v.app, v.settings, { table: "log", orderBy: "-zzz" })).rejects.toThrow(/order_by/);
    await expect(select(v.app, v.settings, { table: "log", where: { kind: { in: "mood" } } })).rejects.toThrow(/expects a list/);
    await expect(select(v.app, v.settings, { table: "log", where: [] as never })).rejects.toThrow(/must be an object/);
  });

  it("compileWhere rejects unknown operators on typed columns", async () => {
    const v = logVault();
    const t = await loadTable(v.app, v.settings, "log");
    const row = { file: v.file("Daily/a.md"), ordered: [["kind", "alcohol"], ["people", ["[[x]]"]]] as [string, unknown][], body: "" };
    expect(() => compileWhere({ kind: {} }, t, v.settings)).toThrow(/unknown operator \(empty object\)/);
    expect(() => compileWhere({ kind: { is: "alcohol" } }, t, v.settings)).toThrow(/unknown operator "is"/);
    expect(compileWhere({ metric_drinks: { gt: 1 } }, t, v.settings)(row)).toBe(false);
    expect(compileWhere(undefined, t, v.settings)(row)).toBe(true);
  });
});

describe("update_rows", () => {
  it("updates matching rows all-or-nothing and supports unset", async () => {
    const v = logVault();
    const r = await updateRows(v.app, v.settings, { table: "log", where: { kind: "alcohol" }, set: { metric_drinks: 5 } });
    expect(r.ok).toBe(true);
    expect(r.notes_changed).toBe(1);
    expect(fm(v, "Daily/a.md").metric_drinks).toBe(5);
    const bad = await updateRows(v.app, v.settings, { table: "log", set: { metric_drinks: 50 } });
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((x) => x.path)).toEqual(["Daily/a.md", "Daily/b.md"]);
    const req = await updateRows(v.app, v.settings, { table: "log", unset: ["kind"] });
    expect(req.violations[0]!.violations[0]!.code).toBe("required");
    const un = await updateRows(v.app, v.settings, { table: "log", where: { path: "Daily/a.md" }, unset: ["metric_drinks"] });
    expect(un.ok).toBe(true);
    expect(fm(v, "Daily/a.md")).not.toHaveProperty("metric_drinks");
    await expect(updateRows(v.app, v.settings, { table: "log" })).rejects.toThrow(/nothing to update/);
    v.write("Daily/b.md", '---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: mood\noccurred_at: 2026-09-26T08:00\n_stray: []\nplugin_ts: "[[x]]"\n---\n');
    const leak = await updateRows(v.app, v.settings, { table: "log", where: { kind: "mood" }, unset: ["_stray", "plugin_ts"] });
    expect(leak.ok).toBe(true);
    expect(fm(v, "Daily/b.md")).not.toHaveProperty("plugin_ts");
    // keys that are not columns may be unset (strays); a missing key is a no-op
    expect((await updateRows(v.app, v.settings, { table: "log", unset: ["zzz"] })).ok).toBe(true);
    await expect(updateRows(v.app, v.settings, { table: "log", set: { zzz: 1 } })).rejects.toThrow(/unknown column/);
    const none = await updateRows(v.app, v.settings, { table: "log", where: { kind: "walk" }, set: { metric_drinks: 1 } });
    expect(none.ok).toBe(true);
    expect(none.notes_changed).toBe(0);
  });
});

describe("delete_rows", () => {
  it("archives by default; undo restores", async () => {
    const v = logVault();
    const r = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" } });
    expect(r.ok).toBe(true);
    expect(v.exists(`${LOG_DIR}/_archive/b.md`)).toBe(true);
    expect((await undoOperation(v.app, v.settings, r.migration_id!)).ok).toBe(true);
    expect(v.exists("Daily/b.md")).toBe(true);
  });

  it("delete mode trashes and journals content for undo", async () => {
    const v = logVault();
    const r = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" }, mode: "delete" });
    expect(r.ok).toBe(true);
    expect(r.files_deleted).toBe(1);
    expect(v.exists("Daily/b.md")).toBe(false);
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.ok).toBe(true);
    expect(v.read("Daily/b.md")).toContain("kind: mood");
  });

  it("undo of delete refuses when the path is occupied", async () => {
    const v = logVault();
    const r = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" }, mode: "delete" });
    v.write("Daily/b.md", "new");
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u.conflicts[0]!.message).toBe("deleted path is occupied");
  });

  it("restricts referenced rows, set_null clears frontmatter links, ignore proceeds", async () => {
    const extra = {
      "Notes/ref.md": '---\nrelated: "[[Daily/b]]"\nlist: ["[[Daily/b]]", "[[Daily/a]]"]\n---\nsee [[Daily/b]]\n',
    };
    const v = logVault(extra);
    const r = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" } });
    expect(r.ok).toBe(false);
    expect(r.conflicts[0]!.message).toBe("referenced by Notes/ref.md");

    const n = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" }, onReferenced: "set_null" });
    expect(n.ok).toBe(true);
    expect(fm(v, "Notes/ref.md")).toMatchObject({ related: null, list: ["[[Daily/a]]"] });

    const v2 = logVault(extra);
    const i = await deleteRows(v2.app, v2.settings, { table: "log", where: { kind: "mood" }, onReferenced: "ignore", mode: "delete" });
    expect(i.ok).toBe(true);
  });

  it("set_null refuses to leave a required link empty (ON DELETE SET NULL on NOT NULL)", async () => {
    const v = createDbVault({
      [METASTORE]: withTables("rating:\n  columns:\n    - { name: book, type: link, required: true }\n    - { name: tags, type: list, items: link }\n"),
      "Daily/b.md": "---\ntable: main.public.log\nkind: mood\noccurred_at: 2026-09-25T10:00\n---\n",
      "R/one.md": '---\ntable: main.public.rating\nbook: "[[Daily/b]]"\n---\n',
      "R/two.md": '---\ntable: main.public.rating\nbook: "[[Elsewhere]]"\ntags: ["[[Daily/b]]"]\n---\n',
      "Elsewhere.md": "x",
    });
    const r = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" }, onReferenced: "set_null" });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ path: "R/one.md", message: expect.stringMatching(/"book" is required/) }]);
    expect(fm(v, "R/one.md").book).toBe("[[Daily/b]]");
  });

  it("reports archive collisions", async () => {
    const v = logVault({ [`${LOG_DIR}/_archive/a.md`]: "x" });
    const r = await deleteRows(v.app, v.settings, { table: "log" });
    expect(r.conflicts.map((c) => c.path)).toEqual(["Daily/a.md"]);
  });
});

describe("check_table", () => {
  it("reports hand-edited violations and passes clean tables", async () => {
    const v = logVault({
      "Daily/x.md": '---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000c\nkind: binge\noccurred_at: yesterday\nmetric_drinks: -1\nextra: 1\n---\n',
    });
    const c = await checkTable(v.app, v.settings, { table: "log" });
    expect(c.rows_checked).toBe(3);
    expect(c.violations).toHaveLength(1);
    expect(c.violations[0]!.violations.map((x) => x.code)).toEqual(["enum", "type", "min", "unknown_column"]);
    const clean = createDbVault({ [METASTORE]: LOG_YAML });
    expect((await checkTable(clean.app, clean.settings, { table: "log" })).violations).toEqual([]);
  });
});

describe("move_rows", () => {
  const YAML = withTables(`workout:
  options:
    filename: "{occurred_at:YYYY-MM-DD}"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: occurred_at, type: datetime, required: true, dense: true }
    - { name: workout_type, type: enum, values: [run, walk, treadmill], dense: true }
    - { name: distance_km, type: number, min: 0 }
    - { name: note, type: string }
`);

  it("re-links rows with renames/sets/drops, fills dense fields, and undo restores", async () => {
    const { moveRows } = await import("../src/core/rows");
    const v = logVault({
      [METASTORE]: YAML,
      "Daily/w.md": '---\ntable: main.public.log\nkind: walk\noccurred_at: 2026-05-25T11:29\nmetric_drinks: 5.07\n---\nbody\n',
    });
    const r = await moveRows(v.app, v.settings, {
      table: "log",
      where: { kind: "walk" },
      toTable: "workout",
      rename: { metric_drinks: "distance_km" },
      set: { note: "tapis", workout_type: "treadmill" },
      drop: ["kind"],
    });
    expect(r.ok).toBe(true);
    expect(fm(v, "Daily/w.md")).toMatchObject({
      table: "main.public.workout",
      occurred_at: "2026-05-25T11:29",
      distance_km: 5.07,
      note: "tapis",
      workout_type: "treadmill",
    });
    expect(v.read("Daily/w.md")).toContain("body");
    expect((await undoOperation(v.app, v.settings, r.migration_id!)).ok).toBe(true);
    expect(fm(v, "Daily/w.md").kind).toBe("walk");
  });

  it("refuses unknown keys, collisions and bad inputs", async () => {
    const { moveRows } = await import("../src/core/rows");
    const v = logVault({ [METASTORE]: YAML });
    const unknown = await moveRows(v.app, v.settings, { table: "log", where: { kind: "alcohol" }, toTable: "workout", drop: ["kind"] });
    expect(unknown.ok).toBe(false);
    expect(unknown.violations[0]!.violations.map((x) => x.column)).toContain("metric_drinks");
    const v2 = logVault({
      [METASTORE]: YAML,
      "Daily/x.md": '---\ntable: main.public.log\nkind: walk\noccurred_at: 2026-05-25T11:29\nmetric_drinks: 1\ndistance_km: 2\n---\n',
    });
    const clash = await moveRows(v2.app, v2.settings, { table: "log", where: { path: "Daily/x.md" }, toTable: "workout", rename: { metric_drinks: "distance_km" }, drop: ["kind"] });
    expect(clash.conflicts[0]!.message).toMatch(/both/);
    const empty = await moveRows(v2.app, v2.settings, { table: "log", where: { path: "Daily/x.md" }, toTable: "workout", rename: { zzz: "distance_km" }, drop: ["kind", "metric_drinks", "distance_km"] });
    expect(empty.ok).toBe(true);
    await expect(moveRows(v.app, v.settings, { table: "log", toTable: "log" })).rejects.toThrow(/same table/);
    await expect(moveRows(v.app, v.settings, { table: "log", toTable: "workout", rename: { a: "nope" } })).rejects.toThrow(/rename target/);
    await expect(moveRows(v.app, v.settings, { table: "log", toTable: "workout", rename: { table: "note" } })).rejects.toThrow(`cannot rename "table": it is the front matter key that names the row's table`);
    await expect(moveRows(v.app, v.settings, { table: "log", toTable: "workout", set: { nope: 1 } })).rejects.toThrow(/set: "nope"/);
  });
});
