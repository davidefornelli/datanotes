/**
 * Writes that several clients send to one engine at the same time, through its operations' routes
 * (src/server/rest.ts): each is validated on the database as the writes applied before it left it
 * (src/core/write-check.ts).
 */
import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { select } from "../src/core/rows";
import { holdsStaleWrite, runWrite, STALE_WRITE, WRITE_ATTEMPTS } from "../src/core/write-check";
import { createHandlers, dispatch, type HandlerResponse } from "../src/server/rest";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;
const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/** `person` (a unique email); `project` (open or closed); `task`: its project must be open (CHECK). */
const TABLES = `person:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string, required: true, dense: true }
    - { name: email, type: string, unique: true }
project:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string, required: true, dense: true }
    - { name: status, type: enum, values: [open, closed], dense: true }
task:
  options: { filename: "{title}" }
  constraints:
    open_project: { "project.status": open }
  columns:
    - ${ID}
    - { name: title, type: string, required: true, dense: true }
    - { name: project, type: link, ref: main.public.project }
`;

function vault(): DbVault {
  return createDbVault({
    [METASTORE]: withTables(TABLES),
    "Prj/Film club.md": "---\ntable: main.public.project\nid: 01a0f000-0000-7000-8000-000000000001\nname: Film club\nstatus: open\n---\n",
  });
}

/** An operation called as a client calls it: POST /datanotes/operations/<op>/. */
function client(v: DbVault): (op: string, body: Record<string, unknown>) => Promise<HandlerResponse> {
  const h = createHandlers(v.app, () => v.settings);
  return (op, body) => dispatch(`/operations/${op}/`, h[`/operations/${op}/`]!, body);
}

const ok = (rs: HandlerResponse[]) => rs.filter((r) => r.status === 200).length;

describe("writes at the same time", () => {
  it("a unique value: one of ten inserts wins, the others are refused", async () => {
    const v = vault();
    const call = client(v);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call("insert_row", { table: "person", values: { name: `Ada ${i}`, email: "ada@example.com" } })));
    expect(ok(rs)).toBe(1);
    expect(rs.filter((r) => r.status === 422).length).toBe(9);
    expect((await select(v.app, v.settings, { table: "person", where: { email: "ada@example.com" } })).total).toBe(1);
  });

  it("a CHECK that follows a link: a task added while its project closes is refused, or the close is", async () => {
    const v = vault();
    const call = client(v);
    const [task, close] = await Promise.all([
      call("insert_row", { table: "task", values: { title: "Pick the films", project: "[[Film club]]" } }),
      call("update_rows", { table: "project", where: { name: "Film club" }, set: { status: "closed" } }),
    ]);
    // never both: the task would link a closed project
    expect([task.status, close.status].filter((s) => s === 200)).toHaveLength(1);
    const tasks = (await select(v.app, v.settings, { table: "task" })).total;
    const status = (await select(v.app, v.settings, { table: "project", columns: ["status"] })).rows[0]!.status;
    expect(tasks === 0 || status === "open").toBe(true);
  });

  it("the same column, written twice without expect: both apply, the last one stays", async () => {
    const v = vault();
    const call = client(v);
    const rs = await Promise.all(["open", "closed"].map((status) => call("update_rows", { table: "project", where: { name: "Film club" }, set: { status } })));
    expect(ok(rs)).toBe(2);
    expect(["open", "closed"]).toContain((await select(v.app, v.settings, { table: "project", columns: ["status"] })).rows[0]!.status);
  });

  it("a batch sees its own steps, and checks them again when another write overtakes it", async () => {
    const v = vault();
    const call = client(v);
    const [batch, single] = await Promise.all([
      call("batch", { operations: [
        { op: "insert_row", table: "person", values: { name: "Grace", email: "grace@example.com" } },
        { op: "update_rows", table: "person", where: { name: "Grace" }, set: { email: "g@example.com" } },
      ] }),
      call("insert_row", { table: "person", values: { name: "Alan", email: "g@example.com" } }),
    ]);
    // one of the two holds g@example.com, never both
    expect([batch.status, single.status].filter((s) => s === 200)).toHaveLength(1);
    expect((await select(v.app, v.settings, { table: "person", where: { email: "g@example.com" } })).total).toBe(1);
  });

  it("runs a write again while it is overtaken, at most WRITE_ATTEMPTS times; a write left alone runs once", async () => {
    const v = vault();
    let runs = 0;
    const stale = { conflicts: [{ path: "", message: `${STALE_WRITE}: send it again` }] };
    expect(await runWrite(v.app, async () => (++runs, stale), holdsStaleWrite)).toBe(stale);
    expect(runs).toBe(WRITE_ATTEMPTS);
    runs = 0;
    expect(await runWrite(v.app, async () => (++runs, "done"), holdsStaleWrite)).toBe("done");
    expect(runs).toBe(1);
    expect(holdsStaleWrite(undefined)).toBe(false);
  });
});
