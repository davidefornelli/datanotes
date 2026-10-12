/**
 * `GET /datanotes/docs`: the OpenAPI document (`openapi.ts`) in an interactive console, like
 * FastAPI's `/docs`. It is Swagger UI (npm `swagger-ui-dist`), served by the engine itself from the
 * same origin as the API, so "Try it out" works once the user clicks Authorize and pastes a token;
 * the page contacts no other host (no CDN, no validator badge) and its Content-Security-Policy
 * allows only same-origin scripts, styles and requests (the init script is a file, not inline).
 *
 * How the assets get here (the simplest way that works in the bundle, in vitest and in any other
 * bundler of `src/`):
 * - in `dist/datanotes.cjs` (which has no runtime dependencies) they are embedded at build time:
 *   `esbuild.service.mjs` defines `SWAGGER_UI_CSS` and `SWAGGER_UI_JS` as the two files' text
 *   (string defines, inlined where used: `embedded()` is their only use, so the text is in the
 *   bundle once);
 * - everywhere else (vitest, `tsc`, `scripts/gen-docs.mjs`) the identifier is not defined:
 *   `embedded()` returns null and the files are read once, lazily, from
 *   `node_modules/swagger-ui-dist` (a devDependency). Nothing is read until the docs are first
 *   asked for.
 */

import { ROUTE_PREFIX } from "./rest";

/** Defined by `esbuild.service.mjs`; not defined anywhere else. */
declare const SWAGGER_UI_CSS: string;
declare const SWAGGER_UI_JS: string;

export const DOCS_PATH = `${ROUTE_PREFIX}/docs`;

/** Same origin only; images also as data: URIs (Swagger UI's icons are in its CSS). */
export const DOCS_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

interface Assets {
  css: string;
  js: string;
}

let assets: Assets | null = null;

function embedded(): Assets | null {
  try {
    return { css: SWAGGER_UI_CSS, js: SWAGGER_UI_JS };
  } catch {
    return null; // ReferenceError: not the bundle
  }
}

function fromNodeModules(): Assets {
  const fs = require("fs") as { readFileSync(p: string, enc: "utf8"): string };
  const path = require("path") as { dirname(p: string): string; join(...p: string[]): string };
  const dir = path.dirname(require.resolve("swagger-ui-dist/package.json"));
  return { css: fs.readFileSync(path.join(dir, "swagger-ui.css"), "utf8"), js: fs.readFileSync(path.join(dir, "swagger-ui-bundle.js"), "utf8") };
}

/** Swagger UI's stylesheet and script, without their source-map comments (the maps are not served). */
export function swaggerUiAssets(): Assets {
  if (!assets) {
    const raw = embedded() ?? fromNodeModules();
    assets = { css: raw.css.replace(/\/\*# sourceMappingURL=[^*]*\*\/\s*$/, ""), js: raw.js.replace(/\/\/# sourceMappingURL=\S*\s*$/, "") };
  }
  return assets;
}

function page(v: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Datanotes API</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${DOCS_PATH}/swagger-ui.css?v=${v}">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${DOCS_PATH}/swagger-ui-bundle.js?v=${v}"></script>
<script src="${DOCS_PATH}/init.js?v=${v}"></script>
</body>
</html>
`;
}

const INIT = `window.ui = SwaggerUIBundle({
  url: "${ROUTE_PREFIX}/openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  persistAuthorization: true,
  tryItOutEnabled: true,
  displayRequestDuration: true,
  filter: true,
  docExpansion: "none",
  validatorUrl: null,
  presets: [SwaggerUIBundle.presets.apis],
  layout: "BaseLayout"
});
`;

export interface DocsResponse {
  type: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * The docs page or one of its assets for a GET of `path`, or null when `path` is not one of them.
 * Assets are referenced with `?v=<version>`, so they may be cached for long.
 */
export function docsResponse(path: string, version: string): DocsResponse | null {
  const v = encodeURIComponent(version || "dev");
  const asset = { "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=31536000, immutable" };
  switch (path) {
    case DOCS_PATH:
    case `${DOCS_PATH}/`:
      return {
        type: "text/html; charset=utf-8",
        body: page(v),
        headers: { "Content-Security-Policy": DOCS_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-cache" },
      };
    case `${DOCS_PATH}/swagger-ui.css`:
      return { type: "text/css; charset=utf-8", body: swaggerUiAssets().css, headers: asset };
    case `${DOCS_PATH}/swagger-ui-bundle.js`:
      return { type: "text/javascript; charset=utf-8", body: swaggerUiAssets().js, headers: asset };
    case `${DOCS_PATH}/init.js`:
      return { type: "text/javascript; charset=utf-8", body: INIT, headers: asset };
    default:
      return null;
  }
}
