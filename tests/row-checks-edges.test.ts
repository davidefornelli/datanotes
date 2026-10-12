/**
 * check_table at its edges: hierarchy cycles and missing inverse links on rows that also break
 * other rules, constraints that are no conditions, every table of a vault without metastore.yaml,
 * and a table that cannot be checked while the others pass.
 */

import { afterEach, describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { checkTable, insertRow } from "../src/core/rows";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { createDbVault, METASTORE, withTables } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;
afterEach(() => setTelemetry(NOOP_TELEMETRY));

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/** `topic`: a hierarchy (`parent`), `friends` mirrored, `rank` at least 1, a constraint that is a list. */
const TOPIC = `topic:
  options: { filename: "{name}" }
  constraints:
    odd: [rank]
  columns:
    - ${ID}
    - { name: name, type: string }
    - { name: parent, type: link, ref: self, hierarchy: true }
    - { name: friends, type: list, items: link, ref: self, inverse: friends }
    - { name: rank, type: integer, min: 1 }
`;
let n = 0;
const topic = (name: string, extra: string) => `---\ntable: main.public.topic\nid: 01a0f000-0000-7000-8000-${String(++n).padStart(12, "0")}\nname: ${name}\n${extra}---\n`;

describe("check_table", () => {
  it("lists a cycle and a missing link back with the row's other violations, or alone", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(TOPIC),
      "T/Cats.md": topic("Cats", 'parent: "[[Pets]]"\nrank: 0\nfriends: ["[[Dogs]]"]\n'),
      "T/Pets.md": topic("Pets", 'parent: "[[Cats]]"\n'),
      "T/Dogs.md": topic("Dogs", ""),
    });
    const r = await checkTable(v.app, v.settings, { table: "topic" });
    expect(r).toMatchObject({ table: "topic", rows_checked: 3, total: 2 });
    expect(r.violations.map((x) => [x.path, x.violations.map((y) => [y.code, y.column])])).toEqual([
      [
        "T/Cats.md",
        [
          ["min", "rank"],
          ["inverse", "friends"],
          ["cycle", "parent"],
        ],
      ],
      ["T/Pets.md", [["cycle", "parent"]]],
    ]);
    expect(r.violations[1]!.violations[0]!.message).toBe(`would make "Pets" its own ancestor (Pets → Cats → Pets)`);
  });

  it("ignores a constraint that is no condition, on check_table and on writes", async () => {
    const v = createDbVault({ [METASTORE]: withTables(TOPIC) });
    expect((await insertRow(v.app, v.settings, { table: "topic", values: { name: "Cats", rank: 2 } })).ok).toBe(true);
    expect(await checkTable(v.app, v.settings, { table: "topic" })).toEqual({ table: "topic", rows_checked: 1, total: 0, violations: [] });
  });

  it("every table of a vault without metastore.yaml: nothing to check", async () => {
    const v = createDbVault({ "Welcome.md": "Hello.\n" });
    expect(await checkTable(v.app, v.settings, {})).toEqual({ table: null, rows_checked: 0, tables_checked: 0, total: 0, violations: [] });
  });

  it("a table that cannot be checked is listed in errors, at WARN, while the others pass", async () => {
    const BROKEN = `broken:
  options: { filename: "{a}" }
  columns:
    - ${ID}
    - { name: a, type: string }
    - { name: b, type: string, generated: "{nope}" }
`;
    const v = createDbVault({ [METASTORE]: withTables(BROKEN) });
    const logs: { severity: string; body: string; attrs: Record<string, unknown> }[] = [];
    setTelemetry({ log: (severity, body, attrs = {}) => logs.push({ severity, body, attrs }), flush: async () => {} });
    const r = await checkTable(v.app, v.settings, {});
    expect(r).toMatchObject({ table: null, rows_checked: 0, tables_checked: 1, total: 0, violations: [] });
    expect(r.errors).toEqual([{ table: "main.public.broken", error: expect.stringContaining(`unknown column "nope"`) }]);
    expect(logs.filter((l) => l.body === "datanotes check_table").map((l) => [l.severity, l.attrs.failed_tables])).toEqual([["WARN", 1]]);
  });
});
