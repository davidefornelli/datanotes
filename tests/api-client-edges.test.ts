import { describe, expect, it } from "vitest";
import { ACTOR_HEADER, DatanotesClient, DatanotesError, trimTrailingSlashes, type HttpRequest, type HttpResponse, type Transport } from "../src/api/client";
import { localDocs } from "../src/api/guidance";
import { guidedTextOf } from "./helpers/guidance";

const ENGINE = "http://engine.test:27199";
const TOKEN = "tok-0123456789abcdef";

/** A transport that records every request and answers from `answer` (a response, or an error to throw). */
function fake(answer: (req: HttpRequest) => HttpResponse | Error = () => ({ status: 200, text: "{}" })) {
  const sent: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    sent.push(req);
    const a = answer(req);
    if (a instanceof Error) throw a;
    return a;
  };
  return { sent, transport };
}

const json = (status: number, body: unknown): HttpResponse => ({ status, text: JSON.stringify(body) });

/** The DatanotesError a promise rejects with, as plain fields. */
async function failure(p: Promise<unknown>): Promise<{ error: unknown; name: string; message: string; kind: string; status: number }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DatanotesError);
    const d = e as DatanotesError;
    return { error: e, name: d.name, message: d.message, kind: d.kind, status: d.status };
  }
  throw new Error("expected a rejection");
}

describe("request: what is sent", () => {
  it("sends the token, the JSON body and the actor; the address loses its trailing slashes", async () => {
    const f = fake(() => json(200, { tables: [] }));
    const c = new DatanotesClient({ url: `${ENGINE}//`, token: TOKEN, actor: { harness: "my-agent", model: "m-1" }, transport: f.transport });
    expect(c.url).toBe(ENGINE);
    const r = await c.request("POST", "/datanotes/operations/list_tables/", { a: 1 });
    expect(r).toEqual({ status: 200, json: { tables: [] }, text: '{"tables":[]}' });
    expect(f.sent).toEqual([
      {
        url: `${ENGINE}/datanotes/operations/list_tables/`,
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", [ACTOR_HEADER]: '{"harness":"my-agent","model":"m-1"}' },
        body: '{"a":1}',
      },
    ]);
  });

  it("a GET has no body nor content type; accept is passed; an empty actor sends no header", async () => {
    const f = fake(() => ({ status: 200, text: "# Note\n" }));
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: f.transport });
    const r = await c.request("GET", "/vault/A.md", undefined, { accept: "text/markdown", actor: {} });
    expect(r).toEqual({ status: 200, json: undefined, text: "# Note\n" }); // not JSON: text only
    expect(f.sent).toEqual([{ url: `${ENGINE}/vault/A.md`, method: "GET", headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/markdown" } }]);
  });

  it("a call's own actor replaces the client's", async () => {
    const f = fake(() => json(200, {}));
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, actor: { harness: "client" }, transport: f.transport });
    await c.request("POST", "/datanotes/operations/list_tables/", {}, { actor: { harness: "agent", tool: "list_tables" } });
    expect(f.sent[0]!.headers[ACTOR_HEADER]).toBe('{"harness":"agent","tool":"list_tables"}');
  });

  it("an empty answer is no JSON", async () => {
    const f = fake(() => ({ status: 204, text: "  \n" }));
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: f.transport });
    expect(await c.request("POST", "/datanotes/x/", {})).toEqual({ status: 204, json: undefined, text: "  \n" });
    expect(await c.post("/x/")).toBeUndefined();
  });
});

describe("request: errors", () => {
  it("refuses to send without an address or a token", async () => {
    const f = fake();
    expect(await failure(new DatanotesClient({ url: "", token: TOKEN, transport: f.transport }).request("GET", "/"))).toMatchObject({
      name: "DatanotesError",
      message: guidedTextOf("engine address not set"),
      kind: "unreachable",
      status: 0,
    });
    expect(await failure(new DatanotesClient({ url: "/", token: TOKEN, transport: f.transport }).call("list_tables"))).toMatchObject({
      message: guidedTextOf("engine address not set"),
      kind: "unreachable",
    });
    expect(await failure(new DatanotesClient({ url: ENGINE, token: "", transport: f.transport }).post("/operations/list_tables/"))).toMatchObject({
      message: guidedTextOf("token not set"),
      kind: "auth",
      status: 0,
    });
    expect(f.sent).toEqual([]);
  });

  it("a transport that throws means the engine is unreachable", async () => {
    const down = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => new Error("connect ECONNREFUSED 127.0.0.1:27199")).transport });
    const e = await failure(down.call("list_tables"));
    expect(e.error).toBeInstanceOf(DatanotesError);
    expect(e.error).toBeInstanceOf(Error);
    expect(e).toMatchObject({ message: guidedTextOf(`engine unreachable at ${ENGINE}: connect ECONNREFUSED 127.0.0.1:27199`), kind: "unreachable", status: 0 });
    // the hint is also a field of its own
    expect(e.error).toMatchObject({ hint: expect.stringContaining("datanotes serve"), docs: "https://datanotes.dev/start/connect-agents.md#how-the-mcp-server-reaches-the-engine" });
    // a transport may throw something that is not an Error (Obsidian's requestUrl, a string)
    const odd: Transport = async () => {
      throw "socket hang up";
    };
    expect(await failure(new DatanotesClient({ url: ENGINE, token: TOKEN, transport: odd }).request("POST", "/datanotes/operations/list_tables/", {}))).toMatchObject({
      message: guidedTextOf(`engine unreachable at ${ENGINE}: socket hang up`),
      kind: "unreachable",
    });
  });

  it("status 0, 502, 503 and 504 mean the engine is unreachable (a proxy answered)", async () => {
    for (const status of [0, 502, 503, 504]) {
      const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => ({ status, text: "Bad Gateway" })).transport });
      expect(await failure(c.call("list_tables"))).toMatchObject({ message: guidedTextOf(`engine unreachable at ${ENGINE} (HTTP ${status})`), kind: "unreachable", status });
    }
    // a 503 whose body is JSON but no engine answer (a proxy's own JSON page) is a proxy too
    for (const text of ["{}", "[]", JSON.stringify({ message: "Service Unavailable" })]) {
      const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => ({ status: 503, text })).transport });
      expect(await failure(c.call("list_tables"))).toMatchObject({ kind: "unreachable", status: 503 });
    }
  });

  it("503 with an engine answer is the engine's: a write rolled back, the engine stopping", async () => {
    // a write that failed partway and was rolled back: nothing written, send it again later
    const rolledBack = { ok: false, op: "update_rows", migration_id: "m1", failed: [{ path: "datanotes/main/public/film/Nosferatu.md", error: "EBUSY: resource busy or locked" }], rolled_back: true, notes_changed: 0 };
    const w = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => json(503, rolledBack)).transport });
    const r = await w.call("update_rows", { table: "film", where: {}, set: { status: "watched" } });
    expect(r.ok).toBe(false);
    expect(r.value).toContain("EBUSY");
    expect(await w.request("POST", "/datanotes/operations/update_rows/", {})).toMatchObject({ status: 503, json: rolledBack });
    // the engine stopping: an error with its hint, thrown by post as an answer (kind http)
    const stopping = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => json(503, { error: "the engine is stopping", hint: "Wait for the stop, then start the engine again.", docs: "https://datanotes.dev/administration/run-the-service.md#stop-the-engine" })).transport });
    expect(await failure(stopping.post("/database/"))).toMatchObject({ kind: "http", status: 503, message: expect.stringContaining("the engine is stopping") });
  });

  it("401 is a refused token", async () => {
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => json(401, { error: "unauthorized" })).transport });
    expect(await failure(c.call("select_rows", { table: "log" }))).toMatchObject({ message: guidedTextOf("token refused by the engine"), kind: "auth", status: 401 });
  });

  it("other errors are answers: call returns them, post throws them", async () => {
    const f = fake(() => json(404, { error: "Table not found: nope" }));
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: f.transport });
    expect(await c.call("select_rows", { table: "nope" })).toEqual({ ok: false, value: "Table not found: nope" });
    expect(await failure(c.post("/operations/select_rows/", { table: "nope" }))).toMatchObject({ message: "Table not found: nope", kind: "http", status: 404 });
    // an answer with guidance: the message ends with it, and the error has it as fields too
    const guidedAnswer = { error: "Table not found: flim", hint: 'Did you mean "film"?', docs: "https://datanotes.dev/guides/database-objects/tables.md#find-the-table-that-matches-a-request" };
    const g = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => json(404, guidedAnswer)).transport });
    const text = `Table not found: flim\nHint: Did you mean "film"?\nDocs: ${guidedAnswer.docs} (offline: ${localDocs(guidedAnswer.docs)})`;
    expect(await g.call("select_rows", { table: "flim" })).toEqual({ ok: false, value: text });
    const thrown = await failure(g.post("/operations/select_rows/", { table: "flim" }));
    expect(thrown).toMatchObject({ message: text, kind: "http", status: 404 });
    expect(thrown.error).toMatchObject({ hint: guidedAnswer.hint, docs: guidedAnswer.docs });
    const plain = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => ({ status: 500, text: "boom\n" })).transport });
    expect(await failure(plain.post("/operations/list_tables/"))).toMatchObject({ message: "boom", kind: "http", status: 500 });
    const empty = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => ({ status: 418, text: "" })).transport });
    expect(await failure(empty.post("/operations/list_tables/"))).toMatchObject({ message: "HTTP 418", kind: "http", status: 418 });
  });
});

describe("call", () => {
  it("builds the operation's request: its route, the arguments as they are", async () => {
    const f = fake((req) => (req.url.endsWith("/read_note/") ? json(200, { path: "A b/c.md" }) : json(200, { ok: true })));
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: f.transport });
    expect(await c.call("update_row", { table: "log", path: "Daily/a.md", set: { metric_drinks: 3 }, body: null })).toEqual({ ok: true, value: { ok: true } });
    expect(await c.call("read_note", { path: "A b/c.md" })).toEqual({ ok: true, value: { path: "A b/c.md" } });
    expect(f.sent.map((r) => [r.method, r.url, r.headers.Accept ?? null, r.body ?? null])).toEqual([
      ["POST", `${ENGINE}/datanotes/operations/update_row/`, null, '{"table":"log","path":"Daily/a.md","set":{"metric_drinks":3}}'],
      ["POST", `${ENGINE}/datanotes/operations/read_note/`, null, '{"path":"A b/c.md"}'],
    ]);
  });

  it("bad arguments are a refusal and nothing is sent", async () => {
    const f = fake();
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: f.transport });
    expect(await c.call("nope")).toEqual({ ok: false, value: guidedTextOf("unknown operation: nope") });
    expect(await c.call("selct_rows")).toEqual({ ok: false, value: expect.stringContaining('Hint: Did you mean "select_rows"?') });
    expect(await c.call("alter_table", { table: "log", history: "maybe" })).toEqual({ ok: false, value: guidedTextOf(`alter_table: "history" must be a boolean or "default", not string "maybe"`) });
    expect(await c.call("read_note", {})).toEqual({ ok: false, value: guidedTextOf(`read_note: missing required argument "path" (string)`) });
    expect(await c.call("update_rows", { table: "log", where: {}, set_values: { a: 1 } })).toEqual({ ok: false, value: expect.stringMatching(/^update_rows: unknown argument "set_values"\nHint: For "set_values" use "set"\. /) });
    expect(f.sent).toEqual([]);
  });

  it("arguments that are not an object are a programming error, thrown as is", async () => {
    const f = fake();
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: f.transport });
    await expect(c.call("select_rows", null as unknown as Record<string, unknown>)).rejects.toThrow(TypeError);
    expect(f.sent).toEqual([]);
  });
});

describe("the engine's operations only", () => {
  it("answers a name that is no engine operation without a request: other programs' tools live in their own MCP servers", async () => {
    const f = fake();
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: f.transport });
    expect(await c.call("pick_film_for_tonight", { max_minutes: 120 })).toEqual({ ok: false, value: guidedTextOf("unknown operation: pick_film_for_tonight") });
    expect(f.sent).toEqual([]);
    for (const gone of ["invoke", "appTools", "callAppTool"]) expect(gone in c).toBe(false);
  });
});

describe("recordToolCall", () => {
  const CALL = { tool: "select_rows", args: { table: "log" }, ok: true, duration_ms: 12, value: { total: 2 }, served_by: "engine", session: "s1", result_chars: 40, result_tokens: 10 };

  it("posts the call to the change feed, as the given actor", async () => {
    const f = fake(() => json(200, { ok: true, takes_summary: true }));
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, actor: { harness: "client" }, transport: f.transport });
    // the engine's answer: it takes a value sent cut, with its summary
    expect(await c.recordToolCall(CALL, { harness: "claude-code", model: "m" })).toEqual({ ok: true, takes_summary: true });
    expect(f.sent).toEqual([
      {
        url: `${ENGINE}/datanotes/tool-calls/record/`,
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", [ACTOR_HEADER]: '{"harness":"claude-code","model":"m"}' },
        body: JSON.stringify(CALL),
      },
    ]);
  });

  it("a refused record throws", async () => {
    const c = new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => json(400, { error: `"tool" is required` })).transport });
    expect(await failure(c.recordToolCall({ ...CALL, tool: "" }))).toMatchObject({ message: `"tool" is required`, kind: "http", status: 400 });
  });
});

describe("ping", () => {
  it("asks GET / without a token and tells whether the engine answered 200", async () => {
    const f = fake(() => ({ status: 200, text: "ok" }));
    expect(await new DatanotesClient({ url: ENGINE, token: "", transport: f.transport }).ping()).toBe(true);
    expect(f.sent).toEqual([{ url: `${ENGINE}/`, method: "GET", headers: {} }]);
    expect(await new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => ({ status: 503, text: "" })).transport }).ping()).toBe(false);
    expect(await new DatanotesClient({ url: ENGINE, token: TOKEN, transport: fake(() => new Error("ECONNRESET")).transport }).ping()).toBe(false);
  });
});

describe("trimTrailingSlashes", () => {
  it("removes every trailing slash and nothing else", () => {
    expect(["http://x/", "http://x///", "http://x", "", "///", "http://x//y/"].map(trimTrailingSlashes)).toEqual(["http://x", "http://x", "http://x", "", "", "http://x//y"]);
    expect(new DatanotesClient({ url: "http://x///", token: TOKEN }).url).toBe("http://x");
  });

  it("is linear: 100000 slashes followed by a character take under 50 ms", () => {
    const s = "/".repeat(100000) + "x";
    const t0 = performance.now();
    expect(trimTrailingSlashes(s)).toBe(s);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
