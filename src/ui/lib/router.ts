// Hash routes of the database browser (#/rows/work.planning.task?offset=100). The server serves one
// page: no route state (table names, note paths) ever reaches it or its logs. Every link the UI makes
// to one of its screens goes through href(), which encodes each path segment and query value.
// Pure: `location` is read only when navigate() is called.

export type RouteName =
  | "login" | "home" | "open" | "ops" | "op" | "not-found"
  | "rows" | "row" | "new-row" | "note"
  | "table" | "view" | "base" | "new-table" | "new-view"
  | "tokens" | "token" | "matrix" | "users" | "user" | "session"
  | "journal" | "changes" | "table-history" | "database-history"
  | "config" | "webhooks" | "extensions" | "status" | "semantic" | "maintenance"
  | "settings";

export interface Route {
  name: RouteName;
  params: Record<string, string>;
  query: Record<string, string>;
}

/** Each route's path segments; ":x" is the parameter x. */
const PATTERNS: readonly (readonly [RouteName, readonly string[]])[] = [
  ["home", []],
  ["login", ["login"]],
  ["open", ["open"]],
  ["ops", ["ops"]],
  ["op", ["ops", ":op"]],
  ["rows", ["rows", ":object"]],
  ["row", ["row", ":table"]],
  ["new-row", ["new-row", ":table"]],
  ["note", ["note"]],
  ["table", ["table", ":table"]],
  ["view", ["view", ":view"]],
  ["base", ["base", ":name"]],
  ["new-table", ["new-table"]],
  ["new-view", ["new-view"]],
  ["tokens", ["tokens"]],
  ["token", ["tokens", ":name"]],
  ["matrix", ["matrix"]],
  ["users", ["users"]],
  ["user", ["users", ":name"]],
  ["session", ["users", ":name", "sessions", ":session"]],
  ["journal", ["journal"]],
  ["changes", ["changes"]],
  ["table-history", ["history", ":table"]],
  ["database-history", ["history"]],
  ["config", ["config"]],
  ["settings", ["settings"]],
  ["webhooks", ["webhooks"]],
  ["extensions", ["extensions"]],
  ["status", ["status"]],
  ["semantic", ["semantic"]],
  ["maintenance", ["maintenance"]],
];

const BY_NAME = new Map<RouteName, readonly string[]>(PATTERNS);

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function parseQuery(text: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const part of text.split("&")) {
    const eq = part.indexOf("=");
    const key = decode(eq < 0 ? part : part.slice(0, eq));
    const value = decode(eq < 0 ? "" : part.slice(eq + 1));
    if (key && value !== null) query[key] = value;
  }
  return query;
}

/** The route of a location hash: "", "#" and "#/" are home; an unknown path is "not-found". */
export function parseHash(hash: string): Route {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = text.indexOf("?");
  const pathText = q < 0 ? text : text.slice(0, q);
  const query = q < 0 ? {} : parseQuery(text.slice(q + 1));
  const trimmed = pathText.replace(/^\/+/, "");
  const raw = trimmed === "" ? [] : trimmed.split("/");
  const segments = raw.map(decode);
  for (const [name, pattern] of PATTERNS) {
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    pattern.forEach((p, i) => {
      const s = segments[i];
      if (s === null || s === undefined || s === "") ok = false;
      else if (p.startsWith(":")) params[p.slice(1)] = s;
      else if (p !== s) ok = false;
    });
    if (ok) return { name, params, query };
  }
  return { name: "not-found", params: {}, query };
}

/** The hash ("#/...") of a route; query keys with an empty or missing value are left out. */
export function href(name: RouteName, params: Record<string, string> = {}, query: Record<string, string> = {}): string {
  const pattern = BY_NAME.get(name) ?? [];
  const path = pattern.map((p) => encodeURIComponent(p.startsWith(":") ? params[p.slice(1)] ?? "" : p)).join("/");
  const pairs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return `#/${path}${pairs.length ? `?${pairs.join("&")}` : ""}`;
}

/** Goes to a route; `replace` replaces the current history entry (no Back to it). */
export function navigate(
  name: RouteName,
  params?: Record<string, string>,
  query?: Record<string, string>,
  replace = false,
): void {
  const target = href(name, params, query);
  if (replace) location.replace(target);
  else location.hash = target;
}
