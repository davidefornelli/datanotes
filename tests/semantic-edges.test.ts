import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { dot, embed, EmbeddingError, normalize, type HttpRequest, type Transport } from "../src/core/embeddings";
import { dequantize, quantize, SemanticIndex, topHits } from "../src/core/semantic";
import type { DatanotesSettings } from "../src/core/settings";
import { createDbVault, LOG_YAML, METASTORE } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const VOCAB = ["desert", "sand", "spice", "dragon", "magic", "wizard", "dinner", "pizza", "friends", "garden", "tomato", "basil"];
const fakeVector = (text: string) => VOCAB.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01);

/** An OpenAI-compatible embedding service over the vocabulary above. */
function service(answer?: (req: HttpRequest, n: number) => { status: number; text: string } | undefined) {
  const calls: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    const special = answer?.(req, calls.length);
    if (special) return special;
    const { input } = JSON.parse(req.body) as { input: string[] };
    return { status: 200, text: JSON.stringify({ data: input.map((t, index) => ({ embedding: fakeVector(t), index })) }) };
  };
  return { transport, calls };
}

const custom = { provider: "custom" as const, baseUrl: "http://emb.test/v1/", model: " nomic " };

describe("embed: the embedding service", () => {
  it("sends nothing for no texts", async () => {
    const s = service();
    expect(await embed(s.transport, custom, [])).toEqual([]);
    expect(s.calls).toEqual([]);
  });

  it("refuses to call without a model, and sends the API key when there is one", async () => {
    const s = service();
    await expect(embed(s.transport, { ...custom, model: "  " }, ["x"])).rejects.toThrow(new EmbeddingError("set the embedding model"));
    await embed(s.transport, { ...custom, apiKey: "sk-local" }, ["x"]);
    expect(s.calls[0]).toMatchObject({ url: "http://emb.test/v1/embeddings", headers: { Authorization: "Bearer sk-local" } });
    expect(JSON.parse(s.calls[0]!.body)).toEqual({ model: "nomic", input: ["x"] });
  });

  it.each([
    [404, JSON.stringify({ error: { message: "model nomic not found" } }), "embedding request failed (HTTP 404): model nomic not found"],
    [400, JSON.stringify({ error: "input too long" }), "embedding request failed (HTTP 400): input too long"],
    [502, "<html>Bad Gateway</html>", "embedding request failed (HTTP 502): <html>Bad Gateway</html>"],
    [500, JSON.stringify({ detail: "overloaded" }), 'embedding request failed (HTTP 500): {"detail":"overloaded"}'],
  ])("an HTTP %i error says what the service said", async (status, text, message) => {
    const s = service(() => ({ status, text }));
    const err = await embed(s.transport, custom, ["x"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toBe(message);
  });

  it.each([
    ["not JSON", "OK"],
    ["no data", JSON.stringify({ object: "list" })],
    ["one vector for two texts", JSON.stringify({ data: [{ embedding: [1, 0], index: 0 }] })],
    ["an empty vector", JSON.stringify({ data: [{ embedding: [], index: 0 }, { embedding: [1], index: 1 }] })],
  ])("an answer with %s is refused", async (_what, text) => {
    const s = service(() => ({ status: 200, text }));
    await expect(embed(s.transport, custom, ["a", "b"])).rejects.toThrow(new EmbeddingError("unexpected embedding response"));
  });

  it("keeps the service's order when the vectors carry no index", async () => {
    const s = service(() => ({ status: 200, text: JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }) }));
    expect(await embed(s.transport, custom, ["a", "b"])).toEqual([[1, 0], [0, 1]]);
  });

  it("normalize leaves a zero vector at zero, and quantize keeps it", () => {
    expect([...normalize([0, 0, 0])]).toEqual([0, 0, 0]);
    expect(quantize(new Float32Array(3))).toEqual({ q: "AAAA", k: 1 });
  });
});

function vault(extra: Record<string, string> = {}) {
  const v = createDbVault({
    [METASTORE]: LOG_YAML,
    "Books/Dune.md": "---\ntitle: Dune\n---\n# Plot\nA desert planet, sand everywhere.\n# Food\nSpice in every dinner.\n",
    "Garden/Plan.md": "# Garden\nTomato and basil along the fence.\n",
    ...extra,
  });
  Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake" } satisfies Partial<DatanotesSettings>);
  return v;
}

describe("SemanticIndex: keeping the index", () => {
  it("re-embeds the notes of a shard that cannot be read", async () => {
    const v = vault();
    await new SemanticIndex(v.app, () => v.settings, service().transport).sync();
    const shards = v.listAll().filter((p) => p.startsWith("store:semantic/"));
    expect(shards.length).toBeGreaterThan(0);
    for (const p of shards) v.write(p, "{ truncated");
    const again = new SemanticIndex(v.app, () => v.settings, service().transport);
    expect(await again.sync()).toMatchObject({ embedded: 2, unchanged: 0 });
  });

  it("drops a note deleted between two full syncs, and notes that leave the scope", async () => {
    const v = vault({ "Books/Earthsea.md": "A wizard and a dragon.\n" });
    const idx = new SemanticIndex(v.app, () => v.settings, service().transport);
    expect((await idx.sync()).embedded).toBe(3);
    v.remove("Garden/Plan.md");
    expect(await idx.sync()).toMatchObject({ embedded: 0, removed: 1, unchanged: 2 });
    v.settings.semanticExclude = ["Books/"];
    expect(await idx.sync()).toMatchObject({ removed: 2 });
    expect(idx.status()).toMatchObject({ files: 0, passages: 0 });
  });

  it("a note that becomes a row (its table is created) is filed under the table without embedding it again", async () => {
    const v = vault({ "Moods/Calm.md": "---\ntable: main.public.mood\n---\nA calm dinner with friends.\n" });
    const s = service();
    const idx = new SemanticIndex(v.app, () => v.settings, s.transport);
    await idx.sync();
    expect((await idx.search({ query: "dinner with friends", tables: ["mood"] })).results).toEqual([]);
    const sent = s.calls.length;
    const created = await createTable(v.app, v.settings, described({ schema: "public", name: "mood", options: { filename: "{note}" }, columns: [{ name: "note", type: "string" }] }));
    expect(await idx.sync()).toMatchObject({ embedded: 0, unchanged: 3 });
    expect(s.calls.length).toBe(sent);
    const hits = (await idx.search({ query: "dinner with friends", tables: ["mood"] })).results;
    expect(hits.map((h) => [h.path, h.table])).toEqual([["Moods/Calm.md", "main.public.mood"]]);
    // a new instance reads the table back from the shard
    const again = new SemanticIndex(v.app, () => v.settings, service().transport);
    expect((await again.search({ query: "dinner with friends", tables: ["mood"] })).results.map((h) => h.path)).toEqual(["Moods/Calm.md"]);
    // the table is undone: the note is a plain note again, still not embedded again
    expect((await undoOperation(v.app, v.settings, created.migration_id!)).ok).toBe(true);
    expect(await again.sync()).toMatchObject({ embedded: 0, unchanged: 3 });
    expect((await again.search({ query: "dinner with friends", tables: ["mood"] })).results).toEqual([]);
    const top = (await again.search({ query: "dinner with friends" })).results[0]!;
    expect([top.path, top.table]).toEqual(["Moods/Calm.md", undefined]);
  });

  it("a second sync waits for the first, and progress is reported note by note", async () => {
    const v = vault();
    const idx = new SemanticIndex(v.app, () => v.settings, service().transport);
    const progress: [number, number][] = [];
    const [a, b] = await Promise.all([idx.sync({ onProgress: (d, t) => progress.push([d, t]) }), idx.sync()]);
    expect(a.embedded).toBe(2);
    expect(b).toMatchObject({ embedded: 0, unchanged: 2 });
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(idx.status().running).toBe(false);
  });
});

describe("SemanticIndex: failures", () => {
  it("a service error on one batch skips its notes, keeps the others and remembers the error", async () => {
    const v = vault();
    v.settings.semanticBatchSize = 1;
    // the failing batch is the only passage of its note
    const s = service((req) => (req.body.includes("Tomato") ? { status: 503, text: JSON.stringify({ error: "warming up" }) } : undefined));
    const idx = new SemanticIndex(v.app, () => v.settings, s.transport);
    const r = await idx.sync();
    expect(r.failed).toEqual([{ path: "Garden/Plan.md", error: "embedding request failed (HTTP 503): warming up" }]);
    expect(r.embedded).toBe(1);
    expect(idx.status()).toMatchObject({ files: 1, last_error: "embedding request failed (HTTP 503): warming up" });
  });

  it("a transport that cannot reach the service stops the sync", async () => {
    const v = vault();
    const idx = new SemanticIndex(v.app, () => v.settings, async () => Promise.reject(new TypeError("fetch failed")));
    await expect(idx.sync()).rejects.toThrow("fetch failed");
    expect(idx.status()).toMatchObject({ files: 0, last_error: "fetch failed" });
  });

  it("sends the API key from secret storage", async () => {
    const v = vault();
    const s = service();
    await new SemanticIndex(v.app, () => v.settings, s.transport, () => "sk-from-keychain").sync();
    expect(s.calls[0]!.headers.Authorization).toBe("Bearer sk-from-keychain");
  });
});

describe("SemanticIndex.search", () => {
  it("needs a query", async () => {
    const v = vault();
    const idx = new SemanticIndex(v.app, () => v.settings, service().transport);
    await expect(idx.search({ query: "  " })).rejects.toThrow('"query" is required');
  });

  it("scores a note by its best passage", async () => {
    const v = vault();
    const idx = new SemanticIndex(v.app, () => v.settings, service().transport);
    await idx.sync();
    const [hit] = (await idx.search({ query: "spice dinner", limit: 1 })).results;
    expect(hit).toMatchObject({ path: "Books/Dune.md", heading: "Food" });
    const [plot] = (await idx.search({ query: "desert sand", limit: 1 })).results;
    expect(plot).toMatchObject({ path: "Books/Dune.md", heading: "Plot" });
  });

  /** The search as it was: every passage dequantized to floats, a dot product, a stable sort. */
  async function floatSearch(v: ReturnType<typeof vault>, query: string, limit: number, minScore?: number) {
    const q = normalize(fakeVector(query));
    const best = new Map<string, { path: string; score: number; heading: string }>();
    const shards = v.listAll().filter((p) => p.startsWith("store:semantic/")).sort();
    const files: [string, { passages: { h: string; q: string; k: number }[] }][] = [];
    for (const shard of shards) files.push(...Object.entries((JSON.parse(v.read(shard)) as { files: Record<string, { passages: { h: string; q: string; k: number }[] }> }).files));
    for (const [path, f] of files) {
      for (const p of f.passages) {
        const score = dot(q, dequantize(p.q, p.k));
        if (minScore !== undefined && score < minScore) continue;
        const prev = best.get(path);
        if (!prev || score > prev.score) best.set(path, { path, score, heading: p.h });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 }));
  }

  it("scores with the int8 vectors exactly as with the floats a load gave, before and after a restart; ties keep the notes' order", async () => {
    const v = vault();
    // notes with the same text score the same: they keep the order the index has them in
    for (const n of ["p", "q", "r", "s", "t"]) v.write(`Twins/${n}.md`, "Basil and tomato in the garden.\n");
    const idx = new SemanticIndex(v.app, () => v.settings, service().transport);
    await idx.sync();
    const again = new SemanticIndex(v.app, () => v.settings, service().transport);
    for (const [query, limit, minScore] of [["garden tomato", 3, undefined], ["spice dinner", 10, undefined], ["desert", 2, 0.2], ["basil", 100, undefined]] as const) {
      const want = await floatSearch(v, query, limit, minScore);
      const fresh = (await idx.search({ query, limit, ...(minScore !== undefined ? { minScore } : {}) })).results.map((h) => ({ path: h.path, score: h.score, heading: h.heading }));
      const loaded = (await again.search({ query, limit, ...(minScore !== undefined ? { minScore } : {}) })).results.map((h) => ({ path: h.path, score: h.score, heading: h.heading }));
      expect(loaded, query).toEqual(want.map((h) => ({ path: h.path, score: h.score, heading: h.heading })));
      // the order of equal scores is the order of the index, which a new instance reads shard by shard
      expect(fresh.map((h) => h.score), query).toEqual(loaded.map((h) => h.score));
    }
    // the shards keep the same bytes and scales when written again
    const kept = () =>
      Object.fromEntries(
        v
          .listAll()
          .filter((p) => p.startsWith("store:semantic/"))
          .flatMap((p) => Object.entries((JSON.parse(v.read(p)) as { files: Record<string, unknown> }).files))
          .filter(([p]) => p !== "Books/Earthsea.md"),
      );
    const before = kept();
    v.write("Books/Earthsea.md", "# Earthsea\nA wizard and a dragon.\n");
    again.touch("Books/Earthsea.md");
    await again.sync({ onlyPending: true });
    expect(kept()).toEqual(before);
    expect(Object.keys(before).length).toBeGreaterThan(5);
  });

  it("decides a minScore at a passage's very score as the floats did", async () => {
    const v = vault();
    const idx = new SemanticIndex(v.app, () => v.settings, service().transport);
    await idx.sync();
    // the exact float score of Dune's best passage for this query
    const q = normalize(fakeVector("desert"));
    const shard = v.listAll().filter((p) => p.startsWith("store:semantic/")).map((p) => JSON.parse(v.read(p)) as { files: Record<string, { passages: { q: string; k: number }[] }> }).find((x) => x.files["Books/Dune.md"])!;
    const exact = Math.max(...shard.files["Books/Dune.md"]!.passages.map((p) => dot(q, dequantize(p.q, p.k))));
    const paths = async (minScore: number) => (await idx.search({ query: "desert", minScore, limit: 100 })).results.map((h) => h.path);
    expect(await paths(exact)).toContain("Books/Dune.md");
    expect(await paths(exact + 1e-12)).not.toContain("Books/Dune.md");
  });

  it("picks the best hits as a stable sort by score does, whatever their order", () => {
    let seed = 5;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 200; t++) {
      const hits = Array.from({ length: Math.floor(next() * 30) }, (_, id) => ({ id, score: Math.floor(next() * 6) / 5 }));
      const limit = 1 + Math.floor(next() * 12);
      expect(topHits(hits, limit), JSON.stringify({ hits, limit })).toEqual([...hits].sort((a, b) => b.score - a.score).slice(0, limit));
    }
  });

  it("a passage whose vector is all zeros scores 0, as its floats did", async () => {
    const v = vault({ "Notes/empty.md": "nothing at all\n" });
    const zero = service((req) => {
      const { input } = JSON.parse(req.body) as { input: string[] };
      return { status: 200, text: JSON.stringify({ data: input.map((t, index) => ({ embedding: t.includes("nothing") ? VOCAB.map(() => 0) : fakeVector(t), index })) }) };
    });
    const idx = new SemanticIndex(v.app, () => v.settings, zero.transport);
    await idx.sync();
    const hit = (await idx.search({ query: "spice", limit: 100 })).results.find((h) => h.path === "Notes/empty.md");
    expect(hit?.score).toBe(0);
    const again = new SemanticIndex(v.app, () => v.settings, zero.transport);
    expect((await again.search({ query: "spice", limit: 100 })).results.find((h) => h.path === "Notes/empty.md")?.score).toBe(0);
  });

  it("asks the service once for a query asked again, per vector space, keeping the latest 64", async () => {
    const v = vault();
    const s = service();
    const idx = new SemanticIndex(v.app, () => v.settings, s.transport);
    await idx.sync();
    const asked = () => s.calls.filter((c) => (JSON.parse(c.body) as { input: string[] }).input.length === 1).length;
    const first = await idx.search({ query: "spice", limit: 1 });
    const n = asked();
    expect(await idx.search({ query: " spice ", limit: 1 })).toEqual({ query: " spice ", results: first.results });
    expect(asked()).toBe(n);
    for (let i = 0; i < 64; i++) await idx.search({ query: `query ${i}`, limit: 1 });
    expect(asked()).toBe(n + 64);
    await idx.search({ query: "spice", limit: 1 });
    expect(asked()).toBe(n + 65);
    await idx.search({ query: "query 63", limit: 1 });
    expect(asked()).toBe(n + 65);
    // another model: its own vectors
    v.settings.semanticModel = "other";
    await idx.search({ query: "query 63", limit: 1 });
    expect(asked()).toBe(n + 66);
  });
});
