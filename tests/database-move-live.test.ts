/**
 * A move of the database folder while the engine runs (by hand, or configure_database root) is ONE
 * operation: every link into the folder rewritten across the vault and the generated columns
 * recomputed in bulk, applied before the engine answers anything else. No request reads the half
 * repaired vault, the journal has one entry, the change feed one `move` per row, the vault's git
 * sync one commit, and no per-row recompute follows. Undo and time travel of older operations
 * keep working. Also case-only renames (Datanotes to datanotes), and moves into a subfolder.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningService } from "../src/node/service";
import { movedVault, post } from "./helpers/moved-vault";

const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(25);
  expect(cond()).toBe(true);
}

/** Rename a folder as a person would: Windows refuses while a file in it is open (EPERM), so retry. */
async function renameFolder(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 50) throw e;
      await sleep(100);
    }
  }
}

type Event = { kind: string; op?: string; path: string; old_path?: string; source: string; row?: Record<string, unknown> };

/** The engine's journal and change feed since `since`. */
async function after(port: number, since: { feed: number; at: string }) {
  const migrations = ((await post(port, "operations/list_migrations/", { since: since.at })).json.migrations as { op: string; summary: string; migration_id: string }[]).filter((m) => m.op !== "set_database_id");
  const events = (await post(port, "operations/list_changes/", { since: since.feed, limit: 10_000 })).json.events as Event[];
  return { migrations, events };
}

async function mark(port: number): Promise<{ feed: number; at: string }> {
  const feed = (await post(port, "operations/list_changes/", { since: 0 })).json.last as number;
  await sleep(5); // journal times are compared as text: the move comes strictly after
  return { feed, at: new Date().toISOString() };
}

const TASKS = 120;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("a hand move of the database folder while the engine runs", () => {
  it("is one operation, into a subfolder: a request made meanwhile waits and never sees a broken link; one journal entry, one move per row, one git commit, no recompute after", async () => {
    const v = await movedVault(TASKS);
    git(v.root, "init", "-q", "-b", "main");
    git(v.root, "config", "user.name", "Test");
    git(v.root, "config", "user.email", "test@example.com");
    git(v.root, "config", "core.autocrlf", "false");
    git(v.root, "add", "-A");
    git(v.root, "commit", "-q", "-m", "before");
    const svc = await v.start({ gitSync: { intervalMs: 3_600_000, quietMs: 1500, push: false } });
    running.push(svc);
    await svc.git!.cycle(); // the first sync cycle has run (cycles never overlap): nothing to commit
    expect(git(v.root, "status", "--porcelain")).toBe("");
    const commits = () => git(v.root, "rev-list", "--count", "HEAD");
    const before = commits();
    const since = await mark(v.port);
    const t0 = Date.now();

    await renameFolder(path.join(v.root, "Datanotes"), path.join(v.root, "Archive", "Db"));
    // at once, before the engine noticed: the request settles the vault first, so it waits for the move
    const check = await post(v.port, "operations/check_table/", { table: "task" });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(check.status).toBe(200);
    expect(JSON.stringify(check.json)).not.toContain("broken_link");
    expect(svc.settings.databaseFolder).toBe("Archive/Db");
    const rows = (await post(v.port, "operations/select_rows/", { table: "task", limit: 10_000 })).json.rows as { path: string; day_note: string }[];
    expect(rows).toHaveLength(TASKS);
    for (const r of rows) {
      expect(r.path.startsWith("Archive/Db/")).toBe(true);
      expect(r.day_note).toMatch(/^\[\[Archive\/Db\/main\/public\/day\/2026-09-\d\d(\|[^\]]*)?\]\]$/);
    }
    for (const n of v.notes) expect(fs.readFileSync(path.join(v.root, n), "utf8")).not.toContain("[[Datanotes/");

    // no per-row recompute or inverse write follows (their delay is 3 s), and git commits once
    await sleep(4500);
    const { migrations, events } = await after(v.port, since);
    expect(migrations.map((m) => [m.op, m.summary])).toEqual([["move_database", "move the database folder from Datanotes to Archive/Db (moved by hand)"]]);
    expect(events.filter((e) => e.kind !== "move" && e.kind !== "metastore")).toEqual([]);
    expect(events.filter((e) => e.kind === "move")).toHaveLength(TASKS + 30);
    const move = events.find((e) => e.kind === "move" && e.path.includes("/task/"))!;
    expect(move).toMatchObject({ source: "external", op: "move_database" });
    expect(String(move.row!.day_note)).toContain("[[Archive/Db/");
    expect(events.filter((e) => e.kind === "metastore")).toEqual([expect.objectContaining({ path: "Archive/Db/metastore.yaml", old_path: "Datanotes/metastore.yaml" })]);
    await until(() => commits() !== before, 10_000);
    await sleep(2000);
    expect(Number(commits()) - Number(before)).toBe(1);
    expect(git(v.root, "log", "-1", "--format=%B")).toContain("vault sync: 1 operation");
    expect(git(v.root, "status", "--porcelain")).toBe("");

    // undo of an operation made before the move, and time travel, in the new folder
    const insert = ((await post(v.port, "operations/list_migrations/", { op: "insert_row" })).json.migrations as { migration_id: string }[])[0]!;
    const first = v.tasks[0]!.replace(/^Datanotes\//, "Archive/Db/");
    const old = (await post(v.port, "operations/select_rows/", { table: "task", version: 1 })).json.rows as { path: string }[];
    expect(old.map((r) => r.path)).toEqual([first]);
    expect((await post(v.port, "operations/undo_migration/", { migration_id: insert.migration_id })).status).toBe(200);
    expect(fs.existsSync(path.join(v.root, first))).toBe(false);
  }, 120_000);

  it("in case only (Datanotes to datanotes), where the file system ignores case too", async () => {
    const v = await movedVault(20);
    const svc = await v.start();
    running.push(svc);
    const since = await mark(v.port);
    const tmp = path.join(v.root, "tmp-rename");
    // a person renames in place; on a case-insensitive file system, through a temporary name
    await renameFolder(path.join(v.root, "Datanotes"), tmp);
    await renameFolder(tmp, path.join(v.root, "datanotes"));
    const check = await post(v.port, "operations/check_table/", { table: "task" });
    expect(JSON.stringify(check.json)).not.toContain("broken_link");
    expect(svc.settings.databaseFolder).toBe("datanotes");
    const rows = (await post(v.port, "operations/select_rows/", { table: "task", limit: 1000 })).json.rows as { path: string; day_note: string }[];
    expect(rows.every((r) => r.path.startsWith("datanotes/") && r.day_note.startsWith("[[datanotes/"))).toBe(true);
    expect(fs.readFileSync(path.join(v.root, v.notes[0]!), "utf8")).toContain("[[datanotes/main/public/task/task 0]]");
    await sleep(500);
    const { migrations } = await after(v.port, since);
    expect(migrations.map((m) => m.op)).toEqual(["move_database"]);
  }, 120_000);
});

describe("configure_database root while the engine runs", () => {
  it("moves into a subfolder, then renames in case only: each one operation, links and generated columns follow", async () => {
    const v = await movedVault(20);
    const svc = await v.start();
    running.push(svc);
    let since = await mark(v.port);
    expect((await post(v.port, "operations/configure_database/", { root: "Areas/Db" })).json.root).toBe("Areas/Db");
    let rows = (await post(v.port, "operations/select_rows/", { table: "task", limit: 1000 })).json.rows as { path: string; day_note: string }[];
    expect(rows.every((r) => r.path.startsWith("Areas/Db/") && r.day_note.startsWith("[[Areas/Db/"))).toBe(true);
    await sleep(3500);
    let r = await after(v.port, since);
    expect(r.migrations.map((m) => m.op)).toEqual(["move_database"]);
    expect(r.events.filter((e) => e.kind !== "move" && e.kind !== "metastore")).toEqual([]);
    expect(r.events.filter((e) => e.kind === "move")).toHaveLength(20 + 30);
    expect(r.events.find((e) => e.kind === "move")).toMatchObject({ source: "engine", op: "move_database" });

    since = await mark(v.port);
    const refused = await post(v.port, "operations/configure_database/", { root: "Areas/.db" });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ hint: expect.stringContaining("Editors hide folders"), docs: expect.stringContaining("#move-the-vault-or-the-database-folder") });
    const parent = await post(v.port, "operations/configure_database/", { root: "areas/db" });
    expect(parent.json).toMatchObject({ error: expect.stringContaining("changes the case of a folder above the database folder Areas/Db"), hint: 'Change the case of the database folder\'s own name only, e.g. root: "Areas/db".' });
    expect((await post(v.port, "operations/configure_database/", { root: "Areas/db" })).json.root).toBe("Areas/db");
    rows = (await post(v.port, "operations/select_rows/", { table: "task", limit: 1000 })).json.rows as { path: string; day_note: string }[];
    expect(rows.every((x) => x.path.startsWith("Areas/db/") && x.day_note.startsWith("[[Areas/db/"))).toBe(true);
    expect(fs.readdirSync(path.join(v.root, "Areas"))).toEqual(["db"]);
    r = await after(v.port, since);
    expect(r.migrations.map((m) => m.op)).toEqual(["move_database"]);
    expect(JSON.stringify((await post(v.port, "operations/check_table/", { table: "task" })).json)).not.toContain("broken_link");
  }, 120_000);
});
