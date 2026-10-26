/** Link values into packs of rows (`[[pack#row]]`): the names they give and what a host resolves (src/core/validate.ts). */
import { afterEach, describe, expect, it } from "vitest";
import { countPackName, linkNoteName, wikilinkTarget, wikilinkTargets } from "../src/core/validate";
import { renderPathTemplate } from "../src/core/path-templates";

afterEach(() => countPackName("feed 2026-10", -1));

describe("links into packs of rows", () => {
  it("a link into a known pack names the row; any other link names its note", () => {
    expect(linkNoteName("[[feed 2026-10#2026-10-01T0800]]")).toBe("feed 2026-10");
    countPackName("feed 2026-10", 1);
    expect(linkNoteName("[[feed 2026-10#2026-10-01T0800|first]]")).toBe("2026-10-01T0800");
    expect(linkNoteName("[[Feed 2026-10#2026-10-01T0800#Notes]]")).toBe("2026-10-01T0800");
    expect(linkNoteName("[[feed 2026-10]]")).toBe("feed 2026-10");
    expect(linkNoteName("[[People/Alice.md#Work|A]]")).toBe("Alice");
    expect(linkNoteName("not a link")).toBeNull();
    // the name kept while two packs have it
    countPackName("feed 2026-10", 1);
    countPackName("feed 2026-10", -1);
    expect(linkNoteName("[[feed 2026-10#x]]")).toBe("x");
  });

  it("wikilinkTarget: the heading too where the host has packs", () => {
    expect(wikilinkTarget("[[a#b|c]]", false)).toBe("a");
    expect(wikilinkTarget("[[a#b|c]]", true)).toBe("a#b");
    expect(wikilinkTarget("[[a#]]", true)).toBe("a");
    expect(wikilinkTarget("[[a]]", true)).toBe("a");
    expect(wikilinkTarget("a", true)).toBeNull();
    expect(wikilinkTarget(3, true)).toBeNull();
    expect(wikilinkTargets(["[[a#b]]", "x", "[[c]]"], true)).toEqual([{ path: "a", lookup: "a#b" }, { path: "c", lookup: "c" }]);
    expect(wikilinkTargets("[[a#b]]", false)).toEqual([{ path: "a", lookup: "a" }]);
  });

  it("a path template takes a packed row by its own name, any other link by its file name as written", () => {
    countPackName("feed 2026-10", 1);
    const at = (v: string) => renderPathTemplate("x/{link}", new Map([["link", v]]));
    expect(at("[[feed 2026-10#2026-10-01T0800]]")).toBe("x/2026-10-01T0800");
    expect(at("[[Folder/Note.md]]")).toBe("x/Note.md");
    expect(at("plain")).toBe("x/plain");
  });
});
