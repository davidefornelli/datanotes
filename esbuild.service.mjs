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

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

// Swagger UI for GET /datanotes/docs (src/server/docs-ui.ts), embedded so the bundle needs no
// node_modules at run time: its stylesheet and script, as the strings SWAGGER_UI_CSS / _JS.
const ui = "node_modules/swagger-ui-dist";
const text = (f) => JSON.stringify(fs.readFileSync(`${ui}/${f}`, "utf8"));

const { metafile } = await esbuild.build({
  entryPoints: ["src/node/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/datanotes.cjs",
  define: { SERVICE_VERSION: JSON.stringify(version), SWAGGER_UI_CSS: text("swagger-ui.css"), SWAGGER_UI_JS: text("swagger-ui-bundle.js") },
  // only the unbundled fallback (docs-ui.ts) resolves it, at run time; the bundle never reaches it
  external: ["swagger-ui-dist/package.json"],
  // src/api/docs.ts finds dist/docs with __dirname here; import.meta.url is for its ES module build
  logOverride: { "empty-import-meta": "silent" },
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
  metafile: true,
});
fs.copyFileSync("dist/datanotes.cjs", "dist/datanotes-service.cjs");

// dist/THIRD-PARTY-NOTICES.txt: the license of every package inside the bundle, Swagger UI included
// (scripts/third-party-notices.mjs). A license outside the allowlist stops the build.
const packages = [...bundledPackages(metafile), swaggerUi()];
const refused = packages.filter((p) => !licenseAllowed(p.license));
if (refused.length) {
  const list = refused.map((p) => `${p.name} ${p.version} (${p.license})`).join(", ");
  throw new Error(`bundled packages with a license outside the allowlist (scripts/third-party-notices.mjs): ${list}`);
}
fs.writeFileSync("dist/THIRD-PARTY-NOTICES.txt", noticesText(packages));
console.log(`dist/THIRD-PARTY-NOTICES.txt: ${packages.length} packages`);
