/**
 * Every docs link an error can give (src/core/hints.ts, src/api/guidance.ts and the other
 * `${DOCS_BASE}/…` addresses in src/) points to a page of the docs site and to a heading of that
 * page: the hand-written pages of docs/src/content/docs, the guide pages made from the examples
 * (docs/examples/pages.ts: their sections are the examples they show and the headings of the text
 * they include, generated at build time) and the reference of the operations (a page per kind,
 * one section per operation of src/api/catalog.ts). The pages are read from their sources, so
 * this needs no docs build; the build itself checks every page has its Markdown twin
 * (tests/docs-markdown.test.ts). Each link also has its offline form, `read_docs("<page>#<anchor>")`,
 * which names the same page and heading, and which read_docs finds.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGES } from "../docs/examples/index";
import { markdownPathOf } from "../docs/src/markdown-pages/paths.js";
import { OPERATION_KIND, OPERATION_KINDS, OPERATIONS } from "../src/api/catalog";
import { docsRef, DocsLibrary } from "../src/api/docs";
import { ERRORS_DOCS, guidedText, localDocs, offlineDocsText, OPERATIONS_DOCS, toolDocs } from "../src/api/guidance";
import { DOCS, DOCS_BASE, docsUrl } from "../src/core/hints";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const content = path.join(root, "docs", "src", "content", "docs");

/** A heading's anchor as Starlight makes it (github-slugger): lowercase, punctuation dropped, spaces as dashes. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The anchors of a Markdown page's `##`…`######` headings (code blocks left out). */
function anchorsOf(markdown: string): Set<string> {
  const out = new Set<string>();
  let fence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(/^#{2,6} (.+)$/);
    if (m) out.add(slug(m[1]!.trim()));
  }
  return out;
}

/** The text of a generated guide page that the anchors come from: its intro, the text it includes, its examples' headings. */
function generatedText(page: (typeof PAGES)[number]): string {
  const included = page.include ? fs.readFileSync(path.join(root, page.include), "utf8") : "";
  return [page.intro, included, ...page.examples.map(([, title]) => `## ${title}\n\nText.\n`)].join("\n\n");
}

/** The reference of the operations: a page per kind, a section per operation. */
const KIND_PAGES = (Object.keys(OPERATION_KINDS) as (keyof typeof OPERATION_KINDS)[]).map((k) => ({ kind: k, ops: OPERATIONS.map((o) => o.name).filter((n) => OPERATION_KIND[n] === k) }));

/** The docs pages, by their Markdown path (`/guides/agents/prompts.md`), with their anchors. */
function pages(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (/\.mdx?$/.test(ent.name)) {
        const rel = path.relative(content, abs).split(path.sep).join("/").replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
        out.set(markdownPathOf(rel === "" ? "/" : `/${rel}/`), anchorsOf(fs.readFileSync(abs, "utf8")));
      }
    }
  };
  walk(content);
  // generated at build time (scripts/gen-docs.mjs), so not in the sources of a fresh checkout
  for (const p of PAGES) out.set(`/${p.path}.md`, anchorsOf(generatedText(p)));
  for (const { kind, ops } of KIND_PAGES) out.set(`/reference/operations/${kind}.md`, new Set(ops));
  out.set("/reference/operations.md", new Set(KIND_PAGES.map(({ kind }) => slug(OPERATION_KINDS[kind].label))));
  return out;
}

/**
 * The docs as read_docs reads them (src/api/docs.ts), made from the same sources as pages(): the
 * hand-written pages with their headings, and the generated ones as their headings alone. So
 * read_docs' own reading of headings and anchors is checked without a docs build.
 */
function docsFromSources(): DocsLibrary {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-error-docs-"));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const walk = (from: string) => {
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const abs = path.join(from, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (/\.mdx?$/.test(ent.name)) {
        const rel = path.relative(content, abs).split(path.sep).join("/").replace(/\.mdx?$/, "");
        write(`${rel}.md`, `# ${rel}\n\n${fs.readFileSync(abs, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}`);
      }
    }
  };
  walk(content);
  for (const p of PAGES) write(`${p.path}.md`, `# ${p.title}\n\n${generatedText(p)}`);
  for (const { kind, ops } of KIND_PAGES) write(`reference/operations/${kind}.md`, `# ${kind}\n\n${ops.map((o) => `## \`${o}\`\n\nText.\n`).join("\n")}`);
  write("reference/operations.md", `# Operations\n\n${KIND_PAGES.map(({ kind }) => `## ${OPERATION_KINDS[kind].label}\n\nText.\n`).join("\n")}`);
  write("llms.txt", "# Datanotes\n");
  if (!fs.existsSync(path.join(dir, "index.md"))) write("index.md", "# Datanotes\n");
  return new DocsLibrary(dir);
}

/** Every `${DOCS_BASE}/…` address written in src/ (the client's and the MCP server's own hints). */
function addressesInSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.name.endsWith(".ts")) {
        for (const m of fs.readFileSync(abs, "utf8").matchAll(/\$\{DOCS_BASE\}(\/[a-z0-9/_.-]+(?:#[a-z0-9_-]+)?)/g)) out.push(`${DOCS_BASE}${m[1]}`);
      }
    }
  };
  walk(path.join(root, "src"));
  return out.filter((u) => !u.endsWith("/reference/operations/"));
}

describe("the docs links of errors", () => {
  const known = pages();
  const problem = (url: string): string | null => {
    const m = url.match(/^https:\/\/datanotes\.dev(\/[^#]+\.md)(?:#(.+))?$/);
    if (!m) return `${url}: not a Markdown page of ${DOCS_BASE}`;
    const anchors = known.get(m[1]!);
    if (!anchors) return `${url}: no page ${m[1]}`;
    if (m[2] !== undefined && !anchors.has(m[2])) return `${url}: no heading #${m[2]} on ${m[1]} (it has: ${[...anchors].join(", ")})`;
    return null;
  };

  it("makes anchors as Starlight does", () => {
    expect(slug("Change a column’s attributes")).toBe("change-a-columns-attributes");
    expect(slug("Trim old history with `vacuum_table`")).toBe("trim-old-history-with-vacuum_table");
    expect(slug("Read the note that shows a view with `{this.*}`")).toBe("read-the-note-that-shows-a-view-with-this");
    expect(slug("Limit link targets with `ref_by` and `ref_where`")).toBe("limit-link-targets-with-ref_by-and-ref_where");
    expect(anchorsOf("# Title\n\n## One\n\n```md\n## Not a heading\n```\n### Two `x`\n")).toEqual(new Set(["one", "two-x"]));
  });

  it("point to an existing page and heading: every topic of the hints", () => {
    const bad = (Object.keys(DOCS) as (keyof typeof DOCS)[]).map((t) => problem(docsUrl(t))).filter(Boolean);
    expect(bad).toEqual([]);
  });

  it("point to an existing page and heading: the reference of every operation", () => {
    expect(OPERATIONS.map((o) => problem(toolDocs(o.name))).filter(Boolean)).toEqual([]);
    expect(problem(OPERATIONS_DOCS)).toBeNull();
    expect(toolDocs("no_such_operation")).toBe(OPERATIONS_DOCS);
  });

  it("point to an existing page and heading: the addresses written in the client, the MCP server and the engine", () => {
    const urls = [...addressesInSources(), ERRORS_DOCS, OPERATIONS_DOCS];
    expect(urls.length).toBeGreaterThan(5);
    expect(urls.map(problem).filter(Boolean)).toEqual([]);
  });

  it("give the same page as read_docs reads it offline, and read_docs finds it", () => {
    const urls = [...(Object.keys(DOCS) as (keyof typeof DOCS)[]).map(docsUrl), ...OPERATIONS.map((o) => toolDocs(o.name)), ...addressesInSources(), ERRORS_DOCS, OPERATIONS_DOCS];
    const bad: string[] = [];
    const built = docsFromSources();
    for (const url of urls) {
      const local = localDocs(url);
      const ref = local && /^read_docs\("(.+)"\)$/.exec(local)?.[1];
      if (!ref) {
        bad.push(`${url}: no offline form`);
        continue;
      }
      const { page, anchor } = docsRef(ref);
      // the same page and heading as the address
      if (problem(`${DOCS_BASE}/${page}.md${anchor ? `#${anchor}` : ""}`) !== null || `${DOCS_BASE}/${page}.md${anchor ? `#${anchor}` : ""}` !== url) bad.push(`${url}: ${local} is another page`);
      try {
        built.text(ref);
      } catch (e) {
        bad.push(`${url}: ${local} fails: ${(e as Error).message}`);
      }
    }
    expect(bad).toEqual([]);
    expect(guidedText("x", { hint: "y", docs: docsUrl("filters") })).toBe('x\nHint: y\nDocs: https://datanotes.dev/guides/read-and-write/read-and-filter.md#compare-values-with-operators (offline: read_docs("guides/read-and-write/read-and-filter#compare-values-with-operators"))');
    // the MCP server keeps only the read_docs call, on every docs line (a batch has one per step); another address stays
    const text = `${guidedText("step", { hint: "y", docs: docsUrl("filters") })}\n${guidedText("batch", { hint: "z", docs: `${DOCS_BASE}/x.md` })}`;
    expect(offlineDocsText(text)).toBe('step\nHint: y\nDocs: read_docs("guides/read-and-write/read-and-filter#compare-values-with-operators")\nbatch\nHint: z\nDocs: read_docs("x")');
    expect(offlineDocsText("x\nHint: y\nDocs: https://example.com/page")).toBe("x\nHint: y\nDocs: https://example.com/page");
  });

  it("find a broken link", () => {
    expect(problem("https://datanotes.dev/guides/database-objects/tables.md#no-such-heading")).toMatch(/no heading #no-such-heading on \/guides\/database-objects\/tables\.md/);
    expect(problem("https://datanotes.dev/nowhere.md")).toBe("https://datanotes.dev/nowhere.md: no page /nowhere.md");
    expect(problem("https://datanotes.dev/guides/database-objects/tables/")).toMatch(/not a Markdown page/);
    expect(problem("https://datanotes.dev/examples/tables.md")).toBe("https://datanotes.dev/examples/tables.md: no page /examples/tables.md");
  });
});
