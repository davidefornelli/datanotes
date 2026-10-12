/**
 * The promise of Datanotes 3, checked by a machine: what contract/datanotes-3.txt lists stays in
 * every 3.x. A new operation, argument, field or option is added to the file with
 * `npm run contract:update`; a line that goes is a breaking change, and the update keeps it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contractLines, environmentVariables, helpText } from "./helpers/contract";

const FILE = path.join(__dirname, "..", "contract", "datanotes-3.txt");
const HEADER = [
  "# The public contract of Datanotes 3 (tests/contract.test.ts, tests/helpers/contract.ts).",
  "# A line never goes: Datanotes 3 adds, never takes away (docs: /reference/compatibility/).",
  "# Add new lines with npm run contract:update; never remove one by hand.",
];

const read = (): string[] =>
  fs.existsSync(FILE)
    ? fs
        .readFileSync(FILE, "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#"))
    : [];

describe("the contract of Datanotes 3", () => {
  it("keeps every line and lists every new one", () => {
    const now = contractLines();
    const current = new Set(now);
    const recorded = read();
    if (process.env.DATANOTES_CONTRACT_UPDATE === "1") {
      // a line stays even when it is gone: the failure below names it
      const kept = recorded.filter((l) => !current.has(l));
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, `${[...HEADER, ...[...new Set([...now, ...kept])].sort()].join("\n")}\n`);
    }
    const file = new Set(read());
    expect(
      [...file].filter((l) => !current.has(l)),
      "parts of the contract that are gone or changed: a breaking change (bring them back, or add the new name beside the old one)",
    ).toEqual([]);
    expect(
      now.filter((l) => !file.has(l)),
      "parts of the contract not in contract/datanotes-3.txt: run npm run contract:update and commit the file",
    ).toEqual([]);
  });

  it("documents every environment variable the engine reads in datanotes --help", () => {
    const help = helpText();
    expect(environmentVariables().filter((v) => !new RegExp(`\\b${v}\\b`).test(help))).toEqual([]);
  });

  it("has a line for each kind of part", () => {
    const kinds = new Set(contractLines().map((l) => l.split(" ")[0]));
    expect([...kinds].sort()).toEqual(["answer", "argument", "command", "environment", "operation", "route", "setting", "violation"]);
  });
});
