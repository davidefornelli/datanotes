import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG, readVaultConfig } from "../src/node/vault-config";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function vaultWith(appJson?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-vcfg-"));
  roots.push(root);
  if (appJson !== undefined) {
    fs.mkdirSync(path.join(root, ".obsidian"));
    fs.writeFileSync(path.join(root, ".obsidian", "app.json"), appJson);
  }
  return root;
}

describe("readVaultConfig: Obsidian's .obsidian/app.json", () => {
  it("reads the link format, markdown links, trash option and excluded files", () => {
    const root = vaultWith(JSON.stringify({ newLinkFormat: "relative", useMarkdownLinks: true, trashOption: "local", userIgnoreFilters: ["Archive/", "/^tmp/"] }));
    expect(readVaultConfig(root)).toEqual({ newLinkFormat: "relative", useMarkdownLinks: true, trashOption: "local", userIgnoreFilters: ["Archive/", "/^tmp/"] });
  });

  it("is Obsidian's defaults without the file, or when the file is not JSON (a half-synced copy)", () => {
    expect(readVaultConfig(vaultWith())).toEqual(DEFAULT_VAULT_CONFIG);
    expect(readVaultConfig(vaultWith("{ newLinkFormat: relative"))).toEqual(DEFAULT_VAULT_CONFIG);
  });

  it("ignores values Obsidian would not write: unknown formats and trash options, non-text filters", () => {
    const root = vaultWith(JSON.stringify({ newLinkFormat: "wiki", useMarkdownLinks: "yes", trashOption: "cloud", userIgnoreFilters: ["Archive/", 3, null] }));
    expect(readVaultConfig(root)).toEqual({ ...DEFAULT_VAULT_CONFIG, userIgnoreFilters: ["Archive/"] });
    const notAList = vaultWith(JSON.stringify({ userIgnoreFilters: "Archive/" }));
    expect(readVaultConfig(notAList).userIgnoreFilters).toEqual([]);
  });
});
