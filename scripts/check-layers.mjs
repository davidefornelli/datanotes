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
import fs from "node:fs";
import path from "node:path";

const RULES = {
  api: [/^obsidian$/, /^\.\.\/(core|server|node|mcp)\//, /^electron$/, /^@modelcontextprotocol\//],
  core: [/^obsidian$/, /^\.\.\/(server|node|api|mcp)\//, /^electron$/, /^@modelcontextprotocol\//],
  server: [/^obsidian$/, /^\.\.\/(node|mcp)\//, /^electron$/, /^@modelcontextprotocol\//],
  node: [/^obsidian$/, /^electron$/, /^@modelcontextprotocol\//],
  mcp: [/^obsidian$/, /^\.\.\/(core|server|node)\//, /^electron$/],
};
const IMPORT = /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
let bad = 0;
for (const [layer, forbidden] of Object.entries(RULES)) {
  const dir = path.join("src", layer);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2];
      if (forbidden.some((re) => re.test(spec))) {
        console.error(`src/${layer}/${f}: imports "${spec}" (not allowed in ${layer}/)`);
        bad++;
      }
    }
  }
}
if (bad > 0) process.exit(1);
console.log("layers ok");
