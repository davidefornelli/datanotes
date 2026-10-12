// The docs site, published at https://datanotes.dev by .github/workflows/docs.yml.
// Generated pages (scripts/gen-docs.mjs, listed in docs/.gitignore): the guide pages made from the
// examples (docs/examples/pages.ts), reference/operations/, reference/cli.md, settings.md and
// errors.md, guides/security/security-model.md and administration/docker.md.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi";
import starlightMarkdownPages from "./src/markdown-pages/plugin.js";
import starlightThemeTerminal from "starlight-theme-terminal";
import { existsSync } from "node:fs";

// Written by scripts/gen-docs.mjs from the engine source (src/server/openapi.ts); `npm run dev` and
// `npm run build` run gen first. starlight-openapi parses it when Astro loads this config.
const openAPISchema = "./public/openapi.json";

// Fails with a readable message instead of a parser stack trace when gen-docs has not run.
const requireOpenAPISchema = {
  name: "require-openapi-schema",
  hooks: {
    "config:setup": ({ command }) => {
      if ((command === "build" || command === "dev") && !existsSync(new URL(openAPISchema, import.meta.url))) {
        throw new Error(`${openAPISchema} is missing: run \`npm run gen\` (or \`npm run build\` / \`npm run dev\`, which run it first).`);
      }
    },
  },
};

export default defineConfig({
  site: "https://datanotes.dev",
  integrations: [
    starlight({
      title: "Datanotes",
      description: "The engine of your second brain: Markdown notes as database tables, for you and your agents.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/davidefornelli/datanotes" }],
      customCss: ["./src/styles/accent.css"],
      // sidebar labels in title case (src/sidebar-labels.ts)
      routeMiddleware: "./src/sidebar-labels.ts",
      // at the end of a page, "On this page" marks the last section (public/toc-end.js)
      head: [
        { tag: "script", attrs: { src: "/toc-end.js", defer: true } },
        // the browser's own bar matches the page (starlight-theme-terminal's backgrounds)
        { tag: "meta", attrs: { name: "theme-color", content: "#17181c", media: "(prefers-color-scheme: dark)" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#fbfcfc", media: "(prefers-color-scheme: light)" } },
      ],
      // EditLink (unused: no `editLink`) shows "View as Markdown" in the page footer (src/markdown-pages/)
      components: { Hero: "./src/components/Hero.astro", EditLink: "./src/components/MarkdownLink.astro" },
      // llms.txt (llmstxt.org): an index for agents, plus the whole docs as llms-full.txt / llms-small.txt
      plugins: [
        // the look: starlight-theme-terminal (github.com/madLinux7/starlight-theme-terminal)
        starlightThemeTerminal(),
        requireOpenAPISchema,
        // HTTP API reference pages under /api/, generated from the OpenAPI document
        starlightOpenAPI([{ base: "api", schema: openAPISchema, sidebar: { label: "HTTP API reference" } }]),
        // every page also as Markdown: /start/quick-start/ -> /start/quick-start.md, / -> /index.md
        starlightMarkdownPages(),
        starlightLlmsTxt({
          details:
            "Datanotes runs a folder of Markdown notes as typed database tables defined in `metastore.yaml`, for people, programs and AI agents. The engine (`npx datanotes serve`) exposes an HTTP API; `datanotes/client` calls it from JavaScript; agents connect through its MCP server, `npx datanotes mcp`. Every write is validated, journaled and undoable.\n\nEvery page of the site is also published as Markdown: add `.md` to its path (`https://datanotes.dev/start/quick-start.md` for `https://datanotes.dev/start/quick-start/`; the home page is `https://datanotes.dev/index.md`), or ask for the page itself with `Accept: text/markdown`.",
          customSets: [
            { label: "Get started", paths: ["index", "start/**"], description: "what Datanotes is, running the engine on your notes, connecting agents, and how the engine works" },
            { label: "Database objects", paths: ["guides/database-objects/**"], description: "catalogs and schemas, tables, columns and types, views, bases, relations and hierarchies, with the engine's real answers" },
            { label: "Data quality", paths: ["guides/data-quality/**"], description: "validation of every write, CHECK constraints, hand edits, check_table and a vault synced between devices" },
            { label: "Read and write data", paths: ["guides/read-and-write/**"], description: "filters, joins and aggregates, writing and moving rows, automatic links, batches, importing existing notes" },
            { label: "Search", paths: ["guides/search/**"], description: "reading and searching notes, semantic search, the link graph" },
            { label: "History and recovery", paths: ["guides/history/**"], description: "the journal and undo, table history and time travel, the change data feed, restores and vacuum" },
            { label: "Agents", paths: ["guides/agents/**"], description: "how an agent works with the vault, prompts with the tools they call, reading errors, the docs offline" },
            { label: "Security", paths: ["guides/security/**"], description: "named tokens and permissions, who did what, the security model" },
            { label: "Develop", paths: ["develop/**"], description: "HTTP API, JavaScript client, concurrent writes, building an app or your own MCP server, the change feed and webhooks, telemetry" },
            { label: "Operations reference", paths: ["reference/operations/**"], description: "every operation of the API (also the MCP tools), by kind, with its parameters" },
            { label: "Administration", paths: ["administration/**"], description: "running the service, Docker, git sync, datanotes status, configuration" },
          ],
          exclude: ["reference/operations/**"],
          // the heading anchors ("Section titled …"), in every output: also in the pages' .md
          customSelectors: { all: [".sl-anchor-link"] },
          optionalLinks: [
            { label: "Connect agents", url: "https://datanotes.dev/start/connect-agents.md", description: "how an agent reaches the engine: the MCP server datanotes mcp, its configuration in MCP clients, and named tokens for agents" },
            { label: "OpenAPI", url: "https://datanotes.dev/openapi.json", description: "OpenAPI 3.1 description of the /datanotes/* routes" },
          ],
        }),
      ],
      // Get started, Guides by area, Develop, Reference by kind, Administration, Release notes
      sidebar: [
        {
          label: "Get Started",
          items: [{ label: "Overview", link: "/" }, "start/quick-start", "start/connect-agents", "start/how-it-works"],
        },
        {
          label: "Guides",
          items: [
            { label: "Database Objects", items: [{ autogenerate: { directory: "guides/database-objects" } }] },
            { label: "Data Quality", items: [{ autogenerate: { directory: "guides/data-quality" } }] },
            { label: "Read and Write Data", items: [{ autogenerate: { directory: "guides/read-and-write" } }] },
            { label: "Search", items: [{ autogenerate: { directory: "guides/search" } }] },
            { label: "History and Recovery", items: [{ autogenerate: { directory: "guides/history" } }] },
            { label: "Agents", items: [{ autogenerate: { directory: "guides/agents" } }] },
            { label: "Security", items: [{ autogenerate: { directory: "guides/security" } }] },
          ],
        },
        { label: "Develop", items: [{ autogenerate: { directory: "develop" } }] },
        {
          label: "Reference",
          items: [
            { label: "Operations", items: [{ autogenerate: { directory: "reference/operations" } }] },
            ...openAPISidebarGroups,
            "reference/cli",
            "reference/settings",
            "reference/errors",
            "reference/compatibility",
            "reference/glossary",
          ],
        },
        { label: "Administration", items: [{ autogenerate: { directory: "administration" } }] },
        { label: "Release Notes", link: "/release-notes/" },
      ],
    }),
  ],
});
