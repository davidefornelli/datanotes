import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeWithDefaults,
  type DatanotesSettings,
} from "../src/core/settings";

describe("mergeWithDefaults", () => {
  it("returns defaults for empty input", () => {
    expect(mergeWithDefaults({})).toEqual(DEFAULT_SETTINGS);
  });

  it("merges partial settings", () => {
    const merged = mergeWithDefaults({
      fileLogEnabled: false,
      autoRecompute: false,
    });
    expect(merged).toEqual({
      ...DEFAULT_SETTINGS,
      fileLogEnabled: false,
      autoRecompute: false,
    });
  });

  it("repairs links after a hand move by default; repairLinksOnHandMove false turns it off, a value that is no boolean keeps it", () => {
    expect(DEFAULT_SETTINGS.repairLinksOnHandMove).toBe(true);
    expect(mergeWithDefaults({ repairLinksOnHandMove: false }).repairLinksOnHandMove).toBe(false);
    expect(mergeWithDefaults({ repairLinksOnHandMove: "no" as never }).repairLinksOnHandMove).toBe(true);
  });

  it("ignores unknown top-level keys (forward compatibility)", () => {
    const merged = mergeWithDefaults({
      futureFeatureFlag: true,
      tableKey: "kind",
    } as Partial<DatanotesSettings> & { futureFeatureFlag?: boolean });
    expect(merged.tableKey).toBe("kind");
    expect(
      (merged as DatanotesSettings & { futureFeatureFlag?: boolean })
        .futureFeatureFlag,
    ).toBeUndefined();
  });

  it("ignores settings of removed features in older saves", () => {
    expect(
      mergeWithDefaults({
        tableKey: "kind",
        schemaFolder: "_templates",
        templateProperty: "fileClass",
        migrationsProperty: "_migrations",
        journalFolder: "_meta/migrations",
      } as Partial<DatanotesSettings> & Record<string, unknown>),
    ).toEqual({ ...DEFAULT_SETTINGS, tableKey: "kind" });
  });

  it("rejects an invalid tableKey", () => {
    expect(mergeWithDefaults({ tableKey: "" })).toEqual(DEFAULT_SETTINGS);
    expect(mergeWithDefaults({ tableKey: 99 as never })).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects invalid unknownFieldStrategy values", () => {
    expect(
      mergeWithDefaults({
        unknownFieldStrategy: "drop" as never,
      }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("accepts append_bottom for unknownFieldStrategy", () => {
    expect(
      mergeWithDefaults({ unknownFieldStrategy: "append_bottom" }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects non-boolean toggles", () => {
    expect(
      mergeWithDefaults({
        reorderFields: "yes" as never,
        fillEmptyWithDefaults: 1 as never,
      }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("skips keys explicitly set to undefined", () => {
    expect(
      mergeWithDefaults({
        tableKey: undefined,
      } as Partial<DatanotesSettings>),
    ).toEqual(DEFAULT_SETTINGS);
  });
});

describe("semantic search settings", () => {
  it("default off and validate merges", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ semanticEnabled: false, semanticProvider: "ollama", semanticScope: "vault", telemetryEnabled: false });
    const m = mergeWithDefaults({
      semanticEnabled: true,
      semanticProvider: "openrouter",
      semanticBaseUrl: "https://x.test/v1/",
      semanticModel: " qwen/qwen3-embedding-0.6b ",
      semanticScope: "tables",
      semanticExclude: ["/Templates/", "", 3 as never],
      semanticBatchSize: 16,
    });
    expect(m).toMatchObject({
      semanticEnabled: true,
      semanticProvider: "openrouter",
      semanticBaseUrl: "https://x.test/v1",
      semanticModel: "qwen/qwen3-embedding-0.6b",
      semanticScope: "tables",
      semanticExclude: ["Templates"],
      semanticBatchSize: 16,
    });
    const bad = mergeWithDefaults({ semanticProvider: "nope" as never, semanticBaseUrl: "ftp://x", semanticScope: "all" as never, semanticBatchSize: 0 });
    expect(bad).toMatchObject({ semanticProvider: "ollama", semanticBaseUrl: "", semanticScope: "vault", semanticBatchSize: 32 });
  });
});
