#!/usr/bin/env node
/**
 * Summarize a V8 CPU profile (.cpuprofile, from --cpu-prof or the inspector) of the built engine:
 * self and total time per function with its src/ file and line (through the source map of
 * bench/scale/sourcemap.mjs), self time per source file and per category, the dominant call
 * paths of the hottest functions, and the time of named phases (startup).
 *
 *   node bench/scale/analyze-profile.mjs <profile> --map <datanotes.cjs.map> [--top 30]
 *        [--from <ms>] [--to <ms>] [--phases startup] [--json <out.json>] [--paths 6]
 *
 * Times are ms; `--from`/`--to` keep the samples in that window (ms since the profile started).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs, REPO } from "./lib.mjs";

const require = createRequire(path.join(REPO, "package.json"));
const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");

const argv = process.argv.slice(2);
const file = argv.shift();
const args = parseArgs(argv);
const TOP = Number(args.top ?? 30);
const from = args.from !== undefined ? Number(args.from) : -Infinity;
const to = args.to !== undefined ? Number(args.to) : Infinity;
const prof = JSON.parse(fs.readFileSync(file, "utf8"));
const map = args.map ? new TraceMap(fs.readFileSync(String(args.map), "utf8")) : null;

// --- frames -----------------------------------------------------------------------------------------

const nodes = new Map();
const parent = new Map();
for (const n of prof.nodes) nodes.set(n.id, n);
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const locCache = new Map();
function where(cf) {
  const k = `${cf.url}:${cf.lineNumber}:${cf.columnNumber}`;
  let r = locCache.get(k);
  if (r) return r;
  if (map && /datanotes(-service)?\.cjs$/.test(cf.url) && cf.lineNumber >= 0) {
    const o = originalPositionFor(map, { line: cf.lineNumber + 1, column: Math.max(0, cf.columnNumber) });
    if (o.source) {
      let src = o.source.replace(/\\/g, "/");
      const i = src.lastIndexOf("src/");
      const j = src.lastIndexOf("node_modules/");
      src = j >= 0 ? src.slice(j) : i >= 0 ? src.slice(i) : src;
      r = { file: src, line: o.line };
    }
  }
  if (!r) {
    const u = cf.url || "";
    r = { file: u.startsWith("node:") ? u : u ? path.basename(u) : "", line: cf.lineNumber >= 0 ? cf.lineNumber + 1 : 0 };
  }
  locCache.set(k, r);
  return r;
}
function keyOf(n) {
  const cf = n.callFrame;
  const w = where(cf);
  const name = cf.functionName || "(anonymous)";
  return { key: `${name}\t${w.file}:${w.line}`, name, file: w.file, line: w.line };
}
const keys = new Map(); // node id -> key info
for (const n of prof.nodes) keys.set(n.id, keyOf(n));
function category(k) {
  if (k.name === "(idle)") return "idle";
  if (k.name === "(program)") return "program (V8: compile, runtime)";
  if (k.name === "(garbage collector)") return "garbage collector";
  if (k.file.startsWith("src/")) return "engine (src/)";
  if (k.file.startsWith("node_modules/")) return "bundled packages";
  if (k.file.startsWith("node:")) return "Node.js";
  if (k.name.startsWith("(")) return k.name;
  return k.file ? "other JS" : "native";
}

// --- samples -------------------------------------------------------------------------------------------

const samples = prof.samples;
const deltas = prof.timeDeltas;
const times = new Array(samples.length);
let t = 0;
for (let i = 0; i < samples.length; i++) {
  t += deltas[i] ?? 0;
  times[i] = t / 1000; // ms since the profile started
}
const durs = samples.map((_, i) => (i + 1 < samples.length ? (deltas[i + 1] ?? 0) / 1000 : 0));

const self = new Map();
const total = new Map();
const byFile = new Map();
const byCat = new Map();
const pathsOf = new Map(); // leaf key -> signature -> ms
let windowMs = 0;
let busyMs = 0;
const PATH_DEPTH = Number(args.paths ?? 6);
const stackOf = (id) => {
  const s = [];
  for (let x = id; x !== undefined; x = parent.get(x)) s.push(x);
  return s; // leaf first
};
const phaseDefs = args.phases === "startup" ? startupPhases() : [];
const phaseAcc = phaseDefs.map(() => ({ ms: 0, first: Infinity, last: -Infinity }));
const buckets = new Map(); // 100 ms -> busy ms
for (let i = 0; i < samples.length; i++) {
  const ti = times[i];
  if (ti < from || ti > to) continue;
  const d = durs[i];
  windowMs += d;
  const leaf = keys.get(samples[i]);
  self.set(leaf.key, (self.get(leaf.key) ?? 0) + d);
  const cat = category(leaf);
  byCat.set(cat, (byCat.get(cat) ?? 0) + d);
  if (cat === "idle") continue;
  busyMs += d;
  const b = Math.floor(ti / 100);
  buckets.set(b, (buckets.get(b) ?? 0) + d);
  const fk = leaf.file || leaf.name;
  byFile.set(fk, (byFile.get(fk) ?? 0) + d);
  const stack = stackOf(samples[i]);
  const seen = new Set();
  for (const id of stack) {
    const k = keys.get(id).key;
    if (seen.has(k)) continue;
    seen.add(k);
    total.set(k, (total.get(k) ?? 0) + d);
  }
  const sig = stack
    .slice(1)
    .map((id) => keys.get(id))
    .filter((k) => k.file.startsWith("src/") || k.file.startsWith("node_modules/"))
    .slice(0, PATH_DEPTH)
    .map((k) => `${k.name} (${k.file}:${k.line})`)
    .join(" < ");
  let m = pathsOf.get(leaf.key);
  if (!m) pathsOf.set(leaf.key, (m = new Map()));
  m.set(sig, (m.get(sig) ?? 0) + d);
  if (phaseDefs.length) {
    const frames = stack.map((id) => keys.get(id));
    phaseDefs.forEach((p, j) => {
      if (frames.some((f) => p.match(f))) {
        const a = phaseAcc[j];
        a.ms += d;
        if (ti < a.first) a.first = ti;
        if (ti > a.last) a.last = ti;
      }
    });
  }
}

// --- report --------------------------------------------------------------------------------------------

const info = new Map([...keys.values()].map((k) => [k.key, k]));
const fmt = (x) => x.toFixed(1).padStart(8);
const rows = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
const lines = [];
const say = (s = "") => lines.push(s);
say(`profile ${path.basename(file)}: ${(windowMs / 1000).toFixed(2)} s sampled in the window, ${(busyMs / 1000).toFixed(2)} s not idle`);
say("\nby category (self):");
for (const [k, v] of rows(byCat)) say(`${fmt(v)} ms ${((100 * v) / windowMs).toFixed(1).padStart(5)}%  ${k}`);
say(`\ntop ${TOP} by self time (ms, % of busy):`);
const top = rows(self).filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).slice(0, TOP);
for (const [k, v] of top) {
  const i = info.get(k);
  say(`${fmt(v)} ${((100 * v) / busyMs).toFixed(1).padStart(5)}%  total ${fmt(total.get(k) ?? 0)}  ${i.name}  ${i.file}:${i.line}`);
  const ps = rows(pathsOf.get(k) ?? new Map()).slice(0, 2);
  for (const [sig, ms] of ps) if (sig) say(`             ${((100 * ms) / v).toFixed(0).padStart(3)}% via ${sig}`);
}
say(`\ntop ${TOP} by total time (engine and packages):`);
const topTotal = rows(total).filter(([k]) => {
  const i = info.get(k);
  return i.file.startsWith("src/") || i.file.startsWith("node_modules/");
});
for (const [k, v] of topTotal.slice(0, TOP)) {
  const i = info.get(k);
  say(`${fmt(v)} ${((100 * v) / busyMs).toFixed(1).padStart(5)}%  self ${fmt(self.get(k) ?? 0)}  ${i.name}  ${i.file}:${i.line}`);
}
say(`\nself time by source file (top ${TOP}):`);
for (const [k, v] of rows(byFile).slice(0, TOP)) say(`${fmt(v)} ${((100 * v) / busyMs).toFixed(1).padStart(5)}%  ${k}`);
if (phaseDefs.length) {
  say("\nphases (CPU time with the phase on the stack; first..last sample, ms since the profile started):");
  phaseDefs.forEach((p, j) => {
    const a = phaseAcc[j];
    if (a.ms > 0) say(`${fmt(a.ms)} ms  ${p.name.padEnd(48)} ${a.first.toFixed(0).padStart(7)} .. ${a.last.toFixed(0).padStart(7)}`);
    else say(`     0.0 ms  ${p.name}`);
  });
}
const busyTimeline = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
console.log(lines.join("\n"));
if (args.json) {
  fs.writeFileSync(
    String(args.json),
    JSON.stringify(
      {
        file: path.basename(file),
        windowMs,
        busyMs,
        categories: Object.fromEntries(rows(byCat)),
        self: top.map(([k, v]) => ({ ...info.get(k), self: v, total: total.get(k) ?? 0, paths: rows(pathsOf.get(k) ?? new Map()).slice(0, 3) })),
        total: topTotal.slice(0, 80).map(([k, v]) => ({ ...info.get(k), total: v, self: self.get(k) ?? 0 })),
        files: rows(byFile).slice(0, 60),
        phases: phaseDefs.map((p, j) => ({ name: p.name, ...phaseAcc[j] })),
        timeline: busyTimeline,
      },
      null,
      1,
    ),
  );
}

/** The phases of the engine's start, by the functions that run them. */
function startupPhases() {
  // esbuild renames a function whose name another module uses too (start2, parse6): compare without the suffix
  const base = (n) => n.replace(/\d+$/, "");
  const fn = (name, file) => (f) => base(f.name) === name && (!file || f.file.endsWith(file));
  const any = (...ms) => (f) => ms.some((m) => m(f));
  return [
    { name: "bundle top-level (module init)", match: (f) => f.name === "(anonymous)" && f.file.endsWith("src/node/cli.ts") },
    { name: "openNodeVault (scan + read + parse + links)", match: fn("openNodeVault", "node-app.ts") },
    { name: "  NodeVault.scanSync (tree walk + stat)", match: fn("scanSync", "node-app.ts") },
    { name: "  NodeMetadataCache.indexAll (read + parse)", match: fn("indexAll", "node-app.ts") },
    { name: "    readFileSync (notes)", match: (f) => f.name === "readFileSync" },
    { name: "    parse (frontmatter YAML)", match: fn("readOrderedFromMarkdown") },
    { name: "    tagsOf (tag regexes)", match: fn("tagsOf", "node-app.ts") },
    { name: "    parseLinks", match: fn("parseLinks") },
    { name: "    contentHash", match: fn("contentHash") },
    { name: "    resolveAll / rebuild (link resolution)", match: any(fn("resolveAll", "node-app.ts"), fn("rebuild")) },
    { name: "  primeFiles (file cache)", match: fn("primeFiles") },
    { name: "openStore (store setup)", match: fn("openStore") },
    { name: "recoverRenames (tree walk)", match: fn("recoverRenames") },
    { name: "watcher.start / rescan (tree walk + stat)", match: fn("rescan", "node-app.ts") },
    { name: "loadMetastore (metastore parse)", match: any(fn("loadMetastore"), fn("parseMetastore")) },
    { name: "ChangeFeed.start (row states of every row)", match: (f) => base(f.name) === "start" && f.file.endsWith("change-feed.ts") },
    { name: "  ChangeFeed.readState", match: fn("readState", "change-feed.ts") },
    { name: "InverseLinks.init", match: (f) => base(f.name) === "init" && f.file.endsWith("inverse.ts") },
    { name: "transaction log replay (readLastState, tableStateAt)", match: any(fn("readLastState"), fn("tableStateAt"), fn("warmLoggedStates")) },
    { name: "transaction log sync (syncTransactionLogs, readCurrentStates)", match: any(fn("syncTransactionLogs"), fn("readCurrentStates"), fn("logExternalEdits")) },
    { name: "maintainStore (store maintenance)", match: fn("maintainStore") },
    { name: "tokens.load", match: (f) => base(f.name) === "load" && f.file.endsWith("tokens.ts") },
    { name: "WebhookDispatcher.start", match: (f) => base(f.name) === "start" && f.file.endsWith("webhooks.ts") },
    { name: "applyHttpServer (listen)", match: fn("applyHttpServer") },
    { name: "auto recompute / adopt", match: (f) => f.file.endsWith("auto-recompute.ts") || f.file.endsWith("auto-adopt.ts") },
    { name: "graph build", match: (f) => f.file.endsWith("graph.ts") },
    { name: "change feed (any)", match: (f) => f.file.endsWith("change-feed.ts") },
    { name: "transaction log (any)", match: (f) => f.file.endsWith("transaction-log.ts") },
    { name: "external edits (any)", match: (f) => f.file.endsWith("external-edits.ts") },
    { name: "journal (any)", match: (f) => f.file.endsWith("journal.ts") },
    { name: "garbage collector", match: (f) => f.name === "(garbage collector)" },
  ];
}
