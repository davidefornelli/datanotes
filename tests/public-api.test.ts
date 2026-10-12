import { describe, expect, it } from "vitest";
import { createPublicApi } from "../src/core/public-api";
import { createDbVault, logVault, LOG_DIR, METASTORE } from "./helpers/db-vault";
import { INDEX_RETRY } from "../src/core/engine";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

describe("public API", () => {
  it("lists tables and checks them by name", async () => {
    const v = logVault({ "Daily/x.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000c\nkind: nope\noccurred_at: 2026-09-27T10:00\n---\n" });
    const api = createPublicApi(v.app, () => v.settings);
    expect(api.version).toBe(1);
    const r = await api.checkTable("main.public.log"); // also loads metastore.yaml into the cache listTables reads
    expect(api.listTables()).toEqual([{ name: "log", catalog: "main", schema: "public", qualified: "main.public.log" }]);
    expect(r.rows_checked).toBe(3);
    expect(r.violations.map((x) => x.path)).toEqual(["Daily/x.md"]);
  });

  it("runs a whole table lifecycle without any other plugin", async () => {
    const v = createDbVault({}); // no Local REST API: app.plugins.getPlugin returns null
    const api = createPublicApi(v.app, () => v.settings);
    await api.configureDatabase({ default_partition: "" });
    const created = await api.createTable(described({
      name: "book",
      options: { filename: "{title}" },
      columns: [
        { name: "title", type: "string", required: true, dense: true },
        { name: "pages", type: "integer", min: 1 },
      ],
    }));
    expect(created.ok).toBe(true);
    expect((await api.listTablesAndViews()).tables.map((t) => t.qualified)).toEqual(["main.public.book"]);

    const dry = await api.insertRow({ table: "book", values: { title: "Dune", pages: 412 } }, { dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(v.exists("Datanotes/main/public/book/Dune.md")).toBe(false);
    const ins = await api.insertRow({ table: "book", values: { title: "Dune", pages: 412 } });
    expect(ins.planned_creates).toEqual(["Datanotes/main/public/book/Dune.md"]);
    expect((await api.insertRow({ table: "book", values: { title: "Bad", pages: 0 } })).ok).toBe(false);

    const upd = await api.updateRow({ table: "book", path: "Datanotes/main/public/book/Dune.md", set: { pages: 896 } });
    expect(upd.ok).toBe(true);
    const sel = await api.select({ table: "book", columns: ["title", "pages"] });
    expect(sel.rows).toEqual([{ path: "Datanotes/main/public/book/Dune.md", title: "Dune", pages: 896 }]);
    expect((await api.describeTable("book")).row_count).toBe(1);

    expect((await api.undo(upd.migration_id!)).ok).toBe(true);
    expect((await api.select({ table: "book", columns: ["pages"] })).rows[0]!.pages).toBe(412);
    const ops = await api.listMigrations({ table: "main.public.book" });
    expect(ops.migrations.map((m) => m.op)).toContain("insert_row");
  });

  it("withActor attributes writes in the journal", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const r = await api.withActor({ harness: "my-plugin", model: "none" }, () =>
      api.insertRow({ table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } }),
    );
    expect(r.ok).toBe(true);
    expect(r.planned_creates[0]!.startsWith(`${LOG_DIR}/`)).toBe(true);
    const ops = await api.listMigrations({ op: "insert_row" });
    expect(ops.migrations[0]).toMatchObject({ by: "my-plugin / none" });
  });
});
