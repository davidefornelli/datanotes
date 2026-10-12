import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { history } from "../src/core/transaction-log";
import { listMigrations, readJournal } from "../src/core/journal";
import { createHandlers } from "../src/server/rest";
import { HttpApiServer } from "../src/server/http-server";
import { parseActor } from "../src/core/actor";
import { createDbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

/** The HTTP API over a test vault, and a POST helper. */
async function serve(handlers: ConstructorParameters<typeof HttpApiServer>[0]["handlers"], app: ConstructorParameters<typeof HttpApiServer>[0]["app"]) {
  const server = new HttpApiServer({ app, handlers, token: "owner-token-0123", port: 0 });
  const port = await server.start();
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/datanotes${path}`, { method: "POST", headers: { Authorization: "Bearer owner-token-0123", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as unknown };
  };
  return { call, stop: () => server.stop() };
}

describe("actor of a request", () => {
  it("parses the header and ignores junk", () => {
    expect(parseActor('{"harness":"claude-code","model":"m1","x":1,"session":""}')).toEqual({ harness: "claude-code", model: "m1" });
    expect(parseActor("not json")).toBeUndefined();
    expect(parseActor(undefined)).toBeUndefined();
  });

  it("is recorded in the journal and in the transaction log; hand edits have none", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    await createTable(v.app, v.settings, described({ schema: "metrics", name: "mood", timeColumn: "occurred_at", columns: [
      { name: "occurred_at", type: "datetime", required: true, dense: true },
      { name: "value", type: "integer", dense: true },
    ] }));
    const { call, stop } = await serve(createHandlers(v.app, () => v.settings, async () => {}), v.app);
    const actor = JSON.stringify({ session: "s1", harness: "claude-code", model: "claude-opus-5-5", tool: "insert_row" });
    const r = await call("/operations/insert_row/", { table: "mood", values: { occurred_at: "2026-10-01T09:00", value: 3 } }, { "x-datanotes-actor": actor });
    expect(r.status).toBe(200);
    const id = (r.json as { migration_id: string }).migration_id;
    expect((await readJournal(v.app, v.settings, id)).entry.actor).toMatchObject({ session: "s1", harness: "claude-code", model: "claude-opus-5-5", tool: "insert_row" });
    const [latest, created] = await history(v.app, v.settings, "main.metrics.mood");
    expect(latest!.userName).toBe("claude-code / claude-opus-5-5");
    expect(latest!.actor?.session).toBe("s1");
    expect(created!.userName).toBeUndefined(); // create_table ran outside a request
    expect((await listMigrations(v.app, v.settings, { limit: 1 })).migrations[0]!.by).toBe("claude-code / claude-opus-5-5");
    // undo through REST: the UNDO commit has the actor too
    const u = await call("/operations/undo_migration/", { migration_id: id }, { "x-datanotes-actor": actor });
    expect(u.status).toBe(200);
    expect((await history(v.app, v.settings, "main.metrics.mood"))[0]!.userName).toBe("claude-code / claude-opus-5-5");
    // a request without the header carries no actor
    const plain = await call("/operations/insert_row/", { table: "mood", values: { occurred_at: "2026-10-01T10:00", value: 2 } });
    expect((await readJournal(v.app, v.settings, (plain.json as { migration_id: string }).migration_id)).entry.actor).toEqual({ auth: "owner" });
    await stop();
  });
});
