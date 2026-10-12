import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendLog, logFilePath, pruneLogs } from "../src/core/file-log";
import { isStorePath, storeAppend, storeExists, storeKey, storeList, storePath, storeRead, storeRemove, storeRename, storeWrite } from "../src/core/store";
import type { App } from "../src/core/host";
import { createDbVault } from "./helpers/db-vault";

describe("store paths", () => {
  it("are store:<path>; a vault path, a dot-folder included, is no store path", () => {
    expect(storePath("journal", "2026-10.jsonl")).toBe("store:journal/2026-10.jsonl");
    expect(isStorePath("store:journal/x")).toBe(true);
    expect(isStorePath(".datanotes/journal/x")).toBe(false);
    expect(isStorePath("Datanotes/x.md")).toBe(false);
    expect(storeKey("store:journal/x/")).toBe("journal/x");
    expect(storeKey("store:")).toBe("");
  });
});

describe("the store of a host", () => {
  it("is its own folder, outside the vault", async () => {
    const v = createDbVault({});
    await storeWrite(v.app, "store:journal/2026-10.jsonl", "a\n");
    await storeAppend(v.app, "store:journal/2026-10.jsonl", "b\n");
    expect(fs.readFileSync(path.join(v.storeRoot, "journal", "2026-10.jsonl"), "utf8")).toBe("a\nb\n");
    expect(fs.existsSync(path.join(v.root, ".datanotes"))).toBe(false);
    expect(await storeList(v.app, "store:")).toEqual({ files: [], folders: ["store:journal"] });
    expect(await storeList(v.app, "store:journal")).toEqual({ files: ["store:journal/2026-10.jsonl"], folders: [] });
  });

  it("is the vault's .datanotes/ folder for a host without one (vault.adapter)", async () => {
    const v = createDbVault({});
    const app = { ...v.app, store: undefined } as App;
    await storeWrite(app, "store:journal/2026-10.jsonl", "a\n");
    await storeAppend(app, "store:journal/2026-10.jsonl", "b\n");
    expect(v.read(".datanotes/journal/2026-10.jsonl")).toBe("a\nb\n");
    expect(await storeList(app, "store:journal")).toEqual({ files: ["store:journal/2026-10.jsonl"], folders: [] });
    expect(await storeList(app, "store:")).toEqual({ files: [], folders: ["store:journal"] });
    expect(await storeExists(app, "store:journal/2026-10.jsonl")).toBe(true);
    await storeRemove(app, "store:journal/2026-10.jsonl");
    await storeRemove(app, "store:journal/2026-10.jsonl");
    expect(await storeRead(app, "store:journal/2026-10.jsonl")).toBeNull();
    expect(await storeList(app, "store:none")).toEqual({ files: [], folders: [] });
  });
});

describe("storeRename", () => {
  it("moves a store file into a folder it creates", async () => {
    const v = createDbVault({});
    await storeWrite(v.app, "store:transaction_log/a/00000.json", "{}\n");
    await storeRename(v.app, "store:transaction_log/a/00000.json", "store:trash/2026/a/00000.json");
    expect(await storeRead(v.app, "store:transaction_log/a/00000.json")).toBeNull();
    expect(await storeRead(v.app, "store:trash/2026/a/00000.json")).toBe("{}\n");
  });

  it("refuses a missing source and never overwrites a target", async () => {
    const v = createDbVault({});
    await storeWrite(v.app, "store:a.json", "a");
    await storeWrite(v.app, "store:b.json", "b");
    await expect(storeRename(v.app, "store:none.json", "store:c.json")).rejects.toThrow("file not found: store:none.json");
    await expect(storeRename(v.app, "store:a.json", "store:b.json")).rejects.toThrow("target exists: store:b.json");
    expect(await storeRead(v.app, "store:b.json")).toBe("b");
  });
});

describe("log files of a named process", () => {
  it("go to <day>.<source>.jsonl and are pruned like the others", async () => {
    const v = createDbVault({});
    expect(logFilePath(v.settings, "2026-10-01", "service")).toBe("store:logs/2026-10-01.service.jsonl");
    await appendLog(v.app, v.settings, "2026-10-01", '{"msg":"a"}\n', "service");
    await appendLog(v.app, v.settings, "2026-10-01", '{"msg":"b"}\n', "service");
    await appendLog(v.app, v.settings, "2026-08-01", '{"msg":"old"}\n', "service");
    expect(v.read("store:logs/2026-10-01.service.jsonl")).toBe('{"msg":"a"}\n{"msg":"b"}\n');
    const removed = await pruneLogs(v.app, { ...v.settings, logRetentionDays: 30 }, new Date("2026-10-01T09:00:00Z"));
    expect(removed).toEqual(["store:logs/2026-08-01.service.jsonl"]);
    expect(v.listAll().filter((p) => p.startsWith("store:logs/"))).toEqual(["store:logs/2026-10-01.service.jsonl"]);
  });
});
