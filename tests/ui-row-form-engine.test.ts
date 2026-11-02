// The row editor's libraries (src/ui/lib/row-form.ts, where.ts) against the real engine: what they
// build is what the engine accepts, and a stale `expect` is refused as a concurrent edit. The calls go
// through the browser's own client (src/ui/lib/api.ts) over HTTP, as the page sends them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, type ApiAnswer } from "../src/ui/lib/api";
import { buildExpect, diffRow, insertValues, rawOf, type ColumnInfo, type Raw } from "../src/ui/lib/row-form";
import { conditionsToWhere } from "../src/ui/lib/where";
import { isWriteAnswer, violationsFor, type WriteAnswer } from "../src/ui/lib/write-result";
import { openTestVault, type TestVault } from "./helpers/test-vault";

const TASK = "work.planning.task";
const PROJECT = "work.planning.project";
const BUTTON = "datanotes/work/planning/task/Build the button component.md";

let vault: TestVault;
let api: ApiClient;

beforeAll(async () => {
  vault = await openTestVault("in-process");
  api = new ApiClient({ token: "test-vault-token", actor: { harness: "datanotes-ui", session: "ui-0123456789abcdef" }, base: vault.client.url });
}, 60_000);

afterAll(async () => {
  await vault?.stop();
});

async function columns(table: string): Promise<ColumnInfo[]> {
  const a = await api.op<{ columns: ColumnInfo[] }>("describe_table", { table });
  expect(a.status).toBe(200);
  return a.json.columns;
}

async function row(table: string, path: string): Promise<Record<string, unknown>> {
  const a = await api.op<{ total: number; rows: Record<string, unknown>[] }>("select_rows", { table, where: { path }, include_body: true, limit: 1 });
  expect(a.json.total).toBe(1);
  return a.json.rows[0]!;
}

/** The form as read: every column's input. */
function rawsOf(cols: ColumnInfo[], values: Record<string, unknown>): Record<string, Raw> {
  return Object.fromEntries(cols.map((c) => [c.name, rawOf(c, values[c.name])]));
}

function writeAnswer(a: ApiAnswer): WriteAnswer {
  expect(isWriteAnswer(a.json), JSON.stringify(a.json)).toBe(true);
  return a.json as unknown as WriteAnswer;
}

describe("the row form against the engine", () => {
  it("saves a changed number and a cleared date with diffRow and buildExpect", async () => {
    const cols = await columns(TASK);
    const before = await row(TASK, BUTTON);
    const raws = { ...rawsOf(cols, before), estimate_h: "10", due: "" };
    const d = diffRow(cols, before, raws);
    expect(d).toEqual({ set: { estimate_h: 10 }, unset: ["due"], changed: ["due", "estimate_h"], errors: {} });
    const a = await api.op("update_row", { table: TASK, path: BUTTON, set: d.set, unset: d.unset, expect: buildExpect(cols, before, d.changed), autolink: true, dry_run: false });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(writeAnswer(a).ok).toBe(true);
    const after = await row(TASK, BUTTON);
    expect(after.estimate_h).toBe(10);
    expect(after.due).toBeUndefined();
  });

  it("is refused with a stale expect when the row changed behind the form", async () => {
    const cols = await columns(TASK);
    const before = await row(TASK, BUTTON);
    await vault.ok("update_row", { table: TASK, path: BUTTON, set: { estimate_h: 7 } });
    const d = diffRow(cols, before, { ...rawsOf(cols, before), estimate_h: "9", due: "2026-12-01" });
    expect(buildExpect(cols, before, d.changed)).toEqual({ estimate_h: before.estimate_h, due: { exists: false } });
    const a = await api.op("update_row", { table: TASK, path: BUTTON, set: d.set, unset: d.unset, expect: buildExpect(cols, before, d.changed), dry_run: false });
    expect(a.status).toBe(422);
    const w = writeAnswer(a);
    expect(w.conflicts.map((c) => c.message).join("\n")).toMatch(/^row changed: expected/);
    expect((await row(TASK, BUTTON)).estimate_h).toBe(7);
  });

  it("is refused with a stale expect_body when the body changed behind the form", async () => {
    const before = await row(TASK, BUTTON);
    await vault.ok("update_row", { table: TASK, path: BUTTON, body: "Written by someone else.\n" });
    const a = await api.op("update_row", { table: TASK, path: BUTTON, body: "Mine.\n", expect_body: before.body, dry_run: false });
    expect(a.status).toBe(422);
    expect(writeAnswer(a).conflicts.map((c) => c.message).join("\n")).toMatch(/^row changed: its body/);
    expect((await row(TASK, BUTTON)).body).toBe("Written by someone else.\n");
  });

  it("shows a CHECK refusal as a check of violationsFor", async () => {
    const cols = await columns(TASK);
    const before = await row(TASK, BUTTON);
    const d = diffRow(cols, before, { ...rawsOf(cols, before), status: "done", estimate_h: "200" });
    const a = await api.op("update_row", { table: TASK, path: BUTTON, set: d.set, expect: buildExpect(cols, before, d.changed), dry_run: true });
    expect(a.status).toBe(422);
    const v = violationsFor(writeAnswer(a), BUTTON);
    expect(v.byColumn.estimate_h?.[0]?.message).toBe("must be <= 80");
  });

  it("inserts a new task from insertValues (enum, link, number)", async () => {
    const cols = await columns(TASK);
    const { values, errors } = insertValues(cols, { title: "Check the contrast", project: "Design system", status: "todo", estimate_h: "3", due: "" });
    expect(errors).toEqual({});
    expect(values).toEqual({ title: "Check the contrast", project: "[[Design system]]", status: "todo", estimate_h: 3 });
    const a = await api.op("insert_row", { table: TASK, values, autolink: true, dry_run: false });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const created = writeAnswer(a).planned_creates[0]!;
    expect(created).toMatch(/Check the contrast\.md$/);
    const r = await row(TASK, created);
    expect(r.estimate_h).toBe(3);
    expect(r.status).toBe("todo");
  });

  it("sets project.members (a list of links) from the list editor's items", async () => {
    const cols = await columns(PROJECT);
    const path = "datanotes/work/planning/project/Design system.md";
    const before = await row(PROJECT, path);
    const members = [...(rawOf(cols.find((c) => c.name === "members")!, before.members) as string[]), "Grace Hopper"];
    const d = diffRow(cols, before, { ...rawsOf(cols, before), members });
    expect(d.changed).toEqual(["members"]);
    const a = await api.op("update_row", { table: PROJECT, path, set: d.set, unset: d.unset, expect: buildExpect(cols, before, d.changed), dry_run: false });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect((await row(PROJECT, path)).members).toContain("[[Grace Hopper]]");
  });

  it("filters with conditionsToWhere as the engine counts", async () => {
    const cols = await columns(TASK);
    const types = Object.fromEntries(cols.map((c) => [c.name, c.type]));
    const { where, errors } = conditionsToWhere(
      [
        { column: "status", op: "eq", value: "todo" },
        { column: "estimate_h", op: "gte", value: "5" },
      ],
      types,
    );
    expect(errors).toEqual([]);
    const a = await api.op<{ total: number }>("select_rows", { table: TASK, where, limit: 1 });
    expect(a.status).toBe(200);
    const all = await api.op<{ rows: Record<string, unknown>[] }>("select_rows", { table: TASK, limit: 1000 });
    const own = all.json.rows.filter((r) => r.status === "todo" && typeof r.estimate_h === "number" && r.estimate_h >= 5).length;
    expect(own).toBeGreaterThan(0);
    expect(a.json.total).toBe(own);
  });
});
