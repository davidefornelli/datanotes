import { describe, expect, it } from "vitest";
import type { App, TFile } from "../src/core/host";
import { parseYamlBlockToOrdered, readOrderedFromMarkdown, readOrderedFrontmatter } from "../src/core/frontmatter";

/** A host whose `vault.read` fails the way the given callback does. */
function failingHost(fail: () => Promise<string>): App {
  return { vault: { read: fail } } as unknown as App;
}

const DAILY = { path: "Journal/2026-10-08.md", extension: "md" } as TFile;

describe("empty frontmatter blocks", () => {
  it("a block with only blank lines has no keys, and the body follows it", () => {
    expect(readOrderedFromMarkdown("---\n\n---\nDinner with Alice.\n")).toEqual({ ordered: [], body: "Dinner with Alice.\n" });
    expect(readOrderedFromMarkdown("---\n  \t\n---\n# Plan\n")).toEqual({ ordered: [], body: "# Plan\n" });
  });

  it("blank YAML text parses to no entries", () => {
    expect(parseYamlBlockToOrdered("")).toEqual([]);
    expect(parseYamlBlockToOrdered(" \n\t\n")).toEqual([]);
  });
});

describe("keys without a value", () => {
  it("an explicit key with no value reads as null, in order", () => {
    expect(parseYamlBlockToOrdered("? reviewed\ntags: [book, sci-fi]\n")).toEqual([
      ["reviewed", null],
      ["tags", ["book", "sci-fi"]],
    ]);
  });

  it("a flow mapping entry with no value reads as null", () => {
    expect(parseYamlBlockToOrdered("source: {url, title: Dune}\n")).toEqual([["source", { url: null, title: "Dune" }]]);
  });

  it("a nested explicit key with no value reads as null", () => {
    expect(parseYamlBlockToOrdered("reminder:\n  ? snoozed\n  at: 09:00\n")).toEqual([["reminder", { snoozed: null, at: "09:00" }]]);
  });

  it("an empty list item reads as null", () => {
    expect(parseYamlBlockToOrdered("people:\n  -\n  - \"[[Alice]]\"\n")).toEqual([["people", [null, "[[Alice]]"]]]);
  });
});

describe("collections used as keys", () => {
  it("a sequence key at the root is named by its flow text", () => {
    expect(parseYamlBlockToOrdered("[2026, 10]: october\ntitle: Budget\n")).toEqual([
      ["[2026,10]", "october"],
      ["title", "Budget"],
    ]);
  });

  it("sequence and mapping keys in a nested mapping are named by their flow text", () => {
    expect(parseYamlBlockToOrdered("grid:\n  [a, b]: 1\n  ? {row: 2}\n  : 3\n  plain: 4\n")).toEqual([
      ["grid", { '["a","b"]': 1, '{"row":2}': 3, plain: 4 }],
    ]);
  });
});

describe("readOrderedFrontmatter when the host fails", () => {
  it("names the note when the host rejects with an Error", async () => {
    const app = failingHost(async () => {
      throw new Error("EBUSY: resource busy or locked, open 'Journal/2026-10-08.md'");
    });
    const e = await readOrderedFrontmatter(app, DAILY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).constructor).toBe(Error);
    expect((e as Error).message).toBe("cannot read the front matter of Journal/2026-10-08.md: EBUSY: resource busy or locked, open 'Journal/2026-10-08.md'");
  });

  it("names the note when the host rejects with something that is not an Error", async () => {
    const app = failingHost(() => Promise.reject("file is being synced by iCloud"));
    const e = await readOrderedFrontmatter(app, DAILY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).constructor).toBe(Error);
    expect((e as Error).message).toBe("cannot read the front matter of Journal/2026-10-08.md: file is being synced by iCloud");
  });

  it("names the note when its frontmatter is not a mapping", async () => {
    const app = failingHost(async () => "---\n- just\n- a list\n---\nBody\n");
    const e = await readOrderedFrontmatter(app, DAILY).catch((x: unknown) => x);
    expect((e as Error).constructor).toBe(Error);
    expect((e as Error).message).toBe("cannot read the front matter of Journal/2026-10-08.md: the front matter must be a YAML mapping of keys and values");
  });
});
