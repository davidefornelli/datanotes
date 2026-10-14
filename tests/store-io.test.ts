/**
 * How the engine writes its store: each folder made once (no probe before every write), appends
 * to the files it wrote without asking whether they exist, the files written handed to the host's
 * `sync` once per hold of the write lock (the setting `storeSync`), binary files where the host
 * holds them, and the headless host's adapter that does all of it on a folder of the disk.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, StoreAdapter } from "../src/core/host";
import { mergeWithDefaults } from "../src/core/settings";
import { onStoreChange, storeAppend, storeFlush, storeHoldsBinary, storeReadBinary, storeRemove, storeRename, storeWrite, storeWriteBinary } from "../src/core/store";
import { withLogLock } from "../src/core/transaction-log";
import { nodeStoreFiles } from "../src/node/store-files";
import { folderStore } from "./helpers/db-vault";

afterEach(() => vi.restoreAllMocks());

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-store-io-"));
}

/** An app whose store is `adapter`, its calls counted by method. */
function counted(adapter: StoreAdapter): { app: App; calls: string[] } {
  const calls: string[] = [];
  const spied = Object.fromEntries(
    Object.entries(adapter).map(([k, fn]) => [k, typeof fn === "function" ? (...a: unknown[]) => (calls.push(`${k} ${String(a[0])}`), (fn as (...x: unknown[]) => unknown)(...a)) : fn]),
  ) as unknown as StoreAdapter;
  return { app: { store: spied } as unknown as App, calls };
}

describe("store writes", () => {
  it("make each folder once: a later write into it asks nothing first", async () => {
    const { app, calls } = counted(folderStore(tmp()));
    await storeWrite(app, "store:transaction_log/t/1.json", "a");
    expect(calls).toEqual(["exists transaction_log/t", "exists transaction_log", "mkdir transaction_log", "mkdir transaction_log/t", "write transaction_log/t/1.json"]);
    calls.length = 0;
    await storeWrite(app, "store:transaction_log/t/2.json", "b");
    await storeAppend(app, "store:transaction_log/t/2.json", "c");
    expect(calls).toEqual(["write transaction_log/t/2.json", "append transaction_log/t/2.json"]);
  });

  it("make a folder removed by hand again, and append to a file removed by hand as to a new one", async () => {
    const dir = tmp();
    const { app } = counted(folderStore(dir));
    await storeWrite(app, "store:journal/2026-10.jsonl", "a\n");
    fs.rmSync(path.join(dir, "journal"), { recursive: true });
    await storeAppend(app, "store:journal/2026-10.jsonl", "b\n");
    expect(fs.readFileSync(path.join(dir, "journal", "2026-10.jsonl"), "utf8")).toBe("b\n");
    fs.rmSync(path.join(dir, "journal"), { recursive: true });
    await storeWrite(app, "store:journal/2026-11.jsonl", "c\n");
    expect(fs.readFileSync(path.join(dir, "journal", "2026-11.jsonl"), "utf8")).toBe("c\n");
  });

  it("a failed append of a file that is still there is the caller's error", async () => {
    const adapter = folderStore(tmp());
    const app = { store: adapter } as unknown as App;
    await storeWrite(app, "store:changes/a.jsonl", "a\n");
    vi.spyOn(adapter, "append").mockRejectedValue(new Error("EBUSY: resource busy or locked"));
    await expect(storeAppend(app, "store:changes/a.jsonl", "b\n")).rejects.toThrow("EBUSY");
  });

  it("are told to the store's listeners, by store path", async () => {
    const app = { store: folderStore(tmp()) } as unknown as App;
    const seen: string[] = [];
    const off = onStoreChange(app, (p) => seen.push(p));
    await storeWrite(app, "store:journal/x.jsonl", "a");
    await storeRename(app, "store:journal/x.jsonl", "store:journal/y.jsonl");
    await storeRemove(app, "store:journal/y.jsonl");
    off();
    await storeWrite(app, "store:journal/z.jsonl", "a");
    expect(seen).toEqual(["store:journal/x.jsonl", "store:journal/x.jsonl", "store:journal/y.jsonl", "store:journal/y.jsonl"]);
  });
});

describe("the store's durability", () => {
  it("syncs the files a hold of the write lock wrote, once, at its end (log records are not synced)", async () => {
    const synced: string[][] = [];
    const app = { store: { ...folderStore(tmp()), sync: async (paths: readonly string[]) => void synced.push([...paths]) } } as unknown as App;
    await withLogLock(app, async () => {
      await storeWrite(app, "store:transaction_log/t/1.json", "a");
      await storeAppend(app, "store:journal/2026-10.jsonl", "a\n");
      await storeAppend(app, "store:journal/2026-10.jsonl", "b\n");
      await storeAppend(app, "store:logs/2026-10-01.service.jsonl", "x\n");
      expect(synced).toEqual([]);
    });
    expect(synced).toEqual([["transaction_log/t/1.json", "journal/2026-10.jsonl"]]);
    await withLogLock(app, async () => undefined);
    expect(synced).toHaveLength(1); // nothing written: nothing synced
  });

  it("a sync that fails keeps its files for the next one", async () => {
    let fail = true;
    const synced: string[][] = [];
    const app = {
      store: {
        ...folderStore(tmp()),
        sync: async (paths: readonly string[]) => {
          if (fail) throw new Error("EIO: i/o error");
          synced.push([...paths]);
        },
      },
    } as unknown as App;
    await storeWrite(app, "store:journal/a.jsonl", "a");
    await expect(storeFlush(app)).rejects.toThrow("EIO");
    fail = false;
    await storeWrite(app, "store:journal/b.jsonl", "b");
    await storeFlush(app);
    expect(synced.map((s) => s.sort())).toEqual([["journal/a.jsonl", "journal/b.jsonl"]]);
  });

  it("binary files only where the host holds them", async () => {
    const plain = { store: folderStore(tmp()) } as unknown as App;
    expect(storeHoldsBinary(plain)).toBe(false);
    expect(await storeReadBinary(plain, "store:x.bin")).toBeNull();
    const dir = tmp();
    const app = { store: nodeStoreFiles(dir) } as unknown as App;
    expect(storeHoldsBinary(app)).toBe(true);
    await storeWriteBinary(app, "store:parts/a.bin", new Uint8Array([1, 2, 255]).buffer);
    expect([...new Uint8Array((await storeReadBinary(app, "store:parts/a.bin"))!)]).toEqual([1, 2, 255]);
    expect(await storeReadBinary(app, "store:parts/missing.bin")).toBeNull();
  });

  it("the setting storeSync: operation by default, off as asked, anything else the default", () => {
    expect(mergeWithDefaults({}).storeSync).toBe("operation");
    expect(mergeWithDefaults({ storeSync: "off" }).storeSync).toBe("off");
    expect(mergeWithDefaults({ storeSync: "always" as never }).storeSync).toBe("operation");
    expect(mergeWithDefaults({}).transactionLogFormat).toBe("segments");
    expect(mergeWithDefaults({ transactionLogFormat: "segments" }).transactionLogFormat).toBe("segments");
    expect(mergeWithDefaults({ transactionLogFormat: "sqlite" as never }).transactionLogFormat).toBe("segments");
  });
});

describe("the headless host's store files", () => {
  it("writes atomically, appends, and makes a folder removed by hand again", async () => {
    const dir = tmp();
    const s = nodeStoreFiles(dir);
    await s.write("journal/a.jsonl", "a\n");
    await s.append("journal/a.jsonl", "b\n");
    expect(fs.readFileSync(path.join(dir, "journal", "a.jsonl"), "utf8")).toBe("a\nb\n");
    expect(fs.readdirSync(path.join(dir, "journal"))).toEqual(["a.jsonl"]); // no temporary file left
    fs.rmSync(path.join(dir, "journal"), { recursive: true });
    await s.append("journal/a.jsonl", "c\n");
    fs.rmSync(path.join(dir, "journal"), { recursive: true });
    await s.write("journal/b.jsonl", "d\n");
    expect(fs.readdirSync(path.join(dir, "journal"))).toEqual(["b.jsonl"]);
    await expect(s.append("../outside.txt", "x")).rejects.toThrow("path outside the vault refused");
  });

  it("syncs each file written (and, on POSIX systems, its folder), unless the setting says off", async () => {
    const dir = tmp();
    let policy: "operation" | "off" = "operation";
    const s = nodeStoreFiles(dir, { sync: () => policy, platform: "linux" });
    await s.write("journal/a.jsonl", "a\n");
    await s.write("transaction_log/t/1.json", "{}");
    const opened: string[] = [];
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (p, flags) => {
      opened.push(`${path.relative(dir, String(p)).split(path.sep).join("/")} ${String(flags)}`);
      return open(p, flags);
    });
    await s.sync!(["journal/a.jsonl", "transaction_log/t/1.json", "journal/a.jsonl", "journal/gone.jsonl"]);
    expect(opened.sort()).toEqual(["journal r", "journal/a.jsonl r+", "journal/gone.jsonl r+", "transaction_log/t r", "transaction_log/t/1.json r+"]);
    opened.length = 0;
    await nodeStoreFiles(dir, { platform: "win32" }).sync!(["journal/a.jsonl"]);
    expect(opened).toEqual(["journal/a.jsonl r+"]); // Windows opens no folder
    opened.length = 0;
    policy = "off";
    await s.sync!(["journal/a.jsonl"]);
    expect(opened).toEqual([]);
  });
});

describe("a store whose host does not make folders on a write", () => {
  it("a write into a folder removed by hand makes it again, once", async () => {
    const dir = tmp();
    const plain = folderStore(dir);
    const strict: StoreAdapter = {
      ...plain,
      write: async (p, d) => {
        if (!fs.existsSync(path.dirname(path.join(dir, p)))) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
        return plain.write(p, d);
      },
    };
    const app = { store: strict } as unknown as App;
    await storeWrite(app, "store:journal/a/x.jsonl", "a");
    fs.rmSync(path.join(dir, "journal"), { recursive: true });
    await storeWrite(app, "store:journal/a/y.jsonl", "b");
    expect(fs.readFileSync(path.join(dir, "journal", "a", "y.jsonl"), "utf8")).toBe("b");
    // a failure that is no missing folder is the caller's
    const failing = { store: { ...strict, write: async () => Promise.reject(new Error("EACCES: permission denied")) } } as unknown as App;
    await expect(storeWrite(failing, "store:journal/a/z.jsonl", "c")).rejects.toThrow("EACCES");
  });
});
