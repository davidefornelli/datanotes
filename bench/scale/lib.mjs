/**
 * Shared helpers of the scale benchmark (bench/scale/): start and stop the built engine
 * (`dist/datanotes.cjs serve`) on a vault copy with a store of its own, call its operations, and
 * drive the V8 inspector (CPU profiles, heap snapshots, memory) over the Chrome DevTools Protocol.
 *
 * Never point it at a vault or store with real data: the engine writes to both.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = path.join(REPO, "dist", "datanotes.cjs");
export const PROBE = path.join(REPO, "bench", "scale", "probe.cjs");

/**
 * The ports this benchmark may use (never the production ones): 27400-27420, or the range in
 * SCALE_PORTS (`27540-27559`) when another benchmark runs on the same machine.
 */
const RANGE = /^(\d+)-(\d+)$/.exec(process.env.SCALE_PORTS ?? "");
export const PORT_MIN = RANGE ? Number(RANGE[1]) : 27400;
export const PORT_MAX = RANGE ? Number(RANGE[2]) : 27420;

export function assertLabPort(port) {
  if (!(port >= PORT_MIN && port <= PORT_MAX)) throw new Error(`port ${port} is outside ${PORT_MIN}-${PORT_MAX}`);
}

export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

export async function freeLabPort(exclude = []) {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!exclude.includes(p) && (await portFree(p))) return p;
  throw new Error("no free port in the lab range");
}

/** The environment of a lab engine: nothing that points at real data, no keys, no sync. */
export function cleanEnv(dataHome, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(DATANOTES_|OTEL_)/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, DATANOTES_DATA_HOME: dataHome, ...extra };
}

export function parseArgs(argv) {
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A timer that does not keep the process alive (for races against timeouts). */
export const sleepUnref = (ms) => new Promise((r) => setTimeout(r, ms).unref());

/** Write (merge) the engine's settings file in the store. */
export function writeSettings(store, values) {
  fs.mkdirSync(store, { recursive: true });
  const file = path.join(store, "settings.json");
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...cur, ...values }, null, 2));
}

/**
 * Start the built engine. Resolves once the HTTP server listens (the start line), with timings
 * measured from the spawn: `listenMs`.
 *
 * o: { vault, store, port, token, dataHome, nodeFlags?: string[], probeOut?: file, inspectPort?,
 *      cpuProfDir?, watch?: "events"|"poll", settings?: {}, env?: {}, timeoutMs?, cli? }
 *
 * `cli`: the `datanotes.cjs` to run; default: this repository's `dist/`.
 */
export async function startEngine(o) {
  assertLabPort(o.port);
  if (o.inspectPort) assertLabPort(o.inspectPort);
  if (!(await portFree(o.port))) throw new Error(`port ${o.port} is busy`);
  writeSettings(o.store, { httpServerPort: o.port, httpServerToken: o.token, storeBackupEnabled: false, semanticEnabled: false, ...(o.settings ?? {}) });
  for (const lock of [path.join(o.store, "engine.lock")]) fs.rmSync(lock, { force: true });
  const flags = [...(o.nodeFlags ?? [])];
  if (o.cpuProfDir) flags.push("--cpu-prof", `--cpu-prof-dir=${o.cpuProfDir}`, "--cpu-prof-interval", String(o.cpuProfInterval ?? 500));
  if (o.inspectPort) flags.push(`--inspect=127.0.0.1:${o.inspectPort}`);
  if (o.probeOut) flags.push("--require", PROBE);
  const args = [...flags, o.cli ?? CLI, "serve", "--vault", o.vault, "--store", o.store, "--port", String(o.port), "--watch", o.watch ?? "events", "--no-store-backup"];
  const env = cleanEnv(o.dataHome, { ...(o.probeOut ? { SCALE_PROBE_OUT: o.probeOut } : {}), ...(o.env ?? {}) });
  const t0 = performance.now();
  const wall0 = Date.now();
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env, cwd: path.dirname(o.store) });
  let output = "";
  let listenMs = null;
  let resolveListen;
  const listening = new Promise((r) => (resolveListen = r));
  const onData = (d) => {
    const s = String(d);
    output += s;
    if (listenMs === null && /datanotes service .*http:\/\//.test(output)) {
      listenMs = performance.now() - t0;
      resolveListen();
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", (d) => (output += String(d)));
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  const timeout = o.timeoutMs ?? 600_000;
  const r = await Promise.race([listening.then(() => "ok"), exited.then(() => "exit"), sleepUnref(timeout).then(() => "timeout")]);
  if (r !== "ok") {
    if (r === "timeout") child.kill();
    throw new Error(`the engine did not start (${r}):\n${output.slice(-4000)}`);
  }
  const url = `http://127.0.0.1:${o.port}`;
  const engine = {
    child,
    url,
    token: o.token,
    t0,
    wall0,
    listenMs,
    get output() {
      return output;
    },
    exited,
    call: (op, body = {}) => call(url, o.token, op, body),
    async stop(timeoutMs = 180_000) {
      if (child.exitCode !== null) return child.exitCode;
      try {
        await fetch(`${url}/datanotes/stop/`, { method: "POST", headers: { Authorization: `Bearer ${o.token}` } });
      } catch {}
      const code = await Promise.race([exited, sleepUnref(timeoutMs).then(() => "timeout")]);
      if (code === "timeout") {
        child.kill();
        await exited;
      }
      return code;
    },
  };
  return engine;
}

/** One operation over HTTP: { ms, status, json }. Throws on a refused or failed call unless `soft`. */
export async function call(url, token, op, body = {}, soft = false) {
  const t0 = performance.now();
  const res = await fetch(`${url}/datanotes/operations/${op}/`, {
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
  if (!soft && (!res.ok || json.ok === false)) {
    const err = new Error(`${op} ${res.status}: ${text.slice(0, 1500)}`);
    err.json = json;
    throw err;
  }
  return { ms, status: res.status, json, bytes: text.length };
}

/** A minimal Chrome DevTools Protocol client over the inspector's WebSocket. */
export class Cdp {
  static async connect(port, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let list;
    for (;;) {
      try {
        list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        if (list.length) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`no inspector on ${port}`);
      await sleep(200);
    }
    const ws = new WebSocket(list[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(`${m.error.message}`));
        else p?.resolve(m.result);
      } else {
        for (const cb of this.listeners.get(m.method) ?? []) cb(m.params);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
  off(method) {
    this.listeners.delete(method);
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  }
  async memory(gc = false) {
    if (gc) await this.send("HeapProfiler.collectGarbage");
    return this.evaluate("(() => { const m = process.memoryUsage(); return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers }; })()");
  }
  async startProfile(intervalUs = 500) {
    await this.send("Profiler.enable");
    await this.send("Profiler.setSamplingInterval", { interval: intervalUs });
    await this.send("Profiler.start");
  }
  async stopProfile(file) {
    const { profile } = await this.send("Profiler.stop");
    fs.writeFileSync(file, JSON.stringify(profile));
    return profile;
  }
  async heapSnapshot(file) {
    const fd = fs.openSync(file, "w");
    this.on("HeapProfiler.addHeapSnapshotChunk", (p) => fs.writeSync(fd, p.chunk));
    await this.send("HeapProfiler.enable");
    await this.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
    this.off("HeapProfiler.addHeapSnapshotChunk");
    fs.closeSync(fd);
  }
  close() {
    this.ws.close();
  }
}

/** Nearest-rank percentile of a list of numbers. */
export function pct(xs, p) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Count files and bytes under a folder, by first-level subfolder. */
export function treeStats(dir) {
  const out = { files: 0, bytes: 0, by: {} };
  if (!fs.existsSync(dir)) return out;
  const walk = (d, top) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const t = top ?? (e.isDirectory() ? e.name : "(root files)");
      if (e.isDirectory()) walk(p, t);
      else {
        const size = fs.statSync(p).size;
        out.files++;
        out.bytes += size;
        out.by[t] ??= { files: 0, bytes: 0 };
        out.by[t].files++;
        out.by[t].bytes += size;
      }
    }
  };
  walk(dir, null);
  return out;
}

/**
 * Copy a benchmark vault folder (vault/, store/, datahome/, manifest.json) to `dst`, and point the
 * copied store at the copied vault (store.json), so the engine takes the copy for what it is: a
 * vault moved with its store, not a second vault on the same store.
 */
export function copyVaultDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, filter: (p) => path.basename(p) !== "engine.lock" });
  relocateStore(dst);
}

/** Point `<dir>/store/store.json` at `<dir>/vault`. */
export function relocateStore(dir) {
  const file = path.join(dir, "store", "store.json");
  if (!fs.existsSync(file)) return;
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  s.vault = path.resolve(dir, "vault");
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

/**
 * Windows only: the CPU of Microsoft Defender's engine (MsMpEng) while it runs, one sample a
 * second (typeperf, no administrator rights needed). `stop()` gives the samples [ms since start,
 * % of one core] and the CPU-seconds they add up to.
 */
export function defenderMonitor() {
  if (process.platform !== "win32") return { stop: async () => ({ samples: [], cpuSeconds: 0 }) };
  const t0 = performance.now();
  const samples = [];
  const child = spawn("typeperf", ["\\Process(MsMpEng)\\% Processor Time", "-si", "1"], { stdio: ["ignore", "pipe", "ignore"] });
  let rest = "";
  child.stdout.on("data", (d) => {
    rest += String(d);
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    for (const l of lines) {
      const m = /^"[^"]+","([\d.]+)"/.exec(l);
      if (m) samples.push([Math.round(performance.now() - t0), Number(m[1])]);
    }
  });
  return {
    samples,
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      return { samples, cpuSeconds: +(samples.reduce((s, x) => s + x[1], 0) / 100).toFixed(2) };
    },
  };
}

/** Wait until Defender's engine is quiet: under `pct`% for `quietS` seconds in a row (at most `maxS`). */
export async function defenderQuiet(pct = 10, quietS = 5, maxS = 180) {
  if (process.platform !== "win32") return 0;
  const m = defenderMonitor();
  const t0 = performance.now();
  let waited = 0;
  while (performance.now() - t0 < maxS * 1000) {
    await sleep(1000);
    const s = m.samples;
    if (s.length >= quietS && s.slice(-quietS).every((x) => x[1] < pct)) break;
  }
  waited = Math.round((performance.now() - t0) / 1000);
  await m.stop();
  return waited;
}
