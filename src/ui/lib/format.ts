// Small text helpers shared by the screens: wiki links, values as text, names, times, and what the
// journal can undo. Pure.

/** The target of a wiki link ("[[a/b|Alias]]" -> "a/b", "[[Name#h]]" -> "Name"); null for other text. */
export function linkTarget(text: string): string | null {
  const m = /^\s*!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/.exec(text);
  const target = m?.[1]?.trim();
  return target ? target : null;
}

/** A value as text: nothing for null, lists joined with ", ", objects as JSON. */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(displayValue).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** "a/b/C.md" -> "C" */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

/** "work.planning.task" -> "task" */
export function shortName(full: string): string {
  return full.slice(full.lastIndexOf(".") + 1);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD HH:mm"; text that is not a time comes back as is. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "just now", "3 min ago", "2 hours ago", "4 days ago"; older or future times as formatTime. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < -45) return formatTime(iso);
  if (s < 45) return "just now";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return formatTime(iso);
}

/** Journal operations undo refuses (the engine's RECORD_ONLY_OPS, src/core/changeset.ts; P7 tests the parity). */
export const RECORD_ONLY_OPS: readonly string[] = ["move_database", "set_database_id", "rollback", "set_engine_settings"];

export function undoable(op: string): boolean {
  return !RECORD_ONLY_OPS.includes(op);
}

/** One entry of list_migrations' `settings` (contract 3.0.4) as text. */
export function settingChangeText(c: { name: string; before?: unknown; after?: unknown; redacted?: boolean }): string {
  if (c.before === undefined && c.after === undefined) return `${c.name}: replaced (hidden)`;
  const side = (v: unknown) => (v === undefined ? "default" : JSON.stringify(v));
  const text = `${c.name}: ${side(c.before)} → ${side(c.after)}`;
  return c.redacted === true ? `${text} (credentials hidden)` : text;
}
