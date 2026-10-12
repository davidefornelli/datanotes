/**
 * The engine's vector index of the docs, for the hybrid search of search_docs: every section of
 * the docs this engine ships (the sections search_docs ranks by their words, src/api/docs.ts),
 * embedded by the provider of semantic search and kept in a file of its own in the store, apart
 * from the vault's index (semantic.ts):
 *
 *   store:semantic/docs.json   {format, key, version, sections: {<path>: {h, q, k}}}
 *
 * `key` names the provider, address and model: another one starts a new index. `version` is the
 * docs' version (a hash of their sections), written once every section has its vector: when the
 * docs change (another engine version, a new docs build), the index is rebuilt for them, and a
 * section whose text did not change keeps its vector (`h`, the hash of the text embedded).
 *
 * The engine builds it in the background: after its first scan of the vault, and when a search
 * finds it out of date. Until it covers the docs, a search answers `ready: false` and no results,
 * and search_docs ranks by words alone. The docs are public: embedding them sends nothing of the
 * vault.
 */

import type { App } from "./host";
import { dot, embed, normalize, type Transport } from "./embeddings";
import { contentHash } from "./file-cache";
import { guide } from "./hints";
import { OperationInputError } from "./engine";
import { messageOf } from "./message";
import { dequantize, embeddingConfig, quantize, SEMANTIC_OFF_MESSAGE, vectorSpaceKey } from "./semantic";
import type { DatanotesSettings } from "./settings";
import { storePath, storeRead, storeWrite } from "./store";

const FORMAT = 1;

/** The file of the index in the store. */
export const DOCS_INDEX_FILE = storePath("semantic", "docs.json");

/** The most characters of a section that are embedded (about 1,000 tokens, within every model's input): its title and first paragraphs. */
export const DOCS_EMBED_MAX_CHARS = 4000;

/** The most results a search returns, and the default. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/** What semantic search being off means for the docs, and how to turn it on. */
const DOCS_SEMANTIC_OFF = guide(
  "Semantic search is off: the owner turns it on with semanticEnabled, semanticProvider and semanticModel in the engine's settings. Until then, search_docs ranks the docs by their words.",
  "semantic",
);

/** The arguments of a search. */
const SEARCH_INPUT = guide(`Send {"query": "time travel a view", "limit": 50}: the words to rank the sections by, and how many to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`, "docsSearch");

/** The docs to index: their version and their sections, with the text to embed. */
export interface DocsCorpus {
  version: string;
  sections: readonly { path: string; text: string }[];
}

/** The answer of a search of the docs by meaning. */
export interface DocsSemanticAnswer {
  query: string;
  /** The version of the docs this engine ships. */
  version: string;
  /** The index covers every section of that version; false while it is built, with no results. */
  ready: boolean;
  /** The sections of the docs, and how many have their vector. */
  sections: number;
  embedded: number;
  /** The sections, closest in meaning first, with their cosine similarity. */
  results: { path: string; score: number }[];
  /** Why the last build of the index failed, while it is not ready. */
  last_error?: string;
}

/** What a build of the index did. */
export interface DocsSyncResult {
  version: string;
  embedded: number;
  reused: number;
  removed: number;
}

interface DocsIndexJson {
  format: number;
  key: string;
  /** The docs' version, once every section has its vector; null while the index is incomplete. */
  version: string | null;
  sections: Record<string, { h: string; q: string; k: number }>;
}

export class DocsSemanticIndex {
  private vectors = new Map<string, { hash: string; v: Float32Array }>();
  private loadedKey: string | null = null;
  /** The version of the docs the index covers in full; null while it does not. */
  private version: string | null = null;
  private running: Promise<DocsSyncResult> | null = null;
  private lastError: string | undefined;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => DatanotesSettings,
    private readonly transport: Transport,
    private readonly getApiKey: () => string | undefined,
    /** The docs this engine ships; throws when there are none (the error says how to get them). */
    private readonly corpus: () => DocsCorpus,
  ) {}

  private config() {
    return embeddingConfig(this.getSettings(), this.getApiKey());
  }

  private requireEnabled(): void {
    if (!this.getSettings().semanticEnabled) throw new OperationInputError(SEMANTIC_OFF_MESSAGE, DOCS_SEMANTIC_OFF);
  }

  private async load(): Promise<void> {
    const key = vectorSpaceKey(this.config());
    if (this.loadedKey === key) return;
    this.vectors.clear();
    this.version = null;
    const text = await storeRead(this.app, DOCS_INDEX_FILE);
    if (text) {
      try {
        const json = JSON.parse(text) as DocsIndexJson;
        if (json.format === FORMAT && json.key === key) {
          for (const [path, s] of Object.entries(json.sections)) this.vectors.set(path, { hash: s.h, v: dequantize(s.q, s.k) });
          this.version = json.version;
        }
      } catch {
        // an unreadable index is built again
      }
    }
    this.loadedKey = key;
  }

  private async save(): Promise<void> {
    const sections: DocsIndexJson["sections"] = {};
    for (const [path, s] of [...this.vectors].sort(([a], [b]) => a.localeCompare(b))) sections[path] = { h: s.hash, ...quantize(s.v) };
    const json: DocsIndexJson = { format: FORMAT, key: this.loadedKey!, version: this.version, sections };
    await storeWrite(this.app, DOCS_INDEX_FILE, JSON.stringify(json));
  }

  /** The text of a section that is embedded, and its hash. */
  private static embedded(text: string): { text: string; hash: string } {
    const cut = text.slice(0, DOCS_EMBED_MAX_CHARS);
    return { text: cut, hash: contentHash(cut) };
  }

  /**
   * Bring the index up to date with the docs: nothing to do when it covers their version; else
   * embed the sections that are new or whose text changed, and drop those that are gone. `rebuild`
   * embeds every section again. One build at a time (a second call waits for the first).
   */
  async sync(opts: { rebuild?: boolean } = {}): Promise<DocsSyncResult> {
    this.requireEnabled();
    if (this.running) await this.running.catch(() => undefined);
    const run = this.doSync(opts.rebuild === true);
    this.running = run;
    try {
      return await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  private async doSync(rebuild: boolean): Promise<DocsSyncResult> {
    try {
      const corpus = this.corpus();
      await this.load();
      if (rebuild) {
        this.vectors.clear();
        this.version = null;
      }
      if (this.version === corpus.version) return { version: corpus.version, embedded: 0, reused: corpus.sections.length, removed: 0 };
      this.version = null;
      const wanted = new Map(corpus.sections.map((s) => [s.path, DocsSemanticIndex.embedded(s.text)]));
      let removed = 0;
      for (const path of [...this.vectors.keys()]) {
        if (!wanted.has(path)) {
          this.vectors.delete(path);
          removed++;
        }
      }
      const todo = [...wanted].filter(([path, w]) => this.vectors.get(path)?.hash !== w.hash);
      const cfg = this.config();
      const batch = Math.max(1, this.getSettings().semanticBatchSize);
      let embedded = 0;
      try {
        for (let i = 0; i < todo.length; i += batch) {
          const part = todo.slice(i, i + batch);
          const vectors = await embed(this.transport, cfg, part.map(([, w]) => w.text));
          part.forEach(([path, w], j) => this.vectors.set(path, { hash: w.hash, v: normalize(vectors[j]!) }));
          embedded += part.length;
        }
        this.version = corpus.version;
      } finally {
        // what was embedded is kept, so a build that failed half-way resumes there
        await this.save();
      }
      this.lastError = undefined;
      return { version: corpus.version, embedded, reused: wanted.size - todo.length, removed };
    } catch (e) {
      this.lastError = messageOf(e);
      throw e;
    }
  }

  /** Build the index in the background, unless a build runs; a failure is kept for the next answers. */
  private buildSoon(): void {
    if (this.running) return;
    this.sync().catch(() => undefined);
  }

  /** Wait until no build runs (the engine waits for it before it stops). */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  /**
   * The sections of the docs closest in meaning to `query`, best first (cosine similarity of
   * their vectors). An index that does not cover the docs yet starts building and answers
   * `ready: false`, with no results.
   */
  async search(query: unknown, limit: unknown = DEFAULT_LIMIT): Promise<DocsSemanticAnswer> {
    if (typeof query !== "string" || query.trim() === "") throw new OperationInputError(`"query" is required: a few words of the topic`, SEARCH_INPUT);
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) throw new OperationInputError(`"limit" must be a whole number from 1 to ${MAX_LIMIT}`, SEARCH_INPUT);
    this.requireEnabled();
    const corpus = this.corpus();
    await this.load();
    const base = { query, version: corpus.version, sections: corpus.sections.length };
    if (this.version !== corpus.version) {
      this.buildSoon();
      const embedded = corpus.sections.filter((s) => this.vectors.get(s.path)?.hash === DocsSemanticIndex.embedded(s.text).hash).length;
      return { ...base, ready: false, embedded, results: [], ...(this.lastError ? { last_error: this.lastError } : {}) };
    }
    const [qv] = await embed(this.transport, this.config(), [query.trim()]);
    const q = normalize(qv!);
    const results = corpus.sections
      .flatMap((s) => {
        const v = this.vectors.get(s.path)?.v;
        return v ? [{ path: s.path, score: dot(q, v) }] : [];
      })
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.min(limit, MAX_LIMIT))
      .map((r) => ({ path: r.path, score: Math.round(r.score * 1000) / 1000 }));
    return { ...base, ready: true, embedded: corpus.sections.length, results };
  }
}
