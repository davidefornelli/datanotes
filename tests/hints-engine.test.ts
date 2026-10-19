/**
 * The engine's errors, kind by kind, as the HTTP API answers them: each says what is wrong
 * (`error`), how to fix it (`hint`: the closest real name, the allowed values, the right shape,
 * the operation that lists the answer) and where to read more (`docs`). The answers are data:
 * the names come from the metastore. Pure functions: hints.test.ts; over MCP: mcp-agent-mistakes.test.ts.
 */

import { describe, expect, it } from "vitest";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { INDEX_RETRY } from "../src/core/engine";
import { toolDocs } from "../src/api/guidance";
import { ACYCLIC_GUIDANCE, docsUrl } from "../src/core/hints";
import { batchGuidance, createHandlers, dispatch, errorResponse, operationOf, BadRequest, Forbidden } from "../src/server/rest";
import { EmbeddingError } from "../src/core/embeddings";
import { createDbVault, logVault, type DbVault } from "./helpers/db-vault";
import { DOCS_URL_RE } from "./helpers/guidance";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

interface Answer {
  status: number;
  json: { error?: string; hint?: string; docs?: string; [k: string]: unknown };
}

/** A vault with the log table and the calls an agent makes, answered as the HTTP API answers them. */
function engine(v: DbVault = logVault()) {
  const handlers = createHandlers(v.app, () => v.settings);
  const call = async (op: string, args: Record<string, unknown>): Promise<Answer> => {
    const req = operationRequest(op, args);
    const route = req.path.slice(ROUTE_PREFIX.length);
    return (await dispatch(route, handlers[route]!, req.body)) as Answer;
  };
  /** A call that must fail with guidance: its answer. */
  const fails = async (op: string, args: Record<string, unknown>): Promise<Answer["json"] & { hint: string; docs: string }> => {
    const r = await call(op, args);
    expect(r.status, `${op} should fail: ${JSON.stringify(r.json)}`).toBeGreaterThanOrEqual(400);
    expect(r.json.hint, `${op}: no hint in ${JSON.stringify(r.json)}`).toEqual(expect.any(String));
    expect(r.json.docs).toMatch(DOCS_URL_RE);
    return r.json as never;
  };
  const ok = async (op: string, args: Record<string, unknown>) => {
    const r = await call(op, args);
    expect(r.status, `${op}: ${JSON.stringify(r.json)}`).toBe(200);
    return r.json;
  };
  return { v, call, fails, ok };
}

const FILM = {
  name: "film",
  description: "Classic films I watched or want to watch",
  columns: [
    { name: "title", type: "string", required: true, description: "The film's title" },
    { name: "status", type: "enum", values: ["to watch", "watched"], description: "Where the film is on my list" },
    { name: "rating", type: "integer", min: 1, max: 5, description: "My rating, from 1 to 5" },
  ],
  filename: "{title}", aliases: ["movies", "watchlist"],
};

describe("tables and views that do not exist", () => {
  it("the closest table by name or alias, the tables, and list_tables", async () => {
    const e = engine();
    await e.ok("create_table", FILM);
    expect(await e.fails("select_rows", { table: "logs" })).toMatchObject({
      error: "Table not found: logs",
      hint: `Did you mean "log"? Tables: film, log. list_tables lists them with their descriptions and aliases.`,
      docs: docsUrl("findTable"),
    });
    expect((await e.fails("insert_row", { table: "watchlist", values: { title: "x" } })).hint).toMatch(/^Did you mean "film"\? /);
    expect((await e.fails("describe_table", { table: "main.public.flim" })).hint).toMatch(/^Did you mean "film"\? /);
    expect((await e.fails("select_rows", { table: "nothing_like_it" })).hint).toBe("Tables: film, log. list_tables lists them with their descriptions and aliases.");
  });

  it("two tables of the same name are named in full", async () => {
    const e = engine();
    await e.ok("create_table", described({ ...FILM, name: "log", schema: "archive", filename: "{title}" }));
    expect((await e.fails("select_rows", { table: "lgo" })).hint).toBe(
      `Did you mean "main.archive.log" or "main.public.log"? Tables: main.archive.log, main.public.log. list_tables lists them with their descriptions and aliases.`,
    );
  });

  it("a view where a table is needed: read it, write to its table; a read lists the views too", async () => {
    const e = engine();
    await e.ok("create_table", FILM);
    await e.ok("create_view", { name: "vw_walks", query: { table: "log", where: { kind: "walk" } }, aliases: ["strolls"] });
    await e.ok("create_view", { name: "vw_everything", query: { union: [{ table: "log" }, { table: "film" }] } });
    expect(await e.fails("insert_row", { table: "vw_walks", values: { kind: "walk" } })).toMatchObject({
      error: "Table not found: vw_walks",
      hint: "main.public.vw_walks is a view: read it with select_rows; it cannot be written or changed like a table. Write to its table, log, instead (describe_table shows it).",
      docs: docsUrl("views"),
    });
    expect((await e.fails("update_rows", { table: "public.vw_everything", where: {}, set: { kind: "walk" } })).hint).toMatch(/is a view: .* Write to its table instead/);
    expect((await e.fails("select_rows", { table: "vw_walk" })).hint).toBe(
      `Did you mean "vw_walks"? Tables: film, log. Views: vw_everything, vw_walks. list_tables lists them with their descriptions and aliases.`,
    );
    expect((await e.fails("select_rows", { table: "strolls" })).hint).toMatch(/^Did you mean "vw_walks"\?/);
    expect(await e.fails("drop_view", { view: "vw_wlaks" })).toMatchObject({
      error: "Table not found: vw_wlaks",
      hint: `Did you mean "vw_walks"? Views: vw_everything, vw_walks. list_tables lists them with their descriptions and aliases.`,
    });
  });

  it("an empty database says there is nothing yet, and how to make it", async () => {
    const e = engine(createDbVault());
    expect((await e.fails("select_rows", { table: "film" })).hint).toBe("There are no tables yet (create_table makes one). list_tables lists them with their descriptions and aliases.");
    expect((await e.fails("drop_view", { view: "vw_x" })).hint).toBe("There are no views. list_tables lists them with their descriptions and aliases.");
    expect((await e.fails("select_rows", { table: "base:dated" })).hint).toBe("There are no bases yet. describe_database lists them; define_base makes one.");
  });
});

describe("columns that do not exist", () => {
  it("in a read: the closest column, the table's columns and describe_table", async () => {
    const e = engine();
    const where = await e.fails("select_rows", { table: "log", where: { knid: "walk" } });
    expect(where).toMatchObject({ error: `unknown column in where: "knid"`, docs: docsUrl("select") });
    expect(where.hint).toMatch(/^Did you mean "kind"\? Columns of main\.public\.log: .*kind.*metric_drinks.*\. describe_table\("main\.public\.log"\) lists them/);
    expect((await e.fails("select_rows", { table: "log", columns: ["kind", "ocurred_at"] })).hint).toMatch(/^Did you mean "occurred_at"\?/);
    expect((await e.fails("select_rows", { table: "log", order_by: "-metric_drink" })).hint).toMatch(/^Did you mean "metric_drinks"\?/);
    expect((await e.fails("select_rows", { table: "log", group_by: "kind", aggregates: { n: "sum:metric_drink" } })).hint).toMatch(/^Did you mean "metric_drinks"\?/);
    expect((await e.fails("select_rows", { table: "log", group_by: "knd" })).hint).toMatch(/^Did you mean "kind"\? Columns: .* An expression is a column, "path", or date\(<column>\)/);
    expect((await e.fails("select_rows", { table: "log", group_by: "kind", order_by: "count" })).hint).toMatch(/^The grouped rows' columns: kind\. Grouped rows have only/);
    expect((await e.fails("select_rows", { table: "log", group_by: "kind", aggregates: { n: "total:metric_drinks" } })).docs).toBe(docsUrl("groupBy"));
  });

  it("in a join: the other table's columns", async () => {
    const e = engine();
    await e.ok("create_table", FILM);
    const j = await e.fails("select_rows", { table: "log", join: { table: "film", on: { kind: "title" }, columns: ["titel"] } });
    expect(j.hint).toMatch(/^Did you mean "title"\? Columns of main\.public\.film: /);
    expect(j.docs).toBe(docsUrl("join"));
    expect((await e.fails("select_rows", { table: "log", join: { table: "film", on: {} } })).hint).toMatch(/^Write join as /);
    const agg = await e.fails("select_rows", { table: "log", join: { table: "film", on: { kind: "title" }, type: "left" }, group_by: "kind", aggregates: { r: "avg:film.ratng" } });
    expect(agg.hint).toMatch(/^Did you mean "rating"\? Columns of film: /);
  });

  it("in a write: the closest column, and add_column for a new one", async () => {
    const e = engine();
    const ins = await e.fails("insert_row", { table: "log", values: { kind: "walk", occurred_at: "2026-10-01T08:00", metric_drink: 1 } });
    expect(ins).toMatchObject({ error: `unknown column "metric_drink" for table "log"`, docs: docsUrl("describeTable") });
    expect(ins.hint).toMatch(/^Did you mean "metric_drinks"\? .* To keep a new front matter key, add_column first\.$/);
    expect((await e.fails("update_rows", { table: "log", where: { kind: "walk" }, set: { knd: "mood" } })).hint).toMatch(/^Did you mean "kind"\?/);
    expect((await e.fails("merge_rows", { table: "log", on: ["idd"], rows: [{ idd: 1 }] })).hint).toMatch(/^Did you mean "id"\? .* The key columns identify a row/);
    expect((await e.fails("merge_rows", { table: "log", on: ["id"], rows: [{ id: "01a0f000-0000-7000-8000-00000000000a", knd: "x" }] })).hint).toMatch(/^Did you mean "kind"\?/);
  });

  it("in a schema change: the table's columns", async () => {
    const e = engine();
    for (const [op, args] of [
      ["alter_column", { table: "log", column: "metric_drink", changes: { max: 40 } }],
      ["drop_column", { table: "log", column: "metric_drink" }],
      ["rename_column", { table: "log", from_column: "metric_drink", to_column: "drinks" }],
      ["rename_value", { table: "log", column: "metric_drink", from_value: "a", to_value: "b" }],
    ] as const) {
      const r = await e.fails(op, args);
      expect(r.error).toBe(`column "metric_drink" not found in table "log"`);
      expect(r.hint, op).toMatch(/^Did you mean "metric_drinks"\? Columns of main\.public\.log: /);
    }
  });

  it("a hand-made property close to a column: check_table says which one was meant", async () => {
    const e = engine(logVault({ "Daily/c.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000c\nkind: walk\noccurred_at: 2026-09-27T07:00\nmetric_drink: 2\nweather: rain\n---\n" }));
    const r = (await e.ok("check_table", { table: "log" })) as { violations: { path: string; violations: { column: string; message: string }[] }[] };
    const messages = r.violations.find((x) => x.path === "Daily/c.md")!.violations.map((x) => `${x.column} ${x.message}`);
    expect(messages).toEqual([`metric_drink is not a column of table "log" (did you mean "metric_drinks"?)`, `weather is not a column of table "log"`]);
  });
});

describe("filters", () => {
  it("a wrong operator: the one meant and every operator, with the filters page", async () => {
    const e = engine();
    const r = await e.fails("select_rows", { table: "log", where: { metric_drinks: { "=>": 3 } } });
    expect(r.error).toBe(`where "metric_drinks": unknown operator "=>" (use eq, ne, gt, gte, lt, lte, in, contains, icontains, exists, within)`);
    expect(r.hint).toMatch(/^Write a condition as /);
    expect(r.docs).toBe(docsUrl("filters"));
    expect((await e.fails("select_rows", { table: "log", where: { metric_drinks: { greater_or_equal: 3, lte: 9 } } })).hint).toMatch(/^Write a condition/);
    expect((await e.fails("select_rows", { table: "log", where: { kind: { in_any: ["walk"] } } })).hint).toMatch(/^Write a condition/);
    expect((await e.fails("select_rows", { table: "log", where: { kind: { in: "walk" } } })).hint).toBe(`Write {"<column>": {"in": ["a", "b"]}}; for one value use {"<column>": "a"}.`);
    expect((await e.fails("select_rows", { table: "log", where: { or: { kind: "walk" } } })).docs).toBe(docsUrl("logical"));
    expect((await e.fails("select_rows", { table: "log", where: { or: ["walk"] } })).docs).toBe(docsUrl("logical"));
  });

  it("a filter through a link: the link columns the table has", async () => {
    const e = engine();
    await e.ok("create_table", described({ ...FILM, columns: [...FILM.columns, { name: "seen_in", type: "link", ref: "main.public.log" }] }));
    expect((await e.fails("select_rows", { table: "log", where: { "people.name": "Ada" } })).hint).toMatch(/follow a link column with a ref; main\.public\.log has none\./);
    expect((await e.fails("select_rows", { table: "film", where: { "status.name": "x" } })).hint).toMatch(/those of main\.public\.film are: seen_in\./);
    expect((await e.fails("select_rows", { table: "film", where: { title: { within: "x" } } })).docs).toBe(docsUrl("linkFilters"));
    expect((await e.fails("select_rows", { table: "film", where: { seen_in: { within: "x" } } })).docs).toBe(docsUrl("tree"));
    expect((await e.fails("update_rows", { table: "film", where: { seen_in: { within: "x" } }, set: { rating: 1 } })).hint).toMatch(/hierarchy: true/);
  });
});

describe("rows, values and the schema", () => {
  it("update_row on a row that does not exist: the row meant, and how to find rows", async () => {
    const e = engine();
    await e.ok("create_table", FILM);
    await e.ok("insert_row", { table: "film", values: { title: "Metropolis" } });
    const r = await e.fails("update_row", { table: "film", path: "Metropolis2", set: { rating: 5 } });
    expect(r.error).toBe("film has no row at Metropolis2.md");
    expect(r.hint).toMatch(/^Did you mean "Datanotes\/main\/public\/film\/Metropolis\.md"\? Name the row by its "path"/);
    expect(r.docs).toBe(docsUrl("updateRow"));
    expect((await e.fails("update_row", { table: "film", path: "Sunrise.md", set: { rating: 5 } })).hint).toMatch(/^Name the row by its "path"/);
    expect((await e.fails("update_row", { table: "film", id: "01a0f000-0000-7000-8000-0000000000ff", set: { rating: 5 } })).hint).toMatch(/^Name the row/);
    expect((await e.fails("update_row", { table: "film", set: { rating: 5 } })).hint).toMatch(/^Name the row/);
  });

  it("an enum value to rename: the values, and the one meant", async () => {
    const e = engine();
    await e.ok("create_table", FILM);
    expect(await e.fails("rename_value", { table: "log", column: "kind", from_value: "walks", to_value: "stroll" })).toMatchObject({
      hint: `Did you mean "walk"? Pass from_value (one of: alcohol, mood, walk) and the new to_value.`,
      docs: docsUrl("renameValue"),
    });
    expect((await e.fails("rename_value", { table: "log", column: "kind", from_value: "zzz", to_value: "b" })).hint).toBe("Pass from_value (one of: alcohol, mood, walk) and the new to_value.");
    expect((await e.fails("rename_value", { table: "log", column: "metric_drinks", from_value: "1", to_value: "2" })).hint).toMatch(/\(in main\.public\.log: kind\)/);
    expect((await e.fails("rename_value", { table: "film", column: "title", from_value: "1", to_value: "2" })).hint).toMatch(/\(in main\.public\.film: status\)/);
    await e.ok("create_table", described({ name: "note", columns: [{ name: "title", type: "string" }], filename: "{title}" }));
    expect((await e.fails("rename_value", { table: "note", column: "title", from_value: "1", to_value: "2" })).hint).toMatch(/\(main\.public\.note has none\)/);
  });

  it("a link to a table that does not exist: the table meant, in full", async () => {
    const e = engine();
    await e.ok("create_table", FILM);
    expect((await e.fails("add_column", described({ table: "log", column: { name: "film", type: "link", ref: "main.public.flim" } }))).hint).toMatch(/^Did you mean "main\.public\.film"\? Name the table in full/);
    expect((await e.fails("add_column", described({ table: "log", column: { name: "film", type: "link", ref: "film" } }))).hint).toMatch(/^Did you mean "main\.public\.film"\?/);
    expect((await e.fails("add_column", described({ table: "log", column: { name: "genre", type: "string", vocabulary: "main.public.genres" } }))).docs).toBe(docsUrl("vocabulary"));
    expect((await e.fails("add_column", described({ table: "log", column: { name: "kind", type: "string" } }))).hint).toMatch(/alter_column/);
  });

  it("list_link_targets on a column that is not a link: the link columns", async () => {
    const e = engine();
    await e.ok("create_table", described({ ...FILM, columns: [...FILM.columns, { name: "seen_in", type: "link", ref: "main.public.log" }] }));
    expect((await e.fails("list_link_targets", { table: "film", column: "title" })).hint).toMatch(/those of main\.public\.film are: seen_in\./);
    expect((await e.fails("list_link_targets", { table: "log", column: "kind" })).hint).toMatch(/main\.public\.log has none\./);
  });

  it("unknown bases, constraints, catalogs and schemas: the real ones", async () => {
    const e = engine();
    await e.ok("define_base", describedBase({ name: "dated", columns: [{ name: "day", type: "date" }] }));
    expect((await e.fails("select_rows", { table: "base:datd" })).hint).toMatch(/^Did you mean "dated"\? Bases: dated\./);
    expect((await e.fails("select_rows", { table: "base:dated", columns: ["dy"] })).hint).toMatch(/^Did you mean "day"\?/);
    expect((await e.fails("set_table_bases", { table: "log", bases: ["datd"] })).hint).toMatch(/^Did you mean "dated"\?/);
    expect((await e.fails("drop_constraint", { table: "log", name: "no_such_rule" })).hint).toBe("There are no constraints of main.public.log yet. describe_table lists them.");
    expect((await e.fails("comment_on", { catalog: "mian", description: "x" })).hint).toMatch(/^Did you mean "main"\? Catalogs: main\./);
    expect((await e.fails("comment_on", { catalog: "main", schema: "pubic", description: "x" })).hint).toMatch(/^Did you mean "public"\?/);
    expect((await e.fails("select_rows", { table: "information_schema.colums" })).hint).toMatch(/^Did you mean "columns"\?/);
    expect((await e.fails("create_view", { name: "vw_x", query: { tabel: "log" } })).hint).toMatch(/^Did you mean "table"\?/);
    const table = { columns: [{ name: "a", type: "string" }], filename: "{a}" };
    expect((await e.fails("create_table", described({ ...table, name: "Film Diary" }))).hint).toMatch(/^Use a name like "film_diary"; /);
    expect((await e.fails("create_table", described({ ...table, name: "x", catalog: "9" }))).hint).toMatch(/^Use a name like "my_catalog"; /);
    expect((await e.fails("define_base", describedBase({ name: "Dated-Notes!", columns: [{ name: "day", type: "date" }] }))).hint).toMatch(/^Use a name like "dated_notes"; /);
    expect((await e.fails("create_view", { name: "1", query: { table: "log" } })).hint).toMatch(/^Use a name like "my_table"; /);
  });

  it("time travel and history: how to turn history on, and the versions", async () => {
    const e = engine();
    const changes = await e.fails("table_changes", { table: "log", start_version: 0 });
    expect(changes.hint).toMatch(/^Turn history on for it with alter_table\("main\.public\.log", history: true\)/);
    expect(changes.docs).toBe(docsUrl("history"));
    expect((await e.fails("select_rows", { table: "log", version: 0 })).docs).toMatch(DOCS_URL_RE);
    expect((await e.fails("describe_history", { table: "log", since: "yesterday" })).docs).toBe(docsUrl("versions"));
  });

  it("a graph of tables that do not exist: the table meant", async () => {
    const e = engine();
    expect((await e.fails("graph_traverse", { from_nodes: { paths: ["Daily/a.md"] }, tables: ["lgo"] })).hint).toMatch(/^Did you mean "log"\? Tables: log\./);
  });

  it("descriptions: every missing one at once, the call's shape with each in place, and the page that explains them", async () => {
    const e = engine();
    const table = await e.fails("create_table", { ...FILM, description: undefined, columns: [FILM.columns[0], { name: "year", type: "integer" }] });
    expect(table).toMatchObject({
      error: "descriptions are required: main.public.film has none for the table and column year",
      hint: `Say what a row records in "description" and what each column holds in its own "description": {"name": "film", "description": "<what a row of film records>", "columns": [{"name": "year", "type": "integer", "description": "<what year holds>"}]}. Agents and people understand the schema through them.`,
      docs: docsUrl("descriptions"),
    });
    await e.ok("create_table", FILM);
    expect(await e.fails("add_column", { table: "film", column: { name: "year", type: "integer" } })).toMatchObject({
      error: "descriptions are required: column year of main.public.film has none",
      hint: `Say what the column holds in its "description": {"table": "main.public.film", "column": {"name": "year", "type": "integer", "description": "<what year holds>"}}. Agents and people understand the schema through them.`,
      docs: docsUrl("descriptions"),
    });
    expect(await e.fails("alter_table", { table: "film", description: "  " })).toMatchObject({
      error: "the description of main.public.film cannot be removed (empty): every table needs one",
      hint: `Pass the new text, as in {"table": "main.public.film", "description": "<what a row records>"}, or leave "description" out to keep the one it has.`,
      docs: docsUrl("descriptions"),
    });
    // the log table was written before descriptions were required: a clone needs them first
    const clone = await e.fails("clone_table", { source: "log", target: "log_copy" });
    expect(clone.error).toBe("descriptions are required: main.public.log has none for the table and columns kind, occurred_at, metric_drinks, people, and a clone would have none either");
    expect(clone.hint).toBe(
      `Describe them on main.public.log first (alter_table {"table": "main.public.log", "description": "<what a row records>"}, then alter_column {"table": "main.public.log", "column": "kind", "changes": {"description": "<what kind holds>"}} for each column), then clone it again. Agents and people understand the schema through them.`,
    );
    expect((await e.fails("define_base", { name: "dated", columns: [{ name: "day", type: "date" }] })).hint).toBe(
      `Say what the tables of the base share in "description" and what each column holds in its own "description": {"name": "dated", "description": "<what tables with these columns share>", "columns": [{"name": "day", "type": "date", "description": "<what day holds>"}]}. Agents and people understand the schema through them.`,
    );
  });
});

describe("cycles", () => {
  const A = "Datanotes/main/public/task/A.md";

  it("an acyclic cycle: its own hint and the acyclic docs", async () => {
    const e = engine(createDbVault({}));
    await e.ok("create_table", described({
      name: "task",
      columns: [
        { name: "title", type: "string", required: true },
        { name: "blocked_by", type: "list", items: "link", ref: "self", acyclic: true },
      ],
      filename: "{title}",
    }));
    await e.ok("insert_row", { table: "task", values: { title: "A" } });
    await e.ok("insert_row", { table: "task", values: { title: "B", blocked_by: ["[[A]]"] } });
    const r = await e.fails("update_row", { table: "task", path: A, set: { blocked_by: ["[[B]]"] } });
    expect(r.hint).toBe(`${ACYCLIC_GUIDANCE.hint} Then call update_row again (dry_run: true checks without writing).`);
    expect(r.docs).toBe(docsUrl("acyclic"));
  });

  it("a hierarchy cycle keeps the tree docs (regression)", async () => {
    const e = engine(createDbVault({}));
    await e.ok("create_table", described({
      name: "task",
      columns: [
        { name: "title", type: "string", required: true },
        { name: "parent", type: "link", ref: "self", hierarchy: true },
      ],
      filename: "{title}",
    }));
    await e.ok("insert_row", { table: "task", values: { title: "A" } });
    await e.ok("insert_row", { table: "task", values: { title: "B", parent: "[[A]]" } });
    const r = await e.fails("update_row", { table: "task", path: A, set: { parent: "[[B]]" } });
    expect(r.docs).toBe(docsUrl("tree"));
  });
});

describe("bad input the routes refuse", () => {
  it("falls back to the operation's arguments and reference", async () => {
    const e = engine();
    expect(await e.fails("insert_row", { table: "log" })).toMatchObject({
      error: `insert_row: missing required argument "values" (object)`,
      hint: expect.stringMatching(/^insert_row takes: table \(string, required\), values \(object, required\), /),
      docs: toolDocs("insert_row"),
    });
    // a value the handler checks itself, past the schema: the operation's arguments
    expect(await e.fails("insert_row", { table: "log", values: { kind: "mood" }, path: "" })).toMatchObject({
      error: `"path" must be a non-empty string`,
      hint: expect.stringMatching(/^Check the arguments of insert_row: table \(string, required\), values \(object, required\), /),
      docs: toolDocs("insert_row"),
    });
    // a batch: the closest operation, the shape of one
    const batch = await e.fails("batch", { operations: [{ op: "insert_rows", table: "log" }] });
    expect(batch.hint).toMatch(/^Did you mean "insert_row"\? A batch holds writes/);
    expect(batch.docs).toBe(docsUrl("batch"));
  });

  it("knows the operation of each route: /operations/<name>/", () => {
    expect(operationOf("/operations/insert_row/")).toBe("insert_row");
    expect(operationOf("/operations/add_column")).toBe("add_column");
    expect(operationOf("/operations/Not-An-Op/")).toBeUndefined();
    expect(operationOf("/tokens/create/")).toBeUndefined();
  });

  it("a route that is no operation: the token routes, or the API description", () => {
    expect(errorResponse(new BadRequest("x"), undefined, "/tokens/create/").json).toMatchObject({ docs: docsUrl("manageTokens") });
    expect(errorResponse(new BadRequest("x"), undefined, "/elsewhere/").json).toMatchObject({ docs: docsUrl("routes") });
    expect(errorResponse(new BadRequest("x")).json).toMatchObject({ docs: docsUrl("routes") });
    expect(errorResponse(new Forbidden("no"))).toMatchObject({ status: 403, json: { error: "no", docs: docsUrl("tokens") } });
    expect(errorResponse(new EmbeddingError("embedding request failed (HTTP 401): unauthorized"))).toMatchObject({ status: 400, json: { docs: docsUrl("semantic") } });
  });

  it("a refused batch: fix and resend it, or repair what could not be undone", () => {
    expect(batchGuidance({ dry_run: false, failed_at: 2 }).hint).toBe("Nothing is left written: fix operation 2 as its error says, then send the whole batch again.");
    expect(batchGuidance({ dry_run: true }).hint).toMatch(/^Fix the operations marked refused/);
    expect(batchGuidance({ dry_run: false, failed_at: 1, rolled_back: false })).toEqual({
      hint: 'Some operations could not be undone: "rollback" lists them; undo them with undo_migration, or repair the rows, before you retry.',
      docs: docsUrl("batch"),
    });
  });

  it("an argument the operation does not take: the one meant, and the operation's arguments", async () => {
    const e = engine();
    const r = await e.fails("update_rows", { table: "log", where: {}, set_values: { kind: "walk" } });
    expect(r.error).toBe(`update_rows: unknown argument "set_values"`);
    expect(r.hint).toMatch(/^For "set_values" use "set"\. update_rows takes: table \(string, required\), where \(object, required\), set \(object\), /);
    expect(r.docs).toBe(toolDocs("update_rows"));
  });
});
