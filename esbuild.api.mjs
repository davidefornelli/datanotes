// `datanotes/client`, `datanotes/local` and `datanotes/mcp`: the API client as a library (ESM and
// CommonJS, with type declarations from tsconfig.api.json), published next to the `datanotes`
// command. tsc writes ES module declarations (`.d.ts`, NodeNext); this script copies each to a
// CommonJS one (`.d.cts`, its relative imports ending in `.cjs`) for `require` consumers. `datanotes/mcp` holds the engine's tool definitions and the docs tools (which read the
// docs shipped in dist/docs with node:fs): no MCP SDK in it.
import fs from "node:fs";
import esbuild from "esbuild";

for (const [entry, name, platform] of [["src/api/index.ts", "index", "neutral"], ["src/api/local.ts", "local", "node"], ["src/api/mcp.ts", "mcp", "node"]]) {
  for (const format of ["esm", "cjs"]) {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform,
      ...(platform === "neutral" ? { mainFields: ["module", "main"] } : {}),
      target: "es2020",
      format,
      outfile: `dist/api/${name}.${format === "esm" ? "js" : "cjs"}`,
      // src/api/docs.ts finds its folder with __dirname in CommonJS, import.meta.url only in ES modules
      logOverride: { "empty-import-meta": "silent" },
      logLevel: "warning",
    });
  }
}

// The CommonJS declarations: `./catalog.js` becomes `./catalog.cjs`, which TypeScript resolves to
// `catalog.d.cts`. Without them a `require` consumer would get ES module types for a CommonJS file.
let declarations = 0;
for (const file of fs.readdirSync("dist/api")) {
  if (!file.endsWith(".d.ts")) continue;
  const text = fs.readFileSync(`dist/api/${file}`, "utf8");
  const cjs = text.replace(/((?:from |import\()\s*["']\.\/[^"']+)\.js(["'])/g, "$1.cjs$2");
  fs.writeFileSync(`dist/api/${file.replace(/\.d\.ts$/, ".d.cts")}`, cjs);
  declarations++;
}
console.log(`dist/api: index, local, mcp (esm, cjs), ${declarations} declarations (.d.ts, .d.cts)`);
