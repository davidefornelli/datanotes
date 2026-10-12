import { describe, expect, it } from "vitest";
import { wireEvent, type ChangeFeed, type ChangePage, type ChangeQuery } from "../src/core/change-feed";
import { INDEX_RETRY } from "../src/core/engine";
import { HttpApiServer, type HttpServerOptions } from "../src/server/http-server";
import { listFolder, searchNotes } from "../src/core/vault-read";
import { createHandlers } from "../src/server/rest";
import { logVault } from "./helpers/db-vault";
import { guided } from "./helpers/guidance";

INDEX_RETRY.delayMs = 1;

/** What a request got back: status, headers, body (SSE chunks joined). */
interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

type Handle = (req: unknown, res: unknown) => void;

/**
 * The server on an injected `createServer` (no socket): each `request` drives the real request
 * handler with an in-memory request and response.
 */
async function serve(extra: Partial<HttpServerOptions> = {}) {
  const v = logVault({ "Notes/Trip.md": "---\ntags: travel\n---\nA dinner in Paris.\n" });
  let handle: Handle | null = null;
  const server = new HttpApiServer({
    app: v.app,
    handlers: createHandlers(v.app, () => v.settings),
    token: "owner-token",
    port: 0,
    version: "3.0.0",
    createServer: (h) => {
      handle = h as Handle;
      return { listen: (_p, _h, cb) => cb(), on: () => undefined, close: (cb) => cb?.(), address: () => ({ port: 41234 }) };
    },
    ...extra,
  });
  expect(await server.start()).toBe(41234);

  function request(method: string | undefined, url: string | undefined, opts: { headers?: Record<string, string>; body?: string; bodySize?: number; onWrite?: (chunk: string, close: () => void) => void } = {}): Promise<Answer & { destroyed: boolean }> {
    return new Promise((resolve) => {
      const answer: Answer & { destroyed: boolean } = { status: 0, headers: {}, body: "", ended: false, destroyed: false };
      const listeners: Record<string, ((x?: unknown) => void)[]> = {};
      let closeRes: () => void = () => undefined;
      const req = {
        method,
        url,
        headers: { authorization: "Bearer owner-token", ...(opts.headers ?? {}) },
        on(ev: string, cb: (x?: unknown) => void) {
          (listeners[ev] ??= []).push(cb);
          if (ev === "end") {
            queueMicrotask(() => {
              if (opts.body !== undefined) for (const d of listeners.data ?? []) d(new TextEncoder().encode(opts.body));
              if (opts.bodySize !== undefined) for (const d of listeners.data ?? []) d({ length: opts.bodySize });
              cb();
            });
          }
        },
        destroy: () => void (answer.destroyed = true),
      };
      const res = {
        statusCode: 0,
        setHeader: (k: string, val: string) => void (answer.headers[k.toLowerCase()] = val),
        flushHeaders: () => undefined,
        write(chunk: string) {
          answer.status = res.statusCode;
          answer.body += chunk;
          opts.onWrite?.(chunk, () => {
            closeRes();
            resolve(answer);
          });
          return true;
        },
        end(body?: string) {
          answer.status = res.statusCode;
          answer.body += body ?? "";
          answer.ended = true;
          resolve(answer);
        },
        on(ev: string, cb: () => void) {
          if (ev === "close") closeRes = cb;
        },
      };
      handle!(req, res);
    });
  }
  return { v, server, request };
}

describe("HTTP server: requests", () => {
  it("an unknown operation or route names the closest one, and where the routes are listed", async () => {
    const { request } = await serve();
    const op = JSON.parse((await request("POST", "/datanotes/operations/insrt_row/")).body);
    expect(op).toEqual(guided("unknown operation insrt_row"));
    expect(op.hint).toMatch(/^Did you mean insert_row\? Call an operation with POST \/datanotes\/operations\/<name>\//);
    const near = JSON.parse((await request("POST", "/datanotes/tokens/creat/")).body);
    expect(near).toEqual(guided("unknown route /datanotes/tokens/creat/"));
    expect(JSON.parse((await request("POST", "/datanotes/nothing-like-it/")).body).hint).toMatch(/^Call an operation with POST/);
  });

  it("an operation answers POST only, without a trailing slash too", async () => {
    const { request } = await serve();
    const tables = await request("POST", "/datanotes/operations/list_tables");
    expect(tables.status).toBe(200);
    expect(JSON.parse(tables.body).tables.map((t: { qualified: string }) => t.qualified)).toEqual(["main.public.log"]);
    expect(await request("GET", "/datanotes/operations/list_tables/")).toMatchObject({ status: 405 });
    expect(JSON.parse((await request("GET", "/datanotes/operations/list_tables/")).body)).toEqual(guided("GET /datanotes/operations/list_tables/ does nothing: operations take POST"));
    expect(await request("PUT", "/datanotes/operations/list_tables/")).toMatchObject({ status: 405 });
    expect(JSON.parse((await request("PUT", "/datanotes/operations/list_tables/")).body)).toEqual(guided("use POST"));
    expect(await request("DELETE", "/datanotes/operations/delete_rows/")).toMatchObject({ status: 405 });
  });

  it("a request without method or URL is the status page", async () => {
    const { request } = await serve();
    const status = await request(undefined, undefined);
    expect(JSON.parse(status.body)).toEqual({ status: "OK", service: "datanotes", version: "3.0.0", authenticated: true, auth: "owner" });
  });

  it("builds the OpenAPI document once and serves the same one after", async () => {
    const { request } = await serve();
    const first = await request("GET", "/datanotes/openapi.json", { headers: { authorization: "" } });
    const second = await request("GET", "/datanotes/openapi.json", { headers: { authorization: "" } });
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-cache");
    expect(JSON.parse(first.body).info.version).toBe("3.0.0");
    expect(second.body).toBe(first.body);
  });

  it("read_note answers the note's text with its front matter, tags written as one word", async () => {
    const { request } = await serve();
    const json = JSON.parse((await request("POST", "/datanotes/operations/read_note/", { body: JSON.stringify({ path: "Notes/Trip.md" }) })).body);
    expect(json).toMatchObject({ path: "Notes/Trip.md", content: "---\ntags: travel\n---\nA dinner in Paris.\n", front_matter: { tags: "travel" }, tags: ["travel"] });
  });

  it("search_notes: the default context, a shorter one, and a context that is not a number is refused", async () => {
    const { request } = await serve();
    const search = async (args: Record<string, unknown>) => request("POST", "/datanotes/operations/search_notes/", { body: JSON.stringify(args) });
    expect((await search({})).status).toBe(400); // no query
    const note = "---\ntags: travel\n---\nA dinner in Paris.\n";
    const at = note.indexOf("Paris");
    expect(JSON.parse((await search({ query: "paris" })).body)).toEqual({ query: "paris", results: [{ path: "Notes/Trip.md", score: 1, matches: [{ start: at, end: at + 5, context: note }] }], total: 1 });
    expect((await search({ query: "paris", context_length: "many" })).status).toBe(400);
    const short = JSON.parse((await search({ query: "paris", context_length: 3 })).body);
    expect(short.results[0].matches[0].context).toBe("in Paris.\n");
  });

  it("plain-text search: words next to each other make one match, one entry per note", async () => {
    const note = "Charade: Cary Grant again.\n\nA Cary weekend, then Grant, Cary-Grant.\n";
    const v = logVault({ "Notes/Rewatch.md": note, "Notes/Other.md": "Only Cary here.\n" });
    const hits = (await searchNotes(v.app, "cary grant grant", 0)).results;
    expect(hits.map((h) => h.path)).toEqual(["Notes/Rewatch.md"]);
    expect(hits[0]!.matches.map((m) => m.context)).toEqual(["Cary Grant", "Cary", "Grant, Cary-Grant"]);
    const first = note.indexOf("Cary");
    expect(hits[0]!.matches[0]).toMatchObject({ start: first, end: first + "Cary Grant".length });
    expect(hits[0]!.score).toBe(6); // the six words found in the text
    // words found at the same place (one inside the other) make one match too
    const nested = (await searchNotes(v.app, "gran grant", 0)).results;
    expect(nested[0]!.matches.map((m) => m.context)).toEqual(["Grant", "Grant", "Grant"]);
  });

  it("a body over 20 MB is refused and the request dropped, before anything is parsed", async () => {
    const { request } = await serve();
    const answer = await request("POST", "/datanotes/operations/insert_row/", { bodySize: 20 * 1024 * 1024 + 1 });
    expect(answer).toMatchObject({ status: 500, body: JSON.stringify({ error: "request body too large" }), destroyed: true });
  });

  it("a token that is neither the owner's nor a named one is refused, also when the token registry fails", async () => {
    const { request } = await serve({ tokens: { authenticate: async () => Promise.reject(new Error("tokens.json unreadable")) } });
    const refused = await request("POST", "/datanotes/operations/list_tables/", { headers: { authorization: "Bearer app-token" } });
    expect(refused.status).toBe(401);
    expect(JSON.parse(refused.body)).toEqual(guided("missing or wrong bearer token"));
  });

  it("without a version, the status page and the OpenAPI document say an empty one", async () => {
    const { request } = await serve({ version: undefined });
    expect(JSON.parse((await request("GET", "/")).body).version).toBe("");
    expect(JSON.parse((await request("GET", "/datanotes/openapi.json")).body).info.version).toBe("");
  });



  it("stop() before start() does nothing", async () => {
    const v = logVault();
    await expect(new HttpApiServer({ app: v.app, handlers: {}, token: "t", port: 0 }).stop()).resolves.toBeUndefined();
  });
});

describe("listFolder", () => {
  it("lists the vault root of a host without getRoot()", () => {
    const { v } = { v: logVault() };
    const app = { ...v.app, vault: { ...v.app.vault, getRoot: undefined, getAbstractFileByPath: v.app.vault.getAbstractFileByPath.bind(v.app.vault) } };
    expect(listFolder(app as never, "").folders).toEqual(expect.arrayContaining(["Daily", "Datanotes"]));
  });
});

describe("HTTP server: the change feed as Server-Sent Events", () => {
  /** A feed whose `wait` answers `pages` in turn and records the queries. */
  function feedOf(pages: Partial<ChangePage>[], lastSeq = 10) {
    const queries: ChangeQuery[] = [];
    const feed = {
      lastSeq,
      async wait(q: ChangeQuery): Promise<ChangePage> {
        queries.push(q);
        const p = pages.shift() ?? {};
        return { events: [], last: q.since ?? 0, head: lastSeq, ...p };
      },
    };
    return { feed: feed as unknown as ChangeFeed, queries };
  }

  it("is 503 without a feed, and 400 for a where that is not JSON", async () => {
    const off = await (await serve()).request("GET", "/datanotes/changes/stream");
    expect([off.status, JSON.parse(off.body)]).toEqual([503, guided("the change feed is not available")]);
    const { feed } = feedOf([]);
    const { request } = await serve({ changeFeed: () => feed });
    const bad = await request("GET", "/datanotes/changes/stream/?where={kind");
    expect([bad.status, JSON.parse(bad.body)]).toEqual([400, guided("where must be a JSON object")]);
  });

  it("passes every filter to the feed, resumes after Last-Event-ID, and announces a gap", async () => {
    const ev = { seq: 8, at: "2026-10-08T10:00:00.000Z", table: "main.public.log", op: "update", path: "Daily/a.md" };
    const { feed, queries } = feedOf([{ events: [ev as never], last: 8, gap: true }]);
    const { request } = await serve({ changeFeed: () => feed });
    const where = encodeURIComponent(JSON.stringify({ kind: "mood" }));
    const answer = await request("GET", `/datanotes/changes/stream?tables=log,%20main.public.log&kinds=update,insert&columns=kind&exclude_actor=pantry&where=${where}`, {
      headers: { "last-event-id": "5" },
      onWrite: (chunk, close) => {
        if (chunk.startsWith("id: 8")) close();
      },
    });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(answer.body).toBe(`: datanotes change feed from 5\n\nevent: gap\ndata: {"since":5}\n\nid: 8\ndata: ${JSON.stringify(wireEvent(ev as never))}\n\n`);
    expect(queries[0]).toEqual({ tables: ["log", "main.public.log"], ops: ["update", "insert"], columns: ["kind"], excludeActor: "pantry", where: { kind: "mood" }, since: 5, limit: 500 });
  });

  it("starts from the feed's last event when `since` is not a valid sequence number, and ends the stream when the server stops", async () => {
    const { feed, queries } = feedOf([], 42);
    const { request, server } = await serve({ changeFeed: () => feed });
    let stopped = false;
    const answer = await request("GET", "/datanotes/changes/stream?since=-3", {
      onWrite: () => {
        if (!stopped) {
          stopped = true;
          void server.stop();
        }
      },
    });
    expect(answer.body).toBe(": datanotes change feed from 42\n\n");
    expect(answer.ended).toBe(true);
    expect(queries).toEqual([]); // stopped before the first wait

    const fromLast = await serve({ changeFeed: () => feed });
    const plain = await fromLast.request("GET", "/datanotes/changes/stream", { onWrite: () => void fromLast.server.stop() });
    expect(plain.body).toBe(": datanotes change feed from 42\n\n");
  });
});
