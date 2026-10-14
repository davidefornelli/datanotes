import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileLookupNames, LinkResolver, linkLookupNames } from "../src/node/links";
import { NodeFile, openNodeVault, type NodeHost } from "../src/node/node-app";

const opened: NodeHost[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.metadataCache.dispose();
});

/** A small deterministic random source (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("LinkResolver kept up to date file by file", () => {
  it("adds and removes files: a path known already keeps its place, one unknown is no change", () => {
    const r = new LinkResolver({ paths: () => ["a/Plan.md", "b/Plan.md"] });
    expect(r.resolve("Plan", "b/x.md")).toBe("b/Plan.md");
    r.add("a/Plan.md"); // known already
    r.remove("b/Plan.md");
    expect(r.resolve("Plan", "b/x.md")).toBe("a/Plan.md");
    expect(r.sameName("a/Plan.md")).toBe(1);
    r.remove("b/Plan.md"); // gone already: nothing changes
    r.remove("a/Plan.md");
    expect(r.resolve("Plan", "b/x.md")).toBeNull();
    expect(r.sameName("a/Plan.md")).toBe(0);
    r.add("c/photo.png");
    expect(r.resolve("photo.png", "x.md")).toBe("c/photo.png");
  });

  it("of one path in two cases (a disk that tells them apart), the last one added wins, as in a rebuild", () => {
    const r = new LinkResolver({ paths: () => [] });
    r.add("Notes/Plan.md");
    r.add("Notes/plan.md");
    const rebuilt = new LinkResolver({ paths: () => ["Notes/Plan.md", "Notes/plan.md"] });
    expect(r.resolve("Notes/Plan", "x.md")).toBe(rebuilt.resolve("Notes/Plan", "x.md"));
    expect(r.resolve("Notes/Plan", "x.md")).toBe("Notes/plan.md");
    r.remove("Notes/plan.md");
    expect(r.resolve("Notes/Plan", "x.md")).toBe("Notes/Plan.md");
    // three spellings: the last added wins, each removed in turn
    r.add("Notes/plan.md");
    r.add("Notes/PLAN.md");
    r.add("Notes/PLAN.md"); // known already
    expect(r.resolve("Notes/Plan", "x.md")).toBe("Notes/PLAN.md");
    expect(r.sameName("Notes/Plan.md")).toBe(3); // one name, three files
    r.remove("Notes/PLAN.md");
    expect(r.resolve("Notes/Plan", "x.md")).toBe("Notes/plan.md");
    r.remove("Notes/Other.md"); // never added
    r.remove("Notes/plan.md");
    r.remove("Notes/Plan.md");
    expect(r.resolve("Notes/Plan", "x.md")).toBeNull();
  });

  it("names the lookups of a link: the file it resolves to has one of its names among them", () => {
    expect(fileLookupNames("a/Plan.md")).toEqual(["plan.md", "plan"]);
    expect(fileLookupNames("a/photo.png")).toEqual(["photo.png"]);
    expect(linkLookupNames("  ", "a/x.md")).toEqual([]);
    expect(linkLookupNames("Plan", "a/x.md")).toEqual(["plan"]);
    expect(linkLookupNames("/Inbox", "a/x.md")).toEqual(["inbox"]);
    expect(linkLookupNames("../People/Alice", "Work/x.md")).toEqual(["alice"]);
    // ".." from a note one folder down is the folder above: its name is looked up as a file
    expect(linkLookupNames("..", "a/b/x.md")).toEqual(["a"]);
    expect(linkLookupNames("..", "x.md")).toEqual([]);
  });
});

const FOLDERS = ["", "One", "One/Two", "Three"];
const NAMES = ["Alpha", "alpha", "Beta", "Gamma", "Plan"];
const LINKS = ["Alpha", "alpha.md", "Beta", "Plan", "One/Plan", "/Beta", "../Alpha", "./Gamma", "Two/Plan", "photo.png", "..", "Nobody"];

function textWith(rnd: () => number): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const links = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(LINKS));
  const fm = rnd() < 0.5 ? `---\nrel: "[[${pick(LINKS)}]]"\n---\n` : "";
  return `${fm}Text ${links.map((l, i) => (i % 3 === 2 ? `[x](${encodeURI(l.endsWith(".md") || l.includes(".") ? l : `${l}.md`)})` : `[[${l}]]`)).join(" ")}\n`;
}

describe("node host: links resolved incrementally equal a full resolution", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`after random creates, edits, deletes and renames (seed ${seed})`, async () => {
      const rnd = random(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-links-inc-"));
      fs.writeFileSync(path.join(root, "Start.md"), "[[Alpha]] [[Plan]]\n");
      const host = openNodeVault(root);
      opened.push(host);
      const { vault, metadataCache, fileManager } = host;
      const notes = () => vault.getMarkdownFiles().map((f) => f.path);
      const anyFile = () => vault.getFiles().map((f) => f.path);
      const newPath = () => {
        const dir = pick(FOLDERS);
        const name = rnd() < 0.15 ? "photo.png" : `${pick(NAMES)}.md`;
        return dir === "" ? name : `${dir}/${name}`;
      };
      const free = (p: string) => !fs.existsSync(path.join(root, ...p.split("/")));
      for (let step = 0; step < 150; step++) {
        const op = rnd();
        if (notes().length === 0) await vault.create(`Start ${step}.md`, textWith(rnd));
        try {
          if (op < 0.3) {
            const p = newPath();
            if (free(p)) await vault.create(p, p.endsWith(".md") ? textWith(rnd) : "png");
          } else if (op < 0.45) {
            const p = pick(notes());
            const f = vault.getAbstractFileByPath(p) as NodeFile;
            if (rnd() < 0.5) await vault.process(f, () => textWith(rnd));
            else {
              // by hand, as the watcher reports it
              fs.writeFileSync(path.join(root, ...p.split("/")), textWith(rnd) + "#".repeat(step));
              vault.syncPath(p);
            }
          } else if (op < 0.6) {
            const p = pick(anyFile());
            if (p !== "Start.md") {
              if (rnd() < 0.5) await vault.delete(vault.getAbstractFileByPath(p)!);
              else {
                fs.rmSync(path.join(root, ...p.split("/")));
                vault.syncPath(p);
              }
            }
          } else if (op < 0.8) {
            const from = pick(anyFile());
            const caseOnly = rnd() < 0.3;
            const to = caseOnly ? from.replace(/[^/]+$/, (n) => (n === n.toLowerCase() ? n.toUpperCase() : n.toLowerCase())) : newPath();
            const caseVariant = from.toLowerCase() === to.toLowerCase();
            if (from !== to && (free(to) || caseVariant)) {
              if (rnd() < 0.5) await fileManager.renameFile(vault.getAbstractFileByPath(from)!, to);
              else await vault.move(vault.getAbstractFileByPath(from)!, to);
            }
          } else if (op < 0.9) {
            // a folder moved, with the notes in it
            const dir = pick(["One/Two", "Three"]);
            const target = dir === "Three" ? "Four" : "Five/Two";
            const folder = vault.getAbstractFileByPath(dir);
            if (folder && free(target)) await fileManager.renameFile(folder, target);
          } else {
            // hand moves seen together (the watcher's batch)
            const from = pick(notes());
            const to = newPath();
            if (from !== "Start.md" && to.endsWith(".md") && free(to)) {
              fs.mkdirSync(path.dirname(path.join(root, ...to.split("/"))), { recursive: true });
              fs.renameSync(path.join(root, ...from.split("/")), path.join(root, ...to.split("/")));
              vault.syncPaths([from, to]);
            }
          }
        } catch (e) {
          // a case collision the disk refuses: no change of the index is expected
          if (!/exists|EEXIST|ENOENT|not found/i.test(String(e))) throw e;
        }
        expect(metadataCache.verifyLinks(), `step ${step}`).toEqual([]);
      }
      // backlinks agree with the resolved links
      for (const p of anyFile()) {
        const from = Object.entries(metadataCache.resolvedLinks).filter(([, d]) => (d[p] ?? 0) > 0).map(([s, d]) => [s, d[p]]);
        expect(Object.entries(metadataCache.backlinksOf(p)).sort()).toEqual(from.sort());
      }
    });
  }
});

describe("node host: the check of the links kept file by file", () => {
  it("tells each kind of difference from a resolution from scratch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-links-check-"));
    fs.writeFileSync(path.join(root, "A.md"), "[[B]] [[Nobody]] [[#here]]\n");
    fs.writeFileSync(path.join(root, "B.md"), "b\n");
    const host = openNodeVault(root);
    opened.push(host);
    const mc = host.metadataCache as unknown as {
      verifyLinks(): string[];
      resolved: Record<string, Record<string, number>>;
      unresolved: Record<string, Record<string, number>>;
      inbound: Map<string, Map<string, number>>;
      lookers: Map<string, Set<string>>;
    };
    expect(mc.verifyLinks()).toEqual([]);
    mc.resolved["A.md"] = {};
    mc.unresolved["A.md"] = {};
    mc.inbound.clear();
    mc.lookers.clear();
    delete mc.resolved["B.md"];
    expect(mc.verifyLinks()).toEqual([
      'resolved notes: ["A.md"] instead of ["A.md","B.md"]',
      'A.md: resolves {} instead of {"B.md":1}',
      'A.md: leaves {} unresolved instead of {"Nobody":1}',
      "B.md: resolves undefined instead of {}",
      "backlinks differ from the resolved links",
      "looked-up names differ from the notes' links",
    ]);
  });
});
