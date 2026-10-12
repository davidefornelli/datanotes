/**
 * The npm package ships the docs of its version (dist/docs, read by src/api/docs.ts): `files` lists
 * them, the docs build copies them there (scripts/copy-docs.mjs), the release builds them before
 * it publishes and prepublishOnly refuses a package without them. When the docs are built in this
 * checkout, `npm pack --dry-run` shows every page in the package.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const json = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as { files: string[]; scripts: Record<string, string> };
const built = fs.existsSync(path.join(root, "dist", "docs", "index.md"));

/** The Markdown files of a folder, relative to it. */
function markdown(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? markdown(dir, `${rel}${e.name}/`) : e.name.endsWith(".md") ? [`${rel}${e.name}`] : []));
}

describe("the docs in the npm package", () => {
  it("are part of the package, copied by the docs build, built by the release, required before publishing", () => {
    const pkg = json("package.json");
    expect(pkg.files).toContain("dist/docs");
    expect(pkg.scripts.prepublishOnly).toContain("node scripts/copy-docs.mjs --check");
    expect(json("docs/package.json").scripts.build).toMatch(/astro build && node \.\.\/scripts\/copy-docs\.mjs$/);
    const release = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");
    const docsBuild = release.indexOf("        run: npm run build\n        working-directory: docs");
    expect(docsBuild).toBeGreaterThan(0);
    expect(docsBuild).toBeLessThan(release.indexOf("run: npm publish"));
  });

  it.runIf(built)("npm pack lists every page and llms.txt (the docs are built in this checkout)", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
    expect(r.status, r.stderr).toBe(0);
    // npm 10 answers a list of packages, npm 11 an object by package name
    type Packed = { files: { path: string }[] };
    const out = JSON.parse(r.stdout) as Packed[] | Record<string, Packed>;
    const files = new Set((Array.isArray(out) ? out : Object.values(out))[0]!.files.map((f) => f.path));
    const pages = markdown(path.join(root, "dist", "docs"));
    expect(pages.length).toBeGreaterThan(50);
    expect(pages.filter((p) => !files.has(`dist/docs/${p}`))).toEqual([]);
    expect(files.has("dist/docs/llms.txt")).toBe(true);
    const check = spawnSync(process.execPath, ["scripts/copy-docs.mjs", "--check"], { cwd: root, encoding: "utf8" });
    expect([check.status, check.stdout]).toEqual([0, `copy-docs: dist/docs holds ${pages.length} pages\n`]);
  }, 60_000);
});
