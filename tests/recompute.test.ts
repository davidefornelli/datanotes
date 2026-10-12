import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoRecompute } from "../src/core/auto-recompute";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { evalGenerated, generatedRefs } from "../src/core/generated";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { listMigrations } from "../src/core/journal";
import { RECOMPUTE_YIELD } from "../src/core/row-ops";
import { checkTable, insertRow, recomputeColumns, updateRows } from "../src/core/rows";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const P = "Datanotes/main/public/person";

async function people(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  const r = await createTable(v.app, v.settings, described({
    name: "person",
    options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true },
      { name: "surname", type: "string" },
      { name: "born", type: "date" },
      { name: "title", type: "string", generated: "{name} {surname}" },
      { name: "label", type: "string", generated: "{title} ({born:DD/MM})" },
    ],
  }));
  expect(r.ok).toBe(true);
  return v;
}

describe("generated templates", () => {
  it("parse references and render text, links and dates", () => {
    expect(generatedRefs("{name} {surname}")).toEqual(["name", "surname"]);
    expect(generatedRefs("date(occurred_at)+1")).toEqual(["occurred_at"]);
    expect(() => generatedRefs("{name")).toThrow(/unbalanced/);
    expect(() => generatedRefs("name + surname")).toThrow(/not a generated expression/);
    const get = (row: Record<string, unknown>) => (k: string) => row[k];
    expect(evalGenerated("{name} {surname}", get({ name: "Alice", surname: "Smith" }), "x")).toBe("Alice Smith");
    expect(evalGenerated("{name} {surname}", get({ name: "Alice" }), "x")).toBe("Alice");
    expect(evalGenerated("{name} ({born:DD/MM})", get({ name: "Ada" }), "x")).toBe("Ada");
    expect(evalGenerated("{who}: {tags}", get({ who: "[[People/Ada Lovelace|Ada]]", tags: ["a", "b"] }), "x")).toBe("Ada: a, b");
    expect(evalGenerated("{name} {surname}", get({}), "x")).toBeNull();
  });

  it("are checked when the table is defined", async () => {
    const v = createDbVault({});
    const base = { name: "t", options: { filename: "{a}" } };
    await expect(createTable(v.app, v.settings, described({ ...base, columns: [{ name: "a", type: "string" }, { name: "b", type: "string", generated: "{nope}" }] }))).rejects.toThrow(/unknown column "nope"/);
    await expect(createTable(v.app, v.settings, described({ ...base, columns: [{ name: "a", type: "string" }, { name: "b", type: "integer", generated: "{a}" }] }))).rejects.toThrow(/string column/);
    await expect(createTable(v.app, v.settings, described({ ...base, columns: [{ name: "a", type: "string" }, { name: "b", type: "string", generated: "{b}" }] }))).rejects.toThrow(/itself/);
  });

  it("are recomputed on insert and update, in the same write", async () => {
    const v = await people();
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Alice", surname: "Brown", born: "1990-03-05" } });
    expect(fm(v, `${P}/Alice.md`)).toMatchObject({ title: "Alice Brown", label: "Alice Brown (05/03)" });
    const u = await updateRows(v.app, v.settings, { table: "person", where: { name: "Alice" }, set: { surname: "Smith" } });
    expect(u.ok).toBe(true);
    expect(fm(v, `${P}/Alice.md`)).toMatchObject({ title: "Alice Smith", label: "Alice Smith (05/03)" });
  });
});

describe("recompute", () => {
  it("fixes rows edited by hand, and is a no-op otherwise", async () => {
    const v = await people();
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Alice", surname: "Brown" } });
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Ada", surname: "Lovelace" } });
    v.write(`${P}/Alice.md`, v.read(`${P}/Alice.md`).replace("surname: Brown", "surname: Smith"));
    expect((await checkTable(v.app, v.settings, { table: "person" })).violations.map((x) => x.path)).toEqual([`${P}/Alice.md`]);
    const r = await recomputeColumns(v.app, v.settings, { table: "person" });
    expect(r.ok).toBe(true);
    expect(r.planned_edits.map((p) => p.path)).toEqual([`${P}/Alice.md`]);
    expect(r.migration_id).toMatch(/.+/);
    expect(fm(v, `${P}/Alice.md`).title).toBe("Alice Smith");
    expect(r.commits?.map((c) => c.operation)).toEqual(["RECOMPUTE"]);
    const again = await recomputeColumns(v.app, v.settings, { table: "person" });
    expect([again.ok, again.migration_id, again.notes_changed]).toEqual([true, undefined, 0]);
  });
});

describe("AutoRecompute", () => {
  afterEach(() => vi.useRealTimers());

  it("recomputes a row a few seconds after its last change, never a note that is not a row", async () => {
    const v = await people();
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Alice", surname: "Brown" } });
    v.write("Note/free.md", "A note that is not a row.\n");
    vi.useFakeTimers();
    const calls: unknown[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (_a, _s, input) => {
      calls.push(input);
      return { ok: true } as never;
    }, undefined, 1000);
    const alice = v.file(`${P}/Alice.md`);
    auto.onChanged(alice);
    vi.advanceTimersByTime(600);
    auto.onChanged(alice); // still typing: the delay restarts
    vi.advanceTimersByTime(600);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([{ table: "main.public.person", paths: [`${P}/Alice.md`] }]);
    auto.onChanged(v.file("Note/free.md"));
    vi.advanceTimersByTime(2000);
    expect(calls).toHaveLength(1);
    v.settings.autoRecompute = false;
    auto.onChanged(alice);
    vi.advanceTimersByTime(2000);
    expect(calls).toHaveLength(1);
    auto.dispose();
  });

  it("a row renamed while its recompute waits: only the new path is recomputed", async () => {
    const v = await people();
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Alice", surname: "Brown" } });
    const calls: unknown[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (_a, _s, input) => {
      calls.push(input);
      return { ok: true } as never;
    }, undefined, 1000);
    vi.useFakeTimers();
    auto.onChanged(v.file(`${P}/Alice.md`));
    vi.advanceTimersByTime(500);
    await v.rename(`${P}/Alice.md`, `${P}/Alicia.md`);
    auto.onRenamed(v.file(`${P}/Alicia.md`), `${P}/Alice.md`);
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([{ table: "main.public.person", paths: [`${P}/Alicia.md`] }]);
    auto.onRenamed(v.file(`${P}/Alicia.md`), `${P}/Gone.md`); // nothing was waiting for the old path
    vi.advanceTimersByTime(2000);
    expect(calls).toHaveLength(2);
    auto.dispose();
  });
});

describe("AutoRecompute after a bulk edit outside the engine", () => {
  afterEach(() => {
    vi.useRealTimers();
    RECOMPUTE_YIELD.rows = 500;
  });

  const N = "Datanotes/main/public/note";

  /** A table with an identity id and no generated column, and `count` rows written by the engine. */
  async function notes(count: number): Promise<DbVault> {
    const v = createDbVault({});
    const r = await createTable(v.app, v.settings, described({
      name: "note",
      options: { filename: "{name}" },
      columns: [{ name: "name", type: "string", required: true }, { name: "mood", type: "string" }],
    }));
    expect(r.ok).toBe(true);
    for (let i = 0; i < count; i++) expect((await insertRow(v.app, v.settings, { table: "note", values: { name: `Note ${i}`, mood: "calm" } })).ok).toBe(true);
    return v;
  }
  const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const stripId = (text: string) => text.replace(/\nid: .*\n/, "\n");

  it("groups the rows changed together into one recompute per table", async () => {
    const v = await people();
    for (const name of ["Alice", "Bob", "Carol"]) await insertRow(v.app, v.settings, { table: "person", values: { name, surname: "Brown" } });
    vi.useFakeTimers();
    const calls: RecomputeCall[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (_a, _s, input) => {
      calls.push(input);
      return { ok: true } as never;
    }, undefined, 1000);
    // a find and replace over the table: every row changes within a moment
    for (const name of ["Alice", "Bob", "Carol"]) {
      auto.onChanged(v.file(`${P}/${name}.md`));
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([{ table: "main.public.person", paths: [`${P}/Alice.md`, `${P}/Bob.md`, `${P}/Carol.md`] }]);
    auto.dispose();
  });

  it("while a row keeps changing, the rows already quiet go after ten delays at the latest", async () => {
    const v = await people();
    for (const name of ["Alice", "Bob"]) await insertRow(v.app, v.settings, { table: "person", values: { name, surname: "Brown" } });
    vi.useFakeTimers();
    const calls: RecomputeCall[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (_a, _s, input) => {
      calls.push(input);
      return { ok: true } as never;
    }, undefined, 1000);
    auto.onChanged(v.file(`${P}/Alice.md`));
    // Bob is edited every half second: the table is never quiet
    for (let t = 0; t < 9500; t += 500) {
      auto.onChanged(v.file(`${P}/Bob.md`));
      vi.advanceTimersByTime(500);
    }
    expect(calls).toEqual([]);
    auto.onChanged(v.file(`${P}/Bob.md`));
    vi.advanceTimersByTime(600);
    expect(calls).toEqual([{ table: "main.public.person", paths: [`${P}/Alice.md`] }]);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([
      { table: "main.public.person", paths: [`${P}/Alice.md`] },
      { table: "main.public.person", paths: [`${P}/Bob.md`] },
    ]);
    auto.dispose();
  });

  it("a single row changing all the time waits for its own quiet time, past the ten delays", async () => {
    const v = await people();
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Bob", surname: "Brown" } });
    vi.useFakeTimers();
    const calls: RecomputeCall[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (_a, _s, input) => {
      calls.push(input);
      return { ok: true } as never;
    }, undefined, 1000);
    for (let t = 0; t < 12_000; t += 500) {
      auto.onChanged(v.file(`${P}/Bob.md`));
      vi.advanceTimersByTime(500);
    }
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(calls).toEqual([{ table: "main.public.person", paths: [`${P}/Bob.md`] }]);
    // disposed while a recompute waits: it never runs
    auto.onChanged(v.file(`${P}/Bob.md`));
    auto.dispose();
    vi.advanceTimersByTime(2000);
    expect(calls).toHaveLength(1);
  });

  it("a file name or creation time identity that is missing or stale is recomputed", async () => {
    const v = createDbVault({});
    const B = "Datanotes/main/public/book";
    expect((await createTable(v.app, v.settings, described({
      name: "book",
      options: { filename: "{title}" },
      columns: [{ name: "title", type: "string", identity: "filename" }, { name: "added", type: "datetime", identity: "created" }, { name: "author", type: "string" }],
    }))).ok).toBe(true);
    await insertRow(v.app, v.settings, { table: "book", values: { title: "Dune", author: "Frank" } });
    vi.useFakeTimers();
    const calls: RecomputeCall[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (_a, _s, input) => {
      calls.push(input);
      return { ok: true } as never;
    }, undefined, 1000);
    auto.onChanged(v.write(`${B}/Dune.md`, v.read(`${B}/Dune.md`).replace("author: Frank", "author: Frank H.")));
    vi.advanceTimersByTime(1500);
    expect(calls).toEqual([]);
    auto.onChanged(v.write(`${B}/Dune.md`, v.read(`${B}/Dune.md`).replace(/\nadded: .*\n/, "\n")));
    await v.rename(`${B}/Dune.md`, `${B}/Dune Messiah.md`);
    auto.onRenamed(v.file(`${B}/Dune Messiah.md`), `${B}/Dune.md`);
    vi.advanceTimersByTime(1500);
    expect(calls).toEqual([{ table: "main.public.book", paths: [`${B}/Dune Messiah.md`] }]);
    auto.dispose();
  });

  it("skips rows whose identity columns hold their values; recomputes the others in one operation", async () => {
    const v = await notes(4);
    const calls: RecomputeCall[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (a, s, input) => {
      calls.push(input);
      return recomputeColumns(a, s, input);
    }, undefined, 20);
    // a find and replace that leaves the ids alone: nothing to recompute, the table is not read
    for (let i = 0; i < 4; i++) {
      v.write(`${N}/Note ${i}.md`, v.read(`${N}/Note ${i}.md`).replace("mood: calm", "mood: glad"));
      auto.onChanged(v.file(`${N}/Note ${i}.md`));
    }
    await quiet(80);
    expect(calls).toEqual([]);
    // two notes lose their id (a script rewrote their properties): one recompute gives both a new one
    const before = (await listMigrations(v.app, v.settings, {})).migrations.length;
    for (const i of [1, 3]) {
      v.write(`${N}/Note ${i}.md`, stripId(v.read(`${N}/Note ${i}.md`)));
      auto.onChanged(v.file(`${N}/Note ${i}.md`));
    }
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 2000 });
    expect(calls[0]).toEqual({ table: "main.public.note", paths: [`${N}/Note 1.md`, `${N}/Note 3.md`] });
    await vi.waitFor(() => expect(fm(v, `${N}/Note 3.md`).id).toMatch(/^[0-9a-f-]{36}$/), { timeout: 2000 });
    expect(fm(v, `${N}/Note 1.md`).id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await listMigrations(v.app, v.settings, {})).migrations.length).toBe(before + 1);
    auto.dispose();
  });

  it("a note copied with its id is recomputed: the copy gets an id of its own", async () => {
    const v = await notes(2);
    const calls: RecomputeCall[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (a, s, input) => {
      calls.push(input);
      return recomputeColumns(a, s, input);
    }, undefined, 20);
    // the index of ids is built on the first change seen
    auto.onChanged(v.file(`${N}/Note 0.md`));
    const original = fm(v, `${N}/Note 1.md`).id as string;
    v.write(`${N}/Note 1 copy.md`, v.read(`${N}/Note 1.md`).replace("name: Note 1", "name: Note 1 copy"));
    auto.onChanged(v.file(`${N}/Note 1 copy.md`));
    await vi.waitFor(() => expect(fm(v, `${N}/Note 1 copy.md`).id).not.toBe(original), { timeout: 2000 });
    expect(calls).toEqual([{ table: "main.public.note", paths: [`${N}/Note 1 copy.md`] }]);
    expect(fm(v, `${N}/Note 1.md`).id).toBe(original);
    // the original, edited again, keeps its id and needs nothing
    auto.onChanged(v.file(`${N}/Note 1.md`));
    await quiet(80);
    expect(calls).toHaveLength(1);
    auto.dispose();
  });

  it("ids copied before the index was built, a row renamed by hand, a row the engine wrote since", async () => {
    const v = await notes(2);
    const calls: RecomputeCall[] = [];
    const auto = new AutoRecompute(v.app, () => v.settings, async (_a, _s, input) => {
      calls.push(input);
      return { ok: true } as never;
    }, undefined, 300);
    // already copied when the engine first looks: both notes are recomputed (the oldest keeps its id)
    v.write(`${N}/Twin.md`, v.read(`${N}/Note 0.md`).replace("name: Note 0", "name: Twin"));
    auto.onChanged(v.file(`${N}/Note 0.md`));
    auto.onChanged(v.file(`${N}/Twin.md`));
    // a rename by hand: the id moves with the note (its old path holds nothing any more)
    await v.rename(`${N}/Note 1.md`, `${N}/Renamed.md`);
    auto.onRenamed(v.file(`${N}/Renamed.md`), `${N}/Note 1.md`);
    // a row the engine wrote after the index was built: seen for the first time, it is recomputed once
    await insertRow(v.app, v.settings, { table: "note", values: { name: "Late" } });
    auto.onChanged(v.file(`${N}/Late.md`));
    auto.onChanged(v.file(`${N}/Late.md`));
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 2000 });
    expect([...calls[0]!.paths!].sort()).toEqual([`${N}/Late.md`, `${N}/Note 0.md`, `${N}/Twin.md`]);
    auto.onChanged(v.file(`${N}/Late.md`));
    await quiet(80);
    expect(calls).toHaveLength(1);
    auto.dispose();
  });

  it("a large recompute lets the event loop turn between rows", async () => {
    const v = await notes(3);
    for (let i = 0; i < 3; i++) v.write(`${N}/Note ${i}.md`, stripId(v.read(`${N}/Note ${i}.md`)));
    RECOMPUTE_YIELD.rows = 1;
    let turns = 0;
    const ticking = setInterval(() => turns++, 0);
    const r = await recomputeColumns(v.app, v.settings, { table: "note" });
    clearInterval(ticking);
    expect(r.ok).toBe(true);
    expect(r.planned_edits).toHaveLength(3);
    expect(turns).toBeGreaterThan(0);
  });
});

type RecomputeCall = { table: string; paths?: string[] };
