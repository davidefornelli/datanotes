/**
 * The headless engine with its store outside the vault: found by the metastore's id, and the
 * database folder moved by hand while the engine is stopped or running
 * (found again by its id, recorded as configure_database root would: undo, history, links, the
 * change feed, the status).
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRegistry, storeLocation, vaultKey } from "../src/api/local";
import { startService, type RunningService } from "../src/node/service";
import { LOG_YAML, METASTORE } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";

const TOKEN = "store-service-token";
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/** A vault with the `log` table, its settings in its store. */
function storedVault(port: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-service-"));
  write(root, METASTORE, LOG_YAML);
  seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false, autoRecompute: false }, METASTORE);
  return root;
}

async function start(root: string, pollMs = 100): Promise<RunningService> {
  const svc = await startService({ vault: root, watch: "poll", pollMs }, {});
  running.push(svc);
  return svc;
}

async function post(port: number, route: string, body: unknown = {}): Promise<{ status: number; json: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}/datanotes/${route}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

/** Rename a folder as a person would: Windows refuses while a file in it is open (EPERM), so retry. */
async function renameFolder(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 50 || !["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function until(ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the store outside the vault", () => {
  it("is found by the metastore's id: the settings, the client, the status", async () => {
    const port = await freePort();
    const root = storedVault(port);
    const svc = await start(root);
    const id = svc.store.id;
    expect(svc.store).toMatchObject({ idAdded: false, database: "Datanotes" });
    expect(svc.store.store).toBe(path.join(process.env.DATANOTES_DATA_HOME!, id));
    expect(fs.existsSync(path.join(root, ".datanotes"))).toBe(false);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(svc.store.store, "settings.json"), "utf8"))).sort()).toEqual(["autoRecompute", "fileLogEnabled", "httpServerPort", "httpServerToken"]);
    // the client finds the engine through the store
    expect(storeLocation(root)?.store).toBe(svc.store.store);
    const status = (await post(port, "status/")).json;
    expect(status.engine).toMatchObject({ store: svc.store.store, database_id: id, database_folder: "Datanotes" });
  });
});

describe("the database folder moved by hand", () => {
  it("while the engine is stopped: found again by its id at the next start, links repaired, undo and history in the new folder", async () => {
    const port = await freePort();
    const root = storedVault(port);
    let svc = await start(root);
    expect((await post(port, "operations/configure_database/", { history: true })).status).toBe(200);
    const ins = await post(port, "operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-09-26T08:00" } });
    const row = (ins.json.planned_creates as string[])[0]!;
    expect(row.startsWith("Datanotes/")).toBe(true);
    write(root, "Notes/link.md", `See [[${row.replace(/\.md$/, "")}]].\n`);
    await svc.stop();
    running.pop();

    fs.mkdirSync(path.join(root, "Life"));
    fs.renameSync(path.join(root, "Datanotes"), path.join(root, "Life", "Db"));
    svc = await start(root);
    expect(svc.store.moved).toEqual({ from: "Datanotes", to: "Life/Db" });
    expect(svc.settings.databaseFolder).toBe("Life/Db");
    const moved = row.replace(/^Datanotes\//, "Life/Db/");
    expect(fs.readFileSync(path.join(root, "Notes/link.md"), "utf8")).toBe(`See [[${moved.replace(/\.md$/, "")}]].\n`);
    expect(readRegistry(process.env.DATANOTES_DATA_HOME!)[vaultKey(root)]).toEqual({ id: svc.store.id, database: "Life/Db" });

    const list = (await post(port, "operations/list_migrations/")).json.migrations as { op: string; migration_id: string; summary: string }[];
    expect(list[0]).toMatchObject({ op: "move_database", summary: "move the database folder from Datanotes to Life/Db (moved by hand)" });
    const insert = list.find((m) => m.op === "insert_row")!;
    expect((await post(port, "operations/undo_migration/", { migration_id: insert.migration_id })).status).toBe(200);
    expect(fs.existsSync(path.join(root, moved))).toBe(false);
    const history = (await post(port, "operations/describe_history/", { table: "log" })).json.history as { operation: string; operation_parameters?: unknown }[];
    expect(history.map((h) => h.operation)).toContain("MOVE DATABASE");
    const before = (await post(port, "operations/select_rows/", { table: "log", version: 1 })).json.rows as { path: string }[];
    expect(before.map((r) => r.path)).toContain(moved);

    const status = (await post(port, "status/")).json;
    expect(status.database.moved).toMatchObject({ from: "Datanotes", to: "Life/Db", by: "hand" });
    const feed = (await post(port, "operations/list_changes/", { since: 0, kinds: ["metastore"] })).json.events as { path: string; old_path?: string; op?: string }[];
    expect(feed.at(-1)).toMatchObject({ path: "Life/Db/metastore.yaml", old_path: "Datanotes/metastore.yaml", op: "move_database" });
  }, 60_000);

  it("while the engine runs: the rows move (not deleted) on the change feed, undo still works, the store records the new folder", async () => {
    const port = await freePort();
    const root = storedVault(port);
    const svc = await start(root);
    const ins = await post(port, "operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-09-26T08:00" } });
    const row = (ins.json.planned_creates as string[])[0]!;
    // the feed records the insert first: else the moved row would be new to it, not moved
    await svc.runtime.changeFeed?.flush();
    const since = (await post(port, "operations/list_changes/", { since: 0 })).json.last as number;

    await renameFolder(path.join(root, "Datanotes"), path.join(root, "Moved"));
    await until(() => svc.settings.databaseFolder === "Moved");
    await svc.runtime.relocated();
    await svc.runtime.changeFeed?.flush();
    const events = (await post(port, "operations/list_changes/", { since })).json.events as { kind: string; path: string; old_path?: string; source: string }[];
    expect(events.filter((e) => e.kind === "delete")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "move", path: row.replace(/^Datanotes\//, "Moved/"), old_path: row, source: "external" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "metastore", path: "Moved/metastore.yaml", old_path: "Datanotes/metastore.yaml" }));
    expect(JSON.parse(fs.readFileSync(path.join(svc.store.store, "store.json"), "utf8")).database).toBe("Moved");
    expect((await post(port, "operations/list_tables/")).json.tables.map((t: { qualified: string }) => t.qualified)).toEqual(["main.public.log"]);
    const list = (await post(port, "operations/list_migrations/", { op: "insert_row", limit: 1 })).json.migrations as { migration_id: string }[];
    expect((await post(port, "operations/undo_migration/", { migration_id: list[0]!.migration_id })).status).toBe(200);
    expect(fs.existsSync(path.join(root, row.replace(/^Datanotes\//, "Moved/")))).toBe(false);
  }, 60_000);

  it("a metastore deleted while the engine runs is not a move: nothing has its id, the rows are gone", async () => {
    const port = await freePort();
    const root = storedVault(port);
    const svc = await start(root);
    fs.rmSync(path.join(root, METASTORE));
    await until(() => svc.runtime.relocation !== null);
    await svc.runtime.relocation;
    expect(svc.settings.databaseFolder).toBe("Datanotes");
    expect(await svc.runtime.findMovedDatabase()).toBeNull();
    // two folders with the id: not a move either
    const id = svc.store.id;
    write(root, "A/metastore.yaml", `id: ${id}\n`);
    write(root, "B/metastore.yaml", `id: ${id}\n`);
    expect(await svc.runtime.findMovedDatabase()).toBeNull();
    expect(svc.settings.databaseFolder).toBe("Datanotes");
  }, 60_000);
});
