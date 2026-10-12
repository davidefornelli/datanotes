/**
 * A small folder of docs as the package ships them in dist/docs (src/api/docs.ts reads it): a few
 * Markdown pages with sections, a long page past read_docs' cap, and llms.txt. The tests of the
 * docs tools and of `GET /datanotes/manual/` read it through DATANOTES_DOCS_DIR, so they need no
 * docs build.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The text of the long page's sections (one per operation), each about 700 characters. */
const opSection = (i: number) => `## \`op_${i}\`\n\n${`Operation ${i} reads and writes rows of a table. `.repeat(14)}Its marker is mark${i}.\n\n`;

export const FIXTURE_PAGES: Record<string, string> = {
  // the overview of a folder, next to the folder
  "examples.md": "# Examples\n\n> Every operation in use.\n",
  "index.md": "# Datanotes\n\n> The engine of your second brain: Markdown notes as database tables.\n\nWelcome to the docs of the engine.\n",
  "examples/queries.md": [
    "# Querying rows",
    "",
    "> Read rows with select_rows: filters, operators and views.",
    "",
    "`select_rows` is the one operation that reads rows.",
    "",
    "## Compare values with operators",
    "",
    "A `where` key takes an object of operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`.",
    "",
    "### Compare dates",
    "",
    "Dates compare as text: give them as YYYY-MM-DD.",
    "",
    "```md",
    "## Not a heading, inside code",
    "```",
    "",
    "## Compare values with operators",
    "",
    "A second section with the same heading gets its own anchor.",
    "",
    "## Store a query as a view",
    "",
    "`create_view` stores a select_rows query under a name.",
    "",
  ].join("\n"),
  // Windows line endings: read as \n
  "guides/tokens.md": "# Give each program its own token\r\n\r\nNamed tokens, without a description line.\r\n\r\n## Choose what a token can do\r\n\r\nThe permissions of a named token: read, write, ddl.\r\n",
  "start/quick-start.md": "# Quick start\n\n> Install and run the engine.\n\nA page without sections.\n",
  "misc/untitled.md": "A page without a title line.\n",
  "api/operations/create_webhook.md":
    "# Push row changes to a web address that would rather be called than poll the change feed for webhook events\n\n> The HTTP route.\n\nPOST /datanotes/webhooks/create/ registers a webhook.\n",
  "reference/tools.md": `# Operations and MCP tools\n\n> Every operation.\n\n${Array.from({ length: 60 }, (_, i) => opSection(i)).join("")}`,
  "llms.txt": "# Datanotes\n\n> The engine of your second brain.\n",
};

/** A new folder with the fixture docs (removed by the caller). */
export function docsFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-docs-"));
  for (const [file, text] of Object.entries(FIXTURE_PAGES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}
