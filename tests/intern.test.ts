/**
 * `intern` and `internAll` (src/core/intern.ts): one copy of each string the engine keeps per
 * note, through V8's string table. Interning never changes a value: these tests check that every
 * string comes back equal, that long strings are left alone, and that `internAll` walks arrays and
 * plain objects in place without touching other objects or prototypes. The memory gain itself is
 * measured by the scale benchmark (bench/scale), not here.
 */

import { describe, expect, it } from "vitest";
import { INTERN, intern, internAll } from "../src/core/intern";

describe("intern", () => {
  it("answers an equal string, for any text", () => {
    for (const s of ["", "open", "work.planning.task", "123", "__proto__", "constructor", "toString", "x".repeat(129), "😀 émoji", "\uD800"]) {
      expect(intern(s)).toBe(s);
    }
    const big = "y".repeat(1000) + "id: 01a0f000-0000-7000-8000-00000000000a";
    const piece = big.slice(1004);
    expect(intern(piece)).toBe(piece);
  });

  it("leaves strings over INTERN.maxLength as they are", () => {
    INTERN.maxLength = 3;
    try {
      expect(intern("abcd")).toBe("abcd");
      expect(intern("abc")).toBe("abc");
    } finally {
      INTERN.maxLength = 128;
    }
  });
});

describe("internAll", () => {
  it("internAll interns in place: arrays, nested arrays, the values of plain objects; other values unchanged", () => {
    const date = new Date(0);
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = "v";
    const v: unknown[] = [["k", "v"], ["n", 1], ["o", { a: "x", b: [null, true, "y"] }], ["d", date], ["bare", bare], "top"];
    const before = JSON.stringify(v);
    expect(internAll(v)).toBe(v);
    expect(JSON.stringify(v)).toBe(before);
    expect((v[3] as unknown[])[1]).toBe(date);
    expect(internAll("s")).toBe("s");
    expect(internAll(7)).toBe(7);
    expect(internAll(null)).toBe(null);
  });

  it("an object with an own __proto__ key keeps it, and its prototype", () => {
    const o = JSON.parse('{"__proto__": "x", "a": "b"}') as Record<string, unknown>;
    internAll(o);
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(Object.keys(o)).toEqual(["__proto__", "a"]);
    expect(o.a).toBe("b");
  });
});
