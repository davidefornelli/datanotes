/**
 * `POST /datanotes/restart/` on the command as it ships (src/node/cli.ts bundled as
 * dist/datanotes.cjs is): the process restarts the engine in place, with the same pid and port, and
 * ends with code 1 and the guided error when the new start fails.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceBuildOptions } from "../scripts/service-build.mjs";
import { storeLocation } from "../src/api/local";
import { copyTestVault } from "./helpers/test-vault";

const temp: string[] = [];
const children: ChildProcess[] = [];
let bin = "";

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-restart-bundle-"));
  temp.push(dir);
  bin = path.join(dir, "datanotes.cjs");
  await esbuild.build({ ...serviceBuildOptions({ outfile: bin, version: "0.0.0-test" }), absWorkingDir: path.resolve(__dirname, ".."), logLevel: "error" });
}, 60_000);

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
  for (const d of temp) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const START_LINE = /http:\/\/127\.0\.0\.1:(\d+)/;

/** Start `serve --port 0` on a copy of the test vault; returns the child, its output and port, and the owner token. */
async function serve() {
  const root = copyTestVault();
  temp.push(root);
  const child = spawn(process.execPath, [bin, "serve", "--vault", root, "--port", "0", "--watch", "poll"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const io = { out: "", err: "" };
  child.stdout!.on("data", (d: Buffer) => (io.out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (io.err += d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  await until(() => START_LINE.test(io.out) || child.exitCode !== null, 30_000);
  const port = Number(START_LINE.exec(io.out)?.[1]);
  expect(port, io.out + io.err).toBeGreaterThan(0);
  const store = storeLocation(root)!.store;
  const token = (JSON.parse(fs.readFileSync(path.join(store, "settings.json"), "utf8")) as { httpServerToken: string }).httpServerToken;
  // a connection of its own each time: a pooled one to the engine before the restart would be reset
  const post = (route: string, body: unknown = {}) => request(port, `/datanotes${route}`, "POST", token, JSON.stringify(body));
  return { root, child, io, port, store, post, exited };
}

/** One request on a connection of its own; resolves with the status. */
function request(port: number, p: string, method: string, token?: string, data?: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = token ? { Authorization: `Bearer ${token}` } : {};
    if (data !== undefined) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    const req = http.request({ host: "127.0.0.1", port, path: p, method, agent: false, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode! }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function until(fn: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

describe("the built command restarts in its own process", () => {
  it("restarts with the same pid and port, then stops with exit 0", async () => {
    const s = await serve();
    expect((await s.post("/restart/")).status).toBe(200);
    await until(() => /datanotes service: restarted[\s\S]*http:\/\/127\.0\.0\.1:\d+/.test(s.io.out), 30_000);
    const after = s.io.out.slice(s.io.out.indexOf("datanotes service: restarted"));
    expect(after, s.io.out + s.io.err).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${s.port}`));
    expect(s.child.exitCode).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(s.store, "engine.lock"), "utf8"))).toMatchObject({ pid: s.child.pid });
    expect((await request(s.port, "/", "GET")).status).toBe(200);
    expect((await s.post("/stop/")).status).toBe(200);
    expect(await s.exited).toBe(0);
  }, 90_000);

  it("ends with code 1 and the guided error when the new start fails", async () => {
    const s = await serve();
    fs.mkdirSync(path.join(s.root, "extra"), { recursive: true });
    fs.writeFileSync(path.join(s.root, "extra", "metastore.yaml"), "tables: {}\n");
    expect((await s.post("/restart/")).status).toBe(200);
    const code = await Promise.race([s.exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 60_000))]);
    expect(code, s.io.out + s.io.err).toBe(1);
    expect(s.io.err).toContain("datanotes: the vault holds more than one database");
    expect(fs.existsSync(path.join(s.store, "engine.lock"))).toBe(false);
  }, 90_000);
});
