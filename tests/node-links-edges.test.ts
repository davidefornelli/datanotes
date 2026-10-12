import { describe, expect, it } from "vitest";
import { generateLink, LinkResolver, linkText, parseLinks, rewriteLinks } from "../src/node/links";

const FILES = [
  "People/Carol Lane.md",
  "People/Alice.md",
  "Work/Alice.md",
  "Work/Team/Alice.md",
  "Projects/Household/Plan (2026).md",
  "Inbox.md",
  "Notes/50%off.md",
];
const resolver = (files = FILES) => new LinkResolver({ paths: () => files });
const brief = (text: string) => parseLinks(text).map((l) => [l.kind, l.linkpath, l.subpath, l.alias ?? null, l.key ?? null]);

describe("parseLinks: frontmatter links are whole values only", () => {
  it("a value, a list item, a flow list element, or a value followed by a comment", () => {
    const text = [
      "---",
      'partner: "[[Carol Lane|Carol]]"',
      "friends:",
      "  - '[[Alice]]'",
      'team: ["[[Work/Alice]]", "[[Inbox]]"]',
      "plan: [[Plan (2026)]] # the current one",
      "---",
      "",
    ].join("\n");
    expect(brief(text)).toEqual([
      ["frontmatter", "Carol Lane", "", "Carol", "partner"],
      ["frontmatter", "Alice", "", null, "friends"],
      ["frontmatter", "Work/Alice", "", null, "team"],
      ["frontmatter", "Inbox", "", null, "team"],
      ["frontmatter", "Plan (2026)", "", null, "plan"],
    ]);
  });

  it("a frontmatter written as a list, not as properties, gives links without a key", () => {
    expect(brief('---\n- "[[Alice]]"\n- "[[Inbox]]"\n---\n')).toEqual([
      ["frontmatter", "Alice", "", null, null],
      ["frontmatter", "Inbox", "", null, null],
    ]);
  });

  it("not a link inside a sentence, nor a link opening a line of a block text", () => {
    const text = [
      "---",
      "summary: met [[Alice]] at the station",
      "note: |",
      "[[Inbox]] first",
      "  [[Carol Lane]]",
      "tail: \"[[Alice]] and more\"",
      "---",
      "",
    ].join("\n");
    expect(brief(text)).toEqual([]);
  });

  it("an empty frontmatter block ends at once: the body's links up to a later --- line are body links", () => {
    const text = "---\n---\nMet [[Alice]].\n\n---\n\nnext: \"[[Inbox]]\"\n";
    expect(brief(text)).toEqual([
      ["wiki", "Alice", "", null, null],
      ["wiki", "Inbox", "", null, null],
    ]);
    expect(parseLinks(text)[0]).toMatchObject({ start: 12, end: 21 });
    expect(brief("---\r\n---")).toEqual([]);
  });
});

describe("parseLinks: Markdown links", () => {
  it("reads a target in angle brackets, keeps a target that is not valid URL encoding as written, and skips code", () => {
    const text = [
      "[plan](<Projects/Household/Plan (2026).md>)",
      "[deal](Notes/50%off.md)",
      "`[code](Inbox.md)` and [web](mailto:x@example.com)",
    ].join("\n");
    expect(brief(text)).toEqual([
      ["md", "Projects/Household/Plan (2026).md", "", "plan", null],
      ["md", "Notes/50%off.md", "", "deal", null],
    ]);
  });
});

describe("LinkResolver: by name", () => {
  it("prefers the note's own folder, then the shallowest path", () => {
    const r = resolver();
    expect(r.resolve("Alice", "Work/Team/Standup.md")).toBe("Work/Team/Alice.md");
    expect(r.resolve("Team/Alice", "Inbox.md")).toBe("Work/Team/Alice.md");
    expect(r.resolve("Alice", "Daily/2026-10-08.md")).toBe("People/Alice.md");
  });

  it("a link with a folder part also prefers the candidate in the note's own folder", () => {
    const r = resolver(["Home/Team/Alice.md", "Work/Team/Alice.md", "Work/Team/Standup.md"]);
    expect(r.resolve("Team/Alice", "Work/Team/Standup.md")).toBe("Work/Team/Alice.md");
    expect(r.resolve("Team/Alice", "Inbox.md")).toBe("Home/Team/Alice.md");
  });

  it("counts files sharing a name, none for a name no file has", () => {
    const r = resolver();
    expect(r.sameName("Work/Alice.md")).toBe(3);
    expect(r.sameName("Nobody.md")).toBe(0);
  });
});

describe("linkText: relative links", () => {
  it("from a note at the vault root, and between siblings", () => {
    const r = resolver();
    expect(linkText(r, "People/Alice.md", "Inbox.md", "relative")).toBe("People/Alice");
    expect(linkText(r, "Work/Team/Alice.md", "Work/Alice.md", "relative")).toBe("Team/Alice");
    expect(linkText(r, "Work/Alice.md", "Work/Team/Alice.md", "relative")).toBe("../Alice");
  });
});

describe("generateLink: a complete link, as Obsidian writes it", () => {
  const r = resolver();
  it("a wikilink in the vault's format, with subpath and alias", () => {
    expect(generateLink(r, "People/Carol Lane.md", "Inbox.md", "shortest")).toBe("[[Carol Lane]]");
    expect(generateLink(r, "Work/Alice.md", "Inbox.md", "shortest", { subpath: "#Role", alias: "Alice (work)" })).toBe("[[Work/Alice#Role|Alice (work)]]");
  });

  it("a section of the same note is just the section", () => {
    expect(generateLink(r, "Inbox.md", "Inbox.md", "absolute", { subpath: "#Today" })).toBe("[[#Today]]");
    expect(generateLink(r, "Inbox.md", "Inbox.md", "absolute")).toBe("[[Inbox]]");
  });

  it("a Markdown link keeps .md, encodes spaces and parentheses, and shows the note name by default", () => {
    expect(generateLink(r, "Projects/Household/Plan (2026).md", "Inbox.md", "absolute", { markdown: true })).toBe(
      "[Plan (2026)](Projects/Household/Plan%20%282026%29.md)",
    );
    expect(generateLink(r, "People/Carol Lane.md", "Work/Alice.md", "relative", { markdown: true, alias: "Carol", subpath: "#Phone" })).toBe(
      "[Carol](../People/Carol%20Lane.md#Phone)",
    );
  });
});

describe("rewriteLinks: more kinds of links", () => {
  it("leaves [[#heading]] alone, writes a same-note section as the section, and keeps Markdown embeds", () => {
    const moved = new Map([["People/Carol Lane.md", "Friends/Carol Lane.md"]]);
    const before = resolver();
    const after = resolver(FILES.map((p) => moved.get(p) ?? p));
    const text = "[[#Top]] [[People/Carol Lane#Phone]] ![card](People/Carol%20Lane.md) [c](<People/Carol Lane.md>)";
    const out = rewriteLinks(
      text,
      "Friends/Carol Lane.md",
      (lp, s) => before.resolve(lp, s),
      moved,
      (dest, s) => linkText(after, dest, s, "absolute"),
      "People/Carol Lane.md",
      (lp, s) => after.resolve(lp, s),
    );
    expect(out.text).toBe("[[#Top]] [[#Phone]] ![card](Friends/Carol%20Lane.md) [c](Friends/Carol%20Lane.md)");
    expect(out.changed).toBe(3);
  });

  it("adds .md to a Markdown link whose new text has none, and changes nothing when the text is already right", () => {
    const moved = new Map([["Inbox.md", "Archive/Inbox.md"]]);
    const before = resolver();
    const out = rewriteLinks("[in](Inbox.md) [[Inbox]]", "People/Alice.md", (lp, s) => before.resolve(lp, s), moved, () => "Archive/Inbox");
    expect(out).toEqual({ text: "[in](Archive/Inbox.md) [[Archive/Inbox]]", changed: 2 });
    const withMd = rewriteLinks("[in](Inbox.md)", "People/Alice.md", (lp, s) => before.resolve(lp, s), moved, () => "Archive/Inbox.md");
    expect(withMd.text).toBe("[in](Archive/Inbox.md)"); // not .md.md
    const same = rewriteLinks("[[Archive/Inbox]]", "People/Alice.md", (lp) => (lp === "Archive/Inbox" ? "Inbox.md" : null), moved, () => "Archive/Inbox");
    expect(same).toEqual({ text: "[[Archive/Inbox]]", changed: 0 });
  });
});
