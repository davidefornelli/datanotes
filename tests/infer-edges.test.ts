import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { inferTable } from "../src/core/infer";
import { createDbVault, METASTORE, withTables } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const PERSON = withTables(
  "person:\n  options: { filename: \"{name}\" }\n  columns:\n    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }\n    - { name: name, type: string }\n",
);
const person = (n: number, name: string) => `---\ntable: main.public.person\nid: 01a0f000-0000-7000-8000-00000000000${n}\nname: ${name}\n---\n`;

/** Reading notes written by hand over time: the same property takes different shapes. */
function readingVault() {
  return createDbVault({
    [METASTORE]: PERSON,
    "People/Herbert.md": person(1, "Herbert"),
    "People/Le Guin.md": person(2, "Le Guin"),
    // `author: [[Herbert]]` without quotes is a nested list in YAML (as Obsidian reads it too).
    "Reading/Dune.md":
      '---\ntitle: Dune\nauthor: [[Herbert]]\ntags: [classic, desert]\nfinished: true\nstarted: 2026-01-10\nscores: [5, "n/a"]\nrating:\npeople: ["[[Herbert]]", "[[Le Guin]]"]\ncssclasses: [wide]\n_draft: true\n---\n',
    "Reading/Earthsea.md":
      '---\ntitle: Earthsea\nauthor: [[Le Guin]]\ntags: classic\nfinished: false\nstarted: early spring\nscores: [4]\nrating:\npeople: "[[Le Guin]]"\n---\n',
    "Reading/Lathe.md": '---\ntitle: Lathe\ntags: [classic]\nfinished: true\nstarted: 2026-03-01\npeople:\n  - "[[Herbert]]"\n  -\n  - "[[Nobody]]"\n---\n',
  });
}

describe("inferTable: properties with mixed shapes", () => {
  it("reconciles lists with single values, mixed kinds, booleans and always-empty keys", async () => {
    const v = readingVault();
    const r = await inferTable(v.app, v.settings, { folder: "Reading" });
    expect(r.files).toBe(3);
    expect(r.skipped).toEqual([]);
    const col = (n: string) => r.columns.find((c) => c.name === n)!;
    // a list in some notes, one value in another: a list; repeated strings make its items an enum
    expect(col("tags")).toEqual({
      name: "tags",
      type: "list",
      description: null,
      items: "enum",
      values: ["classic", "desert"],
      required: true,
      dense: true,
      stats: { present: 3, filled: 3, distinct: 3, types: { list: 2, string: 1 }, examples: [["classic", "desert"], "classic", ["classic"]] },
    });
    // links, one as a single value, a blank item, an unresolved one: still a link list to person
    expect(col("people")).toMatchObject({ type: "list", items: "link", ref: "main.public.person", required: true });
    // list items of different kinds are strings
    expect(col("scores")).toMatchObject({ type: "list", items: "string", stats: { types: { list: 2 } } });
    // unquoted wikilinks are lists of lists: items are strings
    expect(col("author")).toMatchObject({ type: "list", items: "string", stats: { present: 2, filled: 2 } });
    expect(col("author").ref).toBeUndefined();
    expect(col("finished")).toMatchObject({ type: "boolean", required: true, dense: true, stats: { distinct: 2, types: { boolean: 3 } } });
    // dates and free text do not reconcile: a string (too varied for an enum)
    expect(col("started")).toMatchObject({ type: "string", required: true, stats: { types: { date: 2, string: 1 } } });
    // a key that is always empty: a string column nothing fills
    expect(col("rating")).toEqual({ name: "rating", type: "string", description: null, stats: { present: 2, filled: 0, distinct: 0, types: {}, examples: [] } });
    // Obsidian's own keys and private `_` keys are not data
    expect(r.columns.map((c) => c.name).sort()).toEqual(["author", "finished", "people", "rating", "scores", "started", "tags", "title"]);
    expect(r.proposal).toMatchObject({ name: "reading", options: { filename: "{title}" } });
    expect(r.hints).toEqual(["write the description of the table and of each column (null in the proposal) before create_table: it refuses them empty"]);
  });

  it("a link column whose targets are plain notes gets no ref", async () => {
    const v = createDbVault({
      [METASTORE]: PERSON,
      "Places/Office.md": "The office.\n",
      "Places/Home.md": "---\naliases: [house]\n---\nHome.\n",
      "Meetings/standup.md": '---\nplace: "[[Office]]"\n---\n',
      "Meetings/retro.md": '---\nplace: "[[Home]]"\n---\n',
      "Meetings/planning.md": '---\nplace: "[[Office]]"\n---\n',
    });
    const r = await inferTable(v.app, v.settings, { folder: "Meetings" });
    expect(r.columns).toEqual([
      {
        name: "place",
        type: "link",
        description: null,
        required: true,
        dense: true,
        stats: { present: 3, filled: 3, distinct: 2, types: { link: 3 }, examples: ["[[Office]]", "[[Home]]", "[[Office]]"] },
      },
    ]);
    expect(r.hints).toEqual(['no column matches the file names: set filename (e.g. "{title}") and adopt with relocate: false to keep the current names', "write the description of the table and of each column (null in the proposal) before create_table: it refuses them empty"]);
  });
});

describe("inferTable: sources and names", () => {
  it("takes paths with or without .md, ignores missing ones, and names the table `notes`", async () => {
    const v = readingVault();
    const r = await inferTable(v.app, v.settings, { paths: ["Reading/Dune", "Reading/Earthsea.md", "Reading/Gone"] });
    expect(r.paths).toEqual(["Reading/Dune.md", "Reading/Earthsea.md"]);
    expect(r.proposal!.name).toBe("notes");
    expect(r.adopt).toEqual({ paths: ["Reading/Dune.md", "Reading/Earthsea.md"], relocate: false });
  });

  it("the file names match a property whose key is not a column name: the file name template uses the column", async () => {
    const v = createDbVault({ "Books/Dune.md": "---\nBook Title: Dune\n---\n", "Books/Lathe.md": "---\nBook Title: Lathe\n---\n" });
    const r = await inferTable(v.app, v.settings, { folder: "Books" });
    expect(r.columns.map((c) => [c.name, c.from])).toEqual([["book_title", "Book Title"]]);
    expect(r.proposal).toMatchObject({ name: "books", options: { filename: "{book_title}" } });
  });

  it("a folder whose name has no letters or digits proposes `notes`", async () => {
    const v = createDbVault({ "📚/Dune.md": "---\ntitle: Dune\n---\n", "📚/Lathe.md": "---\ntitle: Lathe\n---\n" });
    const r = await inferTable(v.app, v.settings, { folder: "📚/" });
    expect(r.files).toBe(2);
    expect(r.proposal).toEqual({ name: "notes", description: null, options: { filename: "{title}" }, columns: [{ name: "title", type: "string", description: null, required: true, dense: true }] });
  });

  it("a note without frontmatter counts as a note with no properties", async () => {
    const v = createDbVault({ "Ideas/a.md": "---\nmood: calm\n---\n", "Ideas/b.md": "Just text, no properties.\n" });
    const r = await inferTable(v.app, v.settings, { folder: "Ideas" });
    expect(r.files).toBe(2);
    expect(r.columns).toEqual([{ name: "mood", type: "string", description: null, stats: { present: 1, filled: 1, distinct: 1, types: { string: 1 }, examples: ["calm"] } }]);
  });

  it("two properties that map to the same column name are reported", async () => {
    const v = createDbVault({
      "Tasks/a.md": "---\nDue date: 2026-10-01\n---\n",
      "Tasks/b.md": "---\ndue_date: 2026-10-02\n---\n",
      "Tasks/c.md": "---\nDue date: 2026-10-03\n---\n",
    });
    const r = await inferTable(v.app, v.settings, { folder: "Tasks" });
    expect(r.columns.map((c) => [c.name, c.from ?? null, c.stats.filled])).toEqual([
      ["due_date", "Due date", 2],
      ["due_date", null, 1],
    ]);
    expect(r.hints).toContain('"due_date" and "Due date" map to the same column name "due_date": rename one');
    expect(r.adopt!.rename).toEqual({ "Due date": "due_date" });
  });

  it("a folder holding only rows of tables has no notes to infer from", async () => {
    const v = createDbVault({ [METASTORE]: PERSON, "People/Herbert.md": person(1, "Herbert") });
    const r = await inferTable(v.app, v.settings, { folder: "People" });
    expect(r).toEqual({
      files: 0,
      paths: [],
      skipped: [{ path: "People/Herbert.md", reason: "already a row of main.public.person" }],
      columns: [],
      proposal: { name: "people", description: null, options: {}, columns: [] },
      adopt: { paths: [], relocate: false },
      hints: [
        'no column matches the file names: set filename (e.g. "{title}") and adopt with relocate: false to keep the current names',
        "no notes to infer from",
        "write the description of the table and of each column (null in the proposal) before create_table: it refuses them empty",
      ],
    });
  });
});
