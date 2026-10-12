import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** `npm run bench`: scale benchmarks under bench/, kept out of the regular test run. */
export default defineConfig({
  resolve: { alias: { obsidian: path.join(dir, "tests", "obsidian-stub.ts") } },
  // MEMINDEX set here, not in the npm script: `VAR=1 cmd` is POSIX shell syntax, which fails on Windows
  test: { environment: "node", include: ["bench/**/*.test.ts"], testTimeout: 3_600_000, env: { MEMINDEX: process.env.MEMINDEX ?? "1" } },
});
