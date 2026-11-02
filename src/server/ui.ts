/**
 * `GET /datanotes/ui/`: the database browser, a single-page application (`src/ui/`) that is a client
 * of this HTTP API only. The server sends one static page and two same-origin assets, `app.js` and
 * `app.css`; routes live in the URL hash, so no table name or note path reaches the server. The page
 * holds no data and is public like `/datanotes/docs`: every call it makes sends the token the user
 * pastes, as `Authorization: Bearer`. Its Content-Security-Policy allows only same-origin scripts,
 * styles and requests, and no inline script or style.
 *
 * How the assets get here (as `docs-ui.ts` does for Swagger UI):
 * - in `dist/datanotes.cjs` they are embedded at build time: `esbuild.service.mjs` builds the UI
 *   (`scripts/ui-build.mjs`) and defines `DATANOTES_UI_JS` and `DATANOTES_UI_CSS` as the two texts
 *   (string defines, inlined where used: `embedded()` is their only use);
 * - everywhere else (vitest, `tsc`) the identifiers are not defined: `embedded()` returns null and
 *   the UI is built once, lazily, from `src/ui/main.tsx` with esbuild (a devDependency, external in
 *   the bundle, which never reaches this path), with the options of `scripts/ui-build-options.json`.
 */

import { ROUTE_PREFIX } from "./rest";
import type { DocsResponse } from "./docs-ui";

/** Defined by `esbuild.service.mjs`; not defined anywhere else. */
declare const DATANOTES_UI_JS: string;
declare const DATANOTES_UI_CSS: string;

export const UI_PATH = `${ROUTE_PREFIX}/ui`;

/** Same origin only, nothing inline; images also as data: URIs (pictures inside note bodies). */
export const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface Assets {
  js: string;
  css: string;
}

let assets: Assets | null = null;

function embedded(): Assets | null {
  try {
    return { js: DATANOTES_UI_JS, css: DATANOTES_UI_CSS };
  } catch {
    return null; // ReferenceError: not the bundle
  }
}

function built(): Assets {
  const fs = require("fs") as { readFileSync(p: string, enc: "utf8"): string };
  const path = require("path") as { resolve(...p: string[]): string; join(...p: string[]): string };
  const esbuild = require("esbuild") as typeof import("esbuild");
  const root = path.resolve(__dirname, "..", "..");
  const options = JSON.parse(fs.readFileSync(path.join(root, "scripts", "ui-build-options.json"), "utf8")) as import("esbuild").BuildOptions;
  const result = esbuild.buildSync({ ...options, absWorkingDir: root, outdir: "dist/ui", write: false });
  const out = (ext: string): string =>
    result.outputFiles
      .filter((f) => f.path.endsWith(ext))
      .map((f) => f.text)
      .join("");
  return { js: out(".js"), css: out(".css") };
}

/** The UI's script and stylesheet: embedded in the bundle, else built on first use; cached. */
export function uiAssets(): Assets {
  assets ??= embedded() ?? built();
  return assets;
}

function page(v: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Datanotes</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${UI_PATH}/app.css?v=${v}">
</head>
<body>
<div id="app"></div>
<noscript>The Datanotes browser needs JavaScript.</noscript>
<script src="${UI_PATH}/app.js?v=${v}"></script>
</body>
</html>
`;
}

/**
 * The browser's page or one of its assets for a GET of `path`, or null when `path` is not one of
 * them. Assets are referenced with `?v=<version>`, so they may be cached for long.
 */
export function uiResponse(path: string, version: string): DocsResponse | null {
  const v = encodeURIComponent(version || "dev");
  const asset = { "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=31536000, immutable" };
  switch (path) {
    case UI_PATH:
    case `${UI_PATH}/`:
      return {
        type: "text/html; charset=utf-8",
        body: page(v),
        headers: {
          "Content-Security-Policy": UI_CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "X-Frame-Options": "DENY",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cache-Control": "no-cache",
        },
      };
    case `${UI_PATH}/app.js`:
      return { type: "text/javascript; charset=utf-8", body: uiAssets().js, headers: asset };
    case `${UI_PATH}/app.css`:
      return { type: "text/css; charset=utf-8", body: uiAssets().css, headers: asset };
    default:
      return null;
  }
}
