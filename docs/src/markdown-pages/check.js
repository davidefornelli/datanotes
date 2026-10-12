// The check run after every docs build (plugin.js, astro:build:done) and by tests/docs-markdown.test.ts:
// every page of dist/ has its Markdown twin (paths.js), linked from the page's <head>, and the twin
// is clean Markdown: a `# Title` first, no MDX left (imports, exports, directives) and no raw HTML
// or component tags outside code.
import fs from "node:fs";
import path from "node:path";
import { markdownPathOf } from "./paths.js";

/** Folders of dist/ that hold assets, not pages. */
const NOT_PAGES = new Set(["_astro", "_llms-txt", "pagefind"]);

/** The routes of the HTML pages in `dist` ("/", "/concepts/how-it-works/", …), sorted. The 404 page is not one. */
export function pageRoutes(dist) {
  const routes = [];
  const walk = (dir, route) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!(route === "/" && NOT_PAGES.has(entry.name))) walk(path.join(dir, entry.name), `${route}${entry.name}/`);
      } else if (entry.name === "index.html") {
        routes.push(route);
      }
    }
  };
  walk(dist, "/");
  return routes.sort();
}

/** Removes fenced code blocks and inline code: what is left is prose, where no HTML may remain. */
function proseOf(text) {
  const prose = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) fence = marker;
    else if (fence !== null && marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    else if (fence === null) prose.push(line);
  }
  return prose.join("\n").replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "");
}

/** What is wrong with one Markdown page (empty: nothing). */
export function markdownProblems(text) {
  if (!text.trim()) return ["is empty"];
  const problems = [];
  if (!text.startsWith("# ")) problems.push("does not start with a `# Title` line");
  const prose = proseOf(text);
  const esm = /^(?:import|export)\s.+$/m.exec(prose);
  if (esm) problems.push(`has MDX left: ${esm[0].trim()}`);
  const directive = /^:::.*$/m.exec(prose);
  if (directive) problems.push(`has a directive left: ${directive[0].trim()}`);
  // Markdown escapes a `<` it writes as text (`\<`); an unescaped tag is raw HTML or an MDX component.
  // Autolinks (<https://…>, <mailto:…>) are Markdown.
  const tag = /(?<!\\)<(?![A-Za-z][\w+.-]*:)\/?[A-Za-z][\w.:-]*(?=[\s/>])[^>]*>/.exec(prose);
  if (tag) problems.push(`has an HTML or component tag left: ${tag[0].slice(0, 80)}`);
  return problems;
}

/**
 * Checks the Markdown twins of every page in `dist`.
 * @returns {{ pages: number, problems: string[] }}
 */
export function checkMarkdownPages(dist) {
  const routes = pageRoutes(dist);
  const problems = [];
  for (const route of routes) {
    const md = markdownPathOf(route);
    const file = path.join(dist, ...md.split("/"));
    if (!fs.existsSync(file)) {
      problems.push(`${route}: ${md} is missing`);
      continue;
    }
    for (const problem of markdownProblems(fs.readFileSync(file, "utf8"))) problems.push(`${md} ${problem}`);
    const html = fs.readFileSync(path.join(dist, ...route.split("/"), "index.html"), "utf8");
    if (!html.includes(`<link rel="alternate" type="text/markdown" href="${md}"`)) problems.push(`${route}: no <link rel="alternate" type="text/markdown" href="${md}"> in its <head>`);
  }
  return { pages: routes.length, problems };
}
