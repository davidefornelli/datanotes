#!/usr/bin/env node
/**
 * Regenerates `test-vault/`, the small vault committed with the repository for development
 * (`npm run dev`) and for `tests/test-vault.test.ts`.
 *
 *   npm run build:service && node scripts/make-test-vault.mjs
 *
 * Every table, column, rule, view and row is written by the engine's own operations (the built
 * `dist/datanotes.cjs serve` on a temporary folder, driven through `datanotes/client`), never by
 * hand, so the vault is exactly what the engine writes. The script then checks every table
 * (`check_table`) and replaces `test-vault/` with the result (without the engine's state folder).
 * Row ids are new on every run: regenerate only when the vault should change.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "dist", "datanotes.cjs");
const clientLib = path.join(repo, "dist", "api", "index.js");
const target = path.join(repo, "test-vault");
for (const f of [cli, clientLib]) if (!fs.existsSync(f)) throw new Error(`${path.relative(repo, f)} is missing: run npm run build:service first`);
const { DatanotesClient } = await import(pathToFileURL(clientLib).href);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const P = "work.planning";
const ops = [
  // the catalog and its schema
  // history for every table: each write is a version in its transaction log (time travel, restore)
  { op: "configure_database", args: { timezone: "Europe/Rome", default_catalog: "work", default_schema: "planning", history: true } },
  {
    op: "create_table",
    args: {
      catalog: "work",
      schema: "planning",
      name: "person",
      columns: [
        { name: "name", type: "string", required: true, unique: true, description: "The person's full name" },
        { name: "email", type: "string", description: "Where to write to them" },
        { name: "role", type: "enum", values: ["engineer", "designer", "manager"], value_descriptions: { engineer: "builds the software", designer: "designs the product", manager: "plans the work" }, description: "What the person does in the team" },
      ],
      filename: "{name}", description: "People who work on the projects", aliases: ["people", "team"],
      tags: { domain: "people" },
    },
  },
  { op: "comment_on", args: { catalog: "work", description: "Work: projects, tasks and the people on them" } },
  { op: "comment_on", args: { catalog: "work", schema: "planning", description: "Areas, projects, workstreams and their tasks" } },
  // shared columns
  {
    op: "define_base",
    args: {
      name: "dated",
      description: "Work that starts on a day",
      columns: [
        { name: "started_on", type: "date", description: "When the work began" },
        { name: "summary", type: "string", description: "One line about it" },
      ],
    },
  },
  // the tree of areas, projects and workstreams
  {
    op: "create_table",
    args: {
      catalog: "work",
      schema: "planning",
      name: "project",
      columns: [
        { name: "name", type: "string", required: true, unique: true, description: "The name of the area, project or workstream" },
        { name: "kind", type: "enum", values: ["area", "project", "workstream"], required: true, description: "Its level in the tree: an area, a project in it, or a workstream of a project" },
        { name: "parent", type: "link", ref: "self", hierarchy: true, ref_by: { column: "kind", levels: ["area", "project", "workstream"] }, description: "The area or project one level up" },
        { name: "status", type: "enum", values: ["active", "paused", "done"], default: "active", description: "Whether the work goes on, waits or is finished" },
      ],
      filename: "{name}", description: "Areas of responsibility, the projects in them and their workstreams", aliases: ["projects", "areas"],
      tags: { domain: "work", review: "weekly" },
    },
  },
  { op: "set_table_bases", args: { table: `${P}.project`, bases: ["dated"] } },
  // links in both directions: project.members <-> person.projects
  { op: "add_column", args: { table: `${P}.person`, column: { name: "projects", type: "list", items: "link", ref: `${P}.project`, description: "Projects the person works on" } } },
  { op: "add_column", args: { table: `${P}.project`, column: { name: "members", type: "list", items: "link", ref: `${P}.person`, inverse: "projects", description: "People on the project" } } },
  // tasks
  {
    op: "create_table",
    args: {
      catalog: "work",
      schema: "planning",
      name: "task",
      columns: [
        { name: "title", type: "string", required: true, unique: true, description: "The task, in a few words" },
        { name: "project", type: "link", ref: `${P}.project`, required: true, description: "The project or workstream the task belongs to" },
        { name: "assignee", type: "link", ref: `${P}.person`, description: "The person who does the task" },
        { name: "status", type: "enum", values: ["todo", "doing", "done"], required: true, default: "todo", description: "Whether the task is to do, under way or done" },
        { name: "priority", type: "enum", values: ["low", "medium", "high"], ordered: true, description: "How soon the task matters" },
        { name: "due", type: "date", description: "The day the task must be done by" },
        { name: "done_on", type: "date", description: "The day the task was done" },
        { name: "estimate_h", type: "number", min: 0, max: 80, description: "Hours of work the task should take" },
      ],
      filename: "{title}", description: "Things to do, each in a project or a workstream", aliases: ["tasks", "todo"],
      tags: { domain: "work" },
    },
  },
  { op: "set_table_bases", args: { table: `${P}.task`, bases: ["dated"] } },
  { op: "add_constraint", args: { table: `${P}.task`, name: "done_has_date", check: { or: [{ status: { ne: "done" } }, { done_on: { exists: true } }] } } },
  { op: "add_constraint", args: { table: `${P}.task`, name: "not_on_an_area", check: { "project.kind": { in: ["project", "workstream"] } } } },
  // people
  { op: "insert_row", args: { table: `${P}.person`, values: { name: "Ada Lovelace", email: "ada@example.com", role: "engineer" } } },
  { op: "insert_row", args: { table: `${P}.person`, values: { name: "Grace Hopper", email: "grace@example.com", role: "manager" } } },
  { op: "insert_row", args: { table: `${P}.person`, values: { name: "Alan Turing", email: "alan@example.com", role: "engineer" } } },
  { op: "insert_row", args: { table: `${P}.person`, values: { name: "Edith Clarke", email: "edith@example.com", role: "designer" } } },
  // the tree
  { op: "insert_row", args: { table: `${P}.project`, values: { name: "Engineering", kind: "area", summary: "Everything we build" } } },
  { op: "insert_row", args: { table: `${P}.project`, values: { name: "Operations", kind: "area", summary: "Running the company" } } },
  {
    op: "insert_row",
    args: {
      table: `${P}.project`,
      values: { name: "Website relaunch", kind: "project", parent: "[[Engineering]]", started_on: "2026-09-01", members: ["[[Ada Lovelace]]", "[[Edith Clarke]]"] },
      body: "## Goals\n\nA faster site on the new design system.\n\n## Risks\n\nThe old URLs must keep working.\n",
    },
  },
  { op: "insert_row", args: { table: `${P}.project`, values: { name: "Data platform", kind: "project", parent: "[[Engineering]]", started_on: "2026-07-15", members: ["[[Alan Turing]]", "[[Grace Hopper]]"] } } },
  { op: "insert_row", args: { table: `${P}.project`, values: { name: "Office move", kind: "project", parent: "[[Operations]]", status: "paused", members: ["[[Grace Hopper]]"] } } },
  { op: "insert_row", args: { table: `${P}.project`, values: { name: "Design system", kind: "workstream", parent: "[[Website relaunch]]", members: ["[[Edith Clarke]]"] } } },
  { op: "insert_row", args: { table: `${P}.project`, values: { name: "Content migration", kind: "workstream", parent: "[[Website relaunch]]", members: ["[[Ada Lovelace]]"] } } },
  { op: "insert_row", args: { table: `${P}.project`, values: { name: "Ingestion", kind: "workstream", parent: "[[Data platform]]", status: "done", members: ["[[Alan Turing]]"] } } },
  // tasks
  { op: "insert_row", args: { table: `${P}.task`, values: { title: "Choose the colour palette", project: "[[Design system]]", assignee: "[[Edith Clarke]]", status: "done", priority: "medium", done_on: "2026-09-20", estimate_h: 6 } } },
  { op: "insert_row", args: { table: `${P}.task`, values: { title: "Build the button component", project: "[[Design system]]", assignee: "[[Edith Clarke]]", status: "doing", priority: "high", due: "2026-10-15", estimate_h: 12 } } },
  { op: "insert_row", args: { table: `${P}.task`, values: { title: "Export the old pages", project: "[[Content migration]]", assignee: "[[Ada Lovelace]]", status: "todo", priority: "high", due: "2026-10-20", estimate_h: 8 } } },
  { op: "insert_row", args: { table: `${P}.task`, values: { title: "Redirect the old URLs", project: "[[Content migration]]", status: "todo", priority: "low", due: "2026-11-05" } } },
  { op: "insert_row", args: { table: `${P}.task`, values: { title: "Write the launch post", project: "[[Website relaunch]]", assignee: "[[Grace Hopper]]", status: "todo", priority: "medium", due: "2026-11-30", summary: "Announce the new site" } } },
  { op: "insert_row", args: { table: `${P}.task`, values: { title: "Load the sales events", project: "[[Ingestion]]", assignee: "[[Alan Turing]]", status: "done", priority: "high", started_on: "2026-08-01", done_on: "2026-09-10", estimate_h: 20 } } },
  { op: "insert_row", args: { table: `${P}.task`, values: { title: "Pick a query engine", project: "[[Data platform]]", assignee: "[[Alan Turing]]", status: "doing", priority: "medium", due: "2026-10-31" } } },
  { op: "insert_row", args: { table: `${P}.task`, values: { title: "Find the new office", project: "[[Office move]]", assignee: "[[Grace Hopper]]", status: "todo", priority: "low" } } },
  // stored queries
  {
    op: "create_view",
    args: {
      name: "vw_open_tasks",
      query: { table: `${P}.task`, columns: ["title", "project", "assignee", "priority", "due"], where: { status: { ne: "done" } }, order_by: "due" },
      description: "Tasks not done yet, the nearest due date first",
      aliases: ["open tasks", "what is left"],
      labels: { title: "Task", project: "Project", assignee: "Who", priority: "Priority", due: "Due" },
    },
  },
  {
    op: "create_view",
    args: {
      name: "vw_engineering",
      query: { table: `${P}.project`, columns: ["name", "kind", "parent", "status"], where: { parent: { within: "[[Engineering]]" } }, order_by: "name" },
      description: "Projects and workstreams under the Engineering area, at any depth",
    },
  },
  {
    op: "create_view",
    args: {
      name: "vw_project_tasks",
      query: { table: `${P}.task`, columns: ["title", "project", "status", "assignee", "due"], where: { project: { within: "{this.link}" } }, order_by: "title" },
      description: "Tasks of the project a note is about, its workstreams included: select it with this_note = the project's note",
      aliases: ["project tasks"],
    },
  },
];

// Notes that are not rows of any table yet, written as a person would (an editor, a sync): what
// infer_table reads and adopt_rows turns into rows. Not engine output, like Welcome.md.
const MEETINGS = {
  "Meetings/2026-09-02 Website kickoff.md": `---
date: 2026-09-02
kind: kickoff
project: "[[Website relaunch]]"
attendees:
  - "[[Ada Lovelace]]"
  - "[[Edith Clarke]]"
---
# Website kickoff

We agreed on the scope of the relaunch and on a new colour palette.
`,
  "Meetings/2026-09-09 Data platform kickoff.md": `---
date: 2026-09-09
kind: kickoff
project: "[[Data platform]]"
attendees:
  - "[[Alan Turing]]"
  - "[[Grace Hopper]]"
---
# Data platform kickoff

Which query engine, and how the sales events are loaded.
`,
  "Meetings/2026-09-23 Website review.md": `---
date: 2026-09-23
kind: review
project: "[[Website relaunch]]"
attendees:
  - "[[Edith Clarke]]"
  - "[[Grace Hopper]]"
mood: tense
---
# Website review

The button component is late; the launch post moves to November.
`,
  "Meetings/2026-09-30 Data platform review.md": `---
date: 2026-09-30
kind: review
project: "[[Data platform]]"
attendees:
  - "[[Alan Turing]]"
---
# Data platform review

Ingestion is done; the query engine is still open.
`,
};

const WELCOME = `# Test vault

A small vault for developing Datanotes. It is not a row of any table: a plain note.

The database is in \`datanotes/metastore.yaml\`: the catalog \`work\`, schema \`planning\`, with the
tables \`person\`, \`project\` (areas, projects and workstreams in a tree) and \`task\`, the base
\`dated\` and the views \`vw_open_tasks\`, \`vw_engineering\` and \`vw_project_tasks\` (for a project's
note). \`Meetings/\` holds notes that are not rows yet.

Regenerate it with \`node scripts/make-test-vault.mjs\` (after \`npm run build:service\`); never edit
the rows or the metastore by hand. See [[Website relaunch]] for a project.
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-make-test-vault-"));
const port = await freePort();
const token = "make-test-vault";
// the engine's store: a temporary folder (never the user's data folder), removed at the end
const store = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-make-test-vault-store-"));
fs.writeFileSync(path.join(store, "settings.json"), JSON.stringify({ httpServerPort: port, httpServerToken: token, fileLogEnabled: false }));
const child = spawn(process.execPath, [cli, "serve", "--vault", root, "--store", store, "--watch", "poll", "--poll-ms", "300"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DATANOTES_DATA_HOME: store },
});
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));

const client = new DatanotesClient({ url: `http://127.0.0.1:${port}`, token, actor: { harness: "make-test-vault" } });
try {
  const deadline = Date.now() + 30_000;
  while (!(await client.ping())) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the engine did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const { op, args } of ops) {
    const r = await client.call(op, args);
    if (!r.ok) throw new Error(`${op} ${JSON.stringify(args).slice(0, 200)} was refused: ${typeof r.value === "string" ? r.value : JSON.stringify(r.value).slice(0, 2000)}`);
  }
  fs.writeFileSync(path.join(root, "Welcome.md"), WELCOME);
  for (const [rel, text] of Object.entries(MEETINGS)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const check = await client.call("check_table", {});
  if (!check.ok) throw new Error(`check_table failed: ${JSON.stringify(check.value).slice(0, 2000)}`);
  if (!Array.isArray(check.value.violations) || check.value.violations.length > 0) throw new Error(`the vault has violations: ${JSON.stringify(check.value).slice(0, 3000)}`);
} finally {
  child.kill();
  await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
}

// test-vault/ = the generated vault without the engine's state
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(root, target, { recursive: true, filter: (src) => path.relative(root, src).split(path.sep)[0] !== ".datanotes" });
fs.writeFileSync(path.join(target, ".gitignore"), "# deleted notes (the engine keeps its own state outside the vault, in its store)\n.trash/\n");
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(store, { recursive: true, force: true });
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(path.relative(target, p).split(path.sep).join("/"));
  }
};
walk(target);
console.log(`test-vault/ regenerated: ${files.length} files\n  ${files.sort().join("\n  ")}`);
