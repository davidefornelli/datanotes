/**
 * row_history: the versions of one row from the transaction logs: who created it and who changed
 * it last, every change with its agent, renames, hand edits, deletes, moves between tables, a
 * vacuumed log, paging, and the refusals with their hints.
 */

import { describe, expect, it } from "vitest";
import { runWithActor } from "../src/core/actor";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, logExternalEdits, OperationInputError } from "../src/core/engine";
import { vacuumTable } from "../src/core/history";
import { createPublicApi } from "../src/core/public-api";
import { rowHistory, type RowHistory } from "../src/core/row-history";
import { deleteRows, insertRow, moveRows, select, updateRow } from "../src/core/rows";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const at = (minute: number) => ({ now: new Date(Date.UTC(2026, 8, 1, 10, minute)) });
const F = "Datanotes/main/lib/film";
const AGENT = { session: "s-1", harness: "claude-code", model: "claude-opus-5-5", tool: "update_row" };

async function films(history = true): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { history }, async () => {});
  const columns = [
    { name: "title", type: "string", required: true },
    { name: "rating", type: "integer" },
    { name: "status", type: "string" },
  ];
  expect((await createTable(v.app, v.settings, described({ schema: "lib", name: "film", options: { filename: "{title}" }, columns }), at(0))).ok).toBe(true);
  return v;
}

async function ok(p: Promise<{ ok: boolean }>): Promise<void> {
  const r = await p;
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

async function refused(p: Promise<unknown>, message: string, hint?: string): Promise<OperationInputError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(OperationInputError);
  const err = e as OperationInputError;
  expect(err.message).toBe(message);
  if (hint !== undefined) expect(err.hint).toContain(hint);
  expect(err.docs).toBe("https://datanotes.dev/guides/history/table-history.md#see-who-changed-a-row");
  return err;
}

const idOf = async (v: DbVault, title: string) => (await select(v.app, v.settings, { table: "film", where: { title }, columns: ["id"] })).rows[0]!.id as string;
const brief = (h: RowHistory) => h.versions.map((x) => `${x.version} ${x.change} ${x.operation} ${x.source}${x.old_path ? ` from ${x.old_path}` : ""}`);

describe("row_history", () => {
  it("who created a row and who changed it last; each version with its agent, columns, body, rename, hand edit and delete", async () => {
    const v = await films();
    await runWithActor({ ...AGENT, tool: "insert_row" }, () => ok(insertRow(v.app, v.settings, { table: "film", values: { title: "Alien", status: "to watch" }, body: "A ship.\n" }, at(1))));
    const id = await idOf(v, "Alien");
    await runWithActor(AGENT, () => ok(updateRow(v.app, v.settings, { table: "film", path: `${F}/Alien.md`, set: { rating: 4, status: "watched" } }, at(2))));
    // an update of another row: not in this row's history
    await ok(insertRow(v.app, v.settings, { table: "film", values: { title: "Heat" } }, at(3)));
    // a rename: the file name follows the title
    await runWithActor({ ...AGENT, model: "gpt-5", harness: "opencode" }, () => ok(updateRow(v.app, v.settings, { table: "film", id, set: { title: "Aliens" }, body: "A ship.\nA crew.\n" }, at(4))));
    // a hand edit, logged as EXTERNAL_EDIT with no agent
    v.write(`${F}/Aliens.md`, v.read(`${F}/Aliens.md`).replace("rating: 4", "rating: 5"));
    await logExternalEdits(v.app, v.settings);

    const h = await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Aliens` });
    expect(h).toMatchObject({ table: "main.lib.film", id, path: `${F}/Aliens.md`, exists: true, total: 4, history_start: { table: "main.lib.film", version: 0, truncated: false } });
    expect(brief(h)).toEqual(["5 update EXTERNAL_EDIT external", `4 move UPDATE engine from ${F}/Alien.md`, "2 update UPDATE engine", "1 insert WRITE engine"]);
    const [hand, rename, update, insert] = h.versions;
    expect(insert).toMatchObject({ change: "insert", operation: "WRITE", path: `${F}/Alien.md`, actor: { harness: "claude-code", model: "claude-opus-5-5", tool: "insert_row" }, user_name: "claude-code / claude-opus-5-5", body_changed: false });
    expect(insert!.changes).toEqual({ title: { before: null, after: "Alien" }, status: { before: null, after: "to watch" } });
    expect(insert!.migration_id).toEqual(expect.any(String));
    expect(update).toMatchObject({ change: "update", changes: { rating: { before: null, after: 4 }, status: { before: "to watch", after: "watched" } }, body_changed: false, actor: AGENT });
    expect(rename).toMatchObject({ change: "move", old_path: `${F}/Alien.md`, path: `${F}/Aliens.md`, changes: { title: { before: "Alien", after: "Aliens" } }, body_changed: true, body_diff: { removed: [], added: ["A crew."] }, actor: { harness: "opencode", model: "gpt-5" } });
    expect(hand).toMatchObject({ change: "update", operation: "EXTERNAL_EDIT", source: "external", changes: { rating: { before: 4, after: 5 } } });
    expect(hand!.actor).toBeUndefined();
    expect(h.created).toEqual({ table: "main.lib.film", version: insert!.version, timestamp: insert!.timestamp, operation: "WRITE", change: "insert", source: "engine", path: `${F}/Alien.md`, actor: insert!.actor, user_name: insert!.user_name, migration_id: insert!.migration_id });
    expect(h.last_modified).toMatchObject({ operation: "EXTERNAL_EDIT", source: "external", path: `${F}/Aliens.md` });
    expect(h.next_before).toBeUndefined();
    // by id: the same answer
    expect(await rowHistory(v.app, v.settings, { table: "main.lib.film", id })).toEqual(h);

    // deleted: found again by its last path or by its id
    await runWithActor({ ...AGENT, tool: "delete_rows" }, () => ok(deleteRows(v.app, v.settings, { table: "film", where: { title: "Aliens" }, mode: "delete" }, at(6))));
    const gone = await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Aliens.md` });
    expect(gone).toMatchObject({ exists: false, path: `${F}/Aliens.md`, total: 5, last_modified: { change: "delete", operation: "DELETE", actor: { tool: "delete_rows" } } });
    expect(gone.versions[0]).toMatchObject({ change: "delete", changes: {}, body_changed: false });
    expect((await rowHistory(v.app, v.settings, { table: "film", id })).total).toBe(5);
    // the old path names the row too: it was there before the rename
    expect((await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Alien.md` })).id).toBe(id);
  });

  it("pages newest first with limit and before; since keeps the newer versions", async () => {
    const v = await films();
    await ok(insertRow(v.app, v.settings, { table: "film", values: { title: "Heat", rating: 1 } }, at(1)));
    for (let i = 2; i <= 5; i++) await ok(updateRow(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, set: { rating: i } }, at(i)));
    const p1 = await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, limit: 2 });
    expect([p1.total, p1.versions.map((x) => x.changes.rating!.after), p1.next_before]).toEqual([5, [5, 4], p1.versions[1]!.timestamp]);
    const p2 = await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, limit: 2, before: p1.next_before });
    expect(p2.versions.map((x) => x.changes.rating!.after)).toEqual([3, 2]);
    const p3 = await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, limit: 2, before: p2.next_before });
    expect([p3.versions.map((x) => x.change), p3.next_before]).toEqual([["insert"], undefined]);
    // created and last_modified describe the whole history, whatever the page
    expect([p3.created?.change, p3.last_modified?.version]).toEqual(["insert", p1.versions[0]!.version]);
    const since = await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, since: "2026-09-01T10:04:00Z" });
    expect(since.versions.map((x) => x.changes.rating!.after)).toEqual([5, 4]);
  });

  it("follows a row moved to another table: the move names the table it came from, either table finds it", async () => {
    const v = await films();
    const columns = [{ name: "title", type: "string", required: true }, { name: "rating", type: "integer" }];
    await ok(createTable(v.app, v.settings, described({ schema: "lib", name: "classic", options: { filename: "{title}" }, columns }), at(1)));
    await ok(insertRow(v.app, v.settings, { table: "film", values: { title: "Metropolis", status: "old" } }, at(2)));
    const id = await idOf(v, "Metropolis");
    await runWithActor({ ...AGENT, tool: "move_rows" }, () => ok(moveRows(v.app, v.settings, { table: "film", where: { title: "Metropolis" }, toTable: "classic", drop: ["status"], relocate: true }, at(3))));
    await ok(updateRow(v.app, v.settings, { table: "classic", id, set: { rating: 5 } }, at(4)));

    const C = "Datanotes/main/lib/classic";
    const h = await rowHistory(v.app, v.settings, { table: "classic", id });
    expect(h).toMatchObject({ table: "main.lib.classic", path: `${C}/Metropolis.md`, exists: true, total: 3, history_start: { table: "main.lib.film", version: 0 } });
    expect(h.versions.map((x) => `${x.table} ${x.change}`)).toEqual(["main.lib.classic update", "main.lib.classic move", "main.lib.film insert"]);
    expect(h.versions[1]).toMatchObject({ operation: "MOVE ROWS", from_table: "main.lib.film", old_path: `${F}/Metropolis.md`, changes: { status: { before: "old", after: null }, table: { before: "main.lib.film", after: "main.lib.classic" } }, actor: { tool: "move_rows" } });
    expect(h.created).toMatchObject({ table: "main.lib.film", change: "insert" });
    // asked from the table it left, by its old path: the same history
    expect(await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Metropolis.md` })).toEqual(h);
  });

  it("a vacuumed log: the history starts at the oldest version kept, created is unknown", async () => {
    const v = await films();
    await ok(insertRow(v.app, v.settings, { table: "film", values: { title: "Heat", rating: 1 } }, at(1)));
    await ok(updateRow(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, set: { rating: 2 } }, at(2)));
    await ok(updateRow(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, set: { rating: 3 } }, at(3)));
    await vacuumTable(v.app, v.settings, { table: "film", retainFrom: 2 });
    const h = await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heat.md` });
    expect(h).toMatchObject({ created: null, total: 1, history_start: { version: 2, truncated: true }, last_modified: { version: 3 } });
    expect(h.versions[0]!.changes).toEqual({ rating: { before: 2, after: 3 } });
    // vacuumed down to the latest: no version left, the row still known
    await vacuumTable(v.app, v.settings, { table: "film" });
    expect(await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heat.md` })).toMatchObject({ exists: true, total: 0, versions: [], created: null, last_modified: null });
  });

  it("a row without an id is followed by its path", async () => {
    const v = await films();
    v.write(`${F}/Ran.md`, "---\ntable: main.lib.film\ntitle: Ran\n---\n");
    await logExternalEdits(v.app, v.settings);
    v.write(`${F}/Ran.md`, "---\ntable: main.lib.film\ntitle: Ran\nrating: 5\n---\nEpic.\n");
    await logExternalEdits(v.app, v.settings);
    const h = await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Ran.md` });
    expect(h.id).toBeUndefined();
    expect(h.versions.map((x) => `${x.change} ${x.source}`)).toEqual(["update external", "insert external"]);
    expect(h.versions[0]).toMatchObject({ changes: { rating: { before: null, after: 5 } }, body_diff: { added: ["Epic."], removed: [] } });
  });

  it("the body diff lists at most 20 lines a side, each cut at 200 characters", async () => {
    const v = await films();
    await ok(insertRow(v.app, v.settings, { table: "film", values: { title: "Heat" }, body: "old\n" }, at(1)));
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i} ${"x".repeat(i === 0 ? 300 : 0)}`);
    await ok(updateRow(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, body: `${lines.join("\n")}\n` }, at(2)));
    const d = (await rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heat.md` })).versions[0]!.body_diff!;
    expect([d.added.length, d.removed, d.truncated, d.added[0]!.length]).toEqual([20, ["old"], true, 201]);
  });

  it("refusals say what to pass, with the closest row and the docs", async () => {
    const v = await films();
    await ok(insertRow(v.app, v.settings, { table: "film", values: { title: "Heat" } }, at(1)));
    const heat = await idOf(v, "Heat");
    await refused(rowHistory(v.app, v.settings, { table: "film" }), `pass the row's "id" or "path"`, `"path"`);
    await refused(rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heap.md` }), `main.lib.film has no row at ${F}/Heap.md, now or in its history`, `Did you mean "${F}/Heat.md"?`);
    await refused(rowHistory(v.app, v.settings, { table: "film", id: "0190d9a4-0000-7000-8000-000000000000" }), "main.lib.film has no row with id 0190d9a4-0000-7000-8000-000000000000 in its history");
    await refused(rowHistory(v.app, v.settings, { table: "film", path: `${F}/Heat.md`, id: "0190d9a4-0000-7000-8000-000000000000" }), `id 0190d9a4-0000-7000-8000-000000000000 is not the row at ${F}/Heat.md (its id is ${heat})`);
    await refused(rowHistory(v.app, v.settings, { table: "film", id: heat, limit: 0 }), `"limit" must be an integer from 1 to 1000`, "next_before");
    const off = await films(false);
    const e = await rowHistory(off.app, off.settings, { table: "film", path: `${F}/Heat.md` }).catch((x: OperationInputError) => x);
    expect([(e as OperationInputError).message, (e as OperationInputError).hint]).toEqual(["main.lib.film has no history", expect.stringContaining("alter_table")]);
  });

  it("is offered by the public API", async () => {
    const v = await films();
    await ok(insertRow(v.app, v.settings, { table: "film", values: { title: "Heat" } }, at(1)));
    const api = createPublicApi(v.app, () => v.settings);
    expect((await api.rowHistory({ table: "film", path: `${F}/Heat.md` })).created?.change).toBe("insert");
  });
});
