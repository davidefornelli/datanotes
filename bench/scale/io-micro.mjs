#!/usr/bin/env node
/**
 * What reading notes costs on this machine, and how much of it is the antivirus (Microsoft
 * Defender scans a file when it is opened after a change; an unchanged file it has seen is not
 * scanned again). Without administrator rights a folder cannot be excluded, so the share is
 * measured by its effect: the same files read (1) right after they were written, (2) again
 * (Defender's verdict cached), (3) after they were rewritten with the same text (scanned again),
 * each with readFileSync one at a time, as the engine's start does, and with fs.promises in
 * parallel. Defender's CPU (MsMpEng) is sampled meanwhile.
 *
 *   node bench/scale/io-micro.mjs --src <vault> --work <empty scratch folder> [--files 10000]
 *        [--concurrency 16] [--json out.json]
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { defenderMonitor, defenderQuiet, parseArgs, sleep } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const SRC = path.resolve(String(args.src));
const WORK = path.resolve(String(args.work));
const MAX = Number(args.files ?? 10000);
const CONC = Number(args.concurrency ?? 16);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (files.length >= MAX) return;
    if (e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) files.push(p);
  }
})(SRC);
fs.rmSync(WORK, { recursive: true, force: true });
const texts = files.map((f) => fs.readFileSync(f, "utf8"));
// the same tree shape: 100 notes per folder
const targets = files.map((_, i) => path.join(WORK, `d${Math.floor(i / 100)}`, `n${i}.md`));
const results = [];
const writeAll = () => {
  const t0 = performance.now();
  for (let i = 0; i < targets.length; i++) {
    fs.mkdirSync(path.dirname(targets[i]), { recursive: true });
    fs.writeFileSync(targets[i], texts[i]);
  }
  return performance.now() - t0;
};

async function pass(name, fn) {
  const quiet = await defenderQuiet(15, 5, 240);
  const mon = defenderMonitor();
  await sleep(1200);
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  await sleep(1500);
  const d = await mon.stop();
  const r = { name, files: targets.length, ms: Math.round(ms), usPerFile: Math.round((ms * 1000) / targets.length), defenderCpuS: d.cpuSeconds, waitedForQuietS: quiet };
  results.push(r);
  console.log(`${name.padEnd(56)} ${String(r.ms).padStart(7)} ms  ${String(r.usPerFile).padStart(6)} us/file  Defender ${d.cpuSeconds} cpu-s`);
  return r;
}
const readSync = () => {
  let n = 0;
  for (const f of targets) n += fs.readFileSync(f, "utf8").length;
  return n;
};
const readParallel = async () => {
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < targets.length) await fsp.readFile(targets[i++], "utf8");
  }));
};
const openClose = () => {
  for (const f of targets) fs.closeSync(fs.openSync(f, "r"));
};
const statAll = () => {
  for (const f of targets) fs.statSync(f);
};

console.log(`${targets.length} notes of ${SRC} into ${WORK}`);
console.log(`written in ${Math.round(writeAll())} ms`);
await pass("readFileSync, first read after write", readSync);
await pass("readFileSync, again (unchanged)", readSync);
await pass("readFileSync, again (unchanged)", readSync);
await pass("statSync, unchanged", statAll);
await pass("open+close, unchanged", openClose);
console.log(`rewritten in ${Math.round(writeAll())} ms`);
await pass("open+close, after a rewrite (same text)", openClose);
await pass("readFileSync, after open (verdict cached)", readSync);
console.log(`rewritten in ${Math.round(writeAll())} ms`);
await pass("readFileSync, after a rewrite (same text)", readSync);
console.log(`rewritten in ${Math.round(writeAll())} ms`);
await pass(`fs.promises.readFile x${CONC}, after a rewrite`, readParallel);
await pass(`fs.promises.readFile x${CONC}, unchanged`, readParallel);
await pass("readFileSync, unchanged", readSync);
if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ src: SRC, files: targets.length, concurrency: CONC, results }, null, 2));
fs.rmSync(WORK, { recursive: true, force: true });
