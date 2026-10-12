# Golden comparison with Obsidian

`tests/golden-obsidian.test.ts` checks that the Node host reads frontmatter, resolves links, lists
tags and writes links exactly as Obsidian does. It runs only when given an export made in a
running Obsidian (read-only) and a copy of the same vault; no vault data lives in the repository.

Run these in Obsidian's developer console:

```js
// → <tmp>/obsidian-golden.json : frontmatter, links with Obsidian's resolution, resolvedLinks, tags, link text
(() => { const lp = s => s.split("#")[0]; const out = { format: app.vault.getConfig("newLinkFormat"), notes: {} };
  for (const f of app.vault.getMarkdownFiles()) { const c = app.metadataCache.getCache(f.path) || {};
    const fm = c.frontmatter ? Object.fromEntries(Object.entries(c.frontmatter).filter(([k]) => k !== "position")) : null;
    const links = [...(c.links || []).map(l => ["wiki", l]), ...(c.embeds || []).map(l => ["embed", l]), ...(c.frontmatterLinks || []).map(l => ["fm", l])]
      .map(([k, l]) => { const d = app.metadataCache.getFirstLinkpathDest(lp(l.link), f.path); return [k, l.link, d ? d.path : null]; });
    out.notes[f.path] = { fm, links, resolved: app.metadataCache.resolvedLinks[f.path] || {}, tags: (c.tags || []).map(t => t.tag) }; }
  out.linktext = app.vault.getMarkdownFiles().slice(0, 60).map(f => [f.path, app.metadataCache.fileToLinktext(f, "Datanotes/database.md", true)]);
  const os = window.require("os"); window.require("fs").writeFileSync(os.tmpdir() + "/obsidian-golden.json", JSON.stringify(out)); })()

// → <tmp>/obsidian-genlink.json : generateMarkdownLink (what a rename writes) for sample files and sources
(() => { const files = app.vault.getMarkdownFiles(); const pick = files.slice(0, 40);
  const sources = [files[0].path, files[Math.floor(files.length / 2)].path, files[files.length - 1].path]; const out = [];
  for (const s of sources) for (const f of pick) for (const [sub, alias] of [["", ""], ["#Note", ""], ["", "Alias"], ["#Note", "Alias"]])
    out.push([f.path, s, sub, alias, app.fileManager.generateMarkdownLink(f, s, sub, alias)]);
  const os = window.require("os"); window.require("fs").writeFileSync(os.tmpdir() + "/obsidian-genlink.json", JSON.stringify(out)); })()
```

Then copy the vault without dot-folders (keep `.obsidian/app.json`) and run
`GOLDEN_VAULT=… GOLDEN_JSON=… GOLDEN_GENLINK=… npx vitest run tests/golden-obsidian.test.ts`.
