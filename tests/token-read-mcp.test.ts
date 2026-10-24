/**
 * Read permissions through the real MCP server (`datanotes mcp`, stdio): the server forwards a
 * restricted token (`cook`, reads `personal.food.*`) to a real engine, and an agent that asks for
 * a table the token may not read gets a tool error that says so, how to get the read, and where
 * to read more, like every other refusal.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READ_DENIED_GUIDANCE } from "../src/core/read-scope";
import { mcp, type McpRun } from "../src/mcp/command";
import { fakeIo, StreamClientTransport } from "./helpers/mcp";
import { expectNoLeak, startReadEngine, WEIGHT, type ReadEngine } from "./helpers/read-tokens";

let engine: ReadEngine;
let run: McpRun;
let agent: Client;

beforeAll(async () => {
  engine = await startReadEngine();
  const io = fakeIo({ DATANOTES_TOKEN: engine.secrets.cook });
  run = (await mcp(["--url", engine.url.replace(/\/datanotes$/, "")], "9.9.9", io))!;
  agent = new Client({ name: "cooking-agent", version: "1" });
  await agent.connect(new StreamClientTransport(io.stdin, io.stdout));
}, 60_000);

afterAll(async () => {
  await agent?.close();
  await run?.stop();
  await engine?.dispose();
});

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

describe("a restricted token through the MCP server", () => {
  it("select_rows on a table the token may not read is a tool error ending with the Hint and Docs lines", async () => {
    for (const table of ["weight", WEIGHT]) {
      const r = (await agent.callTool({ name: "select_rows", arguments: { table } })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(r.content).toEqual([
        {
          type: "text",
          text: `token cook may not read ${WEIGHT}\nHint: ${READ_DENIED_GUIDANCE.hint}\nDocs: read_docs("guides/security/tokens#limit-what-a-token-can-read")`,
        },
      ]);
    }
  });

  it("reads a table the token may read, without the health data", async () => {
    const r = (await agent.callTool({ name: "select_rows", arguments: { table: "pantry", columns: ["item", "for_weight"], expand: ["for_weight"], order_by: "item" } })) as ToolResult & { structuredContent?: { rows: { item: string }[] } };
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent!.rows.map((row) => row.item)).toEqual(["eggs", "flour"]);
    expectNoLeak(r);
  });
});
