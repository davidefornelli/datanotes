import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import esbuild from "esbuild";
import { serviceBuildOptions } from "../scripts/service-build.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localEngine, storeLocation } from "../src/api/local";
import { docsFixture } from "./helpers/docs-fixture";
import { copyTestVault, freePort, openTestVault, type TestVault } from "./helpers/test-vault";
import { seedStoreSettings } from "./helpers/store-settings";

// `datanotes mcp` as it ships: src/node/cli.ts bundled the way esbuild.service.mjs bundles
// dist/datanotes.cjs (the MCP SDK inside it), copied to a folder with no node_modules, and run as
// an MCP client starts it.

let dir = "";
let bin = "";
let vault: TestVault;
const temp: string[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-mcp-bundle-"));
  bin = path.join(dir, "datanotes.cjs");
  await esbuild.build({ ...serviceBuildOptions({ outfile: bin, version: "0.0.0-test" }), absWorkingDir: path.resolve(__dirname, ".."), logLevel: "error" });
  vault = await openTestVault("service");
}, 60_000);

afterAll(async () => {
  await vault?.stop();
  for (const d of [dir, ...temp]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * The environment of the command: the MCP SDK passes only a few variables (PATH, HOME...) by
 * default, and the engine it starts must keep its store in the tests' data home.
 */
const ENV = { ...process.env } as Record<string, string>;

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe("datanotes mcp: the built command", () => {
  it("prints its help, and is listed by datanotes --help", () => {
    const own = spawnSync(process.execPath, [bin, "mcp", "--help"], { cwd: dir, encoding: "utf8" });
    expect(own.status).toBe(0);
    expect(own.stdout).toMatch(/^datanotes mcp 0\.0\.0-test: the MCP server of Datanotes/);
    const main = spawnSync(process.execPath, [bin, "--help"], { cwd: dir, encoding: "utf8" });
    expect(main.stdout).toContain("datanotes mcp serve [options]");
    const bad = spawnSync(process.execPath, [bin, "mcp"], { cwd: dir, encoding: "utf8", env: { ...process.env, DATANOTES_VAULT: "", DATANOTES_URL: "" } });
    expect([bad.status, bad.stderr]).toEqual([1, expect.stringMatching(/^datanotes mcp: pass --database/)]);
  });

  it("stdio on the engine running on the vault", async () => {
    const client = new Client({ name: "bundle-agent", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--vault", vault.root], cwd: dir, env: ENV, stderr: "ignore" }));
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "datanotes", version: "0.0.0-test" });
      const r = await client.callTool({ name: "list_tables", arguments: {} });
      expect(text(r)).toContain("person");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("the docs tools read the docs next to the bundle (dist/docs in the package), with no engine", async () => {
    const docs = docsFixture();
    temp.push(docs);
    fs.cpSync(docs, path.join(dir, "docs"), { recursive: true });
    const client = new Client({ name: "bundle-agent", version: "1" });
    const env = { ...process.env, DATANOTES_TOKEN: "no-engine-needed", DATANOTES_DOCS_DIR: "" } as Record<string, string>;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--url", `http://127.0.0.1:${await freePort()}`], cwd: os.tmpdir(), env, stderr: "ignore" }));
    try {
      expect(text(await client.callTool({ name: "list_docs", arguments: { prefix: "examples/" } }))).toMatch(/^1 pages\.[^\n]+\nexamples\/queries: Querying rows/);
      expect(text(await client.callTool({ name: "read_docs", arguments: { path: "examples/queries#store-a-query-as-a-view" } }))).toMatch(/^## Store a query as a view\n/);
      expect(text(await client.callTool({ name: "search_docs", arguments: { query: "compare values" } }))).toMatch(/^examples\/queries#compare-values-with-operators /);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("stdio on a vault with no engine: starts `datanotes serve` from the same file, and stops it with the session", async () => {
    const root = copyTestVault();
    temp.push(root);
    seedStoreSettings(root, { httpServerPort: await freePort(), httpServerToken: "bundle-owner-token", fileLogEnabled: false });
    const client = new Client({ name: "bundle-agent", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--vault", root], cwd: dir, env: ENV, stderr: "ignore" }));
    try {
      expect(localEngine(root)).not.toBeNull();
      const r = await client.callTool({ name: "insert_row", arguments: { table: "person", values: { name: "Bundle Person" } } });
      expect(r.isError, text(r)).toBeFalsy();
      expect(fs.existsSync(path.join(root, "datanotes", "work", "planning", "person", "Bundle Person.md"))).toBe(true);
    } finally {
      await client.close();
    }
    // the engine stopped with the session: its lock is no longer renewed (or is gone)
    const lock = path.join(storeLocation(root)!.store, "engine.lock");
    const pid = fs.existsSync(lock) ? (JSON.parse(fs.readFileSync(lock, "utf8")) as { pid: number }).pid : 0;
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && pid && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(pid && alive(pid)).toBeFalsy();
    // asked to stop (POST /datanotes/stop/), not killed: it released its lock on the way out
    expect(fs.existsSync(lock)).toBe(false);
  }, 90_000);
});
