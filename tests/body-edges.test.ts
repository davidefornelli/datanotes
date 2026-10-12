import { describe, expect, it } from "vitest";
import { appendBody, prependBody, setSection } from "../src/core/body";

const RECIPE = [
  "# Carbonara",
  "",
  "## Ingredients",
  "",
  "- guanciale",
  "- pecorino",
  "",
  "## Method",
  "",
  "```md",
  "## Not a heading: inside a code block",
  "```",
  "",
  "Whisk the eggs.",
  "",
  "## Notes",
  "",
  "Serve at once.",
  "",
].join("\n");

describe("setSection", () => {
  it("adds the section as the whole body when the body is empty", () => {
    expect(setSection("", "Summary", "First note of the day.")).toBe("## Summary\n\nFirst note of the day.\n");
    expect(setSection("\n\n", " Summary ", "x")).toBe("## Summary\n\nx\n");
  });

  it("ignores headings inside a code block of the section it replaces", () => {
    expect(setSection(RECIPE, "Method", "Toss the pasta with the sauce.")).toBe(
      "# Carbonara\n\n## Ingredients\n\n- guanciale\n- pecorino\n\n## Method\n\nToss the pasta with the sauce.\n\n## Notes\n\nServe at once.\n",
    );
  });

  it("treats tilde fences and indented fences as code blocks too", () => {
    const body = "## Log\n\n~~~\n# not a heading\n~~~\n  ```\n## nor this\n  ```\nold\n\n## Next\nkept\n";
    expect(setSection(body, "log", "new")).toBe("## Log\n\nnew\n\n## Next\nkept\n");
  });

  it("clears a section when the text is empty, keeping its heading", () => {
    expect(setSection(RECIPE, "Ingredients", "")).toBe(
      "# Carbonara\n\n## Ingredients\n\n## Method\n\n```md\n## Not a heading: inside a code block\n```\n\nWhisk the eggs.\n\n## Notes\n\nServe at once.\n",
    );
    expect(setSection("## Todo\n\n- call Bob\n", "Todo", "  \n\n")).toBe("## Todo\n");
  });

  it("ends the section at the next heading of a higher level", () => {
    const body = "# Trip\n\n## Day 1\n\nRome\n\n# Expenses\n\n- 30 EUR\n";
    expect(setSection(body, "Day 1", "Florence")).toBe("# Trip\n\n## Day 1\n\nFlorence\n\n# Expenses\n\n- 30 EUR\n");
  });

  it("matches a heading written with closing hashes", () => {
    expect(setSection("## Status ##\n\nopen\n", "status", "closed")).toBe("## Status ##\n\nclosed\n");
  });

  it("replaces up to the end of the note when the section is the last one", () => {
    expect(setSection("# A\n\n## Last\n\nold\nlines\n", "Last", "new")).toBe("# A\n\n## Last\n\nnew\n");
  });
});

describe("prependBody", () => {
  it("writes the text alone when the body is empty or blank", () => {
    expect(prependBody("", "Pinned: call the plumber.")).toBe("Pinned: call the plumber.\n");
    expect(prependBody("\n \n\t", "Pinned  \n\n")).toBe("Pinned\n");
  });

  it("separates the text from the existing body by one blank line", () => {
    expect(prependBody("\n\n# Meeting\n", "Moved to Friday.")).toBe("Moved to Friday.\n\n# Meeting\n");
  });
});

describe("appendBody", () => {
  it("separates the text from the existing body by one blank line", () => {
    expect(appendBody("# Meeting\n\n- budget\n\n\n", "- hiring  \n")).toBe("# Meeting\n\n- budget\n\n- hiring\n");
  });

  it("writes the text alone when the body is blank", () => {
    expect(appendBody(" \n\n", "Only line")).toBe("Only line\n");
  });
});
