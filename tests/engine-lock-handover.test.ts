/**
 * The lock handed over to a restart in the same process (LockHolder.handOver): the heartbeat stops,
 * the file stays and names this holder, and `release` removes it only while it does.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultAdapter } from "../src/core/host";
import { LOCK_HEARTBEAT_MS, LockHolder, type EngineLock } from "../src/server/engine-lock";

afterEach(() => {
  vi.useRealTimers();
});

/** An in-memory vault adapter that counts its writes. */
function memAdapter() {
  const files = new Map<string, string>();
  let writes = 0;
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p)!,
    write: async (p: string, d: string) => void (writes++, files.set(p, d)),
    mkdir: async () => undefined,
    remove: async (p: string) => void files.delete(p),
  } as unknown as VaultAdapter;
  return { adapter, files, writes: () => writes };
}

const info = { kind: "service" as const, pid: 4242, host: "pc", port: 27199 };
const FILE = ".datanotes/engine.lock";
const lockOf = (files: Map<string, string>) => JSON.parse(files.get(FILE)!) as EngineLock;

describe("the lock handed over to a restart", () => {
  it("stays on disk naming this holder, and the heartbeat stops", async () => {
    vi.useFakeTimers();
    const m = memAdapter();
    const holder = new LockHolder(m.adapter, ".datanotes", info);
    await holder.acquire();
    const before = lockOf(m.files);
    await holder.handOver();
    expect(lockOf(m.files)).toMatchObject({ pid: 4242, startedAt: before.startedAt });
    const writes = m.writes();
    await vi.advanceTimersByTimeAsync(LOCK_HEARTBEAT_MS * 3);
    expect(m.writes()).toBe(writes);
    await holder.release();
    expect(m.files.has(FILE)).toBe(false);
  });

  it("release after a hand-over leaves the lock of the next holder", async () => {
    const m = memAdapter();
    const first = new LockHolder(m.adapter, ".datanotes", info);
    await first.acquire();
    await first.handOver();
    await new Promise((r) => setTimeout(r, 5));
    const second = new LockHolder(m.adapter, ".datanotes", info);
    await second.acquire();
    const secondStart = lockOf(m.files).startedAt;
    await first.release();
    expect(lockOf(m.files).startedAt).toBe(secondStart);
    await second.release();
    expect(m.files.has(FILE)).toBe(false);
  });
});
