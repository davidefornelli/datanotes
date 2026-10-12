/**
 * Engine paths the other suites leave out: a row the index lists but whose front matter cannot be
 * read (refused, or left out on request), a rollback logged at the write's own time, hand edits
 * whose YAML no longer parses or whose table can no longer be checked, the checks of hand edits
 * failing as a whole, column rules checked on raw columns, and rename_value carrying the value
 * descriptions of the other values along.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyChangeSet } from "../src/core/changeset";
import { configureDatabase } from "../src/core/database";
import {
  checkColumnRefs,
  finish,
  INDEX_RETRY,
  loadRows,
  loadTable,
  logExternalEdits,
  logHandEditsFirst,
  OperationInputError,
  renameValue,
} from "../src/core/engine";
import * as externalEdits from "../src/core/external-edits";
import { fmSet, readOrderedFromMarkdown } from "../src/core/frontmatter";
import type { TFile } from "../src/core/host";
import { describeHistory } from "../src/core/history";
import { listMigrations } from "../src/core/journal";
import { loadMetastore, parseMetastore } from "../src/core/metastore";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { LOG_DIR, LOG_YAML, logVault, METASTORE, withTables, createDbVault, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;
afterEach(() => {
  vi.restoreAllMocks();
  setTelemetry(NOOP_TELEMETRY);
});

/** Collect the telemetry log lines. */
function logLines(): { severity: string; body: string; attrs: Record<string, unknown> }[] {
  const logs: { severity: string; body: string; attrs: Record<string, unknown> }[] = [];
  setTelemetry({ log: (severity, body, attrs = {}) => logs.push({ severity, body, attrs }), flush: async () => {} });
  return logs;
}

/** The log vault with time travel on: the hand edits of its rows become EXTERNAL_EDIT commits. */
async function historyVault(): Promise<DbVault> {
  const v = logVault();
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  await logExternalEdits(v.app, v.settings); // the first version of the log table
  return v;
}

const top = async (v: DbVault) => (await describeHistory(v.app, v.settings, { table: "log", limit: 1 })).history[0]!;

describe("loadRows on a row whose front matter cannot be read", () => {
  /** A row the index still lists (it has not caught up with the hand edit) whose YAML is broken. */
  function staleIndex(): DbVault {
    const path = `${LOG_DIR}/broken.md`;
    const v = logVault({ [path]: "---\ntable: main.public.log\nkind: [walk\n---\nBroken.\n" });
    const cache = v.app.metadataCache as unknown as { getFileCache(f: TFile): unknown };
    const real = cache.getFileCache.bind(cache);
    vi.spyOn(cache, "getFileCache").mockImplementation((f: TFile) => (f.path === path ? { frontmatter: { table: "main.public.log" } } : real(f)));
    return v;
  }

  it("fails the read by default", async () => {
    const v = staleIndex();
    const t = await loadTable(v.app, v.settings, "log");
    await expect(loadRows(v.app, v.settings, t)).rejects.toThrow();
  });

  it("leaves the row out when asked to skip unreadable rows", async () => {
    const v = staleIndex();
    const t = await loadTable(v.app, v.settings, "log");
    const rows = await loadRows(v.app, v.settings, t, true);
    expect(rows.map((r) => r.file.path)).toEqual(["Daily/a.md", "Daily/b.md"]);
  });
});

describe("a write that fails before writing anything", () => {
  it("is rolled back and logged at the time the write was given", async () => {
    const v = await historyVault();
    const before = v.read("Daily/a.md");
    const ordered = readOrderedFromMarkdown(before).ordered;
    const cs = emptyChangeSet("custom", "one edit");
    cs.edits.push({ path: "Daily/a.md", before: ordered, after: fmSet(ordered, "metric_drinks", 1) });
    const fm = v.app.fileManager as unknown as { processFrontMatter(f: TFile, fn: (fm: Record<string, unknown>) => void): Promise<void> };
    vi.spyOn(fm, "processFrontMatter").mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));
    const now = new Date("2026-10-01T09:00:00Z");
    const r = await finish(v.app, v.settings, cs, [], [], { now });
    expect(r).toMatchObject({ ok: false, rolled_back: true });
    expect(v.read("Daily/a.md")).toBe(before);
    const { migrations } = await listMigrations(v.app, v.settings);
    expect(migrations.find((m) => m.migration_id === r.migration_id)).toMatchObject({ undone: true, notes_changed: 0 });
  });
});

describe("hand edits on the transaction log", () => {
  it("a table changed by hand whose rows cannot be checked is logged, uncounted, with a warning", async () => {
    const v = await historyVault();
    const logs = logLines();
    vi.spyOn(externalEdits, "checkChangedTables").mockResolvedValueOnce({ byTable: new Map([["main.public.log", []]]), errors: new Map([["main.public.log", "rows unavailable"]]) });
    v.write(METASTORE, v.read(METASTORE).replace("max: 30", "max: 40"));
    await loadMetastore(v.app, v.settings); // as the change feed reloads it
    await logExternalEdits(v.app, v.settings);
    const c = await top(v);
    expect(c.operation).toBe("EXTERNAL_EDIT");
    expect(c.operationMetrics).toMatchObject({ metadataChanged: true });
    expect(c.operationMetrics.violations).toBeUndefined();
    expect(logs.filter((l) => l.body === "datanotes could not check a table changed by hand")).toEqual([
      { severity: "WARN", body: "datanotes could not check a table changed by hand", attrs: { table: "main.public.log", error: "rows unavailable" } },
    ]);
  });

  it("when the checks fail as a whole, the edits are still logged, uncounted, with a warning", async () => {
    const v = await historyVault();
    const logs = logLines();
    vi.spyOn(externalEdits, "checkExternalEdits").mockRejectedValueOnce(new Error("index unavailable"));
    v.write("Daily/a.md", v.read("Daily/a.md").replace("metric_drinks: 7", "metric_drinks: 2"));
    await logExternalEdits(v.app, v.settings);
    const c = await top(v);
    expect(c.operation).toBe("EXTERNAL_EDIT");
    expect(c.operationMetrics.violations).toBeUndefined();
    expect(logs.filter((l) => l.body === "datanotes could not check hand edits")).toEqual([
      { severity: "WARN", body: "datanotes could not check hand edits", attrs: { tables: 1, error: "index unavailable" } },
    ]);
  });

  it("the hand edits logged before an engine write carry the time given", async () => {
    const v = await historyVault();
    v.write("Daily/b.md", v.read("Daily/b.md").replace("kind: mood", "kind: walk"));
    const now = new Date("2026-10-02T07:30:00Z");
    const commits = await logHandEditsFirst(v.app, v.settings, now);
    expect(commits.map((c) => c.operation)).toEqual(["EXTERNAL_EDIT"]);
    expect(new Date((await top(v)).timestamp).toISOString()).toBe(now.toISOString());
  });
});

describe("checkColumnRefs on raw columns", () => {
  const model = parseMetastore(LOG_YAML);

  it("refuses a hierarchy column without ref", () => {
    expect(() => checkColumnRefs(model, "main.public.log", [{ name: "up", type: "link", hierarchy: true }], "main.public.log")).toThrow(
      new OperationInputError(`main.public.log.up: "hierarchy" needs ref: self`),
    );
  });

  it("leaves the ref of a column that is not a link alone", () => {
    expect(() => checkColumnRefs(model, "main.public.log", [{ name: "topic", type: "string", ref: "main.public.nothing" }], "main.public.log")).not.toThrow();
  });

  it("finds no level to check in a ref_by with neither levels nor a map", () => {
    expect(() => checkColumnRefs(model, "main.public.log", [{ name: "after", type: "link", ref: "self", ref_by: { column: "kind" } }], "main.public.log")).not.toThrow();
  });
});

describe("rename_value", () => {
  it("keeps the descriptions of the other values where they are", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(`fact:
  options:
    filename: "{what}"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: what, type: string, required: true }
    - name: origin
      type: enum
      values: [stated, estimated]
      value_descriptions:
        stated: the user said it
        estimated: a guess of the agent
`),
    });
    const r = await renameValue(v.app, v.settings, { table: "fact", column: "origin", from: "estimated", to: "guessed" });
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    const origin = parseMetastore(v.read(METASTORE)).catalogs.main!.schemas.public!.tables.fact!.columns.find((c) => c.name === "origin")!;
    expect(origin.values).toEqual(["stated", "guessed"]);
    expect(origin.value_descriptions).toEqual({ stated: "the user said it", guessed: "a guess of the agent" });
  });
});

describe("hand edits logged before an engine write", () => {
  it("carry the time of the call when none is given", async () => {
    const v = await historyVault();
    v.write("Daily/b.md", v.read("Daily/b.md").replace("kind: mood", "kind: walk"));
    const start = Date.now();
    expect((await logHandEditsFirst(v.app, v.settings)).map((c) => c.operation)).toEqual(["EXTERNAL_EDIT"]);
    expect(Date.parse((await top(v)).timestamp)).toBeGreaterThanOrEqual(start - 1000);
  });
});
