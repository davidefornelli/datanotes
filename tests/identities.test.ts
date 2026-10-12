import { describe, expect, it } from "vitest";
import { SessionIdentities } from "../src/server/identities";

describe("SessionIdentities: what agent sessions said about themselves", () => {
  it("keeps the model and harness as trimmed text, merging what a session reports later", () => {
    const ids = new SessionIdentities();
    ids.set("0193a1b2c3d4e5f6-rest-of-session", { model: "  claude-opus-5-5 ", harness: 42 });
    ids.set("0193a1b2c3d4e5f6-rest-of-session", { harness: "Claude Code", model: "" });
    expect(ids.get("0193a1b2c3d4e5f6-rest-of-session")).toEqual({ model: "claude-opus-5-5", harness: "Claude Code" });
    expect(ids.get("unknown")).toBeUndefined();
  });

  it("finds a session by the first 16 characters apps see in their actor", () => {
    const ids = new SessionIdentities();
    ids.set("0193a1b2c3d4e5f6", { model: "gpt-x" });
    expect(ids.get("0193a1b2c3d4e5f6-0000-7000-8000-000000000000")).toEqual({ model: "gpt-x" });
  });

  it("cuts a long value to 200 characters", () => {
    const ids = new SessionIdentities();
    ids.set("s", { model: "m".repeat(500) });
    expect(ids.get("s")?.model).toHaveLength(200);
  });

  it("remembers the last 2000 sessions: the least recently reported one goes first", () => {
    const ids = new SessionIdentities();
    for (let i = 0; i < 2000; i++) ids.set(`session-${i}`, { model: `m${i}` });
    ids.set("session-0", { harness: "h" }); // reported again: now the most recent
    ids.set("session-2000", { model: "m2000" });
    expect(ids.get("session-0")).toEqual({ model: "m0", harness: "h" });
    expect(ids.get("session-1")).toBeUndefined(); // evicted
    expect(ids.get("session-2")).toEqual({ model: "m2" });
    expect(ids.get("session-2000")).toEqual({ model: "m2000" });
  });
});
