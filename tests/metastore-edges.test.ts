import { describe, expect, it } from "vitest";
import { docsUrl } from "../src/core/hints";
import {
  AmbiguousCatalogRefError,
  baseChain,
  cachedMetastore,
  type CatalogTableEntry,
  defaultCatalog,
  effectiveColumns,
  entryToOrdered,
  inheritedColumns,
  loadMetastore,
  MetastoreError,
  orderedToEntry,
  parseMetastore,
  primeMetastore,
  rebaseTablePaths,
  refOf,
  resolveCatalogRef,
  setBaseEntry,
  setConfig,
  tableTags,
  withNewDatabaseConfig,
  withTableTags,
} from "../src/core/metastore";
import { MalformedColumnError, tableDefinitionFromOrdered } from "../src/core/table-loader";
import { createDbVault, METASTORE } from "./helpers/db-vault";

const TEXT = `# Life and work database
config:
  default_catalog: personal
  timezone: Europe/Rome
bases:
  dated:
    description: Rows that happened at a moment
    columns:
      - { name: occurred_at, type: datetime, required: true, dense: true, description: When it happened }
  tracked:
    bases: [dated]
    columns:
      - { name: created_at, type: datetime, identity: created }
  nested:
    columns:
      - { name: parent, type: link, ref: self, hierarchy: true }
  retired:
    description: Rows that can be archived
    columns:
      - { name: archived_at, type: datetime }
catalogs:
  personal:
    description: Life tracking
    schemas:
      health:
        tables:
          mood:
            description: Perceived mood
            aliases: [feeling]
            tags: { domain: health }
            bases: [tracked]
            options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}", history: false }
            columns:
              - { name: id, type: string, identity: uuid, unique: true, required: true }
              - { name: occurred_at, label: When }
              - { name: value, type: integer, min: 1, max: 5, description: "1-5" }
  work:
    schemas:
      planning:
        tables:
          project:
            bases: [nested]
            columns:
              - { name: title, type: string, required: true, dense: true }
`;

const SETTINGS = { tableKey: "table" };
const MODEL = parseMetastore(TEXT);
const MOOD_REF = refOf("personal", "health", "mood");
const MOOD = MODEL.catalogs.personal!.schemas.health!.tables.mood!;

/** What `fn` throws: its class and its message (toThrow compares the message only). */
function refusal(fn: () => unknown): [unknown, string] {
  try {
    fn();
  } catch (e) {
    return [(e as Error).constructor, (e as Error).message];
  }
  return [undefined, "no refusal"];
}

/** A metastore whose schema personal.health holds `body` (YAML written as if `health:` were the root). */
const health = (body: string) =>
  `catalogs:\n  personal:\n    schemas:\n      health:\n${body
    .trimEnd()
    .split("\n")
    .map((l) => `        ${l}`)
    .join("\n")}\n`;

describe("parseMetastore refuses a malformed file", () => {
  it.each<[string, string, string]>([
    ["a list", "- personal\n- work\n", "metastore.yaml must be a mapping"],
    ["a sentence", "my second brain\n", "metastore.yaml must be a mapping"],
    ["config as a list", "config: [Europe/Rome]\n", "config must be a mapping"],
    ["catalogs as a list", "catalogs: [personal, work]\n", "catalogs must be a mapping"],
    ["a catalog that is a word", "catalogs:\n  personal: Life tracking\n", "catalogs.personal must be a mapping"],
    ["schemas as a list", "catalogs:\n  personal:\n    schemas: [health]\n", "catalogs.personal.schemas must be a mapping"],
    ["a schema that is a word", "catalogs:\n  personal:\n    schemas:\n      health: Body and mind\n", "catalogs.personal.schemas.health must be a mapping"],
    ["tables as a list", health("tables: [mood]"), "catalogs.personal.schemas.health: tables and views must be mappings"],
    ["views as a list", health("tables: {}\nviews: [low_mood]"), "catalogs.personal.schemas.health: tables and views must be mappings"],
    ["a table with nothing under it", health("tables:\n  mood:"), "personal.health.mood must be a mapping"],
    ["a table that is a word", health("tables:\n  mood: Perceived mood"), "personal.health.mood must be a mapping"],
    ["columns as a mapping", health("tables:\n  mood:\n    columns: { name: value, type: integer }"), "personal.health.mood.columns must be a list of mappings"],
    ["a column that is a word", health("tables:\n  mood:\n    columns: [value]"), "personal.health.mood.columns must be a list of mappings"],
    ["a view without a query", health("views:\n  low_mood: { description: Bad days }"), "personal.health.low_mood: a view needs a query mapping"],
    ["a view that is a word", health("views:\n  low_mood: personal.health.mood"), "personal.health.low_mood: a view needs a query mapping"],
    ["a view whose query is text", health('views:\n  low_mood: { query: "select * from mood" }'), "personal.health.low_mood: a view needs a query mapping"],
    [
      "a table and a view with the same name",
      health("tables:\n  mood: { columns: [] }\nviews:\n  mood: { query: { table: personal.health.mood } }"),
      "personal.health.mood is both a table and a view",
    ],
    ["extends as a word", `bases:\n  dated: { columns: [] }\n${health("tables:\n  mood: { bases: dated }")}`, "personal.health.mood: bases must be a list of base names"],
    ["extends with a number", `bases:\n  dated: { columns: [] }\n${health("tables:\n  mood: { bases: [1] }")}`, "personal.health.mood: bases must be a list of base names"],
    ["extends of an unknown base", `bases:\n  dated: { columns: [] }\n${health("tables:\n  mood: { bases: [timestamped] }")}`, 'personal.health.mood: unknown base "timestamped"'],
    ["bases as a list", "bases: [dated]\n", "bases must be a mapping"],
    ["a base that is a word", "bases:\n  dated: occurred_at\n", "bases.dated must be a mapping"],
    ["base columns as a mapping", "bases:\n  dated:\n    columns: { name: occurred_at, type: datetime }\n", "bases.dated.columns must be a list of mappings"],
    ["a base column that is a word", "bases:\n  dated:\n    columns: [occurred_at]\n", "bases.dated.columns must be a list of mappings"],
    ["a base extends as a word", "bases:\n  dated: { columns: [] }\n  tracked: { bases: dated }\n", "bases.tracked: bases must be a list of base names"],
    ["two bases that extend each other", "bases:\n  dated: { bases: [tracked] }\n  tracked: { bases: [dated] }\n", "bases: inheritance cycle dated → tracked → dated"],
    ["a base that extends itself", "bases:\n  dated: { bases: [dated] }\n", "bases: inheritance cycle dated → dated"],
  ])("refuses %s", (_what, text, message) => {
    expect(refusal(() => parseMetastore(text))).toEqual([MetastoreError, message]);
  });

  it("reads a schema written with nothing under it as empty, and a base without columns as having none", () => {
    const text = "bases:\n  tagged:\n    description: Rows with tags\ncatalogs:\n  personal:\n    description: Life tracking\n    schemas:\n      health:\n      metrics: {}\n";
    expect(parseMetastore(text)).toEqual({
      config: {},
      bases: { tagged: { description: "Rows with tags", columns: [] } },
      catalogs: { personal: { description: "Life tracking", schemas: { health: { tables: {}, views: {} }, metrics: { tables: {}, views: {} } } } },
    });
  });
});

describe("bases", () => {
  it("lists bases parents first, each once", () => {
    expect(baseChain(MODEL.bases, ["tracked", "dated", "nested"])).toEqual(["dated", "tracked", "nested"]);
  });

  it("refuses a base the metastore does not define", () => {
    expect(refusal(() => baseChain(MODEL.bases, ["timestamped"]))).toEqual([MetastoreError, 'unknown base "timestamped"']);
    expect(refusal(() => inheritedColumns(MODEL, ["dated", "timestamped"], "personal.health.walk"))).toEqual([MetastoreError, 'unknown base "timestamped"']);
  });

  const TWO = parseMetastore(`bases:
  dated:
    columns:
      - { name: occurred_at, type: datetime, required: true, dense: true, description: When it happened }
  event:
    columns:
      - { name: occurred_at, type: datetime, required: true, label: Start }
      - { name: location, type: string }
      - { name: related, type: list, items: link, ref: self }
  daily:
    columns:
      - { name: occurred_at, type: date, required: true }
`);

  it("inherits a column two bases define alike but for its presentation once, from the first; ref: self is the table", () => {
    expect(inheritedColumns(TWO, ["dated", "event"], "personal.health.walk")).toEqual([
      { column: { name: "occurred_at", type: "datetime", required: true, dense: true, description: "When it happened" }, base: "dated" },
      { column: { name: "location", type: "string" }, base: "event" },
      { column: { name: "related", type: "list", items: "link", ref: "personal.health.walk" }, base: "event" },
    ]);
    expect(inheritedColumns(TWO, undefined, "personal.health.walk")).toEqual([]);
  });

  it("refuses a column two bases define differently", () => {
    expect(refusal(() => inheritedColumns(TWO, ["dated", "daily"], "personal.health.walk"))).toEqual([
      MetastoreError,
      'personal.health.walk: column "occurred_at" comes from bases dated and daily with different definitions',
    ]);
  });

  it("gives a table the system id, its inherited columns (restyled where it says so), then its own", () => {
    expect(effectiveColumns(MODEL, MOOD_REF, MOOD)).toEqual([
      { name: "id", type: "string", identity: "uuid", unique: true, required: true },
      { name: "occurred_at", type: "datetime", required: true, dense: true, description: "When it happened", label: "When" },
      { name: "created_at", type: "datetime", identity: "created" },
      { name: "value", type: "integer", min: 1, max: 5, description: "1-5" },
    ]);
    const restated = { ...MOOD, columns: [{ name: "occurred_at", type: "datetime", required: true, note: "[[Mood scale]]" }] };
    expect(effectiveColumns(MODEL, MOOD_REF, restated)[0]).toEqual({ name: "occurred_at", type: "datetime", required: true, dense: true, description: "When it happened", note: "[[Mood scale]]" });
  });

  it("refuses a table that redefines an inherited column", () => {
    const redefined = { ...MOOD, columns: [{ name: "occurred_at", type: "date", label: "Day" }] };
    expect(refusal(() => effectiveColumns(MODEL, MOOD_REF, redefined))).toEqual([
      MetastoreError,
      'personal.health.mood: column "occurred_at" is inherited from base "dated"; change the base (a table may only change label, description, aliases, note, dense)',
    ]);
  });

  it("removes a base and keeps the rest of the file", () => {
    const out = setBaseEntry(TEXT, "retired", null);
    const { retired: _retired, ...kept } = MODEL.bases;
    expect(parseMetastore(out)).toEqual({ ...MODEL, bases: kept });
    expect(out.startsWith("# Life and work database\n")).toBe(true);
    expect(out).not.toContain("archived");
  });
});

describe("table tags", () => {
  /** The tags of table personal.health.sleep written by hand as `tags: <yaml>` (or with no tags line). */
  const tagsOf = (yaml: string | null) =>
    tableTags(parseMetastore(health(`tables:\n  sleep:\n${yaml === null ? "" : `    tags: ${yaml}\n`}    columns: []`)).catalogs.personal!.schemas.health!.tables.sleep!);

  it("reads every tag value as text", () => {
    expect(tagsOf("\n      domain: health\n      reviewed:\n      owner: { team: data }\n      priority: 2\n      private: true")).toEqual({
      domain: "health",
      reviewed: "",
      owner: '{"team":"data"}',
      priority: "2",
      private: "true",
    });
  });

  it("reads a list of words or one word as tags with an empty value, skipping blank ones", () => {
    expect(tagsOf('[health, " nightly ", " ", ~, 2026]')).toEqual({ health: "", nightly: "", "2026": "" });
    expect(tagsOf("health")).toEqual({ health: "" });
  });

  it("is undefined for a table without tags", () => {
    expect(tagsOf(null)).toBeUndefined();
    expect(tagsOf("[]")).toBeUndefined();
    expect(tagsOf("{}")).toBeUndefined();
    expect(tagsOf('""')).toBeUndefined();
  });

  it("writes tags after comment and aliases, and drops the key when there are none", () => {
    const tagged = withTableTags(MOOD, { domain: "health", nightly: "" });
    expect(Object.keys(tagged)).toEqual(["description", "aliases", "tags", "bases", "options", "columns"]);
    expect(tagged.tags).toEqual({ domain: "health", nightly: "" });
    expect(Object.keys(withTableTags({ columns: [] }, { domain: "work" }))).toEqual(["tags", "columns"]);
    // nothing after comment and aliases: the tags go last
    expect(withTableTags({ description: "Moods", aliases: ["mood"] } as never, { domain: "health" })).toEqual({ description: "Moods", aliases: ["mood"], tags: { domain: "health" } });
    expect(Object.keys(withTableTags({ description: "Moods", tags: { old: "x" } } as never, { domain: "health" }))).toEqual(["description", "tags"]);
    const untagged = withTableTags(MOOD, {});
    expect(Object.keys(untagged)).toEqual(["description", "aliases", "bases", "options", "columns"]);
  });
});

describe("default catalog and short names", () => {
  const TWO_CATALOGS = `catalogs:
  personal:
    schemas:
      planning:
        tables:
          person: { columns: [{ name: name, type: string }] }
  work:
    schemas:
      planning:
        tables:
          person: { columns: [{ name: name, type: string }] }
          project: { columns: [{ name: title, type: string }] }
`;

  it("is the configured one, else the only catalog, else none", () => {
    expect(defaultCatalog(MODEL)).toBe("personal");
    expect(defaultCatalog(parseMetastore(health("tables: {}")))).toBe("personal");
    expect(defaultCatalog(parseMetastore(TWO_CATALOGS))).toBeUndefined();
    expect(defaultCatalog(parseMetastore(`config:\n  default_catalog: ""\n${TWO_CATALOGS}`))).toBeUndefined();
  });

  it("resolves schema.table in any catalog when there is no default catalog, refusing an ambiguous one", () => {
    const m = parseMetastore(TWO_CATALOGS);
    expect(resolveCatalogRef(m, "planning.project")).toEqual(refOf("work", "planning", "project"));
    expect(refusal(() => resolveCatalogRef(m, "planning.person"))).toEqual([
      AmbiguousCatalogRefError,
      '"planning.person" matches personal.planning.person, work.planning.person; use catalog.schema.table',
    ]);
  });
});

describe("entryToOrdered / orderedToEntry", () => {
  it("passes a column written without a name on to the loader, which refuses it", () => {
    const ref = refOf("personal", "health", "sleep");
    const entry: CatalogTableEntry = { columns: [{ type: "string", description: "Untitled" }, { name: "hours", type: "number" }] };
    const ordered = entryToOrdered(ref, entry, SETTINGS);
    expect(ordered).toEqual([
      ["table", "personal.health.sleep"],
      ["_table", [{ name: "sleep" }]],
      ["_columns", [{ type: "string", description: "Untitled" }, { name: "hours", type: "number" }]],
    ]);
    expect(refusal(() => tableDefinitionFromOrdered(ref, `${METASTORE}#${ref.full}`, ordered, { databaseFolder: "Datanotes" }))).toEqual([
      MalformedColumnError,
      `columns[0]: "name" must start with a letter and contain only letters, digits, "_" or "-"`,
    ]);
  });

  it("reads an ordered form without _columns or properties as a table with no columns", () => {
    expect(orderedToEntry([["table", "personal.health.sleep"], ["type", "sleep"], ["_table", [{ name: "sleep" }]]], undefined, SETTINGS)).toEqual({
      fields: { type: "sleep" },
      columns: [],
    });
  });

  it("writes an inherited column back only as its restyling, and not at all when unchanged", () => {
    const ordered = entryToOrdered(MOOD_REF, MOOD, SETTINGS, MODEL);
    const columns = ordered.find(([k]) => k === "_columns")![1] as Record<string, unknown>[];
    expect(columns.find((c) => c.name === "occurred_at")).toEqual({ name: "occurred_at", type: "datetime", required: true, description: "When it happened", label: "When" });
    const restyled = ordered.map(([k, v]): [string, unknown] =>
      k === "_columns" ? [k, columns.map((c) => (c.name === "occurred_at" ? { name: "occurred_at", type: "datetime", required: true, label: "Moment" } : c))] : [k, v],
    );
    expect(orderedToEntry(restyled, MOOD, SETTINGS, { model: MODEL, ref: MOOD_REF })).toEqual({
      description: "Perceived mood",
      aliases: ["feeling"],
      tags: { domain: "health" },
      bases: ["tracked"],
      options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}", history: false },
      columns: [
        { name: "id", type: "string", identity: "uuid", unique: true, required: true },
        { name: "occurred_at", label: "Moment" },
        { name: "value", type: "integer", min: 1, max: 5, description: "1-5" },
      ],
    });
  });

  it("refuses an inherited column changed beyond its presentation", () => {
    const ordered = entryToOrdered(MOOD_REF, MOOD, SETTINGS, MODEL).map(([k, v]): [string, unknown] =>
      k === "_columns" ? [k, (v as Record<string, unknown>[]).map((c) => (c.name === "occurred_at" ? { ...c, type: "date" } : c))] : [k, v],
    );
    expect(refusal(() => orderedToEntry(ordered, MOOD, SETTINGS, { model: MODEL, ref: MOOD_REF }))).toEqual([
      MetastoreError,
      'personal.health.mood: column "occurred_at" is inherited from base "dated": change the base (only label, description, aliases, note, dense can differ)',
    ]);
  });
});

describe("rebaseTablePaths", () => {
  const PATHS = health(`tables:
  mood:
    options:
      archive: Datanotes
      exclude: [Datanotes/personal/_trash, Templates]
    columns: []
  sleep:
    options:
      archive: Archive/sleep
      exclude: Datanotes/
    columns: []
  weight:
    options:
      archive: Datanotes/old/weight
    columns: []`);

  it("moves an archive or exclude folder that is the old database folder or inside it, and nothing else", () => {
    const m = parseMetastore(rebaseTablePaths(PATHS, "Datanotes", "Data"));
    // an archive without "/" is a folder name inside the table's folder, even when it reads like the database folder
    expect(m.catalogs.personal!.schemas.health!.tables.mood!.options).toEqual({ archive: "Datanotes", exclude: ["Data/personal/_trash", "Templates"] });
    expect(m.catalogs.personal!.schemas.health!.tables.sleep!.options).toEqual({ archive: "Archive/sleep", exclude: "Data" });
    expect(m.catalogs.personal!.schemas.health!.tables.weight!.options).toEqual({ archive: "Data/old/weight" });
  });

  it("returns the text unchanged when no path moves", () => {
    expect(rebaseTablePaths(PATHS, "Vault", "Data")).toBe(PATHS);
  });
});

describe("metastore cache", () => {
  it("forgets the cached model when a text that does not parse or validate is primed; the next load reads the file", async () => {
    const v = createDbVault({ [METASTORE]: TEXT });
    const loaded = await loadMetastore(v.app, v.settings);
    expect(cachedMetastore(v.app, v.settings)).toBe(loaded!.model);
    expect(cachedMetastore(v.app, { databaseFolder: "Data" })).toBeNull();

    primeMetastore(v.app, v.settings, setConfig(TEXT, { timezone: "UTC" }));
    expect(cachedMetastore(v.app, v.settings)!.config).toEqual({ default_catalog: "personal", timezone: "UTC" });
    primeMetastore(v.app, v.settings, "catalogs: [personal, work]\n");
    expect(cachedMetastore(v.app, v.settings)).toBeNull();
    primeMetastore(v.app, v.settings, TEXT);
    primeMetastore(v.app, v.settings, "catalogs: { personal: [\n");
    expect(cachedMetastore(v.app, v.settings)).toBeNull();

    expect((await loadMetastore(v.app, v.settings))!.model.config).toEqual({ default_catalog: "personal", timezone: "Europe/Rome" });
    expect(cachedMetastore(v.app, v.settings)!.config).toEqual({ default_catalog: "personal", timezone: "Europe/Rome" });
  });
});

describe("metastore.yaml in the words before 3.0", () => {
  it("is refused, naming the key and the word to write instead", () => {
    const refusal = (text: string) => {
      try {
        parseMetastore(text);
      } catch (e) {
        return e as MetastoreError;
      }
      throw new Error("not refused");
    };
    const table = (body: string) => `catalogs:\n  main:\n    schemas:\n      public:\n        tables:\n          film:\n${body}`;
    const e = refusal(table("            comment: Films\n            columns: []\n"));
    expect(e).toBeInstanceOf(MetastoreError);
    expect(e.message).toBe('main.public.film: "comment" is not a key of metastore.yaml: write "description"');
    expect(e.hint).toMatch(/uses the operations' words: description, required, options, fields and bases/);
    expect(e.docs).toBe(docsUrl("metastoreWords"));
    expect(refusal(table("            properties: { filename: \"{title}\" }\n            columns: []\n")).message).toMatch(/"properties" is not a key of metastore\.yaml: write "options"$/);
    expect(refusal(table("            extends: [dated]\n            columns: []\n")).message).toMatch(/"extends" is not a key of metastore\.yaml: write "bases"$/);
    expect(refusal("bases:\n  dated: { columns: [] }\n  tracked: { extends: [dated], columns: [] }\n").message).toBe('bases.tracked: "extends" is not a key of metastore.yaml: write "bases"');
    expect(refusal(table("            defaults: { kind: film }\n            columns: []\n")).message).toMatch(/"defaults" .* write "fields"$/);
    expect(refusal(table("            columns:\n              - { name: title, type: string, nullable: false }\n")).message).toBe(
      'main.public.film.columns[0]: "nullable" is not a key of metastore.yaml: write "required: true" for "nullable: false"',
    );
    expect(refusal("catalogs:\n  main:\n    comment: Everything\n").message).toMatch(/^catalogs\.main: "comment"/);
    expect(refusal("bases:\n  dated:\n    columns:\n      - { name: day, type: date, comment: The day }\n").message).toMatch(/^bases\.dated\.columns\[0\]: "comment" .* write "description"$/);
  });
});

describe("the metastore of a database the engine creates", () => {
  it("gets history on, first after its leading comments, unless it sets it", () => {
    expect(withNewDatabaseConfig("{}")).toBe("config:\n  history: true\n");
    expect(withNewDatabaseConfig("# Garden database\ncatalogs: {}\n")).toBe("# Garden database\nconfig:\n  history: true\ncatalogs: {}\n");
    expect(parseMetastore(withNewDatabaseConfig("config: {}\n")).config).toEqual({ history: true });
    expect(parseMetastore(withNewDatabaseConfig("config:\n  default_catalog: garden\n")).config).toEqual({ default_catalog: "garden", history: true });
  });

  it("is left as written when it sets history, or cannot be read (the write reports it)", () => {
    expect(withNewDatabaseConfig("config:\n  history: false\n")).toBe("config:\n  history: false\n");
    expect(withNewDatabaseConfig("- a list\n")).toBe("- a list\n");
  });
});

describe("edits of the metastore's text and its cache", () => {
  it("setTableEntries edits several tables in one parse, as one edit after the other would", async () => {
    const { refOf, setTableEntries, setTableEntry, parseMetastore: parse } = await import("../src/core/metastore");
    const { withTables } = await import("./helpers/db-vault");
    const text = withTables("a:\n  columns:\n    - { name: x, type: string }\n# a comment kept\nb:\n  columns:\n    - { name: y, type: integer }\n");
    const a = refOf("main", "public", "a");
    const c = refOf("main", "other", "c");
    const entry = parse(text).catalogs.main!.schemas.public!.tables.b!;
    const oneByOne = setTableEntry(setTableEntry(text, a, null), c, entry);
    expect(setTableEntries(text, [[a, null], [c, entry]])).toBe(oneByOne);
    expect(setTableEntries(text, [])).toBe(text);
    expect(oneByOne).toContain("# a comment kept");
  });

  it("primeWrittenMetastore keeps the text written with the file's stat: the next load reads nothing", async () => {
    const { loadMetastore, primeWrittenMetastore } = await import("../src/core/metastore");
    const { createDbVault, METASTORE, withTables } = await import("./helpers/db-vault");
    const v = createDbVault({ [METASTORE]: withTables("a:\n  columns:\n    - { name: x, type: string }\n") });
    // a host whose adapter tells a file's size and time, as Obsidian's does
    const fs = await import("node:fs");
    (v.app.vault.adapter as { stat?: (p: string) => Promise<{ size: number; mtime: number } | null> }).stat = async (p) => {
      const s = fs.statSync(v.abs(p), { throwIfNoEntry: false });
      return s ? { size: s.size, mtime: s.mtimeMs } : null;
    };
    // characters of two, three and four bytes in UTF-8: the size on disk is the text's
    const text = withTables("a:\n  description: Notes 📝 and €\n  columns:\n    - { name: x, type: string }\n    - { name: é, type: string }\n");
    v.write(METASTORE, text); // as the engine wrote it
    await primeWrittenMetastore(v.app, v.settings, text);
    const vault = v.app.vault as unknown as { read(f: unknown): Promise<string> };
    const read = vault.read.bind(vault);
    let reads = 0;
    vault.read = async (f) => {
      reads++;
      return read(f);
    };
    expect((await loadMetastore(v.app, v.settings))!.text).toBe(text);
    expect(reads).toBe(0);
    // a text of another length on disk (an edit by hand right after): primed without the stat, read again
    await primeWrittenMetastore(v.app, v.settings, `${text}# not what the file holds\n`);
    expect((await loadMetastore(v.app, v.settings))!.text).toBe(text);
    expect(reads).toBe(1);
  });
});
