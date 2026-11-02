/**
 * The database browser (`GET /datanotes/ui/`, src/server/ui.ts): its page and two assets are served
 * without a token, with the headers of the plan's D6 (a strict Content-Security-Policy, no framing,
 * no referrer); every other path under it needs the token like any route.
 */

import { afterEach, describe, expect, it } from "vitest";
import { HttpApiServer, newToken } from "../src/server/http-server";
import { createHandlers } from "../src/server/rest";
import { UI_CSP, UI_PATH, uiAssets, uiResponse } from "../src/server/ui";
import { logVault } from "./helpers/db-vault";

describe("the database browser's page and assets", () => {
  let server: HttpApiServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function start() {
    const v = logVault({});
    const token = newToken();
    server = new HttpApiServer({ app: v.app, handlers: createHandlers(v.app, () => v.settings), token, port: 0, version: "9.9.9" });
    const base = `http://127.0.0.1:${await server.start()}`;
    return { base, token };
  }

  it("serves the page without a token, with the security headers and only same-origin assets", async () => {
    const { base } = await start();
    for (const p of ["/datanotes/ui", "/datanotes/ui/"]) {
      const page = await fetch(`${base}${p}`);
      expect(page.status, p).toBe(200);
      expect(page.headers.get("content-type")).toMatch(/^text\/html/);
      expect(page.headers.get("content-security-policy")).toBe(UI_CSP);
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("cache-control")).toBe("no-cache");
      const html = await page.text();
      expect(html).toContain("<title>Datanotes</title>");
      expect(html).toContain('<div id="app"></div>');
      const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!).filter((u) => u !== "data:,"); // the empty favicon
      expect(urls.sort()).toEqual(["/datanotes/ui/app.css?v=9.9.9", "/datanotes/ui/app.js?v=9.9.9"]);
      // no inline script or style, nothing from another host
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
      expect(html).not.toMatch(/<style|style="/);
      expect(html).not.toMatch(/https?:\/\//);
    }
  });

  it("has a policy that allows nothing inline, nothing from another host and no framing", () => {
    expect(UI_CSP).toContain("default-src 'none'");
    expect(UI_CSP).toContain("frame-ancestors 'none'");
    expect(UI_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
  });

  it("serves the script and the stylesheet without a token, cached for long", async () => {
    const { base } = await start();
    const js = await fetch(`${base}/datanotes/ui/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    const code = await js.text();
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toContain("sourceMappingURL");
    const css = await fetch(`${base}/datanotes/ui/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect(css.headers.get("cache-control")).toContain("immutable");
    expect(await css.text()).toContain("font-family");
  });

  it("answers any other path under it like any route: 401 without the token, 404 with it; POST needs the token", async () => {
    const { base, token } = await start();
    expect((await fetch(`${base}/datanotes/ui/other.js`)).status).toBe(401);
    expect((await fetch(`${base}/datanotes/ui/other.js`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await fetch(`${base}/datanotes/ui`, { method: "POST" })).status).toBe(401);
  });

  it("answers HEAD with the page's headers and no body", async () => {
    const { base } = await start();
    const head = await fetch(`${base}/datanotes/ui/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-security-policy")).toBe(UI_CSP);
    expect(await head.text()).toBe("");
  });

  it("references the assets with the engine's version, escaped, or dev", () => {
    expect(uiResponse(UI_PATH, "1.0 beta")!.body).toContain("?v=1.0%20beta");
    expect(uiResponse(UI_PATH, "")!.body).toContain("/datanotes/ui/app.js?v=dev");
    expect(uiResponse(`${UI_PATH}/other.js`, "1.0")).toBeNull();
    expect(uiAssets()).toBe(uiAssets());
  });
});
