/**
 * tests/global-setup.ts: the run's temporary folder is every test's os.tmpdir(), so what the tests
 * leave in it goes when the run ends.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("global setup", () => {
  it("every test of the run sees the run's temporary folder", () => {
    const dir = process.env.DATANOTES_TEST_TMP;
    expect(dir).toBeTruthy();
    expect(os.tmpdir()).toBe(dir);
    expect(path.basename(dir!)).toMatch(/^datanotes-tests-/);
    const made = fs.mkdtempSync(path.join(os.tmpdir(), "global-setup-"));
    expect(path.relative(dir!, made).startsWith("..")).toBe(false);
    expect(path.dirname(made)).toBe(dir);
    fs.rmSync(made, { recursive: true, force: true });
  });
});
