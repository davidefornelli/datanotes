import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { configureDatabase } from "../src/core/database";
import { insertRow } from "../src/core/rows";
import { unsafeVaultPath } from "../src/core/vault-path";
import { openNodeVault, resolveInVault } from "../src/node/node-app";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

describe("paths stay inside the vault", () => {
  it("refuses unsafe client paths", () => {
    expect(unsafeVaultPath("Datanotes/main/public/note/a.md")).toBeNull();
    for (const p of ["../x", "a/../../x", "a\\..\\x", "C:/Windows/x", "//server/share/x", "a\0b", ""]) expect(unsafeVaultPath(p)).not.toBeNull();
  });

  it("the Node host resolves only inside the vault folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-path-"));
    expect(resolveInVault(root, "a/b.md")).toBe(path.join(root, "a", "b.md"));
    expect(resolveInVault(root, "/a/./b.md")).toBe(path.join(root, "a", "b.md"));
    for (const p of ["../x.md", "a/../../x.md", "..\\x.md", "a\\..\\..\\x.md", "C:/x.md", "a/C:x.md"]) expect(() => resolveInVault(root, p)).toThrow(/outside the vault/);
  });

  it("an insert with a path out of the vault is refused and writes nothing outside", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vault-parent-"));
    const root = path.join(parent, "vault");
    fs.mkdirSync(root);
    const host = openNodeVault(root);
    const settings = { ...DEFAULT_SETTINGS };
    try {
      await configureDatabase(host.app as never, settings, { timezone: "Europe/Rome" }, async () => {});
      await createTable(host.app as never, settings, described({ name: "note", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] }));
      for (const p of ["../escaped", "Datanotes/../../escaped2", "..\\escaped3"]) {
        await expect(insertRow(host.app as never, settings, { table: "note", values: { title: "x" }, path: p })).rejects.toThrow(/inside the vault/);
      }
      expect(fs.readdirSync(parent)).toEqual(["vault"]);
      // and the host itself refuses, whatever the caller
      await expect(host.app.vault.create("../escaped4.md", "x")).rejects.toThrow(/outside the vault/);
      expect(fs.readdirSync(parent)).toEqual(["vault"]);
    } finally {
      host.metadataCache.dispose();
    }
  });
});
