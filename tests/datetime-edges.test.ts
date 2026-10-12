import { afterEach, describe, expect, it, vi } from "vitest";
import { isoAt, isValidTimeZone, normalizeDatetime, resolveDateToken, resolveDateTokens, resolveDefault, wallClock } from "../src/core/datetime";
import { DEFAULT_NOW, DEFAULT_TODAY } from "../src/core/types-table";

/** 23:30 UTC on 29 September 2026: already 30 September in India, still the 29th in New York. */
const LATE_EVENING_UTC = new Date("2026-09-29T23:30:15.250Z");

afterEach(() => vi.restoreAllMocks());

describe("isValidTimeZone", () => {
  it.each(["Europe/Rome", "America/New_York", "Asia/Kolkata", "Asia/Kathmandu", "UTC"])("accepts the IANA zone %s", (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it.each([
    ["an empty name", ""],
    ["a blank name", "   "],
    ["a fixed offset", "+02:00"],
    ["a negative fixed offset", "-0500"],
    ["the word local", "local"],
    ["the word local in any case", "Local"],
    ["an unknown zone", "Mars/Olympus_Mons"],
  ])("rejects %s", (_title, tz) => {
    expect(isValidTimeZone(tz)).toBe(false);
  });
});

describe("normalizeDatetime with real time zones", () => {
  it.each([
    ["half-hour offset (India)", "2026-01-15T09:00", "Asia/Kolkata", "2026-01-15T09:00:00+05:30"],
    ["three-quarter offset (Nepal)", "2026-07-01T18:45", "Asia/Kathmandu", "2026-07-01T18:45:00+05:45"],
    ["negative half-hour, winter (Newfoundland)", "2026-01-15T09:00", "America/St_Johns", "2026-01-15T09:00:00-03:30"],
    ["negative half-hour, summer (Newfoundland)", "2026-07-15T09:00", "America/St_Johns", "2026-07-15T09:00:00-02:30"],
    ["New York in winter", "2026-01-15T09:00", "America/New_York", "2026-01-15T09:00:00-05:00"],
    ["London in summer", "2026-07-01T12:00", "Europe/London", "2026-07-01T12:00:00+01:00"],
    ["fraction of one digit kept", "2026-12-31T23:59:59.5", "Asia/Kolkata", "2026-12-31T23:59:59.5+05:30"],
  ])("completes a wall-clock time: %s", (_title, value, tz, expected) => {
    expect(normalizeDatetime(value, tz)).toBe(expected);
  });

  it("writes Z only for the zone named UTC; a zero offset elsewhere stays +00:00", () => {
    expect(normalizeDatetime("2026-01-15T09:00", "UTC")).toBe("2026-01-15T09:00:00Z");
    expect(normalizeDatetime("2026-01-15T09:00", "Europe/London")).toBe("2026-01-15T09:00:00+00:00");
    expect(normalizeDatetime("2026-01-15T09:00", "Africa/Abidjan")).toBe("2026-01-15T09:00:00+00:00");
  });

  it.each([
    ["an explicit Z", "2026-09-26T22:30Z"],
    ["a space instead of T", "2026-09-26 22:30"],
    ["a one-digit hour", "2026-09-26T7:30"],
    ["a four-digit fraction", "2026-09-26T22:30:00.1234"],
  ])("leaves values that are not naive date-times unchanged: %s", (_title, value) => {
    expect(normalizeDatetime(value, "Europe/Rome")).toBe(value);
  });
});

describe("isoAt", () => {
  const ms = Date.UTC(2026, 8, 29, 6, 30, 15, 999);

  it.each([
    ["no zone: UTC with Z, milliseconds dropped", "", "2026-09-29T06:30:15Z"],
    ["the UTC zone: Z", "UTC", "2026-09-29T06:30:15Z"],
    ["Europe/Rome in summer time", "Europe/Rome", "2026-09-29T08:30:15+02:00"],
    ["Asia/Kolkata", "Asia/Kolkata", "2026-09-29T12:00:15+05:30"],
    ["America/New_York in summer time", "America/New_York", "2026-09-29T02:30:15-04:00"],
    ["America/St_Johns", "America/St_Johns", "2026-09-29T04:00:15-02:30"],
  ])("writes the instant in %s", (_title, tz, expected) => {
    expect(isoAt(ms, tz)).toBe(expected);
  });

  it("rolls over the year in a zone east of UTC", () => {
    expect(isoAt(Date.UTC(2026, 11, 31, 20, 0, 0), "Asia/Kolkata")).toBe("2027-01-01T01:30:00+05:30");
    expect(isoAt(Date.UTC(2027, 0, 1, 3, 0, 0), "America/New_York")).toBe("2026-12-31T22:00:00-05:00");
  });
});

describe("resolveDateToken", () => {
  it("{today} is the date in the database time zone, not in UTC", () => {
    expect(resolveDateToken("{today}", "Asia/Kolkata", LATE_EVENING_UTC)).toBe("2026-09-30");
    expect(resolveDateToken("{today}", "America/New_York", LATE_EVENING_UTC)).toBe("2026-09-29");
    expect(resolveDateToken("{today}", "UTC", LATE_EVENING_UTC)).toBe("2026-09-29");
    expect(resolveDateToken("{today}", "", LATE_EVENING_UTC)).toBe("2026-09-29");
  });

  it("moves {today} by days and weeks on the calendar", () => {
    expect(resolveDateToken("{today+1d}", "Asia/Kolkata", LATE_EVENING_UTC)).toBe("2026-10-01");
    expect(resolveDateToken("{today-2w}", "America/New_York", LATE_EVENING_UTC)).toBe("2026-09-15");
    // the end of summer time (25 October in Rome) does not shift a date
    expect(resolveDateToken("{today+30d}", "Europe/Rome", LATE_EVENING_UTC)).toBe("2026-10-30");
  });

  it("leaves {today} with hours unchanged: hours make no sense on a date", () => {
    expect(resolveDateToken("{today-12h}", "Europe/Rome", LATE_EVENING_UTC)).toBe("{today-12h}");
    expect(resolveDateToken("{today+1h}", "", LATE_EVENING_UTC)).toBe("{today+1h}");
  });

  it("writes {now} in the database time zone, seconds included", () => {
    expect(resolveDateToken("{now}", "", LATE_EVENING_UTC)).toBe("2026-09-29T23:30:15Z");
    expect(resolveDateToken("{now}", "UTC", LATE_EVENING_UTC)).toBe("2026-09-29T23:30:15Z");
    expect(resolveDateToken("{now-24h}", "Asia/Kolkata", LATE_EVENING_UTC)).toBe("2026-09-29T05:00:15+05:30");
    expect(resolveDateToken("{now+1w}", "Europe/Rome", LATE_EVENING_UTC)).toBe("2026-10-07T01:30:15+02:00");
    // four weeks later Rome is back on standard time
    expect(resolveDateToken("{now+4w}", "Europe/Rome", LATE_EVENING_UTC)).toBe("2026-10-28T00:30:15+01:00");
    expect(resolveDateToken("{now+3d}", "America/New_York", LATE_EVENING_UTC)).toBe("2026-10-02T19:30:15-04:00");
  });

  it.each(["{Today}", "{today+d}", " {today}", "{today+1m}", "{yesterday}", "today"])("leaves %s unchanged", (value) => {
    expect(resolveDateToken(value, "Europe/Rome", LATE_EVENING_UTC)).toBe(value);
  });
});

describe("resolveDateTokens over a where", () => {
  it("resolves operators, lists and nested conditions, and keeps other values", () => {
    const where = {
      kind: "walk",
      occurred_at: { gte: "{today-7d}", lt: "{now}" },
      due: ["{today}", "{today+1d}"],
      or: [{ done: false }, { snoozed_until: { lte: "{now+2h}" } }],
      note: null,
      count: 3,
    };
    expect(resolveDateTokens(where, "Asia/Kolkata", LATE_EVENING_UTC)).toEqual({
      kind: "walk",
      occurred_at: { gte: "2026-09-23", lt: "2026-09-30T05:00:15+05:30" },
      due: ["2026-09-30", "2026-10-01"],
      or: [{ done: false }, { snoozed_until: { lte: "2026-09-30T07:00:15+05:30" } }],
      note: null,
      count: 3,
    });
    // the input is not changed
    expect(where.occurred_at.lt).toBe("{now}");
  });
});

describe("wallClock", () => {
  it("is UTC when no zone is given", () => {
    expect(wallClock(LATE_EVENING_UTC, "")).toBe("2026-09-29T23:30:15");
  });

  it("is the local time of the zone, on its own date", () => {
    expect(wallClock(LATE_EVENING_UTC, "Asia/Kolkata")).toBe("2026-09-30T05:00:15");
    expect(wallClock(LATE_EVENING_UTC, "America/St_Johns")).toBe("2026-09-29T21:00:15");
  });

  it("writes midnight as 00, never 24", () => {
    expect(wallClock(new Date("2026-09-29T22:00:00Z"), "Europe/Rome")).toBe("2026-09-30T00:00:00");
  });
});

describe("resolveDefault", () => {
  it("{now} becomes the current date-time in the database time zone", () => {
    expect(resolveDefault(DEFAULT_NOW, LATE_EVENING_UTC, "")).toBe("2026-09-29T23:30:15Z");
    expect(resolveDefault(DEFAULT_NOW, LATE_EVENING_UTC, "UTC")).toBe("2026-09-29T23:30:15Z");
    expect(resolveDefault(DEFAULT_NOW, LATE_EVENING_UTC, "Asia/Kolkata")).toBe("2026-09-30T05:00:15+05:30");
    expect(resolveDefault(DEFAULT_NOW, LATE_EVENING_UTC, "America/New_York")).toBe("2026-09-29T19:30:15-04:00");
  });

  it("{today} becomes the current date in the database time zone", () => {
    expect(resolveDefault(DEFAULT_TODAY, LATE_EVENING_UTC, "Asia/Kolkata")).toBe("2026-09-30");
    expect(resolveDefault(DEFAULT_TODAY, LATE_EVENING_UTC, "America/New_York")).toBe("2026-09-29");
    expect(resolveDefault(DEFAULT_TODAY, LATE_EVENING_UTC, "")).toBe("2026-09-29");
  });

  it.each([["draft"], [0], [false], [null], ["{today-1d}"]])("keeps any other default as written: %j", (value) => {
    expect(resolveDefault(value, LATE_EVENING_UTC, "Europe/Rome")).toBe(value);
  });
});

describe("a runtime that prints a zero offset as bare \"GMT\"", () => {
  /** Some ICU builds format a zero `longOffset` as "GMT" instead of "GMT+00:00": emulate one. */
  function bareGmtRuntime(): void {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (this: Intl.DateTimeFormat, date?: Date | number) {
      return original.call(this, date).map((p) => (p.type === "timeZoneName" && p.value === "GMT+00:00" ? { ...p, value: "GMT" } : p));
    });
  }

  it("still reads a zero offset", () => {
    bareGmtRuntime();
    expect(isoAt(Date.UTC(2026, 0, 15, 9, 0, 0), "UTC")).toBe("2026-01-15T09:00:00Z");
    expect(isoAt(Date.UTC(2026, 0, 15, 9, 0, 0), "Europe/London")).toBe("2026-01-15T09:00:00+00:00");
    expect(normalizeDatetime("2026-01-15T09:00", "Africa/Abidjan")).toBe("2026-01-15T09:00:00+00:00");
    // other offsets are unaffected
    expect(normalizeDatetime("2026-01-15T09:00", "Asia/Kolkata")).toBe("2026-01-15T09:00:00+05:30");
  });
});
