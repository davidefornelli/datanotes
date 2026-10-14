/**
 * Inverse link columns at their edges: inverse declarations naming no column, link values that
 * are no links or no rows, reciprocal links already there, list columns holding one value or an
 * empty one, names two rows share, the watcher of hand edits and
 * sync_relations given changes of other tables.
 */

import { describe, expect, it, vi } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { inverseEditsFor, inverseSpecs, InverseWatcher, REMOVED_ROW_MS, type RowChange } from "../src/core/inverse";
import { parseMetastore } from "../src/core/metastore";
import { checkTable, syncRelations, updateRow } from "../src/core/rows";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/**
 * `person`: `friends` (symmetric list), `partner` (symmetric single link), `mentor` (an inverse
 * naming no column).
 */
const TABLES = `person:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string, required: true, dense: true }
    - { name: friends, type: list, items: link, ref: self, inverse: friends }
    - { name: partner, type: link, ref: self, inverse: partner }
    - { name: mentor, type: link, ref: self, inverse: mentees }
`;

let n = 0;
const person = (name: string, extra = "") => `---\ntable: main.public.person\nid: 01a0f000-0000-7000-8000-${String(++n).padStart(12, "0")}\nname: ${name}\n${extra}---\n`;

function vault(extra: Record<string, string> = {}): DbVault {
  return createDbVault({
    [METASTORE]: withTables(TABLES),
    "P/Alice.md": person("Alice"),
    "P/Carol.md": person("Carol"),
    "P/Dave.md": person("Dave"),
    "P/Mark.md": person("Mark"),
    "Welcome.md": "Hello.\n",
    ...extra,
  });
}

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const upd = (v: DbVault, path: string, set: Record<string, unknown>) => updateRow(v.app, v.settings, { table: "person", path, set });

describe("inverse declarations", () => {
  it("an inverse naming no column is left out: the other columns are mirrored", async () => {
    const v = vault();
    const r = await upd(v, "P/Alice.md", { friends: ["[[Carol]]"], mentor: "[[Dave]]" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.planned_edits.map((p) => [p.path, p.set])).toEqual([
      ["P/Alice.md", { friends: ["[[Carol]]"], mentor: "[[Dave]]" }],
      ["P/Carol.md", { friends: ["[[Alice]]"] }],
    ]);
    expect(fm(v, "P/Dave.md").mentees).toBeUndefined();
  });
});

describe("mirrored values", () => {
  it("a partner who already links back is not rewritten", async () => {
    const v = vault({ "P/Dave.md": person("Dave", 'partner: "[[Carol]]"\n') });
    const r = await upd(v, "P/Carol.md", { partner: "[[Dave]]" });
    expect([r.ok, r.notes_changed, r.planned_edits.map((p) => p.path)]).toEqual([true, 1, ["P/Carol.md"]]);
    expect(fm(v, "P/Dave.md").partner).toBe("[[Carol]]");
  });

  it("a list holding one link, or an empty string, becomes a list with the new link", async () => {
    const v = vault({ "P/Carol.md": person("Carol", 'friends: "[[Mark]]"\n'), "P/Dave.md": person("Dave", 'friends: ""\n') });
    const r = await upd(v, "P/Alice.md", { friends: ["[[Carol]]", "[[Dave]]"] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(fm(v, "P/Carol.md").friends).toEqual(["[[Mark]]", "[[Alice]]"]);
    expect(fm(v, "P/Dave.md").friends).toEqual(["[[Alice]]"]);
  });

  it("a link back to a row whose name another row shares names it by path", async () => {
    const v = vault({ "P/Ann.md": person("Ann"), "Q/Ann.md": person("Ann") });
    const r = await upd(v, "P/Ann.md", { friends: ["[[Carol]]"] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(fm(v, "P/Carol.md").friends).toEqual(["[[P/Ann]]"]);
  });
});

describe("check_table", () => {
  it("does not ask a note that is no row of the table to link back", async () => {
    const v = vault({ "P/Alice.md": person("Alice", 'friends: ["[[Welcome]]", "[[Carol]]"]\n') });
    const r = await checkTable(v.app, v.settings, { table: "person" });
    expect(r.violations.find((x) => x.path === "P/Alice.md")!.violations.filter((x) => x.code === "inverse")).toEqual([
      { column: "friends", code: "inverse", message: `P/Carol.md does not link back in "friends" (align_relations adds it)`, value: "P/Carol.md" },
    ]);
  });
});

describe("links edited by hand", () => {
  /** A watcher that mirrors hand edits as the service does (sync_relations); flushed by hand. */
  function watch(v: DbVault) {
    const seen: RowChange[][] = [];
    const watcher = new InverseWatcher(v.app, () => v.settings, async (changes) => {
      seen.push(changes);
      await syncRelations(v.app, v.settings, changes);
    }, 60_000);
    return { watcher, seen };
  }

  it("mirrors only links to rows: plain text, numbers and notes of no table are left alone", async () => {
    const v = vault();
    const { watcher, seen } = watch(v);
    // ready only once the metastore is loaded
    watcher.onChanged("P/Alice.md");
    await checkTable(v.app, v.settings, { table: "person" });
    watcher.init();
    v.write("P/Alice.md", person("Alice", 'friends: ["[[Carol]]", "Bob", 42, "[[Welcome]]"]\n'));
    watcher.onChanged("Welcome.png"); // not a note: ignored
    await watcher.flush("P/Alice.md");
    watcher.dispose();
    expect(seen.map((c) => c.map((x) => [x.path, [...x.before], [...x.after]]))).toEqual([
      [["P/Alice.md", [["friends", []], ["partner", []]], [["friends", ["P/Carol.md", "Welcome.md"]], ["partner", []]]]],
    ]);
    expect(fm(v, "P/Carol.md").friends).toEqual(["[[Alice]]"]);
    expect(v.read("Welcome.md")).toBe("Hello.\n");
  });

  it("a row the watcher did not know is compared with no links", async () => {
    const v = vault();
    await checkTable(v.app, v.settings, { table: "person" });
    const { watcher, seen } = watch(v);
    watcher.init();
    v.write("P/Zoe.md", person("Zoe", 'partner: "[[Mark]]"\n'));
    await watcher.flush("P/Zoe.md");
    expect(seen.map((c) => c.map((x) => [x.path, x.table, x.before.size, x.after.get("partner")]))).toEqual([[["P/Zoe.md", "main.public.person", 0, ["P/Mark.md"]]]]);
    expect(fm(v, "P/Mark.md").partner).toBe("[[Zoe]]");
  });

  it("a link removed from a note that is gone has no link back to remove", async () => {
    const v = vault({ "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n'), "P/Carol.md": person("Carol", 'friends: ["[[Alice]]"]\n') });
    await checkTable(v.app, v.settings, { table: "person" });
    const results: unknown[] = [];
    const watcher = new InverseWatcher(v.app, () => v.settings, async (changes) => {
      results.push(await syncRelations(v.app, v.settings, changes));
    });
    watcher.init();
    v.remove("P/Carol.md");
    watcher.onDeleted("P/Carol.md");
    v.write("P/Alice.md", person("Alice", "friends: []\n"));
    await watcher.flush("P/Alice.md");
    expect(results).toEqual([null]);
  });

  it("a row renamed by hand, seen as a delete and a create, keeps its links: nothing is added back, no row lists it twice", async () => {
    const v = vault({ "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n'), "P/Carol.md": person("Carol", 'friends: ["[[Alice]]"]\n') });
    await checkTable(v.app, v.settings, { table: "person" });
    const { watcher, seen } = watch(v);
    watcher.init();
    const text = v.read("P/Alice.md");
    v.remove("P/Alice.md");
    watcher.onDeleted("P/Alice.md");
    v.write("P/Alicia.md", text);
    await watcher.flush("P/Alicia.md");
    expect(seen).toEqual([]);
    expect(fm(v, "P/Carol.md").friends).toEqual(["[[Alice]]"]); // the link repair rewrites it (hand-moves.ts)
  });

  it("when its links changed in the same edit, a link left to its old name is replaced, not doubled", async () => {
    const v = vault({
      "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n'),
      "P/Carol.md": person("Carol", 'friends: ["[[Alice]]"]\n'),
      "P/Dave.md": person("Dave", 'friends: ["[[Mark]]", "[[Alice]]"]\n'),
    });
    await checkTable(v.app, v.settings, { table: "person" });
    const { watcher, seen } = watch(v);
    watcher.init();
    const text = v.read("P/Alice.md").replace('friends: ["[[Carol]]"]', 'friends: ["[[Carol]]", "[[Dave]]"]');
    v.remove("P/Alice.md");
    watcher.onDeleted("P/Alice.md");
    v.write("P/Alicia.md", text);
    await watcher.flush("P/Alicia.md");
    expect(seen.map((c) => c.map((x) => [x.path, x.oldPath]))).toEqual([[["P/Alicia.md", "P/Alice.md"]]]);
    expect(fm(v, "P/Dave.md").friends).toEqual(["[[Mark]]", "[[Alicia]]"]);
  });

  it("forgets a deleted row after a minute; a row without id is not recognized under another name", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const v = vault({ "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n'), "P/Plain.md": '---\ntable: main.public.person\nname: Plain\nfriends: ["[[Mark]]"]\n---\n' });
      await checkTable(v.app, v.settings, { table: "person" });
      const { watcher, seen } = watch(v);
      watcher.init();
      const alice = v.read("P/Alice.md");
      v.remove("P/Alice.md");
      watcher.onDeleted("P/Alice.md");
      vi.setSystemTime(Date.now() + REMOVED_ROW_MS + 1);
      const plain = v.read("P/Plain.md");
      v.remove("P/Plain.md");
      watcher.onDeleted("P/Plain.md"); // no id: not kept; Alice's is too old by now
      v.write("P/Alicia.md", alice);
      v.write("P/Plainer.md", plain);
      await watcher.flush("P/Alicia.md");
      await watcher.flush("P/Plainer.md");
      expect(seen.map((c) => c.map((x) => [x.path, x.before.size, x.oldPath]))).toEqual([[["P/Alicia.md", 0, undefined]], [["P/Plainer.md", 0, undefined]]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a burst of edits of a row is mirrored once, after the delay", async () => {
    const v = vault();
    await checkTable(v.app, v.settings, { table: "person" });
    let done: () => void = () => {};
    const mirrored = new Promise<void>((resolve) => (done = resolve));
    const seen: string[][] = [];
    const watcher = new InverseWatcher(v.app, () => v.settings, async (changes) => {
      seen.push(changes.map((c) => c.path));
      await syncRelations(v.app, v.settings, changes);
      done();
    }, 5);
    watcher.init();
    v.write("P/Alice.md", person("Alice", 'friends: ["[[Mark]]"]\n'));
    watcher.onChanged("P/Alice.md");
    v.write("P/Alice.md", person("Alice", 'friends: ["[[Mark]]", "[[Dave]]"]\n'));
    watcher.onChanged("P/Alice.md");
    await mirrored;
    watcher.dispose();
    expect(seen).toEqual([["P/Alice.md"]]);
    expect([fm(v, "P/Mark.md").friends, fm(v, "P/Dave.md").friends]).toEqual([["[[Alice]]"], ["[[Alice]]"]]);
  });
});

describe("sync_relations", () => {
  it("does nothing for a change of a table without inverse columns", async () => {
    const v = vault({ "Daily/a.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: walk\noccurred_at: 2026-09-25T22:30\n---\n" });
    const change: RowChange = { path: "Daily/a.md", table: "main.public.log", before: new Map(), after: new Map([["people", ["P/Carol.md"]]]) };
    expect(await syncRelations(v.app, v.settings, [change])).toBeNull();
    expect(fm(v, "P/Carol.md").friends).toBeUndefined();
  });

  it("a change that no longer lists a column removes the links back", async () => {
    const v = vault({ "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n'), "P/Carol.md": person("Carol", 'friends: ["[[Alice]]", "[[Mark]]"]\n') });
    const r = await syncRelations(v.app, v.settings, [{ path: "P/Alice.md", table: "main.public.person", before: new Map([["friends", ["P/Carol.md"]]]), after: new Map() }]);
    expect(r?.ok).toBe(true);
    expect(fm(v, "P/Carol.md").friends).toEqual(["[[Mark]]"]);
  });
});

describe("links edited by hand: what the watcher cannot read", () => {
  it("a path with no note, or a folder, has no row to compare", async () => {
    const v = vault();
    await checkTable(v.app, v.settings, { table: "person" });
    const seen: RowChange[][] = [];
    const watcher = new InverseWatcher(v.app, () => v.settings, async (changes) => void seen.push(changes), 60_000);
    watcher.init();
    await watcher.flush("P/Nobody.md");
    await watcher.flush("P");
    expect(seen).toEqual([]);
  });

  it("a row renamed by hand: values of the list that are no links are kept beside the replaced link", async () => {
    const v = vault({
      "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n'),
      "P/Carol.md": person("Carol", 'friends: ["[[Alice]]"]\n'),
      "P/Dave.md": person("Dave", 'friends: [42, "Bob", "[[Mark]]", "[[Alice]]"]\n'),
    });
    await checkTable(v.app, v.settings, { table: "person" });
    const watcher = new InverseWatcher(v.app, () => v.settings, async (changes) => void (await syncRelations(v.app, v.settings, changes)), 60_000);
    watcher.init();
    const text = v.read("P/Alice.md").replace('friends: ["[[Carol]]"]', 'friends: ["[[Carol]]", "[[Dave]]"]');
    v.remove("P/Alice.md");
    watcher.onDeleted("P/Alice.md");
    v.write("P/Alicia.md", text);
    await watcher.flush("P/Alicia.md");
    expect(fm(v, "P/Dave.md").friends).toEqual([42, "Bob", "[[Mark]]", "[[Alicia]]"]);
  });
});

describe("inverse edits of a change set", () => {
  it("reads the metastore when none is cached; none in the vault: no edits", async () => {
    const v = vault({ "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n') });
    const after = readOrderedFromMarkdown(v.read("P/Alice.md")).ordered;
    const plan = await inverseEditsFor(v.app, v.settings, [{ path: "P/Alice.md", before: [], after }], (p) => p);
    expect([...plan!.edits.keys()]).toEqual(["P/Carol.md"]);
    const bare = createDbVault({ "P/Alice.md": person("Alice", 'friends: ["[[Carol]]"]\n') });
    expect(await inverseEditsFor(bare.app, bare.settings, [{ path: "P/Alice.md", before: [], after }], (p) => p)).toBeNull();
  });

  it("a row that leaves its table is read by its table before; a note of no table is left out", async () => {
    const v = vault({ "P/Carol.md": person("Carol", 'friends: ["[[Alice]]"]\n') });
    await checkTable(v.app, v.settings, { table: "person" });
    const before = readOrderedFromMarkdown(person("Alice", 'friends: ["[[Carol]]"]\n')).ordered;
    const plain: [string, unknown][] = [["title", "Hello"]];
    const plan = await inverseEditsFor(v.app, v.settings, [
      { path: "P/Alice.md", before, after: [["name", "Alice"]] },
      { path: "Welcome.md", before: plain, after: plain },
    ], (p) => p);
    expect([...plan!.edits.entries()].map(([p, w]) => [p, Object.fromEntries(w.after).friends])).toEqual([["P/Carol.md", []]]);
  });
});

describe("inverseSpecs", () => {
  it("leaves out a table whose columns cannot be resolved (the loader reports it)", () => {
    const model = parseMetastore(`bases:
  named:
    columns:
      - { name: name, type: string }
catalogs:
  main:
    schemas:
      public:
        tables:
          broken:
            bases: [named]
            columns:
              - { name: name, type: integer }
${TABLES.split("\n").map((l) => (l === "" ? l : `          ${l}`)).join("\n")}`);
    const specs = inverseSpecs(model);
    expect([...specs.keys()]).toEqual(["main.public.person"]);
  });
});

describe("the watcher's snapshot and the metastore", () => {
  it("is kept when the metastore changes nothing it follows; taken again when the inverse pairs or the tables change", async () => {
    const { loadMetastore } = await import("../src/core/metastore");
    const v = vault();
    await checkTable(v.app, v.settings, { table: "person" });
    const watcher = new InverseWatcher(v.app, () => v.settings, async () => {});
    const cache = v.app.metadataCache as unknown as { getFileCache(f: unknown): unknown };
    const spy = vi.spyOn(cache, "getFileCache");
    watcher.init();
    const first = spy.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    // another text (a comment): the same pairs on the same tables
    v.write(METASTORE, `${v.read(METASTORE)}# written by hand\n`);
    await loadMetastore(v.app, v.settings);
    watcher.init();
    expect(spy.mock.calls.length).toBe(first);
    // a new table: names may resolve elsewhere, the snapshot is taken again
    v.write(METASTORE, withTables(`${TABLES}place:\n  columns:\n    - { name: name, type: string }\n`));
    await loadMetastore(v.app, v.settings);
    watcher.init();
    expect(spy.mock.calls.length).toBeGreaterThan(first);
    // stopped and started again: taken again whatever the metastore
    const second = spy.mock.calls.length;
    watcher.dispose();
    watcher.init();
    expect(spy.mock.calls.length).toBeGreaterThan(second);
    spy.mockRestore();
  });
});
