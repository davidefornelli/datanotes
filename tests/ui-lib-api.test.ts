/**
 * The database browser's fetch wrapper (src/ui/lib/api.ts): the headers it sends (token, actor,
 * view-as), the URLs, and how it turns the engine's answers into values and errors.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, AuthRefused, EngineUnreachable, viewAsGone, type ApiOptions } from "../src/ui/lib/api";

const ACTOR = { harness: "datanotes-ui", harness_version: "9.9.9", session: "ui-0011223344556677" };

interface Call {
  url: string;
  init: RequestInit;
}

function fake(status: number, text: string | (() => Promise<string>)) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, text: typeof text === "string" ? async () => text : text } as unknown as Response;
  });
  return { calls, fetchImpl };
}

function client(f: ReturnType<typeof fake>, extra: Partial<ApiOptions> = {}) {
  return new ApiClient({ token: "tok", actor: ACTOR, base: "http://e:1", fetchImpl: f.fetchImpl, ...extra });
}

describe("ApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("op() posts to the operation with the token, the actor and the body", async () => {
    const f = fake(200, '{"tables":[]}');
    const a = await client(f).op("list_tables", { x: 1 });
    expect(a).toEqual({ status: 200, ok: true, json: { tables: [] } });
    const c = f.calls[0]!;
    expect(c.url).toBe("http://e:1/datanotes/operations/list_tables/");
    expect(c.init.method).toBe("POST");
    expect(c.init.body).toBe('{"x":1}');
    expect(c.init.headers).toEqual({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      "X-Datanotes-Actor": JSON.stringify(ACTOR),
    });
    expect(c.init.signal).toBeUndefined();
  });

  it("route() posts under /datanotes, an empty body as {}, with the signal", async () => {
    const f = fake(200, "{}");
    const ctl = new AbortController();
    await client(f).route("/tokens/", undefined, ctl.signal);
    await client(f).route("status/");
    expect(f.calls[0]!.url).toBe("http://e:1/datanotes/tokens/");
    expect(f.calls[0]!.init.body).toBe("{}");
    expect(f.calls[0]!.init.signal).toBe(ctl.signal);
    expect(f.calls[1]!.url).toBe("http://e:1/datanotes/status/");
  });

  it("sends X-Datanotes-View-As only while viewing as a token", async () => {
    const f = fake(200, "{}");
    const c = client(f, { viewAs: "cook" });
    expect(c.viewAs).toBe("cook");
    await c.op("list_tables");
    expect((f.calls[0]!.init.headers as Record<string, string>)["X-Datanotes-View-As"]).toBe("cook");
    const back = c.withViewAs(null);
    expect(back.viewAs).toBeNull();
    await back.op("list_tables");
    expect(f.calls[1]!.init.headers).not.toHaveProperty("X-Datanotes-View-As");
    expect(client(f).viewAs).toBeNull();
  });

  it("throws AuthRefused on 401", async () => {
    await expect(client(fake(401, "{}")).op("x")).rejects.toBeInstanceOf(AuthRefused);
    expect(new AuthRefused().message).toContain("401");
  });

  it("throws EngineUnreachable on a rejected fetch, 502, 504 and a 503 without error", async () => {
    const rejecting = { fetchImpl: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) };
    const e = await client(rejecting as unknown as ReturnType<typeof fake>).op("x").catch((x) => x);
    expect(e).toBeInstanceOf(EngineUnreachable);
    expect(e.message).toBe("The engine does not answer at http://e:1: Failed to fetch");
    const nonError = { fetchImpl: vi.fn(async () => Promise.reject("down")) };
    expect((await client(nonError as unknown as ReturnType<typeof fake>).op("x").catch((x) => x)).message).toContain(": down");
    for (const [status, body] of [
      [502, "bad gateway"],
      [504, "{}"],
      [503, "{}"],
      [503, "null"],
      [503, '{"error":5}'],
    ] as const) {
      const err = await client(fake(status, body)).op("x").catch((x) => x);
      expect(err).toBeInstanceOf(EngineUnreachable);
      expect(err.message).toContain(`HTTP ${status}`);
    }
  });

  it("returns a 503 with the engine's error and a 422, with ok false", async () => {
    const a = await client(fake(503, '{"error":"the engine is restarting"}')).op("x");
    expect(a).toEqual({ status: 503, ok: false, json: { error: "the engine is restarting" } });
    const b = await client(fake(422, '{"ok":false}')).op("x");
    expect(b.ok).toBe(false);
    expect(b.status).toBe(422);
  });

  it("turns an answer that is not JSON into an error body", async () => {
    const a = await client(fake(500, "<html>")).op("x");
    expect(a.json).toEqual({ error: "HTTP 500: the answer is not JSON" });
  });

  it("rethrows an AbortError as is, from fetch or from the body", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const f1 = { fetchImpl: vi.fn(async () => Promise.reject(abort)) };
    await expect(client(f1 as unknown as ReturnType<typeof fake>).op("x")).rejects.toBe(abort);
    await expect(client(fake(200, () => Promise.reject(abort))).op("x")).rejects.toBe(abort);
    const err = await client(fake(200, () => Promise.reject(new Error("reset")))).op("x").catch((x) => x);
    expect(err).toBeInstanceOf(EngineUnreachable);
  });

  it("names the page's origin when no base is given", async () => {
    vi.stubGlobal("location", { origin: "http://page:2" });
    const rejecting = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => Promise.reject(new Error("no")));
    const c = new ApiClient({ token: "t", actor: ACTOR, fetchImpl: rejecting });
    expect((await c.op("x").catch((x) => x)).message).toBe("The engine does not answer at http://page:2: no");
    expect(rejecting.mock.calls[0]![0]).toBe("/datanotes/operations/x/");
    vi.stubGlobal("location", undefined);
    expect((await c.op("x").catch((x) => x)).message).toBe("The engine does not answer at this address: no");
  });

  it("uses the global fetch by default", async () => {
    const g = vi.fn(async () => ({ status: 200, text: async () => "{}" }));
    vi.stubGlobal("fetch", g);
    await new ApiClient({ token: "t", actor: ACTOR }).op("x");
    expect(g).toHaveBeenCalledOnce();
  });

  it("identity() sends only the token with GET /", async () => {
    const f = fake(200, '{"status":"OK","version":"3.7.0","authenticated":true,"auth":"owner"}');
    expect(await client(f).identity()).toEqual({ authenticated: true, auth: "owner", version: "3.7.0" });
    expect(f.calls[0]!.url).toBe("http://e:1/");
    expect(f.calls[0]!.init).toEqual({ method: "GET", headers: { Authorization: "Bearer tok" } });
  });

  it("identity() without a token sends no header, and reads odd answers safely", async () => {
    const f = fake(200, '{"authenticated":false,"auth":null}');
    expect(await client(f, { token: "" }).identity()).toEqual({ authenticated: false, auth: null, version: "" });
    expect(f.calls[0]!.init.headers).toEqual({});
    expect((await client(fake(500, '{"authenticated":true}')).identity()).authenticated).toBe(false);
  });

  it("openapi() gets the document without headers, once per client; a failure is not cached", async () => {
    const f = fake(200, '{"openapi":"3.1.0"}');
    const c = client(f);
    expect(await c.openapi()).toEqual({ openapi: "3.1.0" });
    expect(await c.openapi()).toEqual({ openapi: "3.1.0" });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.calls[0]).toEqual({ url: "http://e:1/datanotes/openapi.json", init: { method: "GET" } });

    let status = 500;
    const flaky = vi.fn(async () => ({ status, text: async () => "{}" }) as unknown as Response);
    const d = new ApiClient({ token: "t", actor: ACTOR, fetchImpl: flaky });
    await expect(d.openapi()).rejects.toThrow("HTTP 500");
    status = 200;
    expect(await d.openapi()).toEqual({});
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

describe("viewAsGone", () => {
  const gone = { status: 400, ok: false, json: { error: "no token cook to view as" } };
  it("is true for the engine's refusal of the viewed name", () => {
    expect(viewAsGone(gone, "cook")).toBe(true);
  });
  it("is false without view-as, for another name, status or error, and for a body that is not an object", () => {
    expect(viewAsGone(gone, null)).toBe(false);
    expect(viewAsGone(gone, "keeper")).toBe(false);
    expect(viewAsGone({ ...gone, status: 403 }, "cook")).toBe(false);
    expect(viewAsGone({ ...gone, status: 200, ok: true }, "cook")).toBe(false);
    expect(viewAsGone({ ...gone, json: { error: "view as cook only reads: POST /x is not a read" } }, "cook")).toBe(false);
    expect(viewAsGone({ ...gone, json: null }, "cook")).toBe(false);
    expect(viewAsGone({ ...gone, json: "x" }, "cook")).toBe(false);
  });
});
