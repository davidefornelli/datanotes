import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXT_DOCS, EXTENSION_NAME, validateManifest } from "../src/api/extension-manifest";
import type { ExtensionManifest } from "../src/api/extension-manifest";
import {
  AGENT_MESSAGE,
  chooseTables,
  columnDifference,
  MAX_OPERATIONS,
  planChanges,
  renderPlan,
  type DescribedTable,
  type InstallChoices,
  type PlanInput,
  type TablesListing,
} from "../src/api/extension-plan";
import { RECORD_NAME, type InstalledExtension } from "../src/api/extension-record";

const FIXTURE = path.join(__dirname, "fixtures", "extensions", "books");
const NOW = "2026-10-19T08:00:00.000Z";

/** The books manifest of a version, as JSON, changed by `edit` before validation. */
function books(version = "v0.1.0", edit?: (m: any) => void): ExtensionManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE, version, "datanotes-extension.json"), "utf8"));
  edit?.(raw);
  return validateManifest(raw);
}

const LISTING: TablesListing = {
  default_catalog: "work",
  tables: [
    { qualified: "work.planning.person", name: "person", catalog: "work", schema: "planning", aliases: ["people", "team"] },
    { qualified: "work.planning.project", name: "project", catalog: "work", schema: "planning", aliases: ["projects", "areas"] },
    { qualified: "work.planning.task", name: "task", catalog: "work", schema: "planning" },
  ],
  views: [],
};

const PERSON: DescribedTable = {
  qualified: "work.planning.person",
  columns: [
    { name: "id", type: "string" },
    { name: "name", type: "string", required: true, description: "Full name" },
    { name: "email", type: "string", description: "Email address" },
    { name: "role", type: "enum", values: ["member", "lead"], description: "Role on the team" },
  ],
};

const SOURCE: PlanInput["source"] = {
  label: "https://example.com/books.git#v0.1.0",
  record: { kind: "git", url: "https://example.com/books.git", ref: "v0.1.0" },
  commit: "a".repeat(40),
  manifest_sha256: "1".repeat(64),
  entry_sha256: "2".repeat(64),
};

type Overrides = Partial<Omit<PlanInput, "choices">> & { choices?: Partial<InstallChoices> };

/** A PlanInput on the test-vault shape, with chooseTables run on its listing and choices. */
function inputFor(manifest: ExtensionManifest, o: Overrides = {}): PlanInput {
  const { choices: given, ...rest } = o;
  const choices: InstallChoices = { map: {}, columns: {}, create: [], add: {}, ...given };
  const listing = o.listing ?? LISTING;
  const installed = o.installed ?? null;
  const { chosen, problems } = chooseTables(manifest, listing, choices, installed);
  return {
    manifest,
    source: SOURCE,
    engineVersion: "3.3.0",
    described: { "work.planning.person": PERSON },
    bases: [{ name: "dated", columns: ["date"] }],
    tokens: [],
    oldManifest: null,
    others: [],
    reservedTools: ["select_rows", "insert_row", "read_docs"],
    localTokenPresent: false,
    now: NOW,
    ...rest,
    listing,
    installed,
    choices,
    chosen,
    choiceProblems: problems,
  };
}

const plan = (m: ExtensionManifest, o: Overrides = {}) => planChanges(inputFor(m, o));
const listingWith = (...extra: TablesListing["tables"]): TablesListing => ({ ...LISTING, tables: [...LISTING.tables, ...extra] });
const table = (qualified: string, aliases?: string[]) => {
  const [catalog, schema, name] = qualified.split(".") as [string, string, string];
  return { qualified, name, catalog, schema, ...(aliases ? { aliases } : {}) };
};
const ops = (p: { operations: Record<string, unknown>[] }) => p.operations.map((o) => o.op);

const BOOK_INSTRUCTIONS = "How to add a book:\n\n1. `title` as printed on the cover.\n2. `author`: a row of work.planning.person.\n";
const CHECK = { or: [{ status: "read" }, { rating: { exists: false } }] };
const HINT_V1 = "Rate a book only once it is read: set status read, or remove rating.";

/** The book table as an earlier install left it (adoption cases change it). */
function bookTable(edit?: (d: DescribedTable) => void): DescribedTable {
  const d: DescribedTable = {
    qualified: "work.books.book",
    columns: [
      { name: "id", type: "string" },
      { name: "title", type: "string", required: true, description: "Title" },
      { name: "author", type: "link", ref: "work.planning.person", description: "Author" },
      { name: "status", type: "enum", values: ["to_read", "reading", "read", "abandoned"], description: "Status" },
    ],
    bases: [],
  };
  edit?.(d);
  return d;
}
const BOOK_LISTING = listingWith(table("work.books.book"));
const shelved = [{ name: "dated", columns: ["date"] }, { name: "shelved", columns: ["shelf"] }];

describe("chooseTables and planChanges: a fresh install", () => {
  it("a fresh install matches the person table and creates the book table", () => {
    const p = plan(books());
    expect(p.action).toBe("install");
    expect(p.tables.map((t) => [t.role, t.table, t.decision, t.proposed])).toEqual([
      ["person", "work.planning.person", "match", true],
      ["book", "work.books.book", "create", false],
    ]);
    expect(p.tables[0]!.candidates).toEqual(["work.planning.person"]);
    expect(p.tables[1]!.changes).toEqual(["create", "define base shelved", "create view vw_reading"]);
    expect(p.operations).toEqual([
      { op: "define_base", name: "shelved", description: "Where a thing sits on a shelf", columns: [{ name: "shelf", type: "string", description: "The shelf it sits on" }] },
      {
        op: "create_table",
        catalog: "work",
        schema: "books",
        name: "book",
        description: "A book on the reading list",
        columns: [
          { name: "title", type: "string", required: true, description: "The book's title, as printed on the cover" },
          { name: "author", type: "link", ref: "work.planning.person", description: "Who wrote it" },
          { name: "status", type: "enum", values: ["to_read", "reading", "read"], default: "to_read", description: "Where the reader is with it" },
          { name: "rating", type: "integer", min: 1, max: 5, description: "From 1 to 5, once read" },
        ],
        filename: "{title}",
        instructions: BOOK_INSTRUCTIONS,
        tags: { extension: "books", extension_role: "book" },
      },
      { op: "set_table_bases", table: "work.books.book", bases: ["shelved"] },
      { op: "add_constraint", table: "work.books.book", name: "rating_only_when_read", check: CHECK, hint: HINT_V1 },
      { op: "create_view", catalog: "work", schema: "books", name: "vw_reading", description: "Books being read now", query: { table: "work.books.book", where: { status: "reading" } } },
    ]);
    expect(p.token).toEqual({ name: "ext-books", action: "create", write: ["work.books.book"], previous_write: null });
    expect(p.tools).toEqual([
      { name: "list_reading", read_only: true, writes: [], change: "added" },
      { name: "finish_book", read_only: false, writes: ["work.books.book"], change: "added" },
    ]);
    expect(p.problems).toEqual([]);
    expect(p.notes).toEqual([]);
    expect(p.ready).toBe(true);
    expect(p.agent_message).toBe(AGENT_MESSAGE);
    expect(p.extension).toEqual({ name: "books", version: "0.1.0", description: "A reading list: books, who wrote them, and what you are reading now", from_version: null, source: SOURCE.label, commit: SOURCE.commit });
    expect(p.record).toEqual({
      name: "books",
      version: "0.1.0",
      description: "A reading list: books, who wrote them, and what you are reading now",
      api: 1,
      source: SOURCE.record,
      commit: SOURCE.commit,
      manifest_sha256: SOURCE.manifest_sha256,
      entry_sha256: SOURCE.entry_sha256,
      token: "ext-books",
      tables: { person: { table: "work.planning.person", owned: false }, book: { table: "work.books.book", owned: true } },
      tools: ["list_reading", "finish_book"],
      write: ["work.books.book"],
      migration_id: null,
      installed_at: NOW,
      updated_at: NOW,
      previous: null,
    });
    expect(p.summary).toBe("books 0.1.0: 1 created, 0 adopted, 1 matched; 5 operations in one batch");
  });

  it("--catalog and --schema place the created tables and views", () => {
    const p = plan(books(), { choices: { catalog: "home", schema: "reading" } });
    expect(p.tables[1]!.table).toBe("home.reading.book");
    expect(p.operations[1]).toMatchObject({ op: "create_table", catalog: "home", schema: "reading", name: "book" });
    expect(p.operations[4]).toMatchObject({ op: "create_view", catalog: "home", schema: "reading", query: { table: "home.reading.book" } });
  });

  it("a manifest without table names uses the roles, and passes aliases and labels on", () => {
    const m = books("v0.1.0", (r) => {
      delete r.tables.person.name;
      delete r.tables.person.names;
      delete r.tables.person.filename;
      r.tables.person.aliases = ["writer"];
      delete r.tables.book.name;
      delete r.tables.book.filename;
      r.tables.book.aliases = ["books"];
      r.views.vw_reading.aliases = ["reading"];
      r.views.vw_reading.labels = { title: "Title" };
    });
    const p = plan(m, { listing: { ...LISTING, tables: LISTING.tables.slice(1) } });
    expect(p.tables.map((t) => [t.role, t.table, t.decision])).toEqual([
      ["person", "work.public.person", "create"],
      ["book", "work.books.book", "create"],
    ]);
    expect(p.operations[1]).toEqual({ op: "create_table", catalog: "work", schema: "public", name: "person", description: "A person: here, the author of a book", columns: [{ name: "name", type: "string", required: true, description: "The person's full name" }], aliases: ["writer"] });
    expect(p.operations[2]).toMatchObject({ op: "create_table", name: "book", aliases: ["books"] });
    expect(p.operations[2]).not.toHaveProperty("filename");
    expect(p.operations[5]).toMatchObject({ op: "create_view", aliases: ["reading"], labels: { title: "Title" } });
    // a role without names matches a table named like the role
    const matched = plan(m);
    expect(matched.tables[0]).toMatchObject({ table: "work.planning.person", decision: "match", proposed: true });
  });

  it("an owned table without bases, CHECKs or instructions, and a dependency without a schema", () => {
    const m = books("v0.1.0", (r) => {
      delete r.tables.person.schema;
      delete r.tables.book.bases;
      delete r.tables.book.constraints;
      delete r.tables.book.instructions;
    });
    const p = plan(m, { choices: { create: ["person"] } });
    expect(p.tables[0]).toMatchObject({ table: "work.public.person", decision: "create", proposed: false });
    expect(ops(p)).toEqual(["define_base", "create_table", "create_table", "create_view"]);
    expect(p.operations[2]).not.toHaveProperty("instructions");
    expect(p.tables[1]!.changes).toEqual(["create", "create view vw_reading"]);
  });

  it("a missing column is described with its type and link", () => {
    const m = books("v0.1.0", (r) => {
      r.tables.person.columns.push(
        { name: "skills", type: "list", items: "string", description: "What the person knows" },
        { name: "manager", type: "link", ref: "self", description: "Who the person reports to" },
        { name: "mentors", type: "list", items: "link", ref: "self", description: "Who helps the person" },
      );
    });
    const p = plan(m);
    expect(p.problems.map((x) => x.detail)).toEqual([
      "person: work.planning.person has no column skills (list of string)",
      "person: work.planning.person has no column manager (link → work.planning.person)",
      "person: work.planning.person has no column mentors (list of link → work.planning.person)",
    ]);
    const other = books("v0.1.0", (r) => {
      r.tables.book.owned = false;
      delete r.tables.book.constraints;
      delete r.tables.book.instructions;
      delete r.tables.book.bases;
      r.permissions.write = [];
      r.tools = [];
      delete r.views;
    });
    const q = plan(other, { listing: listingWith(table("work.books.book")), described: { "work.planning.person": PERSON, "work.books.book": { qualified: "work.books.book", columns: [] } } });
    expect(q.problems.map((x) => x.detail)).toContain("book: work.books.book has no column author (link → work.planning.person)");
  });

  it("--map picks the table and it is not proposed", () => {
    const listing = listingWith(table("work.crm.contact"));
    const p = plan(books(), { listing, choices: { map: { person: "work.crm.contact" } }, described: { "work.crm.contact": { ...PERSON, qualified: "work.crm.contact" } } });
    expect(p.tables[0]).toMatchObject({ role: "person", table: "work.crm.contact", decision: "match", proposed: false, candidates: [] });
    expect(p.operations[1]).toMatchObject({ columns: expect.arrayContaining([expect.objectContaining({ name: "author", ref: "work.crm.contact" })]) });
    expect(p.ready).toBe(true);
    // an owned role mapped to an existing table is adopted, not proposed
    const adopted = plan(books(), { listing: listingWith(table("work.library.book")), choices: { map: { book: "work.library.book" } }, described: { "work.planning.person": PERSON, "work.library.book": { ...bookTable(), qualified: "work.library.book" } } });
    expect(adopted.tables[1]).toMatchObject({ table: "work.library.book", decision: "adopt", proposed: false });
  });

  it("--map to a missing table", () => {
    const p = plan(books(), { choices: { map: { person: "work.planning.persn" } } });
    expect(p.tables[0]).toMatchObject({ table: null, decision: "unresolved" });
    expect(p.problems).toEqual([
      {
        code: "table_not_found",
        role: "person",
        table: "work.planning.persn",
        detail: "person: no table work.planning.persn",
        hint: 'Pass a qualified name (catalog.schema.table): list_tables lists them. Did you mean "work.planning.person"?',
        docs: EXT_DOCS.tables,
      },
    ]);
    expect(p.ready).toBe(false);
    expect(p.record).toBeNull();
    // the book table still names the unresolved role, as @person
    expect(p.operations[1]).toMatchObject({ columns: expect.arrayContaining([expect.objectContaining({ name: "author", ref: "@person" })]) });
    const far = plan(books(), { choices: { map: { person: "elsewhere.x.y" } } });
    expect(far.problems[0]!.hint).toBe("Pass a qualified name (catalog.schema.table): list_tables lists them.");
  });

  it("several candidates are ambiguous", () => {
    const p = plan(books(), { listing: listingWith(table("work.other.people")) });
    expect(p.tables[0]).toMatchObject({ table: null, decision: "unresolved", candidates: ["work.other.people", "work.planning.person"] });
    expect(p.problems).toEqual([
      {
        code: "ambiguous_dependency",
        role: "person",
        detail: "person: 2 tables could be it: work.other.people, work.planning.person",
        hint: "Ask the user which one, then pass --map person=<table>, or --create person for a new table.",
        docs: EXT_DOCS.tables,
      },
    ]);
    expect(p.ready).toBe(false);
    expect(p.record).toBeNull();
    expect(p.summary).toBe("books 0.1.0: 1 problem: nothing written");
  });

  it("a candidate is found by an alias, in any case", () => {
    const listing: TablesListing = { ...LISTING, tables: [table("work.crm.contact", ["Author"]), ...LISTING.tables.slice(1)] };
    const p = plan(books(), { listing, described: { "work.crm.contact": { ...PERSON, qualified: "work.crm.contact" } } });
    expect(p.tables[0]).toMatchObject({ table: "work.crm.contact", decision: "match", proposed: true });
  });

  it("no candidate proposes a create", () => {
    const p = plan(books(), { listing: { ...LISTING, tables: LISTING.tables.slice(1) } });
    expect(p.tables[0]).toMatchObject({ table: "work.public.person", decision: "create", proposed: true, changes: ["create"] });
    expect(p.operations[1]).toEqual({
      op: "create_table",
      catalog: "work",
      schema: "public",
      name: "person",
      description: "A person: here, the author of a book",
      columns: [{ name: "name", type: "string", required: true, description: "The person's full name" }],
      filename: "{name}",
    });
    expect(p.operations[2]).toMatchObject({ columns: expect.arrayContaining([expect.objectContaining({ name: "author", ref: "work.public.person" })]) });
    expect(p.summary).toBe("books 0.1.0: 2 created, 0 adopted, 0 matched; 6 operations in one batch");
  });

  it("--create makes a dependency table", () => {
    const p = plan(books(), { choices: { create: ["person"] } });
    expect(p.tables[0]).toMatchObject({ table: "work.public.person", decision: "create", proposed: false });
  });

  it("--create of an existing name", () => {
    const listing = listingWith(table("work.public.person"));
    const p = plan(books(), { listing, choices: { create: ["person"] } });
    expect(p.problems).toEqual([
      {
        code: "table_exists",
        role: "person",
        table: "work.public.person",
        detail: "person: work.public.person exists already",
        hint: "Use it with --map person=work.public.person, or create the table in another catalog with --catalog.",
        docs: EXT_DOCS.tables,
      },
    ]);
  });

  it("--create of an owned role", () => {
    const p = plan(books(), { choices: { create: ["book"] } });
    expect(p.tables[1]).toMatchObject({ decision: "unresolved", table: null });
    expect(p.problems).toEqual([
      {
        code: "owned_create",
        role: "book",
        detail: "book: the extension creates or adopts its own tables; --create is for the tables it depends on",
        hint: "Leave book out of --create; --map book=<table> adopts an existing table.",
        docs: EXT_DOCS.tables,
      },
    ]);
    // nothing is planned for the unresolved role
    expect(ops(p)).toEqual(["define_base", "create_view"]);
  });

  it("an unknown role in an option", () => {
    const p = plan(books(), { choices: { add: { persn: ["name"] }, create: ["shelf"], map: { journal: "work.planning.task" }, columns: { nobody: { name: "x" } } } });
    expect(p.problems.map((x) => [x.code, x.role, x.detail, x.hint])).toEqual([
      ["unknown_role", "journal", '--map names the role "journal", which the extension does not have', "The roles are person, book."],
      ["unknown_role", "nobody", '--map names the role "nobody", which the extension does not have', "The roles are person, book."],
      ["unknown_role", "shelf", '--create names the role "shelf", which the extension does not have', "The roles are person, book."],
      ["unknown_role", "persn", '--add names the role "persn", which the extension does not have', 'The roles are person, book. Did you mean "person"?'],
    ]);
    expect(p.problems[0]!.docs).toBe(EXT_DOCS.tables);
  });

  it("an option that maps or adds a column of an owned table", () => {
    const p = plan(books(), { choices: { columns: { book: { title: "name" } }, add: { book: ["rating", "status"] } } });
    expect(p.problems).toEqual([
      { code: "owned_column_map", role: "book", column: "title", detail: "book: the columns of the extension's own table keep the extension's names", hint: "Leave --map book.title and --add book.title out.", docs: EXT_DOCS.tables },
      { code: "owned_column_map", role: "book", column: "rating", detail: "book: the columns of the extension's own table keep the extension's names", hint: "Leave --map book.rating and --add book.rating out.", docs: EXT_DOCS.tables },
      { code: "owned_column_map", role: "book", column: "status", detail: "book: the columns of the extension's own table keep the extension's names", hint: "Leave --map book.status and --add book.status out.", docs: EXT_DOCS.tables },
    ]);
  });
});

describe("planChanges: the columns of a dependency", () => {
  const noName: DescribedTable = { qualified: "work.planning.person", columns: PERSON.columns.filter((c) => c.name !== "name") };

  it("a missing required column", () => {
    const p = plan(books(), { described: { "work.planning.person": noName } });
    expect(p.problems).toEqual([
      {
        code: "missing_column",
        role: "person",
        table: "work.planning.person",
        column: "name",
        detail: "person: work.planning.person has no column name (string)",
        hint: "Map the column that holds it (--map person.name=<column>), or add it (--add person.name) once the user agrees.",
        docs: EXT_DOCS.tables,
      },
    ]);
  });

  it("--map person.name=email maps the column", () => {
    const p = plan(books(), { described: { "work.planning.person": noName }, choices: { columns: { person: { name: "email" } } } });
    expect(p.problems).toEqual([]);
    expect(p.tables[0]!.columns).toEqual({ name: "email" });
    expect(p.record!.tables.person).toEqual({ table: "work.planning.person", owned: false, columns: { name: "email" } });
  });

  it("--add person.name adds the column, under its mapped name too", () => {
    const p = plan(books(), { described: { "work.planning.person": noName }, choices: { add: { person: ["name"] } } });
    expect(p.problems).toEqual([]);
    expect(p.operations[1]).toEqual({ op: "add_column", table: "work.planning.person", column: { name: "name", type: "string", required: true, description: "The person's full name" } });
    expect(p.tables[0]!.changes).toEqual(["add column name"]);
    const mapped = plan(books(), { described: { "work.planning.person": noName }, choices: { add: { person: ["name"] }, columns: { person: { name: "full_name" } } } });
    expect(mapped.operations[1]).toEqual({ op: "add_column", table: "work.planning.person", column: { name: "full_name", type: "string", required: true, description: "The person's full name" } });
    expect(mapped.record!.tables.person!.columns).toEqual({ name: "full_name" });
  });

  describe("a mapped column is read under the user's name", () => {
    /** The user's person table: `full_name` holds the name. */
    const fullName: DescribedTable = { qualified: "work.planning.person", columns: [...noName.columns, { name: "full_name", type: "string", required: true, description: "Full name" }] };
    const mapped = (m: ExtensionManifest) => plan(m, { described: { "work.planning.person": fullName }, choices: { columns: { person: { name: "full_name" } } } });
    const viewOf = (p: ReturnType<typeof plan>) => p.operations.find((o) => o.op === "create_view") as { query: Record<string, unknown> };

    it("in a view: where, columns, order_by, group_by and aggregates follow the link to the dependency", () => {
      const m = books("v0.1.0", (r) => {
        r.views.vw_reading.query = {
          table: "@book",
          where: { status: "reading", or: [{ "author.name": { icontains: "a" } }, { title: "x" }] },
          columns: ["title", "author.name"],
          order_by: ["-author.name", "title"],
          group_by: "author.name",
          aggregates: { n: "count", first: "min:author.name" },
        };
      });
      const p = mapped(m);
      expect(p.problems).toEqual([]);
      expect(viewOf(p).query).toEqual({
        table: "work.books.book",
        where: { status: "reading", or: [{ "author.full_name": { icontains: "a" } }, { title: "x" }] },
        columns: ["title", "author.full_name"],
        order_by: ["-author.full_name", "title"],
        group_by: "author.full_name",
        aggregates: { n: "count", first: "min:author.full_name" },
      });
    });

    it("in a view on the dependency itself, and in a join on it", () => {
      const m = books("v0.1.0", (r) => {
        r.views.vw_reading.query = {
          table: "@person",
          columns: ["name"],
          where: { name: { exists: true } },
          join: { table: "@book", on: { path: "author" }, as: "books", columns: ["title"], where: { status: "reading" } },
        };
      });
      expect(viewOf(mapped(m)).query).toEqual({
        table: "work.planning.person",
        columns: ["full_name"],
        where: { full_name: { exists: true } },
        join: { table: "work.books.book", on: { path: "author" }, as: "books", columns: ["title"], where: { status: "reading" } },
      });
    });

    it("in a CHECK and in a link filter of the extension's own table", () => {
      const m = books("v0.1.0", (r) => {
        r.tables.book.constraints.push({ name: "author_named", check: { "author.name": { exists: true } }, hint: "Pick an author with a name." });
        r.tables.book.columns[1].ref_where = { name: { exists: true } };
      });
      const p = mapped(m);
      expect(p.problems).toEqual([]);
      const create = p.operations.find((o) => o.op === "create_table") as { columns: { name: string; ref_where?: unknown }[] };
      expect(create.columns.find((c) => c.name === "author")!.ref_where).toEqual({ full_name: { exists: true } });
      expect(p.operations).toContainEqual({ op: "add_constraint", table: "work.books.book", name: "author_named", check: { "author.full_name": { exists: true } }, hint: "Pick an author with a name." });
    });

    it("where the installer cannot rewrite it, it refuses with a hint", () => {
      const m = books("v0.1.0", (r) => {
        r.views.vw_reading.query = { union: [{ table: "@book", columns: ["title", "author.name"] }], order_by: "author.name" };
      });
      const p = mapped(m);
      expect(p.ready).toBe(false);
      expect(p.problems).toEqual([
        {
          code: "column_map_unsupported",
          role: "person",
          column: "name",
          detail: "person: view vw_reading (union order_by) names column name, which reads your column full_name: the installer cannot rewrite it there",
          hint: "Rename your column to name with rename_column and leave --map person.name out, or ask the extension's author.",
          docs: EXT_DOCS.tables,
        },
      ]);
    });

    it("without a mapping, the view is the manifest's", () => {
      const p = plan(books());
      expect(viewOf(p).query).toEqual({ table: "work.books.book", where: { status: "reading" } });
    });
  });

  it("a table the CLI did not describe has no columns", () => {
    const p = plan(books(), { described: {} });
    expect(p.problems.map((x) => x.code)).toEqual(["missing_column"]);
  });

  it("a required dependency column that differs is refused", () => {
    const p = plan(books(), { described: { "work.planning.person": { ...PERSON, columns: [{ name: "name", type: "integer" }] } } });
    expect(p.problems).toEqual([
      {
        code: "column_differs",
        role: "person",
        table: "work.planning.person",
        column: "name",
        detail: "person: column name of work.planning.person is integer, not string",
        hint: "Map another column (--map person.name=<column>), or another table (--map person=<table>).",
        docs: EXT_DOCS.tables,
      },
    ]);
  });

  it("an optional dependency column that differs is noted, not refused", () => {
    const m = books("v0.1.0", (r) => {
      r.tables.person.columns[0].need = "optional";
    });
    const p = plan(m, { described: { "work.planning.person": { ...PERSON, columns: [{ name: "name", type: "integer" }] } } });
    expect(p.problems).toEqual([]);
    expect(p.notes).toEqual(["person: column name is integer, not string: the extension reads it as it is"]);
    // and an optional column that is missing is recorded as absent
    const gone = plan(m, { described: { "work.planning.person": noName } });
    expect(gone.problems).toEqual([]);
    expect(gone.notes).toEqual(["person: work.planning.person has no column name: the extension works without it"]);
    expect(gone.tables[0]!.absent).toEqual(["name"]);
    expect(gone.record!.tables.person).toEqual({ table: "work.planning.person", owned: false, absent: ["name"] });
  });
});

describe("planChanges: adopting an existing table", () => {
  it("adopt an existing book table and add what is missing", () => {
    const p = plan(books(), { listing: BOOK_LISTING, described: { "work.planning.person": PERSON, "work.books.book": bookTable() }, bases: shelved });
    expect(p.tables[1]).toMatchObject({ table: "work.books.book", decision: "adopt", proposed: true });
    expect(p.problems).toEqual([]);
    expect(p.operations).toEqual([
      { op: "add_column", table: "work.books.book", column: { name: "rating", type: "integer", min: 1, max: 5, description: "From 1 to 5, once read" } },
      { op: "set_table_bases", table: "work.books.book", bases: ["shelved"] },
      { op: "add_constraint", table: "work.books.book", name: "rating_only_when_read", check: CHECK, hint: HINT_V1 },
      { op: "alter_table", table: "work.books.book", instructions: BOOK_INSTRUCTIONS, tags: { extension: "books", extension_role: "book" } },
      { op: "create_view", catalog: "work", schema: "books", name: "vw_reading", description: "Books being read now", query: { table: "work.books.book", where: { status: "reading" } } },
    ]);
    expect(p.tables[1]!.changes).toEqual(["add column rating", "add base shelved", "add CHECK rating_only_when_read", "set instructions", "add tags", "create view vw_reading"]);
    expect(p.summary).toBe("books 0.1.0: 0 created, 1 adopted, 1 matched; 5 operations in one batch");
  });

  it("an adopted table that has everything needs nothing", () => {
    const full = bookTable((d) => {
      d.columns.push({ name: "rating", type: "integer" });
      d.constraints = { rating_only_when_read: CHECK };
      d.constraint_hints = { rating_only_when_read: HINT_V1 };
      d.instructions = BOOK_INSTRUCTIONS.trimEnd();
      d.bases = ["shelved"];
      d.tags = { extension: "books", extension_role: "book", owner: "Nora Blake" };
    });
    const listing = { ...BOOK_LISTING, views: [{ qualified: "work.books.vw_other" }] };
    const p = plan(books("v0.1.0", (r) => delete r.views), { listing, described: { "work.planning.person": PERSON, "work.books.book": full }, bases: shelved });
    expect(p.operations).toEqual([]);
    expect(p.tables[1]!.changes).toEqual([]);
    expect(p.summary).toBe("books 0.1.0: 0 created, 1 adopted, 1 matched; nothing to write");
    // only the tags differ: one alter_table with the tags
    const untagged = plan(books(), { listing, described: { "work.planning.person": PERSON, "work.books.book": { ...full, tags: { extension: "books", extension_role: "shelf" } } }, bases: shelved });
    expect(untagged.operations.filter((o) => o.op === "alter_table")).toEqual([{ op: "alter_table", table: "work.books.book", tags: { extension: "books", extension_role: "book" } }]);
  });

  it("adopt with a CHECK that differs replaces it; an equal one is kept", () => {
    const m = books("v0.1.0", (r) => {
      r.tables.book.constraints.push({ name: "title_set", check: { title: { exists: true } }, hint: "Give the book its title." });
    });
    const described = bookTable((d) => {
      d.columns.push({ name: "rating", type: "integer" });
      d.constraints = { rating_only_when_read: { status: "read" }, title_set: { title: { exists: true } } };
      d.constraint_hints = { rating_only_when_read: HINT_V1, title_set: "Give the book its title." };
      d.bases = ["shelved"];
    });
    const p = plan(m, { listing: BOOK_LISTING, described: { "work.planning.person": PERSON, "work.books.book": described }, bases: shelved });
    expect(ops(p)).toEqual(["drop_constraint", "add_constraint", "alter_table", "create_view"]);
    expect(p.operations[0]).toEqual({ op: "drop_constraint", table: "work.books.book", name: "rating_only_when_read" });
    expect(p.operations[1]).toEqual({ op: "add_constraint", table: "work.books.book", name: "rating_only_when_read", check: CHECK, hint: HINT_V1 });
    expect(p.tables[1]!.changes).toContain("replace CHECK rating_only_when_read");
    expect(p.tables[1]!.changes).not.toContain("replace CHECK title_set");
  });

  it("adopt refuses a column whose type differs", () => {
    const described = bookTable((d) => {
      d.columns[3] = { name: "status", type: "string" };
    });
    const p = plan(books(), { listing: BOOK_LISTING, described: { "work.planning.person": PERSON, "work.books.book": described }, bases: shelved });
    expect(p.problems).toEqual([
      {
        code: "column_differs",
        role: "book",
        table: "work.books.book",
        column: "status",
        detail: "book: column status of work.books.book is string, not enum",
        hint: "Change the column with alter_column, or install on another table: --map book=<table>.",
        docs: EXT_DOCS.tables,
      },
    ]);
  });

  it("a link to another table differs", () => {
    const described = bookTable((d) => {
      d.columns[2] = { name: "author", type: "link", ref: "work.planning.project" };
    });
    const p = plan(books(), { listing: BOOK_LISTING, described: { "work.planning.person": PERSON, "work.books.book": described }, bases: shelved });
    expect(p.problems.map((x) => x.detail)).toEqual(["book: column author of work.books.book links to work.planning.project, not work.planning.person"]);
  });

  it("an optional column of an adopted table that differs is kept, with a note", () => {
    const described = bookTable((d) => {
      d.columns.push({ name: "rating", type: "string" });
    });
    const p = plan(books(), { listing: BOOK_LISTING, described: { "work.planning.person": PERSON, "work.books.book": described }, bases: shelved });
    expect(p.problems).toEqual([]);
    expect(p.notes).toEqual(["book: column rating is string, not integer: kept as it is"]);
    expect(ops(p)).not.toContain("add_column");
  });

  it("adoption keeps an optional column the table has, and adds it when missing (modified_at)", () => {
    const m = books("v0.1.0", (r) => {
      r.tables.book.columns.push({ name: "modified_at", type: "string", need: "optional", description: "When the book last changed" });
    });
    const has = bookTable((d) => {
      d.columns.push({ name: "rating", type: "integer" }, { name: "modified_at", type: "string", description: "Last change" });
    });
    const kept = plan(m, { listing: BOOK_LISTING, described: { "work.planning.person": PERSON, "work.books.book": has }, bases: shelved });
    expect(kept.notes).toEqual([]);
    expect(ops(kept)).not.toContain("add_column");
    const lacks = plan(m, { listing: BOOK_LISTING, described: { "work.planning.person": PERSON, "work.books.book": bookTable() }, bases: shelved });
    expect(lacks.operations.filter((o) => o.op === "add_column").map((o) => (o.column as { name: string }).name)).toEqual(["rating", "modified_at"]);
    expect(lacks.operations[1]).toEqual({ op: "add_column", table: "work.books.book", column: { name: "modified_at", type: "string", description: "When the book last changed" } });
  });
});

describe("planChanges: other problems at install", () => {
  it("an existing view at install", () => {
    const p = plan(books(), { listing: { ...LISTING, views: [{ qualified: "work.books.vw_reading" }] } });
    expect(p.problems).toEqual([
      { code: "view_exists", table: "work.books.vw_reading", detail: "work.books.vw_reading exists already", hint: "Drop or rename that view (drop_view), or install with --schema <another schema>.", docs: EXT_DOCS.install },
    ]);
    expect(ops(p)).not.toContain("create_view");
  });

  it("a base that lacks columns", () => {
    const p = plan(books(), { bases: [{ name: "shelved", columns: ["row"] }] });
    expect(p.problems).toEqual([
      { code: "base_differs", detail: "base shelved exists without the columns shelf", hint: "Rename your base, or add those columns to it with define_base, then run the command again.", docs: EXT_DOCS.install },
    ]);
    expect(ops(p)).not.toContain("define_base");
  });

  it("a tool named like a tool of the MCP server", () => {
    const m = books("v0.1.0", (r) => {
      r.tools[0].name = "select_rows";
    });
    const p = plan(m);
    expect(p.problems).toEqual([
      {
        code: "tool_name_taken",
        detail: "tool select_rows is also a tool of the MCP server",
        hint: "Two tools cannot share a name: ask the extension's author to rename it, or remove the other extension first.",
        docs: EXT_DOCS.permissions,
      },
    ]);
  });

  it("a tool named like a tool of another extension", () => {
    const other = { ...plan(books()).record!, name: "shelf", token: "ext-shelf", tools: ["list_reading", "shelve"] };
    const self = { ...other, name: "books", tools: ["finish_book"] };
    const p = plan(books(), { others: [other, self] });
    expect(p.problems.map((x) => [x.code, x.detail])).toEqual([["tool_name_taken", "tool list_reading is also a tool of extension shelf"]]);
  });

  it("an existing token at install", () => {
    const p = plan(books(), { tokens: ["reader", "ext-books"] });
    expect(p.token.action).toBe("create");
    expect(p.problems).toEqual([
      {
        code: "token_exists",
        detail: "a token named ext-books exists already",
        hint: "Delete it (POST /datanotes/tokens/delete/), or run datanotes extension remove books to clear what an earlier install left.",
        docs: EXT_DOCS.remove,
      },
    ]);
  });

  it("an engine too old", () => {
    const p = plan(books(), { engineVersion: "3.1.0" });
    expect(p.problems).toEqual([
      {
        code: "engine_too_old",
        detail: "the extension needs Datanotes >=3.2.0; the engine is 3.1.0",
        hint: "Update the engine to a version the extension supports and start it again, or install an older version of the extension.",
        docs: EXT_DOCS.install,
      },
    ]);
    expect(plan(books(), { engineVersion: "dev" }).ready).toBe(true);
  });

  it("more than 200 operations", () => {
    const m = books("v0.1.0", (r) => {
      r.tables.book.constraints = Array.from({ length: 201 }, (_, i) => ({ name: `c${i}`, check: { title: { exists: true } }, hint: `Hint ${i}.` }));
    });
    const p = plan(m);
    expect(p.operations.length).toBe(205);
    expect(p.problems).toEqual([
      {
        code: "too_many_operations",
        detail: `the plan needs 205 operations; a batch takes ${MAX_OPERATIONS}`,
        hint: "Install on tables that need fewer changes, or ask the extension's author to split the migration.",
        docs: EXT_DOCS.install,
      },
    ]);
    expect(p.summary).toBe("books 0.1.0: 1 problem: nothing written");
  });

  it("problems come in order and are counted in the summary", () => {
    const p = plan(books(), { engineVersion: "3.0.0", tokens: ["ext-books"], choices: { create: ["nobody"] } });
    expect(p.problems.map((x) => x.code)).toEqual(["unknown_role", "engine_too_old", "token_exists"]);
    expect(p.summary).toBe("books 0.1.0: 3 problems: nothing written");
  });

  it("an extension that only reads the tables it depends on", () => {
    const m = books("v0.1.0", (r) => {
      delete r.tables.book;
      delete r.bases;
      r.views = { vw_people: { description: "Everyone", query: { table: "@person" } } };
      r.permissions.write = [];
      r.tools = [{ ...r.tools[0], tables: ["person"] }];
    });
    const p = plan(m);
    expect(p.ready).toBe(true);
    expect(p.operations).toEqual([{ op: "create_view", catalog: "work", schema: "books", name: "vw_people", description: "Everyone", query: { table: "work.planning.person" } }]);
    expect(p.tables[0]!.changes).toEqual(["create view vw_people"]);
    expect(p.token.write).toEqual([]);
    expect(renderPlan(p).split("\n")).toContain("Token: ext-books, create, writes nothing (no schema changes)");
  });
});

describe("columnDifference", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>, boolean, string | null][] = [
    ["equal strings", { type: "string" }, { type: "string", label: "Name" }, true, null],
    ["another type", { type: "enum" }, { type: "string" }, false, "is string, not enum"],
    ["list items", { type: "list", items: "link" }, { type: "list", items: "string" }, false, "holds string, not link"],
    ["equal lists", { type: "list", items: "string" }, { type: "list", items: "string" }, true, null],
    ["link to another table", { type: "link", ref: "a.b.c" }, { type: "link", ref: "a.b.d" }, false, "links to a.b.d, not a.b.c"],
    ["self on the expected side", { type: "link", ref: "self" }, { type: "link", ref: "w.t.task" }, true, null],
    ["self on the actual side", { type: "link", ref: "w.t.task" }, { type: "link", ref: "self" }, true, null],
    ["self against another table", { type: "link", ref: "self" }, { type: "link", ref: "w.t.other" }, false, "links to w.t.other, not w.t.task"],
    ["list of links", { type: "list", items: "link", ref: "self" }, { type: "list", items: "link", ref: "w.t.other" }, false, "links to w.t.other, not w.t.task"],
    ["enum with more values", { type: "enum", values: ["a", "b"] }, { type: "enum", values: ["a", "b", "c"] }, true, null],
    ["enum lacking values", { type: "enum", values: ["a", "b", "c"] }, { type: "enum", values: ["b"] }, false, "lacks the values a, c"],
    ["enum without values", { type: "enum", values: ["a"] }, { type: "enum" }, false, "lacks the values a"],
    ["hierarchy, not strict", { type: "link", ref: "self", hierarchy: true }, { type: "link", ref: "self" }, false, null],
    ["hierarchy, strict", { type: "link", ref: "self", hierarchy: true }, { type: "link", ref: "self" }, true, "has no hierarchy: true"],
    ["acyclic, strict", { type: "link", ref: "self", acyclic: true }, { type: "link", ref: "self", hierarchy: true }, true, "has no acyclic: true"],
    ["acyclic there", { type: "link", ref: "self", acyclic: true }, { type: "link", ref: "self", acyclic: true }, true, null],
    ["no inverse", { type: "list", items: "link", ref: "self", inverse: "blocked_by" }, { type: "list", items: "link", ref: "self" }, true, "has inverse none, not blocked_by"],
    ["another inverse", { type: "list", items: "link", ref: "self", inverse: "blocked_by" }, { type: "list", items: "link", ref: "self", inverse: "related" }, true, "has inverse related, not blocked_by"],
    ["inverse, not strict", { type: "list", items: "link", ref: "self", inverse: "blocked_by" }, { type: "list", items: "link", ref: "self" }, false, null],
    ["same inverse", { type: "list", items: "link", ref: "self", inverse: "related" }, { type: "list", items: "link", ref: "self", inverse: "related" }, true, null],
    ["other attributes", { type: "integer", min: 1, max: 5 }, { type: "integer", min: 0 }, true, null],
  ];
  it.each(cases)("%s", (_name, expected, actual, strict, result) => {
    expect(columnDifference(expected, actual, "w.t.task", strict)).toBe(result);
  });
});

describe("renderPlan", () => {
  it("shows a ready plan", () => {
    const lines = renderPlan(plan(books())).split("\n");
    expect(lines[0]).toBe("Install books 0.1.0: A reading list: books, who wrote them, and what you are reading now");
    expect(lines[1]).toBe(`Source: ${SOURCE.label} (commit aaaaaaaaaaaa)`);
    expect(lines).toContain("Tables:");
    expect(lines.find((l) => l.includes("person") && l.includes("work.planning.person") && l.includes("match (proposed)"))).toBe("  person  work.planning.person  match (proposed)");
    expect(lines).toContain("  book  work.books.book  create: create; define base shelved; create view vw_reading");
    expect(lines).toContain("Tools (2):");
    expect(lines).toContain("  list_reading  reads");
    expect(lines).toContain("  finish_book  writes work.books.book");
    expect(lines).toContain("Token: ext-books, create, writes work.books.book (no schema changes)");
    expect(lines).toContain("Operations: 5 in one batch (one undo_migration)");
    expect(lines).not.toContain("Notes:");
    expect(lines.slice(-3)).toEqual(["", AGENT_MESSAGE, "books 0.1.0: 1 created, 0 adopted, 1 matched; 5 operations in one batch"]);
  });

  it("shows the problems and notes of a plan that is not ready", () => {
    const p = plan(books("v0.1.0", (r) => (r.tables.person.columns[0].need = "optional")), {
      described: { "work.planning.person": { qualified: "work.planning.person", columns: [] } },
      choices: { map: { book: "work.none.book" } },
    });
    const lines = renderPlan(p).split("\n");
    expect(lines).toContain("  book  ?  unresolved: create view vw_reading");
    expect(lines).toContain("Notes:");
    expect(lines).toContain("  - person: work.planning.person has no column name: the extension works without it");
    expect(lines).toContain("Problems (1):");
    expect(lines).toContain("  - book: no table work.none.book");
    expect(lines.some((l) => l.startsWith("    Hint: Pass a qualified name"))).toBe(true);
    expect(lines).toContain(`    Docs: ${EXT_DOCS.tables}`);
    expect(lines[lines.length - 1]).toBe("books 0.1.0: 1 problem: nothing written");
  });

  it("says when there is nothing to write", () => {
    const p = plan(books("v0.1.0", (r) => delete r.views), {
      listing: BOOK_LISTING,
      described: {
        "work.planning.person": PERSON,
        "work.books.book": bookTable((d) => {
          d.columns.push({ name: "rating", type: "integer" });
          d.constraints = { rating_only_when_read: CHECK };
          d.constraint_hints = { rating_only_when_read: HINT_V1 };
          d.instructions = BOOK_INSTRUCTIONS;
          d.bases = ["shelved"];
          d.tags = { extension: "books", extension_role: "book" };
        }),
      },
      bases: shelved,
    });
    expect(renderPlan(p).split("\n")).toContain("Operations: none");
  });
});

describe("names", () => {
  it("the record names the same rule as the manifest", () => {
    expect(RECORD_NAME.source).toBe(EXTENSION_NAME.source);
  });

  it("the record keeps unknown roles of the installed one out of a fresh choice", () => {
    const installed: InstalledExtension = { ...plan(books()).record!, tables: { person: { table: "work.planning.person", owned: false } } };
    const { chosen } = chooseTables(books(), LISTING, { map: {}, columns: {}, create: [], add: {} }, installed);
    expect(chosen.map((c) => [c.role, c.decision, c.proposed])).toEqual([
      ["person", "match", false],
      ["book", "create", false],
    ]);
  });
});
