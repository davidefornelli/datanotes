import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWithActor } from "../src/core/actor";
import { ChangeFeed } from "../src/core/change-feed";
import { addColumn, INDEX_RETRY, undoOperation } from "../src/core/engine";
import type { TFile } from "../src/core/host";
import { createPublicApi } from "../src/core/public-api";
import { deleteRows, insertRow, updateRow } from "../src/core/rows";
import { createHandlers } from "../src/server/rest";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { openNodeVault } from "../src/node/node-app";
import { LOG_YAML, logVault, METASTORE, TEST_DATABASE_FOLDER, withTables } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const A = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: alcohol\noccurred_at: 2026-09-25T22:30\nmetric_drinks: 7\n---\nA\n";

async function feedVault() {
  const v = logVault({ "Notes/plain.md": "no table here\n" });
  const feed = new ChangeFeed(v.app, () => v.settings);
  await feed.start();
  return { v, feed };
}

describe("change feed", () => {
  it("numbers engine writes with their columns, agent and journal id", async () => {
    const { v, feed } = await feedVault();
    const upd = await runWithActor({ harness: "test-agent" }, () => updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 3 } }));
    expect(upd.ok).toBe(true);
    const ins = await insertRow(v.app, v.settings, { table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } });
    await feed.flush();
    const page = await feed.read();
    expect(page.events.map((e) => [e.seq, e.op, e.table])).toEqual([
      [1, "update", "main.public.log"],
      [2, "insert", "main.public.log"],
    ]);
    expect(page.events[0]).toMatchObject({
      path: "Daily/a.md",
      id: "01a0f000-0000-7000-8000-00000000000a",
      changes: { metric_drinks: { before: 7, after: 3 } },
      source: "engine",
      actor: { harness: "test-agent" },
      migration: upd.migration_id,
      operation: "update_row",
    });
    expect(page.events[1]!.path).toBe(ins.planned_creates[0]);
    expect(page.events[1]!.changes!.kind).toEqual({ after: "mood" });
    expect(page.last).toBe(2);
    expect((await feed.read({ since: 2 })).events).toEqual([]);
    feed.stop();
  });

  it("records hand edits as external, and ignores body-only edits", async () => {
    const { v, feed } = await feedVault();
    v.write("Daily/a.md", A.replace("metric_drinks: 7", "metric_drinks: 8"));
    feed.touch("Daily/a.md");
    v.write("Daily/b.md", "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: mood\noccurred_at: 2026-09-26T08:00\n---\nB edited\n");
    feed.touch("Daily/b.md");
    v.write("Notes/new.md", "---\ntable: main.public.log\nkind: walk\noccurred_at: 2026-09-27T10:00\n---\n");
    feed.touch("Notes/new.md");
    v.write("Notes/plain.md", "still no table\n");
    feed.touch("Notes/plain.md");
    await feed.flush();
    const { events } = await feed.read();
    expect(events.map((e) => [e.op, e.path, e.source])).toEqual([
      ["update", "Daily/a.md", "external"],
      ["insert", "Notes/new.md", "external"],
    ]);
    expect(events[0]!.changes).toEqual({ metric_drinks: { before: 7, after: 8 } });
    // the table property removed by hand: the note leaves the table
    v.write("Notes/new.md", "---\nkind: walk\n---\n");
    feed.touch("Notes/new.md");
    await feed.flush();
    expect((await feed.read({ since: 2 })).events.map((e) => e.op)).toEqual(["delete"]);
    feed.stop();
  });

  it("records a schema change once: a vault event with the text unchanged is the engine's own write", async () => {
    const { v, feed } = await feedVault();
    feed.touch(METASTORE);
    await feed.flush();
    expect((await feed.read()).events).toEqual([]);
    v.write(METASTORE, `${LOG_YAML}# a comment\n`);
    feed.touch(METASTORE);
    await feed.flush();
    feed.touch(METASTORE);
    await feed.flush();
    expect((await feed.read()).events.map((e) => [e.op, e.source])).toEqual([["schema", "external"]]);
  });

  it("records metastore.yaml as the schema file: the engine's DDL, then a hand edit", async () => {
    const { v, feed } = await feedVault();
    const r = await addColumn(v.app, v.settings, described({ table: "log", column: { name: "note", type: "string" } }));
    expect(r.ok).toBe(true);
    await feed.flush();
    v.write(METASTORE, `${v.read(METASTORE)}# a comment\n`);
    feed.touch(METASTORE);
    await feed.flush();
    expect((await feed.read()).events.map((e) => [e.op, e.path, e.table, e.source])).toEqual([
      ["schema", METASTORE, null, "engine"],
      ["schema", METASTORE, null, "external"],
    ]);
    feed.stop();
  });

  it("records no schema event while the metastore cannot be read, and the edit once it can", async () => {
    const { v, feed } = await feedVault();
    const schema = async () => (await feed.read()).events.filter((e) => e.op === "schema").map((e) => e.source);
    // Broken YAML is no event; put back as it was, nothing changed.
    v.write(METASTORE, "catalogs: [\n");
    feed.touch(METASTORE);
    await feed.flush();
    v.write(METASTORE, LOG_YAML);
    feed.touch(METASTORE);
    await feed.flush();
    expect(await schema()).toEqual([]);
    // A read that fails (another program holds the file) loses no edit: it is recorded on the next event.
    const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
    const read = vault.read.bind(vault);
    let locked = false;
    vault.read = async (f) => {
      if (locked && f.path === METASTORE) {
        locked = false;
        throw new Error("EBUSY: resource busy or locked, read");
      }
      return read(f);
    };
    v.write(METASTORE, `${LOG_YAML}# edited\n`);
    locked = true;
    feed.touch(METASTORE);
    await feed.flush();
    expect(locked).toBe(false);
    expect(await schema()).toEqual([]);
    feed.touch(METASTORE);
    await feed.flush();
    expect(await schema()).toEqual(["external"]);
    feed.stop();
  });

  it("records metastore.yaml renamed away as a schema event, like a delete, and renamed back", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "change-feed-"));
    fs.mkdirSync(path.join(root, "Datanotes"));
    fs.writeFileSync(path.join(root, METASTORE), LOG_YAML);
    const host = openNodeVault(root);
    const settings = { ...DEFAULT_SETTINGS, databaseFolder: TEST_DATABASE_FOLDER };
    const feed = new ChangeFeed(host.app, () => settings);
    await feed.start();
    const rename = async (from: string, to: string) => {
      await host.fileManager.renameFile(host.vault.getAbstractFileByPath(from)!, to);
      await feed.flush();
    };
    await rename(METASTORE, "Datanotes/old.yaml");
    await rename("Datanotes/old.yaml", METASTORE); // the same text: back after being gone
    expect((await feed.read()).events.map((e) => [e.op, e.path, e.source])).toEqual([
      ["schema", METASTORE, "external"],
      ["schema", METASTORE, "external"],
    ]);
    feed.stop();
    host.metadataCache.dispose();
  });

  it("reports archived rows as deletes, renames as moves, and undo", async () => {
    const { v, feed } = await feedVault();
    const del = await deleteRows(v.app, v.settings, { table: "log", where: { kind: "mood" } } as never);
    expect(del.ok).toBe(true);
    await undoOperation(v.app, v.settings, del.migration_id!);
    await feed.flush();
    const { events } = await feed.read();
    expect(events.map((e) => [e.op, e.operation])).toEqual([
      ["delete", "delete_rows"],
      ["insert", "undo_migration"],
    ]);
    expect(events[0]).toMatchObject({ path: "Daily/b.md", changes: { kind: { before: "mood" } } });
    // a filename column changed: the note is renamed
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { kind: "walk" } });
    await feed.flush();
    const renamed = (await feed.read({ since: 2 })).events;
    expect(renamed.map((e) => [e.op, e.oldPath ?? null])).toEqual([
      ["move", "Daily/a.md"],
      ["update", null],
    ]);
    expect(renamed[1]!.changes).toEqual({ kind: { before: "alcohol", after: "walk" } });
    feed.stop();
  });

  it("filters by table, op, column and agent, and pages with limit", async () => {
    const { v, feed } = await feedVault();
    await runWithActor({ harness: "caldav-sync" }, () => updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 1 } }));
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/b.md", set: { people: ["[[Notes/plain]]"] } });
    await insertRow(v.app, v.settings, { table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } });
    await feed.flush();
    expect((await feed.read({ excludeActor: "caldav-sync" })).events.map((e) => e.seq)).toEqual([2, 3]);
    expect((await feed.read({ columns: ["people"] })).events.map((e) => e.seq)).toEqual([2, 3]); // inserts always match
    expect((await feed.read({ ops: ["insert"] })).events.map((e) => e.seq)).toEqual([3]);
    expect((await feed.read({ tables: ["nope"] })).events).toEqual([]);
    expect((await feed.read({ tables: ["log"] })).events).toHaveLength(3);
    const first = await feed.read({ limit: 1 });
    expect(first).toMatchObject({ last: 1 });
    expect((await feed.read({ since: first.last, limit: 1 })).events.map((e) => e.seq)).toEqual([2]);
    // nothing matches: `last` still moves on, so the next read skips what was filtered out
    expect(await feed.read({ ops: ["move"] })).toEqual({ events: [], last: 3, head: 3 });
    feed.stop();
  });

  it("filters with where, as select_rows does, on the row after the change (before it for deletes)", async () => {
    const { v, feed } = await feedVault();
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 9 } });
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/b.md", set: { people: ["[[Notes/plain]]"] } });
    await insertRow(v.app, v.settings, { table: "log", values: { kind: "walk", occurred_at: "2026-09-28T09:00" } });
    await feed.flush();
    const seqs = async (where: Record<string, unknown>) => (await feed.read({ where })).events.map((e) => e.seq);
    expect(await seqs({ kind: "alcohol" })).toEqual([1]);
    expect(await seqs({ metric_drinks: { gte: 5 } })).toEqual([1]);
    expect(await seqs({ or: [{ kind: "mood" }, { kind: "walk" }] })).toEqual([2, 3]);
    expect(await seqs({ kind: { in: ["walk"] }, occurred_at: { gte: "2026-09-27" } })).toEqual([3]);
    expect((await feed.read({ where: { kind: "mood" } })).events[0]!.row).toMatchObject({ kind: "mood", people: ["[[Notes/plain]]"] });
    await expect(feed.read({ where: { nope: 1 } })).rejects.toThrow(/column/);
    feed.stop();
  });

  it("tests where only on the tables the other filters keep", async () => {
    const v = logVault({ [METASTORE]: withTables('film:\n  options:\n    filename: "{title}"\n  columns:\n    - { name: title, type: string }\n    - { name: status, type: enum, values: [to watch, watched] }\n') });
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    await insertRow(v.app, v.settings, { table: "log", values: { kind: "walk", occurred_at: "2026-09-28T09:00" } });
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Metropolis", status: "watched" } });
    await feed.flush();
    const page = await feed.read({ tables: ["film"], where: { status: "watched" } });
    expect(page.events.map((e) => [e.seq, e.table])).toEqual([[2, "main.public.film"]]);
    await expect(feed.read({ where: { status: "watched" } })).rejects.toThrow(/column/);
    feed.stop();
  });

  it("long-polls until a change arrives, or times out", async () => {
    const { v, feed } = await feedVault();
    const t0 = Date.now();
    expect((await feed.wait({}, 50)).events).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    const waiting = feed.wait({ since: 0 }, 5000);
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 2 } });
    const page = await waiting;
    expect(page.events.map((e) => e.op)).toEqual(["update"]);
    feed.stop();
  });

  it("keeps the numbering across restarts and reads old events from the files", async () => {
    const { v, feed } = await feedVault();
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 2 } });
    await feed.flush();
    feed.stop();
    const again = new ChangeFeed(v.app, () => v.settings);
    await again.start();
    expect(again.lastSeq).toBe(1);
    await updateRow(v.app, v.settings, { table: "log", path: "Daily/a.md", set: { metric_drinks: 4 } });
    await again.flush();
    const { events } = await again.read();
    expect(events.map((e) => [e.seq, e.changes!.metric_drinks])).toEqual([
      [1, { before: 7, after: 2 }],
      [2, { before: 2, after: 4 }],
    ]);
    expect(v.listAll().filter((p) => p.startsWith("store:changes/"))).toHaveLength(1);
    expect(await again.prune(new Date(Date.now() + 40 * 86_400_000))).toBe(1);
    again.stop();
  });

  it("is served by the public API and the /changes/ route", async () => {
    const { v, feed } = await feedVault();
    const api = createPublicApi(v.app, () => v.settings, async () => {}, undefined, () => feed);
    await api.updateRow({ table: "log", path: "Daily/a.md", set: { metric_drinks: 5 } } as never);
    await feed.flush();
    expect((await api.changes({ since: 0 })).events).toHaveLength(1);
    const h = createHandlers(v.app, () => v.settings, async () => {}, undefined, api);
    const r = await h["/operations/list_changes/"]!({ since: 0, kinds: ["update"] });
    expect(r.status).toBe(200);
    expect((r.json as { events: unknown[] }).events).toHaveLength(1);
    const none = createPublicApi(v.app, () => v.settings);
    await expect(none.changes()).rejects.toThrow(/not available/);
    feed.stop();
  });

  it("follows vault events on the headless host: edits, deletes and renames from disk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "change-feed-"));
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    put(METASTORE, LOG_YAML);
    put("Daily/a.md", A);
    const host = openNodeVault(root);
    const settings = { ...DEFAULT_SETTINGS, databaseFolder: TEST_DATABASE_FOLDER };
    const feed = new ChangeFeed(host.app, () => settings);
    await feed.start();
    put("Daily/a.md", A.replace("kind: alcohol", "kind: walk"));
    host.vault.syncPath("Daily/a.md");
    await feed.flush();
    // a rename on disk is a delete and a create, paired by id into a move
    fs.renameSync(path.join(root, "Daily/a.md"), path.join(root, "Daily/c.md"));
    host.vault.rescan();
    await feed.flush();
    // the watcher reports the old path first: the delete and the create are still one move
    fs.renameSync(path.join(root, "Daily/c.md"), path.join(root, "Daily/d.md"));
    host.vault.syncPath("Daily/c.md");
    host.vault.syncPath("Daily/d.md");
    await feed.flush();
    fs.rmSync(path.join(root, "Daily/d.md"));
    host.vault.syncPath("Daily/d.md");
    await feed.flush();
    const { events } = await feed.read();
    expect(events[1]).toMatchObject({ oldPath: "Daily/a.md", id: "01a0f000-0000-7000-8000-00000000000a" });
    expect(events.map((e) => [e.op, e.path, e.source])).toEqual([
      ["update", "Daily/a.md", "external"],
      ["move", "Daily/c.md", "external"],
      ["move", "Daily/d.md", "external"],
      ["delete", "Daily/d.md", "external"],
    ]);
    feed.stop();
    host.metadataCache.dispose();
  });
});
