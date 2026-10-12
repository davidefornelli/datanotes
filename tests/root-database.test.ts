/**
 * The database at the root of the folder the engine serves (`datanotes serve --database`): its
 * folder is "", `metastore.yaml` and the catalog folders are at the root, and every path is the
 * vault's own (`main/public/film/Metropolis.md`). Notes beside the catalogs stay plain notes.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localEngine } from "../src/api/local";
import { parseArgs, startService } from "../src/node/service";
import { seedStoreSettings } from "./helpers/store-settings";
import { addColumn, createTable, dropTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { configureDatabase, describeDatabase } from "../src/core/database";
import { describeHistory } from "../src/core/history";
import { createView } from "../src/core/catalog-ops";
import { checkTable, deleteRows, insertRow, select, updateRows } from "../src/core/rows";
import { listMigrations } from "../src/core/journal";
import { metastorePath } from "../src/core/metastore";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

async function films(): Promise<DbVault> {
  const v = createDbVault({ "intro.md": "# My films\n" }, { databaseFolder: "" });
  await configureDatabase(v.app, v.settings, { history: true }, async () => {});
  expect((await createTable(v.app, v.settings, described({ name: "person", columns: [{ name: "name", type: "string", required: true }], options: { filename: "{name}" } }))).ok).toBe(true);
  expect(
    (await createTable(v.app, v.settings, described({
      name: "film",
      columns: [
        { name: "title", type: "string", required: true, unique: true },
        { name: "director", type: "link", ref: "main.public.person" },
        { name: "status", type: "enum", values: ["to watch", "watched"] },
      ],
      options: { filename: "{title}" },
    }))).ok,
  ).toBe(true);
  return v;
}

describe("a database at the root of the folder", () => {
  it("keeps metastore.yaml and the catalogs at the root; paths start with the catalog", async () => {
    const v = await films();
    expect(metastorePath(v.settings)).toBe("metastore.yaml");
    expect(v.exists("metastore.yaml")).toBe(true);
    const lang = await insertRow(v.app, v.settings, { table: "person", values: { name: "Fritz Lang" } });
    expect(lang.planned_creates).toEqual(["main/public/person/Fritz Lang.md"]);
    const film = await insertRow(v.app, v.settings, { table: "film", values: { title: "Metropolis", director: "[[Fritz Lang]]", status: "to watch" } });
    expect(film.ok).toBe(true);
    expect(film.planned_creates).toEqual(["main/public/film/Metropolis.md"]);
    expect(v.read("main/public/film/Metropolis.md")).toContain("director: \"[[Fritz Lang]]\"");
    // the link resolves across the root paths
    const rows = await select(v.app, v.settings, { table: "film", columns: ["title"], where: { "director.name": "Fritz Lang" } });
    expect(rows.rows).toEqual([expect.objectContaining({ path: "main/public/film/Metropolis.md", title: "Metropolis" })]);
    // a note beside the catalogs is a plain note, not a row
    expect(v.read("intro.md")).toBe("# My films\n");
    expect((await checkTable(v.app, v.settings, { table: "film" })).violations).toEqual([]);
    const db = await describeDatabase(v.app, v.settings);
    expect(db).toMatchObject({ root: "", metastore: "metastore.yaml" });
  });

  it("updates, archives, deletes, undoes and keeps the history with root paths", async () => {
    const v = await films();
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Metropolis", status: "to watch" } });
    expect((await updateRows(v.app, v.settings, { table: "film", where: { title: "Metropolis" }, set: { status: "watched" } })).ok).toBe(true);
    const add = await addColumn(v.app, v.settings, described({ table: "film", column: { name: "year", type: "integer" } }));
    expect(add.ok).toBe(true);
    const del = await deleteRows(v.app, v.settings, { table: "film", where: { title: "Metropolis" }, mode: "archive" });
    expect(del.ok).toBe(true);
    expect(v.exists("main/public/film/_archive/Metropolis.md")).toBe(true);
    expect((await undoOperation(v.app, v.settings, del.migration_id!)).ok).toBe(true);
    expect(v.exists("main/public/film/Metropolis.md")).toBe(true);
    const history = (await describeHistory(v.app, v.settings, { table: "film" })).history;
    expect(history.length).toBeGreaterThan(2);
    const { migrations } = await listMigrations(v.app, v.settings, { table: "main.public.film" });
    expect(migrations.length).toBeGreaterThan(2);
  });

  it("moves into a folder and back to the root: only the database's names move, links follow, undo still works", async () => {
    const v = await films();
    const ins = await insertRow(v.app, v.settings, { table: "film", values: { title: "Metropolis", status: "to watch" } });
    v.write("intro.md", "# My films\n\nNext: [[main/public/film/Metropolis]] and [notes](main/public/film/Metropolis.md).\n");
    // into a folder
    let d = await configureDatabase(v.app, v.settings, { root: "films" }, async () => {});
    expect(d.root).toBe("films");
    expect(v.exists("films/metastore.yaml") && v.exists("films/main/public/film/Metropolis.md")).toBe(true);
    expect(v.exists("metastore.yaml") || v.exists("main")).toBe(false);
    // the links follow (the Node host writes them shortest, as Obsidian does): none points to the old place
    const linksTo = (t: string) => [...t.matchAll(/\[\[([^\]|]+)|\]\(([^)]+)\)/g)].map((m) => m[1] ?? m[2]!);
    expect(linksTo(v.read("intro.md")).filter((l) => l.startsWith("main/"))).toEqual([]);
    // back to the root
    d = await configureDatabase(v.app, v.settings, { root: "" }, async () => {});
    expect(d.root).toBe("");
    expect(v.exists("metastore.yaml") && v.exists("main/public/film/Metropolis.md")).toBe(true);
    expect(v.exists("films")).toBe(false);
    expect(linksTo(v.read("intro.md")).filter((l) => l.startsWith("films/"))).toEqual([]);
    // the insert made before both moves is undone where the row is now
    expect((await undoOperation(v.app, v.settings, ins.migration_id!)).ok).toBe(true);
    expect(v.exists("main/public/film/Metropolis.md")).toBe(false);
    const { migrations } = await listMigrations(v.app, v.settings, { op: "move_database" });
    expect(migrations.map((m) => m.summary)).toEqual([
      "move the database folder from films to the root of the vault",
      "move the database folder from the root of the vault to films",
    ]);
  });

  it("refuses to move to the root when a name of the database is taken there", async () => {
    const v = createDbVault({ "main/notes.md": "mine\n" });
    expect((await createTable(v.app, v.settings, described({ name: "film", columns: [{ name: "title", type: "string" }], options: { filename: "{title}" } }))).ok).toBe(true);
    await expect(configureDatabase(v.app, v.settings, { root: "" }, async () => {})).rejects.toThrow('"root": main already exists in the vault');
    expect(v.exists("Datanotes/metastore.yaml")).toBe(true);
  });

  it("views and dropping a table work at the root", async () => {
    const v = await films();
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Metropolis", status: "to watch" } });
    expect((await createView(v.app, v.settings, described({ name: "vw_to_watch", query: { table: "film", where: { status: "to watch" }, columns: ["title"] } }))).ok).toBe(true);
    expect((await select(v.app, v.settings, { table: "vw_to_watch" })).rows.map((r) => r.title)).toEqual(["Metropolis"]);
    expect((await dropTable(v.app, v.settings, { table: "person" })).ok).toBe(true);
    expect(v.exists("main/public/person")).toBe(false);
  });
});

describe("datanotes serve --database", () => {
  it("serves a folder that is the database: metastore.yaml and the rows at its root; the folder finds its engine", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dn-root-db-"));
    fs.writeFileSync(path.join(root, "intro.md"), "# Films\n");
    const port = await new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    // settings known before the start (the metastore at the root gets the database's id)
    seedStoreSettings(root, { httpServerPort: port, httpServerToken: "root-token", fileLogEnabled: false }, "metastore.yaml");
    expect(parseArgs(["--database", root])).toMatchObject({ vault: path.resolve(root), atRoot: true });
    const svc = await startService({ ...parseArgs(["--database", root]), watch: "poll", pollMs: 200 }, {});
    try {
      expect(svc.store.database).toBe("");
      const call = async (op: string, body: Record<string, unknown>) =>
        (await fetch(`http://127.0.0.1:${port}/datanotes/operations/${op}/`, { method: "POST", headers: { Authorization: "Bearer root-token", "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
      const t = await call("create_table", described({ name: "film", columns: [{ name: "title", type: "string" }], filename: "{title}" }));
      expect(t.ok).toBe(true);
      const r = await call("insert_row", { table: "film", values: { title: "Metropolis" } });
      expect(r.planned_creates).toEqual(["main/public/film/Metropolis.md"]);
      expect(fs.existsSync(path.join(root, "main", "public", "film", "Metropolis.md"))).toBe(true);
      expect(fs.readFileSync(path.join(root, "metastore.yaml"), "utf8")).toMatch(/^id: /m);
      expect(await call("read_note", { path: "intro.md" })).toMatchObject({ path: "intro.md" });
      expect(localEngine(root)?.url).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await svc.stop();
    }
  }, 30_000);

  it("refuses --database and --vault together, and a folder whose database is in a subfolder", async () => {
    expect(() => parseArgs(["--database", "a", "--vault", "b"])).toThrow("datanotes serve: --database and --vault name the folder twice");
    expect(() => parseArgs([], {})).toThrow("datanotes serve: pass --database <folder> (or --vault <folder>)");
    expect(parseArgs([], { DATANOTES_DATABASE: "db" })).toMatchObject({ vault: path.resolve("db"), atRoot: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dn-root-db-"));
    fs.mkdirSync(path.join(root, "Db"));
    fs.writeFileSync(path.join(root, "Db", "metastore.yaml"), "catalogs: {}\n");
    await expect(startService({ ...parseArgs(["--database", root]), watch: "poll", pollMs: 200 }, {})).rejects.toThrow(`${path.resolve(root)} is not a database folder: its database is in Db/ (Db/metastore.yaml)`);
  });
});
