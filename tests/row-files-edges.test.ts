import { describe, expect, it } from "vitest";
import { loadMetastore } from "../src/core/metastore";
import { catalogRowFiles } from "../src/core/row-files";
import { catalogLayout } from "../src/core/table-loader";
import { logVault } from "./helpers/db-vault";

const ref = { catalog: "main", schema: "public", table: "log", full: "main.public.log" };

describe("catalogRowFiles: which notes are rows of a table", () => {
  it("knows no rows before the metastore is loaded, then finds them wherever they live", async () => {
    const v = logVault({ "Daily/plain.md": "---\nkind: mood\n---\nnot a row\n" });
    const def = { options: {}, layout: catalogLayout("Datanotes", ref, {}) };
    expect(catalogRowFiles(v.app, v.settings, "main.public.log", def)).toEqual([]);
    await loadMetastore(v.app, v.settings);
    expect(catalogRowFiles(v.app, v.settings, "main.public.log", def).map((f) => f.path).sort()).toEqual(["Daily/a.md", "Daily/b.md"]);
  });

  it("leaves out the archive and the excluded folders", async () => {
    const v = logVault({
      "Datanotes/main/public/log/_archive/old.md": "---\ntable: main.public.log\nkind: walk\noccurred_at: 2020-01-01T10:00\n---\n",
      "Templates/log.md": "---\ntable: log\nkind: walk\n---\n",
    });
    await loadMetastore(v.app, v.settings);
    const options = { exclude: ["Templates"] };
    const def = { options, layout: catalogLayout("Datanotes", ref, options) };
    expect(catalogRowFiles(v.app, v.settings, "main.public.log", def).map((f) => f.path).sort()).toEqual(["Daily/a.md", "Daily/b.md"]);
  });
});
