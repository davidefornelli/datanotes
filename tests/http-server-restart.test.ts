/**
 * The HTTP server's side of a restart: a drain that says "the engine is restarting", the undrain of
 * a cancelled restart, and the routes that only POST reaches (/restart/ and /stop/).
 */

import { afterEach, describe, expect, it } from "vitest";
import { HttpApiServer } from "../src/server/http-server";
import { logVault } from "./helpers/db-vault";
import { guided } from "./helpers/guidance";

let server: HttpApiServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const RESTART_DOCS = "https://datanotes.dev/administration/run-the-service.md#restart-the-engine";
const STOP_DOCS = "https://datanotes.dev/administration/run-the-service.md#stop-the-engine";

/** A server whose `/slow/` route answers once `release` is called, and whose `/fast/` answers at once. */
async function slowServer(extra: Record<string, () => Promise<{ status: number; json: unknown }>> = {}) {
  const v = logVault({});
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  server = new HttpApiServer({
    app: v.app,
    handlers: {
      "/slow/": async () => {
        entered();
        await gate;
        return { status: 200, json: { done: true } };
      },
      "/fast/": async () => ({ status: 200, json: { fast: true } }),
      ...extra,
    },
    token: "t",
    port: 0,
  });
  const port = await server.start();
  const call = (p: string, method = "POST") => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Authorization: "Bearer t" } });
  return { call, release, inside };
}

describe("a drain for a restart", () => {
  it("answers new requests 503 the engine is restarting, and lets the one under way finish", async () => {
    const { call, release, inside } = await slowServer();
    const slow = call("/datanotes/slow/");
    await inside;
    const drained = server!.drain(10_000, "restarting");
    const refused = await call("/datanotes/fast/");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual(guided("the engine is restarting", { docs: RESTART_DOCS }));
    expect((await call("/", "GET")).status).toBe(503);
    release();
    expect((await slow).status).toBe(200);
    expect(await drained).toBe(true);
  });

  it("takes requests again after undrain, and a later drain says stopping", async () => {
    const { call, release, inside } = await slowServer();
    const slow = call("/datanotes/slow/");
    await inside;
    expect(await server!.drain(50, "restarting")).toBe(false);
    server!.undrain();
    expect((await call("/datanotes/fast/")).status).toBe(200);
    release();
    expect((await slow).status).toBe(200);
    expect(await server!.drain(10)).toBe(true);
    const refused = await call("/datanotes/fast/");
    expect(await refused.json()).toEqual(guided("the engine is stopping", { docs: STOP_DOCS }));
  });
});

describe("routes that only POST reaches", () => {
  it("answers GET /restart/ and GET /stop/ 405, each with its own hint, and calls neither", async () => {
    const called: string[] = [];
    const { call } = await slowServer({
      "/restart/": async () => (called.push("restart"), { status: 200, json: {} }),
      "/stop/": async () => (called.push("stop"), { status: 200, json: {} }),
    });
    const restart = await call("/datanotes/restart/", "GET");
    expect(restart.status).toBe(405);
    expect(await restart.json()).toEqual(guided("GET /datanotes/restart/ does nothing: the restart takes POST", { docs: RESTART_DOCS }));
    const stop = await call("/datanotes/stop/", "GET");
    expect(stop.status).toBe(405);
    expect(await stop.json()).toEqual(guided("GET /datanotes/stop/ does nothing: the stop takes POST", { docs: STOP_DOCS }));
    expect(called).toEqual([]);
  });
});
