/**
 * The engine's vector index of the docs (src/core/docs-semantic.ts), for the hybrid search of
 * search_docs: built in the background, kept in store:semantic/docs.json apart from the vault's
 * index, rebuilt when the docs' version changes (re-embedding only the sections whose text
 * changed), and when the provider or model changes. A deterministic fake embedder: no network.
 */

import { describe, expect, it } from "vitest";
import type { HttpRequest, Transport } from "../src/core/embeddings";
import { DOCS_EMBED_MAX_CHARS, DOCS_INDEX_FILE, DocsSemanticIndex, type DocsCorpus } from "../src/core/docs-semantic";
import { DocsError, DocsLibrary } from "../src/api/docs";
import type { DatanotesSettings } from "../src/core/settings";
import { createDbVault, LOG_YAML, METASTORE } from "./helpers/db-vault";
import { docsFixture } from "./helpers/docs-fixture";

/** Bag-of-words embedding over a small vocabulary: texts that share these words are close. */
const VOCAB = ["undo", "history", "time", "travel", "token", "view", "webhook", "column"];
const fakeVector = (text: string) => VOCAB.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01);

function fakeTransport() {
  const calls: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    const { input } = JSON.parse(req.body) as { input: string[] };
    return { status: 200, text: JSON.stringify({ embeddings: input.map(fakeVector) }) };
  };
  return { transport, inputs: () => calls.flatMap((c) => (JSON.parse(c.body) as { input: string[] }).input) };
}

const CORPUS: DocsCorpus = {
  version: "v1",
  sections: [
    { path: "guides/undo#undo-a-write", text: "Undo › Undo a write\n\nundo_migration takes a write back; the history keeps it." },
    { path: "guides/history#time-travel", text: "History › Time travel\n\nRead a table as it was: time travel through its history." },
    { path: "guides/tokens#create-a-token", text: "Tokens › Create a token\n\nA token for each program." },
    { path: "guides/views#store-a-view", text: "Views › Store a view\n\nA view stores a query." },
  ],
};

function setup(corpus: () => DocsCorpus = () => CORPUS) {
  const v = createDbVault({ [METASTORE]: LOG_YAML });
  Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "ollama", semanticModel: "fake" } satisfies Partial<DatanotesSettings>);
  const t = fakeTransport();
  const index = (transport: Transport = t.transport) => new DocsSemanticIndex(v.app, () => v.settings, transport, () => undefined, corpus);
  return { v, t, index };
}

describe("the vector index of the docs", () => {
  it("answers ready: false while it builds in the background, then ranks the sections by meaning", async () => {
    const { v, t, index } = setup();
    const idx = index();
    const first = await idx.search("time travel");
    expect(first).toEqual({ query: "time travel", version: "v1", ready: false, sections: 4, embedded: 0, results: [] });
    await idx.idle();
    expect(t.inputs()).toHaveLength(4);
    const r = await idx.search("time travel in the history", 2);
    expect(r).toMatchObject({ version: "v1", ready: true, sections: 4, embedded: 4 });
    expect(r.results.map((x) => x.path)).toEqual(["guides/history#time-travel", "guides/undo#undo-a-write"]);
    expect(r.results[0]!.score).toBeGreaterThan(r.results[1]!.score);
    // its own file in the store, apart from the vault's shards
    expect(DOCS_INDEX_FILE).toBe("store:semantic/docs.json");
    const stored = JSON.parse(v.read(DOCS_INDEX_FILE)) as { format: number; key: string; version: string; sections: Record<string, unknown> };
    expect(stored).toMatchObject({ format: 1, key: "ollama|http://127.0.0.1:11434|fake", version: "v1" });
    expect(Object.keys(stored.sections)).toEqual([...CORPUS.sections.map((s) => s.path)].sort());
    expect(v.listAll().filter((p) => p.startsWith("store:semantic/shard-"))).toEqual([]);
  });

  it("is read back by a new engine: nothing embedded again but the query", async () => {
    const { t, index } = setup();
    await index().sync();
    const again = fakeTransport();
    const idx = index(again.transport);
    expect(await idx.sync()).toEqual({ version: "v1", embedded: 0, reused: 4, removed: 0 });
    expect((await idx.search("a token")).results[0]!.path).toBe("guides/tokens#create-a-token");
    expect(again.inputs()).toEqual(["a token"]);
    expect(t.inputs()).toHaveLength(4);
  });

  it("is rebuilt when the docs' version changes: changed and new sections embedded, gone ones dropped", async () => {
    let corpus = CORPUS;
    const { v, t, index } = setup(() => corpus);
    const idx = index();
    await idx.sync();
    corpus = {
      version: "v2",
      sections: [
        CORPUS.sections[0]!,
        { path: "guides/history#time-travel", text: "History › Time travel\n\nA webhook, now." },
        CORPUS.sections[2]!,
        { path: "guides/columns#add-a-column", text: "Columns › Add a column" },
      ],
    };
    const before = t.inputs().length;
    const stale = await idx.search("webhook");
    expect(stale).toMatchObject({ version: "v2", ready: false, sections: 4, embedded: 2, results: [] });
    await idx.idle();
    expect(t.inputs().slice(before)).toEqual(["History › Time travel\n\nA webhook, now.", "Columns › Add a column"]);
    const r = await idx.search("webhook");
    expect(r).toMatchObject({ version: "v2", ready: true, embedded: 4 });
    expect(r.results[0]!.path).toBe("guides/history#time-travel");
    expect(r.results.map((x) => x.path)).not.toContain("guides/views#store-a-view");
    expect(Object.keys((JSON.parse(v.read(DOCS_INDEX_FILE)) as { sections: object }).sections)).not.toContain("guides/views#store-a-view");
    expect(await idx.sync()).toEqual({ version: "v2", embedded: 0, reused: 4, removed: 0 });
  });

  it("starts over for another model, and on rebuild; embeds only the start of a long section", async () => {
    const long: DocsCorpus = { version: "v1", sections: [...CORPUS.sections, { path: "reference/long", text: `Long › Page\n\n${"x".repeat(DOCS_EMBED_MAX_CHARS * 2)}` }] };
    const { v, t, index } = setup(() => long);
    const idx = index();
    expect(await idx.sync()).toEqual({ version: "v1", embedded: 5, reused: 0, removed: 0 });
    expect(Math.max(...t.inputs().map((s) => s.length))).toBe(DOCS_EMBED_MAX_CHARS);
    expect(await idx.sync({ rebuild: true })).toEqual({ version: "v1", embedded: 5, reused: 0, removed: 0 });
    v.settings.semanticModel = "other";
    expect(await idx.sync()).toMatchObject({ embedded: 5, reused: 0 });
    expect((JSON.parse(v.read(DOCS_INDEX_FILE)) as { key: string }).key).toBe("ollama|http://127.0.0.1:11434|other");
  });

  it("keeps what it embedded when the provider fails half-way, says why, and resumes there", async () => {
    const { v, index } = setup();
    v.settings.semanticBatchSize = 2;
    let n = 0;
    const flaky: Transport = async (req) => (++n === 2 ? { status: 503, text: JSON.stringify({ error: "model is loading" }) } : fakeTransport().transport(req));
    const idx = index(flaky);
    await expect(idx.sync()).rejects.toThrow(/HTTP 503/);
    const r = await idx.search("undo");
    expect(r).toEqual({ query: "undo", version: "v1", ready: false, sections: 4, embedded: 2, results: [], last_error: "embedding request failed (HTTP 503): model is loading" });
    await idx.idle();
    expect(await idx.search("undo")).toMatchObject({ ready: true, embedded: 4 });
    expect((await idx.search("undo")).last_error).toBeUndefined();
  });

  it("builds again from an unreadable file; a section missing from a hand-edited file is left out", async () => {
    const { v, index } = setup();
    v.write(DOCS_INDEX_FILE, "{not json");
    expect(await index().sync()).toMatchObject({ embedded: 4 });
    const stored = JSON.parse(v.read(DOCS_INDEX_FILE)) as { sections: Record<string, unknown> };
    delete stored.sections["guides/tokens#create-a-token"];
    v.write(DOCS_INDEX_FILE, JSON.stringify(stored));
    const r = await index().search("token");
    expect(r).toMatchObject({ ready: true });
    expect(r.results.map((x) => x.path)).not.toContain("guides/tokens#create-a-token");
  });

  it("one build at a time: a second waits for the first, searches meanwhile start none", async () => {
    const { t, index } = setup();
    const idx = index();
    const [a, b] = await Promise.all([idx.sync(), idx.sync()]);
    expect([a.embedded, b.embedded]).toEqual([4, 0]);
    expect(t.inputs()).toHaveLength(4);
    const fresh = setup();
    const other = fresh.index();
    await Promise.all([other.search("undo"), other.search("undo"), other.search("undo")]);
    await other.idle();
    expect(fresh.t.inputs()).toHaveLength(4);
  });

  it("refuses when semantic search is off, and bad arguments, saying how to fix them", async () => {
    const { v, index } = setup();
    const idx = index();
    await expect(idx.search("", 5)).rejects.toMatchObject({ message: '"query" is required: a few words of the topic', hint: expect.stringContaining('{"query": "time travel a view", "limit": 50}') as unknown, docs: "https://datanotes.dev/guides/agents/docs-offline.md#search-by-words-and-by-meaning" });
    await expect(idx.search(3)).rejects.toThrow(/"query" is required/);
    await expect(idx.search("undo", 0)).rejects.toMatchObject({ message: '"limit" must be a whole number from 1 to 100' });
    await expect(idx.search("undo", 1.5)).rejects.toThrow(/"limit"/);
    await expect(idx.search("undo", "5")).rejects.toThrow(/"limit"/);
    v.settings.semanticEnabled = false;
    await expect(idx.search("undo")).rejects.toMatchObject({
      message: "semantic search is off: set semanticEnabled, semanticProvider and semanticModel in the engine settings",
      hint: expect.stringContaining("search_docs ranks the docs by their words") as unknown,
      docs: "https://datanotes.dev/guides/search/semantic.md#turn-on-semantic-search",
    });
    await expect(idx.sync()).rejects.toThrow(/semantic search is off/);
  });

  it("indexes the sections of a docs folder, and says when there are none", async () => {
    const dir = docsFixture();
    const lib = new DocsLibrary(dir);
    const { index } = setup(() => ({ version: lib.version(), sections: lib.sections() }));
    const idx = index();
    expect(await idx.sync()).toMatchObject({ version: lib.version(), embedded: lib.sections().length });
    expect((await idx.search("named token permissions")).results.map((r) => r.path)).toContain("guides/tokens#choose-what-a-token-can-do");
    const none = new DocsLibrary(null);
    const { index: noDocs } = setup(() => ({ version: none.version(), sections: none.sections() }));
    await expect(noDocs().search("undo")).rejects.toBeInstanceOf(DocsError);
    await expect(noDocs().sync()).rejects.toBeInstanceOf(DocsError);
  });
});
