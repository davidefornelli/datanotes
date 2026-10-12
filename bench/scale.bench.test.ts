/**
 * Scale benchmark (not part of `npm test`, whose include is `tests/**`): `npm run bench`, sizes via
 * SIZES=1000,5000 (default 1000,5000,10000), insert/update samples via SAMPLES (default 20), and an
 * Obsidian-like in-memory file index unless MEMINDEX=0 (the plain fake vault pays a syscall per stat).
 * History is on for the table (configure_database history=true), so every write also commits to
 * the transaction log in `.datanotes/delta_log/<catalog.schema.table>/`, as for users who turn it on.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { listVersions, transactionLogDir } from "../src/core/transaction-log";
import { createTable, INDEX_RETRY, logExternalEdits } from "../src/core/engine";
import { insertRow, select, updateRows, checkTable } from "../src/core/rows";
import { createDbVault } from "../tests/helpers/db-vault";

INDEX_RETRY.delayMs = 1;
const SIZES = (process.env.SIZES ?? "1000,5000,10000").split(",").map(Number);
const SAMPLES = Number(process.env.SAMPLES ?? 20);
const TABLE = "main.public.log";
/** On unless MEMINDEX=0 (vitest.bench.config.ts): then the plain fake vault is measured. */
const MEMINDEX = (process.env.MEMINDEX ?? "1") !== "0";

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}

async function time<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t = performance.now();
  const r = await fn();
  return [Math.round(performance.now() - t), r];
}

/** Nearest-rank percentile (ms) of a list of samples. */
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

interface Result {
  n: number;
  baselineCommitMs: number;
  insertMedMs: number;
  insertP95Ms: number;
  selectFirstMs: number;
  selectWarmMs: number;
  checkMs: number;
  update1MedMs: number;
  logKBPerWrite: number;
  logVersions: number;
}
const results: Result[] = [];


type Rec = { path: string; name: string; extension: string; basename: string; stat: { mtime: number; size: number } };
/** Obsidian-like in-memory file index over the fake vault: TFile.stat, file lists and folder children without syscalls. */
function memIndex(v: ReturnType<typeof createDbVault>): void {
  const files = new Map<string, Rec>();
  const kids = new Map<string, Set<string>>();
  const abs = (rel: string) => path.join(v.root, ...rel.split("/"));
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const link = (p: string) => {
    let child = p;
    for (let dir = parentOf(p); ; dir = parentOf(dir)) {
      const set = kids.get(dir) ?? new Set<string>();
      const had = set.has(child);
      set.add(child);
      kids.set(dir, set);
      if (had || dir === "") break;
      child = dir;
    }
  };
  const add = (rel: string) => {
    const st = fs.statSync(abs(rel));
    const name = rel.split("/").pop()!;
    const ext = name.includes(".") ? name.split(".").pop()! : "";
    files.set(rel, { path: rel, name, extension: ext, basename: name.replace(/\.[^.]+$/, ""), stat: { mtime: st.mtimeMs, size: st.size } });
    link(rel);
  };
  const drop = (rel: string) => {
    files.delete(rel);
    kids.get(parentOf(rel))?.delete(rel);
  };
  const walkAll = (dir: string) => {
    for (const e of fs.readdirSync(abs(dir) || v.root, { withFileTypes: true })) {
      const rel = dir === "" ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) { link(rel); walkAll(rel); } else add(rel);
    }
  };
  walkAll("");
  const vault = v.app.vault as unknown as Record<string, (...a: never[]) => unknown>;
  const fm = v.app.fileManager as unknown as Record<string, (...a: never[]) => unknown>;
  const orig = { create: vault.create!, process: vault.process!, trash: vault.trash!, createFolder: vault.createFolder!, rename: fm.renameFile!, trashFile: fm.trashFile! };
  const folderObj = (p: string): unknown => ({
    path: p,
    get children() {
      return [...(kids.get(p) ?? [])].map((c) => files.get(c) ?? folderObj(c));
    },
  });
  Object.assign(vault, {
    getMarkdownFiles: () => [...files.values()].filter((f) => f.extension === "md"),
    getFiles: () => [...files.values()],
    getAbstractFileByPath: (p: string) => files.get(p) ?? (kids.has(p) ? folderObj(p) : null),
    create: async (p: string, c: string) => { const r = await (orig.create as (p: string, c: string) => Promise<unknown>)(p, c); add(p); return files.get(p); },
    process: async (f: { path: string }, fn: (t: string) => string) => { const r = await (orig.process as (f: unknown, fn: unknown) => Promise<string>)(f, fn); add(f.path); return r; },
    trash: async (f: { path: string }) => { await (orig.trash as (f: unknown) => Promise<void>)(f); drop(f.path); },
    createFolder: async (p: string) => { await (orig.createFolder as (p: string) => Promise<void>)(p); link(p); },
  });
  Object.assign(fm, {
    renameFile: async (f: { path: string }, to: string) => { const from = f.path; await (orig.rename as (f: unknown, t: string) => Promise<void>)(f, to); drop(from); add(to); },
    trashFile: async (f: { path: string }) => { await (orig.trashFile as (f: unknown) => Promise<void>)(f); drop(f.path); },
  });
  const mc = v.app.metadataCache as unknown as { getFileCache(f: { path: string }): unknown };
  const parse = mc.getFileCache.bind(mc);
  const memo = new Map<string, [number, unknown]>();
  mc.getFileCache = (f) => {
    const m = files.get(f.path)?.stat.mtime ?? -1;
    const hit = memo.get(f.path);
    if (hit && hit[0] === m) return hit[1];
    const val = parse(f);
    memo.set(f.path, [m, val]);
    return val;
  };
}

describe("scale", () => {
  afterAll(() => {
    if (results.length === 0) return;
    const cols: [keyof Result, string][] = [
      ["n", "rows"], ["insertMedMs", "insert med ms"], ["insertP95Ms", "insert p95 ms"],
      ["selectFirstMs", "select 1st ms"], ["selectWarmMs", "select warm ms"], ["checkMs", "check ms"],
      ["update1MedMs", "update1 med ms"], ["logKBPerWrite", "log KB/write"], ["baselineCommitMs", "baseline ms"],
    ];
    const rows = [cols.map(([, h]) => h), ...results.map((r) => cols.map(([k]) => String(r[k])))];
    const w = cols.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    const line = (r: string[]) => `| ${r.map((c, i) => c.padStart(w[i]!)).join(" | ")} |`;
    const out = [line(rows[0]!), `|${w.map((x) => "-".repeat(x + 2)).join("|")}|`, ...rows.slice(1).map(line)];
    console.log(`\nscale summary (MEMINDEX=${MEMINDEX ? 1 : 0}, history on, ${SAMPLES} samples per write metric)\n${out.join("\n")}\n`);
  });

  for (const n of SIZES) {
    it(`${n} rows`, { timeout: 3_600_000 }, async () => {
      const v = createDbVault({});
      const mc = v.app.metadataCache as unknown as { getFileCache(f: { path: string }): unknown };
      const orig = mc.getFileCache.bind(mc);
      const memo = new Map<string, [number, unknown]>();
      mc.getFileCache = (f) => {
        const p = path.join(v.root, ...f.path.split("/"));
        const m = fs.existsSync(p) ? fs.statSync(p).mtimeMs : -1;
        const hit = memo.get(f.path);
        if (hit && hit[0] === m) return hit[1];
        const val = orig(f);
        memo.set(f.path, [m, val]);
        return val;
      };
      // As a user would: history (time travel) on for the database, then the table.
      await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome", history: true }, async () => {});
      await createTable(v.app, v.settings, {
        schema: "public", name: "log", timeColumn: "occurred_at", description: "Events, one per hour",
        columns: [
          { name: "id", type: "string", unique: true },
          { name: "occurred_at", type: "datetime", required: true, dense: true, description: "When the event happened" },
          { name: "kind", type: "enum", values: ["a", "b", "c"], dense: true, description: "The kind of event" },
          { name: "value", type: "integer", dense: true, description: "A measure of the event" },
          { name: "description", type: "string", description: "The event, in words" },
        ],
      });
      for (let i = 0; i < n; i++) {
        const d = new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString().slice(0, 16);
        const name = d.replace(":", "");
        const rel = `Datanotes/main/public/log/${name}.md`;
        const abs = path.join(v.root, ...rel.split("/"));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `---\ntable: main.public.log\nid: ${name}\noccurred_at: ${d}:00+00:00\nkind: ${"abc"[i % 3]}\nvalue: ${i % 10}\ndescription: row number ${i} with a bit of descriptive text\n---\nBody of note ${i}. `.padEnd(600, "x") + "\n");
      }
      if (MEMINDEX) memIndex(v);
      const logDir = path.join(v.storeRoot, ...transactionLogDir(v.settings, TABLE).replace(/^store:/, "").split("/"));
      // The rows written behind the engine's back are recorded as one EXTERNAL_EDIT commit.
      const [tBase] = await time(() => logExternalEdits(v.app, v.settings));
      const where = { kind: "b", value: { gte: 5 } };
      const [tSelectFirst, sel] = await time(() => select(v.app, v.settings, { table: "log", where, limit: 10 }));
      const warm: number[] = [];
      for (let k = 0; k < 5; k++) warm.push((await time(() => select(v.app, v.settings, { table: "log", where, limit: 10 })))[0]);
      const [tCheck] = await time(() => checkTable(v.app, v.settings, { table: "log" }));

      const versionsBefore = (await listVersions(v.app, v.settings, TABLE)).length;
      const logBefore = dirSize(logDir);
      const inserts: number[] = [];
      for (let k = 0; k < SAMPLES; k++) {
        const at = new Date(Date.UTC(2031, 0, 1) + k * 3_600_000).toISOString().slice(0, 16);
        inserts.push((await time(() => insertRow(v.app, v.settings, { table: "log", values: { occurred_at: at, kind: "a", value: 1 } })))[0]);
      }
      const updates: number[] = [];
      for (let k = 0; k < SAMPLES; k++) {
        const id = new Date(Date.UTC(2020, 0, 1) + ((k * 7919) % n) * 3_600_000).toISOString().slice(0, 16).replace(":", "");
        updates.push((await time(() => updateRows(v.app, v.settings, { table: "log", where: { id }, set: { value: 100 + k } })))[0]);
      }
      const growth = dirSize(logDir) - logBefore;
      const versions = (await listVersions(v.app, v.settings, TABLE)).length - versionsBefore;
      // The log must actually record each write; a silent 0 is the bug this bench once had.
      expect(versions).toBe(2 * SAMPLES);
      expect(growth).toBeGreaterThan(0);

      const r: Result = {
        n,
        baselineCommitMs: tBase,
        insertMedMs: pct(inserts, 50),
        insertP95Ms: pct(inserts, 95),
        selectFirstMs: tSelectFirst,
        selectWarmMs: pct(warm, 50),
        checkMs: tCheck,
        update1MedMs: pct(updates, 50),
        logKBPerWrite: +(growth / (2 * SAMPLES) / 1024).toFixed(1),
        logVersions: versions,
      };
      results.push(r);
      console.log(JSON.stringify({ ...r, matched: sel.total, update1P95Ms: pct(updates, 95) }));
    });
  }
});
