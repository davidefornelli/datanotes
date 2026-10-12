/**
 * The change feed at its edges: rows without an id, notes that cannot be read (at start, in a
 * batch of hand edits, after an engine write), listeners, tool calls, change files that cannot be
 * written or are empty, retention gaps, the in-memory window, and the checks of hand edits that
 * cannot run (no metastore, a table that cannot be loaded).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeFeed, wireEvent, wirePage, type ChangeEvent } from "../src/core/change-feed";
import { INDEX_RETRY, notifyApplied } from "../src/core/engine";
import type { TFile } from "../src/core/host";
import { insertRow } from "../src/core/rows";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { createDbVault, LOG_DIR, logVault, LOG_YAML, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;
afterEach(() => {
  setTelemetry(NOOP_TELEMETRY);
  vi.useRealTimers();
});

const A = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: alcohol\noccurred_at: 2026-09-25T22:30\nmetric_drinks: 7\n---\nA\n";
const R_ROW = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-0000000000d1\nkind: walk\noccurred_at: 2026-09-27T10:00\n---\n";
const B = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: mood\noccurred_at: 2026-09-26T08:00\n---\nB\n";

/** WARN lines the engine logs, by message. */
function captureLogs(): { body: string; attrs: Record<string, unknown> }[] {
  const logs: { body: string; attrs: Record<string, unknown> }[] = [];
  setTelemetry({ log: (_s, body, attrs = {}) => logs.push({ body, attrs }), flush: async () => {} });
  return logs;
}

/** Reads of these paths fail as when another program holds the file (EBUSY). */
function lockReads(v: DbVault): Set<string> {
  const locked = new Set<string>();
  const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
  const read = vault.read.bind(vault);
  vault.read = async (f) => {
    if (locked.has(f.path)) throw new Error(`EBUSY: resource busy or locked, open '${f.path}'`);
    return read(f);
  };
  return locked;
}

/** A rename as the vault does it; the feed hears of it from the host's event, or from us. */
async function rename(v: DbVault, feed: ChangeFeed, from: string, to: string): Promise<void> {
  if (!(await v.rename(from, to))) feed.moved(from, to);
}

function write(v: DbVault, feed: ChangeFeed, path: string, text: string): void {
  v.write(path, text);
  feed.touch(path);
}

const brief = (events: ChangeEvent[]) =>
  events.map((e) => ({
    op: e.op,
    path: e.path,
    table: e.table,
    source: e.source,
    ...(e.oldPath ? { oldPath: e.oldPath } : {}),
    ...(e.id ? { id: e.id } : {}),
    ...(e.violations ? { violations: e.violations } : {}),
  }));

describe("rows without an id", () => {
  const WALK = `walk:
  options:
    filename: "{name}"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: name, type: string }
`;
  const N = "---\ntable: main.public.log\nkind: walk\noccurred_at: 2026-09-27T10:00\n---\nN\n";

  it("are followed by path: an edit, a rename, a move to another table and to its archive", async () => {
    const v = createDbVault({ [METASTORE]: withTables(WALK), "Notes/n.md": N });
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    write(v, feed, "Notes/n.md", N.replace("kind: walk", "kind: mood"));
    await feed.flush();
    await rename(v, feed, "Notes/n.md", "Notes/m.md");
    await feed.flush();
    write(v, feed, "Notes/m.md", "---\ntable: main.public.walk\nname: Park\n---\nN\n");
    await feed.flush();
    await rename(v, feed, "Notes/m.md", "Datanotes/main/public/walk/_archive/m.md");
    await feed.flush();
    const { events } = await feed.read();
    expect(brief(events)).toEqual([
      { op: "update", path: "Notes/n.md", table: "main.public.log", source: "external", violations: [] },
      { op: "move", path: "Notes/m.md", oldPath: "Notes/n.md", table: "main.public.log", source: "external", violations: [] },
      { op: "delete", path: "Notes/m.md", table: "main.public.log", source: "external" },
      { op: "insert", path: "Notes/m.md", table: "main.public.walk", source: "external", violations: [] },
      { op: "delete", path: "Notes/m.md", table: "main.public.walk", source: "external", violations: [] },
    ]);
    expect(events[0]!.changes).toEqual({ kind: { before: "walk", after: "mood" } });
    expect(events[3]!.changes).toEqual({ name: { after: "Park" } });
    expect(events[4]!.row).toEqual({ name: "Park" });
    await feed.stop();
  });
});

describe("notes that cannot be read", () => {
  it("at start: skipped with a WARN, then compared as new on their next change", async () => {
    const logs = captureLogs();
    const v = logVault();
    const locked = lockReads(v);
    locked.add("Daily/a.md");
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    expect(logs.filter((l) => l.body === "datanotes change feed could not read a note")).toEqual([
      { body: "datanotes change feed could not read a note", attrs: { path: "Daily/a.md", error: "EBUSY: resource busy or locked, open 'Daily/a.md'" } },
    ]);
    locked.clear();
    write(v, feed, "Daily/a.md", A.replace("metric_drinks: 7", "metric_drinks: 8"));
    await feed.flush();
    expect(brief((await feed.read()).events)).toEqual([
      { op: "insert", path: "Daily/a.md", table: "main.public.log", source: "external", id: "01a0f000-0000-7000-8000-00000000000a", violations: [] },
    ]);
    await feed.stop();
  });

  it("in a batch: a rename whose new path cannot be read is skipped with a WARN naming both paths", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const logs = captureLogs();
    const locked = lockReads(v);
    write(v, feed, "Daily/a.md", A.replace("metric_drinks: 7", "metric_drinks: 2"));
    await rename(v, feed, "Daily/b.md", "Daily/c.md");
    locked.add("Daily/c.md");
    await feed.flush();
    expect(logs.filter((l) => l.body.startsWith("datanotes change feed"))).toEqual([
      {
        body: "datanotes change feed could not read a hand-edited note",
        attrs: { path: "Daily/c.md", old_path: "Daily/b.md", error: "EBUSY: resource busy or locked, open 'Daily/c.md'" },
      },
    ]);
    expect(brief((await feed.read()).events)).toEqual([
      { op: "update", path: "Daily/a.md", table: "main.public.log", source: "external", id: "01a0f000-0000-7000-8000-00000000000a", violations: [] },
    ]);
    await feed.stop();
  });

  it("in a batch: a note removed while the created one cannot be read is a delete, the other a WARN", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const logs = captureLogs();
    const locked = lockReads(v);
    // a rename seen as a delete, then a create (git, a sync tool): the created note is locked
    v.remove("Daily/b.md");
    feed.touch("Daily/b.md");
    locked.add("Daily/d.md");
    write(v, feed, "Daily/d.md", B);
    await feed.flush();
    expect(logs.filter((l) => l.body.startsWith("datanotes change feed")).map((l) => l.attrs)).toEqual([
      { path: "Daily/d.md", error: "EBUSY: resource busy or locked, open 'Daily/d.md'" },
    ]);
    expect(brief((await feed.read()).events)).toEqual([
      { op: "delete", path: "Daily/b.md", table: "main.public.log", source: "external", id: "01a0f000-0000-7000-8000-00000000000b", violations: [] },
    ]);
    // readable again: the next change of it is compared, the same row back
    locked.clear();
    write(v, feed, "Daily/d.md", B.replace("B\n", "B again\n").replace("kind: mood", "kind: walk"));
    await feed.flush();
    expect(brief((await feed.read({ since: 1 })).events)).toEqual([
      { op: "insert", path: "Daily/d.md", table: "main.public.log", source: "external", id: "01a0f000-0000-7000-8000-00000000000b", violations: [] },
    ]);
    await feed.stop();
  });

  it("after an engine write: the change is not recorded, a WARN says so", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const logs = captureLogs();
    const path = `${LOG_DIR}/2026/09/28/2026-09-28 walk.md`;
    lockReads(v).add(path);
    const r = await insertRow(v.app, v.settings, { table: "log", values: { kind: "walk", occurred_at: "2026-09-28T09:00" } });
    expect(r.planned_creates).toEqual([path]);
    await feed.flush();
    expect((await feed.read()).events).toEqual([]);
    expect(logs.filter((l) => l.body === "datanotes change feed could not record a change")).toEqual([
      { body: "datanotes change feed could not record a change", attrs: { error: `EBUSY: resource busy or locked, open '${path}'` } },
    ]);
    await feed.stop();
  });
});

describe("listeners and tool calls", () => {
  it("every listener hears each event; one that throws does not stop the others; unsubscribed ones hear nothing", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const heard: number[] = [];
    const late: number[] = [];
    feed.onEvent(() => {
      throw new Error("listener bug");
    });
    feed.onEvent((e) => heard.push(e.seq));
    const off = feed.onEvent((e) => late.push(e.seq));
    const call = { tool: "select_rows", args: { table: "log" }, ok: true, durationMs: 3, value: { rows: 2 }, servedBy: "engine" };
    await feed.recordToolCall(call, { harness: "claude-code" });
    expect(off()).toBe(true);
    await feed.recordToolCall({ ...call, ok: false, value: "table not found" });
    expect([heard, late]).toEqual([[1, 2], [1]]);
    // tool calls are their own stream: only for consumers that ask for them
    expect((await feed.read()).events).toEqual([]);
    const { events } = await feed.read({ ops: ["tool_call"] });
    expect(events.map((e) => [e.seq, e.op, e.table, e.path, e.actor ?? null, e.call?.ok])).toEqual([
      [1, "tool_call", null, "", { harness: "claude-code" }, true],
      [2, "tool_call", null, "", null, false],
    ]);
    await feed.stop();
  });

  it("records nothing once stopped: tool calls, edits and renames", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    await feed.stop();
    await feed.recordToolCall({ tool: "list_tables", args: {}, ok: true, durationMs: 1, value: [], servedBy: "engine" });
    v.write("Daily/a.md", A.replace("metric_drinks: 7", "metric_drinks: 1"));
    feed.touch("Daily/a.md");
    feed.moved("Daily/b.md", "Daily/c.md");
    await feed.flush();
    expect(await feed.read({ ops: ["tool_call", "update", "move"] })).toEqual({ events: [], last: 0, head: 0 });
    await feed.stop();
  });
});

describe("change files", () => {
  const call = (n: number) => ({ tool: "select_rows", args: { n }, ok: true, durationMs: 1, value: null, servedBy: "engine" });
  const changes = "store:changes";

  it("while the change files cannot be written, the newest 10 000 events are served from memory", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const adapter = v.app.store! as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const full = () => Promise.reject(new Error("ENOSPC: no space left on device"));
    vi.spyOn(adapter, "exists").mockResolvedValue(true);
    vi.spyOn(adapter, "write").mockImplementation(full);
    vi.spyOn(adapter, "append").mockImplementation(full);
    for (let i = 1; i <= 10_001; i++) void feed.recordToolCall(call(i));
    await feed.flush();
    vi.restoreAllMocks();
    expect(feed.lastSeq).toBe(10_001);
    expect((await feed.read({ ops: ["tool_call"], since: 9_999 })).events.map((e) => e.seq)).toEqual([10_000, 10_001]);
    expect((await feed.read({ ops: ["tool_call"], since: 1, limit: 2 })).events.map((e) => e.seq)).toEqual([2, 3]);
    // the oldest left memory and was never written: a read from the start finds the files empty
    expect((await feed.read({ ops: ["tool_call"], since: 0 })).events).toEqual([]);
    expect(v.listAll().filter((p) => p.startsWith(changes))).toEqual([]);
    await feed.stop();
    // nothing was kept: a restart numbers from the start again
    const again = new ChangeFeed(v.app, () => v.settings);
    await again.start();
    expect(again.lastSeq).toBe(0);
    await again.stop();
  }, 20_000); // 10 001 events: slow under a full parallel run

  it("a torn last line (a stop by force during an append) is skipped, and the next event starts on a line of its own", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    await feed.recordToolCall(call(1));
    await feed.recordToolCall(call(2));
    await feed.stop();
    const file = v.listAll().find((p) => p.startsWith(changes))!;
    v.write(file, `${v.read(file)}{"seq":3,"at":"2026-10-10T08:00`);
    const again = new ChangeFeed(v.app, () => v.settings);
    await again.start();
    expect(again.lastSeq).toBe(2);
    await again.recordToolCall(call(3));
    expect(v.read(file).split("\n").filter(Boolean)).toHaveLength(4); // the torn line, then event 3 on its own
    expect((await again.read({ ops: ["tool_call"], since: 0 })).events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await again.handEditViolations(0)).toMatchObject({ edits: 0 });
    await again.stop();
    // read back from the files by a fresh feed
    const third = new ChangeFeed(v.app, () => v.settings);
    await third.start();
    expect(third.lastSeq).toBe(3);
    expect((await third.read({ ops: ["tool_call"], since: 0 })).events.map((e) => e.seq)).toEqual([1, 2, 3]);
    await third.stop();
  });

  it("a restart skips an empty change file (a crash after creating it)", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    await feed.recordToolCall(call(1));
    await feed.recordToolCall(call(2));
    await feed.stop();
    v.write(`${changes}/2099-12-31.jsonl`, "\n");
    const again = new ChangeFeed(v.app, () => v.settings);
    await again.start();
    expect(again.lastSeq).toBe(2);
    await again.recordToolCall(call(3));
    expect((await again.read({ ops: ["tool_call"], since: 2 })).events.map((e) => e.seq)).toEqual([3]);
    // older events are read back from the files
    expect((await again.read({ ops: ["tool_call"], since: 0 })).events.map((e) => e.seq)).toEqual([1, 2, 3]);
    await again.stop();
  });

  it("an empty oldest change file: every earlier sequence number is a gap", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    await feed.recordToolCall(call(1));
    await feed.recordToolCall(call(2));
    await feed.stop();
    v.write(`${changes}/2000-01-01.jsonl`, "");
    const again = new ChangeFeed(v.app, () => v.settings);
    await again.start();
    expect(await again.read({ since: 1, ops: ["tool_call"] })).toMatchObject({ last: 2, head: 2, gap: true });
    await again.stop();
  });

  it("reports a gap when the events after `since` were dropped by retention", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2020-01-01T10:00:00Z") });
    await feed.recordToolCall(call(1));
    await feed.recordToolCall(call(2));
    vi.useRealTimers();
    await feed.recordToolCall(call(3));
    expect(await feed.prune()).toBe(1);
    await feed.stop();
    const again = new ChangeFeed(v.app, () => v.settings);
    await again.start();
    const page = await again.read({ since: 1, ops: ["tool_call"] });
    expect([page.events.map((e) => e.seq), page.last, page.head, page.gap]).toEqual([[3], 3, 3, true]);
    expect((await again.read({ since: 2, ops: ["tool_call"] })).gap).toBeUndefined();
    await again.stop();
  });
});

describe("checks of hand edits that cannot run", () => {
  it("with metastore.yaml gone, an edited row is no row any more: a delete with nothing to check", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    v.remove(METASTORE);
    feed.touch(METASTORE);
    write(v, feed, "Daily/a.md", A.replace("metric_drinks: 7", "metric_drinks: 3"));
    await feed.flush();
    expect(brief((await feed.read()).events)).toEqual([
      { op: "schema", path: METASTORE, table: null, source: "external" },
      { op: "delete", path: "Daily/a.md", table: "main.public.log", source: "external", id: "01a0f000-0000-7000-8000-00000000000a", violations: [] },
    ]);
    // put back: the row is a row again
    write(v, feed, METASTORE, LOG_YAML);
    await feed.flush();
    write(v, feed, "Daily/a.md", A);
    await feed.flush();
    expect(brief((await feed.read({ since: 2 })).events).map((e) => [e.op, e.path])).toEqual([
      ["schema", METASTORE],
      ["insert", "Daily/a.md"],
    ]);
    await feed.stop();
  });

  const BROKEN = `broken:
  options:
    filename: "{a}"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: a, type: string }
    - { name: b, type: string, generated: "{nope}" }
`;
  const R = "---\ntable: main.public.broken\nid: 01a0f000-0000-7000-8000-0000000000c1\na: one\n---\n";

  it("a row of a table that cannot be loaded: the event has no violations, a WARN says why", async () => {
    const v = createDbVault({ [METASTORE]: withTables(BROKEN), "Notes/r.md": R });
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const logs = captureLogs();
    write(v, feed, "Notes/r.md", R.replace("a: one", "a: two"));
    await feed.flush();
    expect(brief((await feed.read()).events)).toEqual([
      { op: "update", path: "Notes/r.md", table: "main.public.broken", source: "external", id: "01a0f000-0000-7000-8000-0000000000c1" },
    ]);
    expect(logs.filter((l) => l.body === "datanotes could not check hand edits").map((l) => l.attrs)).toEqual([
      { rows: 1, error: expect.stringContaining(`unknown column "nope"`) },
    ]);
    await feed.stop();
  });

  it("metastore.yaml edited by hand into a table that cannot be loaded: no violations on the schema event, a WARN per table", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const logs = captureLogs();
    write(v, feed, METASTORE, withTables(BROKEN));
    await feed.flush();
    expect(brief((await feed.read()).events)).toEqual([{ op: "schema", path: METASTORE, table: null, source: "external" }]);
    expect(logs.filter((l) => l.body === "datanotes could not check a table changed by hand").map((l) => l.attrs)).toEqual([
      { table: "main.public.broken", error: expect.stringContaining(`unknown column "nope"`) },
    ]);
    await feed.stop();
  });
});

describe("events as callers see them", () => {
  it("carry the count of every violation, the hand moves an engine write follows, and a retention gap", () => {
    const ev: ChangeEvent = {
      seq: 7,
      at: "2026-10-01T08:00:00.000Z",
      table: "main.public.log",
      op: "update",
      path: "Daily/a.md",
      source: "engine",
      operation: "repair_links",
      violations: [{ path: "Daily/a.md", code: "required", column: "kind", message: "is required" }],
      violationsTotal: 120,
      cause: [
        { path: "Daily/c.md", oldPath: "Daily/b.md", seq: 5 },
        { path: "Notes/d.md", oldPath: "Notes/old.md" },
      ],
    };
    expect(wireEvent(ev)).toMatchObject({
      violations: [{ path: "Daily/a.md", violations: [{ code: "required", column: "kind", message: "is required" }] }],
      violations_total: 120,
      cause: [
        { path: "Daily/c.md", old_path: "Daily/b.md", seq: 5 },
        { path: "Notes/d.md", old_path: "Notes/old.md" },
      ],
    });
    expect(wirePage({ events: [ev], last: 7, head: 9, gap: true })).toMatchObject({ last: 7, head: 9, gap: true });
    expect(wirePage({ events: [], last: 7, head: 9 })).toEqual({ events: [], last: 7, head: 9 });
  });

  it("an update an older version wrote without its changes matches no column filter", async () => {
    const v = logVault();
    const old = { seq: 1, at: "2026-01-01T08:00:00.000Z", table: "main.public.log", op: "update", path: "Daily/a.md", source: "external" };
    v.write("store:changes/2026-01-01.jsonl", `${JSON.stringify(old)}\n`);
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    expect((await feed.read({ columns: ["kind"] })).events).toEqual([]);
    expect((await feed.read()).events.map((e) => e.seq)).toEqual([1]);
    await feed.stop();
  });

  it("an engine write without a journal entry has no migration_id", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    v.write("Daily/a.md", A.replace("metric_drinks: 7", "metric_drinks: 1"));
    notifyApplied(v.app, { op: "custom", summary: "a write of a plugin", paths: ["Daily/a.md"], moves: [], deletes: [] });
    await feed.flush();
    const [ev] = (await feed.read()).events;
    expect(ev).toMatchObject({ op: "update", source: "engine", operation: "custom", changes: { metric_drinks: { before: 7, after: 1 } } });
    expect(ev).not.toHaveProperty("migration");
    await feed.stop();
  });
});

describe("the feed's own files", () => {
  it("row paths that cannot be saved are a WARN", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const logs = captureLogs();
    const adapter = v.app.store! as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    vi.spyOn(adapter, "write").mockRejectedValue(new Error("ENOSPC: no space left on device"));
    await feed.stop();
    vi.restoreAllMocks();
    expect(logs.filter((l) => l.body === "datanotes could not save the row paths").map((l) => l.attrs)).toEqual([{ error: "ENOSPC: no space left on device" }]);
  });

  it("a torn last line that cannot be ended is read around all the same", async () => {
    const v = logVault();
    const call = { tool: "select_rows", args: {}, ok: true, durationMs: 1, value: null, servedBy: "engine" };
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    await feed.recordToolCall(call);
    await feed.stop();
    const file = v.listAll().find((p) => p.startsWith("store:changes"))!;
    v.write(file, `${v.read(file)}{"seq":2,"at":"2026-10-10T08:00`);
    const adapter = v.app.store! as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    vi.spyOn(adapter, "append").mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));
    const again = new ChangeFeed(v.app, () => v.settings);
    await again.start();
    vi.restoreAllMocks();
    expect(again.lastSeq).toBe(1);
    expect((await again.read({ ops: ["tool_call"], since: 0 })).events.map((e) => e.seq)).toEqual([1]);
    await again.stop();
  });
});

describe("a move of the database folder", () => {
  const X = `${LOG_DIR}/x.md`;
  const Y = `${LOG_DIR}/y.md`;
  const NO_ID = "---\ntable: main.public.log\nkind: walk\noccurred_at: 2026-09-27T10:00\n---\n";

  it("from the root of the vault: its rows move, pending hand edits inside it are dropped, a row that cannot be read keeps its state", async () => {
    const v = logVault({ [X]: NO_ID, [Y]: B.replace("-00000000000b", "-00000000000f") });
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    // pending hand edits inside the folder: the move reads its rows itself
    feed.touch(X);
    feed.moved(Y, `${LOG_DIR}/z.md`);
    // and outside it: kept, compared after the move (nothing changed there)
    feed.touch("Daily/a.md");
    feed.moved("Notes/one.md", "Notes/two.md");
    // the rows where the move puts them: one can be read, the other is held by another program
    v.write(`Base/${X}`, NO_ID.replace("kind: walk", "kind: alcohol"));
    v.write(`Base/${Y}`, B);
    lockReads(v).add(`Base/${Y}`);
    await feed.databaseMoved("", "Base", true, { source: "external", operation: "move_database" }, ["Datanotes"]);
    await feed.flush();
    const events = (await feed.read()).events;
    expect(events.map((e) => [e.op, e.path, e.oldPath, e.id ?? null, e.row?.kind ?? null])).toEqual([
      ["schema", METASTORE, "metastore.yaml", null, null],
      ["move", `Base/${X}`, X, null, "alcohol"],
      ["move", `Base/${Y}`, Y, "01a0f000-0000-7000-8000-00000000000f", "mood"],
    ]);
    await feed.stop();
  });

  it("heard while the feed stops is not recorded", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    // the row paths are saved last while stopping: the move is heard then, and the metastore read slowly
    let saved: (() => void) | undefined;
    let read: (() => void) | undefined;
    const adapter = v.app.store! as unknown as { write(...a: unknown[]): Promise<unknown> };
    const write = adapter.write.bind(adapter);
    vi.spyOn(adapter, "write").mockImplementation(async (...a) => {
      await new Promise<void>((r) => (saved = r));
      return write(...a);
    });
    const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
    const realRead = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (f) => {
      if (saved && f.path === METASTORE) await new Promise<void>((r) => (read = r));
      return realRead(f);
    });
    const stopping = feed.stop();
    await vi.waitFor(() => expect(saved).toBeDefined(), { timeout: 5000 });
    const moved = feed.databaseMoved("Datanotes", "Moved", false);
    await vi.waitFor(() => expect(read).toBeDefined(), { timeout: 5000 });
    saved!();
    await stopping;
    read!();
    await moved;
    vi.restoreAllMocks();
    expect(feed.lastSeq).toBe(0);
  });
});

describe("hand edits in one batch", () => {
  it("a row edited, renamed, and a new row at its old path (its create event still to come): each event is recorded", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    write(v, feed, "Daily/a.md", A.replace("metric_drinks: 7", "metric_drinks: 40"));
    await rename(v, feed, "Daily/a.md", "Daily/c.md");
    v.write("Daily/a.md", A.replace("-00000000000a", "-0000000000a2"));
    await feed.flush();
    const events = (await feed.read()).events;
    // (a host with a watcher hears the create too: the new row's insert follows)
    expect(events.slice(0, 3).map((e) => [e.op, e.path, e.oldPath ?? null])).toEqual([
      ["update", "Daily/a.md", null],
      ["move", "Daily/c.md", "Daily/a.md"],
      ["update", "Daily/c.md", null],
    ]);
    await feed.stop();
  });

  it("notes that cannot be read: one removed while read, a row of a table whose options cannot be read, and no metastore", async () => {
    const v = logVault({ "Notes/r.md": R_ROW });
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const logs = captureLogs();
    const unread = () => logs.filter((l) => l.body === "datanotes change feed could not read a hand-edited note").map((l) => l.attrs.path);
    // the read fails because the note is removed meanwhile
    const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
    const realRead = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (f) => {
      if (f.path === "Daily/b.md") {
        v.remove("Daily/b.md");
        throw new Error("ENOENT: no such file or directory");
      }
      return realRead(f);
    });
    write(v, feed, "Daily/b.md", B.replace("kind: mood", "kind: walk"));
    await feed.flush();
    vi.restoreAllMocks();
    // the table's options broken by hand: its rows cannot be compared
    write(v, feed, METASTORE, LOG_YAML.replace("archive: _archive", "archive: _archive\n              exclude: 3"));
    write(v, feed, "Notes/r.md", R_ROW.replace("kind: walk", "kind: mood"));
    await feed.flush();
    expect(unread()).toEqual(["Daily/b.md", "Notes/r.md"]);

    // without a metastore: a known row left unreadable keeps its table; a new broken note is no row
    write(v, feed, METASTORE, LOG_YAML);
    await feed.flush();
    v.remove(METASTORE);
    feed.touch(METASTORE);
    write(v, feed, "Daily/a.md", A.replace("kind: alcohol", "kind: [alcohol"));
    write(v, feed, "Notes/new.md", "---\ntable: main.public.log\nkind: [walk\n---\n");
    await feed.flush();
    const events = (await feed.read()).events;
    expect(events.filter((e) => e.op === "unreadable").map((e) => [e.path, e.table])).toEqual([["Daily/a.md", "main.public.log"]]);
    expect(unread()).toEqual(["Daily/b.md", "Notes/r.md", "Notes/new.md"]);
    await feed.stop();
  });
});
