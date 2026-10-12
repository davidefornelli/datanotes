/**
 * `datanotes serve` in this process (src/node/service.ts): the entry point `main` (console output
 * to `--log`, the stop on a signal), a settings file that does not exist yet, and the embedding
 * key read from `--embedding-key-file`. Engines listen on free ports, on temporary vaults.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { main, startService, type RunningService } from "../src/node/service";
import { nodeVersionWarning } from "../src/node/node-version";
import { docsUrl } from "../src/core/hints";
import { LOG_YAML, METASTORE } from "./helpers/db-vault";

const temp: string[] = [];
const running: RunningService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of running.splice(0)) await s.stop();
});
afterAll(() => {
  for (const d of temp) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temp.push(d);
  return d;
}

/** A vault with the `log` table, and a settings file beside it (not written when `settings` is null). */
function vault(settings: Record<string, unknown> | null): { root: string; settingsFile: string } {
  const dir = tempDir("dn-main-");
  const root = path.join(dir, "vault");
  fs.mkdirSync(path.join(root, path.dirname(METASTORE)), { recursive: true });
  fs.writeFileSync(path.join(root, METASTORE), LOG_YAML);
  const settingsFile = path.join(dir, "settings", "settings.json");
  if (settings) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ fileLogEnabled: false, autoRecompute: false, ...settings }));
  }
  return { root, settingsFile };
}

const post = (port: number, route: string, token: string, body: unknown = {}) =>
  fetch(`http://127.0.0.1:${port}/datanotes/${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("datanotes serve: the entry point", () => {
  it("appends console output to --log, and stops on a signal the way a stop over HTTP does", async () => {
    const TOKEN = "main-owner-token-0123456789";
    const { root, settingsFile } = vault({ httpServerToken: TOKEN });
    const logFile = path.join(tempDir("dn-main-log-"), "logs", "service.log");
    const signals = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;
    const before = new Map(signals.map((s) => [s, process.listeners(s)]));
    const { log, error } = console;
    // the process's own environment must not choose this engine's store, port or git steps
    const saved = Object.entries(process.env).filter(([k]) => k.startsWith("DATANOTES_") && k !== "DATANOTES_DATA_HOME");
    for (const [k] of saved) delete process.env[k];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await main(["--vault", root, "--settings", settingsFile, "--port", "0", "--watch", "poll", "--log", logFile]);
      const text = () => fs.readFileSync(logFile, "utf8");
      const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(text())![1]);
      expect(text()).toMatch(new RegExp(`^\\S+ INFO datanotes service \\S+: vault ${root.replace(/[\\.]/g, "\\$&")}, http://127\\.0\\.0\\.1:${port}, watch poll, store `, "m"));
      expect((await post(port, "operations/list_tables/", TOKEN)).status).toBe(200);
      // what is not text is written as JSON
      console.log("counts", { tables: 1 });
      expect(text()).toMatch(/ INFO counts \{"tables":1\}\n/);

      // the signal the service manager sends: the graceful stop, then the process ends with 0
      const onTerm = process.listeners("SIGTERM").find((l) => !before.get("SIGTERM")!.includes(l))!;
      for (const s of signals) expect(process.listeners(s).length).toBe(before.get(s)!.length + 1);
      onTerm("SIGTERM");
      await until(() => exit.mock.calls.length > 0);
      expect(exit).toHaveBeenCalledWith(0);
      expect(text()).toMatch(/ INFO datanotes service: SIGTERM, stopping\n[\s\S]* INFO datanotes service: stopped\n/);
      await expect(post(port, "operations/list_tables/", TOKEN)).rejects.toThrow();
    } finally {
      console.log = log;
      console.error = error;
      for (const s of signals) for (const l of process.listeners(s)) if (!before.get(s)!.includes(l)) process.removeListener(s, l);
      for (const [k, v] of saved) process.env[k] = v;
    }
  });
});

describe("datanotes serve: the folder and the Node version", () => {
  it("refuses a folder that does not exist with a hint and the docs, not a raw ENOENT", async () => {
    const missing = path.join(tempDir("dn-main-missing-"), "no-such-folder");
    for (const atRoot of [true, false]) {
      const err = (await startService({ vault: missing, ...(atRoot ? { atRoot } : {}), watch: "poll", pollMs: 1000, port: 0 }, {}).catch((e: unknown) => e)) as Error & { hint?: string; docs?: string };
      const option = atRoot ? "--database" : "--vault";
      expect(err.message).toBe(`${option} ${missing}: no such folder`);
      expect(err.hint).toContain(`fix the path in ${option}`);
      expect(err.docs).toBe(docsUrl("startEngine"));
      expect(fs.existsSync(missing)).toBe(false);
    }
  });

  it("names the folder a database in its first line when started with --database", async () => {
    const TOKEN = "main-database-token-0123456789";
    const dir = tempDir("dn-main-db-");
    const root = path.join(dir, "db");
    fs.mkdirSync(root);
    const settingsFile = path.join(dir, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ fileLogEnabled: false, autoRecompute: false, httpServerToken: TOKEN }));
    const logFile = path.join(dir, "logs", "service.log");
    const signals = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;
    const kept = new Map(signals.map((s) => [s, process.listeners(s)]));
    const { log, error } = console;
    const saved = Object.entries(process.env).filter(([k]) => k.startsWith("DATANOTES_") && k !== "DATANOTES_DATA_HOME");
    for (const [k] of saved) delete process.env[k];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await main(["--database", root, "--settings", settingsFile, "--port", "0", "--watch", "poll", "--log", logFile]);
      const text = fs.readFileSync(logFile, "utf8");
      expect(text).toMatch(new RegExp(`: database ${root.replace(/[\\.]/g, "\\$&")}, http://127\\.0\\.0\\.1:\\d+, watch poll, store `));
      process.listeners("SIGTERM").find((l) => !kept.get("SIGTERM")!.includes(l))!("SIGTERM");
      await until(() => exit.mock.calls.length > 0);
    } finally {
      console.log = log;
      console.error = error;
      for (const s of signals) for (const l of process.listeners(s)) if (!kept.get(s)!.includes(l)) process.removeListener(s, l);
      for (const [k, v] of saved) process.env[k] = v;
    }
  });

  it("warns on Windows with the Node versions that crash on local connections", () => {
    for (const v of ["24.0.0", "24.15.0", "26.0.0", "26.0.3"]) expect(nodeVersionWarning("win32", v)).toContain(`Node ${v} on Windows can crash`);
    for (const v of ["22.12.0", "24.16.0", "24.21.0", "26.1.0", "27.0.0"]) expect(nodeVersionWarning("win32", v)).toBeNull();
    expect(nodeVersionWarning("linux", "24.15.0")).toBeNull();
    expect(nodeVersionWarning("darwin", "26.0.0")).toBeNull();
  });
});

describe("datanotes serve: settings and keys", () => {
  it("starts with a settings file that does not exist yet, and writes it with the owner's token", async () => {
    const { root, settingsFile } = vault(null);
    const svc = await startService({ vault: root, watch: "poll", pollMs: 1000, port: 0, settingsFile }, {});
    running.push(svc);
    const written = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    expect(typeof written.httpServerToken).toBe("string");
    expect((written.httpServerToken as string).length).toBeGreaterThanOrEqual(16);
    // --port is this run's: never saved
    expect(written.httpServerPort).not.toBe(0);
    expect((await post(svc.port, "operations/list_tables/", written.httpServerToken as string)).status).toBe(200);
  });

  it("sends the key of --embedding-key-file to the embedding service, read at each call; none when the file is gone or empty", async () => {
    const auth: (string | undefined)[] = [];
    const fake = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        auth.push(req.headers.authorization);
        const input = (JSON.parse(body) as { input: string[] }).input;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const TOKEN = "embed-owner-token-0123456789";
      const { root, settingsFile } = vault({
        httpServerToken: TOKEN,
        semanticEnabled: true,
        semanticProvider: "openai",
        semanticBaseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
        semanticModel: "test-embed",
      });
      const keyFile = path.join(path.dirname(settingsFile), "embedding.key");
      fs.writeFileSync(keyFile, "  sk-from-file\n");
      const svc = await startService({ vault: root, watch: "poll", pollMs: 1000, port: 0, settingsFile, embeddingKeyFile: keyFile }, {});
      running.push(svc);
      const search = () => post(svc.port, "operations/semantic_search/", TOKEN, { query: "a walk" });

      const found = await search();
      expect(found.status).toBe(200);
      expect(auth.at(-1)).toBe("Bearer sk-from-file");

      // the file changed: the next call sends the new key
      fs.writeFileSync(keyFile, "sk-rotated");
      expect((await search()).status).toBe(200);
      expect(auth.at(-1)).toBe("Bearer sk-rotated");

      // an empty file, or none: no key, and OpenAI refuses to be called without one
      for (const change of [() => fs.writeFileSync(keyFile, " \n"), () => fs.rmSync(keyFile)]) {
        change();
        const calls = auth.length;
        const refused = await search();
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toContain("OpenAI needs an API key");
        expect(auth.length).toBe(calls);
      }
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });
});
