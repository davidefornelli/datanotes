import { describe, expect, it } from "vitest";
import { configureDatabase, readDatabaseConfig } from "../src/core/database";
import { parse as parseYaml } from "yaml";
import { addColumn, createTable, dropTable, INDEX_RETRY } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { alterTable, insertRow, select } from "../src/core/rows";
import { listTables } from "../src/core/table-registry";
import type { TableOptions } from "../src/core/types-table";
import { createDbVault, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const COLUMNS = [
  { name: "occurred_at", type: "datetime", required: true, dense: true },
  { name: "value", type: "integer", min: 1, max: 5, dense: true },
];

type Yaml = { config?: Record<string, unknown>; catalogs: Record<string, { schemas: Record<string, { tables: Record<string, Record<string, unknown>> }> }> };
const metastore = (v: { read(p: string): string }, root = "Datanotes") => parseYaml(v.read(`${root}/metastore.yaml`)) as Yaml;
const entry = (v: { read(p: string): string }, full: string, root = "Datanotes") => {
  const [c, s, t] = full.split(".");
  return metastore(v, root).catalogs[c!]?.schemas[s!]?.tables[t!];
};
const row = (v: { read(p: string): string }, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);

describe("database configuration", () => {
  it("defaults without configuration; create_table writes metastore.yaml, rows declare their table", async () => {
    const v = createDbVault({});
    expect(await readDatabaseConfig(v.app, v.settings)).toEqual({
      default_catalog: "main",
      default_schema: "public",
      default_partition: "",
      default_filename: "YYYY-MM-DD[T]HHmm",
      archive_folder: "_archive",
      timezone: "",
      // a database not created yet reads as the engine creates it: history on
      history: true,
      autolink: true,
    });
    const r = await createTable(v.app, v.settings, described({ schema: "metrics", name: "sleep_quality", timeColumn: "occurred_at", columns: COLUMNS }));
    expect(r.ok).toBe(true);
    expect(r.planned_creates).toEqual([]);
    expect(r.planned_texts).toEqual([METASTORE]);
    // the new database's metastore says so, first in the file
    expect(v.read(METASTORE)).toMatch(/^# Metastore .*\n(id: [0-9a-f-]{36}\n)?config:\n  history: true\n\n?catalogs:/);
    expect((await readDatabaseConfig(v.app, v.settings)).history).toBe(true);
    expect(entry(v, "main.metrics.sleep_quality")).toMatchObject({
      options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}", archive: "_archive" },
      columns: [
        { name: "id", type: "string", identity: "uuid", unique: true, required: true, dense: true },
        { name: "occurred_at", type: "datetime", required: true, dense: true },
        { name: "value", type: "integer", min: 1, max: 5, dense: true },
      ],
    });
    const ins = await insertRow(v.app, v.settings, { table: "metrics.sleep_quality", values: { occurred_at: "2026-09-26T22:30", value: 3 } });
    expect(ins.planned_creates).toEqual(["Datanotes/main/metrics/sleep_quality/2026-09-26T2230.md"]);
    const created = v.read("Datanotes/main/metrics/sleep_quality/2026-09-26T2230.md");
    expect(created).toMatch(/^---\ntable: main\.metrics\.sleep_quality\nid: [0-9a-f-]{36}\n/);
    expect(created).not.toContain("template");
    const pub = await createTable(v.app, v.settings, described({ name: "contact", columns: [{ name: "name", type: "string" }], options: { filename: "{name}" } }));
    expect(pub.ok).toBe(true);
    expect(listTables(v.app, v.settings.databaseFolder).map((t) => t.qualified)).toEqual(["main.metrics.sleep_quality", "main.public.contact"]);
    const dup = await createTable(v.app, v.settings, described({ catalog: "main", schema: "public", name: "contact", columns: [{ name: "name", type: "string" }], options: { filename: "{name}" } }));
    expect(dup.ok).toBe(false);
    expect(dup.conflicts.map((c) => c.message)).toEqual(["main.public.contact already exists"]);
  });

  it("history: on in a new database, as configured or absent (off) in an existing one", async () => {
    // configure_database creates the database: history on unless it says otherwise
    const created = createDbVault({});
    await configureDatabase(created.app, created.settings, { timezone: "Europe/Paris" }, async () => {});
    expect(parseYaml(created.read(METASTORE)).config).toMatchObject({ history: true, timezone: "Europe/Paris" });
    const off = createDbVault({});
    await configureDatabase(off.app, off.settings, { history: false }, async () => {});
    expect(parseYaml(off.read(METASTORE)).config.history).toBe(false);
    // an existing database keeps what its metastore says, and no `history` means off
    const existing = createDbVault({ [METASTORE]: "config:\n  timezone: Europe/Paris\ncatalogs: {}\n" });
    expect((await readDatabaseConfig(existing.app, existing.settings)).history).toBe(false);
    await createTable(existing.app, existing.settings, described({ name: "contact", columns: [{ name: "name", type: "string" }], options: { filename: "{name}" } }));
    expect(parseYaml(existing.read(METASTORE)).config).toEqual({ timezone: "Europe/Paris" });
  });

  it("a row can live anywhere: membership comes from its table property", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    v.write("Journal/today.md", "---\ntable: metrics.mood\noccurred_at: 2026-09-26T09:00\nvalue: 4\n---\nA free note.\n");
    v.write("Other/x.md", "---\ntable: metrics.other\n---\n");
    const res = await select(v.app, v.settings, { table: "main.metrics.mood" });
    expect(res.rows.map((r) => [r.path, r.value])).toEqual([["Journal/today.md", 4]]);
    expect(Object.keys(res.rows[0]!)).not.toContain("table");
    const add = await addColumn(v.app, v.settings, described({ table: "mood", column: { name: "note", type: "string", description: "Free text" } }));
    expect(add.ok).toBe(true);
    expect(add.planned_texts).toEqual([METASTORE]);
    expect((entry(v, "main.metrics.mood")!.columns as Record<string, unknown>[]).map((c) => c.name)).toEqual(["id", "occurred_at", "value", "note"]);
    expect((entry(v, "main.metrics.mood")!.columns as Record<string, unknown>[])[3]).toEqual({ name: "note", type: "string", description: "Free text" });
  });

  it("a date time column names rows by the date only", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ name: "day", timeColumn: "date", columns: [{ name: "date", type: "date", required: true }] }));
    const r = await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-10-06" } });
    expect(r.planned_creates).toEqual(["Datanotes/main/public/day/2026-10-06.md"]);
  });

  it("refuses bad names, a missing file name rule and absolute paths", async () => {
    const v = createDbVault({});
    await expect(createTable(v.app, v.settings, described({ name: "Bad-Name", columns: COLUMNS }))).rejects.toThrow(/lowercase/);
    await expect(createTable(v.app, v.settings, described({ name: "x", columns: COLUMNS }))).rejects.toThrow(/time_column/);
    await expect(createTable(v.app, v.settings, described({ name: "x", timeColumn: "value", columns: COLUMNS }))).rejects.toThrow(/date or datetime/);
    await expect(
      createTable(v.app, v.settings, described({ name: "x", timeColumn: "occurred_at", columns: COLUMNS, options: { path: "Else" } as never })),
    ).rejects.toThrow(/partition/);
  });

  it("configure_database stores defaults in metastore.yaml, used by new tables", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { default_partition: "YYYY", default_filename: "YYYY-MM-DD", default_schema: "misc", default_catalog: "personal" }, async () => {});
    expect(metastore(v).config).toMatchObject({ default_catalog: "personal", default_schema: "misc", default_partition: "YYYY", default_filename: "YYYY-MM-DD" });
    const r = await createTable(v.app, v.settings, described({ name: "notes", timeColumn: "occurred_at", columns: COLUMNS }));
    expect(r.ok).toBe(true);
    expect(entry(v, "personal.misc.notes")!.options).toMatchObject({ partition: "{occurred_at:YYYY}", filename: "{occurred_at:YYYY-MM-DD}" });
    await expect(configureDatabase(v.app, v.settings, { default_partition: "{x}" }, async () => {})).rejects.toThrow(/date format/);
    await expect(configureDatabase(v.app, v.settings, { archive_folder: "a/b" }, async () => {})).rejects.toThrow(/single folder/);
    await expect(configureDatabase(v.app, v.settings, { default_catalog: "Bad" }, async () => {})).rejects.toThrow(/lowercase/);
  });

  it("configure_database renames the database folder; tables keep their names", async () => {
    const VIEW = '# Today\nFROM "Datanotes"\n';
    const v = createDbVault({ "Views/today.md": VIEW });
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    let saved = 0;
    const d = await configureDatabase(v.app, v.settings, { root: "db" }, async () => {
      saved++;
    });
    expect(saved).toBe(1);
    expect(v.settings.databaseFolder).toBe("db");
    expect(d.root).toBe("db");
    expect(v.read("Views/today.md")).toBe(VIEW); // notes are addressed by table name, not by folder: left alone
    expect(d.metastore).toBe("db/metastore.yaml");
    expect(d.catalogs).toEqual([
      { catalog: "main", default: true, schemas: [{ schema: "metrics", tables: [{ name: "mood", qualified: "main.metrics.mood", row_count: 1, description: "Test table mood" }], views: [] }] },
    ]);
    expect(listTables(v.app, "db").map((t) => t.qualified)).toEqual(["main.metrics.mood"]);
    const ins = await insertRow(v.app, v.settings, { table: "metrics.mood", values: { occurred_at: "2026-09-27T09:00", value: 3 } });
    expect(ins.planned_creates).toEqual(["db/main/metrics/mood/2026-09-27T0900.md"]);
    await expect(configureDatabase(v.app, v.settings, { root: "db/inner" }, async () => {})).rejects.toThrow(/inside/);
  });

  it("configure_database moves the tables' archive and exclude folders inside the database folder with it", async () => {
    const template = "---\ntable: main.public.book\ntitle: New book\n---\n";
    const v = createDbVault({ "Datanotes/main/public/book/Templates/New book.md": template, "Drafts/Old.md": "---\ntable: main.public.book\ntitle: Old\n---\n" });
    const options = { filename: "{title}", exclude: ["Datanotes/main/public/book/Templates", "Drafts"], archive: "Datanotes/old/books" };
    expect((await createTable(v.app, v.settings, described({ name: "book", options, columns: [{ name: "title", type: "string" }] }))).ok).toBe(true);
    // one folder (or alias) given as a string, not a list
    const note = { filename: "{title}", exclude: "Datanotes/main/public/note/Templates", aliases: "jottings" } as unknown as TableOptions;
    expect((await createTable(v.app, v.settings, described({ name: "note", options: note, columns: [{ name: "title", type: "string" }] }))).ok).toBe(true);
    expect(entry(v, "main.public.note")).toMatchObject({ aliases: ["jottings"], options: { exclude: "Datanotes/main/public/note/Templates" } });
    await insertRow(v.app, v.settings, { table: "book", values: { title: "Dune" } });
    expect((await select(v.app, v.settings, { table: "book" })).total).toBe(1);
    v.write(METASTORE, `# kept\n${v.read(METASTORE)}`);
    await configureDatabase(v.app, v.settings, { root: "Data" }, async () => {});
    expect(entry(v, "main.public.book", "Data")!.options).toEqual({ filename: "{title}", archive: "Data/old/books", exclude: ["Data/main/public/book/Templates", "Drafts"] });
    expect(entry(v, "main.public.note", "Data")!.options).toMatchObject({ exclude: "Data/main/public/note/Templates" });
    expect(v.read("Data/metastore.yaml").startsWith("# kept\n")).toBe(true);
    expect((await select(v.app, v.settings, { table: "book", columns: ["title"] })).rows.map((r) => r.title)).toEqual(["Dune"]);
  });
});

describe("alter_table", () => {
  it("moves a table to another schema and renames it, rows follow, no paths stored", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    const r = await alterTable(v.app, v.settings, { table: "metrics.mood", schema: "wellbeing" });
    expect(r.ok).toBe(true);
    // a new database keeps history: its transaction log follows the table too
    expect(r.planned_moves.some((m) => m.from.includes("transaction_log"))).toBe(true);
    expect(r.planned_moves.filter((m) => !m.from.includes("transaction_log"))).toEqual([
      { from: "Datanotes/main/metrics/mood/2026-09-26T0900.md", to: "Datanotes/main/wellbeing/mood/2026-09-26T0900.md" },
    ]);
    expect(entry(v, "main.metrics.mood")).toBeUndefined();
    expect(entry(v, "main.wellbeing.mood")!.options).toEqual({ filename: "{occurred_at:YYYY-MM-DD[T]HHmm}", archive: "_archive" });
    expect(row(v, "Datanotes/main/wellbeing/mood/2026-09-26T0900.md").table).toBe("main.wellbeing.mood");
    const ren = await alterTable(v.app, v.settings, { table: "wellbeing.mood", name: "feeling", description: "Feeling" });
    expect(ren.ok).toBe(true);
    expect(listTables(v.app, v.settings.databaseFolder).map((t) => t.qualified)).toEqual(["main.wellbeing.feeling"]);
    expect(entry(v, "main.wellbeing.feeling")!.description).toBe("Feeling");
    expect((await select(v.app, v.settings, { table: "wellbeing.feeling" })).total).toBe(1);
    const cat = await alterTable(v.app, v.settings, { table: "feeling", catalog: "personal" });
    expect(cat.ok).toBe(true);
    expect(cat.planned_moves.filter((m) => !m.from.includes("transaction_log"))).toEqual([
      { from: "Datanotes/main/wellbeing/feeling/2026-09-26T0900.md", to: "Datanotes/personal/wellbeing/feeling/2026-09-26T0900.md" },
    ]);
    expect(Object.keys(metastore(v).catalogs.main!.schemas.wellbeing?.tables ?? {})).toEqual([]);
    expect(row(v, "Datanotes/personal/wellbeing/feeling/2026-09-26T0900.md").table).toBe("personal.wellbeing.feeling");
  });

  it("drop_table removes the entry from metastore.yaml and archives the rows", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    const refused = await dropTable(v.app, v.settings, { table: "mood" });
    expect(refused.ok).toBe(false);
    const r = await dropTable(v.app, v.settings, { table: "mood", mode: "archive" });
    expect(r.ok).toBe(true);
    expect(r.planned_moves).toEqual([{ from: "Datanotes/main/metrics/mood/2026-09-26T0900.md", to: "Datanotes/main/metrics/mood/_archive/2026-09-26T0900.md" }]);
    expect(entry(v, "main.metrics.mood")).toBeUndefined();
    expect(listTables(v.app, v.settings.databaseFolder)).toEqual([]);
  });

  it("falls back to moving files one by one when the folder cannot be renamed", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    const fm = v.app.fileManager as unknown as { renameFile: (f: { path: string }, to: string) => Promise<void> };
    const original = fm.renameFile.bind(fm);
    fm.renameFile = async (f, to) => {
      if (!("extension" in f)) {
        // like a folder-notes plugin reacting to the new folder, then Windows refusing the rename
        v.write("db/metastore.yaml", "");
        throw new Error("EPERM: operation not permitted, rename");
      }
      return original(f, to);
    };
    const vault = v.app.vault as unknown as { delete: (f: { path: string }, force?: boolean) => Promise<void> };
    vault.delete = async (f) => {
      if ("extension" in f) await (v.app.vault as unknown as { trash: (f: unknown) => Promise<void> }).trash(f);
    };
    await configureDatabase(v.app, v.settings, { root: "db" }, async () => {});
    expect(v.settings.databaseFolder).toBe("db");
    expect(listTables(v.app, "db").map((t) => t.qualified)).toEqual(["main.metrics.mood"]);
    expect(v.read("db/main/metrics/mood/2026-09-26T0900.md")).toContain("value: 2");
  });

  it("partition \"\" flattens a table: rows move up into the table folder", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { default_partition: "YYYY/MM" }, async () => {});
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: COLUMNS }));
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 2 } });
    await insertRow(v.app, v.settings, { table: "mood", values: { occurred_at: "2026-09-26T09:00", value: 3 } });
    const r = await alterTable(v.app, v.settings, { table: "metrics.mood", partition: "" });
    expect(r.ok).toBe(true);
    expect(r.planned_moves).toEqual([
      { from: "Datanotes/main/metrics/mood/2026/09/2026-09-26T0900-2.md", to: "Datanotes/main/metrics/mood/2026-09-26T0900-2.md" },
      { from: "Datanotes/main/metrics/mood/2026/09/2026-09-26T0900.md", to: "Datanotes/main/metrics/mood/2026-09-26T0900.md" },
    ]);
    expect(entry(v, "main.metrics.mood")!.options).toEqual({ filename: "{occurred_at:YYYY-MM-DD[T]HHmm}", archive: "_archive" });
    await configureDatabase(v.app, v.settings, { default_partition: "" }, async () => {});
    expect((await readDatabaseConfig(v.app, v.settings)).default_partition).toBe("");
  });

  it("alter_table(exclude) drops notes in those folders from the table instead of moving them", async () => {
    const v = createDbVault({});
    await createTable(v.app, v.settings, described({ schema: "journal", name: "day", options: { filename: "{date:YYYY-MM-DD}" }, columns: [{ name: "date", type: "date", required: true, unique: true, dense: true }] }));
    await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-09-28" } });
    v.write("Templates/template-daily.md", "---\ntable: journal.day\ndate: <% tp.file.title %>\n---\n");
    const r = await alterTable(v.app, v.settings, { table: "day", exclude: ["Templates"] });
    expect(r.ok).toBe(true);
    expect(r.planned_moves).toEqual([]);
    expect(v.read("Templates/template-daily.md")).toContain("<% tp.file.title %>");
    expect((await select(v.app, v.settings, { table: "day" })).total).toBe(1);
  });
});
