// The docs site on Cloudflare Workers: static files from dist/, one canonical address.
// www.datanotes.dev and datanote.dev (the first name) redirect to https://datanotes.dev.
// Every page has a Markdown twin (/start/quick-start/ -> /start/quick-start.md, / -> /index.md;
// src/markdown-pages/), served as text/markdown; a page asked for with `Accept: text/markdown`
// (preferred to text/html) answers with its twin.
const CANONICAL = "datanotes.dev";
const MARKDOWN = "text/markdown; charset=utf-8";
// Paths that redirect: /sitemap.xml (where crawlers look first) to the index Astro writes,
// /favicon.ico to the SVG icon, pages that moved, with their Markdown twins. A redirect keeps the
// anchor (browsers carry it over), so /examples/queries/#store-a-query-as-a-view lands on the
// section when it is on the new page; /reference/tools/#<op> lands on the overview of the
// operations, whose script sends it on to the page of the operation's kind (scripts/gen-docs.mjs).
const MOVED = {
  "/sitemap.xml": "/sitemap-index.xml",
  "/favicon.ico": "/favicon.svg",
  "/guides/javascript-api/": "/develop/client/",
  "/guides/apps/": "/guides/security/tokens/",
  "/guides/apps.md": "/guides/security/tokens.md",
  "/guides/obsidian/": "/administration/use-with-obsidian/",
  // 3.0: the information architecture by area (Get started, Guides, Develop, Reference, Administration)
  "/concepts/how-it-works/": "/start/how-it-works/",
  "/concepts/how-it-works.md": "/start/how-it-works.md",
  "/concepts/build-on-datanotes/": "/develop/build-on-datanotes/",
  "/concepts/build-on-datanotes.md": "/develop/build-on-datanotes.md",
  "/agents/how-agents-use-datanotes/": "/guides/agents/how-agents-use-datanotes/",
  "/agents/how-agents-use-datanotes.md": "/guides/agents/how-agents-use-datanotes.md",
  "/agents/prompts/": "/guides/agents/prompts/",
  "/agents/prompts.md": "/guides/agents/prompts.md",
  "/agents/when-something-goes-wrong/": "/guides/agents/reading-errors/",
  "/agents/when-something-goes-wrong.md": "/guides/agents/reading-errors.md",
  "/guides/tokens/": "/guides/security/tokens/",
  "/guides/tokens.md": "/guides/security/tokens.md",
  "/guides/http-api/": "/develop/http-api/",
  "/guides/http-api.md": "/develop/http-api.md",
  "/guides/client/": "/develop/client/",
  "/guides/client.md": "/develop/client.md",
  "/guides/build-an-app/": "/develop/build-an-app/",
  "/guides/build-an-app.md": "/develop/build-an-app.md",
  "/guides/telemetry/": "/develop/telemetry/",
  "/guides/telemetry.md": "/develop/telemetry.md",
  "/guides/semantic-search/": "/guides/search/semantic/",
  "/guides/semantic-search.md": "/guides/search/semantic.md",
  "/guides/docker/": "/administration/docker/",
  "/guides/docker.md": "/administration/docker.md",
  "/security/": "/guides/security/security-model/",
  "/security.md": "/guides/security/security-model.md",
  "/reference/tools/": "/reference/operations/",
  "/reference/tools.md": "/reference/operations.md",
  "/examples/": "/reference/operations/",
  "/examples.md": "/reference/operations.md",
  "/examples/tables/": "/guides/database-objects/tables/",
  "/examples/tables.md": "/guides/database-objects/tables.md",
  "/examples/columns/": "/guides/database-objects/columns/",
  "/examples/columns.md": "/guides/database-objects/columns.md",
  "/examples/relations/": "/guides/database-objects/relations/",
  "/examples/relations.md": "/guides/database-objects/relations.md",
  "/examples/writing/": "/guides/read-and-write/write-rows/",
  "/examples/writing.md": "/guides/read-and-write/write-rows.md",
  "/examples/queries/": "/guides/read-and-write/read-and-filter/",
  "/examples/queries.md": "/guides/read-and-write/read-and-filter.md",
  "/examples/importing/": "/guides/read-and-write/import-notes/",
  "/examples/importing.md": "/guides/read-and-write/import-notes.md",
  "/examples/structure/": "/guides/database-objects/catalogs-and-schemas/",
  "/examples/structure.md": "/guides/database-objects/catalogs-and-schemas.md",
  "/examples/history/": "/guides/history/table-history/",
  "/examples/history.md": "/guides/history/table-history.md",
  "/examples/vault/": "/guides/search/text/",
  "/examples/vault.md": "/guides/search/text.md",
};

// Helpers are not exported: Workers reads named exports as entrypoints (tests/docs-markdown.test.ts
// tests them through fetch). The twin's path: the same rule as src/markdown-pages/paths.js.
function markdownPathOf(pathname) {
  const route = pathname.replace(/\/+$/, "");
  return route === "" ? "/index.md" : `${route}.md`;
}

/** Whether an Accept header asks for Markdown at least as much as for HTML. */
function prefersMarkdown(accept) {
  const q = (type) => {
    for (const part of (accept ?? "").split(",")) {
      const [media, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
      if (media !== type) continue;
      const weight = params.find((p) => p.startsWith("q="));
      const value = weight ? Number(weight.slice(2)) : 1;
      return Number.isFinite(value) ? value : 0;
    }
    return 0;
  };
  const markdown = q("text/markdown");
  return markdown > 0 && markdown >= q("text/html");
}

/** A copy of `response` with headers that can be changed (the assets' responses are immutable). */
function withHeaders(response, headers) {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
  return copy;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL && !url.hostname.endsWith(".workers.dev")) {
      url.hostname = CANONICAL;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    // addresses asked for that the site does not have under that name (crawlers, old links)
    // a page asked for without its trailing slash moves too
    const key = Object.hasOwn(MOVED, url.pathname) ? url.pathname : Object.hasOwn(MOVED, `${url.pathname}/`) ? `${url.pathname}/` : undefined;
    const moved = key ? MOVED[key] : undefined;
    if (moved) return Response.redirect(new URL(moved, url).toString(), 301);
    if (url.pathname.endsWith(".md")) {
      const response = await env.ASSETS.fetch(request);
      return response.status === 200 ? withHeaders(response, { "Content-Type": MARKDOWN }) : response;
    }
    // a page (a path without an extension) can answer as Markdown: caches must key on Accept
    if (!/\.[^/]*$/.test(url.pathname)) {
      if (prefersMarkdown(request.headers.get("Accept"))) {
        const twin = await env.ASSETS.fetch(new Request(new URL(markdownPathOf(url.pathname), url), request));
        if (twin.status === 200) return withHeaders(twin, { "Content-Type": MARKDOWN, Vary: "Accept" });
      }
      const response = await env.ASSETS.fetch(request);
      return withHeaders(response, { Vary: "Accept" });
    }
    return env.ASSETS.fetch(request);
  },
};
