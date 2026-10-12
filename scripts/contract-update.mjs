// npm run contract:update: add the new parts of the public contract to contract/datanotes-3.txt
// (tests/contract.test.ts). A stable line that is gone stays in the file, and the test still fails.
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["vitest", "run", "tests/contract.test.ts"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATANOTES_CONTRACT_UPDATE: "1" },
});
process.exit(r.status ?? 1);
