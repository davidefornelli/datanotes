import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { embed, EmbeddingError, normalize, type HttpRequest, type Transport } from "../src/core/embeddings";
import { quantize, SemanticIndex } from "../src/core/semantic";
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
});
