// The npm package as its users get it: packs it (`npm pack`, without the prepack build: run
// `npm run build:service` first) and checks the tarball three ways.
//
//   1. @arethetypeswrong/cli: every entry point (`datanotes`, `/client`, `/local`, `/mcp`) resolves
//      to the right types for `import` and `require` under node16/nodenext and bundler. Profile
//      `node16`: the legacy `node10` resolution ignores `exports`, so it never finds a subpath.
//   2. publint --strict: package.json fields, `exports` and the files they point to.
//   3. A tiny consumer project, compiled with the repository's TypeScript against the unpacked
//      package in every module mode users have (nodenext and node16, ES module and CommonJS, and
//      bundler), with skipLibCheck off. Its `@ts-expect-error` lines prove the types are real: a
//      type that silently became `any` would accept the wrong argument and fail the compile.
//
//   npm run check:package

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (pkg, file) => path.join(root, "node_modules", pkg, file);

for (const file of ["dist/datanotes.cjs", "dist/api/index.d.ts", "dist/api/index.d.cts", "dist/api/index.cjs"]) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`check-package: ${file} is missing: run \`npm run build:service\` first`);
    process.exit(1);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-package-"));
const failures = [];

/** Run a Node script, print its output; a failure is recorded under `name`. */
function run(name, args, cwd = root) {
  console.log(`check-package: ${name}`);
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();
  if (r.status !== 0) {
    failures.push(name);
    console.log(out.split("\n").map((l) => `  | ${l}`).join("\n"));
  }
  return r.status === 0;
}

/** The files of a .tgz made by npm pack (ustar), without their leading `package/`. */
function unpack(tgz, into) {
  const tar = zlib.gunzipSync(fs.readFileSync(tgz));
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from, to) => header.subarray(from, to).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 136).trim() || "0", 8);
    const type = field(156, 157);
    const prefix = field(345, 500);
    const name = (prefix ? `${prefix}/` : "") + field(0, 100);
    if (type === "0" || type === "") {
      const target = path.join(into, name.replace(/^package\//, ""));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, tar.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
}

try {
  // 0. the tarball
  const npm = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", work], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (npm.status !== 0) throw new Error(`npm pack failed:\n${npm.stderr}`);
  const tgz = path.join(work, fs.readdirSync(work).find((f) => f.endsWith(".tgz")) ?? "");
  if (!tgz.endsWith(".tgz")) throw new Error("npm pack wrote no .tgz");

  // 1. and 2.
  run("are the types wrong (attw, profile node16)", [bin("@arethetypeswrong/cli", "dist/index.js"), tgz, "--profile", "node16", "--no-emoji", "--no-color"]);
  run("publint --strict", [bin("publint", "src/cli.js"), "run", tgz, "--strict"]);

  // 3. consumers: node_modules/datanotes next to one folder per module mode
  unpack(tgz, path.join(work, "node_modules", "datanotes"));
  const consumer = `
import { DatanotesClient, estimateTokens, OPERATIONS, type ClientOptions } from "datanotes/client";
import * as main from "datanotes";
import { engineTools, type EngineTool } from "datanotes/mcp";
import { readDatabaseId } from "datanotes/local";

const options: ClientOptions = { url: "http://127.0.0.1:1", token: "t" };
const client: DatanotesClient = new DatanotesClient(options);
const tokens: number = estimateTokens("some text");
const tools: EngineTool[] = engineTools();
const id: string | null = readDatabaseId("id: x");

// Each line below is an error only while the types are real: as \`any\` they would compile.
// @ts-expect-error estimateTokens takes a string
estimateTokens(42);
// @ts-expect-error the package root has the same types
main.estimateTokens(42);
// @ts-expect-error ClientOptions needs a url
new DatanotesClient({ token: "t" });
// @ts-expect-error engineTools returns tools, not a string
const notText: string = engineTools();
// @ts-expect-error readDatabaseId takes a string
readDatabaseId(1);

export const used = [client, tokens, tools, id, notText, OPERATIONS.length];
`;
  const modes = [
    ["nodenext, ES module", "module", { module: "nodenext", moduleResolution: "nodenext" }],
    ["nodenext, CommonJS", "commonjs", { module: "nodenext", moduleResolution: "nodenext" }],
    ["node16, ES module", "module", { module: "node16", moduleResolution: "node16" }],
    ["node16, CommonJS", "commonjs", { module: "node16", moduleResolution: "node16" }],
    ["bundler", "module", { module: "esnext", moduleResolution: "bundler" }],
  ];
  for (const [name, type, options] of modes) {
    const dir = path.join(work, name.replace(/[^a-z0-9]+/gi, "-"));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, type }));
    fs.writeFileSync(path.join(dir, "index.ts"), consumer);
    const compilerOptions = { ...options, target: "es2022", lib: ["es2022", "dom"], types: [], strict: true, noEmit: true, skipLibCheck: false };
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, files: ["index.ts"] }));
    run(`consumer types (${name})`, [bin("typescript", "bin/tsc"), "-p", "tsconfig.json"], dir);
  }
} catch (e) {
  failures.push(String(e instanceof Error ? e.message : e));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "check-package: all passed" : `check-package: FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
