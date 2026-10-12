import { describe, expect, it } from "vitest";
import { fileCreated, fillIdentities, normalizeDatetimes } from "../src/core/computed-columns";
import { configureDatabase } from "../src/core/database";
import { createTable, dropTable, INDEX_RETRY, loadTable } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { checkTable, insertRow } from "../src/core/rows";
import type { ColumnSpec } from "../src/core/types-table";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const col = (partial: Partial<ColumnSpec> & Pick<ColumnSpec, "name" | "type">): ColumnSpec => ({ required: false, aliases: [], ...partial });
/** Today in Rome, as `{today}` gives it. */
const romeToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date());

async function romeVault(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  return v;
}

describe("generated link(…) columns", () => {
  it("link by note name when the day table partitions its rows in sub-folders", async () => {
    const v = await romeVault();
    await createTable(v.app, v.settings, described({ schema: "journal", name: "day", options: { filename: "{date:YYYY-MM-DD}", partition: "{date:YYYY}" }, columns: [{ name: "date", type: "date", required: true }] }));
    await createTable(v.app, v.settings, described({
      name: "walk",
      options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}" },
      columns: [
        { name: "occurred_at", type: "datetime", required: true },
        { name: "day", type: "link", ref: "main.journal.day", generated: "link({occurred_at:YYYY-MM-DD})" },
      ],
    }));
    const r = await insertRow(v.app, v.settings, { table: "walk", values: { occurred_at: "2026-10-06T07:30" } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    expect(fm(v, r.planned_creates![0]!).day).toBe("[[2026-10-06|2026-10-06]]");
  });

  it("no link once the ref table is dropped: the column is left empty", async () => {
    const v = await romeVault();
    await createTable(v.app, v.settings, described({ schema: "journal", name: "day", options: { filename: "{date:YYYY-MM-DD}" }, columns: [{ name: "date", type: "date", required: true }] }));
    await createTable(v.app, v.settings, described({
      name: "walk",
      options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}" },
      columns: [
        { name: "occurred_at", type: "datetime", required: true },
        { name: "day", type: "link", ref: "main.journal.day", generated: "link({occurred_at:YYYY-MM-DD})" },
      ],
    }));
    expect((await dropTable(v.app, v.settings, { table: "main.journal.day" })).ok).toBe(true);
    const r = await insertRow(v.app, v.settings, { table: "walk", values: { occurred_at: "2026-10-06T07:30" } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    expect(fm(v, r.planned_creates![0]!)).not.toHaveProperty("day");
  });
});

/** People with a generated nickname label (dense: kept as null when empty) and a sparse known_as. */
async function people(): Promise<DbVault> {
  const v = await romeVault();
  const r = await createTable(v.app, v.settings, described({
    name: "person",
    options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true },
      { name: "nickname", type: "string" },
      { name: "label", type: "string", generated: "{nickname}", dense: true },
      { name: "known_as", type: "string", generated: "({nickname})" },
      { name: "since", type: "date", identity: "created" },
    ],
  }));
  expect(r.ok).toBe(true);
  return v;
}
const PERSON = "Datanotes/main/public/person";

describe("generated and identity columns on write", () => {
  it("an empty generated value is kept as null on a dense column and left out otherwise", async () => {
    const v = await people();
    expect((await insertRow(v.app, v.settings, { table: "person", values: { name: "Ada", nickname: "Countess" } })).ok).toBe(true);
    expect((await insertRow(v.app, v.settings, { table: "person", values: { name: "Ted" } })).ok).toBe(true);
    expect(fm(v, `${PERSON}/Ada.md`)).toMatchObject({ label: "Countess", known_as: "(Countess)" });
    const ted = fm(v, `${PERSON}/Ted.md`);
    expect([ted.label, "known_as" in ted]).toEqual([null, false]);
  });

  it("identity: created on a date column takes today's date in the database time zone", async () => {
    const v = await people();
    expect((await insertRow(v.app, v.settings, { table: "person", values: { name: "Ada" } })).ok).toBe(true);
    expect(fm(v, `${PERSON}/Ada.md`).since).toBe(romeToday());
  });

  it("check_table reports a stored value where the computed one is empty", async () => {
    const v = await people();
    expect((await insertRow(v.app, v.settings, { table: "person", values: { name: "Ted" } })).ok).toBe(true);
    const text = v.read(`${PERSON}/Ted.md`);
    v.write(`${PERSON}/Ted.md`, text.replace("label: null", "label: Teddy\nknown_as: (Teddy)"));
    const check = await checkTable(v.app, v.settings, { table: "person" });
    expect(check.violations.flatMap((x) => x.violations.map((y) => [x.path, y.column, y.message, y.value]))).toEqual([
      [`${PERSON}/Ted.md`, "label", "should be null (computed)", "Teddy"],
      [`${PERSON}/Ted.md`, "known_as", "should be null (computed)", "(Teddy)"],
    ]);
  });
});

describe("fillIdentities", () => {
  it("a note not yet on disk takes the current time for identity: created; an existing one its file's creation", async () => {
    const v = await romeVault();
    await createTable(v.app, v.settings, described({
      name: "book",
      options: { filename: "{title}" },
      columns: [
        { name: "title", type: "string", identity: "filename" },
        { name: "added_at", type: "datetime", identity: "created" },
      ],
    }));
    const book = await loadTable(v.app, v.settings, "book");
    const path = "Datanotes/main/public/book/Dune.md";
    expect(fileCreated(v.app, path)).toBeUndefined();
    const t0 = Date.now();
    const filled = Object.fromEntries(await fillIdentities(v.app, v.settings, book, [["table", "main.public.book"]], path));
    expect(filled.title).toBe("Dune");
    expect(String(filled.added_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/);
    expect(Math.abs(Date.parse(String(filled.added_at)) - t0)).toBeLessThan(5_000);

    v.write(path, "---\ntable: main.public.book\n---\n");
    const created = fileCreated(v.app, path);
    expect(typeof created === "number" && created > 0).toBe(true);
    const existing = Object.fromEntries(await fillIdentities(v.app, v.settings, book, [["table", "main.public.book"]], path));
    expect(Math.abs(Date.parse(String(existing.added_at)) - created!)).toBeLessThan(1_000);
    // a value already there is kept
    const kept = await fillIdentities(v.app, v.settings, book, [["table", "main.public.book"], ["added_at", "2020-01-01T10:00:00+01:00"]], path);
    expect(Object.fromEntries(kept).added_at).toBe("2020-01-01T10:00:00+01:00");
  });
});

describe("normalizeDatetimes", () => {
  const columns = [col({ name: "at", type: "datetime" }), col({ name: "reminders", type: "list", items: "datetime" }), col({ name: "tags", type: "list", items: "string" })];

  it("completes date-times, one by one in a list, with the database time zone", () => {
    const row: [string, unknown][] = [
      ["at", "2026-10-06T08:30"],
      ["reminders", ["2026-10-06T07:00", "2026-12-24T18:00:30", "2026-10-06T09:00:00Z"]],
      ["tags", ["2026-10-06T07:00"]],
    ];
    expect(normalizeDatetimes(columns, row, "Europe/Rome")).toEqual([
      ["at", "2026-10-06T08:30:00+02:00"],
      ["reminders", ["2026-10-06T07:00:00+02:00", "2026-12-24T18:00:30+01:00", "2026-10-06T09:00:00Z"]],
      ["tags", ["2026-10-06T07:00"]],
    ]);
  });

  it("a single value in a list column is completed as it is; empty values and no time zone change nothing", () => {
    expect(normalizeDatetimes(columns, [["reminders", "2026-10-06T07:00"]], "Europe/Rome")).toEqual([["reminders", "2026-10-06T07:00:00+02:00"]]);
    const untouched: [string, unknown][] = [["at", null], ["reminders", []]];
    expect(normalizeDatetimes(columns, untouched, "Europe/Rome")).toBe(untouched);
    const naive: [string, unknown][] = [["at", "2026-10-06T08:30"]];
    expect(normalizeDatetimes(columns, naive, "")).toBe(naive);
  });
});
