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

/** Wait for the comparisons of the whole tree under way (they run without blocking). */
async function compared(w: NodeWatcher): Promise<void> {
  const of = () => (w as unknown as { comparing: Promise<void> | null }).comparing;
  while (of()) await of();
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
    await compared(watcher); // without blocking
    expect(changes).toEqual([["A.md"]]);
    fs.rmSync(path.join(root, "A.md"));
    os_.w.emit("error", new Error("EMFILE: too many open files, watch"));
    await vi.advanceTimersByTimeAsync(10);
    await compared(watcher);
    expect(changes).toEqual([["A.md"], ["A.md"]]);
    os_.emit("rename", null); // nothing changed: nothing reported
    await vi.advanceTimersByTimeAsync(10);
    await compared(watcher);
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
    await compared(watcher);
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
    await watcher.flush(); // waits for the comparison
    expect(changes).toEqual([["Unreported.md"]]);
    await vi.advanceTimersByTimeAsync(1000); // the startup rescan: nothing new
    await compared(watcher);
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

describe("NodeWatcher: the service's start (one walk)", () => {
  it("after the start's walk, compares the tree without blocking: what changed meanwhile is found, and an operation waits for it", async () => {
    const root = vaultWith({ "Inbox.md": "i", "Old/Gone.md": "g", "Keep.md": "k" });
    const os_ = fakeOsWatcher();
    const { changes, watcher, host } = start(root, { startupRescanMs: 0 });
    const rescan = vi.spyOn(host.vault, "rescan");
    // changes made between the walk (openNodeVault) and the watcher's start
    fs.writeFileSync(path.join(root, "During.md"), "written while the notes were read");
    fs.writeFileSync(path.join(root, "Keep.md"), "kept, and changed");
    fs.rmSync(path.join(root, "Old"), { recursive: true });
    fs.mkdirSync(path.join(root, "New"));
    fs.writeFileSync(path.join(root, "New", "Inside.md"), "n");
    fs.writeFileSync(path.join(root, ".hidden.md"), "not the vault's");
    expect(watcher.start({ scanned: { at: performance.now(), ms: 5 } })).toEqual([]);
    expect(fs.watch).toHaveBeenCalledTimes(1);
    await watcher.flush(); // waits for the comparison
    // a new folder is synced with what it holds (its notes indexed with it)
    expect(changes.map((c) => c.sort())).toEqual([["During.md", "Keep.md", "New", "Old", "Old/Gone.md"]]);
    expect(host.vault.getAbstractFileByPath("New/Inside.md")).not.toBeNull();
    expect(host.vault.getAbstractFileByPath("Old/Gone.md")).toBeNull();
    expect(rescan).not.toHaveBeenCalled(); // no blocking comparison
    expect(watcher.rescans).toBe(1);
    // nothing more to find: the next flush has nothing to check
    expect(watcher.flush()).toBeUndefined();
    // the OS's reports are followed from the start on
    fs.writeFileSync(path.join(root, "After.md"), "a");
    os_.emit("rename", "After.md");
    watcher.flush();
    expect(changes.at(-1)).toEqual(["After.md"]);
  });

  it("nothing changed since the walk: nothing reported", async () => {
    const root = vaultWith({ "Inbox.md": "i" });
    fakeOsWatcher();
    const { changes, watcher } = start(root, { startupRescanMs: 0 });
    watcher.start({ scanned: { at: performance.now(), ms: 5 } });
    await watcher.flush();
    expect(changes).toEqual([]);
  });

  it("a comparison still running when the watcher stops applies nothing", async () => {
    const root = vaultWith({ "Inbox.md": "i" });
    fakeOsWatcher();
    const { changes, watcher, host } = start(root, { startupRescanMs: 0 });
    fs.writeFileSync(path.join(root, "Late.md"), "l");
    let release!: () => void;
    const real = host.vault.changedSinceWalk.bind(host.vault);
    vi.spyOn(host.vault, "changedSinceWalk").mockImplementation(async () => {
      const paths = await real();
      await new Promise<void>((r) => (release = r));
      return paths;
    });
    watcher.start({ scanned: { at: performance.now(), ms: 5 } });
    await vi.waitFor(() => expect(release).toBeDefined());
    watcher.stop();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(changes).toEqual([]);
  });

  it("poll mode: the walk counts as the last comparison", async () => {
    const root = vaultWith({ "Inbox.md": "i" });
    const { watcher, host } = start(root, { mode: "poll", intervalMs: 60_000 });
    const rescan = vi.spyOn(host.vault, "rescan");
    const at = performance.now();
    watcher.start({ scanned: { at, ms: 500 } });
    await watcher.flush(at - 1);
    // the comparison after the walk took little: a flush compares the tree again
    watcher.flush();
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("the check 1 s after start: none when the comparison after the walk ended later, one walk when it ended sooner", async () => {
    const root = vaultWith({ "Inbox.md": "i" });
    fakeOsWatcher();
    // a slow comparison (a large vault): it ends after the OS's stream started, and is the only walk
    const slow = start(root, { startupRescanMs: 30 });
    const real = slow.host.vault.changedSinceWalk.bind(slow.host.vault);
    const walks = vi.spyOn(slow.host.vault, "changedSinceWalk").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return real();
    });
    slow.watcher.start({ scanned: { at: performance.now(), ms: 5 } });
    await slow.watcher.flush();
    await new Promise((r) => setTimeout(r, 60));
    await compared(slow.watcher);
    expect(walks).toHaveBeenCalledTimes(1);
    slow.watcher.stop();
    // a quick one: the check at 30 ms walks once more, without blocking
    const quick = start(root, { startupRescanMs: 30 });
    const quickWalks = vi.spyOn(quick.host.vault, "changedSinceWalk");
    quick.watcher.start({ scanned: { at: performance.now(), ms: 5 } });
    await compared(quick.watcher);
    expect(quickWalks).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(root, "Missed.md"), "m"); // the OS's stream was still starting
    await vi.waitFor(() => expect(quick.changes).toEqual([["Missed.md"]]));
    expect(quickWalks).toHaveBeenCalledTimes(2);
  });

  it("the comparison after the walk ends past the check's time before the check ran: the check is cancelled", async () => {
    const root = vaultWith({ "Inbox.md": "i" });
    fakeOsWatcher();
    const { watcher, host } = start(root, { startupRescanMs: 20 });
    const real = host.vault.changedSinceWalk.bind(host.vault);
    const walks = vi.spyOn(host.vault, "changedSinceWalk").mockImplementation(async () => {
      const paths = await real();
      // the event loop held past the check's time: its timer cannot fire before the comparison ends
      const until = performance.now() + 40;
      while (performance.now() < until);
      return paths;
    });
    watcher.start({ scanned: { at: performance.now(), ms: 5 } });
    await compared(watcher);
    expect((watcher as unknown as { startup: unknown }).startup).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    await compared(watcher);
    expect(walks).toHaveBeenCalledTimes(1);
  });

  it("a comparison asked for while one runs runs again once it ends", async () => {
    const root = vaultWith({ "Inbox.md": "i" });
    const os_ = fakeOsWatcher();
    const { changes, watcher, host } = start(root, { startupRescanMs: 0, debounceMs: 1 });
    const real = host.vault.changedSinceWalk.bind(host.vault);
    let release!: () => void;
    const walks = vi.spyOn(host.vault, "changedSinceWalk").mockImplementationOnce(async () => {
      const paths = await real();
      await new Promise<void>((r) => (release = r));
      return paths;
    });
    watcher.start({ scanned: { at: performance.now(), ms: 5 } });
    await vi.waitFor(() => expect(release).toBeDefined());
    // listed already by the first comparison: only a second one finds it
    fs.writeFileSync(path.join(root, "After.md"), "a");
    os_.emit("change", null);
    os_.emit("change", null); // asked twice: one more comparison
    await new Promise((r) => setTimeout(r, 20));
    release();
    await compared(watcher);
    expect(walks).toHaveBeenCalledTimes(2);
    expect(changes).toEqual([["After.md"]]);
  });

  it("poll mode: no comparison while the engine writes; one once it is done", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    let writing = true;
    const { changes, watcher, host } = start(root, { mode: "poll", intervalMs: 1000, writing: () => writing });
    const rescan = vi.spyOn(host.vault, "rescan");
    watcher.start({ scanned: { at: performance.now(), ms: 5 } });
    await compared(watcher);
    fs.writeFileSync(path.join(root, "Hand.md"), "h");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rescan).not.toHaveBeenCalled();
    writing = false;
    await vi.advanceTimersByTimeAsync(150);
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([["Hand.md"]]);
  });

  it("a comparison of the tree asked for while the engine writes waits until it is done, then runs once", async () => {
    vi.useFakeTimers();
    const root = vaultWith({ "Inbox.md": "i" });
    const os_ = fakeOsWatcher();
    let writing = true;
    const { changes, watcher, host } = start(root, { startupRescanMs: 0, writing: () => writing });
    const rescan = vi.spyOn(host.vault, "rescan");
    const walks = vi.spyOn(host.vault, "changedSinceWalk");
    watcher.start();
    // the OS's buffer overflowed during a burst of the engine's writes: no path, several times
    os_.emit("change", null);
    fs.writeFileSync(path.join(root, "Named.md"), "n");
    os_.emit("rename", "Named.md");
    await vi.advanceTimersByTimeAsync(150);
    expect(changes).toEqual([["Named.md"]]); // the paths reported are checked meanwhile
    os_.emit("change", null);
    watcher.flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(walks).not.toHaveBeenCalled(); // no comparison of the tree while the engine writes
    fs.writeFileSync(path.join(root, "Unreported.md"), "u");
    writing = false;
    await vi.advanceTimersByTimeAsync(150);
    await compared(watcher);
    // one comparison once it is done, without blocking; the start's own was the only blocking one
    expect(walks).toHaveBeenCalledTimes(1);
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([["Named.md"], ["Unreported.md"]]);
    expect(watcher.rescans).toBe(2);
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

  it("flush() for an operation that arrived before the last comparison started: that comparison saw it", () => {
    const root = vaultWith({ "Inbox.md": "i" });
    const { changes, watcher, host } = start(root, { mode: "poll", intervalMs: 3_600_000 });
    watcher.start();
    const scans = vi.spyOn(host.vault, "rescan");
    const arrived = performance.now();
    fs.writeFileSync(path.join(root, "First.md"), "f");
    watcher.flush(arrived); // compares: none since the operation arrived
    expect(changes).toEqual([["First.md"]]);
    // another operation that arrived before that comparison started: not compared again
    fs.writeFileSync(path.join(root, "Second.md"), "s");
    watcher.flush(arrived);
    expect(scans).toHaveBeenCalledTimes(1);
    // one that arrives now: compared
    watcher.flush(performance.now());
    expect(changes).toEqual([["First.md"], ["Second.md"]]);
    expect(scans).toHaveBeenCalledTimes(2);
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
    let took = 2000;
    const scans = slowScans(host, () => took);
    watcher.start();
    expect(scans.count).toBe(1);
    fs.writeFileSync(path.join(root, "Late.md"), "l");
    watcher.flush(); // every comparison so far took 2 s: not before every operation
    expect(scans.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // the first poll, after the interval asked for
    expect(scans.count).toBe(2);
    expect(changes).toEqual([["Late.md"]]);
    await vi.advanceTimersByTimeAsync(7999); // 2 s: the next after 8 s
    expect(scans.count).toBe(2);
    took = 10;
    await vi.advanceTimersByTimeAsync(1);
    expect(scans.count).toBe(3);
    // fast again: back to the interval asked for, and an operation compares first
    fs.writeFileSync(path.join(root, "Quick.md"), "q");
    watcher.flush();
    expect(scans.count).toBe(4);
    expect(changes).toEqual([["Late.md"], ["Quick.md"]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scans.count).toBe(5);
  });

  it("one slow comparison among fast ones (a GC pause): an operation still compares first; three slow in a row: it does not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const root = vaultWith({ "Inbox.md": "i" });
    const { changes, watcher, host } = start(root, { mode: "poll", intervalMs: 1000 });
    let took = 5;
    const scans = slowScans(host, () => took);
    watcher.start();
    took = 60; // one comparison over the budget
    watcher.flush();
    expect(scans.count).toBe(2);
    took = 5;
    fs.writeFileSync(path.join(root, "Moved.md"), "m");
    watcher.flush(); // the one before was fast: compares, and sees the change
    expect(scans.count).toBe(3);
    expect(changes).toEqual([["Moved.md"]]);
    // a vault slow every time: three comparisons over the budget, then an operation does not compare
    took = 60;
    watcher.flush();
    watcher.flush();
    watcher.flush();
    expect(scans.count).toBe(6);
    watcher.flush();
    expect(scans.count).toBe(6);
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
