/**
 * One temporary folder per test run: every os.tmpdir() of the run (workers, engines and git started by the tests) is
 * inside it, and it goes when the run ends. DATANOTES_KEEP_TEST_TMP=1 keeps it, to look at what a test left.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-tests-"));
  for (const k of ["TMPDIR", "TEMP", "TMP"]) process.env[k] = dir; // TEMP and TMP: Windows
  process.env.DATANOTES_TEST_TMP = dir;
  return () => {
    if (process.env.DATANOTES_KEEP_TEST_TMP === "1") return;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  };
}
