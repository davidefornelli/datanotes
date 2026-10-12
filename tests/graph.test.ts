import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { graphIndex, graphNeighbors, graphPath, graphTraverse } from "../src/core/graph";
import { insertRow } from "../src/core/rows";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const P = "Datanotes/main/public";
const MOOD = "Datanotes/main/metrics/mood";

/** person ← log.people ← mood.event; a free note links to Alice in its body. */
async function lifeGraph(): Promise<DbVault> {
  const v = createDbVault({});
  await createTable(v.app, v.settings, described({ name: "person", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true }] }));
  await createTable(v.app, v.settings, described({
    name: "log",
    timeColumn: "occurred_at",
    columns: [
      { name: "occurred_at", type: "datetime", required: true, dense: true },
      { name: "people", type: "list", items: "link", ref: "main.public.person" },
    ],
  }));
  await createTable(v.app, v.settings, described({
    schema: "metrics",
    name: "mood",
    timeColumn: "occurred_at",
    columns: [
      { name: "occurred_at", type: "datetime", required: true, dense: true },
      { name: "value", type: "integer" },
      { name: "event", type: "link", ref: "main.public.log" },
    ],
  }));
  for (const name of ["Alice", "Paul"]) await insertRow(v.app, v.settings, { table: "person", values: { name } });
  await insertRow(v.app, v.settings, { table: "log", values: { occurred_at: "2026-09-26T09:00", people: ["[[Alice]]"] } });
  await insertRow(v.app, v.settings, { table: "log", values: { occurred_at: "2026-09-27T09:00", people: ["[[Paul]]"] } });
  await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T10:00", value: 4, event: `[[${P}/log/2026-09-26T0900]]` } });
  await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-27T10:00", value: 2, event: `[[${P}/log/2026-09-27T0900]]` } });
  v.write("Note/dinner.md", "Dinner with [[Alice]].\n");
  return v;
}

describe("link graph", () => {
  it("labels edges with the link column, other links as `link`, nodes with their table", async () => {
    const v = await lifeGraph();
    const g = await graphIndex(v.app, v.settings);
    expect(g.out.get(`${P}/log/2026-09-26T0900.md`)).toEqual([{ to: `${P}/person/Alice.md`, label: "people" }]);
    expect(g.out.get("Note/dinner.md")).toEqual([{ to: `${P}/person/Alice.md`, label: "link" }]);
    expect(g.tableOf.get(`${MOOD}/2026-09-26T1000.md`)).toBe("main.metrics.mood");
    expect(g.tableOf.has("Note/dinner.md")).toBe(false);
  });

  it("neighbors lists both directions with counts", async () => {
    const v = await lifeGraph();
    const r = await graphNeighbors(v.app, v.settings, { from: { table: "person", where: { name: "Alice" } } });
    expect(r.nodes[0]!.counts).toEqual({ "in:people": 1, "in:link": 1 });
    expect(r.nodes[0]!.edges.map((e) => [e.path, e.label, e.direction])).toEqual([
      [`${P}/log/2026-09-26T0900.md`, "people", "in"],
      ["Note/dinner.md", "link", "in"],
    ]);
  });

  it("traverse walks backwards through labelled edges and filters the result by table", async () => {
    const v = await lifeGraph();
    const r = await graphTraverse(v.app, v.settings, {
      from: { table: "person", where: { name: "Alice" } },
      direction: "in",
      edges: ["people", "event"],
      tables: ["mood"],
      maxDepth: 2,
    });
    expect(r.nodes.map((n) => [n.path, n.depth])).toEqual([[`${MOOD}/2026-09-26T1000.md`, 2]]);
    expect(r.nodes[0]!.via.map((s) => s.label)).toEqual(["people", "event"]);
    const all = await graphTraverse(v.app, v.settings, { from: { paths: [`${P}/person/Alice`] }, direction: "in", maxDepth: 1 });
    expect(all.nodes.map((n) => n.path)).toEqual([`${P}/log/2026-09-26T0900.md`, "Note/dinner.md"]);
    const through = await graphTraverse(v.app, v.settings, {
      from: { paths: [`${P}/person/Alice`] },
      direction: "in",
      through: ["person"],
      maxDepth: 3,
    });
    expect(through.nodes.map((n) => n.depth)).toEqual([1, 1]); // log rows are not walked through
    await expect(graphTraverse(v.app, v.settings, { from: { paths: [`${P}/person/Alice`] }, maxDepth: 99 })).rejects.toThrow(/max_depth/);
    await expect(graphTraverse(v.app, v.settings, { from: { table: "person" }, tables: ["nope"] })).rejects.toThrow(/unknown table/);
  });

  it("path finds the shortest route in either direction", async () => {
    const v = await lifeGraph();
    const r = await graphPath(v.app, v.settings, {
      from: { paths: [`${MOOD}/2026-09-26T1000`] },
      to: { table: "person" },
      direction: "out",
    });
    expect([r.found, r.length, r.to]).toEqual([true, 2, `${P}/person/Alice.md`]);
    expect(r.via.map((s) => `${s.label}:${s.direction}`)).toEqual(["event:out", "people:out"]);
    const between = await graphPath(v.app, v.settings, { from: { paths: ["Note/dinner"] }, to: { paths: [`${MOOD}/2026-09-26T1000`] } });
    expect(between.length).toBe(3); // dinner → Alice ← log ← mood
    const none = await graphPath(v.app, v.settings, { from: { paths: [`${P}/person/Paul`] }, to: { paths: ["Note/dinner"] }, maxDepth: 2 });
    expect(none.found).toBe(false);
  });

  it("sees rows the plugin just wrote (index rebuilt after writes)", async () => {
    const v = await lifeGraph();
    await graphIndex(v.app, v.settings);
    await insertRow(v.app, v.settings, { table: "log", values: { occurred_at: "2026-09-28T09:00", people: ["[[Alice]]", "[[Paul]]"] } });
    const r = await graphNeighbors(v.app, v.settings, { from: { paths: [`${P}/person/Paul`] }, direction: "in" });
    expect(r.nodes[0]!.edges.map((e) => e.path)).toEqual([`${P}/log/2026-09-27T0900.md`, `${P}/log/2026-09-28T0900.md`]);
  });
});
