/**
 * The headless host's start: one walk of the vault without blocking (folders listed and files
 * stat-ed many at a time), the notes read many at a time, the same index as the walk that blocked
 * gave; the walk also finds the temporary files of renames a crash cut short. The lists of files
 * are kept until a file comes, goes or moves, and the metadata of a note is the same object on
 * every call, as Obsidian gives it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "../src/core/host";
import { createNodeHost, openNodeVault, openNodeVaultAsync, type NodeHost } from "../src/node/node-app";

const opened: NodeHost[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.metadataCache.dispose();
  vi.restoreAllMocks();
});

function vaultWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-host-start-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const VAULT = {
  "Welcome.md": "Start at [[Projects/Apollo]] and [[Ada]].\n",
  "People/Ada.md": "---\nname: Ada\ntags: [person]\n---\nWorks on [[Apollo]] #team\n",
  "People/Bob.md": "---\nname: Bob\nfriend: \"[[Ada]]\"\n---\nSee ![[diagram.png]] and [[Missing note]].\n",
  "Projects/Apollo.md": "---\nstatus: active\n---\n# Apollo\nLead: [[People/Ada|Ada]]\n",
  "Projects/Deep/Plan.md": "---\ntable: [broken\n---\nA plan with front matter YAML cannot read.\n",
  "Projects/diagram.png": "png",
  "Archive/Old.md": "No front matter, a link to [Apollo](../Projects/Apollo.md).\n",
  ".obsidian/app.json": "{}",
  "People/.hidden.md": "a dot-file is not part of the vault",
};

function open(root: string, sync: boolean): NodeHost | Promise<NodeHost> {
  return sync ? openNodeVault(root) : openNodeVaultAsync(root);
}

describe("the start's walk without blocking", () => {
  it("gives the index the blocking walk gives: the same files, folders, order, stats, metadata and links", async () => {
    const root = vaultWith(VAULT);
    const a = (await open(root, true)) as NodeHost;
    const b = await open(root, false);
    opened.push(a, b);
    const paths = (h: NodeHost) => h.vault.getAllLoadedFiles().map((f) => f.path);
    expect(paths(b)).toEqual(paths(a));
    expect(b.vault.getFiles().map((f) => [f.path, f.stat])).toEqual(a.vault.getFiles().map((f) => [f.path, f.stat]));
    expect(b.vault.getMarkdownFiles().map((f) => f.path)).toEqual(a.vault.getMarkdownFiles().map((f) => f.path));
    expect(b.vault.getMarkdownFiles()).toHaveLength(6); // the dot-file and dot-folder left out
    for (const f of a.vault.getMarkdownFiles()) expect(b.metadataCache.getFileCache(f)).toEqual(a.metadataCache.getFileCache(f));
    expect(b.metadataCache.resolvedLinks).toEqual(a.metadataCache.resolvedLinks);
    expect(JSON.stringify(Object.keys(b.metadataCache.resolvedLinks))).toBe(JSON.stringify(Object.keys(a.metadataCache.resolvedLinks)));
    expect(b.metadataCache.unresolvedLinks).toEqual(a.metadataCache.unresolvedLinks);
    expect(b.metadataCache.verifyLinks()).toEqual([]);
    expect(b.metadataCache.getFileCache(b.vault.getAbstractFileByPath("People/Ada.md") as TFile)).toEqual({ frontmatter: { name: "Ada", tags: ["person"] }, tags: [{ tag: "#team" }] });
    // the walk sees every file's id (`<device>:<inode>`), kept for the index on disk only
    expect(b.vault.walkIds).toBeNull();
    const c = createNodeHost(root);
    opened.push(c);
    await c.vault.scan();
    expect([...c.vault.walkIds!.keys()]).toEqual(b.vault.getFiles().map((f) => f.path));
    const st = fs.statSync(path.join(root, "People", "Ada.md"));
    expect(c.vault.walkIds!.get("People/Ada.md")).toBe(`${st.dev}:${st.ino}`);
    expect(c.vault.fileId("People/Ada.md")).toBe(`${st.dev}:${st.ino}`);
    c.vault.walkIds = null;
    expect(c.vault.fileId("People/Ada.md")).toBe(`${st.dev}:${st.ino}`); // from a stat now
    expect(c.vault.fileId("People/None.md")).toBeNull();
  });

  it("reads the notes many at a time, each once, and hands them to the engine's file cache", async () => {
    const root = vaultWith(VAULT);
    const read = vi.spyOn(fs.promises, "readFile");
    const h = await openNodeVaultAsync(root);
    opened.push(h);
    const notes = read.mock.calls.map(([p]) => path.relative(root, String(p)).split(path.sep).join("/")).sort();
    expect(notes).toEqual(h.vault.getMarkdownFiles().map((f) => f.path).sort());
    expect(h.metadataCache.startTexts).toBeNull();
  });

  it("leaves out a note gone between the walk and its read: the watcher reports it", async () => {
    const root = vaultWith({ "a.md": "A", "b.md": "B" });
    const h = await openNodeVaultAsync(root);
    opened.push(h);
    fs.rmSync(path.join(root, "b.md"));
    await h.metadataCache.indexAllAsync(1);
    expect(h.metadataCache.getFileCache(h.vault.getAbstractFileByPath("a.md") as TFile)).toEqual({ tags: [] });
    expect(h.metadataCache.getFileCache(h.vault.getAbstractFileByPath("b.md") as TFile)).toBeNull();
  });

  it("finds the temporary files of renames a crash cut short; they are finished from that list, without another walk", async () => {
    const root = vaultWith({ "Notes/Other.md": "other" });
    const write = (rel: string, text: string) => fs.writeFileSync(path.join(root, ...rel.split("/")), text);
    write("Notes/.datanotes-rename-99-1--plan.md", "plan");
    write(".datanotes-rename-99-2--Top.md", "top");
    write("Notes/.datanotes-rename-99-3--Other.md", "a file has that name by now");
    fs.mkdirSync(path.join(root, ".trash"));
    write(".trash/.datanotes-rename-99-5--Trashed.md", "in a dot-folder: not the vault's");
    const h = await openNodeVaultAsync(root);
    opened.push(h);
    const { renameTemps } = await h.vault.scan();
    expect(renameTemps.sort()).toEqual([".datanotes-rename-99-2--Top.md", "Notes/.datanotes-rename-99-1--plan.md", "Notes/.datanotes-rename-99-3--Other.md"]);
    const readdir = vi.spyOn(fs, "readdirSync");
    const r = h.vault.recoverRenames([...renameTemps, "Notes/.datanotes-rename-99-6--gone.md"]);
    expect(readdir).not.toHaveBeenCalled();
    expect([r.recovered.sort(), r.left]).toEqual([["Notes/plan.md", "Top.md"], ["Notes/.datanotes-rename-99-3--Other.md"]]);
    expect(fs.readFileSync(path.join(root, "Notes", "plan.md"), "utf8")).toBe("plan");
  });

  it("refuses a vault folder that is gone", async () => {
    const root = path.join(os.tmpdir(), `node-host-start-none-${process.pid}`);
    await expect(openNodeVaultAsync(root)).rejects.toThrow(/ENOENT/);
  });
});

describe("the lists of files and the metadata", () => {
  it("are the same list until a file comes, goes or moves", async () => {
    const root = vaultWith({ "a.md": "A", "img.png": "x" });
    const h = await openNodeVaultAsync(root);
    opened.push(h);
    const md = h.vault.getMarkdownFiles();
    const all = h.vault.getFiles();
    expect(h.vault.getMarkdownFiles()).toBe(md);
    expect(h.vault.getFiles()).toBe(all);
    const a = h.vault.getAbstractFileByPath("a.md") as TFile;
    await h.vault.process(a, () => "A2"); // the same files: the same lists
    expect(h.vault.getMarkdownFiles()).toBe(md);
    await h.vault.create("b.md", "B");
    const md2 = h.vault.getMarkdownFiles();
    expect(md2.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect(md.map((f) => f.path)).toEqual(["a.md"]); // a list given before stays as it was
    await h.fileManager.renameFile(a, "c.md");
    expect(h.vault.getMarkdownFiles().map((f) => f.path)).toEqual(["b.md", "c.md"]);
    await h.vault.delete(h.vault.getAbstractFileByPath("img.png")!);
    expect(h.vault.getFiles().map((f) => f.path)).toEqual(["b.md", "c.md"]);
  });

  it("a note's metadata is the same object on every call, a new one once it changes", async () => {
    const root = vaultWith({ "a.md": "---\nk: 1\n---\nA\n" });
    const h = await openNodeVaultAsync(root);
    opened.push(h);
    const a = h.vault.getAbstractFileByPath("a.md") as TFile;
    const first = h.metadataCache.getFileCache(a);
    expect(h.metadataCache.getFileCache(a)).toBe(first);
    await h.vault.process(a, () => "---\nk: 2\n---\nA\n");
    expect(h.metadataCache.getFileCache(a)).not.toBe(first);
    expect(h.metadataCache.getFileCache(a)?.frontmatter).toEqual({ k: 2 });
  });
});
