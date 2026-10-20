// The commands the package installs: `datanotes` and its short name `dnotes`, one bundle under two
// names. The command reads only its arguments, never the name it was started by.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import { serviceBuildOptions } from "../scripts/service-build.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { help } from "../src/node/help";

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { bin: Record<string, string> };

let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-cli-bin-"));
  // the bundle as esbuild.service.mjs makes it, saved under the short name
  await esbuild.build({ ...serviceBuildOptions({ outfile: path.join(dir, "dnotes.cjs"), version: "0.0.0-test" }), absWorkingDir: ROOT, logLevel: "error" });
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const run = (...args: string[]) => spawnSync(process.execPath, [path.join(dir, "dnotes.cjs"), ...args], { encoding: "utf8", timeout: 30_000 });

describe("the dnotes command", () => {
  it("is installed next to datanotes, from the same bundle", () => {
    expect(pkg.bin.datanotes).toBe("dist/datanotes.cjs");
    expect(pkg.bin.dnotes).toBe(pkg.bin.datanotes);
  });

  it("answers --version and --help under the short name", () => {
    const version = run("--version");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("0.0.0-test");
    const usage = run("--help");
    expect(usage.status).toBe(0);
    expect(usage.stdout).toBe(`${help("0.0.0-test")}\n`);
    expect(usage.stdout).toContain("dnotes is a short name for datanotes");
  });

  it("refuses an unknown command as datanotes does, pointing to the help", () => {
    const r = run("frobnicate");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command "frobnicate" (datanotes --help)');
  });

  it("runs extension check on the fixture from the bundle", () => {
    const r = run("extension", "check", path.join(ROOT, "tests/fixtures/extensions/books/v0.1.0"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ok: books 0.1.0: 2 tools, 2 tables (1 own), 1 views, 1 bases\n");
  });
});
