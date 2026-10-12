/**
 * The headless host (src/node/node-app.ts) at its edges: how a path counts as present on file
 * systems that ignore case (macOS, Windows: the platform is set by the test, the checks run on
 * this system's files), a case-only move onto another file, and the links after a move whose old
 * path holds a file again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNodeVault, type NodeHost } from "../src/node/node-app";

const opened: NodeHost[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of opened.splice(0)) h.metadataCache.dispose();
});

function open(files: Record<string, string>): { host: NodeHost; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-app-edges-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const host = openNodeVault(root);
  opened.push(host);
  return { host, root };
}

/** Run `fn` with `process.platform` set to `platform`. */
function on<T>(platform: NodeJS.Platform, fn: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...saved, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", saved);
  }
}

describe("a path counts as the folder listing spells it", () => {
  it("macOS: every segment as listed; a segment not listed, or a folder that cannot be read, is not there", () => {
    const { host, root } = open({});
    fs.mkdirSync(path.join(root, "Notes"));
    fs.writeFileSync(path.join(root, "Notes", "Plan.md"), "plan\n");
    fs.writeFileSync(path.join(root, "Notes", "Other.md"), "other\n");
    expect(on("darwin", () => host.vault.syncPath("Notes/Plan.md"))).toBe("created");
    // the listing does not name it (another spelling on disk): not there
    const real = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const names = (real as (p: fs.PathLike, o?: unknown) => string[])(p, o);
      return String(p).endsWith("Notes") ? names.filter((n) => n !== "Other.md") : names;
    }) as typeof fs.readdirSync);
    expect(on("darwin", () => host.vault.syncPath("Notes/Other.md"))).toBeNull();
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    expect(on("darwin", () => host.vault.syncPath("Notes/Other.md"))).toBeNull();
  });

  // two names that differ in case only need a file system that keeps case apart: Linux, not macOS
  it.skipIf(process.platform !== "linux")("Windows: the path as the file system spells it; a spelling in another case is not there", () => {
    const { host, root } = open({});
    fs.mkdirSync(path.join(root, "Notes"));
    fs.writeFileSync(path.join(root, "Notes", "Plan.md"), "plan\n");
    // two more names for the same file: one in another case, one another name altogether
    fs.symlinkSync("Plan.md", path.join(root, "Notes", "plan.md"));
    fs.symlinkSync("Plan.md", path.join(root, "Notes", "Alias.md"));
    expect(on("win32", () => host.vault.syncPath("Notes/Plan.md"))).toBe("created");
    expect(on("win32", () => host.vault.syncPath("Notes/plan.md"))).toBeNull();
    // the real path is another name: the folder listing decides
    expect(on("win32", () => host.vault.syncPath("Notes/Alias.md"))).toBe("created");
  });

  it.skipIf(process.platform === "win32")("Windows: a path whose real path cannot be read is not there", () => {
    const { host, root } = open({});
    fs.writeFileSync(path.join(root, "Plan.md"), "plan\n");
    const native = fs.realpathSync.native;
    fs.realpathSync.native = (() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    }) as unknown as typeof fs.realpathSync.native;
    try {
      expect(on("win32", () => host.vault.syncPath("Plan.md"))).toBeNull();
    } finally {
      fs.realpathSync.native = native;
    }
  });
});

describe("moves", () => {
  it.skipIf(process.platform !== "linux")("a move in case only onto another file (a file system that keeps case apart) is refused", async () => {
    const { host } = open({ "note.md": "lower\n", "Note.md": "upper\n" });
    await expect(host.vault.move(host.vault.getAbstractFileByPath("note.md")!, "Note.md")).rejects.toThrow("Destination exists: Note.md");
  });

  it.skipIf(process.platform !== "linux")("a move in case only onto another name of the same file (a hard link) goes through", async () => {
    const { host, root } = open({ "note.md": "one file, two names\n" });
    fs.linkSync(path.join(root, "note.md"), path.join(root, "Note.md"));
    await host.vault.move(host.vault.getAbstractFileByPath("note.md")!, "Note.md");
    // POSIX rename between two names of one file changes nothing: what counts is that no
    // "Destination exists" refused the move
    expect(fs.readdirSync(root)).toContain("Note.md");
    expect(fs.readFileSync(path.join(root, "Note.md"), "utf8")).toBe("one file, two names\n");
  });

  it("deleting the vault's own folder keeps the root of the index", async () => {
    const { host, root } = open({ "a.md": "a\n" });
    const top = host.vault.getRoot();
    await host.vault.delete(top, true);
    expect(fs.existsSync(root)).toBe(false);
    expect(host.vault.getRoot()).toBe(top);
  });

  it("links after a move whose old path holds a file again: left out unless told, followed where told", async () => {
    const { host, root } = open({ "a.md": "the note that moves\n", "n.md": "see [[a]]\n" });
    fs.renameSync(path.join(root, "a.md"), path.join(root, "b.md"));
    fs.writeFileSync(path.join(root, "a.md"), "another note, under the old name\n");
    host.vault.syncPaths(["a.md", "b.md"]);
    const moves = new Map([["a.md", "b.md"]]);
    expect(await host.fileManager.linksAfterMove(moves)).toEqual([]);
    const asked: string[] = [];
    const plan = await host.fileManager.linksAfterMove(moves, {
      reoccupied: (from, note) => {
        asked.push(`${from} in ${note}`);
        return true;
      },
    });
    expect(asked).toEqual(["a.md in n.md"]);
    expect(plan).toEqual([{ path: "n.md", before: "see [[a]]\n", after: "see [[b]]\n" }]);
  });
});
