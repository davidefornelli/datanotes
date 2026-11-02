/**
 * URL user info out of a recorded tool call before the MCP server cuts it (R4w5-1): src/api/redact.ts
 * repeats the rule of src/core/url-credentials.ts (src/api imports nothing else), and both must give
 * the same text.
 */

import { describe, expect, it } from "vitest";
import { cutToolCall, RECORDED_CHARS, URL_USERINFO, withoutUrlUserinfo } from "../src/api/redact";
import { ANY_USERINFO, redactUrlCredentials } from "../src/core/url-credentials";

const TEXTS = [
  "https://u:SECRET@h:431800",
  "https://u:SECRET@ho^st.example.com/v1",
  "https://u:p@SECRET@h/x",
  "ssh://git@host/x",
  "failed: https://u:SECRET@127.0.0.1:9/v1 and http://a:b@c/d, then 'x://y:z@w'",
  "http://u:p@evil.invalid\\@good.example/x",
  "http://u:SENTSEM\\x19292@127.0.0.1:9/v1",
  "failed: http://u:SENT\\X@h:99999/v1, then",
  "x-git://u:p\\q@h/x",
  "http://h\\x@y/z",
  'a "https://u:S@h" b <https://u:S@h> `https://u:S@h` c',
  "git@github.com:you/store.git",
  "https://h/x@y",
  "https://h?a=b@c",
  "plain text",
  "",
];

describe("withoutUrlUserinfo", () => {
  it("gives the text the engine's rule gives", () => {
    for (const t of TEXTS) expect(withoutUrlUserinfo(t), t).toBe(redactUrlCredentials(t));
  });

  it("uses the same pattern as the engine, character for character", () => {
    expect(URL_USERINFO.source).toBe(ANY_USERINFO.source);
    expect(URL_USERINFO.flags).toBe(ANY_USERINFO.flags);
  });

  it("cleans every string at any depth, in a copy", () => {
    const v = { url: "https://u:S@h/x", list: ["http://a:S@b", 3, null], nested: { deep: "ftp://x:S@y" }, n: 1 };
    expect(withoutUrlUserinfo(v)).toEqual({ url: "https://h/x", list: ["http://b", 3, null], nested: { deep: "ftp://y" }, n: 1 });
    expect(v.url).toBe("https://u:S@h/x");
    expect(withoutUrlUserinfo(5)).toBe(5);
  });
});

describe("cutToolCall", () => {
  it("removes URL user info before the cut, so no part of a long password survives", () => {
    const url = `https://u:SENTINEL${"p".repeat(RECORDED_CHARS.arg)}@127.0.0.1:9/hook`;
    const cut = cutToolCall({ args: { url, long: `${url} ${"x".repeat(400)}` }, ok: true, value: { id: "w1", url, note: "n".repeat(2000) } });
    expect(cut.args.url).toBe("https://127.0.0.1:9/hook");
    expect(JSON.stringify(cut)).not.toContain("SENTINEL");
    expect(cut.summary).toEqual({ id: "w1", url: "https://127.0.0.1:9/hook", note: `${"n".repeat(200)}…` });
  });
});

describe("redactUrlCredentials on a text cut short", () => {
  it("drops the authority the cut ends in", () => {
    expect(redactUrlCredentials("https://u:SENTINELppp…")).toBe("https://…");
    expect(redactUrlCredentials('{"id":"w1","url":"https://u:p@SENTIN…')).toBe('{"id":"w1","url":"https://…');
    expect(redactUrlCredentials("see https://u:p@h/x, then https://v:SENT…")).toBe("see https://h/x, then https://…");
  });

  it("leaves a cut after the authority, and a text without a URL, as they are", () => {
    expect(redactUrlCredentials("https://h/x…")).toBe("https://h/x…");
    expect(redactUrlCredentials("https://u:p@h/xyz…")).toBe("https://h/xyz…");
    expect(redactUrlCredentials("no address…")).toBe("no address…");
  });

  it("runs in linear time", () => {
    const long = `https://${"a".repeat(100_000)}…`;
    const t = performance.now();
    expect(redactUrlCredentials(long)).toBe("https://…");
    expect(redactUrlCredentials(`${"https://a".repeat(20_000)}…`).endsWith("https://…")).toBe(true);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
