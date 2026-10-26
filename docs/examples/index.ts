/**
 * The examples of the docs site. Every example runs against a real engine when the site is built
 * (scripts/gen-docs.mjs) and in the tests, so a page shows what the engine really answers. The
 * examples are grouped in chapters, each run in order on a vault of its own; the guide pages
 * (pages.ts) show them by area. Each chapter has its own test file, tests/examples/<slug>.test.ts:
 * a new chapter needs one too (tests/examples.test.ts names it).
 */

import columns from "./columns";
import history from "./history";
import importing from "./importing";
import linking from "./linking";
import packs from "./packs";
import { PAGES, type GuidePage } from "./pages";
import queries from "./queries";
import relations from "./relations";
import structure from "./structure";
import tables from "./tables";
import vault from "./vault";
import writing from "./writing";
import type { Chapter } from "./types";

export const CHAPTERS: Chapter[] = [tables, columns, relations, writing, linking, queries, importing, structure, history, vault, packs];

export { PAGES, pageOfExample, type GuidePage, type ExampleRef } from "./pages";
export { runChapter, type ChapterRun } from "./run";
export { renderExample, renderPage } from "./render";
export { missingOptions, missingOptionsMessage } from "./coverage";

/** Operations used by the examples, by chapter: every operation of the API must appear somewhere. */
export function operationsUsed(chapters: Chapter[] = CHAPTERS): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const ch of chapters) {
    for (const ex of ch.examples) {
      for (const op of opsOf(ex.steps)) {
        const list = used.get(op) ?? [];
        if (!list.includes(ch.slug)) list.push(ch.slug);
        used.set(op, list);
      }
    }
  }
  return used;
}

/** The operations an example's steps call; the writes inside a batch count too. */
function opsOf(steps: Chapter["examples"][number]["steps"]): string[] {
  const ops: string[] = [];
  for (const s of steps) {
    if (!s.op) continue;
    ops.push(s.op);
    if (s.op === "batch" && s.args && typeof s.args === "object") {
      for (const o of (s.args.operations as { op: string }[] | undefined) ?? []) ops.push(o.op);
    }
  }
  return ops;
}

/** The guide pages whose examples use an operation, in the order of PAGES. */
export function pagesUsing(op: string, chapters: Chapter[] = CHAPTERS, pages: GuidePage[] = PAGES): GuidePage[] {
  const bySlug = new Map(chapters.map((c) => [c.slug, c]));
  return pages.filter((p) => p.examples.some(([slug, title]) => bySlug.get(slug)?.examples.find((e) => e.title === title && opsOf(e.steps).includes(op))));
}

/**
 * What is wrong with the pages: an example on no page or on two, a page naming an example that
 * does not exist, two pages with one path. Empty when every example is on exactly one page.
 */
export function pagesProblems(chapters: Chapter[] = CHAPTERS, pages: GuidePage[] = PAGES): string[] {
  const problems: string[] = [];
  const shown = new Map<string, string[]>();
  for (const p of pages) {
    for (const [slug, title] of p.examples) {
      const key = `${slug}: ${title}`;
      shown.set(key, [...(shown.get(key) ?? []), p.path]);
      const ch = chapters.find((c) => c.slug === slug);
      if (!ch) problems.push(`${p.path}: no chapter ${slug}`);
      else if (!ch.examples.some((e) => e.title === title)) problems.push(`${p.path}: no example "${title}" in chapter ${slug}`);
    }
  }
  for (const c of chapters) {
    for (const e of c.examples) {
      const on = shown.get(`${c.slug}: ${e.title}`) ?? [];
      if (on.length === 0) problems.push(`${c.slug}: "${e.title}" is on no page: add it to a page of docs/examples/pages.ts`);
      if (on.length > 1) problems.push(`${c.slug}: "${e.title}" is on ${on.length} pages: ${on.join(", ")}`);
    }
  }
  const paths = pages.map((p) => p.path);
  for (const dup of new Set(paths.filter((x, i) => paths.indexOf(x) !== i))) problems.push(`two pages at ${dup}`);
  return problems;
}
