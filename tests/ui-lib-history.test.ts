/**
 * The history screens' helpers (src/ui/lib/history.ts): who made a change, journal paging and
 * batches, change feed lines, and the row diffs of table_changes (fed with a real answer of the
 * test vault). Also the parity of the UI's RECORD_ONLY_OPS with the engine's.
 */

import { describe, expect, it } from "vitest";
import { RECORD_ONLY_OPS as ENGINE_RECORD_ONLY_OPS } from "../src/core/changeset";
import { RECORD_ONLY_OPS } from "../src/ui/lib/format";
import { actorLabel, changeSummary, groupBatches, nextBefore, pairChanges } from "../src/ui/lib/history";
import { openTestVault } from "./helpers/test-vault";

describe("actorLabel", () => {
  it("names the credential and the agent", () => {
    expect(actorLabel({ auth: "cook", harness: "claude-code", model: "claude-opus-5-5", session: "s1" })).toBe("cook · claude-code / claude-opus-5-5");
    expect(actorLabel({ auth: "owner" })).toBe("owner");
    expect(actorLabel({ harness: "datanotes-ui" })).toBe("datanotes-ui");
    expect(actorLabel({ model: "m", harness: "" })).toBe("m");
    expect(actorLabel({ auth: "owner", harness: "datanotes-ui" }, "x")).toBe("owner · datanotes-ui");
  });
  it("falls back to by, then to unknown", () => {
    expect(actorLabel(undefined, "agent / model")).toBe("agent / model");
    expect(actorLabel({ session: "s" }, "by")).toBe("by");
    expect(actorLabel()).toBe("unknown (hand edit or engine)");
    expect(actorLabel({})).toBe("unknown (hand edit or engine)");
  });
});

describe("nextBefore", () => {
  it("gives the last executed_at of a full page only", () => {
    const rows = [{ executed_at: "b" }, { executed_at: "a" }];
    expect(nextBefore(rows, 2)).toBe("a");
    expect(nextBefore(rows, 3)).toBeNull();
    expect(nextBefore([], 0)).toBeNull();
  });
});

describe("groupBatches", () => {
  it("puts a batch's operations under it and keeps the others", () => {
    const rows = [
      { migration_id: "b1", members: ["m1", "m2"] },
      { migration_id: "m2", batch: "b1" },
      { migration_id: "m1", batch: "b1" },
      { migration_id: "x" },
      { migration_id: "m9", batch: "gone" },
    ];
    const g = groupBatches(rows);
    expect(g.map((r) => r.migration_id)).toEqual(["b1", "x", "m9"]);
    expect(g[0]!.children.map((r) => r.migration_id)).toEqual(["m2", "m1"]);
    expect(g[1]!.children).toEqual([]);
    expect(g[2]!.children).toEqual([]);
  });
});

describe("changeSummary", () => {
  const base = { table: "work.planning.task", path: "a/Build it.md" };
  it("says what happened to which row", () => {
    expect(changeSummary({ ...base, kind: "insert" })).toBe("New task: Build it");
    expect(changeSummary({ ...base, kind: "update", changes: { status: { before: "a", after: "b" }, due: {} } })).toBe("Changed task Build it: status, due");
    expect(changeSummary({ ...base, kind: "update" })).toBe("Changed task Build it");
    expect(changeSummary({ ...base, kind: "delete" })).toBe("Deleted task: Build it");
    expect(changeSummary({ ...base, kind: "move" })).toBe("Moved task: Build it");
    expect(changeSummary({ table: null, path: "datanotes/metastore.yaml", kind: "metastore" })).toBe("Changed the tables' definitions (metastore.yaml)");
    expect(changeSummary({ table: null, path: "N.md", kind: "unreadable" })).toBe("Unreadable front matter: N");
    expect(changeSummary({ table: null, path: "", kind: "tool_call", call: { tool: "select_rows", ok: true } })).toBe("Called select_rows");
    expect(changeSummary({ table: null, path: "", kind: "tool_call", call: { tool: "insert_row", ok: false } })).toBe("Called insert_row (refused)");
    expect(changeSummary({ table: null, path: "", kind: "tool_call" })).toBe("Called a tool");
    expect(changeSummary({ table: null, path: "x/N.md", kind: "other" })).toBe("other: N");
  });
});

describe("pairChanges", () => {
  const meta = (type: string, version: number) => ({ _change_type: type, _commit_version: version, _commit_timestamp: "t", _operation: "UPDATE" });
  it("pairs pre and post images, and keeps inserts, deletes and metadata", () => {
    const diffs = pairChanges([
      { ...meta("metadata", 2) },
      { ...meta("update_preimage", 2), path: "a.md", x: 1, y: 2 },
      { ...meta("update_postimage", 2), path: "a.md", x: 1, y: 3, z: 4 },
      { ...meta("insert", 2), path: "b.md", x: 5 },
      { ...meta("delete", 2), path: "c.md", x: 6 },
      { ...meta("update_postimage", 3), path: "d.md", x: 7 },
      { _change_type: "update_preimage", path: "e.md", x: 8 },
    ]);
    expect(diffs).toEqual([
      { path: "", version: 2, kind: "metadata", changed: [] },
      { path: "a.md", version: 2, kind: "update", before: { x: 1, y: 2 }, after: { x: 1, y: 3, z: 4 }, changed: ["y", "z"] },
      { path: "b.md", version: 2, kind: "insert", after: { x: 5 }, changed: ["x"] },
      { path: "c.md", version: 2, kind: "delete", before: { x: 6 }, changed: ["x"] },
      { path: "d.md", version: 3, kind: "update", after: { x: 7 }, changed: ["x"] },
      { path: "e.md", kind: "update", before: { x: 8 }, changed: ["x"] },
    ]);
  });

  it("gives one update with the changed columns for a real table_changes answer", async () => {
    const v = await openTestVault("in-process");
    try {
      const t = await v.ok<{ rows: { path: string }[] }>("select_rows", { table: "work.planning.task", limit: 1 });
      const path = t.rows[0]!.path;
      await v.ok("update_row", { table: "work.planning.task", path, set: { priority: "low", estimate_h: 13 }, dry_run: false });
      const tc = await v.ok<{ changes: Record<string, unknown>[] }>("table_changes", { table: "work.planning.task", start_version: 0 });
      const diffs = pairChanges(tc.changes);
      expect(diffs.filter((d) => d.kind === "insert")).toHaveLength(8);
      const updates = diffs.filter((d) => d.kind === "update");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.path).toBe(path);
      expect(updates[0]!.version).toBe(1);
      expect(updates[0]!.changed.sort()).toEqual(["estimate_h", "priority"]);
      expect(updates[0]!.after?.priority).toBe("low");
    } finally {
      await v.stop();
    }
  }, 60_000);
});

describe("RECORD_ONLY_OPS parity", () => {
  it("the UI's list equals the engine's", () => {
    expect(new Set(RECORD_ONLY_OPS)).toEqual(new Set(Object.keys(ENGINE_RECORD_ONLY_OPS)));
  });
});
