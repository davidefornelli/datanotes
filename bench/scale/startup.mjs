#!/usr/bin/env node
/**
 * The engine's start on a vault, measured: `--runs` starts in a row (the first may be the first
 * start after a bulk import; the next are restarts), each with the probe (bench/scale/probe.cjs)
 * and, for the runs listed in `--cpu-prof`, a CPU profile of the whole start.
 *
 *   node bench/scale/startup.mjs --dir <vault dir: vault/ store/ datahome/> --out <raw folder>
 *        --label 10k [--port 27402] [--runs 3] [--cpu-prof 1,2] [--settle-ms 2000] [--max-wait-s 300]
 *
 * Per run: the time to the start line (HTTP listening), the first read right after it (the
 * biggest table, cold), the time until the engine is idle (event loop utilization under 5% for
 * `--settle-ms`), memory then, the file system calls before listening and until idle, and the
 * store's files. Writes <out>/startup-<label>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs, pct, sleep, startEngine, treeStats, relocateStore, defenderMonitor, defenderQuiet } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const DIR = path.resolve(String(args.dir));
const OUT = path.resolve(String(args.out));
const LABEL = String(args.label ?? path.basename(DIR));
const PORT = Number(args.port ?? 27402);
const RUNS = Number(args.runs ?? 3);
const PROF = new Set(String(args["cpu-prof"] ?? "").split(",").filter(Boolean).map(Number));
const SETTLE_MS = Number(args["settle-ms"] ?? 2000);
const MAX_WAIT = Number(args["max-wait-s"] ?? 300) * 1000;
const TOKEN = String(args.token ?? "scale-bench-owner");
fs.mkdirSync(OUT, { recursive: true });
relocateStore(DIR);
const manifest = fs.existsSync(path.join(DIR, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8")) : null;

function readProbe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The file system calls of the probe's timeline between two times (ms since the process started). */
function ioBetween(probe, a, b) {
  const out = {};
  for (const [bucket, ops] of Object.entries(probe.timeline)) {
    const t = Number(bucket) * 100;
    if (t < a || t >= b) continue;
    for (const [op, [n, ms]] of Object.entries(ops)) {
      const e = (out[op] ??= { n: 0, ms: 0 });
      e.n += n;
      e.ms += ms;
    }
  }
  for (const e of Object.values(out)) e.ms = Math.round(e.ms);
  return Object.fromEntries(Object.entries(out).sort((x, y) => y[1].ms - x[1].ms));
}

const results = [];
for (let run = 1; run <= RUNS; run++) {
  const probeOut = path.join(OUT, `probe-startup-${LABEL}-run${run}.json`);
  const profDir = PROF.has(run) ? path.join(OUT, `cpuprof-startup-${LABEL}-run${run}`) : null;
  if (profDir) fs.rmSync(profDir, { recursive: true, force: true });
  const storeBefore = treeStats(path.join(DIR, "store"));
  // Defender: wait until it is quiet, measure its background rate, then follow it through the start
  const waitedS = await defenderQuiet(25, 4, 90);
  const bg = defenderMonitor();
  await sleep(5000);
  const background = await bg.stop();
  const defender = defenderMonitor();
  const e = await startEngine({
    vault: path.join(DIR, "vault"),
    store: path.join(DIR, "store"),
    dataHome: path.join(DIR, "datahome"),
    port: PORT,
    token: TOKEN,
    probeOut,
    ...(profDir ? { cpuProfDir: profDir } : {}),
    timeoutMs: MAX_WAIT,
  });
  const listenMs = e.listenMs;
  // the first read an agent makes right after the start: the biggest table, cold
  const big = manifest?.tables?.[0]?.table;
  const first = big ? await e.call("select_rows", { table: big, where: { status: { ne: "done" } }, limit: 50 }, true).catch((err) => ({ ms: NaN, err })) : null;
  const firstDoneMs = performance.now() - e.t0;
  // idle: the probe's event loop utilization stays under 5% for SETTLE_MS
  let settledAt = null;
  const deadline = performance.now() + MAX_WAIT;
  while (performance.now() < deadline) {
    await sleep(1000);
    const p = readProbe(probeOut);
    if (!p) continue;
    const s = p.samples;
    const need = Math.ceil(SETTLE_MS / 250);
    if (s.length < need + 2) continue;
    const tail = s.slice(-need);
    if (tail.every((x) => x[1] < 0.05) && tail[0][0] > (p.marks.startLine ?? Infinity)) {
      // the start of the quiet stretch: the end of the start's work
      let i = s.length - need;
      while (i > 0 && s[i - 1][1] < 0.05) i--;
      settledAt = s[i][0];
      break;
    }
  }
  const p1 = readProbe(probeOut);
  const def = await defender.stop();
  await e.stop();
  await sleep(300);
  const p = readProbe(probeOut) ?? p1;
  const marks = p?.marks ?? {};
  const last = p?.samples?.filter((s) => settledAt === null || s[0] <= settledAt + SETTLE_MS).at(-1);
  const busy = p ? p.samples.filter((s) => s[0] <= (settledAt ?? Infinity)) : [];
  const r0 = { listen: marks.startLine ?? listenMs };
  const r = {
    run,
    listenMs: Math.round(listenMs),
    marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Math.round(v)])),
    firstRead: first ? { table: big, ms: Math.round(first.ms), status: first.status, rows: first.json?.rows?.length, total: first.json?.total } : null,
    firstReadDoneMs: Math.round(firstDoneMs),
    settledMs: settledAt === null ? null : Math.round(settledAt),
    memAtSettle: last ? { rssMB: last[2], heapUsedMB: last[3], heapTotalMB: last[4], externalMB: last[5] } : null,
    peakRssMB: busy.length ? Math.max(...busy.map((s) => s[2])) : null,
    gc: p?.gc,
    ioBeforeListen: p ? ioBetween(p, 0, marks.startLine ?? Infinity) : null,
    ioListenToSettle: p ? ioBetween(p, marks.startLine ?? 0, settledAt ?? Infinity) : null,
    ioTotals: p?.totals,
    storeBefore,
    storeAfter: treeStats(path.join(DIR, "store")),
    defender: (() => {
      // samples are ms since the monitor started, about when the engine was spawned
      const listen = r0.listen;
      const settle = settledAt ?? Infinity;
      const sum = (a, b) => +(def.samples.filter((x) => x[0] > a && x[0] <= b + 1000).reduce((t, x) => t + x[1], 0) / 100).toFixed(2);
      const bgRate = background.samples.length ? background.cpuSeconds / background.samples.length : 0;
      return { waitedForQuietS: waitedS, backgroundCoreShare: +bgRate.toFixed(3), cpuSecondsToListen: sum(0, listen), cpuSecondsListenToIdle: sum(listen, settle), samples: def.samples };
    })(),
    cpuProfile: profDir ? fs.readdirSync(profDir).map((f) => path.join(profDir, f))[0] : null,
  };
  results.push(r);
  console.log(`[${LABEL}] run ${run}: listening ${r.listenMs} ms (bundle at ${r.marks.bundle}, server listening at ${r.marks.listening}), first read ${r.firstRead?.ms} ms, idle at ${r.settledMs} ms, rss ${r.memAtSettle?.rssMB} MB heap ${r.memAtSettle?.heapUsedMB} MB, Defender ${r.defender.cpuSecondsToListen} cpu-s to listening + ${r.defender.cpuSecondsListenToIdle} to idle (background ${r.defender.backgroundCoreShare} core), gc ${Math.round(p?.gc?.ms ?? 0)} ms / ${p?.gc?.n}`);
  const top = Object.entries(r.ioBeforeListen ?? {}).slice(0, 6).map(([k, v]) => `${k} ${v.n}x ${v.ms} ms`).join(", ");
  console.log(`    io before listening: ${top}`);
  const top2 = Object.entries(r.ioListenToSettle ?? {}).slice(0, 6).map(([k, v]) => `${k} ${v.n}x ${v.ms} ms`).join(", ");
  console.log(`    io listening..idle: ${top2}`);
  console.log(`    store: ${r.storeBefore.files} -> ${r.storeAfter.files} files, ${(r.storeAfter.bytes / 1e6).toFixed(1)} MB`);
  await sleep(1000);
}
fs.writeFileSync(path.join(OUT, `startup-${LABEL}.json`), JSON.stringify({ label: LABEL, dir: DIR, manifest: manifest && { notes: manifest.notes, rows: manifest.rows, plain: manifest.plain }, results }, null, 2));
const listen = results.map((r) => r.listenMs);
console.log(`[${LABEL}] listening p50 ${pct(listen, 50)} ms over ${results.length} runs`);
