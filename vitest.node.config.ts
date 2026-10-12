// The engine tests on the headless Node host instead of the fake App (`npm run test:node`).
//
// `VAULT_HOST_TESTS_ONLY=1` runs only the test files the host changes: those that reach
// tests/helpers/db-vault.ts, directly or through other modules of tests/. The others do the same
// on either host, so where both configs run on one system (CI on Linux) they need not run twice.
import fs from "node:fs";
import path from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/** The test files that reach the vault helper, as paths relative to the repository. */
function hostTestFiles(): string[] {
  const root = path.resolve(__dirname, "tests");
  const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => path.join(root, f));
  const imports = new Map(
    files.map((f) => {
      const specs = [...fs.readFileSync(f, "utf8").matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => path.resolve(path.dirname(f), m[1]!).replace(/\.ts$/, "") + ".ts");
      return [f, specs] as const;
    }),
  );
  const host = new Set([path.join(root, "helpers", "db-vault.ts")]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, specs] of imports)
      if (!host.has(f) && specs.some((s) => host.has(s))) {
        host.add(f);
        grew = true;
      }
  }
  return [...host].filter((f) => f.endsWith(".test.ts")).map((f) => path.relative(__dirname, f).replace(/\\/g, "/"));
}

const config = mergeConfig(base, defineConfig({ test: { env: { VAULT_HOST: "node" } } }));
// mergeConfig would add these to the base's `include`: replace it instead
if (process.env.VAULT_HOST_TESTS_ONLY === "1") config.test!.include = hostTestFiles();

export default config;
