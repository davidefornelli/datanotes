// The docs of this version in the npm package: copies the Markdown twin of every page of the docs
// build (docs/dist/**/*.md) and llms.txt to dist/docs/, which `files` in package.json publishes.
// The MCP server's docs tools (list_docs, read_docs, search_docs) and the engine's
// GET /datanotes/manual/ read them there (src/api/docs.ts). The docs build runs it last
// (docs/package.json); the release workflow builds the docs before it publishes.
//
//   node scripts/copy-docs.mjs           copy (the docs must be built: cd docs && npm run build)
//   node scripts/copy-docs.mjs --check   fail unless dist/docs holds the docs (prepublishOnly)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "docs", "dist");
const to = path.join(root, "dist", "docs");

/** The Markdown files of a folder, relative to it, sorted. */
function markdownFiles(dir, rel = "") {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...markdownFiles(dir, r));
    else if (ent.name.endsWith(".md")) out.push(r);
  }
  return out.sort();
}

if (process.argv.includes("--check")) {
  const ok = fs.existsSync(path.join(to, "index.md")) && fs.existsSync(path.join(to, "llms.txt"));
  if (!ok) {
    console.error("copy-docs: dist/docs has no docs: build them first (cd docs && npm ci && npm run build), so the package ships them");
    process.exit(1);
  }
  console.log(`copy-docs: dist/docs holds ${markdownFiles(to).length} pages`);
  process.exit(0);
}

if (!fs.existsSync(path.join(from, "index.md"))) {
  console.error("copy-docs: docs/dist has no pages: build the docs first (cd docs && npm ci && npm run build)");
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
const files = [...markdownFiles(from), "llms.txt"];
let bytes = 0;
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
  fs.copyFileSync(path.join(from, f), path.join(to, f));
  bytes += fs.statSync(path.join(to, f)).size;
}
console.log(`copy-docs: ${files.length} files (${Math.round(bytes / 1024)} KB) to dist/docs`);
