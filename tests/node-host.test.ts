import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeVault, type NodeHost } from "../src/node/node-app";
import { NodeWatcher } from "../src/node/watcher";
import type { TFile, TFolder } from "../src/core/host";

const opened: { host: NodeHost; watcher?: NodeWatcher }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.watcher?.stop();
    o.host.metadataCache.dispose();
  }
});

function vaultDir(files: Record<string, string>, appJson?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-host-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  if (appJson) {
    fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(root, ".obsidian", "app.json"), JSON.stringify(appJson));
  }
  return root;
}

function open(files: Record<string, string>, appJson?: Record<string, unknown>) {
  const root = vaultDir(files, appJson);
  const host = openNodeVault(root);
  opened.push({ host });
  const file = (p: string) => host.vault.getAbstractFileByPath(p) as TFile;
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  return { root, host, file, read, app: host.app };
}

const FILES = {
  "People/Carol.md": '---\ntable: person\npartner: "[[People/Dave]]"\ntags: [pals]\n---\nFriend of [[Alice]]. #contact\n',
  "People/Dave.md": "---\ntable: person\n---\nHusband of [[Carol]].\n",
  "People/Alice.md": "See [[People/Carol|my Carol]] e ![[photo.png]].\n",
  "photo.png": "png",
  "Inbox.md": "[[Carol]] [[Nobody]] [x](People/Carol.md)\n",
  ".obsidian/workspace.json": "{}",
  ".datanotes/journal/x.jsonl": "{}",
};

describe("node host: index and metadata", () => {
  it("indexes files and folders like Obsidian (dot entries are not part of the vault)", () => {
    const { host, file } = open(FILES);
    expect(host.vault.getMarkdownFiles().map((f) => f.path).sort()).toEqual(["Inbox.md", "People/Alice.md", "People/Carol.md", "People/Dave.md"]);
    expect(host.vault.getFiles()).toHaveLength(5);
    expect(host.vault.getAbstractFileByPath(".datanotes/journal/x.jsonl")).toBeNull();
    const people = host.vault.getAbstractFileByPath("People") as TFolder;
    expect(people.children.map((c) => c.path).sort()).toEqual(["People/Alice.md", "People/Carol.md", "People/Dave.md"]);
    expect((host.vault.getRoot().children.map((c) => c.path)).sort()).toEqual(["Inbox.md", "People", "photo.png"]);
    expect(file("People/Carol.md")).toMatchObject({ name: "Carol.md", basename: "Carol", extension: "md" });
    expect(file("People/Carol.md").stat!.size).toBeGreaterThan(0);
  });

  it("parses frontmatter and tags, resolves links and backlinks", () => {
    const { host, file } = open(FILES);
    const cache = host.metadataCache.getFileCache(file("People/Carol.md"))!;
    expect(cache.frontmatter).toEqual({ table: "person", partner: "[[People/Dave]]", tags: ["pals"] });
    expect(cache.tags).toEqual([{ tag: "#contact" }]);
    expect(host.metadataCache.resolvedLinks["People/Carol.md"]).toEqual({ "People/Dave.md": 1, "People/Alice.md": 1 });
    expect(host.metadataCache.resolvedLinks["Inbox.md"]).toEqual({ "People/Carol.md": 2 });
    expect(host.metadataCache.unresolvedLinks["Inbox.md"]).toEqual({ Nobody: 1 });
    expect(host.metadataCache.getFirstLinkpathDest("photo.png", "People/Alice.md")!.path).toBe("photo.png");
    expect(host.metadataCache.fileToLinktext!(file("People/Carol.md"), "Inbox.md")).toBe("Carol");
  });

  it("follows the vault's link format from .obsidian/app.json", () => {
    const { host, file } = open(FILES, { newLinkFormat: "absolute" });
    expect(host.metadataCache.fileToLinktext!(file("People/Carol.md"), "Inbox.md")).toBe("People/Carol");
  });
});

describe("node host: writes", () => {
  it("creates, processes and deletes files; the cache follows at once", async () => {
    const { host, app, read, root } = open(FILES);
    const events: string[] = [];
    app.vault.on("create", (f) => events.push(`create ${f.path}`));
    app.vault.on("modify", (f) => events.push(`modify ${f.path}`));
    app.vault.on("delete", (f) => events.push(`delete ${f.path}`));
    const f = await app.vault.create("New/Anna.md", "Friend of [[Carol]]\n");
    expect(host.metadataCache.resolvedLinks["New/Anna.md"]).toEqual({ "People/Carol.md": 1 });
    await app.vault.process(f, (t) => t.replace("Carol", "Nobody"));
    expect(read("New/Anna.md")).toBe("Friend of [[Nobody]]\n");
    expect(host.metadataCache.resolvedLinks["New/Anna.md"]).toEqual({});
    // A new file resolves links that were dangling.
    await app.vault.create("Nobody.md", "");
    expect(host.metadataCache.resolvedLinks["New/Anna.md"]).toEqual({ "Nobody.md": 1 });
    await app.vault.delete(f);
    expect(fs.existsSync(path.join(root, "New/Anna.md"))).toBe(false);
    expect(events).toEqual(["create New", "create New/Anna.md", "modify New/Anna.md", "create Nobody.md", "delete New/Anna.md"]);
    await expect(app.vault.create("Inbox.md", "x")).rejects.toThrow(/exists/);
    expect(fs.readdirSync(path.join(root, "People")).some((n) => n.endsWith(".tmp"))).toBe(false); // atomic writes leave nothing behind
  });

  it("processFrontMatter edits properties and keeps the body", async () => {
    const { app, file, read } = open(FILES);
    await app.fileManager.processFrontMatter(file("People/Dave.md"), (fm) => {
      fm.partner = "[[People/Carol]]";
    });
    expect(read("People/Dave.md")).toBe('---\ntable: person\npartner: "[[People/Carol]]"\n---\nHusband of [[Carol]].\n');
    await app.fileManager.processFrontMatter(file("Inbox.md"), () => {});
    expect(read("Inbox.md")).toBe(FILES["Inbox.md"]);
  });

  it("trash goes to .trash, or deletes with trashOption none", async () => {
    const a = open(FILES);
    await a.app.fileManager.trashFile!(a.file("Inbox.md"));
    expect(fs.existsSync(path.join(a.root, ".trash/Inbox.md"))).toBe(true);
    expect(a.host.vault.getAbstractFileByPath("Inbox.md")).toBeNull();
    const b = open(FILES, { trashOption: "none" });
    await b.app.vault.trash(b.file("Inbox.md"), true);
    expect(fs.existsSync(path.join(b.root, "Inbox.md"))).toBe(false);
    expect(fs.existsSync(path.join(b.root, ".trash"))).toBe(false);
  });
});

describe("node host: rename updates links", () => {
  it("renaming a note rewrites links to it everywhere (body and frontmatter), in the vault's format", async () => {
    const { app, file, read, host } = open(FILES, { newLinkFormat: "absolute" });
    const carol = file("People/Carol.md");
    await app.fileManager.renameFile(carol, "Pals/Carol Lane.md");
    expect(carol.path).toBe("Pals/Carol Lane.md"); // same object, new path (like Obsidian)
    expect(read("People/Dave.md")).toBe("---\ntable: person\n---\nHusband of [[Pals/Carol Lane]].\n");
    expect(read("People/Alice.md")).toBe("See [[Pals/Carol Lane|my Carol]] e ![[photo.png]].\n");
    expect(read("Inbox.md")).toBe("[[Pals/Carol Lane]] [[Nobody]] [x](Pals/Carol%20Lane.md)\n");
    // The moved note's own links still resolve: left as written.
    expect(read("Pals/Carol Lane.md")).toBe(FILES["People/Carol.md"]);
    expect(host.metadataCache.resolvedLinks["Inbox.md"]).toEqual({ "Pals/Carol Lane.md": 2 });
    expect(host.vault.getAbstractFileByPath("People/Carol.md")).toBeNull();
  });

  it("renaming a folder moves everything inside and rewrites links to each file", async () => {
    const { app, read, host } = open(FILES, { newLinkFormat: "absolute" });
    const folder = host.vault.getAbstractFileByPath("People")!;
    await app.fileManager.renameFile(folder, "Folks");
    expect(host.vault.getMarkdownFiles().map((f) => f.path).sort()).toEqual(["Folks/Alice.md", "Folks/Carol.md", "Folks/Dave.md", "Inbox.md"]);
    expect(read("Folks/Carol.md")).toContain('partner: "[[Folks/Dave]]"');
    expect(read("Folks/Alice.md")).toBe("See [[Folks/Carol|my Carol]] e ![[photo.png]].\n");
    expect(read("Inbox.md")).toBe("[[Folks/Carol]] [[Nobody]] [x](Folks/Carol.md)\n");
    expect(host.vault.getAbstractFileByPath("People")).toBeNull();
  });

  it("with the shortest format a unique name stays short", async () => {
    const { app, file, read } = open(FILES);
    await app.fileManager.renameFile(file("People/Carol.md"), "People/Carol L.md");
    expect(read("People/Dave.md")).toBe("---\ntable: person\n---\nHusband of [[Carol L]].\n");
    expect(read("People/Alice.md")).toBe("See [[Carol L|my Carol]] e ![[photo.png]].\n");
  });
});

describe("node host: external changes", () => {
  it("rescan reports changes made by other programs; the engine's own writes are not reported", async () => {
    const { host, root, app } = open(FILES);
    const seen: string[] = [];
    app.vault.on("create", (f) => seen.push(`create ${f.path}`));
    app.vault.on("modify", (f) => seen.push(`modify ${f.path}`));
    app.vault.on("delete", (f) => seen.push(`delete ${f.path}`));
    await app.vault.process(app.vault.getAbstractFileByPath("Inbox.md") as TFile, (t) => `${t}more\n`);
    seen.length = 0;
    expect(host.vault.rescan()).toEqual([]); // our own write
    fs.writeFileSync(path.join(root, "Outside.md"), "[[Carol]]");
    fs.appendFileSync(path.join(root, "People/Dave.md"), "edited by hand\n");
    fs.rmSync(path.join(root, "People/Alice.md"));
    const changed = host.vault.rescan().sort();
    expect(changed).toEqual(["Outside.md", "People/Alice.md", "People/Dave.md"]);
    expect(seen.sort()).toEqual(["create Outside.md", "delete People/Alice.md", "modify People/Dave.md"]);
    expect(host.metadataCache.resolvedLinks["Outside.md"]).toEqual({ "People/Carol.md": 1 });
    expect(host.metadataCache.resolvedLinks["People/Carol.md"]).toEqual({ "People/Dave.md": 1 }); // Alice is gone
  });

  it("the watcher picks up changes (events and polling)", async () => {
    for (const mode of ["events", "poll"] as const) {
      const { host, root } = open(FILES);
      const batches: string[][] = [];
      // the startup rescan catches a change made before the OS stream is up (macOS FSEvents)
      const watcher = new NodeWatcher(host.vault, { mode, intervalMs: 50, debounceMs: 30, startupRescanMs: 100, onChanges: (p) => batches.push(p) });
      opened.push({ host, watcher });
      watcher.start();
      fs.writeFileSync(path.join(root, "Watched.md"), "hello");
      const deadline = Date.now() + 3000;
      while (!host.vault.getAbstractFileByPath("Watched.md") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(host.vault.getAbstractFileByPath("Watched.md"), mode).not.toBeNull();
      expect(batches.flat()).toContain("Watched.md");
      watcher.stop();
    }
  });
});

describe("rescans while the vault writes", () => {
  it("never take the vault's own move, create or delete for a change made outside", async () => {
    const { host } = open({ "A/one.md": "1", "A/two.md": "2", "A/three.md": "3" });
    const v = host.vault as unknown as { rescan(): string[]; on(n: string, cb: (...a: unknown[]) => void): unknown };
    const events: string[] = [];
    for (const name of ["create", "delete", "rename"]) v.on(name, (f: unknown) => events.push(`${name} ${(f as TFile).path}`));
    // Rescan on every turn of the event loop, as a fast poll would, while the writes run.
    let busy = true;
    const scans = (async () => {
      while (busy) {
        v.rescan();
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (const n of ["one", "two", "three"]) {
      await host.app.fileManager.renameFile(host.vault.getAbstractFileByPath(`A/${n}.md`) as TFile, `B/C/${n}.md`);
    }
    const created = await host.vault.create("D/new.md", "x");
    await host.vault.delete(created);
    busy = false;
    await scans;
    expect(events.filter((e) => e.startsWith("delete") && e !== "delete D/new.md")).toEqual([]);
    expect(events.filter((e) => e === "create D/new.md")).toHaveLength(1);
    expect(host.vault.getMarkdownFiles().map((f) => f.path).sort()).toEqual(["B/C/one.md", "B/C/three.md", "B/C/two.md"]);
  });
});
