// The history screens' helpers: who made a change, journal paging and batches, one line per change
// feed event, and the row diffs of table_changes. Pure.

import { basename, shortName } from "./format";

export interface ActorLike {
  auth?: string;
  session?: string;
  harness?: string;
  model?: string;
}

/**
 * Who made a change: "cook · claude-code / claude-opus-5-5"; {auth: "owner"} -> "owner"; with no
 * credential, harness or model, `by` (the journal's agent name) or "unknown (hand edit or engine)".
 */
export function actorLabel(a?: ActorLike, by?: string): string {
  const agent = [a?.harness, a?.model].filter((s): s is string => typeof s === "string" && s !== "").join(" / ");
  const parts = [a?.auth ?? "", agent].filter((s) => s !== "");
  if (parts.length > 0) return parts.join(" · ");
  return by ?? "unknown (hand edit or engine)";
}

/** The `before` of the next (older) journal page: the last `executed_at` when the page was full. */
export function nextBefore(rows: { executed_at: string }[], limit: number): string | null {
  const last = rows[rows.length - 1];
  return last !== undefined && rows.length === limit ? last.executed_at : null;
}

/**
 * Journal rows with each batch's operations under it: a row whose `batch` is a row of the list goes
 * into that row's `children` (in list order) instead of the top level.
 */
export function groupBatches<T extends { migration_id: string; members?: string[]; batch?: string }>(rows: T[]): (T & { children: T[] })[] {
  const ids = new Set(rows.map((r) => r.migration_id));
  const children = new Map<string, T[]>();
  for (const r of rows) {
    if (r.batch === undefined || !ids.has(r.batch)) continue;
    const list = children.get(r.batch) ?? [];
    list.push(r);
    children.set(r.batch, list);
  }
  return rows
    .filter((r) => r.batch === undefined || !ids.has(r.batch))
    .map((r) => ({ ...r, children: children.get(r.migration_id) ?? [] }));
}

/** One line for a change feed event: what happened, to which row of which table. */
export function changeSummary(ev: {
  kind: string;
  table: string | null;
  path: string;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  call?: Record<string, unknown>;
}): string {
  const where = ev.table ? shortName(ev.table) : "note";
  const name = basename(ev.path);
  switch (ev.kind) {
    case "insert":
      return `New ${where}: ${name}`;
    case "update": {
      const cols = Object.keys(ev.changes ?? {});
      return `Changed ${where} ${name}${cols.length ? `: ${cols.join(", ")}` : ""}`;
    }
    case "delete":
      return `Deleted ${where}: ${name}`;
    case "move":
      return `Moved ${where}: ${name}`;
    case "metastore":
      return "Changed the tables' definitions (metastore.yaml)";
    case "unreadable":
      return `Unreadable front matter: ${name}`;
    case "tool_call": {
      const tool = typeof ev.call?.tool === "string" ? ev.call.tool : "a tool";
      return `Called ${tool}${ev.call?.ok === false ? " (refused)" : ""}`;
    }
    default:
      return `${ev.kind}: ${name}`;
  }
}

export interface RowDiff {
  path: string;
  kind: "insert" | "delete" | "update" | "metadata";
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changed: string[];
  /** The table version of the change (`_commit_version`). */
  version?: number;
}

const META = new Set(["_change_type", "_commit_version", "_commit_timestamp", "_operation", "path"]);

function values(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!META.has(k)) out[k] = v;
  return out;
}

function differing(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = [...Object.keys(before), ...Object.keys(after).filter((k) => !(k in before))];
  return keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

/**
 * table_changes rows as one diff per row and version: an update_preimage and the update_postimage of
 * the same path and version become one "update" whose `changed` lists the columns that differ.
 */
export function pairChanges(changes: Record<string, unknown>[]): RowDiff[] {
  const out: RowDiff[] = [];
  const open = new Map<string, RowDiff>();
  for (const c of changes) {
    const type = c._change_type;
    const path = typeof c.path === "string" ? c.path : "";
    const version = typeof c._commit_version === "number" ? c._commit_version : undefined;
    const base: { path: string; version?: number } = version === undefined ? { path } : { path, version };
    const key = `${version ?? ""}\u0000${path}`;
    if (type === "update_preimage") {
      const d: RowDiff = { ...base, kind: "update", before: values(c), changed: Object.keys(values(c)) };
      open.set(key, d);
      out.push(d);
    } else if (type === "update_postimage") {
      const after = values(c);
      const d = open.get(key);
      if (d) {
        open.delete(key);
        d.after = after;
        d.changed = differing(d.before!, after);
      } else {
        out.push({ ...base, kind: "update", after, changed: Object.keys(after) });
      }
    } else if (type === "insert") {
      const after = values(c);
      out.push({ ...base, kind: "insert", after, changed: Object.keys(after) });
    } else if (type === "delete") {
      const before = values(c);
      out.push({ ...base, kind: "delete", before, changed: Object.keys(before) });
    } else {
      out.push({ ...base, kind: "metadata", changed: [] });
    }
  }
  return out;
}
