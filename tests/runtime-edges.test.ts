/**
 * The engine runtime (`src/server/runtime.ts`) on a vault on disk, as the headless service runs it:
 * start and stop, the HTTP server it manages (port 0, never connected to), its own routes, store
 * maintenance, telemetry and the semantic index catching up (fake embedding transport).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithActor } from "../src/core/actor";
import type { Transport } from "../src/core/embeddings";
import { INDEX_RETRY, whileWriting } from "../src/core/engine";
import { mergeWithDefaults, type DatanotesSettings } from "../src/core/settings";
import { NOOP_TELEMETRY, setTelemetry, telemetry, type AttrValue } from "../src/core/telemetry";
import { openNodeVault, type NodeHost } from "../src/node/node-app";
import { dispatch } from "../src/server/rest";
import { EngineRuntime, type RuntimeOptions } from "../src/server/runtime";
import type { TFile } from "../src/core/host";
import { LOG_DIR, LOG_YAML, METASTORE, TEST_DATABASE_FOLDER, withTables } from "./helpers/db-vault";
import { guided } from "./helpers/guidance";

beforeAll(() => {
  INDEX_RETRY.delayMs = 1;
});

let logs: { severity: string; body: string; attributes?: Record<string, AttrValue> }[] = [];
beforeEach(() => {
  logs = [];
  setTelemetry({ log: (severity, body, attributes) => void logs.push({ severity, body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
});
const logged = (body: string) => logs.filter((l) => l.body === body);

/** Wait (up to 5 s) until a record with this body is logged. */
async function until(body: string, count = 1): Promise<void> {
  for (let i = 0; i < 250 && logged(body).length < count; i++) await new Promise((r) => setTimeout(r, 20));
  expect(logged(body).length).toBeGreaterThanOrEqual(count);
}

interface Engine {
  root: string;
  host: NodeHost;
  settings: DatanotesSettings;
  runtime: EngineRuntime;
  saves: number;
  write(rel: string, text: string): void;
  /** The file on disk: a vault path, or a store path (`store:<path>`). */
  abs(rel: string): string;
  exists(rel: string): boolean;
}

const open: Engine[] = [];
afterEach(async () => {
  for (const e of open.splice(0)) {
    await e.runtime.stop();
    e.host.metadataCache.dispose();
    fs.rmSync(e.root, { recursive: true, force: true });
  }
  setTelemetry(NOOP_TELEMETRY);
});

/** A vault with the log table and two rows, and a runtime on it (not started). */
/** Reads of the change feed's files fail, as when another program holds them; returns the undo. */
function lockChanges(e: Engine, message: string): () => void {
  const store = e.host.app.store! as unknown as { read(rel: string): Promise<string> };
  const read = store.read;
  store.read = async (rel) => {
    if (rel.startsWith("changes/")) throw new Error(message);
    return read.call(store, rel);
  };
  return () => void (store.read = read);
}

function engine(settings: Partial<DatanotesSettings> = {}, options: Partial<RuntimeOptions> = {}, files: Record<string, string> = {}): Engine {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-edges-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-edges-store-"));
  // `store:<path>`: a file of the engine's store
  const abs = (rel: string) => (rel.startsWith("store:") ? path.join(store, rel.slice("store:".length)) : path.join(root, rel));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  };
  write(METASTORE, LOG_YAML);
  write("Daily/a.md", "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: walk\noccurred_at: 2026-09-25T18:30\n---\nAlong the river.\n");
  write("Daily/b.md", "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: mood\noccurred_at: 2026-09-26T08:00\n---\nRested.\n");
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  const host = openNodeVault(root, undefined, { store });
  const s = mergeWithDefaults({ fileLogEnabled: false, autoRecompute: false, databaseFolder: TEST_DATABASE_FOLDER, ...settings });
  // a port the system picks: the settings refuse 0 and fall back to 27150, a live engine's port
  s.httpServerPort = 0;
  const e: Engine = {
    root,
    host,
    settings: s,
    saves: 0,
    runtime: undefined as unknown as EngineRuntime,
    write,
    abs,
    exists: (rel) => fs.existsSync(abs(rel)),
  };
  e.runtime = new EngineRuntime({
    app: host.app,
    getSettings: () => s,
    saveSettings: async () => void e.saves++,
    transport: async () => ({ status: 500, text: "" }),
    embeddingKey: () => undefined,
    version: "3.0.0-test",
    hostName: "service",
    canServeHttp: false,
    ...options,
  });
  open.push(e);
  return e;
}

describe("runtime: start and stop", () => {
  it("starts once: a second start keeps the same change feed", async () => {
    const e = engine();
    await e.runtime.start({ http: false });
    const feed = e.runtime.changeFeed;
    expect(feed).not.toBeNull();
    await e.runtime.start({ http: false });
    expect(e.runtime.changeFeed).toBe(feed);
    await e.runtime.stop();
    expect(e.runtime.changeFeed).toBeNull();
  });

  it("on a host that cannot open a server, start says why the HTTP server is not running", async () => {
    const e = engine();
    await e.runtime.start();
    expect(e.runtime.httpServerRunning).toBe(false);
    expect(e.runtime.httpServerError).toBe("the HTTP server runs on desktop only");
  });

  it("serves HTTP with a token it makes and saves when there is none; applying again restarts the server", async () => {
    const e = engine({ httpServerToken: "" }, { canServeHttp: true, httpHost: "127.0.0.1" });
    await e.runtime.applyHttpServer();
    expect(e.runtime.httpServerRunning).toBe(true);
    expect(e.runtime.httpServerError).toBeNull();
    const token = e.settings.httpServerToken;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(e.saves).toBe(1);
    const listening = logged("datanotes HTTP server listening");
    expect(listening).toHaveLength(1);
    expect(listening[0]!.attributes!.port).toBeGreaterThan(0);

    await e.runtime.applyHttpServer();
    expect(e.runtime.httpServerRunning).toBe(true);
    expect(e.settings.httpServerToken).toBe(token);
    expect(e.saves).toBe(1);
    expect(logged("datanotes HTTP server listening")).toHaveLength(2);

    await e.runtime.stop();
    expect(e.runtime.httpServerRunning).toBe(false);
  });

  it("leaves the change feed off and says so when the stored feed cannot be read", async () => {
    // a torn line is skipped (change-feed-edges.test.ts); a file another program holds is not
    const e = engine({}, {}, { "store:changes/2026-10.jsonl": `{"seq":1,"at":"2026-10-01T08:00:00.000Z","table":null,"op":"tool_call","path":"","source":"engine"}\n` });
    const readError = "EBUSY: resource busy or locked, open 'changes/2026-10.jsonl'";
    lockChanges(e, readError);
    await e.runtime.start({ http: false });
    expect(e.runtime.changeFeed).toBeNull();
    expect(logged("datanotes change feed could not start")).toEqual([{ severity: "WARN", body: "datanotes change feed could not start", attributes: { error: readError } }]);
    expect(logged("datanotes change feed not running: it starts the next time metastore.yaml changes and can be read")).toHaveLength(1);
  });

  it("stops a change feed that was still starting when the runtime stopped", async () => {
    const e = engine({}, {}, { "store:changes/2026-10.jsonl": "{}\n" });
    const unlock = lockChanges(e, "EBUSY: resource busy or locked");
    await e.runtime.start({ http: false });
    expect(e.runtime.changeFeed).toBeNull();
    unlock();
    fs.rmSync(e.abs("store:changes/2026-10.jsonl"));
    // the feed starts again (as after a metastore fix) and the runtime stops before it is up
    const starting = (e.runtime as unknown as { startFeed(): Promise<void> }).startFeed();
    await e.runtime.stop();
    await starting;
    expect(e.runtime.changeFeed).toBeNull();
    expect(logged("datanotes change feed could not start")).toHaveLength(1);
  });

  it("logs a background task that fails with a plain value, and still stops", async () => {
    const e = engine();
    await e.runtime.start({ http: false });
    (e.runtime as unknown as { track(w: Promise<unknown>, what: string): void }).track(Promise.reject("disk full"), "transaction log of hand edits");
    await e.runtime.stop();
    expect(logged("datanotes transaction log of hand edits failed")).toEqual([
      { severity: "WARN", body: "datanotes transaction log of hand edits failed", attributes: { error: "disk full" } },
    ]);
  });
});

describe("runtime: notes created by hand while it runs", () => {
  it("makes a note created in a table folder a row, and logs one it cannot adopt", async () => {
    const e = engine();
    await e.runtime.start({ http: false });
    await e.host.app.vault.create(`${LOG_DIR}/2026/09/27/2026-09-27 walk.md`, "---\noccurred_at: 2026-09-27T17:00\n---\nUp the hill.\n");
    // the kind its name gives is not one the table knows
    await e.host.app.vault.create(`${LOG_DIR}/2026/09/27/2026-09-27 nap.md`, "---\noccurred_at: 2026-09-27T14:00\n---\n");
    await e.host.app.vault.create("Ideas/garden.md", "Plant tomatoes.\n");
    await until("datanotes adopted new note");
    await until("datanotes could not adopt new note");
    expect(logged("datanotes adopted new note")).toEqual([
      { severity: "INFO", body: "datanotes adopted new note", attributes: { path: `${LOG_DIR}/2026/09/27/2026-09-27 walk.md`, table: "main.public.log" } },
    ]);
    expect(logged("datanotes could not adopt new note")).toEqual([
      {
        severity: "WARN",
        body: "datanotes could not adopt new note",
        attributes: { path: `${LOG_DIR}/2026/09/27/2026-09-27 nap.md`, table: "main.public.log", reason: "kind: must be one of: alcohol; mood; walk" },
      },
    ]);
    expect(fs.readFileSync(path.join(e.root, `${LOG_DIR}/2026/09/27/2026-09-27 nap.md`), "utf8")).toBe("---\noccurred_at: 2026-09-27T14:00\n---\n");
    const adopted = fs.readFileSync(path.join(e.root, `${LOG_DIR}/2026/09/27/2026-09-27 walk.md`), "utf8");
    expect(adopted).toMatch(/^---\n[\s\S]*table: main\.public\.log\n[\s\S]*kind: walk\n[\s\S]*---\nUp the hill\.\n$/);
    // a note outside the tables' folders stays a plain note
    expect(fs.readFileSync(path.join(e.root, "Ideas/garden.md"), "utf8")).toBe("Plant tomatoes.\n");
  }, 10_000);

  it("makes a note moved by hand into a table folder a row, as one created there", async () => {
    const e = engine({}, {}, { "Ideas/2026-09-28 walk.md": "---\noccurred_at: 2026-09-28T17:00\n---\nTo the lake.\n" });
    await e.runtime.start({ http: false });
    // another program's move, as the host announces it (a rename, not the engine's)
    const to = `${LOG_DIR}/2026/09/28/2026-09-28 walk.md`;
    await e.host.vault.move(e.host.vault.getAbstractFileByPath("Ideas/2026-09-28 walk.md")!, to);
    await until("datanotes adopted new note");
    expect(logged("datanotes adopted new note")).toEqual([{ severity: "INFO", body: "datanotes adopted new note", attributes: { path: to, table: "main.public.log" } }]);
    expect(fs.readFileSync(e.abs(to), "utf8")).toMatch(/^---\n[\s\S]*table: main\.public\.log\n[\s\S]*kind: walk\n[\s\S]*---\nTo the lake\.\n$/);
  }, 10_000);

  it("adopts a note moved by hand into a table folder also when the move is seen while the engine writes", async () => {
    const from = "Ideas/2026-09-29 walk.md";
    const e = engine({}, {}, { [from]: "---\noccurred_at: 2026-09-29T17:00\n---\nAlong the river.\n" });
    await e.runtime.start({ http: false });
    const to = `${LOG_DIR}/2026/09/29/2026-09-29 walk.md`;
    // another program moves it; the watcher reports it during an engine write: still a hand move
    await whileWriting(e.host.app, async () => {
      fs.mkdirSync(path.dirname(e.abs(to)), { recursive: true });
      fs.renameSync(e.abs(from), e.abs(to));
      e.host.vault.syncPaths([from, to]);
    });
    await until("datanotes adopted new note");
    expect(logged("datanotes adopted new note")).toEqual([{ severity: "INFO", body: "datanotes adopted new note", attributes: { path: to, table: "main.public.log" } }]);
  }, 10_000);
});

describe("runtime: links edited while it runs", () => {
  /** Friends are mirrored both ways and must be active people. */
  const PEOPLE = withTables(`person:
  options: { filename: "{name}" }
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: name, type: string, required: true }
    - { name: active, type: boolean }
    - { name: friends, type: list, items: link, ref: self, inverse: friends, ref_where: { active: true } }
`);
  const person = (n: number, name: string, active: boolean, friends = "") =>
    `---\ntable: main.public.person\nid: 01a0f000-0000-7000-8000-00000000010${n}\nname: ${name}\nactive: ${active}\n${friends}---\n`;

  it("mirrors a link another tool adds in the linked row, and logs a mirror the linked row's rules refuse", async () => {
    const e = engine({}, {}, {
      [METASTORE]: PEOPLE,
      "People/Alice.md": person(1, "Alice", true),
      "People/Carol.md": person(2, "Carol", true),
      "People/Mark.md": person(3, "Mark", false),
      "People/Dave.md": person(4, "Dave", true),
    });
    await e.runtime.start({ http: false });
    const link = (from: string, to: string) =>
      e.host.app.vault.process(e.host.app.vault.getAbstractFileByPath(`People/${from}.md`) as TFile, (t) => t.replace(/---\n$/, `friends:\n  - "[[${to}]]"\n---\n`));
    await link("Alice", "Carol");
    await link("Mark", "Dave"); // Mark is not active: Dave may not list him
    const read = (name: string) => fs.readFileSync(path.join(e.root, `People/${name}.md`), "utf8");
    await until("datanotes could not mirror links");
    for (let i = 0; i < 100 && !read("Carol").includes("[[Alice]]"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(read("Carol")).toBe(person(2, "Carol", true, `friends:\n  - "[[Alice]]"\n`));
    expect(read("Dave")).toBe(person(4, "Dave", true));
    expect(logged("datanotes could not mirror links")).toEqual([
      { severity: "WARN", body: "datanotes could not mirror links", attributes: { conflicts: 0, violating_rows: 1, failed: 0 } },
    ]);
  }, 10_000);
});

describe("runtime: store maintenance", () => {
  it("drops journal entries past their retention, unused blobs and old log files, and logs what it removed", async () => {
    const e = engine({}, {}, {
      "store:journal/2020-01.jsonl": `${JSON.stringify({ type: "migration", migration_id: "20200115T100000-0001", executed_at: "2020-01-15T10:00:00.000Z", op: "insert_row", references: [] })}\n`,
      "store:blobs/0123abcd.txt": "a large text nobody refers to any more",
      "store:logs/2020-01-15.service.jsonl": '{"level":"INFO"}\n',
    });
    await e.runtime.maintainStore();
    expect(logged("datanotes store compacted")).toEqual([{ severity: "INFO", body: "datanotes store compacted", attributes: { dropped: 1, blobs_removed: 1, logs_removed: 1 } }]);
    expect(e.exists("store:journal/2020-01.jsonl")).toBe(false);
    expect(e.exists("store:blobs/0123abcd.txt")).toBe(false);
    expect(e.exists("store:logs/2020-01-15.service.jsonl")).toBe(false);
    // nothing left to do: nothing logged
    await e.runtime.maintainStore();
    expect(logged("datanotes store compacted")).toHaveLength(1);
  });

  it("logs a maintenance that fails and goes on", async () => {
    const e = engine({}, {}, { "store:journal": "a file where the journal folder should be" });
    await expect(e.runtime.maintainStore()).resolves.toBeUndefined();
    const failed = logged("datanotes store maintenance failed");
    expect(failed).toHaveLength(1);
    expect(String(failed[0]!.attributes!.error)).toMatch(/^ENOTDIR: not a directory/);
  });
});

describe("runtime: its own routes", () => {
  it("answers the OpenAPI document of its version on both routes", async () => {
    const h = engine().runtime.handlers();
    for (const route of ["/openapi/", "/openapi.json/"]) {
      const r = await h[route]!({});
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ openapi: "3.1.0", info: { title: "Datanotes", version: "3.0.0-test" } });
    }
  });

  it("describes a table as the engine does when it is not found or no app tool declares it", async () => {
    const h = engine().runtime.handlers();
    expect(await dispatch("/operations/describe_table/", h["/operations/describe_table/"]!, { table: "workouts" })).toEqual({ status: 404, json: guided("Table not found: workouts") });
    const log = await dispatch("/operations/describe_table/", h["/operations/describe_table/"]!, { table: "log" });
    expect(log.status).toBe(200);
    expect(log.json).toMatchObject({ qualified: "main.public.log" });
    expect(log.json).not.toHaveProperty("tools");
  });

  it("records the model an agent reports for its session; a session is required", async () => {
    const e = engine();
    const h = e.runtime.handlers();
    for (const body of [{}, { session: "   " }, { session: 42, model: "opus" }]) {
      expect(await h["/sessions/identify/"]!(body)).toEqual({ status: 400, json: guided(`"session" is required`) });
    }
    expect(await h["/sessions/identify/"]!({ session: " sess-agent-0001 ", model: "claude-opus-5-5", harness: "claude-code" })).toEqual({ status: 200, json: { ok: true } });
    expect(e.runtime.identities.get("sess-agent-0001")).toEqual({ model: "claude-opus-5-5", harness: "claude-code" });
  });

  it("logs a tool call with defaults for what the reporter leaves out, also with no change feed running", async () => {
    const h = engine().runtime.handlers();
    expect(await h["/tool-calls/record/"]!({ tool: "select_rows", ok: "yes", duration_ms: "12", args: "table=log", served_by: 7 })).toEqual({ status: 200, json: { ok: true } });
    expect(logged("datanotes tool call")).toEqual([
      {
        severity: "INFO",
        body: "datanotes tool call",
        attributes: { tool: "select_rows", ok: false, duration_ms: 0, served_by: "engine", result_chars: 0, result_tokens: 0, harness: "", model: "", session: "" },
      },
    ]);
  });

  it("puts a reported tool call in the change feed with its agent, long values cut and a summary of the result", async () => {
    const e = engine();
    await e.runtime.start({ http: false });
    const h = e.runtime.handlers();
    const note = "n".repeat(250);
    const body = {
      tool: "select_rows",
      args: { table: "log", where: { note: "x".repeat(400) }, query: "q".repeat(320), limit: 20 },
      ok: true,
      duration_ms: 35,
      value: { rows: [{ kind: "walk" }, { kind: "mood" }], total: 2, qualified: "main.public.log", note, done: true, cursor: null, table: { name: "log" } },
      served_by: "engine",
      session: "sess-agent-0001",
      result_chars: 120,
      result_tokens: 40,
    };
    const agent = { harness: "claude-code", model: "claude-opus-5-5", session: "sess-agent-0001", auth: "assistant" };
    expect(await runWithActor(agent, () => h["/tool-calls/record/"]!(body))).toEqual({ status: 200, json: { ok: true } });
    // a failed call and a list result: no summary; a long text value is cut
    await runWithActor(agent, () => h["/tool-calls/record/"]!({ tool: "insert_row", args: {}, ok: false, duration_ms: 3, value: "e".repeat(1200), served_by: "pantry" }));
    await h["/tool-calls/record/"]!({ tool: "list_tables", args: {}, ok: true, duration_ms: 1, value: ["main.public.log"] });

    const page = await e.runtime.changeFeed!.read({ since: 0, ops: ["tool_call"] });
    expect(page.events.map((ev) => ev.actor)).toEqual([agent, agent, undefined]);
    const whereText = JSON.stringify({ note: "x".repeat(400) });
    expect(page.events.map((ev) => ev.call)).toEqual([
      {
        tool: "select_rows",
        args: { table: "log", where: `${whereText.slice(0, 300)}…`, query: `${"q".repeat(300)}…`, limit: 20 },
        ok: true,
        durationMs: 35,
        value: body.value,
        summary: { rows: 2, total: 2, qualified: "main.public.log", note: `${"n".repeat(200)}…`, done: true, cursor: null },
        servedBy: "engine",
        session: "sess-agent-0001",
        resultChars: 120,
        resultTokens: 40,
      },
      { tool: "insert_row", args: {}, ok: false, durationMs: 3, value: `${"e".repeat(1000)}…`, servedBy: "pantry" },
      { tool: "list_tables", args: {}, ok: true, durationMs: 1, value: ["main.public.log"], servedBy: "engine" },
    ]);
    expect(logged("datanotes tool call")[0]!.attributes).toEqual({
      tool: "select_rows",
      ok: true,
      duration_ms: 35,
      served_by: "engine",
      result_chars: 120,
      result_tokens: 40,
      harness: "claude-code",
      model: "claude-opus-5-5",
      session: "sess-agent-0001",
    });
  });
});

describe("runtime: telemetry", () => {
  it("writes the logs to this host's file of the day; dispose flushes them and silences the logs", async () => {
    const e = engine({ fileLogEnabled: true });
    e.runtime.startTelemetry();
    telemetry().log("INFO", "datanotes test record", { table: "main.public.log" });
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const file = `store:logs/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.service.jsonl`;
    await e.runtime.dispose();
    expect(telemetry()).toBe(NOOP_TELEMETRY);
    const lines = fs.readFileSync(e.abs(file), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.msg === "datanotes test record")).toMatchObject({ level: "INFO", table: "main.public.log" });
  });
});

describe("runtime: the semantic index catches up after a quiet time", () => {
  const SEMANTIC: Partial<DatanotesSettings> = { semanticEnabled: true, semanticProvider: "ollama", semanticModel: "nomic-embed-text" };
  /** An Ollama-style embedding service answering every text, or failing with a status. */
  const embeddings = (status = 200): { transport: Transport; requests: string[] } => {
    const requests: string[] = [];
    return {
      requests,
      transport: async (req) => {
        requests.push(req.url);
        if (status !== 200) return { status, text: JSON.stringify({ error: status === 401 ? "unauthorized" : "model is loading" }) };
        const input = (JSON.parse(req.body) as { input: string[] }).input;
        return { status: 200, text: JSON.stringify({ embeddings: input.map((_, i) => [1, i + 1, 0.5]) }) };
      },
    };
  };

  it("embeds the notes once the last request's delay has passed, and logs it", async () => {
    const service = embeddings();
    const e = engine(SEMANTIC, { transport: service.transport });
    e.runtime.syncSemanticSoon(60_000);
    e.runtime.syncSemanticSoon(5, true); // replaces the first
    await until("datanotes semantic index updated");
    expect(logged("datanotes semantic index updated")).toEqual([{ severity: "INFO", body: "datanotes semantic index updated", attributes: { embedded: 2, removed: 0, failed: 0 } }]);
    expect(service.requests.every((u) => u === "http://127.0.0.1:11434/api/embed")).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(logged("datanotes semantic index updated")).toHaveLength(1);
  });

  it("logs the notes it could not embed when the service fails for a while", async () => {
    const e = engine(SEMANTIC, { transport: embeddings(503).transport });
    e.runtime.syncSemanticSoon(5, true);
    await until("datanotes semantic index updated");
    expect(logged("datanotes semantic index updated")).toEqual([{ severity: "WARN", body: "datanotes semantic index updated", attributes: { embedded: 0, removed: 0, failed: 2 } }]);
  });

  it("logs a failed update when the service refuses the engine", async () => {
    const e = engine(SEMANTIC, { transport: embeddings(401).transport });
    e.runtime.syncSemanticSoon(5, true);
    await until("datanotes semantic index update failed");
    expect(logged("datanotes semantic index update failed")).toEqual([
      { severity: "WARN", body: "datanotes semantic index update failed", attributes: { error: "embedding request failed (HTTP 401): unauthorized" } },
    ]);
  });
});
