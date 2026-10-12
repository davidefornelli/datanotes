import { describe, expect, it } from "vitest";
import { LinkResolver, linkText, normalizePath, parseLinks, rewriteLinks } from "../src/node/links";

const FILES = [
  "People/Carol Lane.md",
  "People/Alice.md",
  "Work/Alice.md",
  "Projects/Household/Plan.md",
  "Projects/Household/photo.png",
  "Inbox.md",
  "Daily/2026-10-04.md",
];
const resolver = () => new LinkResolver({ paths: () => FILES });

describe("parseLinks", () => {
  it("finds wikilinks, embeds, Markdown links and frontmatter links, skipping code", () => {
    const text = [
      "---",
      "partner: \"[[People/Carol Lane]]\"",
      "friends:",
      "  - \"[[Alice|G]]\"",
      "---",
      "See [[Inbox]], [[Plan#Budget|the plan]] and ![[photo.png]].",
      "A [link](Projects/Household/Plan.md#Phases) and [web](https://x.org) and ![img](photo%20copy.png).",
      "`[[not a link]]`",
      "```",
      "[[nor this]]",
      "```",
      "[[#Same note]]",
      "| a | [[Inbox|broken in a table]] | [[Inbox\\|ok]] |",
    ].join("\n");
    const links = parseLinks(text);
    expect(links.map((l) => [l.kind, l.linkpath, l.subpath, l.alias ?? null, l.key ?? null])).toEqual([
      ["frontmatter", "People/Carol Lane", "", null, "partner"],
      ["frontmatter", "Alice", "", "G", "friends"],
      ["wiki", "Inbox", "", null, null],
      ["wiki", "Plan", "#Budget", "the plan", null],
      ["embed", "photo.png", "", null, null],
      ["md", "Projects/Household/Plan.md", "#Phases", "link", null],
      ["mdembed", "photo copy.png", "", "img", null],
      ["wiki", "", "#Same note", null, null],
      ["wiki", "Inbox", "", "ok", null],
    ]);
    for (const l of links) expect(text.slice(l.start, l.end)).toMatch(/^!?\[/);
  });
});

describe("LinkResolver", () => {
  it("resolves like Obsidian: relative, from the root, then by name (same folder first, then shortest)", () => {
    const r = resolver();
    expect(r.resolve("Inbox", "Daily/2026-10-04.md")).toBe("Inbox.md");
    expect(r.resolve("people/carol lane", "Inbox.md")).toBe("People/Carol Lane.md"); // case-insensitive
    expect(r.resolve("Carol Lane", "Inbox.md")).toBe("People/Carol Lane.md");
    expect(r.resolve("Plan", "Inbox.md")).toBe("Projects/Household/Plan.md");
    expect(r.resolve("Household/Plan", "Inbox.md")).toBe("Projects/Household/Plan.md");
    expect(r.resolve("photo.png", "Projects/Household/Plan.md")).toBe("Projects/Household/photo.png");
    expect(r.resolve("../People/Alice", "Work/Alice.md")).toBe("People/Alice.md");
    expect(r.resolve("Alice", "Work/Notes.md")).toBe("Work/Alice.md"); // same folder wins
    expect(r.resolve("Alice", "Inbox.md")).toBe("People/Alice.md"); // same depth: alphabetical
    expect(r.resolve("/Inbox", "Daily/x.md")).toBe("Inbox.md");
    expect(r.resolve("Nope", "Inbox.md")).toBeNull();
    expect(r.resolve("", "Inbox.md")).toBeNull();
    expect(normalizePath("a/./b/../c")).toBe("a/c");
    expect(normalizePath("../x")).toBeNull();
  });

  it("writes link text in the vault's format", () => {
    const r = resolver();
    expect(linkText(r, "People/Carol Lane.md", "Inbox.md", "shortest")).toBe("Carol Lane");
    expect(linkText(r, "People/Alice.md", "Inbox.md", "shortest")).toBe("People/Alice"); // name not unique
    expect(linkText(r, "People/Carol Lane.md", "Inbox.md", "absolute")).toBe("People/Carol Lane");
    expect(linkText(r, "People/Carol Lane.md", "Work/Alice.md", "relative")).toBe("../People/Carol Lane");
    expect(linkText(r, "Projects/Household/photo.png", "Inbox.md", "absolute")).toBe("Projects/Household/photo.png");
  });
});

describe("rewriteLinks", () => {
  it("rewrites links to a moved file, keeping alias, subpath and kind", () => {
    const r = resolver();
    const moved = new Map([["People/Carol Lane.md", "Friends/Carol Lane.md"]]);
    const after = new LinkResolver({ paths: () => FILES.map((p) => moved.get(p) ?? p) });
    const text = '---\npartner: "[[People/Carol Lane]]"\n---\n[[People/Carol Lane#Note|Carol]], ![[People/Carol Lane]], [x](People/Carol%20Lane.md), [[Inbox]]\n';
    const out = rewriteLinks(text, "Inbox.md", (lp, s) => r.resolve(lp, s), moved, (dest, s) => linkText(after, dest, s, "absolute"));
    expect(out.changed).toBe(4);
    expect(out.text).toBe(
      '---\npartner: "[[Friends/Carol Lane]]"\n---\n[[Friends/Carol Lane#Note|Carol]], ![[Friends/Carol Lane]], [x](Friends/Carol%20Lane.md), [[Inbox]]\n',
    );
  });

  it("a moved note keeps links that still work and fixes relative ones", () => {
    const r = resolver();
    const moved = new Map([["Work/Alice.md", "Archive/Old/Alice.md"]]);
    const after = new LinkResolver({ paths: () => FILES.map((p) => moved.get(p) ?? p) });
    const text = "[[Inbox]] and [[../People/Carol Lane]]";
    const out = rewriteLinks(
      text,
      "Archive/Old/Alice.md",
      (lp, s) => r.resolve(lp, s),
      moved,
      (dest, s) => linkText(after, dest, s, "relative"),
      "Work/Alice.md",
      (lp, s) => after.resolve(lp, s),
    );
    expect(out.text).toBe("[[Inbox]] and [[../../People/Carol Lane]]");
  });
});
