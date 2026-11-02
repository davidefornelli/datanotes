// The database's objects as the browser shows them: describe_database (the tree) merged with
// list_tables (aliases, tags), describe_table per object and the views' definitions, each cached
// until the schema changes (a `metastore` event calls refresh()). One cache per client: an owner's
// cache never serves a token the owner views as. Pure: the operation call is injected.

import type { ApiAnswer, ErrorBody } from "./api";

export interface TableEntry {
  name: string;
  qualified: string;
  row_count?: number;
  description?: string;
  aliases?: string[];
  tags?: Record<string, string>;
}

export interface ViewEntry {
  name: string;
  qualified: string;
  description?: string;
  aliases?: string[];
}

export interface BaseEntry {
  name: string;
  description?: string;
  columns: string[];
  tables: string[];
}

export interface CatalogTree {
  catalogs: {
    catalog: string;
    description?: string;
    default?: boolean;
    schemas: { schema: string; description?: string; tables: TableEntry[]; views: ViewEntry[] }[];
  }[];
  bases: BaseEntry[];
  config: Record<string, unknown>;
  root: string;
}

export interface ViewInfo {
  qualified: string;
  query: Record<string, unknown> | null;
  description?: string;
  aliases: string[];
  labels: Record<string, string>;
}

type OpCall = (name: string, args?: Record<string, unknown>) => Promise<ApiAnswer>;

/** An error that carries the engine's answer (error, hint, docs). */
export class AnswerError extends Error {
  readonly body: ErrorBody;
  readonly status: number;
  constructor(body: ErrorBody, status: number) {
    super(body.error);
    this.name = "AnswerError";
    this.body = body;
    this.status = status;
  }
}

function errorBody(a: ApiAnswer): ErrorBody {
  const j = a.json as Partial<ErrorBody>;
  const body: ErrorBody = { error: typeof j.error === "string" ? j.error : `HTTP ${a.status}` };
  if (typeof j.hint === "string") body.hint = j.hint;
  if (typeof j.docs === "string") body.docs = j.docs;
  return body;
}

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

interface Listed {
  qualified: string;
  aliases?: string[];
  tags?: Record<string, string>;
}

export class CatalogCache {
  private readonly op: OpCall;
  private tree: Promise<CatalogTree> | null = null;
  private loaded: CatalogTree | null = null;
  private described = new Map<string, Promise<ApiAnswer>>();
  private viewList: Promise<ViewInfo[]> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(op: OpCall) {
    this.op = op;
  }

  /** The tree, cached; a failed load is not cached. */
  load(): Promise<CatalogTree> {
    if (!this.tree) {
      const p = this.fetchTree();
      this.tree = p;
      p.then(
        (t) => {
          if (this.tree === p) this.loaded = t;
        },
        () => {
          if (this.tree === p) this.tree = null;
        },
      );
    }
    return this.tree;
  }

  private async fetchTree(): Promise<CatalogTree> {
    const [db, list] = await Promise.all([this.op("describe_database"), this.op("list_tables")]);
    if (db.status !== 200) throw new AnswerError(errorBody(db), db.status);
    const listed = new Map<string, Listed>();
    if (list.status === 200) {
      const j = list.json as { tables?: Listed[]; views?: Listed[] };
      for (const e of [...(j.tables ?? []), ...(j.views ?? [])]) listed.set(e.qualified, e);
    }
    const j = db.json as Partial<CatalogTree>;
    const merge = <T extends { qualified: string; aliases?: string[]; tags?: Record<string, string> }>(e: T): T => {
      const l = listed.get(e.qualified);
      const out = { ...e };
      if (l?.aliases && !out.aliases) out.aliases = l.aliases;
      if (l?.tags && !out.tags) out.tags = l.tags;
      return out;
    };
    return {
      catalogs: (j.catalogs ?? []).map((c) => ({
        ...c,
        schemas: (c.schemas ?? []).map((s) => ({
          ...s,
          tables: (s.tables ?? []).map(merge),
          views: (s.views ?? []).map(merge),
        })),
      })),
      bases: j.bases ?? [],
      config: j.config ?? {},
      root: j.root ?? "",
    };
  }

  /** Drops every cache, tells the subscribers, and loads the tree again. */
  refresh(): Promise<CatalogTree> {
    this.tree = null;
    this.loaded = null;
    this.described = new Map();
    this.viewList = null;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // a broken subscriber does not stop the others
      }
    }
    return this.load();
  }

  /** describe_table, cached by name until refresh(); an answer that is not 200 is not cached. */
  describe(full: string): Promise<ApiAnswer> {
    let p = this.described.get(full);
    if (!p) {
      const map = this.described;
      const q = this.op("describe_table", { table: full });
      p = q;
      map.set(full, q);
      q.then(
        (a) => {
          if (a.status !== 200 && map.get(full) === q) map.delete(full);
        },
        () => {
          if (map.get(full) === q) map.delete(full);
        },
      );
    }
    return p;
  }

  /** Every view with its definition (system.information_schema.views), cached until refresh(). */
  views(): Promise<ViewInfo[]> {
    if (!this.viewList) {
      const p = this.fetchViews();
      this.viewList = p;
      p.catch(() => {
        if (this.viewList === p) this.viewList = null;
      });
    }
    return this.viewList;
  }

  private async fetchViews(): Promise<ViewInfo[]> {
    const a = await this.op("select_rows", { table: "system.information_schema.views", limit: 1000 });
    if (a.status !== 200) throw new AnswerError(errorBody(a), a.status);
    const rows = ((a.json as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
    return rows.map((r) => {
      const info: ViewInfo = {
        qualified: [r.table_catalog, r.table_schema, r.table_name].join("."),
        query: parseJson<Record<string, unknown> | null>(r.view_definition, null),
        aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
        labels: parseJson<Record<string, string>>(r.labels, {}),
      };
      if (typeof r.comment === "string" && r.comment) info.description = r.comment;
      return info;
    });
  }

  /** What a name is, once the tree is loaded: "base:x" is a base; null when unknown or not loaded. */
  kindOf(full: string): "table" | "view" | "base" | null {
    const t = this.loaded;
    if (!t) return null;
    if (full.startsWith("base:")) return t.bases.some((b) => b.name === full.slice(5)) ? "base" : null;
    for (const c of t.catalogs) {
      for (const s of c.schemas) {
        if (s.tables.some((x) => x.qualified === full)) return "table";
        if (s.views.some((x) => x.qualified === full)) return "view";
      }
    }
    return null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
