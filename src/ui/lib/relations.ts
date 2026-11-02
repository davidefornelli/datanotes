// The links between tables, from describe_table columns: the ones a table makes (outgoing) and the
// ones other tables make to it (incoming). Pure.

export interface Relation {
  /** The table that holds the link column. */
  table: string;
  column: string;
  /** The linked table ("self" resolved to `table`); "" for a link to any note. */
  ref: string;
  /** A list of links. */
  list: boolean;
  inverse?: string;
  hierarchy?: boolean;
  ref_by?: unknown;
  ref_where?: unknown;
}

function isLink(c: Record<string, unknown>): boolean {
  return c.type === "link" || (c.type === "list" && c.items === "link");
}

/** The link columns of a table (a link, or a list of links), `ref: "self"` read as the table. */
export function outgoing(table: string, columns: Record<string, unknown>[]): Relation[] {
  const out: Relation[] = [];
  for (const c of columns) {
    if (!isLink(c) || typeof c.name !== "string") continue;
    const ref = typeof c.ref === "string" ? (c.ref === "self" ? table : c.ref) : "";
    const r: Relation = { table, column: c.name, ref, list: c.type === "list" };
    if (typeof c.inverse === "string") r.inverse = c.inverse;
    if (c.hierarchy === true) r.hierarchy = true;
    if (c.ref_by !== undefined && c.ref_by !== null) r.ref_by = c.ref_by;
    if (c.ref_where !== undefined && c.ref_where !== null) r.ref_where = c.ref_where;
    out.push(r);
  }
  return out;
}

/** Does a ref name the target? A ref without dots is the target's short name. */
function names(ref: string, target: string): boolean {
  if (ref === target) return true;
  return ref !== "" && !ref.includes(".") && target.slice(target.lastIndexOf(".") + 1) === ref;
}

/** The link columns of every described table that point at `target`. */
export function incoming(target: string, described: { qualified: string; columns: Record<string, unknown>[] }[]): Relation[] {
  return described.flatMap((d) => outgoing(d.qualified, d.columns).filter((r) => names(r.ref, target)));
}
