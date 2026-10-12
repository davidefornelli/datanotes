/**
 * dist/datanotes.cjs bundles third-party packages: esbuild.service.mjs writes their licenses to
 * dist/THIRD-PARTY-NOTICES.txt (scripts/third-party-notices.mjs), which the npm package ships.
 * This test bundles src/node/cli.ts the same way and fails when a bundled package has a license
 * outside the allowlist, or ships no license file.
 */

import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { ALLOWED_LICENSES, bundledPackages, licenseAllowed, noticesText, swaggerUi } from "../scripts/third-party-notices.mjs";

type Package = { name: string; version: string; license: string; files: { name: string; text: string }[] };

const root = path.resolve(__dirname, "..");
let packages: Package[] = [];

beforeAll(async () => {
  const { metafile } = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["src/node/cli.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "dist/datanotes.cjs",
    write: false,
    metafile: true,
    define: { SERVICE_VERSION: '"0.0.0-test"', SWAGGER_UI_CSS: '""', SWAGGER_UI_JS: '""' },
    external: ["swagger-ui-dist/package.json"],
    logLevel: "error",
  });
  packages = [...(bundledPackages(metafile, root) as Package[]), swaggerUi(root) as Package];
}, 60_000);

describe("third-party notices of the bundled command", () => {
  it("every bundled package has an allowed license and ships its license text", () => {
    const names = packages.map((p) => p.name);
    expect(names).toContain("@modelcontextprotocol/sdk");
    expect(names).toContain("yaml");
    expect(names).toContain("swagger-ui-dist");
    expect(packages.filter((p) => !licenseAllowed(p.license)).map((p) => `${p.name} ${p.version} (${p.license})`)).toEqual([]);
    expect(packages.filter((p) => !p.files.some((f) => /^licen[cs]e/i.test(f.name))).map((p) => p.name)).toEqual([]);
  });

  it("names every package, its version and license, and keeps the Swagger UI notice", () => {
    const text = noticesText(packages) as string;
    for (const p of packages) expect(text).toContain(`- ${p.name} ${p.version} (${p.license})`);
    expect(text).toContain("Copyright 2020-2021 SmartBear Software Inc.");
    expect(text).toContain("--- swagger-ui-bundle.js.LICENSE.txt ---");
  });

  it("accepts SPDX expressions only when the allowlist covers them", () => {
    expect(ALLOWED_LICENSES).toEqual(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "Python-2.0"]);
    expect(licenseAllowed("MIT")).toBe(true);
    expect(licenseAllowed("(MIT OR GPL-3.0-only)")).toBe(true);
    expect(licenseAllowed("MIT AND GPL-3.0-only")).toBe(false);
    expect(licenseAllowed("GPL-3.0-only")).toBe(false);
    expect(licenseAllowed("UNKNOWN")).toBe(false);
  });

  it("ship in the npm package, and NOTICE points to them and names Swagger UI", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("dist/THIRD-PARTY-NOTICES.txt");
    const notice = fs.readFileSync(path.join(root, "NOTICE"), "utf8");
    expect(notice).toContain("dist/THIRD-PARTY-NOTICES.txt");
    expect(notice).toContain("Swagger UI");
    expect(notice).toContain("Copyright 2020-2021 SmartBear Software Inc.");
    expect(fs.readFileSync(path.join(root, "esbuild.service.mjs"), "utf8")).toContain('fs.writeFileSync("dist/THIRD-PARTY-NOTICES.txt"');
  });
});
