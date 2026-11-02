// The database browser (src/ui/, served at GET /datanotes/ui/ by src/server/ui.ts) as two files,
// app.js and app.css, built by esbuild from src/ui/main.tsx:
//   node scripts/ui-build.mjs      writes dist/ui/app.js and dist/ui/app.css and prints their sizes
// esbuild.service.mjs calls buildUi() and embeds both texts into dist/datanotes.cjs as the strings
// DATANOTES_UI_JS / DATANOTES_UI_CSS, so dist/ui/ is never shipped: it is for inspection only.
// scripts/ui-build-options.json is the one source of the esbuild options; src/server/ui.ts reads it
// too, to build the UI on the fly where the strings are not defined (vitest, tsc).
// Its "alias" maps `entities` to the package's decoder: markdown-it imports only decodeHTML and
// decodeHTMLStrict, and the package's index would also bring its encoding table (23 KB minified)
// into app.js, which esbuild does not drop. Same functions, so the same behaviour.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const OPTIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui-build-options.json");

/**
 * The esbuild options of the UI, for the repository at `root`.
 * @param {string} [root] the repository folder (the default: the current folder)
 * @returns {import("esbuild").BuildOptions & { metafile: true, write: false }}
 */
export function uiBuildOptions(root = process.cwd()) {
  return { ...JSON.parse(fs.readFileSync(OPTIONS, "utf8")), absWorkingDir: root, outdir: "dist/ui", write: false, metafile: true };
}

/**
 * Builds the UI in memory.
 * @param {string} [root] the repository folder (the default: the current folder)
 * @returns {Promise<{ js: string, css: string, metafile: import("esbuild").Metafile }>} css is "" when
 *   the UI has no stylesheet
 */
export async function buildUi(root = process.cwd()) {
  const result = await esbuild.build(uiBuildOptions(root));
  const out = (ext) => result.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? "";
  return { js: out(".js"), css: out(".css"), metafile: result.metafile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ui = await buildUi();
  fs.mkdirSync("dist/ui", { recursive: true });
  for (const [name, text] of [["app.js", ui.js], ["app.css", ui.css]]) {
    fs.writeFileSync(`dist/ui/${name}`, text);
    const kb = (n) => (n / 1024).toFixed(1);
    console.log(`dist/ui/${name}: ${kb(Buffer.byteLength(text))} KB, ${kb(zlib.gzipSync(text).length)} KB gzip`);
  }
}
