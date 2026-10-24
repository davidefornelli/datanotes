import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXT_DOCS, validateManifest } from "../src/api/extension-manifest";
import type { ExtensionManifest } from "../src/api/extension-manifest";
import { chooseTables, planChanges, renderPlan, type DescribedTable, type InstallChoices, type PlanInput, type TablesListing } from "../src/api/extension-plan";
import type { InstalledExtension } from "../src/api/extension-record";

const FIXTURE = path.join(__dirname, "fixtures", "extensions", "books");
const NOW = "2026-10-19T08:00:00.000Z";
const LATER = "2026-11-02T09:30:00.000Z";

/** The books manifest of a version, as JSON, changed by `edit` before validation. */
function books(version = "v0.1.0", edit?: (m: any) => void): ExtensionManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE, version, "datanotes-extension.json"), "utf8"));
  edit?.(raw);
  return validateManifest(raw);
}
const V1 = books("v0.1.0");
const V2 = books("v0.2.0");

const table = (qualified: string) => {
  const [catalog, schema, name] = qualified.split(".") as [string, string, string];
  return { qualified, name, catalog, schema };
};
const LISTING: TablesListing = {
  default_catalog: "work",
  tables: [
    { ...table("work.planning.person"), aliases: ["people", "team"] },
    { ...table("work.planning.project"), aliases: ["projects", "areas"] },
    table("work.planning.task"),
    table("work.books.book"),
  ],
  views: [{ qualified: "work.books.vw_reading" }],
};
const PERSON: DescribedTable = {
  qualified: "work.planning.person",
  columns: [
    { name: "id", type: "string" },
    { name: "name", type: "string", required: true, description: "Full name" },
    { name: "email", type: "string", description: "Email address" },
  ],
};
const CHECK = { or: [{ status: "read" }, { rating: { exists: false } }] };
const HINT_V1 = "Rate a book only once it is read: set status read, or remove rating.";
const HINT_V2 = "Rate a book only once it is read: set status read first, or remove rating.";
const FINISHED_ON = { name: "finished_on", type: "date", description: "The day the book was finished" };

const SOURCE_V1: PlanInput["source"] = {
  label: "https://example.com/books.git#v0.1.0",
  record: { kind: "git", url: "https://example.com/books.git", ref: "v0.1.0" },
  commit: "a".repeat(40),
  manifest_sha256: "1".repeat(64),
  entry_sha256: "2".repeat(64),
};
const SOURCE_V2: PlanInput["source"] = { ...SOURCE_V1, label: "https://example.com/books.git#v0.2.0", record: { ...SOURCE_V1.record, ref: "v0.2.0" }, commit: "b".repeat(40), manifest_sha256: "3".repeat(64) };

type Overrides = Partial<Omit<PlanInput, "choices">> & { choices?: Partial<InstallChoices> };

function inputFor(manifest: ExtensionManifest, o: Overrides): PlanInput {
  const { choices: given, ...rest } = o;
  const choices: InstallChoices = { map: {}, columns: {}, create: [], add: {}, ...given };
  const listing = o.listing ?? LISTING;
  const installed = o.installed ?? null;
  const { chosen, problems } = chooseTables(manifest, listing, choices, installed);
  return {
    manifest,
    source: SOURCE_V2,
    engineVersion: "3.3.0",
    described: { "work.planning.person": PERSON, "work.books.book": bookTable() },
    bases: [
      { name: "dated", columns: ["date"] },
      { name: "shelved", columns: ["shelf"] },
    ],
    tokens: ["ext-books"],
    oldManifest: V1,
    others: [],
    reservedTools: ["select_rows", "insert_row", "read_docs"],
    localTokenPresent: true,
    now: LATER,
    ...rest,
    listing,
    installed,
    choices,
    chosen,
    choiceProblems: problems,
  };
}

/** The record of v0.1.0 as a fresh install wrote it. */
function installedV1(): InstalledExtension {
  const fresh: PlanInput = {
    ...inputFor(V1, { listing: { ...LISTING, tables: LISTING.tables.slice(0, 3), views: [] }, oldManifest: null, tokens: [], source: SOURCE_V1, now: NOW, bases: [] }),
  };
  const first = planChanges(fresh);
  expect(first.ready).toBe(true);
  return { ...first.record!, migration_id: "m1" };
}

/** The book table as v0.1.0 created it: its columns after id and the base's, its CHECK, instructions and tags. */
function bookTable(edit?: (d: DescribedTable) => void): DescribedTable {
  const d: DescribedTable = {
    qualified: "work.books.book",
    columns: [
      { name: "id", type: "string" },
      { name: "shelf", type: "string", description: "The shelf it sits on" },
      { name: "title", type: "string", required: true, description: "The book's title, as printed on the cover" },
      { name: "author", type: "link", ref: "work.planning.person", description: "Who wrote it" },
      { name: "status", type: "enum", values: ["to_read", "reading", "read"], default: "to_read", description: "Where the reader is with it" },
      { name: "rating", type: "integer", min: 1, max: 5, description: "From 1 to 5, once read" },
    ],
    constraints: { rating_only_when_read: CHECK },
    constraint_hints: { rating_only_when_read: HINT_V1 },
    instructions: "How to add a book:\n\n1. `title` as printed on the cover.\n2. `author`: a row of work.planning.person.\n",
    bases: ["shelved"],
    tags: { extension: "books", extension_role: "book" },
  };
  edit?.(d);
  return d;
}

const update = (manifest: ExtensionManifest, o: Overrides = {}) => planChanges(inputFor(manifest, { installed: installedV1(), ...o }));
const ops = (p: { operations: Record<string, unknown>[] }) => p.operations.map((o) => o.op);

describe("planChanges: an update over a dependency whose column is mapped", () => {
  /** v0.1.0 installed with person.name read from `full_name`. */
  const mapped = (): InstalledExtension => {
    const i = installedV1();
    return { ...i, tables: { ...i.tables, person: { ...i.tables.person!, columns: { name: "full_name" } } } };
  };
  const fullName: DescribedTable = { ...PERSON, columns: PERSON.columns.map((c) => (c.name === "name" ? { ...c, name: "full_name" } : c)) };
  const described = { "work.planning.person": fullName, "work.books.book": bookTable() };

  it("keeps the mapping and runs a migration that does not name the mapped column", () => {
    const p = update(V2, { installed: mapped(), described });
    expect(p.problems).toEqual([]);
    expect(ops(p)).toEqual(["add_column", "drop_constraint", "add_constraint"]);
    expect(p.record!.tables.person!.columns).toEqual({ name: "full_name" });
  });

  it("a view the update replaces reads the mapped column", () => {
    const m = books("v0.2.0", (r) => (r.views.vw_reading.query.columns = ["title", "author.name"]));
    const p = update(m, { installed: mapped(), described });
    expect(p.operations.find((o) => o.op === "create_view")).toMatchObject({ replace: true, query: { columns: ["title", "author.full_name"] } });
  });

  it("a repair replaces a view and a CHECK that 3.4.1 installed with the manifest's names", () => {
    const m = books("v0.1.0", (r) => {
      r.views.vw_reading.query.columns = ["title", "author.name"];
      r.tables.book.constraints.push({ name: "author_named", check: { "author.name": { exists: true } }, hint: "Pick an author with a name." });
    });
    const installed = { ...mapped(), version: "0.1.0", commit: SOURCE_V1.commit };
    const book = bookTable((d) => {
      d.constraints = { ...d.constraints, author_named: { "author.name": { exists: true } } };
      d.constraint_hints = { ...d.constraint_hints, author_named: "Pick an author with a name." };
    });
    const listing = { ...LISTING, views: [{ qualified: "work.books.vw_reading" }] };
    const p = planChanges(inputFor(m, { installed, source: SOURCE_V1, oldManifest: m, listing, described: { "work.planning.person": fullName, "work.books.book": book } }));
    expect(p.action).toBe("repair");
    expect(p.problems).toEqual([]);
    expect(p.operations).toEqual([
      { op: "drop_constraint", table: "work.books.book", name: "author_named" },
      { op: "add_constraint", table: "work.books.book", name: "author_named", check: { "author.full_name": { exists: true } }, hint: "Pick an author with a name." },
      expect.objectContaining({ op: "create_view", replace: true, query: { table: "work.books.book", where: { status: "reading" }, columns: ["title", "author.full_name"] } }),
    ]);
  });

  it("refuses a migration step that names the mapped column through a link", () => {
    const m = books("v0.2.0", (r) => r.migrations[0].operations.push({ op: "add_constraint", table: "@book", name: "author_named", check: { "author.name": { exists: true } }, hint: "Pick an author with a name." }));
    const p = update(m, { installed: mapped(), described });
    expect(p.problems).toEqual([
      {
        code: "migration_conflict",
        role: "person",
        column: "name",
        detail: "migration 0.2.0: add_constraint names column name of person, which reads your column full_name",
        hint: "Rename your column to name with rename_column and run the command again without --map person.name, or ask the extension's author.",
        docs: EXT_DOCS.update,
      },
    ]);
    // the keys of a step are parameters, not columns: its `name` key does not name person.name
    const own = books("v0.2.0", (r) => r.migrations[0].operations.push({ op: "add_column", table: "@book", column: { name: "label", type: "string", description: "A label" } }));
    expect(update(own, { installed: mapped(), described }).problems).toEqual([]);
  });
});

describe("planChanges: an update", () => {
  it("update runs the migration, then replaces the CHECK whose hint changed", () => {
    const installed = installedV1();
    const p = update(V2, { installed });
    expect(p.action).toBe("update");
    expect(p.extension.from_version).toBe("0.1.0");
    expect(p.problems).toEqual([]);
    expect(p.operations).toEqual([
      { op: "add_column", table: "work.books.book", column: FINISHED_ON },
      { op: "drop_constraint", table: "work.books.book", name: "rating_only_when_read" },
      { op: "add_constraint", table: "work.books.book", name: "rating_only_when_read", check: CHECK, hint: HINT_V2 },
    ]);
    expect(p.tables.map((t) => [t.role, t.table, t.decision, t.proposed])).toEqual([
      ["person", "work.planning.person", "match", false],
      ["book", "work.books.book", "adopt", false],
    ]);
    expect(p.tables[1]!.changes).toEqual(["replace CHECK rating_only_when_read"]);
    expect(p.token).toEqual({ name: "ext-books", action: "keep", write: ["work.books.book"], previous_write: ["work.books.book"] });
    expect(p.tools.map((t) => [t.name, t.change])).toEqual([
      ["list_reading", "same"],
      ["finish_book", "same"],
    ]);
    expect(p.record).toMatchObject({ version: "0.2.0", commit: "b".repeat(40), installed_at: NOW, updated_at: LATER, migration_id: null, source: SOURCE_V2.record });
    expect(p.record!.previous).toEqual(installed);
    expect(p.summary).toBe("books 0.2.0: 0 created, 1 adopted, 1 matched; 3 operations in one batch");
    const lines = renderPlan(p).split("\n");
    expect(lines[0]).toBe("Update books 0.2.0 (from 0.1.0): A reading list: books, who wrote them, and what you are reading now");
    expect(lines).toContain("  list_reading  reads");
    expect(lines).toContain("Token: ext-books, keep, writes work.books.book (no schema changes)");
  });

  it("a migration step whose effect is there is skipped", () => {
    const p = update(V2, { described: { "work.planning.person": PERSON, "work.books.book": bookTable((d) => d.columns.push({ ...FINISHED_ON, label: "Finished" })) } });
    expect(p.notes).toEqual(["migration 0.2.0: skips add_column finished_on: the column exists"]);
    expect(ops(p)).toEqual(["drop_constraint", "add_constraint"]);
  });

  it("a migration on a column with another definition conflicts", () => {
    const p = update(V2, { described: { "work.planning.person": PERSON, "work.books.book": bookTable((d) => d.columns.push({ ...FINISHED_ON, type: "string" })) } });
    expect(p.problems).toEqual([
      {
        code: "migration_conflict",
        table: "work.books.book",
        detail: "migration 0.2.0: add_column on work.books.book: column finished_on exists with another definition: is string, not date",
        hint: "Make the table match what the migration expects (describe_table shows it), or ask the extension's author.",
        docs: EXT_DOCS.update,
      },
    ]);
    expect(p.notes).toEqual(["book: column finished_on is string, not date: kept as it is"]);
    expect(p.record).toBeNull();
  });

  it("a downgrade is refused", () => {
    const installed = { ...installedV1(), version: "0.2.0", commit: "b".repeat(40) };
    const p = update(V1, { installed, oldManifest: V2, source: SOURCE_V1 });
    expect(p.action).toBe("update");
    expect(p.problems).toEqual([
      {
        code: "downgrade",
        detail: "0.1.0 is older than the installed 0.2.0",
        hint: "Undo the last update with datanotes extension rollback books; installing an older version is not supported.",
        docs: EXT_DOCS.rollback,
      },
    ]);
  });

  it("the same version from another commit", () => {
    const moved = { ...SOURCE_V1, commit: "c".repeat(40) };
    const tag = update(V1, { source: moved });
    expect(tag.action).toBe("update");
    expect(tag.problems).toEqual([
      {
        code: "same_version",
        detail: `0.1.0 is installed from commit ${"a".repeat(40)}; v0.1.0 now names commit ${"c".repeat(40)}`,
        hint: `A version tag that moved is a warning sign: check the repository. To install that commit anyway, pass its id: --to ${"c".repeat(40)}.`,
        docs: EXT_DOCS.update,
      },
    ]);
    const noRef = update(V1, { source: { ...moved, record: { kind: "git", url: "https://example.com/books.git" } } });
    expect(noRef.problems[0]!.detail).toBe(`0.1.0 is installed from commit ${"a".repeat(40)}; ${SOURCE_V1.label} now names commit ${"c".repeat(40)}`);
    const local = update(V1, { source: { ...moved, label: "C:/src/books", record: { kind: "local", path: "C:/src/books" }, commit: "local-0123456789ab" } });
    expect(local.problems).toEqual([]);
    expect(local.ready).toBe(true);
    const byCommit = update(V1, { source: { ...moved, record: { kind: "git", url: "https://example.com/books.git", ref: "c".repeat(40) } } });
    expect(byCommit.problems).toEqual([]);
  });

  it("repair finds nothing to do", () => {
    const installed = installedV1();
    const p = update(V1, { installed, source: SOURCE_V1, oldManifest: V1 });
    expect(p.action).toBe("repair");
    expect(p.extension.from_version).toBeNull();
    expect(p.operations).toEqual([]);
    expect(p.token.action).toBe("keep");
    expect(p.tools.map((t) => t.change)).toEqual(["same", "same"]);
    expect(p.summary).toBe("books 0.1.0: 0 created, 1 adopted, 1 matched; nothing to write");
    expect(p.record!.previous).toEqual(installed);
    expect(renderPlan(p).split("\n")[0]).toBe("Repair books 0.1.0: A reading list: books, who wrote them, and what you are reading now");
    expect(renderPlan(p).split("\n")).toContain("  list_reading  reads");
    expect(update(V1, { installed, source: SOURCE_V1, oldManifest: V1, localTokenPresent: false }).token.action).toBe("rotate");
    expect(update(V1, { installed, source: SOURCE_V1, oldManifest: V1, tokens: [] }).token.action).toBe("create");
    // a repair puts back a view that is gone
    const noView = update(V1, { installed, source: SOURCE_V1, oldManifest: V1, listing: { ...LISTING, views: [] } });
    expect(ops(noView)).toEqual(["create_view"]);
  });

  it("a repair given no old manifest plans as with the fetched one", () => {
    const installed = installedV1();
    const given = update(V1, { installed, source: SOURCE_V1, oldManifest: V1 });
    // the listing holds the view vw_reading: this used to throw a TypeError
    const none = update(V1, { installed, source: SOURCE_V1, oldManifest: null });
    expect(none.action).toBe("repair");
    expect(none).toEqual(given);
    expect(none.tools.map((t) => t.change)).toEqual(["same", "same"]);
  });

  it("the token's write patterns change with the tables a version writes", () => {
    const m = books("v0.2.0", (r) => (r.permissions.write = ["book", "person"]));
    const p = update(m);
    expect(p.token).toEqual({ name: "ext-books", action: "update", write: ["work.books.book", "work.planning.person"], previous_write: ["work.books.book"] });
  });

  it("a tool removed in the new version is listed as removed", () => {
    const m = books("v0.2.0", (r) => (r.tools = r.tools.filter((t: { name: string }) => t.name !== "list_reading")));
    const p = update(m);
    expect(p.tools).toEqual([
      { name: "finish_book", read_only: false, writes: ["work.books.book"], change: "same" },
      { name: "list_reading", read_only: true, writes: [], change: "removed" },
    ]);
    expect(renderPlan(p).split("\n")).toContain("  list_reading  reads  (removed)");
    expect(p.record!.tools).toEqual(["finish_book"]);
    // a removed tool that wrote shows the tables it wrote; a changed and an added tool
    const m2 = books("v0.2.0", (r) => {
      r.tools = [
        { ...r.tools[0], description: "List the books being read now, with their authors." },
        { ...r.tools[1], name: "rate_book" },
      ];
    });
    const p2 = update(m2);
    expect(p2.tools.map((t) => [t.name, t.change, t.writes])).toEqual([
      ["list_reading", "changed", []],
      ["rate_book", "added", ["work.books.book"]],
      ["finish_book", "removed", ["work.books.book"]],
    ]);
    const lines = renderPlan(p2).split("\n");
    expect(lines).toContain("  list_reading  reads  (changed)");
    expect(lines).toContain("  rate_book  writes work.books.book  (added)");
    expect(lines).toContain("  finish_book  writes work.books.book  (removed)");
  });

  it("a view removed in the new version is dropped", () => {
    const m = books("v0.2.0", (r) => delete r.views);
    const p = update(m);
    expect(p.operations.slice(-1)).toEqual([{ op: "drop_view", view: "work.books.vw_reading" }]);
    expect(p.tables[1]!.changes).toContain("drop view vw_reading");
    // a view that is gone already is not dropped again
    expect(ops(update(m, { listing: { ...LISTING, views: [] } }))).not.toContain("drop_view");
  });

  it("a changed view is replaced", () => {
    const m = books("v0.2.0", (r) => (r.views.vw_reading.query.order_by = ["title"]));
    const p = update(m);
    expect(p.operations.slice(-1)).toEqual([
      { op: "create_view", catalog: "work", schema: "books", name: "vw_reading", description: "Books being read now", query: { table: "work.books.book", where: { status: "reading" }, order_by: ["title"] }, replace: true },
    ]);
    expect(p.tables[1]!.changes).toContain("replace view vw_reading");
    // a view new in this version that exists already is replaced too
    const added = books("v0.2.0", (r) => (r.views.vw_read = { description: "Books read", query: { table: "@book", where: { status: "read" } } }));
    const p2 = update(added, { listing: { ...LISTING, views: [...LISTING.views, { qualified: "work.books.vw_read" }] } });
    expect(p2.operations.slice(-1)).toMatchObject([{ op: "create_view", name: "vw_read", replace: true }]);
  });

  it("a role no longer used is noted and kept", () => {
    const m = books("v0.2.0", (r) => {
      delete r.tables.person;
      r.tables.book.columns = r.tables.book.columns.filter((c: { name: string }) => c.name !== "author");
      r.tables.book.instructions = "How to add a book: its title as printed on the cover.\n";
      r.tools[0].tables = ["book"];
    });
    const p = update(m);
    expect(p.notes).toEqual(["person (work.planning.person) is no longer used by the extension: it stays in the database"]);
    expect(p.tables.map((t) => t.role)).toEqual(["book"]);
    expect(p.tables[0]!.changes).toEqual(["replace CHECK rating_only_when_read", "set instructions"]);
    expect(p.operations.slice(-1)).toEqual([{ op: "alter_table", table: "work.books.book", instructions: "How to add a book: its title as printed on the cover.\n" }]);
    expect(Object.keys(p.record!.tables)).toEqual(["book"]);
  });

  it("a migration on a role new in this version conflicts", () => {
    const m = books("v0.2.0", (r) => {
      r.tables.publisher = { owned: false, description: "A publisher of books", columns: [] };
      r.migrations[0].operations.push({ op: "add_column", table: "@publisher", column: { name: "city", type: "string", description: "Where it is" } });
    });
    const p = update(m);
    expect(p.tables[2]).toMatchObject({ role: "publisher", table: "work.public.publisher", decision: "create", proposed: true });
    expect(p.problems).toEqual([
      {
        code: "migration_conflict",
        role: "publisher",
        table: "work.public.publisher",
        detail: "migration 0.2.0: add_column on work.public.publisher: publisher is new in this version: a migration may only change the tables of the installed version",
        hint: "Make the table match what the migration expects (describe_table shows it), or ask the extension's author.",
        docs: EXT_DOCS.update,
      },
    ]);
    // a step on a role whose table is unresolved is left to that role's problem
    const lost = update(m, { listing: { ...LISTING, tables: LISTING.tables.filter((t) => t.qualified !== "work.books.book") } });
    expect(lost.problems.map((x) => x.code)).toEqual(["table_missing", "migration_conflict"]);
    expect(lost.problems[0]).toEqual({
      code: "table_missing",
      role: "book",
      table: "work.books.book",
      detail: "book: the table work.books.book the extension uses is gone",
      hint: "Restore it (restore_table), or remove the extension: datanotes extension remove books.",
      docs: EXT_DOCS.update,
    });
  });

  it("install of another version while one is installed", () => {
    const p = update(V2, { oldManifest: null });
    expect(p.action).toBe("install");
    expect(p.problems.map((x) => x.code)).toEqual(["already_installed", "view_exists", "token_exists"]);
    expect(p.problems[0]).toEqual({
      code: "already_installed",
      detail: "books 0.1.0 is installed",
      hint: "Update it instead: datanotes extension update books --to <ref> (or --from <source>).",
      docs: EXT_DOCS.update,
    });
    expect(p.extension.from_version).toBeNull();
  });
});

describe("planChanges: migrations on the model", () => {
  /** v0.2.0 with these migration steps instead of its own. */
  const withSteps = (operations: Record<string, unknown>[], edit?: (r: any) => void) =>
    books("v0.2.0", (r) => {
      r.migrations = [{ version: "0.2.0", description: "Steps", operations }];
      r.tables.book.columns = r.tables.book.columns.filter((c: { name: string }) => c.name !== "finished_on");
      edit?.(r);
    });
  const col = (name: string, type = "string") => ({ name, type, description: `The ${name}` });

  it("each step changes the model, is skipped when its effect is there, or conflicts", () => {
    const m = withSteps([
      { op: "create_table", name: "loan", description: "Loans", columns: [col("who")] },
      { op: "create_table", catalog: "work", schema: "books", name: "book", description: "Books", columns: [] },
      { op: "drop_table", table: "work.books.gone" },
      { op: "drop_table", table: "work.books.loan" },
      { op: "add_column", table: "work.books.gone", column: col("x") },
      { op: "drop_column", table: "work.books.gone", column: "x" },
      { op: "drop_column", table: "@book", column: "nope" },
      { op: "add_column", table: "@book", column: col("isbn") },
      { op: "rename_column", table: "@book", from_column: "isbn", to_column: "isbn13" },
      { op: "rename_column", table: "@book", from_column: "isbn", to_column: "isbn13" },
      { op: "rename_column", table: "@book", from_column: "nope", to_column: "nada" },
      { op: "rename_column", table: "@book", from_column: "isbn13", to_column: "title" },
      { op: "alter_column", table: "@book", column: "nope", changes: { label: "No" } },
      { op: "alter_column", table: "@book", column: "isbn13", changes: { name: "isbn_13", label: "ISBN" } },
      { op: "drop_column", table: "@book", column: "isbn_13" },
      { op: "add_constraint", table: "@book", name: "titled", check: { title: { exists: true } } },
      { op: "add_constraint", table: "@book", name: "titled", check: { title: { exists: true } } },
      { op: "add_constraint", table: "@book", name: "titled", check: { title: { exists: true } }, hint: "Give it a title." },
      { op: "drop_constraint", table: "@book", name: "nope" },
      { op: "drop_constraint", table: "work.books.gone", name: "titled" },
      { op: "drop_constraint", table: "@book", name: "titled" },
      { op: "alter_table", table: "@book", instructions: "Read me first.", tags: { colour: "red", extension: null } },
      { op: "alter_table", table: "@book", description: "Books on the shelf" },
      { op: "set_table_bases", table: "@book", bases: ["dated"] },
      { op: "define_base", name: "dated", columns: [col("date", "date")] },
      { op: "create_view", name: "vw_reading", query: { table: "@book" } },
      { op: "create_view", catalog: "work", schema: "books", name: "vw_all", query: { table: "@book" }, replace: true },
      { op: "drop_view", view: "work.books.vw_none" },
      { op: "drop_view", view: "work.books.vw_all" },
      { op: "update_rows", table: "@book", where: { status: "read" }, set: { rating: 5 } },
    ]);
    const p = update(m);
    expect(p.problems.map((x) => x.detail)).toEqual([
      "migration 0.2.0: add_column on work.books.gone: no such table",
      "migration 0.2.0: rename_column on work.books.book: no column nope",
      "migration 0.2.0: rename_column on work.books.book: both isbn13 and title exist",
      "migration 0.2.0: alter_column on work.books.book: no column nope",
      "migration 0.2.0: add_constraint on work.books.book: CHECK titled exists with another definition",
    ]);
    expect(p.notes).toEqual(["migration 0.2.0: skips create_table work.books.book: the table exists"]);
    expect(p.operations.slice(0, 15)).toEqual([
      { op: "create_table", catalog: "work", schema: "books", name: "loan", description: "Loans", columns: [col("who")] },
      { op: "drop_table", table: "work.books.loan" },
      { op: "add_column", table: "work.books.book", column: col("isbn") },
      { op: "rename_column", table: "work.books.book", from_column: "isbn", to_column: "isbn13" },
      { op: "alter_column", table: "work.books.book", column: "isbn13", changes: { name: "isbn_13", label: "ISBN" } },
      { op: "drop_column", table: "work.books.book", column: "isbn_13" },
      { op: "add_constraint", table: "work.books.book", name: "titled", check: { title: { exists: true } } },
      { op: "drop_constraint", table: "work.books.book", name: "titled" },
      { op: "alter_table", table: "work.books.book", instructions: "Read me first.", tags: { colour: "red", extension: null } },
      { op: "alter_table", table: "work.books.book", description: "Books on the shelf" },
      { op: "set_table_bases", table: "work.books.book", bases: ["dated"] },
      { op: "define_base", name: "dated", columns: [col("date", "date")] },
      { op: "create_view", catalog: "work", schema: "books", name: "vw_all", query: { table: "work.books.book" }, replace: true },
      { op: "drop_view", view: "work.books.vw_all" },
      { op: "update_rows", table: "work.books.book", where: { status: "read" }, set: { rating: 5 } },
    ]);
    // the reconcile reads the model the steps left: the base, the instructions and the tags come back
    expect(p.operations.slice(15)).toEqual([
      { op: "set_table_bases", table: "work.books.book", bases: ["dated", "shelved"] },
      { op: "drop_constraint", table: "work.books.book", name: "rating_only_when_read" },
      { op: "add_constraint", table: "work.books.book", name: "rating_only_when_read", check: CHECK, hint: HINT_V2 },
      {
        op: "alter_table",
        table: "work.books.book",
        instructions: "How to add a book:\n\n1. `title` as printed on the cover.\n2. `author`: a row of work.planning.person.\n",
        tags: { extension: "books", extension_role: "book" },
      },
    ]);
  });

  it("only the migrations after the installed version run", () => {
    const m = withSteps([{ op: "add_column", table: "@book", column: col("isbn") }], (r) => {
      r.migrations.unshift({ version: "0.1.0", description: "Old", operations: [{ op: "add_column", table: "@book", column: col("old") }] });
    });
    m.migrations.push({ version: "0.3.0", description: "Not yet", operations: [{ op: "add_column", table: "work.books.book", column: col("later") }] });
    expect(update(m).operations[0]).toEqual({ op: "add_column", table: "work.books.book", column: col("isbn") });
    expect(update(m).operations.filter((o) => o.op === "add_column")).toHaveLength(1);
  });

  it("a removed column of the extension's own table is added back", () => {
    const p = update(withSteps([{ op: "drop_column", table: "@book", column: "rating" }]));
    expect(ops(p)).toEqual(["drop_column", "add_column", "drop_constraint", "add_constraint"]);
  });
});

describe("planChanges: bases, CHECKs and tables on update", () => {
  it("a base the new version changes is defined again", () => {
    const m = books("v0.2.0", (r) => r.bases.shelved.columns.push({ name: "row", type: "integer", description: "The row on the shelf" }));
    const p = update(m);
    expect(p.operations[1]).toEqual({
      op: "define_base",
      name: "shelved",
      description: "Where a thing sits on a shelf",
      columns: [
        { name: "shelf", type: "string", description: "The shelf it sits on" },
        { name: "row", type: "integer", description: "The row on the shelf" },
      ],
    });
    expect(p.tables[1]!.changes[0]).toBe("define base shelved");
    // a base the user changed, where the extension did not: nothing
    const p2 = update(V2, { bases: [{ name: "shelved", columns: ["row"] }] });
    expect(ops(p2)).not.toContain("define_base");
    expect(p2.problems).toEqual([]);
    // a repair does not change a base either: it is a problem
    const p3 = update(V1, { source: SOURCE_V1, bases: [{ name: "shelved", columns: ["row"] }] });
    expect(p3.problems.map((x) => x.code)).toEqual(["base_differs"]);
  });

  it("a CHECK the new version drops is dropped", () => {
    const m = books("v0.2.0", (r) => delete r.tables.book.constraints);
    const p = update(m);
    expect(p.operations.slice(1)).toEqual([{ op: "drop_constraint", table: "work.books.book", name: "rating_only_when_read" }]);
    expect(p.tables[1]!.changes).toEqual(["drop CHECK rating_only_when_read"]);
    const gone = update(m, { described: { "work.planning.person": PERSON, "work.books.book": bookTable((d) => delete d.constraints) } });
    expect(ops(gone)).toEqual(["add_column"]);
  });

  it("an owned role new in this version adopts an existing table", () => {
    const m = books("v0.2.0", (r) => {
      r.tables.loan = { owned: true, description: "A book lent to someone", columns: [{ name: "who", type: "string", description: "Who has it" }] };
      r.permissions.write.push("loan");
    });
    const listing = { ...LISTING, tables: [...LISTING.tables, table("work.books.loan")] };
    const loan: DescribedTable = { qualified: "work.books.loan", columns: [{ name: "id", type: "string" }, { name: "who", type: "string" }] };
    const p = update(m, { listing, described: { "work.planning.person": PERSON, "work.books.book": bookTable(), "work.books.loan": loan } });
    expect(p.tables[2]).toMatchObject({ role: "loan", decision: "adopt", proposed: true, changes: ["add tags"] });
    expect(p.operations.slice(-1)).toEqual([{ op: "alter_table", table: "work.books.loan", tags: { extension: "books", extension_role: "loan" } }]);
    expect(p.token.action).toBe("update");
  });

  it("a mapped column of a dependency stays mapped", () => {
    const installed = installedV1();
    installed.tables.person = { table: "work.planning.person", owned: false, columns: { name: "full_name" } };
    const person: DescribedTable = { qualified: "work.planning.person", columns: [{ name: "id", type: "string" }, { name: "full_name", type: "string" }] };
    const p = update(V2, { installed, described: { "work.planning.person": person, "work.books.book": bookTable() } });
    expect(p.problems).toEqual([]);
    expect(p.record!.tables.person).toEqual({ table: "work.planning.person", owned: false, columns: { name: "full_name" } });
  });
});
