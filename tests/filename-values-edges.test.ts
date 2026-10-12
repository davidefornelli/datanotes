import { describe, expect, it } from "vitest";
import { valuesFromFilename } from "../src/core/filename-values";

describe("valuesFromFilename: date and time formats", () => {
  it.each([
    ["{at:YYYY-MM-DD HH}", "2026-09-30 08", { at: "2026-09-30T08:00" }],
    ["{at:YYYY-MM-DD HH[h]}", "2026-09-30 08h", { at: "2026-09-30T08:00" }],
    ["{at:YYYYMMDD[T]HHmmss}", "20260930T083015", { at: "2026-09-30T08:30:15" }],
    ["{at:DD.MM.YYYY HH.mm}", "30.09.2026 08.30", { at: "2026-09-30T08:30" }],
  ])("%s reads %s", (pattern, basename, values) => {
    expect(valuesFromFilename(pattern, basename)).toEqual(values);
  });

  it("a format without year, month and day cannot rebuild a date: the name does not fit", () => {
    expect(valuesFromFilename("{month:YYYY-MM}", "2026-09")).toBeNull();
    expect(valuesFromFilename("{date:YYYY}-{date:MM-DD}", "2026-09-30")).toBeNull();
    expect(valuesFromFilename("{at:HH-mm}", "08-30")).toBeNull();
  });

  it("the literal text of the pattern and of the format matches only itself", () => {
    expect(valuesFromFilename("({kind}) {date:YYYY.MM.DD}", "(walk) 2026.09.30")).toEqual({ kind: "walk", date: "2026-09-30" });
    expect(valuesFromFilename("({kind}) {date:YYYY.MM.DD}", "(walk) 2026x09x30")).toBeNull();
    expect(valuesFromFilename("{date:YYYY-MM-DD} [draft]", "2026-09-30 [draft]")).toEqual({ date: "2026-09-30" });
  });
});

describe("valuesFromFilename: plain columns", () => {
  it("a column named twice must have the same value in both places", () => {
    expect(valuesFromFilename("{kind} {date:YYYY-MM-DD} {kind}", "walk 2026-09-30 walk")).toEqual({ kind: "walk", date: "2026-09-30" });
    expect(valuesFromFilename("{kind} {date:YYYY-MM-DD} {kind}", "walk 2026-09-30 run")).toBeNull();
  });

  it("two columns next to each other split at the first separator", () => {
    expect(valuesFromFilename("{name} {surname}", "Ada King Lovelace")).toEqual({ name: "Ada", surname: "King Lovelace" });
  });
});
