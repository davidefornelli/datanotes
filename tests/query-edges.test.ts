import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { computeOrderedAggregate, enumPosition } from "../src/core/query";
import { insertRow, select } from "../src/core/rows";
import type { ColumnSpec } from "../src/core/types-table";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const SEVERITY: ColumnSpec = { name: "severity", type: "enum", values: ["minor", "moderate", "major"], ordered: true, required: false, aliases: [] };

describe("enumPosition", () => {
  it.each([
    ["minor", 1],
    ["major", 3],
    ["critical", null],
    ["", null],
    [true, null],
    [null, null],
  ])("%j is at %j", (value, position) => {
    expect(enumPosition(SEVERITY, value)).toBe(position);
  });

  it("a number matches the value written as text", () => {
    expect(enumPosition({ ...SEVERITY, values: ["1", "2", "3"] }, 2)).toBe(2);
  });

  it("an enum that is not ordered, or no column, has no positions", () => {
    expect(enumPosition({ ...SEVERITY, ordered: false }, "minor")).toBeNull();
    expect(enumPosition(undefined, "minor")).toBeNull();
  });
});

describe("computeOrderedAggregate", () => {
  const values = ["moderate", "minor", "critical", null, "major", "moderate"];
  it("min and max give the value, sum and avg the positions; values outside the enum are left out", () => {
    expect(computeOrderedAggregate("min", SEVERITY, values, 6)).toBe("minor");
    expect(computeOrderedAggregate("max", SEVERITY, values, 6)).toBe("major");
    expect(computeOrderedAggregate("sum", SEVERITY, values, 6)).toBe(8);
    expect(computeOrderedAggregate("avg", SEVERITY, values, 6)).toBe(2);
    expect(computeOrderedAggregate("count", SEVERITY, values, 6)).toBe(6);
  });

  it("no value of the enum: null", () => {
    expect(computeOrderedAggregate("max", SEVERITY, ["critical", null], 2)).toBeNull();
    expect(computeOrderedAggregate("avg", SEVERITY, [], 0)).toBeNull();
  });
});

/** Symptoms with an ordered severity; one note edited by hand with a value outside the enum. */
async function symptoms(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  await createTable(v.app, v.settings, described({
    name: "symptom",
    options: { filename: "{name}" },
    columns: [{ name: "name", type: "string", required: true }, { name: "area", type: "string" }, { name: "severity", type: "enum", values: ["minor", "moderate", "major"], ordered: true }],
  }));
  for (const [name, area, severity] of [["Headache", "head", "moderate"], ["Migraine", "head", "major"], ["Cramp", "leg", "minor"]] as const) {
    expect((await insertRow(v.app, v.settings, { table: "symptom", values: { name, area, severity } })).ok).toBe(true);
  }
  v.write("Datanotes/main/public/symptom/Ache.md", "---\ntable: main.public.symptom\nname: Ache\narea: leg\nseverity: critical\n---\n");
  return v;
}

describe("ordered enums in select", () => {
  it("compare by position; a value outside the enum is compared as it is and matches no range", async () => {
    const v = await symptoms();
    const names = async (where: Record<string, unknown>) => (await select(v.app, v.settings, { table: "symptom", where, columns: ["name"], orderBy: "name" })).rows.map((r) => r.name);
    expect(await names({ severity: { gte: "moderate" } })).toEqual(["Headache", "Migraine"]);
    expect(await names({ severity: { gt: "critical" } })).toEqual([]);
    expect(await names({ severity: { lt: "critical" } })).toEqual([]);
    expect(await names({ severity: "critical" })).toEqual(["Ache"]);
  });

  it("group aggregates ignore a value outside the enum", async () => {
    const v = await symptoms();
    const r = await select(v.app, v.settings, { table: "symptom", groupBy: "area", aggregates: { worst: "max:severity", mildest: "min:severity", n: "count" } });
    expect(r.rows).toEqual([
      { area: "head", worst: "major", mildest: "moderate", n: 2 },
      { area: "leg", worst: "minor", mildest: "minor", n: 2 },
    ]);
  });
});
