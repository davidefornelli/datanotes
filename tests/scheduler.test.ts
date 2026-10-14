/**
 * Write priority (src/server/scheduler.ts): while a write runs or waits, new reads wait; reads
 * under way finish; writes keep their order; reads never starve; free operations never wait.
 */

import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { MAX_WRITES_AHEAD, OperationScheduler, operationClass, WRITE_SLOT, type OperationClass } from "../src/server/scheduler";
import { READ_OPERATIONS } from "../src/server/token-routes";

/** A promise to resolve by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function scheduler(maxReadWaitMs = 10_000, enabled = true): OperationScheduler {
  return new OperationScheduler(() => ({ enabled, maxReadWaitMs }));
}

/** Runs an operation that ends when its gate opens; `log` records when it starts and ends. */
function op(s: OperationScheduler, cls: OperationClass, name: string, log: string[]) {
  const g = gate();
  const done = s.run(cls, async () => {
    log.push(`start ${name}`);
    await g.promise;
    log.push(`end ${name}`);
    return name;
  });
  return { done, end: g.open };
}

describe("write priority", () => {
  it("classifies every operation of the catalogue: reads by readOnlyHint, the long poll and the embedding calls free", () => {
    for (const o of OPERATIONS) {
      const cls = operationClass(o.name);
      expect(["read", "write", "free"], o.name).toContain(cls);
      if (o.name === "semantic_search" || o.name === "sync_semantic_index") expect(cls, o.name).toBe("free");
      else expect(cls, o.name).toBe(o.annotations.readOnlyHint === true ? "read" : "write");
    }
    expect([...READ_OPERATIONS].sort()).toEqual(OPERATIONS.filter((o) => o.annotations.readOnlyHint === true).map((o) => o.name).sort());
    expect(operationClass("list_changes", { wait_ms: 5000 })).toBe("free");
    expect(operationClass("list_changes", { wait_ms: 0 })).toBe("read");
    expect(operationClass("list_changes", {})).toBe("read");
  });

  it("runs reads at once while no write runs, side by side", async () => {
    const s = scheduler();
    const log: string[] = [];
    const a = op(s, "read", "r1", log);
    const b = op(s, "read", "r2", log);
    await tick();
    expect(log).toEqual(["start r1", "start r2"]);
    a.end();
    b.end();
    expect(await Promise.all([a.done, b.done])).toEqual(["r1", "r2"]);
  });

  it("holds new reads while a write runs; a read under way finishes; the reads start when the write ends", async () => {
    const s = scheduler();
    const log: string[] = [];
    const r1 = op(s, "read", "r1", log);
    await tick();
    const w = op(s, "write", "w", log);
    await tick();
    // the write does not wait for the read under way
    expect(log).toEqual(["start r1", "start w"]);
    const r2 = op(s, "read", "r2", log);
    await tick();
    expect(s.waitingReads).toBe(1);
    r1.end();
    await tick();
    expect(log).toEqual(["start r1", "start w", "end r1"]);
    w.end();
    await w.done;
    await tick();
    expect(log).toEqual(["start r1", "start w", "end r1", "end w", "start r2"]);
    r2.end();
    await r2.done;
  });

  it("runs writes one at a time, in the order they came, with the reads that came meanwhile after all of them", async () => {
    const s = scheduler();
    const log: string[] = [];
    const w1 = op(s, "write", "w1", log);
    const w2 = op(s, "write", "w2", log);
    const r = op(s, "read", "r", log);
    const w3 = op(s, "write", "w3", log);
    await tick();
    expect(log).toEqual(["start w1"]);
    expect(s.pendingWrites).toBe(3);
    w1.end();
    await w1.done;
    await tick();
    expect(log).toEqual(["start w1", "end w1", "start w2"]);
    w2.end();
    await w2.done;
    await tick();
    w3.end();
    await w3.done;
    await tick();
    expect(log).toEqual(["start w1", "end w1", "start w2", "end w2", "start w3", "end w3", "start r"]);
    r.end();
    await r.done;
    expect(s.pendingWrites).toBe(0);
  });

  it("lets a read waiting for writes start after maxReadWaitMs, while the write still runs", async () => {
    const s = scheduler(20);
    const log: string[] = [];
    const w = op(s, "write", "w", log);
    await tick();
    const slot = await s.acquire("read");
    expect(slot.wait.released).toBe("max_wait");
    expect(slot.wait.waitedMs).toBeGreaterThanOrEqual(15);
    expect(slot.wait.writesAhead).toBe(1);
    expect(log).toEqual(["start w"]);
    w.end();
    await w.done;
  });

  it(`lets a read through once more than ${MAX_WRITES_AHEAD} writes started after it came`, async () => {
    const s = scheduler();
    const log: string[] = [];
    const first = op(s, "write", "w0", log);
    await tick();
    let released: string | undefined;
    const read = s.acquire("read").then((slot) => (released = slot.wait.released));
    const writes = Array.from({ length: MAX_WRITES_AHEAD + 1 }, (_, i) => op(s, "write", `w${i + 1}`, log));
    first.end();
    for (const w of writes) {
      await tick();
      w.end();
      await w.done;
    }
    await read;
    expect(released).toBe("max_writes");
    // it was let through while writes still came: before the last of them ended
    await first.done;
  });

  it("never holds free operations (a long poll), and they never hold a write", async () => {
    const s = scheduler();
    const log: string[] = [];
    const w = op(s, "write", "w", log);
    const poll = op(s, "free", "poll", log);
    await tick();
    expect(log).toEqual(["start w", "start poll"]);
    const w2 = op(s, "write", "w2", log);
    w.end();
    await w.done;
    await tick();
    // the poll still waits for a change: the next write runs
    expect(log).toEqual(["start w", "start poll", "end w", "start w2"]);
    w2.end();
    poll.end();
    await Promise.all([w2.done, poll.done]);
    expect(s.wouldWait("free")).toBe(false);
  });

  it("does nothing when write priority is off", async () => {
    const s = scheduler(10_000, false);
    const log: string[] = [];
    const w1 = op(s, "write", "w1", log);
    const w2 = op(s, "write", "w2", log);
    const r = op(s, "read", "r", log);
    await tick();
    expect(log).toEqual(["start w1", "start w2", "start r"]);
    expect(s.wouldWait("read")).toBe(false);
    for (const x of [w1, w2, r]) x.end();
    await Promise.all([w1.done, w2.done, r.done]);
  });

  it("releases a write's turn once only, and passes it on when the write fails", async () => {
    const s = scheduler();
    const slot = await s.acquire("write");
    const next = s.acquire("write");
    slot.release();
    slot.release();
    const second = await next;
    expect(s.pendingWrites).toBe(1);
    second.release();
    await expect(s.run("write", async () => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
    expect(s.pendingWrites).toBe(0);
    expect((await s.acquire("read")).wait.waitedMs).toBe(0);
  });

  it("hands the write slot to the next write once a write kept it for WRITE_SLOT.maxMs, with a warning naming it; the late release passes nothing on", async () => {
    const max = WRITE_SLOT.maxMs;
    const logs: { severity: string; body: string; attributes?: Record<string, unknown> }[] = [];
    setTelemetry({ log: (severity, body, attributes) => void logs.push({ severity, body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
    try {
      const s = scheduler();
      WRITE_SLOT.maxMs = 30; // read when a write gets the slot: only this one has 30 ms
      const stuck = await s.acquire("write", "update_rows");
      WRITE_SLOT.maxMs = 60_000; // the writes after it keep their turn
      const log: string[] = [];
      const w2 = op(s, "write", "w2", log);
      await tick();
      expect(log).toEqual([]);
      await new Promise((r) => setTimeout(r, 80));
      expect(log).toEqual(["start w2"]);
      expect(logs).toEqual([{ severity: "WARN", body: "datanotes write still running: the next write starts", attributes: { operation: "update_rows", held_ms: expect.any(Number) } }]);
      const w3 = op(s, "write", "w3", log);
      stuck.release(); // late: w2 holds the slot, nothing is passed on
      await tick();
      expect(log).toEqual(["start w2"]);
      w2.end();
      await w2.done;
      await tick();
      expect(log).toEqual(["start w2", "end w2", "start w3"]);
      w3.end();
      await w3.done;
      // a write that ends before its limit sets off no warning
      WRITE_SLOT.maxMs = 30;
      const quick = await s.acquire("write", "insert_row");
      quick.release();
      await new Promise((r) => setTimeout(r, 80));
      expect(logs).toHaveLength(1);
    } finally {
      WRITE_SLOT.maxMs = max;
      setTelemetry(NOOP_TELEMETRY);
    }
  });
});
