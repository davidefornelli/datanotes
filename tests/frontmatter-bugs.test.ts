import { describe, expect, it } from "vitest";
import { fmDelete, fmSet, readOrderedFromMarkdown, splitFrontmatter, writeFrontmatter } from "../src/core/frontmatter";
import { createDbVault } from "./helpers/db-vault";

describe("an empty frontmatter block", () => {
  it("reads back as empty frontmatter, as in Obsidian", () => {
    expect(splitFrontmatter("---\n---\nBody\n")).toEqual({ yamlText: "", body: "Body\n" });
    expect(splitFrontmatter("---\r\n---\r\nBody\r\n")).toEqual({ yamlText: "", body: "Body\r\n" });
    expect(splitFrontmatter("---\n---")).toEqual({ yamlText: "", body: "" });
    expect(readOrderedFromMarkdown("---\n---\nBody\n")).toEqual({ ordered: [], body: "Body\n" });
  });

  it("closes at its second line, also when the body has a `---` line of its own", () => {
    expect(readOrderedFromMarkdown("---\n---\nBody\n---\nmore\n")).toEqual({ ordered: [], body: "Body\n---\nmore\n" });
    // a block whose YAML starts with `---x` is not the empty block
    expect(splitFrontmatter("---\n---x: 1\n---\nB")).toEqual({ yamlText: "---x: 1", body: "B" });
  });

  it("removing the last property and adding one again leaves one block, not a pile of `---` lines", async () => {
    const v = createDbVault({ "Note.md": "---\na: 1\n---\nBody\n" });
    const f = v.file("Note.md");
    await writeFrontmatter(v.app, f, (fm) => fmDelete(fm, "a"));
    expect(v.read("Note.md")).toBe("---\n---\nBody\n");
    await writeFrontmatter(v.app, f, (fm) => fmSet(fm, "b", 2));
    expect(v.read("Note.md")).toBe("---\nb: 2\n---\nBody\n");
    await writeFrontmatter(v.app, f, (fm) => fmDelete(fm, "b"));
    await writeFrontmatter(v.app, f, (fm) => fmSet(fm, "c", 3));
    expect(v.read("Note.md")).toBe("---\nc: 3\n---\nBody\n");
  });
});
