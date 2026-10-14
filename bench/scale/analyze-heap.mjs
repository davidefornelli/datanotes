#!/usr/bin/env node
/**
 * Summarize a V8 heap snapshot (.heapsnapshot) of the engine: memory by constructor (count, self
 * size, the size its objects retain), by node type, and the objects that retain the most with the
 * chain of objects that hold them (the dominator tree, as Chrome DevTools computes "retained
 * size"), and the strings held twice or more (duplicate strings). Streams the file, so snapshots
 * larger than a JavaScript string are fine.
 *
 *   node bench/scale/analyze-heap.mjs <file.heapsnapshot> [--top 40] [--json out.json]
 */
import fs from "node:fs";
import { parseArgs } from "./lib.mjs";

const argv = process.argv.slice(2);
const file = argv.shift();
const args = parseArgs(argv);
const TOP = Number(args.top ?? 40);

// --- streaming parse ------------------------------------------------------------------------------

const fd = fs.openSync(file, "r");
const CHUNK = 64 * 1024 * 1024;
let buf = Buffer.alloc(0);
let pos = 0;
let eof = false;
function fill() {
  if (eof) return false;
  const chunk = Buffer.alloc(CHUNK);
  const n = fs.readSync(fd, chunk, 0, CHUNK, null);
  if (n === 0) {
    eof = true;
    return false;
  }
  buf = pos < buf.length ? Buffer.concat([buf.subarray(pos), chunk.subarray(0, n)]) : chunk.subarray(0, n);
  pos = 0;
  return true;
}
/** Advance past `token` (bytes), keeping what follows. */
function seek(token) {
  const t = Buffer.from(token);
  for (;;) {
    const i = buf.indexOf(t, pos);
    if (i >= 0) {
      pos = i + t.length;
      return;
    }
    pos = Math.max(pos, buf.length - t.length);
    if (!fill()) throw new Error(`${token} not found`);
  }
}
function header() {
  while (buf.indexOf('"nodes":', pos) < 0) if (!fill()) throw new Error("no nodes");
  const i = buf.indexOf('"nodes":', pos);
  let text = buf.subarray(0, i).toString("utf8").trim();
  if (text.endsWith(",")) text = text.slice(0, -1);
  return JSON.parse(text + "}").snapshot;
}
/** Read a JSON array of non-negative integers into `sink(index, value)`; returns the count. */
function readInts(sink) {
  seek("[");
  let n = 0;
  let cur = 0;
  let inNum = false;
  for (;;) {
    if (pos >= buf.length && !fill()) throw new Error("eof in array");
    const b = buf[pos++];
    if (b >= 48 && b <= 57) {
      cur = cur * 10 + (b - 48);
      inNum = true;
    } else {
      if (inNum) {
        sink(n++, cur);
        cur = 0;
        inNum = false;
      }
      if (b === 93) return n; // ]
    }
  }
}
function readStrings() {
  seek("[");
  const out = [];
  for (;;) {
    if (pos >= buf.length && !fill()) throw new Error("eof in strings");
    const b = buf[pos];
    if (b === 93) return out;
    if (b !== 34) {
      pos++;
      continue;
    }
    // a string token: find its closing quote (not escaped)
    let j = pos + 1;
    for (;;) {
      if (j >= buf.length) {
        const off = j - pos;
        if (!fill()) throw new Error("eof in string");
        j = pos + off;
        continue;
      }
      const c = buf[j];
      if (c === 92) j += 2;
      else if (c === 34) break;
      else j++;
    }
    out.push(JSON.parse(buf.subarray(pos, j + 1).toString("utf8")));
    pos = j + 1;
  }
}

fill();
const meta = header();
const nf = meta.meta.node_fields;
const ef = meta.meta.edge_fields;
const nodeTypes = meta.meta.node_types[nf.indexOf("type")];
const edgeTypes = meta.meta.edge_types[ef.indexOf("type")];
const NF = nf.length;
const EF = ef.length;
const N = meta.node_count;
const E = meta.edge_count;
const iType = nf.indexOf("type");
const iName = nf.indexOf("name");
const iSelf = nf.indexOf("self_size");
const iEdges = nf.indexOf("edge_count");
const nType = new Uint8Array(N);
const nName = new Uint32Array(N);
const nSelf = new Float64Array(N);
const nEdges = new Uint32Array(N);
seek('"nodes":');
readInts((k, v) => {
  const i = (k / NF) | 0;
  const f = k - i * NF;
  if (f === iType) nType[i] = v;
  else if (f === iName) nName[i] = v;
  else if (f === iSelf) nSelf[i] = v;
  else if (f === iEdges) nEdges[i] = v;
});
const eType = new Uint8Array(E);
const eName = new Uint32Array(E);
const eTo = new Uint32Array(E);
const jType = ef.indexOf("type");
const jName = ef.indexOf("name_or_index");
const jTo = ef.indexOf("to_node");
seek('"edges":');
readInts((k, v) => {
  const i = (k / EF) | 0;
  const f = k - i * EF;
  if (f === jType) eType[i] = v;
  else if (f === jName) eName[i] = v;
  else if (f === jTo) eTo[i] = v / NF;
});
seek('"strings":');
const strings = readStrings();
fs.closeSync(fd);
console.log(`${file}: ${N} nodes, ${E} edges, ${strings.length} strings`);

// --- graph ---------------------------------------------------------------------------------------------

const firstEdge = new Uint32Array(N + 1);
for (let i = 0; i < N; i++) firstEdge[i + 1] = firstEdge[i] + nEdges[i];
const WEAK = edgeTypes.indexOf("weak");
const SHORTCUT = edgeTypes.indexOf("shortcut");
const strong = (e) => eType[e] !== WEAK && eType[e] !== SHORTCUT;
// reverse post order from the root (node 0)
const order = new Uint32Array(N);
const rpoIndex = new Int32Array(N).fill(-1);
{
  const visited = new Uint8Array(N);
  const stackNode = new Uint32Array(N);
  const stackEdge = new Uint32Array(N);
  let sp = 0;
  let post = 0;
  stackNode[0] = 0;
  stackEdge[0] = firstEdge[0];
  visited[0] = 1;
  sp = 1;
  while (sp > 0) {
    const v = stackNode[sp - 1];
    let e = stackEdge[sp - 1];
    let pushed = false;
    while (e < firstEdge[v + 1]) {
      const w = eTo[e];
      e++;
      if (!strong(e - 1) || visited[w]) continue;
      visited[w] = 1;
      stackEdge[sp - 1] = e;
      stackNode[sp] = w;
      stackEdge[sp] = firstEdge[w];
      sp++;
      pushed = true;
      break;
    }
    if (!pushed) {
      order[post++] = v;
      sp--;
    }
  }
  // reverse it: rpo[0] = root
  for (let i = 0; i < post / 2; i++) {
    const t = order[i];
    order[i] = order[post - 1 - i];
    order[post - 1 - i] = t;
  }
  for (let i = 0; i < post; i++) rpoIndex[order[i]] = i;
  order.reachable = post;
}
const R = order.reachable;
// predecessors (strong edges between reachable nodes)
const predCount = new Uint32Array(N + 1);
for (let v = 0; v < N; v++) {
  if (rpoIndex[v] < 0) continue;
  for (let e = firstEdge[v]; e < firstEdge[v + 1]; e++) if (strong(e) && rpoIndex[eTo[e]] >= 0) predCount[eTo[e] + 1]++;
}
for (let i = 0; i < N; i++) predCount[i + 1] += predCount[i];
const preds = new Uint32Array(predCount[N]);
{
  const fillp = predCount.slice(0, N);
  for (let v = 0; v < N; v++) {
    if (rpoIndex[v] < 0) continue;
    for (let e = firstEdge[v]; e < firstEdge[v + 1]; e++) if (strong(e) && rpoIndex[eTo[e]] >= 0) preds[fillp[eTo[e]]++] = v;
  }
}
// Cooper, Harvey, Kennedy: idom by reverse post order index
const idom = new Int32Array(N).fill(-1);
idom[0] = 0;
let changed = true;
let passes = 0;
while (changed) {
  changed = false;
  passes++;
  for (let k = 1; k < R; k++) {
    const b = order[k];
    let nd = -1;
    for (let p = predCount[b]; p < predCount[b + 1]; p++) {
      const q = preds[p];
      if (idom[q] < 0) continue;
      if (nd < 0) nd = q;
      else {
        let f1 = q;
        let f2 = nd;
        while (f1 !== f2) {
          while (rpoIndex[f1] > rpoIndex[f2]) f1 = idom[f1];
          while (rpoIndex[f2] > rpoIndex[f1]) f2 = idom[f2];
        }
        nd = f1;
      }
    }
    if (nd >= 0 && idom[b] !== nd) {
      idom[b] = nd;
      changed = true;
    }
  }
}
const retained = new Float64Array(N);
for (let k = R - 1; k >= 0; k--) {
  const v = order[k];
  retained[v] += nSelf[v];
  if (v !== 0) retained[idom[v]] += retained[v];
}

// --- report ----------------------------------------------------------------------------------------------

const typeName = (i) => nodeTypes[nType[i]];
function className(i) {
  const t = typeName(i);
  const name = strings[nName[i]];
  switch (t) {
    case "object":
    case "native":
      return name;
    case "string":
    case "concatenated string":
    case "sliced string":
      return "(string)";
    case "array":
      return `(array ${name || ""})`.replace(" )", ")");
    case "closure":
      return "(closure)";
    case "code":
      return "(compiled code)";
    case "hidden":
      return "(system)";
    case "number":
      return "(number)";
    case "regexp":
      return "(regexp)";
    default:
      return `(${t}) ${name}`.slice(0, 80);
  }
}
const MB = (x) => (x / 1048576).toFixed(1);
let totalSelf = 0;
for (let i = 0; i < N; i++) totalSelf += nSelf[i];
const byClass = new Map();
const byType = new Map();
const classIds = new Map();
const classNames = [];
const cls = new Uint32Array(N);
for (let i = 0; i < N; i++) {
  const c = className(i);
  let id = classIds.get(c);
  if (id === undefined) {
    classIds.set(c, (id = classNames.length));
    classNames.push(c);
    byClass.set(c, { n: 0, self: 0, retained: 0 });
  }
  cls[i] = id;
  const e = byClass.get(c);
  e.n++;
  e.self += nSelf[i];
  const t = typeName(i);
  byType.set(t, (byType.get(t) ?? 0) + nSelf[i]);
}
// retained by class: objects of the class not dominated by another object of the class
const classRetained = new Float64Array(classNames.length);
for (let k = 0; k < R; k++) {
  const v = order[k];
  const c = cls[v];
  let d = v === 0 ? -1 : idom[v];
  let nested = false;
  for (let hops = 0; d > 0 && hops < 32; hops++, d = idom[d]) {
    if (cls[d] === c) {
      nested = true;
      break;
    }
  }
  if (!nested) classRetained[c] += retained[v];
}
for (let c = 0; c < classNames.length; c++) byClass.get(classNames[c]).retained = classRetained[c];
const lines = [];
const say = (s = "") => lines.push(s);
say(`heap: ${MB(totalSelf)} MB in ${N} objects (${passes} dominator passes, ${R} reachable)`);
say("\nby node type (self MB):");
for (const [t, v] of [...byType].sort((a, b) => b[1] - a[1])) say(`${MB(v).padStart(9)}  ${t}`);
say(`\ntop ${TOP} constructors by retained size (MB; objects not inside another of the same class):`);
say(`${"retained".padStart(9)} ${"self".padStart(9)} ${"count".padStart(9)}  constructor`);
const classes = [...byClass].sort((a, b) => b[1].retained - a[1].retained);
for (const [c, e] of classes.slice(0, TOP)) say(`${MB(e.retained).padStart(9)} ${MB(e.self).padStart(9)} ${String(e.n).padStart(9)}  ${c.slice(0, 100)}`);
say(`\ntop ${TOP} constructors by self size:`);
for (const [c, e] of [...byClass].sort((a, b) => b[1].self - a[1].self).slice(0, TOP)) say(`${MB(e.self).padStart(9)} ${String(e.n).padStart(9)}  ${c.slice(0, 100)}`);

// the biggest retainers: objects with a large retained size, their holder chain (edge names)
function edgeLabel(from, to) {
  for (let e = firstEdge[from]; e < firstEdge[from + 1]; e++) {
    if (eTo[e] !== to) continue;
    const t = edgeTypes[eType[e]];
    return t === "element" || t === "hidden" ? `[${eName[e]}]` : strings[eName[e]];
  }
  return "?";
}
function describe(i) {
  const c = className(i);
  const name = strings[nName[i]];
  return typeName(i) === "closure" ? `${name || "(anonymous)"}()` : c.length > 60 ? c.slice(0, 60) + "…" : c;
}
const candidates = [];
for (let k = 1; k < R; k++) {
  const v = order[k];
  if (retained[v] < totalSelf * 0.01) continue;
  candidates.push(v);
}
candidates.sort((a, b) => retained[b] - retained[a]);
say(`\nobjects retaining 1% or more (MB retained, then the chain that holds them, innermost first):`);
const shown = [];
for (const v of candidates) {
  // skip a node whose dominator is shown with almost the same size (the same thing, one level down)
  const d = idom[v];
  if (shown.includes(d) && retained[v] > retained[d] * 0.9) continue;
  shown.push(v);
  const chain = [];
  for (let x = v, hops = 0; x > 0 && hops < 8; hops++) {
    const p = idom[x];
    chain.push(`${describe(x)}${p >= 0 ? ` .${edgeLabel(p, x)}` : ""}`);
    x = p;
  }
  say(`${MB(retained[v]).padStart(9)}  ${chain.join(" < ")}${idom[v] === 0 || chain.at(-1)?.endsWith("?") ? `   held by ${retainerHint(chain.length ? lastOf(v) : v)}` : ""}`);
  if (shown.length >= TOP) break;
}
function lastOf(v) {
  let x = v;
  for (let hops = 0; hops < 8 && idom[x] > 0; hops++) x = idom[x];
  return x;
}
/** Who points at a node (its strong retainers, up to 3): "Class.edge". */
function retainerHint(v) {
  const out = [];
  for (let p = predCount[v]; p < predCount[v + 1] && out.length < 3; p++) {
    const q = preds[p];
    out.push(`${describe(q)}.${edgeLabel(q, v)}`);
  }
  return out.join(", ") || "(root)";
}

// --- maps: what they hold -------------------------------------------------------------------------------

const PROPERTY = edgeTypes.indexOf("property");
const INTERNAL = edgeTypes.indexOf("internal");
function child(v, name) {
  for (let e = firstEdge[v]; e < firstEdge[v + 1]; e++) if (strings[eName[e]] === name && (eType[e] === INTERNAL || eType[e] === PROPERTY)) return eTo[e];
  return -1;
}
/** A Map's entries and the shape of its first values: property names of object values, or the value type. */
function mapInfo(m) {
  const table = child(m, "table");
  if (table < 0) return null;
  const kids = [];
  for (let e = firstEdge[table]; e < firstEdge[table + 1]; e++) {
    const w = eTo[e];
    const t = typeName(w);
    if (t === "object" || t === "string" || t === "array" || t === "number" || t === "concatenated string" || t === "sliced string") kids.push(w);
  }
  const values = kids.filter((w) => typeName(w) === "object");
  const shapes = new Map();
  for (const w of values.slice(0, 50)) {
    const props = [];
    for (let e = firstEdge[w]; e < firstEdge[w + 1]; e++) if (eType[e] === PROPERTY) props.push(strings[eName[e]]);
    const sig = `${className(w)}{${props.filter((p) => p !== "__proto__").slice(0, 8).join(",")}}`;
    shapes.set(sig, (shapes.get(sig) ?? 0) + 1);
  }
  const top = [...shapes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (kids[1] !== undefined ? className(kids[1]) : "empty");
  return { entries: Math.floor(kids.length / 2), shape: top };
}
// data reachable from a node: strong edges, through objects, arrays and strings only
const STOP = new Set(["code", "closure", "hidden", "native", "synthetic", "object shape", "regexp"]);
const STOP_CLASS = new Set(["NodeFile", "NodeFolder", "NodeVault", "NodeMetadataCache", "NodeFileManager", "EngineRuntime", "global", "Window"]);
const mark = new Uint32Array(N);
let markGen = 0;
function reachable(v, cap = 3_000_000) {
  markGen++;
  const stack = [v];
  mark[v] = markGen;
  let size = 0;
  let count = 0;
  while (stack.length && count < cap) {
    const x = stack.pop();
    size += nSelf[x];
    count++;
    for (let e = firstEdge[x]; e < firstEdge[x + 1]; e++) {
      if (!strong(e)) continue;
      const w = eTo[e];
      if (mark[w] === markGen) continue;
      const n = strings[eName[e]];
      if (eType[e] === PROPERTY && (n === "__proto__" || n === "constructor")) continue;
      if (eType[e] === INTERNAL && n === "map") continue;
      if (STOP.has(typeName(w)) || STOP_CLASS.has(className(w))) continue;
      mark[w] = markGen;
      stack.push(w);
    }
  }
  return { size, count, capped: count >= cap };
}
const maps = [];
for (let i = 0; i < N; i++) {
  const c = className(i);
  if (c !== "Map" && c !== "Set" && c !== "WeakMap") continue;
  if (retained[i] < 0.3 * 1048576 && nSelf[i] < 0.3 * 1048576) continue;
  maps.push(i);
}
maps.sort((a, b) => retained[b] - retained[a]);
say(`\nlargest Maps and Sets: retained MB, data reachable MB (shared data counted in each), entries, the shape of their values, who holds them:`);
const mapRows = [];
for (const m of maps.slice(0, TOP)) {
  const info = mapInfo(m) ?? { entries: "?", shape: "?" };
  const r = reachable(m);
  const holder = retainerHint(m);
  mapRows.push({ retainedMB: retained[m] / 1048576, reachableMB: r.size / 1048576, entries: info.entries, shape: info.shape, holder });
  say(`${MB(retained[m]).padStart(9)} ${MB(r.size).padStart(9)}${r.capped ? "+" : " "} ${String(info.entries).padStart(7)}  ${className(m)}<${info.shape.slice(0, 90)}>  held by ${holder.slice(0, 120)}`);
}
// strings: who holds them (the immediate dominator's class and the edge that holds the string)
const stringTypes = new Set(["string", "concatenated string", "sliced string"].map((t) => nodeTypes.indexOf(t)));
const byHolder = new Map();
for (let k = 1; k < R; k++) {
  const v = order[k];
  if (!stringTypes.has(nType[v])) continue;
  const d = idom[v];
  // a string inside a string (the parts of a concatenation) counts with its outer string
  if (d > 0 && stringTypes.has(nType[d])) continue;
  const lab = (a, b) => {
    const l = edgeLabel(a, b);
    return /^\[\d+\]$/.test(l) ? "[i]" : /^\d+$/.test(l) ? "[n]" : l;
  };
  let key = d <= 0 ? "(shared: no single holder)" : `${describe(d)}.${lab(d, v)}`;
  // an array's strings: name the array by what holds it, two levels up
  if (d > 0 && /^\(?[Aa]rray/.test(describe(d))) {
    const up = idom[d];
    const up2 = up > 0 ? idom[up] : -1;
    if (up > 0) key = `${up2 > 0 ? `${describe(up2)}.${lab(up2, up)} > ` : ""}${describe(up)}.${lab(up, d)} > ${key}`;
  }
  const e = byHolder.get(key) ?? { n: 0, size: 0 };
  e.n++;
  e.size += retained[v];
  byHolder.set(key, e);
}
say(`\nstrings by holder (MB retained, count; "[i]" an element of an array or a Map's table):`);
const holders = [...byHolder].sort((a, b) => b[1].size - a[1].size).slice(0, TOP);
for (const [k, e] of holders) say(`${MB(e.size).padStart(9)} ${String(e.n).padStart(9)}  ${k}`);
// duplicate strings: flat strings with the same text (a snapshot names a flat string by its text,
// one entry of `strings` per text; texts longer than the snapshot's name limit may be cut)
const FLAT = nodeTypes.indexOf("string");
const sameText = new Map();
let flatN = 0;
let flatSize = 0;
for (let i = 0; i < N; i++) {
  if (nType[i] !== FLAT) continue;
  flatN++;
  flatSize += nSelf[i];
  const e = sameText.get(nName[i]);
  if (e) {
    e.n++;
    e.size += nSelf[i];
  } else sameText.set(nName[i], { n: 1, size: nSelf[i], one: nSelf[i] });
}
const kindOf = (s) =>
  /.md$/i.test(s) ? "note path" : /^[[/.test(s) ? "wikilink" : /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s) ? "uuid" : /^[0-9a-f]{14}$/.test(s) ? "content hash" : /^#/.test(s) ? "tag" : /^[a-z0-9_]+.[a-z0-9_]+.[a-z0-9_]+$/.test(s) ? "table name" : /^d{4}-dd-dd/.test(s) ? "date" : s.length <= 12 ? "other, 12 characters or less" : "other, longer";
const kinds = new Map();
const dupTop = [];
let dupCopies = 0;
let dupSize = 0;
for (const [name, e] of sameText) {
  if (e.n < 2) continue;
  const extra = e.size - e.one;
  dupCopies += e.n - 1;
  dupSize += extra;
  const s = strings[name];
  const k = kindOf(s);
  const r = kinds.get(k) ?? { texts: 0, copies: 0, size: 0 };
  r.texts++;
  r.copies += e.n - 1;
  r.size += extra;
  kinds.set(k, r);
  dupTop.push([extra, e.n, s]);
}
dupTop.sort((a, b) => b[0] - a[0]);
say(`
duplicate strings: ${flatN} flat strings, ${MB(flatSize)} MB; ${dupCopies} copies of a text held already, ${MB(dupSize)} MB`);
for (const [k, r] of [...kinds].sort((a, b) => b[1].size - a[1].size)) say(`${MB(r.size).padStart(9)} ${String(r.copies).padStart(9)} copies of ${r.texts} texts  ${k}`);
for (const [extra, n, s] of dupTop.slice(0, TOP)) say(`${MB(extra).padStart(9)} ${String(n).padStart(9)}x ${JSON.stringify(s.slice(0, 80))}`);
console.log(lines.join("\n"));
if (args.json) {
  fs.writeFileSync(
    String(args.json),
    JSON.stringify({ file, nodes: N, totalSelfMB: totalSelf / 1048576, byType: Object.fromEntries([...byType].map(([k, v]) => [k, v / 1048576])), classes: classes.slice(0, 100).map(([c, e]) => ({ c, n: e.n, selfMB: e.self / 1048576, retainedMB: e.retained / 1048576 })), maps: mapRows, duplicates: { flatStrings: flatN, flatMB: flatSize / 1048576, copies: dupCopies, wastedMB: dupSize / 1048576, kinds: Object.fromEntries([...kinds].map(([k, r]) => [k, { texts: r.texts, copies: r.copies, MB: r.size / 1048576 }])) } }, null, 1),
  );
}
