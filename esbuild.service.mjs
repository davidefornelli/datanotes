// The `datanotes` command as one file without dependencies (the npm package's bin):
//   node dist/datanotes.cjs serve --vault <folder>
//   node dist/datanotes.cjs mcp --vault <folder>
// Everything it imports is bundled, the MCP SDK of `datanotes mcp` included: the SDK is a
// devDependency, so installing the package installs nothing else.
// dist/datanotes-service.cjs is the same file, under the name existing deployments start.
// dist/THIRD-PARTY-NOTICES.txt lists the license of every package bundled in it.
import esbuild from "esbuild";
import fs from "node:fs";
import { bundledPackages, licenseAllowed, noticesText, swaggerUi } from "./scripts/third-party-notices.mjs";
import { serviceBuildOptions } from "./scripts/service-build.mjs";
import { buildUi } from "./scripts/ui-build.mjs";

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

// Swagger UI for GET /datanotes/docs (src/server/docs-ui.ts), embedded so the bundle needs no
// node_modules at run time: its stylesheet and script, as the strings SWAGGER_UI_CSS / _JS.
const ui = "node_modules/swagger-ui-dist";
const text = (f) => JSON.stringify(fs.readFileSync(`${ui}/${f}`, "utf8"));

// The database browser for GET /datanotes/ui/ (src/server/ui.ts), built from src/ui/ and embedded
// the same way: its script and stylesheet, as the strings DATANOTES_UI_JS / _CSS.
const browser = await buildUi();

const { metafile } = await esbuild.build({
  ...serviceBuildOptions({
    outfile: "dist/datanotes.cjs",
    version,
    swaggerCss: text("swagger-ui.css"),
    swaggerJs: text("swagger-ui-bundle.js"),
    uiJs: JSON.stringify(browser.js),
    uiCss: JSON.stringify(browser.css),
  }),
  logLevel: "info",
  metafile: true,
});
fs.copyFileSync("dist/datanotes.cjs", "dist/datanotes-service.cjs");
const kb = (text) => Math.round(Buffer.byteLength(text) / 1024);
console.log(`dist/datanotes.cjs: database browser ${kb(browser.js)} KB js, ${kb(browser.css)} KB css`);

// dist/THIRD-PARTY-NOTICES.txt: the license of every package inside the bundle, the database
// browser's and Swagger UI included (scripts/third-party-notices.mjs), once each, by name. A license
// outside the allowlist stops the build.
const unique = new Map();
for (const p of [...bundledPackages(metafile), ...bundledPackages(browser.metafile), swaggerUi()]) unique.set(`${p.name}@${p.version}`, p);
const packages = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const refused = packages.filter((p) => !licenseAllowed(p.license));
if (refused.length) {
  const list = refused.map((p) => `${p.name} ${p.version} (${p.license})`).join(", ");
  throw new Error(`bundled packages with a license outside the allowlist (scripts/third-party-notices.mjs): ${list}`);
}
fs.writeFileSync("dist/THIRD-PARTY-NOTICES.txt", noticesText(packages));
console.log(`dist/THIRD-PARTY-NOTICES.txt: ${packages.length} packages`);
