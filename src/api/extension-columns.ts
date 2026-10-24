/**
 * Column bindings of an extension: the manifest columns of a dependency role may be bound to
 * columns of another name in the user's table (`--map role.column=column`). The manifest names
 * columns in its view queries, CHECKs and link filters; this module rewrites those names to the
 * bound ones, following link columns from role to role (`book.author.name`). Pure: no I/O.
 *
 * What it cannot rewrite safely it reports as an issue (fail closed), never guesses: a mapped
 * column named in the outer clauses of a union view, or under a query key it does not know.
 */

import { ROLE_REF } from "./extension-manifest.js";
import type { ExtensionManifest, ManifestColumn } from "./extension-manifest.js";

/** role → (manifest column → bound column); only the columns whose names differ matter. */
export type ColumnMap = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** A place where a mapped column is named and cannot be rewritten. */
export interface ColumnIssue {
  role: string;
  column: string;
  /** Where it is named: `view vw_x (union order_by)`. */
  where: string;
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const LOGICAL = new Set(["or", "and", "not"]);
/** `date(col)` with an optional day shift, as group_by and join expressions take it. */
const DATE_EXPR = /^date\((.+)\)([+-]\d+)?$/;
/** The keys of a view query (select_rows parameters, plus `union`). */
const QUERY_KEYS = new Set(["table", "columns", "where", "order_by", "limit", "offset", "expand", "join", "group_by", "aggregates", "include_body", "union"]);
const JOIN_KEYS = new Set(["table", "on", "as", "type", "columns", "where"]);
const UNION_PART_KEYS = new Set(["table", "columns", "where"]);

/** The role a value names exactly (`@meal`), or null. */
function roleOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = ROLE_REF.exec(v);
  return m ? m[1]! : null;
}

/** Rewrites the column names of bound roles; `issues` collects what it could not rewrite. */
export class ColumnBinder {
  readonly issues: ColumnIssue[] = [];
  private readonly map: Record<string, Record<string, string>> = {};

  constructor(
    private readonly manifest: Pick<ExtensionManifest, "tables">,
    map: ColumnMap,
  ) {
    for (const [role, cols] of Object.entries(map)) {
      const differing = Object.entries(cols).filter(([from, to]) => from !== to);
      if (differing.length > 0) this.map[role] = Object.fromEntries(differing);
    }
  }

  /** True when no role has a column bound to another name: every rewrite is the identity. */
  get empty(): boolean {
    return Object.keys(this.map).length === 0;
  }

  /** The bound name of a role's manifest column. */
  name(role: string | null, column: string): string {
    return role === null ? column : (this.map[role]?.[column] ?? column);
  }

  /** The manifest columns of a role bound to another name. */
  mapped(role: string): string[] {
    return Object.keys(this.map[role] ?? {});
  }

  /** The role a link column of `role` points to (`ref: "@x"`, or `self`), or null. */
  private linkRole(role: string, column: string | ManifestColumn): string | null {
    const c = typeof column === "string" ? this.manifest.tables[role]?.columns.find((x) => x.name === column) : column;
    if (!c || c.ref === undefined) return null;
    if (!(c.type === "link" || (c.type === "list" && c.items === "link"))) return null;
    return c.ref === "self" ? role : roleOf(c.ref);
  }

  /** A dotted column path read on `role`: each part on the role the previous link points to. */
  path(role: string | null, dotted: string): string {
    if (role === null || this.empty) return dotted;
    const parts = dotted.split(".");
    const out: string[] = [];
    let cur: string | null = role;
    for (const part of parts) {
      out.push(this.name(cur, part));
      cur = cur === null ? null : this.linkRole(cur, part);
    }
    return out.join(".");
  }

  /** A group_by or join expression: `col`, `path`, `date(col)`, `date(col)+1`. */
  expr(role: string | null, e: string): string {
    const d = DATE_EXPR.exec(e);
    return d ? `date(${this.path(role, d[1]!)})${d[2] ?? ""}` : this.path(role, e);
  }

  /** A `where` filter (or a CHECK) on `role`: keys are column paths; `or` / `and` / `not` nest. */
  where(role: string | null, where: unknown): unknown {
    if (!isObject(where) || role === null || this.empty) return where;
    const out: Obj = {};
    for (const [k, v] of Object.entries(where)) {
      if (LOGICAL.has(k)) out[k] = Array.isArray(v) ? v.map((w) => this.where(role, w)) : this.where(role, v);
      else out[this.path(role, k)] = v;
    }
    return out;
  }

  /** A column spec of `role`: its link filter (`ref_where`), `ref_by`, `inverse`. */
  column(role: string, c: ManifestColumn): ManifestColumn {
    if (this.empty) return c;
    let out: ManifestColumn = c;
    const target = this.linkRole(role, c);
    if (c.ref_where !== undefined) out = { ...out, ref_where: this.where(target, c.ref_where) };
    if (isObject(c.ref_by)) {
      const by = c.ref_by;
      const col = this.name(role, String(by.column));
      const tgt = this.name(target, String(by.target_column ?? by.column));
      const { target_column: _t, ...rest } = by;
      out = { ...out, ref_by: { ...rest, column: col, ...(tgt !== col ? { target_column: tgt } : {}) } };
    }
    if (typeof c.inverse === "string") out = { ...out, inverse: this.name(target, c.inverse) };
    return out;
  }

  /** A view query: the tables it reads are roles (`@meal`); every column it names follows them. */
  query(view: string, q: Obj): Obj {
    if (this.empty) return q;
    if (Array.isArray(q.union)) return this.union(view, q);
    const role = roleOf(q.table);
    const out: Obj = {};
    const aliases = new Set(isObject(q.aggregates) ? Object.keys(q.aggregates) : []);
    const col = (v: string): string => (aliases.has(v) ? v : this.path(role, v));
    for (const [k, v] of Object.entries(q)) {
      switch (k) {
        case "columns":
        case "expand":
          out[k] = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? col(x) : x)) : v;
          break;
        case "order_by":
          out[k] = Array.isArray(v) ? v.map((x) => this.order(x, col)) : this.order(v, col);
          break;
        case "where":
          out[k] = this.where(role, v);
          break;
        case "group_by":
          out[k] = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? this.expr(role, x) : x)) : typeof v === "string" ? this.expr(role, v) : v;
          break;
        case "aggregates":
          out[k] = isObject(v) ? Object.fromEntries(Object.entries(v).map(([a, spec]) => [a, this.aggregate(role, spec)])) : v;
          break;
        case "join":
          out[k] = isObject(v) ? this.join(view, role, v) : v;
          break;
        default:
          if (!QUERY_KEYS.has(k)) this.unknown(view, [role], k, v);
          out[k] = v;
      }
    }
    return out;
  }

  private order(v: unknown, col: (s: string) => string): unknown {
    if (typeof v !== "string") return v;
    return v.startsWith("-") ? `-${col(v.slice(1))}` : col(v);
  }

  /** `count`, `count:col`, `sum:meal.kcal`. */
  private aggregate(role: string | null, spec: unknown): unknown {
    if (typeof spec !== "string") return spec;
    const i = spec.indexOf(":");
    return i < 0 ? spec : `${spec.slice(0, i)}:${this.path(role, spec.slice(i + 1))}`;
  }

  /** `{table, on: {left expr: right expr}, as, type, columns, where}`: `columns` and `where` read the joined table. */
  private join(view: string, left: string | null, j: Obj): Obj {
    const right = roleOf(j.table);
    const out: Obj = {};
    for (const [k, v] of Object.entries(j)) {
      if (k === "on" && isObject(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [this.expr(left, a), typeof b === "string" ? this.expr(right, b) : b]));
      } else if (k === "columns" && Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? this.path(right, x) : x));
      else if (k === "where") out[k] = this.where(right, v);
      else {
        if (!JOIN_KEYS.has(k)) this.unknown(view, [left, right], `join.${k}`, v);
        out[k] = v;
      }
    }
    return out;
  }

  /** `{union: [{table, columns, where}], …}`: each part on its role; the outer clauses read every part, so a mapped column there is an issue. */
  private union(view: string, q: Obj): Obj {
    const roles: (string | null)[] = [];
    const parts = (q.union as unknown[]).map((p) => {
      if (!isObject(p)) return p;
      const role = roleOf(p.table);
      roles.push(role);
      const out: Obj = {};
      for (const [k, v] of Object.entries(p)) {
        if (k === "columns" && Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? this.path(role, x) : x));
        else if (k === "where") out[k] = this.where(role, v);
        else {
          if (!UNION_PART_KEYS.has(k)) this.unknown(view, [role], `union.${k}`, v);
          out[k] = v;
        }
      }
      return out;
    });
    for (const [k, v] of Object.entries(q)) if (k !== "union") this.unknown(view, roles, `union ${k}`, v);
    return { ...q, union: parts };
  }

  /** A clause the binder does not rewrite: an issue for each mapped column it names. */
  private unknown(view: string, roles: (string | null)[], key: string, v: unknown): void {
    for (const n of this.named(v, roles.filter((r): r is string => r !== null), () => true)) this.issues.push({ ...n, where: `view ${view} (${key})` });
  }

  /**
   * The mapped columns a value names, where nothing rewrites it: a word that is a mapped column of
   * one of `roles`, or a later part of a dotted path (`author.name`) that is a mapped column of any
   * role. `keys(key, inKeys)` tells whether the keys under `key` are names too.
   */
  named(v: unknown, roles: string[], keys: (key: string, inKeys: boolean) => boolean): { role: string; column: string }[] {
    const words = new Set<string>();
    const tails = new Set<string>();
    const text = (x: string): void => {
      for (const w of x.split(/[^A-Za-z0-9_.]+/)) {
        const parts = w.split(".");
        if (parts.length === 1) words.add(w);
        else for (const p of parts.slice(1)) tails.add(p);
      }
    };
    const walk = (x: unknown, inKeys: boolean): void => {
      if (typeof x === "string") text(x);
      else if (Array.isArray(x)) x.forEach((y) => walk(y, inKeys));
      else if (isObject(x)) {
        for (const [k, y] of Object.entries(x)) {
          if (inKeys) text(k);
          walk(y, keys(k, inKeys));
        }
      }
    };
    walk(v, keys("", false));
    const out: { role: string; column: string }[] = [];
    for (const role of Object.keys(this.map)) {
      for (const column of this.mapped(role)) if (tails.has(column) || (roles.includes(role) && words.has(column))) out.push({ role, column });
    }
    return out;
  }
}
