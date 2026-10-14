/**
 * Semantic search over notes: each note is cut into passages (`chunk.ts`), embedded by the
 * configured provider (`embeddings.ts`) and stored in the plugin's hidden store:
 *
 *   store:semantic/shard-00.json … shard-15.json
 *
 * Each shard holds the files whose path hashes to it: content hash, table, and per passage the
 * heading, an excerpt and the vector quantized to int8 (base64). Only shards with changed files are
 * rewritten. A note is re-embedded when its content hash changes; changing provider or model
 * starts a new index. Search embeds the query and ranks passages by cosine similarity, one result
 * per note.
 *
 * Off by default: note content is sent to the embedding provider (stays on the machine with
 * Ollama or LM Studio).
 */

import type { App, TFile } from "./host";
import { chunkNote } from "./chunk";
import { embed, EmbeddingError, normalize, resolvedBaseUrl, type EmbeddingConfig, type Transport } from "./embeddings";
import { contentHash, readHashed } from "./file-cache";
import { cachedMetastore, loadMetastore, rowTableFull } from "./metastore";
import type { DatanotesSettings } from "./settings";
import { storePath, storeRead, storeWrite } from "./store";
import { OperationInputError } from "./engine";
import { messageOf } from "./message";

const SHARDS = 16;
const FORMAT = 1;

/**
 * A passage and its vector as the shards keep it: int8 values and their scale (a quarter of the
 * memory of floats). `norm` is what makes the dequantized vector unit length; search computes each
 * value as dequantize and normalize did, so scores are what they were with the floats of a load.
 */
interface Passage {
  heading: string;
  snippet: string;
  q: Int8Array;
  k: number;
  norm: number;
}
interface FileEntry {
  hash: string;
  table?: string;
  passages: Passage[];
}
interface ShardJson {
  format: number;
  key: string;
  files: Record<string, { hash: string; table?: string; passages: { h: string; s: string; q: string; k: number }[] }>;
}

export interface SemanticSearchInput {
  query: string;
  /** Default 10, at most 100. */
  limit?: number;
  /** Only rows of these tables (qualified or short names). */
  tables?: string[];
  /** Only notes under this folder. */
  folder?: string;
  /** Drop results scoring below this cosine similarity (0–1). */
  minScore?: number;
}

export interface SemanticHit {
  path: string;
  score: number;
  heading: string;
  snippet: string;
  table?: string;
}

export interface SemanticStatus {
  enabled: boolean;
  provider: string;
  model: string;
  files: number;
  passages: number;
  pending: number;
  running: boolean;
  last_sync?: string;
  last_error?: string;
}

export interface SyncResult {
  embedded: number;
  removed: number;
  unchanged: number;
  failed: { path: string; error: string }[];
}

/** int8 quantization of a unit vector: the values and their scale. */
function quantizeValues(v: Float32Array): { q: Int8Array; k: number } {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const k = max > 0 ? max / 127 : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i]! / k);
  return { q, k };
}

/** int8 values as the shards write them: base64 of their bytes. */
function base64Of(q: Int8Array): string {
  const bytes = new Uint8Array(q.buffer, q.byteOffset, q.length);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

/** int8 quantization of a unit vector: base64 bytes + scale. */
export function quantize(v: Float32Array): { q: string; k: number } {
  const { q, k } = quantizeValues(v);
  return { q: base64Of(q), k };
}

function valuesOf(q: string): Int8Array {
  const bin = atob(q);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function dequantize(q: string, k: number): Float32Array {
  const values = valuesOf(q);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i]! * k;
  return normalize(out);
}

/** A passage's vector kept as int8: the factor that makes it unit length, as normalize computes it. */
function passageOf(heading: string, snippet: string, q: Int8Array, k: number): Passage {
  let n = 0;
  for (let i = 0; i < q.length; i++) {
    const x = Math.fround(q[i]! * k);
    n += x * x;
  }
  return { heading, snippet, q, k, norm: n > 0 ? 1 / Math.sqrt(n) : 0 };
}

/**
 * The cosine of a unit query and a passage: each value of the passage dequantized and normalized
 * as 32-bit floats, as a loaded vector was, so the score is the same to the last bit.
 */
function scoreOf(query: Float32Array, p: Passage): number {
  const { q, k, norm } = p;
  const n = Math.min(query.length, q.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += query[i]! * Math.fround(Math.fround(q[i]! * k) * norm);
  return sum;
}

/**
 * The int8 dot product times the scale and the norm: within {@link SCORE_SLACK} of {@link scoreOf}
 * (two roundings to 32 bits per value, at most 1.2e-7 of a sum of unit vectors), and as fast as
 * floats.
 */
function estimateOf(query: Float32Array, p: Passage): number {
  const { q } = p;
  const n = Math.min(query.length, q.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += query[i]! * q[i]!;
  return sum * p.k * p.norm;
}

/** How far an estimate may be from the score, with a wide margin. */
export const SCORE_SLACK = 1e-6;

/** Query vectors kept by vector space and text: a query asked again does not call the service. */
const QUERY_VECTORS_MAX = 64;

/**
 * The `limit` best hits, best first, in the order a stable sort by score gives (equal scores keep
 * their order): a heap of the best so far instead of a sort of every note.
 */
export function topHits<T extends { score: number }>(hits: readonly T[], limit: number): T[] {
  // a worse hit: a lower score, or an equal one that came later
  const worse = (a: number, b: number) => hits[a]!.score < hits[b]!.score || (hits[a]!.score === hits[b]!.score && a > b);
  const heap: number[] = [];
  const swap = (i: number, j: number) => ([heap[i], heap[j]] = [heap[j]!, heap[i]!]);
  for (let i = 0; i < hits.length; i++) {
    if (heap.length < limit) {
      heap.push(i);
      for (let c = heap.length - 1; c > 0 && worse(heap[c]!, heap[(c - 1) >> 1]!); c = (c - 1) >> 1) swap(c, (c - 1) >> 1);
    } else if (worse(heap[0]!, i)) {
      heap[0] = i;
      for (let c = 0; ; ) {
        const l = 2 * c + 1;
        const r = l + 1;
        let w = c;
        if (l < heap.length && worse(heap[l]!, heap[w]!)) w = l;
        if (r < heap.length && worse(heap[r]!, heap[w]!)) w = r;
        if (w === c) break;
        swap(c, w);
        c = w;
      }
    }
  }
  return heap.sort((a, b) => (worse(a, b) ? 1 : -1)).map((i) => hits[i]!);
}

function shardOf(path: string): number {
  return parseInt(contentHash(path).slice(-4), 16) % SHARDS;
}

/** The embedding provider the settings name, with its API key. */
export function embeddingConfig(s: DatanotesSettings, apiKey: string | undefined): EmbeddingConfig {
  return { provider: s.semanticProvider, baseUrl: s.semanticBaseUrl, model: s.semanticModel, ...(apiKey ? { apiKey } : {}) };
}

/** Identity of the vector space: vectors from another provider/model are not comparable. */
export function vectorSpaceKey(c: EmbeddingConfig): string {
  return `${c.provider}|${resolvedBaseUrl(c)}|${c.model.trim()}`;
}

/** Why semantic search cannot run: it is off in the settings. */
export const SEMANTIC_OFF_MESSAGE = "semantic search is off: set semanticEnabled, semanticProvider and semanticModel in the engine settings";

export class SemanticIndex {
  private files = new Map<string, FileEntry>();
  private loadedKey: string | null = null;
  private dirtyShards = new Set<number>();
  private pending = new Set<string>();
  private running: Promise<SyncResult> | null = null;
  private lastSync?: string;
  private lastError?: string;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => DatanotesSettings,
    private readonly transport: Transport,
    /** The API key (from Obsidian's secret storage), if any. */
    private readonly getApiKey: () => string | undefined = () => undefined,
  ) {}

  private config(): EmbeddingConfig {
    return embeddingConfig(this.getSettings(), this.getApiKey());
  }

  private indexKey(): string {
    return vectorSpaceKey(this.config());
  }

  private requireEnabled(): void {
    if (!this.getSettings().semanticEnabled) throw new OperationInputError(SEMANTIC_OFF_MESSAGE);
  }

  private async load(): Promise<void> {
    const key = this.indexKey();
    if (this.loadedKey === key) return;
    this.files.clear();
    this.dirtyShards.clear();
    for (let i = 0; i < SHARDS; i++) {
      const text = await storeRead(this.app, this.shardPath(i));
      if (!text) continue;
      try {
        const json = JSON.parse(text) as ShardJson;
        if (json.format !== FORMAT || json.key !== key) continue; // another model: start over
        for (const [path, f] of Object.entries(json.files)) {
          this.files.set(path, {
            hash: f.hash,
            ...(f.table ? { table: f.table } : {}),
            passages: f.passages.map((p) => passageOf(p.h, p.s, valuesOf(p.q), p.k)),
          });
        }
      } catch {
        // unreadable shard: its files are re-embedded
      }
    }
    this.loadedKey = key;
  }

  private shardPath(i: number): string {
    return storePath("semantic", `shard-${String(i).padStart(2, "0")}.json`);
  }

  private async save(): Promise<void> {
    const key = this.indexKey();
    for (const i of [...this.dirtyShards].sort((a, b) => a - b)) {
      const files: ShardJson["files"] = {};
      for (const [path, f] of this.files) {
        if (shardOf(path) !== i) continue;
        files[path] = {
          hash: f.hash,
          ...(f.table ? { table: f.table } : {}),
          passages: f.passages.map((p) => ({ h: p.heading, s: p.snippet, q: base64Of(p.q), k: p.k })),
        };
      }
      await storeWrite(this.app, this.shardPath(i), JSON.stringify({ format: FORMAT, key, files } satisfies ShardJson));
    }
    this.dirtyShards.clear();
  }

  /** Notes in scope: every markdown note, or only table rows; minus excluded folders and archives. */
  private inScope(f: TFile, table: string | null): boolean {
    const s = this.getSettings();
    if (f.path.startsWith("_archive/") || f.path.includes("/_archive/")) return false;
    if (s.semanticExclude.some((dir) => f.path === dir || f.path.startsWith(`${dir.replace(/\/+$/, "")}/`))) return false;
    if (s.semanticScope === "tables" && !table) return false;
    return true;
  }

  private tableOf(f: TFile): string | null {
    const ms = cachedMetastore(this.app, this.getSettings());
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    return ms && fm ? rowTableFull(ms, fm[this.getSettings().tableKey]) : null;
  }

  /** Mark a note for re-embedding at the next `sync({ onlyPending: true })`. */
  touch(path: string): void {
    if (path.endsWith(".md")) this.pending.add(path);
  }

  forget(path: string): void {
    this.pending.add(path); // processed as a removal when the file is gone
  }

  /**
   * Bring the index up to date. Full scan by default; `onlyPending` handles the notes passed to
   * `touch`/`forget` since the last run. One run at a time (a second call waits for the first).
   */
  async sync(opts: { onlyPending?: boolean; rebuild?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<SyncResult> {
    this.requireEnabled();
    if (this.running) await this.running.catch(() => undefined);
    const run = this.doSync(opts);
    this.running = run;
    try {
      return await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  private async doSync(opts: { onlyPending?: boolean; rebuild?: boolean; onProgress?: (done: number, total: number) => void }): Promise<SyncResult> {
    const settings = this.getSettings();
    await loadMetastore(this.app, settings);
    await this.load();
    const result: SyncResult = { embedded: 0, removed: 0, unchanged: 0, failed: [] };
    if (opts.rebuild) {
      for (const p of this.files.keys()) this.dirtyShards.add(shardOf(p));
      this.files.clear();
    }

    let candidates: TFile[];
    const gone: string[] = [];
    if (opts.onlyPending) {
      const paths = [...this.pending];
      this.pending.clear();
      candidates = [];
      for (const p of paths) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f && "extension" in f) candidates.push(f as TFile);
        else gone.push(p);
      }
    } else {
      this.pending.clear();
      candidates = this.app.vault.getMarkdownFiles();
      const present = new Set(candidates.map((f) => f.path));
      for (const p of this.files.keys()) if (!present.has(p)) gone.push(p);
    }

    // Files to (re-)embed, and files that left the scope.
    const todo: { file: TFile; hash: string; content: string; table: string | null }[] = [];
    for (const f of candidates) {
      const table = this.tableOf(f);
      if (!this.inScope(f, table)) {
        if (this.files.has(f.path)) gone.push(f.path);
        continue;
      }
      const { content, hash } = await readHashed(this.app, f);
      const prev = this.files.get(f.path);
      if (prev && prev.hash === hash) {
        if ((prev.table ?? null) !== table) {
          if (table) prev.table = table;
          else delete prev.table;
          this.dirtyShards.add(shardOf(f.path));
        }
        result.unchanged++;
        continue;
      }
      todo.push({ file: f, hash, content, table });
    }
    for (const p of gone) {
      if (this.files.delete(p)) {
        this.dirtyShards.add(shardOf(p));
        result.removed++;
      }
    }

    // Embed passages in batches.
    const cfg = this.config();
    const batch = Math.max(1, settings.semanticBatchSize);
    const skipKeys = ["id", settings.tableKey, "position"];
    let done = 0;
    let queue: { path: string; i: number; text: string }[] = [];
    const staged = new Map<string, { entry: FileEntry; texts: string[]; vectors: (Float32Array | null)[] }>();
    const empty = new Int8Array(0);
    const flush = async () => {
      // Passages of a note whose earlier batch failed are dropped: the note is no longer staged.
      const items = queue.filter((x) => staged.has(x.path));
      queue = [];
      if (items.length === 0) return;
      try {
        const vectors = await embed(this.transport, cfg, items.map((x) => x.text));
        items.forEach((x, j) => {
          staged.get(x.path)!.vectors[x.i] = normalize(vectors[j]!);
        });
      } catch (e) {
        const error = messageOf(e);
        for (const x of new Set(items.map((y) => y.path))) {
          staged.delete(x);
          result.failed.push({ path: x, error });
          this.pending.add(x); // tried again at the next sync
        }
        if (!(e instanceof EmbeddingError) || /HTTP (401|403|404)/.test(error)) throw e; // configuration problem: stop
      }
    };
    try {
      for (const t of todo) {
        const chunks = chunkNote(t.file.path, t.content, { skipKeys });
        staged.set(t.file.path, {
          entry: { hash: t.hash, ...(t.table ? { table: t.table } : {}), passages: chunks.map((c) => ({ heading: c.heading, snippet: c.snippet, q: empty, k: 1, norm: 0 })) },
          texts: chunks.map((c) => c.text),
          vectors: chunks.map(() => null),
        });
        chunks.forEach((c, i) => queue.push({ path: t.file.path, i, text: c.text }));
        while (queue.length >= batch) {
          const rest = queue.slice(batch);
          queue = queue.slice(0, batch);
          await flush();
          queue = rest;
        }
        done++;
        opts.onProgress?.(done, todo.length);
        this.commit(staged, result);
      }
      await flush();
      this.commit(staged, result);
      this.lastError = result.failed[0]?.error;
    } catch (e) {
      this.lastError = messageOf(e);
      throw e;
    } finally {
      await this.save();
      this.lastSync = new Date().toISOString();
    }
    return result;
  }

  /** Move fully embedded files from `staged` into the index. */
  private commit(staged: Map<string, { entry: FileEntry; vectors: (Float32Array | null)[] }>, result: SyncResult): void {
    for (const [path, s] of staged) {
      if (s.vectors.some((v) => v === null)) continue;
      // kept as the shard keeps it: the scores are the same now and after a restart
      s.entry.passages = s.entry.passages.map((p, i) => {
        const { q, k } = quantizeValues(s.vectors[i]!);
        return passageOf(p.heading, p.snippet, q, k);
      });
      this.files.set(path, s.entry);
      this.dirtyShards.add(shardOf(path));
      staged.delete(path);
      result.embedded++;
    }
  }

  async search(input: SemanticSearchInput): Promise<{ query: string; results: SemanticHit[] }> {
    this.requireEnabled();
    if (typeof input.query !== "string" || input.query.trim() === "") throw new OperationInputError(`"query" is required`);
    await this.load();
    const q = await this.queryVector(input.query.trim());
    const limit = Math.min(Math.max(1, input.limit ?? 10), 100);
    const folder = input.folder?.replace(/^\/+|\/+$/g, "");
    const wantTable = (t: string | undefined) =>
      !input.tables || input.tables.length === 0 || (t !== undefined && input.tables.some((x) => t === x || t.endsWith(`.${x}`)));
    // Each note's best passage (the first of equal ones), then the `limit` best notes, best first;
    // equal scores keep the notes' order (a stable sort did). The int8 dot product, without the
    // float rounding, is within SCORE_SLACK of the score: it rules out the notes and passages that
    // cannot be among the best, and only the others are scored to the last bit.
    const min = input.minScore;
    /** The passages that pass `minScore` (decided exactly where the estimate is too close to say). */
    const passing = (f: FileEntry): { p: Passage; estimate: number }[] =>
      f.passages
        .map((p) => ({ p, estimate: estimateOf(q, p) }))
        .filter(({ p, estimate }) => min === undefined || estimate >= min + SCORE_SLACK || (estimate >= min - SCORE_SLACK && scoreOf(q, p) >= min));
    const notes: { path: string; f: FileEntry; estimate: number }[] = [];
    for (const [path, f] of this.files) {
      if (folder && !path.startsWith(`${folder}/`)) continue;
      if (!wantTable(f.table)) continue;
      let estimate = -Infinity;
      for (const x of passing(f)) estimate = Math.max(estimate, x.estimate);
      if (estimate > -Infinity) notes.push({ path, f, estimate });
    }
    // the notes that may be among the `limit` best: those within twice the slack of the limit-th estimate
    const cut = notes.length > limit ? topHits(notes.map((n) => ({ score: n.estimate })), limit)[limit - 1]!.score - 2 * SCORE_SLACK : -Infinity;
    const hits: { path: string; score: number; p: Passage; table?: string }[] = [];
    for (const n of notes) {
      if (n.estimate < cut) continue;
      let best: Passage | null = null;
      let top = 0;
      for (const { p, estimate } of passing(n.f)) {
        // a passage further below the note's best estimate cannot be its best
        if (estimate < n.estimate - 2 * SCORE_SLACK) continue;
        const score = scoreOf(q, p);
        if (!best || score > top) {
          best = p;
          top = score;
        }
      }
      hits.push({ path: n.path, score: top, p: best!, ...(n.f.table ? { table: n.f.table } : {}) });
    }
    const results = topHits(hits, limit).map((h) => ({ path: h.path, score: Math.round(h.score * 1000) / 1000, heading: h.p.heading, snippet: h.p.snippet, ...(h.table ? { table: h.table } : {}) }));
    return { query: input.query, results };
  }

  /** Query vectors already asked for, by vector space and text (the oldest out first). */
  private readonly queries = new Map<string, Float32Array>();

  /**
   * The unit vector of a query: asked of the service once per vector space, API key and text. A key
   * changed (or gone) asks again, so the service and its refusals see it as before.
   */
  private async queryVector(text: string): Promise<Float32Array> {
    const key = `${this.indexKey()}\u0000${contentHash(this.getApiKey() ?? "")}\u0000${text}`;
    const kept = this.queries.get(key);
    if (kept) {
      this.queries.delete(key);
      this.queries.set(key, kept);
      return kept;
    }
    const [qv] = await embed(this.transport, this.config(), [text]);
    const v = normalize(qv!);
    this.queries.set(key, v);
    if (this.queries.size > QUERY_VECTORS_MAX) this.queries.delete(this.queries.keys().next().value!);
    return v;
  }

  status(): SemanticStatus {
    const s = this.getSettings();
    let passages = 0;
    for (const f of this.files.values()) passages += f.passages.length;
    return {
      enabled: s.semanticEnabled,
      provider: s.semanticProvider,
      model: s.semanticModel,
      files: this.files.size,
      passages,
      pending: this.pending.size,
      running: this.running !== null,
      ...(this.lastSync ? { last_sync: this.lastSync } : {}),
      ...(this.lastError ? { last_error: this.lastError } : {}),
    };
  }
}
