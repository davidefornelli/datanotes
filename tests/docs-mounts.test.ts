/**
 * Docs mounts (src/api/docs.ts): the Markdown pages of an installed extension appear in the docs
 * tools under `extensions/<name>/`, next to the package's own pages, which they never replace.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DocsError, DocsLibrary, openDocs, type DocsMount } from "../src/api/docs";
import { docsFixture } from "./helpers/docs-fixture";
import { BOOKS_V1 } from "./helpers/extensions";

const temp: string[] = [];
afterAll(() => {
  for (const d of temp) fs.rmSync(d, { recursive: true, force: true });
});
const main = (() => {
  const d = docsFixture();
  temp.push(d);
  return d;
})();
const booksDocs = path.join(BOOKS_V1, "docs");
const mount: DocsMount = { prefix: "extensions/books", dir: booksDocs };

/** A new folder of pages, by relative path. */
function folder(pages: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dn-mount-"));
  temp.push(d);
  for (const [rel, text] of Object.entries(pages)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  }
  return d;
}

describe("a mount", () => {
  const docs = new DocsLibrary(main, [mount]);

  it("lists its pages under the prefix: index.md is the prefix itself", () => {
    expect(docs.list("extensions/").map((p) => p.path)).toEqual(["extensions/books", "extensions/books/tools"]);
    expect(docs.list("extensions/books").map((p) => p.path)).toEqual(["extensions/books", "extensions/books/tools"]);
    expect(docs.list().map((p) => p.path)).toContain("extensions/books/tools");
  });

  it("reads a page and a section, finds a section by search, and leaves the package's pages alone", () => {
    expect(docs.read("extensions/books/tools#finish_book")).toContain("Marks a book read.");
    expect(docs.read("extensions/books")).toContain("A reading list for your Datanotes database");
    const hit = docs.search("finish book").find((h) => h.path.startsWith("extensions/books/"));
    expect(hit?.path).toBe("extensions/books/tools#finish_book");
    const plain = new DocsLibrary(main);
    expect(docs.read("examples/queries")).toBe(plain.read("examples/queries"));
    expect(plain.list().map((p) => p.path)).not.toContain("extensions/books");
  });

  it("names mount pages in its suggestions", () => {
    let hint = "";
    try {
      docs.read("extensions/books/tool");
    } catch (e) {
      expect(e).toBeInstanceOf(DocsError);
      hint = (e as DocsError).hint ?? "";
    }
    expect(hint).toContain('Did you mean "extensions/books/tools"?');
  });
});

describe("the version of the docs", () => {
  it("is the same with and without mounts, so the engine's docs index still matches", () => {
    const plain = new DocsLibrary(main);
    const withMount = new DocsLibrary(main, [mount]);
    expect(withMount.list().length).toBeGreaterThan(plain.list().length);
    expect(withMount.version()).toBe(plain.version());
  });

  it("still changes when a package page changes", () => {
    const a = folder({ "index.md": "# Docs\n\nOne.\n", "llms.txt": "# Docs\n" });
    const b = folder({ "index.md": "# Docs\n\nTwo.\n", "llms.txt": "# Docs\n" });
    expect(new DocsLibrary(a, [mount]).version()).not.toBe(new DocsLibrary(b, [mount]).version());
  });
});

describe("what a mount adds", () => {
  it("maps nested pages: x.md, a/index.md and a/b.md", () => {
    const dir = folder({ "index.md": "# Top\n", "x.md": "# X\n", "a/index.md": "# A\n", "a/b.md": "# B\n", "notes.txt": "not a page", "a/c/d.md": "# D\n" });
    const docs = new DocsLibrary(main, [{ prefix: "extensions/demo", dir }]);
    expect(docs.list("extensions/").map((p) => p.path)).toEqual(["extensions/demo", "extensions/demo/a", "extensions/demo/a/b", "extensions/demo/a/c/d", "extensions/demo/x"]);
  });

  it("adds nothing for a folder that does not exist", () => {
    const docs = new DocsLibrary(main, [{ prefix: "extensions/gone", dir: path.join(os.tmpdir(), "dn-no-such-docs-folder") }]);
    expect(docs.list().map((p) => p.path)).toEqual(new DocsLibrary(main).list().map((p) => p.path));
  });

  it("never replaces a package page: a key already taken is skipped", () => {
    const dir = folder({ "queries.md": "# Impostor\n\nNot the real page.\n", "extra.md": "# Extra\n" });
    const docs = new DocsLibrary(main, [{ prefix: "examples", dir }]);
    expect(docs.read("examples/queries")).toBe(new DocsLibrary(main).read("examples/queries"));
    expect(docs.list("examples/").map((p) => p.path)).toContain("examples/extra");
    // the skipped page is not a mount page, the added one is: only package pages count in the version
    expect(docs.version()).toBe(new DocsLibrary(main).version());
  });

  it("reads mounts in the order of their prefixes, and the first of two equal prefixes wins", () => {
    const a = folder({ "index.md": "# From a\n" });
    const b = folder({ "index.md": "# From b\n" });
    const docs = new DocsLibrary(main, [
      { prefix: "extensions/z", dir: b },
      { prefix: "extensions/m", dir: a },
      { prefix: "extensions/m", dir: b },
    ]);
    expect(docs.list("extensions/").map((p) => p.path)).toEqual(["extensions/m", "extensions/z"]);
    expect(docs.read("extensions/m")).toContain("From a");
  });
});

describe("openDocs with mounts", () => {
  it("caches one library per folder and mounts", () => {
    const a = openDocs(main, [mount]);
    expect(openDocs(main, [mount])).toBe(a);
    expect(openDocs(main, [{ ...mount }])).toBe(a);
    expect(openDocs(main, [])).not.toBe(a);
    expect(openDocs(main)).toBe(openDocs(main, []));
    expect(openDocs(main, [{ prefix: "extensions/other", dir: booksDocs }])).not.toBe(a);
    expect(a.mounts).toEqual([mount]);
  });
});
