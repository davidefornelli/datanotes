import Module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorName, currentActor, parseActor, runWithActor, type Actor } from "../src/core/actor";

afterEach(() => vi.restoreAllMocks());

describe("parseActor", () => {
  it("takes the first value of a header sent twice", () => {
    expect(parseActor(['{"harness":"claude-code","model":"claude-opus-5-5"}', '{"harness":"cursor"}'])).toEqual({ harness: "claude-code", model: "claude-opus-5-5" });
  });

  it.each([
    ["an empty object", "{}"],
    ["only unknown keys", '{"user":"alice","auth":"owner","app":"inventory"}'],
    ["only blank or non-string values", '{"harness":"  ","model":3,"session":null}'],
    ["a JSON list", '["claude-code"]'],
    ["JSON null", "null"],
    ["a blank header", "   "],
    ["an empty list of values", []],
  ])("gives no actor for %s", (_title, raw) => {
    expect(parseActor(raw)).toBeUndefined();
  });

  it("trims values and caps them at 200 characters", () => {
    expect(parseActor(JSON.stringify({ session: "  s-42  ", tool: ` ${"x".repeat(250)} `, harness_version: "2.1.0" }))).toEqual({
      session: "s-42",
      tool: "x".repeat(200),
      harness_version: "2.1.0",
    });
  });
});

describe("runWithActor", () => {
  const agent: Actor = { session: "s-1", harness: "claude-code", model: "claude-opus-5-5", tool: "insert_row" };

  it("keeps the actor across awaits of the request, and only there", async () => {
    const seen = await runWithActor(agent, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentActor();
    });
    expect(seen).toEqual(agent);
    expect(currentActor()).toBeUndefined();
  });

  it("runs a request without an actor as is", () => {
    expect(runWithActor(undefined, () => currentActor())).toBeUndefined();
    expect(runWithActor(undefined, () => 42)).toBe(42);
  });

  it("keeps concurrent requests apart", async () => {
    const other: Actor = { harness: "cursor", model: "gpt-x" };
    const later = (a: Actor, ms: number) => runWithActor(a, async () => {
      await new Promise((r) => setTimeout(r, ms));
      return currentActor()?.harness;
    });
    expect(await Promise.all([later(agent, 5), later(other, 1)])).toEqual(["claude-code", "cursor"]);
  });
});

describe("actorName", () => {
  it.each<[string, Actor | undefined, string | undefined]>([
    ["no actor", undefined, undefined],
    ["an actor with no names", { auth: "owner" }, undefined],
    ["harness and model", { harness: "claude-code", model: "claude-opus-5-5" }, "claude-code / claude-opus-5-5"],
    ["the harness alone", { harness: "claude-code", session: "s-1" }, "claude-code"],
    ["the session when nothing else names the agent", { session: "s-1" }, "s-1"],
    ["the owner's token", { harness: "claude-code", auth: "owner" }, "claude-code"],
    ["a named token alone", { auth: "stock-sync" }, "stock-sync"],
    ["an agent behind a named token", { harness: "claude-code", model: "claude-opus-5-5", auth: "stock-sync" }, "claude-code / claude-opus-5-5 via stock-sync"],
    ["a session behind a named token", { session: "s-1", auth: "stock-sync" }, "s-1 via stock-sync"],
    ["a program whose token is named as its harness", { harness: "stock-sync", auth: "stock-sync" }, "stock-sync"],
  ])("names %s", (_title, actor, expected) => {
    expect(actorName(actor)).toBe(expected);
  });
});

describe("a runtime without AsyncLocalStorage", () => {
  afterEach(() => vi.resetModules());

  it("runs requests without an actor and still parses the header", async () => {
    type Loader = { require: (id: string) => unknown };
    const original = (Module.prototype as unknown as Loader).require;
    vi.spyOn(Module.prototype as unknown as Loader, "require").mockImplementation(function (this: unknown, id: string) {
      if (id === "node:async_hooks") throw new Error("Cannot find module 'node:async_hooks'");
      return original.call(this, id);
    });
    vi.resetModules();
    const bare = await import("../src/core/actor");
    vi.restoreAllMocks();
    expect(bare.runWithActor({ harness: "claude-code" }, () => bare.currentActor())).toBeUndefined();
    expect(bare.runWithActor({ harness: "claude-code" }, () => "ran")).toBe("ran");
    expect(bare.parseActor('{"harness":"claude-code"}')).toEqual({ harness: "claude-code" });
  });
});
