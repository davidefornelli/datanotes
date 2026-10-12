import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { App, TFile } from "../src/core/host";
import { describe, expect, it } from "vitest";
import {
  applyOrderedFrontmatter,
  buildMarkdownWithFrontmatter,
  coerceMisparsedYamlWikilinkToString,
  fmAdd,
  fmDelete,
  fmGet,
  fmReorder,
  fmRename,
  fmSet,
  parseYamlBlockToOrdered,
  readOrderedFromMarkdown,
  readOrderedFrontmatter,
  splitFrontmatter,
  writeFrontmatter,
} from "../src/core/frontmatter";
import type { OrderedFrontmatter } from "../src/core/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "frontmatter");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

const FIXTURE_NAMES = [
  "simple.md",
  "quoted.md",
  "lists.md",
  "multiline.md",
  "numbers-bools-nulls.md",
  "with-comments.md",
  "unicode.md",
  "underscore-keys.md",
  "nested.md",
] as const;
describe("splitFrontmatter / parseYamlBlockToOrdered", () => {
  it("returns null when no frontmatter block", () => {
    expect(splitFrontmatter("# Only body")).toBeNull();
  });

  it("readOrderedFromMarkdown returns full markdown as body when no --- block", () => {
    const md = "# Only body\n";
    expect(readOrderedFromMarkdown(md)).toEqual({
      ordered: [],
      body: md,
    });
  });

  it("parses root sequence as error", () => {
    expect(() => parseYamlBlockToOrdered("[1, 2]")).toThrow(
      "the front matter must be a YAML mapping",
    );
  });
});

describe("fixtures — round-trip (read → build → read)", () => {
  const entriesEqual = (a: OrderedFrontmatter, b: OrderedFrontmatter): boolean => JSON.stringify(a) === JSON.stringify(b);
  for (const name of FIXTURE_NAMES) {
    it(name, () => {
      const raw = loadFixture(name);
      const first = readOrderedFromMarkdown(raw);
      const rebuilt = buildMarkdownWithFrontmatter(first.ordered, first.body);
      const second = readOrderedFromMarkdown(rebuilt);
      expect(entriesEqual(first.ordered, second.ordered)).toBe(true);
      expect(second.body).toBe(first.body);
    });
  }
});

describe("fixtures — mutation add key", () => {
  for (const name of FIXTURE_NAMES) {
    it(name, () => {
      const raw = loadFixture(name);
      const first = readOrderedFromMarkdown(raw);
      const added = fmAdd(first.ordered, "__test_key", 42);
      const rebuilt = buildMarkdownWithFrontmatter(added, first.body);
      const second = readOrderedFromMarkdown(rebuilt);
      expect(fmGet(second.ordered, "__test_key")).toBe(42);
      for (const [k, v] of first.ordered) {
        if (k === "__test_key") continue;
        expect(fmGet(second.ordered, k)).toEqual(v);
      }
    });
  }
});

describe("nested mappings", () => {
  it("are read as plain objects", () => {
    const raw = loadFixture("nested.md");
    expect(readOrderedFromMarkdown(raw).ordered).toEqual([
      ["parent", { child: 1 }],
      ["flat", 2],
    ]);
  });
});

describe("coerceMisparsedYamlWikilinkToString (unquoted [[…]] in YAML)", () => {
  it("unwraps two-level single-string flow arrays to Obsidian wikilink strings", () => {
    expect(coerceMisparsedYamlWikilinkToString("no change")).toBe("no change");
    expect(
      coerceMisparsedYamlWikilinkToString([["Templates/template/x|y"]]),
    ).toBe("[[Templates/template/x|y]]");
    expect(coerceMisparsedYamlWikilinkToString([["only"]])).toBe("[[only]]");
  });

  it("does not coerce a one-level list (not the YAML `[[` flow ambiguity)", () => {
    const one = ["a"];
    expect(coerceMisparsedYamlWikilinkToString(one)).toBe(one);
  });

  it("does not coerce a multi-item inner flow sequence", () => {
    const multi = [[["a", "b"]]];
    expect(coerceMisparsedYamlWikilinkToString(multi)).toBe(multi);
  });
});

describe("tolerant nested YAML", () => {
  const taskNotesLike = `---
table: "[[base]]"
reminders:
  - id: rem_1773476497323
    type: relative
    relatedTo: due
tags: []
---
`;

  it("parseYamlBlockToOrdered coerces unquoted wikilinks to strings for the keys it is given", () => {
    const yaml = `---
table: [[Templates/template/template-log|template-log]]
other: [[x]]
date: 2026-03-10
---`;
    const split = splitFrontmatter(`${yaml}\n`);
    expect(split).not.toBeNull();
    const o = parseYamlBlockToOrdered(split!.yamlText, new Set(["table"]));
    expect(o.find(([k]) => k === "table")?.[1]).toBe(
      "[[Templates/template/template-log|template-log]]",
    );
    expect(o.find(([k]) => k === "other")?.[1]).toEqual([["x"]]);
  });

  it("parseYamlBlockToOrdered preserves nested maps in sequences", () => {
    const split = splitFrontmatter(taskNotesLike);
    expect(split).not.toBeNull();
    const o = parseYamlBlockToOrdered(split!.yamlText);
    expect(o.map(([k]) => k)).toEqual(["table", "reminders", "tags"]);
    const rem = o.find(([k]) => k === "reminders")?.[1] as Record<string, unknown>[];
    expect(rem?.[0]).toMatchObject({
      id: "rem_1773476497323",
      type: "relative",
      relatedTo: "due",
    });
  });

  it("readOrderedFrontmatter wraps duplicate keys with path", async () => {
    const dup = `---
test01: a
price: hi
test01: b
---
`;
    const file = { path: "dup.md", extension: "md" } as TFile;
    const app = {
      vault: {
        read: async () => dup,
      },
    } as unknown as App;
    await expect(readOrderedFrontmatter(app, file)).rejects.toThrow(
      /cannot read the front matter of dup\.md:.*Map keys must be unique/s,
    );
  });

  it("parseYamlBlockToOrdered rejects non-mapping root", () => {
    expect(() => parseYamlBlockToOrdered("[1, 2]")).toThrow(
      "the front matter must be a YAML mapping of keys and values",
    );
  });

  it("parseYamlBlockToOrdered rejects unsupported alias nodes in values", () => {
    expect(() =>
      parseYamlBlockToOrdered("a: &x 1\nb: *x\n"),
    ).toThrow("unsupported YAML value at front matter key");
  });

  it("writeFrontmatter preserves nested reminders when adding a key", async () => {
    const raw = `---
a: 1
reminders:
  - id: x
    type: relative
---
body`;
    let markdown = raw;
    const file = { path: "c.md", extension: "md" } as TFile;
    const app = {
      vault: {
        read: async () => markdown,
      },
      fileManager: {
        processFrontMatter: async (
          _f: TFile,
          fn: (fm: Record<string, unknown>) => void,
        ) => {
          const { ordered, body } = readOrderedFromMarkdown(markdown);
          const rec = Object.fromEntries(ordered) as Record<string, unknown>;
          fn(rec);
          markdown = buildMarkdownWithFrontmatter(
            Object.entries(rec) as [string, unknown][],
            body,
          );
        },
      },
    } as unknown as App;
    await writeFrontmatter(app, file, (fm) => fmSet(fm, "b", 2));
    const after = readOrderedFromMarkdown(markdown);
    expect(fmGet(after.ordered, "b")).toBe(2);
    const rem = fmGet(after.ordered, "reminders") as unknown[];
    expect(rem?.[0]).toMatchObject({ id: "x", type: "relative" });
  });
});

describe("immutable helpers", () => {
  const base: OrderedFrontmatter = [
    ["a", 1],
    ["b", 2],
  ];

  it("fmSet updates and fmDelete removes", () => {
    expect(fmGet(base, "a")).toBe(1);
    const s = fmSet(base, "a", 9);
    expect(fmGet(s, "a")).toBe(9);
    expect(fmGet(base, "a")).toBe(1);
    const d = fmDelete(s, "b");
    expect(d.length).toBe(1);
  });

  it("fmRename and fmReorder", () => {
    const r = fmRename(base, "a", "aa");
    expect(fmGet(r, "aa")).toBe(1);
    const o = fmReorder(r, ["b", "aa"]);
    expect(o.map(([k]) => k)).toEqual(["b", "aa"]);
  });

  it("fmAdd at index", () => {
    const x = fmAdd(base, "z", 0, 0);
    expect(x.map(([k]) => k)).toEqual(["z", "a", "b"]);
  });

  it("fmAdd delegates to fmSet when key exists", () => {
    const x = fmAdd(base, "a", 99);
    expect(fmGet(x, "a")).toBe(99);
  });

  it("fmRename no-op when from === to", () => {
    expect(fmRename(base, "a", "a")).toBe(base);
  });
});

describe("applyOrderedFrontmatter", () => {
  it("replaces keys on a plain object", () => {
    const fm: Record<string, unknown> = { a: 1, b: 2, c: 3 };
    applyOrderedFrontmatter(fm, [
      ["b", 9],
      ["d", 4],
    ]);
    expect(fm).toEqual({ b: 9, d: 4 });
  });

  it("enumeration order follows ordered list (reorders in-place object keys)", () => {
    const fm: Record<string, unknown> = { z: 1, a: 2 };
    applyOrderedFrontmatter(fm, [
      ["a", 2],
      ["z", 1],
    ]);
    expect(Object.keys(fm)).toEqual(["a", "z"]);
  });
});

describe("writeFrontmatter + readOrderedFrontmatter (mock App)", () => {
  function createMockApp(initialMarkdown: string): {
    app: App;
    file: TFile;
    getMarkdown: () => string;
  } {
    let markdown = initialMarkdown;
    const file = { path: "t.md", extension: "md" } as TFile;
    const app = {
      vault: {
        read: async () => markdown,
      },
      fileManager: {
        processFrontMatter: async (
          _f: TFile,
          fn: (fm: Record<string, unknown>) => void,
        ) => {
          const { ordered, body } = readOrderedFromMarkdown(markdown);
          const fm = Object.fromEntries(ordered) as Record<string, unknown>;
          fn(fm);
          const nextOrdered = Object.entries(fm) as [string, unknown][];
          markdown = buildMarkdownWithFrontmatter(nextOrdered, body);
        },
      },
    } as unknown as App;
    return {
      app,
      file,
      getMarkdown: () => markdown,
    };
  }

  it("applies mutator via processFrontMatter", async () => {
    const raw = loadFixture("simple.md");
    const { app, file, getMarkdown } = createMockApp(raw);
    await writeFrontmatter(app, file, (fm) => fmSet(fm, "extra", true));
    const after = readOrderedFromMarkdown(getMarkdown());
    expect(fmGet(after.ordered, "extra")).toBe(true);
  });

  it("readOrderedFrontmatter reads via vault.read", async () => {
    const raw = loadFixture("simple.md");
    const { app, file } = createMockApp(raw);
    const ordered = await readOrderedFrontmatter(app, file);
    expect(fmGet(ordered, "title")).toBe("My note");
  });

  it("readOrderedFrontmatter wraps parse errors with file path", async () => {
    const dup = `---
test01: a
price: hi
test01: b
---
`;
    const file = { path: "_templates/book_detail.md", extension: "md" } as TFile;
    const app = {
      vault: {
        read: async () => dup,
      },
    } as unknown as App;
    await expect(readOrderedFrontmatter(app, file)).rejects.toThrow(
      /cannot read the front matter of _templates\/book_detail\.md:.*Map keys must be unique/s,
    );
  });
});

describe("error paths for 100% coverage", () => {
  it("parseDocument errors surface", () => {
    expect(() => parseYamlBlockToOrdered("[")).toThrow();
  });

  it("comment-only YAML block yields empty mapping (null root)", () => {
    expect(parseYamlBlockToOrdered("# only a comment\n")).toEqual([]);
  });

  it("YAML alias node as value hits unsupported-node guard", () => {
    expect(() =>
      parseYamlBlockToOrdered("a: &x 1\nb: *x\n"),
    ).toThrow("unsupported YAML value at front matter key");
  });

  it("keys starting with _ are plain fields", () => {
    expect(parseYamlBlockToOrdered("_migrations:\n  - op: rename\n    meta:\n      x: 1\n_inherits: x\n")).toEqual([
      ["_migrations", [{ op: "rename", meta: { x: 1 } }]],
      ["_inherits", "x"],
    ]);
  });

  it("buildMarkdownWithFrontmatter handles empty ordered", () => {
    expect(buildMarkdownWithFrontmatter([], "x")).toBe("---\n---\nx");
  });

  it("fmReorder skips unknown keys and appends the rest", () => {
    const o: OrderedFrontmatter = [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ];
    const r = fmReorder(o, ["missing", "c", "a"]);
    expect(r.map(([k]) => k)).toEqual(["c", "a", "b"]);
  });
});
