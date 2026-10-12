import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { graphIndex } from "../src/core/graph";
import { cachedMetastore } from "../src/core/metastore";
import { createDbVault, METASTORE } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const YAML = `catalogs:
  main:
    schemas:
      public:
        tables:
          person:
            columns:
              - { name: name, type: string }
              - { name: friend, type: link }
`;
const ROW = (name: string, friend: string) => `---\ntable: main.public.person\nname: ${name}\nfriend: "[[${friend}]]"\n---\n`;

describe("the graph of a vault whose metastore nothing has loaded yet", () => {
  it("loads the metastore: rows and their link columns are there, and the graph is reused after", async () => {
    const v = createDbVault({ [METASTORE]: YAML, "P/Alice.md": ROW("Alice", "Paul"), "P/Paul.md": ROW("Paul", "Alice") });
    expect(cachedMetastore(v.app, v.settings)).toBeNull();
    const g = await graphIndex(v.app, v.settings);
    expect([...g.tableOf.entries()].sort()).toEqual([
      ["P/Alice.md", "main.public.person"],
      ["P/Paul.md", "main.public.person"],
    ]);
    expect(g.out.get("P/Alice.md")).toEqual([{ to: "P/Paul.md", label: "friend" }]);
    expect(await graphIndex(v.app, v.settings)).toBe(g);
  });

  it("a vault without a metastore, or with a broken one, has a graph of plain links only", async () => {
    const none = createDbVault({ "A.md": "[[B]]\n", "B.md": "b\n" });
    const g = await graphIndex(none.app, none.settings);
    expect(g.tableOf.size).toBe(0);
    expect(g.out.get("A.md")).toEqual([{ to: "B.md", label: "link" }]);
    expect(await graphIndex(none.app, none.settings)).toBe(g);
    const broken = createDbVault({ [METASTORE]: "catalogs: 5\n", "A.md": "[[B]]\n", "B.md": "b\n" });
    const gb = await graphIndex(broken.app, broken.settings);
    expect(gb.tableOf.size).toBe(0);
    expect(gb.out.get("A.md")).toEqual([{ to: "B.md", label: "link" }]);
  });

  it("a metastore that does not parse is read once, not on every call, until the vault changes", async () => {
    const v = createDbVault({ [METASTORE]: "catalogs: 5\n", "P/Alice.md": ROW("Alice", "Paul"), "P/Paul.md": ROW("Paul", "Alice") });
    const read = v.app.vault.read.bind(v.app.vault);
    let reads = 0;
    v.app.vault.read = async (f) => {
      if (f.path === METASTORE) reads++;
      return read(f);
    };
    const g = await graphIndex(v.app, v.settings);
    expect(g.tableOf.size).toBe(0);
    expect(await graphIndex(v.app, v.settings)).toBe(g);
    await graphIndex(v.app, v.settings);
    expect(reads).toBe(1);
    // fixed: the next call loads it, and the rows are there
    v.write(METASTORE, YAML);
    const fixed = await graphIndex(v.app, v.settings);
    expect(reads).toBeGreaterThan(1);
    expect(fixed.out.get("P/Alice.md")).toEqual([{ to: "P/Paul.md", label: "friend" }]);
  });
});
