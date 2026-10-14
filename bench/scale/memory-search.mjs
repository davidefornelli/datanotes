#!/usr/bin/env node
/**
 * Restart, memory, search and the index size of one engine build on one vault (a copy: it
 * writes), to compare two builds on the same vault (run one, then the other).
 *
 *   node bench/scale/memory-search.mjs --dir <vault dir: vault/ store/ datahome/> --out <raw folder>
 *        --label 50k-final [--cli <path to datanotes.cjs>] [--port 27404] [--inspect-port 27418]
 *        [--restarts 3] [--iterations 10] [--heap]
 *
 * A warm-up start first (the first start of a build rebuilds the vault index), then `--restarts`
 * restarts: the time to the start line and until idle, heap and RSS after a forced GC. `--heap`
 * takes a heap snapshot at idle after the first restart. On the last restart, `search_notes` runs
 * each query once unmeasured, then `--iterations` times: p50, p95, total. Then the memory again,
 * and the size of `store/index/vault.sqlite` (with its -wal and -shm). Every start has the read
 * cache off, so each search is computed. Writes <out>/memory-search-<label>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Cdp, defenderQuiet, parseArgs, pct, relocateStore, sleep, startEngine } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const DIR = path.resolve(String(args.dir));
const OUT = path.resolve(String(args.out));
const LABEL = String(args.label ?? path.basename(DIR));
const CLI = args.cli === undefined ? undefined : path.resolve(String(args.cli));
const PORT = Number(args.port ?? 27404);
const INSPECT = Number(args["inspect-port"] ?? 27418);
const RESTARTS = Number(args.restarts ?? 3);
const ITER = Number(args.iterations ?? 10);
const HEAP = args.heap === true;
const TOKEN = "scale-bench-owner";
const SETTINGS = { readCacheMaxBytes: 0 };
fs.mkdirSync(OUT, { recursive: true });
relocateStore(DIR);
const STORE = path.join(DIR, "store");
const manifestFile = path.join(DIR, "manifest.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
const person = manifest?.samples?.person?.[0];
const QUERIES = ["coffee", "budget roadmap", "quiet falcon", ...(person ? [person] : []), "zzqqxx", "ab"];
const log = (...a) => console.log(`[${LABEL}]`, ...a);
const MB = (b) => +(b / 1048576).toFixed(1);

/** Wait until the engine is idle (the probe's event loop utilization under 5% for 8 s): ms since the spawn. */
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

function start(probeOut, inspect) {
  fs.rmSync(probeOut, { force: true });
  return startEngine({ vault: path.join(DIR, "vault"), store: STORE, dataHome: path.join(DIR, "datahome"), port: PORT, token: TOKEN, probeOut, inspectPort: inspect ? INSPECT : undefined, settings: SETTINGS, cli: CLI, timeoutMs: 900_000 });
}

const result = { label: LABEL, cli: CLI ?? "(this repository's dist/)", dir: DIR, queries: QUERIES, iterations: ITER, warmup: null, restarts: [], search: [], memAfterSearch: null, indexMB: null };
const save = () => fs.writeFileSync(path.join(OUT, `memory-search-${LABEL}.json`), JSON.stringify(result, null, 2));

log(`waited ${await defenderQuiet()} s for Defender to be quiet`);
const probeOut = path.join(OUT, `probe-${LABEL}.json`);

{
  const e = await start(probeOut, false);
  const idleMs = await settle(probeOut);
  await e.stop();
  result.warmup = { listenMs: Math.round(e.listenMs), idleMs };
  log(`warm-up: listen ${result.warmup.listenMs} ms, idle ${idleMs} ms`);
  save();
}

for (let r = 1; r <= RESTARTS; r++) {
  const e = await start(probeOut, true);
  const listenMs = Math.round(e.listenMs);
  const idleMs = await settle(probeOut);
  const cdp = await Cdp.connect(INSPECT);
  const mem = await cdp.memory(true);
  const row = { listenMs, idleMs, heapMB: MB(mem.heapUsed), rssMB: MB(mem.rss) };
  result.restarts.push(row);
  log(`restart ${r}: listen ${listenMs} ms, idle ${idleMs} ms, heap ${row.heapMB} MB, rss ${row.rssMB} MB`);
  if (r === 1 && HEAP) {
    const file = path.join(OUT, `heap-${LABEL}-idle.heapsnapshot`);
    await cdp.heapSnapshot(file);
    log(`heap snapshot: ${file}`);
  }
  if (r === RESTARTS) {
    for (const query of QUERIES) {
      const body = { query, context_length: 40 };
      await e.call("search_notes", body);
      const ms = [];
      let total = null;
      for (let i = 0; i < ITER; i++) {
        const c = await e.call("search_notes", body);
        ms.push(c.ms);
        total = c.json.total ?? c.json.result?.total ?? null;
      }
      const s = { query, p50: +pct(ms, 50).toFixed(1), p95: +pct(ms, 95).toFixed(1), total };
      result.search.push(s);
      log(`search ${JSON.stringify(query)}: p50 ${s.p50} ms, p95 ${s.p95} ms, total ${total}`);
    }
    const m = await cdp.memory(true);
    result.memAfterSearch = { heapMB: MB(m.heapUsed), rssMB: MB(m.rss) };
    log(`after the searches: heap ${result.memAfterSearch.heapMB} MB, rss ${result.memAfterSearch.rssMB} MB`);
  }
  cdp.close();
  await e.stop();
  save();
}

let bytes = 0;
for (const suffix of ["", "-wal", "-shm"]) {
  const f = path.join(STORE, "index", `vault.sqlite${suffix}`);
  if (fs.existsSync(f)) bytes += fs.statSync(f).size;
}
result.indexMB = MB(bytes);
log(`vault.sqlite: ${result.indexMB} MB`);
save();
