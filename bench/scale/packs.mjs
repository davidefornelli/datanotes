#!/usr/bin/env node
/**
 * Packs of rows, measured: the same rows of one table as notes of their own, then in monthly
 * packs (pack_rows). For both: the first start (no vault index) and a restart, the first
 * `select_rows` after each, `select_rows` of one month, the resident memory once idle, the vault
 * index on disk, and git (`git add` + `git commit` of the whole vault, then `git status`).
 *
 *   npm run build:service
 *   node bench/scale/packs.mjs --rows 50000 --out <folder> [--port 27405] [--runs 5]
 *
 * The rows are written as files in the format the engine writes (a bulk import), old enough to be
 * packed; the schema is made by the engine's own operations. Never point it at real data.
 * Memory is read from /proc (Linux); elsewhere it is null. Writes <out>/packs-result.json.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs, sleep, startEngine } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const ROWS = Number(args.rows ?? 50000);
const OUT = path.resolve(String(args.out ?? ""));
const PORT = Number(args.port ?? 27405);
const RUNS = Number(args.runs ?? 5);
const TOKEN = "packs-bench-owner";
const TABLE = "main.public.event";
if (!args.out) {
  console.error("usage: node bench/scale/packs.mjs --rows 50000 --out <folder> [--port 27405] [--runs 5]");
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("[packs]", ...a);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor(s.length / 2)];
};
const round = (x) => (x === null ? null : Math.round(x * 10) / 10);

/** Resident memory of a process (MB), from /proc; null elsewhere. */
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/** Files and bytes under a folder. */
function tree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

// --- 1. the table, through the engine -------------------------------------------------------------

const base = path.join(OUT, "single");
const vault = (dir) => path.join(dir, "vault");
const store = (dir) => path.join(dir, "store");
const home = (dir) => path.join(dir, "datahome");
for (const d of [vault(base), store(base), home(base)]) fs.mkdirSync(d, { recursive: true });

async function engineOn(dir, settings = {}) {
  return startEngine({ vault: vault(dir), store: store(dir), port: PORT, token: TOKEN, dataHome: home(dir), settings: { fileLogEnabled: false, autoPack: false, ...settings } });
}

{
  const e = await engineOn(base);
  await e.call("create_table", {
    name: "event",
    description: "Events of a sensor log, one per reading",
    time_column: "at",
    partition: "{at:YYYY/MM}",
    pack: "{at:YYYY-MM}",
    columns: [
      { name: "at", type: "datetime", required: true, description: "When the reading was taken" },
      { name: "kind", type: "enum", values: ["start", "stop", "level"], description: "What the reading is" },
      { name: "value", type: "number", description: "The value read" },
      { name: "note", type: "string", description: "A short remark" },
    ],
  });
  await e.stop();
}

// --- 2. the rows, as files ------------------------------------------------------------------------

const FOLDER = path.join(vault(base), "datanotes", "main", "public", "event");
const pad = (n, w = 2) => String(n).padStart(w, "0");
const hex = (n, w) => n.toString(16).padStart(w, "0");
const KINDS = ["start", "stop", "level"];
const WORDS = ["calm", "steady", "rising", "falling", "noisy", "quiet", "warm", "cold"];
let t = Date.UTC(2014, 0, 1, 8, 0);
/** The month of the middle row: `select_rows` of one month reads it. */
let middle = "";
const old = new Date("2026-01-01T00:00:00Z");
log(`writing ${ROWS} rows`);
for (let i = 0; i < ROWS; i++) {
  t += (97 + (i % 13)) * 60_000; // about 7 rows a day: some 200 a month
  const d = new Date(t);
  const at = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const name = at.replace(":", "");
  if (i === Math.floor(ROWS / 2)) middle = at.slice(0, 7);
  const dir = path.join(FOLDER, at.slice(0, 4), at.slice(5, 7));
  fs.mkdirSync(dir, { recursive: true });
  const id = `${hex(t, 12).slice(0, 8)}-${hex(t, 12).slice(8)}-7${hex(i & 0xfff, 3)}-8${hex((i * 7919) & 0xfff, 3)}-${hex(i, 12)}`;
  const text = `---\ntable: ${TABLE}\nid: ${id}\nat: ${at}\nkind: ${KINDS[i % 3]}\nvalue: ${(i % 97) / 4}\nnote: ${WORDS[i % 8]} ${WORDS[(i * 3) % 8]}\n---\n`;
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, old, old);
}

// --- 3. the same rows, packed ---------------------------------------------------------------------

const packed = path.join(OUT, "packed");
fs.cpSync(base, packed, { recursive: true, preserveTimestamps: true });
// the store records its vault: the copy is a copy of the database (a store of its own)
fs.rmSync(store(packed), { recursive: true, force: true });
fs.mkdirSync(store(packed), { recursive: true });
fs.rmSync(home(packed), { recursive: true, force: true });
fs.mkdirSync(home(packed), { recursive: true });
fs.rmSync(store(base), { recursive: true, force: true });
fs.mkdirSync(store(base), { recursive: true });
const result = { month: middle, rows: ROWS, runs: RUNS, node: process.version, platform: `${process.platform} ${process.arch}`, pack: null, variants: {} };
{
  const e = await engineOn(packed);
  const t0 = performance.now();
  const r = await e.call("pack_rows", { table: TABLE });
  result.pack = { ms: Math.round(performance.now() - t0), packs: r.json.packs.length, rows: r.json.packs.reduce((n, p) => n + p.rows.length, 0), excluded: r.json.excluded.length };
  log("pack_rows", result.pack);
  await e.stop();
}

// --- 4. both, measured ----------------------------------------------------------------------------

async function idle(e) {
  // the engine is idle once two status reads 1 s apart see no change in its memory
  let last = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const now = rssMb(e.child.pid);
    if (now !== null && last !== null && Math.abs(now - last) <= 1) return now;
    last = now;
  }
  return last;
}

async function measure(dir, label) {
  const out = { label };
  const [y, m] = middle.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const month = { at: { gte: `${middle}-01T00:00`, lt: `${next}-01T00:00` } };
  // first start: no vault index
  fs.rmSync(path.join(store(dir), "index"), { recursive: true, force: true });
  {
    const e = await engineOn(dir);
    const t0 = performance.now();
    const r = await e.call("select_rows", { table: TABLE, where: month, limit: 1000 });
    out.first_start = { listen_ms: Math.round(e.listenMs), first_select_ms: Math.round(performance.now() - t0), rows: r.json.total };
    await e.stop();
  }
  const restarts = [];
  const selects = [];
  let rss = null;
  for (let i = 0; i < RUNS; i++) {
    const e = await engineOn(dir);
    const t0 = performance.now();
    await e.call("select_rows", { table: TABLE, where: month, limit: 1000 });
    restarts.push({ listen: e.listenMs, first: performance.now() - t0 });
    if (i === RUNS - 1) {
      for (let k = 0; k < 20; k++) {
        const s0 = performance.now();
        await e.call("select_rows", { table: TABLE, where: month, limit: 1000 });
        selects.push(performance.now() - s0);
      }
      const all = await e.call("select_rows", { table: TABLE, limit: 1 });
      out.total_rows = all.json.total;
      rss = await idle(e);
    }
    await e.stop();
  }
  out.restart = { listen_ms: round(median(restarts.map((r) => r.listen))), first_select_ms: round(median(restarts.map((r) => r.first))) };
  out.select_month_ms = round(median(selects));
  out.rss_mb = rss;
  out.vault_index_mb = round(tree(path.join(store(dir), "index")).bytes / 1048576);
  out.vault = tree(vault(dir));
  // git: the whole vault committed, then the status of a clean tree
  const git = (...a) => execFileSync("git", a, { cwd: vault(dir), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "b", GIT_AUTHOR_EMAIL: "b@b", GIT_COMMITTER_NAME: "b", GIT_COMMITTER_EMAIL: "b@b" } });
  git("init", "-q");
  const g0 = performance.now();
  git("add", "-A");
  git("commit", "-qm", "all");
  out.git_add_commit_ms = Math.round(performance.now() - g0);
  const st = [];
  for (let i = 0; i < 5; i++) {
    const s0 = performance.now();
    git("status", "--porcelain");
    st.push(performance.now() - s0);
  }
  out.git_status_ms = round(median(st));
  log(label, JSON.stringify(out));
  return out;
}

result.variants.single = await measure(base, "single");
result.variants.packed = await measure(packed, "packed");
fs.writeFileSync(path.join(OUT, "packs-result.json"), JSON.stringify(result, null, 2));
log("done:", path.join(OUT, "packs-result.json"));
