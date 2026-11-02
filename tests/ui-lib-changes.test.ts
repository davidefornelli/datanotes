/**
 * The database browser's change bus (src/ui/lib/changes.ts): one long poll of list_changes per tab,
 * its cursor, its waits, and how it hands each subscriber the events that match its filter.
 */

import { describe, expect, it, vi } from "vitest";
import { AuthRefused, EngineUnreachable, type ApiAnswer } from "../src/ui/lib/api";
import { ChangeBus, VIEW_AS_WAIT_MS, type BusDeps, type WireEvent } from "../src/ui/lib/changes";

type Page = { events: WireEvent[]; last: number; head: number; gap?: boolean };

function ev(seq: number, over: Partial<WireEvent> = {}): WireEvent {
  return { seq, at: "2026-11-02T00:00:00Z", table: "w.p.task", kind: "update", path: `t/${seq}.md`, source: "engine", ...over };
}

function deps(answers: (ApiAnswer<Page> | Error)[], visible = () => true) {
  const sleeps: number[] = [];
  const args: Record<string, unknown>[] = [];
  const onAuthRefused = vi.fn();
  const d: BusDeps = {
    list: vi.fn(async (a: Record<string, unknown>) => {
      args.push(a);
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      if (next instanceof Error) throw next;
      return next;
    }),
    sleep: vi.fn(async (ms: number) => void sleeps.push(ms)),
    visible,
    onAuthRefused,
  };
  return { d, sleeps, args, onAuthRefused };
}

const ok = (json: Page): ApiAnswer<Page> => ({ status: 200, ok: true, json });

describe("ChangeBus", () => {
  it("starts at the head, then follows the cursor with long polls", async () => {
    const { d, args, sleeps } = deps([
      { status: 503, ok: false, json: { events: [], last: 0, head: 0 } },
      ok({ events: [], last: 0, head: 7 }),
      ok({ events: [ev(8)], last: 8, head: 8 }),
      ok({ events: [], last: 8, head: 8 }),
    ]);
    const bus = new ChangeBus(d);
    const got: WireEvent[][] = [];
    bus.subscribe((e) => got.push(e));
    await bus.tick();
    expect(sleeps).toEqual([5000]);
    await bus.tick();
    await bus.tick();
    await bus.tick();
    expect(args).toEqual([
      { since: 0, limit: 1 },
      { since: 0, limit: 1 },
      { since: 7, wait_ms: 25000, limit: 500 },
      { since: 8, wait_ms: 25000, limit: 500 },
    ]);
    expect(got).toEqual([[ev(8)]]);
  });

  it("waits waitMs per long poll when given (view-as: 5 s)", async () => {
    const { d, args } = deps([ok({ events: [], last: 0, head: 3 }), ok({ events: [], last: 3, head: 3 })]);
    const bus = new ChangeBus({ ...d, waitMs: VIEW_AS_WAIT_MS });
    await bus.tick();
    await bus.tick();
    expect(VIEW_AS_WAIT_MS).toBe(5000);
    expect(args[1]).toEqual({ since: 3, wait_ms: 5000, limit: 500 });
  });

  it("filters by table, path (old_path too) and kind; a gap reaches everyone", async () => {
    const events = [
      ev(1, { table: "w.p.task" }),
      ev(2, { table: null, kind: "metastore", path: "datanotes/metastore.yaml" }),
      ev(3, { kind: "move", path: "t/new.md", old_path: "t/old.md" }),
      ev(4, { kind: "insert" }),
    ];
    const { d } = deps([ok({ events: [], last: 0, head: 0 }), ok({ events, last: 4, head: 4 }), ok({ events: [ev(5)], last: 5, head: 5, gap: true })]);
    const bus = new ChangeBus(d);
    const seen: Record<string, number[][]> = { tables: [], paths: [], kinds: [], all: [], none: [] };
    const gaps: boolean[] = [];
    bus.subscribe((e) => seen.tables!.push(e.map((x) => x.seq)), { tables: ["w.p.task"] });
    bus.subscribe((e) => seen.paths!.push(e.map((x) => x.seq)), { paths: ["t/old.md", "t/1.md"] });
    bus.subscribe((e, info) => {
      seen.kinds!.push(e.map((x) => x.seq));
      gaps.push(info.gap);
    }, { kinds: ["metastore"] });
    bus.subscribe((e) => seen.all!.push(e.map((x) => x.seq)));
    const off = bus.subscribe((e) => seen.none!.push(e.map((x) => x.seq)), { tables: ["other"] });
    await bus.tick();
    await bus.tick();
    off();
    await bus.tick();
    expect(seen.tables).toEqual([[1, 3, 4], [5]]);
    expect(seen.paths).toEqual([[1, 3], []]);
    expect(seen.kinds).toEqual([[2], []]);
    expect(gaps).toEqual([false, true]);
    expect(seen.all).toEqual([[1, 2, 3, 4], [5]]);
    expect(seen.none).toEqual([]);
  });

  it("sleeps while the tab is hidden", async () => {
    let shown = false;
    const { d, sleeps } = deps([ok({ events: [], last: 0, head: 3 })], () => shown);
    const bus = new ChangeBus(d);
    await bus.tick();
    await bus.tick();
    expect(sleeps).toEqual([2000]);
    expect(d.list).toHaveBeenCalledOnce();
    shown = true;
  });

  it("waits 5 s after a refusal or an unreachable engine, and keeps its cursor", async () => {
    const { d, sleeps, args } = deps([
      ok({ events: [], last: 0, head: 2 }),
      { status: 500, ok: false, json: { events: [], last: 0, head: 0 } },
      new EngineUnreachable("down"),
      ok({ events: [], last: 2, head: 2 }),
    ]);
    const bus = new ChangeBus(d);
    for (let i = 0; i < 4; i++) await bus.tick();
    expect(sleeps).toEqual([5000, 5000]);
    expect(args.slice(1).map((a) => a.since)).toEqual([2, 2, 2]);
  });

  it("stops and signs out on AuthRefused", async () => {
    const { d, onAuthRefused } = deps([new AuthRefused()]);
    const bus = new ChangeBus(d);
    bus.start();
    await vi.waitFor(() => expect(onAuthRefused).toHaveBeenCalledOnce());
    expect(bus.running).toBe(false);
  });

  it("a throwing listener does not stop the others", async () => {
    const { d } = deps([ok({ events: [], last: 0, head: 0 }), ok({ events: [ev(1)], last: 1, head: 1 })]);
    const bus = new ChangeBus(d);
    const later = vi.fn();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(later);
    await bus.tick();
    await bus.tick();
    expect(later).toHaveBeenCalledOnce();
  });

  it("start() twice runs one loop; stop() aborts the poll and dispatches nothing", async () => {
    let release: (a: ApiAnswer<Page>) => void = () => {};
    const signals: AbortSignal[] = [];
    let calls = 0;
    const d: BusDeps = {
      list: vi.fn((a: Record<string, unknown>, signal?: AbortSignal) => {
        calls++;
        signals.push(signal!);
        if (a.limit === 1) return Promise.resolve(ok({ events: [], last: 0, head: 0 }));
        return new Promise<ApiAnswer<Page>>((resolve, reject) => {
          release = resolve;
          signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }),
      sleep: vi.fn(async () => {}),
      visible: () => true,
      onAuthRefused: vi.fn(),
    };
    const bus = new ChangeBus(d);
    const got = vi.fn();
    bus.subscribe(got);
    bus.start();
    bus.start();
    expect(bus.running).toBe(true);
    await vi.waitFor(() => expect(calls).toBe(2));
    bus.stop();
    expect(bus.running).toBe(false);
    expect(signals[1]!.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.sleep).not.toHaveBeenCalled();
    expect(calls).toBe(2);
    release(ok({ events: [ev(1)], last: 1, head: 1 }));
    expect(got).not.toHaveBeenCalled();
  });

  it("drops an answer that arrives after stop()", async () => {
    let release: (a: ApiAnswer<Page>) => void = () => {};
    const d: BusDeps = {
      list: vi.fn((a: Record<string, unknown>) =>
        a.limit === 1 ? Promise.resolve(ok({ events: [], last: 0, head: 0 })) : new Promise<ApiAnswer<Page>>((r) => (release = r)),
      ),
      sleep: vi.fn(async () => {}),
      visible: () => true,
      onAuthRefused: vi.fn(),
    };
    const bus = new ChangeBus(d);
    const got = vi.fn();
    bus.subscribe(got);
    await bus.tick();
    const pending = bus.tick();
    bus.stop();
    release(ok({ events: [ev(1)], last: 1, head: 1 }));
    await pending;
    expect(got).not.toHaveBeenCalled();
  });
});
