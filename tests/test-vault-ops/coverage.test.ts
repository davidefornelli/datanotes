/**
 * Every operation of the API (`OPERATIONS` in src/api/catalog.ts) runs on the test vault. Each
 * scenario names the operations it covers, and fails when it does not call one of them (the
 * recording `call` of tests/helpers/test-vault.ts, checked in harness.ts); this test fails when an
 * operation is covered by no scenario: a new operation needs a test-vault scenario (or, when it
 * cannot run here, an entry in EXCEPTIONS with the reason).
 *
 * The scenario modules are found in this folder: every `<name>.ts` with a `<name>.test.ts` beside it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../../src/api/catalog";
import type { Scenario } from "./harness";

/**
 * Operations that cannot run on the test vault, with the reason. Keep it minimal: a local stand-in
 * is preferred (semantic search runs on a local embedding provider, webhooks post to a local
 * receiver), so today there is none.
 */
const EXCEPTIONS: Record<string, string> = {};

const DIR = __dirname;
const MODULES = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".test.ts") && f !== "coverage.test.ts")
  .map((f) => f.slice(0, -".test.ts".length))
  .sort();

async function load(): Promise<{ module: string; scenario: Scenario }[]> {
  const out: { module: string; scenario: Scenario }[] = [];
  for (const m of MODULES) {
    const spec = `./${m}.ts`;
    const { scenarios } = (await import(/* @vite-ignore */ spec)) as { scenarios: Scenario[] };
    for (const scenario of scenarios) out.push({ module: m, scenario });
  }
  return out;
}

describe("test-vault operations", () => {
  it("every scenario file runs its module's scenarios", () => {
    expect(MODULES.length).toBeGreaterThan(0);
    for (const m of MODULES) {
      expect(fs.existsSync(path.join(DIR, `${m}.ts`)), `${m}.test.ts has no ${m}.ts`).toBe(true);
      const runner = fs.readFileSync(path.join(DIR, `${m}.test.ts`), "utf8");
      expect(runner, `${m}.test.ts`).toContain(`from "./${m}"`);
      expect(runner, `${m}.test.ts`).toContain("runScenarios(scenarios)");
    }
  });

  it("every operation of the API has a scenario on the test vault", async () => {
    const all = await load();
    const names = new Set(OPERATIONS.map((o) => o.name));
    const unknown = all.flatMap(({ module, scenario }) => scenario.ops.filter((op) => !names.has(op)).map((op) => `${module}: "${scenario.name}" names ${op}`));
    expect(unknown, "scenarios name operations the API does not have").toEqual([]);
    expect(
      all.filter(({ scenario }) => scenario.ops.length === 0).map(({ scenario }) => scenario.name),
      "scenarios that cover no operation",
    ).toEqual([]);
    // a scenario marked as a known bug is expected to fail: it covers nothing
    const covered = new Set(all.filter(({ scenario }) => !scenario.bug).flatMap(({ scenario }) => scenario.ops));
    const missing = [...names].filter((n) => !covered.has(n) && !(n in EXCEPTIONS));
    expect(missing, `operations without a test-vault scenario: ${missing.join(", ")}`).toEqual([]);
    const stale = Object.keys(EXCEPTIONS).filter((n) => !names.has(n) || covered.has(n));
    expect(stale, "EXCEPTIONS that are not operations, or that a scenario covers now").toEqual([]);
  });

  it("scenario names are unique", async () => {
    const all = await load();
    const seen = all.map(({ scenario }) => scenario.name);
    expect(seen.filter((n, i) => seen.indexOf(n) !== i)).toEqual([]);
  });
});
