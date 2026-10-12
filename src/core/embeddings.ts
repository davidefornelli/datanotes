/**
 * Embedding providers for semantic search. Two wire formats cover the common services:
 * - OpenAI-compatible `POST <base>/embeddings` (OpenAI, OpenRouter, LM Studio, Ollama's /v1,
 *   most self-hosted servers);
 * - Ollama's native `POST <base>/api/embed`.
 * The HTTP call goes through an injected transport (Obsidian's `requestUrl` in the plugin).
 */

export type ProviderKind = "ollama" | "openrouter" | "openai" | "lmstudio" | "custom";

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  style: "ollama" | "openai";
  needsKey: boolean;
  exampleModel: string;
  /** Runs on this machine: note content does not leave it. */
  local: boolean;
}

export const PROVIDER_PRESETS: Record<ProviderKind, ProviderPreset> = {
  ollama: { label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434", style: "ollama", needsKey: false, exampleModel: "nomic-embed-text", local: true },
  lmstudio: { label: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", style: "openai", needsKey: false, exampleModel: "text-embedding-nomic-embed-text-v1.5", local: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", style: "openai", needsKey: true, exampleModel: "openai/text-embedding-3-small", local: false },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", style: "openai", needsKey: true, exampleModel: "text-embedding-3-small", local: false },
  custom: { label: "Other (OpenAI-compatible)", baseUrl: "", style: "openai", needsKey: false, exampleModel: "", local: false },
};

export interface EmbeddingConfig {
  provider: ProviderKind;
  /** Empty: the preset's URL. */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}
export interface HttpResponse {
  status: number;
  text: string;
}
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";
}

export function resolvedBaseUrl(cfg: EmbeddingConfig): string {
  return (cfg.baseUrl.trim() || PROVIDER_PRESETS[cfg.provider].baseUrl).replace(/\/+$/, "");
}

/** Embed `texts` in one request; vectors come back in input order. */
export async function embed(transport: Transport, cfg: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const preset = PROVIDER_PRESETS[cfg.provider];
  const base = resolvedBaseUrl(cfg);
  if (!base) throw new EmbeddingError("set the embedding service URL");
  if (!cfg.model.trim()) throw new EmbeddingError("set the embedding model");
  if (preset.needsKey && !cfg.apiKey) throw new EmbeddingError(`${preset.label} needs an API key`);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === "openrouter") headers["X-Title"] = "Datanotes";
  const ollama = preset.style === "ollama";
  const res = await transport({
    url: ollama ? `${base}/api/embed` : `${base}/embeddings`,
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.model.trim(), input: texts }),
  });
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    json = undefined;
  }
  if (res.status < 200 || res.status >= 300) {
    const err = json as { error?: unknown } | undefined;
    const msg = typeof err?.error === "string" ? err.error : (err?.error as { message?: string } | undefined)?.message ?? res.text.slice(0, 200);
    throw new EmbeddingError(`embedding request failed (HTTP ${res.status}): ${msg}`);
  }
  const vectors = ollama
    ? (json as { embeddings?: number[][] })?.embeddings
    : (json as { data?: { embedding: number[]; index?: number }[] })?.data
        ?.slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding);
  if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every((v) => Array.isArray(v) && v.length > 0)) {
    throw new EmbeddingError("unexpected embedding response");
  }
  return vectors;
}

/** Unit-length copy (cosine similarity becomes a dot product). */
export function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  const s = n > 0 ? 1 / Math.sqrt(n) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * s;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
