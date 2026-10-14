/**
 * check_table at its edges: hierarchy cycles and missing inverse links on rows that also break
 * other rules, constraints that are no conditions, every table of a vault without metastore.yaml,
 * and a table that cannot be checked while the others pass.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { checkTable, insertRow } from "../src/core/rows";
import { checkOne } from "../src/core/row-checks";
import { loadMetastore, parseMetastore } from "../src/core/metastore";
import { describeDatabase } from "../src/core/database";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { createDbVault, METASTORE, withTables } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;
afterEach(() => {
  setTelemetry(NOOP_TELEMETRY);
  vi.restoreAllMocks();
});

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

describe("check_table on many rows", () => {
  it("each row once, its violations merged in order, when every row breaks several rules", async () => {
    // pairs of topics that are each other's parent (a cycle each), all with a rank below the minimum
    const files: Record<string, string> = { [METASTORE]: withTables(TOPIC) };
    for (let i = 0; i < 400; i++) files[`T/N${i}.md`] = topic(`N${i}`, `parent: "[[N${i ^ 1}]]"\nrank: 0\n`);
    const v = createDbVault(files);
    const r = await checkTable(v.app, v.settings, { table: "topic", limit: 5000 });
    expect(r).toMatchObject({ rows_checked: 400, total: 400 });
    expect(new Set(r.violations.map((x) => x.path)).size).toBe(400);
    for (const x of r.violations) expect(x.violations.map((y) => y.code)).toEqual(["min", "cycle"]);
  });

  it("every table at once: the unreadable notes are found in one pass and each reported with its table", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(TOPIC),
      "T/Cats.md": topic("Cats", "rank: 1\n"),
      "T/Broken.md": "---\ntable: main.public.topic\nname: [Broken\n---\n",
      "L/Broken log.md": "---\ntable: main.public.log\noccurred_at: [x\n---\n",
    });
    // like Obsidian, the index has no properties for a note whose YAML it cannot parse
    const cache = v.app.metadataCache as unknown as { getFileCache(f: unknown): unknown };
    const real = cache.getFileCache.bind(cache);
    vi.spyOn(cache, "getFileCache").mockImplementation((f: unknown) => {
      try {
        return real(f);
      } catch {
        return {};
      }
    });
    const all = await checkTable(v.app, v.settings, {});
    expect(all.violations.map((x) => [x.table, x.path, x.violations.map((y) => y.code)])).toEqual([
      ["main.public.log", "L/Broken log.md", ["unreadable"]],
      ["main.public.topic", "T/Broken.md", ["unreadable"]],
    ]);
    // a metastore other than the one the list was read on: the table's own notes are read again
    const model = (await loadMetastore(v.app, v.settings))!.model;
    const other = await checkOne(v.app, v.settings, "topic", { model: parseMetastore(withTables(TOPIC)), rows: [] });
    expect(other.violations.map((x) => x.path)).toEqual(["T/Broken.md"]);
    const same = await checkOne(v.app, v.settings, "topic", { model, rows: [] });
    expect(same.violations).toEqual([]);
    // describe_database counts each table's rows in one pass over the notes
    const d = await describeDatabase(v.app, v.settings);
    const counts = d.catalogs.flatMap((c) => c.schemas.flatMap((x) => x.tables.map((t) => [t.qualified, t.row_count, t.unreadable_count ?? 0])));
    expect(counts).toEqual([["main.public.log", 0, 1], ["main.public.topic", 1, 1]]);
  });
});
