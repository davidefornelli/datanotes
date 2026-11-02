/**
 * The database browser's hash routes (src/ui/lib/router.ts): every route round-trips through
 * href() and parseHash(), path segments and query values are encoded, unknown paths are not-found.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { href, navigate, parseHash, type RouteName } from "../src/ui/lib/router";

const CASES: [RouteName, Record<string, string>, Record<string, string>, string][] = [
  ["home", {}, {}, "#/"],
  ["login", {}, { reason: "refused" }, "#/login?reason=refused"],
  ["open", {}, { path: "a/b.md" }, "#/open?path=a%2Fb.md"],
  ["open", {}, { from: "a.md", link: "[[B]]" }, "#/open?from=a.md&link=%5B%5BB%5D%5D"],
  ["ops", {}, {}, "#/ops"],
  ["op", { op: "select_rows" }, {}, "#/ops/select_rows"],
  ["rows", { object: "work.planning.task" }, { where: '{"a":1}', order: "-due", offset: "100", limit: "50", cols: "a,b" }, ""],
  ["rows", { object: "base:dated" }, {}, "#/rows/base%3Adated"],
  ["row", { table: "work.planning.task" }, { path: "t/X.md" }, ""],
  ["new-row", { table: "work.planning.task" }, {}, "#/new-row/work.planning.task"],
  ["note", {}, { path: "Welcome.md" }, ""],
  ["table", { table: "t" }, { tab: "columns" }, "#/table/t?tab=columns"],
  ["view", { view: "v" }, {}, "#/view/v"],
  ["base", { name: "dated" }, {}, "#/base/dated"],
  ["new-table", {}, { catalog: "work", schema: "planning" }, ""],
  ["new-view", {}, {}, "#/new-view"],
  ["tokens", {}, {}, "#/tokens"],
  ["token", { name: "cook" }, {}, "#/tokens/cook"],
  ["matrix", {}, {}, "#/matrix"],
  ["users", {}, {}, "#/users"],
  ["user", { name: "owner" }, {}, "#/users/owner"],
  ["session", { name: "cook", session: "-" }, {}, "#/users/cook/sessions/-"],
  ["journal", {}, { op: "insert_row" }, ""],
  ["changes", {}, {}, "#/changes"],
  ["table-history", { table: "t" }, { from: "1", to: "3" }, ""],
  ["database-history", {}, {}, "#/history"],
  ["config", {}, {}, "#/config"],
  ["settings", {}, {}, "#/settings"],
  ["webhooks", {}, {}, "#/webhooks"],
  ["extensions", {}, {}, "#/extensions"],
  ["status", {}, {}, "#/status"],
  ["semantic", {}, {}, "#/semantic"],
  ["maintenance", {}, {}, "#/maintenance"],
];

describe("router", () => {
  it.each(CASES)("%s round-trips", (name, params, query, exact) => {
    const h = href(name, params, query);
    if (exact) expect(h).toBe(exact);
    expect(parseHash(h)).toEqual({ name, params, query });
  });

  it("encodes spaces, #, ?, %, / and & in params and query values", () => {
    const odd = "a b#c?d%e/f&g=h.md";
    const h = href("row", { table: odd }, { path: odd });
    expect(h).not.toContain(" ");
    expect(h.split("#").length).toBe(2);
    expect(parseHash(h)).toEqual({ name: "row", params: { table: odd }, query: { path: odd } });
  });

  it("drops query keys with empty values", () => {
    expect(href("journal", {}, { op: "", table: "t" })).toBe("#/journal?table=t");
    expect(href("journal", {}, { op: undefined as unknown as string })).toBe("#/journal");
  });

  it("reads home from an empty hash", () => {
    expect(parseHash("")).toEqual({ name: "home", params: {}, query: {} });
    expect(parseHash("#")).toEqual({ name: "home", params: {}, query: {} });
    expect(parseHash("#/")).toEqual({ name: "home", params: {}, query: {} });
    expect(parseHash("/")).toEqual({ name: "home", params: {}, query: {} });
  });

  it("answers not-found for an unknown path, an empty segment or bad encoding", () => {
    expect(parseHash("#/nope").name).toBe("not-found");
    expect(parseHash("#/rows/a/b").name).toBe("not-found");
    expect(parseHash("#/row/").name).toBe("not-found");
    expect(parseHash("#/rows/%E0%A4%A").name).toBe("not-found");
    expect(parseHash("#/nope?x=1").query).toEqual({ x: "1" });
  });

  it("reads query keys without a value, and skips empty or badly encoded parts", () => {
    expect(parseHash("#/journal?flag&&=v&bad=%E0%A4%A&ok=1").query).toEqual({ flag: "", ok: "1" });
  });

  it("makes an empty segment for a missing param, which does not parse", () => {
    expect(href("row")).toBe("#/row/");
    expect(href("nope" as RouteName)).toBe("#/");
  });

  describe("navigate", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("sets the hash, or replaces the entry", () => {
      const loc = { hash: "", replace: vi.fn() };
      vi.stubGlobal("location", loc);
      navigate("table", { table: "t" }, { tab: "columns" });
      expect(loc.hash).toBe("#/table/t?tab=columns");
      navigate("home", undefined, undefined, true);
      expect(loc.replace).toHaveBeenCalledWith("#/");
    });
  });
});
