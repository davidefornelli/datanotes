/**
 * Two guards of the writes, through the HTTP API's handlers:
 *
 * - the undo of an insert trashes the note only while it is as the insert left it (the journal
 *   keeps a hash of each note it created, `created_hashes`); entries written before keep working;
 * - a new note's file name is taken when another note has it in another case, on every system
 *   (Windows and macOS see one file; on Linux the two collide once synced there), with the
 *   standard error naming that note; dry_run agrees.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { createdHash } from "../src/core/changeset";
import { INDEX_RETRY } from "../src/core/engine";
import { docsUrl } from "../src/core/hints";
import { existingPathIgnoringCase } from "../src/core/vault-path";
import { createHandlers, dispatch } from "../src/server/rest";
import { logVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";
import { DOCS_URL_RE } from "./helpers/guidance";

INDEX_RETRY.delayMs = 1;

interface Answer {
  status: number;
  json: Record<string, any>;
}

function engine(v: DbVault = logVault()) {
  const handlers = createHandlers(v.app, () => v.settings);
  const call = async (op: string, args: Record<string, unknown>): Promise<Answer> => {
    const req = operationRequest(op, args);
    const route = req.path.slice(ROUTE_PREFIX.length);
    return (await dispatch(route, handlers[route]!, req.body)) as Answer;
  };
  const ok = async (op: string, args: Record<string, unknown>) => {
    const r = await call(op, args);
    expect(r.status, `${op}: ${JSON.stringify(r.json)}`).toBe(200);
    return r.json;
  };
  return { v, call, ok };
}

const BOOK = described({
  name: "book",
  columns: [
    { name: "title", type: "string", required: true },
    { name: "pages", type: "integer" },
  ],
  filename: "{title}",
});
const DIR = "Datanotes/main/public/book";

/** Every journal file of the store (JSON lines). */
function journalFiles(v: DbVault): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".jsonl") && p.split(path.sep).includes("journal")) out.push(p);
    }
  };
  walk(v.storeRoot);
  return out;
}

describe("the undo of an insert", () => {
  it("keeps the hash of the note it created, of its values and body (the YAML style aside)", async () => {
    const e = engine();
    await e.ok("create_table", BOOK);
    const ins = await e.ok("insert_row", { table: "book", values: { title: "Dune", pages: 412 } });
    const at = `${DIR}/Dune.md`;
    const line = journalFiles(e.v).flatMap((f) => fs.readFileSync(f, "utf8").split("\n")).find((l) => l.includes(`"migration_id":"${ins.migration_id}"`))!;
    expect(JSON.parse(line).created_hashes).toEqual([{ path: at, hash: createdHash(e.v.read(at)) }]);
    // the same values written in another style hash the same; another value does not
    expect(createdHash(e.v.read(at).replace("title: Dune", 'title: "Dune"'))).toBe(createdHash(e.v.read(at)));
    expect(createdHash(e.v.read(at).replace("pages: 412", "pages: 413"))).not.toBe(createdHash(e.v.read(at)));
    expect(createdHash("---\ntitle: [broken\n---\n")).toEqual(expect.any(String));
  });

  it("is refused with 409 when the note changed since, through the engine or by hand; undoing the change first lets it through", async () => {
    const e = engine();
    await e.ok("create_table", BOOK);
    const ins = await e.ok("insert_row", { table: "book", values: { title: "Dune", pages: 412 } });
    const at = `${DIR}/Dune.md`;
    const upd = await e.ok("update_row", { table: "book", path: at, body: "Sand everywhere.\n" });
    const refused = await e.call("undo_migration", { migration_id: ins.migration_id });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ ok: false, conflicts: [{ path: at, message: "created note changed since the operation" }], docs: docsUrl("undoConflict") });
    expect(refused.json.hint).toMatch(/undo those first/);
    expect(fs.existsSync(path.join(e.v.root, at))).toBe(true);
    // the update undone, the note is as the insert left it again
    await e.ok("undo_migration", { migration_id: upd.migration_id });
    await e.ok("undo_migration", { migration_id: ins.migration_id });
    expect(fs.existsSync(path.join(e.v.root, at))).toBe(false);

    // a hand edit of the values counts too
    const again = await e.ok("insert_row", { table: "book", values: { title: "Emma", pages: 300 } });
    const emma = `${DIR}/Emma.md`;
    e.v.write(emma, e.v.read(emma).replace("pages: 300", "pages: 301"));
    const byHand = await e.call("undo_migration", { migration_id: again.migration_id });
    expect([byHand.status, byHand.json.conflicts]).toEqual([409, [{ path: emma, message: "created note changed since the operation" }]]);
    expect(byHand.json.docs).toMatch(DOCS_URL_RE);
  });

  it("of a journal entry written before the hashes were kept trashes the note as before", async () => {
    const e = engine();
    await e.ok("create_table", BOOK);
    const ins = await e.ok("insert_row", { table: "book", values: { title: "Dune" } });
    for (const f of journalFiles(e.v)) fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/,"created_hashes":\[[^\]]*\]/g, ""));
    const at = `${DIR}/Dune.md`;
    e.v.write(at, e.v.read(at).replace("\n---\n", "\npages: 9\n---\n"));
    await e.ok("undo_migration", { migration_id: ins.migration_id });
    expect(fs.existsSync(path.join(e.v.root, at))).toBe(false);
  });

  it("an undo that puts back a deleted note keeps its hash too: undoing that undo is refused once the note changed", async () => {
    const e = engine();
    await e.ok("create_table", BOOK);
    await e.ok("insert_row", { table: "book", values: { title: "Dune" } });
    const del = await e.ok("delete_rows", { table: "book", where: { title: "Dune" }, mode: "delete" });
    const back = await e.ok("undo_migration", { migration_id: del.migration_id });
    const at = `${DIR}/Dune.md`;
    expect(fs.existsSync(path.join(e.v.root, at))).toBe(true);
    e.v.write(at, `${e.v.read(at)}Read it twice.\n`);
    const r = await e.call("undo_migration", { migration_id: back.migration_id });
    expect([r.status, r.json.conflicts]).toEqual([409, [{ path: at, message: "created note changed since the operation" }]]);
  });
});

describe("a file name taken in another case", () => {
  it("is found whatever the case of its folders and name", async () => {
    const e = engine();
    await e.ok("create_table", BOOK);
    await e.ok("insert_row", { table: "book", values: { title: "Dune" } });
    expect(existingPathIgnoringCase(e.v.app, `${DIR}/Dune.md`)).toBe(`${DIR}/Dune.md`);
    expect(existingPathIgnoringCase(e.v.app, `${DIR}/dune.md`)).toBe(`${DIR}/Dune.md`);
    expect(existingPathIgnoringCase(e.v.app, `${DIR.toUpperCase()}/DUNE.MD`)).toBe(`${DIR}/Dune.md`);
    expect(existingPathIgnoringCase(e.v.app, "datanotes")).toBe("Datanotes");
    expect(existingPathIgnoringCase(e.v.app, `${DIR}/Emma.md`)).toBeNull();
    expect(existingPathIgnoringCase(e.v.app, "Nowhere/Dune.md")).toBeNull();
    expect(existingPathIgnoringCase(e.v.app, "")).toBeNull();
    // a host without folder listings: every file compared
    const app = { vault: { getAbstractFileByPath: () => null, getFiles: () => e.v.app.vault.getFiles() } } as never;
    expect(existingPathIgnoringCase(app, `${DIR}/dune.md`)).toBe(`${DIR}/Dune.md`);
    expect(existingPathIgnoringCase(app, DIR.toLowerCase())).toBe(DIR);
    expect(existingPathIgnoringCase(app, `${DIR}/Emma.md`)).toBeNull();
  });

  it("a passed path is refused with the standard error naming the note; dry_run says the same and writes nothing", async () => {
    const e = engine();
    await e.ok("create_table", BOOK);
    await e.ok("insert_row", { table: "book", values: { title: "Task" } });
    for (const dry_run of [true, false]) {
      const r = await e.call("insert_row", { table: "book", values: { title: "Other task" }, path: `${DIR}/task.md`, dry_run });
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      expect(r.json).toMatchObject({ ok: false, docs: docsUrl("sameNameCase") });
      expect(r.json.conflicts).toEqual([{ path: `${DIR}/task.md`, message: `note already exists in another case: "${DIR}/Task.md" (one file on Windows and macOS)` }]);
      expect(r.json.hint).toMatch(/another case/);
    }
    expect(fs.readdirSync(path.join(e.v.root, DIR))).toEqual(["Task.md"]);
    // the same name in the same case keeps its message
    const same = await e.call("insert_row", { table: "book", values: { title: "Again" }, path: `${DIR}/Task.md` });
    expect(same.json.conflicts).toEqual([{ path: `${DIR}/Task.md`, message: "note already exists" }]);
    expect(same.json.docs).toBe(docsUrl("sameNameCase"));
  });

  it("a name from the filename pattern gets -2 instead, also within one batch", async () => {
    const e = engine();
    await e.ok("create_table", BOOK);
    await e.ok("insert_row", { table: "book", values: { title: "Task" } });
    const r = await e.ok("insert_row", { table: "book", values: { title: "task" } });
    expect(r.planned_creates).toEqual([`${DIR}/task-2.md`]);
    const merged = await e.ok("merge_rows", { table: "book", on: ["title"], rows: [{ title: "Emma" }, { title: "EMMA" }] });
    expect(merged.planned_creates).toEqual([`${DIR}/Emma.md`, `${DIR}/EMMA-2.md`]);
    expect(fs.readdirSync(path.join(e.v.root, DIR)).sort()).toEqual(["EMMA-2.md", "Emma.md", "Task.md", "task-2.md"]);
  });

  it("a rename by update_row skips a name another note has in another case, and may change the case of its own", async () => {
    const e = engine();
    await e.ok("create_table", BOOK);
    await e.ok("insert_row", { table: "book", values: { title: "Alpha" } });
    await e.ok("insert_row", { table: "book", values: { title: "Beta" } });
    const r = await e.ok("update_row", { table: "book", path: `${DIR}/Beta.md`, set: { title: "alpha" } });
    expect(r.planned_moves).toEqual([{ from: `${DIR}/Beta.md`, to: `${DIR}/alpha-2.md` }]);
    const own = await e.ok("update_row", { table: "book", path: `${DIR}/Alpha.md`, set: { title: "ALPHA" } });
    expect(own.planned_moves).toEqual([{ from: `${DIR}/Alpha.md`, to: `${DIR}/ALPHA.md` }]);
    expect(fs.readdirSync(path.join(e.v.root, DIR)).sort()).toEqual(["ALPHA.md", "alpha-2.md"]);
  });
});
