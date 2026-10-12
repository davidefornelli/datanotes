import { describe, expect, it } from "vitest";
import { chunkNote } from "../src/core/chunk";
import { embed, EmbeddingError, type HttpRequest, type Transport } from "../src/core/embeddings";
import { dequantize, quantize, SemanticIndex } from "../src/core/semantic";
import { normalize } from "../src/core/embeddings";
import { createDbVault, LOG_YAML, METASTORE } from "./helpers/db-vault";
import type { DatanotesSettings } from "../src/core/settings";

/** Bag-of-words embedding over a small vocabulary: similar words → similar vectors. */
const VOCAB = ["desert", "sand", "spice", "dragon", "magic", "wizard", "dinner", "pizza", "friends", "move", "house", "boxes"];
function fakeVector(text: string): number[] {
  const t = text.toLowerCase();
  return VOCAB.map((w) => (t.includes(w) ? 1 : 0) + 0.01);
}

function fakeTransport(style: "openai" | "ollama" = "openai") {
  const calls: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    const { input } = JSON.parse(req.body) as { input: string[] };
    const vectors = input.map(fakeVector);
    const json = style === "ollama" ? { embeddings: vectors } : { data: vectors.map((embedding, index) => ({ embedding, index })).reverse() };
    return { status: 200, text: JSON.stringify(json) };
  };
  return { transport, calls, inputs: () => calls.flatMap((c) => (JSON.parse(c.body) as { input: string[] }).input) };
}

function vault() {
  const v = createDbVault({
    [METASTORE]: LOG_YAML,
    "Books/Dune.md": "---\ntitle: Dune\n---\n# Plot\nA desert planet, sand everywhere and the spice.\n",
    "Books/Earthsea.md": "# Earthsea\nA wizard school and a dragon. Magic has a price.\n",
    "Daily/a.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: mood\noccurred_at: 2026-09-25T22:30\n---\nDinner with friends, pizza and talk about the move to a new house.\n",
    "Archive/_archive/old.md": "desert sand spice",
  });
  Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake" } satisfies Partial<DatanotesSettings>);
  return v;
}

describe("embeddings", () => {
  it("speaks the OpenAI-compatible and the Ollama formats", async () => {
    const o = fakeTransport("openai");
    const v = await embed(o.transport, { provider: "openrouter", baseUrl: "", model: "m", apiKey: "k" }, ["desert", "pizza"]);
    expect(o.calls[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(o.calls[0]!.headers.Authorization).toBe("Bearer k");
    expect(v[0]).toEqual(fakeVector("desert")); // index order restored
    const l = fakeTransport("ollama");
    await embed(l.transport, { provider: "ollama", baseUrl: "", model: "nomic-embed-text" }, ["x"]);
    expect(l.calls[0]!.url).toBe("http://127.0.0.1:11434/api/embed");
    expect(l.calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("reports configuration and HTTP errors", async () => {
    const t = fakeTransport();
    await expect(embed(t.transport, { provider: "openai", baseUrl: "", model: "m" }, ["x"])).rejects.toThrow(/needs an API key/);
    await expect(embed(t.transport, { provider: "custom", baseUrl: "", model: "m" }, ["x"])).rejects.toThrow(/URL/);
    const denied: Transport = async () => ({ status: 401, text: JSON.stringify({ error: { message: "bad key" } }) });
    await expect(embed(denied, { provider: "custom", baseUrl: "http://x", model: "m" }, ["x"])).rejects.toThrow(/HTTP 401\): bad key/);
    await expect(embed(denied, { provider: "custom", baseUrl: "http://x", model: "m" }, ["x"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it("quantizes vectors with little loss", () => {
    const v = normalize([0.1, -0.5, 0.3, 0.9, -0.2]);
    const back = dequantize(quantize(v).q, quantize(v).k);
    v.forEach((x, i) => expect(back[i]!).toBeCloseTo(x, 1));
  });
});

describe("chunkNote", () => {
  it("puts title and frontmatter in the first passage and splits by heading", () => {
    const c = chunkNote("Books/Dune.md", "---\ntitle: Dune\nid: 123\n---\nIntro.\n# Plot\nDesert.\n## Ending\nSpice.\n", { skipKeys: ["id"] });
    expect(c.map((x) => x.heading)).toEqual(["", "Plot", "Plot › Ending"]);
    expect(c[0]!.text).toContain("Dune\ntitle: Dune");
    expect(c[0]!.text).not.toContain("id: 123");
    expect(c[2]!.text.startsWith("Dune › Plot › Ending")).toBe(true);
    expect(chunkNote("x.md", "---\na: 1\n---\n")).toEqual([{ heading: "", text: "x\na: 1", snippet: "a: 1" }]);
    expect(chunkNote("x.md", "p".repeat(3000), { maxChars: 1000 })).toHaveLength(3);
  });
});

describe("SemanticIndex", () => {
  it("indexes the vault, searches by meaning, filters by table and folder", async () => {
    const v = vault();
    const t = fakeTransport();
    const idx = new SemanticIndex(v.app, () => v.settings, t.transport);
    const r = await idx.sync();
    expect(r).toMatchObject({ embedded: 3, removed: 0, failed: [] }); // the archived note is left out
    const hits = await idx.search({ query: "sand dunes in the desert" });
    expect(hits.results[0]).toMatchObject({ path: "Books/Dune.md", heading: "Plot" });
    expect((await idx.search({ query: "pizza with friends", limit: 1 })).results).toMatchObject([{ path: "Daily/a.md", table: "main.public.log" }]);
    expect((await idx.search({ query: "desert", tables: ["log"] })).results.map((h) => h.path)).toEqual(["Daily/a.md"]);
    expect((await idx.search({ query: "desert", folder: "Books", minScore: 0.5 })).results.map((h) => h.path)).toEqual(["Books/Dune.md"]);
    expect(idx.status()).toMatchObject({ enabled: true, files: 3, pending: 0 });
  });

  it("re-embeds only changed notes, drops deleted ones and persists across instances", async () => {
    const v = vault();
    const t = fakeTransport();
    const idx = new SemanticIndex(v.app, () => v.settings, t.transport);
    await idx.sync();
    const before = t.inputs().length;
    v.write("Books/Earthsea.md", "# Earthsea\nNow about moving house with boxes.\n");
    idx.touch("Books/Earthsea.md");
    await (v.app.vault as unknown as { trash: (f: { path: string }) => Promise<void> }).trash(v.file("Daily/a.md"));
    idx.forget("Daily/a.md");
    const r = await idx.sync({ onlyPending: true });
    expect(r).toMatchObject({ embedded: 1, removed: 1 });
    expect(t.inputs().length - before).toBe(1);
    expect((await idx.search({ query: "boxes for the move", limit: 1 })).results[0]!.path).toBe("Books/Earthsea.md");

    // A new instance reads the shards: nothing is embedded again, only the query.
    const t2 = fakeTransport();
    const again = new SemanticIndex(v.app, () => v.settings, t2.transport);
    expect((await again.sync()).embedded).toBe(0);
    expect((await again.search({ query: "spice" })).results[0]!.path).toBe("Books/Dune.md");
    expect(t2.inputs()).toEqual(["spice"]);
    expect(v.listAll().filter((p) => p.startsWith("store:semantic/")).length).toBeGreaterThan(0);

    // Another model: vectors are not comparable, the index starts over.
    v.settings.semanticModel = "other";
    const t3 = fakeTransport();
    expect((await new SemanticIndex(v.app, () => v.settings, t3.transport).sync()).embedded).toBe(2);
  });

  it("scope, exclusions, rebuild and the off switch", async () => {
    const v = vault();
    const t = fakeTransport();
    const idx = new SemanticIndex(v.app, () => v.settings, t.transport);
    v.settings.semanticScope = "tables";
    expect((await idx.sync()).embedded).toBe(1);
    v.settings.semanticScope = "vault";
    v.settings.semanticExclude = ["Books"];
    expect(await idx.sync()).toMatchObject({ embedded: 0, unchanged: 1 });
    expect((await idx.sync({ rebuild: true })).embedded).toBe(1);
    v.settings.semanticEnabled = false;
    await expect(idx.search({ query: "x" })).rejects.toThrow(/semantic search is off/);
  });

  it("stops on a configuration error and keeps what was indexed", async () => {
    const v = vault();
    let n = 0;
    const flaky: Transport = async (req) => (++n > 1 ? { status: 401, text: "{}" } : fakeTransport().transport(req));
    v.settings.semanticBatchSize = 1;
    const idx = new SemanticIndex(v.app, () => v.settings, flaky);
    await expect(idx.sync()).rejects.toThrow(/HTTP 401/);
    expect(idx.status()).toMatchObject({ files: 1 });
    expect(idx.status().last_error).toMatch(/401/);
  });
});
