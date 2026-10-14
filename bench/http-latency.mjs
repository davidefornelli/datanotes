#!/usr/bin/env node
/**
 * HTTP latency benchmark of a running engine: drives realistic operations over the HTTP API and
 * prints client-side latency percentiles per operation (p50, p95, max).
 *
 *   node bench/http-latency.mjs --port 27300 --token-file token.txt [--vault <folder>]
 *        [--task-table <table>] [--note-table <table>] [--iterations 20] [--concurrency 4]
 *        [--tables 6] [--bulk-edits 200] [--json out.json]
 *        [--only reads,writes,ddl,graph,concurrent,cache,background]
 *
 * `--only scale` (never part of the default run) measures what a large vault makes slow, every
 * read with arguments that change on each call (a miss of the read cache): select_rows on the
 * biggest and the smallest table, views, `base:<name>`, expand, within, this_note, backlinks
 * (file_backlink_count, graph_neighbors in), graph_neighbors on one table and on the whole vault,
 * search_notes, describe_table, list_changes; then insert_row, update_row, batch, delete_rows
 * and undo_migration on --task-table.
 *
 * Run it only against a copy of a vault: it writes rows (undone at the end), creates and drops a
 * scratch table, and with --vault it edits the bench's own rows by hand to keep the engine's
 * background jobs busy. Without --task-table / --note-table it creates two scratch tables and
 * drops them (archive) at the end.
 *
 * The token needs write on the tables it writes and ddl (a named token, or the owner's).
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

// --- arguments -------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    const name = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const port = args.port ?? process.env.DATANOTES_PORT;
const base = (args.url ?? (port ? `http://127.0.0.1:${port}` : process.env.DATANOTES_URL ?? "")).replace(/\/$/, "");
const token = args.token ?? (args["token-file"] ? fs.readFileSync(args["token-file"], "utf8").trim() : process.env.DATANOTES_TOKEN);
if (!base || !token) {
  console.error("usage: node bench/http-latency.mjs --port <port> | --url <url>  --token <t> | --token-file <file>");
  process.exit(2);
}
const ITER = Number(args.iterations ?? 20);
const CONC = Number(args.concurrency ?? 4);
const TOP_TABLES = Number(args.tables ?? 6);
const only = args.only ? new Set(String(args.only).split(",")) : null;
const want = (g) => !only || only.has(g);
const vault = typeof args.vault === "string" ? args.vault : null;
/** The table with the most rows (discover). */
let BIGGEST;

// --- calls and samples ---------------------------------------------------------------------------

const samples = new Map(); // name -> ms[]
const failures = new Map(); // name -> count

async function call(op, body = {}, label = op) {
  const t0 = performance.now();
  const res = await fetch(`${base}/datanotes/operations/${op}/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.ok === false) {
    failures.set(label, (failures.get(label) ?? 0) + 1);
    const err = new Error(`${op} ${res.status}: ${(json.error ?? json.conflicts?.[0]?.message ?? text).toString().slice(0, 300)}`);
    err.result = json;
    err.ms = ms;
    throw err;
  }
  if (label) record(label, ms);
  return json;
}

function record(label, ms) {
  let s = samples.get(label);
  if (!s) samples.set(label, (s = []));
  s.push(ms);
}

async function timed(label, fn) {
  const t0 = performance.now();
  const r = await fn();
  record(label, performance.now() - t0);
  return r;
}

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summary() {
  const rows = [];
  for (const [name, s] of samples) {
    const sorted = [...s].sort((a, b) => a - b);
    rows.push({ name, n: s.length, p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted[sorted.length - 1], failed: failures.get(name) ?? 0 });
  }
  return rows;
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const quiet = async (p) => {
  try {
    return await p;
  } catch (e) {
    console.warn(`  ! ${e.message}`);
    return null;
  }
};

// --- the vault's shape -----------------------------------------------------------------------------

async function discover() {
  const { tables, views } = await call("list_tables", {});
  const described = [];
  await pool(tables, 4, async (t) => {
    const d = await quiet(call("describe_table", { table: t.qualified }, "describe_table"));
    if (d) described.push(d);
  });
  // row counts: a select of the paths only
  const counted = [];
  await pool(described, 4, async (d) => {
    let rows = 0;
    for (;;) {
      const r = await quiet(call("select_rows", { table: d.qualified, columns: ["path"], limit: 1000, offset: rows }, null));
      const n = r?.rows?.length ?? 0;
      rows += n;
      if (n < 1000) break;
    }
    counted.push({ def: d, rows });
  });
  counted.sort((a, b) => b.rows - a.rows);
  BIGGEST = counted[0]?.def.qualified;
  return { tables, views: views ?? [], counted };
}

function isLink(c) {
  return c.type === "link" || (c.type === "list" && c.items === "link");
}

/** The typical filters of a table: by an enum value, by a date range, by a link. */
async function filtersFor(def) {
  const out = [];
  const en = def.columns.find((c) => c.type === "enum" && c.values?.length && c.name !== "origin");
  if (en) out.push({ kind: "status", where: { [en.name]: en.values[0] } });
  const dt = def.columns.find((c) => (c.type === "date" || c.type === "datetime") && c.identity !== "created") ?? def.columns.find((c) => c.type === "date" || c.type === "datetime");
  if (dt) {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    out.push({ kind: "date_range", where: { [dt.name]: { gte: from } }, order_by: `-${dt.name}` });
  }
  const ln = def.columns.find((c) => isLink(c) && c.name !== "nodes") ?? def.columns.find(isLink);
  if (ln) {
    const r = await quiet(call("select_rows", { table: def.qualified, columns: [ln.name], where: { [ln.name]: { exists: true } }, limit: 1 }, null));
    const v = r?.rows?.[0]?.[ln.name];
    const one = Array.isArray(v) ? v[0] : v;
    if (one) out.push({ kind: "link", where: { [ln.name]: c(ln) ? { contains: one } : one } });
  }
  return out;
  function c(col) {
    return col.type === "list";
  }
}

// --- scenarios -----------------------------------------------------------------------------------

const RUN = `pb${Date.now().toString(36)}`;
const undoStack = []; // migration ids, oldest first
const handEdited = new Set(); // paths of rows edited by hand: deleted, not undone

async function ensureScratchTables() {
  const made = [];
  let taskTable = args["task-table"];
  let noteTable = args["note-table"];
  if (!taskTable) {
    taskTable = `perf_task_${RUN}`;
    await call("create_table", {
      name: taskTable,
      description: "Benchmark scratch: things to do",
      filename: "{title}",
      columns: [
        { name: "title", type: "string", required: true, description: "What to do" },
        { name: "status", type: "enum", values: ["open", "done"], default: "open", required: true, description: "Whether it is done" },
        { name: "due", type: "date", description: "When it is due" },
        { name: "related", type: "list", items: "link", description: "Notes it relates to" },
      ],
    }, "create_table(scratch)");
    made.push(taskTable);
  }
  if (!noteTable) {
    noteTable = `perf_note_${RUN}`;
    await call("create_table", {
      name: noteTable,
      description: "Benchmark scratch: free notes",
      filename: "{title}",
      columns: [{ name: "title", type: "string", required: true, description: "The note's title" }],
    }, "create_table(scratch)");
    made.push(noteTable);
  }
  return { taskTable, noteTable, made };
}

async function taskValues(table, i) {
  const d = await call("describe_table", { table }, null);
  const v = {};
  for (const c of d.columns) {
    if (c.identity || c.generated) continue;
    if (c.name === "title" || c.name === "name") v[c.name] = `Bench ${RUN} ${i}`;
    else if (c.required && c.type === "enum") v[c.name] = c.default ?? c.external_default ?? c.values[0];
    else if (c.required && c.type === "string") v[c.name] = `bench ${i}`;
    else if (c.required && (c.type === "date" || c.type === "datetime")) v[c.name] = new Date().toISOString().slice(0, c.type === "date" ? 10 : 19);
    else if (c.required && (c.type === "integer" || c.type === "number")) v[c.name] = c.min ?? 1;
    else if (c.required && c.type === "boolean") v[c.name] = false;
    else if (c.required && isLink(c)) {
      // a required link: the value an existing row has
      const r = await quiet(call("select_rows", { table, columns: [c.name], where: { [c.name]: { exists: true } }, limit: 1 }, null));
      const x = r?.rows?.[0]?.[c.name];
      if (x !== undefined) v[c.name] = x;
    }
  }
  if (!("title" in v) && !("name" in v)) v.title = `Bench ${RUN} ${i}`;
  return { values: v, columns: d.columns };
}

async function writes(taskTable, noteTable) {
  console.log(`writes: ${ITER} x insert_row/update_row into ${taskTable}, ${noteTable}`);
  const shape = await taskValues(taskTable, 0);
  const noteShape = await taskValues(noteTable, 0);
  const prio = shape.columns.find((c) => c.type === "enum" && !c.required && c.values?.length > 1) ?? shape.columns.find((c) => c.type === "enum" && c.name !== "origin" && c.values?.length > 1);
  const rows = [];
  for (let i = 0; i < ITER; i++) {
    const values = { ...shape.values, title: undefined, name: undefined };
    const key = "title" in shape.values ? "title" : "name";
    values[key] = `Bench ${RUN} task ${i}`;
    delete values[key === "title" ? "name" : "title"];
    const r = await call("insert_row", { table: taskTable, values }, "insert_row(task)");
    undoStack.push(r.migration_id);
    rows.push(r.planned_creates[0]);
    const nv = { ...noteShape.values };
    nv["title" in nv ? "title" : "name"] = `Bench ${RUN} note ${i}`;
    const n = await call("insert_row", { table: noteTable, values: nv, body: "A free note written by the benchmark.\n" }, "insert_row(note)");
    undoStack.push(n.migration_id);
  }
  for (let i = 0; i < ITER; i++) {
    const set = prio ? { [prio.name]: prio.values[(i % (prio.values.length - 1)) + 1] } : {};
    const r = await call("update_row", { table: taskTable, path: rows[i], set, body_append: `\nupdate ${i}\n` }, "update_row(task)");
    undoStack.push(r.migration_id);
  }
  for (let i = 0; i < Math.max(3, ITER / 4); i++) {
    const v1 = { ...noteShape.values };
    v1["title" in v1 ? "title" : "name"] = `Bench ${RUN} batch ${i} a`;
    const v2 = { ...noteShape.values };
    v2["title" in v2 ? "title" : "name"] = `Bench ${RUN} batch ${i} b`;
    const r = await call("batch", {
      operations: [
        { op: "insert_row", table: noteTable, values: v1 },
        { op: "insert_row", table: noteTable, values: v2 },
        { op: "update_row", table: taskTable, path: rows[i], body_append: `\nbatch ${i}\n` },
      ],
    }, "batch(3 writes)");
    undoStack.push(r.migration_id);
  }
  return rows;
}

async function undoAll(label = "undo_migration") {
  console.log(`undo_migration x ${undoStack.length}`);
  while (undoStack.length) {
    const id = undoStack.pop();
    await quiet(call("undo_migration", { migration_id: id }, label));
  }
}

async function ddl() {
  console.log("ddl: create_table, add_column, drop_column, drop_table on a scratch table");
  for (let i = 0; i < Math.max(3, ITER / 4); i++) {
    const name = `perf_ddl_${RUN}_${i}`;
    await call("create_table", { name, description: "Benchmark scratch table", filename: "{title}", columns: [{ name: "title", type: "string", required: true, description: "Title" }] }, "create_table");
    await call("add_column", { table: name, column: { name: "score", type: "integer", description: "A number" } }, "add_column");
    await call("drop_column", { table: name, column: "score" }, "drop_column");
    await call("drop_table", { table: name }, "drop_table");
  }
}

/** The reads of the biggest tables and of the first views: the same plans for every scenario. */
async function readPlans(shape) {
  const top = shape.counted.slice(0, TOP_TABLES);
  const plans = [];
  for (const t of top) {
    plans.push({ label: "select_rows(all, limit 50)", body: { table: t.def.qualified, limit: 50 } });
    for (const f of await filtersFor(t.def)) {
      plans.push({ label: `select_rows(${f.kind})`, body: { table: t.def.qualified, where: f.where, ...(f.order_by ? { order_by: f.order_by } : {}), limit: 100 } });
    }
  }
  for (const v of shape.views.slice(0, 8)) plans.push({ label: "select_rows(view)", body: { table: v.qualified ?? v.name, limit: 100 } });
  return plans;
}

async function reads(shape) {
  const top = shape.counted.slice(0, TOP_TABLES);
  console.log(`reads: ${top.map((t) => `${t.def.name}(${t.rows})`).join(", ")}`);
  const plans = await readPlans(shape);
  for (let i = 0; i < ITER; i++) {
    await call("list_tables", {});
    await call("describe_table", { table: top[i % top.length].def.qualified });
    const head = (await call("list_changes", { limit: 100 }, "list_changes(from the start)")).head ?? 0;
    await call("list_changes", { since: Math.max(0, head - 50), limit: 100 }, "list_changes(recent)");
    for (const p of plans) await quiet(call("select_rows", p.body, p.label));
  }
  return plans;
}

async function graph(shape) {
  const tables = shape.tables.filter((t) => t.catalog !== "system").map((t) => t.qualified);
  console.log(`graph: graph_neighbors on ${tables.length} tables, 6 at a time (as the graph app), x ${Math.max(2, ITER / 5)}`);
  for (let i = 0; i < Math.max(2, ITER / 5); i++) {
    await timed("graph: whole vault, per table x6", () => pool(tables, 6, (table) => quiet(call("graph_neighbors", { from_nodes: { table }, direction: "out" }, "graph_neighbors(table)"))));
    // the one-call form (engines before it refuse it: the row stays empty)
    await quiet(call("graph_neighbors", { from_nodes: { tables: ["*"] }, direction: "out" }, "graph: whole vault, one call"));
  }
}

async function concurrent(shape, plans, taskTable) {
  console.log(`concurrent: ${CONC} clients of reads, one writer`);
  const shapeT = await taskValues(taskTable, 0);
  const key = "title" in shapeT.values ? "title" : "name";
  let stop = false;
  const writer = (async () => {
    let i = 0;
    while (!stop) {
      const values = { ...shapeT.values, [key]: `Bench ${RUN} conc ${i++}` };
      const r = await quiet(call("insert_row", { table: taskTable, values }, "insert_row(task) under read load"));
      if (r) undoStack.push(r.migration_id);
    }
  })();
  const jobs = [];
  for (let i = 0; i < ITER; i++) for (const p of plans) jobs.push(p);
  await pool(jobs, CONC, (p) => quiet(call("select_rows", p.body, `${p.label} x${CONC}`)));
  stop = true;
  await writer;
}

/**
 * The read cache: a read asked again with nothing changed (a hit with the cache on), a read of the
 * table just written (always computed again), a read of another table after a write (a hit: the
 * write did not touch it).
 */
async function cacheReads(shape, plans, taskTable) {
  console.log(`cache: ${plans.length} reads asked again, reads after writes`);
  const shapeT = await taskValues(taskTable, 0);
  const key = "title" in shapeT.values ? "title" : "name";
  for (const p of plans) await quiet(call("select_rows", p.body, null)); // computed once
  for (let i = 0; i < ITER; i++) for (const p of plans) await quiet(call("select_rows", p.body, "select_rows(asked again)"));
  const other = plans[0];
  for (let i = 0; i < ITER; i++) {
    const r = await quiet(call("insert_row", { table: taskTable, values: { ...shapeT.values, [key]: `Bench ${RUN} cache ${i}` } }, null));
    if (r) undoStack.push(r.migration_id);
    await quiet(call("select_rows", { table: taskTable, limit: 50 }, "select_rows(the table just written)"));
    await quiet(call("select_rows", other.body, "select_rows(another table, after a write)"));
  }
}

async function background(rows, plans, taskTable) {
  if (!vault) return console.log("background: skipped (no --vault)");
  console.log("background: hand edits of the bench rows on disk while reading and writing");
  const files = rows.map((p) => path.join(vault, p)).filter((f) => fs.existsSync(f));
  const shapeT = await taskValues(taskTable, 0);
  const key = "title" in shapeT.values ? "title" : "name";
  let stop = false;
  let n = 0;
  const editor = (async () => {
    while (!stop) {
      for (const f of files) fs.appendFileSync(f, `\nhand edit ${n}\n`);
      for (const p of rows) handEdited.add(p);
      n++;
      await new Promise((r) => setTimeout(r, 800));
    }
  })();
  for (let i = 0; i < ITER; i++) {
    const values = { ...shapeT.values, [key]: `Bench ${RUN} bg ${i}` };
    const r = await quiet(call("insert_row", { table: taskTable, values }, "insert_row(task) during hand edits"));
    if (r) undoStack.push(r.migration_id);
    const p = plans[i % plans.length];
    await quiet(call("select_rows", p.body, "select_rows during hand edits"));
    await quiet(call("list_changes", { since: 0, limit: 100 }, "list_changes during hand edits"));
  }
  stop = true;
  await editor;
  await bulkEdits(shapeT, key, taskTable);
}

/**
 * A git pull: --bulk-edits rows of the biggest table changed by hand at once (a line added at the
 * end), then put back; the engine logs them (job hand_edits_log). Rows are written meanwhile.
 */
async function bulkEdits(shapeT, key, taskTable) {
  const count = Number(args["bulk-edits"] ?? 200);
  if (!count) return;
  const biggest = shapeT && (await call("select_rows", { table: BIGGEST, columns: ["path"], limit: Math.min(count, 1000) }, null));
  const files = (biggest?.rows ?? []).map((r) => path.join(vault, r.path)).filter((f) => fs.existsSync(f));
  console.log(`background: ${files.length} rows of ${BIGGEST} edited by hand at once, then put back`);
  const before = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
  const during = async (label) => {
    const until = performance.now() + 9000; // the engine logs hand edits 3 s after the last one
    for (let i = 0; performance.now() < until; i++) {
      const values = { ...shapeT.values, [key]: `Bench ${RUN} ${label} ${i}` };
      const r = await quiet(call("insert_row", { table: taskTable, values }, `insert_row(task) after ${files.length} hand edits`));
      if (r) undoStack.push(r.migration_id);
      await new Promise((res) => setTimeout(res, 250));
    }
  };
  try {
    for (const f of files) fs.appendFileSync(f, "\n");
    await during("bulk");
  } finally {
    for (const [f, text] of before) fs.writeFileSync(f, text);
  }
  await during("bulk back");
}

/** Reads that miss the read cache (arguments change on every call), and writes on a big table. */
async function scale(shape, taskTable) {
  const big = shape.counted[0].def;
  const small = shape.counted[shape.counted.length - 1].def;
  const bigF = await filtersFor(big);
  const views = shape.views.map((v) => v.qualified ?? v.name);
  const words = ["budget roadmap", "garden harvest", "quiet falcon", "review draft", "coffee", "migration plan", "river light", "schedule week"];
  const linkCol = big.columns.find((c) => isLink(c) && c.name !== "nodes");
  const persons = shape.counted.find((t) => /person|people|contact/.test(t.def.name))?.def ?? null;
  const hier = shape.counted.find((t) => t.def.columns.some((c) => c.hierarchy))?.def ?? null;
  const hierCol = hier?.columns.find((c) => c.hierarchy);
  const top = hier ? (await quiet(call("select_rows", { table: hier.qualified, columns: ["path", hierCol.name], where: { [hierCol.name]: { exists: false } }, limit: 5 }, null)))?.rows ?? [] : [];
  const area = top[0] ? `[[${top[0].path.split("/").pop().replace(/\.md$/, "")}]]` : null;
  const someRows = (await quiet(call("select_rows", { table: big.qualified, columns: ["path"], limit: 200 }, null)))?.rows ?? [];
  const personRows = persons ? (await quiet(call("select_rows", { table: persons.qualified, columns: ["path"], limit: 200 }, null)))?.rows ?? [] : [];
  const projectRows = hier ? (await quiet(call("select_rows", { table: hier.qualified, columns: ["path"], where: { [hierCol.name]: { exists: true } }, limit: 200 }, null)))?.rows ?? [] : [];
  const bases = (await quiet(call("describe_database", {}, null)))?.bases ?? [];
  const baseNames = (Array.isArray(bases) ? bases : Object.keys(bases)).map((b) => (typeof b === "string" ? b : b.name)).filter(Boolean);
  const tables = shape.tables.filter((t) => t.catalog !== "system").map((t) => t.qualified);
  console.log(`scale: big ${big.qualified} (${shape.counted[0].rows}), small ${small.qualified} (${shape.counted[shape.counted.length - 1].rows}), ${views.length} views, bases ${baseNames.join(",")}, ${ITER} x each`);
  for (let i = 0; i < ITER; i++) {
    const lim = 20 + i;
    await quiet(call("select_rows", { table: big.qualified, limit: lim }, "scale: select_rows big (all)"));
    for (const f of bigF) await quiet(call("select_rows", { table: big.qualified, where: f.where, ...(f.order_by ? { order_by: f.order_by } : {}), limit: lim }, `scale: select_rows big (${f.kind})`));
    await quiet(call("select_rows", { table: big.qualified, where: { path: someRows[i % Math.max(1, someRows.length)]?.path ?? "" }, limit: lim }, "scale: select_rows big (by path)"));
    await quiet(call("select_rows", { table: small.qualified, limit: lim }, "scale: select_rows small (all)"));
    await quiet(call("select_rows", { table: views[i % views.length], limit: lim }, "scale: select_rows (view)"));
    if (baseNames.length) await quiet(call("select_rows", { table: `base:${baseNames[i % baseNames.length]}`, limit: lim }, "scale: select_rows (base)"));
    if (linkCol) await quiet(call("select_rows", { table: big.qualified, expand: [linkCol.name], limit: lim }, "scale: select_rows big (expand)"));
    if (area && hier) await quiet(call("select_rows", { table: hier.qualified, where: { [hierCol.name]: { within: area } }, limit: lim }, "scale: select_rows (within, hierarchy)"));
    if (area && linkCol && linkCol.ref === hier?.qualified) await quiet(call("select_rows", { table: big.qualified, where: { [linkCol.name]: { within: area } }, limit: lim }, "scale: select_rows big (within, via link)"));
    if (projectRows.length) {
      const pv = views.find((v) => /project_tasks/.test(v));
      if (pv) await quiet(call("select_rows", { table: pv, this_note: projectRows[i % projectRows.length].path, limit: lim }, "scale: select_rows (view, this_note)"));
    }
    if (persons) await quiet(call("select_rows", { table: persons.qualified, columns: ["path", "file_backlink_count"], order_by: "-file_backlink_count", limit: lim }, "scale: select_rows (file_backlink_count)"));
    if (personRows.length) await quiet(call("graph_neighbors", { from_nodes: { paths: [personRows[i % personRows.length].path] }, direction: "in" }, "scale: graph_neighbors (backlinks of 1 note)"));
    await quiet(call("graph_neighbors", { from_nodes: { table: tables[i % tables.length] }, direction: "out" }, "scale: graph_neighbors (one table)"));
    if (i < Math.max(2, ITER / 4)) await quiet(call("graph_neighbors", { from_nodes: { tables: ["*"] }, direction: i % 2 ? "out" : "both" }, "scale: graph_neighbors (whole vault)"));
    await quiet(call("search_notes", { query: `${words[i % words.length]}`, context_length: 40 + i }, "scale: search_notes"));
    await quiet(call("describe_table", { table: tables[(i * 7) % tables.length] }, "scale: describe_table"));
    await quiet(call("list_changes", { limit: 20 + i }, "scale: list_changes"));
  }
  // writes on the big table (not with --no-scale-writes)
  if (args["no-scale-writes"]) return;
  const shapeT = await taskValues(taskTable, 0);
  const key = "title" in shapeT.values ? "title" : "name";
  const paths = [];
  const ids = [];
  for (let i = 0; i < ITER; i++) {
    const r = await quiet(call("insert_row", { table: taskTable, values: { ...shapeT.values, [key]: `Bench ${RUN} scale ${i}` }, body: "Written by the benchmark.\n" }, "scale: insert_row"));
    if (r) paths.push(r.planned_creates[0]);
  }
  for (let i = 0; i < paths.length; i++) {
    const r = await quiet(call("update_row", { table: taskTable, path: paths[i], body_append: `\nupdate ${i}\n` }, "scale: update_row"));
    if (r) ids.push(r.migration_id);
  }
  for (let i = 0; i + 1 < paths.length && i < ITER / 2; i += 2) {
    const r = await quiet(call("batch", { operations: [{ op: "update_row", table: taskTable, path: paths[i], body_append: "\nbatch\n" }, { op: "update_row", table: taskTable, path: paths[i + 1], body_append: "\nbatch\n" }] }, "scale: batch (2 updates)"));
    if (r) ids.push(r.migration_id);
  }
  // undo the updates (newest first), then delete the inserted rows one at a time
  while (ids.length) await quiet(call("undo_migration", { migration_id: ids.pop() }, "scale: undo_migration"));
  for (const p of paths) await quiet(call("delete_rows", { table: taskTable, where: { path: p }, mode: "delete", on_referenced: "ignore" }, "scale: delete_rows (1 row)"));
}

async function cleanup(taskTable, made) {
  // rows edited by hand cannot be undone: undo what can be, then delete the rest
  await undoAll("undo_migration(cleanup)");
  if (handEdited.size) {
    await quiet(call("delete_rows", { table: taskTable, where: { path: { in: [...handEdited] } }, mode: "delete", on_referenced: "ignore" }, null));
  }
  for (const t of made) await quiet(call("drop_table", { table: t, mode: "archive" }, null));
}

// --- main ------------------------------------------------------------------------------------------

const started = performance.now();
const shape = await discover();
console.log(`${base}: ${shape.tables.length} tables, ${shape.views.length} views, ${shape.counted.reduce((s, t) => s + t.rows, 0)} rows`);
const { taskTable, noteTable, made } = await ensureScratchTables();
let rows = [];
let plans = [];
try {
  if (want("reads") || want("concurrent") || want("background")) plans = await (want("reads") ? reads(shape) : Promise.resolve([]));
  if (!plans.length && (want("concurrent") || want("background") || want("cache"))) plans = await readPlans(shape);
  if (want("graph")) await graph(shape);
  if (want("writes") || want("background")) rows = await writes(taskTable, noteTable);
  if (want("writes")) await undoAllButKeep(rows);
  if (want("concurrent")) await concurrent(shape, plans, taskTable);
  if (want("cache")) await cacheReads(shape, plans, taskTable);
  if (want("background")) {
    if (!rows.length) rows = await writes(taskTable, noteTable);
    await background(rows, plans, taskTable);
  }
  if (want("ddl")) await ddl();
  if (only?.has("scale")) await scale(shape, taskTable);
} finally {
  await cleanup(taskTable, made);
}

/** Undo the measured writes now (so undo is measured on a fresh journal), keeping nothing. */
async function undoAllButKeep() {
  await undoAll();
  rows = [];
}

const result = summary();
const w = Math.max(...result.map((r) => r.name.length), 10);
console.log(`\n${"operation".padEnd(w)}      n     p50 ms     p95 ms     max ms  failed`);
for (const r of result) {
  console.log(`${r.name.padEnd(w)} ${String(r.n).padStart(6)} ${r.p50.toFixed(1).padStart(10)} ${r.p95.toFixed(1).padStart(10)} ${r.max.toFixed(1).padStart(10)} ${String(r.failed).padStart(7)}`);
}
console.log(`\ntotal ${((performance.now() - started) / 1000).toFixed(1)} s, run ${RUN}`);
if (typeof args.json === "string") fs.writeFileSync(args.json, JSON.stringify({ base, run: RUN, at: new Date().toISOString(), label: args.label ?? null, results: result }, null, 2));
