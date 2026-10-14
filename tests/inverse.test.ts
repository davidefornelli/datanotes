import { afterEach, describe, expect, it, vi } from "vitest";
import { addColumn, alterColumn, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { InverseWatcher } from "../src/core/inverse";
import { alignRelations, checkTable, insertRow, syncRelations, updateRow } from "../src/core/rows";
import { configureTracer, rootOrChild, setContextStore, withSpan, type SpanData } from "../src/core/tracing";
import { AsyncContextStore } from "../src/server/tracing";
import { createDbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

/** The tracer on, with the context store of Node: the exported spans land in the returned list. */
function traces(): SpanData[] {
  const out: SpanData[] = [];
  setContextStore(new AsyncContextStore());
  configureTracer({ export: (s) => out.push(...s), enabled: () => true, sampleRatio: () => 1, maxSpansPerTrace: () => 100 });
  return out;
}

afterEach(() => {
  configureTracer(null);
  setContextStore(null);
});

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
              - { name: friends, type: list, items: link, ref: self, inverse: friends }
              - { name: partner, type: link, ref: self, inverse: partner }
              - { name: children, type: list, items: link, ref: self, inverse: parents }
              - { name: parents, type: list, items: link, ref: self }
              - { name: projects, type: list, items: link, ref: main.public.project }
          project:
            options: { filename: "{title}" }
            columns:
              - ${ID}
              - { name: title, type: string, required: true, dense: true }
              - { name: members, type: list, items: link, ref: main.public.person, inverse: projects }
`;

let n = 0;
const person = (name: string, extra = "") => `---\ntable: main.public.person\nid: 01a0f000-0000-7000-8000-${String(++n).padStart(12, "0")}\nname: ${name}\n${extra}---\n`;

function vault() {
  return createDbVault({
    [METASTORE]: YAML,
    "P/Alice.md": person("Alice"),
    "P/Carol.md": person("Carol"),
    "P/Dave.md": person("Dave"),
    "P/Mark.md": person("Mark"),
    "P/Leo.md": person("Leo"),
    "Prj/Household.md": `---\ntable: main.public.project\nid: 01a0f000-0000-7000-8000-000000000999\ntitle: Household\n---\n`,
  });
}

const fm = (v: { read(p: string): string }, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const upd = (v: ReturnType<typeof vault>, path: string, set: Record<string, unknown>) => updateRow(v.app, v.settings, { table: "person", path, set });

describe("inverse link columns", () => {
  it("a symmetric list is mirrored in the same operation; undo reverts both rows", async () => {
    const v = vault();
    const r = await upd(v, "P/Alice.md", { friends: ["[[Carol]]"] });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    expect(r.notes_changed).toBe(2);
    expect(fm(v, "P/Carol.md").friends).toEqual(["[[Alice]]"]);
    expect((await undoOperation(v.app, v.settings, r.migration_id!)).ok).toBe(true);
    expect(fm(v, "P/Carol.md").friends ?? []).toEqual([]);
    expect(fm(v, "P/Alice.md").friends ?? []).toEqual([]);
  });

  it("removing a link removes the reciprocal one", async () => {
    const v = vault();
    await upd(v, "P/Alice.md", { friends: ["[[Carol]]", "[[Mark]]"] });
    expect(fm(v, "P/Mark.md").friends).toEqual(["[[Alice]]"]);
    await upd(v, "P/Alice.md", { friends: ["[[Mark]]"] });
    expect(fm(v, "P/Carol.md").friends).toEqual([]);
    expect(fm(v, "P/Mark.md").friends).toEqual(["[[Alice]]"]);
  });

  it("single values replace the previous partner, whose link goes too", async () => {
    const v = vault();
    await upd(v, "P/Carol.md", { partner: "[[Dave]]" });
    expect(fm(v, "P/Dave.md").partner).toBe("[[Carol]]");
    await upd(v, "P/Carol.md", { partner: "[[Mark]]" });
    expect(fm(v, "P/Mark.md").partner).toBe("[[Carol]]");
    expect(fm(v, "P/Dave.md").partner ?? null).toBeNull();
    // Taking Mark's partner from Carol: Carol loses hers.
    await upd(v, "P/Alice.md", { partner: "[[Mark]]" });
    expect(fm(v, "P/Mark.md").partner).toBe("[[Alice]]");
    expect(fm(v, "P/Carol.md").partner ?? null).toBeNull();
  });

  it("pairs declared on one side, and across tables", async () => {
    const v = vault();
    await upd(v, "P/Carol.md", { children: ["[[Leo]]"] });
    expect(fm(v, "P/Leo.md").parents).toEqual(["[[Carol]]"]);
    await upd(v, "P/Leo.md", { parents: ["[[Carol]]", "[[Dave]]"] }); // the undeclared side mirrors too
    expect(fm(v, "P/Dave.md").children).toEqual(["[[Leo]]"]);
    const p = await updateRow(v.app, v.settings, { table: "project", path: "Prj/Household.md", set: { members: ["[[Carol]]"] } });
    expect(p.ok).toBe(true);
    expect(fm(v, "P/Carol.md").projects).toEqual(["[[Household]]"]);
  });

  it("a new row links back from the rows it names", async () => {
    const v = vault();
    const r = await insertRow(v.app, v.settings, { table: "person", values: { name: "Anna", friends: ["[[Alice]]"] } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    expect(fm(v, "P/Alice.md").friends).toEqual(["[[Anna]]"]);
  });

  it("check_table reports links that are not reciprocated; align_relations adds them", async () => {
    const v = vault();
    v.write("P/Alice.md", person("Alice", 'friends: ["[[Carol]]"]\npartner: "[[Mark]]"\n'));
    v.write("P/Dave.md", person("Dave", 'partner: "[[Mark]]"\n'));
    const c = await checkTable(v.app, v.settings, { table: "person" });
    expect(c.violations.find((x) => x.path === "P/Alice.md")!.violations.map((x) => [x.code, x.column])).toEqual([
      ["inverse", "friends"],
      ["inverse", "partner"],
    ]);
    const a = await alignRelations(v.app, v.settings, { table: "person" });
    expect(a.ok).toBe(false); // Mark cannot be partner of both
    expect(a.conflicts[0]!.message).toMatch(/already links to/);
    v.write("P/Dave.md", person("Dave"));
    const b = await alignRelations(v.app, v.settings, { table: "person" });
    expect(b.ok).toBe(true);
    expect(fm(v, "P/Carol.md").friends).toEqual(["[[Alice]]"]);
    expect(fm(v, "P/Mark.md").partner).toBe("[[Alice]]");
    expect((await checkTable(v.app, v.settings, { table: "person" })).violations).toEqual([]);
    await expect(alignRelations(v.app, v.settings, { table: "project" })).resolves.toMatchObject({ ok: true });
  });

  it("links edited by hand are mirrored by the watcher", async () => {
    const v = vault();
    const watcher = new InverseWatcher(v.app, () => v.settings, async (changes) => {
      await syncRelations(v.app, v.settings, changes);
    }, 0);
    await checkTable(v.app, v.settings, { table: "person" }); // loads the metastore cache
    watcher.init();
    v.write("P/Alice.md", person("Alice", 'friends: ["[[Mark]]"]\n'));
    await watcher.flush("P/Alice.md");
    expect(fm(v, "P/Mark.md").friends).toEqual(["[[Alice]]"]);
    await watcher.flush("P/Mark.md"); // the mirrored write: nothing more to do
    v.write("P/Alice.md", person("Alice", "friends: []\n"));
    await watcher.flush("P/Alice.md");
    expect(fm(v, "P/Mark.md").friends).toEqual([]);
    expect(await syncRelations(v.app, v.settings, [])).toBeNull();
    watcher.dispose();
  });

  it("links edited by hand while a request ran are mirrored in a trace of their own", async () => {
    const out = traces();
    const v = vault();
    const watcher = new InverseWatcher(v.app, () => v.settings, async (changes) => {
      await rootOrChild("engine.op sync_relations", () => syncRelations(v.app, v.settings, changes));
    }, 0);
    await checkTable(v.app, v.settings, { table: "person" }); // loads the metastore cache
    watcher.init();
    v.write("P/Alice.md", person("Alice", 'friends: ["[[Mark]]"]\n'));
    withSpan("request", { root: true }, () => watcher.onChanged("P/Alice.md"));
    await vi.waitFor(() => expect(out.map((s) => s.name)).toContain("job inverse_links"), { timeout: 2000, interval: 5 });
    const by = Object.fromEntries(out.map((s) => [s.name, s]));
    expect(by["engine.op sync_relations"]!.traceId).not.toBe(by.request!.traceId);
    expect(by["engine.op sync_relations"]!.parentSpanId).toBe(by["job inverse_links"]!.spanId);
    expect(by["job inverse_links"]!.attributes["file.path"]).toBe("P/Alice.md");
    expect(fm(v, "P/Mark.md").friends).toEqual(["[[Alice]]"]);
    watcher.dispose();
  });

  it("validates inverse declarations", async () => {
    const v = vault();
    await expect(addColumn(v.app, v.settings, described({ table: "person", column: { name: "boss", type: "link", ref: "main.public.person", inverse: "nope" } }))).rejects.toThrow(/inverse column "nope" does not exist/);
    await expect(addColumn(v.app, v.settings, described({ table: "person", column: { name: "boss", type: "link", ref: "main.public.person", inverse: "children" } }))).rejects.toThrow(/declares inverse "parents"/);
    await expect(addColumn(v.app, v.settings, described({ table: "person", column: { name: "nick", type: "string", inverse: "name" } }))).rejects.toThrow(/needs a link column/);
    await expect(addColumn(v.app, v.settings, described({ table: "person", column: { name: "boss", type: "link", ref: "main.public.project", inverse: "title" } }))).rejects.toThrow(/must be a link column with ref main.public.person/);
    const ok = await alterColumn(v.app, v.settings, { table: "person", name: "parents", changes: { inverse: "children" } });
    expect(ok.ok).toBe(true);
  });
});

describe("inverse links over REST and in batches", () => {
  it("align_relations route and batch op", async () => {
    const { createHandlers, dispatch } = await import("../src/server/rest");
    const { createPublicApi } = await import("../src/core/public-api");
    const v = vault();
    v.write("P/Alice.md", person("Alice", 'friends: ["[[Carol]]"]\n'));
    const h = createHandlers(v.app, () => v.settings);
    const dry = await dispatch("/operations/align_relations/", h["/operations/align_relations/"]!, { table: "person", dry_run: true });
    expect(dry.status).toBe(200);
    expect((dry.json as { planned_edits: { path: string }[] }).planned_edits.map((p) => p.path)).toEqual(["P/Carol.md"]);
    const api = createPublicApi(v.app, () => v.settings);
    const b = await api.batch({
      operations: [
        { op: "align_relations", table: "person" },
        { op: "updateRow", table: "person", path: "P/Dave.md", set: { partner: "[[Carol]]" } },
      ],
    });
    expect(b.ok).toBe(true);
    expect(fm(v, "P/Carol.md")).toMatchObject({ friends: ["[[Alice]]"], partner: "[[Dave]]" });
    expect((await api.undo(b.migration_id!)).ok).toBe(true);
    expect(fm(v, "P/Carol.md").partner ?? null).toBeNull();
    expect(fm(v, "P/Carol.md").friends ?? []).toEqual([]);
  });
});
