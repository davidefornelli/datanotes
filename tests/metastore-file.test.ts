import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyChangeSet, emptyChangeSet } from "../src/core/changeset";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import type { TFile } from "../src/core/host";
import { parseMetastore, resolveCatalogRef } from "../src/core/metastore";
import { listTablesAndViews } from "../src/core/public-api";
import { select } from "../src/core/rows";
import { mergeWithDefaults } from "../src/core/settings";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { openNodeVault } from "../src/node/node-app";
import { EngineRuntime } from "../src/server/runtime";
import { createDbVault, LOG_YAML, METASTORE, TEST_DATABASE_FOLDER } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

/** The metastore's name before Datanotes 3: not read any more (the user renames it by hand before upgrading). */
const OLD = "Datanotes/database.yaml";
const A = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: alcohol\noccurred_at: 2026-09-25T22:30\n---\nA\n";

describe("metastore.yaml", () => {
  it("ignores database.yaml: the vault looks empty and the first DDL starts metastore.yaml next to it", async () => {
    const v = createDbVault({ [OLD]: LOG_YAML, "Daily/a.md": A });
    expect((await listTablesAndViews(v.app, v.settings)).tables).toEqual([]);
    await expect(select(v.app, v.settings, { table: "log" })).rejects.toThrow("Table not found: log");
    expect(resolveCatalogRef(parseMetastore(LOG_YAML), `${OLD}#main.public.log`)).toBeNull();

    const r = await createTable(v.app, v.settings, described({ name: "person", columns: [{ name: "name", type: "string" }], options: { filename: "{name}" } }));
    expect(r.ok).toBe(true);
    expect(r.planned_texts).toEqual([METASTORE]);
    expect(Object.keys(parseMetastore(v.read(METASTORE)).catalogs.main!.schemas.public!.tables)).toEqual(["person"]);
    expect(v.read(OLD)).toBe(LOG_YAML);
  });

  it("refuses the undo of an operation journaled on database.yaml once the file is renamed by hand", async () => {
    const v = createDbVault({ [OLD]: LOG_YAML });
    // What Datanotes 1 and 2 journaled for a DDL: the whole text of the file before and after.
    const after = `${LOG_YAML}# edited by an operation\n`;
    const cs = emptyChangeSet("alter_table", "alter table main.public.log", `${OLD}#main.public.log`);
    cs.texts.push({ path: OLD, before: LOG_YAML, after });
    const old = await applyChangeSet(v.app, v.settings, cs);
    expect(old.ok).toBe(true);
    await v.app.fileManager.renameFile(v.file(OLD), METASTORE); // the upgrade
    const u = await undoOperation(v.app, v.settings, old.migrationId);
    expect(u.ok).toBe(false);
    expect(u.conflicts).toEqual([{ path: OLD, message: "text changed since the operation" }]);
    expect(v.read(METASTORE)).toBe(after);
  });
});

describe("metastore.yaml in the service runtime", () => {
  /** A vault on disk with `text` as its metastore, and a runtime on it (not started). */
  const open = (text: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "metastore-file-"));
    fs.mkdirSync(path.join(root, "Datanotes"));
    fs.writeFileSync(path.join(root, METASTORE), text);
    const host = openNodeVault(root);
    const settings = mergeWithDefaults({ fileLogEnabled: false, autoRecompute: false, databaseFolder: TEST_DATABASE_FOLDER });
    const runtime = new EngineRuntime({
      app: host.app,
      getSettings: () => settings,
      saveSettings: async () => {},
      transport: async () => ({ status: 500, text: "" }),
      embeddingKey: () => undefined,
      version: "test",
      hostName: "test",
      canServeHttp: false,
    });
    return { root, host, runtime };
  };
  /**
   * Up to 1.5 s by the clock, not by a count of timers (one takes about 16 ms on Windows): well
   * before the transaction log reads the metastore too, 3 s after the last change, so only the
   * runtime's own handler can have re-read it.
   */
  const until = async (done: () => boolean) => {
    const end = Date.now() + 1500;
    while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  };

  it("re-reads the metastore when metastore.yaml is created, deleted or renamed (the change feed off)", async () => {
    const { root, host, runtime } = open(LOG_YAML);
    await runtime.start({ http: false });
    try {
      // The change feed re-reads the metastore too (after its debounce): here only the runtime's own handlers react.
      runtime.changeFeed!.stop();
      const { vault, fileManager } = host;
      const file = (p: string) => vault.getAbstractFileByPath(p)!;
      const tables = () => runtime.api.listTables().map((t) => t.qualified);
      const settle = async (want: string[]) => {
        await until(() => JSON.stringify(tables()) === JSON.stringify(want));
        expect(tables()).toEqual(want);
      };
      expect(tables()).toEqual(["main.public.log"]);

      // A checkout deletes metastore.yaml, then creates it again.
      await vault.delete(file(METASTORE));
      await settle([]);
      await vault.create(METASTORE, LOG_YAML);
      await settle(["main.public.log"]);

      // Renamed away, changed meanwhile, renamed back: read again, not taken from the cache.
      await fileManager.renameFile(file(METASTORE), "Datanotes/old.yaml");
      await settle([]);
      fs.writeFileSync(path.join(root, "Datanotes/old.yaml"), LOG_YAML.replace("log:", "other:"));
      await fileManager.renameFile(file("Datanotes/old.yaml"), METASTORE);
      await settle(["main.public.other"]);
    } finally {
      await runtime.stop();
      host.metadataCache.dispose();
    }
  });

  it("starts the change feed once the metastore changes and can be read", async () => {
    const logs: string[] = [];
    setTelemetry({ log: (_s, body) => logs.push(body), flush: async () => {} });
    const { host, runtime } = open("catalogs: [\n"); // broken YAML
    try {
      await runtime.start({ http: false });
      expect(runtime.changeFeed).toBeNull();
      expect(logs).toContain("datanotes could not read metastore.yaml");
      expect(logs).toContain("datanotes change feed not running: it starts the next time metastore.yaml changes and can be read");

      // Fixed: the modify event re-reads it, and the change feed starts (no restart).
      await host.vault.process(host.vault.getAbstractFileByPath(METASTORE) as TFile, () => LOG_YAML);
      await until(() => runtime.changeFeed !== null);
      expect(runtime.changeFeed).not.toBeNull();
      expect(runtime.api.listTables().map((t) => t.qualified)).toEqual(["main.public.log"]);
    } finally {
      await runtime.stop();
      host.metadataCache.dispose();
      setTelemetry(NOOP_TELEMETRY);
    }
  });
});
