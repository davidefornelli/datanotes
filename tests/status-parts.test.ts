/**
 * The pieces of `datanotes status` on their own: the journal's recent activity, the hand edits the
 * change feed recorded, the report the route builds (`engineStatus`) in the cases a running
 * service rarely shows, the command's arguments and its text for a person.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChangeFeed, type ChangeEvent } from "../src/core/change-feed";
import { journalActivity } from "../src/core/journal";
import { engineStatus, type EngineStatus, type StatusInput } from "../src/server/status";
import { formatStatus, formatUptime, main, parseStatusArgs, type OfflineReport } from "../src/node/status";
import { help } from "../src/node/help";
import { logVault, type DbVault } from "./helpers/db-vault";

function storeFile(v: DbVault, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(v.abs(rel)), { recursive: true });
  fs.writeFileSync(v.abs(rel), text);
}

const migration = (id: string, at: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "migration", migration_id: id, op: "insert_row", summary: `insert ${id}`, executed_at: at, rows: [], creates: [], moves: [], references: [], failed: [], ...extra });

describe("journalActivity", () => {
  it("counts the operations of the window and names the newest, reading the newest months first", async () => {
    const v = logVault();
    const since = Date.parse("2026-10-08T12:00:00Z");
    expect(await journalActivity(v.app, v.settings, since)).toEqual({ recent: 0, last: null });
    storeFile(v, "store:journal/2026-10.jsonl", [migration("a", "2026-10-08T08:00:00.000Z"), migration("b", "2026-10-09T08:00:00.000Z", { actor: { harness: "claude-code", model: "opus" } }), JSON.stringify({ type: "undone", migration_id: "a", undone_by: "c", at: "x" })].join("\n"));
    storeFile(v, "store:journal/2026-09.jsonl", migration("old", "2026-09-30T08:00:00.000Z"));
    storeFile(v, "store:journal/undated.jsonl", migration("u", "2026-10-09T09:00:00.000Z"));
    // the undated file is read last: September holds nothing recent, so the reading stops there
    expect(await journalActivity(v.app, v.settings, since)).toEqual({ recent: 1, last: { migration_id: "b", op: "insert_row", summary: "insert b", executed_at: "2026-10-09T08:00:00.000Z", by: "claude-code / opus" } });
    // with nothing in the window yet, every month is read until one holds the newest
    fs.rmSync(v.abs("store:journal/2026-10.jsonl"));
    fs.rmSync(v.abs("store:journal/2026-09.jsonl"));
    expect(await journalActivity(v.app, v.settings, since)).toMatchObject({ recent: 1, last: { migration_id: "u" } });
    expect((await journalActivity(v.app, v.settings, Date.parse("2027-01-01"))).last).not.toHaveProperty("by");
  });
});

describe("ChangeFeed.handEditViolations", () => {
  it("counts the hand edits of the window and the rows they leave broken, newest first", async () => {
    const v = logVault();
    const ev = (seq: number, at: string, e: Partial<ChangeEvent>): string => JSON.stringify({ seq, at, table: "main.public.log", op: "update", path: "a.md", source: "external", ...e });
    const viol = (n: number) => Array.from({ length: n }, (_, i) => ({ path: "x.md", code: "required" as const, column: "kind", message: `broken ${i}` }));
    storeFile(v, "store:changes/2026-10-07.jsonl", ev(1, "2026-10-07T10:00:00Z", { path: "old.md", violations: viol(1) }));
    storeFile(v, "store:changes/notes.jsonl", ev(2, "2026-10-09T10:00:00Z", { path: "stray.md", violations: viol(1) }));
    storeFile(
      v,
      "store:changes/2026-10-08.jsonl",
      [
        ev(3, "2026-10-08T01:00:00Z", { path: "early.md", violations: viol(1) }), // before the window, same day
        ev(4, "2026-10-08T13:00:00Z", { path: "a.md", violations: viol(2) }),
        ev(5, "2026-10-08T14:00:00Z", { path: "b.md", violations: viol(1) }),
        ev(6, "2026-10-08T14:30:00Z", { op: "tool_call", path: "", table: null, source: "engine" }),
        "",
      ].join("\n"),
    );
    storeFile(
      v,
      "store:changes/2026-10-09.jsonl",
      [
        ev(7, "2026-10-09T08:00:00Z", { path: "b2.md", oldPath: "b.md", source: "engine" }), // the engine moved b.md: its edit no longer counts
        ev(8, "2026-10-09T09:00:00Z", { path: "c.md", violations: [] }),
        ev(9, "2026-10-09T09:30:00Z", { path: "Datanotes/metastore.yaml", op: "schema", table: null, violations: viol(100), violationsTotal: 140 }),
        ev(10, "2026-10-09T09:40:00Z", { path: "d.md" }),
      ].join("\n"),
    );
    const feed = new ChangeFeed(v.app, () => v.settings);
    const r = await feed.handEditViolations(Date.parse("2026-10-08T12:00:00Z"));
    expect(r).toEqual({
      edits: 5,
      rows: 2,
      violations: 142,
      latest: [
        { path: "Datanotes/metastore.yaml", table: null, at: "2026-10-09T09:30:00Z", seq: 9, violations: 140, message: "broken 0" },
        { path: "a.md", table: "main.public.log", at: "2026-10-08T13:00:00Z", seq: 4, violations: 2, message: "broken 0" },
      ],
    });
    expect((await feed.handEditViolations(Date.parse("2026-10-08T12:00:00Z"), 1)).latest).toHaveLength(1);
  });
});

function input(v: DbVault, over: Partial<StatusInput> = {}): StatusInput {
  return {
    app: v.app,
    settings: v.settings,
    version: "9.9.9",
    startedAt: new Date("2026-10-09T10:00:00Z"),
    now: new Date("2026-10-09T10:00:00Z"),
    http: { host: "127.0.0.1", port: 1234 },
    feed: null,
    feedProblem: null,
    webhooks: null,
    tokens: [],
    host: null,
    telemetryEndpoint: null,
    ...over,
  };
}

describe("engineStatus", () => {
  it("without a host, a feed or a metastore: what it can say", async () => {
    const v = logVault();
    v.remove("Datanotes/metastore.yaml");
    const s = await engineStatus(input(v, { now: undefined, startedAt: new Date(Date.now() + 60_000) }));
    expect(s.engine).toMatchObject({ pid: null, host_name: null, watch: null, vault: null, settings_file: null, uptime_s: 0 });
    expect(s.database).toMatchObject({ readable: false, error: "not found (no tables yet)", tables: 0, views: 0, history_tables: 0 });
    expect(s.change_feed).toEqual({ running: false, reason: "not started", head: null });
    expect(s.hand_edits).toEqual({ window_hours: 24, checked: false, reason: "the change feed is not running" });
    expect(s.problems).toEqual(["change feed not running: not started"]);
    expect(s.git_sync).toBeNull();
    expect(s.webhooks).toEqual({ count: 0, failing: [] });
  });

  it("reads the stored webhooks when the dispatcher is not running, and shows only their host", async () => {
    const v = logVault();
    const hook = { secret: "hook-secret", enabled: true, cursor: 3, createdAt: "x" };
    storeFile(
      v,
      "store:webhooks.json",
      JSON.stringify([
        { ...hook, id: "wh_a", url: "https://user:pw@hooks.example.com/path?key=1", failures: 2, lastError: "HTTP 500", lastDelivery: "2026-10-09T09:00:00Z" },
        { ...hook, id: "wh_b", url: "http://", failures: 1 },
        { ...hook, id: "wh_c", url: "https://ok.example.com", failures: 0 },
      ]),
    );
    const s = await engineStatus(input(v, { telemetryEndpoint: "https://collector.example.com:4318/v1?x=1" }));
    expect(s.webhooks).toEqual({
      count: 3,
      failing: [
        { id: "wh_a", url_host: "hooks.example.com", failures: 2, last_error: "HTTP 500", last_delivery: "2026-10-09T09:00:00Z", cursor: 3 },
        { id: "wh_b", url_host: "(invalid URL)", failures: 1, cursor: 3 },
      ],
    });
    expect(s.problems).toContain("webhook wh_b ((invalid URL)) failing: no answer");
    expect(s.logs).toEqual({ folder: "store:logs", console_log: null, telemetry: "https://collector.example.com:4318" });
    expect(JSON.stringify(s)).not.toMatch(/hook-secret|pw@|key=1/);
    // a store file that cannot be read lists none
    storeFile(v, "store:webhooks.json", "{ not json");
    expect((await engineStatus(input(v, { telemetryEndpoint: "not a url" }))).logs.telemetry).toBe("(invalid URL)");
    expect((await engineStatus(input(v))).webhooks.count).toBe(0);
  });

  it("a metastore that cannot be read, a feed problem, a hand-edit check that fails, git sync off or stopped", async () => {
    const v = logVault();
    v.write("Datanotes/metastore.yaml", "catalogs: [\n");
    const s = await engineStatus(input(v, { feedProblem: "metastore.yaml cannot be read: bad", host: { git: { enabled: false, pendingOperations: 2 } } }));
    expect(s.database.readable).toBe(false);
    expect(s.database.error).toMatch(/^cannot be read: /);
    expect(s.problems[0]).toMatch(/^metastore\.yaml cannot be read: /);
    expect(s.change_feed.reason).toBe("metastore.yaml cannot be read: bad");
    expect(s.git_sync).toEqual({ enabled: false, pending_operations: 2 });
    const feed = { lastSeq: 7, handEditViolations: async () => Promise.reject(new Error("disk gone")) } as unknown as ChangeFeed;
    const t = await engineStatus(input(logVault(), { feed }));
    expect(t.hand_edits).toEqual({ window_hours: 24, checked: false, reason: "disk gone" });
    expect(t.change_feed).toEqual({ running: true, head: 7 });
    expect(t.healthy).toBe(true);
    const one = { lastSeq: 1, handEditViolations: async () => ({ edits: 1, rows: 1, violations: 1, latest: [] }) } as unknown as ChangeFeed;
    expect((await engineStatus(input(logVault(), { feed: one }))).problems).toEqual(["1 row edited by hand breaks the tables' rules (1 violation)"]);
    const two = { lastSeq: 1, handEditViolations: async () => ({ edits: 2, rows: 2, violations: 3, latest: [] }) } as unknown as ChangeFeed;
    const host = { git: { enabled: true, repo: "/r", lastRun: "a", lastCommit: "b", lastPush: "c", pendingOperations: 0 } };
    const both = await engineStatus(input(logVault(), { feed: two, host }));
    expect(both.problems).toEqual(["2 rows edited by hand break the tables' rules (3 violations)"]);
    expect(both.git_sync).toEqual({ enabled: true, repo: "/r", last_run_at: "a", last_commit: "b", last_push_at: "c", pending_operations: 0 });
    const backedUp = { storeBackup: { enabled: true, every: 60, remote: "r", lastCommit: "abc", lastCommitAt: "t1", lastPush: "t2", pendingOperations: 0, pendingCommits: 0 } };
    expect((await engineStatus(input(logVault(), { host: backedUp }))).store_backup).toEqual({ enabled: true, interval_s: 60, remote: "r", last_commit: "abc", last_commit_at: "t1", last_push_at: "t2", pending_operations: 0, pending_commits: 0 });
    const fresh = { storeBackup: { enabled: true, every: 60, remote: null, pendingOperations: 1, pendingCommits: 0 } };
    expect((await engineStatus(input(logVault(), { host: fresh }))).store_backup).toEqual({ enabled: true, interval_s: 60, remote: null, pending_operations: 1, pending_commits: 0 });
    // a failure a person must fix: a problem, with the hint and the docs of the fix
    const failing = {
      storeBackup: { enabled: true, every: 60, remote: "r", pendingOperations: 0, pendingCommits: 1, lastError: "a file is over 95 MB", nextRetry: "t3", hint: "Make the file smaller", docs: "https://datanotes.dev/x.md#y" },
    };
    const st = await engineStatus(input(logVault(), { host: failing }));
    expect(st.problems).toContain("store backup failing: a file is over 95 MB");
    expect(st.store_backup).toEqual({
      enabled: true,
      interval_s: 60,
      remote: "r",
      pending_operations: 0,
      pending_commits: 1,
      last_error: "a file is over 95 MB",
      next_retry_at: "t3",
      hint: "Make the file smaller",
      docs: "https://datanotes.dev/x.md#y",
    });
  });
});

describe("datanotes status: arguments", () => {
  it("the vault from the command line or the environment; --url and --token instead of a vault", () => {
    expect(parseStatusArgs(["--vault", "/v", "--json"], {})).toEqual({ vault: path.resolve("/v"), json: true });
    expect(parseStatusArgs(["--settings", "s.json"], { DATANOTES_VAULT: "/env" })).toEqual({ vault: path.resolve("/env"), settingsFile: path.resolve("s.json"), json: false });
    expect(parseStatusArgs([], { DATANOTES_VAULT: "/env", DATANOTES_SETTINGS: "/etc/s.json" }).settingsFile).toBe(path.resolve("/etc/s.json"));
    expect(parseStatusArgs(["--url", "http://h:1/", "--token", "t"], {})).toEqual({ url: "http://h:1", token: "t", json: false });
    expect(parseStatusArgs([], { DATANOTES_URL: "http://h:2", DATANOTES_TOKEN: "t2" })).toEqual({ url: "http://h:2", token: "t2", json: false });
    expect(() => parseStatusArgs([], {})).toThrow(/--vault/);
    expect(() => parseStatusArgs(["--url", "http://h:1"], {})).toThrow(/--token/);
  });

  it("--help documents the command, its options and its exit codes", () => {
    const text = help("3.0.0");
    for (const s of ["datanotes status --database", "--url <url> --token <token>", "--json", "Exit codes: 0 healthy", "2 no engine running"]) expect(text).toContain(s);
  });

  it("prints to standard output by default", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const v = logVault();
    expect(await main(["--vault", v.root], { env: {} })).toBe(2);
    expect(String(write.mock.calls[0]![0])).toMatch(/^datanotes status: not running\n/);
    write.mockRestore();
  });

  it("uptime in a short form", () => {
    expect([formatUptime(5), formatUptime(125), formatUptime(3725), formatUptime(2 * 86400 + 7200)]).toEqual(["5s", "2m", "1h 2m", "2d 2h"]);
  });
});

const BASE: EngineStatus = {
  healthy: true,
  problems: [],
  engine: { version: "3.0.0", pid: 42, host_name: "box", started_at: "2026-10-09T08:00:00Z", uptime_s: 3725, http: { host: "127.0.0.1", port: 27150 }, watch: "events", vault: "/v", settings_file: "/s/0192/settings.json", store: "/s/0192", database_id: "0192e000-0000-7000-8000-000000000001", database_folder: "Datanotes" },
  database: { metastore: "Datanotes/metastore.yaml", readable: true, tables: 3, views: 1, history_tables: 1, journal: { window_hours: 24, operations: 1, last: { migration_id: "m", op: "insert_row", summary: "s", executed_at: "2026-10-09T09:00:00Z", by: "claude-code" } } },
  git_sync: null,
  store_backup: null,
  change_feed: { running: true, head: 12 },
  webhooks: { count: 0, failing: [] },
  tokens: [],
  hand_edits: { window_hours: 24, checked: true, edits: 0, rows: 0, violations: 0, latest: [] },
  logs: { folder: null, console_log: null, telemetry: null },
};

describe("datanotes status: the text for a person", () => {
  const text = (over: Partial<EngineStatus>) => formatStatus({ running: true, url: "http://127.0.0.1:27150", ...BASE, ...over });

  it("a healthy engine", () => {
    expect(text({})).toBe(
      [
        "datanotes status: healthy",
        "engine     3.0.0, pid 42 on box, up 1h 2m, http://127.0.0.1:27150, watch events",
        "vault      /v (settings /s/0192/settings.json)",
        "store      /s/0192, database Datanotes (id 0192e000-0000-7000-8000-000000000001)",
        "database   Datanotes/metastore.yaml: 3 tables (1 with history), 1 view",
        "journal    1 operation in the last 24 h; last insert_row at 2026-10-09T09:00:00Z by claude-code",
        "git sync   off",
        "backup     off",
        "changes    feed running, last seq 12",
        "webhooks   0",
        "tokens     owner only",
        "hand edits 0 hand edits in the last 24 h, none breaking the tables' rules",
        "logs       files off",
      ].join("\n"),
    );
  });

  it("every part in its other states", () => {
    const out = text({
      healthy: false,
      problems: ["git sync blocked: x"],
      engine: { ...BASE.engine, pid: null, host_name: null, watch: null, vault: null, settings_file: null, store: null, database_id: null },
      database: { ...BASE.database, moved: { from: "Old", to: "Datanotes", at: "2026-10-09T08:30:00.000Z", by: "hand" }, readable: false, error: "cannot be read: bad", journal: { window_hours: 24, operations: 0, last: null } },
      git_sync: { enabled: true, repo: "/repo", last_commit: "c", last_push_at: "p", pending_operations: 1 },
      store_backup: { enabled: true, interval_s: 60, remote: "https://github.com/me/store.git", last_commit: "abc1234", last_commit_at: "t1", last_push_at: "t2", pending_operations: 2, pending_commits: 1 },
      change_feed: { running: false, reason: "why", head: null },
      webhooks: { count: 2, failing: [{ id: "wh_1", url_host: "h", failures: 1, last_error: "HTTP 500", cursor: 0 }, { id: "wh_2", url_host: "h2", failures: 3, cursor: 0 }] },
      tokens: [
        { name: "bot", write: ["main.*"], ddl: true, maintain: true, last_seen: "2026-10-09T09:30:00Z" },
        { name: "reader", write: [], ddl: false, maintain: false, last_seen: null },
      ],
      hand_edits: { window_hours: 24, checked: true, edits: 3, rows: 2, violations: 3, latest: [{ path: "a.md", table: "main.public.log", at: "t", seq: 1, violations: 2, message: "kind is required" }, { path: "Datanotes/metastore.yaml", table: null, at: "t", seq: 2, violations: 1, message: "m" }] },
      logs: { folder: "store:logs", console_log: "/var/log/dn.log", telemetry: "http://c:4318" },
    });
    expect(out.split("\n")).toEqual([
      "datanotes status: needs attention",
      "engine     3.0.0, pid ? on ?, up 1h 2m, http://127.0.0.1:27150",
      "store      none (in the vault), database Datanotes",
      "database   Datanotes/metastore.yaml: cannot be read: bad",
      "moved      database folder Old -> Datanotes at 2026-10-09T08:30:00.000Z (by hand)",
      "journal    0 operations in the last 24 h",
      "git sync   on, repo /repo, last commit c, last push p, 1 pending operation",
      "backup     on, every 60 s, remote https://github.com/me/store.git, last commit abc1234 at t1, last push t2, 2 pending operations, 1 commit to push",
      "changes    feed NOT RUNNING: why",
      "webhooks   2 (2 failing)",
      "  ! wh_1 h: 1 failed attempt, retried with backoff; last error: HTTP 500",
      "  ! wh_2 h2: 3 failed attempts, retried with backoff",
      "tokens     bot (write main.*, ddl, maintain); reader (read only)",
      "hand edits 3 hand edits in the last 24 h; 2 rows break the tables' rules (3 violations)",
      "  ! a.md (main.public.log): kind is required (+1 more)",
      "  ! Datanotes/metastore.yaml: m",
      "logs       files store:logs, console /var/log/dn.log, telemetry http://c:4318",
      "problems:",
      "  - git sync blocked: x",
    ]);
    expect(text({ engine: { ...BASE.engine, settings_file: null }, hand_edits: { window_hours: 24, checked: true, edits: 1, rows: 1, violations: 1, latest: [] } })).toContain("vault      /v\n");
    expect(text({ hand_edits: { window_hours: 24, checked: true, edits: 1, rows: 1, violations: 1, latest: [] } })).toContain("1 row breaks the tables' rules (1 violation)");
    expect(text({ git_sync: { enabled: false, pending_operations: 0 } })).toContain("git sync   stopped, last commit none, last push none, 0 pending operations");
    expect(text({ git_sync: { enabled: true, blocked: "a rebase", pending_operations: 0 } })).toContain("git sync   BLOCKED: a rebase");
    expect(text({ store_backup: { enabled: true, interval_s: 30, remote: null, pending_operations: 0, pending_commits: 0 } })).toContain("backup     on, every 30 s, remote none (commits only), last commit none, last push none, 0 pending operations, 0 commits to push");
    expect(text({ store_backup: { enabled: false, interval_s: 5, remote: "r", last_commit: "c", pending_operations: 1, pending_commits: 3, last_error: "git push: denied", next_retry_at: "t3" } })).toContain(
      "backup     FAILING, every 5 s, remote r, last commit c, last push none, 1 pending operation, 3 commits to push; last error: git push: denied (retry at t3)",
    );
    expect(text({ store_backup: { enabled: false, interval_s: 60, remote: "r", pending_operations: 0, pending_commits: 0, last_error: "no git" } })).toContain("last error: no git\n");
    // a failure a person must fix: how, and where to read more
    const big = { enabled: true, interval_s: 60, remote: "r", pending_operations: 0, pending_commits: 1, last_error: "a file is over 95 MB", hint: "Make the file smaller", docs: "https://datanotes.dev/x.md#y" };
    expect(text({ store_backup: big })).toContain("last error: a file is over 95 MB; Make the file smaller (https://datanotes.dev/x.md#y)\n");
    const { docs: _docs, ...noDocs } = big;
    expect(text({ store_backup: noDocs })).toContain("last error: a file is over 95 MB; Make the file smaller\n");
    expect(text({ store_backup: { enabled: false, interval_s: 60, remote: "r", pending_operations: 0, pending_commits: 0 } })).toContain("backup     stopped");
    expect(text({ hand_edits: { window_hours: 24, checked: false, reason: "no feed" } })).toContain("hand edits not checked: no feed");
    expect(text({ hand_edits: { window_hours: 24, checked: true, edits: 1, rows: 0, violations: 0 } })).toContain("1 hand edit in the last 24 h, none");
  });

  it("an engine that does not answer the status, and one not running", () => {
    expect(formatStatus({ running: true, url: "http://x", error: "the token was refused" })).toBe("datanotes status: engine at http://x did not answer the status\nerror      the token was refused");
    const off: OfflineReport = {
      running: false,
      reason: "no engine holds the vault (no lock)",
      vault: "/v",
      lock: { state: "none" },
      settings: { file: "/v/s.json", found: true, owner_token_set: true },
      metastore: { path: "/v/m.yaml", found: true, tables: 1 },
      store: { path: "/s/0192", database_id: null },
    };
    expect(formatStatus(off).split("\n")).toEqual([
      "datanotes status: not running",
      "vault      /v",
      "lock       none",
      "store      /s/0192 (database id unknown)",
      "settings   /v/s.json (owner token set)",
      "metastore  /v/m.yaml: 1 table",
      "reason     no engine holds the vault (no lock)",
    ]);
    const lock = { pid: 7, host_name: "box", port: 1, heartbeat: "h" };
    const other = formatStatus({ ...off, vault: null, settings: null, metastore: null, store: null, lock: { state: "fresh", ...lock } });
    expect(other.split("\n")).toEqual(["datanotes status: not running", "lock       held (pid 7 on box, port 1, heartbeat h)", "reason     no engine holds the vault (no lock)"]);
    expect(formatStatus({ ...off, store: { path: "/s/x", database_id: "x-id" }, lock: { state: "stale", ...lock }, settings: { file: "f", found: true, owner_token_set: false }, metastore: { path: "m", found: false } })).toContain(
      "lock       stale (pid 7 on box, port 1, heartbeat h)\nstore      /s/x (database id x-id)\nsettings   f (no owner token yet)\nmetastore  m: not found",
    );
    expect(formatStatus({ ...off, settings: { file: "f", found: false, owner_token_set: false }, metastore: { path: "m", found: true, error: "bad" } })).toContain("settings   f (not found)\nmetastore  m: cannot be read: bad");
  });
});
