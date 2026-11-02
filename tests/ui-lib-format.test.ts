/**
 * The database browser's text helpers (src/ui/lib/format.ts) and its link resolution
 * (src/ui/lib/open.ts, with a fake graph_neighbors).
 */

import { describe, expect, it } from "vitest";
import {
  RECORD_ONLY_OPS,
  basename,
  displayValue,
  formatTime,
  linkTarget,
  relativeTime,
  settingChangeText,
  shortName,
  undoable,
} from "../src/ui/lib/format";

describe("format", () => {
  it("reads wiki link targets", () => {
    expect(linkTarget("[[a/b|Alias]]")).toBe("a/b");
    expect(linkTarget("[[Name#h]]")).toBe("Name");
    expect(linkTarget(" ![[photo.png]] ")).toBe("photo.png");
    expect(linkTarget("[[ Spaced ]]")).toBe("Spaced");
    expect(linkTarget("[[]]")).toBeNull();
    expect(linkTarget("[[#h]]")).toBeNull();
    expect(linkTarget("Name")).toBeNull();
    expect(linkTarget("see [[Name]]")).toBeNull();
  });

  it("shows values as text", () => {
    expect(displayValue(null)).toBe("");
    expect(displayValue(undefined)).toBe("");
    expect(displayValue(["a", 1, null, ["b"]])).toBe("a, 1, , b");
    expect(displayValue({ a: 1 })).toBe('{"a":1}');
    expect(displayValue(true)).toBe("true");
    expect(displayValue(false)).toBe("false");
    expect(displayValue(2.5)).toBe("2.5");
    expect(displayValue("x")).toBe("x");
  });

  it("shortens paths and names", () => {
    expect(basename("a/b/C.md")).toBe("C");
    expect(basename("C.MD")).toBe("C");
    expect(basename("a/b.png")).toBe("b.png");
    expect(shortName("work.planning.task")).toBe("task");
    expect(shortName("task")).toBe("task");
  });

  it("formats times in local time", () => {
    const d = new Date(2026, 10, 2, 7, 5);
    expect(formatTime(d.toISOString())).toBe("2026-11-02 07:05");
    expect(formatTime("not a time")).toBe("not a time");
  });

  it("says how long ago", () => {
    const now = new Date(2026, 10, 2, 12, 0).getTime();
    const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now);
    expect(ago(10_000)).toBe("just now");
    expect(ago(-10_000)).toBe("just now");
    expect(ago(3 * 60_000)).toBe("3 min ago");
    expect(ago(60 * 60_000)).toBe("1 hour ago");
    expect(ago(5 * 3600_000)).toBe("5 hours ago");
    expect(ago(24 * 3600_000)).toBe("1 day ago");
    expect(ago(2 * 86400_000)).toBe("2 days ago");
    expect(ago(40 * 86400_000)).toBe(formatTime(new Date(now - 40 * 86400_000).toISOString()));
    expect(ago(-3600_000)).toBe(formatTime(new Date(now + 3600_000).toISOString()));
    expect(relativeTime("nope", now)).toBe("nope");
    expect(relativeTime(new Date().toISOString())).toBe("just now");
  });

  it("knows what the journal can undo", () => {
    expect(RECORD_ONLY_OPS).toContain("set_engine_settings");
    expect(undoable("set_engine_settings")).toBe(false);
    expect(undoable("move_database")).toBe(false);
    expect(undoable("insert_row")).toBe(true);
  });

  it("writes a settings change as text", () => {
    expect(settingChangeText({ name: "logRetentionDays", before: 30, after: 45 })).toBe("logRetentionDays: 30 → 45");
    expect(settingChangeText({ name: "httpServerToken" })).toBe("httpServerToken: replaced (hidden)");
    expect(settingChangeText({ name: "storeBackupRemote", before: "", after: "https://h/r.git", redacted: true })).toBe(
      'storeBackupRemote: "" → "https://h/r.git" (credentials hidden)',
    );
    expect(settingChangeText({ name: "autoPack", after: true })).toBe("autoPack: default → true");
    expect(settingChangeText({ name: "autoPack", before: false, redacted: false })).toBe("autoPack: false → default");
  });
});
