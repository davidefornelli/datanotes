// A view's query as select_rows arguments (to preview a query before it is saved) and qualified
// names in their parts. Pure.

/** The keys of a view query that select_rows takes as they are. */
export const PREVIEW_KEYS = ["table", "columns", "where", "order_by", "join", "group_by", "aggregates", "expand"] as const;

/**
 * select_rows arguments that run a view's query, at most `limit` rows (the query's own limit when
 * smaller); null for a union query, which select_rows cannot take inline (the view's Check runs it).
 */
export function previewArgs(query: Record<string, unknown>, limit = 20): Record<string, unknown> | null {
  if (query.union !== undefined) return null;
  const args: Record<string, unknown> = {};
  for (const k of PREVIEW_KEYS) if (query[k] !== undefined) args[k] = query[k];
  const own = query.limit;
  args.limit = typeof own === "number" && own < limit ? own : limit;
  return args;
}

/** "work.planning.task" -> its parts; a shorter name leaves the missing parts "". */
export function splitQualified(full: string): { catalog: string; schema: string; name: string } {
  const parts = full.split(".");
  const name = String(parts.pop());
  const schema = parts.pop() ?? "";
  const catalog = parts.join(".");
  return { catalog, schema, name };
}
