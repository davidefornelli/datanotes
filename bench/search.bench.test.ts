/**
 * Search benchmark (not part of `npm test`): `npm run bench -- bench/search.bench.test.ts`, sizes
 * via SIZES (default 10000). A vault of notes in Italian on the headless Node host, with and without
 * the index of words on disk (`vault.sqlite`, as `datanotes serve` runs it); `search` (BM25, the
 * semantic index off) against `search_notes` on the same queries: a rare word, a common word, two
 * words, a phrase. The first search of a vault reads every note it needs; the warm ones are the
 * median of five.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { searchVault } from "../src/core/note-search";
import { mergeWithDefaults } from "../src/core/settings";
import { searchNotes } from "../src/core/vault-read";
import { closeNodeHost, openNodeVaultAsync } from "../src/node/node-app";

const SIZES = (process.env.SIZES ?? "10000").split(",").map(Number);

/** A small deterministic random source (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON = ["di", "la", "il", "che", "e", "per", "un", "una", "con", "non", "del", "della", "pasta", "casa", "giorno", "oggi", "poi", "anche"];
const RARE = ["svezzamento", "zucchine", "ricotta", "lievito", "melograno", "quinoa", "ferro", "cumino", "sedano", "farro"];

/** `n` notes of about 120 words: common words, a rare one in one note in fifty, "6 mesi" in one in a hundred. */
function writeVault(root: string, n: number): void {
  const rnd = random(7);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  for (let i = 0; i < n; i++) {
    const words: string[] = [];
    for (let k = 0; k < 120; k++) words.push(pick(COMMON));
    if (i % 50 === 0) words.splice(10, 0, pick(RARE));
    if (i % 100 === 0) words.splice(20, 0, "6", "mesi");
    const rel = `Notes/${Math.floor(i / 500)}/Nota ${i}.md`;
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `---\ntags: [diario]\n---\n# Nota ${i}\n\n${words.join(" ")}.\n`);
  }
}

async function time<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t = performance.now();
  const r = await fn();
  return [Math.round(performance.now() - t), r];
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const QUERIES = [
  ["rare word", "svezzamento"],
  ["common word", "pasta"],
  ["two words", "ricotta zucchine"],
  ["phrase", '"6 mesi"'],
] as const;

interface Row {
  notes: number;
  index: string;
  query: string;
  searchNotesFirstMs: number;
  searchNotesWarmMs: number;
  searchFirstMs: number;
  searchWarmMs: number;
  hits: number;
}
const rows: Row[] = [];

describe("search", () => {
  afterAll(() => {
    if (rows.length === 0) return;
    const cols: [keyof Row, string][] = [
      ["notes", "notes"], ["index", "index"], ["query", "query"], ["searchNotesFirstMs", "search_notes 1st ms"], ["searchNotesWarmMs", "search_notes warm ms"],
      ["searchFirstMs", "search 1st ms"], ["searchWarmMs", "search warm ms"], ["hits", "search hits"],
    ];
    const table = [cols.map(([, h]) => h), ...rows.map((r) => cols.map(([k]) => String(r[k])))];
    const w = cols.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
    const line = (r: string[]) => `| ${r.map((c, i) => c.padStart(w[i]!)).join(" | ")} |`;
    console.log(`\nsearch summary\n${[line(table[0]!), `|${w.map((x) => "-".repeat(x + 2)).join("|")}|`, ...table.slice(1).map(line)].join("\n")}\n`);
  });

  for (const n of SIZES) {
    for (const indexed of [true, false]) {
      it(`${n} notes, ${indexed ? "with" : "without"} the index of words`, { timeout: 3_600_000 }, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-bench-"));
        const store = fs.mkdtempSync(path.join(os.tmpdir(), "search-bench-store-"));
        try {
          writeVault(root, n);
          const host = await openNodeVaultAsync(root, undefined, indexed ? { index: { store, version: "bench" } } : {});
          const settings = mergeWithDefaults({ fileLogEnabled: false });
          try {
            for (const [label, query] of QUERIES) {
              // each query on a fresh cache would need a fresh host: the first of each is warm for the files read before it
              const [notesFirst] = await time(() => searchNotes(host.app, query.replace(/"/g, ""), 100, settings));
              const [first, r] = await time(() => searchVault(host.app, settings, { query, limit: 10 }));
              const notesWarm: number[] = [];
              const warm: number[] = [];
              for (let k = 0; k < 5; k++) {
                notesWarm.push((await time(() => searchNotes(host.app, query.replace(/"/g, ""), 100, settings)))[0]);
                warm.push((await time(() => searchVault(host.app, settings, { query, limit: 10 })))[0]);
              }
              expect(r.results.length).toBeGreaterThan(0);
              rows.push({ notes: n, index: indexed ? "yes" : "no", query: label, searchNotesFirstMs: notesFirst, searchNotesWarmMs: median(notesWarm), searchFirstMs: first, searchWarmMs: median(warm), hits: r.results.length });
            }
          } finally {
            closeNodeHost(host);
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
          fs.rmSync(store, { recursive: true, force: true });
        }
      });
    }
  }
});
