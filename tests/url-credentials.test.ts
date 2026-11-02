/**
 * URL credentials kept out of what the engine answers, stores and logs (src/core/url-credentials.ts):
 * text rules that also cover the addresses `new URL` refuses, in linear time.
 */

import { describe, expect, it } from "vitest";
import { redactAttributes, redactErrorCredentials, redactUrlCredentials, redactUrlCredentialsDeep, stripLeadingUserinfo } from "../src/core/url-credentials";
import { withoutCredentials } from "../src/server/settings-route";

describe("stripLeadingUserinfo", () => {
  it("removes the user info of a leading scheme://, also where new URL refuses the address", () => {
    expect(stripLeadingUserinfo("https://u:SECRET@h:431800")).toBe("https://h:431800");
    expect(stripLeadingUserinfo("https://u:SECRET@ho^st.example.com/v1")).toBe("https://ho^st.example.com/v1");
    expect(stripLeadingUserinfo("https://u:SECRET@git.example.com:80:80/r.git")).toBe("https://git.example.com:80:80/r.git");
    expect(stripLeadingUserinfo("https://u:SECRET@ho|st/r.git")).toBe("https://ho|st/r.git");
    expect(stripLeadingUserinfo("https://u:p@SECRET@h/x")).toBe("https://h/x");
    expect(stripLeadingUserinfo("https://u:pass SECRET@h/x")).toBe("https://h/x");
    expect(stripLeadingUserinfo("ssh://git@host/x")).toBe("ssh://host/x");
  });

  it("stops at a backslash, where the URL parser ends the host: the address shown names the host a request goes to", () => {
    const tricky = "http://u:p@evil.invalid\\@good.example/x";
    expect(stripLeadingUserinfo(tricky)).toBe("http://evil.invalid\\@good.example/x");
    expect(new URL(stripLeadingUserinfo(tricky)).host).toBe(new URL(tricky).host);
    expect(new URL(tricky).host).toBe("evil.invalid");
    expect(stripLeadingUserinfo("http://evil.invalid\\@good.example/x")).toBe("http://evil.invalid\\@good.example/x");
    expect(redactUrlCredentials(`failed: ${tricky} then`)).toBe("failed: http://evil.invalid\\@good.example/x then");
  });

  it("hides a raw backslash in a password when the address does not parse: the user info runs to the last @", () => {
    const raw = "http://u:SENTSEM\\x19292@127.0.0.1:9/v1";
    expect(() => new URL(raw)).toThrow();
    expect(stripLeadingUserinfo(raw)).toBe("http://127.0.0.1:9/v1");
    expect(redactUrlCredentials(`Failed to parse URL from ${raw}`)).toBe("Failed to parse URL from http://127.0.0.1:9/v1");
    expect(redactUrlCredentials(`"${raw}"`)).toBe('"http://127.0.0.1:9/v1"');
    expect(redactUrlCredentials("https://u:SEC\\RET…")).toBe("https://…");
  });

  it("follows the parser for a scheme where a backslash does not end the authority", () => {
    expect(new URL("x-git://u:p\\q@h/x").host).toBe("h");
    expect(stripLeadingUserinfo("x-git://u:p\\q@h/x")).toBe("x-git://h/x");
    expect(redactUrlCredentials("see x-git://u:p\\q@h/x")).toBe("see x-git://h/x");
  });

  it("keeps a cut text whose authority a backslash ends before the cut, and strips its user info", () => {
    expect(redactUrlCredentials("https://u:p@h\\SECRE…")).toBe("https://h\\SECRE…");
  });

  it("leaves values without user info as they are", () => {
    for (const v of ["git@github.com:you/store.git", "", "/tmp/remote", "http://127.0.0.1:4318", "https://h/x@y", "https://h?a=b@c"]) {
      expect(stripLeadingUserinfo(v)).toBe(v);
    }
  });
});

describe("redactUrlCredentials", () => {
  it("removes the credentials of every URL in a text", () => {
    expect(redactUrlCredentials("Request cannot be constructed from a URL that includes credentials: https://u:SECRET@127.0.0.1:9/v1/embeddings")).toBe(
      "Request cannot be constructed from a URL that includes credentials: https://127.0.0.1:9/v1/embeddings",
    );
    expect(redactUrlCredentials("Failed to parse URL from https://u:SECRET@otel.example.com:431800/v1/logs")).toBe(
      "Failed to parse URL from https://otel.example.com:431800/v1/logs",
    );
    expect(redactUrlCredentials("fatal: unable to access 'https://me:SECRET@example.com/store.git/': 403")).toBe(
      "fatal: unable to access 'https://example.com/store.git/': 403",
    );
    expect(redactUrlCredentials("a https://x:S1@h1/p and http://y:S2@h2")).toBe("a https://h1/p and http://h2");
    expect(redactUrlCredentials("custom|https://u:SECRET@h|m")).toBe("custom|https://h|m");
  });

  it("returns a text without user info in a URL as it is", () => {
    for (const t of ["user@example.com wrote", "see https://h/x", ""]) expect(redactUrlCredentials(t)).toBe(t);
  });

  it("runs in linear time (the scheme is bounded)", () => {
    let t0 = performance.now();
    expect(redactUrlCredentials("a".repeat(200_000) + " https://u:SECRET@h/x").endsWith(" https://h/x")).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1500);
    const long = "x://" + "b".repeat(1_000_000) + " @";
    t0 = performance.now();
    expect(redactUrlCredentials(long)).toBe(long);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("redactAttributes", () => {
  it("redacts string values only, in a copy", () => {
    const input = { error: "x https://u:SECRET@h/y", n: 3, ok: true, none: null, gone: undefined };
    const before = structuredClone(input);
    const out = redactAttributes(input);
    expect(out).toEqual({ error: "x https://h/y", n: 3, ok: true, none: null, gone: undefined });
    expect(Object.keys(out)).toEqual(Object.keys(input));
    expect(input).toEqual(before);
  });
});

describe("redactErrorCredentials", () => {
  it("redacts a string and passes other values through", () => {
    expect(redactErrorCredentials("at https://u:SECRET@h")).toBe("at https://h");
    expect(redactErrorCredentials(42)).toBe(42);
    const o = { a: 1 };
    expect(redactErrorCredentials(o)).toBe(o);
  });

  it("rewrites an Error in place", () => {
    const err = new TypeError("Failed to parse URL from https://u:SECRET@h:431800/x");
    const out = redactErrorCredentials(err);
    expect(out).toBe(err);
    expect(out).toBeInstanceOf(TypeError);
    expect(err.message).toBe("Failed to parse URL from https://h:431800/x");
    expect(String(err.stack)).not.toContain("SECRET");
  });

  it("rewrites an Error that has no stack", () => {
    const err = new Error("https://u:SECRET@h");
    delete (err as { stack?: string }).stack;
    expect(redactErrorCredentials(err)).toBe(err);
    expect(err.message).toBe("https://h");
    expect(err.stack).toBeUndefined();
  });

  it("leaves a clean Error alone", () => {
    const err = new Error("plain");
    expect(redactErrorCredentials(err)).toBe(err);
    expect(err.message).toBe("plain");
  });

  it("replaces a frozen Error", () => {
    const err = Object.freeze(new RangeError("https://u:SECRET@h"));
    const out = redactErrorCredentials(err) as Error;
    expect(out).not.toBe(err);
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("RangeError");
    expect(out.message).toBe("https://h");
  });
});

describe("withoutCredentials", () => {
  it("strips what new URL refuses, as text", () => {
    expect(withoutCredentials("https://user:pw@host/x")).toBe("https://host/x");
    expect(withoutCredentials("https://user@host")).toBe("https://host/");
    expect(withoutCredentials("https://u:SECRET@h:431800")).toBe("https://h:431800");
    expect(withoutCredentials("https://u:SECRET@ho^st/x")).toBe("https://ho^st/x");
    for (const v of ["git@host:repo.git", "", "/tmp/remote"]) expect(withoutCredentials(v)).toBe(v);
  });
});

describe("redactUrlCredentialsDeep", () => {
  it("redacts every string, at any depth, in a copy", () => {
    const input = { url: "https://u:SECRET@h/x", list: ["a", "ftp://v:SECRET@g/y", 3], nested: { deep: { text: "see https://w:SECRET@k" } }, n: 1, ok: true, none: null };
    const before = structuredClone(input);
    expect(redactUrlCredentialsDeep(input)).toEqual({ url: "https://h/x", list: ["a", "ftp://g/y", 3], nested: { deep: { text: "see https://k" } }, n: 1, ok: true, none: null });
    expect(input).toEqual(before);
  });

  it("passes other values through", () => {
    for (const v of [5, null, undefined, true]) expect(redactUrlCredentialsDeep(v)).toBe(v);
    expect(redactUrlCredentialsDeep("plain")).toBe("plain");
    expect(redactUrlCredentialsDeep([])).toEqual([]);
  });
});
