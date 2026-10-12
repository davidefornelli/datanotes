/**
 * Hybrid search_docs end to end: the engine runtime (src/server/runtime.ts) on a vault on disk
 * indexes the docs (helpers/docs-fixture.ts) with a deterministic fake embedder after its first
 * scan, answers `POST /datanotes/manual/search/`, and the MCP server's search_docs
 * (src/mcp/tools.ts) fuses that ranking with its own. Without semantic search, with no docs, or
 * with no engine, search_docs ranks by words alone.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatanotesClient } from "../src/api/client";
import { DocsLibrary } from "../src/api/docs";
import { callDocsTool } from "../src/api/mcp";
import type { Transport } from "../src/core/embeddings";
import { mergeWithDefaults, type DatanotesSettings } from "../src/core/settings";
import { NOOP_TELEMETRY, setTelemetry, type AttrValue } from "../src/core/telemetry";
import { openNodeVault, type NodeHost } from "../src/node/node-app";
import { EngineRuntime } from "../src/server/runtime";
import { Toolbox } from "../src/mcp/tools";
import { LOG_YAML, METASTORE, TEST_DATABASE_FOLDER } from "./helpers/db-vault";
import { docsFixture } from "./helpers/docs-fixture";
import { guided } from "./helpers/guidance";
import { freePort } from "./helpers/test-vault";

let logs: { severity: string; body: string; attributes?: Record<string, AttrValue> }[] = [];
beforeEach(() => {
  logs = [];
  setTelemetry({ log: (severity, body, attributes) => void logs.push({ severity, body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
});
const logged = (body: string) => logs.filter((l) => l.body === body);

/** Wait (up to 5 s) until a record with this body is logged. */
async function until(body: string): Promise<void> {
  for (let i = 0; i < 250 && logged(body).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  expect(logged(body).length).toBeGreaterThan(0);
}

/** An Ollama-style embedder: a bag of words hashed into 64 dimensions, so texts that share words are close. */
function embedder(status = 200): { transport: Transport; texts: string[] } {
  const texts: string[] = [];
  const vector = (text: string) => {
    const v = new Array<number>(64).fill(0.01);
    for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
      v[(h >>> 0) % 64]! += 1;
    }
    return v;
  };
  return {
    texts,
    transport: async (req) => {
      const input = (JSON.parse(req.body) as { input: string[] }).input;
      texts.push(...input);
      if (status !== 200) return { status, text: JSON.stringify({ error: "unauthorized" }) };
      return { status: 200, text: JSON.stringify({ embeddings: input.map(vector) }) };
    },
  };
}

const SEMANTIC: Partial<DatanotesSettings> = { semanticEnabled: true, semanticProvider: "ollama", semanticModel: "fake-embed" };

interface Engine {
  runtime: EngineRuntime;
  host: NodeHost;
  url: string;
  token: string;
  docs: DocsLibrary;
}

const open: { runtime: EngineRuntime; host: NodeHost; dirs: string[] }[] = [];
afterEach(async () => {
  for (const e of open.splice(0)) {
    await e.runtime.stop();
    e.host.metadataCache.dispose();
    for (const d of e.dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  setTelemetry(NOOP_TELEMETRY);
});

/** A started engine serving HTTP on a vault with the log table, the fixture docs, and these settings. */
async function engine(settings: Partial<DatanotesSettings>, transport: Transport, docs: DocsLibrary = new DocsLibrary(docsFixture())): Promise<Engine> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-hybrid-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "docs-hybrid-store-"));
  fs.mkdirSync(path.dirname(path.join(root, METASTORE)), { recursive: true });
  fs.writeFileSync(path.join(root, METASTORE), LOG_YAML);
  fs.writeFileSync(path.join(root, "Welcome.md"), "# Welcome\n\nA note of the vault.\n");
  const host = openNodeVault(root, undefined, { store });
  const s = mergeWithDefaults({ fileLogEnabled: false, autoRecompute: false, databaseFolder: TEST_DATABASE_FOLDER, httpServerToken: "owner-token", ...settings });
  s.httpServerPort = 0;
  const runtime = new EngineRuntime({ app: host.app, getSettings: () => s, saveSettings: async () => {}, transport, embeddingKey: () => undefined, version: "3.0.0-test", hostName: "service", canServeHttp: true, httpHost: "127.0.0.1", docs });
  open.push({ runtime, host, dirs: [root, store, ...(docs.dir ? [docs.dir] : [])] });
  await runtime.start();
  return { runtime, host, url: `http://127.0.0.1:${runtime.httpPort}`, token: "owner-token", docs };
}

const textOf = (r: { content: { text: string }[] }) => r.content[0]!.text;
const AGENT = { harness: "test-agent", session: "s-1" };

describe("hybrid search_docs on a running engine", () => {
  it("the engine indexes the docs after its first scan; search_docs then fuses both rankings", async () => {
    const fake = embedder();
    const e = await engine(SEMANTIC, fake.transport);
    e.runtime.syncSemanticSoon(5, true);
    await until("datanotes docs index updated");
    const sections = e.docs.sections().length;
    expect(logged("datanotes docs index updated")[0]!.attributes).toEqual({ version: e.docs.version(), embedded: sections, reused: 0, removed: 0 });
    const client = new DatanotesClient({ url: e.url, token: e.token });
    const answer = await client.post<{ ready: boolean; version: string; sections: number; results: { path: string }[] }>("/manual/search/", { query: "named token permissions", limit: 3 });
    expect(answer).toMatchObject({ query: "named token permissions", ready: true, version: e.docs.version(), sections, embedded: sections });
    expect(answer.results).toHaveLength(3);
    expect(answer.results[0]!.path).toBe("guides/tokens#choose-what-a-token-can-do");

    const toolbox = new Toolbox(e.url, undefined, e.docs);
    const out = textOf(await toolbox.call(e.token, "search_docs", { query: "named token permissions", limit: 3 }, AGENT));
    expect(out.split("\n")[0]).toBe("guides/tokens#choose-what-a-token-can-do — Give each program its own token › Choose what a token can do (keyword, semantic)");
    expect(out.split("\n").at(-1)).toBe('Ranked by words and by meaning (hybrid search). Read one with read_docs("<path>").');
    // the same docs, by words alone: the same first section, without the signals
    expect(textOf(await callDocsTool("search_docs", { query: "named token permissions", limit: 3 }, { docs: e.docs })).split("\n")[0]).toBe(
      "guides/tokens#choose-what-a-token-can-do — Give each program its own token › Choose what a token can do",
    );
  });

  it("a search before the index is built starts it and ranks by words meanwhile", async () => {
    const fake = embedder();
    const e = await engine(SEMANTIC, fake.transport);
    const toolbox = new Toolbox(e.url, undefined, e.docs);
    const byWords = textOf(await callDocsTool("search_docs", { query: "compare values" }, { docs: e.docs }));
    expect(textOf(await toolbox.call(e.token, "search_docs", { query: "compare values" }, AGENT))).toBe(byWords);
    await e.runtime.docsIndex.idle();
    expect(textOf(await toolbox.call(e.token, "search_docs", { query: "compare values" }, AGENT))).toMatch(/\(keyword, semantic\)\n/);
  });

  it("without semantic search on the engine, search_docs ranks by words alone, and the route says how to turn it on", async () => {
    const fake = embedder();
    const e = await engine({}, fake.transport);
    const client = new DatanotesClient({ url: e.url, token: e.token });
    const r = await client.request("POST", "/datanotes/manual/search/", { query: "token" });
    expect(r).toMatchObject({ status: 400, json: guided("semantic search is off: set semanticEnabled, semanticProvider and semanticModel in the engine settings") });
    expect((r.json as { docs: string }).docs).toBe("https://datanotes.dev/guides/search/semantic.md#turn-on-semantic-search");
    const toolbox = new Toolbox(e.url, undefined, e.docs);
    const byWords = textOf(await callDocsTool("search_docs", { query: "named token" }, { docs: e.docs }));
    expect(textOf(await toolbox.call(e.token, "search_docs", { query: "named token" }, AGENT))).toBe(byWords);
    expect(fake.texts).toEqual([]);
  });

  it("with no engine answering, search_docs ranks by words alone", async () => {
    const dir = docsFixture();
    const docs = new DocsLibrary(dir);
    try {
      const toolbox = new Toolbox(`http://127.0.0.1:${await freePort()}`, undefined, docs);
      const byWords = textOf(await callDocsTool("search_docs", { query: "named token" }, { docs }));
      expect(textOf(await toolbox.call("a-token", "search_docs", { query: "named token" }, AGENT))).toBe(byWords);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an engine without the docs answers 503 with how to get them, and its first scan leaves them alone", async () => {
    const fake = embedder();
    const e = await engine(SEMANTIC, fake.transport, new DocsLibrary(null));
    e.runtime.syncSemanticSoon(5, true);
    await until("datanotes semantic index updated");
    await e.runtime.docsIndex.idle();
    const client = new DatanotesClient({ url: e.url, token: e.token });
    const r = await client.request("POST", "/datanotes/manual/search/", { query: "token" });
    // the 503 is the engine's own answer, not an unreachable engine: the client passes it on
    expect(r.status).toBe(503);
    expect(r.json).toEqual(guided("the Datanotes docs are not in this installation"));
    const raw = await fetch(`${e.url}/datanotes/manual/search/`, { method: "POST", headers: { Authorization: `Bearer ${e.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: "token" }) });
    expect(raw.status).toBe(503);
    expect(await raw.json()).toEqual(guided("the Datanotes docs are not in this installation"));
    expect(logged("datanotes docs index update failed")).toEqual([]);
  });

  it("a failed build of the docs index is logged, and the next searches say why", async () => {
    const e = await engine(SEMANTIC, embedder(401).transport);
    e.runtime.syncSemanticSoon(5, true);
    await until("datanotes docs index update failed");
    expect(logged("datanotes docs index update failed")[0]).toEqual({ severity: "WARN", body: "datanotes docs index update failed", attributes: { error: "embedding request failed (HTTP 401): unauthorized" } });
    const client = new DatanotesClient({ url: e.url, token: e.token });
    const answer = await client.post<{ ready: boolean; last_error?: string }>("/manual/search/", { query: "token" });
    expect(answer).toMatchObject({ ready: false, last_error: "embedding request failed (HTTP 401): unauthorized" });
  });
});
