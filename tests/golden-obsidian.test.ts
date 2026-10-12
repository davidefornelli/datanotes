/**
 * Golden comparison with the real Obsidian (opt-in): a vault copy and what Obsidian computed on the
 * original (frontmatter, every link's resolution, resolved links, tags, link text), exported from a
 * running Obsidian. Run with
 *
 *   GOLDEN_VAULT=<vault copy> GOLDEN_JSON=<export.json> npx vitest run tests/golden-obsidian.test.ts
 *
 * The export is made in Obsidian's console (scripts in tests/golden-obsidian.md). No vault data
 * lives in the repository.
 */

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { openNodeVault } from "../src/node/node-app";
import { generateLink } from "../src/node/links";
import type { TFile } from "../src/core/host";

interface Golden {
  format: string;
  notes: Record<string, { fm: Record<string, unknown> | null; links: [string, string, string | null][]; resolved: Record<string, number>; tags: string[] }>;
  linktext: [string, string][];
}

const VAULT = process.env.GOLDEN_VAULT;
const JSON_PATH = process.env.GOLDEN_JSON;
/** Optional: Obsidian's generateMarkdownLink for [file, source, subpath, alias] (what a rename writes). */
const GENLINK = process.env.GOLDEN_GENLINK;

describe.skipIf(!VAULT || !JSON_PATH)("golden: node host vs Obsidian", () => {
  // the body still runs when the suite is skipped: read nothing then (there is no /dev/null on Windows)
  const golden = (JSON_PATH ? JSON.parse(fs.readFileSync(JSON_PATH, "utf8") || "{}") : {}) as Golden;
  const host = VAULT ? openNodeVault(VAULT) : null;
  const report = (label: string, diffs: string[], total: number) => {
    console.log(`${label}: ${total - diffs.length}/${total} equal${diffs.length ? `\n  ${diffs.slice(0, 15).join("\n  ")}` : ""}`);
  };

  it("same notes", () => {
    expect(host!.vault.getMarkdownFiles().map((f) => f.path).sort()).toEqual(Object.keys(golden.notes).sort());
  });

  it("frontmatter", () => {
    const diffs: string[] = [];
    for (const [p, g] of Object.entries(golden.notes)) {
      const mine = host!.metadataCache.getFileCache(host!.vault.getAbstractFileByPath(p) as TFile)?.frontmatter ?? null;
      if (JSON.stringify(mine) !== JSON.stringify(g.fm)) diffs.push(`${p}: node ${JSON.stringify(mine)?.slice(0, 160)} | obsidian ${JSON.stringify(g.fm)?.slice(0, 160)}`);
    }
    report("frontmatter", diffs, Object.keys(golden.notes).length);
    expect(diffs).toEqual([]);
  });

  it("link resolution", () => {
    const diffs: string[] = [];
    let total = 0;
    for (const [p, g] of Object.entries(golden.notes)) {
      for (const [kind, link, dest] of g.links) {
        total++;
        const mine = host!.metadataCache.getFirstLinkpathDest(link.split("#")[0]!, p)?.path ?? null;
        if (mine !== dest) diffs.push(`${p} ${kind} [[${link}]]: node ${mine} | obsidian ${dest}`);
      }
    }
    report("links", diffs, total);
    expect(diffs).toEqual([]);
  });

  it("resolved links", () => {
    const diffs: string[] = [];
    for (const [p, g] of Object.entries(golden.notes)) {
      const mine = host!.metadataCache.resolvedLinks[p] ?? {};
      const sort = (o: Record<string, number>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
      if (sort(mine) !== sort(g.resolved)) diffs.push(`${p}: node ${sort(mine).slice(0, 200)} | obsidian ${sort(g.resolved).slice(0, 200)}`);
    }
    report("resolvedLinks", diffs, Object.keys(golden.notes).length);
    expect(diffs).toEqual([]);
  });

  it("tags", () => {
    const diffs: string[] = [];
    for (const [p, g] of Object.entries(golden.notes)) {
      const mine = (host!.metadataCache.getFileCache(host!.vault.getAbstractFileByPath(p) as TFile)?.tags ?? []).map((t) => t.tag);
      if (JSON.stringify(mine) !== JSON.stringify(g.tags)) diffs.push(`${p}: node ${JSON.stringify(mine)} | obsidian ${JSON.stringify(g.tags)}`);
    }
    report("tags", diffs, Object.keys(golden.notes).length);
    expect(diffs).toEqual([]);
  });

  it("link text", () => {
    const diffs: string[] = [];
    for (const [p, text] of golden.linktext) {
      const mine = host!.metadataCache.fileToLinktext!(host!.vault.getAbstractFileByPath(p) as TFile, "Datanotes/database.md", true);
      if (mine !== text) diffs.push(`${p}: node ${mine} | obsidian ${text}`);
    }
    report("linktext", diffs, golden.linktext.length);
    expect(diffs).toEqual([]);
  });

  it.skipIf(!GENLINK)("generated links (what a rename writes)", () => {
    const rows = JSON.parse(fs.readFileSync(GENLINK!, "utf8")) as [string, string, string, string, string][];
    const diffs: string[] = [];
    for (const [file, source, subpath, alias, expected] of rows) {
      const mine = generateLink(host!.metadataCache.resolver, file, source, host!.vault.config.newLinkFormat, { subpath, alias });
      if (mine !== expected) diffs.push(`${file} from ${source} (${subpath}|${alias}): node ${mine} | obsidian ${expected}`);
    }
    report("generated links", diffs, rows.length);
    expect(diffs).toEqual([]);
  });
});
