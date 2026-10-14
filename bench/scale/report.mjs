#!/usr/bin/env node
/**
 * Markdown tables of the scale benchmark's results: start, memory, latency per operation, store
 * growth, for every size measured (bench/scale/startup.mjs and run.mjs wrote them to <raw>).
 *
 *   node bench/scale/report.mjs --raw <folder> --labels 2.5k,10k,50k,real
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, pct } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const RAW = path.resolve(String(args.raw));
const LABELS = String(args.labels).split(",");
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
  } catch {
    return null;
  }
};
const out = [];
const say = (s = "") => out.push(s);
const table = (head, rows) => {
  say(`| ${head.join(" | ")} |`);
  say(`|${head.map(() => " --- ").join("|")}|`);
  for (const r of rows) say(`| ${r.map((x) => (x === undefined || x === null || Number.isNaN(x) ? "–" : x)).join(" | ")} |`);
  say();
};
const med = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && !Number.isNaN(x));
  return v.length ? Math.round(pct(v, 50)) : null;
};

// --- start ---------------------------------------------------------------------------------------------
say("### Start");
const startRows = [];
for (const l of LABELS) {
  const s = read(`startup-${l}.json`);
  if (!s) continue;
  const [first, ...rest] = s.results;
  const io = (r, op) => r.ioBeforeListen?.[op];
  const row = (r, kind) => [
    l,
    kind,
    s.manifest?.notes ?? "",
    r.marks.bundle,
    r.listenMs,
    r.firstRead?.ms,
    r.settledMs,
    io(r, "sync.readFileSync") ? `${io(r, "sync.readFileSync").n} / ${io(r, "sync.readFileSync").ms}` : "",
    io(r, "sync.statSync") ? `${io(r, "sync.statSync").n} / ${io(r, "sync.statSync").ms}` : "",
    r.ioListenToSettle?.["sync.statSync"] ? `${r.ioListenToSettle["sync.statSync"].n} / ${r.ioListenToSettle["sync.statSync"].ms}` : "",
    r.defender ? `${r.defender.cpuSecondsToListen} + ${r.defender.cpuSecondsListenToIdle}` : "",
    r.memAtSettle ? `${r.memAtSettle.rssMB} / ${r.memAtSettle.heapUsedMB}` : "",
    r.peakRssMB,
    `${r.storeBefore.files} → ${r.storeAfter.files}`,
  ];
  // a label ending in "restarts": every run is a restart (the store existed already)
  const restarts = l.endsWith("restarts");
  startRows.push(row(first, restarts ? "restart" : "first start"));
  for (const r of rest) startRows.push(row(r, `restart ${restarts ? r.run : r.run - 1}`));
}
table(["size", "run", "notes", "bundle loaded (ms)", "listening (ms)", "1st select_rows (ms)", "idle at (ms)", "readFileSync before listen (n / ms)", "statSync before listen (n / ms)", "statSync listen→idle (n / ms)", "Defender CPU-s (to listen + to idle)", "RSS / heap at idle (MB)", "peak RSS (MB)", "store files"], startRows);

// --- memory -----------------------------------------------------------------------------------------------
say("### Memory (after a forced GC)");
const memRows = [];
for (const l of LABELS) {
  const r = read(`run-${l}.json`);
  if (!r) continue;
  const p1 = r.phases?.[1];
  const p2 = r.phases?.[2];
  const m = (x) => (x ? `${x.heapUsedMB} / ${x.rssMB}` : "");
  memRows.push([l, m(p1?.memStart), m(p1?.memAfterReads), m(p1?.memAfterWrites), m(p2?.memStart), m(p2?.memAfterReads), m(p2?.memAfterGrowth)]);
}
table(["size", "after start (heap / RSS MB)", "after reads, cache on", "after write burst", "after start (cache off run)", "after reads, cache off", "after growth"], memRows);

// --- latency ------------------------------------------------------------------------------------------------
const runs = [
  ["cache-on", "read cache on (repeats are hits)"],
  ["cache-off", "read cache off (every read computed)"],
  ["write-burst", "write burst (history on)"],
  ["history-off", "writes, history off"],
];
for (const [suffix, title] of runs) {
  const byLabel = new Map();
  const names = [];
  for (const l of LABELS) {
    const j = read(`latency-${l}-${suffix}.json`);
    if (!j) continue;
    const m = new Map(j.results.map((r) => [r.name, r]));
    byLabel.set(l, m);
    for (const r of j.results) if (!names.includes(r.name)) names.push(r.name);
  }
  if (!byLabel.size) continue;
  say(`### Latency: ${title} — p50 / p95 ms (n)`);
  const labels = [...byLabel.keys()];
  table(["operation", ...labels], names.map((n) => [n, ...labels.map((l) => {
    const r = byLabel.get(l).get(n);
    return r ? `${r.p50.toFixed(0)} / ${r.p95.toFixed(0)}${r.failed ? ` (${r.failed} failed)` : ""}` : "";
  })]));
}

// --- configure_database history -----------------------------------------------------------------------------
const hist = LABELS.map((l) => [l, read(`run-${l}.json`)?.phases?.[1]]).filter(([, p]) => p);
if (hist.length) {
  say("### configure_database history");
  table(["size", "history off (ms)", "history on again (ms)"], hist.map(([l, p]) => [l, p.historyOffMs, p.historyOnMs]));
}

// --- store growth ----------------------------------------------------------------------------------------------
for (const l of LABELS) {
  const r = read(`run-${l}.json`);
  const g = r?.phases?.[2]?.growth;
  const wb = r?.phases?.[1]?.storeAroundWriteBurst;
  if (wb) {
    say(`### Store around the write burst (${l})`);
    const by = (x) => Object.entries(x.by).map(([k, v]) => `${k} ${v.files}`).join(", ");
    table(["", "files", "MB", "commits", "checkpoints", "by folder (files)"], [["before", wb.before.files, wb.before.MB, wb.before.commits, wb.before.checkpoints, by(wb.before)], ["after", wb.after.files, wb.after.MB, wb.after.commits, wb.after.checkpoints, by(wb.after)]]);
  }
  if (!g) continue;
  say(`### Store growth: ${g.inserts} insert_row into the biggest table (${l})`);
  table(
    ["inserts", "insert p50 / p95 (ms)", "store files", "store MB", "task log commits", "task checkpoints", "transaction_log files", "journal files", "changes files", "blobs files", "describe_history (ms)", "time travel to v0 (ms)", "time travel to latest-2 (ms)"],
    g.steps.map((s) => [s.inserts, `${s.insertP50} / ${s.insertP95}`, s.store.files, s.store.MB, s.store.taskCommits, s.store.taskCheckpoints, s.store.by.transaction_log?.files, s.store.by.journal?.files, s.store.by.changes?.files, s.store.by.blobs?.files, s.describeHistoryMs, s.timeTravelV0Ms, s.timeTravelRecentMs]),
  );
}
console.log(out.join("\n"));
