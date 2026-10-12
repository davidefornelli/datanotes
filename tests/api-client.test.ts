import { afterEach, describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";
import { DatanotesClient, DatanotesError } from "../src/api/client";
import { CALLABLE_OPERATIONS, operationRequest } from "../src/api/requests";
import { INDEX_RETRY } from "../src/core/engine";
import { listMigrations } from "../src/core/journal";
import { newToken, HttpApiServer } from "../src/server/http-server";
import { createHandlers } from "../src/server/rest";
import { logVault, LOG_DIR } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

let server: HttpApiServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function start() {
  const v = logVault({ "Notes/Dinner.md": "Dinner with [[Alice]] and pizza.\n" });
  const token = newToken();
  server = new HttpApiServer({ app: v.app, handlers: createHandlers(v.app, () => v.settings), token, port: 0 });
  const port = await server.start();
  const url = `http://127.0.0.1:${port}`;
  return { v, url, token, client: new DatanotesClient({ url, token, actor: { harness: "test-agent" } }) };
}

describe("datanotes/client", () => {
  it("has a request for every operation of the catalogue", () => {
    expect(OPERATIONS.map((t) => t.name).filter((n) => !CALLABLE_OPERATIONS.has(n))).toEqual([]);
    expect(OPERATIONS.every((t) => (t.inputSchema as { type?: string }).type === "object")).toBe(true);
    expect(operationRequest("create_table", described({ name: "x", dry_run: true }))).toEqual({ method: "POST", path: "/datanotes/operations/create_table/", body: described({ name: "x", dry_run: true }) });
    expect(operationRequest("read_note", { path: "A b/c.md" })).toEqual({ method: "POST", path: "/datanotes/operations/read_note/", body: { path: "A b/c.md" } });
    expect(() => operationRequest("nope")).toThrow(/unknown operation/);
  });

  it("reads and writes; refusals are readable; writes record the caller", async () => {
    const { client, v } = await start();
    const sel = await client.call("select_rows", { table: "log", columns: ["kind"] });
    expect(sel.ok).toBe(true);
    expect((sel.value as { total: number }).total).toBe(2);
    const ins = await client.call("insert_row", { table: "log", values: { kind: "mood", occurred_at: "2026-09-28T09:00" } });
    expect((ins.value as { planned_creates: string[] }).planned_creates[0]!.startsWith(LOG_DIR)).toBe(true);
    const bad = await client.call("insert_row", { table: "log", values: { kind: "nope", occurred_at: "2026-09-28T10:00" } });
    expect(bad.ok).toBe(false);
    expect(bad.value).toMatch(/refused — nothing was written:\ninvalid .*kind must be one of/);
    expect((await client.call("update_row", { table: "log", path: "Daily/a.md", set: { metric_drinks: 3 } })).ok).toBe(true);
    expect(v.read("Daily/a.md")).toContain("metric_drinks: 3");
    const batch = await client.call("batch", { operations: [{ op: "update_row", table: "log", path: "Daily/a.md", set: { metric_drinks: 99 } }] });
    expect(batch.value).toMatch(/batch refused at operation 0/);
    expect((await listMigrations(v.app, v.settings, { op: "insert_row" })).migrations[0]).toMatchObject({ by: "test-agent" });
    await client.call("insert_row", { table: "log", values: { kind: "walk", occurred_at: "2026-09-28T11:00" } }, { harness: "other-agent", tool: "insert_row" });
    expect((await listMigrations(v.app, v.settings, { op: "insert_row" })).migrations[0]).toMatchObject({ by: "other-agent" });
    expect((await client.call("select_rows", { table: "nope" })).value).toMatch(/Table not found/);
    expect((await client.call("alter_table", { table: "log", history: "maybe" })).value).toMatch(/^alter_table: "history" must be a boolean or "default"/);
    expect(await client.post("/operations/list_tables/")).toBeTruthy();
  });

  it("reads notes", async () => {
    const { client } = await start();
    expect((await client.call("read_note", { path: "Notes/Dinner.md" })).value).toMatchObject({ path: "Notes/Dinner.md", content: "Dinner with [[Alice]] and pizza.\n", front_matter: {} });
    expect((await client.call("read_note", { path: "Nope.md" })).ok).toBe(false);
    expect((await client.call("list_folder", { folder: "Notes" })).value).toEqual({ folder: "Notes", folders: [], files: ["Notes/Dinner.md"] });
    expect(((await client.call("search_notes", { query: "pizza" })).value as { results: { path: string }[] }).results[0]!.path).toBe("Notes/Dinner.md");
  });

  it("tells a refused token and an engine that is not there", async () => {
    const { url } = await start();
    const wrong = new DatanotesClient({ url, token: "wrong-token-0123456789" });
    await expect(wrong.call("list_tables")).rejects.toMatchObject({ kind: "auth" });
    expect(await wrong.ping()).toBe(true);
    const gone = new DatanotesClient({ url: "http://127.0.0.1:9", token: "x" });
    await expect(gone.call("list_tables")).rejects.toBeInstanceOf(DatanotesError);
    await expect(gone.call("list_tables")).rejects.toMatchObject({ kind: "unreachable" });
    expect(await gone.ping()).toBe(false);
  });
});
