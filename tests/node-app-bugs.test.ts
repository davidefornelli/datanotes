import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "../src/core/host";
import { NodeFile, openNodeVault, type NodeHost } from "../src/node/node-app";

const opened: NodeHost[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of opened.splice(0)) h.metadataCache.dispose();
});

function open(files: Record<string, string>): { host: NodeHost; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-app-bugs-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const host = openNodeVault(root);
  opened.push(host);
  return { host, root };
}

describe("atomic writes", () => {
  it("two writes of a file in the same millisecond each use their own temporary file: the last one wins", async () => {
    const { host, root } = open({ "Note.md": "zero\n" });
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000); // the same millisecond for every write
    const f = host.vault.getAbstractFileByPath("Note.md") as NodeFile;
    await Promise.all([host.vault.writeText(f, "one\n"), host.vault.writeText(f, "two\n"), host.vault.adapter.write("Note.md", "three\n")]);
    expect(["one\n", "two\n", "three\n"]).toContain(fs.readFileSync(path.join(root, "Note.md"), "utf8"));
    await Promise.all([host.vault.adapter.write(".store/a.json", "1"), host.vault.adapter.write(".store/a.json", "2")]);
    expect(["1", "2"]).toContain(fs.readFileSync(path.join(root, ".store/a.json"), "utf8"));
    // no temporary file left behind
    expect(fs.readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(fs.readdirSync(path.join(root, ".store"))).toEqual(["a.json"]);
  });

  it("writes and creates a note whose name is near the file system's limit of 255 characters", async () => {
    // the temporary file of a write used to be named after the note: 248 + ~30 characters, refused (ENOENT)
    const name = `${"a".repeat(245)}.md`;
    const { host, root } = open({ [name]: "zero\n" });
    const f = host.vault.getAbstractFileByPath(name) as NodeFile;
    await host.vault.writeText(f, "one\n");
    expect(fs.readFileSync(path.join(root, name), "utf8")).toBe("one\n");
    await host.vault.adapter.write(name, "two\n");
    expect(fs.readFileSync(path.join(root, name), "utf8")).toBe("two\n");
    await host.vault.create(`Folder/${name}`, "three\n");
    expect(fs.readFileSync(path.join(root, "Folder", name), "utf8")).toBe("three\n");
    expect(fs.readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("moving a file", () => {
  it("a file the index does not know is refused before the disk changes", async () => {
    const { host, root } = open({ "A.md": "a\n" });
    fs.writeFileSync(path.join(root, "B.md"), "b\n"); // on disk, not yet seen by the watcher
    await expect(host.vault.move({ path: "B.md", name: "B.md" } as TFile, "C.md")).rejects.toThrow("file not found: B.md");
    expect(fs.existsSync(path.join(root, "B.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "C.md"))).toBe(false);
    // the index and the disk still agree: the watcher adds B.md where it is
    expect(host.vault.syncPath("B.md")).toBe("created");
    expect(host.vault.getAbstractFileByPath("C.md")).toBeNull();
  });
});
