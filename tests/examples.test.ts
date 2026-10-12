import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHAPTERS, missingOptions, operationsUsed, pageOfExample, PAGES, pagesProblems, pagesUsing, renderPage, runChapter, type ChapterRun } from "../docs/examples/index";
import { OPERATIONS } from "../src/api/catalog";
import { chapterTestFile } from "./helpers/examples";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The docs site's examples (docs/examples/) as a whole. Each chapter runs against a real engine in
// its own test file, tests/examples/<slug>.test.ts, so vitest runs the chapters in parallel.
describe("docs examples", () => {
  it("use every operation of the API", () => {
    const used = operationsUsed();
    expect(OPERATIONS.map((o) => o.name).filter((n) => !used.has(n))).toEqual([]);
  });

  it("are each on exactly one guide page (docs/examples/pages.ts)", () => {
    expect(pagesProblems()).toEqual([]);
    expect(PAGES.every((p) => /^guides\/[a-z-]+\/[a-z-]+$/.test(p.path)), "pages live in guides/<area>/").toBe(true);
    for (const p of PAGES) if (p.include) expect(fs.existsSync(path.join(root, p.include)), p.include).toBe(true);
  });

  it("find what is wrong with the pages", () => {
    const [chapter] = CHAPTERS;
    const [first, second] = chapter!.examples;
    const page = (path: string, examples: [string, string][]) => ({ path, title: "T", description: "D", order: 1, intro: "I", examples });
    expect(
      pagesProblems(
        [{ ...chapter!, examples: [first!, second!] }],
        [page("guides/a/one", [[chapter!.slug, first!.title], ["nope", "X"], [chapter!.slug, "Missing"]]), page("guides/a/one", [[chapter!.slug, first!.title]])],
      ),
    ).toEqual([
      "guides/a/one: no chapter nope",
      `guides/a/one: no example "Missing" in chapter ${chapter!.slug}`,
      `${chapter!.slug}: "${first!.title}" is on 2 pages: guides/a/one, guides/a/one`,
      `${chapter!.slug}: "${second!.title}" is on no page: add it to a page of docs/examples/pages.ts`,
      "two pages at guides/a/one",
    ]);
    expect(pageOfExample(chapter!.slug, first!.title)?.path).toBe("guides/database-objects/tables");
    expect(pagesUsing("vacuum_table").map((p) => p.path)).toEqual(["guides/history/vacuum"]);
    expect(() => renderPage(page("guides/a/one", [["nope", "X"]]), new Map(), "")).toThrow(/no example "X" in chapter nope/);
  });

  it("have a test file per chapter", () => {
    const files = fs.readdirSync(path.join(root, "tests", "examples")).filter((f) => f.endsWith(".test.ts"));
    const wanted = CHAPTERS.map((c) => chapterTestFile(c.slug));
    expect(wanted.filter((f) => !files.includes(f)), "chapters of docs/examples/index.ts with no tests/examples/<slug>.test.ts: copy tables.test.ts").toEqual([]);
    expect(files.filter((f) => !wanted.includes(f)), "tests/examples/ files of no chapter in docs/examples/index.ts").toEqual([]);
  });

  // Every option that defines the database (docs/examples/coverage.ts): passed by an example call,
  // and, for metastore.yaml's own words, in a metastore.yaml a page shows. That is the engine's
  // output (and many calls take their arguments from earlier answers), so it needs the runs; the
  // chapter files run in other workers, in no fixed order, so the chapters run again here, all at
  // once: this takes as long as the slowest chapter, not their sum.
  it("show every option of the database", async () => {
    const settled = await Promise.allSettled(CHAPTERS.map((c) => runChapter(c)));
    const failed = CHAPTERS.filter((_, i) => settled[i]!.status === "rejected").map((c) => `tests/examples/${chapterTestFile(c.slug)}`);
    expect(failed, "chapters that fail: their test files say why").toEqual([]);
    const runs = settled.map((s) => (s as PromiseFulfilledResult<ChapterRun>).value);
    expect(missingOptions(runs, root)).toEqual({ file: [], calls: [] });
  }, 60_000);
});
