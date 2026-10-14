import { afterEach, describe, expect, it, vi } from "vitest";

const before = process.env.UV_THREADPOOL_SIZE;
afterEach(() => {
  if (before === undefined) delete process.env.UV_THREADPOOL_SIZE;
  else process.env.UV_THREADPOOL_SIZE = before;
  vi.resetModules();
});

describe("the thread pool of the datanotes command", () => {
  it("gets 16 threads when the environment sets none", async () => {
    delete process.env.UV_THREADPOOL_SIZE;
    const { THREAD_POOL_SIZE } = await import("../src/node/threadpool");
    expect(THREAD_POOL_SIZE).toBe(16);
    expect(process.env.UV_THREADPOOL_SIZE).toBe("16");
  });

  it("keeps the size the user set", async () => {
    process.env.UV_THREADPOOL_SIZE = "6";
    await import("../src/node/threadpool");
    expect(process.env.UV_THREADPOOL_SIZE).toBe("6");
  });
});
