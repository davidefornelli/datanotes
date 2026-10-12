import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex, tableAllowed } from "../src/server/tokens";
import { startService, type RunningService } from "../src/node/service";
import { METASTORE, withTables } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of running.splice(0).reverse()) await s.stop();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

const YAML = withTables(`task:
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: title, type: string, required: true }
`);

describe("tokens: pieces", () => {
  it("matches table patterns", () => {
    expect(tableAllowed("main.public.log", ["main.public.log"])).toBe(true);
    expect(tableAllowed("main.public.log", ["main.public.*"])).toBe(true);
    expect(tableAllowed("main.public.log", ["main.*"])).toBe(true);
    expect(tableAllowed("main.public.log", ["*"])).toBe(true);
    expect(tableAllowed("main.public.log", ["main.public.task", "other.*"])).toBe(false);
    expect(tableAllowed("main.public.log", [])).toBe(false);
  });
});

async function engine(prefix: string, files: Record<string, string> = {}) {
  const p = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, "Datanotes"), { recursive: true });
  fs.writeFileSync(path.join(root, METASTORE), YAML);
  seedStoreSettings(root, { httpServerPort: p, httpServerToken: "owner-token", fileLogEnabled: false, autoRecompute: false }, METASTORE);
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  const svc: RunningService = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
  running.push(svc);
  const base = `http://127.0.0.1:${p}`;
  const call = async (route: string, body: unknown, token: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  return { root, base, call, store: svc.store.store };
}

describe("tokens: registry, permissions, identity in the journal", () => {
  it("lets a named token write within its permissions, and the journal names it", async () => {
    const { base, call, store } = await engine("tokens-");

    // the owner creates the token; it is shown once and stored hashed
    const created = await call("/datanotes/tokens/create/", { name: "walker", description: "walks", write: ["main.public.log"] }, "owner-token");
    expect(created.status).toBe(200);
    const token = created.json.token as string;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(created.json.entry).toMatchObject({ name: "walker", write: ["main.public.log"], ddl: false });
    const stored = fs.readFileSync(path.join(store, "tokens.json"), "utf8");
    expect(stored).not.toContain(token);

    // permissions
    expect((await call("/datanotes/operations/select_rows/", { table: "log" }, token)).status).toBe(200);
    expect((await call("/datanotes/operations/insert_row/", { table: "task", values: { title: "x" } }, token)).status).toBe(403);
    expect((await call("/datanotes/operations/batch/", { operations: [{ op: "insert_row", table: "task", values: { title: "x" } }] }, token)).json.error).toMatch(/operation 0: token walker may not write main\.public\.task/);
    expect((await call("/datanotes/operations/drop_table/", { table: "task" }, token)).status).toBe(403);
    expect((await call("/datanotes/tokens/", {}, token)).status).toBe(403);
    expect((await call("/datanotes/tokens/update/", { write: ["*"] }, token)).status).toBe(403);
    expect((await call("/datanotes/tokens/me/", {}, token)).json.entry.name).toBe("walker");
    expect((await call("/datanotes/operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-10-01T09:00" } }, token)).status).toBe(200);
    expect((await call("/datanotes/operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-10-01T09:00" } }, "wrong-token-123456789")).status).toBe(401);

    // a program's own MCP server writes for an agent with its token, and reports the agent's model
    const agent = { "X-Datanotes-Actor": JSON.stringify({ harness: "test-agent", session: "sess-agent-0001", tool: "log_walk" }) };
    expect((await call("/datanotes/sessions/identify/", { session: "sess-agent-0001", model: "opus-x" }, token)).status).toBe(200);
    expect((await call("/datanotes/operations/insert_row/", { table: "log", values: { kind: "walk", occurred_at: "2026-10-02T18:00" } }, token, agent)).status).toBe(200);
    const by = (await call("/datanotes/operations/list_migrations/", { op: "insert_row" }, "owner-token")).json.migrations.map((m: { by: string }) => m.by);
    expect(by).toEqual(["test-agent / opus-x via walker", "walker"]);

    // the journal records the credential as `auth`: the token's name, or "owner"
    await call("/datanotes/operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-10-01T10:00" } }, "owner-token", agent);
    const jdir = path.join(store, "journal");
    const journal = fs.readdirSync(jdir).map((f) => fs.readFileSync(path.join(jdir, f), "utf8")).join("");
    expect(journal).toMatch(/"harness":"walker","auth":"walker"/);
    expect(journal).toMatch(/"harness":"test-agent".*"auth":"walker"/);
    expect(journal).toMatch(/"harness":"test-agent".*"auth":"owner"/);
    expect(journal).not.toMatch(/"app":/);

    // tool calls an MCP server reports, its own tools included, are change-feed events for those who ask
    const rec = { tool: "log_walk", args: { when: "2026-10-02T18:00" }, ok: true, duration_ms: 12, value: { written: true }, served_by: "walker", session: "sess-agent-0001", result_chars: 16, result_tokens: 8 };
    expect((await call("/datanotes/tool-calls/record/", rec, token, agent)).status).toBe(200);
    expect((await call("/datanotes/tool-calls/record/", {}, "owner-token")).status).toBe(400);
    const all = await call("/datanotes/operations/list_changes/", { since: 0 }, "owner-token");
    expect((all.json.events as { kind: string }[]).some((e) => e.kind === "tool_call")).toBe(false);
    const calls = await call("/datanotes/operations/list_changes/", { since: 0, kinds: ["tool_call"] }, "owner-token");
    const ev = (calls.json.events as { actor?: Record<string, unknown>; call: Record<string, unknown> }[]).find((e) => e.call.tool === "log_walk");
    expect(ev?.call).toMatchObject({ served_by: "walker", ok: true, result_chars: 16, result_tokens: 8, summary: { written: true } });
    expect(ev?.actor).toMatchObject({ harness: "test-agent", auth: "walker" });

    // the engine no longer serves other programs' tools
    for (const route of ["/datanotes/apps/tools/", "/datanotes/apps/call/", "/datanotes/apps/", "/datanotes/apps/create/"]) {
      const gone = await call(route, { tool: "log_walk" }, "owner-token");
      expect([gone.status, gone.json.error]).toEqual([404, `unknown route ${route}`]);
    }
    // describe_table lists no tools of other programs
    expect((await call("/datanotes/operations/describe_table/", { table: "log" }, "owner-token")).json).not.toHaveProperty("tools");

    // OpenAPI
    const doc = (await (await fetch(`${base}/datanotes/openapi.json`)).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/datanotes/tokens/create/", "/datanotes/tokens/rotate/", "/datanotes/tool-calls/record/"]));
    expect(Object.keys(doc.paths).filter((p) => p.includes("/apps/"))).toEqual([]);

    // the status lists the tokens and their permissions, never their values
    const status = await call("/datanotes/status/", {}, "owner-token");
    expect(status.json.tokens).toEqual([{ name: "walker", write: ["main.public.log"], ddl: false, maintain: false, last_seen: expect.any(String) }]);
    expect(JSON.stringify(status.json)).not.toContain(token);

    // rotate and revoke
    const rotated = (await call("/datanotes/tokens/rotate/", { name: "walker" }, "owner-token")).json.token as string;
    expect((await call("/datanotes/operations/select_rows/", { table: "log" }, token)).status).toBe(401);
    expect((await call("/datanotes/operations/select_rows/", { table: "log" }, rotated)).status).toBe(200);
    expect((await call("/datanotes/tokens/delete/", { name: "walker" }, "owner-token")).json.deleted).toBe(true);
    expect((await call("/datanotes/operations/select_rows/", { table: "log" }, rotated)).status).toBe(401);
  }, 30_000);

});

describe("tokens: the autolink default", () => {
  it("gives a token's writes its autolink default; a write's own wins; null follows the database", async () => {
    const { root, call } = await engine("tokens-autolink-", { "Oscar Reed.md": "A friend.\n" });
    const body = (p: string) => fs.readFileSync(path.join(root, p), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const text = "Call Oscar Reed about the boiler.\n";

    // a sync program's token: its text stays as it came
    const created = await call("/datanotes/tokens/create/", { name: "tasks-sync", write: ["main.public.task"], autolink: false }, "owner-token");
    expect(created.json.entry).toMatchObject({ name: "tasks-sync", autolink: false });
    const sync = created.json.token as string;
    const plain = await call("/datanotes/operations/insert_row/", { table: "task", values: { title: "a" }, path: "Tasks/a.md", body: text }, sync);
    expect(plain.status).toBe(200);
    expect(plain.json.links_added).toBeUndefined();
    expect(body("Tasks/a.md")).toBe(text);
    // in a batch too, and a write's own autolink wins
    const batch = await call("/datanotes/operations/batch/", {
      operations: [
        { op: "insert_row", table: "task", values: { title: "b" }, path: "Tasks/b.md", body: text },
        { op: "update_row", table: "task", path: "Tasks/a.md", body: text, autolink: true },
      ],
    }, sync);
    expect(batch.status).toBe(200);
    expect(body("Tasks/b.md")).toBe(text);
    expect(body("Tasks/a.md")).toBe("Call [[Oscar Reed]] about the boiler.\n");

    // listed with the entry; null follows the database's setting (on) again
    expect((await call("/datanotes/tokens/", {}, "owner-token")).json.tokens).toEqual([expect.objectContaining({ name: "tasks-sync", autolink: false })]);
    const reset = await call("/datanotes/tokens/update/", { name: "tasks-sync", autolink: null }, "owner-token");
    expect(reset.json.entry).not.toHaveProperty("autolink");
    const linked = await call("/datanotes/operations/update_row/", { table: "task", path: "Tasks/b.md", body: text }, sync);
    expect(linked.json.links_added).toEqual([expect.objectContaining({ text: "Oscar Reed" })]);

    // a token may set its own default; a wrong value is refused with how to fix it
    expect((await call("/datanotes/tokens/update/", { autolink: false }, sync)).json.entry).toMatchObject({ autolink: false });
    const bad = await call("/datanotes/tokens/update/", { autolink: "off" }, sync);
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({
      error: expect.stringContaining(`"autolink" must be true or false`),
      hint: expect.stringContaining("sync program"),
      docs: expect.stringContaining("/guides/security/tokens.md#turn-automatic-links-off-for-a-sync-program"),
    });
    expect((await call("/datanotes/tokens/create/", { name: "other", autolink: 1 }, "owner-token")).status).toBe(400);
    // a token with no default writes as the database says
    const agent = (await call("/datanotes/tokens/create/", { name: "agent", write: ["*"] }, "owner-token")).json;
    expect(agent.entry).not.toHaveProperty("autolink");
    const ins = await call("/datanotes/operations/insert_row/", { table: "task", values: { title: "c" }, path: "Tasks/c.md", body: text }, agent.token as string);
    expect(ins.json.links_added).toHaveLength(1);
  }, 30_000);

  it("adds the default only to the writes that link text, and leaves a body that is no object alone", async () => {
    const { withAutolinkDefault } = await import("../src/server/tokens");
    expect(withAutolinkDefault("/operations/insert_row/", { table: "t" }, false)).toEqual({ table: "t", autolink: false });
    expect(withAutolinkDefault("/operations/update_row/", { table: "t", autolink: true }, false)).toEqual({ table: "t", autolink: true });
    expect(withAutolinkDefault("/operations/delete_rows/", { table: "t" }, false)).toEqual({ table: "t" });
    // update_rows writes no text: no default either
    expect(withAutolinkDefault("/operations/update_rows/", { table: "t" }, false)).toEqual({ table: "t" });
    expect(withAutolinkDefault("/operations/insert_row/", null, false)).toBeNull();
    expect(withAutolinkDefault("/operations/batch/", { operations: "x" }, false)).toEqual({ operations: "x" });
    expect(withAutolinkDefault("/operations/batch/", { operations: [null, { op: "delete_rows" }, { op: "update_row", autolink: null }] }, true)).toEqual({
      operations: [null, { op: "delete_rows" }, { op: "update_row", autolink: true }],
    });
    // an operation without an op name, or with one that is not a string, is left as it is (the batch refuses it)
    expect(withAutolinkDefault("/operations/batch/", { operations: [{ table: "t" }, { op: 7 }, ["insert_row"]] }, false)).toEqual({ operations: [{ table: "t" }, { op: 7 }, ["insert_row"]] });
    expect(withAutolinkDefault("/tokens/me/", { table: "t" }, false)).toEqual({ table: "t" });
  });
});

describe("token estimate", () => {
  it("counts words, numbers and symbols", async () => {
    const { estimateTokens } = await import("../src/api/tokens");
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens('{"written":true}')).toBe(8);
    expect(estimateTokens("Dinner with Carol and Dave")).toBe(7);
    expect(estimateTokens("2026-10-04")).toBe(6);
  });
});

describe("credentials: what named tokens may not do", () => {
  it("an agent's token with maintain may undo but not administer; no token makes the engine call out", async () => {
    const { base } = await engine("creds-");
    const post = async (route: string, body: unknown, token: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    };

    const agent = (await post("/datanotes/tokens/create/", { name: "assistant", write: ["*"], ddl: true, maintain: true }, "owner-token")).json;
    expect(agent.entry).toMatchObject({ maintain: true, ddl: true, write: ["*"] });
    const token = agent.token as string;
    // the agent may call itself anything: the record still says which token it used
    const ins = await post("/datanotes/operations/insert_row/", { table: "log", values: { kind: "mood", occurred_at: "2026-10-07T09:00" } }, token, { "X-Datanotes-Actor": JSON.stringify({ harness: "chat-bot", auth: "owner" }) });
    expect(ins.status).toBe(200);
    const migs = await post("/datanotes/operations/list_migrations/", { op: "insert_row" }, "owner-token");
    expect(migs.json.migrations[0].by).toBe("chat-bot via assistant");
    // maintain: undo is allowed
    expect((await post("/datanotes/operations/undo_migration/", { migration_id: migs.json.migrations[0].migration_id }, token)).status).toBe(200);
    // administration is not
    expect((await post("/datanotes/tokens/create/", { name: "evil", write: ["*"] }, token)).status).toBe(403);
    expect((await post("/datanotes/operations/create_webhook/", { url: "http://127.0.0.1:5232/" }, token)).json.error).toMatch(/reserved to the owner/);
    expect((await post("/datanotes/status/", {}, token)).status).toBe(403);

    // without maintain, a token may not undo nor make the engine call out
    const reader = (await post("/datanotes/tokens/create/", { name: "reader", write: [] }, "owner-token")).json.token as string;
    expect((await post("/datanotes/operations/undo_migration/", { migration_id: "x" }, reader)).status).toBe(403);
    const hook = await post("/datanotes/operations/create_webhook/", { url: "http://127.0.0.1:5232/" }, reader);
    expect(hook.status).toBe(403);
    expect(hook.json.error).toMatch(/reserved to the owner/);
    expect((await post("/datanotes/operations/create_webhook/", { url: "http://127.0.0.1:9/" }, "owner-token")).status).toBe(200);
  });
});
