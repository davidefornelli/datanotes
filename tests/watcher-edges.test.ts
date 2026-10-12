import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNodeVault, type NodeHost } from "../src/node/node-app";
import { nextPollMs, NodeWatcher, POLL_MAX_INTERVAL_MS } from "../src/node/watcher";

const opened: { host: NodeHost; watcher: NodeWatcher }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.watcher.stop();
    o.host.metadataCache.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function vaultWith(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-edges-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/**
 * The operating system's watcher, played by the test: `emit(event, filename)` is what fs.watch
 * would report (filename null when the platform does not say which path changed).
 */
function fakeOsWatcher() {
  let listener: ((event: string, filename: string | null) => void) | null = null;
  const w = new EventEmitter() as EventEmitter & { close: () => void; closed: boolean };
  w.closed = false;
  w.close = () => void (w.closed = true);
  vi.spyOn(fs, "watch").mockImplementation(((_p: unknown, _o: unknown, cb: (event: string, filename: string | null) => void) => {
    listener = cb;
    return w;
  }) as never);
  return { w, emit: (event: string, filename: string | null) => listener!(event, filename) };
}

function start(root: string, opts: Partial<ConstructorParameters<typeof NodeWatcher>[1]> = {}) {
  const host = openNodeVault(root);
  const changes: string[][] = [];
  const watcher = new NodeWatcher(host.vault, { mode: "events", onChanges: (p) => changes.push(p), ...opts });
  opened.push({ host, watcher });
  return { host, watcher, changes };
}

describe("NodeWatcher: events mode", () => {
  it("reports changes made while the engine was off at start", () => {
    const root = vaultWith({ "Inbox.md": "i" });
    fakeOsWatcher();
    const host = openNodeVault(root);
    fs.writeFileSync(path.join(root, "New.md"), "written while off");
    const changes: string[][] = [];
    const watcher = new NodeWatcher(host.vault, { mode: "events", onChanges: (p) => changes.push(p) });
    opened.push({ host, watcher });
    expect(watcher.start()).toEqual(["New.md"]);
    expect(changes).toEqual([["New.md"]]);
  });

  it("checks a reported path after 150 ms of quiet, once for a burst, and ignores hidden folders", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    const os_ = fakeOsWatcher();
    const { changes, watcher } = start(root);
    watcher.start();
    fs.writeFileSync(path.join(root, "Notes.md"), "n");
    os_.emit("rename", "Notes.md");
    await vi.advanceTimersByTimeAsync(100);
    os_.emit("change", "Notes.md"); // the burst restarts the quiet time
    os_.emit("change", path.join(".obsidian", "workspace.json"));
    await vi.advanceTimersByTimeAsync(149);
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toEqual([["Notes.md"]]);
  });

  it("checks the paths reported together as one batch: a note renamed outside is one rename", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i", "People/Ada.md": "Ada Lovelace, mathematician and writer." });
    const os_ = fakeOsWatcher();
    const { changes, watcher, host } = start(root);
    const events: string[] = [];
    host.vault.on("rename", ((f: { path: string }, old: string) => void events.push(`rename ${old} -> ${f.path}`)) as never);
    host.vault.on("delete", ((f: { path: string }) => void events.push(`delete ${f.path}`)) as never);
    watcher.start();
    fs.renameSync(path.join(root, "People/Ada.md"), path.join(root, "People/Ada King.md"));
    os_.emit("rename", path.join("People", "Ada.md"));
    os_.emit("rename", path.join("People", "Ada King.md"));
    await vi.advanceTimersByTimeAsync(150);
    expect(changes).toEqual([["People/Ada.md", "People/Ada King.md"]]);
    expect(events).toEqual(["rename People/Ada.md -> People/Ada King.md"]);
    os_.emit("change", "Inbox.md"); // touched, not changed: nothing reported
    await vi.advanceTimersByTimeAsync(150);
    expect(changes).toHaveLength(1);
  });

  it("a burst that goes on is checked at the latest maxWaitMs after its first path", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    const os_ = fakeOsWatcher();
    const { changes, watcher } = start(root, { debounceMs: 100, maxWaitMs: 250 });
    watcher.start();
    fs.writeFileSync(path.join(root, "Busy.md"), "b");
    for (let i = 0; i < 3; i++) {
      os_.emit("change", "Busy.md");
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(changes).toEqual([]);
    os_.emit("change", "Busy.md"); // at 240 ms: 10 ms are left of the longest wait
    await vi.advanceTimersByTimeAsync(10);
    expect(changes).toEqual([["Busy.md"]]);
  });

  it("an event without a path, or a watcher error, compares the whole tree", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    const os_ = fakeOsWatcher();
    const { changes, watcher } = start(root, { debounceMs: 10 });
    watcher.start();
    fs.writeFileSync(path.join(root, "A.md"), "a");
    os_.emit("rename", null);
    await vi.advanceTimersByTimeAsync(10);
    expect(changes).toEqual([["A.md"]]);
    fs.rmSync(path.join(root, "A.md"));
    os_.w.emit("error", new Error("EMFILE: too many open files, watch"));
    await vi.advanceTimersByTimeAsync(10);
    expect(changes).toEqual([["A.md"], ["A.md"]]);
    os_.emit("rename", null); // nothing changed: nothing reported
    await vi.advanceTimersByTimeAsync(10);
    expect(changes).toHaveLength(2);
  });

  it("compares the whole tree 1 s after start: a change the OS stream missed while starting", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    fakeOsWatcher();
    const { changes, watcher } = start(root, { debounceMs: 10 });
    watcher.start();
    fs.writeFileSync(path.join(root, "Early.md"), "e"); // no event reported
    await vi.advanceTimersByTimeAsync(1009);
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toEqual([["Early.md"]]);
  });

  it("flush() applies at once the paths still in their quiet time, and the whole tree while the stream may be starting", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    const os_ = fakeOsWatcher();
    const { changes, watcher } = start(root);
    watcher.flush(); // not started: nothing to do
    watcher.start();
    fs.writeFileSync(path.join(root, "Unreported.md"), "u"); // no event: only the startup rescan finds it
    watcher.flush();
    expect(changes).toEqual([["Unreported.md"]]);
    await vi.advanceTimersByTimeAsync(1000); // the startup rescan: nothing new
    fs.writeFileSync(path.join(root, "Reported.md"), "r");
    os_.emit("rename", "Reported.md");
    watcher.flush();
    expect(changes).toEqual([["Unreported.md"], ["Reported.md"]]);
    await vi.advanceTimersByTimeAsync(1000); // the check was done: not reported again
    expect(changes).toHaveLength(2);
    fs.writeFileSync(path.join(root, "Unseen.md"), "u"); // no event, no startup rescan any more
    watcher.flush(); // nothing pending: the tree is not compared
    expect(changes).toHaveLength(2);
    watcher.stop();
    watcher.flush(); // stopped: nothing to do
  });

  it("stop() closes the OS watcher and drops the checks still waiting", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    const os_ = fakeOsWatcher();
    const { changes, watcher } = start(root);
    watcher.start();
    fs.writeFileSync(path.join(root, "Late.md"), "l");
    os_.emit("rename", "Late.md");
    watcher.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([]);
    expect(os_.w.closed).toBe(true);
  });
});

describe("NodeWatcher: poll mode", () => {
  it("compares the tree every 3 s by default", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    const { changes, watcher } = start(root, { mode: "poll" });
    watcher.start();
    fs.writeFileSync(path.join(root, "Polled.md"), "p");
    await vi.advanceTimersByTimeAsync(2999);
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toEqual([["Polled.md"]]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(changes).toHaveLength(1); // nothing new
  });

  it("flush() compares the tree at once, only while polling", () => {
    const root = vaultWith({ "Inbox.md": "i" });
    const { changes, watcher } = start(root, { mode: "poll", intervalMs: 3_600_000 });
    fs.writeFileSync(path.join(root, "Early.md"), "e");
    watcher.flush(); // not started
    expect(changes).toEqual([]);
    watcher.start();
    expect(changes).toEqual([["Early.md"]]);
    fs.writeFileSync(path.join(root, "Flushed.md"), "f");
    watcher.flush();
    expect(changes).toEqual([["Early.md"], ["Flushed.md"]]);
    watcher.flush();
    expect(changes).toHaveLength(2); // nothing new
  });

  it("the pause after a comparison grows with its duration, up to a minute", () => {
    expect(nextPollMs(3000, 5)).toBe(3000);
    expect(nextPollMs(3000, 2000)).toBe(4 * 2000);
    expect(nextPollMs(3000, 60_000)).toBe(POLL_MAX_INTERVAL_MS);
    expect(nextPollMs(120_000, 60_000)).toBe(120_000); // never under the interval asked for
  });

  /** A vault whose comparison of the whole tree takes `ms` (as 10,000 notes over a slow mount). */
  function slowScans(host: ReturnType<typeof start>["host"], ms: () => number) {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const rescan = host.vault.rescan.bind(host.vault);
    const scans = { count: 0 };
    vi.spyOn(host.vault, "rescan").mockImplementation(() => {
      scans.count++;
      clock += ms();
      return rescan();
    });
    return scans;
  }

  it("a slow comparison: the next one waits longer, and an operation does not compare first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const root = vaultWith({ "Inbox.md": "i" });
    const { changes, watcher, host } = start(root, { mode: "poll", intervalMs: 1000 });
    let took = 10;
    const scans = slowScans(host, () => took);
    watcher.start();
    expect(scans.count).toBe(1);
    took = 2000;
    await vi.advanceTimersByTimeAsync(1000); // 10 ms at start: the next comparison after 1 s
    expect(scans.count).toBe(2);
    fs.writeFileSync(path.join(root, "Late.md"), "l");
    watcher.flush(); // the last comparison took 2 s: not before every operation
    expect(scans.count).toBe(2);
    await vi.advanceTimersByTimeAsync(7999); // 2 s: the next after 8 s
    expect(scans.count).toBe(2);
    took = 10;
    await vi.advanceTimersByTimeAsync(1);
    expect(scans.count).toBe(3);
    expect(changes).toEqual([["Late.md"]]);
    // fast again: back to the interval asked for, and an operation compares first
    fs.writeFileSync(path.join(root, "Quick.md"), "q");
    watcher.flush();
    expect(scans.count).toBe(4);
    expect(changes).toEqual([["Late.md"], ["Quick.md"]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scans.count).toBe(5);
  });

  it("a watcher stopped and started again by its own listener keeps one poll", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const root = vaultWith({ "Inbox.md": "i" });
    let restart = false;
    const host = openNodeVault(root);
    const watcher: NodeWatcher = new NodeWatcher(host.vault, {
      mode: "poll",
      intervalMs: 1000,
      onChanges: () => {
        if (!restart) return;
        restart = false;
        watcher.stop();
        watcher.start();
      },
    });
    opened.push({ host, watcher });
    const scans = slowScans(host, () => 1);
    watcher.start();
    fs.writeFileSync(path.join(root, "Moved.md"), "m");
    restart = true;
    await vi.advanceTimersByTimeAsync(1000); // the poll, then the start's comparison
    expect(scans.count).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scans.count).toBe(4); // one poll, not two
  });
});
