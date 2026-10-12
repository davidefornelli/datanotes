// Writes the docs site's generated pages from their sources, so the site cannot drift from the code:
//   reference/operations/*.md       <- src/api/catalog.ts (the operations, offered as MCP tools by
//                                      `datanotes mcp`), one page per kind (OPERATION_KINDS) and an overview
//   reference/cli.md                <- src/node/help.ts (datanotes --help)
//   reference/settings.md           <- src/core/settings.ts (DatanotesSettings and its defaults)
//   reference/errors.md             <- src/core/hints.ts (the docs topics, the guidance of each violation)
//   guides/security/security-model.md <- SECURITY.md
//   administration/docker.md        <- deploy/docker/README.md
//   public/openapi.json             <- src/server/openapi.ts
//   guides/<area>/*.md              <- docs/examples/pages.ts and the chapters of docs/examples/*.ts,
//                                      each example run against a real engine on a temporary vault:
//                                      the pages show the engine's real answers. The build fails when
//                                      no example uses an operation, an example is on no page, or no
//                                      example shows an option that defines the database
//                                      (docs/examples/coverage.ts)
// The outputs are not committed (docs/.gitignore): `npm run gen` (docs/package.json) runs before every docs dev/build.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docs = path.join(root, "docs", "src", "content", "docs");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

// the sources, bundled the way the service is (no TypeScript loader needed)
const entry = `export { OPERATIONS as MCP_TOOLS, OPERATION_KINDS, OPERATION_KIND } from "./src/api/catalog";
export { DOCS, VIOLATION_GUIDANCE } from "./src/core/hints";
export { DEFAULT_SETTINGS } from "./src/core/settings";
export { openApiDocument } from "./src/server/openapi";
export { help } from "./src/node/help";`;
const out = await esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error" });
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
const { MCP_TOOLS, OPERATION_KINDS, OPERATION_KIND, DOCS, VIOLATION_GUIDANCE, DEFAULT_SETTINGS, openApiDocument, help } = mod.exports;

// the examples and the engine that runs them
const exOut = await esbuild.build({
  stdin: { contents: `export * from "./docs/examples/index";`, resolveDir: root, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "error",
  external: ["swagger-ui-dist/package.json", "typescript"],
});
const exMod = { exports: {} };
new Function("module", "exports", "require", exOut.outputFiles[0].text)(exMod, exMod.exports, createRequire(path.join(root, "package.json")));
const { CHAPTERS, PAGES, runChapter, renderPage, operationsUsed, pagesUsing, pagesProblems, missingOptions, missingOptionsMessage } = exMod.exports;
const USED = operationsUsed();
const unused = MCP_TOOLS.map((t) => t.name).filter((n) => !USED.has(n));
if (unused.length) throw new Error(`docs/examples: no example uses ${unused.join(", ")}: add one`);
const misplaced = pagesProblems();
if (misplaced.length) throw new Error(`docs/examples/pages.ts:\n${misplaced.join("\n")}`);
const unkinded = MCP_TOOLS.map((t) => t.name).filter((n) => !Object.hasOwn(OPERATION_KIND, n));
if (unkinded.length) throw new Error(`src/api/catalog.ts: no kind in OPERATION_KIND for ${unkinded.join(", ")}`);
const exampleLinks = (op) => pagesUsing(op).map((p) => `[${p.title}](/${p.path}/)`).join(", ");
/** A docs address (`https://datanotes.dev/x/y.md#a`, `/x/y.md#a`) as a link of the site: `/x/y/#a`. */
const siteLink = (url) => url.replace(/^https:\/\/datanotes\.dev/, "").replace(/\.md(#|$)/, "/$1");

const GENERATED = (source) => `<!-- Generated from ${source} by scripts/gen-docs.mjs: edit the source, not this file. -->`;

function write(rel, text) {
  const file = path.join(docs, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n+/g, " ");
const md = (s) => String(s ?? "").replace(/``([^`]+)``/g, "`$1`");

function typeOf(schema) {
  if (!schema) return "";
  if (schema.enum) return schema.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (schema.anyOf || schema.oneOf) return (schema.anyOf ?? schema.oneOf).map(typeOf).filter(Boolean).join(" \\| ");
  if (schema.type === "array") return `${typeOf(schema.items) || "any"}[]`;
  return Array.isArray(schema.type) ? schema.type.join(" \\| ") : (schema.type ?? "");
}

// --- operations / MCP tools: one page per kind, and an overview ----------------------------------------
{
  const KINDS = Object.keys(OPERATION_KINDS);
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
  // the operations of a kind, in the order of OPERATION_KIND
  const opsOf = (kind) => Object.keys(OPERATION_KIND).filter((n) => OPERATION_KIND[n] === kind && byName.has(n)).map((n) => byName.get(n));
  const badgeOf = (t) => (t.annotations?.readOnlyHint ? "read-only" : t.annotations?.destructiveHint ? "destructive write" : "write");
  const ABOUT = [
    "The MCP server, `datanotes mcp`, offers each operation as an MCP tool of the same name, and `engineTools()` of `datanotes/mcp` gives the same definitions to [your own MCP server](/develop/build-on-datanotes/#build-your-own-mcp-server). `DatanotesClient.call(name, args)` runs one from code. Over HTTP each one is `POST /datanotes/operations/<name>/`, with its arguments as the JSON body: the [HTTP API reference](/api/) lists them.",
    "Every write is validated. Writes to rows and to the schema are journaled and undone with `undo_migration`; `configure_database`, the webhook operations, `vacuum_table` and `sync_semantic_index` are not journaled.",
  ];
  // /reference/tools/#<op> (the old page) redirects here (docs/worker.js); the browser keeps the anchor, and this sends it on
  const redirect = `(function(){var k=${JSON.stringify(Object.fromEntries(MCP_TOOLS.map((t) => [t.name, OPERATION_KIND[t.name]])))};var h=decodeURIComponent(location.hash.slice(1));if(Object.prototype.hasOwnProperty.call(k,h))location.replace("/reference/operations/"+k[h]+"/#"+h);})();`;
  const overview = [
    "---",
    "title: Operations",
    "description: Every operation of the HTTP API, offered to agents as an MCP tool of the same name, grouped by kind.",
    "sidebar:",
    "  label: Overview",
    "  order: 0",
    "head:",
    "  - tag: script",
    `    content: ${JSON.stringify(redirect)}`,
    "---",
    "",
    GENERATED("src/api/catalog.ts"),
    "",
    `The engine has ${MCP_TOOLS.length} operations of five kinds, like the statements of a SQL reference. ${ABOUT[0]}`,
    "",
    "Next to them, `datanotes mcp` offers three tools that read these docs offline, `list_docs`, `read_docs` and `search_docs`; they aren’t operations of the engine ([Read the docs offline](/guides/agents/docs-offline/)). `search_docs` takes required and excluded words, and becomes a hybrid search when the engine has semantic search on ([Search by words and by meaning](/guides/agents/docs-offline/#search-by-words-and-by-meaning)).",
    "",
  ];
  for (const kind of KINDS) {
    const k = OPERATION_KINDS[kind];
    overview.push(`## ${k.label}`, "", `${k.description} [${k.title}](/reference/operations/${kind}/) lists their parameters.`, "", "| Operation | What it does | Examples |", "| --- | --- | --- |");
    for (const t of opsOf(kind)) {
      const what = cell(md(t.description).split(/(?<=\.)\s/)[0]);
      overview.push(`| [\`${t.name}\`](/reference/operations/${kind}/#${t.name}) | ${what} | ${exampleLinks(t.name)} |`);
    }
    overview.push("");
  }
  write("reference/operations/index.md", overview.join("\n"));

  KINDS.forEach((kind, i) => {
    const k = OPERATION_KINDS[kind];
    const lines = [
      "---",
      `title: ${JSON.stringify(k.title)}`,
      `description: ${JSON.stringify(k.description)}`,
      "sidebar:",
      `  label: ${JSON.stringify(k.label)}`,
      `  order: ${i + 1}`,
      "---",
      "",
      GENERATED("src/api/catalog.ts"),
      "",
      `${k.description} The [overview](/reference/operations/) lists every operation by kind. ${ABOUT[0]}`,
      "",
      ABOUT[1],
      "",
    ];
    for (const t of opsOf(kind)) {
      const a = t.annotations ?? {};
      const examples = exampleLinks(t.name);
      lines.push(`## \`${t.name}\``, "", `**${a.title ?? t.name}** · ${badgeOf(t)}`, "", md(t.description).trim(), "");
      if (examples) lines.push(`Examples: ${examples}.`, "");
      const props = t.inputSchema?.properties ?? {};
      const required = new Set(t.inputSchema?.required ?? []);
      if (Object.keys(props).length) {
        lines.push("| Parameter | Type | Required | Default | Description |", "| --- | --- | --- | --- | --- |");
        for (const [name, sch] of Object.entries(props)) {
          lines.push(`| \`${name}\` | ${cell(typeOf(sch))} | ${required.has(name) ? "yes" : ""} | ${sch.default === undefined ? "" : `\`${cell(JSON.stringify(sch.default))}\``} | ${cell(md(sch.description))} |`);
        }
        lines.push("");
      }
    }
    write(`reference/operations/${kind}.md`, lines.join("\n"));
  });
}

// --- CLI -------------------------------------------------------------------------------------
write(
  "reference/cli.md",
  ["---", "title: Command line", "description: The datanotes command and its options.", "sidebar:", "  label: CLI", "  order: 2", "---", "", GENERATED("src/node/help.ts"), "", "```text", help(version), "```", ""].join("\n"),
);

// --- settings (doc comments of DatanotesSettings, defaults of DEFAULT_SETTINGS) ---------------
{
  const file = path.join(root, "src/core/settings.ts");
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const rows = [];
  sf.forEachChild((n) => {
    if (!ts.isInterfaceDeclaration(n) || n.name.text !== "DatanotesSettings") return;
    for (const m of n.members) {
      if (!ts.isPropertySignature(m)) continue;
      const name = m.name.getText(sf);
      const doc = (m.jsDoc ?? []).map((d) => ts.getTextOfJSDocComment(d.comment) ?? "").join(" ").replace(/\s+/g, " ").trim();
      if (/^Internal|^Legacy/.test(doc)) continue;
      rows.push(`| \`${name}\` | \`${cell(JSON.stringify(DEFAULT_SETTINGS[name]))}\` | ${cell(doc)} |`);
    }
  });
  write(
    "reference/settings.md",
    [
      "---",
      "title: Settings",
      "description: Every key of the engine's settings file and its default.",
      "sidebar:",
      "  order: 3",
      "---",
      "",
      GENERATED("src/core/settings.ts"),
      "",
      "The headless engine reads `settings.json` in its store, outside the vault (`datanotes store path` shows where), or the file given with `--settings`. Missing keys take their default.",
      "",
      "| Key | Default | Meaning |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
}

// --- pages kept in the repository root, published as they are -------------------------------
function include(src, rel, title, description, order) {
  const text = fs.readFileSync(path.join(root, src), "utf8").replace(/^# .*\r?\n+/, "");
  write(rel, ["---", `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(description)}`, "sidebar:", `  order: ${order}`, "---", "", GENERATED(src), "", text].join("\n"));
}
include("SECURITY.md", "guides/security/security-model.md", "Security model", "Security model, credentials, and how to report a vulnerability.", 3);
include("deploy/docker/README.md", "administration/docker.md", "Run in Docker", "The engine in a container, on a server.", 2);

// --- errors (src/core/hints.ts) ------------------------------------------------------------------
{
  const topic = (t) => {
    if (!Object.hasOwn(DOCS, t)) throw new Error(`gen-docs: errors: no docs topic ${t} in src/core/hints.ts`);
    return siteLink(DOCS[t]);
  };
  // a link named after the section it opens: the example's title on a guide page, else its heading in words
  const anchorSlug = (h) => h.replace(/`/g, "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
  const linkText = (u) => {
    const [route, anchor] = u.replace(/^\/|\/$/g, "").split(/\/?#/);
    const page = PAGES.find((pg) => pg.path === route);
    const title = anchor && page?.examples.map(([, t]) => t).find((t) => anchorSlug(t) === anchor);
    if (title) return title;
    if (anchor) return anchor[0].toUpperCase() + anchor.slice(1).replace(/-/g, " ");
    return page?.title ?? (route === "reference/operations" ? "Operations" : route);
  };
  const link = (u) => `[${linkText(u)}](${u})`;
  const links = (...ts) => ts.map((t) => (t.startsWith("/") ? t : topic(t))).map(link).join(", ");
  // what the engine and the MCP server answer (CONTRIBUTING.md, "Errors", has where each one is raised)
  const KINDS = [
    ["Unknown tool or operation", "MCP tool error; 400", "The closest tools", links("/reference/operations/")],
    ["Argument unknown, missing or of the wrong type", "MCP tool error, before the call", "The argument meant, and the tool’s arguments with their types", "The operation’s reference"],
    ["Bad input to an operation or a route", "400", "Its own where the answer is data, else the operation’s arguments", "The topic’s page, or the operation’s reference"],
    ["Table or view not found", "404", "The closest names and aliases, the tables and views, or the view’s table where a table is needed", links("findTable", "views")],
    ["Ambiguous table name", "409", "The full names", links("catalogs")],
    ["Unknown column", "400", "The closest column, the table’s columns, `describe_table` and `add_column`", links("describeTable")],
    ["Unknown filter operator", "400", "The operator meant, every operator, and the shape of a condition", links("filters")],
    ["Bad expression or aggregate", "400", "The columns and the shape", links("groupBy")],
    ["Unknown base, constraint, catalog, schema, enum value or link column", "400", "The closest name, the list, and the operation that lists them", "The topic’s page"],
    ["A name that isn’t an identifier", "400", "The name it could be", links("catalogs")],
    ["A table, base or column without a description, or one removed", "400", "Every missing description, and the call’s shape with each in place", links("descriptions")],
    ["Row not found", "400", "The closest note name, and how to find a row’s `path` or `id`", links("updateRow")],
    ["A value breaks a rule (a violation)", "422", "The hint of its kind: [Violations](#violations)", "The page of its kind"],
    ["A conflict: `expect`, linked rows, rows that break a new CHECK, a column others read, `cascade`, a name taken, merge keys", "422", "What the conflict means and what to do", links("expect", "referenced", "check", "dropTable", "merge")],
    ["A write that failed partway, rolled back by the engine", "503, with the result as the body", "Free the file, then send the write again", links("failedWrite")],
    ["A write that failed partway, and its rollback too", "500, with the result as the body", "`undo_migration`", links("undo")],
    ["Undo refused, or migration not found", "409, 404", "Undone already, the later changes, `list_migrations`", links("undo", "undoConflict")],
    ["No history, no such version, a time before the table existed", "400", "`alter_table` with `history: \"on\"`, `describe_history`, `timestamp`", links("history", "versions")],
    ["A batch with an operation refused or unknown", "422, 400", "Each operation’s own; fix it and send the whole batch again", links("batch")],
    ["A token beyond its permissions", "403", "The permissions, and who changes them", links("tokens")],
    ["Token missing or wrong", "401", "Which token to send, as a bearer token", links("auth")],
    ["Unknown operation, route, argument, method or body", "404, 400, 405", "The closest operation, route or argument, and the routes in `openapi.json`", links("routes")],
    ["Note or folder not found", "404", "Vault paths, `list_folder` and `search_notes`", links("readNote")],
    ["Change feed, webhooks or semantic search off", "400, 503", "How to turn it on", links("changeFeed", "semantic")],
    ["Engine unreachable", "Thrown by the client; 502 from the MCP server", "Start the engine, or check its address", links("/start/connect-agents/#how-the-mcp-server-reaches-the-engine")],
    ["The engine can’t listen: a port in use or reserved, an address of another machine", "Exit code 1 of `datanotes serve`", "Another `--port`, `--port 0`, or an address of this machine", links("port")],
    ["A request while the engine stops", "503", "Wait for the stop, then start the engine again", links("stop")],
    ["Unexpected error", "500", "None: it isn’t a mistake of the caller", "None"],
  ];
  const lines = [
    "---",
    "title: Errors",
    "description: Every kind of error the engine and the MCP server answer, with its status, what its hint gives and the page its docs link names.",
    "sidebar:",
    "  order: 4",
    "---",
    "",
    GENERATED("src/core/hints.ts"),
    "",
    "Every error of the engine says three things: what is wrong (`error`), how to fix it (`hint`) and where to read more (`docs`, a page of this site in Markdown, with its anchor). The HTTP API sends them as JSON fields; the MCP server and `DatanotesError` end the text with a `Hint:` and a `Docs:` line. The docs line of `DatanotesError` gives the address, then the `read_docs` call that reads the same section offline; `datanotes mcp` gives only the call:",
    "",
    "```text",
    "insert_row refused — nothing was written:",
    "invalid datanotes/main/public/film/Sunrise.md: status must be one of: to watch; watched",
    `Hint: ${VIOLATION_GUIDANCE.enum.hint}`,
    `Docs: ${VIOLATION_GUIDANCE.enum.docs} (offline: read_docs("${VIOLATION_GUIDANCE.enum.docs.replace(/^https:\/\/datanotes\.dev\//, "").replace(/\.md/, "")}"))`,
    "```",
    "",
    "[Read the engine’s errors](/guides/agents/reading-errors/) shows how an agent uses them.",
    "",
    "## Kinds of error",
    "",
    "| Error | Status | The hint gives | Docs |",
    "| --- | --- | --- | --- |",
    ...KINDS.map((r) => `| ${r.map(cell).join(" | ")} |`),
    "",
    "A refused write writes nothing, so the caller can fix the call and send it again. Hand edits that break a rule aren’t errors: `check_table` and the change feed report them as violations.",
    "",
    "## Violations",
    "",
    "A write the engine refuses lists its violations, each with a `code`; `check_table` and the change feed report the violations of hand edits with the same codes.",
    "",
    "| Code | Hint | Docs |",
    "| --- | --- | --- |",
    ...Object.entries(VIOLATION_GUIDANCE).map(([code, g]) => `| \`${code}\` | ${cell(g.hint)} | ${link(siteLink(g.docs))} |`),
    "",
  ];
  write("reference/errors.md", lines.join("\n"));
}

// --- OpenAPI ---------------------------------------------------------------------------------
fs.mkdirSync(path.join(root, "docs", "public"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "public", "openapi.json"), JSON.stringify(openApiDocument(version), null, 2));

// --- Examples: the guide pages made from them ----------------------------------------------------------
{
  const started = Date.now();
  for (const p of PAGES) fs.rmSync(path.join(docs, `${p.path}.md`), { force: true });
  // generated before 3.0, at the addresses that moved (docs/worker.js redirects them)
  for (const old of ["examples", "reference/tools.md", "security.md", "guides/docker.md"]) fs.rmSync(path.join(docs, old), { recursive: true, force: true });
  const runs = [];
  for (const chapter of CHAPTERS) runs.push(await runChapter(chapter)); // one engine at a time
  // Every option that defines the database must be shown too (docs/examples/coverage.ts).
  const missing = missingOptionsMessage(missingOptions(runs, root));
  if (missing) throw new Error(missing);
  const bySlug = new Map(runs.map((r) => [r.chapter.slug, r]));
  for (const page of PAGES) {
    const chapters = [...new Set(page.examples.map(([slug]) => slug))];
    const sources = ["docs/examples/pages.ts", ...(page.include ? [page.include] : []), ...chapters.map((c) => `docs/examples/${c}.ts`)];
    const included = page.include ? fs.readFileSync(path.join(root, page.include), "utf8") : "";
    write(`${page.path}.md`, renderPage(page, bySlug, GENERATED(sources.join(", ")), included));
  }
  console.log(`docs: ${CHAPTERS.length} example chapters run in ${((Date.now() - started) / 1000).toFixed(1)} s, ${PAGES.length} guide pages`);
}

console.log(`docs: ${MCP_TOOLS.length} operations, settings, CLI, errors, security, docker, openapi.json`);
