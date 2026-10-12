import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { normalizeDatetime } from "../src/core/datetime";
import { alterColumn, createTable, dropColumn, INDEX_RETRY, renameColumn } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { alterTable, insertRow, recomputeColumns, updateRows } from "../src/core/rows";
import { createDbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const fm = (v: { read(p: string): string }, p: string) =>
  Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);

describe("RFC 3339 date-times", () => {
  it("completes wall-clock values with the zone offset of that day", () => {
    expect(normalizeDatetime("2026-09-26T22:30", "Europe/Rome")).toBe("2026-09-26T22:30:00+02:00");
    expect(normalizeDatetime("2026-01-10T08:05:07", "Europe/Rome")).toBe("2026-01-10T08:05:07+01:00");
    expect(normalizeDatetime("2026-03-29T03:30", "Europe/Rome")).toBe("2026-03-29T03:30:00+02:00"); // after the spring jump
    expect(normalizeDatetime("2026-03-29T01:30", "Europe/Rome")).toBe("2026-03-29T01:30:00+01:00");
    expect(normalizeDatetime("2026-09-26T22:30:00.250", "America/New_York")).toBe("2026-09-26T22:30:00.250-04:00");
    expect(normalizeDatetime("2026-09-26T22:30", "UTC")).toBe("2026-09-26T22:30:00Z");
    expect(normalizeDatetime("2026-09-26T22:30:00+02:00", "UTC")).toBe("2026-09-26T22:30:00+02:00");
    expect(normalizeDatetime("2026-09-26T22:30", "")).toBe("2026-09-26T22:30");
    expect(normalizeDatetime("2026-09-26", "Europe/Rome")).toBe("2026-09-26");
    expect(normalizeDatetime(3, "Europe/Rome")).toBe(3);
  });
});

const COLUMNS = [
  { name: "id", type: "string", unique: true },
  { name: "occurred_at", type: "datetime", required: true, dense: true },
  { name: "value", type: "enum", values: ["minor", "moderate", "major"], ordered: true, dense: true },
];

async function metricsVault() {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  await createTable(v.app, v.settings, described({
    schema: "metrics",
    name: "stress",
    timeColumn: "occurred_at",
    columns: COLUMNS,
    options: { description: "Stress", aliases: ["tension"] },
  }));
  return v;
}

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("rows with a time zone and a system id", () => {
  it("insert completes the date-time and assigns a UUIDv7 id, independent of the file name", async () => {
    const v = await metricsVault();
    const a = await insertRow(v.app, v.settings, { table: "stress", values: { occurred_at: "2026-09-26T22:30", value: "major" } });
    const b = await insertRow(v.app, v.settings, { table: "stress", values: { occurred_at: "2026-09-26T22:30", value: "moderate" } });
    expect([a.planned_creates, b.planned_creates]).toEqual([
      ["Datanotes/main/metrics/stress/2026-09-26T2230.md"],
      ["Datanotes/main/metrics/stress/2026-09-26T2230-2.md"],
    ]);
    const first = fm(v, "Datanotes/main/metrics/stress/2026-09-26T2230.md");
    const second = fm(v, "Datanotes/main/metrics/stress/2026-09-26T2230-2.md");
    expect(first).toMatchObject({ occurred_at: "2026-09-26T22:30:00+02:00" });
    expect(first.id).toMatch(UUID7);
    expect(second.id).toMatch(UUID7);
    expect(second.id).not.toBe(first.id);
    expect(v.read("Datanotes/main/metrics/stress/2026-09-26T2230.md").startsWith(`---\ntable: main.metrics.stress\nid: ${first.id as string}\n`)).toBe(true);
    await expect(insertRow(v.app, v.settings, { table: "stress", values: { id: "x", occurred_at: "2026-09-27T08:00", value: "minor" } })).rejects.toThrow(/generated/);
    await expect(updateRows(v.app, v.settings, { table: "stress", where: { id: first.id }, set: { id: "x" } })).rejects.toThrow(/generated/);
    const upd = await updateRows(v.app, v.settings, { table: "stress", where: { id: second.id }, set: { occurred_at: "2026-01-05T07:00" } });
    expect(upd.ok).toBe(true);
    expect(fm(v, "Datanotes/main/metrics/stress/2026-01-05T0700.md")).toMatchObject({ id: second.id, occurred_at: "2026-01-05T07:00:00+01:00" });
  });

  it("the id survives renames; the system column cannot be dropped or changed", async () => {
    const v = await metricsVault();
    await insertRow(v.app, v.settings, { table: "stress", values: { occurred_at: "2026-09-26T22:30", value: "major" } });
    const id = fm(v, "Datanotes/main/metrics/stress/2026-09-26T2230.md").id;
    const r = await alterTable(v.app, v.settings, { table: "metrics.stress", filename: "{occurred_at:YYYY-MM-DD}" });
    expect(r.planned_moves).toEqual([{ from: "Datanotes/main/metrics/stress/2026-09-26T2230.md", to: "Datanotes/main/metrics/stress/2026-09-26.md" }]);
    expect(fm(v, "Datanotes/main/metrics/stress/2026-09-26.md").id).toBe(id);
    await expect(dropColumn(v.app, v.settings, { table: "stress", name: "id" })).rejects.toThrow(/system row id/);
    await expect(renameColumn(v.app, v.settings, { table: "stress", from: "id", to: "uid" })).rejects.toThrow(/system row id/);
    await expect(alterColumn(v.app, v.settings, { table: "stress", name: "id", changes: { unique: false } })).rejects.toThrow(/system row id/);
    expect((await alterColumn(v.app, v.settings, { table: "stress", name: "id", changes: { label: "ID" } })).ok).toBe(true);
  });

  it("recompute gives a duplicated note a new id and fills missing ones", async () => {
    const v = await metricsVault();
    await insertRow(v.app, v.settings, { table: "stress", values: { occurred_at: "2026-09-26T22:30", value: "major" } });
    const original = v.read("Datanotes/main/metrics/stress/2026-09-26T2230.md");
    const id = fm(v, "Datanotes/main/metrics/stress/2026-09-26T2230.md").id;
    await new Promise((r) => setTimeout(r, 20));
    v.write("Datanotes/main/metrics/stress/copy.md", original); // like "Make a copy" in Obsidian
    v.write("Other/by-hand.md", "---\ntable: metrics.stress\noccurred_at: 2026-09-27T08:00\nvalue: minor\n---\n");
    const r = await recomputeColumns(v.app, v.settings, { table: "stress" });
    expect(r.ok).toBe(true);
    expect(fm(v, "Datanotes/main/metrics/stress/2026-09-26T2230.md").id).toBe(id);
    expect(fm(v, "Datanotes/main/metrics/stress/copy.md").id).toMatch(UUID7);
    expect(fm(v, "Datanotes/main/metrics/stress/copy.md").id).not.toBe(id);
    expect(fm(v, "Other/by-hand.md").id).toMatch(UUID7);
    const all = await recomputeColumns(v.app, v.settings, { table: "stress", newIds: true });
    expect(all.planned_edits).toHaveLength(3);
    expect(fm(v, "Datanotes/main/metrics/stress/2026-09-26T2230.md").id).not.toBe(id);
  });
});
