import { describe, expect, it } from "vitest";
import { createView } from "../src/core/catalog-ops";
import { INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { select, UNION_BRANCH_MAX, type SelectJoin, type SelectUnionBranch } from "../src/core/select";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
const YAML = `bases:
  dated:
    columns:
      - { name: day, type: date }
catalogs:
  main:
    schemas:
      public:
        tables:
          person:
            options: { filename: "{name}" }
            columns:
              - ${ID}
              - { name: name, type: string, required: true, dense: true }
              - { name: email, type: string }
          book:
            options: { filename: "{title}" }
            columns:
              - ${ID}
              - { name: title, type: string, required: true, dense: true }
              - { name: author, type: link }
              - { name: tags, type: list, items: string }
          film:
            options: { filename: "{title}" }
            columns:
              - ${ID}
              - { name: title, type: string, required: true, dense: true }
              - { name: tags, type: list, items: string }
`;

const uuid = (n: number) => `01a0f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const row = (table: string, n: number, extra: string, body = "") => `---\ntable: main.public.${table}\nid: ${uuid(n)}\n${extra}---\n${body}`;

/**
 * Dune's author is Alice; Emma's is Bob (no email); Ghost names a note that does not exist; Plain
 * names a note without properties; Nameless has no author. Alien is a film.
 */
function vault(): DbVault {
  return createDbVault({
    [METASTORE]: YAML,
    "P/Alice.md": row("person", 1, "name: Alice\nemail: alice@example.org\n"),
    "P/Bob.md": row("person", 2, "name: Bob\n"),
    "B/Dune.md": row("book", 3, 'title: Dune\nauthor: "[[Alice]]"\ntags: [scifi, classic]\n', "Spice.\n"),
    "B/Emma.md": row("book", 4, 'title: Emma\nauthor: "[[Bob]]"\ntags: []\n', "Matchmaking.\n"),
    "B/Ghost.md": row("book", 5, 'title: Ghost\nauthor: "[[Nobody]]"\ntags: [scifi]\n'),
    "B/Nameless.md": row("book", 6, "title: Nameless\n"),
    "B/Plain.md": row("book", 7, 'title: Plain\nauthor: "[[Welcome]]"\n'),
    "F/Alien.md": row("film", 8, "title: Alien\ntags: [scifi]\n", "In space.\n"),
    "Welcome.md": "Hello.\n",
  });
}

async function refused(p: Promise<unknown>, message: string): Promise<void> {
  await expect(p).rejects.toThrow(OperationInputError);
  await expect(p).rejects.toThrow(message);
}

describe("join", () => {
  it("joined rows show the columns asked for: path once, a missing value as null", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, {
      table: "book",
      columns: ["title"],
      where: { title: { in: ["Dune", "Emma", "Ghost"] } },
      orderBy: "title",
      join: { table: "person", on: { author: "file_link" }, as: "writer", type: "left", columns: ["path", "name", "email"] },
    });
    expect(r.rows).toEqual([
      { path: "B/Dune.md", title: "Dune", writer: [{ path: "P/Alice.md", name: "Alice", email: "alice@example.org" }] },
      { path: "B/Emma.md", title: "Emma", writer: [{ path: "P/Bob.md", name: "Bob", email: null }] },
      { path: "B/Ghost.md", title: "Ghost", writer: [] },
    ]);
  });

  it("needs an on pair", async () => {
    const v = vault();
    await refused(select(v.app, v.settings, { table: "book", join: { table: "person" } as SelectJoin }), `join.on must contain exactly one "left": "right" pair`);
  });
});

describe("expand", () => {
  it("replaces a link by the linked note's properties; leaves missing links, empty values and plain notes alone", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "book", columns: ["title", "author"], expand: ["author"], where: { title: { ne: "Emma" } } });
    expect(r.rows).toEqual([
      { path: "B/Dune.md", title: "Dune", author: { path: "P/Alice.md", table: "main.public.person", id: uuid(1), name: "Alice", email: "alice@example.org" } },
      { path: "B/Ghost.md", title: "Ghost", author: "[[Nobody]]" },
      { path: "B/Nameless.md", title: "Nameless", author: null },
      { path: "B/Plain.md", title: "Plain", author: { path: "Welcome.md" } },
    ]);
  });

  it("a link to an archived row stays a link, as one to a deleted row", async () => {
    const v = vault();
    v.write("Datanotes/main/public/person/_archive/Old Writer.md", row("person", 9, "name: Old Writer\n"));
    v.write("B/Lost.md", row("book", 10, 'title: Lost\nauthor: "[[Old Writer]]"\n'));
    const r = await select(v.app, v.settings, { table: "book", columns: ["author"], expand: ["author"], where: { title: { in: ["Lost", "Dune"] } } });
    expect(r.rows).toEqual([
      { path: "B/Dune.md", author: { path: "P/Alice.md", table: "main.public.person", id: uuid(1), name: "Alice", email: "alice@example.org" } },
      { path: "B/Lost.md", author: "[[Old Writer]]" },
    ]);
  });
});

describe("group_by", () => {
  it("a row with an empty list falls in the null group, like a row without the value", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "book", groupBy: "tags", aggregates: { n: "count", books: "count:title" } });
    expect(r.rows).toEqual([
      { tags: "classic", n: 1, books: 1 },
      { tags: "scifi", n: 2, books: 2 },
      { tags: null, n: 3, books: 3 },
    ]);
  });
});

describe("bases", () => {
  it("a base no table extends has no rows (its columns are still checked)", async () => {
    const v = vault();
    expect(await select(v.app, v.settings, { table: "base:dated" })).toEqual({ table: "base:dated", total: 0, rows: [] });
    expect(await select(v.app, v.settings, { table: "base: dated ", columns: ["day"], where: { day: "2026-10-01" } })).toEqual({ table: "base: dated ", total: 0, rows: [] });
    await refused(select(v.app, v.settings, { table: "base:dated", columns: ["title"] }), `"title" is not a column of base dated (columns: id, day)`);
  });
});

describe("union", () => {
  const union: SelectUnionBranch[] = [{ table: "book", where: { title: "Dune" } }, { table: "film" }];

  it("without columns every branch returns all of its own", async () => {
    const v = vault();
    const r = await select(v.app, v.settings, { table: "", union, orderBy: "-title" });
    expect(r).toEqual({
      table: "union",
      total: 2,
      rows: [
        { path: "B/Dune.md", id: uuid(3), title: "Dune", author: "[[Alice]]", tags: ["scifi", "classic"], _source: "book" },
        { path: "F/Alien.md", id: uuid(8), title: "Alien", tags: ["scifi"], _source: "film" },
      ],
    });
  });

  it("include_body adds every row's body; the branch's view names the source", async () => {
    const v = vault();
    expect((await createView(v.app, v.settings, { name: "vw_dune", query: { table: "book", where: { title: "Dune" } } })).ok).toBe(true);
    const r = await select(v.app, v.settings, { table: "", union: [{ table: "vw_dune" }, { table: "film" }], columns: ["title"], includeBody: true });
    expect(r.rows).toEqual([
      { path: "B/Dune.md", title: "Dune", body: "Spice.\n", _source: "main.public.vw_dune" },
      { path: "F/Alien.md", title: "Alien", body: "In space.\n", _source: "film" },
    ]);
  });

  it("refuses join, group_by and aggregates", async () => {
    const v = vault();
    const msg = "union does not support join, group_by or aggregates";
    await refused(select(v.app, v.settings, { table: "", union, join: { table: "person", on: { author: "file_link" } } }), msg);
    await refused(select(v.app, v.settings, { table: "", union, groupBy: "title" }), msg);
    await refused(select(v.app, v.settings, { table: "", union, aggregates: { n: "count" } }), msg);
  });

  it("time travel: by version refused (several tables), by timestamp refused for tables without history", async () => {
    const v = vault();
    expect((await createView(v.app, v.settings, { name: "vw_media", query: { union, columns: ["title"] } })).ok).toBe(true);
    expect((await select(v.app, v.settings, { table: "vw_media" })).rows.map((x) => x.title)).toEqual(["Dune", "Alien"]);
    await refused(select(v.app, v.settings, { table: "vw_media", version: 0 }), '"version" numbers the versions of one table, and a union reads several tables');
    await refused(select(v.app, v.settings, { table: "", union, timestamp: "2026-10-01T00:00:00Z" }), "has no history: time travel is off for it");
  });

  it("every branch needs a table", async () => {
    const v = vault();
    const msg = `every union branch needs "table"`;
    await refused(select(v.app, v.settings, { table: "", union: [{ table: "book" }, {} as SelectUnionBranch] }), msg);
    await refused(select(v.app, v.settings, { table: "", union: [{ table: "book" }, { table: "" }] }), msg);
    await refused(select(v.app, v.settings, { table: "", union: [null as unknown as SelectUnionBranch, { table: "book" }] }), msg);
  });

  it(`a branch may bring at most ${UNION_BRANCH_MAX} rows`, async () => {
    // a wide table: information_schema.columns has a row per column
    const readings = Array.from({ length: UNION_BRANCH_MAX }, (_, i) => `              - { name: reading_${i + 1}, type: number }`);
    const yaml = ["catalogs:", "  main:", "    schemas:", "      public:", "        tables:", "          sensor:", "            columns:", `              - ${ID}`, ...readings, ""];
    const v = createDbVault({ [METASTORE]: yaml.join("\n") });
    const union = [{ table: "information_schema.columns" }, { table: "information_schema.tables" }];
    await refused(
      select(v.app, v.settings, { table: "", union, columns: ["table_name"] }),
      `union branch information_schema.columns has ${UNION_BRANCH_MAX + 1} rows (max ${UNION_BRANCH_MAX}): narrow it with where`,
    );
    const narrowed = await select(v.app, v.settings, { table: "", union: [{ table: "information_schema.columns", where: { column_name: "reading_7" } }, union[1]!], columns: ["table_name"] });
    expect(narrowed.rows).toEqual([
      { path: "system/information_schema/columns/00008", table_name: "sensor", _source: "information_schema.columns" },
      { path: "system/information_schema/tables/00001", table_name: "sensor", _source: "information_schema.tables" },
    ]);
  });
});

describe("information_schema", () => {
  it("has no history", async () => {
    const v = vault();
    await refused(select(v.app, v.settings, { table: "system.information_schema.tables", version: 1 }), "information_schema has no history");
    await refused(select(v.app, v.settings, { table: "information_schema.columns", timestamp: "2026-10-01T00:00:00Z" }), "information_schema has no history");
  });
});

describe("views", () => {
  it("views that read each other are refused when nested too deep", async () => {
    const v = vault();
    expect((await createView(v.app, v.settings, { name: "vw_a", query: { table: "book" } })).ok).toBe(true);
    expect((await createView(v.app, v.settings, { name: "vw_b", query: { table: "vw_a", columns: ["title"] } })).ok).toBe(true);
    expect((await createView(v.app, v.settings, { name: "vw_a", query: { table: "vw_b" }, replace: true })).ok).toBe(true);
    await refused(select(v.app, v.settings, { table: "vw_a" }), "views nested deeper than 8 (a cycle?) at main.public.vw_a");
    await refused(select(v.app, v.settings, { table: "vw_b" }), "views nested deeper than 8 (a cycle?) at main.public.vw_b");
  });
});
