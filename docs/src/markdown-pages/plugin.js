// Every page of the site also as Markdown, for people and agents: /start/quick-start/ is also
// /start/quick-start.md, the home page /index.md (paths.js). The pages come from page.md.ts: the
// content pages rendered to Markdown by starlight-llms-txt's own converter (the one behind
// llms-full.txt), the HTTP API pages of starlight-openapi written from openapi.json (openapi.ts).
// Each HTML page links its twin in <head> (route-middleware.ts) and in its footer
// (src/components/MarkdownLink.astro); docs/worker.js serves them as text/markdown. After the build,
// check.js fails it when a page has no twin, or a twin is not clean Markdown.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMarkdownPages } from "./check.js";

const require = createRequire(import.meta.url);

/**
 * A module inside a package that does not export it (`exports` names only the package entry), found
 * next to that entry. Imported through a Vite alias; an upgrade that moves it stops the build here.
 */
function packageFile(pkg, file) {
  const found = path.join(path.dirname(require.resolve(pkg)), file);
  if (!fs.existsSync(found)) throw new Error(`markdown pages: ${pkg} has no ${file} any more (the .md pages use it): update docs/src/markdown-pages`);
  return found;
}

export default function starlightMarkdownPages() {
  return {
    name: "datanotes-markdown-pages",
    hooks: {
      "config:setup"({ addIntegration, addRouteMiddleware }) {
        addRouteMiddleware({ entrypoint: fileURLToPath(new URL("./route-middleware.ts", import.meta.url)) });
        addIntegration({
          name: "datanotes-markdown-pages",
          hooks: {
            "astro:config:setup"({ injectRoute, updateConfig }) {
              injectRoute({ pattern: "/[...slug].md", entrypoint: fileURLToPath(new URL("./page.md.ts", import.meta.url)), prerender: true });
              updateConfig({
                vite: {
                  resolve: {
                    alias: {
                      "datanotes:llms-txt-markdown": packageFile("starlight-llms-txt", "entryToSimpleMarkdown.ts"),
                      "datanotes:openapi-routes": packageFile("starlight-openapi", "libs/route.ts"),
                    },
                  },
                },
              });
            },
            "astro:build:done"({ dir, logger }) {
              const { pages, problems } = checkMarkdownPages(fileURLToPath(dir));
              if (problems.length) throw new Error(`markdown pages: ${problems.length} problem(s):\n${problems.join("\n")}`);
              logger.info(`${pages} pages, each with its .md`);
            },
          },
        });
      },
    },
  };
}
