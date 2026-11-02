/**
 * View as a token (G5): the owner sends `X-Datanotes-View-As: <token name>` on a read and gets the
 * answer that named token would get. Writes, owner routes, unknown names and named tokens sending
 * the header are refused; the viewed token's `last_seen` does not move; the read cache never
 * shares an answer between the owner and the viewed token.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isViewingAs, viewingAs } from "../src/core/actor";
import { setTelemetry, telemetry } from "../src/core/telemetry";
import { guided } from "./helpers/guidance";
import { expectNoLeak, PANTRY, READ_OWNER_TOKEN, readRefusal, startReadEngine, WEIGHT, type ReadEngine, type ReadTokenName } from "./helpers/read-tokens";

type Json = Record<string, unknown>;

let engine: ReadEngine | null = null;
afterEach(async () => {
  await engine?.dispose();
  engine = null;
});

/** A request over HTTP with a token's secret (or the owner's) and, when given, the view-as header. */
async function call(e: ReadEngine, token: ReadTokenName | "owner", route: string, opts: { viewAs?: string; method?: string; body?: Json } = {}): Promise<{ status: number; json: Json }> {
  const bearer = token === "owner" ? READ_OWNER_TOKEN : e.secrets[token];
  const method = opts.method ?? "POST";
  const res = await fetch(`${e.url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...(opts.viewAs !== undefined ? { "X-Datanotes-View-As": opts.viewAs } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as Json };
}

const op = (e: ReadEngine, token: ReadTokenName | "owner", name: string, body: Json, viewAs?: string) => call(e, token, `/operations/${name}/`, { body, ...(viewAs !== undefined ? { viewAs } : {}) });

const notARead = (name: string, method: string, path: string) => ({ status: 400, json: guided(`view as ${name} only reads: ${method} ${path} is not a read`) });

describe("view as a token", () => {
  it("a read runs with the viewed token's permissions", async () => {
    engine = await startReadEngine();
    const e = engine;
    const weight = await op(e, "owner", "select_rows", { table: WEIGHT }, "cook");
    expect(weight).toEqual(readRefusal("cook", WEIGHT));
    const tables = await op(e, "owner", "list_tables", {}, "cook");
    expect(tables.status).toBe(200);
    expect(JSON.stringify(tables.json)).not.toContain("health");
    expectNoLeak(tables.json);
    const pantry = await op(e, "owner", "select_rows", { table: PANTRY }, "cook");
    expect(pantry.status).toBe(200);
    expect(pantry.json).toEqual((await op(e, "cook", "select_rows", { table: PANTRY })).json);
    // tokens/me/ answers the viewed token's entry
    const me = await call(e, "owner", "/tokens/me/", { viewAs: "cook" });
    expect([me.status, (me.json.entry as Json).name]).toEqual([200, "cook"]);
    // the manual is a read: the same answer as the owner's (503 where the docs are not built)
    const manual = (viewAs?: string) => fetch(`${e.url}/manual/`, { headers: { Authorization: `Bearer ${READ_OWNER_TOKEN}`, ...(viewAs ? { "X-Datanotes-View-As": viewAs } : {}) } }).then(async (r) => [r.status, await r.text()]);
    const viewedManual = await manual("cook");
    expect(viewedManual[0]).not.toBe(400);
    expect(viewedManual).toEqual(await manual());
  });

  it("a request that is not a read is refused, whether its route exists or not", async () => {
    engine = await startReadEngine();
    const e = engine;
    expect(await op(e, "owner", "insert_row", { table: PANTRY, values: { item: "salt", qty: 1 } }, "cook")).toEqual(notARead("cook", "POST", "/datanotes/operations/insert_row/"));
    for (const route of ["/tokens/", "/status/", "/settings/", "/settings/update/", "/restart/", "/stop/"]) {
      expect(await call(e, "owner", route, { viewAs: "cook" })).toEqual(notARead("cook", "POST", `/datanotes${route}`));
    }
    // GET of a route that is not the change stream nor the manual
    expect(await call(e, "owner", "/tokens/", { viewAs: "cook", method: "GET" })).toEqual(notARead("cook", "GET", "/datanotes/tokens/"));
    // nothing was written
    const rows = await op(e, "owner", "select_rows", { table: PANTRY, where: { item: "salt" } });
    expect(rows.json.total).toBe(0);
  });

  it("a named token may not send the header", async () => {
    engine = await startReadEngine();
    expect(await op(engine, "cook", "select_rows", { table: PANTRY }, "nurse")).toEqual({ status: 403, json: guided("only the owner's token may view as another token") });
  });

  it("an unknown name is refused; an empty header is ignored", async () => {
    engine = await startReadEngine();
    const e = engine;
    expect(await op(e, "owner", "select_rows", { table: WEIGHT }, "ghost")).toEqual({ status: 400, json: guided("no token ghost to view as") });
    const blank = await op(e, "owner", "select_rows", { table: WEIGHT }, "  ");
    expect(blank).toEqual(await op(e, "owner", "select_rows", { table: WEIGHT }));
    expect(blank.status).toBe(200);
  });

  it("the change stream sends only the events the viewed token may read", async () => {
    engine = await startReadEngine();
    const e = engine;
    const head = (await e.op("owner", "list_changes", { limit: 1 })).json.head as number;
    const ac = new AbortController();
    const res = await fetch(`${e.url}/changes/stream?since=${head}`, { headers: { Authorization: `Bearer ${READ_OWNER_TOKEN}`, "X-Datanotes-View-As": "cook" }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = "";
    const until = async (re: RegExp) => {
      const deadline = Date.now() + 8000;
      while (!re.test(text) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return text;
    };
    try {
      await until(/datanotes change feed from/);
      expect((await e.op("owner", "insert_row", { table: WEIGHT, values: { label: "ZZSECRETHEALTH streamed", day: "2026-10-03", kg: 80.5, note: "ZZSECRETHEALTH stream" } })).status).toBe(200);
      expect((await e.op("owner", "insert_row", { table: PANTRY, values: { item: "salt", qty: 1 } })).status).toBe(200);
      const got = await until(/"table":"personal\.food\.pantry"/);
      const events = [...got.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!) as Json);
      expect(events.map((x) => [x.kind, x.table])).toEqual([["insert", PANTRY]]);
      expectNoLeak(got);
    } finally {
      ac.abort();
    }
  });

  it("the viewed token's last_seen does not change", async () => {
    engine = await startReadEngine();
    const e = engine;
    const lastSeen = async () => ((await e.route("owner", "/tokens/")).json.tokens as Json[]).find((t) => t.name === "cook")?.last_seen;
    const before = await lastSeen();
    for (let i = 0; i < 10; i++) expect((await op(e, "owner", "select_rows", { table: PANTRY }, "cook")).status).toBe(200);
    expect(await lastSeen()).toBe(before);
  });

  it("the read cache never shares an answer between the owner and the viewed token", async () => {
    engine = await startReadEngine();
    const e = engine;
    expect((await op(e, "owner", "select_rows", { table: WEIGHT })).status).toBe(200);
    expect(await op(e, "owner", "select_rows", { table: WEIGHT }, "cook")).toEqual(readRefusal("cook", WEIGHT));
    const viewed = await op(e, "owner", "list_tables", {}, "cook");
    expect(JSON.stringify(viewed.json)).not.toContain(WEIGHT);
    const own = await op(e, "owner", "list_tables", {});
    expect(JSON.stringify(own.json)).toContain(WEIGHT);
  });

  it("marks only the actors of the owner viewing as a token", () => {
    expect(isViewingAs(undefined)).toBe(false);
    expect(isViewingAs({ auth: "cook" })).toBe(false);
    expect(isViewingAs(viewingAs({ auth: "cook" }))).toBe(true);
  });

  it("a refusal under view-as is logged with view_as, the token's own refusal without it", async () => {
    engine = await startReadEngine();
    const e = engine;
    const records: { body: string; attrs: Record<string, unknown> }[] = [];
    const prev = telemetry();
    setTelemetry({ log: (_s, body, attrs = {}) => void records.push({ body, attrs }), flush: async () => {} });
    try {
      expect(await op(e, "owner", "select_rows", { table: WEIGHT }, "cook")).toEqual(readRefusal("cook", WEIGHT));
      const viewed = records.filter((r) => r.body === "datanotes token refused");
      expect(viewed).toHaveLength(1);
      expect(viewed[0]!.attrs).toMatchObject({ token_name: "cook", view_as: true });
      records.length = 0;
      expect(await op(e, "cook", "select_rows", { table: WEIGHT })).toEqual(readRefusal("cook", WEIGHT));
      const own = records.filter((r) => r.body === "datanotes token refused");
      expect(own).toHaveLength(1);
      expect(own[0]!.attrs.token_name).toBe("cook");
      expect(own[0]!.attrs).not.toHaveProperty("view_as");
    } finally {
      setTelemetry(prev);
    }
  });
});
