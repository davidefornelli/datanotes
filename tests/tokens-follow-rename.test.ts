/**
 * A named token's exact grants follow a table renamed or moved (alter_table, alone or in a batch)
 * and back again (undo_migration); patterns, dry runs and refused renames change nothing
 * (guides/security/tokens#a-renamed-table-keeps-its-grants).
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followMove, followRename, TokenRegistry, type TokenRecord } from "../src/server/tokens";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { startService, type RunningService } from "../src/node/service";
import { createDbVault, METASTORE, withTables } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";

/** The undos made to fail (a disk error), by journal id: a batch's rollback that fails. */
const failUndo = vi.hoisted(() => ({ when: null as ((id: string) => boolean) | null }));
vi.mock("../src/core/engine", async (importOriginal) => {
  const engine = await importOriginal<typeof import("../src/core/engine")>();
  return {
    ...engine,
    undoOperation: (...args: Parameters<typeof engine.undoOperation>) =>
      failUndo.when?.(args[2])
        ? Promise.resolve({ ok: false, op: "undo_migration" as const, undoes: args[2], conflicts: [], failed: [{ path: "undo", error: "disk full" }] })
        : engine.undoOperation(...args),
  };
});

const running: { stop(): Promise<void> }[] = [];
/** The vaults of this file's engines: removed after each test. */
const roots: string[] = [];
afterEach(async () => {
  failUndo.when = null;
  for (const s of running.splice(0).reverse()) await s.stop();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
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

const YAML = withTables(`task:
  description: Things to do.
  options:
    filename: "{title}"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true, description: The row's id. }
    - { name: title, type: string, required: true, description: What to do. }
`);

const OWNER = "owner-token";

/**
 * An engine on a new vault, or again on the vault of an engine stopped before (`again`). A restart
 * gets a new port: another file's engine may have taken the old one since.
 */
async function engine(again?: { root: string; store: string }) {
  const p = await freePort();
  if (again) {
    const file = path.join(again.store, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), httpServerPort: p }));
  }
  const root = again?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "tokens-follow-"));
  if (!again) {
    roots.push(root);
    fs.mkdirSync(path.join(root, "Datanotes"), { recursive: true });
    fs.writeFileSync(path.join(root, METASTORE), YAML);
    seedStoreSettings(root, { httpServerPort: p, httpServerToken: OWNER, fileLogEnabled: false, autoRecompute: false }, METASTORE);
  }
  const svc: RunningService = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
  running.push(svc);
  const base = `http://127.0.0.1:${p}`;
  const call = async (route: string, body: unknown, token = OWNER) => {
    const r = await fetch(`${base}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const op = (name: string, body: unknown, token = OWNER) => call(`/datanotes/operations/${name}/`, body, token);
  const create = async (body: Record<string, unknown>) => {
    const r = await call("/datanotes/tokens/create/", body);
    expect(r.status).toBe(200);
    return r.json.token as string;
  };
  const tokens = async () => {
    const r = await call("/datanotes/tokens/", {});
    return Object.fromEntries((r.json.tokens as { name: string; read: string[]; write: string[] }[]).map((t) => [t.name, { read: t.read, write: t.write }]));
  };
  const stored = () => JSON.parse(fs.readFileSync(path.join(svc.store.store, "tokens.json"), "utf8")) as TokenRecord[];
  const tokensFile = path.join(svc.store.store, "tokens.json");
  const stop = async () => {
    running.splice(running.indexOf(svc), 1);
    await svc.stop();
  };
  return { op, call, create, tokens, stored, tokensFile, stop, root, store: svc.store.store };
}

describe("tokens follow a renamed table: the rule", () => {
  const token = (read: string[] | undefined, write: string[]): TokenRecord => ({ name: "t", tokenHash: "h", ...(read ? { read } : {}), write, ddl: false, createdAt: "c", updatedAt: "u", lastSeen: "s" });

  it("puts the new name in the place of the old one, in read and write", () => {
    const t = token(["a.b.x", "a.b.task", "a.b.y"], ["a.b.task"]);
    expect(followMove(t, "a.b.task", "a.b.todo")).toEqual(["read", "write"]);
    expect(t.read).toEqual(["a.b.x", "a.b.todo", "a.b.y"]);
    expect(t.write).toEqual(["a.b.todo"]);
    expect([t.updatedAt, t.lastSeen]).toEqual(["u", "s"]);
  });

  it("leaves patterns alone, and adds no duplicate", () => {
    const t = token(["a.b.*", "a.c.todo", "a.b.task"], ["a.*"]);
    expect(followMove(t, "a.b.task", "a.c.todo")).toEqual(["read"]);
    expect(t.read).toEqual(["a.b.*", "a.c.todo"]);
    expect(t.write).toEqual(["a.*"]);
    expect(followMove(token(["*"], ["*"]), "a.b.task", "a.b.todo")).toEqual([]);
  });

  it("gives read of the new name to an exact write that a read pattern covered only under the old one", () => {
    const t = token(["a.b.*"], ["a.b.task"]);
    expect(followMove(t, "a.b.task", "a.c.task")).toEqual(["read", "write"]);
    expect(t.read).toEqual(["a.b.*", "a.c.task"]);
    expect(t.write).toEqual(["a.c.task"]);
    // a token that reads every table needs nothing more
    const all = token(undefined, ["a.b.task"]);
    expect(followMove(all, "a.b.task", "a.c.task")).toEqual(["write"]);
    expect(all.read).toBeUndefined();
  });
});

describe("tokens follow a renamed table: the lists an undo puts back", () => {
  const AFTER = { read: ["m.p.b"], write: ["m.p.b"] };
  /** A token after rename "r" (m.p.a to m.p.b), with what it kept of it; then its undo "u". */
  const undo = (kept: unknown, extra: Partial<TokenRecord> = {}) => {
    const t = { name: "t", tokenHash: "h", read: ["m.p.b"], write: ["m.p.b"], ddl: false, createdAt: "c", updatedAt: "u", follows: kept, ...extra } as unknown as TokenRecord;
    const follows = followRename(t, "u", [{ from: "m.p.b", to: "m.p.a" }], "r");
    return { lists: { ...(t.read !== undefined ? { read: t.read } : {}), write: t.write }, follows };
  };
  const BY_NAME = { read: ["m.p.a"], write: ["m.p.a"] };

  it("puts back valid kept lists exactly, read absent included", () => {
    expect(undo([null, { migration: "r", before: { read: ["m.p.a", "m.p.x"], write: ["m.p.a"] }, after: AFTER }]).lists).toEqual({ read: ["m.p.a", "m.p.x"], write: ["m.p.a"] });
    expect(undo([{ migration: "r", before: { write: ["m.p.a"] }, after: AFTER }])).toEqual({ lists: { write: ["m.p.a"] }, follows: [{ token: "t", from: "m.p.b", to: "m.p.a", permissions: ["read", "write"] }] });
  });

  it("follows by name, and logs it, when the kept lists are not valid", () => {
    const logs: string[] = [];
    setTelemetry({ log: (severity, body) => void logs.push(`${severity} ${body}`), flush: async () => {} });
    try {
      const bad: [string, unknown][] = [
        ["a string for write", { before: { read: ["m.p.*"], write: "*" }, after: AFTER }],
        ["no before", { before: null, after: AFTER }],
        ["no after", { before: { write: ["m.p.a"] } }],
        ["a string for read", { before: { read: "m.p.*", write: ["m.p.a"] }, after: AFTER }],
        ["a number in write", { before: { write: [1] }, after: AFTER }],
        ["a number in read", { before: { read: [1], write: [] }, after: AFTER }],
        ["a write pattern that is no name", { before: { write: ["m p a"] }, after: AFTER }],
        ["a read pattern that is no name", { before: { read: ["m p *"], write: [] }, after: AFTER }],
        ["a write its read does not cover", { before: { read: ["m.p.x"], write: ["m.p.a"] }, after: AFTER }],
      ];
      for (const [why, kept] of bad) expect(undo([{ migration: "r", ...(kept as object) }]).lists, why).toEqual(BY_NAME);
      expect(logs.filter((l) => l === "WARN datanotes token's kept lists are not valid: its undo follows by name")).toHaveLength(bad.length);
      // kept lists that are not a list at all: nothing to put back
      expect(undo("x").lists).toEqual(BY_NAME);
      // and the token still follows, and keeps a list of one entry: no throw after its lists changed
      for (const notAList of ["x", 5, {}]) {
        const t = { name: "t", tokenHash: "h", read: ["m.p.b"], write: ["m.p.b"], ddl: false, createdAt: "c", updatedAt: "u", follows: notAList } as unknown as TokenRecord;
        expect(followRename(t, "u", [{ from: "m.p.b", to: "m.p.a" }], "r"), String(notAList)).toEqual([{ token: "t", from: "m.p.b", to: "m.p.a", permissions: ["read", "write"] }]);
        expect(t.follows).toEqual([{ migration: "u", before: AFTER, after: BY_NAME }]);
      }
      // a token with ddl needs read on every table: restricted lists are not put back
      expect(undo([{ migration: "r", before: { read: ["m.p.a"], write: ["m.p.a"] }, after: AFTER }], { ddl: true }).lists).toEqual(BY_NAME);
    } finally {
      setTelemetry(NOOP_TELEMETRY);
    }
  });
});

describe("tokens follow a renamed table: over HTTP", () => {
  it("renames within the schema: exact names follow, patterns stay, the token keeps working", async () => {
    const { op, create, tokens, stored } = await engine();
    const exact = await create({ name: "exact", read: ["main.public.task", "main.public.log"], write: ["main.public.task"] });
    await create({ name: "pattern", read: ["main.*"], write: ["main.public.*"] });
    await create({ name: "both", read: ["main.public.task", "main.public.*"], write: ["main.public.task"] });
    await create({ name: "other", write: ["main.public.log"] });

    const renamed = await op("alter_table", { table: "main.public.task", name: "todo" });
    expect(renamed.status).toBe(200);
    expect(renamed.json.tokens_followed).toEqual([
      { token: "exact", from: "main.public.task", to: "main.public.todo", permissions: ["read", "write"] },
      { token: "both", from: "main.public.task", to: "main.public.todo", permissions: ["read", "write"] },
    ]);
    expect(await tokens()).toEqual({
      exact: { read: ["main.public.todo", "main.public.log"], write: ["main.public.todo"] },
      pattern: { read: ["main.*"], write: ["main.public.*"] },
      both: { read: ["main.public.todo", "main.public.*"], write: ["main.public.todo"] },
      other: { read: ["*"], write: ["main.public.log"] },
    });
    // saved: the registry file holds the new names
    expect(stored().find((t) => t.name === "exact")!.write).toEqual(["main.public.todo"]);

    // the token writes and reads the table under its new name right away
    const inserted = await op("insert_row", { table: "main.public.todo", values: { title: "water the plants" } }, exact);
    expect(inserted.status).toBe(200);
    const rows = await op("select_rows", { table: "main.public.todo" }, exact);
    expect(rows.status).toBe(200);
    expect((rows.json.rows as { title: string }[]).map((r) => r.title)).toEqual(["water the plants"]);
  });

  it("moves to another schema and catalog; undo puts the old names back", async () => {
    const { op, create, tokens } = await engine();
    const token = await create({ name: "mover", read: ["main.public.task", "main.public.log"], write: ["main.public.task"] });
    await create({ name: "watcher", read: ["main.public.*"], write: ["main.public.task"] });

    const toSchema = await op("alter_table", { table: "main.public.task", schema: "work" });
    expect(toSchema.status).toBe(200);
    expect((await tokens()).mover).toEqual({ read: ["main.work.task", "main.public.log"], write: ["main.work.task"] });
    // the read pattern no longer covers the table it writes: it gets read of the new name too
    expect((await tokens()).watcher).toEqual({ read: ["main.public.*", "main.work.task"], write: ["main.work.task"] });

    const toCatalog = await op("alter_table", { table: "main.work.task", catalog: "home", schema: "lists", name: "todo" });
    expect(toCatalog.status).toBe(200);
    expect((await tokens()).mover).toEqual({ read: ["home.lists.todo", "main.public.log"], write: ["home.lists.todo"] });
    expect((await op("select_rows", { table: "home.lists.todo" }, token)).status).toBe(200);

    // undo the move to the catalog: the tokens follow the table back
    const undone = await op("undo_migration", { migration_id: toCatalog.json.migration_id });
    expect(undone.status).toBe(200);
    expect((await tokens()).mover).toEqual({ read: ["main.work.task", "main.public.log"], write: ["main.work.task"] });
    expect((await op("insert_row", { table: "main.work.task", values: { title: "call Ada" } }, token)).status).toBe(200);
  });

  it("undo of a rename renames the grants back, and undoing the undo renames them again", async () => {
    const { op, create, tokens } = await engine();
    const token = await create({ name: "planner", read: ["main.public.task"], write: ["main.public.task"] });
    const renamed = await op("alter_table", { table: "task", name: "attivita" });
    expect((await tokens()).planner!.write).toEqual(["main.public.attivita"]);

    const undone = await op("undo_migration", { migration_id: renamed.json.migration_id });
    expect(undone.status).toBe(200);
    expect(undone.json.tokens_followed).toEqual([{ token: "planner", from: "main.public.attivita", to: "main.public.task", permissions: ["read", "write"] }]);
    expect(await tokens()).toEqual({ planner: { read: ["main.public.task"], write: ["main.public.task"] } });
    expect((await op("insert_row", { table: "main.public.task", values: { title: "plan" } }, token)).status).toBe(200);

    // undoing the undo is a redo: the grants follow the table again
    const redone = await op("undo_migration", { migration_id: undone.json.migration_id });
    expect(redone.status).toBe(200);
    expect((await tokens()).planner).toEqual({ read: ["main.public.attivita"], write: ["main.public.attivita"] });
  });

  it("undo puts the lists back exactly: the read a move added goes, a name the token also held comes back", async () => {
    const { op, call, create, tokens } = await engine();
    await create({ name: "watcher", read: ["main.public.*"], write: ["main.public.task"] });
    await create({ name: "both", read: ["main.public.task", "main.public.todo"], write: ["main.public.task", "main.public.todo"] });
    await create({ name: "edited", read: ["main.public.*"], write: ["main.public.task"] });
    await create({ name: "writer", write: ["main.public.task"] });
    const before = await tokens();

    const moved = await op("alter_table", { table: "main.public.task", schema: "work", name: "todo" });
    expect(moved.status).toBe(200);
    expect(await tokens()).toEqual({
      watcher: { read: ["main.public.*", "main.work.todo"], write: ["main.work.todo"] },
      both: { read: ["main.work.todo", "main.public.todo"], write: ["main.work.todo", "main.public.todo"] },
      edited: { read: ["main.public.*", "main.work.todo"], write: ["main.work.todo"] },
      writer: { read: ["*"], write: ["main.work.todo"] },
    });
    // the owner changes one token in between: its undo follows the table back by name only
    expect((await call("/datanotes/tokens/update/", { name: "edited", read: ["main.public.*", "main.work.todo", "main.public.log"] })).status).toBe(200);

    const undone = await op("undo_migration", { migration_id: moved.json.migration_id });
    expect(undone.status).toBe(200);
    expect(undone.json.tokens_followed).toEqual([
      { token: "watcher", from: "main.work.todo", to: "main.public.task", permissions: ["read", "write"] },
      { token: "both", from: "main.work.todo", to: "main.public.task", permissions: ["read", "write"] },
      { token: "edited", from: "main.work.todo", to: "main.public.task", permissions: ["read", "write"] },
      { token: "writer", from: "main.work.todo", to: "main.public.task", permissions: ["write"] },
    ]);
    expect(await tokens()).toEqual({
      watcher: before.watcher,
      both: before.both,
      edited: { read: ["main.public.*", "main.public.task", "main.public.log"], write: ["main.public.task"] },
      writer: before.writer,
    });

    // undoing the undo moves them again, exactly as the move did
    const redone = await op("undo_migration", { migration_id: undone.json.migration_id });
    expect(redone.status).toBe(200);
    expect((await tokens()).watcher).toEqual({ read: ["main.public.*", "main.work.todo"], write: ["main.work.todo"] });
    expect((await tokens()).both).toEqual({ read: ["main.work.todo", "main.public.todo"], write: ["main.work.todo", "main.public.todo"] });
  });

  it("changes nothing on a dry run or a refused rename", async () => {
    const { op, create, tokens } = await engine();
    await create({ name: "planner", read: ["main.public.task", "main.public.log"], write: ["main.public.task"] });
    const before = await tokens();

    const dry = await op("alter_table", { table: "task", name: "todo", dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.json.dry_run).toBe(true);
    expect(dry.json.tokens_followed).toBeUndefined();

    // the name is taken by another table: refused, the token keeps its grants
    const refused = await op("alter_table", { table: "task", name: "log" });
    expect(refused.status).toBe(422);
    expect(refused.json.tokens_followed).toBeUndefined();
    expect(await tokens()).toEqual(before);
  });

  it("follows a rename in a batch, and back when the batch is rolled back", async () => {
    const { op, create, tokens } = await engine();
    await create({ name: "planner", read: ["main.public.task", "main.public.log"], write: ["main.public.task"] });

    const batch = await op("batch", { operations: [{ op: "alter_table", table: "task", name: "todo" }, { op: "insert_row", table: "main.public.todo", values: { title: "plan" } }] });
    expect(batch.status).toBe(200);
    expect(batch.json.steps[0].result.tokens_followed).toEqual([{ token: "planner", from: "main.public.task", to: "main.public.todo", permissions: ["read", "write"] }]);
    expect((await tokens()).planner!.write).toEqual(["main.public.todo"]);

    // undo of the batch: its rename is undone too, and the grants follow back
    const undone = await op("undo_migration", { migration_id: batch.json.migration_id });
    expect(undone.status).toBe(200);
    expect(undone.json.tokens_followed).toEqual([{ token: "planner", from: "main.public.todo", to: "main.public.task", permissions: ["read", "write"] }]);
    expect((await tokens()).planner!.write).toEqual(["main.public.task"]);

    // a batch refused after its rename: rolled back, the grants are back too, and its answer lists none
    const failed = await op("batch", { operations: [{ op: "alter_table", table: "task", name: "todo" }, { op: "insert_row", table: "main.public.todo", values: {} }] });
    expect(failed.status).toBe(422);
    expect(failed.json.rolled_back).toBe(true);
    expect(failed.json.steps[0].result.tokens_followed).toBeUndefined();
    expect((await tokens()).planner).toEqual({ read: ["main.public.task", "main.public.log"], write: ["main.public.task"] });
  });

  it("lists the tokens of the renames a failed rollback left in place", async () => {
    const { op, create, tokens } = await engine();
    await create({ name: "planner", read: ["main.public.task", "main.public.log"], write: ["main.public.task", "main.public.log"] });
    // the rollback cannot undo the rename of task; it undoes the rename of log
    failUndo.when = (id) => id.includes("main-public-task");
    const failed = await op("batch", {
      operations: [
        { op: "alter_table", table: "task", name: "todo" },
        { op: "alter_table", table: "log", name: "journal" },
        { op: "insert_row", table: "main.public.todo", values: {} },
      ],
    });
    expect(failed.status).toBe(500);
    expect(failed.json.rolled_back).toBe(false);
    expect(failed.json.steps[0].result.tokens_followed).toEqual([{ token: "planner", from: "main.public.task", to: "main.public.todo", permissions: ["read", "write"] }]);
    expect(failed.json.steps[1].result.tokens_followed).toBeUndefined();
    expect((await tokens()).planner).toEqual({ read: ["main.public.todo", "main.public.log"], write: ["main.public.todo", "main.public.log"] });
  });

  it("lists the followed tokens to the owner only", async () => {
    const { op, create, tokens } = await engine();
    const admin = await create({ name: "admin", ddl: true });
    await create({ name: "planner", read: ["main.public.task", "main.public.log"], write: ["main.public.task"] });
    const renamed = await op("alter_table", { table: "task", name: "todo" }, admin);
    expect(renamed.status).toBe(200);
    expect(renamed.json.tokens_followed).toBeUndefined();
    expect((await tokens()).planner!.write).toEqual(["main.public.todo"]);
  });

  it("has no view to follow: a view cannot be renamed", async () => {
    const { op, create, tokens } = await engine();
    await create({ name: "viewer", read: ["main.public.vw_tasks"] });
    expect((await op("create_view", { name: "vw_tasks", description: "Every task.", query: { table: "task" } })).status).toBe(200);
    const refused = await op("alter_table", { table: "vw_tasks", name: "vw_todo" });
    expect(refused.status).toBe(404);
    expect(refused.json.error).toBe("Table not found: vw_tasks");
    expect(refused.json.hint).toMatch(/view/);
    expect((await tokens()).viewer!.read).toEqual(["main.public.vw_tasks"]);
  });

  it("leaves the grants alone on restore_table, which keeps the table's current name", async () => {
    const { op, create, tokens } = await engine();
    await create({ name: "planner", read: ["main.public.task", "main.public.log"], write: ["main.public.task"] });
    expect((await op("alter_table", { table: "task", history: true })).status).toBe(200);
    expect((await op("insert_row", { table: "task", values: { title: "plan" } })).status).toBe(200);
    expect((await op("alter_table", { table: "task", name: "todo" })).status).toBe(200);
    const restored = await op("restore_table", { table: "main.public.todo", version: 0 });
    expect(restored.status).toBe(200);
    expect(restored.json.tokens_followed).toBeUndefined();
    expect((await op("list_tables", {})).json.tables.map((t: { name: string }) => t.name)).toContain("todo");
    expect((await tokens()).planner!.write).toEqual(["main.public.todo"]);
  });

  it("catches up at start with a rename journaled before a stop that lost the registry's save", async () => {
    const first = await engine();
    await first.create({ name: "planner", read: ["main.public.task", "main.public.log"], write: ["main.public.task"] });
    await first.create({ name: "logger", write: ["main.public.log"] });
    // the registry as it was saved before the renames: the stop came before their save
    const saved = fs.readFileSync(first.tokensFile, "utf8");
    expect((await first.op("alter_table", { table: "task", name: "todo" })).status).toBe(200);
    expect((await first.op("alter_table", { table: "log", name: "journal" })).status).toBe(200);
    await first.stop();
    fs.writeFileSync(first.tokensFile, saved);

    const again = await engine({ root: first.root, store: first.store });
    expect(await again.tokens()).toEqual({
      planner: { read: ["main.public.todo", "main.public.journal"], write: ["main.public.todo"] },
      logger: { read: ["*"], write: ["main.public.journal"] },
    });
    // saved, and marked as through the last rename: a third start changes nothing
    const caught = again.stored();
    expect(new Set(caught.map((t) => t.movesThrough)).size).toBe(1);
    expect(caught[0]!.movesThrough).toMatch(/alter_table/);
    await again.stop();
    const third = await engine({ root: first.root, store: first.store });
    expect(third.stored()).toEqual(caught);
  });

  it("does not follow at start the renames a token from an older engine already had: it starts from now", async () => {
    const first = await engine();
    await first.create({ name: "planner", read: ["main.public.task"], write: ["main.public.task"] });
    expect((await first.op("alter_table", { table: "task", name: "todo" })).status).toBe(200);
    expect((await first.op("alter_table", { table: "todo", name: "task" })).status).toBe(200);
    await first.stop();
    // a registry written before tokens kept their mark, by hand: its grants are taken as they are
    const legacy = (JSON.parse(fs.readFileSync(first.tokensFile, "utf8")) as TokenRecord[]).map(({ movesThrough: _m, ...t }) => ({ ...t, write: ["main.public.todo"], read: ["main.public.todo"] }));
    fs.writeFileSync(first.tokensFile, JSON.stringify(legacy));

    const again = await engine({ root: first.root, store: first.store });
    expect((await again.tokens()).planner).toEqual({ read: ["main.public.todo"], write: ["main.public.todo"] });
    expect(again.stored()[0]!.movesThrough).toMatch(/alter_table/);
  });
});

describe("tokens follow a renamed table: the catch-up at start", () => {
  const token = (name: string, lists: { read?: string[]; write: string[] }, movesThrough?: string): TokenRecord => ({
    name,
    tokenHash: `hash-${name}`,
    ...lists,
    ddl: false,
    createdAt: "c",
    updatedAt: "u",
    ...(movesThrough !== undefined ? { movesThrough } : {}),
  });
  /** A journal line of a rename (a failed one, or an undo, as given). */
  const line = (id: string, from: string, to: string, extra: { failed?: boolean; undoes?: string } = {}) =>
    JSON.stringify({ type: "migration", migration_id: id, op: "alter_table", summary: "", executed_at: "2026-11-01T10:00:00.000Z", rows: [], creates: [], moves: [], references: [], failed: extra.failed ? [{ path: "x", error: "disk full" }] : [], ...(extra.undoes ? { undoes: extra.undoes } : {}), table_moves: [{ from, to }] });
  const vault = (tokens: TokenRecord[] | null, journal: string[]) => {
    const v = createDbVault({ [METASTORE]: YAML });
    if (tokens) v.write("store:tokens.json", JSON.stringify(tokens));
    v.write("store:journal/2026-10.jsonl", `${JSON.stringify({ type: "migration", migration_id: "20261001T100000-insert_row", op: "insert_row", summary: "", executed_at: "2026-10-01T10:00:00.000Z", rows: [], creates: [], moves: [], references: [], failed: [] })}\n`);
    v.write("store:journal/2026-11.jsonl", journal.map((l) => `${l}\n`).join(""));
    return v;
  };
  const read = (v: ReturnType<typeof createDbVault>) => JSON.parse(v.read("store:tokens.json")) as TokenRecord[];

  it("follows each token from its own mark; skips a write that failed partway and its rollback", async () => {
    const v = vault(
      [token("fresh", { write: ["m.p.a"] }, ""), token("middle", { write: ["m.p.c"] }, "20261101T100001-b"), token("gone", { write: ["m.p.a"] }, "20261001T090000-compacted")],
      [
        line("20261101T100000-a", "m.p.a", "m.p.b"),
        line("20261101T100001-b", "m.p.b", "m.p.c"),
        line("20261101T100002-failed", "m.p.c", "m.p.x", { failed: true }),
        line("20261101T100003-rollback", "m.p.x", "m.p.c", { undoes: "20261101T100002-failed" }),
        JSON.stringify({ type: "undone", migration_id: "20261001T100000-insert_row", undone_by: "x", at: "2026-11-01T10:00:00.000Z" }),
        line("20261101T100004-d", "m.p.c", "m.p.d"),
      ],
    );
    const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
    await registry.load();
    expect(read(v).map((t) => [t.name, t.write, t.movesThrough])).toEqual([
      ["fresh", ["m.p.d"], "20261101T100004-d"],
      ["middle", ["m.p.d"], "20261101T100004-d"],
      // its mark is no longer in the journal (compacted): every rename left there is newer
      ["gone", ["m.p.d"], "20261101T100004-d"],
    ]);
    // the apply hook of a rename followed at start changes nothing more, and answers what it followed
    registry.followTableMoves("20261101T100004-d", [{ from: "m.p.c", to: "m.p.d" }]);
    expect(await registry.takeFollowed(["20261101T100004-d"])).toEqual([
      { token: "fresh", from: "m.p.c", to: "m.p.d", permissions: ["write"] },
      { token: "middle", from: "m.p.c", to: "m.p.d", permissions: ["write"] },
      { token: "gone", from: "m.p.c", to: "m.p.d", permissions: ["write"] },
    ]);
    await registry.stop();
  });

  it("writes nothing for an empty registry, and marks a token created then as through the last rename", async () => {
    const v = vault(null, [line("20261101T100000-a", "m.p.a", "m.p.b")]);
    const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
    await registry.load();
    expect(v.exists("store:tokens.json")).toBe(false);
    await registry.create({ name: "late", write: ["m.p.a"] });
    expect(read(v)[0]!.movesThrough).toBe("20261101T100000-a");
    await registry.stop();
  });

  it("keeps the followed tokens of the last 100 renames for their answers", async () => {
    const v = vault([token("t", { write: ["m.p.a"] }, "")], []);
    const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
    registry.followTableMoves("first", [{ from: "m.p.a", to: "m.p.b" }]);
    for (let i = 0; i < 100; i++) registry.followTableMoves(`next-${i}`, [{ from: "m.p.y", to: "m.p.z" }]);
    expect(await registry.takeFollowed(["first"])).toEqual([]);
    expect(await registry.takeFollowed(["next-0"])).toEqual([]);
    expect(registry.get("t")!.write).toEqual(["m.p.b"]);
    await registry.stop();
  });

  it("skips a token record of a wrong shape, logs it, and follows on: no rejection is left unhandled", async () => {
    const logs: string[] = [];
    setTelemetry({ log: (severity, body) => void logs.push(`${severity} ${body}`), flush: async () => {} });
    try {
      const broken = { name: "broken", tokenHash: "hash-broken", ddl: false, createdAt: "c", updatedAt: "u", movesThrough: "" } as unknown as TokenRecord;
      // a rename journaled before the start, and one after: both reach the broken record
      const v = vault([broken, token("t", { write: ["m.p.a"] }, "")], [line("20261101T100000-a", "m.p.a", "m.p.b")]);
      const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
      await registry.load();
      registry.followTableMoves("20261101T100001-b", [{ from: "m.p.b", to: "m.p.c" }]);
      expect(await registry.takeFollowed(["20261101T100001-b"])).toEqual([{ token: "t", from: "m.p.b", to: "m.p.c", permissions: ["write"] }]);
      registry.followTableMoves("20261101T100002-c", [{ from: "m.p.c", to: "m.p.d" }]);
      await registry.stop();
      expect(registry.get("t")!.write).toEqual(["m.p.d"]);
      expect(logs.filter((l) => l === "WARN datanotes token could not follow a renamed table")).toHaveLength(3);
    } finally {
      setTelemetry(NOOP_TELEMETRY);
    }
  });

  it("skips registry entries that are not objects: a rename leaves no rejection, the others follow and are saved", async () => {
    const logs: string[] = [];
    setTelemetry({ log: (severity, body) => void logs.push(`${severity} ${body}`), flush: async () => {} });
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => void rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const v = createDbVault({ [METASTORE]: YAML });
      v.write("store:tokens.json", JSON.stringify([1, "x", null, [], token("t", { write: ["m.p.a"] }, "")]));
      const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
      await registry.load();
      registry.followTableMoves("20261101T100000-a", [{ from: "m.p.a", to: "m.p.b" }]);
      expect(await registry.takeFollowed(["20261101T100000-a"])).toEqual([{ token: "t", from: "m.p.a", to: "m.p.b", permissions: ["write"] }]);
      await registry.stop();
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
      expect(read(v).map((t) => [t.name, t.write, t.movesThrough])).toEqual([["t", ["m.p.b"], "20261101T100000-a"]]);
      expect(logs).toContain("WARN datanotes skipped token registry entries that are not objects");
    } finally {
      process.off("unhandledRejection", onRejection);
      setTelemetry(NOOP_TELEMETRY);
    }
  });

  it("answers no token, and logs why, when following a rename fails anyway", async () => {
    const logs: string[] = [];
    // a log sink that fails on the line of a followed token: the follow itself fails
    setTelemetry({ log: (severity, body) => {
      if (body === "datanotes token followed a renamed table") throw new Error("sink down");
      logs.push(`${severity} ${body}`);
    }, flush: async () => {} });
    try {
      const v = vault([token("t", { write: ["m.p.a"] }, "")], []);
      const registry = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
      registry.followTableMoves("20261101T100000-a", [{ from: "m.p.a", to: "m.p.b" }]);
      expect(await registry.takeFollowed(["20261101T100000-a"])).toEqual([]);
      await registry.stop();
      expect(logs).toContain("WARN datanotes tokens could not follow a renamed table");
    } finally {
      setTelemetry(NOOP_TELEMETRY);
    }
  });

  it("keeps serving when the journal cannot be read: logs it and follows nothing", async () => {
    const logs: string[] = [];
    setTelemetry({ log: (severity, body) => void logs.push(`${severity} ${body}`), flush: async () => {} });
    try {
      const v = vault([token("t", { write: ["m.p.a"] }, "")], [line("20261101T100000-a", "m.p.a", "m.p.b")]);
      const registry = new TokenRegistry({ app: v.app, getSettings: () => { throw new Error("no settings"); } });
      await registry.load();
      expect(registry.get("t")!.write).toEqual(["m.p.a"]);
      expect(logs).toContain("WARN datanotes could not catch up with the renamed tables");
      // where the journal stands is unknown: a token created now gets its mark at the next start
      await registry.create({ name: "late", write: [] });
      expect(registry.get("late")).not.toHaveProperty("movesThrough");
      await registry.stop();
    } finally {
      setTelemetry(NOOP_TELEMETRY);
    }
  });
});
