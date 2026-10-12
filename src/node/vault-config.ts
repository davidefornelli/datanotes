/**
 * Vault settings that change how files and links are handled, read from Obsidian's
 * `.obsidian/app.json` when the vault has one, so the headless engine behaves like the user's
 * Obsidian. Without it: Obsidian's defaults.
 */

import fs from "node:fs";
import path from "node:path";
import type { LinkFormat } from "./links";

export interface VaultConfig {
  /** How new links are written: file name when unique, path relative to the note, or full path. */
  newLinkFormat: LinkFormat;
  /** Write `[text](path.md)` instead of `[[path]]`. */
  useMarkdownLinks: boolean;
  /** Where deleted files go: Obsidian's `.trash` folder, or removed for good. (`system` → `.trash`.) */
  trashOption: "system" | "local" | "none";
  /** Obsidian's "excluded files" (paths or `/regex/`): still files of the vault, not indexed for search. */
  userIgnoreFilters: string[];
}

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  newLinkFormat: "shortest",
  useMarkdownLinks: false,
  trashOption: "system",
  userIgnoreFilters: [],
};

export function readVaultConfig(root: string): VaultConfig {
  const file = path.join(root, ".obsidian", "app.json");
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_VAULT_CONFIG };
  }
  const fmt = raw.newLinkFormat;
  const trash = raw.trashOption;
  return {
    newLinkFormat: fmt === "relative" || fmt === "absolute" || fmt === "shortest" ? fmt : DEFAULT_VAULT_CONFIG.newLinkFormat,
    useMarkdownLinks: raw.useMarkdownLinks === true,
    trashOption: trash === "local" || trash === "none" || trash === "system" ? trash : DEFAULT_VAULT_CONFIG.trashOption,
    userIgnoreFilters: Array.isArray(raw.userIgnoreFilters) ? raw.userIgnoreFilters.filter((x): x is string => typeof x === "string") : [],
  };
}
