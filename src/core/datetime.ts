/**
 * RFC 3339 date-times for table rows. Values written without seconds or offset
 * (`2026-09-26T22:30`) are completed with the database time zone, daylight saving included
 * (`2026-09-26T22:30:00+02:00`), so every stored date-time is unambiguous (RFC 3339).
 */

import { DEFAULT_NOW, DEFAULT_TODAY } from "./types-table";

const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/;

/** True for an IANA time zone name the runtime knows (e.g. `Europe/Rome`, `UTC`). */

export function isValidTimeZone(tz: string): boolean {
  if (tz.trim() === "" || /^[+-]\d/.test(tz) || tz.toLowerCase() === "local") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** At most this many formatters per shape are kept (a database has one time zone). */
const FORMATTERS_MAX = 32;

/**
 * A formatter per time zone, built once: building one costs about 20 times formatting with it,
 * and a sort on `file_modified` formats every row. A time zone the runtime does not know throws,
 * as building it did, and is not kept.
 */
function cachedFormatter(cache: Map<string, Intl.DateTimeFormat>, tz: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (f === undefined) {
    f = make();
    if (cache.size >= FORMATTERS_MAX) cache.clear();
    cache.set(tz, f);
  }
  return f;
}

const OFFSET_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const WALL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** Offset of `tz` at instant `ms`, in minutes east of UTC. */
function offsetMinutesAt(ms: number, tz: string): number {
  // `timeZoneName` is always among the parts: "GMT" (UTC) or "GMT+05:30", minutes always written
  const name = cachedFormatter(OFFSET_FORMATTERS, tz, () => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }))
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName")!.value;
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * Complete a wall-clock date-time with seconds and the `tz` offset valid on that day.
 * Values that already carry an offset (or are not date-times) are returned unchanged;
 * so is everything when `tz` is empty.
 */
export function normalizeDatetime(value: unknown, tz: string): unknown {
  if (typeof value !== "string" || tz === "") return value;
  const m = value.match(NAIVE_DATETIME);
  if (!m) return value;
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const seconds = m[6] ?? "00";
  const fraction = m[7] ?? "";
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!, Number(seconds));
  // The offset at the wall-clock time: guess with the wall time as UTC, then correct once.
  let offset = offsetMinutesAt(wall, tz);
  offset = offsetMinutesAt(wall - offset * 60_000, tz);
  const suffix = tz === "UTC" && offset === 0 ? "Z" : formatOffset(offset);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${seconds}${fraction}${suffix}`;
}

/** Instant `ms` as an RFC 3339 date-time in `tz` (`2026-09-29T08:30:00+02:00`; UTC `Z` when `tz` is empty). */
export function isoAt(ms: number, tz: string): string {
  if (tz === "") return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const offset = offsetMinutesAt(ms, tz);
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${tz === "UTC" && offset === 0 ? "Z" : formatOffset(offset)}`;
}

const DATE_TOKEN = /^\{(today|now)(?:([+-])(\d+)([dwh]))?\}$/;

/**
 * A relative date in a filter value: `{today}`, `{today-7d}`, `{today+1w}` (a date in `tz`),
 * `{now}`, `{now-24h}` (a date-time in `tz`). Other values are returned unchanged.
 */
export function resolveDateToken(value: unknown, tz: string, now: Date): unknown {
  if (typeof value !== "string") return value;
  const m = value.match(DATE_TOKEN);
  if (!m) return value;
  const n = m[3] === undefined ? 0 : Number(m[3]) * (m[2] === "-" ? -1 : 1);
  const unitMs = m[4] === "w" ? 7 * 86_400_000 : m[4] === "h" ? 3_600_000 : 86_400_000;
  if (m[1] === "now") return isoAt(now.getTime() + n * unitMs, tz);
  if (m[4] === "h") return value; // hours make no sense on a date
  const [y, mo, d] = isoAt(now.getTime(), tz).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!) + n * unitMs).toISOString().slice(0, 10);
}

/** `resolveDateToken` over every value of a `where` (operators, lists and nested objects included). */
export function resolveDateTokens<T>(where: T, tz: string, now: Date): T {
  const walk = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : resolveDateToken(v, tz, now);
  return walk(where) as T;
}

/** Wall-clock `YYYY-MM-DDTHH:mm:ss` of `now` in `tz` (UTC when empty). */
export function wallClock(now: Date, tz: string): string {
  const zone = tz || "UTC";
  const parts = cachedFormatter(WALL_FORMATTERS, zone, () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
  ).formatToParts(now);
  const g = (type: string) => parts.find((p) => p.type === type)!.value; // every part asked for is formatted
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

/** A column default as written: `{now}` / `{today}` become the current date-time / date. */
export function resolveDefault(value: unknown, now: Date, tz: string): unknown {
  if (value === DEFAULT_NOW) return tz === "" ? `${now.toISOString().slice(0, 19)}Z` : normalizeDatetime(wallClock(now, tz), tz);
  if (value === DEFAULT_TODAY) return wallClock(now, tz).slice(0, 10);
  return value;
}

const FORMAT_TOKEN_RE = /\[([^\]]*)\]|YYYY|MM|DD|HH|mm|ss/g;

/**
 * Format an ISO date / date-time string with YYYY MM DD HH mm ss and `[literal]` tokens, no time
 * zone shift (path templates, generated columns); null when the value does not start with a date.
 */
export function formatDateTokensOrNull(value: string, format: string): string | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const parts: Record<string, string> = { YYYY: m[1]!, MM: m[2]!, DD: m[3]!, HH: m[4] ?? "00", mm: m[5] ?? "00", ss: m[6] ?? "00" };
  return format.replace(FORMAT_TOKEN_RE, (tok, literal: string | undefined) => (literal !== undefined ? literal : parts[tok]!));
}
