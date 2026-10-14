import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { keepIndexersOut, MARKED, SPOTLIGHT_MARKER, TIME_MACHINE_MARKER } from "../src/node/store-hygiene";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "store-hygiene-"));

describe("search indexers kept out of the store", () => {
  it("Windows: the store, then once what it holds, marked not content indexed, in the background", () => {
    const store = tmp();
    const calls: [string, string[], unknown][] = [];
    const handlers: Record<string, ((code: number | null) => void)[]> = { error: [], exit: [] };
    let unrefs = 0;
    const spawn = (command: string, args: string[], options: unknown) => {
      calls.push([command, args, options]);
      return { on: (e: string, cb: (code: number | null) => void) => void handlers[e]!.push(cb), unref: () => void unrefs++ };
    };
    keepIndexersOut(store, { platform: "win32", spawn });
    expect(calls).toEqual([
      ["attrib", ["+I", store], { stdio: "ignore", windowsHide: true }],
      ["attrib", ["+I", path.join(store, "*"), "/S", "/D"], { stdio: "ignore", windowsHide: true }],
    ]);
    expect(unrefs).toBe(2);
    for (const cb of handlers.error!) expect(cb(null)).toBeUndefined(); // a failure to start attrib changes nothing
    // a failed run marks again at the next start; a run that ended well records it
    handlers.exit![0]!(1);
    expect(fs.existsSync(path.join(store, MARKED))).toBe(false);
    handlers.exit![0]!(0);
    expect(fs.existsSync(path.join(store, MARKED))).toBe(true);
    calls.length = 0;
    keepIndexersOut(store, { platform: "win32", spawn });
    expect(calls).toEqual([["attrib", ["+I", store], { stdio: "ignore", windowsHide: true }]]);
    // a store gone meanwhile: nothing recorded, nothing thrown
    fs.rmSync(store, { recursive: true });
    expect(() => handlers.exit![0]!(0)).not.toThrow();
  });

  it("macOS: an empty .metadata_never_index for Spotlight, written once; the vault index kept out of Time Machine once tmutil succeeded", () => {
    const store = tmp();
    const calls: [string, string[], unknown][] = [];
    const handlers: Record<string, ((code: number | null) => void)[]> = { error: [], exit: [] };
    let unrefs = 0;
    const spawn = (command: string, args: string[], options: unknown) => {
      calls.push([command, args, options]);
      return { on: (e: string, cb: (code: number | null) => void) => void handlers[e]!.push(cb), unref: () => void unrefs++ };
    };
    const index = path.join(store, "index");
    keepIndexersOut(store, { platform: "darwin", spawn });
    expect(fs.readFileSync(path.join(store, SPOTLIGHT_MARKER), "utf8")).toBe("");
    expect(calls).toEqual([["tmutil", ["addexclusion", index], { stdio: "ignore", windowsHide: true }]]);
    expect(fs.statSync(index).isDirectory()).toBe(true);
    expect(unrefs).toBe(1);
    for (const cb of handlers.error!) expect(cb(null)).toBeUndefined(); // tmutil missing: nothing changes
    handlers.exit![0]!(1); // tmutil failed: asked again at the next start
    expect(fs.existsSync(path.join(index, TIME_MACHINE_MARKER))).toBe(false);
    keepIndexersOut(store, { platform: "darwin", spawn });
    expect(calls).toHaveLength(2);
    handlers.exit![1]!(0);
    expect(fs.existsSync(path.join(index, TIME_MACHINE_MARKER))).toBe(true);
    fs.writeFileSync(path.join(store, SPOTLIGHT_MARKER), "kept");
    keepIndexersOut(store, { platform: "darwin", spawn });
    expect(calls).toHaveLength(2); // excluded once: not asked again
    expect(fs.readFileSync(path.join(store, SPOTLIGHT_MARKER), "utf8")).toBe("kept");
    fs.rmSync(store, { recursive: true });
    expect(() => handlers.exit![1]!(0)).not.toThrow(); // a store gone meanwhile: nothing thrown
  });

  it("macOS with the vault index off: Spotlight's marker only, no index folder, no tmutil", () => {
    const store = tmp();
    const calls: string[] = [];
    const spawn = (command: string) => {
      calls.push(command);
      return { on: () => undefined, unref: () => undefined };
    };
    keepIndexersOut(store, { platform: "darwin", spawn, index: false });
    expect(fs.readFileSync(path.join(store, SPOTLIGHT_MARKER), "utf8")).toBe("");
    expect(fs.existsSync(path.join(store, "index"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("Linux: nothing; a store that cannot be marked is left as it is", () => {
    const store = tmp();
    keepIndexersOut(store, { platform: "linux" });
    expect(fs.readdirSync(store)).toEqual([]);
    expect(() => keepIndexersOut(path.join(store, "missing", "store"), { platform: "darwin" })).not.toThrow();
    expect(() =>
      keepIndexersOut(store, {
        platform: "win32",
        spawn: () => {
          throw new Error("spawn EPERM");
        },
      }),
    ).not.toThrow();
  });
});
