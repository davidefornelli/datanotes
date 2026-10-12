/**
 * The committed test vault (`test-vault/`) on a temporary copy, with the engine running on it:
 *
 * - `service`: `datanotes serve` in process (`startService`, the Node host with its watcher, change
 *   feed, webhooks and transaction log of hand edits), reached over HTTP with `DatanotesClient`;
 * - `in-process`: the engine's route handlers (`createHandlers`) behind its HTTP server on the vault
 *   of `createDbVault` (the fake `App` of the in-memory tests, or the Node host with
 *   `VAULT_HOST=node`), with a change feed and webhooks of its own. It has no watcher: a hand
 *   edit is announced to the feed as the vault's event would be (`handEdit`).
 *
 * Both answer the same `call(op, args)`, which records every operation name it sends (`used`).
 * The committed folder is never written; `stop()` stops the engine before the copy is deleted.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { DatanotesClient, fetchTransport, type HttpResponse } from "../../src/api/client";
import type { OperationResult } from "../../src/api/results";
import { ChangeFeed } from "../../src/core/change-feed";
import { createPublicApi } from "../../src/core/public-api";
import { SemanticIndex } from "../../src/core/semantic";
import type { DatanotesSettings } from "../../src/core/settings";
import { newDatabaseId, withMetastoreId } from "../../src/core/database-id";
import { startService, type RunningService } from "../../src/node/service";
import { HttpApiServer } from "../../src/server/http-server";
import { createHandlers } from "../../src/server/rest";
import { WebhookDispatcher } from "../../src/server/webhooks";
import { createDbVault } from "./db-vault";
import { opProblem } from "./op-names";
import { seedStoreSettings } from "./store-settings";

/** The committed test vault. */
export const TEST_VAULT = path.resolve(__dirname, "..", "..", "test-vault");

export type HostKind = "service" | "in-process";
export const HOSTS: HostKind[] = ["service", "in-process"];

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** Every file under `root` (vault-relative, `/`), dot-folders and dot-files left out. */
export function vaultFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(root, abs).split(path.sep).join("/")] = fs.readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * A temporary copy of the test vault, without the engine's state folder, and with a database id of
 * its own (as `datanotes store new-id` gives a copy): each copy has its own store.
 */
export function copyTestVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-test-vault-"));
  fs.cpSync(TEST_VAULT, root, { recursive: true, filter: (src) => path.relative(TEST_VAULT, src).split(path.sep)[0] !== ".datanotes" });
  const meta = path.join(root, "datanotes", "metastore.yaml");
  fs.writeFileSync(meta, withMetastoreId(fs.readFileSync(meta, "utf8"), newDatabaseId()));
  return root;
}

export interface OpenOptions {
  /** Engine settings (e.g. semantic search on a stub provider). */
  settings?: Partial<DatanotesSettings>;
  /** Poll interval of the service's watcher, ms. */
  pollMs?: number;
}

export interface TestVault {
  host: HostKind;
  /** The vault copy. */
  root: string;
  client: DatanotesClient;
  /** Names of the operations sent through `call` (and `ok` / `refused`). */
  used: Set<string>;
  call(op: string, args?: Record<string, unknown>): Promise<OperationResult>;
  /** `call`, expecting success: the value. */
  ok<T = any>(op: string, args?: Record<string, unknown>): Promise<T>;
  /**
   * `call`, expecting a refusal that teaches: it must end with the engine's `Hint:` and `Docs:`
   * lines (src/core/hints.ts). The reason (agent-readable text), without those lines.
   */
  refused(op: string, args?: Record<string, unknown>): Promise<string>;
  read(rel: string): string;
  exists(rel: string): boolean;
  /** The notes and the metastore, by path (dot-folders left out): to compare states. */
  files(): Record<string, string>;
  /** Write a note as an editor would, outside the engine; the engine learns it as it would on its host. */
  handEdit(rel: string, text: string): void;
  /** Rename or move a note as a file manager would, outside the engine (links to it are not rewritten). */
  handMove(from: string, to: string): Promise<void>;
  /** Stop the engine, then delete the copy. */
  stop(): Promise<void>;
}

/**
 * A refusal's text without its guidance: it must end with a `Hint:` line and a `Docs:` line that
 * links a Markdown page of the docs (every refusal says how to fix it and where to read more).
 * Every such line is left out, those of a batch's steps too.
 */
export function withoutGuidance(text: string, op = "the call"): string {
  expect(text, `${op}: the refusal does not end with Hint: and Docs: lines`).toMatch(/\nHint: [^\n]+\nDocs: https:\/\/datanotes\.dev\/[a-z0-9\/_-]+\.md(#[a-z0-9_-]+)? \(offline: read_docs\("[a-z0-9\/_#-]+"\)\)$/);
  return text
    .split("\n")
    .filter((l) => !l.startsWith("Hint: ") && !l.startsWith("Docs: "))
    .join("\n");
}

const TOKEN = "test-vault-token";
const ACTOR = { harness: "test-vault-ops" };

function recording(
  host: HostKind,
  root: string,
  url: string,
  handEdit: (rel: string, text: string) => void,
  handMove: (from: string, to: string) => Promise<void>,
  stop: () => Promise<void>,
): TestVault {
  const client = new DatanotesClient({ url, token: TOKEN, actor: ACTOR });
  const used = new Set<string>();
  const call = async (op: string, args: Record<string, unknown> = {}) => {
    used.add(op);
    // a client of its own, which keeps this call's answer: every answer names the operation called
    // (`op`), its refusals too (tests/operation-op.test.ts)
    let res: HttpResponse | null = null;
    const one = new DatanotesClient({ url, token: TOKEN, actor: ACTOR, transport: async (req) => (res = await fetchTransport(req)) });
    const r = await one.call(op, args);
    const answer = res as HttpResponse | null;
    if (answer) {
      let json: unknown;
      try {
        json = JSON.parse(answer.text);
      } catch {
        json = undefined;
      }
      expect(opProblem(op, answer.status, json), `${op}: the answer's "op"`).toBeNull();
    }
    return r;
  };
  const full = (rel: string) => path.join(root, ...rel.split("/"));
  let stopped = false;
  return {
    host,
    root,
    client,
    used,
    call,
    async ok(op, args) {
      const r = await call(op, args);
      expect(r.ok, `${op} ${JSON.stringify(args ?? {}).slice(0, 300)} was refused: ${typeof r.value === "string" ? r.value : JSON.stringify(r.value).slice(0, 2000)}`).toBe(true);
      return r.value as never;
    },
    async refused(op, args) {
      const r = await call(op, args);
      expect(r.ok, `${op} ${JSON.stringify(args ?? {}).slice(0, 300)} was not refused: ${JSON.stringify(r.value).slice(0, 2000)}`).toBe(false);
      return withoutGuidance(String(r.value), op);
    },
    read: (rel) => fs.readFileSync(full(rel), "utf8"),
    exists: (rel) => fs.existsSync(full(rel)),
    files: () => vaultFiles(root),
    handEdit,
    handMove,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await stop();
      } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  };
}

/** The engine on a new copy of the test vault. */
export async function openTestVault(host: HostKind, o: OpenOptions = {}): Promise<TestVault> {
  return host === "service" ? openService(o) : openInProcess(o);
}

async function openService(o: OpenOptions): Promise<TestVault> {
  const root = copyTestVault();
  let svc: RunningService | undefined;
  try {
    const port = await freePort();
    // the settings in the copy's store: the port and the owner token are known before the start
    seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false, autoRecompute: false, ...o.settings });
    svc = await startService({ vault: root, watch: "poll", pollMs: o.pollMs ?? 200, httpWaitMs: 10_000 }, {});
    const running = svc;
    return recording(
      "service",
      root,
      `http://127.0.0.1:${port}`,
      (rel, text) => {
        // the watcher's next poll sees it (mtime and size), as it sees an editor's save
        const abs = path.join(root, ...rel.split("/"));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
      },
      async (from, to) => {
        // the watcher's next poll sees one note gone and one new with its text: a rename
        const abs = (rel: string) => path.join(root, ...rel.split("/"));
        fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
        fs.renameSync(abs(from), abs(to));
      },
      () => running.stop(),
    );
  } catch (e) {
    await svc?.stop();
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

async function openInProcess(o: OpenOptions): Promise<TestVault> {
  const v = createDbVault(vaultFiles(TEST_VAULT), { fileLogEnabled: false, autoRecompute: false, databaseFolder: "datanotes", ...o.settings });
  const s = () => v.settings;
  const semantic = new SemanticIndex(v.app, s, async (req) => {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    return { status: res.status, text: await res.text() };
  });
  const feed = new ChangeFeed(v.app, s);
  await feed.start();
  const hooks = new WebhookDispatcher(v.app, s, () => feed);
  await hooks.start();
  const api = createPublicApi(v.app, s, async () => {}, semantic, () => feed, () => hooks);
  const server = new HttpApiServer({ app: v.app, handlers: createHandlers(v.app, s, async () => {}, semantic, api), token: TOKEN, port: 0, changeFeed: () => feed });
  const port = await server.start();
  return recording(
    "in-process",
    v.root,
    `http://127.0.0.1:${port}`,
    (rel, text) => {
      v.write(rel, text);
      feed.touch(rel); // the vault's modify event (the fake App has no events)
    },
    async (from, to) => {
      // the vault's rename event: the headless host announces it, the fake App has no events
      if (!(await v.rename(from, to))) feed.moved(from, to);
    },
    async () => {
      await server.stop();
      await hooks.stop();
      await feed.stop();
    },
  );
}

/** A local HTTP server that keeps what it is sent (a webhook receiver). */
export interface Receiver {
  url: string;
  received: { headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

export async function receiver(handle?: (body: string) => { status: number; body: string }): Promise<Receiver> {
  const received: Receiver["received"] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: data });
      const out = handle?.(data) ?? { status: 200, body: "ok" };
      res.statusCode = out.status;
      res.setHeader("Content-Type", "application/json");
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/**
 * A local embedding provider in Ollama's format (`POST /api/embed`): a bag of words hashed into 64
 * dimensions, so texts that share words are close. Settings for the engine: `settings`.
 */
export async function embeddingStub(): Promise<{ settings: Partial<DatanotesSettings>; close(): Promise<void> }> {
  const vector = (text: string) => {
    const v = new Array<number>(64).fill(0.01);
    for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
      v[(h >>> 0) % 64]! += 1;
    }
    return v;
  };
  const r = await receiver((body) => {
    const { input } = JSON.parse(body) as { input: string[] };
    return { status: 200, body: JSON.stringify({ embeddings: input.map(vector) }) };
  });
  return {
    settings: { semanticEnabled: true, semanticProvider: "ollama", semanticBaseUrl: r.url, semanticModel: "stub-embed" },
    close: r.close,
  };
}

/** Poll `fn` until it returns a truthy value (or fail after `ms`). */
export async function until<T>(fn: () => Promise<T> | T, ms = 5000, what = "condition"): Promise<Exclude<T, undefined | null | false | 0 | "">> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as Exclude<T, undefined | null | false | 0 | "">;
    if (Date.now() > end) throw new Error(`${what}: not met after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
