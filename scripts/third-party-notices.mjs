// The third-party notices of dist/datanotes.cjs: every package esbuild bundles into it (read from
// the build's metafile), plus Swagger UI, which esbuild.service.mjs embeds as text. For each one:
// name, version, license, and its license, notice and copyright files as they ship.
// esbuild.service.mjs writes them to dist/THIRD-PARTY-NOTICES.txt; tests/third-party-notices.test.ts
// fails when a bundled package has a license outside ALLOWED_LICENSES.
import fs from "node:fs";
import path from "node:path";

/** The licenses a bundled package may have (SPDX identifiers). */
export const ALLOWED_LICENSES = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "Python-2.0"];

/** The files of a package folder that carry its license, notice or copyright. */
const LEGAL = /^(licen[cs]e|copying|notice|copyright)([.-].*)?$/i;

/** The license of a package.json: `license`, or the old `licenses` list (joined with OR). */
function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  return "UNKNOWN";
}

/**
 * Whether an SPDX license expression is allowed: every term of an AND, at least one of an OR.
 * @param {string} expression
 * @returns {boolean}
 */
export function licenseAllowed(expression) {
  const e = expression.trim().replace(/^\((.*)\)$/, "$1").trim();
  if (/\bOR\b/.test(e)) return e.split(/\s+OR\s+/).some(licenseAllowed);
  if (/\bAND\b/.test(e)) return e.split(/\s+AND\s+/).every(licenseAllowed);
  return ALLOWED_LICENSES.includes(e);
}

/**
 * A package of node_modules: its name, version, license and legal files.
 * @param {string} dir the package folder
 * @param {string[]} [extra] more files of the folder to include (for example a bundle's own LICENSE.txt)
 */
export function packageInfo(dir, extra = []) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const names = fs.readdirSync(dir).filter((f) => LEGAL.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort();
  const files = [...names, ...extra.filter((f) => !names.includes(f))].map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n").trimEnd() }));
  return { name: pkg.name, version: pkg.version, license: licenseOf(pkg), files };
}

/**
 * The packages an esbuild metafile bundles, sorted by name: the folder of each input under
 * node_modules (the innermost one, for a nested node_modules).
 * @param {{ inputs: Record<string, unknown> }} metafile
 * @param {string} [root] the folder the build ran in
 */
export function bundledPackages(metafile, root = process.cwd()) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const p = input.replace(/\\/g, "/");
    const m = p.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (m) dirs.add(m[1]);
  }
  return [...dirs].map((d) => packageInfo(path.resolve(root, d))).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Swagger UI, embedded by esbuild.service.mjs as text: its LICENSE, NOTICE and the notices of its bundle. */
export function swaggerUi(root = process.cwd()) {
  return packageInfo(path.resolve(root, "node_modules", "swagger-ui-dist"), ["swagger-ui-bundle.js.LICENSE.txt"]);
}

/**
 * The text of dist/THIRD-PARTY-NOTICES.txt.
 * @param {{ name: string, version: string, license: string, files: { name: string, text: string }[] }[]} packages
 */
export function noticesText(packages) {
  const rule = "=".repeat(78);
  const head = [
    "Third-party notices for dist/datanotes.cjs",
    "",
    "The `datanotes` command bundles the following packages. Each keeps its own license, reproduced",
    "below with its notice and copyright files. Datanotes itself is licensed under the Apache",
    "License, Version 2.0 (see LICENSE and NOTICE).",
    "",
    ...packages.map((p) => `- ${p.name} ${p.version} (${p.license})`),
  ].join("\n");
  const parts = packages.map((p) => [rule, `${p.name} ${p.version}`, `License: ${p.license}`, rule, ...p.files.flatMap((f) => [`--- ${f.name} ---`, f.text, ""])].join("\n"));
  return `${head}\n\n${parts.join("\n")}`.trimEnd() + "\n";
}
