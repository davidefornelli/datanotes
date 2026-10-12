/**
 * configure_database and describe_database at their edges: a time zone cleared, views with a
 * comment, a vault without metastore.yaml, roots that are no vault folder or already exist, a
 * root at the top of the vault, and the file-by-file move meeting a note in the way or an old
 * folder that cannot be removed.
 */

import { describe, expect, it } from "vitest";
import { createView } from "../src/core/catalog-ops";
import { configureDatabase, DatabaseConfigError, describeDatabase, readDatabaseConfig } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { insertRow, select } from "../src/core/rows";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

async function refused(p: Promise<unknown>, message: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(DatabaseConfigError);
  await expect(p).rejects.toThrow(message);
}

async function moods(): Promise<DbVault> {
  const v = createDbVault({ "Notes/a.md": "A note.\n" });
  const r = await createTable(v.app, v.settings, described({
    schema: "metrics",
    name: "mood",
    options: { filename: "{label}" },
    columns: [{ name: "label", type: "string" }],
  }));
  expect(r.ok).toBe(true);
  expect((await insertRow(v.app, v.settings, { table: "mood", values: { label: "calm" } })).ok).toBe(true);
  return v;
}

const noSave = async () => {};

describe("configuration", () => {
  it("an empty time zone clears it: date-times are stored as given again", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, noSave);
    expect((await readDatabaseConfig(v.app, v.settings)).timezone).toBe("Europe/Rome");
    const d = await configureDatabase(v.app, v.settings, { timezone: "" }, noSave);
    expect(d.config.timezone).toBe("");
    expect((await readDatabaseConfig(v.app, v.settings)).timezone).toBe("");
  });
});

describe("describe_database", () => {
  it("without metastore.yaml: no catalogs, no bases", async () => {
    const v = createDbVault({});
    expect(await describeDatabase(v.app, v.settings)).toMatchObject({ root: "Datanotes", metastore: "Datanotes/metastore.yaml", catalogs: [], bases: [] });
  });

  it("shows a view's comment", async () => {
    const v = await moods();
    expect((await createView(v.app, v.settings, { schema: "metrics", name: "calm", description: "Calm days", query: { table: "main.metrics.mood", where: { label: "calm" } } })).ok).toBe(true);
    expect((await createView(v.app, v.settings, { schema: "metrics", name: "all_moods", query: { table: "main.metrics.mood" } })).ok).toBe(true);
    const d = await describeDatabase(v.app, v.settings);
    expect(d.catalogs[0]!.schemas[0]!.views).toEqual([
      { name: "calm", qualified: "main.metrics.calm", description: "Calm days" },
      { name: "all_moods", qualified: "main.metrics.all_moods" },
    ]);
  });
});

describe("moving the database folder", () => {
  it("refuses a dot segment, a path that exists (in any case) or one inside the database: each says how to fix it", async () => {
    const v = await moods();
    const DOCS = "https://datanotes.dev/start/how-it-works.md#move-the-vault-or-the-database-folder";
    const refusal = async (root: string) => {
      try {
        await configureDatabase(v.app, v.settings, { root }, noSave);
      } catch (e) {
        expect(e).toBeInstanceOf(DatabaseConfigError);
        const { message, hint, docs } = e as DatabaseConfigError;
        return { message, hint, docs };
      }
      throw new Error(`not refused: ${root}`);
    };
    for (const root of [".hidden", "a/../b", "Data/.git", "Areas/.db/x"]) {
      const r = await refusal(root);
      expect(r.message).toBe(`"root" cannot have a dot segment: "${root}"`);
      expect(r.hint).toContain("Editors hide folders whose name starts with a dot");
      expect(r.docs).toBe(DOCS);
    }
    expect((await refusal("a//b")).message).toBe(`"root" cannot have a empty segment: "a//b"`);
    for (const root of ["Notes", "notes", "NOTES/"]) {
      expect(await refusal(root)).toEqual({ message: `"${root.replace(/\/$/, "")}" already exists in the vault`, hint: "Name a folder that does not exist yet: the engine creates it and moves the database into it.", docs: DOCS });
    }
    expect(await refusal("Datanotes/inner")).toEqual({ message: `"Datanotes/inner" is inside the current database folder Datanotes`, hint: `Name a folder outside Datanotes/, e.g. root: "datanotes".`, docs: DOCS });
    expect(v.settings.databaseFolder).toBe("Datanotes");
    // the same folder: nothing moves
    await configureDatabase(v.app, v.settings, { root: "/Datanotes/" }, noSave);
    expect(v.settings.databaseFolder).toBe("Datanotes");
  });

  it("renames the folder in case only (Datanotes to datanotes), through a temporary name, on file systems that ignore case too", async () => {
    const v = await moods();
    v.write("Notes/Day.md", "See [[Datanotes/main/metrics/mood/calm]].\n");
    await configureDatabase(v.app, v.settings, { root: "datanotes" }, noSave);
    expect(v.settings.databaseFolder).toBe("datanotes");
    const top = v.app.vault.getFiles().map((f) => f.path.split("/")[0]);
    expect(top).toContain("datanotes");
    expect(top).not.toContain("Datanotes");
    expect(top.some((t) => t !== undefined && t.includes("renaming"))).toBe(false);
    expect((await select(v.app, v.settings, { table: "mood", columns: ["label"] })).rows).toEqual([{ path: "datanotes/main/metrics/mood/calm.md", label: "calm" }]);
    // the link follows (in the vault's link format: the full path, or the shortest one)
    expect(v.read("Notes/Day.md")).toMatch(/\[\[(datanotes\/main\/metrics\/mood\/)?calm\]\]/);
    expect(v.read("Notes/Day.md")).not.toContain("Datanotes/");
  });

  it("to the top of the vault: tables and rows follow, the settings are saved", async () => {
    const v = await moods();
    let saved = 0;
    const d = await configureDatabase(v.app, v.settings, { root: "Data" }, async () => {
      saved++;
    });
    expect([v.settings.databaseFolder, saved, d.root, d.metastore]).toEqual(["Data", 1, "Data", "Data/metastore.yaml"]);
    expect((await select(v.app, v.settings, { table: "mood", columns: ["label"] })).rows).toEqual([{ path: "Data/main/metrics/mood/calm.md", label: "calm" }]);
  });

  it("into a folder that does not exist yet: it is created", async () => {
    const v = await moods();
    await configureDatabase(v.app, v.settings, { root: "Areas/Data" }, noSave);
    expect(v.settings.databaseFolder).toBe("Areas/Data");
    expect((await select(v.app, v.settings, { table: "mood", columns: ["label"] })).rows).toEqual([{ path: "Areas/Data/main/metrics/mood/calm.md", label: "calm" }]);
  });

  /** Windows refusing to rename the folder (EPERM): files move one by one. */
  function refuseFolderRename(v: DbVault, onRefuse: () => void = () => {}): void {
    const fm = v.app.fileManager as unknown as { renameFile: (f: { path: string }, to: string) => Promise<void> };
    const original = fm.renameFile.bind(fm);
    fm.renameFile = async (f, to) => {
      if (!("extension" in f)) {
        onRefuse();
        throw new Error("EPERM: operation not permitted, rename");
      }
      return original(f, to);
    };
  }

  it("file by file: a note with content in the way stops the move", async () => {
    const v = await moods();
    // a folder-notes plugin writes a note where the metastore goes
    refuseFolderRename(v, () => v.write("db/metastore.yaml", "My database.\n"));
    await refused(configureDatabase(v.app, v.settings, { root: "db" }, noSave), "cannot move Datanotes/metastore.yaml: db/metastore.yaml already exists");
    expect(v.settings.databaseFolder).toBe("Datanotes");
    expect(v.read("db/metastore.yaml")).toBe("My database.\n");
  });

  it("file by file: an old folder that cannot be removed is left behind", async () => {
    const v = await moods();
    refuseFolderRename(v);
    const vault = v.app.vault as unknown as { delete: (f: { path: string }, force?: boolean) => Promise<void> };
    const remove = vault.delete.bind(vault);
    vault.delete = async (f, force) => {
      if (!("extension" in f)) throw new Error("EBUSY: resource busy or locked, rmdir");
      return remove(f, force);
    };
    await configureDatabase(v.app, v.settings, { root: "db" }, noSave);
    expect(v.settings.databaseFolder).toBe("db");
    expect((await select(v.app, v.settings, { table: "mood", columns: ["label"] })).rows).toEqual([{ path: "db/main/metrics/mood/calm.md", label: "calm" }]);
  });
});

describe("database settings and moves at their edges", () => {
  it("reads a time zone left empty in the file as the empty one", async () => {
    const v = createDbVault({ "Datanotes/metastore.yaml": "config:\n  timezone:\n  default_partition:\ncatalogs: {}\n" });
    const cfg = await readDatabaseConfig(v.app, v.settings);
    expect([cfg.timezone, cfg.default_partition]).toEqual(["", ""]);
  });

  it("refuses the root of the vault when several names of the database are taken there", async () => {
    const v = createDbVault({ "main/notes.md": "mine\n", "metastore.yaml": "mine too\n" });
    expect((await createTable(v.app, v.settings, described({ name: "film", columns: [{ name: "title", type: "string" }], options: { filename: "{title}" } }))).ok).toBe(true);
    await expect(configureDatabase(v.app, v.settings, { root: "" }, async () => {})).rejects.toThrow(/^"root": (metastore\.yaml, main|main, metastore\.yaml) already exist in the vault$/);
  });

  it("moves a database that has no metastore yet to the root of the vault", async () => {
    const v = createDbVault({});
    const d = await configureDatabase(v.app, v.settings, { root: "" }, async () => {});
    expect(d.root).toBe("");
  });
});
