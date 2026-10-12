/**
 * Notes created by hand in a table's folder (auto-adopt) and rows edited by hand (auto-recompute)
 * at their edges: notes that are no candidates (not Markdown, no metastore, archive, excluded
 * folders), names that do not fit the pattern, notes created already as rows (of another table,
 * by a short name, refused by a rule), empty notes given the row template, tables named
 * ambiguously or without computed columns, and a recompute that fails with no error handler.
 */

import { describe, expect, it } from "vitest";
import { adoptCreatedNote, adoptTargetFor } from "../src/core/auto-adopt";
import { AutoRecompute } from "../src/core/auto-recompute";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { loadMetastore } from "../src/core/metastore";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/**
 * `diary` (by month, named by the day, a templates folder excluded, a row template); `project`
 * and `chore` (a chore's project must be of kind project: CHECK); `plain` (no computed column);
 * `memo` (no filename pattern).
 */
const TABLES = `diary:
  options:
    partition: "{day:YYYY/MM}"
    filename: "{day:YYYY-MM-DD}"
    exclude: [Datanotes/main/public/diary/templates]
  row_template: "## Notes\\n"
  columns:
    - ${ID}
    - { name: day, type: date, required: true, dense: true }
project:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string }
    - { name: kind, type: enum, values: [area, project] }
chore:
  options: { filename: "{title}" }
  constraints:
    in_project: { "project.kind": project }
  columns:
    - ${ID}
    - { name: title, type: string }
    - { name: project, type: link, ref: main.public.project }
plain:
  options: { filename: "{title}" }
  columns:
    - { name: title, type: string }
memo:
  columns:
    - ${ID}
    - { name: title, type: string }
`;
const D = "Datanotes/main/public/diary";

function vault(extra: Record<string, string> = {}): DbVault {
  return createDbVault({
    [METASTORE]: withTables(TABLES),
    "Prj/Home.md": "---\ntable: main.public.project\nid: 01a0f000-0000-7000-8000-0000000000a1\nname: Home\nkind: area\n---\n",
    ...extra,
  });
}

const parsed = (v: DbVault, p: string) => {
  const { ordered, body } = readOrderedFromMarkdown(v.read(p));
  return { fm: Object.fromEntries(ordered), body };
};

describe("which notes are candidates", () => {
  it("only Markdown notes of a table's folder, not its archive nor an excluded folder", async () => {
    const v = vault();
    expect(await adoptTargetFor(v.app, v.settings, `${D}/2026/09/picture.png`)).toBeNull();
    expect(await adoptTargetFor(v.app, v.settings, `${D}/_archive/2026/2026-09-01.md`)).toBeNull();
    expect(await adoptTargetFor(v.app, v.settings, `${D}/templates/day.md`)).toBeNull();
    expect(await adoptTargetFor(v.app, v.settings, `${D}/2026/09/2026-09-28.md`)).toEqual({ table: "main.public.diary", values: { day: "2026-09-28" }, rowTemplate: "## Notes\n" });
    // a name that does not fit the pattern gives no values
    expect(await adoptTargetFor(v.app, v.settings, `${D}/2026/09/notes.md`)).toEqual({ table: "main.public.diary", values: {}, rowTemplate: "## Notes\n" });
    // nor a table without a filename pattern
    expect(await adoptTargetFor(v.app, v.settings, "Datanotes/main/public/memo/2026-09-28.md")).toEqual({ table: "main.public.memo", values: {} });
  });

  it("none without metastore.yaml", async () => {
    const v = createDbVault({ "Datanotes/main/public/diary/2026-09-28.md": "" });
    expect(await adoptTargetFor(v.app, v.settings, "Datanotes/main/public/diary/2026-09-28.md")).toBeNull();
  });
});

describe("adoptCreatedNote", () => {
  it("an empty note gets the row template and the values of its name", async () => {
    const v = vault();
    const p = `${D}/2026/09/2026-09-28.md`;
    v.write(p, "");
    expect(await adoptCreatedNote(v.app, v.settings, v.file(p))).toEqual({ adopted: true, table: "main.public.diary" });
    const { fm, body } = parsed(v, p);
    expect([fm.table, fm.day, typeof fm.id]).toEqual(["main.public.diary", "2026-09-28", "string"]);
    expect(body).toBe("## Notes\n");
  });

  it("a note with properties and no body gets the row template after them", async () => {
    const v = vault();
    const p = `${D}/2026/09/2026-09-29.md`;
    v.write(p, "---\nday: 2026-09-29\n---\n");
    expect(await adoptCreatedNote(v.app, v.settings, v.file(p))).toEqual({ adopted: true, table: "main.public.diary" });
    const { fm, body } = parsed(v, p);
    expect([fm.table, fm.day, typeof fm.id, body]).toEqual(["main.public.diary", "2026-09-29", "string", "## Notes\n"]);
  });

  it("a note created as a row of another table is left alone", async () => {
    const v = vault();
    const p = `${D}/2026/09/2026-09-28.md`;
    const text = "---\ntable: main.public.project\nname: Diary\n---\n";
    v.write(p, text);
    expect(await adoptCreatedNote(v.app, v.settings, v.file(p))).toEqual({ adopted: false });
    expect(v.read(p)).toBe(text);
  });

  it("a note created as a row by the table's short name only gets its id", async () => {
    const v = vault();
    const p = `${D}/2026/09/2026-09-28.md`;
    v.write(p, "---\ntable: diary\nday: 2026-09-28\n---\nWritten by a tool.\n");
    expect(await adoptCreatedNote(v.app, v.settings, v.file(p))).toEqual({ adopted: true, table: "main.public.diary" });
    const { fm, body } = parsed(v, p);
    expect([fm.table, fm.day, typeof fm.id, body]).toEqual(["diary", "2026-09-28", "string", "Written by a tool.\n"]);
  });

  it("a note created as a row that breaks a rule is not completed", async () => {
    const v = vault();
    const p = "Datanotes/main/public/chore/Dust.md";
    const text = '---\ntable: main.public.chore\ntitle: Dust\nproject: "[[Home]]"\n---\n';
    v.write(p, text);
    expect(await adoptCreatedNote(v.app, v.settings, v.file(p))).toEqual({ adopted: false, table: "main.public.chore", reason: "recompute refused" });
    expect(v.read(p)).toBe(text);
  });
});

describe("AutoRecompute", () => {
  it("follows rows of tables with computed columns, named without ambiguity", async () => {
    const v = vault();
    expect((await createTable(v.app, v.settings, described({ schema: "home", name: "diary", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] }))).ok).toBe(true);
    await loadMetastore(v.app, v.settings);
    const ar = new AutoRecompute(v.app, () => v.settings, async () => {
      throw new Error("not called");
    });
    const row = (rel: string, text: string) => v.write(rel, text);
    expect(ar.tableWithComputedColumns(row("A/full.md", "---\ntable: main.public.diary\nday: 2026-09-28\n---\n"))).toBe("main.public.diary");
    expect(ar.tableWithComputedColumns(row("A/short.md", "---\ntable: diary\nday: 2026-09-28\n---\n"))).toBeNull();
    expect(ar.tableWithComputedColumns(row("A/plain.md", "---\ntable: main.public.plain\ntitle: x\n---\n"))).toBeNull();
    expect(ar.tableWithComputedColumns(row("A/none.md", "---\ntable: main.public.nosuch\n---\n"))).toBeNull();
    ar.dispose();
  });

  it("follows nothing while the metastore cannot be read", () => {
    const v = createDbVault({});
    const ar = new AutoRecompute(v.app, () => v.settings, async () => {
      throw new Error("not called");
    });
    expect(ar.tableWithComputedColumns(v.write("A/row.md", "---\ntable: main.public.diary\n---\n"))).toBeNull();
    ar.dispose();
  });

  it("a recompute that fails is dropped when no error handler is given", async () => {
    const v = vault();
    await loadMetastore(v.app, v.settings);
    let failed: () => void = () => {};
    const ran = new Promise<void>((resolve) => (failed = resolve));
    const calls: unknown[] = [];
    const ar = new AutoRecompute(v.app, () => v.settings, async (_app, _s, input) => {
      calls.push(input);
      failed();
      throw new Error("engine busy");
    }, undefined, 0);
    const p = `${D}/2026/09/2026-09-28.md`;
    ar.onChanged(v.write(p, "---\ntable: main.public.diary\nday: 2026-09-28\n---\n"));
    await ran;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ table: "main.public.diary", paths: [p] }]);
    ar.dispose();
  });
});
