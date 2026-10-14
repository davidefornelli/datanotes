#!/usr/bin/env node
/**
 * A source map for `dist/datanotes.cjs`, so CPU profiles of the built engine name src/ files and
 * lines: the same esbuild build as esbuild.service.mjs, with `sourcemap`, into <out>/ (never into
 * dist/). It checks that the code is the same as dist/datanotes.cjs (the build is deterministic):
 * the map then applies to profiles of dist/datanotes.cjs.
 *
 *   node bench/scale/sourcemap.mjs --out <folder>    ->  <folder>/datanotes.cjs.map
 */
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, REPO } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(String(args.out ?? path.join(REPO, "bench", "scale", ".map")));
fs.mkdirSync(out, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const ui = path.join(REPO, "node_modules", "swagger-ui-dist");
const text = (f) => JSON.stringify(fs.readFileSync(path.join(ui, f), "utf8"));
const outfile = path.join(out, "datanotes.cjs");
await esbuild.build({
  absWorkingDir: REPO,
  entryPoints: ["src/node/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile,
  define: { SERVICE_VERSION: JSON.stringify(version), SWAGGER_UI_CSS: text("swagger-ui.css"), SWAGGER_UI_JS: text("swagger-ui-bundle.js") },
  external: ["swagger-ui-dist/package.json"],
  logOverride: { "empty-import-meta": "silent" },
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: "external",
  logLevel: "warning",
});
const strip = (s) => s.replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n").trimEnd();
const built = strip(fs.readFileSync(outfile, "utf8"));
const dist = strip(fs.readFileSync(path.join(REPO, "dist", "datanotes.cjs"), "utf8"));
if (built !== dist) {
  console.error("the build differs from dist/datanotes.cjs: run npm run build:service first");
  process.exit(1);
}
console.log(`${outfile}.map (the code is the same as dist/datanotes.cjs)`);
