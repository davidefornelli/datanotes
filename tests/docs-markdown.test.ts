import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkMarkdownPages, markdownProblems, pageRoutes } from "../docs/src/markdown-pages/check.js";
import { markdownPathOf } from "../docs/src/markdown-pages/paths.js";
import worker from "../docs/worker.js";
import { PAGES } from "../docs/examples/pages";
import { OPERATION_KINDS } from "../src/api/catalog";

const root = path.resolve(__dirname, "..");

// The docs site's Markdown twins (docs/src/markdown-pages/): the check the docs build runs on
// dist/, and the worker that serves them (docs/worker.js). The build itself renders the pages.

describe("markdown twins: paths", () => {
  it("are the page's path with .md, the home page index.md", () => {
    expect(markdownPathOf("/")).toBe("/index.md");
    expect(markdownPathOf("")).toBe("/index.md");
    expect(markdownPathOf("/start/quick-start/")).toBe("/start/quick-start.md");
    expect(markdownPathOf("/start/quick-start")).toBe("/start/quick-start.md");
    expect(markdownPathOf("/examples/")).toBe("/examples.md");
  });
});

describe("markdown twins: content check", () => {
  const page = (body: string) => `# Title\n\n> What the page is about.\n\n${body}\n`;

  it("accepts clean Markdown, HTML-looking text in code included", () => {
    const md = page(
      [
        "Run `npx datanotes serve --vault <folder>`; the token is in `<store>/settings.json`.",
        "Escaped text \\<view> and an autolink <https://datanotes.dev/>.",
        "```html",
        '<div class="x"><Code lang="yaml" /></div>',
        "import x from 'y';",
        "```",
        "~~~",
        "<section>",
        "~~~",
        "- a list, with a [link](https://datanotes.dev/guides/apps/)",
      ].join("\n"),
    );
    expect(markdownProblems(md)).toEqual([]);
  });

  it("refuses an empty page, or one without its title", () => {
    expect(markdownProblems("")).toEqual(["is empty"]);
    expect(markdownProblems("  \n")).toEqual(["is empty"]);
    expect(markdownProblems("Some text\n")).toEqual(["does not start with a `# Title` line"]);
  });

  it("refuses MDX left in the page: imports, exports, directives", () => {
    expect(markdownProblems(page('import { Code } from "@astrojs/starlight/components";'))).toEqual(['has MDX left: import { Code } from "@astrojs/starlight/components";']);
    expect(markdownProblems(page("export const x = 1;"))).toEqual(["has MDX left: export const x = 1;"]);
    expect(markdownProblems(page(":::note\nText\n:::"))).toEqual(["has a directive left: :::note"]);
  });

  it("refuses raw HTML and component tags outside code", () => {
    expect(markdownProblems(page('<Code lang="yaml" code={x} />'))).toEqual(['has an HTML or component tag left: <Code lang="yaml" code={x} />']);
    expect(markdownProblems(page('<div class="dn-points">'))).toEqual(['has an HTML or component tag left: <div class="dn-points">']);
    expect(markdownProblems(page("text</section>"))).toEqual(["has an HTML or component tag left: </section>"]);
    expect(markdownProblems(page("select_rows(table=<view>)"))).toEqual(["has an HTML or component tag left: <view>"]);
    // a fence left open hides nothing after it: it is code to the end, as Markdown reads it
    expect(markdownProblems(page("```\n<div>"))).toEqual([]);
  });
});

describe("markdown twins: dist check", () => {
  let dist = "";
  afterEach(() => fs.rmSync(dist, { recursive: true, force: true }));

  const write = (rel: string, text: string) => {
    const file = path.join(dist, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const html = (md: string) => `<html><head><link rel="alternate" type="text/markdown" href="${md}"/></head><body></body></html>`;

  it("finds every page, not the assets or the 404 page", () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "dn-docs-"));
    write("index.html", html("/index.md"));
    write("404.html", "<html></html>");
    write("start/quick-start/index.html", html("/start/quick-start.md"));
    write("_astro/index.html", "");
    write("pagefind/index.html", "");
    write("_llms-txt/index.html", "");
    expect(pageRoutes(dist)).toEqual(["/", "/start/quick-start/"]);
  });

  it("passes when every page has a clean twin linked from its head", () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "dn-docs-"));
    write("index.html", html("/index.md"));
    write("index.md", "# Home\n");
    write("examples/index.html", html("/examples.md"));
    write("examples.md", "# Examples\n");
    expect(checkMarkdownPages(dist)).toEqual({ pages: 2, problems: [] });
  });

  it("names the pages without a twin, with a bad one, or without the link", () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "dn-docs-"));
    write("index.html", "<html><head></head></html>");
    write("index.md", "# Home\n");
    write("a/index.html", html("/a.md"));
    write("b/index.html", html("/b.md"));
    write("b.md", "# B\n\n<div>left</div>\n");
    expect(checkMarkdownPages(dist)).toEqual({
      pages: 3,
      problems: ['/: no <link rel="alternate" type="text/markdown" href="/index.md"> in its <head>', "/a/: /a.md is missing", "/b.md has an HTML or component tag left: <div>"],
    });
  });
});

describe("docs worker", () => {
  /** The static assets of dist/: path -> [status, body, content type]. */
  const ASSETS: Record<string, [number, string, string]> = {
    "/": [200, "<html>home</html>", "text/html"],
    "/index.md": [200, "# Home\n", "text/markdown"],
    "/start/quick-start/": [200, "<html>quick start</html>", "text/html"],
    "/start/quick-start.md": [200, "# Quick start\n", "application/octet-stream"],
    "/no-twin/": [200, "<html>no twin</html>", "text/html"],
    "/_astro/site.css": [200, "body{}", "text/css"],
  };
  const fetched: string[] = [];
  const env = {
    ASSETS: {
      async fetch(request: Request) {
        const { pathname } = new URL(request.url);
        fetched.push(pathname);
        const [status, body, type] = ASSETS[pathname] ?? [404, "<html>404</html>", "text/html"];
        return new Response(body, { status, headers: { "Content-Type": type } });
      },
    },
  };
  const get = (url: string, headers: Record<string, string> = {}) => {
    fetched.length = 0;
    return worker.fetch(new Request(url, { headers }), env);
  };

  it("redirects /sitemap.xml, /favicon.ico and moved pages", async () => {
    for (const [from, to] of [
      ["/sitemap.xml", "/sitemap-index.xml"],
      ["/favicon.ico", "/favicon.svg"],
      ["/guides/javascript-api/", "/develop/client/"],
      ["/guides/apps/", "/guides/security/tokens/"],
      ["/guides/apps.md", "/guides/security/tokens.md"],
      ["/guides/obsidian/", "/administration/use-with-obsidian/"],
      // 3.0: the pages by area
      ["/examples/", "/reference/operations/"],
      ["/examples/queries/", "/guides/read-and-write/read-and-filter/"],
      ["/examples/queries", "/guides/read-and-write/read-and-filter/"],
      ["/examples/queries.md", "/guides/read-and-write/read-and-filter.md"],
      ["/examples/history/", "/guides/history/table-history/"],
      ["/reference/tools/", "/reference/operations/"],
      ["/reference/tools.md", "/reference/operations.md"],
      ["/concepts/how-it-works/", "/start/how-it-works/"],
      ["/concepts/build-on-datanotes.md", "/develop/build-on-datanotes.md"],
      ["/agents/prompts/", "/guides/agents/prompts/"],
      ["/agents/when-something-goes-wrong.md", "/guides/agents/reading-errors.md"],
      ["/guides/tokens/", "/guides/security/tokens/"],
      ["/guides/http-api/", "/develop/http-api/"],
      ["/guides/docker/", "/administration/docker/"],
      ["/guides/semantic-search/", "/guides/search/semantic/"],
      ["/security/", "/guides/security/security-model/"],
      ["/security.md", "/guides/security/security-model.md"],
    ] as const) {
      const response = await get(`https://datanotes.dev${from}`);
      expect(response.status, from).toBe(301);
      expect(response.headers.get("Location")).toBe(to.startsWith("https:") ? to : `https://datanotes.dev${to}`);
      expect(fetched).toEqual([]);
    }
    expect((await get("https://datanotes.dev/toString")).status).toBe(404); // own keys only
  });

  it("redirects every moved page to a page of the site", () => {
    // the pages: the sources of docs/src/content/docs, and the ones scripts/gen-docs.mjs writes
    const content = path.join(root, "docs", "src", "content", "docs");
    const routes = new Set<string>();
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs);
        else if (/\.mdx?$/.test(ent.name)) routes.add(path.relative(content, abs).split(path.sep).join("/").replace(/\.mdx?$/, "").replace(/(^|\/)index$/, ""));
      }
    };
    walk(content);
    for (const p of PAGES) routes.add(p.path);
    for (const k of Object.keys(OPERATION_KINDS)) routes.add(`reference/operations/${k}`);
    for (const r of ["reference/operations", "reference/cli", "reference/settings", "reference/errors", "guides/security/security-model", "administration/docker"]) routes.add(r);
    const source = fs.readFileSync(path.join(root, "docs", "worker.js"), "utf8");
    const moved = [...source.slice(source.indexOf("const MOVED")).matchAll(/^\s+"(\/[^"]*)": "(\/[^"]*)",$/gm)].map((m) => [m[1]!, m[2]!] as const);
    expect(moved.length).toBeGreaterThan(40);
    const bad = moved
      .filter(([from]) => !["/sitemap.xml", "/favicon.ico"].includes(from))
      .filter(([from, to]) => {
        const route = to.replace(/^\/|\/$/g, "").replace(/\.md$/, "");
        return !routes.has(route) || from.endsWith(".md") !== to.endsWith(".md") || routes.has(from.replace(/^\/|\/$/g, "").replace(/\.md$/, ""));
      });
    expect(bad, "redirects to a page that does not exist, from a page that still does, or between a page and a twin").toEqual([]);
  });

  it("redirects the other names to https://datanotes.dev", async () => {
    const response = await get("http://www.datanotes.dev/start/quick-start/?x=1");
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://datanotes.dev/start/quick-start/?x=1");
  });

  it("serves the twins as text/markdown", async () => {
    const response = await get("https://datanotes.dev/start/quick-start.md");
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe("# Quick start\n");
    const missing = await get("https://datanotes.dev/nowhere.md");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toBe("text/html");
  });

  it("answers a page with its twin when the request prefers Markdown", async () => {
    for (const accept of ["text/markdown", "text/markdown, text/html;q=0.9", "text/html;q=0.5, text/markdown"]) {
      const response = await get("https://datanotes.dev/start/quick-start/", { Accept: accept });
      expect(await response.text(), accept).toBe("# Quick start\n");
      expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("Vary")).toBe("Accept");
    }
    expect(await (await get("https://datanotes.dev/", { Accept: "text/markdown" })).text()).toBe("# Home\n");
    expect(fetched).toEqual(["/index.md"]);
    expect(await (await get("https://datanotes.dev/start/quick-start", { Accept: "text/markdown" })).text()).toBe("# Quick start\n");
  });

  it("answers HTML otherwise, varying on Accept", async () => {
    for (const accept of ["", "text/html,application/xhtml+xml,*/*;q=0.8", "text/html, text/markdown;q=0.5", "text/markdown;q=0", "text/markdown;q=x"]) {
      const response = await get("https://datanotes.dev/start/quick-start/", accept ? { Accept: accept } : {});
      expect(await response.text(), accept).toBe("<html>quick start</html>");
      expect(response.headers.get("Content-Type")).toBe("text/html");
      expect(response.headers.get("Vary")).toBe("Accept");
    }
    // no twin: the page itself
    const response = await get("https://datanotes.dev/no-twin/", { Accept: "text/markdown" });
    expect(await response.text()).toBe("<html>no twin</html>");
    expect(fetched).toEqual(["/no-twin.md", "/no-twin/"]);
  });

  it("serves the other files untouched", async () => {
    const response = await get("https://datanotes.dev/_astro/site.css", { Accept: "text/markdown" });
    expect(await response.text()).toBe("body{}");
    expect(response.headers.get("Vary")).toBeNull();
    expect(fetched).toEqual(["/_astro/site.css"]);
  });
});
