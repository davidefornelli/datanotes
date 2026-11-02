// Fails when a layer imports one it must not depend on:
//   src/api      (client of the HTTP API: datanotes/client, datanotes/local, datanotes/mcp) → nothing
//                but itself, and never the MCP SDK: datanotes/mcp gives tool definitions to servers
//                that bring their own SDK
//   src/core     (engine)    → nothing but itself
// The MCP SDK only in src/mcp (src/node loads it from there for `datanotes mcp`).
//   src/server   (HTTP)      → core, api (and never the MCP SDK: the engine does not serve MCP)
//   src/node     (headless)  → core, server, api, mcp
//   src/mcp      (MCP server: `datanotes mcp`) → api only (and the MCP SDK): a client of the HTTP
//                API, never the engine in process
//   src/ui       (the database browser, GET /datanotes/ui/: runs in a web page) → nothing but itself
//                (every .ts and .tsx file, in every subfolder) and the packages preact,
//                preact/hooks and markdown-it; no node: module, no other package. It talks to the
//                engine over HTTP with its own fetch wrapper, never through src/api (whose client
//                pulls the whole catalogue into the page).
// Nothing imports src/ui: the server embeds its build output (src/server/ui.ts), not its modules.
import fs from "node:fs";
import path from "node:path";

const NO_UI = /^\.\.\/ui\//;
const RULES = {
  api: [/^obsidian$/, /^\.\.\/(core|server|node|mcp)\//, /^electron$/, /^@modelcontextprotocol\//, NO_UI],
  core: [/^obsidian$/, /^\.\.\/(server|node|api|mcp)\//, /^electron$/, /^@modelcontextprotocol\//, NO_UI],
  server: [/^obsidian$/, /^\.\.\/(node|mcp)\//, /^electron$/, /^@modelcontextprotocol\//, NO_UI],
  node: [/^obsidian$/, /^electron$/, /^@modelcontextprotocol\//, NO_UI],
  mcp: [/^obsidian$/, /^\.\.\/(core|server|node)\//, /^electron$/, NO_UI],
};
const IMPORT = /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
// `import "./styles.css"`: an import for its side effects, without `from` (checked in every layer)
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;
const UI_PACKAGES = new Set(["preact", "preact/hooks", "markdown-it"]);
const UI_DIR = path.resolve("src", "ui");

let bad = 0;
for (const [layer, forbidden] of Object.entries(RULES)) {
  const dir = path.join("src", layer);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const specs = [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2]).concat([...text.matchAll(SIDE_EFFECT_IMPORT)].map((m) => m[1]));
    for (const spec of specs) {
      if (forbidden.some((re) => re.test(spec))) {
        console.error(`src/${layer}/${f}: imports "${spec}" (not allowed in ${layer}/)`);
        bad++;
      }
    }
  }
}

/** Every .ts and .tsx file under `dir`, at any depth. */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

for (const file of walk(UI_DIR)) {
  const text = fs.readFileSync(file, "utf8");
  const specs = [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2]).concat([...text.matchAll(SIDE_EFFECT_IMPORT)].map((m) => m[1]));
  const name = path.relative(process.cwd(), file).split(path.sep).join("/");
  for (const spec of specs) {
    let why = "";
    if (spec.startsWith(".")) {
      const target = path.resolve(path.dirname(file), spec);
      if (target !== UI_DIR && !target.startsWith(UI_DIR + path.sep)) why = "outside src/ui";
    } else if (!UI_PACKAGES.has(spec)) {
      why = `only ${[...UI_PACKAGES].join(", ")} and src/ui itself`;
    }
    if (why) {
      console.error(`${name}: imports "${spec}" (not allowed in ui/: ${why})`);
      bad++;
    }
  }
}
if (bad > 0) process.exit(1);
console.log("layers ok");
