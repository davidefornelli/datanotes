/**
 * One chapter of the docs site's examples (docs/examples/) as a test. Each chapter has its own file,
 * tests/examples/<slug>.test.ts, that only calls `testChapter`: vitest runs the files in parallel,
 * so the chapters (mostly waiting for hand edits and webhooks to be picked up) no longer add up.
 * tests/examples.test.ts checks that every chapter has its file, and that the chapters together use
 * every operation and show every option of the database.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderExample } from "../../docs/examples/render";
import { runChapter } from "../../docs/examples/run";
import type { Chapter } from "../../docs/examples/types";

/** The test file of a chapter, in tests/examples/. */
export const chapterTestFile = (slug: string) => `${slug}.test.ts`;

/**
 * The chapter, run against a real engine: a call that is refused where the page says it works, or
 * works where the page shows a refusal, fails here. Call it from tests/examples/<slug>.test.ts.
 */
export function testChapter(chapter: Chapter): void {
  describe("docs examples", () => {
    it(`${chapter.slug}: every call answers as the page says`, async () => {
      expect(path.basename(expect.getState().testPath ?? ""), "the chapter's test file is named after its slug").toBe(chapterTestFile(chapter.slug));
      const run = await runChapter(chapter);
      expect(run.results).toHaveLength(chapter.examples.length);
      chapter.examples.forEach((ex, i) => expect(renderExample(ex, run.results[i]!).startsWith(`## ${ex.title}\n\n${ex.say}\n`), ex.title).toBe(true));
    }, 60_000);
  });
}
