/**
 * Preloaded into the engine by the scale benchmark (`node --require bench/scale/probe.cjs
 * dist/datanotes.cjs serve …`, with SCALE_PROBE_OUT=<file.json>): it changes nothing the engine
 * does, and records
 *
 * - every file system call the engine makes (sync, promise and callback forms): count, time
 *   (latency for the asynchronous ones), characters read or written; in total and per 100 ms of
 *   the process's life (a timeline to lay over a CPU profile);
 * - garbage collections (count and pause time);
 * - event loop utilization and memory (RSS, heap) every 250 ms;
 * - marks: the probe loaded (the end of Node's own start), the bundle started, the HTTP server
 *   listening, the start line printed.
 *
 * Times are ms since the process started (performance.timeOrigin). The file is written every 2 s
 * and at exit.
 */
"use strict";
const out = process.env.SCALE_PROBE_OUT;
if (out) install(out);

function install(file) {
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const http = require("node:http");
  const Module = require("node:module");
  const { performance, PerformanceObserver } = require("node:perf_hooks");
  const now = () => performance.now();
  const writeFileSync = fs.writeFileSync;

  const data = {
    pid: process.pid,
    timeOrigin: performance.timeOrigin,
    marks: { probe: now() },
    totals: {},
    timeline: {}, // bucket (100 ms) -> op -> [n, ms]
    gc: { n: 0, ms: 0, byKind: {} },
    samples: [], // [t, elu, rssMB, heapUsedMB, heapTotalMB, externalMB]
  };
  const BUCKET = 100;
  const rec = (op, t0, chars) => {
    const t1 = now();
    const ms = t1 - t0;
    const tot = (data.totals[op] ??= { n: 0, ms: 0, chars: 0, max: 0 });
    tot.n++;
    tot.ms += ms;
    if (ms > tot.max) tot.max = ms;
    if (chars) tot.chars += chars;
    const b = Math.floor(t0 / BUCKET);
    const bucket = (data.timeline[b] ??= {});
    const e = (bucket[op] ??= [0, 0]);
    e[0]++;
    e[1] += ms;
  };
  const size = (v) => (typeof v === "string" ? v.length : v && typeof v.length === "number" ? v.length : 0);

  const SYNC = ["readFileSync", "writeFileSync", "appendFileSync", "readdirSync", "statSync", "lstatSync", "fstatSync", "existsSync", "mkdirSync", "renameSync", "openSync", "closeSync", "readSync", "writeSync", "unlinkSync", "rmSync", "rmdirSync", "copyFileSync", "accessSync", "fsyncSync", "utimesSync", "chmodSync"];
  for (const name of SYNC) {
    const orig = fs[name];
    if (typeof orig !== "function") continue;
    fs[name] = function (...a) {
      const t0 = now();
      let r;
      try {
        r = orig.apply(this, a);
        return r;
      } finally {
        rec(`sync.${name}`, t0, name === "readFileSync" ? size(r) : name === "writeFileSync" || name === "appendFileSync" ? size(a[1]) : 0);
      }
    };
  }
  const PROMISES = ["readFile", "writeFile", "appendFile", "readdir", "stat", "lstat", "mkdir", "rename", "unlink", "rm", "rmdir", "open", "access", "copyFile", "utimes"];
  for (const name of PROMISES) {
    const orig = fsp[name];
    if (typeof orig !== "function") continue;
    fsp[name] = function (...a) {
      const t0 = now();
      const p = orig.apply(this, a);
      p.then(
        (r) => rec(`promise.${name}`, t0, name === "readFile" ? size(r) : name === "writeFile" || name === "appendFile" ? size(a[1]) : 0),
        () => rec(`promise.${name}`, t0, 0),
      );
      return p;
    };
  }
  const CALLBACKS = ["readFile", "writeFile", "appendFile", "readdir", "stat", "lstat", "open", "close", "read", "write", "rename", "unlink", "mkdir", "fsync", "fstat"];
  for (const name of CALLBACKS) {
    const orig = fs[name];
    if (typeof orig !== "function") continue;
    fs[name] = function (...a) {
      const cb = a[a.length - 1];
      if (typeof cb !== "function") return orig.apply(this, a);
      const t0 = now();
      a[a.length - 1] = function (err, r) {
        rec(`cb.${name}`, t0, name === "readFile" ? size(r) : 0);
        return cb.apply(this, arguments);
      };
      return orig.apply(this, a);
    };
  }
  const watch = fs.watch;
  fs.watch = function (...a) {
    data.marks.watch ??= now();
    return watch.apply(this, a);
  };

  // marks: the bundle starts, the server listens, the start line is printed
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename) {
    if (/datanotes(-service)?\.cjs$/.test(filename) && data.marks.bundle === undefined) data.marks.bundle = now();
    return compile.apply(this, arguments);
  };
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...a) {
    data.marks.listenCall ??= now();
    this.once("listening", () => (data.marks.listening ??= now()));
    return listen.apply(this, a);
  };
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (data.marks.startLine === undefined && /datanotes service .*http:\/\//.test(String(chunk))) data.marks.startLine = now();
    return write.call(this, chunk, ...rest);
  };

  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      data.gc.n++;
      data.gc.ms += e.duration;
      const k = String(e.detail?.kind ?? e.kind ?? "?");
      const g = (data.gc.byKind[k] ??= { n: 0, ms: 0, max: 0 });
      g.n++;
      g.ms += e.duration;
      if (e.duration > g.max) g.max = e.duration;
      const b = Math.floor(e.startTime / BUCKET);
      const bucket = (data.timeline[b] ??= {});
      const x = (bucket.gc ??= [0, 0]);
      x[0]++;
      x[1] += e.duration;
    }
  });
  obs.observe({ entryTypes: ["gc"] });

  let elu = performance.eventLoopUtilization();
  const sample = () => {
    const e = performance.eventLoopUtilization(elu);
    elu = performance.eventLoopUtilization();
    const m = process.memoryUsage();
    const MB = (x) => Math.round((x / 1048576) * 10) / 10;
    data.samples.push([Math.round(now()), Math.round(e.utilization * 1000) / 1000, MB(m.rss), MB(m.heapUsed), MB(m.heapTotal), MB(m.external)]);
  };
  setInterval(sample, 250).unref();
  const flush = () => {
    try {
      writeFileSync(file, JSON.stringify(data));
    } catch {}
  };
  setInterval(flush, 2000).unref();
  process.on("exit", () => {
    sample();
    data.marks.exit = now();
    flush();
  });
}
