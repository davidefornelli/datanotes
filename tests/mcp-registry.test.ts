/**
 * The MCP Registry entry (server.json, name = package.json mcpName) and the release that publishes
 * the npm package it points to (.github/workflows/release.yml).
 */

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

type Argument = { type: string; name?: string; value?: string; valueHint?: string; isRequired?: boolean };
type ServerJson = {
  $schema: string;
  name: string;
  description: string;
  version: string;
  repository: { url: string; source: string };
  packages: { registryType: string; identifier: string; version: string; transport: { type: string }; packageArguments: Argument[] }[];
};
const pkg = JSON.parse(read("package.json")) as { name: string; version: string; mcpName: string; repository: { url: string } };
const server = JSON.parse(read("server.json")) as ServerJson;

describe("server.json, the MCP Registry entry", () => {
  it("is the npm package's server, under the mcpName of package.json", () => {
    expect(pkg.mcpName).toBe("io.github.davidefornelli/datanotes");
    expect(server.name).toBe(pkg.mcpName);
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
    // the registry caps the description at 100 characters
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(pkg.repository.url).toContain(server.repository.url.replace(/^https:\/\//, ""));
    expect(server.packages).toHaveLength(1);
    const [npm] = server.packages;
    expect([npm!.registryType, npm!.identifier, npm!.transport.type]).toEqual(["npm", pkg.name, "stdio"]);
  });

  it("carries the version of package.json, so a release keeps them equal", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]!.version).toBe(pkg.version);
    // the release refuses to publish when they differ
    const release = read(".github/workflows/release.yml");
    expect(release).toContain(`test "$v" = "v$(node -p "require('./server.json').version")"`);
    expect(release).toContain(`test "$v" = "v$(node -p "require('./server.json').packages[0].version")"`);
  });

  it("starts `datanotes mcp --database <folder>`", () => {
    const args = server.packages[0]!.packageArguments;
    expect(args.map((a) => a.value ?? a.name)).toEqual(["mcp", "--database"]);
    expect(args[0]!.type).toBe("positional");
    expect(args[1]).toMatchObject({ type: "named", valueHint: "folder", isRequired: true });
  });
});

describe("the release workflow", () => {
  type Job = { needs?: string[]; environment?: string; permissions?: Record<string, string>; steps: { run?: string; uses?: string }[] };
  const workflow = parse(read(".github/workflows/release.yml")) as { permissions: Record<string, string>; jobs: Record<string, Job> };
  const jobs = workflow.jobs;

  it("publishes in the environment npm, the only job with id-token: write", () => {
    const publishing = Object.entries(jobs).filter(([, j]) => j.steps.some((s) => s.run?.includes("npm publish")));
    expect(publishing.map(([name]) => name)).toEqual(["publish"]);
    expect(jobs.publish!.environment).toBe("npm");
    expect(jobs.publish!.permissions?.["id-token"]).toBe("write");
    expect(workflow.permissions["id-token"]).toBeUndefined();
    for (const [name, job] of Object.entries(jobs)) if (name !== "publish") expect(job.permissions?.["id-token"], name).toBeUndefined();
  });

  it("installs an exact npm version", () => {
    const installs = Object.values(jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).filter((r) => /npm install -g npm@/.test(r));
    expect(installs.length).toBeGreaterThan(0);
    for (const r of installs) expect(r).toMatch(/npm@\d+\.\d+\.\d+$/);
  });

  it("tests the package before it publishes it", () => {
    expect(jobs.publish!.needs).toContain("package");
    expect(jobs.package!.needs).toContain("test-macos");
    const runs = jobs.package!.steps.map((s) => s.run ?? "");
    expect(runs.indexOf("npm test")).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf("npm test")).toBeLessThan(runs.indexOf("npm pack"));
  });
});
