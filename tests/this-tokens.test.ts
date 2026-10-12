import { describe, expect, it } from "vitest";
import { operationRequest } from "../src/api/requests";
import { createView } from "../src/core/catalog-ops";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { insertRow, select } from "../src/core/rows";
import { hasThisTokens, resolveThisTokens } from "../src/core/this-tokens";
import { createHandlers, dispatch } from "../src/server/rest";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const host = { path: "Journal/2026-10-06.md", frontmatter: { date: "2026-10-06", author: { name: "Ursula" } } };

describe("{this.*} tokens", () => {
  it("read the note showing the view: its path, name, link and properties", () => {
    const query = {
      where: {
        day: { gte: "{this.date}", lt: "{this.date+1d}", ne: "{this.date-1w}" },
        about: "{this.link}",
        title: "Notes of {this.name}",
        path: { ne: "{this.path}" },
        by: "{this.author.name}",
        missing: "{this.nothing}",
      },
    };
    expect(hasThisTokens(query)).toBe(true);
    expect(resolveThisTokens(query, host)).toEqual({
      where: {
        day: { gte: "2026-10-06", lt: "2026-10-07", ne: "2026-09-29" },
        about: "[[2026-10-06]]",
        title: "Notes of 2026-10-06",
        path: { ne: "Journal/2026-10-06.md" },
        by: "Ursula",
        missing: "{this.nothing}",
      },
    });
    expect(hasThisTokens({ where: { day: "{today}" } })).toBe(false);
  });
});

/** Books, reading sessions, views for a daily note and for a book's note, and a daily note. */
async function reading(): Promise<DbVault> {
  const v = createDbVault({ "Journal/2026-10-06.md": "---\ndate: 2026-10-06\n---\nA quiet day.\n" });
  await createTable(v.app, v.settings, described({ name: "book", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] }));
  await createTable(v.app, v.settings, described({
    name: "session",
    timeColumn: "started_at",
    columns: [{ name: "book", type: "link", ref: "main.public.book" }, { name: "started_at", type: "datetime", required: true }, { name: "minutes", type: "integer" }],
  }));
  for (const title of ["Dune", "Piranesi"]) await insertRow(v.app, v.settings, { table: "book", values: { title } });
  const sessions: [string, string, number][] = [["[[Dune]]", "2026-10-05T21:00", 45], ["[[Piranesi]]", "2026-10-06T08:00", 30], ["[[Piranesi]]", "2026-10-06T21:00", 20]];
  for (const [book, started_at, minutes] of sessions) await insertRow(v.app, v.settings, { table: "session", values: { book, started_at, minutes } });
  const views = [
    { name: "vw_day_sessions", query: { table: "session", columns: ["book", "minutes"], where: { started_at: { gte: "{this.date}", lt: "{this.date+1d}" } }, order_by: "started_at" } },
    { name: "vw_book_sessions", query: { table: "session", columns: ["minutes"], where: { book: "{this.link}" }, order_by: "started_at" } },
    { name: "vw_both", query: { union: [{ table: "vw_day_sessions" }, { table: "vw_book_sessions" }], columns: ["minutes"] } },
  ];
  for (const view of views) expect((await createView(v.app, v.settings, view)).ok).toBe(true);
  return v;
}

const minutes = (r: { rows: Record<string, unknown>[] }) => r.rows.map((x) => x.minutes);

describe("select_rows this_note", () => {
  it("fills the tokens of the view, of its union branches and of where from the note it names", async () => {
    const v = await reading();
    expect(minutes(await select(v.app, v.settings, { table: "vw_day_sessions", thisNote: "Journal/2026-10-06.md" }))).toEqual([30, 20]);
    expect(minutes(await select(v.app, v.settings, { table: "vw_book_sessions", thisNote: "Datanotes/main/public/book/Piranesi.md" }))).toEqual([30, 20]);
    expect(minutes(await select(v.app, v.settings, { table: "vw_both", thisNote: "Journal/2026-10-06.md" }))).toEqual([30, 20]);
    const where = { book: "{this.link}" };
    expect(minutes(await select(v.app, v.settings, { table: "session", columns: ["minutes"], where, thisNote: "Datanotes/main/public/book/Dune.md" }))).toEqual([45]);
    // without it the tokens stay as written
    expect((await select(v.app, v.settings, { table: "vw_book_sessions" })).total).toBe(0);
    expect((await select(v.app, v.settings, { table: "vw_both" })).total).toBe(0);
  });

  it("a token no note fills matches no row, whatever the operator; in a list of `in`, only that item", async () => {
    const v = await reading();
    const total = async (where: Record<string, unknown>, thisNote?: string) =>
      (await select(v.app, v.settings, { table: "session", where, ...(thisNote ? { thisNote } : {}) })).total;
    expect(await total({})).toBe(3);
    expect(await total({ book: "{this.link}" })).toBe(0);
    expect(await total({ book: { ne: "{this.link}" } })).toBe(0);
    expect(await total({ started_at: { lt: "{this.date}" } })).toBe(0);
    expect(await total({ started_at: { gte: "{this.date}" } })).toBe(0);
    expect(await total({ book: { contains: "{this.name}" } })).toBe(0);
    expect(await total({ book: { icontains: "[[{this.name}]]" } })).toBe(0);
    expect(await total({ minutes: { exists: "{this.flag}" } })).toBe(0);
    expect(await total({ book: { in: ["{this.link}", "[[Dune]]"] } })).toBe(1);
    expect(await total({ not: { book: "{this.link}" } })).toBe(3);
    // a property the note lacks is a token without a value too
    expect(await total({ started_at: { lt: "{this.nothing}" } }, "Journal/2026-10-06.md")).toBe(0);
    expect(await total({ started_at: { lt: "{this.date}" } }, "Journal/2026-10-06.md")).toBe(1);
  });

  it("`within` a token no note fills matches nothing instead of being refused", async () => {
    const v = await reading();
    await createTable(v.app, v.settings, described({
      name: "topic",
      options: { filename: "{name}" },
      columns: [{ name: "name", type: "string" }, { name: "parent", type: "link", ref: "self", hierarchy: true }],
    }));
    await insertRow(v.app, v.settings, { table: "topic", values: { name: "Fiction" } });
    await insertRow(v.app, v.settings, { table: "topic", values: { name: "Fantasy", parent: "[[Fiction]]" } });
    expect((await createView(v.app, v.settings, { name: "vw_subtopics", query: { table: "topic", where: { parent: { within: "{this.link}" } } } })).ok).toBe(true);
    expect((await select(v.app, v.settings, { table: "vw_subtopics" })).total).toBe(0);
    expect((await select(v.app, v.settings, { table: "vw_subtopics", thisNote: "Datanotes/main/public/topic/Fiction.md" })).rows.map((r) => r.name)).toEqual(["Fantasy"]);
    await expect(select(v.app, v.settings, { table: "topic", where: { parent: { within: "[[Nowhere]]" } } })).rejects.toThrow(`"within": no row of main.public.topic named "[[Nowhere]]"`);
  });

  it("a union view is checked when it is created, also when it cannot run before a note fills its tokens", async () => {
    const v = await reading();
    const union = [{ table: "session", where: { book: "{this.link}" } }, { table: "book" }];
    await expect(createView(v.app, v.settings, { name: "vw_bad", query: { union, group_by: "book" } })).rejects.toThrow(
      `view query: union does not support group_by (next to union: columns, where, order_by, limit, expand)`,
    );
    await expect(createView(v.app, v.settings, { name: "vw_bad", query: { union: [{ table: "session", join: {} }, { table: "book" }] } })).rejects.toThrow(/unknown: join/);
  });

  it("refuses a path that names no note", async () => {
    const v = await reading();
    await expect(select(v.app, v.settings, { table: "vw_day_sessions", thisNote: "Journal/missing.md" })).rejects.toThrow(`this_note: no note at "Journal/missing.md"`);
    await expect(select(v.app, v.settings, { table: "vw_day_sessions", thisNote: "Journal" })).rejects.toThrow(/no note at "Journal"/);
    await expect(select(v.app, v.settings, { table: "vw_day_sessions", thisNote: "../outside.md" })).rejects.toThrow(`this_note: ".." in path`);
  });

  it("over HTTP", async () => {
    expect(operationRequest("select_rows", { table: "vw_day_sessions", this_note: "Journal/2026-10-06.md" }).body).toEqual({ table: "vw_day_sessions", this_note: "Journal/2026-10-06.md" });
    const v = await reading();
    const h = createHandlers(v.app, () => v.settings);
    const sel = (body: Record<string, unknown>) => dispatch("/operations/select_rows/", h["/operations/select_rows/"]!, body);
    expect(await sel({ table: "vw_day_sessions", this_note: "Journal/2026-10-06.md" })).toMatchObject({ status: 200, json: { total: 2 } });
    expect((await sel({ table: "vw_day_sessions", this_note: 3 })).status).toBe(400);
    expect(await sel({ table: "vw_day_sessions", this_note: "Journal/missing.md" })).toMatchObject({ status: 400 });
  });
});
