import { describe, expect, it } from "vitest";
import { INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { graphIndex, graphNeighbors, graphPath, graphTraverse, MAX_GRAPH_NODES, type GraphNodeSet } from "../src/core/graph";
import { loadMetastore } from "../src/core/metastore";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
const YAML = `catalogs:
  main:
    schemas:
      public:
        tables:
          person:
            options: { filename: "{name}" }
            columns:
              - ${ID}
              - { name: name, type: string, required: true, dense: true }
          event:
            columns:
              - ${ID}
              - { name: title, type: string }
              - { name: people, type: list, items: link }
              - { name: host, type: link }
      metrics:
        tables:
          event:
            columns:
              - ${ID}
              - { name: value, type: integer }
              - { name: about, type: link }
`;

let n = 0;
const row = (table: string, extra: string) => `---\ntable: main.${table}\nid: 01a0f000-0000-7000-8000-${String(++n).padStart(12, "0")}\n${extra}---\n`;

/**
 * Dinner names Alice twice in `people`, Alice again as `host`, a note that does not exist and
 * itself; a metrics event is about the dinner; a free note links to Paul.
 */
async function vault(extra: Record<string, string> = {}): Promise<DbVault> {
  const v = createDbVault({
    [METASTORE]: YAML,
    "P/Alice.md": row("public.person", "name: Alice\n"),
    "P/Paul.md": row("public.person", "name: Paul\n"),
    "E/Dinner.md": row("public.event", 'title: Dinner\npeople: ["[[Alice]]", "[[Alice]]", "[[Paul]]", "[[Ghost]]", "[[Dinner]]"]\nhost: "[[Alice]]"\n'),
    "M/Score.md": row("metrics.event", 'value: 4\nabout: "[[Dinner]]"\n'),
    "Notes/Call.md": "Called [[Paul]] about [[Call]].\n",
    ...extra,
  });
  // The graph reads the tables from the metastore cache, which the runtime loads when it starts.
  await loadMetastore(v.app, v.settings);
  return v;
}

describe("graph index", () => {
  it("keeps one edge per target and label: a repeated link counts once, another column is another edge", async () => {
    const v = await vault();
    const g = await graphIndex(v.app, v.settings);
    expect(g.out.get("E/Dinner.md")).toEqual([
      { to: "P/Alice.md", label: "people" },
      { to: "P/Paul.md", label: "people" },
      { to: "P/Alice.md", label: "host" },
    ]);
    expect(g.in.get("P/Alice.md")).toEqual([
      { to: "E/Dinner.md", label: "people" },
      { to: "E/Dinner.md", label: "host" },
    ]);
  });

  it("skips links to missing notes and to the row itself", async () => {
    const v = await vault();
    const g = await graphIndex(v.app, v.settings);
    expect(g.in.has("E/Dinner.md")).toBe(true); // only from the metrics event
    expect(g.in.get("E/Dinner.md")).toEqual([{ to: "M/Score.md", label: "about" }]);
    expect([...g.out.keys()].sort()).toEqual(["E/Dinner.md", "M/Score.md", "Notes/Call.md"]);
    expect(g.out.get("Notes/Call.md")).toEqual([{ to: "P/Paul.md", label: "link" }]); // its link to itself is no edge
  });

  it("a table whose definition is broken is left out (its rows are plain notes); the others still make the graph", async () => {
    const v = await vault({
      [METASTORE]: YAML.replace("      metrics:", `          broken:\n            columns:\n              - ${ID}\n              - { name: x, type: nope }\n      metrics:`),
      "B/x.md": row("public.broken", 'x: "[[Alice]]"\n'),
    });
    const g = await graphIndex(v.app, v.settings);
    expect([...g.tableOf.entries()].sort()).toEqual([
      ["E/Dinner.md", "main.public.event"],
      ["M/Score.md", "main.metrics.event"],
      ["P/Alice.md", "main.public.person"],
      ["P/Paul.md", "main.public.person"],
    ]);
    expect(g.out.get("B/x.md")).toEqual([{ to: "P/Alice.md", label: "link" }]); // a plain note: its link is untyped
  });
});

describe("start sets", () => {
  const refused = async (from: unknown, message: string) => {
    const v = await vault();
    const p = graphNeighbors(v.app, v.settings, { from: from as GraphNodeSet });
    await expect(p).rejects.toThrow(OperationInputError);
    await expect(p).rejects.toThrow(message);
  };

  it("must be an object", async () => {
    await refused(null, `"from" must be an object with "paths" or "table"`);
    await refused("P/Alice", `"from" must be an object with "paths" or "table"`);
  });

  it("need paths or a table, and where only with a table", async () => {
    await refused({}, `"from" needs "paths" or "table"`);
    await refused({ where: { name: "Alice" } }, `from: "where" needs "table"`);
  });

  it("paths must name existing notes", async () => {
    await refused({ paths: ["P/Alice", "P/Nobody"] }, "from: note not found: P/Nobody.md");
  });

  it("the end set of a path is checked the same way", async () => {
    const v = await vault();
    await expect(graphPath(v.app, v.settings, { from: { paths: ["P/Alice"] }, to: {} })).rejects.toThrow(`"to" needs "paths" or "table"`);
  });

  it(`at most ${MAX_GRAPH_NODES} start notes`, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_GRAPH_NODES; i++) files[`Many/n${i}.md`] = "x\n";
    const v = createDbVault(files);
    const p = graphNeighbors(v.app, v.settings, { from: { paths: Object.keys(files) } });
    await expect(p).rejects.toThrow(OperationInputError);
    await expect(p).rejects.toThrow(`"from" matches ${MAX_GRAPH_NODES + 1} notes (max ${MAX_GRAPH_NODES}): narrow it`);
  }, 60_000);
});

describe("neighbors", () => {
  it("refuses an unknown direction", async () => {
    const v = await vault();
    const p = graphNeighbors(v.app, v.settings, { from: { paths: ["P/Alice"] }, direction: "up" as "out" });
    await expect(p).rejects.toThrow(OperationInputError);
    await expect(p).rejects.toThrow(`"direction" must be "out", "in" or "both"`);
  });

  it("counts each labelled edge once", async () => {
    const v = await vault();
    const r = await graphNeighbors(v.app, v.settings, { from: { paths: ["P/Alice"] } });
    expect(r).toEqual({
      nodes: [
        {
          path: "P/Alice.md",
          table: "main.public.person",
          counts: { "in:people": 1, "in:host": 1 },
          edges: [
            { path: "E/Dinner.md", table: "main.public.event", label: "people", direction: "in" },
            { path: "E/Dinner.md", table: "main.public.event", label: "host", direction: "in" },
          ],
        },
      ],
    });
  });
});

describe("traverse", () => {
  it("a table name that matches tables of several schemas is refused, in tables and in through", async () => {
    const v = await vault();
    const from = { paths: ["P/Alice"] };
    const t = graphTraverse(v.app, v.settings, { from, tables: ["event"] });
    await expect(t).rejects.toThrow(OperationInputError);
    await expect(t).rejects.toThrow(`tables: "event" matches main.metrics.event, main.public.event`);
    await expect(graphTraverse(v.app, v.settings, { from, through: ["person", "event"] })).rejects.toThrow(`through: "event" matches main.metrics.event, main.public.event`);
    const ok = await graphTraverse(v.app, v.settings, { from, direction: "in", tables: ["metrics.event"], maxDepth: 2 });
    expect(ok.nodes).toEqual([
      {
        path: "M/Score.md",
        table: "main.metrics.event",
        depth: 2,
        via: [
          { from: "P/Alice.md", label: "people", direction: "in", to: "E/Dinner.md" },
          { from: "E/Dinner.md", label: "about", direction: "in", to: "M/Score.md" },
        ],
      },
    ]);
  });

  it("stops at limit and says the result is truncated", async () => {
    const v = await vault();
    const r = await graphTraverse(v.app, v.settings, { from: { paths: ["E/Dinner"] }, direction: "both", maxDepth: 3, limit: 2 });
    expect(r.truncated).toBe(true);
    expect(r.nodes.map((x) => [x.path, x.depth])).toEqual([
      ["M/Score.md", 1],
      ["P/Alice.md", 1],
    ]);
    const all = await graphTraverse(v.app, v.settings, { from: { paths: ["E/Dinner"] }, direction: "both", maxDepth: 3 });
    expect(all.truncated).toBe(false);
    expect(all.nodes.map((x) => [x.path, x.depth])).toEqual([
      ["M/Score.md", 1],
      ["P/Alice.md", 1],
      ["P/Paul.md", 1],
      ["Notes/Call.md", 2],
    ]);
  });
});

describe("path", () => {
  it("max_depth must be an integer from 1 to 10", async () => {
    const v = await vault();
    for (const maxDepth of [0, 11, 2.5]) {
      const p = graphPath(v.app, v.settings, { from: { paths: ["P/Alice"] }, to: { paths: ["P/Paul"] }, maxDepth });
      await expect(p).rejects.toThrow(OperationInputError);
      await expect(p).rejects.toThrow("need 1 <= max_depth <= 10");
    }
  });

  it("a note in both sets is a path of length 0", async () => {
    const v = await vault();
    const r = await graphPath(v.app, v.settings, { from: { paths: ["P/Paul", "P/Alice"] }, to: { table: "person", where: { name: "Alice" } } });
    expect(r).toEqual({ found: true, length: 0, via: [], from: "P/Alice.md", to: "P/Alice.md" });
  });

  it("follows only the labels asked for", async () => {
    const v = await vault();
    const viaHost = await graphPath(v.app, v.settings, { from: { paths: ["M/Score"] }, to: { paths: ["P/Alice"] }, direction: "out", edges: ["about", "host"] });
    expect(viaHost.via.map((s) => `${s.from} -${s.label}-> ${s.to}`)).toEqual(["M/Score.md -about-> E/Dinner.md", "E/Dinner.md -host-> P/Alice.md"]);
    const none = await graphPath(v.app, v.settings, { from: { paths: ["M/Score"] }, to: { paths: ["P/Paul"] }, direction: "out", edges: ["about", "host"] });
    expect(none).toEqual({ found: false, length: null, via: [] });
  });
});
