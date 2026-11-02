/**
 * The engine settings screen's logic (src/ui/lib/settings-form.ts, plan P8b): groups, inputs,
 * the draft, the header patch, confirmations, the rebase after a conflict, refusals, new tokens.
 */

import { describe, expect, it } from "vitest";
import {
  GROUPS,
  confirmationFor,
  groupOf,
  headerPatch,
  headerRows,
  hostOf,
  inputOf,
  newOwnerToken,
  parseInput,
  rebase,
  refusedByName,
  setDraft,
  type SettingView,
} from "../src/ui/lib/settings-form";

function view(name: string, type: SettingView["type"], value: unknown, extra: Partial<SettingView> = {}): SettingView {
  return { name, type, value, changed: false, expected: "", applies: "live", editable: true, restart_pending: false, ...extra };
}

describe("groupOf", () => {
  it("groups by name and prefix, in GROUPS order", () => {
    expect(GROUPS).toEqual(["Journal and logs", "Telemetry", "Automatic work", "Semantic search", "Performance", "Vault", "HTTP server", "Store"]);
    expect(groupOf("logRetentionDays")).toBe("Journal and logs");
    expect(groupOf("telemetryHeaders")).toBe("Telemetry");
    expect(groupOf("autoPack")).toBe("Automatic work");
    expect(groupOf("semanticModel")).toBe("Semantic search");
    expect(groupOf("writePriorityMaxWaitMs")).toBe("Performance");
    expect(groupOf("readCacheMaxBytes")).toBe("Performance");
    expect(groupOf("tableKey")).toBe("Vault");
    expect(groupOf("httpCompression")).toBe("HTTP server");
    expect(groupOf("storeSync")).toBe("Store");
    expect(groupOf("transactionLogFormat")).toBe("Store");
    expect(groupOf("somethingNew")).toBe("Store");
  });
});

describe("inputOf", () => {
  it("shows each type", () => {
    expect(inputOf(view("a", "boolean", true))).toBe(true);
    expect(inputOf(view("a", "boolean", "x"))).toBe(false);
    expect(inputOf(view("a", "integer", 30))).toBe("30");
    expect(inputOf(view("a", "number", 0.5))).toBe("0.5");
    expect(inputOf(view("a", "string", "x"))).toBe("x");
    expect(inputOf(view("a", "enum", "off"))).toBe("off");
    expect(inputOf(view("a", "string", undefined))).toBe("");
    expect(inputOf(view("a", "string_list", ["a", "b"]))).toBe("a\nb");
    expect(inputOf(view("a", "string_list", null))).toBe("");
    expect(inputOf(view("a", "string_map", { X: "<redacted>" }))).toBe("");
    expect(inputOf(view("a", "string", undefined, { write_only: true }))).toBe("");
  });
});

describe("parseInput", () => {
  it("parses booleans", () => {
    const v = view("a", "boolean", true);
    expect(parseInput(v, false)).toEqual({ value: false });
    expect(parseInput(v, "true")).toEqual({ value: true });
    expect(parseInput(v, "false")).toEqual({ value: false });
    expect(parseInput(v, "yes")).toEqual({ error: "choose true or false" });
  });
  it("parses integers and numbers", () => {
    const i = view("a", "integer", 1);
    expect(parseInput(i, " 45 ")).toEqual({ value: 45 });
    expect(parseInput(i, "-3")).toEqual({ value: -3 });
    expect(parseInput(i, "4.5")).toEqual({ error: "a whole number" });
    const n = view("a", "number", 1);
    expect(parseInput(n, " 0.25")).toEqual({ value: 0.25 });
    expect(parseInput(n, " ")).toEqual({ error: "a number" });
    expect(parseInput(n, "abc")).toEqual({ error: "a number" });
    expect(parseInput(n, true)).toEqual({ error: "a number" });
  });
  it("keeps strings and enums as typed, splits lists", () => {
    expect(parseInput(view("a", "string", ""), " x ")).toEqual({ value: " x " });
    expect(parseInput(view("a", "enum", "off"), "remote")).toEqual({ value: "remote" });
    expect(parseInput(view("a", "string_list", []), " a \r\n\nb\n ")).toEqual({ value: ["a", "b"] });
  });
  it("leaves maps and write-only settings to their editors", () => {
    expect(parseInput(view("a", "string_map", {}), "x")).toEqual({ error: "use the editor of this setting" });
    expect(parseInput(view("a", "string", undefined, { write_only: true }), "x")).toEqual({ error: "use the editor of this setting" });
  });
});

describe("setDraft", () => {
  it("adds, replaces and removes", () => {
    const v = view("logRetentionDays", "integer", 30);
    const d0 = {};
    const d1 = setDraft(d0, v, 45);
    expect(d1).toEqual({ logRetentionDays: 45 });
    expect(d0).toEqual({});
    expect(setDraft(d1, v, 50)).toEqual({ logRetentionDays: 50 });
    expect(setDraft(d1, v, 30)).toEqual({});
    const url = view("storeBackupRemote", "string", "https://example.com/r.git", { redacted: true });
    expect(setDraft({}, url, "https://example.com/r.git")).toEqual({});
  });
});

describe("headerPatch", () => {
  it("adds, replaces, removes and reports errors", () => {
    const current = { "X-Api-Key": "<redacted>" };
    expect(
      headerPatch(current, [
        { name: "X-New", value: "v" },
        { name: "X-Api-Key", value: "w" },
      ]),
    ).toEqual({ patch: { "X-New": "v", "X-Api-Key": "w" }, errors: [] });
    expect(headerPatch(current, [{ name: "X-Api-Key", remove: true }, { name: "X-Missing", remove: true }])).toEqual({ patch: { "X-Api-Key": null }, errors: [] });
    expect(headerPatch(current, [{ name: " ", value: "v" }, { name: "X-B", value: "" }, { name: "X-C" }])).toEqual({
      patch: {},
      errors: ["type the header's name", "type the header's value"],
    });
  });
});

describe("confirmationFor and hostOf", () => {
  const views = [
    view("vaultIndexEnabled", "boolean", true, { warning: "W6 text" }),
    view("logRetentionDays", "integer", 30),
    view("telemetryEndpoint", "string", "http://127.0.0.1:4318", { sends_data: true }),
    view("storeBackupRemote", "string", "", { sends_data: true, warning: "pushes the store" }),
  ];
  it("no warning", () => {
    expect(confirmationFor(views, { logRetentionDays: 45 })).toEqual({ warnings: [], requireText: null });
  });
  it("warnings in view order", () => {
    expect(confirmationFor(views, { storeBackupRemote: "", vaultIndexEnabled: false })).toEqual({
      warnings: ["vaultIndexEnabled: W6 text", "storeBackupRemote: pushes the store"],
      requireText: null,
    });
  });
  it("the host to type", () => {
    expect(confirmationFor(views, { storeBackupRemote: "git@github.com:me/s.git" }).requireText).toBe("github.com");
    expect(confirmationFor(views, { storeBackupRemote: "https://x.example/r.git", telemetryEndpoint: "https://otlp.example.com/x" }).requireText).toBe("otlp.example.com");
    expect(confirmationFor(views, { telemetryEndpoint: null }).requireText).toBeNull();
  });
  it("hostOf", () => {
    expect(hostOf("https://u:p@example.com:8443/r.git")).toBe("example.com");
    expect(hostOf("git@github.com:me/s.git")).toBe("github.com");
    expect(hostOf("file:///srv/r.git")).toBe("file:///srv/r.git");
    expect(hostOf("plain text")).toBe("plain text");
  });
});

describe("rebase", () => {
  const before = [view("a", "integer", 1), view("b", "integer", 2), view("t", "string", undefined, { write_only: true, changed: true }), view("c", "integer", 3)];
  it("keeps the edits nobody changed meanwhile", () => {
    const after = [view("a", "integer", 1), view("b", "integer", 5), view("t", "string", undefined, { write_only: true, changed: true })];
    expect(rebase(before, after, { c: 9, b: 7, a: 4, t: "tok", z: 1 })).toEqual({ draft: { a: 4, t: "tok" }, dropped: ["b", "c", "z"] });
  });
  it("drops on a changed flag, write-only compares changed only", () => {
    const after = [view("a", "integer", 1, { changed: true }), view("t", "string", "ignored", { write_only: true, changed: false })];
    expect(rebase(before, after, { a: 4, t: "tok" })).toEqual({ draft: {}, dropped: ["a", "t"] });
    const same = [view("t", "string", "other", { write_only: true, changed: true })];
    expect(rebase(before, same, { t: "tok" })).toEqual({ draft: { t: "tok" }, dropped: [] });
  });
});

describe("refusedByName", () => {
  it("maps refused values, ignores the rest", () => {
    expect(refusedByName({ error: "x", refused: [{ setting: "journalRetentionDays", error: "setting journalRetentionDays: 0 is not allowed", hint: "h" }, null, { setting: 1 }] })).toEqual({
      journalRetentionDays: "setting journalRetentionDays: 0 is not allowed",
    });
    expect(refusedByName({ error: "x" })).toEqual({});
    expect(refusedByName(null)).toEqual({});
    expect(refusedByName("x")).toEqual({});
  });
});

describe("newOwnerToken", () => {
  it("48 hex characters from 24 bytes", () => {
    const fixed = newOwnerToken((n) => Uint8Array.from({ length: n }, (_, i) => i * 10));
    expect(fixed).toBe("000a141e28323c46505a646e78828c96a0aab4bec8d2dce6");
    const t = newOwnerToken();
    expect(t).toHaveLength(48);
    expect(t).toMatch(/^[0-9a-f]+$/);
  });
});

describe("headerRows", () => {
  const current = { "X-Api-Key": "", "X-Org": "" };
  it("rebuilds the rows from the draft's patch", () => {
    expect(headerRows(current, { "X-Api-Key": "new", "X-Org": null, "X-New": "v", "X-Gone": null })).toEqual({
      rows: [
        { name: "X-Api-Key", value: "new", remove: false, existing: true },
        { name: "X-Org", value: "", remove: true, existing: true },
        { name: "X-New", value: "v", remove: false, existing: false },
      ],
      replacing: ["X-Api-Key"],
    });
  });
  it("gives the plain rows for a patch that is not an object", () => {
    const plain = {
      rows: [
        { name: "X-Api-Key", value: "", remove: false, existing: true },
        { name: "X-Org", value: "", remove: false, existing: true },
      ],
      replacing: [],
    };
    for (const patch of [undefined, "x", ["a"]]) expect(headerRows(current, patch)).toEqual(plain);
  });
  it("gives no rows for no header and an empty patch", () => {
    expect(headerRows({}, {})).toEqual({ rows: [], replacing: [] });
  });
});
