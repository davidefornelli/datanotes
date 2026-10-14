// The esbuild options of the `datanotes` command (dist/datanotes.cjs), shared by esbuild.service.mjs
// and by the tests that bundle the command the same way (tests/cli-bin.test.ts,
// tests/mcp-bundle.test.ts): a test builds what ships, with only the output file and the embedded
// values of its own.

/**
 * @param {{ outfile: string, version: string, swaggerCss?: string, swaggerJs?: string }} o
 *   swaggerCss / swaggerJs: Swagger UI's stylesheet and script as JSON strings (empty in tests)
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
    define: { SERVICE_VERSION: JSON.stringify(o.version), SWAGGER_UI_CSS: o.swaggerCss ?? '""', SWAGGER_UI_JS: o.swaggerJs ?? '""' },
    // only the unbundled fallback (docs-ui.ts) resolves it, at run time; the bundle never reaches it
    external: ["swagger-ui-dist/package.json"],
    // src/api/docs.ts finds dist/docs with __dirname here; import.meta.url is for its ES module build
    logOverride: { "empty-import-meta": "silent" },
    banner: { js: "#!/usr/bin/env node" },
  };
}
