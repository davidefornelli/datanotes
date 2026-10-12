import { describe, expect, it } from "vitest";
import {
  AmbiguousCatalogRefError,
  entryToOrdered,
  MetastoreError,
  orderedToEntry,
  parseMetastore,
  refOf,
  resolveCatalogRef,
  rowTableFull,
  setConfig,
  setTableEntry,
} from "../src/core/metastore";
import { METASTORE } from "./helpers/db-vault";

const TEXT = `# Life database
config:
  default_catalog: personal
catalogs:
  personal:
    description: Life tracking
    schemas:
      metrics:
        tables:
          mood:
            description: Perceived mood # kept on rewrite
            aliases: [feeling]
            options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}" }
            columns:
              - { name: occurred_at, type: datetime, required: true, dense: true }
              - { name: value, type: integer, description: "1-5" }
      public:
        tables:
          log:
            columns: [{ name: text, type: string }]
  agent:
    schemas:
      public:
        tables:
          log:
            columns: [{ name: text, type: string }]
          skill:
            columns: [{ name: name, type: string }]
`;

const SETTINGS = { tableKey: "table" };

describe("metastore", () => {
  it("parses catalogs, schemas and tables and validates names", () => {
    const m = parseMetastore(TEXT);
    expect(Object.keys(m.catalogs)).toEqual(["personal", "agent"]);
    expect(m.catalogs.personal!.schemas.metrics!.tables.mood!.description).toBe("Perceived mood");
    expect(parseMetastore("")).toEqual({ config: {}, bases: {}, catalogs: {} });
    expect(() => parseMetastore("catalogs:\n  Bad:\n    schemas: {}\n")).toThrow(MetastoreError);
    expect(() => parseMetastore("catalogs:\n  system:\n    schemas: {}\n")).toThrow(/reserved/);
  });

  it("resolves 3-, 2- and 1-part names through the default catalog", () => {
    const m = parseMetastore(TEXT);
    expect(resolveCatalogRef(m, "agent.public.log")?.full).toBe("agent.public.log");
    expect(resolveCatalogRef(m, "public.log")?.full).toBe("personal.public.log");
    expect(resolveCatalogRef(m, "public.skill")?.full).toBe("agent.public.skill");
    expect(resolveCatalogRef(m, "mood")?.full).toBe("personal.metrics.mood");
    expect(resolveCatalogRef(m, `${METASTORE}#personal.metrics.mood`)?.full).toBe("personal.metrics.mood");
    expect(() => resolveCatalogRef(m, "log")).toThrow(AmbiguousCatalogRefError);
    expect(resolveCatalogRef(m, "nothing")).toBeNull();
    expect(rowTableFull(m, "metrics.mood")).toBe("personal.metrics.mood");
    expect(rowTableFull(m, "log")).toBeNull();
    expect(rowTableFull(m, 3)).toBeNull();
  });

  it("round-trips an entry through the engine's ordered form", () => {
    const m = parseMetastore(TEXT);
    const ref = refOf("personal", "metrics", "mood");
    const entry = m.catalogs.personal!.schemas.metrics!.tables.mood!;
    const ordered = entryToOrdered(ref, entry, SETTINGS);
    expect(ordered[0]).toEqual(["table", "personal.metrics.mood"]);
    expect(ordered.find(([k]) => k === "_columns")![1]).toEqual([
      { name: "occurred_at", type: "datetime", required: true },
      { name: "value", type: "integer", description: "1-5" },
    ]);
    expect(orderedToEntry(ordered, entry, SETTINGS)).toEqual(entry);
  });

  it("edits keep comments and the rest of the file", () => {
    const ref = refOf("personal", "metrics", "energy");
    const out = setTableEntry(TEXT, ref, { description: "Energy", columns: [{ name: "value", type: "integer" }] });
    expect(out).toContain("# Life database");
    expect(out).toContain("# kept on rewrite");
    expect(parseMetastore(out).catalogs.personal!.schemas.metrics!.tables.energy!.description).toBe("Energy");
    const removed = setTableEntry(out, refOf("personal", "metrics", "mood"), null);
    expect(Object.keys(parseMetastore(removed).catalogs.personal!.schemas.metrics!.tables)).toEqual(["energy"]);
    const fresh = setTableEntry("", refOf("main", "public", "x"), { columns: [] });
    expect(Object.keys(parseMetastore(fresh).catalogs)).toEqual(["main"]);
    expect(parseMetastore(setConfig(TEXT, { timezone: "Europe/Rome" })).config).toEqual({ default_catalog: "personal", timezone: "Europe/Rome" });
  });

  it("writes what is added to an emptied mapping in block style, like the rest of the file", () => {
    const ref = refOf("main", "public", "a");
    const emptied = setTableEntry(setTableEntry("", ref, { columns: [{ name: "x", type: "string" }] }), ref, null);
    expect(emptied).toContain("tables: {}");
    const out = setTableEntry(emptied, refOf("main", "public", "b"), { description: "B", columns: [{ name: "y", type: "string" }] });
    expect(out).toContain("        tables:\n          b:\n            description: B\n");
    expect(out).not.toContain("{");
  });
});
