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
import { dot, embed, EmbeddingError, normalize, resolvedBaseUrl, type EmbeddingConfig, type Transport } from "./embeddings";
import { contentHash, readHashed } from "./file-cache";
import { cachedMetastore, loadMetastore, rowTableFull } from "./metastore";
import type { DatanotesSettings } from "./settings";
import { storePath, storeRead, storeWrite } from "./store";
import { OperationInputError } from "./engine";
import { messageOf } from "./message";

const SHARDS = 16;
const FORMAT = 1;

interface Passage {
  heading: string;
  snippet: string;
  v: Float32Array;
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

/** int8 quantization of a unit vector: base64 bytes + scale. */
export function quantize(v: Float32Array): { q: string; k: number } {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const k = max > 0 ? max / 127 : 1;
  const bytes = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) bytes[i] = (Math.round(v[i]! / k) + 256) & 255;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { q: btoa(bin), k };
}

export function dequantize(q: string, k: number): Float32Array {
  const bin = atob(q);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    const b = bin.charCodeAt(i);
    out[i] = (b > 127 ? b - 256 : b) * k;
  }
  return normalize(out);
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
            passages: f.passages.map((p) => ({ heading: p.h, snippet: p.s, v: dequantize(p.q, p.k) })),
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
          passages: f.passages.map((p) => ({ h: p.heading, s: p.snippet, ...quantize(p.v) })),
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
          entry: { hash: t.hash, ...(t.table ? { table: t.table } : {}), passages: chunks.map((c) => ({ heading: c.heading, snippet: c.snippet, v: new Float32Array(0) })) },
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
      s.entry.passages.forEach((p, i) => (p.v = s.vectors[i]!));
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
    const [qv] = await embed(this.transport, this.config(), [input.query.trim()]);
    const q = normalize(qv!);
    const limit = Math.min(Math.max(1, input.limit ?? 10), 100);
    const folder = input.folder?.replace(/^\/+|\/+$/g, "");
    const wantTable = (t: string | undefined) =>
      !input.tables || input.tables.length === 0 || (t !== undefined && input.tables.some((x) => t === x || t.endsWith(`.${x}`)));
    const best = new Map<string, SemanticHit>();
    for (const [path, f] of this.files) {
      if (folder && !path.startsWith(`${folder}/`)) continue;
      if (!wantTable(f.table)) continue;
      for (const p of f.passages) {
        const score = dot(q, p.v);
        if (input.minScore !== undefined && score < input.minScore) continue;
        const prev = best.get(path);
        if (!prev || score > prev.score) {
          best.set(path, { path, score, heading: p.heading, snippet: p.snippet, ...(f.table ? { table: f.table } : {}) });
        }
      }
    }
    const results = [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 }));
    return { query: input.query, results };
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
