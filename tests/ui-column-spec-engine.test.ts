/**
 * The structure screens' helpers against the engine (src/ui/lib/column-spec.ts, view-query.ts):
 * the specs and changes they build are what add_column, alter_column and select_rows accept.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alterChanges, cleanSpec, specFromColumn } from "../src/ui/lib/column-spec";
import { previewArgs } from "../src/ui/lib/view-query";
import { openTestVault, type TestVault } from "./helpers/test-vault";

const TASK = "work.planning.task";
let v: TestVault;

beforeAll(async () => {
  v = await openTestVault("in-process");
}, 60_000);
afterAll(async () => {
  await v?.stop();
});

const columnsOf = async (table: string) => ((await v.ok("describe_table", { table })) as { columns: Record<string, unknown>[] }).columns;

describe("column specs on the engine", () => {
  it("a column described and read back has no changes", async () => {
    for (const t of ["work.planning.person", "work.planning.project", TASK]) {
      const cols = await columnsOf(t);
      expect(cols.length).toBeGreaterThan(0);
      for (const c of cols) expect(alterChanges(specFromColumn(c), specFromColumn(c)), `${t}.${String(c.name)}`).toEqual({});
    }
  });

  const NEW: Record<string, unknown>[] = [
    { name: "x_string", type: "string", description: "A text", required: false, aliases: [], dense: false },
    { name: "x_number", type: "number", min: 0, max: 10, description: "A number" },
    { name: "x_integer", type: "integer", description: "An integer", default: "" },
    { name: "x_boolean", type: "boolean", description: "A flag" },
    { name: "x_date", type: "date", description: "A day" },
    { name: "x_datetime", type: "datetime", description: "A time" },
    { name: "x_enum", type: "enum", values: ["a", "b"], description: "A choice", value_descriptions: {} },
    { name: "x_link", type: "link", ref: "work.planning.person", description: "A person" },
    { name: "x_links", type: "list", items: "link", ref: "work.planning.project", description: "Projects" },
    { name: "x_json", type: "json", description: "Anything" },
  ];
  for (const spec of NEW) {
    it(`add_column of a ${String(spec.name).slice(2)} column passes a dry run`, async () => {
      const r = await v.call("add_column", { table: TASK, column: cleanSpec(spec), dry_run: true });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });
  }

  it("removing estimate_h's max passes alter_column's dry run", async () => {
    const c = (await columnsOf(TASK)).find((x) => x.name === "estimate_h")!;
    const before = specFromColumn(c);
    const { max: _max, ...after } = before;
    const changes = alterChanges(before, after);
    expect(changes).toEqual({ max: null });
    const r = await v.call("alter_column", { table: TASK, column: "estimate_h", changes, dry_run: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("view previews on the engine", () => {
  it("previewArgs of each test-vault view runs on select_rows", async () => {
    const views = (await v.ok("select_rows", { table: "system.information_schema.views", limit: 100 })) as { rows: Record<string, unknown>[] };
    expect(views.rows.length).toBe(3);
    const project = (await v.ok("select_rows", { table: "work.planning.project", where: { name: "Design system" } })) as { rows: { path: string }[] };
    const projectPath = project.rows[0]!.path;
    for (const row of views.rows) {
      const args = previewArgs(JSON.parse(String(row.view_definition)) as Record<string, unknown>);
      expect(args).not.toBeNull();
      const extra = row.table_name === "vw_project_tasks" ? { this_note: projectPath } : {};
      const r = (await v.ok("select_rows", { ...args, ...extra })) as { rows: unknown[] };
      expect(r.rows.length, String(row.table_name)).toBeGreaterThan(0);
    }
  });
});
