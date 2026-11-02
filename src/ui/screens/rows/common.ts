// What the rows screens share: the columns a table's form shows, an answer's error body, and the
// operation call the libraries take.

import type { ApiAnswer, ApiClient, ErrorBody } from "../../lib/api";
import type { ColumnInfo } from "../../lib/row-form";

export interface Described {
  columns: ColumnInfo[];
  untyped: string[];
  description?: string;
  constraintHints: Record<string, string>;
}

/** A describe_table answer as the form needs it: the typed columns, without the table key. */
export function described(a: ApiAnswer): Described {
  const j = a.json as { columns?: ColumnInfo[]; untyped_fields?: string[]; description?: string; constraint_hints?: Record<string, string> };
  const untyped = j.untyped_fields ?? ["table"];
  const out: Described = {
    columns: (j.columns ?? []).filter((c) => !untyped.includes(c.name)),
    untyped,
    constraintHints: j.constraint_hints ?? {},
  };
  if (j.description) out.description = j.description;
  return out;
}

/** The error of an answer that is not a write answer. */
export function bodyOf(a: ApiAnswer<unknown>): ErrorBody {
  const j = a.json as Partial<ErrorBody>;
  const b: ErrorBody = { error: typeof j.error === "string" ? j.error : `HTTP ${a.status}` };
  if (typeof j.hint === "string") b.hint = j.hint;
  if (typeof j.docs === "string") b.docs = j.docs;
  return b;
}

/** The operation call of lib/open.ts, on this client. */
export function opOf(api: ApiClient): (name: string, args?: Record<string, unknown>) => Promise<ApiAnswer> {
  return (name, args) => api.op(name, args);
}
