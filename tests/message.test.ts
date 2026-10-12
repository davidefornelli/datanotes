import { describe, expect, it } from "vitest";
import { messageOf } from "../src/core/message";

describe("messageOf", () => {
  it("reads an Error's message, subclasses included", () => {
    expect(messageOf(new Error("disk full"))).toBe("disk full");
    expect(messageOf(new TypeError("x is not a function"))).toBe("x is not a function");
  });

  it("turns anything else thrown into its string", () => {
    expect(messageOf("plain text")).toBe("plain text");
    expect(messageOf(42)).toBe("42");
    expect(messageOf(undefined)).toBe("undefined");
    expect(messageOf({ toString: () => "host error" })).toBe("host error");
  });
});
