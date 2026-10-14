#!/usr/bin/env node
/**
 * The scale benchmark on one vault (a copy: it writes): latency, memory, CPU profiles of a write
 * burst and of a read burst, store growth. Run bench/scale/startup.mjs first for the start.
 *
 *   node bench/scale/run.mjs --dir <vault dir: vault/ store/ datahome/> --out <raw folder> --label 10k
 *        [--port 27403] [--inspect-port 27419] [--iterations 20] [--heap] [--growth 300]
 *        [--task-table work.planning.task --note-table lab.misc.idea] [--phases 1,2]
 *
 * Phase 1, read cache on (the default settings): memory after the start, bench/http-latency.mjs
 * (reads, graph, scale, writes, ddl), memory after it, a CPU profile of a write burst, the writes
 * again with history off. Phase 2, read cache off (readCacheMaxBytes 0): a CPU profile of a read
 * burst (every read computed), then `--growth` inserts into the task table with the store's files
 * and the log's replay times as they grow. `--heap` takes heap snapshots after the start and
 * after the reads. Writes <out>/run-<label>.json and the profiles next to it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Cdp, parseArgs, pct, REPO, sleep, startEngine, treeStats, relocateStore } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const DIR = path.resolve(String(args.dir));
const OUT = path.resolve(String(args.out));
const LABEL = String(args.label ?? path.basename(DIR));
const PORT = Number(args.port ?? 27403);
const INSPECT = Number(args["inspect-port"] ?? 27419);
const ITER = Number(args.iterations ?? 20);
const GROWTH = Number(args.growth ?? 300);
const PHASES = new Set(String(args.phases ?? "1,2").split(",").map(Number));
const TOKEN = "scale-bench-owner";
const TASK = args["task-table"] === undefined ? "work.planning.task" : args["task-table"] === "none" ? null : String(args["task-table"]);
const NOTE = args["note-table"] === undefined ? "lab.misc.idea" : args["note-table"] === "none" ? null : String(args["note-table"]);
fs.mkdirSync(OUT, { recursive: true });
relocateStore(DIR);
const STORE = path.join(DIR, "store");
const result = { label: LABEL, dir: DIR, iterations: ITER, phases: {} };
const save = () => fs.writeFileSync(path.join(OUT, `run-${LABEL}.json`), JSON.stringify(result, null, 2));
const log = (...a) => console.log(`[${LABEL}]`, ...a);

async function settle(probeOut, maxMs = 600_000) {
  const t0 = performance.now();
  while (performance.now() - t0 < maxMs) {
    await sleep(1000);
    let p;
    try {
      p = JSON.parse(fs.readFileSync(probeOut, "utf8"));
    } catch {
      continue;
    }
    const s = p.samples;
    if (s.length < 12) continue;
    if (s.slice(-8).every((x) => x[1] < 0.05)) return Math.round(s.at(-1)[0]);
  }
  return null;
}

function latency(label, only, iterations, extra = []) {
  const json = path.join(OUT, `latency-${LABEL}-${label}.json`);
  const a = [path.join(REPO, "bench", "http-latency.mjs"), "--port", String(PORT), "--token", TOKEN, "--only", only, "--iterations", String(iterations), "--json", json, "--label", `${LABEL} ${label}`, ...extra];
  if (TASK) a.push("--task-table", TASK);
  if (NOTE) a.push("--note-table", NOTE);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, a, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      fs.writeFileSync(path.join(OUT, `latency-${LABEL}-${label}.log`), out);
      let rows = null;
      try {
        rows = JSON.parse(fs.readFileSync(json, "utf8")).results;
      } catch {}
      log(`latency ${label}: exit ${code}, ${((performance.now() - t0) / 1000).toFixed(0)} s, ${rows?.length ?? 0} rows`);
      resolve({ code, seconds: (performance.now() - t0) / 1000, rows });
    });
  });
}

const storeCounts = () => {
  const t = treeStats(STORE);
  const tl = path.join(STORE, "transaction_log");
  let commits = 0;
  let checkpoints = 0;
  let taskCommits = 0;
  let taskCheckpoints = 0;
  if (fs.existsSync(tl)) {
    for (const d of fs.readdirSync(tl)) {
      const files = fs.readdirSync(path.join(tl, d));
      const cp = files.filter((f) => f.endsWith(".checkpoint.json")).length;
      const cm = files.filter((f) => /^\d{20}\.json$/.test(f)).length;
      commits += cm;
      checkpoints += cp;
      if (TASK && d === TASK) {
        taskCommits = cm;
        taskCheckpoints = cp;
      }
    }
  }
  return { files: t.files, MB: +(t.bytes / 1e6).toFixed(2), by: Object.fromEntries(Object.entries(t.by).map(([k, v]) => [k, { files: v.files, MB: +(v.bytes / 1e6).toFixed(2) }])), commits, checkpoints, taskCommits, taskCheckpoints };
};

async function engineFor(phase, settings) {
  const probeOut = path.join(OUT, `probe-run-${LABEL}-phase${phase}.json`);
  const e = await startEngine({ vault: path.join(DIR, "vault"), store: STORE, dataHome: path.join(DIR, "datahome"), port: PORT, token: TOKEN, probeOut, inspectPort: INSPECT, settings, timeoutMs: 900_000 });
  const settledAt = await settle(probeOut);
  const cdp = await Cdp.connect(INSPECT);
  log(`phase ${phase}: listening ${Math.round(e.listenMs)} ms, idle at ${settledAt} ms`);
  return { e, cdp, probeOut, listenMs: e.listenMs, settledAt };
}

const memory = async (cdp) => {
  const m = await cdp.memory(true);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [`${k}MB`, +(v / 1048576).toFixed(1)]));
};

// --- phase 1: read cache on ----------------------------------------------------------------------------

if (PHASES.has(1)) {
  const ph = (result.phases[1] = { settings: "defaults (read cache on, history on)" });
  const { e, cdp, listenMs, settledAt } = await engineFor(1, { readCacheMaxBytes: 33554432 });
  ph.listenMs = Math.round(listenMs);
  ph.settledAt = settledAt;
  try {
    ph.memStart = await memory(cdp);
    log("memory after start", ph.memStart);
    if (args.heap) {
      const f = path.join(OUT, `heap-${LABEL}-start.heapsnapshot`);
      const t0 = performance.now();
      await cdp.heapSnapshot(f);
      log(`heap snapshot ${f} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      ph.heapStart = f;
    }
    ph.storeStart = storeCounts();
    save();
    ph.latency = await latency("cache-on", "reads,graph,scale,writes,ddl", ITER);
    ph.memAfterReads = await memory(cdp);
    log("memory after the latency run", ph.memAfterReads);
    if (args.heap) {
      const f = path.join(OUT, `heap-${LABEL}-after-reads.heapsnapshot`);
      await cdp.heapSnapshot(f);
      ph.heapAfterReads = f;
    }
    save();
    // a write burst under the profiler
    const before = storeCounts();
    await cdp.startProfile(500);
    ph.writeBurst = await latency("write-burst", "writes", 30);
    const prof = path.join(OUT, `cpuprof-${LABEL}-write-burst.cpuprofile`);
    await cdp.stopProfile(prof);
    ph.writeBurstProfile = prof;
    ph.storeAroundWriteBurst = { before, after: storeCounts() };
    ph.memAfterWrites = await memory(cdp);
    save();
    // history off: the same writes
    const off = await e.call("configure_database", { history: false });
    ph.historyOffMs = Math.round(off.ms);
    ph.historyOff = await latency("history-off", "writes", ITER);
    const on = await e.call("configure_database", { history: true });
    ph.historyOnMs = Math.round(on.ms);
    log(`configure_database history off ${ph.historyOffMs} ms, on again ${ph.historyOnMs} ms`);
    save();
  } finally {
    cdp.close();
    await e.stop();
  }
  await sleep(1000);
}

// --- phase 2: read cache off -----------------------------------------------------------------------------

if (PHASES.has(2)) {
  const ph = (result.phases[2] = { settings: "read cache off (readCacheMaxBytes 0)" });
  const { e, cdp, listenMs, settledAt } = await engineFor(2, { readCacheMaxBytes: 0 });
  ph.listenMs = Math.round(listenMs);
  ph.settledAt = settledAt;
  try {
    ph.memStart = await memory(cdp);
    await cdp.startProfile(500);
    ph.readBurst = await latency("cache-off", "reads,graph,scale", Math.max(5, Math.round(ITER / 2)), ["--no-scale-writes"]);
    const prof = path.join(OUT, `cpuprof-${LABEL}-read-burst.cpuprofile`);
    await cdp.stopProfile(prof);
    ph.readBurstProfile = prof;
    ph.memAfterReads = await memory(cdp);
    save();
    // store growth: inserts into the task table, and the log's replay as it grows
    if (GROWTH > 0 && TASK) {
      const d = (await e.call("describe_table", { table: TASK })).json;
      const values = {};
      for (const c of d.columns) {
        if (c.identity || c.generated || !c.required) continue;
        if (c.type === "enum") values[c.name] = c.default ?? c.values[0];
        else if (c.type === "link" || (c.type === "list" && c.items === "link")) {
          const r = (await e.call("select_rows", { table: TASK, columns: [c.name], where: { [c.name]: { exists: true } }, limit: 1 })).json;
          values[c.name] = r.rows[0][c.name];
        }
      }
      const key = d.columns.some((c) => c.name === "title") ? "title" : "name";
      const steps = [];
      const firstVersion = (await e.call("describe_history", { table: TASK }, true)).json;
      ph.describeHistoryShape = Object.keys(firstVersion ?? {});
      let lat = [];
      const t0 = performance.now();
      for (let i = 1; i <= GROWTH; i++) {
        const r = await e.call("insert_row", { table: TASK, values: { ...values, [key]: `Growth ${LABEL} ${i}` }, body: "A row of the growth test.\n" });
        lat.push(r.ms);
        if (i % 50 === 0 || i === GROWTH) {
          const counts = storeCounts();
          const hist = await e.call("describe_history", { table: TASK }, true);
          const versions = (await e.call("select_rows", { table: TASK, columns: ["path"], limit: 1, version: 0 }, true));
          const recent = counts.taskCommits > 2 ? await e.call("select_rows", { table: TASK, columns: ["path"], limit: 1, version: counts.taskCommits - 2 }, true) : null;
          const step = {
            inserts: i,
            insertP50: +pct(lat, 50).toFixed(1),
            insertP95: +pct(lat, 95).toFixed(1),
            describeHistoryMs: Math.round(hist.ms),
            timeTravelV0Ms: Math.round(versions.ms),
            timeTravelV0Status: versions.status,
            timeTravelRecentMs: recent ? Math.round(recent.ms) : null,
            store: counts,
          };
          steps.push(step);
          log(`growth ${i}: insert p50 ${step.insertP50} ms p95 ${step.insertP95} ms, store ${counts.files} files ${counts.MB} MB (task log ${counts.taskCommits} commits, ${counts.taskCheckpoints} checkpoints), time travel v0 ${step.timeTravelV0Ms} ms, recent ${step.timeTravelRecentMs} ms, describe_history ${step.describeHistoryMs} ms`);
          lat = [];
          save();
        }
      }
      ph.growth = { inserts: GROWTH, seconds: (performance.now() - t0) / 1000, steps };
      ph.memAfterGrowth = await memory(cdp);
    }
    save();
  } finally {
    cdp.close();
    await e.stop();
  }
}
save();
log("done");
