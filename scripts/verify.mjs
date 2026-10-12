// "Is this change done?" in one command: the checks CI runs, in order, with a summary. A step's
// output is shown only when it fails (its last lines), so the result stays short.
//
//   npm run verify            layers, types, docs build, tests (in-memory and Node host), the
//                             npm package's types (scripts/check-package.mjs)
//   npm run verify:no-docs    the same without the docs build
//   npm run verify:fast       layers, types and the tests related to uncommitted changes (all
//                             tests when package.json or a config file changed)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const fast = args.has("--fast");
const docs = !fast && !args.has("--no-docs");
const TAIL = 60;

/** [name, command, working folder] */
const steps = [
  ["layers", "node scripts/check-layers.mjs", root],
  ["types", "npx tsc -noEmit -skipLibCheck", root],
  // the docs first: the build copies them to dist/docs, where tests/docs-search-quality.test.ts reads them
  ...(docs ? [["docs build", "npm run build", path.join(root, "docs")]] : []),
  ...(fast
    ? [["tests (changed)", "npx vitest run --changed", root]]
    : [
        ["tests", "npx vitest run", root],
        ["tests (Node host)", "npx vitest run --config vitest.node.config.ts", root],
        // the published types (attw, publint, a consumer compiled with nodenext, node16, bundler)
        ["package", "node esbuild.service.mjs && npm run build:api && node scripts/check-package.mjs", root],
      ]),
];

// Node 24.0-24.15 on Windows (libuv 1.51.0) aborts at random with 0xC0000409 on TCP connects to
// 127.0.0.1, which the tests make all the time: vitest then reports "Worker exited unexpectedly".
// Fixed in 24.16.0 (libuv issue 5107).
const [major, minor] = process.versions.node.split(".").map(Number);
if (process.platform === "win32" && major === 24 && minor < 16) {
  console.warn(`verify: WARNING Node ${process.versions.node} on Windows has a libuv bug that kills test workers at random ("Worker exited unexpectedly", 0xC0000409); use Node 24.16.0 or later`);
}

if (docs && !fs.existsSync(path.join(root, "docs", "node_modules"))) {
  console.error("verify: docs/node_modules is missing: run `cd docs && npm ci`, or `npm run verify:no-docs`");
  process.exit(1);
}

const results = [];
for (const [name, command, cwd] of steps) {
  process.stdout.write(`verify: ${name} ... `);
  const started = Date.now();
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = r.status === 0;
  console.log(`${ok ? "ok" : "FAILED"} (${seconds} s)`);
  if (!ok) {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n");
    console.log(out.slice(-TAIL).map((l) => `  | ${l}`).join("\n"));
  }
  results.push({ name, ok, seconds });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nverify: ${failed.length === 0 ? "all passed" : `FAILED: ${failed.map((r) => r.name).join(", ")}`}`);
process.exit(failed.length === 0 ? 0 : 1);
