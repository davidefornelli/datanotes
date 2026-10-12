/**
 * The headless host and notes renamed or moved by other programs: one note gone and one new with
 * its text, seen together (a batch of the watcher, a comparison of the whole tree), is announced as
 * a rename, as Obsidian announces its own; a rename in case only too, whichever of its two paths is
 * reported, so the index keeps one path. The engine's own renames in case only go through a
 * temporary name. `linksAfterMove` gives the links a hand move left behind, as `renameFile` would
 * have rewritten them. Every test holds on file systems that ignore case (Windows, macOS) and on
 * those that do not (Linux).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../src/core/file-cache";
import type { TFile } from "../src/core/host";
import { openNodeVault, temporaryName, type NodeHost } from "../src/node/node-app";

/** Texts long enough to pair a note by its text (32 characters or more). */
const ADA_TEXT = "Ada Lovelace, mathematician and writer.\n";
const SAME = "The same template text in two notes.\n";

const opened: NodeHost[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.metadataCache.dispose();
});

function open(initial: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-host-moves-"));
  const abs = (rel: string) => path.join(root, ...rel.split("/"));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  };
  for (const [rel, text] of Object.entries(initial)) write(rel, text);
  const host = openNodeVault(root);
  opened.push(host);
  const events: string[] = [];
  for (const name of ["create", "modify", "delete"]) host.vault.on(name as "create", ((f: { path: string }) => void events.push(`${name} ${f.path}`)) as never);
  host.vault.on("rename", ((f: { path: string }, old: string) => void events.push(`rename ${old} -> ${f.path}`)) as never);
  const move = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
    fs.renameSync(abs(from), abs(to));
  };
  const file = (p: string) => host.vault.getAbstractFileByPath(p) as TFile | null;
  const files = () => host.vault.getFiles().map((f) => f.path).sort();
  return { root, abs, host, events, write, move, file, files };
}

describe("node host: a note moved by another program is a rename", () => {
  it("seen together, a note gone and a new one with its text: one rename, the same file, its metadata and links follow", () => {
    const v = open({ "People/Ada.md": "---\nname: Ada\n---\nSee [[Bob]], her friend.\n", "People/Bob.md": "b", "Notes/Index.md": "[[Ada]]" });
    const ada = v.file("People/Ada.md");
    v.move("People/Ada.md", "People/Ada King.md");
    expect(v.host.vault.syncPaths(["People/Ada.md", "People/Ada King.md"]).sort()).toEqual(["People/Ada King.md", "People/Ada.md"]);
    expect(v.events).toEqual(["rename People/Ada.md -> People/Ada King.md"]);
    expect(v.file("People/Ada King.md")).toBe(ada);
    expect(v.host.metadataCache.getFileCache(ada!)?.frontmatter).toEqual({ name: "Ada" });
    expect([v.host.metadataCache.hashOf("People/Ada King.md") !== undefined, v.host.metadataCache.hashOf("People/Ada.md")]).toEqual([true, undefined]);
    expect(v.host.metadataCache.resolvedLinks["People/Ada King.md"]).toEqual({ "People/Bob.md": 1 });
    expect(v.files()).toEqual(["Notes/Index.md", "People/Ada King.md", "People/Bob.md"]);
  });

  it("moved into a new folder: the folders are announced first, then the rename; the folder's other notes are created", () => {
    const v = open({ "People/Ada.md": ADA_TEXT, "People/Bob.md": "b" });
    v.move("People/Ada.md", "Archive/2026/Ada.md");
    v.write("Archive/2026/Other.md", "other");
    v.write("Archive/.sync-state", "a dot-file: no note of the vault");
    v.host.vault.syncPaths(["People/Ada.md", "Archive"]); // the operating system reports the new top folder
    expect(v.events).toEqual(["create Archive", "create Archive/2026", "rename People/Ada.md -> Archive/2026/Ada.md", "create Archive/2026/Other.md"]);
    expect(v.files()).toEqual(["Archive/2026/Ada.md", "Archive/2026/Other.md", "People/Bob.md"]);
  });

  it("stays a delete and a create when the text changed too, when two notes gone had the same text, or when a whole folder moved", () => {
    const v = open({ "People/Ada.md": "Ada", "A.md": SAME, "B.md": SAME, "Old/x.md": "x", "Keep.md": "k" });
    v.move("People/Ada.md", "People/Ada King.md");
    v.write("People/Ada King.md", "Ada, edited");
    v.host.vault.syncPaths(["People/Ada.md", "People/Ada King.md"]);
    expect(v.events.splice(0).sort()).toEqual(["create People/Ada King.md", "delete People/Ada.md"]);
    v.move("A.md", "C.md");
    fs.rmSync(v.abs("B.md"));
    v.host.vault.syncPaths(["A.md", "B.md", "C.md"]);
    expect(v.events.splice(0).sort()).toEqual(["create C.md", "delete A.md", "delete B.md"]);
    v.move("Old", "New");
    v.host.vault.syncPaths(["Old", "New"]);
    expect(v.events.splice(0).sort()).toEqual(["create New", "create New/x.md", "delete Old", "delete Old/x.md"]);
  });

  it("the whole tree compared (poll mode, start): a moved note is a rename", () => {
    const v = open({ "People/Ada.md": ADA_TEXT, "Archive/Keep.md": "k" });
    v.move("People/Ada.md", "Archive/Ada.md");
    expect(v.host.vault.rescan().sort()).toEqual(["Archive/Ada.md", "People/Ada.md"]);
    expect(v.events).toEqual(["rename People/Ada.md -> Archive/Ada.md"]);
  });
});

describe("node host: a rename in case only by another program", () => {
  it("both paths reported: a rename; the index keeps one path", () => {
    const v = open({ "Notes/Plan.md": "plan" });
    v.move("Notes/Plan.md", "Notes/plan.md");
    v.host.vault.syncPaths(["Notes/Plan.md", "Notes/plan.md"]);
    expect(v.events).toEqual(["rename Notes/Plan.md -> Notes/plan.md"]);
    expect(v.files()).toEqual(["Notes/plan.md"]);
  });

  it("only the new path reported, or only the old one when the name came back (a git checkout): still a rename, one path", () => {
    const v = open({ "Notes/Plan.md": "plan" });
    v.move("Notes/Plan.md", "Notes/plan.md");
    expect(v.host.vault.syncPath("Notes/plan.md")).toBe("renamed");
    expect(v.files()).toEqual(["Notes/plan.md"]);
    v.move("Notes/plan.md", "Notes/Plan.md");
    expect(v.host.vault.syncPath("Notes/Plan.md")).toBe("renamed");
    expect(v.files()).toEqual(["Notes/Plan.md"]);
    expect(v.events).toEqual(["rename Notes/Plan.md -> Notes/plan.md", "rename Notes/plan.md -> Notes/Plan.md"]);
  });

  it("with an edit at once: a rename, then a modify", () => {
    const v = open({ "Notes/Plan.md": "plan" });
    v.move("Notes/Plan.md", "Notes/plan.md");
    v.write("Notes/plan.md", "plan, edited");
    v.host.vault.syncPaths(["Notes/Plan.md", "Notes/plan.md"]);
    expect(v.events).toEqual(["rename Notes/Plan.md -> Notes/plan.md", "modify Notes/plan.md"]);
    expect(v.host.metadataCache.hashOf("Notes/plan.md")).toBe(contentHash("plan, edited")); // read again
  });
});

describe("node host: notes paired by their text", () => {
  it("only a note of 32 characters or more that kept its name or its folder; announced as made by another program", () => {
    const LONG = (n: number) => `Note ${n}: a text long enough to be recognized.\n`;
    const v = open({ "Inbox/Empty.md": "", "Inbox/Todo.md": "TODO, later", "Inbox/Idea.md": LONG(1), "Inbox/Plan.md": LONG(2), "Inbox/Same.md": LONG(3), "Archive/Keep.md": LONG(4) });
    const infos: unknown[] = [];
    v.host.vault.on("rename", ((_f: unknown, _old: string, info: unknown) => void infos.push(info)) as never);
    // empty or short: the same text as many notes (a template), not the same note
    v.move("Inbox/Empty.md", "Archive/Empty.md");
    v.move("Inbox/Todo.md", "Archive/Todo.md");
    v.host.vault.syncPaths(["Inbox/Empty.md", "Inbox/Todo.md", "Archive/Empty.md", "Archive/Todo.md"]);
    expect(v.events.splice(0).sort()).toEqual(["create Archive/Empty.md", "create Archive/Todo.md", "delete Inbox/Empty.md", "delete Inbox/Todo.md"]);
    // neither its name nor its folder kept: another note with the same text
    v.move("Inbox/Idea.md", "Archive/Other name.md");
    v.host.vault.syncPaths(["Inbox/Idea.md", "Archive/Other name.md"]);
    expect(v.events.splice(0).sort()).toEqual(["create Archive/Other name.md", "delete Inbox/Idea.md"]);
    // its name kept in another folder, or another name in its folder: renamed
    v.move("Inbox/Plan.md", "Archive/Plan.md");
    v.move("Inbox/Same.md", "Inbox/Same, renamed.md");
    v.host.vault.syncPaths(["Inbox/Plan.md", "Archive/Plan.md", "Inbox/Same.md", "Inbox/Same, renamed.md"]);
    expect(v.events.splice(0).sort()).toEqual(["rename Inbox/Plan.md -> Archive/Plan.md", "rename Inbox/Same.md -> Inbox/Same, renamed.md"]);
    expect(infos).toEqual([{ external: true }, { external: true }]);
  });
});

describe("node host: a rename in case only cut short by a crash", () => {
  it("the temporary name ends with the target's, unless the name would be too long", () => {
    expect(temporaryName("plan.md")).toMatch(/^\.datanotes-rename-\d+-\d+--plan\.md$/);
    expect(temporaryName(`${"x".repeat(250)}.md`)).toMatch(/^\.datanotes-rename-\d+-\d+$/);
  });

  it("recoverRenames puts a file left under its temporary name where it was going, and leaves one it cannot place", () => {
    const v = open({ "Notes/Other.md": "other" });
    v.write("Notes/.datanotes-rename-99-1--plan.md", "plan"); // a crash between the two renames
    v.write(".datanotes-rename-99-2--Top.md", "top");
    v.write("Notes/.datanotes-rename-99-3--Other.md", "a file has that name by now");
    v.write("Notes/.datanotes-rename-99-4", "no target in the name");
    const r = v.host.vault.recoverRenames();
    expect([r.recovered.sort(), r.left.sort()]).toEqual([
      ["Notes/plan.md", "Top.md"],
      ["Notes/.datanotes-rename-99-3--Other.md", "Notes/.datanotes-rename-99-4"],
    ]);
    expect([fs.readFileSync(v.abs("Notes/plan.md"), "utf8"), fs.readFileSync(v.abs("Top.md"), "utf8"), fs.readFileSync(v.abs("Notes/Other.md"), "utf8")]).toEqual(["plan", "top", "other"]);
  });
});

describe("node host: the engine's own renames in case only", () => {
  it("go through a temporary name: one rename, one path, the new name on disk, links follow", async () => {
    const v = open({ "Notes/Plan.md": "plan", "Notes/Index.md": "Next: [[Plan]].\n" });
    await v.host.fileManager.renameFile(v.file("Notes/Plan.md")!, "Notes/plan.md");
    expect(v.events.filter((e) => e.startsWith("rename"))).toEqual(["rename Notes/Plan.md -> Notes/plan.md"]);
    expect(fs.readdirSync(v.abs("Notes")).sort()).toEqual(["Index.md", "plan.md"]);
    expect(v.files()).toEqual(["Notes/Index.md", "Notes/plan.md"]);
    expect(fs.readFileSync(v.abs("Notes/Index.md"), "utf8")).toBe("Next: [[plan]].\n");
    // a folder too
    await v.host.vault.move(v.host.vault.getAbstractFileByPath("Notes")!, "notes");
    expect(fs.readdirSync(v.root).filter((n) => !n.startsWith("."))).toEqual(["notes"]);
    expect(v.files()).toEqual(["notes/Index.md", "notes/plan.md"]);
    expect(v.host.vault.rescan()).toEqual([]); // the disk agrees with the index
  });

  it("onto another file of that name in another case (where the file system tells them apart) is refused", async () => {
    const v = open({ "Notes/Other.md": "o" });
    if (fs.existsSync(v.abs("Notes/OTHER.md"))) return; // a file system that ignores case has no such second file
    v.write("Notes/other.md", "a second file");
    v.host.vault.syncPath("Notes/other.md");
    await expect(v.host.vault.move(v.file("Notes/Other.md")!, "Notes/other.md")).rejects.toThrow("Destination exists: Notes/other.md");
  });
});

describe("node host: linksAfterMove", () => {
  it("the notes whose links still lead to an old path, rewritten as renameFile would; nothing written", async () => {
    const index = '---\nwho: "[[Ada]]"\n---\n[[Ada]], ![[Ada]], [[People/Ada|her]], [x](../People/Ada.md).\n';
    const v = open({
      "People/Ada.md": "Friend: [b](Bob.md).\n",
      "People/Bob.md": "b",
      "Other/Bob.md": "another Bob",
      "Notes/Index.md": index,
      "Notes/Relinked.md": "[[Ada King]]\n",
    });
    v.move("People/Ada.md", "Archive/Ada King.md");
    v.host.vault.syncPaths(["People/Ada.md", "Archive"]);
    const plan = await v.host.fileManager.linksAfterMove(new Map([["People/Ada.md", "Archive/Ada King.md"]]));
    expect(plan.map((p) => p.path)).toEqual(["Archive/Ada King.md", "Notes/Index.md"]);
    // its own relative link would lead to the other Bob from the new folder: it names the path
    expect(plan[0]).toEqual({ path: "Archive/Ada King.md", before: "Friend: [b](Bob.md).\n", after: "Friend: [b](People/Bob.md).\n" });
    expect(plan[1]).toEqual({ path: "Notes/Index.md", before: index, after: '---\nwho: "[[Ada King]]"\n---\n[[Ada King]], ![[Ada King]], [[Ada King|her]], [x](Ada%20King.md).\n' });
    expect(fs.readFileSync(v.abs("Notes/Index.md"), "utf8")).toBe(index);
    // a move whose old path has a file again, or whose new one has none, is no move to follow
    expect(await v.host.fileManager.linksAfterMove(new Map([["Notes/Index.md", "Notes/Gone.md"], ["People/Bob.md", "People/Ada.md"]]))).toEqual([]);
  });
});
