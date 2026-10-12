import { describe, expect, it } from "vitest";
import { chunkNote } from "../src/core/chunk";

/** A paragraph of exactly 40 characters. */
const para = (label: string) => label.padEnd(40, ".");

describe("long sections", () => {
  it("are cut at blank lines, grouping paragraphs up to the size limit", () => {
    const [d1, d2, d3, d4, d5] = ["Day 1 Alfama", "Day 2 Belem", "Day 3 Sintra", "Day 4 Cascais", "Day 5 back home"].map(para);
    const note = `# Diary\n${[d1, d2, d3, d4, d5].join("\n\n")}\n`;
    expect(chunkNote("Travel/Lisbon.md", note, { maxChars: 100 })).toEqual([
      { heading: "Diary", text: `Lisbon\n\nDiary\n${d1}\n\n${d2}`, snippet: `${d1} ${d2}` },
      { heading: "Diary", text: `Lisbon › Diary\n\n${d3}\n\n${d4}`, snippet: `${d3} ${d4}` },
      { heading: "Diary", text: `Lisbon › Diary\n\n${d5}`, snippet: d5 },
    ]);
  });

  it("close the pending group before a paragraph longer than the limit, which is cut by length", () => {
    const long = "x".repeat(250);
    const pieces = chunkNote("Notes/Log.md", `Short intro.\n\n${long}`, { maxChars: 100 });
    expect(pieces.map((c) => c.text)).toEqual([
      "Log\n\nShort intro.",
      `Log\n\n${"x".repeat(100)}`,
      `Log\n\n${"x".repeat(100)}`,
      `Log\n\n${"x".repeat(50)}`,
    ]);
    expect(pieces.every((c) => c.heading === "")).toBe(true);
  });
});

describe("code blocks", () => {
  it("headings inside backtick and tilde fences do not start a section", () => {
    const note = "Intro\n```bash\n# not a heading\nls\n```\n  ~~~\n## also not\n  ~~~\n## Real\nDone.\n";
    expect(chunkNote("Dev/Script.md", note)).toEqual([
      {
        heading: "",
        text: "Script\n\nIntro\n```bash\n# not a heading\nls\n```\n  ~~~\n## also not\n  ~~~",
        snippet: "Intro ```bash # not a heading ls ``` ~~~ ## also not ~~~",
      },
      { heading: "Real", text: "Script › Real\n\nDone.", snippet: "Done." },
    ]);
  });
});

describe("notes without text", () => {
  it.each([
    ["an empty file", ""],
    ["blank lines only", "\n\n   \n"],
    ["headings only", "# Title\n## Subtitle\n"],
  ])("give one passage with the title: %s", (_title, content) => {
    expect(chunkNote("Inbox/Untitled.MD", content)).toEqual([{ heading: "", text: "Untitled", snippet: "Untitled" }]);
  });
});

describe("heading paths", () => {
  it("a skipped level leaves no empty name, and a higher heading closes the deeper ones", () => {
    const note = "# Garden\n### Tomatoes\nWater daily.\n## Herbs\nBasil.\n";
    expect(chunkNote("Home/Garden.md", note).map((c) => [c.heading, c.text])).toEqual([
      ["Garden › Tomatoes", "Garden\n\nGarden › Tomatoes\nWater daily."],
      ["Garden › Herbs", "Garden › Garden › Herbs\n\nBasil."],
    ]);
  });
});

describe("Windows line endings", () => {
  it("frontmatter and body with CRLF are read, skipped keys left out", () => {
    const note = "---\r\ntable: main.public.log\r\nid: 0193a0f0\r\nkind: walk\r\n---\r\nWalked 5 km.\r\n";
    expect(chunkNote("Datanotes/main/public/log/2026-10-08 walk.md", note, { skipKeys: ["id", "table"] })).toEqual([
      { heading: "", text: "2026-10-08 walk\nkind: walk\n\nWalked 5 km.", snippet: "Walked 5 km." },
    ]);
  });
});

describe("empty frontmatter", () => {
  it("an empty block is the frontmatter, a later --- line stays in the body", () => {
    const note = "---\n---\nFirst part.\n\n---\n\nSecond part.\n";
    expect(chunkNote("Notes/Draft.md", note)).toEqual([
      { heading: "", text: "Draft\n\nFirst part.\n\n---\n\nSecond part.", snippet: "First part. --- Second part." },
    ]);
  });

  it("an empty block with CRLF, at the end of the file", () => {
    expect(chunkNote("Notes/Blank.md", "---\r\n---")).toEqual([{ heading: "", text: "Blank", snippet: "Blank" }]);
  });
});

describe("passage limit", () => {
  const note = Array.from({ length: 45 }, (_, i) => `## Step ${i + 1}\nDo thing ${i + 1}.`).join("\n");

  it("keeps the first 40 passages by default", () => {
    const c = chunkNote("Guides/Setup.md", note);
    expect(c).toHaveLength(40);
    expect(c[39]!.heading).toBe("Step 40");
  });

  it("follows maxChunks", () => {
    expect(chunkNote("Guides/Setup.md", note, { maxChunks: 2 }).map((c) => c.heading)).toEqual(["Step 1", "Step 2"]);
  });
});
