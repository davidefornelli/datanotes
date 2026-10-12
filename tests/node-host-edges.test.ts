import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TFile, TFolder } from "../src/core/host";
import { NodeFile, openNodeVault, resolveInVault, type NodeHost } from "../src/node/node-app";

const opened: NodeHost[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.metadataCache.dispose();
});

function open(files: Record<string, string>, config?: Parameters<typeof openNodeVault>[1]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-host-edges-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const host = openNodeVault(root, config);
  opened.push(host);
  const file = (p: string) => host.vault.getAbstractFileByPath(p) as TFile;
  const disk = (p: string) => fs.existsSync(path.join(root, p));
  return { root, host, file, disk };
}

describe("node host: names", () => {
  it("a file without extension, and the vault root, have the names Obsidian gives them", () => {
    const { host, file } = open({ "Scripts/Makefile": "all:\n", "Notes/v1.2 plan.md": "x" });
    expect(file("Scripts/Makefile")).toMatchObject({ name: "Makefile", basename: "Makefile", extension: "" });
    expect(file("Notes/v1.2 plan.md")).toMatchObject({ basename: "v1.2 plan", extension: "md" });
    expect(host.vault.getRoot().name).toBe("");
    expect(host.vault.getAbstractFileByPath("/")).toBe(host.vault.getRoot());
  });

  it("lists every loaded folder and file", () => {
    const { host } = open({ "People/Carol.md": "c", "Inbox.md": "i" });
    expect(host.vault.getAllLoadedFiles().map((f) => f.path).sort()).toEqual(["", "Inbox.md", "People", "People/Carol.md"]);
  });
});

describe("resolveInVault: every path of the host stays inside the vault", () => {
  it.each([
    ["../outside.md"],
    ["Notes/../../outside.md"],
    ["Notes\\..\\..\\outside.md"],
    ["C:/Windows/win.ini"],
    ["Notes/a\0b.md"],
  ])("refuses %j", (rel) => {
    expect(() => resolveInVault("/vault", rel)).toThrow(`path outside the vault refused: ${rel}`);
  });

  it("keeps ./ and empty segments harmless", () => {
    expect(resolveInVault(path.resolve("/vault"), "./Notes//a.md")).toBe(path.resolve("/vault", "Notes", "a.md"));
    expect(resolveInVault(path.resolve("/vault"), "")).toBe(path.resolve("/vault"));
  });
});

describe("node host: the raw adapter (hidden store)", () => {
  it("lists the vault root and removes a folder, recursively only when asked", async () => {
    const { host, disk } = open({ "Inbox.md": "i", ".datanotes/logs/a.jsonl": "{}\n" });
    const root = await host.vault.adapter.list("");
    expect(root.files).toEqual(["Inbox.md"]);
    expect(root.folders).toEqual([".datanotes"]);
    await expect(host.vault.adapter.rmdir(".datanotes/logs", false)).rejects.toThrow();
    expect(disk(".datanotes/logs/a.jsonl")).toBe(true);
    await host.vault.adapter.rmdir(".datanotes/logs", true);
    expect(disk(".datanotes/logs")).toBe(false);
  });
});

describe("node host: refusals, with Obsidian's messages", () => {
  it("creating a folder that exists, processing or editing a note the vault does not have", async () => {
    const { host } = open({ "People/Carol.md": "c" });
    await expect(host.vault.createFolder("People/")).rejects.toThrow("Folder already exists: People");
    const ghost = { path: "People/Ghost.md", name: "Ghost.md", basename: "Ghost", extension: "md" };
    await expect(host.vault.process(ghost, (t) => t)).rejects.toThrow("file not found: People/Ghost.md");
    await expect(host.fileManager.processFrontMatter(ghost, () => undefined)).rejects.toThrow("file not found: People/Ghost.md");
    await expect(host.fileManager.renameFile(ghost, "People/Spirit.md")).rejects.toThrow("file not found: People/Ghost.md");
  });

  it("moving onto another file is refused; moving to the same path does nothing; a case-only rename is allowed", async () => {
    const { host, file, disk } = open({ "People/Carol.md": "c", "People/Dave.md": "d" });
    await expect(host.vault.move(file("People/Carol.md"), "People/Dave.md")).rejects.toThrow("Destination exists: People/Dave.md");
    expect(await host.vault.move(file("People/Carol.md"), "/People/Carol.md/")).toEqual(new Map());
    expect(await host.vault.move(file("People/Carol.md"), "People/carol.md")).toEqual(new Map([["People/Carol.md", "People/carol.md"]]));
    expect(host.vault.getAbstractFileByPath("People/carol.md")).not.toBeNull();
    expect(disk("People/carol.md")).toBe(true);
  });

  it("moving a file the index does not know yet (written outside, not seen by the watcher) is refused", async () => {
    const { host, root } = open({ "People/Carol.md": "c" });
    fs.writeFileSync(path.join(root, "People/Old.md"), "o");
    const unseen = new NodeFile("People/Old.md", { ctime: 0, mtime: 0, size: 0 });
    await expect(host.vault.move(unseen, "People/New.md")).rejects.toThrow("file not found: People/Old.md");
    expect(host.vault.getAbstractFileByPath("People/New.md")).toBeNull();
  });
});

describe("node host: the index when the disk changed behind it", () => {
  it("a note deleted outside and created again before the watcher noticed stays one file with a fresh stat", async () => {
    const { host, root, file } = open({ "Inbox.md": "old" });
    const before = file("Inbox.md");
    fs.rmSync(path.join(root, "Inbox.md"));
    const again = await host.vault.create("Inbox.md", "new text");
    expect(again).toBe(before);
    expect(again.stat!.size).toBe(8);
    expect(host.vault.getFiles().filter((f) => f.path === "Inbox.md")).toHaveLength(1);
  });

  it("a file reported before its new folder is indexed together with the folder", () => {
    const { host, root } = open({ "Inbox.md": "i" });
    fs.mkdirSync(path.join(root, "New"));
    fs.writeFileSync(path.join(root, "New/a.md"), "a");
    expect(host.vault.syncPath("New/a.md")).toBe("created");
    expect((host.vault.getAbstractFileByPath("New") as TFolder).children.map((c) => c.path)).toEqual(["New/a.md"]);
  });

  it("deleting a file the index never saw removes it from disk without a delete event", async () => {
    const { host, root, disk } = open({ "Inbox.md": "i" });
    fs.writeFileSync(path.join(root, "Unseen.md"), "u");
    const deleted: string[] = [];
    host.vault.on("delete", ((f: { path: string }) => deleted.push(f.path)) as never);
    await host.vault.delete(new NodeFile("Unseen.md", { ctime: 0, mtime: 0, size: 0 }));
    expect(disk("Unseen.md")).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("deleting a folder (force) announces each file inside, then the folder", async () => {
    const { host, disk } = open({ "Old/a.md": "a", "Old/Sub/b.md": "b" });
    const deleted: string[] = [];
    host.vault.on("delete", ((f: { path: string }) => deleted.push(f.path)) as never);
    await host.vault.delete(host.vault.getAbstractFileByPath("Old")!, true);
    expect(deleted.slice(0, -1).sort()).toEqual(["Old/Sub/b.md", "Old/a.md"]); // in the order the disk listed them
    expect(deleted.at(-1)).toBe("Old");
    expect(disk("Old")).toBe(false);
  });
});

describe("node host: trash", () => {
  it("a folder goes to .trash with everything inside; a name taken in the trash gets a number", async () => {
    const { host, disk } = open({ "Old/a.md": "a", "Old/b.md": "b", "Notes/Old.md": "x", ".trash/Old.md": "earlier" });
    const deleted: string[] = [];
    host.vault.on("delete", ((f: { path: string }) => deleted.push(f.path)) as never);
    await host.fileManager.trashFile(host.vault.getAbstractFileByPath("Old") as TFolder);
    expect(disk(".trash/Old/a.md") && disk(".trash/Old/b.md")).toBe(true);
    expect(deleted.sort()).toEqual(["Old", "Old/a.md", "Old/b.md"]);
    expect(host.vault.getAbstractFileByPath("Old/a.md")).toBeNull();
    await host.fileManager.trashFile(host.vault.getAbstractFileByPath("Notes/Old.md")!);
    expect(fs.readFileSync(path.join(host.vault.basePath, ".trash/Old 1.md"), "utf8")).toBe("x");
    expect(fs.readFileSync(path.join(host.vault.basePath, ".trash/Old.md"), "utf8")).toBe("earlier");
  });

  it("the trash numbers a third note of the same name 2", async () => {
    const { host } = open({ "Inbox/Note.md": "third", ".trash/Note.md": "first", ".trash/Note 1.md": "second" });
    await host.fileManager.trashFile(host.vault.getAbstractFileByPath("Inbox/Note.md")!);
    expect(fs.readFileSync(path.join(host.vault.basePath, ".trash/Note 2.md"), "utf8")).toBe("third");
  });
});

describe("node host: changes made outside (syncPath)", () => {
  it("a folder deleted outside drops its files, with a delete event for each", async () => {
    const { host, root } = open({ "Old/a.md": "a", "Old/Sub/b.md": "b", "Inbox.md": "i" });
    const deleted: string[] = [];
    host.vault.on("delete", ((f: { path: string }) => deleted.push(f.path)) as never);
    fs.rmSync(path.join(root, "Old"), { recursive: true });
    expect(host.vault.syncPath("Old")).toBe("deleted");
    expect(deleted.sort()).toEqual(["Old", "Old/Sub/b.md", "Old/a.md"]);
    expect(host.vault.getFiles().map((f) => f.path)).toEqual(["Inbox.md"]);
  });

  it("ignores the vault root, hidden paths and paths that never existed", () => {
    const { host } = open({ "Inbox.md": "i" });
    expect(host.vault.syncPath("")).toBeNull();
    expect(host.vault.syncPath(".obsidian/workspace.json")).toBeNull();
    expect(host.vault.syncPath("Never/There.md")).toBeNull();
  });
});

describe("node host: metadata", () => {
  it("knows the links of each note (none for an unknown one) and frontmatter edits that change nothing write nothing", async () => {
    const { host, file } = open({ "Inbox.md": "[[Carol]] and [[#Today]]\n", "Carol.md": "---\na: 1\n---\nC\n", "Plain.md": "no properties\n" });
    expect(host.metadataCache.linksOf("Inbox.md").map((l) => [l.linkpath, l.subpath])).toEqual([["Carol", ""], ["", "#Today"]]);
    expect(host.metadataCache.linksOf("Nope.md")).toEqual([]);
    expect(host.metadataCache.resolvedLinks["Inbox.md"]).toEqual({ "Carol.md": 1 }); // [[#Today]] is the note itself
    const before = fs.statSync(path.join(host.vault.basePath, "Carol.md")).mtimeMs;
    await host.fileManager.processFrontMatter(file("Carol.md"), (fm) => void (fm.a = 1));
    expect(fs.statSync(path.join(host.vault.basePath, "Carol.md")).mtimeMs).toBe(before);
    expect(host.metadataCache.getFileCache({ path: "Nope.md" } as TFile)).toBeNull();
  });

  it("a note whose frontmatter is not valid YAML has no properties, but its tags and links count", () => {
    const { host, file } = open({ "Broken.md": "---\ntitle: [unclosed\n---\nSee [[Inbox]] #todo\n", "Inbox.md": "i" });
    expect(host.metadataCache.getFileCache(file("Broken.md"))).toEqual({ tags: [{ tag: "#todo" }] });
    expect(host.metadataCache.resolvedLinks["Broken.md"]).toEqual({ "Inbox.md": 1 });
  });

  it("a change reported for a note already gone from disk keeps what the cache knew", () => {
    const { host, file, root } = open({ "Carol.md": "---\na: 1\n---\nC\n" });
    const f = file("Carol.md") as NodeFile;
    fs.rmSync(path.join(root, "Carol.md"));
    expect(() => host.metadataCache.changed(f, false)).not.toThrow();
    expect(host.metadataCache.getFileCache(f)?.frontmatter).toEqual({ a: 1 });
  });

  it("a note without properties stays as written when an edit adds and removes nothing", async () => {
    const { host, file } = open({ "Plain.md": "no properties\n" });
    await host.fileManager.processFrontMatter(file("Plain.md"), (fm) => {
      fm.tmp = 1;
      delete fm.tmp;
    });
    expect(fs.readFileSync(path.join(host.vault.basePath, "Plain.md"), "utf8")).toBe("no properties\n");
  });

  it("removing the last property of a note keeps its body", async () => {
    const { host, file } = open({ "Carol.md": "---\na: 1\n---\nBody\n" });
    await host.fileManager.processFrontMatter(file("Carol.md"), (fm) => void delete fm.a);
    const text = fs.readFileSync(path.join(host.vault.basePath, "Carol.md"), "utf8");
    // an empty `---\n---` block stays, as in Obsidian, and reads back as empty frontmatter
    expect(text).toBe("---\n---\nBody\n");
  });
});
