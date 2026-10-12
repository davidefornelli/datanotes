import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultAdapter } from "../src/core/host";
import { isFresh, LOCK_HEARTBEAT_MS, LOCK_STALE_MS, LockHolder, lockPath, readLock, type EngineLock } from "../src/server/engine-lock";

afterEach(() => {
  vi.useRealTimers();
});

/** An in-memory vault adapter; `fail` makes the named calls throw (a full disk, a locked file). */
function memAdapter(fail: Set<string> = new Set()) {
  const files = new Map<string, string>();
  const guard = (op: string) => {
    if (fail.has(op)) throw new Error(`${op} failed`);
  };
  const adapter = {
    exists: async (p: string) => (guard("exists"), files.has(p)),
    read: async (p: string) => (guard("read"), files.get(p)!),
    write: async (p: string, d: string) => void (guard("write"), files.set(p, d)),
    mkdir: async () => guard("mkdir"),
    remove: async (p: string) => void (guard("remove"), files.delete(p)),
  } as unknown as VaultAdapter;
  return { adapter, files, fail };
}

const info = { kind: "service" as const, pid: 4242, host: "pc", port: 27199 };

describe("the engine lock", () => {
  it("lives in the store folder, whatever its trailing slashes", () => {
    expect(lockPath(".datanotes/")).toBe(".datanotes/engine.lock");
    expect(lockPath(".engine")).toBe(".engine/engine.lock");
  });

  it("reads as no lock when the file is missing, half written, or cannot be read", async () => {
    const m = memAdapter();
    expect(await readLock(m.adapter, ".datanotes")).toBeNull();
    m.files.set(".datanotes/engine.lock", '{"kind":"serv');
    expect(await readLock(m.adapter, ".datanotes")).toBeNull();
    m.files.set(".datanotes/engine.lock", JSON.stringify({ ...info, startedAt: "x", heartbeat: "y" }));
    m.fail.add("read");
    expect(await readLock(m.adapter, ".datanotes")).toBeNull();
  });

  it("is fresh while its heartbeat is younger than 30 s", () => {
    const now = Date.parse("2026-10-08T10:00:00Z");
    const lock = (ms: number): EngineLock => ({ ...info, startedAt: "2026-10-08T09:00:00Z", heartbeat: new Date(now - ms).toISOString() });
    expect(isFresh(lock(LOCK_STALE_MS - 1), now)).toBe(true);
    expect(isFresh(lock(LOCK_STALE_MS), now)).toBe(false);
    expect(isFresh(null, now)).toBe(false);
  });
});

describe("LockHolder", () => {
  it("writes the lock, refreshes its heartbeat every 10 s, and removes it on release", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-08T10:00:00Z") });
    const m = memAdapter();
    const holder = new LockHolder(m.adapter, ".datanotes", info);
    await holder.acquire();
    const first = JSON.parse(m.files.get(".datanotes/engine.lock")!) as EngineLock;
    expect(first).toEqual({ ...info, startedAt: "2026-10-08T10:00:00.000Z", heartbeat: "2026-10-08T10:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(LOCK_HEARTBEAT_MS);
    expect(JSON.parse(m.files.get(".datanotes/engine.lock")!).heartbeat).toBe("2026-10-08T10:00:10.000Z");
    await holder.release();
    expect(m.files.has(".datanotes/engine.lock")).toBe(false);
  });

  it("keeps running when a heartbeat cannot be written, and retries at the next one", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-08T10:00:00Z") });
    const m = memAdapter(new Set(["write"]));
    const holder = new LockHolder(m.adapter, ".datanotes", info);
    await holder.acquire(); // does not throw
    expect(m.files.size).toBe(0);
    m.fail.delete("write");
    await vi.advanceTimersByTimeAsync(LOCK_HEARTBEAT_MS);
    expect(JSON.parse(m.files.get(".datanotes/engine.lock")!).heartbeat).toBe("2026-10-08T10:00:10.000Z");
    await holder.release();
  });

  it("on release leaves alone a lock another engine took over, and tolerates a lock already gone", async () => {
    const m = memAdapter();
    const holder = new LockHolder(m.adapter, ".datanotes", info);
    await holder.acquire();
    const other = { ...info, pid: 9999, startedAt: "2026-10-08T11:00:00.000Z", heartbeat: "2026-10-08T11:00:00.000Z" };
    m.files.set(".datanotes/engine.lock", JSON.stringify(other));
    await holder.release();
    expect(JSON.parse(m.files.get(".datanotes/engine.lock")!)).toEqual(other);

    const again = new LockHolder(m.adapter, ".datanotes", info);
    await again.acquire();
    m.fail.add("remove");
    await expect(again.release()).resolves.toBeUndefined();
    await again.release(); // a second release is harmless
  });

  it("on release waits for a write under way, so the lock is not written again after its removal", async () => {
    const m = memAdapter();
    const holder = new LockHolder(m.adapter, ".datanotes", info);
    await holder.acquire();
    // the next write waits until `open` (a slow disk, a heartbeat under way)
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const write = (m.adapter as unknown as { write: (p: string, d: string) => Promise<void> }).write;
    (m.adapter as unknown as { write: (p: string, d: string) => Promise<void> }).write = async (p, d) => {
      await gate;
      await write(p, d);
    };
    const setPort = holder.setPort(1234);
    const released = holder.release();
    open();
    await Promise.all([setPort, released]);
    expect(m.files.has(".datanotes/engine.lock")).toBe(false);
  });
});
