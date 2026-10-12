import { afterEach, describe, expect, it, vi } from "vitest";
import { isUuid, UUID_RE, uuidv7 } from "../src/core/uuid";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uuidv7", () => {
  it("is an RFC 9562 version 7 UUID whose first 48 bits are the time in ms", () => {
    const at = Date.parse("2026-10-08T10:00:00.123Z");
    const id = uuidv7(at);
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe("7"); // version
    expect(["8", "9", "a", "b"]).toContain(id[19]); // variant 10xx
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(at);
  });

  it("sorts by creation time, as text", () => {
    const ids = [uuidv7(Date.parse("2026-10-08T10:00:00Z")), uuidv7(Date.parse("2026-10-08T10:00:01Z")), uuidv7(Date.parse("2027-01-01T00:00:00Z"))];
    expect([...ids].sort()).toEqual(ids);
  });

  it("still makes valid, distinct ids on a runtime without crypto.getRandomValues", () => {
    vi.stubGlobal("crypto", undefined);
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_000);
    expect(isUuid(a) && isUuid(b)).toBe(true);
    expect(a.slice(0, 13)).toBe(b.slice(0, 13)); // same millisecond
    expect(a).not.toBe(b); // random tail
  });
});

describe("isUuid", () => {
  it("accepts any UUID text (either case) and nothing else", () => {
    expect(isUuid("01A0F000-0000-7000-8000-00000000000A")).toBe(true);
    expect(isUuid("01a0f000-0000-7000-8000-00000000000")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
