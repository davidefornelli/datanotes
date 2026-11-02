/**
 * A semanticBaseUrl with credentials (Node's fetch refuses it and repeats it in its error): the
 * credentials reach no error, last_error, answer, log line or store file but settings.json. No
 * network: fetch refuses such an address before it connects.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { embed, EmbeddingError, type Transport } from "../src/core/embeddings";
import { SemanticIndex, vectorSpaceKey } from "../src/core/semantic";
import { DOCS_INDEX_FILE, DocsSemanticIndex, type DocsCorpus } from "../src/core/docs-semantic";
import type { DatanotesSettings } from "../src/core/settings";
import { startService, type RunningService } from "../src/node/service";
import { createDbVault, LOG_YAML, METASTORE, withTables } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";
import { filesWith } from "./helpers/store-grep";

const S = "SENTINEL-SEM";

/** The transport of the service (src/node/service.ts, startOn): Node's fetch. */
const nodeFetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  return { status: res.status, text: await res.text() };
};

/** A vault with notes to embed (as tests/semantic.test.ts). */
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

const CORPUS: DocsCorpus = {
  version: "v1",
  sections: [
    { path: "guides/undo#undo-a-write", text: "Undo › Undo a write\n\nundo_migration takes a write back; the history keeps it." },
    { path: "guides/history#time-travel", text: "History › Time travel\n\nRead a table as it was: time travel through its history." },
    { path: "guides/tokens#create-a-token", text: "Tokens › Create a token\n\nA token for each program." },
    { path: "guides/views#store-a-view", text: "Views › Store a view\n\nA view stores a query." },
  ],
};

describe("the embedding request", () => {
  it("an address with credentials fails without them, and the error keeps its class", async () => {
    const e1 = (await embed(nodeFetchTransport, { provider: "custom", baseUrl: `https://u:${S}@127.0.0.1:9/v1`, model: "m" }, ["x"]).catch((e: unknown) => e)) as Error;
    expect(e1).toBeInstanceOf(TypeError);
    expect(e1.message).toContain("https://127.0.0.1:9/v1/embeddings");
    expect(e1.message).not.toContain(S);
    expect(String(e1.stack)).not.toContain(S);
    const e2 = (await embed(nodeFetchTransport, { provider: "custom", baseUrl: `https://u:${S}@emb.example.com:431800/v1`, model: "m" }, ["x"]).catch((e: unknown) => e)) as Error;
    expect(e2).toBeInstanceOf(TypeError);
    expect(e2.message).toContain("Failed to parse URL from https://emb.example.com:431800/v1/embeddings");
    expect(e2.message).not.toContain(S);
  });

  it("a transport that throws a string, and an error answer that repeats the address", async () => {
    const throwing: Transport = async () => {
      throw `down: https://u:${S}@h/v1`;
    };
    await expect(embed(throwing, { provider: "custom", baseUrl: "http://h/v1", model: "m" }, ["x"])).rejects.toBe("down: https://h/v1");
    const echoing: Transport = async () => ({ status: 502, text: JSON.stringify({ error: `bad gateway at https://u:${S}@h/v1` }) });
    const e = (await embed(echoing, { provider: "custom", baseUrl: "http://h/v1", model: "m" }, ["x"]).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(EmbeddingError);
    expect(e.message).toBe("embedding request failed (HTTP 502): bad gateway at https://h/v1");
  });
});

describe("vectorSpaceKey", () => {
  it("keeps keys without credentials, drops credentials", () => {
    expect(vectorSpaceKey({ provider: "ollama", baseUrl: "", model: "fake" })).toBe("ollama|http://127.0.0.1:11434|fake");
    expect(vectorSpaceKey({ provider: "custom", baseUrl: "http://emb.test/v1", model: " fake " })).toBe("custom|http://emb.test/v1|fake");
    expect(vectorSpaceKey({ provider: "custom", baseUrl: `https://k:${S}@api.example.com/v1/`, model: "m" })).toBe("custom|https://api.example.com/v1|m");
  });
});

describe("the vault's index", () => {
  it("a refused address leaves no credentials in the error, last_error or the store", async () => {
    const v = vault();
    v.settings.semanticBaseUrl = `https://u:${S}@127.0.0.1:9/v1`;
    const idx = new SemanticIndex(v.app, () => v.settings, nodeFetchTransport);
    const e = (await idx.sync().catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).not.toContain(S);
    const lastError = idx.status().last_error;
    expect(lastError).toContain("https://127.0.0.1:9/v1/embeddings");
    expect(lastError).not.toContain(S);
    for (const p of v.listAll().filter((x) => x.startsWith("store:"))) expect(v.read(p), p).not.toContain(S);
  });

  it("a failed batch leaves no credentials in failed or last_error", async () => {
    const v = vault();
    v.settings.semanticBaseUrl = `https://u:${S}@127.0.0.1:9/v1`;
    const failing: Transport = async () => ({ status: 500, text: JSON.stringify({ error: `upstream https://u:${S}@h failed` }) });
    const idx = new SemanticIndex(v.app, () => v.settings, failing);
    const result = await idx.sync();
    expect(result.failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.failed)).not.toContain(S);
    expect(idx.status().last_error).toBeDefined();
    expect(idx.status().last_error).not.toContain(S);
  });
});

describe("the docs index", () => {
  it("a refused address leaves no credentials in docs.json or last_error", async () => {
    const v = createDbVault({ [METASTORE]: LOG_YAML });
    Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: `https://u:${S}@127.0.0.1:9/v1`, semanticModel: "m" } satisfies Partial<DatanotesSettings>);
    const idx = new DocsSemanticIndex(v.app, () => v.settings, nodeFetchTransport, () => undefined, () => CORPUS);
    await expect(idx.sync()).rejects.toBeInstanceOf(TypeError);
    const text = v.read(DOCS_INDEX_FILE);
    expect((JSON.parse(text) as { key: string }).key).toBe("custom|https://127.0.0.1:9/v1|m");
    expect(text).not.toContain(S);
    const answer = await idx.search("time travel");
    expect(answer.ready).toBe(false);
    expect(answer.last_error).toContain("https://127.0.0.1:9/v1/embeddings");
    expect(answer.last_error).not.toContain(S);
    await idx.idle();
  });
});

const OWNER = "owner-token-semantic-credentials-0123456789";
const running: RunningService[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const svc of running.splice(0)) await svc.stop();
  for (const d of folders.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A vault with its settings seeded in its store and two plain notes to embed. */
function serviceVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-credentials-"));
  folders.push(root);
  fs.mkdirSync(path.join(root, "Datanotes"), { recursive: true });
  fs.writeFileSync(path.join(root, METASTORE), withTables("task:\n  columns:\n    - { name: title, type: string }\n"));
  seedStoreSettings(root, { httpServerPort: 0, httpServerToken: OWNER, fileLogEnabled: true, autoRecompute: false }, METASTORE);
  for (const p of ["note.md", "Datanotes/note.md"]) fs.writeFileSync(path.join(root, p), "# Note\n\nSome text to embed.\n");
  return root;
}

async function post(svc: RunningService, route: string, body: unknown, token = OWNER): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`http://127.0.0.1:${svc.port}/datanotes${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
}

function logText(store: string): string {
  const dir = path.join(store, "logs");
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("");
}

describe("on the service", () => {
  it("describe_semantic_index, semantic_search, the log file and the store hold no credentials", { timeout: 30_000 }, async () => {
    const root = serviceVault();
    const svc = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
    running.push(svc);
    const created = await post(svc, "/tokens/create/", { name: "cook", write: [] });
    expect(created.status).toBe(200);
    const cook = created.json.token as string;
    const version = (await post(svc, "/settings/", {})).json.settings_version;
    const update = await post(svc, "/settings/update/", {
      expect_version: version,
      changes: { semanticEnabled: true, semanticProvider: "custom", semanticModel: "m", semanticBaseUrl: `https://u:${S}@127.0.0.1:9/v1` },
    });
    expect(update.status).toBe(200);
    expect(update.text).not.toContain(S);
    let lastError: unknown;
    for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
      const d = await post(svc, "/operations/describe_semantic_index/", {}, cook);
      expect(d.text).not.toContain(S);
      lastError = d.json.last_error;
      if (typeof lastError === "string") break;
    }
    expect(typeof lastError).toBe("string");
    expect(lastError).toContain("https://127.0.0.1:9/v1/embeddings");
    const search = await post(svc, "/operations/semantic_search/", { query: "text" }, cook);
    expect(search.status).toBe(500);
    expect(search.text).not.toContain(S);
    expect(search.text).toContain("127.0.0.1:9");
    await svc.stop();
    expect(filesWith(svc.store.store, S)).toEqual(["settings.json"]);
    expect(logText(svc.store.store)).toContain("datanotes semantic index update failed");
  });
});
