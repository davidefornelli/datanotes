// The esbuild options of the `datanotes` command (dist/datanotes.cjs), shared by esbuild.service.mjs
// and by the tests that bundle the command the same way (tests/cli-bin.test.ts,
// tests/mcp-bundle.test.ts): a test builds what ships, with only the output file and the embedded
// values of its own.

/**
 * @param {{ outfile: string, version: string, swaggerCss?: string, swaggerJs?: string, uiJs?: string, uiCss?: string }} o
 *   swaggerCss / swaggerJs: Swagger UI's stylesheet and script as JSON strings (empty in tests)
 *   uiJs / uiCss: the database browser's script and stylesheet (scripts/ui-build.mjs) as JSON
 *   strings (`'""'` by default: empty in tests)
 * @returns {import("esbuild").BuildOptions}
 */
export function serviceBuildOptions(o) {
  return {
    entryPoints: ["src/node/cli.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: o.outfile,
    define: {
      SERVICE_VERSION: JSON.stringify(o.version), SWAGGER_UI_CSS: o.swaggerCss ?? '""', SWAGGER_UI_JS: o.swaggerJs ?? '""',
      DATANOTES_UI_JS: o.uiJs ?? '""',
      DATANOTES_UI_CSS: o.uiCss ?? '""',
    },
    // only the unbundled fallbacks (docs-ui.ts, ui.ts) resolve them, at run time; the bundle never
    // reaches them (and esbuild must not try to bundle itself)
    external: ["swagger-ui-dist/package.json", "esbuild"],
    // src/api/docs.ts finds dist/docs with __dirname here; import.meta.url is for its ES module build
    logOverride: { "empty-import-meta": "silent" },
    banner: { js: "#!/usr/bin/env node" },
  };
}
