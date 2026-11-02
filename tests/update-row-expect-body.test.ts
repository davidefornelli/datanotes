/**
 * `expect_body` on update_row (src/core/row-ops.ts): a compare-and-set on the note's text, the
 * body as select_rows with include_body returned it; refused (422, a conflict) when it changed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { createHandlers, type Handler } from "../src/server/rest";
import { DOCS, DOCS_BASE } from "../src/core/hints";
import { READ_YAML, PANTRY } from "./helpers/read-tokens";

let v: DbVault;
let h: Record<string, Handler>;
let path: string;

const op = (name: string, body: Record<string, unknown>) => h[`/operations/${name}/`]!(body);

async function bodyOf(p: string): Promise<string> {
  const r = await op("select_rows", { table: PANTRY, where: { path: p }, include_body: true });
  expect(r.status).toBe(200);
  return (r.json as { rows: { body: string }[] }).rows[0]!.body;
}

const CONFLICT = "row changed: its body is not the one you read — read it again";

function expectConflict(r: { status: number; json: unknown }, at: string = path): void {
  expect(r.status).toBe(422);
  const json = r.json as { conflicts: { path: string; message: string }[]; hint: string; docs: string };
  expect(json.conflicts).toEqual([{ path: at, message: CONFLICT }]);
  expect(json.hint).toBe(`The note's text changed since you read it: read it again (select_rows with include_body), then retry update_row with "expect_body" set to the body you read.`);
  expect(json.docs).toBe(`${DOCS_BASE}${DOCS.expect}`);
}

beforeEach(async () => {
  v = createDbVault({ [METASTORE]: READ_YAML });
  h = createHandlers(v.app, () => v.settings);
  const r = await op("insert_row", { table: PANTRY, values: { item: "eggs", qty: 6 }, body: "Fresh from the farm.\n" });
  expect(r.status).toBe(200);
  path = (r.json as { planned_creates: string[] }).planned_creates[0]!;
});

describe("update_row expect_body", () => {
  it("writes when the body is the one select_rows returned", async () => {
    const read = await bodyOf(path);
    expect(read).toBe("Fresh from the farm.\n");
    const r = await op("update_row", { table: PANTRY, path, body: "Bought on Monday.\n", expect_body: read });
    expect(r.status).toBe(200);
    expect(await bodyOf(path)).toBe("Bought on Monday.\n");
  });

  it("refuses a stale body with a conflict, its hint and docs, and writes nothing", async () => {
    const r = await op("update_row", { table: PANTRY, path, body: "Mine.\n", expect_body: "An older text.\n" });
    expectConflict(r);
    expect(await bodyOf(path)).toBe("Fresh from the farm.\n");
  });

  it("compares CRLF and LF as equal", async () => {
    const r = await op("update_row", { table: PANTRY, path, set: { qty: 5 }, expect_body: "Fresh from the farm.\r\n" });
    expect(r.status).toBe(200);
  });

  it("guards a write of front matter only (set, no body)", async () => {
    expectConflict(await op("update_row", { table: PANTRY, path, set: { qty: 1 }, expect_body: "Something else.\n" }));
    const row = await op("select_rows", { table: PANTRY, where: { path } });
    expect((row.json as { rows: { qty: number }[] }).rows[0]!.qty).toBe(6);
  });

  it("gives the same conflict on a dry run", async () => {
    expectConflict(await op("update_row", { table: PANTRY, path, body: "x\n", expect_body: "y\n", dry_run: true }));
  });

  it("guards a batch step too", async () => {
    const r = await op("batch", { operations: [{ op: "update_row", table: PANTRY, path, body: "x\n", expect_body: "stale\n" }] });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json)).toContain(CONFLICT);
    expect(await bodyOf(path)).toBe("Fresh from the farm.\n");
  });

  it("passes expect_body \"\" on a row whose body is empty", async () => {
    const ins = await op("insert_row", { table: PANTRY, values: { item: "flour" } });
    const p = (ins.json as { planned_creates: string[] }).planned_creates[0]!;
    // a new row's body, as select_rows reads it, passes as it is
    const fresh = await bodyOf(p);
    expect((await op("update_row", { table: PANTRY, path: p, body: "", expect_body: fresh })).status).toBe(200);
    expect(await bodyOf(p)).toBe("");
    const r = await op("update_row", { table: PANTRY, path: p, set: { qty: 2 }, expect_body: "" });
    expect(r.status).toBe(200);
    expectConflict(await op("update_row", { table: PANTRY, path: p, set: { qty: 3 }, expect_body: "text\n" }), p);
  });
});
