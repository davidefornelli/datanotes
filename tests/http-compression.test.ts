/**
 * Answers compressed with gzip (http-server.ts, setting `httpCompression`): only for a client
 * whose request says `Accept-Encoding: gzip`, only answers of 16 KB or more, by default only for
 * clients on other machines. The client gets the same JSON once it is decompressed.
 */

import http from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeWithDefaults } from "../src/core/settings";
import { acceptsGzip, GZIP_MIN_CHARS, HttpApiServer, isLoopback, type HttpCompression } from "../src/server/http-server";
import type { Handler } from "../src/server/rest";
import { logVault } from "./helpers/db-vault";

const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ path: `Notes/n${i}.md`, title: `Note ${i}` })) };
const handlers: Record<string, Handler> = {
  "/operations/select_rows/": async () => ({ status: 200, json: big }),
  "/operations/list_tables/": async () => ({ status: 200, json: { tables: [] } }),
};

const servers: HttpApiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function serve(mode: () => HttpCompression): Promise<number> {
  const v = logVault();
  const server = new HttpApiServer({ app: v.app, handlers, token: "owner-token", port: 0, compression: mode });
  servers.push(server);
  return server.start();
}

/** A POST with these headers: the status, the headers and the raw bytes of the answer. */
function post(port: number, route: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/datanotes${route}`, headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

describe("gzip answers", () => {
  it("a large answer to a client that accepts gzip, when the setting lets this client have it", async () => {
    let mode: HttpCompression = "always";
    const port = await serve(() => mode);
    const zipped = await post(port, "/operations/select_rows/", { "Accept-Encoding": "gzip, deflate" });
    expect([zipped.status, zipped.headers["content-encoding"], zipped.headers.vary]).toEqual([200, "gzip", "Accept-Encoding"]);
    expect(JSON.parse(gunzipSync(zipped.bytes).toString("utf8"))).toEqual(big);
    expect(zipped.bytes.length).toBeLessThan(JSON.stringify(big).length / 5);
    // no Accept-Encoding, or gzip refused: as it is
    for (const headers of [{}, { "Accept-Encoding": "gzip;q=0, br" }, { "Accept-Encoding": "identity" }] as Record<string, string>[]) {
      const plain = await post(port, "/operations/select_rows/", headers);
      expect(plain.headers["content-encoding"], JSON.stringify(headers)).toBeUndefined();
      expect(JSON.parse(plain.bytes.toString("utf8"))).toEqual(big);
    }
    // a small answer: as it is
    const small = await post(port, "/operations/list_tables/", { "Accept-Encoding": "gzip" });
    expect([small.headers["content-encoding"], small.bytes.toString("utf8")]).toEqual([undefined, '{"tables":[]}']);
    // this machine is no remote client; off is off
    for (const m of ["remote", "off"] as const) {
      mode = m;
      expect((await post(port, "/operations/select_rows/", { "Accept-Encoding": "gzip" })).headers["content-encoding"], m).toBeUndefined();
    }
  });

  it("reads Accept-Encoding and the client's address as HTTP says", () => {
    expect(["gzip", "x-gzip", "deflate, gzip;q=0.5", "*", "br, *;q=0.1", "GZIP"].map(acceptsGzip)).toEqual([true, true, true, true, true, true]);
    expect([undefined, "", "identity", "gzip;q=0", "*;q=0", "gzip;q=0, *", "br, deflate", "gzip;q=abc"].map(acceptsGzip)).toEqual([false, false, false, false, false, false, false, false]);
    expect(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"].map(isLoopback)).toEqual([true, true, true, true]);
    expect([undefined, "10.0.0.2", "::ffff:192.168.1.5", "2001:db8::1"].map(isLoopback)).toEqual([false, false, false, false]);
    expect(GZIP_MIN_CHARS).toBe(16_384);
  });

  it("is a setting: remote by default, always or off, any other value the default", () => {
    expect(DEFAULT_SETTINGS.httpCompression).toBe("remote");
    expect(mergeWithDefaults({ httpCompression: "always" }).httpCompression).toBe("always");
    expect(mergeWithDefaults({ httpCompression: "off" }).httpCompression).toBe("off");
    expect(mergeWithDefaults({ httpCompression: "gzip" as never }).httpCompression).toBe("remote");
  });

  it("a server given no compression answers every client as it is", async () => {
    const v = logVault();
    const server = new HttpApiServer({ app: v.app, handlers, token: "owner-token", port: 0 });
    servers.push(server);
    const port = await server.start();
    expect((await post(port, "/operations/select_rows/", { "Accept-Encoding": "gzip" })).headers["content-encoding"]).toBeUndefined();
  });
});
